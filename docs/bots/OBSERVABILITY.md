# Bots — observability contract

Status: **phase 1 contract**. Logging is a layer-crossing concern with its own
tests, not something added while debugging. Structure is in
[ARCHITECTURE.md](ARCHITECTURE.md); this file says what every layer emits so a
user-visible failure is attributable to exactly one layer from logs alone.

## Why this exists

The requirement is diagnostic, not archival: when the app stops answering, one
lookup must say whether the frame never arrived, the bot was never resolved, the
runtime never acknowledged, or pi-durable failed.

Three rules make that possible, and each is tested:

1. every layer names itself in every record;
2. every crossing carries one `trace`, created once and never regenerated;
3. exactly one layer — the originating one — logs the failure at `error`; layers
   above record a propagated outcome at `warn` and do not repeat the message.

## Layer names

| `layer` | Code | Emits |
| --- | --- | --- |
| `transport` | `src/server` | Connections, auth, frame I/O, close codes |
| `protocol` | `src/protocol` | Encode/decode, version, limits, command validation |
| `core` | `src/core` | Catalog, lifecycle, hub ordering, paging, command routing |
| `runtime` | `src/runtime/pi` | Adapter calls, event mapping, failure classification |
| `pi` | third-party callbacks | `onReport`, `harness.closed`, watch end |

Client-side layers use the same vocabulary: `client.ui`, `client.vm`,
`client.transport` (`os.Logger`, subsystem `ai.hexly.bots`).

The independent encrypted-cache Worker/DO uses `runtime.sync.fail` as the sole
error origin for its refusal. Worker forwarding retains the bounded incoming
trace/Bot context; returned failure ID/kind/layer is propagated by Bots as the
existing ClassifiedFailure at warn, without a second error origin. R2 I/O/corrupt
storage and Cache DO SQL reads are storage_failed, Registry RPC transport/internal
SQL faults are internal, and protocol/crypto/
authorization refusal is auth_failed. Original causes stay local; logs/wire never
include authority, descriptor, cipher, plaintext or raw upstream error text.
Header context must match the existing bounded trace/Bot grammar. Local metadata
port denials retain their original cause and auth_failed origin.

Automatic turns originate `tr_auto_<uuid-without-hyphens>` and use the same Bot,
failure ID and origin propagation through existing sync crossings. Actual fetch
or body I/O keeps its transport cause; active abort and remote bounded refusals
are distinct. A preference storage failure has one runtime.sync.fail origin;
initial read failures use tr_sync_preferences before any Bot is selected, and
management exposes that retained failure rather than logging another origin.
Only sync is paused; the original preference file is preserved and native work
retains its lifecycle. No preference bytes or unbounded error text enter logs.
The controller's own saved/current complete-binding refusal emits one
runtime.sync.fail origin at that comparison, with the same automatic trace and
Bot. A pending local apply retry retains the original lower-layer failure/cause;
the turn catch neither remints nor logs a second error origin.

## Trace ownership

| Originator | Trace shape | Example |
| --- | --- | --- |
| Client command (`send`, `abort`, `recover`, `resync`, `history`, `ping`) | created by the client: `tr_<uuidv7>` | `tr_0190a1…` |
| Connection episode | created by the daemon on accept: `tr_conn_<n>` | `tr_conn_7` |
| Startup recovery and idle close | created by the daemon: `tr_boot_<n>` | `tr_boot_3` |
| HTTP catalog request | created by the daemon: `tr_http_<n>`, since HTTP carries no trace field | `tr_http_4` |
| Run progress caused by an admitted input | the trace **stored with that submission** at `send` time | the original `send` trace |

Rules:

1. The client puts `trace` in the command frame ([PROTOCOL.md](PROTOCOL.md)); the
   daemon echoes it on every event it causes.
2. A daemon-originated event (progress of a run whose `send` is long finished, a
   recovery scan) uses the stored submission trace or a `tr_boot_*`/`tr_conn_*`
   id. A run started by several queued inputs uses the first input's trace.
