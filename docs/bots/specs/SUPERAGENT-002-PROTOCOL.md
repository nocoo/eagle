# SG-002 observation protocol (v1)

Status: **frozen interface for SG-002 implementation; no code yet**. Requirements:
[SG-002](SUPERAGENT-002-OBSERVATION.md). Gate evidence:
[cold-read spike](OBSERVATION-SPIKE.md). Normative samples:
`fixtures/bots-observation/` — both the daemon and the Superagent must parse them.

## 1. Where this lives

The provider is mounted in the daemon's existing HTTP surface
(`apps/bots/src/server/http.ts` route table), shares its loopback-only, Host/Origin
checks and its JSON helpers, and adds three routes plus one credential. The consumer
is the Superagent's own authenticated API. Only the wire shapes below are new.

## 2. Provider routes

All are `GET`, loopback-only, and refuse a browser `Origin`, a non-loopback `Host`,
unknown query parameters and any body. No credential appears in a URL.

```text
GET /v1/observe/snapshot
GET /v1/observe/history?botId=<id>&scope=<scopeId|root>&before=<entryId|e_91>&limit=<n>
GET /v1/observe/changes?cursor=<opaque>&limit=<n>
```

### Credential

`Authorization: Bearer <observation token>`, where the token is minted by the daemon
into its own root (mode 0600) on first start beside a store identity record
`{storeId, createdAt}`.

| Caller | `/v1/observe/*` | every other route |
| --- | --- | --- |
| observation token | allowed | **refused** (`403 credential_kind`) |
| worker bearer token | **refused** (`403 credential_kind`) | unchanged |

Comparison is constant time. A missing, non-regular, symlinked, foreign-owned or
loosened credential file fails closed; it is never repaired, regenerated or logged.
There is no query-string, cookie or header-alternative credential.

### Common envelope

Every success response carries:

```json
{
  "protocolVersion": 1,
  "kind": "snapshot",
  "source": { "id": "<16 hex chars>", "epoch": "<uuid>", "capturedAt": 1762500000000 }
}
```

`source.id` is a binding hash of the canonical daemon root; `source.epoch` is
`storeId` from the store identity record and changes when that record is recreated.
Every cursor is bound to `source`, operation, Bot and scope.

## 3. `snapshot`

```json
{
  "protocolVersion": 1,
  "kind": "snapshot",
  "source": { "id": "8f2a1c0d9be4f7a1", "epoch": "6f1c...", "capturedAt": 1762500000000 },
  "bots": [
    {
      "botId": "b_3f1a",
      "title": "Release captain",
      "activity": "idle",
      "store": { "state": "available", "schemaVersion": 3 },
      "coverage": { "scopes": 2, "entries": 53, "watermark": 88 },
      "updatedAt": "2026-11-08T09:00:00.000Z"
    }
  ],
  "botsTotal": 1,
  "truncated": false,
  "cursor": "<opaque changes cursor>",
  "lag": 0
}
```

- `store.state` is one of `available`, `session_missing`, `schema_unsupported`,
  `store_unreadable`. Only `available` carries a numeric `coverage.watermark`.
- `activity` is one of `idle`, `running`, `queued`, `unknown`, read from committed
  rows; it is a fact about committed work, not a promise about live execution.
- `truncated` is true when `bots` was cut at the fleet limit; `botsTotal` is the real
  count. A truncated snapshot must not be read as the whole fleet.
- `lag` is the provider's projection lag in milliseconds. With a synchronous
  read-through provider it is `0`; it exists so a future projection cannot claim
  completeness it does not have.
- The snapshot's `cursor` is the change cursor paired with this baseline.

## 4. `history`

```json
{
  "protocolVersion": 1,
  "kind": "history",
  "source": { "id": "8f2a1c0d9be4f7a1", "epoch": "6f1c...", "capturedAt": 1762500000000 },
  "botId": "b_3f1a",
  "scopes": [
    { "id": "c_1", "kind": "root", "entries": 23 },
    { "id": "c_12", "kind": "child", "owner": { "conversationId": "c_1", "taskId": "t_9" }, "entries": 5 }
  ],
  "scope": { "id": "c_1", "kind": "root" },
  "boundary": { "newestEntryId": "e_91", "before": "e_91" },
  "messages": [
    {
      "entryId": "e_88",
      "commitSeq": 88,
      "role": "assistant",
      "kind": "pi.assistant",
      "state": "complete",
      "at": "2026-11-08T08:59:00.000Z",
      "bounded": false,
      "blocks": [{ "type": "text", "text": "The build is green." }]
    }
  ],
  "omitted": { "entries": 2, "kinds": ["pi.system"] },
  "next": { "cursor": "<opaque history cursor>" },
  "coverage": { "complete": true }
}
```

