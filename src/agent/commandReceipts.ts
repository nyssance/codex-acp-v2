import {createHash, randomUUID} from "node:crypto";
import {mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type {Thread} from "../app-server/v2";
import type {AppServerClient} from "../codex/AppServerClient";
import {abortable} from "../util/abort";

export interface CommandReceipt {
    kind: "plan" | "review";
    messageId: string;
    content: acp.ContentBlock[];
}

export interface CommandHistoryGuard { threadId: string; id: string }

const INTERNAL_PLAN_PREFIX = "codex-acp-internal-plan:";

export function internalPlanMessageId(): string {
    return `${INTERNAL_PLAN_PREFIX}${randomUUID()}`;
}

export function isInternalPlanMessageId(messageId: string | null): boolean {
    return messageId?.startsWith(INTERNAL_PLAN_PREFIX) ?? false;
}

/** A native user item ID survives resume and fork, unlike an in-memory command echo. */
export class CommandReceipts {
    private readonly memory = new Map<string, CommandReceipt>();
    private readonly pending = new Map<string, Set<string>>();

    constructor(private readonly codexHome?: string) {}

    /** Persist before starting native work: missing item mappings must never look like foreign input. */
    async prepare(threadId: string): Promise<CommandHistoryGuard> {
        const guard = {threadId, id: randomUUID()};
        if (this.codexHome) {
            try {
                const directory = this.guardDirectory(threadId);
                await mkdir(directory, {recursive: true, mode: 0o700});
                await writeFile(path.join(directory, `${guard.id}.pending`), "", {flag: "wx", mode: 0o600});
            } catch (error) {
                throw new Error("Could not protect command history before execution; check Codex home access and free space", {cause: error});
            }
        } else {
            const pending = this.pending.get(threadId) ?? new Set<string>();
            pending.add(guard.id);
            this.pending.set(threadId, pending);
        }
        return guard;
    }

    /** A separate completion marker cannot expose a truncated or failed receipt as saved. */
    async complete(guard: CommandHistoryGuard): Promise<void> {
        if (this.codexHome) {
            await writeFile(path.join(this.guardDirectory(guard.threadId), `${guard.id}.complete`), "", {flag: "a", mode: 0o600});
        } else {
            this.pending.get(guard.threadId)?.delete(guard.id);
        }
    }

    async assertReplayable(threadId: string): Promise<void> {
        let incomplete: boolean;
        if (this.codexHome) {
            let files: string[];
            try {
                files = await readdir(this.guardDirectory(threadId));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
                throw acp.RequestError.internalError(undefined, "Could not verify command history; check Codex home access and retry");
            }
            const names = new Set(files);
            incomplete = files.some(file => file.endsWith(".pending") && !names.has(file.replace(/\.pending$/, ".complete")));
        } else {
            incomplete = (this.pending.get(threadId)?.size ?? 0) > 0;
        }
        if (incomplete) throw acp.RequestError.internalError({reason: "command_history_incomplete", retryable: null, threadId},
            "Command history has an unconfirmed receipt mapping. Wait for the command to finish and retry; if saving failed, restore the receipt data or start a new session.");
    }

    private guardDirectory(threadId: string): string {
        const key = createHash("sha256").update(threadId).digest("hex");
        return path.join(this.codexHome!, "codex-acp-v2", "command-history-guards", key);
    }

    async write(itemId: string, receipt: CommandReceipt): Promise<void> {
        if (this.memory.has(itemId)) return;
        if (!this.codexHome) {
            this.memory.set(itemId, receipt);
            return;
        }
        const target = this.file(itemId);
        try {
            await mkdir(path.dirname(target), {recursive: true, mode: 0o700});
            await writeFile(target, JSON.stringify(receipt), {encoding: "utf8", flag: "wx", mode: 0o600});
        } catch (error) {
            throw new Error("Could not save the command receipt under Codex home; check directory permissions and free space", {cause: error});
        }
        this.memory.set(itemId, receipt);
    }

    async read(itemId: string): Promise<CommandReceipt | null> {
        const cached = this.memory.get(itemId);
        if (cached) return cached;
        if (!this.codexHome) return null;
        let raw: string;
        try {
            raw = await readFile(this.file(itemId), "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw acp.RequestError.internalError(undefined, "Could not read saved command history; check Codex home access and retry");
        }
        let value: unknown;
        try {
            value = JSON.parse(raw);
        } catch {
            throw acp.RequestError.internalError(undefined, "Saved command history is incomplete; check Codex home and retry");
        }
        if (!isCommandReceipt(value)) throw acp.RequestError.internalError(undefined, "Saved command history is invalid; check Codex home and retry");
        this.memory.set(itemId, value);
        return value;
    }

    private file(itemId: string): string {
        const key = createHash("sha256").update(itemId).digest("hex");
        return path.join(this.codexHome!, "codex-acp-v2", "command-receipts", `${key}.json`);
    }
}

/** Forks retain source items, so an incomplete ancestor also makes their replay unsafe. */
export async function assertCommandHistory(codex: AppServerClient, thread: Thread, receipts: CommandReceipts | null | undefined, signal?: AbortSignal): Promise<void> {
    if (!receipts) return;
    const seen = new Set<string>();
    let current = thread;
    while (true) {
        if (seen.has(current.id)) throw acp.RequestError.internalError(undefined, "Codex history lineage contains a cycle; restart Codex and retry");
        seen.add(current.id);
        const check = receipts.assertReplayable(current.id);
        await (signal ? abortable(check, signal) : check);
        if (current.forkedFromId === null) return;
        signal?.throwIfAborted();
        const parent = codex.threadRead({threadId: current.forkedFromId, includeTurns: false});
        current = (await (signal ? abortable(parent, signal) : parent)).thread;
    }
}

function isCommandReceipt(value: unknown): value is CommandReceipt {
    if (!value || typeof value !== "object") return false;
    const record = value as Partial<CommandReceipt>;
    return (record.kind === "plan" || record.kind === "review") && typeof record.messageId === "string"
        && Array.isArray(record.content) && record.content.every(block => block && typeof block === "object" && typeof block.type === "string");
}
