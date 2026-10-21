import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable"

/** Message ids identify items; a fork boundary must use the enclosing Codex turn id. */
export function withTurnId(update: acp.SessionUpdate, turnId: string, startedAt?: number | null): acp.SessionUpdate {
  switch (update.sessionUpdate) {
    case "user_message":
    case "agent_message":
    case "agent_message_chunk":
    case "agent_thought":
    case "agent_thought_chunk":
    case "tool_call_update":
    case "plan_update":
    case "compaction_update": {
      const meta = update._meta as Record<string, unknown> | undefined
      const codex = meta?.["codex"] as Record<string, unknown> | undefined
      return {
        ...update,
        _meta: {
          ...meta,
          codex: { ...codex, turnId, ...(startedAt == null ? {} : { turnStartedAt: startedAt * 1000 }) }
        }
      }
    }
    default:
      return update
  }
}
