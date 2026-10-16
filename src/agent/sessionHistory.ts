import type * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type {ThreadItem, Turn} from "../app-server/v2";
import type {AppServerClient} from "../codex/AppServerClient";
import {HistoryRead, historyError, parseSessionHistoryParams, parseSessionHistoryItemsParams, type HistoryPage, type SessionHistoryParams, type SessionHistoryItemsParams} from "./historyProtocol";
import {projectHistoryItem, type HistoryOmission} from "./historyProjection";
import {assertCommandHistory, type CommandReceipts} from "./commandReceipts";
export {parseSessionHistoryParams, parseSessionHistoryItemsParams, type SessionHistoryParams, type SessionHistoryItemsParams} from "./historyProtocol";

export interface SessionHistoryTurn {
    turnId: string;
    status: Turn["status"];
    error: Turn["error"];
    startedAt: number | null;
    completedAt: number | null;
    durationMs: number | null;
    itemsView: Turn["itemsView"];
    updates: acp.SessionUpdate[];
    omissions: HistoryOmission[];
    _meta?: {codex: {items: ThreadItem[]}};
}
export interface SessionHistoryResponse extends HistoryPage { turns: SessionHistoryTurn[] }
export interface SessionHistoryItem {
    turnId: string;
    itemId: string;
    startedAtMs: number | null;
    completedAtMs: number | null;
    updates: acp.SessionUpdate[];
    omissions: HistoryOmission[];
    _meta?: {codex: {item: ThreadItem}};
}
export interface SessionHistoryItemsResponse extends HistoryPage { items: SessionHistoryItem[] }

export async function readSessionHistory(codex: AppServerClient, raw: SessionHistoryParams, signal?: AbortSignal, commandReceipts?: CommandReceipts | null): Promise<SessionHistoryResponse> {
    const params = parseSessionHistoryParams(raw);
    const view = params.itemsView ?? "summary";
    const read = new HistoryRead(codex, params, {endpoint: "turns", itemsView: view}, signal);
    const start = await read.start();
    const page = await read.call(() => codex.threadTurnsList({threadId: params.sessionId, cursor: read.after, limit: params.limit ?? 50, sortDirection: read.direction, itemsView: view}));
    read.checkTurns(page.data);
    if (view === "full" && page.data.some(turn => turn.itemsView !== "full")) throw historyError("history_incomplete", "Codex did not return full history items; update Codex and retry", false, {}, -32603);
    if (view === "full") await read.call(() => assertCommandHistory(codex, start.thread, commandReceipts, signal));
    const turns = await read.call(() => Promise.all(page.data.map(async turn => {
        const projections = view === "full" ? await Promise.all(turn.items.map(async item =>
            projectHistoryItem(item, turn.id, turn.startedAt, item.type === "userMessage" ? await commandReceipts?.read(item.id) : null))) : [];
        return {turnId: turn.id, status: turn.status, error: turn.error, startedAt: turn.startedAt, completedAt: turn.completedAt, durationMs: turn.durationMs,
            itemsView: view === "summary" ? "summary" as const : turn.itemsView,
            updates: projections.flatMap(p => p.updates), omissions: projections.flatMap(p => p.omissions),
            ...(params.includeNative ? {_meta: {codex: {items: turn.items}}} : {})};
    })));
    const result = await read.finish(start, page.nextCursor, page.data.length);
    return read.bounded({...result, running: page.data.some(turn => turn.status === "inProgress") ? true : result.running, turns});
}

export async function readSessionHistoryItems(codex: AppServerClient, raw: SessionHistoryItemsParams, signal?: AbortSignal, commandReceipts?: CommandReceipts | null): Promise<SessionHistoryItemsResponse> {
    const params = parseSessionHistoryItemsParams(raw);
    const read = new HistoryRead(codex, params, {endpoint: "items", turnId: params.turnId ?? null}, signal);
    const start = await read.start();
    const page = await read.call(() => codex.threadItemsList({threadId: params.sessionId, turnId: params.turnId ?? null,
        cursor: read.after ?? (params.anchorItemId ? {type: "item", itemId: params.anchorItemId} : null), limit: params.limit ?? 50, sortDirection: read.direction}));
    await read.call(() => assertCommandHistory(codex, start.thread, commandReceipts, signal));
    const items = await read.call(() => Promise.all(page.data.map(async entry => ({turnId: entry.turnId, itemId: entry.item.id,
        startedAtMs: entry.startedAtMs, completedAtMs: entry.completedAtMs,
        ...projectHistoryItem(entry.item, entry.turnId, null, entry.item.type === "userMessage" ? await commandReceipts?.read(entry.item.id) : null),
        ...(params.includeNative ? {_meta: {codex: {item: entry.item}}} : {})}))));
    const result = await read.finish(start, page.nextCursor, page.data.length);
    return read.bounded({...result, items});
}
