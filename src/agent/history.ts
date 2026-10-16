import type * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type {Thread, Turn} from "../app-server/v2";
import {itemSnapshot} from "../bridge/itemSnapshot";
import type {AgentDirectory} from "../bridge/agentDirectory";
import {withTurnId} from "../bridge/turnMetadata";
import type {CommandReceipt} from "./commandReceipts";
import {fromUserMessage, promptTitle} from "../codex/sessionConfig";

/**
 * Renders a loaded Codex thread as the session updates a client would have seen
 * live, so `session/resume` with `replayFrom: start` and `session/fork` restore
 * the transcript before the response resolves.
 */
export function historyUpdates(turns: readonly Turn[], agents: AgentDirectory, commandReceipts: ReadonlyMap<string, CommandReceipt> = new Map()): acp.SessionUpdate[] {
    const updates: acp.SessionUpdate[] = [];
    for (const turn of turns) {
        const openingUser = turn.items.find(item => item.type === "userMessage");
        for (const item of turn.items) {
            const command = item.type === "userMessage" ? commandReceipts.get(item.id) : undefined;
            updates.push(...itemSnapshot(item, agents, command).map(update => {
                const replay = withTurnId(update, turn.id, turn.startedAt);
                const meta = replay._meta as Record<string, unknown> | undefined;
                const codex = meta?.["codex"] as Record<string, unknown> | undefined;
                const duration = turn.durationMs ?? (turn.startedAt !== null && turn.completedAt !== null
                    ? (turn.completedAt - turn.startedAt) * 1000 : null);
                replay._meta = {...meta, codex: {...codex, historyReplay: true,
                    ...(turn.completedAt !== null ? {turnCompletedAt: turn.completedAt * 1000} : {}),
                    ...(item === openingUser && turn.startedAt !== null ? {messageSentAt: turn.startedAt * 1000} : {}),
                    ...(duration !== null && Number.isFinite(duration) && duration >= 0 ? {turnDurationMs: duration} : {}),
                    ...(turn.status === "interrupted" ? {historyInterrupted: true} : {}),
                }};
                return replay;
            }));
        }
    }
    return updates;
}

/** Title from the thread name, else the first user message, else the preview. */
export function historyTitle(thread: Pick<Thread, "name" | "preview">, turns: readonly Turn[]): string | null {
    const explicit = thread.name?.trim();
    if (explicit) return explicit;
    for (const turn of turns) {
        for (const item of turn.items) {
            if (item.type !== "userMessage") continue;
            const title = promptTitle(fromUserMessage(item.content));
            if (title) return title;
        }
    }
    const preview = thread.preview.trim();
    return preview.length > 0 ? firstLine(preview) : null;
}

function firstLine(text: string): string {
    const line = text.split(/\r?\n/).map(part => part.trim()).find(part => part.length > 0) ?? text;
    return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}
