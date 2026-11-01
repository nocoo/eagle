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
| `server` | `src/server` | Daemon startup configuration: the development agent token |
| `protocol` | `src/protocol` | Encode/decode, version, limits, command validation |
| `core` | `src/core` | Catalog, lifecycle, hub ordering, paging, command routing |
| `runtime` | `src/runtime/pi` | Adapter calls, event mapping, failure classification |
| `pi` | third-party callbacks | `onReport`, `harness.closed`, watch end |

Client-side layers use the same vocabulary: `client.ui`, `client.vm`,
`client.transport` (`os.Logger`, subsystem `ai.hexly.bots`).

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
skip | reject | end | classify | unsafe`. Names are constants in
`src/log/events.ts`. Every `start` has a declared `ok`/`fail` partner
(`core.singleton.start` → `core.singleton.ok|fail`), and no free-form event name
exists. From stage 4 a test asserts bidirectional equality between constants and
uses; before that it asserts `used ⊆ declared`.

| layer | events |
| --- | --- |
| transport | `transport.devtoken.ok`, `transport.devtoken.unsafe` — the development agent token's file, read once at startup: `ok` when it is a usable credential, `unsafe` when it is not, `transport.conn.open.ok`, `transport.conn.open.reject`, `transport.conn.close.ok`, `transport.conn.close.end`, `transport.auth.fail`, `transport.frame.recv.ok`, `transport.frame.send.ok`, `transport.frame.send.drop` — a frame that cannot be decoded is `protocol.*`, not a second transport record |
| protocol | `protocol.decode.fail`, `protocol.encode.fail`, `protocol.limit.fail`, `protocol.version.fail`, `protocol.command.start`, `protocol.command.ok`, `protocol.command.fail` — `ok` means decoded, validated and dispatched (not "succeeded"); `fail` is a propagated refusal after dispatch, or the origin record when no layer below classified the failure |
| core | `core.catalog.load.ok`, `core.catalog.load.fail`, `core.catalog.write.ok`, `core.catalog.write.fail`, `core.bot.resolve.fail`, `core.bot.open.start`, `core.bot.open.ok`, `core.bot.open.fail`, `core.bot.close.ok`, `core.bot.close.fail`, `core.bot.close.degrade` (quarantine), `core.subscribe.start`, `core.subscribe.ok`, `core.subscribe.fail`, `core.submit.start`, `core.submit.ok`, `core.submit.fail`, `core.history.start`, `core.history.ok`, `core.history.fail`, `core.hub.publish.ok`, `core.hub.coalesce.ok`, `core.hub.snapshot.ok`, `core.hub.degrade`, `core.singleton.start`, `core.singleton.ok`, `core.singleton.fail`, `core.origin.replay.degrade` (an unreadable origin record line), `core.recovery.start`, `core.recovery.bot.ok`, `core.recovery.bot.fail`, `core.recovery.ok`, `core.delete.start`, `core.delete.ok`, `core.delete.fail`, `core.reconcile.ok`, `core.group.write.ok` |
| runtime | `runtime.device.start`, `runtime.device.ok`, `runtime.device.fail`, `runtime.open.start`, `runtime.open.ok`, `runtime.open.fail`, `runtime.subscribe.start`, `runtime.subscribe.ok`, `runtime.subscribe.fail`, `runtime.submit.start`, `runtime.submit.ok`, `runtime.submit.fail`, `runtime.abort.start`, `runtime.abort.ok`, `runtime.abort.fail`, `runtime.recover.start`, `runtime.task.retry.ok`, `runtime.task.abort.ok`, `runtime.recover.ok`, `runtime.recover.fail`, `runtime.tools.refresh.ok`, `runtime.tools.refresh.fail`, `runtime.close.start`, `runtime.close.ok`, `runtime.close.fail`, `runtime.watch.end.ok`, `runtime.failure.classify` |
| pi | `pi.report`, `pi.session.closed` |

`*.start` pairs with exactly one `*.ok|fail` per layer reached. A layer that is
not reached emits nothing for that trace — that absence is evidence.

### The development agent token events

Both events are emitted once, at startup, on the `transport` layer, with the daemon's
startup trace (`tr_boot_<n>`). They report the state of the file
`BOTS_DEV_AGENT_TOKEN` names ([PROTOCOL.md](PROTOCOL.md) "CLI clients and scopes");
neither carries the token.

| Event | Level | `detail` |
| --- | --- | --- |
| `transport.devtoken.ok` | `info` | `path` — the configured file, shortened to `~` under the home directory |
| `transport.devtoken.unsafe` | `warn` | `path`, `reason` — `reason` is `invalid`: the mode is not `0600`, the content is shorter than 32 characters after trimming, or the file cannot be read |

The file is read again on every authentication, so a record at startup describes the
start, not the current state: a file fixed later is accepted, and a file broken later
is refused, without a second event.

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
