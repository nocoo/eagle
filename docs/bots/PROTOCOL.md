# Bots — protocol v1

Status: **frozen contract**. The only cross-process contract. The daemon encodes
it, the Swift client decodes it, and both test against `fixtures/bots-protocol/`.
Runtime details live in [RUNTIME.md](RUNTIME.md), layers in
[ARCHITECTURE.md](ARCHITECTURE.md), logs in
[OBSERVABILITY.md](OBSERVABILITY.md).

`PROTOCOL_VERSION = 1`.

## Versioning policy

- v1 is additive only: new optional fields, new event types, new capability flags.
- A client **must ignore unknown event types and unknown object fields**, but it
  must still consume the envelope's `rev` when present, so unknown events never
  look like a gap. It never closes the connection over them.
- The server rejects unknown command types with `error{kind:"invalid_command"}`
  and keeps the connection open.
- Removing a field, changing a meaning, or changing ordering requires v2 at a new
  path (`/v2/...`). A breaking change is visible in this file's diff.

## Transport

| Item | Value |
| --- | --- |
| Bind | `127.0.0.1`, default port `43117` (`--port`) |
| HTTP base | `http://127.0.0.1:<port>/v1` |
| WebSocket | `ws://127.0.0.1:<port>/v1/socket` |
| Auth | `Authorization: Bearer <token>`, token in `<root>/token` (0600) |
| Auth failure | HTTP `401` before upgrade; no socket is created |
| Origin | Not checked: no browser client in phase 1. A browser client would require an origin check and a CSRF decision first |
| Frames | Text only, one JSON object per frame, no batching envelope |
| Compression | None |

## Limits

| Limit | Value | Violation |
| --- | --- | --- |
| `send.text` | 8 000 characters | `error{invalid_command}` |
| `bot.title` (HTTP) | 80 characters | HTTP `400` |
| `bot.label` (HTTP) | 24 characters, optional | HTTP `400` |
| `group.title` (HTTP) | 1–40 characters after trimming | HTTP `400` |
| Groups | 50 per catalog | `POST /v1/groups` answers `limit_exceeded` |
| `bot.appearance` (HTTP) | one shape and one tint from the closed sets | HTTP `400` |
| Any single frame | 256 KiB, measured on the **encoded** frame | Close `1008`; a daemon-produced frame that cannot fit is dropped and the socket closes `1008`, because the client cannot decode it either |
| Single message payload | ≤ 96 KiB encoded | Withheld and replaced by a notice, see below |
| `notice` text | ≤ 500 bytes, and for the withheld case a fixed constant | — |
| One `BotSummary` | ≤ 1 200 bytes **after JSON encoding** (escaping included) | Creation or rename refuses a value that would exceed it |
| Catalog | ≤ 200 bots | Creation fails `limit_exceeded` beyond it |
| Derived `bots` bound | 200 × 1 200 B + 200 B envelope = 240 200 B | Inside the 256 KiB cap |
| Derived `welcome` bound | the same 240 200 B + ≤ 4 KiB of server/capability fields = 244 300 B | Inside the 256 KiB cap |
| UX caps (not the authority) | `title` ≤ 80 characters, `id` ≤ 80, `model.provider` ≤ 40, `model.modelId` ≤ 200, `unavailable.message` ≤ 200 | Rejected earlier with a clear message |
| `snapshot.messages` page | ≤ 200 messages and ≤ 192 KiB of the encoded frame, or empty | Older messages page through `history` |
| `history` reply | ≤ 200 messages and ≤ 192 KiB | `hasMore` says whether more exist |
| Coalesced delta batch | 96 KiB **soft** flush threshold in addition to 50 ms | A change always fits alone: it carries at most one message projection (≤ 96 KiB) plus envelope |
| Catalog size | ≤ 200 bots, `bots` events carry the whole catalog | Creation fails `limit_exceeded` beyond it |
| `agent.instructions` | ≤ 4 000 characters | `configure` fails `invalid_command` (capability off in phase 1) |
| `pending` | ≤ 32 entries | Admission beyond it fails `limit_exceeded` |
| `inbox` | ≤ 32 entries | `send` beyond it fails `limit_exceeded` |
| Connections | 16 | HTTP `503` before upgrade |
| Subscribers per bot | 8 | `error{limit_exceeded}` |
| `requestId` | 8–64 chars, `[A-Za-z0-9_-]` | `error{invalid_command}` |
| `trace` | 8–64 chars, `[A-Za-z0-9_-]` | `error{invalid_command}` |
| Pending events per connection | 256 frames or 1 MiB | Snapshot-only mode (`core.hub.degrade`) |
| Delta coalescing | 50 ms | — |
| Client `ping` interval | 15 s | Server closes `4000` after 60 s without frames |

## One bot per connection

Selecting a bot uses the existing subscription flow. Before answering its baseline, the
daemon refreshes the selected bot's native tool registry configuration, even when its
conversation view is cached. This adds no frame, request or UI loading state and does not
restart the bot's Harness or interrupt an answer already running.
A runtime failure before the subscription baseline sends its error and closes `1011`,
so the existing client reconnect policy retries instead of leaving an open, unsubscribed socket.

A connection subscribes exactly once and lives as long as that bot's chat. There
is no `unsubscribe`: switching bots closes the socket and opens a new one. This
removes an entire class of leak (late frames from the previous bot) instead of
marshalling it with generation counters.

## HTTP endpoints

`health.deviceAccess` is `null` without a host device port, or
`{version:1,binding:<lowercase SHA256 of the configured socket path UTF-8>}`.
The App checks this configuration binding before connecting to an existing daemon;
a mismatch must not silently use tools outside the shared device policy. It carries
no path, token or permission decision. An offline configured port still has a binding.

All require the bearer token, except `/v1/health`, which answers liveness so a
supervisor can check the process before any client has a token. It exposes the
version, the instance id, the pid and a bot count, never bot content.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/v1/health` | — | `{ "version", "protocolVersion", "instance", "pid", "bots", "deviceAccess" }` |
| `GET` | `/v1/bots` | — | `{ "bots": [BotSummary] }` |
| `POST` | `/v1/bots` | `{ "title", "label"?, "appearance"? }` — `appearance` is `{ "shape", "tint" }` | `201 { "bot": BotSummary }` |
| `PATCH` | `/v1/bots/:id` | `{ "title"?, "label"?, "appearance"?, "groupId"?, "model"?, "thinkingLevel"? }` — a label of `""` and a `groupId` of `null` clear their field | `{ "bot": BotSummary }` |
| `DELETE` | `/v1/bots/:id` | — | `204` |
| `POST` | `/v1/bots/:id/replica/export` | `{ "head"?, "branch"?, "resources"? }` | immutable version-1 full history bundle |
| `POST` | `/v1/bots/:id/replica/import` | `{ "bundle": HistoryBundle }` | `{ "head": SHA256 }`; passive, atomic and idempotent |
| `POST` | `/v1/bots/:id/replica/run` | `{ "head", "requestId", "text" }` | `{ "branch": requestId, "submission": Submission }`; new local run only |
| `POST` | `/v1/bots/:id/replica/status` | `{ "requestId" }` | `{ "branch"?, "submission": Submission or null }` |
| `POST` | `/v1/bots/:id/replica/receipts` | `{ "after": safe nonnegative integer, "limit"?: 1..128 }` | `{ "items": [{ "id": DocumentId, "head": SHA256 }], "nextAfter", "hasMore" }`; local full-carrier inventory |
| `POST` | `/v1/groups` | `{ "title" }` | `{ "group": BotGroup }` |
| `PATCH` | `/v1/groups/:id` | `{ "title" }` | `{ "group": BotGroup }` |
| `PUT` | `/v1/groups/order` | `{ "ids": [string] }` — every group once, in display order | `{ "groups": [BotGroup] }` |
| `DELETE` | `/v1/groups/:id` | — | `204`, or `409` while a bot is filed under it |
| `GET` | `/v1/providers` | — | `{ "providers": [Provider] }` |
| `PUT` | `/v1/providers/:id` | `{ "apiKey"?, "enabled"? }` | `{ "provider": Provider }` |
| `POST` | `/v1/providers/:id/test` | — | `{ "result": { "ok", "message", "latencyMs", "results"? } }` |
| `GET` | `/v1/usage?days=` | — | `{ "usage": UsageReport }` — statistics over the daemon's retained days |
| `GET` | `/v1/models` | — | `{ "models": [string] }` — the gateway's ids, empty when it cannot be asked |
| `GET` | `/v1/settings` | — | `{ "settings": GatewaySettings }` |
| `PUT` | `/v1/settings` | `{ "baseUrl", "model", "apiKey"?, "provider"?, "thinkingLevel"?, "toolGroups"? }` | `{ "settings": GatewaySettings }` |
| `POST` | `/v1/settings/test` | `{ "baseUrl"?, "model"?, "apiKey"?, "provider"? }` | `{ "result": GatewayProbe }` |

```json
// GatewaySettings: the key is never returned, only whether one is stored.
{ "configured": true, "provider": "magpie", "baseUrl": "http://127.0.0.1:3425/v1",
  "model": "auto/gpt-6-luna", "hasApiKey": true, "thinkingLevel": "medium",
  "toolGroups": ["core", "coding", "herdr", "agents", "trigger"] }

// GatewayProbe: the test asks the gateway for its model list.
{ "ok": true, "status": 200, "message": "连接成功，网关报告 17 个模型",
  "latencyMs": 53, "models": 17 }
