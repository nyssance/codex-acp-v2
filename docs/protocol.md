# Wire contract

`codex-acp-v2` implements the ACP v2 draft as shipped in `@agentclientprotocol/sdk`
`experimental/v2`. This page lists what the agent accepts, what it emits, and the
`_meta.codex` keys it adds. Anything not listed is standard ACP behaviour.

## Handshake

`initialize` requires `protocolVersion: 2` and `info`. The response advertises:

```json
{
  "capabilities": {
    "session": {
      "prompt": {"image": {}, "embeddedContext": {}},
      "mcp": {"stdio": {}, "http": {}},
      "fork": {}, "delete": {}, "additionalDirectories": {}
    }
  },
  "authMethods": [
    {"type": "agent", "methodId": "api-key"},
    {"type": "agent", "methodId": "chat-gpt"},
    {"type": "agent", "methodId": "chat-gpt-device-code"}
  ]
}
```

`chat-gpt` is omitted when `NO_BROWSER` is set; `chat-gpt-device-code` is offered only
to clients that declare `capabilities.elicitation.url`. Every other method returns
`-32600` until `initialize` has succeeded.

`auth/login` with `api-key` reads `_meta["api-key"].apiKey`, then `CODEX_API_KEY`,
then `OPENAI_API_KEY`. `session/new` returns `-32000` (auth required) while Codex has
no account.

## Sessions

| Method | Notes |
| --- | --- |
| `session/new` | `cwd` must be absolute. `additionalDirectories` become trusted projects and sandbox write roots. `mcpServers` (stdio, http) are added to the thread config; names that collide with the user's Codex config are skipped. |
| `session/resume` | `replayFrom: {type: "start"}` replays the transcript as `session/update` frames before the response; `null` or omitted restores context only. Other cursors are rejected. |
| `session/fork` | Forks the Codex thread and replays the copied transcript under the new session id. |
| `session/list` | `cwd` filters by exact Codex thread cwd; `cursor` pages. |
| `session/close` | Interrupts a running turn, waits for it, unsubscribes. |
| `session/delete` | Close plus `thread/archive`. |
| `session/set_config_option` | Returns and broadcasts the full option list. |

### Config options

| `configId` | `category` | Type | Values |
| --- | --- | --- | --- |
| `mode` | `mode` | select | `read-only`, `agent`, `agent-full-access` |
| `model` | `model` | select | Codex catalog ids (the current id is always listed) |
| `effort` | `thought_level` | select | efforts supported by the current model |
| `collaboration_mode` | `model_config` | select | `default`, `plan` |
| `fast_mode` | `model_config` | boolean | only when the model offers the `fast` service tier |

Changing `model` re-validates `effort` and clears `fast_mode` if the new model does
not support it.

## Prompts and state

`session/prompt` returns `{}` immediately (or `-32602` for an empty prompt, an image
on a text-only model, or an unknown session). While a turn runs, another prompt on
the same session is injected into it with `turn/steer` and returns
`{_meta: {codex: {steered: "<turnId>"}}}`.

State frames:

| `state` | When |
| --- | --- |
| `running` | Turn accepted. Also after every blocking client request resolves. |
| `requires_action` | The first open `session/request_permission` or `elicitation/create`. |
| `idle` | Turn over. `stopReason` is `end_turn` or `cancelled`; `usage` carries the last turn's tokens when known. |

A failed turn emits an `agent_message_chunk` with the error text and
`_meta.codex.error {message, codexErrorInfo, additionalDetails}`, then
`idle` with `stopReason: "end_turn"` and the same `_meta.codex.error`.

`session/cancel` calls `turn/interrupt`; the turn ends with `idle` / `cancelled`.

## Session updates

