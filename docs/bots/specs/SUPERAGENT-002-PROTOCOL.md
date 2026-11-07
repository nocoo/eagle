# SG-002 observation protocol (v1, revision 3)

Status: **frozen interface for SG-002 implementation; no code yet**. Requirements:
[SG-002](SUPERAGENT-002-OBSERVATION.md). Gate evidence:
[cold-read spike](OBSERVATION-SPIKE.md). Normative samples:
`fixtures/bots-observation/` — both the daemon and the Superagent must parse them.

Revision 3 closes the second review: a request body for the baseline (it cannot fit
in a request target), one end-to-end byte budget under the socket frame cap, a
delivery trim that still advances the page, store generation and page stability,
scope-enumeration continuation, and mapping/omission rules that match the daemon's
real converters.

## 1. Where this lives

**Provider** — three routes in the daemon's existing HTTP surface
(`apps/bots/src/server/http.ts`), reusing its JSON/error helpers, its client
credential store, its catalog and storage access.

**Consumer** — three commands on the Superagent's existing authenticated WebSocket
(`/v1/chat`, [SG-001 protocol](SUPERAGENT-001-PROTOCOL.md)), reusing its proof
handshake, `{type,id}` envelope and error codes.

## 2. Provider routes

```text
GET  /v1/observe/snapshot
GET  /v1/observe/history?botId=<id>&scope=<scopeId|root>&scopeAfter=<scopeId>&before=<e_n>&limit=<n>
POST /v1/observe/changes
```

`changes` takes a body because a 200-Bot baseline cannot be carried in a request
target: Node's default header budget is 16 KiB (`http.ts` request handling), and the
frozen baseline is much larger than that. It is still an inert read — the route
accepts no other method and performs no write.

```json
{ "cursor": "<opaque baseline>", "limit": 100 }
```

Body: JSON only, `Content-Type: application/json`, at most 64 KiB; anything else is
`413 body_refused` / `422 query_invalid`. `GET` routes refuse any body. 64 KiB is the
measured size of a full 200-Bot baseline with UUID identities plus headroom, and is an
acceptance case (SG002-A16), not an assumption.

Loopback only, with checks the existing surface does not provide:

- `Host` must equal `127.0.0.1:<the bound port>`; otherwise `403 host_refused`.
- Any `Origin` header is refused (`403 origin_refused`).
- Unknown query parameters on the `GET` routes are refused (`422 query_invalid`).
- The routes answer `503 shutting_down` while the daemon is closing.

### Credential

A dedicated observation token, separate from the App root token, the dev-agent token
and named clients:

| Item | Value |
| --- | --- |
| File | `<daemon root>/observation/token` |
| Creation | Minted once by the daemon on first start: 32 random bytes, base64url, mode 0600 |
| Reading | Re-read per request with the dev-token reader rules: regular file, no symlink/FIFO, mode exactly 0600, at least 32 characters; anything else is refused, never repaired |
| Scope | Exactly `observe` |
| Rotation | Delete the file; the next start mints a new one and the old token stops working |

`observe` is **not rankable**: it is not implied by `read`/`write`/`admin`, and it
implies none of them. Authentication resolves a fourth actor kind, `observation`, and
the route check is by kind rather than by rank:

| Caller | `/v1/observe/*` | every other route |
| --- | --- | --- |
| `observation` token | allowed | **refused** (`403 credential_kind`) |
| App root token | **refused** (`403 credential_kind`) | unchanged |
| dev-agent token | **refused** (`403 credential_kind`) | unchanged |
| named client (any scopes) | **refused** (`403 credential_kind`) | unchanged |

Comparison is constant time. The credential never appears in a URL, body, log, error
or payload. A missing file means observation is disabled; the rest of the daemon is
unaffected.

### Store identity

`<daemon root>/observation/identity.json` holds `{storeId, createdAt}`, created with
the token. `storeId` is the source epoch; deleting the `observation` directory
recreates both and invalidates every cursor.

### Common envelope