```

Gateway rules:

- **One stored gateway.** The daemon keeps `{ provider, baseUrl, model, apiKey, thinkingLevel }` in
  `<root>/gateway.json` (0600, beside the token); the dotenv is only the fallback when that
  file is absent. `configured` means all three of `baseUrl`, `model` and `apiKey` are set.
- **The key is write-only.** `PUT` with an omitted or empty `apiKey` keeps the stored one,
  so the form does not have to re-enter a secret it cannot read.
- **Saving applies it.** New bots record the model, a live conversation is moved to it in
  place (its session keeps its history), and the catalog is rebroadcast because every
  summary's `model` changes. A malformed URL, an empty model or an empty key is a `400`
  and nothing is written.
- **The thinking level is one setting for every bot.** `thinkingLevel` is one of `off`,
  `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; `medium` is the default when the
  field or the whole file is absent. Saving it writes each bot's stored configuration and moves a
  live conversation to the new level in place; an unknown value is a `400` and nothing is
  written.
- **Tool groups are chosen per daemon.** `toolGroups` lists the groups every bot is given:
  `core` (the `list` tool), `coding` (pi-durable's `read`, `write`, `edit`, `bash`),
  `herdr` (the terminal collaborator), and `agents` (child conversations). Both `core`
  and `coding` are mandatory: an empty array selects those two groups. An unknown name
  is a `400` and nothing is written. Saving records the selection on every bot and changes
  what a live conversation offers in place. There are no aliases for the old tool names.
- **Testing is separate.** `POST /v1/settings/test` probes `GET {baseUrl}/models` with the
  key; a `401` is reported as a refused key, a timeout as an unreachable gateway. It does
  not save and does not spend a generation.
- **The model is still the daemon's single registered model.** A bot whose config names a
  different id settles `no_model`; saving the gateway is what aligns it.

`instance` is a random id chosen at daemon start; a client that sees it change
knows the daemon restarted and reconnects. Errors use
`{ "error": { "kind": ErrorKind, "message": string } }` with `400`, `401`, `404`,
`409` (bot quarantined or being deleted), `503` (shutting down).

The model is the daemon's configured gateway model; saving settings aligns every bot with
it. A per-bot model picker still needs the `agent` capability.

## Group rules

- **Groups live beside the catalog.** The catalog file holds `groups: [{ id, title }]` in
  display order; a bot's `groupId` is its membership. A membership that points at a missing
  group reads as ungrouped instead of failing the catalog.
- **A group that still holds a bot cannot be deleted.** `DELETE` answers `409` with
  `invalid_command` and a message; the client shows it rather than emptying the group.
  Emptying a group is the person's job (`PATCH /v1/bots/:id` with `groupId: null`).
- **Order is explicit.** `PUT /v1/groups/order` must list every group exactly once; anything
  else is a `400` and nothing is written. Moving one group up or down is the client sending
  the reordered list.
- **Limits.** 50 groups, a title of 1–40 characters after trimming; a refused title is a
  `400`. Ids are `g_` plus a UUID and are chosen by the daemon.
- **The catalog event carries them.** A `bots` event and the `welcome` frame carry
  `groups` (absent when there are none, so an older client keeps working) and every
  `BotSummary` may carry a `groupId`.

## Live tasks

`tasks` lists the work a bot's conversations are running right now — the same graph the
scheduler runs — and each `snapshot` carries the current list as `tasks`. It is a whole-list
replacement, never a delta; an empty list means nothing runs.

```json
{ "id": "t_12", "kind": "pi.generation", "status": "running", "phase": "generate",
  "background": false, "conversationId": "c_1" }
{ "id": "t_13", "kind": "pi.tool", "status": "waiting", "phase": "run",
  "background": false, "owner": "t_12", "conversationId": "c_1" }
```

- `status` is one of `pending`, `running`, `waiting`, `sleeping`, `completing`; only live
  work appears, so a settled task leaves the list rather than becoming `terminal`.
- `kind` names the task definition (`pi.generation`, `pi.tool`, `pi.compaction`, and an
  extension's own kinds such as the compaction or subagent tasks).
- `blocked` appears when the task cannot run here (`restart_limit`, `missing_task`,
  `task_too_old`, `migration_failed`); `owner` names the parent task of a child.
- Ids are wire ids (`t_` for tasks, `c_` for conversations); a client that does not parse
  them may treat them as opaque strings.
- The `tasks` capability is `true`. A client that predates the field simply ignores it.

## Triggers

`triggers` lists the Bot's own schedule and webhook triggers — the ones its model created
through the `trigger_*` tools — and each `snapshot` carries the current list as `triggers`.
It is a whole-list replacement, never a delta; an empty list means the Bot has none.

```json
{ "id": "t_9f2a1c3d04", "kind": "schedule", "name": "morning triage", "enabled": true,
  "schedule": { "cron": "0 9 * * *", "timezone": "Asia/Shanghai",
                "nextDueAt": "2026-10-29T01:00:00.000Z" },
  "counters": { "fired": 12, "dropped": 0, "refused": 1 },
  "lastFiredAt": "2026-10-28T01:00:03.114Z" }
```

- `kind` is `schedule` or `webhook`; a `webhook` trigger has no `schedule` object.
- `nextDueAt` is the durable delivery cursor, absent while the trigger is disabled or
  before its first tick. `lastSkipped.reason` is `disabled`, `missed`, `rate_limited` or
  `queue_full`; a `missed` window is never replayed.
- The event never carries the trigger's prompt, its webhook credential or its endpoint:
  detail is `GET /v1/triggers?botId=…` and the person's only mutation is
  `PATCH /v1/triggers/<botId>/<triggerId>` with `{ "enabled": true|false }`.
- Order is creation order, so a re-render cannot reshuffle rows.
- The `triggers` capability is `true`. A client that predates the field ignores it, and a
  daemon without trigger storage omits the field rather than inventing an empty list.
- Normative sample: `triggers.server.json`.

## Reported pull requests

`pulls` lists the pull requests a bot reported through `pr_register` — a coding-group tool —
and each `snapshot` carries the current list as `pulls`. It is a whole-list replacement,
never a delta; an empty list or an absent field means the Bot reported none. The daemon
stores reports and never queries a forge, so this list is only as fresh as the model's last
report.

```json
{ "url": "https://github.com/nocoo/eagle/pull/490", "title": "deps: 依赖升级到 2.4.0",
  "status": "merged", "host": "github.com", "updatedAt": "2026-10-30T10:00:00.000Z" }
```

- `url` is opened verbatim: any `http(s)` forge (GitHub, Azure DevOps, GitLab, …) is valid,
  and `host` is only the row's label.
- `status` is `draft`, `open`, `reviewing`, `merged`, `closed` or `failed`; the tool refuses
  anything else, so a client can map every value to one colour.
- Order is newest report first. Reporting the same URL again replaces that row, so the list
  never holds two rows for one pull request.
- The `pulls` field is additive in v1: a client that predates it ignores it, and a daemon
  without a store omits it.

## Per-bot agent

`PATCH /v1/bots/:id` accepts `model` (an id the gateway lists) and `thinkingLevel` (one of
the seven levels), which are that bot's own choice: the catalog records them and a live
conversation moves in place. `GET /v1/models` is a read-only proxy of the gateway's model
list (cached for a minute), so a picker never has to know the gateway itself. The `agent`
capability is `true`.

An applied agent change is broadcast as a bot-scoped `agent` event, carrying the complete
`AgentView` with `rev` and `trace`. It replaces only the current agent configuration; the
transcript, loaded history, optimistic sends, pending inputs, tasks, triggers and recovery
state stay intact. The initial subscription snapshot still carries `agent`. A gateway-wide change
(`PUT /v1/settings`, which rewrites every bot's level or model) reaches each open conversation the
same way, one `agent` event per bot. This is a v1 additive event: older clients consume its
revision and ignore it under I8.

## Providers

Third-party services a bot's tools may call. The catalogue is code (`id`, `title`,
`kind`, `baseUrl`, `docsUrl`, `keyLabel`); the first entry is `deepseek-search`, whose
search and fetch APIs back the `web_search`/`web_fetch` tools. The search section
also offers `tavily-search`. Each provider stores one independent key; the user
selects at most one provider to serve both operations.

```json
{ "id": "deepseek-search", "title": "DeepSeek 搜索", "kind": "deepseek-search",
  "baseUrl": "https://api.deepseek.com",
  "docsUrl": "https://api-docs.deepseek.com/guides/search/",
  "keyLabel": "DeepSeek API Key", "hasApiKey": true, "enabled": true }
```

- **The key is write-only and lives in the user's config**, not in the daemon root or a
  bot's directory: `<XDG_CONFIG_HOME or ~/.config>/eagle-bots/providers.json`, mode 0600. A
  `PUT` with an omitted key keeps the stored one; an empty key is a `400` and writes nothing.
  The public shape only says whether a key is set.
- **Selection is exclusive.** `PUT` with `enabled: true` requires a saved or supplied
  nonblank key and atomically deselects the other search providers without deleting
  their keys. Saving only a key never changes selection. `enabled: false` deselects
  that provider. Concurrent saves serialize; failed writes change neither keys nor
  the active route. Ambiguous persisted selections do not pick a provider by order.
- **The Bot API is provider-independent.** `web_search(query, count?, needContent?)`
  and `web_fetch(url)` keep identical schemas, results and usage accounting. The
  daemon installs its routing client even before a provider is selected; the optional
  `search` tool group still controls discovery. Without a valid selection, a call
  returns a configuration error and sends no external request. Selection/key changes
  apply at the next invocation, including existing conversations. In-flight requests
  retain their original client. Failures never fall back to another provider.
- **`test` spends one search**: it asks the provider for a single result and reports
  reachability, the message and the latency. It saves nothing.
- An unknown provider is a `400`; a refused key reads as "the provider refused the API key".

## Usage statistics

`GET /v1/usage?days=30` answers the settings page from one table the daemon keeps for every
bot, **local** day (a day is what the person experienced, not UTC) and source: tokens, calls
and what the provider said it cost. Ninety days are retained; older rows are pruned on boot
and on every write.

```json
{ "usage": {
  "retentionDays": 90,
  "today": { "totalTokens": 120, "calls": 3, "costUsd": 0.01 },
  "week":  { "totalTokens": 900, "calls": 12, "costUsd": 0.05 },
  "month": { "totalTokens": 5000, "calls": 40, "costUsd": 0.3 },
  "days": [ { "day": "2026-10-20", "totalTokens": 0, "calls": 0, "costUsd": 0 }, … ],
  "bots": [ { "botId": "b_1", "title": "研究员", "totalTokens": 5000, "calls": 40, "costUsd": 0.3 } ],
  "sources": [ { "source": "model", "totalTokens": 4990, "calls": 0, "costUsd": 0.3 },
               { "source": "search", "totalTokens": 0, "calls": 40, "costUsd": 0 } ] } }
```

- Sources: `model` spends tokens, `search` spends calls (one per search or fetch); `sources`
  lists each one's share, busiest first, so a client shows where the work went. `model` and
  `search` are today's set; the store keys on a string, so the next spender needs no migration.
- The first schema counted tokens only; the daemon migrates that day table into the `model`
  source when it opens the store.
- `days` is the requested window (1–90, default 30), oldest first, with a zero row for a day
  nothing ran, so a chart needs no gap handling.
- `bots` lists the ten busiest in the retention window, busiest first; the daemon joins the
  title from the catalog, so a client shows a name even for a bot it never loaded.
- The counters are deltas: the runtime reports cumulative totals, and the daemon books what
  a conversation gained since its last report. A reset conversation books nothing rather
  than a negative row.
- Statistics are a side channel: if the store cannot be written, the conversation is
  unaffected and the row is missing, never invented.

## Usage

`usage` carries one conversation's totals, summed from pi's usage document — assistant
turns and summarization attempts under the model, tool results under their tool. It is a
whole-value replacement and arrives whenever the totals move; a snapshot carries the same
object. Before the first answered turn the field is absent, so a client shows its empty
state rather than three zeros.

The `usage` capability is `true`.

## Entities

```jsonc
// BotSummary
{
  "id": "b_0190a1b0-…",                 // UUIDv7 with a "b_" prefix
  "title": "研究员",
  "label": "研究",                       // optional; at most 24 characters
  "appearance": {                        // optional; the client's closed sets
    "shape": "blob",                     // blob|pebble|squircle|star|cloud|shield|drop|hex|heart|flower
    "tint": "green"                      // paper|clay|red|orange|yellow|green|teal|sky|blue|violet|pink|graphite
  },
  "createdAt": "2026-10-25T02:11:03.412Z",
  "updatedAt": "2026-10-25T02:11:03.412Z",
  "model": { "provider": "magpie", "modelId": "auto/gpt-6-luna" },
  "state": "idle",                       // catalogued|opening|idle|running|unavailable|quarantined
  "unavailable": { "reason": "storage_failed", "message": "…" }   // only when unavailable
}

// Message
{
  "id": "e_10",                          // entry id, or a provisional "p_a2" while streaming
  "role": "assistant",                   // user|assistant|notice|tool  (system reserved)
  "state": "complete",                   // streaming|complete|aborted|error
  "stopReason": "stop",                  // optional: stop|length|toolUse|aborted|error|deferred
  "createdAt": "2026-10-25T02:11:04.001Z",
  "blocks": [ { "type": "text", "text": "巴黎。" } ],
  "requestId": "r_0190a1b3"              // user messages only; ties the entry to a send
}

// Messages are never split or clipped. The bound is structural: assistant answers are
// capped at maxTokens 8 192, user text at 8 000 characters, notices at 500, and the
// daemon measures each converted message before sending it. A message above 96 KiB
// encoded cannot occur with that configuration; if a provider still produces one the
// daemon withholds the message, emits `notice` text saying the answer exceeded the
// transport limit, and settles the submission normally. Nothing partial is ever
// presented as the answer, so there is no clipped variant and no byte counter.
//
// The replacement is deterministic and identifiable: the notice takes the withheld
// entry's own id (`e_<n>`), `state:"complete"`, the fixed text "回答超出传输上限",
// and the submission's `answerEntryId` points at it. A provisional that already
// streamed is finalized by an `append` with `replaces` pointing at it, so a
// reconnecting client sees the same notice from `snapshot`/`history` (same id, same
// text) and no duplicate. `status.streaming` becomes null at that point.
//
// Over-limit *in-flight* attempt, before its entry exists. The snapshot must never
// carry content over the cap, so the attempt is withdrawn atomically instead of
// being projected:
//   1. the adapter stops forwarding deltas for that attempt;
//   2. it emits `snapshot` with `streaming:null`, `running:true`, and no message for
//      that attempt — a client that had the provisional drops it (the snapshot
//      replaces state);
//   3. when the entry commits, the withheld notice is appended with
//      `replaces:"p_a<n>"`; a client that no longer holds that provisional ignores
//      the field (upsert by the notice's own id);
//   4. a retry starts a new attempt with a new provisional id, and a deferred poll
//      uses the same withdrawal rule.
// A late join, `resync`, or watch rerender during step 2 therefore sees
// `streaming:null` and a transcript without that attempt — never an oversized
// partial and never stale content.

// ContentBlock — a toolCall rides in an assistant message; a toolResult rides alone in a
// `tool` message (see "Tool rows").
{ "type": "text",     "text": "…" }
{ "type": "thinking", "text": "…" }                                   // not rendered
{ "type": "toolCall", "callId": "…", "name": "…", "args": {} }
{ "type": "toolResult", "callId": "…", "name": "…", "text": "…", "isError": false,
  "durationMs": 21 }                                                  // durationMs optional

// InboxItem
{ "id": "s_3", "mode": "followUp" }     // followUp|steer|queue; text is never echoed before placement
```

`notice` is daemon-authored text for the user ("the run was aborted", "this bot is
unavailable"). It is never sent to the model.

## Handshake

```
client → { "type": "hello", "protocolVersion": 1, "client": "BotsApp/0.1.0" }
server → { "type": "welcome", "protocolVersion": 1,
           "server": { "version": "0.1.0", "instance": "i_7f3", "pid": 4711 },
           "capabilities": { "agent": false, "tools": true, "tasks": false,
                             "entries": false, "usage": false, "peers": false,
                             "triggers": true },
           "bots": [ BotSummary, … ] }
```

`hello` must be the first frame; anything else closes `1008`. A version the server
does not serve gets a final frame and then close `4009`:

```
server → { "type": "error", "kind": "version_mismatch", "message": "…",
           "server": { "protocolVersion": 1 } }
```

`welcome.bots` equals `GET /v1/bots`, so the sidebar needs no second request.

## Subscription

```
client → { "type": "subscribe", "botId": "b_…", "trace": "tr_…" }
server → { "type": "snapshot", "rev": 42, "trace": "tr_…", "value": ConversationSnapshot }
```

- `subscribe` twice on one connection closes `1008`.
- Unknown `botId` closes `4004`; a quarantined bot closes `4090` (see close codes).
- The first `snapshot` is always sent — after connect, after reconnect, after an
  idle close. There is no replay protocol.

```jsonc
// ConversationSnapshot
{
  "botId": "b_…",
  "agent": { "model": {…}, "thinkingLevel": "off", "instructions": "" },  // a live change arrives as an `agent` event
  "messages": [ Message, … ],            // newest page, oldest first
  "truncatedBefore": "e_3",              // present when older messages exist
  "streaming": { "messageId": "p_a2" },  // null when no run is active; always present
  "parked": true,                        // optional; a task needs `recover` to be retried
  "pending": [                           // admitted, not yet settled
    { "requestId": "r_…", "submissionId": "s_3", "status": "queued" }
  ],
  "inbox": [ InboxItem, … ],
  "running": true,
  "usage": { "inputTokens": 0, "outputTokens": 0, "totalTokens": 0 },   // reserved
  "unavailable": { "reason": "storage_failed", "message": "…" }          // only when unavailable
}
```

Snapshot semantics:

- A snapshot is **complete for the window it describes**. When `streaming` is
  present, the streaming message is already inside `messages` with its current
  content and `state:"streaming"`, so a client that joins mid-answer needs no
  earlier frames.
- A snapshot **replaces** client state and resets the revision baseline; it can
  arrive at any time (initial subscribe, `resync`, or a hub rerender when the
  runtime's watch fell behind).
- `truncatedBefore` means older messages exist and are loadable with `history`.
  Its presence is not an error and does not block the composer.
- `streaming` is null while an over-limit attempt is withdrawn (see above): absence
  of a provisional never means the run has no work, which is why `running` is a
  separate field.
- `parked` is present when a task is parked and `recover` retries it; the flag is in the
  snapshot (not only in the one-shot `error`) so a client that connects later still
  offers the recovery, and a snapshot after a successful `recover` omits it.
- When `unavailable` is present, every collection is still present and empty and
  `streaming` is `null`, but they mean **unknown**, not empty: the client renders the
  reason and offers `recover`, and never treats the empty arrays as truth. `agent`
  and `usage` may be omitted in that variant.

## Server events

Bot-scoped events are **broadcast to every subscriber of that bot** and carry one
shared `rev`, strictly increasing per bot. Connection-scoped replies (a duplicate
`send` reply, a pre-subscription command error) carry **no `rev`**; a missing `rev`
is never a gap.

```jsonc
{ "type": "append", "rev": 43, "trace": "tr_…", "message": Message,
  "replaces": "p_a2" }                     // optional: provisional id this message finalizes

{ "type": "delta", "rev": 44, "trace": "tr_…", "messageId": "p_a2",
  "changes": [
    { "kind": "text",     "index": 0, "append": "Par" },
    { "kind": "thinking", "index": 1, "append": "…" },            // reserved
    { "kind": "block",    "index": 0, "block": { "type": "text", "text": "Paris" } },
    { "kind": "message",  "message": { … } },                     // whole-message replacement
    { "kind": "toolcall", "index": 2, "callId": "…", "path": ["args","q"], "append": "…" }
  ] }

{ "type": "status", "rev": 45, "trace": "tr_…", "running": true,
  "streaming": "p_a2",                   // null when no attempt is in flight
  "inbox": [ InboxItem, … ] }

{ "type": "tasks", "rev": 45, "trace": "tr_…", "tasks": [ Task, … ] }

{ "type": "agent", "rev": 45, "trace": "tr_…", "agent": AgentView }

{ "type": "usage", "rev": 45, "trace": "tr_…",
  "usage": { "inputTokens": 1234, "outputTokens": 567, "totalTokens": 1801,
             "costUsd": 0.42 } }              // costUsd only when the provider reports it

{ "type": "submission", "rev": 46, "trace": "tr_…",
  "requestId": "r_…", "submissionId": "s_3",
  "status": "done",                        // queued|placed|done|unanswered
  "entryId": "e_7",                        // the user entry, once placed
  "answerEntryId": "e_10",                 // the assistant entry, once done
  "reason": "aborted",                     // only unanswered
  "detail": null }                         // only unanswered; never content

{ "type": "error", "rev": 47, "trace": "tr_…",
  "kind": "task_parked",                   // ErrorKind
  "failure": "f_7f3a",                     // identity, shared with the daemon log
  "disposition": "runtime",                // not_admitted | unknown | runtime
  "message": "…",                          // redacted, ≤ 200 chars
  "requestId": "r_…",                      // present when a command caused it
  "taskId": "t_3" }                        // reserved

{ "type": "bots", "bots": [ BotSummary, … ] }   // absolute catalog state, no rev
{ "type": "pong" }
```

Every change names its block `index`; a `block` change carries the whole block, so
a client never has to infer content from a stream of appends. `message` replaces
the entire message, including when a provider revises earlier content.

`append` is an upsert by `message.id`. It is used twice per answer: a provisional
message (`id: "p_a<n>"`, `state:"streaming"`, real content) before its deltas, and
the final entry (`id: "e_<n>"`, `replaces: "p_a<n>"`). A client that never saw the
provisional — because it joined later — already has the content from the snapshot.

`submission` semantics (why three states exist):

| `status` | Meaning | `entryId` / `answerEntryId` |
| --- | --- | --- |
| `queued` | Admitted durably, not placed yet (bot busy or opening) | none |
| `placed` | A user entry exists; the run may not have answered | `entryId` |
| `done` | Answered | both |
| `unanswered` | Admitted, will never be answered | `entryId` only if it was placed |

Recording order is not execution order. The daemon answers a `send` with the
record it read, which may already be `done`; a connection-scoped reply may also
arrive after the broadcast settlement. Status is therefore **ranked**
(`queued < placed < done = unanswered`) and a client applies a record only when its
rank is not lower than the one it holds for that `submissionId`. A reply never
downgrades state.

`reason` on `unanswered` is a short code, not prose: `model_error`, `aborted`
(user abort or shutdown), `run_failed` (a previous run failed and the queue was
withdrawn), `stale` (compaction placed past it), `withdrawn`. The client maps
codes to localised text; unknown codes render generically.

## Client commands

Every command except `hello` and `ping` carries `trace`.

```jsonc
{ "type": "hello",     "protocolVersion": 1, "client": "…" }
{ "type": "subscribe", "botId": "b_…", "trace": "tr_…" }
{ "type": "send",      "requestId": "r_…", "text": "…", "whenBusy": "followUp", "trace": "tr_…" }
{ "type": "abort",     "trace": "tr_…" }
{ "type": "recover",   "trace": "tr_…" }
{ "type": "resync",    "trace": "tr_…" }
{ "type": "history",   "before": "e_12", "limit": 100, "trace": "tr_…" }

{ "type": "ping" }
```

- A command rejection is reported twice with one identity: the protocol emits
  `error{kind, failure, requestId}` and the same `failure` is what the daemon logs.
  A client that is awaiting a call can match them by `failure`.
- `send` requires a subscription. The daemon replies with a `submission` frame for
  that `requestId` carrying the record it reads, which may already be `done`
  because admission starts the run. A repeated `send` with the same `requestId`
  returns the existing record instead of duplicating work, which is how a lost
  reply is recovered.
- `whenBusy` defaults to `followUp`. `steer` places after the current tool round
  (phase 2). `reject` yields `error{kind:"invalid_command"}` when busy.
- `abort` withdraws the running input and any queued inputs. Their settlements
  arrive as `unanswered{reason:"aborted"}`.
- `recover` is the phase-1 escape hatch, and what it does depends on the bot's
  state, so it can never destroy healthy work:

  | Bot state | `recover` does |
  | --- | --- |
  | `unavailable` | Re-opens the harness (`open` + resume) and answers with a snapshot |
  | `idle` / `running` with a parked task | Retries the parked tasks only |
  | `idle` / `running` and healthy | Nothing but the snapshot |
  | `quarantined` | Refused with `error{kind:"internal"}`; closing must finish first |

  It never aborts a running answer — `abort` is the explicit destructive action.
  Repeated calls during one recovery episode are idempotent.
- `history{before}` answers with
  `{ "type": "history", "trace": "…", "messages": [Message…], "hasMore": bool }`:
  older messages, oldest first, contiguous with what the client holds. Read-only:
  deltas only ever touch the newest window. There is no byte-range form; messages
  are never split.

## Client duties

Two responsibilities live in the client, not the daemon, because only the client
knows whether it ever saw a reply. They are part of the contract because the
recovery guarantees depend on them.

1. **Persisted outbox.** Before writing a `send` frame, the client stores
   `{botId, requestId, text, whenBusy, createdAt}` durably (app-support file, mode
   0600, since the text is user content). The frame is written after the record
   exists.
2. **Reconciliation.** On connect, after the first snapshot, the client re-sends
   every outbox entry with its original `requestId`; pi returns the stored record.
   Only a **terminal** record (`done` or `unanswered`) removes the entry. Seeing a
   user message carrying that `requestId` proves placement only — `placed` can still
   become `unanswered` later, so the entry survives until a terminal record arrives.
   Entries are never re-sent with a new id, and no entry is removed before its
   terminal record has been stored.

3. **Disposition decides the outbox.** Every `error` emitted after `welcome` carries
   `disposition`. The handshake failure (`version_mismatch`), which is sent before a
   session exists, is exempt and carries `server` instead. `requestId` is required on
   `not_admitted` only for a rejected `send`, which always has one; a rejected
   command without a requestId never touches the outbox.

   | `disposition` | Meaning | Outbox |
   | --- | --- | --- |
   | `not_admitted` | The daemon refused the command before admission (validation, limits, busy with `reject`, unknown bot). Carries `requestId` when the command was a `send` | Remove that entry and restore its text as a draft; the user decides |
   | `unknown` | Admission could not be confirmed (a storage or read failure between `submit()` and reading its record) | Keep the entry; it is reconciled by re-sending the same `requestId` |
   | `runtime` | A run-time failure reported later (parked task, storage failure, watch escalation). May carry `requestId` for correlation | Keep the entry or not; it is about the bot, not that command |

   Presence of `requestId` never implies non-admission by itself: only
   `disposition:"not_admitted"` clears the outbox.

Consequence: an unanswered settlement that arrived while the app was closed is
recovered by re-sending, not by daemon-side history. `snapshot.pending` exists for
display; it is not the recovery mechanism.

## Invariants

| # | Invariant |
| --- | --- |
| I1 | Bot-scoped events broadcast to every subscriber of that bot with one strictly increasing `rev`; `snapshot.rev` is the last applied event |
| I2 | A client that sees `rev != last + 1` discards events until the next `snapshot` and sends `resync`. A resync that produces no snapshot within 10 s is retried once; after two failures the client closes the connection and reconnects with backoff. Counters reset on any received snapshot |
| I3 | A snapshot replaces state atomically and resets the baseline; it may arrive mid-answer and is always complete for its window |
| I4 | A message is rendered optimistically only with a `requestId`; it is replaced when the matching `submission`/`append` arrives, and a repeated `send` with the same `requestId` never duplicates |
| I5 | `unanswered` is not a transport failure: the message was admitted and the run will not answer. `reason` distinguishes model failure, abort, and withdrawal |
| I6 | A command that was never admitted produces `error`, never a `submission`. "Admitted but reply lost" is recovered by re-sending the same `requestId` or by reading `snapshot.pending` |
| I7 | `bots` events are absolute and idempotent; they carry no `rev` |
| I8 | Unknown server event types are consumed (`rev` included) and ignored; unknown client commands are rejected without closing |
| I9 | Wire content appears only inside these carriers: `send.text`; any `Message` (`blocks`, and the message inside a `delta` `message` change); `delta.changes[].append`; `delta.changes[].block`; `history.messages`; `BotSummary.title`; `BotSummary.label`; `agent.instructions`. No other field carries user or model text |
| I10 | `append` upserts by id; a provisional `p_a<n>` is finalized by an entry carrying `replaces` |
| I11 | `rev` is absent on connection-scoped replies and `bots`/`pong`; absence is not a gap |
| I12 | Older windows are fetched with `history`; the newest window is never re-fetched by paging |
| I16 | One underlying failure produces one `error` frame and one daemon `error` record, even when the runtime reports it on several channels; the identity is scoped to a failure episode, not to the bot |
| I13 | Every **block-scoped** delta change (`text`, `thinking`, `toolcall`, `block`) names its `index`; `block` carries the whole block, so no content depends on a preceding append. `message` replaces everything and is the only change without an index |

### Tool rows

A run that calls a tool commits two kinds of entry, and both are transcript content:

1. The assistant entry that asked for the call carries a `toolCall` block
   (`callId`, `name`, `args`). While the attempt streams, `toolcall` deltas grow
   `args` at an indexed path (I13), so the client's row fills in as the model writes it.
2. pi commits a `pi.tool-result` entry; the daemon maps it to a message with
   `role:"tool"`, `state:"complete"` and one `toolResult` block
   (`callId`, `name`, `text`, `isError`, optional `durationMs`). It is a message like any
   other: it appears as a live `append`, in a `snapshot`, in `history` and after
   `resync`, so a late join sees exactly the rows the live client saw.

Rules:

- **Pairing is the client's job, by `callId`.** A result whose call is no longer in the
  page (history trimming) is still rendered as a row of its own; the block carries `name`
  for that case. Nothing is silently dropped.
- **Text is bounded by the tool, not split.** Workspace and herdr tools cap their output
  at 64 KiB, below the 96 KiB message budget. A tool that returns more is clamped by the
  daemon with a `[tool output truncated]` tail; it is never turned into the
  "回答超出传输上限" notice, which belongs to assistant answers only.
- **Deltas stay block-scoped.** A `toolcall` delta names the assistant message's block
  index and a path rooted at that block: pi streams a call's arguments, so the path always
  starts with `"args"` (the daemon prefixes it before sending). The fold creates missing
  intermediate objects or arrays from the next path component; it never names a tool
  result.
- **Pages count tool rows.** A tool message consumes a page slot and its encoded bytes like
  any other message; `truncatedBefore` may therefore point at a tool entry, and paging back
  from it restores the call/result pair in order.
- **Capability.** `capabilities.tools: true` means the client renders these rows; a client
  that ignores tool blocks still sees a correct answer, because the answer never contains
  them.
| I14 | A submission record is applied only when its rank does not decrease (`queued < placed < done = unanswered`), so a late connection-scoped reply cannot undo a settlement |
| I15 | Messages are never split or clipped on the wire. A message above 96 KiB encoded is withheld, replaced by a `notice`, and the submission still settles; deltas for an attempt stop being forwarded once its projection would exceed the cap |

## Close codes

| Code | Meaning | Client behavior |
| --- | --- | --- |
| `1000` | Normal close (client asked, or the app is closing) | Reconnect only on user action |
| `1006` | Abnormal close: daemon crashed or was killed | Reconnect with backoff immediately |
| `1008` | Protocol violation (bad JSON, oversize, double subscribe, missing hello) | Show an error, do not auto-reconnect |
| `1011` | Internal daemon error | Reconnect with backoff, show a notice |
| `4000` | Idle timeout (no frames for 60 s) | Reconnect immediately |
| `4001` | Auth failed after connect | Stop; ask for the token |
| `4004` | Unknown bot | Refresh the catalog, do not reconnect to that id |
| `4009` | Protocol version mismatch | Stop; show both versions |
| `4010` | Daemon shutting down | Reconnect with backoff; expect the port to refuse briefly |
| `4090` | Bot is quarantined (close timed out) | Show the state, offer `recover` later; retry the connection |

Handshake failures that happen before the upgrade use HTTP status codes: `401`
auth, `503` at the connection limit or while shutting down.

## Error kinds

`auth_failed | unknown_bot | invalid_command | limit_exceeded | version_mismatch |
model_error | session_failed | task_faulted | task_parked | extension_error |
storage_failed | internal`

Shared verbatim with `err.kind` in the daemon log and the client's
`ConversationEvent.error` ([OBSERVABILITY.md](OBSERVABILITY.md)).

## Fixtures

`fixtures/bots-protocol/` holds one frame (or an explicitly named HTTP metadata sample)
per file, pretty-printed, used by both
sides.

| File | Direction |
| --- | --- |
| `hello.client.json`, `welcome.server.json`, `version-mismatch.server.json` | handshake |
| `subscribe.client.json` | subscription |
| `snapshot.server.json`, `snapshot.streaming.server.json`, `snapshot.unavailable.server.json` | attach states |
| `append.server.json`, `append.streaming.server.json`, `append.finalize.server.json`, `delta.server.json` | transcript |
| `append.tool.server.json`, `append.tool-result.server.json`, `snapshot.tools.server.json` | a tool call and its result, live and in a snapshot |
| `history.client.json`, `history.server.json` | message paging |
| `agent.server.json` | live agent configuration |
| `status.server.json`, `submission.server.json`, `submission.connection.server.json` | run state and the connection-scoped duplicate reply |
| `bots.server.json`, `error.server.json`, `error-rejected.server.json`, `version-mismatch.server.json` | catalog, runtime failure, definite rejection, exempt handshake failure |
| `send.client.json`, `send.resources.client.json`, `abort.client.json`, `recover.client.json`, `resync.client.json` | commands |
| `sync-proof.http.json` | fixed-domain typed mutual proof and shared Node/CryptoKit signing bytes, validated by the independent Bots codec |
| `sync-objects-v1/canonical.json` | typed durable object/descriptor/envelope signing bytes verified by Node, Bots and Swift CryptoKit |
| `sync-access.http.json` | version1 sync access request/response metadata, checked by the independent Bot and Registry codecs |
| `ping.client.json`, `pong.server.json` | liveness |
| `entities.json` | `BotSummary`, `Message` (user, assistant with a tool call, tool), `InboxItem` samples |

Rules enforced by `test/protocol/fixtures.test.ts`:

1. Fixtures are normative: the daemon encoder reproduces them from the same
   values, and the Swift decoder decodes them.
2. A protocol change and the affected fixtures land in the same commit as this
   document, and the file set must match this table exactly.
3. No real user data, tokens or paths.

## External shared device port v1

The optional host integration uses the independent JSONL contract in
[DEVICES.md](../DEVICES.md); it does not change conversation v1 fields or
capabilities. Normative cross-language canonical parameter vectors are in
`fixtures/bots-protocol/device-access-v1/`, checked by the Bot adapter and App
identity tests. The Keychain signer accepts registration payloads only at its
registration seam; typed approvals require complete, validated operation data
and a matching digest before a trusted App confirmation can be signed.
`approval.request` sends `{request,policyVersion,expiresAt}` as JSONL params and
returns `result:{approval:<signed envelope>}`. The adapter unwraps that envelope
before attaching it to the same operation; it never treats transport success as
human confirmation.
The helper canonicalizes all approval UUID fields to lowercase at decoding, so
the displayed operation, signed bytes and service verification use the same IDs.


### P0 full-history carrier

The four authenticated loopback `replica` endpoints carry full user/model content in
`HistoryBundle` and `run.text`; they are separate from WebSocket UI carriers (I9).
Their dedicated body cap is 8 MiB, with malformed/oversized input returning
`400 invalid_command`; ordinary API and WebSocket limits remain unchanged. Other
methods are not accepted. New local run input retains the existing 8000-code-point
limit and `[A-Za-z0-9_-]{8,64}` request ID grammar; failures use the normal `f_` identity.
The same registry owns runtime opens and holds a lease
through each request. Failed/runtime-uncertain requests do not change targets or IDs.

[The normative bundle](../../fixtures/bots-sync/history.v1.json) retains original
SDK entries and provenance. Its head is SHA-256 of UTF-8 `JSON.stringify` of the
validated v1 envelope without `head`: the schema fixes known field order while
original model/data object insertion order is retained. There is no recursive
key sorting; SDK section order changes prompt text and therefore changes the head.
Receipt re-export retains that order. The earlier unpublished sorted P0 encoding
is not accepted through a compatibility path. Full validation and
compatibility rules are in [RUNTIME.md](RUNTIME.md#p0-local-history-handoff).
No fragment or unsupported bundle may be claimed as a complete runnable head;
P0 rejects nested SDK tool history, and retained-but-uninstalled instruction/skill
resources prevent continuation. There are no new WebSocket commands, shared-device
signing calls, cloud transport or Swift UI in this slice.


### P1 local incremental replica log

The same authenticated `/v1/bots/:id/replica/*` POST boundary adds `bind`, `pull`,
`apply`, and `status {}`. Ordinary HTTP/WebSocket limits and client behavior do not
change. `bind {sharedBotId: UUID}` associates an empty local Bot directory with the
explicit shared identity; it cannot reassign populated state. There is no name matching.

`pull {after,limit?,source?}` selects a stream `{replicaId,epoch}` (default local source),
up to 128 events and **8 MiB of UTF-8 JSON including the complete apply `{page}` wrapper**.
The [normative page](../../fixtures/bots-sync/page.v1.json) contains version1, sharedBotId,
source, advertised `range {from,to}`, events `{seq,body}`, `nextAfter` and `hasMore`.
The position advances only for events actually returned. Single-event overflow is an
explicit refusal; it leaves the source event/gap intact. Forwarding keeps the original
source/epoch/seq, including A→B→C duplicates. SDK cursors are not wire positions.

Bodies are immutable `entry`, `resource`, `head` or passive `run` facts. Entry facts
retain original replica/conversation/entry/task provenance, full kind/model/data/edit
content and dependency references. Their ref is SHA-256 of JSON.stringify({origin});
resource refs hash JSON.stringify({resource}). Automatic SDK receipts reference these manifests and preserve a bounded fork/ID map;
they do not embed the old bodies. A validated matching materialized prefix can be forked
and only the new suffix appended. Explicit P0 carriers keep their full-bundle API.
Head manifests carry the v1 source/parents/
agent metadata and ordered entry aliases `{id,conversationId,byTaskId?,head?,ref,targets?}`
plus resource refs. The parallel targets array must exactly match edits. Reconstructed
head digests use the P0 validated-envelope encoding; model/data insertion order remains
semantic. New heads reference old fact bodies instead of retransmitting them in full.

`apply {page}` first commits deduplicated incoming events, then materializes complete
heads with public SDK passive append. A foreign `run` fact is historical evidence only;
it never enters local intents, a task queue or provider session. Same stream/sequence or
original fact ID with different content is refused. Missing dependencies wait without
advancing applied; semantic protocol errors retain a blocked source position and return
invalid_command. That source cannot acquire an applied ACK for the bad sequence or block
other complete local heads. Unverified heads are never globally indexed.

A complete explicit P0 carrier remains self-contained when its `parents` only names
ancestor summaries; separate parent receipts are unnecessary for its run or re-export.
After upgrade, a selected complete P0 SDK receipt is validated/indexed on demand without
re-import, warming export or passive execution. Missing causal parents/facts in a new
incremental manifest still prevent applied acknowledgment. A validated fixed head also
bounds nonterminal ancestor checks for its independent continuation; all-ancestor nested
tool refusal remains unchanged.

`status {}` reports binding, each stream's known maximum, contiguous received/applied
positions, actual retained intervals, optional `{error:{seq,code:"invalid_history"}}`,
and validated materialized heads. A received maximum is not an applied receipt. No field
claims cloud-cached or physical delivery. Epoch replacement/backup rotation, retention
pruning and directory tombstones remain planned.

Both ordinary local input and `run {head,requestId,text}` persist a fixed local intent
and source event in one replica transaction before same-ID SDK admission. Retries fix
mode/head/text/whenBusy, including an original null root head. Recovery uses only this
local ledger and SDK's idempotent admission; 8000 code points and 8..64 legal ID characters
remain unchanged. P0 public carrier limits remain enforced while internal reconstructed
histories can exceed one page. No device, cloud, Swift or automatic peer transport is
introduced by these local API methods.

### Saved-history recovery inventory

`receipts {after,limit?}` enumerates complete `bots.replica.import` P0 carriers in the
current Bot's session. `limit` defaults to 128 and bounds newly **checked documents**,
including compact/empty records with no full carrier. Metadata is scanned with the public
SDK API; bodies are read and validated one at a time. `nextAfter` advances to the last
checked persistent DocumentId even for an empty result page. SDK cursors stay inside the
request. This position is neither source sequence nor peer-applied acknowledgment.

Each returned family key must equal the validated complete carrier's head, with a supported
receipt version and visible conversation/entry mappings. Malformed carriers fail closed;
SQLite/SDK failures propagate. A raw enumeration I/O failure seals that local Harness via
public close (SDK SessionEnd.closed); the original error remains storage_failed at the
runtime boundary. Subsequent commands and in-flight raw results are refused before further
consumption, including empty/compact pages. Protocol errors, StorageRequestError and real
caller cancellation do not close a healthy instance. The response exposes only document
IDs/heads, never carrier bodies. The existing Bearer auth, Bot isolation, strict request fields and 8 MiB boundary
apply. The [normative summary](../../fixtures/bots-sync/receipts.v1.json) includes a checked
compact record after its returned complete carrier; a nextAfter beyond an item is expected.
Multiple inventory requests do not freeze a Bot snapshot.

To restore saved history, create a fresh local Bot, bind its saved sharedBotId, import the
explicitly selected complete carriers (including standalone P0 branches with summarized
parents), and apply the retained original source pages/ranges. A new replicaId/epoch is
stable across target restart; old facts retain their original identities and sequences.
Pages alone cannot cover legacy complete SDK receipts without source events. Missing pages
remain gaps; bad carriers cannot replace a complete head. Neither foreign pending nor active
run facts enter local queues. A user starts continuation with a new request ID only after
the selected head is ready. This is explicit passive recovery, not detection of an unannounced
live-directory rollback or permission to copy/resume an active session database.


### P1 permanent directory tombstones

Authenticated POST /v1/replica/tombstones/pull accepts strict
{after: nonnegative safe integer, limit?: 1..128}, default128, and returns
{items:[{sharedBotId: UUID}],nextAfter,hasMore}. The cursor is this daemon root's
append-only deduplicated set position, never a history source/epoch/sequence or ACK.
POST /v1/replica/tombstones/apply accepts strict {items:[{sharedBotId: UUID}]} with
1..128 items, validates every item before writing, and idempotently retains/forwards
the facts. No local Bot ID, path or credentials are accepted. Both use the existing
Bearer/Origin checks and 8 MiB body cap; malformed/oversized input is invalid_command.
Apply success means marks are saved and affected local runtime entry points are sealed;
close/cleanup failure is an honest failure, while saved marks remain irreversible.
Deletion wins over bind, old pages, P0 import and run for the destination binding;
P0 carrier content cannot supply or infer sharedBotId. New shared identities remain usable.
Local DELETE cleans only aliases of the target's actual shared binding after close;
an unbound legacy Bot has none. Another identity's pending deletion/quarantine cannot
turn that successful DELETE into failure or suppress its catalog broadcast.
The normative tombstones.v1.json fixture contains only immutable shared identity facts.
Only these new root routes reject any Origin header; existing replica routes retain
their earlier behavior. A subscribed WebSocket can hold deletion in quarantine until
its original lease ends. Apply returns failure in that case, retains the mark and does
not move an owned database. Its subsequent recover command cannot execute or reopen the
deleted identity; the existing unknown-Bot refusal/close semantics apply.


## Fixed-head resource manifest (P2 local slice)

The existing ordered `HistoryBundle.resources` array is the complete selected file manifest;
no endpoint or body/page limit changes. `name` is a nonempty relative POSIX file path.
Instructions entries contain valid UTF-8 AGENTS text; skill entries use
`skills/<package>/SKILL.md` and the complete selected package files below that directory
(scripts, references, assets, including binary files). Every selected package needs a
nonempty UTF-8 SKILL.md. Attachments retain arbitrary bytes. Manifest order determines
instruction/skill presentation order; relative package dependencies must be supplied in
this manifest, with no automatic workspace discovery, remote fetch or dependency install.

Duplicate paths, file/directory conflicts, traversal/absolute paths, symlink escapes,
missing skill descriptors and invalid selected text reject **run**, while a structurally
valid original history carrier remains retainable/exportable. Base64/SHA integrity remains
validated on import/apply. Files are immutable version data, not executable authorization;
script bytes can be invoked explicitly with native bash and an interpreter. Selected
versions coexist at local paths exposed in the model's resource section. No global latest
selection is introduced. Existing no-resource bundle encoding/head digests stay unchanged.

## Ordinary root resource selection (P2 local slice)

`send` adds optional `resourceHead`, a lowercase SHA256 digest of a complete local resource
manifest or locally ready history head. Invocation/SubmitInput carry the same selector. It selects only that head's complete
resource manifest, retaining this root's history, agent/model, local cwd and credentials.
No selector on a new ID means legacy unselected resources. A same-ID retry omitting the
selector reuses its durable choice; an explicitly different selector is a binding conflict.
Every persisted root intent binds `whenBusy`, including refused and already admitted IDs.
Retries must keep that mode even when omitting `resourceHead`; only a legacy omitted
mode normalizes to the existing `followUp` default. Core stored-record lookups validate
this binding before returning a known SDK admission. A matching retry keeps the original
choice and can retry a refused input once its original mode permits admission.
The ordinary frame/text/queue limits and replica page limits do not change. Local edits
are captured through existing export{resources} as a new immutable head; no global latest.
Resource metadata never becomes user display content.

For local edits while the root is busy, replica export accepts `{head, resources}` with
a complete fixed ready head and a complete ordered replacement resource manifest. It
derives a new local head with that fixed head as parent, preserving immutable history,
Agent and original provenance; it neither reads the current busy tail nor executes work.
The same base and ordered files re-export deterministically. `head+branch`, unknown or
incomplete bases are refused. Existing compact facts and complete legacy P0 receipts
are supported; the explicit full carrier retains its 8MiB limit. New facts/manifests
publish under the local source, preserving the original entry/task origins.


### First resources on an empty Bot

Replica export accepts strict `{kind:"resources",resources:[...]}` for a nonempty complete
ordered package, or `{kind:"resources",head}` to re-export it. The complete carrier is
`{version:1,kind:"resources",head,resources}`. It contains no history, Agent, source runtime
or local device binding. Its head is SHA256 of `{kind:"resource_manifest",resources:[refs]}`;
each ordered ref is the existing resource fact key. Resource bytes retain their original
base64/SHA integrity and the existing 8MiB explicit-carrier limit. Branch/history selectors
and replacement resources cannot be combined with resource-only re-export.

Import accepts this explicitly tagged carrier through the existing `{bundle}` envelope.
Capture publishes resource facts followed by one immutable `resource_manifest` fact on
the bound local source. Passive import stores the same complete facts; incremental apply
cannot apply a manifest until every ordered ref resolves to a valid resource fact. Repeated
capture/import and duplicate/reordered pages are idempotent and never admit work. Bind an
empty replica to its intended sharedBotId before capture/outbox. Resource-only heads select
packages for ordinary send/Invocation; they cannot be used as history run/fork parents or
weaken P0 entries.min(1), tail or missing-history-dependency checks. Empty/malformed carriers
are invalid_command. Existing history formats, caps, tombstones and queue rules are unchanged.


## P3 local synchronization access metadata

POST /v1/bots/:id/sync/access is protected by the daemon bearer, loopback Origin
policy and existing body limit. Strict body is {peerDeviceId,purpose:"replica.read"}.
The daemon resolves sharedBotId from this Bot's actual persisted local replica binding
and applies the existing tombstone guard; no request-supplied group/shared identity is
accepted. It calls an independently injected, Bots-owned DeviceSyncPort version1 over
the existing private socket. No runtime admission or historical/resource payload is sent.

The port offers identity() and access({sharedBotId,peerDeviceId,purpose}). Registry must
verify current device session, same nonempty group and target-to-caller explicit grant,
including both epoch/credential versions. It returns bound identity/authorization/peer
Tailscale endpoint metadata only. It never returns tokens/private keys. Socket callers
cannot grant/revoke/publish. Missing integration, authorization or Registry failure is a
refusal, not an authorized empty result. Existing local chat/native execution is unchanged.

The normative metadata sample is `fixtures/bots-protocol/sync-access.http.json`.
Device UUIDs accepted by this new sync request are canonicalized to lowercase by
the Bots-owned codec. Classified sync refusals return `{error:{kind,message,failure},trace}`:
403 authorization, 404 deleted/unknown Bot, 400 malformed/unbound/changed scope,
503 Registry/private-service unavailable or invalid metadata. A completed cross-process
lookup is rechecked against the current local binding/tombstone before a 200 response.


## P4 first authenticated one-page pull

This additive local slice uses the existing daemon bearer, rejects any Origin header,
keeps management HTTP on loopback and leaves default queues unchanged:

- GET /v1/sync/status returns version1, instance, pid, device-socket binding digest,
  ready, actualPort|null and selfDigest|null. Readiness certifies the current Self
  socket set is bound, not publication, authentication or physical connectivity.
- POST /v1/bots/:id/sync/pull accepts only {peerDeviceId,source?,after,limit?}.
  source is {replicaId,epoch}, after is nonnegative, limit defaults128 and is1...128.
  Shared identity comes from the actual local binding. URLs, IPs, tokens and group
  claims are not accepted. The response is {page,applied}, preserving the original page.
  Failure uses the existing {error:{kind,message,failure},trace} shape/status mapping.

A requires its current access(B), while B independently requires B's current grant to A
through read-only sync.peer.authorize. A reciprocal grant is not required. Registry and
private-service failures refuse the exchange; no local directory fallback authorizes it.
Only the new private authorize result adds configured registryOrigin; P3 codecs are unchanged.

The dedicated listener exposes only POST /v1/sync/challenge and /v1/sync/page. Challenge
input is strict version1/sharedBotId/readerDeviceId/readerNonce/readerEphemeral. Both endpoints
reject Origin and all management/run routes. A challenge is consumed once, expires within60s,
and belongs to one daemon generation; at most128 unexpired challenges are held in memory.
Challenge JSON is capped8192 bytes. The private DeviceChannel remains512KiB and transports
only typed identity/proof/Self metadata, never history pages.

Both helper signatures use eagle-bots-sync-proof-v1 plus canonical typed JSON. The proof
contains version1, registryOrigin, role(reader/server), purpose(replica.read), sharedBotId,
reader/server current identity(publicKey/deviceId/groupId/membershipEpoch/credentialVersion),
readerNonce/serverNonce/generation/sessionId, expiresAt and both32-byte X25519 public keys.
Nonces and keys are canonical base64url. The helper validates its configured origin and own
identity, exact fields and <=60s expiry, then constructs signing bytes itself. No payload or
digest signing entry is exposed. Node checks current directional access before and after the
helper wait; peers verify signatures using current Registry keys and recheck identity/grant
across page preparation/decryption awaits. No identity snapshot is a reusable bearer token.
Expiry is rechecked after the final asynchronous authorization/binding checks and at the
actual challenge/request/page/apply use point, including ready-directory and replica-command
queue waits. A proof that entered within its lifetime cannot be used after that lifetime.
The internal use guard also checks the original exchange generation/closed state after those
waits. It is not a wire parameter or SDK extension. Once apply is admitted at receive within
the lifetime, the existing atomic apply/drain completion remains; no later cancellation is added.

X25519 feeds SHA256 HKDF with SHA256(full server-role canonical proof transcript) as salt
and SHA256(full AAD) as info. AAD is the full domain+canonical proof, direction and sequence0;
it is never truncated. AES256-GCM has independent reader/server keys, random12-byte nonce,
16-byte tag and strict sequence0. Encrypted frame cap is ceil(8MiB*4/3)+16384 bytes; decrypted
page remains <=8MiB and <=128 events, with all prior source/epoch/seq/dependency checks.
Ephemeral session keys are not cache/resource keys. One-page pull does not implement CF
fallback, durable encryption envelopes, automatic switching or72h caching.

Both sides require an existing healthy held runtime. Sync uses short serialized leases
and the same handle identity, never BotRegistry.replica's touch/open/recover behavior.
Cold, unavailable, closing, deleted or rebound instances refuse. Explicit local recovery
retains ownership of pending work. No lease spans the remote exchange; binding/tombstone
and instance are checked again before local page reads/apply. B rejects multiple aliases
for the same sharedBotId. Passive apply never submits or resumes local/foreign work.

DaemonConfig.syncPort, --sync-port and BOTS_SYNC_PORT are optional, disabled by default;
zero selects an OS port. sync.endpoints.self returns bounded actual Self addresses plus
SHA256(JSON.stringify(sorted unique addresses)). Only Tailscale IPv4/IPv6 ranges are accepted.
The listener binds the whole current set to the same actual port or remains unready; no
wildcard/LAN listener, partial publication or forced Tailscale installation/login is added.
The trusted parent alone publishes {syncPort,expectedSelfDigest?}, or null to withdraw.
Node serializes only these writers in management receive order through discovery and the
Registry write, including failures. Digest mismatch withdraws stale endpoints and refuses.
App status reads verify owned pid/instance/socket binding; stale generations cannot dispatch.
Ready positive publication is reconfirmed through the current Node session on each existing
polling round; only unchanged withdrawal is deduplicated. Identity changes never relax Registry
matching or digest checks. Poll/request/retry timing does not promise a fixed success deadline.
Shutdown invalidates generation/access immediately and begins the original local HTTP/drain/
registry cleanup while unfinished private Self discovery drains within the unchanged total budget.
Late Self results cannot make the closed listener ready. Header/body transport I/O uses the
existing network/internal failure mapping; size, JSON and crypto refusals remain protocol failures.
Normal public application quit awaits bounded withdrawal and close, records confirmed or
unknown, then replies exactly once. Unexpected owned exit invalidates its generation and
withdraws; adopted processes use the previously verified OS process-start identity if health
becomes unavailable. Unconfirmed withdrawal never blocks exit indefinitely or claims success.


## P4 immutable encrypted page objects (additive v1)

Loopback bearer/no-Origin POST `/v1/bots/:id/sync/objects/pull` accepts exactly one selector:
`{peerDeviceId,source?,after,limit?}` or `{peerDeviceId,objectId}`. Mixed/unknown fields reject.
It returns `{version:1,objectId,stored:true,applied:false,cipherDigest}` only after a complete
immutable local result is durable. `/sync/objects/apply` strictly accepts `{objectId}` and
resolves only the already stored capability bound to this exact local Bot/replica/epoch/sharedBot.
It returns `{version:1,objectId,applied:<original replica.apply result>}`. Public callers cannot
supply an issuer pin,URL,IP,management token or remote body to offline apply. Existing sync/pull
and replica Page/SDK formats are unchanged; synchronization remains ready-only and passive.

Remote `/v1/sync/object` uses the existing one-use mutual proof exchange and an encrypted strict
selector including the current recipient descriptor. The response is `{carrier,receipt,trace}`.
Carrier is `{version:1,manifest,descriptor,ciphertext,envelope}`; cipher appears once outside the
small ephemeral AEAD receipt. Receipt binds current sessionId,requestDigest,objectId and complete
publisher/issuer/recipient plus manifest/envelope/descriptor/cipher digests. Both ends recheck
current directional grants,time,generation and local binding at final use. An old signed object
alone is never evidence of a current authorized network exchange.

Manifest signs version/purpose/Registry origin,publisher,sharedBot,keyEpoch1,keyId,objectId,
source,advertised range,actual included seq/eventDigest,nextAfter/hasMore,pageDigest,nonce and
cipherDigest. ObjectId is the digest of controlled version/purpose,publisherDeviceId,sharedBot,
keyEpoch,source,pageDigest, independent of encryption randomness and recipient signatures.
Page plaintext and event digests retain the original Page JSON.stringify model/data insertion
order. The32-byte per-object DEK/96-bit nonce encrypt with full header AAD; wrapping uses a
separate persistent X25519 key and a signed directed envelope bound to the complete manifest,
issuer/recipient identities and signed descriptors. Logical slots compare verified unsigned
descriptor bodies: another valid signature does not replace the original envelope/descriptor.

Plaintext remains8MiB/128events. Cipher is at most8MiB+16 bytes; the object JSON frame permits
its base64url encoding plus64KiB metadata. Private512KiB/vault4096B limits do not change.
`fixtures/bots-protocol/sync-objects-v1/canonical.json` contains actual CryptoKit signatures
and exact shared Node/Swift canonical metadata texts; it contains no private key or DEK.

## P4 explicit encrypted cache (additive v1)

Loopback authenticated POST `/v1/bots/:id/sync/cache/publish` accepts the same strict
page-or-object selector as objects/pull. `/sync/cache/list` accepts
`{peerDeviceId,source:{replicaId,epoch},after,limit?}` (limit1–128, default128).
`/sync/cache/receive` accepts only `{peerDeviceId,objectId}`. Receive durably stores a
fully verified object/pin and returns stored:true,applied:false; explicit objects/apply
remains separate. No caller endpoint, authority, pin or external body is accepted.

The independent Sync Worker accepts POST `/v1/cache/publish`, `/list`, `/get` with
strict version1/operation/sharedBotId/peerDeviceId plus carrier, source/after/limit,
or objectId respectively. Dedicated metadata authority is obtained through the
private `sync.cache.authority` port; Worker recomputes its digest from actual fields
and verifies operation, namespace, both current identities and directional grant via
Registry RPC. Publish uses uploader B's session; list/get use reader A's session and
never require B online or its former session. `sync.key.publish {}` publishes only
the helper's durable descriptor; lookup requires current B→A authorization.

Existing signed carrier/page bytes and all8MiB/128/private512KiB limits remain.
cloudCached:true certifies a verified immutable R2 cipher and committed metadata
references, not peer application or execution. Empty pages return cloudCached:false.
Lists are bounded, report expired/pending/unavailable gaps and always complete:false;
they do not advance an applied cursor. Event identity and immutable72h clocks,
pending recovery and physical deletion are specified in [SYNC-CACHE.md](SYNC-CACHE.md).

### Automatic connections on an existing ready binding

Bearer-authenticated loopback GET `/v1/bots/:id/sync/connections` returns version1,
actual replica status and explicit preferences. PUT `/sync/connections/:peerDeviceId`
accepts only `{direction:"publish"|"receive"|"both",source?:{replicaId,epoch}}`;
DELETE disables that preference. Origin headers are rejected. The daemon captures
the actual complete local binding, never opens a replica or creates reverse grants.
The maximum is32 preferences across the daemon. `publish` independently caches
local facts for authorized pulls; it is not proactive direct-send.

Local cache publish results add the acknowledged immutable manifest's `page`
metadata `{objectId,source,included,nextAfter,hasMore}`. Bounded cache list results
add `nextAfter`, the last actual selected/inspected SQL sequence (empty keeps after).
Whole-object included is not a query-window or applied cursor. Received/applied
remain actual ReplicaStore facts; peerApplied is always unknown here.
Attempt signals/guards and connection timing callbacks are internal only.
Optional preference storage faults pause automatic work and return503/storage_failed
without stopping daemon startup or native run. Original bytes are not repaired or
overwritten. The owned preference can retain one pendingApply objectId per
connection after complete cache storage and before apply; it is retried through
the existing local stored-object path before online work and cleared on success.
This is private persistence, not a new peer/wire cursor or applied acknowledgment.
Detailed fallback, stable return and bounded expiry recovery are in
[SYNC-AUTO.md](SYNC-AUTO.md).

### Online-holder relay and delivery-associated receipts (additive v1)

Private typed `sync.relay.authority` and Registry `/sync/relay/authority` introduce
only `register|discover|exchange|ack|receipts`, purpose `replica.relay`. Each short
metadata authority binds operation, actual request digest, sharedBot, current full
identity/session and directed holder→reader grant; it is separate from cache
publish/list/get. No session token, generic signer or remote management bearer.

The independent Worker adds GET WebSocket `/v1/relay/connect?sharedBotId=...` and
POST `/v1/relay/{discover,exchange,ack,receipts}`. The bounded first socket message
registers complete holder binding, original-source actual coverage, connection
generation and authority. Renewal of that same socket/identity/binding/generation
preserves an in-flight page; replacement/close does not. After DO restart, stored
advertisements cannot make a holder online. Every page uses the existing fresh
one-use challenge/proof/AEAD object exchange, not a reusable crypto session.

Local bearer/no-Origin POST `/v1/bots/:id/sync/relay/register` and `/discover` accept
`{}`; `/pull` accepts the existing peer/source/after/limit page selector; `/ack`
accepts `{peerDeviceId,delivery:{requestId,sessionId,objectId,source}}`; `/receipts`
accepts `{peerDeviceId}`. No caller binding, applied cursor, authority or endpoint
is accepted at the local ACK boundary. It reads complete persistent ready status.
The original source is explicit for holder history; a holder creates its own
publisher transfer object without changing original event bytes or writing R2.

ACK binds current holder/receiver identities, complete receiverBinding and original
source, the actual request/session/object reference, received/applied/available.
Applied can lag received and does not imply execution. Same complete-key metadata
is idempotent/monotonic; an old receiver epoch cannot represent a new one. Receipt
read uses holder→reader permission, without reverse grant. Unknown remains unknown.
Only current-authorized explicit410 `sync_relay_delivery_unavailable` can discard
an obsolete pending ACK reference; generic expiry/auth/binding/SQL failures cannot.
The connection status field peerApplied and direct/cache sender confirmation are
still unknown in this slice. See SYNC-RELAY for limits and the following status slice.

### Authenticated persistent status (additive v1)

`sync.relay.authority` adds distinct `status-report|status-read` operations under
the existing replica.relay purpose. Each binds the complete actual request digest,
operation, namespace/session and current holder→receiver identities/grant. A report
uses the receiver session; an independent read uses the holder session. Neither
requires a reverse data-read grant or reuses a cache/other relay operation ticket.

Local bearer/no-Origin POST `/v1/bots/:id/sync/relay/status-report` and `/status-read`
accept only `{peerDeviceId}`. Report reconstructs the same ready handle's durable
status, not caller cursors/binding. Worker POST `/v1/relay/status-report` accepts
`{version:1,operation,sharedBotId,peerDeviceId,binding,streams}`; streams contains
at most128 unique `{source:{replicaId,epoch},received,applied}` entries with
0<=applied<=received. Binding is the complete receiver
`{localBotId,sharedBotId,replicaId,epoch}`. The response is
`{version:1,recorded:true}`. Worker recomputes the digest and rechecks authorization
at the metadata use point. No object/delivery reference is required for plain direct.

Worker status-read accepts `{version:1,operation,sharedBotId,peerDeviceId}` and
returns `{version:1,snapshots,hasMore}` with at most128 snapshots. Each includes
registryOrigin,sharedBotId,complete holder/receiver identities,binding,original
source,actual received/applied and server recordedAt. The exact complete key is
idempotent/monotonic; an old binding or source epoch remains separate history.
Reports are current receiver statements, not independent proofs of execution.

Automatic receive/both reports and publish/both reads use one independent bounded
metadata action. Connection peerApplied is `"unknown"` until a nonempty authenticated
read, then `{version:1,current:"unknown",authenticatedAt,snapshots,hasMore}`.
Current receiver binding stays unknown; snapshots never imply a new instance's
progress, complete history or native run. A failed refresh retains the last
timestamped authenticated snapshot. CloudCached and local received/applied remain
separate. No report is added to offline applyObject; failed reporting cannot undo
apply or block inbound/upload/native work. Details are in [SYNC-STATUS.md](SYNC-STATUS.md).


## Native fixed-head contexts and merge (P5 additive slice)

The same authenticated `/v1/bots/:id/replica/*` POST boundary adds:

| Method | Strict request | Response |
| --- | --- | --- |
| `heads` | `{after?:nonnegative safe integer,limit?:1..128}` | `{items:[{head,parents,source,ready,entries,resources,resourceHead}],nextAfter,hasMore}`; defaults0/128, metadata only, existing8MiB page bound |
| `head` | `{head:SHA256}` | one head's metadata and `resourceFiles:[{ref,name?,kind?,sha256?}]`; no resource bodies |
| `context` | `{contextId,head?:SHA256,resourceHead?:SHA256}` | `{contextId,seedHead,resourceHead,tip}`; absent head reads an existing identity, present immutable ready seed creates it idempotently |
| `merge` | `{preview:true,heads:[SHA256,SHA256]}` | bounded `conflicts:[{origin,options:[{head,action,messageCount,digest}]}]` and `resources:[{name,versions:[{sha256,kind,heads}]}]` |
| `merge` | `{requestId,heads:[SHA256,SHA256],choices?:[{origin,head}],resources?:[{name,sha256}]}` | `{head}`; two ready immutable parents, idempotent on the complete request binding |

Head paging visits actual changed head records and preserves readiness updates;
`receipts` remains the older complete-carrier inventory. Context IDs follow the
existing invocation-ID syntax. A context fixes its seed and initial resources;
its current tip changes only as its own durable SDK conversation evolves. Merge
retains both logical parent heads, deduplicates common full original origins,
and requires explicit replace/omit and same-path different-resource choices.
Original parent raw entries/resources remain immutable. Each effective visible
message is one typed derived entry, with persistent original-origin, selected-edit,
group/order and tool-call/result mapping. Explicit omissions keep a mapping.
Later old-origin edits are passively retained and rederived into a complete ordered
immutable group; no opaque multi-message marker or passive provider work is used.

`subscribe` adds optional `contextId`; the connection remains fixed to one Bot
and that context until closed. `send` adds the same optional field alongside
`resourceHead`. Omission retains root behavior. History, entry lookup, submission
status, watch, abort, export and retry follow the captured context, including
reconnection. A connection cannot send into a different context. Bot-wide running,
capacity, shared Harness, and existing followUp/steer queue rules remain in force.
Each context has its own rendered event stream; a whole-Bot observer is used only
where a lifecycle wait really needs all contexts.

Before sending, Outbox atomically retains contextId/resourceHead/whenBusy with
the original requestId. Switching selection cannot retarget pending work; retry
uses the captured selection. Durable terminal metadata retains these fields and
is committed in the same file write that removes the pending entry. A root
connection never reconciles another context's pending work. Native selection,
resource choices and two-head merge feed the existing composer and bearer/socket
paths. The incoming selector's trusted management contract is SYNC-NATIVE.md;
it grants no management access to the Bot socket.
