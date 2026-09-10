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
Concurrent initialization requests share one Codex handshake. A failed handshake
does not unlock session methods and can be retried.

`auth/login` with `api-key` reads `_meta["api-key"].apiKey`, then `CODEX_API_KEY`,
then `OPENAI_API_KEY`. `session/new` returns `-32000` (auth required) while Codex has
no account.

## Providers

The agent advertises `capabilities.providers` and exposes one slot, `providerId: "openai"`,
which is where Codex's OpenAI-protocol traffic goes.

| Method | Behaviour |
| --- | --- |
| `providers/list` | Reports the committed routing for new sessions with `supported: ["openai"]` and its `baseUrl`. |
| `providers/set` | `{providerId: "openai", apiType: "openai", baseUrl, headers?}` routes Codex through that gateway: new and open sessions get a `model_providers.custom-gateway` config entry and `modelProvider: "custom-gateway"`. Open sessions with persisted history are unsubscribed and resumed with the new routing; a running turn makes the request fail with `-32600`. |
| `providers/disable` | `{providerId: "openai"}` restores native routing; other ids are a no-op. |

Accepted hints on `providers/set._meta`: `alwith.models` (`[{id, label?, description?}]`)
becomes the session model catalog, `alwith.model` selects the model, `codex.name` labels the
provider. The gateway must implement the OpenAI Responses API; Codex 0.153 no longer speaks
chat completions. With a gateway active `session/new` does not require an OpenAI login.

## Sessions

| Method | Notes |
| --- | --- |
| `session/new` | `cwd` must be absolute. `additionalDirectories` become trusted projects and sandbox write roots. `mcpServers` (stdio, http) are added to the thread config; names that collide with the user's Codex config are skipped. |
| `session/resume` | `replayFrom: {type: "start"}` replays the transcript as `session/update` frames before the response, paged through Codex `thread/turns/list` in pages of 50 turns; `null` or omitted restores context only. Other cursors are rejected. |
| `session/fork` | Forks the Codex thread and replays the copied transcript under the new session id. The source session remains open, including any running turn. |
| `session/list` | `cwd` filters by exact Codex thread cwd; `cursor` pages. |
| `session/close` | Detaches locally within a single 5-second budget, subject to event-loop scheduling. At most half is spent waiting for an interrupted turn; the remainder is reserved for unsubscribe. Stalled client writes do not prevent cleanup. A late start is interrupted when its id becomes known. |
| `session/delete` | Close plus `thread/delete` (permanent deletion). |
| `_codex/session_archive` | `{sessionId}` closes and archives the thread (reversible hiding). Advertised as `capabilities._meta.codex.archive: true`. |
| `_codex/session_unarchive` | `{sessionId}` restores an archived thread's visibility. |
| `session/set_config_option` | Returns and broadcasts the full option list. |

`session/list` with `_meta: {codex: {archived: true}}` lists archived threads.
The default is the non-archived list; each returned session includes
`_meta.codex.archived`.

`session/new` accepts `_meta.codex.seedHistory: [{role, text}]`, with `role` equal
to `"user"` or `"assistant"`. These entries are injected into the new thread as
model-visible history before the first prompt. This extension is advertised as
`capabilities._meta.codex.seedHistory: true`.

Invalid replay cursors, additional directories, and seed history are rejected
before an existing session is closed or a new thread is created.

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

## Skills and plugins

Codex's skill and plugin catalogs are exposed as `_codex/*` requests whose params and
results are the Codex app-server v2 shapes, passed through verbatim (see
`src/app-server/v2/`). Codex validates the fields; the adapter only checks that params
are an object and requires a successful `initialize`. Codex errors propagate unchanged.
Advertised as `capabilities._meta.codex.skills: true` and `capabilities._meta.codex.plugins: true`.

| Method | Codex request | Params → result |
| --- | --- | --- |
| `_codex/skills_list` | `skills/list` | `SkillsListParams` → `SkillsListResponse` |
| `_codex/skills_config_write` | `skills/config/write` | `SkillsConfigWriteParams` → `SkillsConfigWriteResponse` |
| `_codex/plugin_list` | `plugin/list` | `PluginListParams` → `PluginListResponse` |
| `_codex/plugin_installed` | `plugin/installed` | `PluginInstalledParams` → `PluginInstalledResponse` |
| `_codex/plugin_install` | `plugin/install` | `PluginInstallParams` → `PluginInstallResponse` |
| `_codex/plugin_uninstall` | `plugin/uninstall` | `PluginUninstallParams` → `{}` |
| `_codex/plugin_read` | `plugin/read` | `PluginReadParams` → `PluginReadResponse` |
| `_codex/marketplace_add` | `marketplace/add` | `MarketplaceAddParams` → `MarketplaceAddResponse` |
| `_codex/marketplace_remove` | `marketplace/remove` | `MarketplaceRemoveParams` → `{}` |
| `_codex/marketplace_upgrade` | `marketplace/upgrade` | `MarketplaceUpgradeParams` → `MarketplaceUpgradeResponse` |

