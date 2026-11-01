# Bots — test contract

Status: **phase 1 contract**. Tests are the specification of each layer and the
enforcement of the boundaries in [ARCHITECTURE.md](ARCHITECTURE.md). Runtime
behaviour under test is described in [RUNTIME.md](RUNTIME.md); log assertions in
[OBSERVABILITY.md](OBSERVABILITY.md).

The root `npm run check` and Linux CI job use only the root lock and top-level
`tests/*.test.ts`; they never require the independent Bots installation. Bots keeps
its own `npm ci` / `npm run check` and is not a root workspace member.

App/device integration lives in `tests/device-integration/` and runs explicitly as
`npm run test:devices` from the root, after root `npm ci`, independent
`npm --prefix apps/bots ci`, and `npm --workspace @nocoo/eagle-agent run build`.
Those tests cross real process/HTTP/socket ports; Bots product code never imports
Eagle, Agent or Worker sources. Missing dependencies fail this explicit suite.
The macOS CI job prepares these two independent installs, runs the integration
suite, and retains its Swift build/format/coverage gates. Local candidate acceptance
also runs the Bots and Bots-macOS gates; no default root test silently opts into
cross-product tests. Process tests are not evidence of physical multi-Mac operation
or distribution signing.

## The loop

For every behaviour change:

1. Update the owning document first when a contract, semantic or log event changes.
2. Write the test that demonstrates the behaviour. Run it. Record the failure in
   the commit body as a `Red:` line.
3. Write the smallest implementation that passes.
4. Run the layer tests, then the stage gate.
5. Commit once: documents + the test that failed first + implementation. `main`
   never holds a red commit.

```
Red: <test name> — <the failure it produced>
Tests: <files or names>
Checks: cd apps/bots && npm run check
```

## What may be faked

| Real, never faked | Faked | Why the boundary is there |
| --- | --- | --- |
| Protocol encode/decode against fixtures | — | A codec that only round-trips its own bug proves nothing |
| `BotDirectory` writes (real temp dir) | — | Atomicity is a filesystem property |
| `EventHub` ordering, coalescing, paging | — | Pure in-memory async |
| SQLite storage and `Harness.open` | — | `test/runtime/**` uses real `openNodeSqliteStorage` in a temp dir |
| HTTP and WebSocket transport (real `node:http`, ephemeral port) | — | Auth, close codes and paging only exist on a socket |
| pi-durable itself | Model provider only | `fauxProvider()` replaces the network, not the runtime |
| Swift `ConversationSocket` framing | — | It connects to the same fixture server the daemon tests use |
| — | `RuntimePort` in core tests | `testing/FakeRuntime.ts` replays scripted `RuntimeEvent`s |
| — | Clock, timers | Coalescing, idle close, quarantine retry |
| — | `CatalogPort` / `ConversationPort` in VM tests | Domain fakes; no sockets |
| — | `URLProtocol` for **HTTP only** | It cannot intercept `URLSessionWebSocketTask`; a WebSocket fake must be a real local server |

## Driving acceptance through the CLI

The `eagle-dev` CLI is the supported external surface of the daemon, so an end-to-end
check is a real command against a real daemon rather than a hand-written HTTP or
WebSocket script. One CLI call exercises the wire format, the credential and its
scope, the exit code and the daemon behind it together.

- The development daemon accepts a credential an agent mints itself at
  `~/.config/eagle-dev/token` (`docs/bots/CLI.md`), so an acceptance run needs no
  person turning a switch. A bundled build never accepts that file.
- Acceptance cases live in `tests/eval` and drive their steps through the CLI
  (`tests/eval/README.md`). `npm --prefix apps/bots run eval` builds the CLI and runs
  every case; `eval:cli` runs only the `cli-*` ones. Both stay outside `npm run check`
  because they boot a process and run real tools.
- This never replaces a deterministic test: a scope, a refusal or a wire rule still
  needs its assertion in `apps/bots/test`, and a CLI acceptance case is evidence the
  assembled product still does the thing, not a substitute for the gate.

## Test ladder

Each row is one commit-sized step; the `Needs` column is the precondition. A step
is never started before its preconditions are green.

### Stage 1 — wire and project skeleton

