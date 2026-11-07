# SG-002 observation protocol (v1, revision 2)

Status: **frozen interface for SG-002 implementation; no code yet**. Requirements:
[SG-002](SUPERAGENT-002-OBSERVATION.md). Gate evidence:
[cold-read spike](OBSERVATION-SPIKE.md). Normative samples:
`fixtures/bots-observation/` — both the daemon and the Superagent must parse them.

Revision 2 closes the first review: per-Bot baselines instead of one fleet sequence,
range-based change events, store incarnation, history continuation by entry id,
pinned schema version, a dedicated non-rankable scope, and the consumer's existing
authenticated socket instead of a new credential protocol.

## 1. Where this lives

**Provider** — three `GET` routes in the daemon's existing HTTP surface
(`apps/bots/src/server/http.ts` route table), reusing its JSON/error helpers, its
client credential store and its catalog and storage access.

**Consumer** — three commands on the Superagent's existing authenticated WebSocket
(`/v1/chat`, [SG-001 protocol](SUPERAGENT-001-PROTOCOL.md)), reusing its proof
handshake, `{type,id}` command/reply envelope and error codes. No new credential
protocol, no bearer over HTTP, no second socket.

## 2. Provider routes

```text
GET /v1/observe/snapshot
GET /v1/observe/history?botId=<id>&scope=<scopeId|root>&before=<e_n>&limit=<n>
GET /v1/observe/changes?cursor=<opaque>&limit=<n>
```

Loopback only. These routes are stricter than the existing surface, which has no
generic `Host` check and branches health/webhook before authentication, so the
observation path adds its own:

- `Host` must equal `127.0.0.1:<the bound port>`; anything else is `403 host_refused`.
- Any `Origin` header is refused (`403 origin_refused`); a service never sends one.
- No request body: `Content-Length` must be absent or `0`, and no chunked encoding.
- Unknown query parameters are refused (`422 query_invalid`), as are other methods.
- The routes are unavailable while the daemon is closing (`503 shutting_down`).

### Credential

A dedicated observation token, separate from the App root token, the dev-agent token
and named clients:

| Item | Value |
| --- | --- |
| File | `<daemon root>/observation/token` |
| Creation | Minted once by the daemon on first start, 32 random bytes, base64url, mode 0600 |
| Reading | Re-read on every request through the same hardened reader as the dev token: regular file only, no symlink/FIFO, mode exactly 0600, at least 32 characters; anything else is refused, never repaired |
| Scope | Exactly `observe` |
| Rotation | Delete the file; the next start mints a new one and the old token stops working |

`observe` is **not rankable**. It is not implied by `read`/`write`/`admin`, and it
implies none of them. Authentication resolves a fourth actor kind, `observation`, and
the route check is by kind, not by rank:

| Caller | `/v1/observe/*` | every other route |
| --- | --- | --- |
| `observation` token | allowed | **refused** (`403 credential_kind`) |
| App root token | **refused** (`403 credential_kind`) | unchanged |
| dev-agent token | **refused** (`403 credential_kind`) | unchanged |
| named client (any scopes) | **refused** (`403 credential_kind`) | unchanged |

Comparison is constant time. No credential appears in a URL, query, log, error body
or observation payload. A missing file means observation is disabled; the rest of the
daemon is unaffected.

### Store identity

`<daemon root>/observation/identity.json` holds `{storeId, createdAt}`, created with
the token. `storeId` is the source epoch. Deleting the `observation` directory
recreates both, which invalidates every prior cursor.

### Common envelope

```json
{
  "protocolVersion": 1,
  "kind": "snapshot",
  "source": { "id": "8f2a1c0d9be4f7a1", "epoch": "6f1c2a90-1c1b-4a55-9a13-0d1e2f3a4b5c", "capturedAt": 1794000000000 }
}
```

`source.id` is a SHA-256 binding hash of the canonical daemon root; `source.epoch` is
`storeId`. Both are recomputed per request; cursors are bound to both.