| Update | Source |
| --- | --- |
| `agent_message_chunk` | `item/agentMessage/delta`; `messageId` is the Codex item id; `_meta.codex.phase` is `commentary` or `final_answer`. Notices (warnings, model reroutes) use `_meta.codex.notice: true`. |
| `agent_thought_chunk` | reasoning deltas, keyed by item id |
| `user_message`, `agent_message`, `agent_thought` | history replay only |
| `tool_call_update` | see below |
| `terminal_update`, `terminal_output_chunk` | shell commands; `terminalId` equals the tool call id; data is base64 |
| `plan_update` | `turn/plan/updated` → `{type: "items", planId: "codex-turn-plan"}`; plan-mode drafts → `{type: "markdown", planId: <item id>}` |
| `usage_update` | `thread/tokenUsage/updated`: `used` = last turn total tokens, `size` = model context window |
| `session_info_update` | `title` from Codex thread names, or the first prompt line as a fallback; `_meta.codex.retry` for transient errors Codex is retrying |
| `available_commands_update` | built-in slash commands plus `$<skill>` entries |
| `config_option_update` | after every `session/set_config_option` and `/plan` |

### Tool calls

The first frame for a `toolCallId` carries `name`, `title`, and `kind`; later frames
omit `name` and patch `status`, `content`, `rawOutput`. Codex `interrupted` items map
to status `cancelled`, and a cancelled turn marks every still-open tool call
`cancelled` before the `idle` frame.

| `name` | `kind` | Codex item |
| --- | --- | --- |
| `shell` | `execute` | unclassified command; `content: [{type: "terminal"}]` |
| `read_file`, `list_files` | `read` | command classified as a read or listing |
| `search` | `search` | command classified as a search |
| `apply_patch` | `edit` | file change; `content` is `diff` with `changes` and `patch {format: "git_patch"}`, `locations` lists every path |
| `mcp` | `execute` | MCP tool call; progress arrives as text content |
| `dynamic_tool` | `execute` | dynamic tool call |
| `web_search` | `fetch` | web search |
| `view_image` | `read` | image view |
| `image_generation` | `other` | image generation; result as image content |
| `compact` | `think` | context compaction |
| `subagent`, `collab` | `other` | sub-agent activity and collaboration calls; `_meta.codex.subagent` / `_meta.codex.collaboration` |
| `fuzzy_file_search` | `search` | Codex fuzzy file search sessions |
| `guardian_review` | `think` | auto-approval reviews |
| `mcp_startup` | `other` | failed MCP server startups (status `failed`) |
| `plan_review` | `switch_mode` | plan approval prompt |

## Permissions

All approvals use `session/request_permission` with `title`, optional `description`
(the Codex reason), and `subject: {type: "tool_call", toolCall}` whose `toolCallId`
is the Codex item id. Clients answer with an advertised `optionId`; `cancelled`,
unknown ids, and transport errors fail closed.

| Title | Options (`optionId` → Codex decision) |
| --- | --- |
| `Run command?` / `Allow network access?` | `allow_once` → accept, `allow_for_session` → acceptForSession, `accept_execpolicy_amendment` → acceptWithExecpolicyAmendment, `apply_network_policy_amendment:<n>` → applyNetworkPolicyAmendment, `decline`, `cancel`. When Codex sends `availableDecisions` that list is authoritative. |
| `Make edits?` | `allow_once` → accept, `allow_for_session` → acceptForSession, `cancel` |
| `Grant permissions?` | `allow_permissions_turn`, `allow_permissions_turn_strict_auto_review`, `allow_permissions_session`, `reject_permissions` |
| MCP approvals | `allow_once` / `accept`, `allow_session`, `allow_always` (only when Codex advertises `persist`), `decline`, `cancel` |
| `Implement this plan?` | `implement_plan`, `revise_plan` |

Option descriptions ride in `_meta.codex.description`.

## Elicitation

- MCP form elicitations use `elicitation/create` (`mode: "form"`) when the client
  declares `elicitation.form`; MCP `enum`/`enumNames` schemas are converted to `oneOf`.
  A structured form the client cannot render is cancelled rather than degraded.
- MCP URL elicitations use `mode: "url"` when the client declares `elicitation.url`;
  `elicitation/complete` follows once Codex resolves the request.
- Message-only MCP requests fall back to `session/request_permission`.
- Codex user-input questions (`item/tool/requestUserInput`) become a form whose
  `toolCallId` is the Codex item; questions with an "other" answer add a
  `<id>__other` text field.