The agent sends the `_codex/skills_changed` notification (params `{}`) whenever Codex
emits `skills/changed`, and after each successful `_codex/skills_config_write`,
`_codex/plugin_install`, `_codex/plugin_uninstall` and `_codex/marketplace_*` request.
Plugins ship skills, so one signal covers both catalogs; a host refetches on it.
The adapter's own skill snapshot and `available_commands_update` handling is unchanged.

## Prompts and state

`session/prompt` returns `{}` immediately (or `-32602` for an empty prompt, an image
on a text-only model, or an unknown session). While a turn runs, another prompt on
the same session is injected into it with `turn/steer` and returns
`{_meta: {codex: {steered: "<turnId>"}}}`.
Image capability validation also applies to steering. Once `idle` is published,
the next prompt starts a new turn rather than steering the completed one.

State frames:

| `state` | When |
| --- | --- |
| `running` | Turn accepted. Also after every blocking client request resolves. |
| `requires_action` | The first open `session/request_permission` or `elicitation/create`. |
| `idle` | Turn over. `stopReason` is `end_turn` or `cancelled`; `usage` carries the last turn's tokens when known. |

A failed turn emits an `agent_message_chunk` with the error text and
`_meta.codex.error {message, codexErrorInfo, additionalDetails}`, then
`idle` with `stopReason: "_error"` (an ACP extension value; render unknown reasons
generically) and the same `_meta.codex.error`.

`session/cancel` calls `turn/interrupt`; the turn ends with `idle` / `cancelled`.
Repeated cancel/close requests coalesce an in-flight or successfully acknowledged interrupt. After an explicit rejection, a subsequent cancel or close retries; there is no automatic retry loop.
Cancellation before `turn/start` prevents that turn from being sent, even if
the preceding skills refresh is still pending. For `/compact`, cancellation
ends the adapter's wait and reports `idle` / `cancelled`; Codex exposes no
compaction-specific interrupt, so background compaction may still finish.

Blocking requests are counted per turn: a late response from a previous turn
cannot clear the current turn's `requires_action` state. A lost Codex connection
also ends waits for compaction and plan approval with `_error`.

## Session updates

| Update | Source |
| --- | --- |
| `agent_message_chunk` | `item/agentMessage/delta`; `messageId` is the Codex item id; `_meta.codex.phase` is `commentary` or `final_answer`. Notices (warnings, model reroutes) use `_meta.codex.notice: true`. |
| `agent_thought_chunk` | reasoning deltas, keyed by item id |
| `user_message` | history replay, and once per turn when Codex materializes the prompt as a `userMessage` item (its item id is the `messageId`) |
| `agent_message`, `agent_thought` | history replay only |
| `tool_call_update` | see below |
| `terminal_update`, `terminal_output_chunk` | shell commands; `terminalId` equals the tool call id; data is base64 |
| `plan_update` | `turn/plan/updated` → `{type: "items", planId: "codex-turn-plan"}`; plan-mode drafts → `{type: "markdown", planId: <item id>}` |
| `usage_update` | `thread/tokenUsage/updated`: `used` = last turn total tokens, `size` = model context window |
| `compaction_update` | `compactionId` = Codex `contextCompaction` item id; `in_progress` on item/started, `completed` on item/completed (history snapshots report `completed`). No `compaction_summary_chunk`: Codex exposes no summary text. |
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

### Shutdown and routing failure details

`session/close` reports `_meta.codex.close` with `attempted: true`,
`localDetached: true`, and `remoteUnsubscribe: "confirmed" | "timed_out" | "failed"`
when a loaded session is closed. Closing an unknown session remains a no-op.
A timeout confirms only local cleanup, not remote unsubscription. Terminal updates
are best effort: a completed local write is not acknowledgement by the client.
Codex stdout EOF drains already received RPC frames through the dispatcher before
publishing connection loss; an already dispatched turn completion remains authoritative.
Shutdown does not wait for user approvals to finish.

Provider changes are staged and committed only after all open sessions rebind.
All sessions' history is checked before changing subscriptions. Codex cannot resume
an empty thread whose history storage has not yet been created; in that case the
request fails with `-32600` before changing routing. Close empty sessions, configure
the provider, then create them again. Rebinding unsubscribes before resume because
Codex treats resume of a subscribed thread as rejoin and ignores routing overrides.
Competing provider changes are serialized. During a switch, prompt admission,
session lifecycle changes, and config changes fail with a retryable `-32600` error.
A switch also fails if lifecycle/config work or a turn is already active.
Overlapping lifecycle/config operations on the same session and prompts during
those operations are rejected with `-32600`; retry after the operation finishes. Inference
turns do not hold a global lifecycle lock.

