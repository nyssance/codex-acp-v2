import type * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type {Thread, Turn} from "../app-server/v2";
import {itemSnapshot} from "../bridge/itemSnapshot";

/**
 * Renders a loaded Codex thread as the session updates a client would have seen
 * live, so `session/resume` with `replayFrom: start` and `session/fork` restore
 * the transcript before the response resolves.
 */
export function historyUpdates(turns: readonly Turn[]): acp.SessionUpdate[] {
    const updates: acp.SessionUpdate[] = [];
    for (const turn of turns) {
        for (const item of turn.items) {
            updates.push(...itemSnapshot(item));
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
            const text = item.content
                .filter((input): input is Extract<typeof input, {type: "text"}> => input.type === "text")
                .map(input => input.text.trim())
                .find(part => part.length > 0);
            if (text) return firstLine(text);
        }
    }
    const preview = thread.preview.trim();
    return preview.length > 0 ? firstLine(preview) : null;
}

function firstLine(text: string): string {
    const line = text.split(/\r?\n/).map(part => part.trim()).find(part => part.length > 0) ?? text;
    return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}