| # | File | First failing test | Needs |
| --- | --- | --- | --- |
| 1 | `test/protocol/fixtures.test.ts` | `decodes every committed fixture without loss` | package, tsconfig, `fixtures:check` harness |
| 2 | `test/protocol/events.test.ts` | `encodes a snapshot byte-identically to its fixture` | 1 |
| 3 | `test/protocol/commands.test.ts` | `rejects a send without a requestId or trace` | 1 |
| 4 | `test/protocol/limits.test.ts` | `rejects text longer than 8000 characters and frames over 256 KiB` | 1 |
| 5 | `test/protocol/versioning.test.ts` | `ignores an unknown event type but consumes its rev` | 1 |
| 6 | `test/log/shape.test.ts` | `every event name a source file uses is declared` (subset only; equality is asserted from stage 4 by `catalog.test.ts`) | log module |
| 7 | `test/log/redaction.test.ts` | `a provider error echoing the prompt never reaches the log` | log module |
| 8 | `test/architecture.test.ts` | `core imports nothing from protocol or pi-durable` | 1, 6 |

### Stage 2 — domain, catalog and lifecycle primitives

| # | File | First failing test | Needs |
| --- | --- | --- | --- |
| 9 | `test/core/directory.test.ts` | `keeps the previous catalog when a write is interrupted` | 8 |
| 10 | `test/core/directory.test.ts` | `delete reconciliation finishes an interrupted delete` | 9 |
| 11 | `test/core/runtimeport.test.ts` | `the fake runtime satisfies the port contract` | 8 |
| 12 | `test/core/hub.test.ts` | `assigns strictly increasing revisions per bot` | 11 |
| 13 | `test/core/hub.test.ts` | `delivers the same sequence to every subscriber and drops none` | 12 |
| 14 | `test/core/hub.test.ts` | `downgrades a subscriber that falls behind to snapshot-only` | 12 |
| 15 | `test/core/hub.test.ts` | `coalesces deltas inside one 50ms window with a fake clock` | 12 |
| 16 | `test/core/hub.test.ts` | `renders a fresh snapshot when the runtime reports one` | 12 |
| 17 | `test/core/service.test.ts` | `send requires a subscription and answers a connection-scoped record` | 13 |
| 18 | `test/core/service.test.ts` | `a repeated send with the same requestId returns the stored record` | 17 |
| 19 | `test/core/service.test.ts` | `queued, placed and done map to one submissionId` | 17 |
| 20 | `test/core/service.test.ts` | `unanswered keeps its reason and never invents a settlement` | 17 |
| 21 | `test/core/service.test.ts` | `history pages older messages without touching the newest window` | 17 |
| 22 | `test/core/service.test.ts` | `resync returns a snapshot whose rev equals the last published event` | 17 |

### Stage 3 — pi adapter

| # | File | First failing test | Needs |
| --- | --- | --- | --- |
| 23 | `test/runtime/mapEvents.test.ts` | `maps a recorded run to append, delta, append, submission, status` | 11 |
| 24 | `test/runtime/mapEvents.test.ts` | `builds the provisional from message_start content` | 23 |
| 25 | `test/runtime/mapEvents.test.ts` | `applies block and message replacements without loss, including a start block with no delta` | 23 |
| 25b | `test/runtime/mapEvents.test.ts` | `two text blocks receive deltas at their own indexes` | 23 |
| 25c | `test/runtime/mapEvents.test.ts` | `an aborted entry replaces the provisional that a late attach already delivered` | 23 |
| 25d | `test/runtime/mapEvents.test.ts` | `an oversized projection is withheld: the notice takes the entry id, replaces the provisional, and a reconnect sees the same notice` | 23 |
| 26 | `test/runtime/mapEvents.test.ts` | `a failed attempt finalizes its provisional and the retry gets a new id` | 23 |
| 26b | `test/runtime/mapEvents.test.ts` | `deferred_poll drops the provisional through a snapshot with streaming null` | 23 |
| 27 | `test/runtime/mapEvents.test.ts` | `maps every stopReason to a message state` | 23 |
| 28 | `test/runtime/adapter.test.ts` | `one turn appends exactly one pi.assistant entry` | 23 |
| 29 | `test/runtime/idempotency.test.ts` | `the same requestId returns one record and emits no new events` | 28 |
| 30 | `test/runtime/adapter.test.ts` | `abort settles the running and queued inputs with reason aborted` | 28 |
| 31 | `test/runtime/adapter.test.ts` | `a provider error settles unanswered with reason model_error` | 28 |
| 32 | `test/runtime/adapter.test.ts` | `a model asking for a tool gets an error result and the run continues` | 28 |
| 33 | `test/runtime/failures.test.ts` | `a parked task surfaces as task_parked from onReport, once` | 28 |
| 34 | `test/runtime/failures.test.ts` | `a storage failure closes the harness and classifies storage_failed` | 28 |
| 35 | `test/runtime/failures.test.ts` | `open resumes a run interrupted by close` | 28 |
| 36 | `test/runtime/adapter.test.ts` | `close resolves timeout without dropping the handle` | 28 |

