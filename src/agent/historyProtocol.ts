import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import {createHash} from "node:crypto";
import type {Thread, Turn} from "../app-server/v2";
import type {AppServerClient} from "../codex/AppServerClient";
import {abortable} from "../util/abort";

export interface HistoryParams {
    sessionId: string;
    cursor?: string | null;
    limit?: number;
    mode?: "browse" | "export";
    sortDirection?: "asc" | "desc";
    maxBytes?: number;
    includeNative?: boolean;
}
export interface SessionHistoryParams extends HistoryParams { itemsView?: "summary" | "full" }
export interface SessionHistoryItemsParams extends HistoryParams { turnId?: string; anchorItemId?: string }
export interface HistoryPage {
    sessionId: string;
    cwd: string;
    title: string | null;
    createdAt: number;
    updatedAt: number;
    forkedFromId: string | null;
    running: boolean | null;
    revision: string | null;
    consistency: "live" | "optimistic";
    nextCursor: string | null;
    /** End of this traversal, not a content-fidelity or atomic-snapshot guarantee. */
    complete: boolean;
}
interface Cursor {
    version: 2;
    binding: string;
    revision: string | null;
    after: string;
}

export function historyError(reason: string, message: string, retryable: boolean | null, extra: Record<string, unknown> = {}, code = -32600): acp.RequestError {
    return new acp.RequestError(code, message, {reason, retryable, ...extra});
}

function invalid(message: string): never {
    throw historyError("history_invalid_params", message, false, {}, -32602);
}

function parse(raw: unknown, items: boolean): Record<string, unknown> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("History params must be an object");
    const p = raw as Record<string, unknown>;
    const allowed = new Set(["sessionId", "cursor", "limit", "mode", "sortDirection", "maxBytes", "includeNative", "_meta", ...(items ? ["turnId", "anchorItemId"] : ["itemsView"])]);
    for (const key of Object.keys(p)) if (!allowed.has(key)) invalid(`Unknown history parameter: ${key}`);
    if (typeof p["sessionId"] !== "string" || !p["sessionId"].trim()) invalid("sessionId must be a non-empty string");
    if (p["cursor"] != null && (typeof p["cursor"] !== "string" || !p["cursor"] || p["cursor"].length > 65536)) invalid("cursor must be a non-empty history cursor or null");
    for (const [key, min, max] of [["limit", 1, 100], ["maxBytes", 1024, 16 * 1024 * 1024]] as const) {
        if (p[key] !== undefined && (typeof p[key] !== "number" || !Number.isInteger(p[key]) || p[key] < min || p[key] > max)) invalid(`${key} must be an integer between ${min} and ${max}`);
    }
    if (p["mode"] !== undefined && p["mode"] !== "browse" && p["mode"] !== "export") invalid("mode must be browse or export");
    if (p["sortDirection"] !== undefined && p["sortDirection"] !== "asc" && p["sortDirection"] !== "desc") invalid("sortDirection must be asc or desc");
    if (p["includeNative"] !== undefined && typeof p["includeNative"] !== "boolean") invalid("includeNative must be a boolean");
    if (!items && p["itemsView"] !== undefined && p["itemsView"] !== "summary" && p["itemsView"] !== "full") invalid("itemsView must be summary or full");
    if (!items && p["includeNative"] === true && p["itemsView"] !== "full") invalid("includeNative requires itemsView: full; use the items endpoint for details");
    for (const key of ["turnId", "anchorItemId"]) {
        if (p[key] !== undefined && (typeof p[key] !== "string" || !p[key].trim())) invalid(`${key} must be a non-empty string`);
    }
    if (p["anchorItemId"] !== undefined && (p["turnId"] === undefined || p["cursor"] != null)) invalid("anchorItemId requires turnId and cannot be combined with cursor");
    return p;
}
export function parseSessionHistoryParams(raw: unknown): SessionHistoryParams { return parse(raw, false) as unknown as SessionHistoryParams; }
export function parseSessionHistoryItemsParams(raw: unknown): SessionHistoryItemsParams { return parse(raw, true) as unknown as SessionHistoryItemsParams; }

/** Preserve upstream RPC diagnostics; classify only known shapes/messages, never guess retryability. */
function sourceError(error: unknown): acp.RequestError {
    if (error instanceof acp.RequestError) return error;
    const e = error && typeof error === "object" ? error as Record<string, unknown> : {};
    const message = error instanceof Error ? error.message : String(error);
    const native = {code: e["code"] ?? null, data: e["data"] ?? null};
    const code = typeof e["code"] === "number" ? e["code"] : -32603;
    if (/thread not found|no rollout found for thread|unknown thread/i.test(message)) return historyError("history_not_found", message, false, {native}, code);
    if (code === -32602 && /cursor/i.test(message)) return historyError("history_invalid_cursor", message, false, {native}, code);
    if (code === -32602) return historyError("history_invalid_params", message, false, {native}, code);
    if (code === -32601) return historyError("history_unsupported", message, false, {native}, code);
    if (["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNREFUSED"].includes(String(e["code"]))) return historyError("history_unavailable", message, true, {native}, code);
    return historyError("history_source_error", message, null, {native}, code);
}