3. Downstream calls inherit the trace; a layer never mints a new one. The only
   exception is the connection trace, which is used until a command arrives.
4. Client logs use the same `trace` string, so Console.app and the daemon JSONL
   join on one value. The app's "Copy diagnostics" surfaces it.
5. `ping`/`pong` are liveness only and carry no trace; their records use the
   connection trace. Phase 1 installs no pi telemetry, so a trace cannot be carried
   into pi-durable or recovered from its storage: a run resumed after a restart is
   attributed to a fresh `tr_boot_<n>`.

## Event names

`<layer>.<subject>.<outcome>`, outcome ∈ `start | ok | fail | drop | degrade |
skip | reject | end | classify`. Names are constants in `src/log/events.ts`. Every
`start` has a declared `ok`/`fail` partner (`core.singleton.start` →
`core.singleton.ok|fail`), and no free-form event name exists. From stage 4 a test
asserts bidirectional equality between constants and uses; before that it asserts
`used ⊆ declared`.

| layer | events |
| --- | --- |
| transport | `transport.conn.open.ok`, `transport.conn.open.reject`, `transport.conn.close.ok`, `transport.conn.close.end`, `transport.auth.fail`, `transport.frame.recv.ok`, `transport.frame.send.ok`, `transport.frame.send.drop` — a frame that cannot be decoded is `protocol.*`, not a second transport record |
| protocol | `protocol.decode.fail`, `protocol.encode.fail`, `protocol.limit.fail`, `protocol.version.fail`, `protocol.command.start`, `protocol.command.ok`, `protocol.command.fail` — `ok` means decoded, validated and dispatched (not "succeeded"); `fail` is a propagated refusal after dispatch, or the origin record when no layer below classified the failure |
| core | `core.sync.start`, `core.sync.ok`, `core.sync.fail`, `core.replica.start`, `core.replica.ok`, `core.replica.fail`, `core.catalog.load.ok`, `core.catalog.load.fail`, `core.catalog.write.ok`, `core.catalog.write.fail`, `core.bot.resolve.fail`, `core.bot.open.start`, `core.bot.open.ok`, `core.bot.open.fail`, `core.bot.close.ok`, `core.bot.close.fail`, `core.bot.close.degrade` (quarantine), `core.subscribe.start`, `core.subscribe.ok`, `core.subscribe.fail`, `core.submit.start`, `core.submit.ok`, `core.submit.fail`, `core.history.start`, `core.history.ok`, `core.history.fail`, `core.hub.publish.ok`, `core.hub.coalesce.ok`, `core.hub.snapshot.ok`, `core.hub.degrade`, `core.singleton.start`, `core.singleton.ok`, `core.singleton.fail`, `core.origin.replay.degrade` (an unreadable origin record line), `core.recovery.start`, `core.recovery.bot.ok`, `core.recovery.bot.fail`, `core.recovery.ok`, `core.delete.start`, `core.delete.ok`, `core.delete.fail`, `core.reconcile.ok`, `core.group.write.ok` |
| runtime | `runtime.sync.start`, `runtime.sync.ok`, `runtime.sync.fail`, `runtime.replica.start`, `runtime.replica.ok`, `runtime.replica.fail`, `runtime.device.start`, `runtime.device.ok`, `runtime.device.fail`, `runtime.open.start`, `runtime.open.ok`, `runtime.open.fail`, `runtime.subscribe.start`, `runtime.subscribe.ok`, `runtime.subscribe.fail`, `runtime.submit.start`, `runtime.submit.ok`, `runtime.submit.fail`, `runtime.abort.start`, `runtime.abort.ok`, `runtime.abort.fail`, `runtime.recover.start`, `runtime.task.retry.ok`, `runtime.task.retry.fail`, `runtime.task.abort.ok`, `runtime.recover.ok`, `runtime.recover.fail`, `runtime.tools.refresh.ok`, `runtime.tools.refresh.fail`, `runtime.close.start`, `runtime.close.ok`, `runtime.close.fail`, `runtime.watch.end.ok`, `runtime.failure.classify` |
| pi | `pi.report`, `pi.session.closed` |