## 3. `snapshot`

```json
{
  "protocolVersion": 1,
  "kind": "snapshot",
  "source": { "id": "8f2a1c0d9be4f7a1", "epoch": "6f1c2a90-1c1b-4a55-9a13-0d1e2f3a4b5c", "capturedAt": 1794000000000 },
  "catalog": { "revision": "a1b2c3d4e5f60718", "bots": 3 },
  "bots": [
    {
      "botId": "b_3f1a",
      "title": "Release captain",
      "activity": "idle",
      "store": { "state": "available", "schemaVersion": 2, "incarnation": "9f31c0b4a7d20e55" },
      "coverage": { "scopes": 2, "entries": 28, "newestEntryId": "e_91" },
      "updatedAt": "2026-11-08T09:00:00.000Z"
    },
    {
      "botId": "b_9c2",
      "title": "Nightly triage",
      "activity": "unknown",
      "store": { "state": "session_missing" },
      "updatedAt": "2026-11-07T21:12:00.000Z"
    },
    {
      "botId": "b_71d",
      "title": "Docs runner",
      "activity": "unknown",
      "store": { "state": "schema_unsupported", "schemaVersion": 1 },
      "updatedAt": "2026-10-30T08:00:00.000Z"
    }
  ],
  "botsTotal": 3,
  "truncated": false,
  "cursor": "<opaque baseline>",
  "lag": 0
}
```

- `store.state`: `available`, `session_missing`, `schema_unsupported`,
  `store_unreadable`. Only `available` carries `schemaVersion` (the pinned current
  version is **2**) and `incarnation`. `incarnation` is a digest of the store file's
  `inode` and birth time, so a replaced or restored database is a different store even
  when its contents look similar.
- `activity` is derived from committed task rows only: `running` when any task is
  `running` or `completing`; `queued` when any is `pending`, `waiting` or `sleeping`;
  `idle` when the store is readable and no such row exists; `unknown` when the store is
  not readable. It describes committed work, never a live process promise.
- `catalog.revision` is a digest of the catalog file bytes; `catalog.bots` is the
  catalog's own count, which can differ from `botsTotal` while a Bot is being created.
- `truncated` means the Bot list was cut at the fleet limit; `botsTotal` is the real
  count, and a truncated snapshot does not describe the whole fleet.
- `lag` is the provider's projection lag in milliseconds; a synchronous read-through
  provider reports `0`, and the field exists so a future projection cannot claim
  freshness it lacks.
- `cursor` is the baseline: it encodes `catalog.revision` plus, per Bot,
  `{incarnation, newestEntryId}` at capture. There is no fleet-wide sequence.

## 4. `history`

Request: `botId`, optional `scope` (default `root`), optional `before` (exclusive
entry id), optional `limit`.

```json
{
  "protocolVersion": 1,
  "kind": "history",
  "source": { "id": "8f2a1c0d9be4f7a1", "epoch": "6f1c2a90-1c1b-4a55-9a13-0d1e2f3a4b5c", "capturedAt": 1794000000000 },
  "botId": "b_3f1a",
  "scope": { "id": "c_1", "kind": "root" },
  "scopes": [
    { "id": "c_1", "kind": "root", "entries": 23 },
    { "id": "c_12", "kind": "child", "owner": { "conversationId": "c_1", "taskId": "t_9" }, "entries": 5 }
  ],
  "scopesTruncated": false,
  "boundary": { "newestEntryId": "e_91", "before": "e_91", "compactions": [{ "entryId": "e_88", "head": "e_70" }] },
  "messages": [
    {
      "entryId": "e_70",
      "commitSeq": 70,
      "role": "user",
      "kind": "pi.user",
      "state": "complete",
      "at": "2026-11-08T08:58:00.000Z",
      "blocks": [{ "type": "text", "text": "Why did the nightly run stop?" }]
    },
    {
      "entryId": "e_71",
      "commitSeq": 71,
      "role": "assistant",
      "kind": "pi.assistant",
      "state": "complete",
      "at": "2026-11-08T08:58:04.000Z",
      "blocks": [
        { "type": "text", "text": "The nightly run stopped on a test failure." },
        { "type": "toolResult", "callId": "call_1", "name": "run_tests", "text": "AssertionError: expected 3 suites, saw 2", "isError": true }
      ]
    },
    {
      "entryId": "e_88",
      "commitSeq": 88,
      "role": "notice",
      "kind": "pi.compaction",
      "state": "complete",
      "at": "2026-11-08T08:59:00.000Z",
      "blocks": [{ "type": "notice", "text": "Context compacted; earlier entries stay readable." }]
    }
  ],
  "omitted": { "entries": 2, "kinds": ["pi.system"] },
  "next": { "before": "e_70" },
  "coverage": { "scopes": "complete", "page": "complete", "content": "complete", "reasons": [] }
}
```

