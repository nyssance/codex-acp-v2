# Repository Guidelines

## Project structure

- `src/index.ts` — CLI entry; stdio transport.
- `src/agent/` — ACP v2 agent: method handlers, session state, prompt flow, config options, commands, auth, history replay.
- `src/bridge/` — Codex notification → ACP `session/update` mapping.
- `src/permissions/` — approvals and elicitations.
- `src/codex/` — Codex app-server client, process spawning, model/mode helpers, thread config.
- `src/app-server/` — generated Codex types; regenerate with `bun run generate-types`, never edit.
- `src/__tests__/` — Vitest suites plus the shared harness.
- `docs/protocol.md` — the wire contract clients rely on. Update it with any protocol change.

## Conventions

- ACP v2 only. Import types from `@agentclientprotocol/sdk/experimental/v2`; never from the v1 root entry point.
- Emit only standard `session/update` variants. Adapter-specific data goes under `_meta.codex`.
- Tool calls are upserts: the first `tool_call_update` for an id carries `name`, `title`, and `kind`; later frames patch.
- Every client-blocking request (permission, elicitation) goes through `ClientSession` so `requires_action` is reported correctly.
- `switch` statements over Codex unions are exhaustive. Handle each variant; list intentionally ignored ones explicitly instead of adding a default.
- Errors returned over JSON-RPC are `RequestError`s with a message a user can act on.
- User-visible strings are English; comments explain the Codex quirk being handled, not the obvious.

## Testing

- `bun run typecheck && bun run test` before every change lands.
- Prefer behaviour tests through `createTestAgent()` over unit tests of internals.
- `bun run test:e2e` runs against a real `codex app-server`; use it when touching the Codex client or turn flow.

## Never bump a minor or major version on your own

- For any package or app (`@alwith/api`, `@alwith/module-*`, `codex-acp-v2`, `alwith-cli`, Desktop / U / TV) an agent may only bump the **patch** version (x.y.Z).
- Minor and major bumps are the user's decision alone; "types changed", "breaking change" or "semver convention" never justify doing it yourself. Ask first, change only after the user agrees.
- Origin: user instruction (2026-10-19; `@alwith/api` was published as 0.4.0 instead of 0.3.1 without permission, and a published version number cannot be taken back).
