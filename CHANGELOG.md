# Changelog

## 0.7.5 — 2026-10-08

### Added

- Chat branches and fork lineage under `_meta.codex`: `forkAtTurn` and `sessionLineage` capabilities;
  `session/fork` and `session/resume` responses carry `nativeSessionId` and `forkedFromId`; session
  messages carry `turnId` and `turnStartedAt` so a client can tell which turn a message came from.

### Changed

- `@agentclientprotocol/sdk` ^1.7.0 (schema v2.0.0-alpha.7). The protocol now lets `session/new` and
  `session/resume` responses carry `availableCommands` and `configOptions`; the adapter does not fill
  them yet and still announces commands through `available_commands_update`. The 1.7.0 types reject a
  hand-built update with an unknown tag (no `_` prefix) or a malformed known variant at compile time;
  runtime validation is unchanged.

### Fixed

- `AppServerClient` wrote a raw NUL byte into a template literal as the turn-key separator, so `file`
  and `grep` treated the source as binary. It is the `\0` escape now.

## 0.7.4 — 2026-09-30

### Added

- `CODEX_ACP_MODEL_CATALOGS`: extra model catalog files for gateway models. Codex builds its model
  table once at app-server start and ignores a per-thread `model_catalog_json`, so gateway models ran on
  fallback metadata and every reply opened with "Model metadata for `…` not found". The adapter now dumps
  Codex's own catalog (`codex debug models`), adds the extra entries hidden, and starts the app-server
  with the merged file.

### Changed

- Generated against Codex 0.159.2 (`@openai/codex` ^0.159.2): `tooManyDenials` turn errors are
  classified `too_many_denials` (not retryable); `thread/items/list` cursors may be item anchors.

## 0.7.3 — 2026-09-30

### Changed

- In catalog mode the native model group is `chatgpt`, named ChatGPT: it lists the ChatGPT models
  Codex serves, and Codex is the CLI, not the model. Gateway ids may not take `chatgpt`. The `_codex/*`
  methods and the `_meta.codex` namespace are unchanged; they belong to the CLI.

## 0.7.2 — 2026-09-29

### Added

- Turn correlation v2 (`capabilities._meta.alwith.turns = {version: 2}`): `session/prompt`
  accepts a host-named receipt in `_meta.alwith.messageId`, and every `state_update` of a
  prompted turn carries `_meta.alwith.messageId`. A stale `idle` of an older turn is dropped
  once a newer prompt owns the session.

## 0.7.1 — 2026-09-29

### Changed

- Generated against Codex 0.158.0 (`@openai/codex` `^0.158.0`); the version floor follows.
- MCP `openai/userVerification` elicitations (signed device challenges) are declined with
  `cancelled`: ACP has no surface for them and enrollment stays inside Codex.
- `codexErrorInfo` `flexUnavailable` classifies as `flex_unavailable`, retryable.
- Replayed `image` user input renders `image:<fileId>` when Codex stored an uploaded file
  instead of a URL.

## 0.7.0 — 2026-09-29

### Changed

- `session/prompt` returns `{messageId}` (ACP v2, sdk 1.5.1). The id is passed to Codex as
  `clientUserMessageId`; `user_message` echoes and replays report it as `messageId`
  (`userMessage.clientId ?? id`). Steering returns `{messageId, _meta.codex.steered}`.

## 0.6.0 — 2026-09-11

### Added

- Several gateways at once in catalog mode: `providers/set` takes `_meta.codex.id`
  (default `custom-gateway`); each gateway keeps its own base URL, key, config and models,
  writes its own `model_providers.<id>` entry, and gets its own select group in every
  session's `model` option. Model ids must be unique across gateways (`-32602` otherwise).
  `providers/disable` with `_meta.codex.id` removes one gateway; `providers/list` reports
  `_meta.codex.gateways`. Route mode is unchanged (one gateway).
- Pass-throughs: `_codex/session_rename` (`thread/name/set`), `_codex/account_read`
  (`account/read`), `_codex/rate_limits` (`account/rateLimits/read`) and
  `_codex/fuzzy_file_search` (`fuzzyFileSearch`); notifications
  `_codex/rate_limits_updated`, `_codex/fuzzy_file_search_updated` and
  `_codex/fuzzy_file_search_completed` carry Codex's payloads verbatim. Advertised as
  `capabilities._meta.codex.rename` / `.account` / `.fuzzyFileSearch`.