Rules:

- `scopes` enumerates **every** retained scope of the Bot in stable id order, so a
  caller can verify completeness. `scopesTruncated: true` with more than 500 scopes.
- A child scope's history is its own conversation rows. It does not inherit or repeat
  the parent's entries; `owner` names the fork relationship (`conversationId` from
  `owner_conversation_id`, `taskId` from `owner_task_id`).
- `boundary.newestEntryId` is fixed at capture; `before` echoes the request and is
  absent on the newest page. Compaction boundaries appear in
  `boundary.compactions` as `{entryId, head}` where `head` is the retained entry the
  compacted window starts at, and the compaction entry itself is returned as a
  `notice`.
- Continuation is `next.before`: the oldest entry id of the returned page, exclusive.
  There is no opaque history cursor; paging cannot re-serve a page or skip an entry.
  `next` is absent on the oldest page.
- `messages` are ordered oldest first within one page; pages walk newest to oldest.
- `role` ∈ `user`, `assistant`, `notice`, `tool`, `system`; `kind` is the stored entry
  kind verbatim (`pi.user`, `pi.assistant`, `pi.compaction`, `bots.reflection`, …).
- Blocks are exactly the existing daemon wire blocks: `text`, `toolCall`
  (`callId,name,args`), `toolResult` (`callId,name,text,isError,durationMs?`) and
  `notice` (`text`). Thinking/reasoning blocks are never exposed; they are counted in
  `omitted`. Stored content is returned as retained — the daemon's write-time bound is
  the limit, and the observation never promises bytes that were never stored.
- `omitted` counts stored entries that were deliberately not turned into messages, and
  its `kinds` lists them. It never hides a scope or a page.
- `coverage` has three independent parts:
  `scopes` (`complete` | `truncated`), `page` (`complete` | `truncated`) and `content`
  (`complete` | `partial`), with `reasons` from `scopes_truncated`, `page_limit`,
  `unsupported_kind`, `scope_unavailable`. Nothing is `complete` unless every scope was
  enumerated, the page was not cut and every entry could be mapped.
- An unknown `botId` is `404 unknown_bot`; a foreign or unknown `scope` is
  `404 unknown_scope`. An unreadable store answers `503 provider_unavailable` with the
  store state, never an empty page.

## 5. `changes`

`changes` compares the presented baseline with the current state, Bot by Bot.

```json
{
  "protocolVersion": 1,
  "kind": "changes",
  "source": { "id": "8f2a1c0d9be4f7a1", "epoch": "6f1c2a90-1c1b-4a55-9a13-0d1e2f3a4b5c", "capturedAt": 1794000000000 },
  "changes": [
    { "kind": "history_appended", "botId": "b_3f1a", "scopeId": "c_1", "from": "e_71", "to": "e_91", "entries": 21 },
    { "kind": "storage_replaced", "botId": "b_55e" },
    { "kind": "store_state_changed", "botId": "b_9c2", "state": "session_missing" },
    { "kind": "activity_changed", "botId": "b_71d", "activity": "queued" },
    { "kind": "catalog_changed", "bots": 4 }
  ],
  "next": { "cursor": "<opaque baseline>" },
  "coverage": { "complete": true, "reasons": [] }
}
```

