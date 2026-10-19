# Changelog

## 0.7.18 — 2026-10-19

### Changed

- Outgoing `_meta` follows the ACP v2 patch rule: clients replace each named top-level key whole, so
  every frame now carries the keys it names complete (`codex.turnId` from a message's first chunk
  survives the final frame's `codex.phase`; a reconciled tool keeps its `codex.subagent`). Keys a
  frame does not name are left alone.

## 0.7.17 — 2026-10-19

### Changed

- Built against `@agentclientprotocol/sdk` 1.9.0 (schemas v1.26.0 / v2.0.0-alpha.9; v2 protocol
  version negotiation and session updates decoupled from prompt completion).

## 0.7.16 — 2026-10-16

### Added

- Codex's durable read state: `thread/readState/changed` is forwarded as `session_info_update` with
  `_meta.codex.readState`, and `_codex/session_read_state_update` marks a session read or unread
  (`capabilities._meta.codex.readState: true`).

## 0.7.15 — 2026-10-16

### Added

- Collaboration calls report the agents they address in `_meta.codex.collaboration.agents`: each
  receiver's `threadId`, `nickname`, `role`, `model` and `reasoningEffort`, read from its own thread,
  and its `state`. A thread that cannot be read yet is reported with null identity fields and read
  again on its next frame.

## 0.7.14 — 2026-10-16

### Added

- Sub-agent activity carries `model` and `reasoningEffort` in `rawInput` and `_meta.codex.subagent`.

### Changed

- Generated against Codex 0.163.0 (`@openai/codex` ^0.163.0); the version floor follows.
  `generate-types` clears `src/app-server` first, so types Codex removed no longer linger.
- Command approvals offer exactly the `availableDecisions` Codex sends; a missing list, or one naming
  an amendment Codex did not propose, is cancelled. The adapter no longer builds its own decision set.
- Review exits produce no update: Codex follows every exit with an assistant message carrying the
  conclusion, and the adapter maps that message. Exit buffering and deduplication are removed.
- Fast mode availability reads `serviceTiers` only; the deprecated `additionalSpeedTiers` is ignored.
- `codexErrorInfo` values Codex has no name for classify as `unknown`.

## 0.7.13 — 2026-10-13

### Fixed

- Match gateway model capabilities by upstream model, including hidden native models,
  and omit reasoning effort settings when the model declares no supported levels.
- Normalize unsupported reasoning efforts when selecting a model.
- Recognize local commands after leading file attachments and preserve attachments
  when `/plan <task>` starts a turn.

## 0.7.12 — 2026-10-13

### Added

- `_codex/plugin_set_enabled` enables or disables local and remote plugins,
  advertised through `capabilities._meta.codex.pluginEnable`. Successful changes
  emit `_codex/skills_changed` so clients can refresh the effective catalog.
- Remote plugin changes use ChatGPT plugin-service, reconcile installed plugins,
  and verify the resulting state. Expired credentials are refreshed once without
  exposing credentials over ACP; local changes report configuration overrides.

## 0.7.11 — 2026-10-12

### Added

- `_codex/session_list` returns all non-archived sessions across projects when called
  without params, walking native pages and deduplicating session IDs. Requests with
  defined params retain the filtering and pagination behavior of `session/list`.

### Fixed

- Suppress duplicate review results in live updates and full-turn history when the
  review exit repeats the assistant's answer, while preserving standalone or different
  review results regardless of native event order.

## 0.7.10 — 2026-10-11

### Fixed

- Restore image attachments, file references, and readable conversation titles in
  history instead of exposing serialized attachment wrappers or Markdown links.
- Load native local image attachments with bounded reads and preserve unavailable
  image placeholders when clipboard files have expired.
- Parse single and multiple questionnaire replies into question and answer metadata
  for both live messages and history, preserving malformed input as ordinary text.
- Report user send times, assistant completion times, and live work duration through
  message metadata; keep native historical total duration distinct from work duration.
- Preserve interruption metadata when replaying history and when live turns stop.

## 0.7.9 — 2026-10-10

### Added

- `/plan <task>` enables plan mode and starts the supplied task; `/plan` alone
  continues to toggle plan mode.

### Fixed

- Insert foreground prompts and local commands before acknowledging acceptance,
  preserving their original message IDs and content when Codex echoes them later.
- Persist `/plan` and `/review` receipt mappings across adapter restarts, session
  resume, forks, and read-only history; hide internal plan implementation prompts.
- Guard history when command receipt persistence cannot be confirmed, while clearing
  unused guards after explicit pre-execution rejections so history remains available.
- Keep receipt writes off the notification queue, bound persistence and restoration
  waits, and prevent cancelled or late reads from affecting subsequent turns.
- Recover Stop when completion notifications are missing by checking native thread
  status and retrying interruption; report cancellation only after stopping is
  confirmed and allow another Stop attempt when confirmation is unavailable.
- Restore active sessions without replaying stored messages or tool snapshots when
  `replayFrom` is omitted or null; announce restored tools when live activity needs them.

## 0.7.8 — 2026-10-10

### Fixed

- Update ACP SDK to 1.8.0 and report failed turns with the standard `error` stop reason and JSON-RPC error details. Preserve Codex diagnostics and existing limit/refusal classifications.

## 0.7.7 — 2026-10-09

### Added

- Independent read-only history APIs: `_codex/session_history` for paginated turns and
  `_codex/session_history_items` for paginated items, advertised through the version 2
  `sessionHistory` capability.
- Browse mode for live history and export mode with optimistic consistency checks,
  bounded response sizes, scoped cursors, cancellation, and structured errors.
- History projections preserve media references and text annotations, with optional
  native records and explicit omission metadata for archival and export consumers.

### Fixed

- Session listing includes custom-provider conversations by clearing the native
  default model-provider filter.

## 0.7.6 — 2026-10-08

### Added

- The `_meta` of a `session/prompt` is echoed once on the `user_message` reported under the same receipt id
  (`_meta.alwith.messageId`), merged with the adapter's own `_meta.codex`. A host can therefore attach its own
  per-message metadata (canvas references, attachments, a skill name) and get it back from the live stream and
  from the Runtime's session event log on replay. Codex's own history snapshots (`session/load`) do not carry it.

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
