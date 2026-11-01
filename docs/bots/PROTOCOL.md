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
| `bot.note` (HTTP and `note_set`) | 120 characters after trimming and whitespace collapse, optional | HTTP `400`, or the tool returns an error |
| `group.title` (HTTP) | 1–40 characters after trimming | HTTP `400` |
| Groups | 50 per catalog | `POST /v1/groups` answers `limit_exceeded` |
| `bot.appearance` (HTTP) | one shape and one tint from the closed sets | HTTP `400` |
| Any HTTP body | 256 KiB, measured as received (the shared frame cap) | HTTP `500` before the body is parsed |
| `settings.corePrompt` (HTTP) | 4 000 characters after trimming | HTTP `400` |
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
| `PATCH` | `/v1/bots/:id` | `{ "title"?, "label"?, "note"?, "appearance"?, "groupId"?, "model"?, "thinkingLevel"? }` — a label of `""`, a note of `null` and a `groupId` of `null` clear their field | `{ "bot": BotSummary }` |
| `DELETE` | `/v1/bots/:id` | — | `204` |
| `POST` | `/v1/groups` | `{ "title" }` | `{ "group": BotGroup }` |
| `PATCH` | `/v1/groups/:id` | `{ "title" }` | `{ "group": BotGroup }` |
| `PUT` | `/v1/groups/order` | `{ "ids": [string] }` — every group once, in display order | `{ "groups": [BotGroup] }` |
| `DELETE` | `/v1/groups/:id` | — | `204`, or `409` while a bot is filed under it |
| `GET` | `/v1/providers` | — | `{ "providers": [Provider] }` |
| `PUT` | `/v1/providers/:id` | `{ "apiKey"?, "enabled"? }` | `{ "provider": Provider }` |
| `POST` | `/v1/providers/:id/test` | — | `{ "result": { "ok", "message", "latencyMs", "results"? } }` |
| `GET` | `/v1/usage?days=` | — | `{ "usage": UsageReport }` — statistics over the daemon's retained days |
| `GET` | `/v1/models` | — | `{ "models": [string] }` — the gateway's ids, empty when it cannot be asked |
| `GET` | `/v1/settings` | — | `{ "settings": GatewaySettings, "machinePrompt": MachinePrompt \| null }` |
| `GET` | `/v1/clients` | — | `{ "clients": [Client] }` — requires `admin` |
| `POST` | `/v1/clients` | `{ "name", "scopes" }` — fields follow `CLI.md` rules | `201 { "client": Client, "token" }` — requires `admin`, the token is answered once |
| `GET` | `/v1/clients/me` | — | `{ "client": Client \| null }` — `null` for the App's own token |
| `POST` | `/v1/clients/:id/rotate` | — | `{ "client": Client, "token" }` — requires `admin` |
| `POST` | `/v1/clients/:id/revoke` | — | `{ "client": Client }` — requires `admin`, idempotent |
| `DELETE` | `/v1/clients/:id` | — | `204`, or `409 client_active` while the client is not revoked |
| `PUT` | `/v1/settings` | `{ "baseUrl", "model", "apiKey"?, "provider"?, "thinkingLevel"?, "toolGroups"?, "corePrompt"? }` | `{ "settings": GatewaySettings, "machinePrompt": MachinePrompt \| null }` |
| `POST` | `/v1/settings/test` | `{ "baseUrl"?, "model"?, "apiKey"?, "provider"? }` | `{ "result": GatewayProbe }` |