On failure, the adapter retains the previous committed routing and attempts remote
compensation for every attempted session, including the request that failed.
The error data includes `attemptedSessions` and `staleSessions`. Failed compensation
marks affected sessions with `_meta.codex.routing.stale: true` on a standard
`config_option_update`; their prompts are rejected until a successful resume or
provider switch. Successful switching emits `stale: false`. The config update does
not contain or attest to a provider URL. JSON-RPC errors do not imply no remote side
effects; uncertain remote state is reported explicitly.

Wire logging redacts structured credential/header fields and complete `env` maps,
including arbitrarily named MCP environment variables. Logs are not guaranteed to
be secret-free: command arguments, free-form tool output, and Codex stderr may
contain sensitive text and are not heuristically redacted.

A timed-out unsubscribe fences subsequent resume/fork of that thread until the
outstanding RPC settles. These attempts fail promptly with `-32600`, rather than
racing a late unsubscribe against a new subscription. Delete/archive requests
after local close still wait for Codex to acknowledge the remote mutation; the
local close deadline is not a deadline for those separate remote operations.

### Recovery and terminal outcomes

Live `agent_message` completion updates carry the authoritative full content for
that message id. ACP v2 clients replace previously accumulated content when a
concrete `content` array arrives; they must not append the snapshot to earlier
`agent_message_chunk` text. History replay uses the same snapshot mapping.
Completed-only tools, and progress/patch events received without a start, emit a
complete first upsert with `name`, `title`, and `kind`.

Before an idle update, unfinished tool calls are reconciled to the enclosing
turn's outcome and marked `_meta.codex.reconciled: true`. Orphan terminals receive
an `exitStatus` with unknown (`null`) exit code and signal; this does not assert
that a process exited successfully or received a particular OS signal. Their
`_meta.codex.turnOutcome` records `completed`, `failed`, or `cancelled`.

Terminal snapshots retain full output. For all commands, duplicate
`tool_call_update.rawOutput.output` is capped at 16,384 UTF-16 code units, without
splitting a surrogate pair. A capped result has `_meta.codex.outputTruncated`,
`outputCharacters`, and (for terminal-backed commands) `terminalId`; obtain the
complete output from the terminal or the classified tool call’s text content.

Context-window exhaustion ends with `max_tokens`; Codex policy violations end
with `refusal`. Other failures retain `_error`. Error metadata under
`_meta.codex.error` includes `category` and `retryable`; retryability is advisory
and never causes automatic resubmission of a failed model turn.

A rejected steer becomes a new prompt only after a matching completion or local
turn finalization proves the old turn ended. Unexpected `turn/started` events are
observed as running foreground work, including cancellation and finalization.
Resuming an active thread discovers its current turn through paged history.

Repeated cursors in automatically paginated model catalogs or history fail with
an actionable error. Failed-open cleanup has the same bounded unsubscribe wait
and pending-unsubscribe fence as session close.


### Cache freshness and cancellation

Skill metadata is reused for an unchanged working-directory context. A Codex
`skills/changed` notification invalidates it. Commands refresh immediately for the
current root context; other sessions refresh on their next foreground prompt.
Notifications never switch roots, preventing delayed watcher echoes from causing
a refresh loop.
Because extra skill roots are process-global in Codex, context changes are
serialized through thread/turn start acknowledgement; model inference can run
concurrently. Switching roots invalidates the previous snapshot. Model catalogs
are shared for up to 30 seconds, invalidated on `account/updated` and local login/logout, and forcibly
refreshed for provider changes. Account notifications also refresh live session
account-dependent settings.

Request cancellation for `session/new`, `session/resume`, and `session/fork`
returns `-32800` promptly. A remote request already in flight may still finish;
its late result is unsubscribed rather than left as an inaccessible open session.
Lifecycle admission stays held until that operation settles, so a replacement or
provider transition cannot race the cleanup. Cancellation is not a rollback of
already completed remote actions.


Skill-root serialization covers foreground turns started by this adapter and
steering into those turns. It is not thread or tenant isolation. Codex-created
subagent/automatic turns and turns started by other app-server clients snapshot
process-global roots at their own start time and are outside this guarantee.
The pinned Codex 0.153 implementation constructs the skill snapshot before
returning a started turn: [turn input handling](https://github.com/openai/codex/blob/rust-v0.153.0/codex-rs/core/src/session/turn_input.rs)
and [turn context construction](https://github.com/openai/codex/blob/rust-v0.153.0/codex-rs/core/src/session/turn_context.rs).

Turn-scoped `item/*` notifications are ignored while idle or when they name a
known different active turn. Items are accepted while a local turn's id is still
unknown, because Codex may deliver them before its start response.
