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
| `providers/set` | `{providerId: "openai", apiType: "openai", baseUrl, headers?}` routes Codex through that gateway: new and open sessions get a `model_providers.<id>` config entry and `modelProvider: "<id>"`, where `<id>` is `_meta.codex.id` (default `custom-gateway`). Open sessions with persisted history are unsubscribed and resumed with the new routing; a running turn makes the request fail with `-32600`. |
| `providers/disable` | `{providerId: "openai"}` restores native routing for every gateway; with `_meta.codex.id` only that gateway is removed (catalog mode). Other provider ids are a no-op. |

Accepted hints on `providers/set._meta`:

| Hint | Meaning |
| --- | --- |
| `codex.id` | Gateway id, `[a-z0-9-]+`, default `custom-gateway`: the `model_providers` entry, the `modelProvider` value and (catalog mode) the select group. Codex's own provider ids (`openai`, the configured `model_provider`) and the native group id `chatgpt` are refused. |
| `alwith.models` | `[{id, label?, description?}]`: the models the gateway serves; Codex cannot list them. Model ids must be unique across gateways; a clash is refused with `-32602` naming the other gateway. |
| `alwith.model` | The model to select on the gateway. |
| `codex.name` | Label of the `model_providers` entry (and of the gateway's select group in catalog mode). |
| `codex.bearerToken` | Written as `experimental_bearer_token` on the entry, the key DeepSeek's official Codex integration uses; Codex adds the `Authorization` header itself. |
| `codex.config` | Extra top-level Codex thread-config keys that apply only to threads on the gateway (`model_catalog_json`, `web_search`, `model_reasoning_effort`, …). Must be an object; `model_providers` is refused. When it names a `model_catalog_json` file, the adapter reads it so the gateway's models carry their real reasoning levels, modalities and display names (`model/list` never reflects a per-thread catalog). |
| `codex.mode` | `"route"` (default): the gateway takes over every session. `"catalog"`: see below. |

The gateway must implement the OpenAI Responses API; Codex 0.153 no longer speaks
chat completions. A session on the gateway does not require an OpenAI login.

### Catalog mode

`providers/set` with `_meta.codex.mode: "catalog"` registers a gateway without re-routing
anything. Any number of gateways can be registered this way, each under its own
`codex.id`; a route-mode `providers/set` replaces them all. `providers/list` keeps
reporting native routing, with every gateway under `providers[]._meta.codex.gateways`
(`[{id, name, baseUrl, models}]`; `_meta.codex.gateway` is the first one, kept for older
clients), and every session's `model` option becomes one group per source: `chatgpt`
(named ChatGPT: the models Codex serves through the ChatGPT sign-in) followed by one group per gateway (groupId = its id, named after
`codex.name`, listing its `alwith.models`). Advertised as
`capabilities._meta.codex.providerCatalog: true`.

- `session/set_config_option {configId: "model"}` with a gateway model moves **only that
  session** to the gateway that serves the model (a thread's config carries only that
  gateway's `model_providers` entry); a native model moves it back. Codex has no per-turn provider
  (`turn/start` overrides the model only), so the move is the same unsubscribe + cold
  `thread/resume` an agent-wide change uses, with the gateway's `model_providers` entry and
  `codex.config` overrides in that thread's config. A thread Codex has not materialized yet
  (no user message) is materialized first by injecting a one-line developer note, because
  Codex refuses to cold-resume it otherwise. `effort` then lists the gateway model's levels.
  A running turn on that session → `-32600`.
- `session/new` and `session/fork` stay native unless `_meta.alwith.model` names a gateway
  model. `session/resume` opens the thread on what `_meta.alwith.model` asks for, else on
  the provider Codex recorded for it (`thread/read`). Codex records the provider a thread
  was **created** with, not one it was moved to later, so a client that moved a thread
  should pass `_meta.alwith.model` when it resumes it.
- `providers/disable` returns gateway sessions to native routing and drops the gateway
  groups (an empty gateway session is materialized the same way first); with
  `_meta.codex.id` only that gateway's sessions move and only its group goes.
  Re-registering a gateway under the same id (a rotated key) re-resumes the sessions on it
  with the new entry and leaves sessions on other gateways alone.
- Catalog mode does not affect ALwith Desktop's agent-wide `providers/set` (no `mode` hint).



## Sessions

| Method | Notes |
| --- | --- |
| `session/new` | `cwd` must be absolute. `additionalDirectories` become trusted projects and sandbox write roots. `mcpServers` (stdio, http) are added to the thread config; names that collide with the user's Codex config are skipped. |
| `session/resume` | `replayFrom: {type: "start"}` replays the transcript as `session/update` frames before the response, paged through Codex `thread/turns/list` in pages of 50 turns; `null` or omitted restores context only. Other cursors are rejected. When Codex answers "already has an active writer" (its writer lock is a file lock across the Codex home: the thread is open in another Codex client — ChatGPT app, CLI, another app-server — and nothing here can release it) the session opens for viewing instead, the way Codex's TUI does: `thread/read` in place of `thread/resume`, history through the same `thread/turns/list` path, the response carries `_meta: {codex: {readOnly: true, reason: "active_writer"}}`. On such a session `session/prompt` and `session/set_config_option` fail with `-32600` "Thread is open in another Codex client" and `data: {codex: {readOnly: true}}`; `session/cancel` is a notification and is ignored. Resuming the same id again retries the real resume and, when the other client has let go, replaces the viewing session. |
| `session/fork` | Forks the Codex thread and replays the copied transcript under the new session id. The source session remains open, including any running turn. |
| `session/list` | `cwd` filters by exact Codex thread cwd; `cursor` pages. |
| `session/close` | Detaches locally within a single 5-second budget, subject to event-loop scheduling. At most half is spent waiting for an interrupted turn; the remainder is reserved for unsubscribe. Stalled client writes do not prevent cleanup. A late start is interrupted when its id becomes known. |
| `session/delete` | Close plus `thread/delete` (permanent deletion). |
| `_codex/session_history` | Read-only turn metadata or full ACP history without opening or subscribing to the session. See the contract below. Advertised as `capabilities._meta.codex.sessionHistory: {version: 2, items: true, modes: ["browse", "export"]}`. |
| `_codex/session_history_items` | Independent item pagination across a thread or within one turn; supports item anchors and optional native data. Part of the version 2 history capability. |
| `_codex/session_archive` | `{sessionId}` closes and archives the thread (reversible hiding). Advertised as `capabilities._meta.codex.archive: true`. |
| `_codex/session_unarchive` | `{sessionId}` restores an archived thread's visibility. |
| `_codex/session_rename` | `{sessionId, name}` → `thread/name/set`. A loaded thread then reports `thread/name/updated`, delivered as `session_info_update` with the new `title`; a thread that is not loaded gets no notification. Advertised as `capabilities._meta.codex.rename: true`. |
| `session/set_config_option` | Returns and broadcasts the full option list. |

`session/list` with `_meta: {codex: {archived: true}}` lists archived threads.
Both lists include all model providers, including custom gateways. `cwd` must match
the stored canonical path exactly (use the path returned by Codex, especially on
platforms where temporary directories have symlink aliases).
The default is the non-archived list; each returned session includes
`_meta.codex.archived`.

`session/new` accepts `_meta.codex.seedHistory: [{role, text}]`, with `role` equal
to `"user"` or `"assistant"`. These entries are injected into the new thread as
model-visible history before the first prompt. This extension is advertised as
`capabilities._meta.codex.seedHistory: true`.

Invalid replay cursors, additional directories, and seed history are rejected
before an existing session is closed or a new thread is created.

### Read-only history (version 2)

`capabilities._meta.codex.sessionHistory` advertises
`{version: 2, items: true, modes: ["browse", "export"]}`. Both history methods require
`initialize`, but not `session/resume`. They do not acquire a writer, create a runtime,
change subscriptions, interrupt a turn, unarchive a thread, or publish `session/update`
notifications. They read Codex's persisted history through its app-server, including
closed, archived, and other clients' threads. No second transcript store is created.

#### Turn pages and item pages

Get the latest turn summaries for a history browser:

```json
{"sessionId": "thread-id", "sortDirection": "desc", "limit": 20}
```

Send that request to `_codex/session_history`. `itemsView` defaults to `"summary"`:
only turn metadata is returned, with empty `updates` and `omissions`. Choose `"full"`
to project whole turns, or use `_codex/session_history_items` for bounded item pages:

```json
{"sessionId": "thread-id", "turnId": "turn-id", "limit": 20, "includeNative": true}
```

The item method accepts `turnId` to restrict the result to one turn. Omit it to page
items across the thread. `anchorItemId` requires `turnId` and starts exclusively after
that item in ascending order, or before it in descending order; it cannot be combined
with `cursor`. Continue from the returned cursor without repeating the anchor.
Turn IDs are obtained from the turn method; no full-turn load is required to locate
and read a turn's items.

Common parameters:

| Parameter | Contract |
| --- | --- |
| `sessionId` | Required non-empty Codex thread ID. |
| `cursor` | Opaque next cursor, null/omitted for the first page. Bound to the session, endpoint, direction, mode, view, native-data choice and (for items) turn filter. Preserve those options when continuing. |
| `limit` | Integer 1–100, default 50. Counts turns or items according to the endpoint. Can change between pages. |
| `sortDirection` | `"asc"` (default) or `"desc"`. Order within a whole turn remains chronological; the item endpoint orders individual items in the chosen direction. Start a new traversal to change direction. |
| `mode` | `"browse"` (default) or `"export"`, described below. |
| `includeNative` | Default false. Retain exact native item records under `_meta.codex`. On the turn method this requires `itemsView: "full"`. |
| `maxBytes` | Maximum serialized **result payload** size in bytes, excluding the JSON-RPC envelope. Default 1 MiB, allowed range 1 KiB–16 MiB. Can change between pages. |

Unknown parameters, invalid types, incompatible options and version 1 cursors fail
explicitly. Version 2 changes the unreleased version 1 default from full export to
summary browsing and replaces `omittedItems` with `omissions`.

Both responses contain `sessionId`, `cwd`, `title` (explicit name or preview, nullable),
`createdAt`, `updatedAt` (Unix **seconds**), `forkedFromId`, `running`, `consistency`,
`revision`, `nextCursor`, and `complete`. `running` is the observed thread/local prompt
state, not a subscription or a guarantee about the state after the response. It is
null when Codex reports an unloaded/unknown state: absence of a local runtime does
not prove that another client is idle.

- Turn responses add `turns[]`: `turnId`, `status`, `error`, `startedAt`, `completedAt`
  (nullable Unix **seconds**), `durationMs`, `itemsView`, `updates`, `omissions`, and
  optional `_meta.codex.items` containing full native `ThreadItem` records.
- Item responses add `items[]`: `turnId`, `itemId` (native item ID), `startedAtMs`,
  `completedAtMs` (nullable Unix **milliseconds**), `updates`, `omissions`, and optional
  `_meta.codex.item`. Item timestamps are not misreported as turn timestamps.
- `updates` contains standard ACP update payloads as response data, never notifications.
  Apply tool upserts in order. Message IDs preserve the existing receipt-ID convention;
  `_meta.codex.turnId` and the enclosing turn/item identify provenance. Full-turn message
  updates also carry `turnStartedAt` in milliseconds when known.
- `complete` means exactly `nextCursor === null`, the end of **this traversal**. It is
  not a complete-content, immutable-snapshot, or full-thread assertion: a traversal
  may be anchored, turn-filtered, summary-only, or missing previously collected pages.

#### Browsing versus export

`mode: "browse"` allows running sessions and returns `consistency: "live"`,
`revision: null`. The cursor remains usable when a new turn is appended. Codex may
change a returned in-progress item, or reject an invalidated cursor after rollback;
clients should upsert by turn/item identity and refresh or restart as appropriate.
This is suitable for history viewers, loading older messages, inspection and monitoring.
Each page requires one metadata read and one turn/item page read.

`mode: "export"` returns `consistency: "optimistic"` and a change fingerprint in
`revision`. It rejects a known running session, including a locally accepted prompt
not yet persisted by Codex. Before and after each page it compares thread metadata
and the last turn's **summary**, with the fingerprint carried by continuation cursors.
It no longer reloads a large final tool result merely to check every page boundary.
A detected change invalidates the traversal: discard collected pages and restart.
Use the same mode throughout a traversal and wait for the thread to become quiescent.

Example for textual/ACP export:

```json
{"sessionId": "thread-id", "mode": "export", "itemsView": "full", "limit": 10}
```

Export mode is a best-effort conflict check, **not an atomic snapshot or a content
hash of the entire history**. Codex has no transactional history version and its
thread timestamps have second precision. Changes to earlier items, or details absent
from a summary, can evade detection with unchanged timestamps/summary. No guarantee
extends past the final check. Strict backup/audit snapshots require stronger support
from Codex itself; version 2 does not claim to provide them.

#### Content fidelity and size

The new endpoints use a history-specific projection without changing live replay.
Mixed text, audio, images, skills and mentions retain separate content blocks. URL
and local media become `resource_link` blocks with `_meta.codex.inputType`; local paths
become file URIs. File-ID-only images use `codex-file:<encoded-id>` and retain `fileId`.
These are references, not fetched media or an automatic resource resolver. Text spans
are retained under `_meta.codex.textElements`.

`omissions[]` records `{itemId, field, reason}` for known projection losses, including
unmapped items (`field: "*"`), reasoning content replaced by a summary, and unrepresented
assistant fields. It is a diagnostic list, not a proof that every native field was
represented. For lossless capture of **native item records returned by Codex**, request
`includeNative: true`; the raw records remain namespaced under `_meta.codex` and follow
Codex's versioned schema. These records cannot recover data Codex never persisted,
truncated tool output, missing host metadata, or unavailable external files.

Responses exceeding `maxBytes` fail with `history_page_too_large` and `bytes`/`maxBytes`
diagnostics. Nothing is truncated and no continuation is consumed: retry the same
cursor with a smaller limit or a larger budget. To switch from whole turns to item
pagination, start the item endpoint without reusing a turn cursor. A single item can
still exceed the maximum; this fails explicitly rather than silently omitting it.
The cap applies after the native reply has been materialized; it bounds outgoing
payloads, not Codex's allocations or peak adapter memory. There is no chunked blob
transfer in this protocol.

#### Errors and cancellation

History errors include `data.reason` and `data.retryable`. Native failures also retain
`data.native.code` and `data.native.data`; numeric native RPC codes are preserved.
`retryable: null` means unknown, not an invitation to retry automatically. Known native
not-found/cursor failures are classified; unknown native errors remain intact.

| Reason | Caller action |
| --- | --- |
| `history_invalid_params` / `history_invalid_cursor` | Correct the request or start a new traversal; false. |
| `history_busy` | Wait for idle, then retry export; true. |
| `history_changed` | Discard all collected pages and restart without a cursor; true. |
| `history_not_found` | Report the missing source; false. |
| `history_unsupported` | Upgrade the Codex app-server; false. |
| `history_unavailable` | Retry after the reported source/transport problem is resolved; true. |
| `history_source_error` | Inspect preserved native diagnostics; retryability unknown. |
| `history_incomplete` / `history_invalid_page` | Do not publish an export; investigate the native response; false. |
| `history_page_too_large` | Retry with a smaller page or larger budget; true. |
| `history_cancelled` | Stop this traversal; false. |

Invalid inputs use `-32602`; local state conflicts/size/cancellation use `-32600`;
incomplete/non-progressing native pages use `-32603`. No error becomes an empty
successful archive. Clients should track continuation cursors to detect longer cycles.

ACP `$/cancel_request` cancels an individual history request. It stops waiting and
prevents further native reads; an already sent read-only request may finish in the
background. It never sends `turn/interrupt`. These methods do not upload exports or
perform the separate reversible `_codex/session_archive` operation.

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

## Account and file search

Pass-throughs in the same style as the skills surface (params and results are the Codex
shapes, `initialize` required, Codex errors propagate unchanged). Advertised as
`capabilities._meta.codex.account: true` and `capabilities._meta.codex.fuzzyFileSearch: true`.

| Method | Codex request | Params → result |
| --- | --- | --- |
| `_codex/account_read` | `account/read {refreshToken: false}` | `{}` → `GetAccountResponse` |
| `_codex/rate_limits` | `account/rateLimits/read` | `{}` → `GetAccountRateLimitsResponse` |
| `_codex/fuzzy_file_search` | `fuzzyFileSearch` | `{query, roots, cancellationToken?}` → `FuzzyFileSearchResponse` (`cancellationToken` defaults to `null`) |

Notifications the agent forwards with Codex's payload verbatim: `account/rateLimits/updated`
→ `_codex/rate_limits_updated`, `fuzzyFileSearch/sessionUpdated` →
`_codex/fuzzy_file_search_updated`, `fuzzyFileSearch/sessionCompleted` →
`_codex/fuzzy_file_search_completed`. (Inside a session, fuzzy search frames are also
mapped to `tool_call_update`s as before.)

## Prompts and state

`session/prompt` returns `{messageId}` immediately (or `-32602` for an empty prompt,
an image on a text-only model, or an unknown session). The id is minted by the adapter
unless the request names it in `_meta.alwith.messageId` (a non-empty string a host
chooses so it can recognise the turn's frames before the response arrives), and it is
passed to Codex as `clientUserMessageId`, so the `user_message` echo and every
replay of that message report under it (`userMessage.clientId`; a message written by
another Codex client has no `clientId` and keeps its item id). While a turn runs, another
prompt on the same session is injected into it with `turn/steer` and returns
`{messageId, _meta: {codex: {steered: "<turnId>"}}}`.

Turn correlation (`capabilities._meta.alwith.turns = {version: 2}`): every `state_update`
of a prompted turn (`running`, `requires_action`, `idle`) carries `_meta.alwith.messageId`,
the receipt of the prompt that owns the turn. A turn Codex started elsewhere (observed
foreign turn) has no receipt and no such field. An `idle` that belongs to an older turn is
never published after a newer prompt started its turn on the session.
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

### Chat branches

`capabilities._meta.codex.forkAtTurn: true` advertises an optional
`session/fork._meta.codex.lastTurnId` non-empty string. It maps to Codex
`thread/fork.lastTurnId`: the referenced completed turn is included and later
turns are omitted. Codex rejects unknown or in-progress boundaries. Omitting
the hint preserves the whole-thread fork. Message/item ids are not turn ids.

Live `user_message` / `agent_message_chunk` and replayed `user_message` /
`agent_message` updates carry `_meta.codex.turnId` for their enclosing Codex
turn, alongside existing phase metadata.
When Codex supplies the turn's original `startedAt`, those messages also carry
`_meta.codex.turnStartedAt` as Unix milliseconds, on live delivery and history
replay alike. It is omitted when native timing is unavailable; clients must not
display a replay arrival time as the historical turn time.

`capabilities._meta.codex.sessionLineage: true` advertises
`_meta.codex.{nativeSessionId, forkedFromId}` on `session/new`, `session/resume`,
`session/fork` responses and each `session/list` entry. These are Codex's native
`Thread.sessionId` and `Thread.forkedFromId`. ACP `sessionId` still identifies
one thread. Despite its upstream type comment, native `Thread.sessionId` can
change on fork (verified with Codex 0.156.1); clients must build branch relations
from `forkedFromId`, not equality of `nativeSessionId`. A root has
`forkedFromId: null`. Subagent `parentThreadId` is unrelated. Clients must page
the list fully when looking for branches; a branch can have a different cwd.
The adapter does not persist a separate branch index.

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
returning a started turn: [turn input handling](https://github.com/openai/codex/blob/rust-v0.158.0/codex-rs/core/src/session/turn_input.rs)
and [turn context construction](https://github.com/openai/codex/blob/rust-v0.158.0/codex-rs/core/src/session/turn_context.rs).

Turn-scoped `item/*` notifications are ignored while idle or when they name a
known different active turn. Items are accepted while a local turn's id is still
unknown, because Codex may deliver them before its start response.
# Module-owned client tools

The adapter advertises `capabilities._meta.alwith.tools = {version: 1}`. On
`session/new`, `session/resume` and `session/fork`, a trusted host may supply
`_meta.alwith.tools = {version: 1, revision, definitions}`. Definitions contain
unique `name`, `description` and object `inputSchema` fields (at most 128 tools).
New threads receive these as Codex dynamic functions before their first turn.
Codex persists dynamic definitions across resume/fork; the host must retain the
original revision and declarations with the session and refuse incompatible
restores. Supplying a new set on resume does not replace persisted definitions.

Calls use the reverse request `_alwith/tool/call` with
`{sessionId, turnId, toolCallId, name, arguments, toolSetRevision}`. Tool names in
Codex have an `alwith_client_` prefix; callback names are the original names.
Results are `{success, contentItems}`. Items are `{type:"text",text}` or bounded
base64 `{type:"image"|"audio",mimeType,data}`. Arbitrary resource URLs are never
fetched by the adapter. Results have a 16 MiB serialized limit.

Declaring a tool does not grant permission. Non-full-access modes use the
existing ACP permission channel before execution. Only this user decision
enters `requires_action`; executing the host callback remains `running`.
The module must still validate scope, arguments, task ownership and revision.
Cancellation uses standard ACP `$/cancel_request` with `requestId`. Callbacks
are deduplicated within a turn; conflicting call IDs fail closed. Cancel,
session close and engine disconnect terminate waiting, and late results cannot
update a subsequent turn. Hosts must separately preserve operation identity
for writes whose outcome is unknown across process loss.

Runtime hosts route callbacks privately to the module that owns the Agent
process. They must not expose tool arguments/results on the public event bus
or replay journal. UI progress uses normal `tool_call_update` frames.

### Host session instructions and initial mode

`session/new`, `session/resume`, and `session/fork` accept
`_meta.alwith.appendSystemPrompt` (a string) as Codex `developerInstructions`.
The adapter preserves Codex base instructions; host text is never injected as a user message.
`_meta.codex.mode` explicitly selects `read-only`, `agent`, or `agent-full-access`
for that session, overriding the process default. Unknown modes are rejected before opening a thread.

Empty-preview fork compatibility: Codex 0.156.1 omits such threads from `thread/list`
even after continuation. For `session/list` the adapter reads only
`session_meta` headers beneath the server-reported `codexHome` (`sessions` or
`archived_sessions`), discovers native `forked_from_id` records, and resolves their
summaries with `thread/read`. The hydrated preview from `thread/read` can differ from the list index; the adapter
checks every native page before supplementing IDs to avoid duplicates. Only missing forks from the requested
source/archive/project scope are appended. Native cursors are retained. Native list rows can also omit `forkedFromId` after
unload; each page is enriched with the lineage confirmed by `thread/read`.
No Codex file is written and no second conversation index is persisted. This also
allows a fresh adapter process to discover forks before they have a new user turn.

Fork/resume responses with history replay also include `_meta.codex.forkedAtTurnId`
(string or null) for forks. This is the last native turn ID shared with the parent,
resolved from both native histories each time; it identifies where an inherited-history
marker belongs even after the child continues and the adapter restarts. Null means
there is no shared visible turn (for example an empty fork).