```json
// GatewaySettings: the key is never returned, only whether one is stored.
{ "configured": true, "provider": "magpie", "baseUrl": "http://127.0.0.1:3425/v1",
  "model": "auto/gpt-6-luna", "hasApiKey": true, "thinkingLevel": "medium",
  "toolGroups": ["persona", "machine", "core", "coding", "herdr", "agents", "trigger"],
  "corePrompt": "你是一个务实、友好的 agent：先说结论，再给依据。" }

// MachinePrompt: the machine's own instructions, read-only, with the file a person edits.
{ "path": "/Users/me/workspace/workflow/agents/AGENTS.md", "text": "# system0 machine setup…" }

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
  `persona` and `machine` (the two core prompts, see below), `core` (the `list` tool),
  `coding` (pi-durable's `read`, `write`, `edit`, `bash`), `herdr` (the terminal
  collaborator), and `agents` (child conversations). Only `core` and `coding` are mandatory:
  an empty array selects exactly those two. An unknown name is a `400` and nothing is
  written. Saving records the selection on every bot and changes what a live conversation
  offers in place. There are no aliases for the old tool names.
- **The two core prompts lead the system prompt.** `corePrompt` is one standing instruction
  for every bot, trimmed and bounded to 4 000 characters (a longer one is a `400`); an empty
  string stores no section. The machine prompt is never written by the daemon: it is the
  first file that exists with content among `~/.agents/AGENTS.md`, `~/.pi/agent/AGENTS.md`,
  `~/.codex/AGENTS.md` and `~/.claude/CLAUDE.md`, resolved through its symlink and cut at
  40 000 characters. `machinePrompt` reports that file and its text, or `null` when none
  exists; neither field is a per-bot setting.
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

## CLI clients and scopes

The App's own token in `<root>/token` stays the only credential with every right. Named
CLI credentials are an additive set so a person can hand one to another agent, watch it,
revoke it and delete it again (`CLI.md` owns the CLI itself).

- **Where they live.** `<root>/clients.json`, mode 0600, beside the token:
  `{ "version": 1, "clients": [Client] }`. Written atomically through a temporary
  sibling and `link`, the same way the token is.
- **What is stored.** `{ "id": "c_<uuid>", "name", "scopes": ["read"|"write"|"admin"],
  "salt", "hash", "createdAt", "lastUsedAt"?, "revokedAt"? }`. The secret itself is
  never written: `hash` is SHA-256 over the salt and the secret, so a copied file does not
  yield a usable bearer.
- **Token form.** `<id>.<secret>`, secret 32 random bytes base64url. A presented bearer is
  split on the first `.`, looked up by id, compared in constant time, and refused with the
  same `401 auth_failed` as an unknown token when the credential is missing or revoked
  (no oracle).
- **Scopes are per route.** `read` covers every `GET`; `write` adds `send`/`abort` on a
  subscribed bot, `POST /v1/bots`, `PATCH /v1/bots/:id`, `POST /v1/groups`,
  `PATCH /v1/groups/:id` and `PUT /v1/groups/order`; `admin` adds `DELETE /v1/bots/:id`,
  `DELETE /v1/groups/:id`, every `/v1/settings` write, `/v1/settings/test`,
  `/v1/providers` writes and `/v1/clients`. A missing scope is
  `403 { "error": { "kind": "auth_scope", "message" } }` and mutates nothing. The App's
  own token is always `admin`.
- **Sockets obey the scope.** A credential without `write` may subscribe and read; its
  `send`/`abort` is refused as `error{kind:"auth_scope"}` on the open connection instead of
  blocking the upgrade.
- **Name rules.** 1–32 characters after trimming, `[a-z0-9][a-z0-9_-]*`, unique among
  records, so a log line names one client. `scopes` is a non-empty deduplicated subset of
  the three; an unknown scope or a duplicate name is a `400`.
- **Revoke first, delete second.** `revoke` sets `revokedAt` and keeps the record (the App
  shows who was cut off); `DELETE` answers `409 client_active` until the record is revoked,
  then removes it. Revoking an already-revoked client is a no-op that returns the record.
- **Authorship is recorded, not invented.** A user message admitted over a CLI credential
  carries `origin: { "kind": "human", "label": "<client name>" }`; the App's own token
  keeps `{ "kind": "human" }`. `lastUsedAt` moves at most once per minute, so a chatty
  client does not rewrite the file per request.

## The bot's own note

`BotSummary.note` is the one line a Bot writes about itself, so a sidebar row says what a
Bot is doing without opening its conversation (which costs a socket and a restore).

- **It is the Bot's, not the person's.** The `note_set` tool in the `core` group writes it;
  `PATCH /v1/bots/:id` exists so a client can read it back and clear it (`"note": null`),
  never so a client can invent a status.
- **Bounded and normalized.** Whitespace runs collapse to one space, the value is trimmed,
  and 120 characters is the cap. A longer note is refused instead of truncated: a silently
  shortened status line is a lie.
- **Catalog-visible.** The value rides on `BotSummary`, so `bots` events carry it and no
  extra read is needed. Setting or clearing it republishes the catalog.
- **Optional.** Absent means the Bot never set one; a client may then show its own derived
  preview, and must not invent text of its own.

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
  "note": "在核对 10-24 的依赖报告",      // optional; the Bot's own one-line status
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

`fixtures/bots-protocol/` holds one frame per file, pretty-printed, used by both
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
| `send.client.json`, `abort.client.json`, `recover.client.json`, `resync.client.json` | commands |
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