Rules:

- `scopes` always enumerates **every** retained scope of that Bot, in stable order,
  so a caller can check completeness itself. Root scope id is the root conversation id.
- `boundary.newestEntryId` is fixed at capture; `before` echoes the request and is
  absent when the newest page is requested. `next` is absent on the oldest page.
- Paging is by entry id (`e_<n>`, the daemon's wire form), never by time or offset.
  Order is ascending inside one page, and pages walk from newest to oldest.
- `role` is one of `user`, `assistant`, `notice`, `tool`, `system`. `kind` is the
  stored entry kind verbatim (`pi.user`, `pi.assistant`, `pi.compaction`,
  `bots.reflection`, …), so a consumer never has to infer provenance.
- A `pi.compaction` boundary entry is returned as a `notice` with
  `kind: "pi.compaction"`; the entries before it stay readable.
- `bounded` is true when stored content exceeded the per-block limit and was cut. The
  response never implies missing bytes are recoverable.
- `omitted` counts stored entries that were deliberately not turned into messages
  (system prompts, internal reasoning). It never hides a scope.
- `coverage.complete` is true only when `scopes` was fully enumerated, no limit cut
  the enumeration, and no unsupported kind was skipped. Otherwise it is
  `{ "complete": false, "reason": "truncated" | "unsupported_kind" | "scope_unavailable" }`.
- An unknown `botId` is `404 unknown_bot`; an unknown or foreign `scope` is
  `404 unknown_scope`. Unreadable stores are per-Bot facts from `snapshot`, and a
  history read on them is `503 provider_unavailable` with the store state, never an
  empty page.

## 5. `changes`

```json
{
  "protocolVersion": 1,
  "kind": "changes",
  "source": { "id": "8f2a1c0d9be4f7a1", "epoch": "6f1c...", "capturedAt": 1762500000000 },
  "changes": [
    {
      "kind": "history_appended",
      "botId": "b_3f1a",
      "scopeId": "c_1",
      "commitSeq": 88,
      "at": "2026-11-08T08:59:00.000Z"
    },
    { "kind": "store_state_changed", "botId": "b_9c2", "state": "session_missing" }
  ],
  "next": { "cursor": "<opaque changes cursor>" },
  "coverage": { "complete": true }
}
```

- Change kinds: `bot_added`, `bot_removed`, `history_appended`, `status_changed`,
  `store_state_changed`.
- The dedupe key is `(kind, botId, scopeId, commitSeq)`; duplicates across reads are
  allowed and are how a consumer proves idempotency.
- `next` is always present: an unchanged read returns the same cursor with an empty
  list.
- No worker progress waits on this read, and no acknowledgement endpoint exists.
- `coverage.complete: false` with `reason: "truncated"` means the limit cut the page;
  the consumer must read again before treating the cursor as current.

## 6. Errors

```json
{ "protocolVersion": 1, "error": { "code": "cursor_reset", "detail": "the source epoch changed" } }
```

| HTTP | `code` | Meaning |
| --- | --- | --- |
| 401 | `unauthenticated` | credential absent or wrong |
| 403 | `credential_kind` | a valid credential used on the wrong surface |
| 404 | `unknown_bot` / `unknown_scope` | requested identity does not exist |
| 409 | `cursor_invalid` | cursor bound to another source/epoch/operation/Bot/scope, or malformed |
| 410 | `cursor_reset` | epoch changed or the baseline is unusable; re-baseline required |
| 422 | `limit_invalid` | limit missing, non-numeric or out of range |
| 503 | `shutting_down` / `provider_unavailable` | closing, or the store cannot be read now |

`detail` is a fixed, secret-free explanation. No stack, path, Bot content, token or
provider message ever appears in an error.

## 7. Cursors

Opaque to callers: `base64url(JSON({v:1,k,s,e,b?,c?,q}))`.

| Field | Meaning |
| --- | --- |
| `v` | cursor version, `1` |
| `k` | operation: `changes` or `history` |
| `s` | source id |
| `e` | source epoch |
| `b` | Bot id (history) |
| `c` | scope id or `root` |
| `q` | position: `commitSeq` (number) for `changes`, entry id (`e_<n>`) for `history` |

A cursor is decoded, structurally validated and then checked against the request's
binding; a mismatch is `409 cursor_invalid`, never a best-effort continuation. Cursors
are never accepted from a URL for the consumer API; the consumer keeps its own.

## 8. Limits (frozen)

| Limit | Value |
| --- | --- |
| Snapshot bots | 200 per response, `truncated` beyond |
| History messages per page | default 50, max 200 |
| History scopes per Bot | max 500, beyond that `coverage.complete: false` with `truncated` |
| Change entries per page | default 100, max 500 |
| Response body | 512 KiB per response; a history page stops early with `truncated` |
| Text block | 8 KiB stored text per block, `bounded: true` when cut |
| Server read budget | one short transaction per request, 3 s ceiling, handles released before responding |

## 9. Non-interference

Allowed side effects: WAL `-shm`/`-wal` sidecars may appear or be rewritten; trace
and credential-use bookkeeping. Everything else is forbidden: creating or migrating a
store, opening a Harness, resume/recovery, configuration, tool refresh, `registry.touch`,
idle-lease extension, peer/exchange/trigger/secret writes, conversation entries,
observer backpressure into a worker commit.

Reads run on a read-only connection, after an existence check, with the store's schema
version verified against provider-owned constants. A conformance test fails when the
pinned `@earendil-works/pi-durable` schema changes, so that coupling stays explicit.

## 10. Consumer routes (Superagent)

The Superagent exposes the same three operations to the App and CLI, authenticated by
its own SG-001 root credential, and adds a `provider` block and its own state:

```text
GET /v1/observe/snapshot
GET /v1/observe/history?botId=<id>&scope=<scopeId|root>&before=<entryId|e_91>&limit=<n>
GET /v1/observe/changes?limit=<n>
```

```json
"provider": {
  "reachable": true,
  "source": { "id": "8f2a1c0d9be4f7a1", "epoch": "6f1c...", "capturedAt": 1762500000000 },
  "state": "ready",
  "lastReadAt": "2026-11-08T09:00:02.000Z",
  "failure": { "code": "provider_unavailable", "id": "f_12" }
}
```

- `state` is `ready`, `refused`, `unreachable`, `reset` or `unconfigured`.
- `changes` takes no cursor: the consumer uses its stored cursor and commits the new
  one with the consumed observation in its own store. Clients cannot inject a provider
  cursor.
- A `cursor_reset` from the provider is surfaced as `state: "reset"` with the stale
  baseline dropped; the next read re-baselines and reports `truncated` coverage until
  it has done so.
- The consumer never falls back to reading daemon files, and its chat surface keeps
  working while observation is refused, unavailable or failing.

### CLI

```text
eagle-dev superagent observe status [--json]
eagle-dev superagent observe snapshot [--json]
eagle-dev superagent observe history --bot ID [--scope ID|root] [--before ENTRY] [--limit N] [--json]
eagle-dev superagent observe changes [--limit N] [--json]
```

Exit codes reuse SG-001: `0` success, `1` service/provider failure, `2` usage,
`3` credential/identity refusal, `4` unreachable. `--json` prints the wire body.

### Configuration

| Setting | Default |
| --- | --- |
| Provider endpoint | `http://127.0.0.1:43117`, override `BOTS_OBSERVATION_ENDPOINT` |
| Provider credential file | `<bots root>/observation/token`, override `BOTS_OBSERVATION_TOKEN_FILE` |
| Consumer state | inside the Superagent root, never in the daemon root |

The provider credential is read from its file at use, never from an argument, URL,
environment value, log or model content.

## 11. Fixtures and conformance

`fixtures/bots-observation/` holds the normative samples:

| File | Purpose |
| --- | --- |
| `snapshot.server.json` | snapshot with one available, one missing and one unsupported store |
| `history.server.json` | paged history with a compaction boundary, a child scope and one bounded block |
| `history-oldest.server.json` | last page: no `next`, complete coverage |
| `changes.server.json` | mixed changes with a duplicate and a truncated page |
| `error.server.json` | each error code with its status |
| `cursor.json` | documented cursors and the binding each must resolve to |

Both languages decode these bytes; a required field missing is an error, an unknown
field is dropped on encode and tolerated on decode. Any change to a wire shape lands
with its fixture and both conformance tests in the same commit.