- Change kinds: `history_appended` (an entry-id range in one scope),
  `storage_replaced` (different incarnation), `store_state_changed`,
  `activity_changed`, `catalog_changed` (catalog digest differs; the consumer must
  re-read `snapshot` for the new Bot set).
- There are no per-message events and no event identity derived from `commit_seq`:
  one commit can write several entries, and tasks/submissions are updated in place, so
  a sequence cannot identify an event. A range plus the Bot's incarnation is stable and
  replayable.
- Replaying the same cursor returns the same ranges; a consumer dedupes on
  `(kind, botId, scopeId, to)` or simply re-reads `snapshot` when it is unsure.
- `next` is always present. `coverage.complete: false` with `page_limit` means the
  page was cut; the consumer reads again before treating `next` as current.
- No worker progress waits on this read and no acknowledgement endpoint exists.

## 6. Errors

```json
{ "protocolVersion": 1, "error": { "code": "cursor_reset", "detail": "the source epoch changed" } }
```

| HTTP | `code` | Meaning |
| --- | --- | --- |
| 401 | `unauthenticated` | observation credential absent or wrong |
| 403 | `credential_kind` | a valid credential used on the wrong surface |
| 403 | `host_refused` / `origin_refused` | not the loopback endpoint that owns this root |
| 404 | `unknown_bot` / `unknown_scope` | requested identity does not exist |
| 409 | `cursor_invalid` | cursor malformed or bound to another source/epoch/operation |
| 410 | `cursor_reset` | epoch or a Bot's store incarnation changed; re-baseline required |
| 422 | `limit_invalid` / `query_invalid` | limit out of range, unknown parameter |
| 503 | `provider_unavailable` / `shutting_down` | the store cannot be read now, or closing |

`limit` defaults: `history` 50 (1–200), `changes` 100 (1–500). An omitted limit uses
the default; `limit_invalid` means a value that is not a positive integer inside the
range, and its `detail` names that operation's range. `provider_unavailable` carries
the store state of the Bot it concerns. `detail` is a fixed, secret-free explanation;
no stack, path, Bot content, token or provider text ever appears.

## 7. Cursors

Opaque to callers: `base64url(JSON({v:1,k,s,e,...}))`.

| Field | Meaning |
| --- | --- |
| `v` | cursor version, `1` |
| `k` | operation, `changes` |
| `s`, `e` | source id and epoch |
| `c` | catalog revision |
| `p` | map `botId → {incarnation, entryId}` for Bots whose store was readable at capture; a Bot without a readable store is absent and reports `store_state_changed` until it is readable |

The baseline is the only cursor. A history page is continued by `next.before`, which
is a plain entry id, not a cursor. A cursor is decoded, validated, then compared with
the live source/epoch/catalog/Bot set: an epoch or incarnation mismatch is
`cursor_reset`, a malformed or wrong-source cursor is `cursor_invalid`, never a
best-effort continuation.

## 8. Limits

| Limit | Value |
| --- | --- |
| Snapshot bots | 200 per response, `truncated` beyond |
| History messages per page | default 50, max 200 |
| History scopes per Bot | 500, `scopesTruncated` beyond |
| Change entries per page | default 100, max 500 |
| Response body | 512 KiB; a history page stops early with `coverage.page: "truncated"` |
| Read budget | one short transaction per request, 3 s ceiling, handles released before responding |

## 9. Non-interference

Reusing daemon infrastructure does not relax inertness. Allowed side effects: WAL
`-shm`/`-wal` sidecars may appear or be rewritten; trace and credential-use
bookkeeping. Forbidden: creating or migrating a store, opening a Harness,
resume/recovery, configuration, tool refresh, `registry.touch`, idle-lease extension,
peer/exchange/trigger/secret writes, conversation entries, observer backpressure into a
worker commit.

