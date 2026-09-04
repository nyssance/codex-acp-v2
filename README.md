# codex-acp-v2

[![npm version](https://img.shields.io/npm/v/%40nyssance%2Fcodex-acp-v2)](https://www.npmjs.com/package/@nyssance/codex-acp-v2)

A native [Agent Client Protocol v2](https://agentclientprotocol.com/) agent for the
[OpenAI Codex](https://github.com/openai/codex) app-server. It speaks ACP v2 over
stdio, maps each ACP session onto a Codex thread, and translates the Codex
`thread/*`, `turn/*`, and `item/*` event surface into ACP `session/update` frames.

This is an independent project, not an official OpenAI or Agent Client Protocol
release. It started from the Apache-2.0 licensed
[`agentclientprotocol/codex-acp`](https://github.com/agentclientprotocol/codex-acp)
and keeps its copyright and license notices. There is no ACP v1 surface and no
compatibility layer: everything is written against `@agentclientprotocol/sdk/experimental/v2`.

## What it does

- **Session lifecycle**: `session/new`, `session/resume` (with `replayFrom: {type: "start"}`
  transcript replay), `session/fork`, `session/list`, `session/close`, `session/delete`.
- **Asynchronous prompts**: `session/prompt` returns immediately; the turn is
  reported through `state_update` frames (`running`, `requires_action` while a
  permission or form is open, `idle` with `stopReason` and token `usage`).
  A prompt sent during a running turn is steered into it.
- **Streaming**: `agent_message_chunk` / `agent_thought_chunk` keyed by Codex item id,
  `plan_update` (turn plans as items, plan-mode drafts as markdown), `usage_update`,
  `session_info_update` titles, `available_commands_update`.
- **Tool calls as upserts**: `tool_call_update` only. Shell commands stream through
  ACP terminals (`terminal_update`, `terminal_output_chunk`); file changes carry v2
  diff content (`changes` + a `git_patch`); MCP, dynamic tools, web search, image
  view/generation, compaction, sub-agents, and guardian reviews are all mapped.
- **Permissions**: Codex command, file-change, sandbox-permission, and MCP approvals
  become `session/request_permission` with a `tool_call` subject. Every option maps
  back to the exact Codex decision it came from; anything else fails closed.
- **Elicitation**: MCP forms and URLs and Codex user-input questions use
  `elicitation/create` when the client supports it, with a permission fallback for
  message-only requests.
- **Config options**: `mode` (approval and sandbox preset), `model`, `effort`,
  `collaboration_mode` (plan mode), and `fast_mode` when the model offers it.
- **Auth**: `api-key`, `chat-gpt` (browser), and `chat-gpt-device-code` (URL elicitation).
- **Slash commands**: `/review`, `/review-branch`, `/review-commit`, `/compact`,
  `/plan`, `/status`, `/mcp`, `/skills`, `/logout`, plus `$skill` entries from Codex.

See [`docs/protocol.md`](docs/protocol.md) for the exact wire contract.

## Installation

```bash
npx -y @nyssance/codex-acp-v2
```

or

```bash
bun add -g @nyssance/codex-acp-v2
codex-acp-v2 --version
```

The package bundles a compatible `@openai/codex`. Set `CODEX_PATH` to use another
Codex executable.

## Runtime options

Everything a client needs is negotiated over the wire; environment variables only
adjust defaults.

| Variable | Effect |
| --- | --- |
| `CODEX_PATH` | Codex executable to spawn (`codex app-server`). Default: bundled `@openai/codex`. |
| `CODEX_CONFIG` | JSON object merged into every thread's Codex config. |
| `MODEL_PROVIDER` | Codex model provider for new threads. |
| `INITIAL_AGENT_MODE` | `read-only`, `agent` (default), or `agent-full-access`. |
| `CODEX_API_KEY` / `OPENAI_API_KEY` | Key used by the `api-key` auth method. |
| `NO_BROWSER` | Hide the browser-based `chat-gpt` auth method. |
| `APP_SERVER_LOGS` | Directory for the adapter log file (wire frames included). |

## Client configuration

```json
{
  "agent_servers": {
    "Codex": {
      "command": "codex-acp-v2",
      "env": {"CODEX_PATH": "/opt/homebrew/bin/codex"}
    }
  }
}
```

## Development

```bash
bun install
bun run typecheck
bun run test          # unit suite with a fake Codex
bun run test:e2e      # live suite against a real codex app-server
bun run build         # dist/index.js
```

See [`readme-dev.md`](readme-dev.md) for the architecture.
