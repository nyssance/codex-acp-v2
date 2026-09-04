# Development notes

## Architecture

```
ACP v2 client ──stdio──▶ src/index.ts ──▶ agent/createAgent.ts (SDK AgentApp, one handler per method)
                                            └─▶ agent/CodexAgent.ts (sessions, prompt flow, cancel/close)
                                                  ├─▶ agent/clientSession.ts   outbound frames + requires_action refcount
                                                  ├─▶ bridge/EventBridge.ts    Codex notifications → session/update
                                                  │     ├─ bridge/toolCalls.ts  ThreadItem → tool_call_update
                                                  │     ├─ bridge/diff.ts       FileUpdateChange → v2 diff + git patch
                                                  │     └─ bridge/terminal.ts   command output → terminal frames
                                                  ├─▶ permissions/*             approvals and elicitations
                                                  └─▶ codex/AppServerClient.ts  typed JSON-RPC client for codex app-server
                                                        └─ codex/process.ts     spawn + newline JSON-RPC transport
```

- `src/app-server/` holds the generated Codex app-server types (`bun run generate-types`).
  Only the `v2` surface is used.
- `src/agent/session.ts` is the per-session state. One `ActiveTurn` at a time; a
  second `session/prompt` while a turn runs is steered into it with `turn/steer`.
- `src/agent/configOptions.ts` is the single place a config option takes effect.
- `src/bridge/EventBridge.ts` is exhaustive over `ServerNotification`; adding a
  Codex notification is a compile error until it is mapped or listed as ignored.

## Prompt flow

1. `session/prompt` validates, records an `ActiveTurn`, emits `state_update running`, returns `{}`.
2. `runPrompt` handles slash commands locally or starts a Codex turn (`turn/start`)
   and awaits `turn/completed`.
3. Notifications for the thread are queued per session so frames reach the client
   in Codex order. Approval handlers drain that queue before prompting, so the
   tool call under review is always rendered before its permission request.
4. `turn/completed` status decides the terminal frame: `completed` → `idle end_turn`
   with usage; `interrupted` → `idle cancelled`; `failed` → an error
   `agent_message_chunk` (`_meta.codex.error`) followed by `idle end_turn`.
5. `session/cancel` aborts the turn and calls `turn/interrupt` once the turn id is
   known; a cancel that arrives before `turn/start` is sent never starts the turn.

## Testing

- `src/__tests__/harness.ts` provides `FakeCodexConnection` (scripted app-server)
  and `FakeClient` (records `session/update`, answers permissions and elicitations).
- Unit suites: `agent.test.ts` (lifecycle), `bridge.test.ts` (event mapping),
  `permissions.test.ts` (approvals, elicitation, state transitions), `units.test.ts`.
- `e2e.test.ts` drives the real agent over stdio; run with `bun run test:e2e`
  (needs a ChatGPT login or `CODEX_API_KEY`).

## Updating the supported Codex version

1. Bump `@openai/codex` in `package.json`.
2. `bun run generate-types`.
3. `bun run typecheck && bun run test`; the exhaustive switches surface new
   notifications and item types.