### Stage 4 — server, lifecycle and end-to-end

| # | File | First failing test | Needs |
| --- | --- | --- | --- |
| 37 | `test/server/auth.test.ts` | `rejects a wrong bearer token before upgrade` | 17 |
| 38 | `test/server/socket.test.ts` | `closes 1008 when hello is not the first frame` | 37 |
| 39 | `test/server/socket.test.ts` | `closes 4004 for an unknown bot and 4090 while quarantined` | 37 |
| 40 | `test/server/socket.test.ts` | `a second subscribe on one connection closes 1008` | 37 |
| 41 | `test/server/catalog.test.ts` | `create, rename and delete keep the catalog absolute` | 9, 37 |
| 42 | `test/log/origin.test.ts` | `a failed operation has exactly one error record, at the originating layer, counted by failure id` | 6, 38 |
| 43 | `test/log/trace.test.ts` | `R1–R3 hold with a fake clock and a drain barrier` | 42 |
| 44 | `test/core/registry.test.ts` | `open is idempotent and shared by concurrent subscribers` | 28 |
| 45 | `test/core/registry.test.ts` | `an idle bot closes after idleCloseMs and reopens on demand` | 44 |
| 46 | `test/core/registry.test.ts` | `a timed-out close quarantines and refuses open and delete` | 36, 44 |
| 47 | `test/core/registry.test.ts` | `recovery scan resumes active bots and leaves the rest closed` | 44 |
| 48 | `test/core/singleton.test.ts` | `a live daemon rejects a second instance on the same root` | 44 |
| 49 | `test/e2e/journey.test.ts` | `create, chat three turns, reconnect and delete` | 41, 44 |
| 50 | `test/e2e/journey.test.ts` | `two bots stream independently with separate revisions` | 49 |
| 51 | `test/e2e/journey.test.ts` | `a lost submission reply is recovered by re-sending the requestId` | 49 |
| 52 | `test/e2e/journey.test.ts` | `a bot joining mid-answer receives the partial in the snapshot` | 49 |
| 52b | `test/e2e/outbox.test.ts` | `a send persisted before the socket write is reconciled after a daemon restart` | 49 |
| 52c | `test/e2e/paging.test.ts` | `history pages older messages and the newest window is never re-fetched` | 49 |
| 52e | `test/e2e/outbox.test.ts` | `a not_admitted rejection restores the draft, an unknown result keeps the requestId` | 49 |
| 52f | `test/e2e/outbox.test.ts` | `an admitted input whose status read fails keeps the outbox entry and reconciles on re-send` | 49 |
| 52g | `test/e2e/overflow.test.ts` | `an over-limit attempt is withdrawn; a late join during it sees streaming null, and the notice replaces it after commit` | 49 |
| 52d | `test/e2e/ordering.test.ts` | `a late connection-scoped record never downgrades a settlement` | 49 |
| 53 | `test/crash/sigkill.test.ts` | `killing the daemon mid-answer loses no message and duplicates none` | 49 |
| 53b | `test/crash/delete.test.ts` | `R4: a delete killed after rename reconciles on the next start` | 49 |
| 54 | `test/crash/singleton.test.ts` | `a SIGKILLed daemon is taken over on the next start` | 48 |

### Stage 5 — client

