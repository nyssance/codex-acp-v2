# Changelog

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
