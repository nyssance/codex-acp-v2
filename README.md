# codex-acp-v2

[![npm version](https://img.shields.io/npm/v/%40nyssance%2Fcodex-acp-v2)](https://www.npmjs.com/package/@nyssance/codex-acp-v2)

An independently maintained [Agent Client Protocol v2](https://agentclientprotocol.com/)
adapter for the [OpenAI Codex](https://github.com/openai/codex) app-server.
It runs over stdio, translates ACP requests into Codex operations, and maps
Codex events back into the client.

This project is not an official OpenAI or Agent Client Protocol release. It is
derived from the Apache-2.0 licensed
[`agentclientprotocol/codex-acp`](https://github.com/agentclientprotocol/codex-acp)
project and preserves its copyright and license notices.

## Features

- Asynchronous ACP v2 prompt lifecycle with `running`, `idle`, and
  `requires_action` states.
- Completion stop reasons, token usage, stable message IDs, and replay.
- Session creation, resume, cancellation, and fork support.
- Model, reasoning effort, fast mode, approval, and sandbox configuration.
- Text, embedded context, images, resource links, and extra workspace roots.
- Shell, file change, MCP tool, reasoning, plan, web search, image generation,
  image view, permission, and review events.
- ChatGPT, API-key, and client-provided OpenAI-compatible gateway authentication.
- Client-provided MCP servers over stdio and HTTP transports.

ACP v2 is still experimental. SDK upgrades may require wire compatibility
changes in this adapter.

## Installation

Run the ACP v2 server directly:

```bash
npx -y @nyssance/codex-acp-v2
```

Or install it globally:

```bash
bun add -g @nyssance/codex-acp-v2
codex-acp-v2 --version
```

The npm package includes a compatible `@openai/codex` dependency. Set
`CODEX_PATH` only to use another Codex executable:

```bash
CODEX_PATH=/path/to/codex npx -y @nyssance/codex-acp-v2
```

## Authentication

The adapter advertises ACP authentication methods during initialization:

- ChatGPT login. Set `NO_BROWSER=1` to hide it in remote or browserless environments.
- API key via `CODEX_API_KEY` or `OPENAI_API_KEY`.
- A custom OpenAI-compatible gateway when the client advertises that capability.

## Runtime options

- `CODEX_API_KEY` — API key used when API-key auth is selected; takes precedence over `OPENAI_API_KEY`.
- `OPENAI_API_KEY` — fallback API key.
- `CODEX_PATH` — alternate Codex executable.
- `CODEX_CONFIG` — JSON object merged into Codex session configuration.
- `MODEL_PROVIDER` — model provider for new sessions.
- `DEFAULT_AUTH_REQUEST` — ACP auth request JSON used when Codex requires authentication.
- `INITIAL_AGENT_MODE` — `read-only`, `agent`, or `agent-full-access`.
- `NO_BROWSER` — hide browser-based ChatGPT authentication when set.
- `APP_SERVER_LOGS` — directory for adapter logs.

## Development

```bash
bun install
bun run start
bun run typecheck
bun test
```

`bun run start` launches ACP v2. Build standalone binaries in `dist/bin` with:

```bash
bun run bundle:all
bun run package:all
```

See [readme-dev.md](readme-dev.md) for local client configuration and type
generation.

## License

Apache-2.0. See [LICENSE](LICENSE). Contributions are licensed under the same
terms. This repository is derived from `agentclientprotocol/codex-acp`; its
upstream history and attribution are retained in Git and the license notices.