| # | File | First failing test | Needs |
| --- | --- | --- | --- |
| 55 | `BotsCoreTests/FixtureDecodingTests.swift` | `decodes every committed fixture` | 1 |
| 56 | `BotsCoreTests/ReducerTests.swift` | `append upserts by id and applies replaces` | 55 |
| 57 | `BotsCoreTests/ReducerTests.swift` | `delta applies text, block and message changes in order` | 55 |
| 58 | `BotsCoreTests/ReducerTests.swift` | `a snapshot replaces state and resets the baseline` | 55 |
| 59 | `BotsTransportTests/GapTests.swift` | `a revision gap drops events, resyncs once and reconnects after two failures (fake clock)` | 61 |
| 60 | `BotsCoreTests/ReducerTests.swift` | `a duplicate submission reply does not disturb the transcript` | 55 |
| 61 | `BotsTransportTests/SocketTests.swift` | `speaks the fixture server: handshake, subscribe, stream, paging` | fixture server |
| 62 | `BotsTransportTests/SocketTests.swift` | `maps close codes to connection states and reconnects on 1006` | 61 |
| 62b | `BotsTransportTests/GapTests.swift` | `a snapshot resets the gap counters` | 59 |
| 63 | `BotsFeaturesTests/ConversationTests.swift` | `connecting, ready, resync, reconnect and failed` | 59, 61 |
| 64 | `BotsFeaturesTests/ComposerTests.swift` | `optimistic bubble is replaced by the submission and append` | 60 |
| 65 | `BotsFeaturesTests/ComposerTests.swift` | `retry reuses the same requestId, including after an app restart` | 64 |
| 66 | `BotsFeaturesTests/ComposerTests.swift` | `sending while busy queues with followUp and survives a restart of the view` | 64 |
| 67 | `BotsFeaturesTests/CatalogTests.swift` | `create selects the new bot; delete removes it; a push updates the list` | 61 |
| 68 | `BotsFeaturesTests/RecoveryTests.swift` | `recover reopens an unavailable bot and leaves a healthy one untouched` | 63 |
| 68b | `BotsFeaturesTests/ComposerTests.swift` | `only not_admitted clears the outbox entry; unknown and runtime keep it` | 64 |
| 69 | `BotsCoreTests/DependencyRulesTests.swift` | `no networking API in core or features; no wire decoding outside transport` | 55 |
| 70 | `test/e2e/tools.test.ts` (daemon) | `a tool round is live in the transcript and in a later snapshot` | real stack + faux model |
| 71 | `test/runtime/tools.test.ts` | `a tool call and its result are live transcript rows and survive a late join` | 70 |
| 72 | `BotsCoreTests/FixtureDecodingTests.swift` | `the tool snapshot carries calls and their results` | 55 |
| 73 | `EagleFeaturesTests/BotsPresenterTests.swift` | `a call without its result is a running row while the run works`; `the result pairs with its call by id` | 72 |
| 74 | `test/server/gateway.test.ts` | `settings round-trip, stay 0600 and never expose the key`; `the probe reports reachability, auth and model count` | — |
| 75 | `test/server/settings.test.ts` | `the settings endpoints read, validate, save and test behind the bearer` | 74 |
| 76 | `test/core/registry.test.ts` | `a gateway model change reaches existing bots and new ones` | 75 |
| 77 | `test/server/update.test.ts` | `name, label and face are editable over PATCH` | 75 |
| 78 | `BotsFeaturesTests/CatalogTests.swift` | `testUpdateChangesNameLabelAndFaceAndReloadsTheCatalog` | 77 |

## Golden fixtures

- `fixtures/bots-protocol/*.json` are normative. `npm run fixtures:check` encodes
  every fixture through the daemon codec and fails on any byte difference;
  `npm run fixtures:write` regenerates them after a documented protocol change.