```json
{
  "protocolVersion": 1,
  "kind": "snapshot",
  "source": { "id": "8f2a1c0d9be4f7a1", "epoch": "6f1c2a90-1c1b-4a55-9a13-0d1e2f3a4b5c", "capturedAt": 1794000000000 }
}
```

`source.id` is a SHA-256 binding hash of the canonical daemon root; `source.epoch` is
`storeId`. Both are recomputed per request; cursors bind both.

## 3. `snapshot`

```json
{
  "protocolVersion": 1,
  "kind": "snapshot",
  "source": { "id": "8f2a1c0d9be4f7a1", "epoch": "6f1c2a90-1c1b-4a55-9a13-0d1e2f3a4b5c", "capturedAt": 1794000000000 },
  "catalog": { "revision": "a1b2c3d4e5f60718", "bots": 3 },
  "consistent": true,
  "bots": [
    {
      "botId": "b_3f1a",
      "title": "Release captain",
      "activity": "idle",
      "store": { "state": "available", "schemaVersion": 2, "incarnation": "9f31c0b4a7d20e55" },
      "coverage": { "scopes": 2, "entries": 28, "newestEntryId": "e_91", "generation": { "min": "e_10", "max": "e_91", "count": 28 } },
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
  `store_unreadable`. `schemaVersion` is present whenever the file could be opened and
  its version read (`available`, `schema_unsupported`; the pinned current version is
  **2**), absent otherwise. `incarnation` is present only for `available` and is a
  digest of the file's inode and birth time, so a copied or replaced database is a
  different store.
- `coverage.generation` is `{min, max, count}` over the Bot's entries. It detects an
  in-place restore that rewrites the same file: a `max` or `count` that goes backwards
  relative to a baseline is a replaced store, not a continuation.
- `activity` derives from committed task rows only: `running` when any task is
  `running` or `completing`; `queued` when any is `pending`, `waiting` or `sleeping`;
  `idle` when the store is readable and no such row exists; `unknown` when it is not
  readable. It describes committed work, never a live process promise.
- `consistent: false` means the catalog revision changed between the start and the end
  of the Bot scan, so the Bot list and the catalog described different moments. The
  baseline is still usable, and the next `changes` reports `catalog_changed`.
- `truncated: true` means the Bot list was cut at the fleet limit; `botsTotal` is the
  real count, and the baseline then covers only the delivered Bots. Undelivered Bots
  are reported as `catalog_changed` until a later snapshot delivers them.
- `lag` is the provider's projection lag in milliseconds; a synchronous read-through
  provider reports `0`.
- `cursor` is the baseline (section 7). A truncated snapshot's baseline covers only the
  delivered Bots; undelivered Bots are reported as `catalog_changed` until a later
  snapshot delivers them, so truncation can never look like "nothing else exists".

## 4. `history`

Request: `botId`, optional `scope` (default `root`), optional `scopeAfter` to continue
scope enumeration, optional `before` (exclusive entry id), optional `limit` — and, when
`before` is present, `incarnation` and `newest` (the previous page's
`boundary.newestEntryId`), which make page continuity checkable. A `before` without
them is `422 query_invalid`, never a silently unpinned page.

```json
{
  "protocolVersion": 1,
  "kind": "history",
  "source": { "id": "8f2a1c0d9be4f7a1", "epoch": "6f1c2a90-1c1b-4a55-9a13-0d1e2f3a4b5c", "capturedAt": 1794000000000 },
  "botId": "b_3f1a",
  "incarnation": "9f31c0b4a7d20e55",
  "scope": { "id": "c_1", "kind": "root" },
  "scopes": [
    { "id": "c_1", "kind": "root", "entries": 23 },
    { "id": "c_12", "kind": "child", "owner": { "conversationId": "c_1", "taskId": "t_9" }, "entries": 5 }
  ],
  "scopesNext": null,
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
        { "type": "toolCall", "callId": "call_1", "name": "run_tests", "args": { "scope": "all" } }
      ]
    },
    {
      "entryId": "e_72",
      "commitSeq": 72,
      "role": "tool",
      "kind": "pi.tool-result",
      "state": "complete",
      "at": "2026-11-08T08:58:05.000Z",
      "blocks": [
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
  "omitted": { "entries": 2, "blocks": 1, "kinds": ["pi.system"] },
  "next": { "before": "e_70" },
  "coverage": { "scopes": "complete", "page": "complete", "content": "complete", "reasons": [] }
}
```

### Mapping (fixed)

| Stored kind | `role` | Blocks |
| --- | --- | --- |
| `pi.user` | `user` | `text` |
| `pi.assistant` | `assistant` | `text`, `toolCall`; reasoning/thinking never exposed |
| `pi.tool-result` | `tool` | `toolResult` (`callId,name,text,isError,durationMs?`) |
| `pi.compaction` | `notice` | `notice` |
| `bots.reflection`, `bots.reflection.tool` | by the stored role | as stored |
| anything else | not a message | counted in `omitted.kinds`, and makes `coverage.content` `partial` with `unsupported_kind` |

### Rules

- `scopes` enumerates every retained scope of the Bot in stable id order. With more
  than 500 scopes the response sets `scopesNext: {afterScopeId}` and
  `coverage.scopes: "truncated"`; the caller continues with `scopeAfter`, so no scope
  can become unreachable.
- A child scope returns its own rows only; `owner` names the fork
  (`conversationId` from `owner_conversation_id`, `taskId` from `owner_task_id`).
- `boundary.newestEntryId` is fixed at capture and echoed as `before` when requested.
  Compaction boundaries appear in `boundary.compactions` as `{entryId, head}`, `head`
  being the retained entry the compacted window starts at.
- Continuation is `next.before`: the oldest entry id of this page, exclusive. There is
  no opaque history cursor, so a page can neither be re-served nor skipped.
- Page stability: the response carries `incarnation` and `boundary.newestEntryId`, and a
  continuation echoes both. If the store's incarnation differs from the echoed one, or its
  current newest entry id is older than the echoed `newest`, the page answers
  `409 stale_page` and the caller restarts from the newest page. New commits never
  invalidate a page: the boundary is pinned by `newest`.
- Delivery trim: a single message whose encoded form exceeds 64 KiB is returned
  trimmed with `"trimmed": true` and still advances the page (`next.before` is its own
  entry id). Tool rows are already bounded at write time by the daemon, which keeps
  its `[tool output truncated]` marker; the delivery trim only protects the page
  budget.
- `omitted` has two counters and one closed set. `omitted.entries` counts entries the
  contract deliberately does not map — only the known-hidden kinds are allowed there:
  `pi.system` (prompts) and internal reasoning entries. `omitted.blocks` counts blocks
  dropped inside mapped messages, which is how filtered reasoning inside an assistant
  message is reported. Both are by design and never make coverage incomplete. Any other
  kind is **not** a known-hidden kind: it is counted in `omitted.kinds` and forces
  `coverage.content: "partial"` with `unsupported_kind`. `coverage.content` reports
  whether every mapped message was delivered untrimmed and every entry was mappable.
- `coverage.scopes`: `complete` iff every scope was enumerated. `coverage.page`:
  `complete` iff the page was not cut by the response budget. `coverage.content`:
  `complete` iff no delivered message was trimmed. `reasons` is drawn from
  `scopes_truncated`, `page_limit`, `unsupported_kind`, `scope_unavailable`,
  `entry_trimmed`.
- An unknown `botId` is `404 unknown_bot`; a foreign or unknown `scope` is
  `404 unknown_scope`. An unreadable store answers `503 provider_unavailable` with the
  store state, never an empty page. An empty conversation is a valid
  `messages: []` with `coverage.page: "complete"`.

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

- Kinds: `history_appended` (entry-id range in one scope), `storage_replaced`,
  `store_state_changed`, `activity_changed`, `catalog_changed` (the consumer must
  re-read `snapshot`).
- There are no per-message events and no event identity derived from `commit_seq`: one
  commit can write several entries, and tasks/submissions are updated in place. A range
  plus incarnation is stable and replayable.
- Identity is a comparison against the baseline, not an event log. Within one response
  a change is unique by `(kind, botId, scopeId, to)`; across responses, the same
  baseline produces the same response, and a consumer that has committed a new baseline
  cannot see the transition again. A state or activity that returns to a previous value
  is reported against the baseline it actually had, so
  `available → session_missing → available` is observed as two changes by a consumer
  that advances between them.
- Comparing state needs the baseline to carry the previous state and activity, which it
  does (section 7).
- When `coverage.complete` is false with `page_limit`, `next` advances **only** the Bots
  whose changes were fully delivered in this page; the rest are re-reported next time.
- `next` is always present. `coverage.complete: false` with `page_limit` means the page
  was cut; the consumer reads again before treating `next` as current.
- No worker progress waits on this read and no acknowledgement endpoint exists.

## 6. Errors

Provider error bodies:

```json
{ "protocolVersion": 1, "error": { "code": "cursor_reset", "detail": "the source epoch changed" } }
```

`provider_unavailable` adds a structured sibling, so the store state is never only
prose: `{ "error": {…}, "store": { "state": "session_missing" } }`.

| HTTP | `code` | Meaning |
| --- | --- | --- |
| 401 | `unauthenticated` | observation credential absent or wrong |
| 403 | `credential_kind` | a valid credential used on the wrong surface |
| 403 | `host_refused` / `origin_refused` | not the loopback endpoint that owns this root |
| 404 | `unknown_bot` / `unknown_scope` | requested identity does not exist |
| 409 | `cursor_invalid` | baseline malformed, or bound to another **source** or operation |
| 409 | `cursor_reset` | same source, but the epoch changed, a store was replaced or its generation regressed |
| 409 | `stale_page` | the store changed between history pages; restart from the newest page |
| 413 | `body_refused` | a body on a `GET` route, or a `changes` body over 8 KiB |
| 422 | `limit_invalid` / `query_invalid` | limit out of range, unknown parameter |
| 503 | `provider_unavailable` / `shutting_down` | the store cannot be read now, or closing |

`limit` defaults: `history` 50 (1–200), `changes` 100 (1–500). An omitted limit uses
the default; `limit_invalid` means a value outside that operation's range, and its
`detail` names the range. `provider_unavailable` carries the Bot's store state.
`detail` is a fixed, secret-free explanation; no stack, path, Bot content, token or
provider text ever appears. The only structured facts carried beside an error are the
`store` state above and, on the consumer side, `provider.detail` as a code.

## 7. Baseline (the only cursor)

Opaque to callers: `base64url(JSON({v:1,k,s,e,c,p}))`.

| Field | Meaning |
| --- | --- |
| `v` | version, `1` |
| `k` | operation, `changes` |
| `s`, `e` | source id and epoch |
| `c` | catalog revision |
| `p` | map `botId → {i,g,s,a}` |

Per-Bot position: `i` incarnation, `g` generation `{min,max,count}`, `s` store state,
`a` activity. A Bot whose store is not readable at capture is absent from `p` and is
reported by `store_state_changed` until it is readable.

Decoding is strict. A malformed baseline, an unknown field set, a wrong operation or a
wrong **source** is `cursor_invalid`. With the right source, a changed epoch, a changed
incarnation or a regressed generation is `cursor_reset` — the baseline was correct but
its world is gone. There is no best-effort continuation. The baseline is
sent in the `changes` body, bounded by the 64 KiB body budget; a full 200-Bot fleet with
UUID identities must fit inside it — an acceptance case, not an assumption.

## 8. Limits

| Limit | Value |
| --- | --- |
| Snapshot bots | 200 per response, `truncated` beyond |
| History messages per page | default 50, max 200 |
| History scopes per enumeration | 500, `scopesNext` beyond |
| Single delivered message | 64 KiB, trimmed and flagged beyond |
| Change entries per page | default 100, max 500 |
| Provider response body | **192 KiB** per response; a cut page reports `page_limit` |
| Consumer frame | the SG-001 socket cap of **256 KiB** covers the whole `result` frame (value + envelope + provider block), so the provider budget above is chosen to fit |
| `changes` request body | 64 KiB (a 200-Bot baseline must fit) |
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
when the pinned `@earendil-works/pi-durable` schema version or table set changes.

## 10. Consumer (Superagent)

Three commands on the existing authenticated socket `/v1/chat`:

| Command | Fields | Result value |
| --- | --- | --- |
| `observe-snapshot` | `type,id` | `{provider, snapshot}` |
| `observe-history` | `type,id,botId,scope?,scopeAfter?,before?,limit?` | `{provider, history}` |
| `observe-changes` | `type,id,limit?` | `{provider, changes}` |

```json
"provider": {
  "reachable": true,
  "state": "ready",
  "source": { "id": "8f2a1c0d9be4f7a1", "epoch": "6f1c2a90-1c1b-4a55-9a13-0d1e2f3a4b5c", "capturedAt": 1794000000000 },
  "lastReadAt": "2026-11-08T09:00:02.000Z",
  "unavailable": 0
}
```

- `state` ∈ `ready`, `refused`, `unreachable`, `reset`, `unconfigured`, `internal`;
  `unavailable` counts Bots the last snapshot could not read; `detail` carries a provider
  error **code** when `internal` is used, never provider text; `subject` carries the
  Bot/scope a failure refers to.
- **Provider failures are values, not socket errors.** Every `observe-*` command
  answers `{type:"result",id,value:{provider}}` with `snapshot`/`history`/`changes`
  omitted or `null`; the socket error frame is reserved for protocol violations
  (`invalid_command`, `shutting_down`). This keeps one failure channel and never
  forwards provider text.
- Provider code mapping, one row per provider code, no provider text ever forwarded:

  | Provider code | `provider.state` | Extra |
  | --- | --- | --- |
  | `unauthenticated`, `credential_kind` | `refused` | — |
  | `cursor_invalid`, `cursor_reset`, `stale_page` | `reset` | stale baseline dropped |
  | `unknown_bot`, `unknown_scope` | `internal` | `provider.detail` is the code, `provider.subject` names the Bot/scope |
  | `host_refused`, `origin_refused`, connection failure | `unreachable` | — |
  | `body_refused`, `limit_invalid`, `query_invalid` | `internal` | `provider.detail` is the code |
  | `shutting_down` | `unreachable` | a value, never a socket error |
  | `provider_unavailable` | `ready` | `provider.unavailable` increments; the Bot's store state comes from the snapshot it already served |
- `observe-changes` takes no baseline from the client: the consumer sends its stored
  baseline and commits the new one with the consumed observation in its own store.
- A provider `cursor_reset` surfaces as `state: "reset"`; the consumer drops the stale
  baseline and re-reads `snapshot` before serving further changes.
- The consumer never falls back to daemon files and never blocks or closes chat.

### CLI

```text
eagle-dev superagent observe status [--json]
eagle-dev superagent observe snapshot [--json]
eagle-dev superagent observe history --bot ID [--scope ID|root] [--scope-after ID] [--before e_n] [--limit N] [--json]
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
| `snapshot.server.json` | available (schema 2), missing, unsupported (schema 1) stores |
| `history.server.json` | root page: compaction boundary, child scope, tool row, `next` |
| `history-empty.server.json` | readable store with no entries: `messages: []`, complete page |
| `history-oldest.server.json` | oldest page: no `next` |
| `history-truncated.server.json` | page cut by the budget: `coverage.page: "truncated"` |
| `history-trimmed.server.json` | one message over 64 KiB: `trimmed`, still advancing |
| `changes.server.json` | range, replacement, state, activity and catalog changes with a duplicate |
| `error.server.json` | every code with its status |
| `cursor.json` | baseline, its binding, and the expected rejection per misuse |
| `observe-result.json` | consumer result values for success, `reset` and `refused` |

Both languages decode these bytes; a missing required field is an error, an unknown
field is dropped on encode and tolerated on decode. A wire change lands with its
fixture and both conformance tests in the same commit.