`*.start` pairs with exactly one `*.ok|fail` per layer reached. A layer that is
not reached emits nothing for that trace — that absence is evidence.

## Record shape

One JSON object per line: `<root>/logs/daemon-YYYYMMDD.jsonl`, rotated at 10 MB,
five files kept.

```json
{"ts":"2026-10-25T02:11:03.412Z","level":"info","layer":"core","evt":"core.submit.ok",
 "trace":"tr_0190a1b2","botId":"b_0190a1b0","connId":"c_7","reqId":"r_0190a1b3",
 "rev":44,"durMs":3,"detail":{"queued":false,"count":1}}
```

| Field | Presence | Meaning |
| --- | --- | --- |
| `ts` | always | ISO-8601 UTC, milliseconds |
| `level` | always | `trace` / `debug` / `info` / `warn` / `error` |
| `layer` | always | See above |
| `evt` | always | One declared name |
| `trace` | always | Per the ownership table |
| `botId` | when a bot is involved | Bot id |
| `connId` | transport and everything below one connection; absent for a port invocation, which has no connection ([TRIGGERS.md](TRIGGERS.md) §3) | Connection id |
| `reqId` | commands carrying a `requestId` | Client request id |
| `rev` | hub publishes | Assigned revision |
| `durMs` | `*.ok` / `*.fail` with a paired start | Layer's own work |
| `err` | `*.fail`, `*.degrade`, `*.reject`, `runtime.failure.classify` | `{ "kind": ErrorKind, "failure": "f_…" }`, plus `origin: true` only on the originating record |
| `detail` | optional | Whitelisted ids, counts, enums, byte lengths |

`ErrorKind` is the closed union shared with the protocol:
`auth_failed | unknown_bot | invalid_command | limit_exceeded | version_mismatch |
model_error | session_failed | task_faulted | task_parked | extension_error |
storage_failed | internal`.

## Failure recording: origin versus propagation

```
runtime.submit.fail   level=error  err={kind:"storage_failed", failure:"f_7", origin:true}
core.submit.fail      level=warn   err={kind:"storage_failed", failure:"f_7"}  detail.propagated=true
```

`protocol.command.ok` means decoded, validated and dispatched — not "succeeded". A
failure *after* dispatch is reported by the layer that owns it at `error`, and the
wire layer above it records `protocol.command.fail` at `warn` with
`detail.propagated=true`, the same failure id and the close code it chose. A failure
no layer classified (a daemon defect) is attributed to the protocol layer, which is
where it crossed the wire, and is the only case where `protocol.command.fail` is the
originating record.

- Page frames are bounded by count *and* encoded bytes before they are written, so a
  page of legal 70 KiB messages never becomes a frame the transport has to drop.
- A subscriber whose transport has more than 1 MiB unsent is treated exactly like one
  that fell behind: it is downgraded to snapshot-only, and the newest snapshot is its
  recovery.