- `test/protocol/fixtures.test.ts` also asserts that the file set equals the table
  in [PROTOCOL.md](PROTOCOL.md#fixtures): an undocumented fixture fails.
- The Swift package decodes the same directory through a relative path, so one
  changed fixture breaks both sides in the same commit.
- Golden event sequences (not just single frames) are checked in under
  `test/runtime/golden/` for: a plain answer, a `message_start` that already carries
  content, an answer with deltas, two text blocks, a retry inside one turn, a
  tool-call attempt, an abort with a queued input, a provider error and a deferred
  poll. Each file holds the recorded pi events and the mapper's frozen output;
  `scripts/record-golden.ts` records from a real Harness over pi-ai's faux provider
  and `npm run golden:record` rewrites the frozen half, which is then reviewed like
  code. Shapes a faux provider cannot reach (a withdrawn over-limit attempt, a
  block change with no delta, the `deferred_poll` reset) are asserted from
  hand-built events in `mapEvents.test.ts`.
- `npm run test:runtime` and `npm run test:protocol` run one stage's suite; `npm test`
  and `npm run coverage` run the deterministic file list that includes both.
- Recovery (`test/runtime/failures.test.ts`) and the restart-count cases use a real
  child process that is `SIGKILL`ed mid-answer, because no in-process shutdown
  produces an interrupted task.

## Fault injection

| Injected fault | Expected |
| --- | --- |
| Wrong bearer token | HTTP 401; no `core.*` log; no bot opened |
| Malformed JSON frame | Close 1008; `protocol.decode.fail` only |
| Unknown command type | `error{invalid_command}`, connection kept |
| `subscribe` to a missing bot | Close 4004; `core.bot.resolve.fail` only |

| `send` before admission rejects | `error{disposition:"not_admitted"}`, **no** `submission` frame; the client restores the draft |
| Admission succeeded, reading its record failed | `error{disposition:"unknown"}`, outbox entry kept, reconciled by re-sending |
| Create or rename whose `BotSummary` would exceed 1 200 encoded bytes (a long title or a long model id) | Refused before the write; the catalog frame stays inside 200 × 1 200 B |
| Session failure on all three channels | One failure identity; a reopen then a new failure gets a new one |
| Retired watch | Re-attach, fresh snapshot, no counter, no error (classifier level; no integration injection exists upstream) |
| Admitted input whose record read fails inside the adapter | Asserted at the service and adapter boundaries; a real storage fault on that read has no injection point yet |
| Reply to `send` lost | Re-send the same `requestId` returns the record; no duplicate entry |
| Provider error | `unanswered{reason:"model_error"}`; provider text absent from logs |
| `runtime.open` rejects | `error` carries `failure` whose origin is `runtime`; core logs `warn` with the same id |
| Oversized message projection | Attempt withdrawn via snapshot (streaming null), notice replaces it after commit, no frame over 256 KiB |
| Late join during an over-limit attempt | Snapshot has no oversized partial; client never receives stale content |
| Abort with a queued input | Both settle `unanswered{reason:"aborted"}`; inbox empty |
| Parked task | One `error{kind:"task_parked"}` within 60 s; `recover` clears it |
| `listener_error` watch end once | Reattach + snapshot; no client-visible error, no failure minted |
| `listener_error` watch end three times in 60 s | Exactly one `error{kind:"internal"}`; bot `unavailable` while it keeps its Harness; `recover` re-attaches that harness's watch, never a second owner |
| `session_failed` watch end | Immediate `storage_failed` failure, same id as `harness.closed{failed}`; one error |
| `retired` watch end | Re-acquire, no counter, no error |
| `session.sqlite` replaced with junk | That bot `unavailable`; other bots unaffected; daemon alive |
| `close` never resolves | Quarantine; open and delete refused; retry every 30 s |
| Subscriber stops reading | Queue overflow, or more than 1 MiB unsent on its socket → snapshot-only; daemon keeps serving others. The queue path is asserted in `test/core/hub.test.ts`; the transport threshold is the same mechanism and is not covered by a deterministic slow-TCP test |
| Second daemon on the same root | Exits non-zero; first unaffected |
| Two daemons racing the same stale lock | Exactly one wins; the loser exits non-zero |
| Provider returns `deferred` then answers | `running:true` throughout, no fake streaming message, one final answer |
| Provider stops at `length` | `Message.stopReason:"length"`; client renders its own notice |
| `SIGKILL` mid-answer | Restart resumes; no message lost or duplicated |
| Delete killed after rename | Restart reconciliation finishes the delete |
| Open during an idle close | The open waits for the close and owns the handle it creates |
| Delete during a warm-up open | The delete waits for the open to settle, then closes the handle it created |
| Two concurrent creates for the last catalog slot | One succeeds, one is refused; the catalog is never 201 |
| Two concurrent sends at the pending limit | Exactly the allowed number is admitted |
| Session storage failure mid-run | The bot becomes `unavailable`; `recover` re-opens it and the next turn works |
| One bot's `session.sqlite` is junk | That bot is `unavailable`; another bot completes a turn |
| Shutdown with several stalled handles | One shared deadline, not one per bot; each is recorded as a degraded close |
| Catalog change between upgrade and `hello` | The change reaches the client in `welcome`, never as a frame before it |

## Crash test

`test/crash/sigkill.test.ts` runs from the stage that implements the daemon
(stage 4) and is mandatory from then on; it is opt-in for the fast gate
(`npm run test:crash`).

The barrier is a fact about the provider, not about timing or a log state. The
test's provider emits one streamed chunk, writes a sentinel file, and then **never
returns** — completion is blocked by construction, so no answer can land between the
barrier and the kill. The test waits for the sentinel *and* for the daemon's
`append` record whose whitelisted `detail` carries `role="assistant"`,
`state="streaming"` and a `messageId`, then `SIGKILL`s the process.

A second case kills **before** any assistant provisional exists, only after
admission (no sentinel chunk emitted), and asserts recovery without requiring an
aborted assistant entry. A third case kills after `rename` during delete
(`test/crash/delete.test.ts`) and asserts only post-restart reconciliation, since a
killed process cannot log its own failure.

After restart it asserts: exactly one admitted submission, the interrupted attempt
retained as an `aborted` assistant entry (RUNTIME F22), exactly one completed
answer for the same input, no duplicate submission and no duplicate user entry. A
second case kills after `rename` during delete and asserts that startup
reconciliation finished the delete; a `SIGKILL`ed process cannot log its own
failure, so the evidence is the post-restart `core.reconcile.ok`.

## Performance measurement

`npm run perf` is separate from `npm run check` because absolute milliseconds are
not deterministic. It records the environment, samples each operation five times,
reports the median, and asserts only generous bounds so a real regression fails
while noise does not.

| Measurement | Bound | Documented value |
| --- | --- | --- |
| `Harness.open` + `root()` on an empty bot | < 250 ms | 7 ms |
| Reopen a bot with 400 entries | < 100 ms | 3 ms |
| One answered turn (faux) | < 200 ms | 2–7 ms |
| 20 bots open in one process | < 1 s | 30 ms |

The script prints machine, Node version, filesystem and sample values; the
observed numbers are copied into [CHECKPOINTS.md](CHECKPOINTS.md). Changing a
bound means changing [PRODUCT.md](PRODUCT.md#speed-targets) in the same commit.

## Gates

```sh
cd apps/bots
npm run fixtures:check
npm test                # deterministic unit and integration tests only (test/tools included)
npm run typecheck       # tsc --noEmit
npm run lint            # biome check --error-on-warnings .
npm run coverage        # same file list as `npm test`, thresholds enforced
npm run test:crash      # test/crash/** only; mandatory from stage 4
npm run perf            # test/perf/** only; informational
npm run check           # fixtures:check, test, typecheck, lint, coverage

cd apps/bots-macos
swift test
./Scripts/coverage.sh    # Bots logic gate, own script
```

One file list, defined once in `scripts/unit-files.sh` and used by both `npm test`
and `npm run coverage`, so the deterministic gate and the coverage gate can never
drift. `test/crash/**` and `test/perf/**` are deliberately absent from it: a real
`SIGKILL` and a real clock are not deterministic. `package.json` is the single
authority for these commands; the README points here instead of restating them.

`npm run coverage` runs Node's own reporter with enforced thresholds:

```sh
node --test \
  --experimental-test-coverage \
  --test-coverage-include='src/**/*.ts' \
  --test-coverage-exclude='src/testing/**' \
  --test-coverage-exclude='src/**/*.test.ts' \
  --test-coverage-include-all \
  --test-coverage-lines=90 --test-coverage-functions=90 --test-coverage-branches=85 \
  $(sh scripts/unit-files.sh)
```

`--test-coverage-include-all` counts files no test imported, so an untested module
cannot hide. The thresholds make the command exit non-zero; stage signoff records
the run.

Rules:

- No skipped or focused tests. A blocked test is deleted or fixed; `test.skip`,
  `.only` or `XCTSkip` in a diff fails review.
- Time-dependent tests inject a clock. Only the crash and perf suites touch real
  time, and neither is part of `npm test`.
- No test opens a network socket other than a loopback fixture server it owns.
- Coverage is a floor: a layer at 95% with no fault-injection test is not done.

## Definition of done for a stage

Gates accumulate: a stage must keep every earlier stage's gates green and add its
own. Requirements that need a later stage's machinery start when that machinery
exists — this prevents the circular gate where stage 1 must pass a `SIGKILL` test
that only stage 4 can run.

| Gate | Enforced from |
| --- | --- |
| `npm test` + `npm run typecheck` + `npm run lint` + `fixtures:check` | stage 1 |
| `npm run coverage` with enforced thresholds | stage 1 |
| `test/log/shape.test.ts` asserting `used ⊆ declared` | stage 1 |
| `test/log/catalog.test.ts` asserting bidirectional equality | stage 4 (the first stage where every emit site exists) |
| `test/log/origin.test.ts` for each layer that exists | stage 4 |
| `npm run test:crash` | stage 4 |
| `npm run perf` | stage 4 |
| `test/tools/**` per-tool tests and the faux-provider tool round | phase 2 slice 1 |
| `swift test` + `Scripts/coverage.sh` | stage 5 |

Per stage:

1. Every ladder row of the stage is green; documents updated in the same commits.
2. The gates listed above for that stage pass; output is quoted in the checkpoint.
3. No widened limits, silenced log, swallowed error or new `test.only`.
4. [CHECKPOINTS.md](CHECKPOINTS.md) records what a user can see, what was run, and
   the next broken hop.