Reads use a read-only connection after an existence check, verify the store's schema
version against provider-owned constants, and never migrate. A conformance test fails
when the pinned `@earendil-works/pi-durable` schema version or table set changes, so
that coupling stays explicit.

## 10. Consumer (Superagent)

Three commands on the existing authenticated socket `/v1/chat`:

| Command | Fields | Result value |
| --- | --- | --- |
| `observe-snapshot` | `type,id` | `{provider, snapshot}` |
| `observe-history` | `type,id,botId,scope?,before?,limit?` | `{provider, history}` |
| `observe-changes` | `type,id,limit?` | `{provider, changes}` |

`provider` describes the consumer's own view of the provider:

```json
"provider": {
  "reachable": true,
  "state": "ready",
  "source": { "id": "8f2a1c0d9be4f7a1", "epoch": "6f1c2a90-1c1b-4a55-9a13-0d1e2f3a4b5c", "capturedAt": 1794000000000 },
  "lastReadAt": "2026-11-08T09:00:02.000Z",
  "unavailable": 0,
  "failure": { "code": "provider_unavailable", "id": "f_12" }
}
```

- `state` ∈ `ready`, `refused`, `unreachable`, `reset`, `unconfigured`; `unavailable`
  counts Bots the last snapshot could not read.
- `observe-changes` takes no cursor: the consumer sends its stored baseline and commits
  the new one together with the consumed observation in its own store.
- A provider `cursor_reset` surfaces as `state: "reset"`; the consumer drops the stale
  baseline and re-reads `snapshot` before serving further changes.
- The provider's raw error codes are mapped to the existing socket codes
  (`unconfigured`, `storage_failed`, `internal`, `shutting_down`); provider `detail`
  text is never forwarded verbatim. The consumer never falls back to daemon files.
- Reply shapes are exactly SG-001's `{type:"result",id,value}` and
  `{type:"error",id,code}`. Observation never closes the chat socket and never blocks a
  chat command.

### CLI

```text
eagle-dev superagent observe status [--json]
eagle-dev superagent observe snapshot [--json]
eagle-dev superagent observe history --bot ID [--scope ID|root] [--before e_n] [--limit N] [--json]
eagle-dev superagent observe changes [--limit N] [--json]
```

Exit codes reuse SG-001: `0` success, `1` service/provider failure, `2` usage,
`3` credential/identity refusal, `4` unreachable. `--json` prints the wire value.

### Configuration

| Setting | Default |
| --- | --- |
| Provider endpoint | `http://127.0.0.1:43117`, override `BOTS_OBSERVATION_ENDPOINT` |
| Provider credential file | `<daemon root>/observation/token`, override `BOTS_OBSERVATION_TOKEN_FILE` |
| Consumer state | inside the Superagent root, never in the daemon root |

The consumer rejects a non-loopback endpoint, a redirect and any `Host`/`Origin`
mismatch, and reads the credential file at use. The credential never appears in an
argument, URL, environment value, log or model content.

## 11. Fixtures and conformance

| File | Purpose |
| --- | --- |
| `snapshot.server.json` | one available (schema 2), one missing and one unsupported (schema 1) store |
| `history.server.json` | root page with a compaction boundary, child scope, tool result and `next` |
| `history-oldest.server.json` | oldest page: no `next` |
| `history-truncated.server.json` | page cut by the response cap: `coverage.page: "truncated"` |
| `changes.server.json` | range, replacement, state, activity and catalog changes with a duplicate |
| `error.server.json` | every error code with its status |
| `cursor.json` | baseline cursors, their bindings and the expected rejection |

Both languages decode these bytes; a missing required field is an error, an unknown
field is dropped on encode and tolerated on decode. A wire change lands with its
fixture and both conformance tests in the same commit.
