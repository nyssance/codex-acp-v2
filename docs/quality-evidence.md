# Quality evidence and reproducible acceptance

This document records reproducible acceptance checks and their measurement scope.

## Reference scope

The source comparison used `agentclientprotocol/codex-acp` at commit
`1a3c01e8ca317f83e3b60bc5632cf052882bea15` (2026-09-07 checkout). It targets a
different ACP SDK entry point. Its AIR-specific `async_task_*` updates are not
valid additions to this repository's standard ACP v2 update surface. Background
terminal APIs absent from the generated Codex types and speculative custom goal
or rename extensions are not copied as feature-count targets.

## Source comparison at the pinned reference commit

| Dimension | This adapter | Reference source |
| --- | --- | --- |
| ACP entry point | `sdk/experimental/v2` only | Root SDK entry point in `CodexAcpServer.ts` |
| Background task updates | Standard tool/terminal updates with `_meta.codex` | Custom `async_task_spawned` and `async_task_progress` in `AcpAsyncTasks.ts` |
| Completion snapshots | Shared live/history snapshot mapping and client-reducer tests | Completion handling compared in `CodexEventHandler.ts`; not benchmarked here |
| Performance comparison | Reproducible local workloads with stated scope | No identical harness run, so no relative speed claim |

Reference: [agentclientprotocol/codex-acp pinned source](https://github.com/agentclientprotocol/codex-acp/tree/1a3c01e8ca317f83e3b60bc5632cf052882bea15).
These are scope differences, not evidence of an overall product ranking.

## Run the acceptance checks

```sh
bun run typecheck
bun run test
bun run build
bun run test:e2e
bun run test:soak
BENCHMARK_OUTPUT=/tmp/codex-acp-benchmark.json bun run test:benchmark
```

The live suite uses the local Codex login or explicitly supplied API credentials.
The benchmarks use a scripted app-server connection and require no account.

- The official ACP v2 client connects through seven-byte NDJSON fragments. Tests
  cover Unicode, initialization, session creation, prompt completion and close.
- An independent client reducer validates standard SDK update guards, first tool
  upserts, authoritative message replacement, and no running tool/terminal at idle.
  The same reducer checks every update in the live Codex suite.
- Regression tests cover completed-only messages/tools, progress before starts,
  interrupted state, orphan finalization, steering races, external turns, paginated
  history cycles, failed-open cleanup and typed error stop reasons.
- The opt-in soak sends 100,000 multilingual chunks over 500 turns, including 100
  interrupted outcomes. It checks every reconstructed transcript and terminal state.
  This is a deterministic stress test, not evidence of weeks of production uptime.
- The large-frame benchmark parses one 50 MiB JSON payload in 64 KiB fragments.
  The reader accumulates fragments and joins once per frame, avoiding repeated
  scanning and flattening of the growing line.

## Measurement interpretation

A local run on Apple M4 Pro, macOS arm64, Node 26.8.1 parsed the 50 MiB frame in
about 36 ms. Rerun on the deployment machine: latency is hardware/runtime specific.
Soak throughput includes adapter and client validation work, excludes network,
model inference and stdio, and is not directly comparable to live agent throughput.
Heap samples are observational without forced GC; Vitest and the recorder retain
state, so these samples cannot certify absence of an adapter memory leak.

CI now schedules type checking and behavior tests on Linux, macOS and Windows.
A workflow definition is not proof those remote jobs passed; check the actual CI
run before claiming platform certification. Each OS also compiles and runs a deterministic stdio fixture using the official
SDK client; this requires no Codex login. The existing child-exit/inherited-pipe
fixture is POSIX-only and is explicitly skipped on Windows.

The standalone executable was built locally and initialized against the installed
native Codex binary. Optional-package resolution now spawns the native executable
directly, avoiding recursive launch through a compiled adapter's `process.execPath`.
Hosts may continue to provide `CODEX_PATH` explicitly.


## Latest local acceptance run

- 206 behavior/unit tests passed, plus the two opt-in benchmark tests.
- Six real Codex E2E tests passed (91.23 seconds in the latest run).
- Source and compiled executable both passed the deterministic real-stdio test.
- Cold session open used five Codex RPCs; a warm prompt with unchanged skill roots
  used one. Two opens reused a model catalog; an account update invalidated it.
- An isolated Bun bridge soak ran 5,000 rounds with 500,000 chunks and 1,000
  interrupted outcomes. After forced GC, retained heap grew by 426,984 bytes.
  RSS grew by about 90 MiB; runtime allocation/JIT reservations are not equivalent
  to retained application heap. This test does not measure the whole agent process.

Raw measurements are produced by `BENCHMARK_OUTPUT` for the benchmark and soak
commands. Thresholds apply only to their named workload, not to model latency.

Skill-root timing was checked against pinned Codex 0.153 Rust source. The
foreground guarantee and autonomous/subagent exclusions are documented in
`protocol.md`. The local results above do not certify remote Linux/Windows runs.