- The failure identity `err.failure` is minted exactly once, by the classifier of a
  **failure episode** ([RUNTIME.md](RUNTIME.md#failure-channels)). It is the dedupe
  unit: **exactly one `level=error` record per `failure` id**, on the layer where it
  originated.
- Layers above log `warn` with the same `err.kind` and `err.failure`, plus
  `detail.propagated=true`, never the message text and never `error`.
- A trace is long-lived (a connection serves many commands); a failure is not, so
  deduping on `failure` rather than on `trace` is what makes "one error" exact.
- A trace that is not a legal `trace` value is user text: the record names the
  connection instead, so an invalid trace can never reach the log.
- Retryable trouble that the layer handles internally (one watch reattach) logs
  `runtime.watch.end.ok` at `warn` and mints no failure id. Three within 60 s mint
  one `internal` failure.

## Redaction

Two different rules, previously conflated:

One carrier list, used by both the protocol and the redaction test:

| Carrier | Wire | Logs |
| --- | --- | --- |
| `send.text` | Allowed | Forbidden |
| `Message.blocks` and the message inside a `delta` `message` change | Allowed | Forbidden |
| `delta.changes[].append`, `delta.changes[].block` | Allowed | Forbidden |
| `history.messages` | Allowed | Forbidden |
| `BotSummary.title` (user-authored) | Allowed | Forbidden |
| `BotSummary.label` (user-authored) | Allowed | Forbidden |
| `agent.instructions` (capability `agent` only) | Allowed | Forbidden |
| `notice` text | Allowed | Forbidden |
| Anything else | Forbidden | Forbidden |

Paths under the user's home are shortened to `~` in logs. A redaction test asserts a
legal title survives on the wire and never appears in a log record.

Specifics:

- Provider and upstream error text is **not logged verbatim**; it may echo user
  content. The adapter maps it to `err.kind` plus `detail.providerCode` (a short
  token when upstream supplies one) and a fixed `safeMessage`. A test injects a
  provider error that echoes the prompt and asserts the prompt never appears in
  the log.
- The daemon token, `BOTS_API_KEY`, and any `sk-`-shaped value are scrubbed from
  every field including `err` and `detail`.
- `detail` keys are whitelisted per event; an undeclared key fails the shape test.

## Levels

| Level | Contents |
| --- | --- |
| `trace` | Frame-level encode/decode; off by default (`--log-level=trace`). Records at this level use the same schema and only `protocol.*`/`transport.frame.*` names |
| `error` | Originating failures only (`err.origin: true`), one record per failure episode |
| `warn` | Propagated failures, `core.hub.degrade`, `core.bot.close.degrade` (quarantine), drops |
| `info` (default) | Crossings: connection, subscribe, submit, publish counters, recovery, delete |
| `debug` | Coalescing details, snapshot rerenders, paging, per-command byte sizes |
Coalesced deltas log `detail.count`, never contents. Recipes below state the
level they require; `--log-level=debug` is the support default when collecting
evidence.

## Diagnosis recipes

Each recipe injects exactly one fault, waits on an explicit barrier, and asserts
presence *and* absence. The tests use a fake clock and a drain barrier
(`await hub.drain()` / `await log.flush()`) rather than sleeps, so a missing
event is a fact, not a race.

**R1 — a bot cannot be opened.** Two variants, one per owning layer.

Runtime variant: inject an unopenable session store (the bot's `session.sqlite` is a
directory) before the daemon starts. The runtime owns the open, so it is the origin:

```
runtime.open.start         trace=tr_boot_1
runtime.open.fail          trace=tr_boot_1 err={kind:"storage_failed", failure:"f_7", origin:true}
core.bot.open.fail         trace=tr_boot_1 err={kind:"storage_failed", failure:"f_7"} detail.propagated
core.recovery.bot.fail     trace=tr_boot_1 err={kind:"storage_failed", failure:"f_7"} detail.propagated
```
Asserted: exactly one `level=error` for that bot, on `runtime`, with `origin:true`;
every other record carries the same `f_7` and `propagated`, never `origin`; the
client still gets a `snapshot` whose `unavailable.reason` is `storage_failed`.

Core variant: subscribe to an unknown bot id, which never reaches the runtime:

```
protocol.command.ok        trace=tr_A               # dispatched to core
core.bot.resolve.fail      trace=tr_A err={kind:"unknown_bot", failure:"f_8", origin:true}
protocol.command.fail      trace=tr_A err={kind:"unknown_bot", failure:"f_8"} propagated
```
Asserted: exactly one `level=error`, on `core`; no `runtime.*` record at all; the
socket closes `4004`.

**R2 — the event stream dies mid-answer.**
Inject: the adapter's own sink callback throws once (a defect inside the runtime
layer), then reattach succeeds. The sink fault is only reachable at the adapter, so
this recipe's runtime half is asserted by `test/runtime/channels.test.ts`; the core
and transport records it names are covered by the hub and frame records R1 and R3
exercise.

```
core.hub.publish.ok        trace=tr_B rev=42 detail.kind=append
runtime.watch.end.ok       trace=tr_B level=warn detail.reason=listener_error
runtime.subscribe.ok       trace=tr_B detail.reattach=true
core.hub.snapshot.ok       trace=tr_B rev=43
transport.frame.send.ok    trace=tr_B detail.evt=snapshot
```
Asserted: exactly one `runtime.watch.end.ok`, one reattach, one snapshot rerender,
and no `level=error` (handled internally). A variant that fails three times in 60 s
asserts exactly one `internal` failure with `origin:true` on `runtime`, and one
`level=error` overall.

**R3 — the client sends something malformed.**
Inject: one frame with an unknown command type.

```
transport.frame.recv.ok    trace=tr_C
protocol.decode.fail       trace=tr_C err={kind:"invalid_command", origin:true}
protocol.command.fail      trace=tr_C propagated
```
Asserted: no `core.*` and no `runtime.*` for `tr_C`. Attribution: client/protocol.

**R4 — delete interrupted between the two steps.** This recipe runs in the crash
suite (`test/crash/delete.test.ts`), not in the deterministic log suite, because it
uses a real `SIGKILL`.
Inject: `SIGKILL` after `rename(bots/<id>, trash/<id>)` and before the catalog
write. A killed process cannot log its own failure, so only the pre-kill barrier and
the post-restart evidence are asserted.

```
core.delete.start          trace=tr_D botId=b1
# process killed; no further records for tr_D
core.reconcile.ok          trace=tr_boot_1 botId=b1 detail.finished="delete"
```
Asserted: `core.reconcile.ok` after restart, no `b1` in the catalog, `trash/b1`
present. Nothing is asserted about `core.delete.fail` for `tr_D`.

## Client logging

`BotsTransport` and `BotsFeatures` log through `os.Logger` with
`subsystem = "ai.hexly.bots"`, `category` equal to the layer name, and the same
field names. Each crossing logs `start` and one outcome; per-delta logging is
forbidden (a test asserts no emit inside the delta path).

## Tests that keep this honest

| Test | Asserts |
| --- | --- |
| `test/log/shape.test.ts` | Required fields; `err.kind` from the union; `detail` whitelist; declared-and-used event names |
| `test/log/origin.test.ts` | Exactly one `level=error` per `err.failure`, at the originating layer; higher layers log `warn` with `propagated`; the count is keyed on `err.failure`, not on `trace` |
| `test/log/trace.test.ts` | R1–R3 with fake clock and drain barrier, at `--log-level=debug`, asserting presence *and* absence |
| `test/log/redaction.test.ts` | Sentinel prompt, token, bot title and home path never appear in logs; provider error echo is scrubbed |
| `BotsFeaturesTests/LoggingTests.swift` | Client emit sites use the shared vocabulary; no per-delta emit |

Shared-device tool calls mint a stable `tr_device_<hash>` from Bot and native tool-call
identity at the external port boundary (pi does not carry the submission trace here).
The adapter logs one start and outcome, never operation arguments, output, pairing
codes or credentials. A refused/failed external receipt is one runtime extension
failure; its full operation receipt remains in the conversation, outside logs.

P0 history handoff logs `core.replica` and `runtime.replica` start/outcome with the
HTTP trace and local botId only. Bundle contents, prompts, resource bytes and provider
credentials are never log fields. The runtime alone logs an originating error; core
records propagation. See RUNTIME.md for passive-import and continuation boundaries.


P1 local bind/pull/apply/status reuse the `core.replica` / `runtime.replica` crossing
catalog and request trace. Background entry scans report through `runtime.replica.fail`
using the Bot-open trace, failure identity and botId only; a repeated failed scan episode
is logged once until a successful scan. An existing failed SDK session is propagation
(warn), not a newly minted error. Body text, entry data, model/tool inputs, resources and
page payloads never enter these logs. A blocked source's status records only sequence and
stable invalid_history code; durable receipt position still stays before the rejected fact.

Saved-history `receipts` inventory uses the same replica crossing trace and origin/error
classification; it adds no body-bearing log event. Its output is head/DocumentId metadata,
not an applied ACK. Storage read failures propagate instead of being logged as missing
history or silently returning an empty inventory.

Receipt enumeration raw I/O errors retain one runtime storage_failed identity. Public
close seals this instance without inventing a pi session_failed report (SDK reports
SessionEnd.closed); later command failures propagate at warn, including cleanup. Existing
SDK-guarded failures still use their original pi/runtime session episode. No raw error
message is logged. Invalid protocol/cursor reads and actual cancellation do not close a
healthy Session or claim a new SDK failed state.

Root tombstone commands reuse core.replica start/outcome without a local Bot ID or body.
A directory cleanup failure originates at core.delete.fail; the root command propagates
the same identity at warn. Startup records each failed Bot cleanup at core.delete.fail
with reason startup while reporting only successful moves in core.reconcile.ok. Root
catalog I/O remains core.catalog.load.fail and stops startup. A cached socket's refused
recover uses core.bot.resolve.fail and the original command trace, followed by the same
failure identity at protocol.command.fail warn. Shared IDs, paths and history stay out
of these records.


Fixed-head resource preflight uses existing runtime.replica.fail / runtime.open.fail
crossings. Invalid selected manifests are invalid_command + not_admitted; known install
I/O before pin/admission is storage_failed + not_admitted with the original I/O cause.
The runtime is the sole error origin, outer crossings retain that failure identity, and
resource text, bytes, full file paths and package bodies are never log details. Closing a
failed startup owner does not mint a second cleanup failure or claim SDK reason failed.

A warm task-retry resource preflight refusal records runtime.task.retry.fail at its sole
runtime error origin, with the HTTP command trace and Bot identity. Existing classified
validation failures retain their identity and cause; raw filesystem I/O becomes
storage_failed with its original cause. No package text, manifest or full local path is
logged. This boundary covers resource preflight only; the existing SDK task-retry behavior
is otherwise unchanged.

Ordinary root resource selection uses existing runtime.submit start/outcome and core/protocol
crossings with the original trace/Bot. Manifest/install refusal is not_admitted; pre-admission
filesystem I/O is storage_failed with its cause. Exactly one error origin is recorded and
outer layers propagate the same failure. Selector metadata, manifests, text and full local
package paths are absent from log details. An accepted same-ID lookup emits no new failure.

Ordinary admission's checked request-ID lookup validates the durable `whenBusy` binding
before the core stored-record shortcut. A conflict uses `runtime.submit.fail` once with
the incoming command trace/Bot/request and the original classified failure identity;
outer layers propagate it. Pure status lookup does not perform admission validation.

Raw SQLite failures while checking an admission retry binding use the existing submit
classifier/session episode and runtime.submit.fail, keeping the command trace/Bot and
original cause. The first occurrence owns the single error origin; a repeated episode
propagates the same failure ID at warn. Existing ClassifiedFailure identity/cause remain
intact. No raw SQLite message, table name, package text or local path is logged. This
boundary covers only the retry-binding read, not pure status or later SDK lookups.


Resource-only capture/import/apply keeps the existing runtime.replica start/outcome and
core.replica crossings; it adds no event or history/admission log. First ordinary input
uses the same runtime.submit failure boundary as history-backed resource selection.
Missing refs remain an unapplied gap, never a successful complete manifest. Integrity or
install refusal preserves the original classification/cause and sole error origin; logs
do not include ordered refs, manifest bodies, resource bytes or full installation paths.

P3 sync access uses the HTTP trace and Bot id across core and the private-device
adapter. `runtime.sync.fail` owns one failure for a refused/unavailable Registry
request or invalid metadata response; `core.sync.fail` propagates that same identity
at warn level. Binding/storage/tombstone refusals originate in core before or after
the remote await. Logs contain only bounded reason codes, never metadata bodies,
endpoints, tokens, private keys or local socket paths. The endpoint returns its
trace and failure id on classified failure. Authorization failure never becomes an
offline directory fallback. No SDK submission is made by this route.


P4 authenticated pull reuses runtime.sync.start/ok/fail for the actual exchange and private
metadata calls, and core.sync.fail for ready-only/binding refusals. Each request carries the
same trace across the dedicated HTTP handshake/page route; an innermost ClassifiedFailure
keeps its failure identity through remote response and local HTTP propagation. Outer layers
record propagation, not a second error origin. Local ready-binding I/O is storage_failed;
missing directional authorization is auth_failed and network-unreachable remains distinct.
Logs carry no proof payload/signature, keys, plaintext pages/resources, tokens or local socket
paths. Listener bind failure uses listener_error/sync_bind_failed and does not prevent local
chat startup. Parent OSLog records publication/withdrawal unconfirmed without metadata bodies.
A quit reply/process exit is not proof of confirmed endpoint withdrawal; unknown stays unknown
on a late callback. Owned CLI/TCP fixtures establish protocol behavior, not physical connectivity.
Response-body stream I/O, including a truncated body after successful headers, retains
sync_network_unreachable/internal and the original nested I/O cause (local HTTP503); it does
not become auth_failed403. Size/JSON/crypto validation remains outside that I/O catch. Internal
use-point guard failures keep their original cause with one runtime auth_failed origin; they
are not storage failures. Remote failures accept the existing protocol FAILURE_ID grammar,
including adapter classifier identities; B retains the only error origin and A propagates the
same failure id as a warning with the shared trace and its own local Bot id.
Positive endpoint reconfirmation uses the current trusted Node session,
and a late Self reply after shutdown cannot claim renewed readiness/publication.


Durable object pull/apply use the existing runtime.sync start/ok/fail trace and original local Bot
context. Their four typed private crossings preserve the same trace; no cipher/page/key,signature
payload,pin body or private filesystem path is logged. File open/read/stage/file-fsync/link/dir-fsync
failures are classified at the object storage boundary as storage_failed, preserving the original
native cause and one error origin; outer crossings only warn with the same failure identity.
Complete malformed signature/digest/AEAD/protocol data remains auth_failed. Offline local apply
success does not certify peer delivery,cloud caching or model/tool execution. Network body I/O
and original direct-page failure propagation retain their previously delivered behavior.

## Online-holder relay attribution

Relay retains the existing runtime.sync start/ok/fail trace and actual local Bot.
A holder's strictly validated classified no-body failure propagates through Worker
and receiver with its original failure identity: the holder is the only error
origin. It does not go through a second successful-body final authorization that
could mint a different failure. Successful encrypted bodies always undergo final
current Registry authorization, expiry and holder-generation checks before supply.
Malformed holder failures are rejected at the owning Worker boundary.

Registry and owning relay-DO SQL exec/result-materialization faults retain the
original local cause and return503 (Registry RPC unavailable/internal; DO storage
failure), never directory gap/auth403. ACK and receipt promises are awaited inside
the owning DO catch. Logs/wire contain only bounded code/failure/trace/Bot, never
SQL text, raw error message, authority, descriptor, cipher, page or key. Outer
ClassifiedFailure crossings warn without creating another error origin. The local
owned fault assertions inspect cause directly; production logs do not expose it.

Relay delivery receipt means actual persistent apply progress for its complete
receiver/source key. It is distinct from cloudCached, stored, native completion
and all-path sender status. The latter remains unknown until its next slice.

All-path status-report/status-read reuse runtime.sync.fail and existing HTTP/private
metadata crossings with one trace and actual Bot. Their real DO SQL faults return
503/storage_failed with the original owned cause; Registry SQL uses its existing
RPC-unavailable/internal503 path. Worker is the sole error origin for its classified
failure and Bots propagates the same failure at warn. Local ready/configuration
refusals retain their owning failure. Logs/wire contain no SQL text, authority,
status body or raw error message.

The independent automatic metadata action may fail while direct/cache apply and
native work succeed. Unknown or the last authenticated exact-key/timestamped
snapshot remains visible; missing refresh is not a new confirmation. Received and
applied stay distinct during real materialization failure. Actual transport loss
after a Worker commit is retryable from persistent status, without body download,
apply/provider replay or a second failure origin. Complete malformed JSON remains
protocol/auth failure and is not labeled transport I/O.