export class HistoryRead {
    readonly direction: "asc" | "desc";
    readonly mode: "browse" | "export";
    readonly after: string | null;
    private readonly binding: string;
    private readonly previous: Cursor | null;
    constructor(private readonly codex: AppServerClient, readonly params: HistoryParams, scope: Record<string, unknown>, private readonly signal?: AbortSignal) {
        this.direction = params.sortDirection ?? "asc";
        this.mode = params.mode ?? "browse";
        this.binding = JSON.stringify({sessionId: params.sessionId, mode: this.mode, sortDirection: this.direction, includeNative: params.includeNative ?? false, ...scope});
        this.previous = this.decode(params.cursor);
        this.after = this.previous?.after ?? null;
    }
    private decode(raw: string | null | undefined): Cursor | null {
        if (raw == null) return null;
        try {
            const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<Cursor> | null;
            if (!v || v.version !== 2 || v.binding !== this.binding || typeof v.after !== "string" || !v.after ||
                (this.mode === "browse" ? v.revision !== null : typeof v.revision !== "string" || !/^[a-f0-9]{64}$/.test(v.revision))) throw new Error("cursor mismatch");
            return v as Cursor;
        } catch {
            throw historyError("history_invalid_cursor", "Invalid history cursor or changed query options; restart without a cursor", false, {}, -32602);
        }
    }
    async call<T>(operation: () => Promise<T>): Promise<T> {
        const check = (): void => { if (this.signal?.aborted) throw historyError("history_cancelled", "History request cancelled", false); };
        check();
        try {
            const result = this.signal ? await abortable(operation(), this.signal) : await operation();
            check();
            return result;
        } catch (error) { check(); throw sourceError(error); }
    }
    async start(): Promise<{thread: Thread; revision: string | null}> {
        const boundary = await this.boundary();
        if (this.previous && this.previous.revision !== boundary.revision) this.changed();
        return boundary;
    }
    private async boundary(): Promise<{thread: Thread; revision: string | null}> {
        const {thread} = await this.call(() => this.codex.threadRead({threadId: this.params.sessionId, includeTurns: false}));
        if (this.mode === "browse") return {thread, revision: null};
        if (thread.status.type === "active") this.busy();
        if (thread.status.type === "systemError") throw historyError("history_unavailable", "Codex reports a session error; retry when it is resolved", true);
        // The summary avoids re-reading a potentially huge final tool result for every page.
        // This remains a best-effort change detector, never a transactional revision.
        const tail = await this.call(() => this.codex.threadTurnsList({threadId: this.params.sessionId, limit: 1, sortDirection: "desc", itemsView: "summary"}));
        this.checkTurns(tail.data);
        const revision = createHash("sha256").update(JSON.stringify({id: thread.id, cwd: thread.cwd, name: thread.name, preview: thread.preview, createdAt: thread.createdAt, updatedAt: thread.updatedAt, forkedFromId: thread.forkedFromId, tail: tail.data[0] ?? null})).digest("hex");
        return {thread, revision};
    }
    checkTurns(turns: readonly Turn[]): void {
        if (this.mode === "export" && turns.some(turn => turn.status === "inProgress")) this.busy();
    }
    private busy(): never { throw historyError("history_busy", "Session history is still running; retry after the turn finishes", true); }
    private changed(): never { throw historyError("history_changed", "Session history changed; discard collected pages and restart without a cursor", true); }
    async finish(start: {thread: Thread; revision: string | null}, next: string | null, count: number): Promise<HistoryPage> {
        if (next !== null && (!next || next === this.after || count === 0)) throw historyError("history_invalid_page", "Codex history pagination made no progress; restart the read", false, {}, -32603);
        if (this.mode === "export" && start.revision !== (await this.boundary()).revision) this.changed();
        const nextCursor = next === null ? null : Buffer.from(JSON.stringify({version: 2, binding: this.binding, revision: start.revision, after: next} satisfies Cursor)).toString("base64url");
        const t = start.thread;
        return {sessionId: this.params.sessionId, cwd: t.cwd, title: t.name?.trim() || t.preview.trim() || null, createdAt: t.createdAt, updatedAt: t.updatedAt, forkedFromId: t.forkedFromId, running: t.status.type === "active" ? true : t.status.type === "idle" ? false : null, revision: start.revision, consistency: this.mode === "export" ? "optimistic" : "live", nextCursor, complete: nextCursor === null};
    }
    bounded<T>(page: T): T {
        const bytes = Buffer.byteLength(JSON.stringify(page));
        const maxBytes = this.params.maxBytes ?? 1024 * 1024;
        if (bytes > maxBytes) throw historyError("history_page_too_large", "History page exceeds maxBytes; retry the same cursor with a smaller limit or larger maxBytes, or start a new summary/item traversal", true, {bytes, maxBytes}, -32600);
        return page;
    }
}
