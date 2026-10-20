import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";

/**
 * ACP v2 clients patch an entity's `_meta` by top-level key and replace each key's value whole,
 * so an agent that spreads one key's facts over several frames (a message's turn id on the first
 * chunk, its completion time on the last) must send that key complete every time it names it.
 * This ledger remembers each entity's last complete value per top-level key and completes the
 * keys an outgoing frame names; keys it omits stay unchanged on the client and are not resent.
 *
 * Chunk metadata is chunk-scoped in the protocol; our clients fold it into the message, so chunks
 * are completed the same way. `null` for a key forgets it; `_meta: null` forgets the entity. The ledger
 * keeps the most recently touched entities up to `limit` (a session's live frames only ever concern
 * its newest items), so a long session does not grow it without bound.
 */
export class CompleteMeta {
    private readonly entities = new Map<string, Record<string, unknown>>();

    constructor(private readonly limit = 4096) {}

    complete(update: acp.SessionUpdate): acp.SessionUpdate {
        const key = entityKey(update);
        if (key === null || !("_meta" in update) || update._meta === undefined) return update;
        if (update._meta === null) {
            this.entities.delete(key);
            return update;
        }
        const remembered = this.entities.get(key) ?? {};
        this.entities.delete(key);
        const completed: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(update._meta as Record<string, unknown>)) {
            if (value === null) {
                delete remembered[name];
                completed[name] = null;
            } else {
                const before = remembered[name];
                completed[name] = isRecord(value) && isRecord(before) ? {...before, ...value} : value;
                remembered[name] = completed[name];
            }
        }
        this.entities.set(key, remembered);
        if (this.entities.size > this.limit) {
            const oldest = this.entities.keys().next().value;
            if (oldest !== undefined) this.entities.delete(oldest);
        }
        return {...update, _meta: completed};
    }
}

function entityKey(update: acp.SessionUpdate): string | null {
    switch (update.sessionUpdate) {
        case "user_message":
        case "user_message_chunk":
        case "agent_message":
        case "agent_message_chunk":
        case "agent_thought":
        case "agent_thought_chunk":
            return `message:${update.messageId}`;
        case "tool_call_update":
        case "tool_call_content_chunk":
            return `tool:${update.toolCallId}`;
        case "terminal_update":
        case "terminal_output_chunk":
            return `terminal:${update.terminalId}`;
        case "plan_update":
            return `plan:${(update as acp.PlanUpdate).plan.planId}`;
        case "compaction_update":
        case "compaction_summary_chunk":
            return `compaction:${update.compactionId}`;
        case "session_info_update":
            return "session";
        default:
            return null;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