### Fixed

- A thread moved from one gateway to another no longer keeps the previous gateway's
  `model_providers` entry (and bearer token) in its config.
- Re-registering one gateway no longer re-resumes sessions that sit on other gateways.

## 0.5.0 — 2026-09-11

### Added

- `providers/set` hints `_meta.codex.bearerToken` (written as `experimental_bearer_token`)
  and `_meta.codex.config` (top-level Codex thread-config overrides that ride with the
  gateway; a `model_catalog_json` file is read so gateway models carry their real reasoning
  levels and modalities). `providers/disable` removes both from live threads.
- Catalog mode (`_meta.codex.mode: "catalog"`): the gateway's models are offered next to
  Codex's in every session's `model` option as their own select group; selecting one moves
  only that session to the gateway (unsubscribe + resume, materializing an empty thread
  first), selecting a Codex model moves it back. `session/new` / `session/fork` honour
  `_meta.alwith.model`; `session/resume` follows the provider Codex recorded for the thread.
  Advertised as `capabilities._meta.codex.providerCatalog`.

### Fixed

- A thread another Codex client is writing ("already has an active writer", a file lock
  across the Codex home) opens as a read-only session through `thread/read`, like Codex's
  TUI: history replays, the response carries `_meta.codex.readOnly`, prompts and config
  changes are refused with `-32600`, and a later resume retries the real thing.

## 0.4.0 — 2026-09-10

### Added

- Skills and plugins extension surface: `_codex/skills_list`, `_codex/skills_config_write`,
  `_codex/plugin_list`, `_codex/plugin_installed`, `_codex/plugin_install`,
  `_codex/plugin_uninstall`, `_codex/plugin_read`, `_codex/marketplace_add`,
  `_codex/marketplace_remove`, `_codex/marketplace_upgrade` pass the Codex v2 shapes
  through verbatim; advertised as `capabilities._meta.codex.skills` / `.plugins`.
- `_codex/skills_changed` notification: forwarded from Codex `skills/changed` and sent
  after every catalog mutation made through the adapter.

## 0.3.5 — 2026-09-07

### Fixed

- Preserve completed-only messages and tool calls, apply authoritative message
  snapshots, and share snapshot mapping between live updates and history replay.
- Supply required metadata on first tool updates, create terminals before tool
  references, and finalize unfinished tools and terminals before reporting idle.
- Handle steering/completion races, externally started turns, active-session
  recovery, and stale item notifications without duplicating prompts.
- Cancel session-open requests promptly and clean up late-created sessions;
  bound close and unsubscribe waits and prevent reopening during pending cleanup.
- Make provider changes transactional across open sessions, retain configuration,
  and reject unsafe changes before mutation when history cannot be resumed.
- Drain dispatched messages before reporting transport closure, handle write
  backpressure and failures, and redact credentials from diagnostics.
- Launch the native Codex executable directly from compiled adapters and correctly
  encode file URLs containing spaces, Unicode, or platform-specific paths.

### Improved

- Cache model catalogs with expiry and account/provider invalidation, refresh
  account state during session creation, and avoid redundant startup requests.
- Serialize foreground skill-root selection through turn-start acknowledgement;
  cache skill snapshots and avoid refresh loops from skill-change notifications.
  Autonomous and subagent turn starts remain outside this foreground guarantee.
- Parse large fragmented JSON frames without repeatedly rescanning accumulated
  input. Limit duplicated command output in `rawOutput` to 16,384 UTF-16 code
  units while retaining full output in terminal snapshots or tool content.

### Validation

- Add ACP v2 schema/reducer conformance checks and real-stdio tests for source and
  compiled executables; configure Linux, macOS, and Windows CI coverage.
- Pass 206 local behavior/unit tests and six real Codex E2E tests.
- Add opt-in large-frame and streaming benchmarks, plus an isolated bridge soak
  covering 5,000 turns, 500,000 chunks, and 1,000 interrupted outcomes.
- Document protocol guarantees and reproducible measurement scope in
  `docs/protocol.md` and `docs/quality-evidence.md`.
