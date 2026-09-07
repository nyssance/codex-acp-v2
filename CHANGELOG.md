# Changelog

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
