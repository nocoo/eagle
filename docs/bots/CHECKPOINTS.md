# Bots — checkpoints

User-view progress log. One entry per working session, written from the
perspective of what a user or reviewer can observe, not what was typed. Never
claim verification that did not run.

Format per entry:

```
## YYYY-MM-DD HH:MM — <milestone>
Observed: <what can be seen or executed now>
Verified: <commands actually run, with results>
Next broken hop: <the first thing that does not work yet>
```

## 2026-10-25 20:35 — documentation phase complete

Observed: the Bots contract exists as six documents plus a normative fixture set.
No Bots code exists yet, so nothing is runnable. A reviewer can read the product
scope, the layer boundaries, the wire protocol, the runtime mapping, the log
contract and the test ladder without consulting chat history.

Verified:

- `git log` shows seven atomic documentation commits on `main`.
- Every file under `docs/bots/` and `fixtures/bots-protocol/` parses and passes the
  repository pre-commit gate (Biome formats the fixtures, Markdown is excluded).
- `docs/bots/RUNTIME.md` facts F1–F16 were established by running
  `@earendil-works/pi-durable@1.4.0` with `fauxProvider()` on Node 26.12.0 in a
  scratch directory, including: generation appends `pi.assistant` itself
  (`answer` equals that entry id), `message_end` fires for the user entry too,
  `requestId` idempotency, `unanswered{reason:"model_error"}`, late-join
  `watchEvents` snapshots, cold open 7 ms, reopen of 400 entries 3 ms, 20 bots
  open in 30 ms at 103 MB RSS.
- No Eagle code, test or configuration was changed; `apps/bots` does not exist
  yet, so no gate could accidentally start running it.

Next broken hop: `apps/bots` is missing. The first implementation commit has to
create the isolated package (`package.json`, `tsconfig.json`, `biome.json`, test
script) before the protocol codec can be written, otherwise the TDD ladder has
nowhere to run. `apps/macos` still contains only the Eagle client; the `Bots*`
targets do not exist.

## 2026-10-25 21:40 — review round 1 and model endpoint verified

Observed: the contract was reviewed by an independent coding agent (Codex, model
`group/auto-gpt-6-astra`, reasoning `xhigh`) which returned `VERDICT: BLOCKING 7`
with 29 findings. All 29 were accepted as correct or as actionable gaps; the
documents were revised in three commits (ports/ownership/logging, wire, runtime and
tests). The development model endpoint was also verified end to end.

Verified:

- `cd apps/bots && npm run smoke:model` against `http://127.0.0.1:3425/v1`
  (provider `magpie`, model `auto/gpt-6-luna`, OpenAI Responses shape): two turns,
  both `done`, answers `巴黎是法国的首都。`, 1.7 s and 1.3 s per turn, usage
  `68 in / 16 out`. The key is read from the 0600 `.env`, never printed, never in
  argv.
- `npx tsc --noEmit` in `apps/bots` passes for the smoke script.
- Probe P3 established that the assistant `message_start` already carries the full
  partial content, and that `message_update` can be absent entirely (one run had
  zero deltas). Probe P4 established `abort()` settlements (`unanswered{reason:
  "aborted"}`, with `entry` for the running input and without it for queued inputs)
  and duplicate-`requestId` idempotency. Both facts changed the mapping and the
  protocol, so they were applied before code exists.
- `git log` shows the review-fix commits; no Bots code beyond
  `package.json`/`tsconfig.json`/`biome.json`/`scripts/smoke-model.ts` exists yet.

Next broken hop: the daemon has no `src/` code, no lock discipline and no tests, so
the ladder in `docs/bots/TESTING.md` stage 1 cannot run. The skeleton commit carries
`package-lock.json`, the configs and `.env.example` — never the real `.env`, which
holds `BOTS_API_KEY` and stays untracked with mode 0600.

## 2026-10-25 22:30 — documentation signed off

Observed: the contract is signed off by the independent reviewer after eight
rounds. Round 1 found 7 blockers and 29 findings; rounds 2-8 found 7, 5, 4, 3, 2, 2
and finally none. Every finding was accepted and applied, and each round's fix is
its own commit so the reasoning is reviewable.

Verified: the reviewer's final message reports `VERDICT: SIGN OFF`, with B1-B7 all
`FIXED`, all five weak spots closed (content reconstruction, frame budgets, offline
outbox reconciliation, exactly-one-error with attribution, stage-1 signable), and
the note that stage 1 can start "without inventing anything". Its single warning for
implementation: do not lose the "attempt withdrawn" decision — the regression to
watch is over-limit partial, then shorter content, then the entry commits, then a
daemon restart; append, snapshot and history must all yield the same notice.

Nothing has been executed yet beyond the model smoke test and the probe scripts, so
this signoff certifies the contract, not a passing gate.

Next broken hop: stage 1 has no code. The first ladder row is
`test/protocol/fixtures.test.ts` -> `decodes every committed fixture without loss`,
which must fail because no decoder exists, then pass with the protocol module.

## 2026-10-25 22:45 — stage 1 started: the wire decodes and re-encodes

Observed: the protocol codec exists and the normative fixtures are executable. The
ladder rows 1-2 are green; rows 3-8 (command validation, limits, versioning, log
shape and redaction, architecture guards) are not written yet.

Verified:

- `node --test test/protocol/fixtures.test.ts`: 29 tests pass, including "decodes and
  re-encodes <fixture> without loss" for all 17 server fixtures and "the encoder
  reproduces snapshot.server.json byte for byte".
- `npm test` runs the shared unit file list through `scripts/run-tests.sh`; it fails
  loudly when the list is empty, so a gate cannot pass because it found nothing.
- `npm run typecheck` and `npm run lint` pass.
- `npm run check` is expected to fail right now: `npm run coverage` enforces 90 %
  lines over `src/**` with `--test-coverage-include-all`, and most modules
  (`core/`, `runtime/`, `server/`, `log/`) do not exist yet.

Next broken hop: no command validation, no limits enforcement, no log module and no
architecture guard test, so ladder rows 3-8 cannot run. The next commit adds command
validation and limits, then the log module, then the guard tests.

## 2026-10-25 23:20 — stage 1 complete and signed off

Observed: all eight stage-1 ladder rows are implemented, tested and reviewed. The
daemon can decode and encode every protocol frame, validate commands, enforce the wire
budgets, ignore unknown events while consuming their revision, log through a declared
catalogue with redaction, and prove its own layer boundaries by parsing its source.

Verified (all run just now in `apps/bots`):

- `npm test`: 104 tests pass.
- `npm run check`: `fixtures:check` (26 files), tests, `tsc --noEmit`, Biome and
  coverage all pass; coverage is 93.72% lines, 90.30% branches, 96.00% functions.
- Codex reviewed each batch and signed off: rows 1-4 (6 rounds), rows 5-6 (5 rounds),
  rows 7-8 (5 rounds). Every review finding was fixed and re-reviewed; the recurring
  themes were "a test that only round-trips proves nothing", "budgets must measure the
  bytes actually written", and "enforce boundaries with a parser, not a regex".

Next broken hop: stage 2 has no code. `src/core` contains only `domain.ts` and the
components `BotDirectory`, `EventHub`, `ConversationService`, `RuntimePort` and
`BotRegistry` do not exist, so rows 9-22 (directory, hub, service) cannot start. The
agent runtime, transports and client remain unimplemented.

## 2026-10-26 — stage 2 halfway, plan recorded

Observed: rows 1-10 are signed off; rows 11-16 are implemented with 143 tests passing
but are waiting on a review round. The daemon still cannot start: there is no
`ConversationService`, no transport and no entrypoint.

Verified: `npm run check` in `apps/bots` (fixtures 26 files, 143 tests, typecheck, lint,
coverage above thresholds). The catalog, fake runtime and hub are the only core modules.

Next broken hop: `send` has no owner. `src/core/ConversationService.ts` does not exist,
so rows 17-22 cannot start, and nothing wires the protocol codec to a socket. The full
state and order of work now lives in [PLAN.md](PLAN.md).

## 2026-10-26 07:20 — stage 2 hub signed off

Observed: ladder rows 11-16 are implemented, tested and signed off after six review
rounds. The hub now numbers a delta when its batch is broadcast, splits a batch
between whole changes against the 96 KiB soft limit, keeps a per-bot serial fanout
with no sink reentrancy, downgrades a slow subscriber to snapshot-only with a
recovery anchor it never serves stale, and measures encoded bytes through an injected
transport measure. The fake runtime keeps only committed entries in its history,
orders finalization like the window, tracks the streaming pointer and walks a
toolcall path from the block root.

Verified (all run just now in `apps/bots`):

- `npm run check`: `fixtures:check` (26 files), 167 tests, `tsc --noEmit`, Biome and
  coverage 95.88 % lines, 91.19 % branches, 96.77 % functions.
- Codex reviewed each batch read-only and answered `VERDICT: SIGN OFF` on fc7fddc
  after 11 in-memory reproductions and 8 mutations that the suite catches.

Next broken hop: `send` and the connection still have no owner. `ConversationService`
does not exist, so rows 17-22 cannot start and nothing turns a domain event into a
frame.

## 2026-10-26 14:05 — stage 2 complete

Observed: ladder rows 9-22 are implemented, tested and signed off. The catalog is
atomic and resumable, the hub owns revisions, coalescing and per-bot serial fanout,
the fake runtime satisfies the port, and `ConversationService` turns a connection into
a subscription: a current baseline rendered before it goes live, a silent duplicate
send, broadcasts for settlements, paging that leaves the window alone, and a resync
whose only reply is the snapshot it publishes.

Verified (all run just now in `apps/bots`):

- `npm run check` exited 0: `fixtures:check` (26 files), 199 tests, `tsc --noEmit`,
  Biome, coverage 96.49 % lines, 91.60 % branches, 97.40 % functions.
- Codex signed off rows 17-18 on 80315bd and rows 19-22 on cf33bee after 13 in-memory
  reproductions and 6 mutations; six review rounds closed rows 11-16 on fc7fddc.
- Mutation spot checks in this session: a fat batch split, the first-frame guard, the
  post-drain re-check, both rank seedings, the snapshot normalization, the normalized
  broadcast, the resync trace, the resync window and a thin settlement record each
  fail the suite when removed.

Next broken hop: nothing turns a runtime event into a frame and nothing listens on a
socket. `src/runtime/pi/` (stage 3) has no adapter, so there is no real Harness, no
`mapEvents`, and the daemon cannot start; stage 4's server and `main.ts` are next.

## 2026-10-26 — stage 4 closed out: transport, budgets, observability, journeys, crash

Observed: the daemon is a usable local service, not a half-wired server. It binds a
loopback port, refuses a wrong token before the upgrade, caps connections and
subscribers, serves the catalog as measured frames, streams a bot over a socket,
records every crossing in the declared log catalogue with one identity per failure,
and survives a `SIGKILL` mid-answer: the restart keeps the interrupted attempt as
`aborted`, answers once and duplicates nothing.

Verified (all run just now in `apps/bots`):

- `npm run check`: `fixtures:check` (26 files), 310 tests, `tsc --noEmit`, Biome and
  coverage 93.00 % lines, 89.47 % branches, 90.87 % functions.
- `npm run test:crash`: 3/3 — the mid-answer `SIGKILL` (a stub provider that streams
  one chunk, writes a sentinel and never returns), the delete killed after its
  rename, and the lock taken over after a `SIGKILL`.
- `npm run perf`: open 3 ms (bound 250), reopen 400 entries 1 ms (150), one answered
  turn 3 ms (200), 20 bots open 10 ms (1000), on arm64 / Node 26.12.0.
- The review round it is heading into is recorded in [PLAN.md](PLAN.md); no stage-4
  row is signed off yet.

Next broken hop: there is no client. `apps/bots-macos/` does not exist, so a person
cannot open a bot, type at it or see a transcript — that is stage 5 (rows 55-69).

## 2026-10-26 — stage 4 second review round closed

Observed: an independent review (Codex, `group/auto-gpt-6-astra`, high) returned
`BLOCKING 9` against the first round, with 19 further findings. Every defect is
fixed: the daemon no longer opens a second Harness while one is closing, a delete
waits for a warm-up open, a run-time storage failure turns into `unavailable` and
`recover` re-opens the bot, a snapshot page is bounded by bytes as well as count, a
client that stops reading is downgraded instead of buffered, admission and creation
are serialized against their budgets, the catalog event waits for the handshake,
shutdown spends one shared deadline, every refusal has one originating record, and
the catalog follows the run.

Verified (all run just now in `apps/bots`):

- `npm run check` exited 0: `fixtures:check` (26 files), 329 tests, `tsc --noEmit`,
  Biome, coverage 93.22 % lines / 89.54 % branches / 90.02 % functions.
- `npm run test:crash` exited 0: 5/5, including a second kill before any assistant
  provisional and two daemons starting at once.
- `npm run perf` exited 0: open 3 ms, reopen 400 entries 1 ms, one turn 3 ms, 20 bots
  10 ms; the reopen bound now matches the document (100 ms) and every sample is
  printed.
- The review's own probes reproduced each P1 before the fixes; the new tests assert
  them after.

Next broken hop: stage 4 is awaiting the reviewer's acceptance of this round; the
client (`apps/bots-macos/`, rows 55-69) still does not exist.

## 2026-10-26 — stage 4 third review round closed

Observed: the reviewer's third pass found eight P1s in the neighbourhood of the
round-two fixes — a handle that a subscribe could still hold across a closing or
deleting bot, history byte-paging that skipped messages, a snapshot budget that
ignored the rest of the frame, an unavailable snapshot the production decoder would
reject, reservations that could leak or free too early, replies and catalog events
that bypassed the backpressure bound, a lock server a silent client could hold open,
and concurrent `recover` attaching a second watch. Each is fixed with a test that
fails without the fix.

Verified (all run just now in `apps/bots`):

- `npm run check` exited 0: `fixtures:check` (26 files), 338 tests, `tsc --noEmit`,
  Biome, coverage 95.07 % lines / 90.24 % branches / 90.39 % functions.
- `npm run test:crash` exited 0: 5/5.
- `npm run perf` exited 0 and now asserts the documented load (400 messages) instead
  of only reporting a number.

Next broken hop: waiting on the reviewer's round-four verdict; the client still does
not exist.

## 2026-10-26 — stage 4 fourth review round closed

Observed: the fourth round found five P1s inside the third round's fixes, all of them
one-owner problems: reservations that double-counted or leaked, an escalated watch that
dropped a live Harness so `recover` could open a second owner over one sqlite file, a
view that two concurrent subscribes could build twice (and so exceed the eight-
subscriber cap per hub), and a summary that was only budgeted in its healthy form
although the unavailable variant is longer and could stop a `welcome` from fitting.
All are fixed with tests that fail without the fix, and the P2s are closed too.

Verified (all run just now in `apps/bots`):

- `npm run check` exited 0: `fixtures:check`, 343 tests, `tsc --noEmit`, Biome,
  coverage 94.82 % lines / 89.97 % branches / 90.33 % functions.
- `npm run test:crash` exited 0: 5/5.
- `npm run perf` exited 0: the answered-turn measurement now waits for `done`, and the
  reopen asserts the documented 400-message load.

Next broken hop: the reviewer's round-five verdict; then stage 5 (the client).

## 2026-10-26 — stage 4 fifth review round closed

Observed: the fifth round found three more one-owner and budgeting defects — the
delete's settling window was being replaced by its close's window, a snapshot could
reconcile a reservation whose `submit` had not returned, and an unavailable bot with a
live Harness still admitted work past the 32-entry budget. Also fixed: the catalog
after a recovery, the oversize-versus-backlog order in the writer, validation and
version refusals as origin errors, a recorded refusal for a summary over budget, the
answered-turn measurement, and a real-adapter window test that joins a client while a
provider-blocked over-limit attempt is withdrawn.

Verified (all run just now in `apps/bots`):

- `npm run check` exited 0: `fixtures:check`, 344 tests, `tsc --noEmit`, Biome,
  coverage 94.86 % lines / 89.76 % branches / 90.33 % functions.
- `npm run test:crash` exited 0: 5/5.
- `npm run perf` exited 0 with the settlement waited for.

Next broken hop: the reviewer's round-six verdict; then stage 5 (the client).

## 2026-10-26 — stage 4 paused, stage 5 started

Observed: stage 4 (rows 37-54) is implemented and green, but the independent review has
not signed it off: six rounds closed 40+ findings, and the sixth left three reproducible
daemon races (a delete/idle-close overlap, a stale snapshot releasing a reservation, and
an availability check before an `await`). Those are recorded in [PLAN.md](PLAN.md) as
deferred work; the mock runtime, the fixture set and the existing test stacks stay
untouched as the demo and regression path.

Decision: start stage 5 (the macOS client, rows 55-69) with the MVP scope — create a bot
and chat — and wire the client to the real daemon for every new bot. Stage 5 is not
reviewed with the same loop before the user sees it working.

Next broken hop: `apps/bots-macos` does not exist yet.

## 2026-10-26 — stage 5 MVP in the Eagle main window

Observed: the Bots client lives in the Eagle app, not in a second app. The sidebar has a
`Bots` group whose items are the daemon's bots; `+` creates one, rename and delete are
the sidebar's own menu, and selecting a bot turns the middle column into its
conversation. Against the real daemon and the real model endpoint, a created bot
answers: the transcript shows the user pill, the streamed assistant text as it grows,
the typing row before the first token, and the settlement. The optimistic bubble is
replaced by the committed entry, the outbox survives a restart, and `unavailable` offers
`recover`.

Verified (run just now):

- `cd apps/bots-macos && swift test`: 44 tests, including an integration test that
  spawns the production daemon with a stub model endpoint, creates a bot, chats and
  rebuilds the transcript from a second subscription.
- `cd apps/bots-macos && ./Scripts/coverage.sh`: 90.2% logic lines (minimum 90).
- `cd apps/macos && swift build` and `Scripts/build-app.sh`: the Eagle app builds with
  the Bots group; launched against the real daemon it listed the existing bots and
  rendered their conversation in the main window. `EagleDesignTests`' palette-sampling
  tests fail in this shell (they read dynamic NSColors; untouched by this change).
- The reviewer's hands-on observations were fixed: the sidebar group chevron is always
  visible instead of hover-only, adjacent sidebar cards keep a small gap instead of
  touching, and one send no longer paints two user bubbles (the placement removes the
  optimistic bubble even when the daemon's append carries no `requestId`).

## 2026-10-26 — bot identity: name, label and a face

Observed: creating a bot opens a sheet on the main window with a required name, an
optional label, one of eight silhouettes and one of twelve tints. The daemon stores the
label and the face on `bot.json`, returns them in every catalog payload, and the sidebar
row draws the chosen silhouette with its two eyes; a bot written before appearance
existed renders the default face. Sidebar wording is bot vocabulary (`重命名 Bot`,
`删除 Bot`), the group collapse animates as a fade with a small gap between cards, and
the demo workspace is the same shape: every item is a bot.

Verified: `cd apps/bots && npm run check` (346 tests), `cd apps/bots-macos && swift test`
+ `./Scripts/coverage.sh` (90.2%), `cd apps/macos && swift test` (39 tests) and
`Scripts/build-app.sh`; a screenshot of the sheet shows the preview, the shape grid and
the swatches, and the sidebar renders the green blob face.

The sheet follows the reference dialog's measured proportions (879 × 1 116 scaled to 560
wide: a 62 pt header, a 132 pt preview, a 43 pt name row, five shapes per row and six
swatches per row, a 46 pt footer). Assistant answers render in a dialog bubble with
markdown: headings, bullets, quotes, fenced code and inline styles. The row context menu
follows the reference: 置顶, 移至 ▸ (groups and 创建分组), 标为未读, 重命名 Bot, 复制对话
ID, 从侧边栏隐藏, 删除 — with pinned rows sorting first, a pin glyph, an unread dot and
hidden rows dropping out of the list.

Next broken hop: history paging from the transcript, bot settings and per-bot inspector
content; stage 4's three deferred daemon races are still open.

## 2026-10-26 — stage 5 MVP observed end to end

Observed: the Eagle main window has a `Bots` group whose rows are daemon bots drawn with
their own face; `+` opens the create sheet (required name, optional label, ten shapes,
twelve tints, live preview, reference proportions), `+`-created bots appear in the list
immediately and chat over a real socket; answers stream into markdown dialog bubbles;
the row menu matches the reference (置顶, 移至 ▸, 标为未读, 重命名 Bot, 复制对话 ID, 从侧
边栏隐藏, 删除); bots keep their label and face across daemon restarts.

Verified just now: `apps/bots` `npm run check` 346 tests, coverage 94.87/89.71/90.35;
`apps/bots-macos` `swift test` 44 tests and `./Scripts/coverage.sh` 90.2%;
`apps/macos` `swift test` 39 tests; `Scripts/build-app.sh` builds the app; a live chat
against the real model rendered as a markdown bubble (heading, bullets, `bash` block).

Next broken hop: the independent review of stages 4 and 5 (this round), then the
daemon's three deferred races and the client items listed in PLAN.md.

## 2026-10-26 — stages 4-5 review round closed (except what is recorded as deferred)

Observed: the reviewer's fifteen P1s are closed: three confirmed daemon races and twelve
client/integration defects — a missing shape that could make the whole catalog
undecodable, an outbox that sent without a durable record, placements treated as
settlements, replay before the subscription, a send that could land on another bot, a
wedged writer after one failed write, a gap rule that advanced past the gap, a snapshot
that forgot settlements, two windows overwriting each other's outbox, a hide that left
the conversation on the hidden bot, a catalog push that desynced the selection, and a
shell without recover/stop/error. Markdown is now parsed in order (fences, headings,
lists) and rendered in dialog bubbles.

Verified just now: `apps/bots` `npm run check` 348 tests, coverage 94.99/89.82/90.68,
`npm run test:crash` 5/5; `apps/bots-macos` `swift test` and `./Scripts/coverage.sh`
93.7%; `apps/macos` `swift test` 44 tests and `Scripts/build-app.sh`.

Next broken hop: the deferred list in PLAN.md — client `os.Logger` contract, the
transport fault-injection matrix, the outbox across two windows, three daemon origin/
handle gaps, and a measured long-markdown layout.

## 2026-10-26 — stages 4-5 review, second pass

Observed: the reviewer's second pass confirmed thirteen findings as fixed and found nine
regressions inside the fixes. All nine are closed: one draft shared by the shell and the
view model, evidence-based reservation expiry, a fail-closed outbox with durable terminal
records, reconciliation after every reconnect, a cleared write queue on failure,
one-resync-per-gap with a ten-second deadline and a drop barrier, bot-bound
abort/recover/history, refusal text preserved next to a newer draft, and the send path
fixed by the single draft.

Verified just now: daemon `npm run check` 348 tests, coverage 94.97/89.72/90.68;
client `swift test` and `./Scripts/coverage.sh` 93.1%; Eagle `swift test` 44 tests.

The third pass found four follow-ups inside those fixes (the draft binding, a failed
status read releasing a reservation, a resync deadline closing a barrier a snapshot had
opened, and a refused entry replayed after a failed removal). All four are fixed and now
have regression tests: `BotsWindowTests` binds the window the way the shell does and
proves one draft plus the restored refusal text; the reservation test injects a failing
status read and requires the slot to stay taken; `ResyncStateTests` drives the
snapshot/deadline interleavings; and the refused-entry test makes the outbox write fail,
reconnects, asserts no replay and asserts the failure is reported.

Next broken hop: the deferred list in PLAN.md (client `os.Logger`, the socket
fault-injection matrix beyond the resync state machine, two real windows, three daemon
origin/handle gaps, long-markdown layout) and the reviewer's fourth pass.

## 2026-10-26 — stages 4-5 review, fourth pass

Observed: the reviewer (Codex, reasoning max) found four contract defects at ff231ce and
they are closed: a recovery no longer drops the admissions that were in flight when the
watch escalated; a subscriber the transport downgraded is handed a fresh snapshot instead
of waiting silently forever; close `4090` retries the connection (a quarantined bot can
only be recovered over a live socket); and a parked task now offers `recover` and the
action reaches the daemon. The P2s are closed too: a restored settlement is ranked by its
submission id, a half-spoken lock owner no longer hangs the probe, the initial snapshot
sets the history flag, the window test now asserts the published transcript, and the I9
carrier list and redaction test include a bot's label.

Verified just now: daemon `npm run check` 351 tests, coverage 94.99/90.01/90.55,
`npm run test:crash` 5/5; client `swift test` and `./Scripts/coverage.sh` 93.1%; Eagle
`swift test` 48 tests.

A fifth pass (max reasoning) found four more contract defects, all closed with tests: a
recovering bot keeps the admissions in flight; a backpressured subscriber is refreshed
with a snapshot, bounded to one attempt per episode so a client that never reads cannot
spin the daemon; a bot that becomes quarantined while a subscription waits closes 4090 and
retries; and a recover clicked while reconnecting keeps the parked affordance. P2s: the
heartbeat follows the connection generation, a refusal is a durable tombstone, the settled
rank key is the submission id, and the lock probe resolves on a partial answer.

Verified just now: daemon 353 tests, coverage 95.07/90.01/91.06, crash 5/5; client
coverage 93.4%; Eagle 48 tests.

A sixth pass found three more, closed with tests: a degraded subscriber whose recovery
snapshot was also lost is retried on a timer until its anchor is delivered (the final
events of a run can no longer be lost behind a backpressure episode); a refusal whose
support directory is unwritable still becomes a durable tombstone (a user-private
temporary fallback), so a restarted process cannot replay it; and a command issued while
reconnecting is refused instead of silently dropped, so a recover never clears the parked
affordance without reaching the daemon. P2/P3: the TTL test now exercises only the
reserved ids, a snapshot can no longer resurrect a settled submission as pending, and the
plan's stale "no client" row is gone.

Verified just now: daemon 354 tests, coverage 95.05/89.92/91.11, crash 5/5, perf 4/4;
client coverage 93.1%; Eagle 48 tests.

A seventh pass found two more, closed with tests: the snapshot now carries whether a task
is parked, so a client that reopens the bot still offers `recover` (and a recovery
snapshot clears it); and closing a window releases its socket (the receive task is
cancelled, the session invalidated, the shell disconnects on disappear), so the
eight-subscriber cap is not consumed by closed chats — verified with nine sequential
subscribe/close cycles. P2/P3: the Swift fold keeps settlement ranks across a snapshot and
the plan's stale "not started"/"next race" lines are gone.

Verified just now: daemon 355 tests, coverage 95.07/89.95/91.11, crash 5/5; client
coverage 93.2%; Eagle 48 tests.

Next broken hop: the recorded deferrals in PLAN.md and the reviewer's eighth pass
(closeout).

## 2026-10-26 — Phase 1 stages 4-5 closed by owner; fine issues deferred

Observed: the owner closed the Phase 1 stages 4-5 closeout without waiting for another
signoff round ("太细致不修，进入 tool call 开发") and asked for the findings to be written
down. The eighth review was interrupted on purpose, issued no verdict, and its one
confirmed observation — after a daemon reopen the recovery affordance can disappear
because `parked` is not carried on that path — is open, not fixed. Phase 2 (tool calls)
is the next work.

Tip at close: `e70547c` (`docs(bots): document snapshot.parked`); only this
documentation commit moves HEAD after it.

Verified at close: daemon `npm run check` 355 tests, coverage 95.07/89.95/91.11,
`test:crash` 5/5, `perf` 4/4; Bots client `swift test` and `./Scripts/coverage.sh`
93.2%; Eagle `swift test` 48 tests.

Deferred, not claimed fixed (also listed in [PLAN.md](PLAN.md#phase-1-close-owner-decision-2026-10-26)):

- client `os.Logger` crossing contract and its `LoggingTests.swift`
- the transport fault-injection matrix beyond `ResyncState` (real-socket gap, unknown
  event with a gap, resync timeout with a fake clock, the full close-code matrix)
- the outbox across two real windows
- daemon: abort-refusal origin record, a failed `directory.remove` leaving a closed
  handle, the catalog-full origin record
- the recovery affordance after a daemon reopen (unfinished round 8)
- a measured long-markdown layout
- the adapter's admitted-then-unreadable storage fault and the retired-watch integration
  injection (recorded in TESTING.md)
- history paging, bot settings and per-bot inspector content

Next broken hop: Phase 2 — tool calls auto-execute, no approval gate; first the common
local coding commands, then herdr/CLI space control. The brief is
`.herdr-brief-phase2-tools.md`.

## 2026-10-27 — Phase 2 slice 1: the bot's four workspace tools

Observed: a bot now executes tools without asking. `read_file`, `write_file`,
`list_files` and `run_command` work inside `<bot dir>/workspace`; paths cannot leave it
(including through a symlink), a command is killed at its deadline with the output capped
at 64 KiB, and the child environment is an allowlist that never carries the daemon's
credentials. A refusal is text the model reads, and a run survives it. `capabilities.tools`
is true; `toolcall` deltas already fit the wire.

Verified just now in `apps/bots`: `npm run check` 370 tests (10 file-tool tests, 5 shell
tests, the registry test, 4 faux-model tool rounds), coverage 95.11/89.52/90.91; the
faux-provider round proves a read result reached the model, a write and a command took
effect, and a `../../etc/hosts` read came back as a refusal instead of a run failure.

Next broken hop: Slice 2 — the herdr tools (open a space, schedule the controller, monitor,
fetch results, bidirectional messages), then Codex review at max reasoning.

## 2026-10-29 09:20 — triggers are visible, switchable and firing

Observed: a Bot's triggers now exist as one product surface. The Bot's own model
creates and manages them with five tools; a schedule fires through the invocation
port and is batched, retried and delivered by the queue; the window lists the
selected bot's triggers in a `触发器` sidebar section with a one-click switch on
each row, and the inspector shows that trigger's plan, next due instant, counters,
endpoint and prompt read-only. Settings offers the `trigger` group. A message
whose cause was a trigger carries a small origin line above its text.

Verified:

- `apps/bots`: `npm run check` 599 tests, coverage 95.24 / 87.90 / 90.61. The new
  suites cover the store journal (idempotency, cap, cursor, restart), the tools'
  mapping and refusals, the queue (cap, frozen batch, budget cut, envelope), the
  pump (reconcile, retry with the same key, round-robin), the schedule (zone math,
  arm/fire/missed, one journal record per decision), the `triggers` event and its
  budgets, the HTTP detail/switch contract, and the composition end to end with a
  fake port.
- `apps/bots-macos`: `swift test` 51 + 43 tests, `./Scripts/coverage.sh` 91.1%.
- `apps/macos`: `swift test` 134 + 49 tests, `./Scripts/coverage.sh` 95.7%,
  `./Scripts/build-app.sh` builds `.build/Eagle.app`.
- Live daemon, real process on a temporary root: `POST /v1/bots` created a bot, a
  replayed `triggers.journal.jsonl` was read back by `GET /v1/triggers?botId=…`
  with its prompt, `PATCH …/<trigger>` returned `enabled:false` and appended an
  `enable` record, re-enabling let the real ticker arm the cursor at
  `2026-10-30T01:00:00.000Z` (09:00 Asia/Shanghai), which then appeared as
  `nextDueAt` in the detail — `triggers/<triggerId>.jsonl` held exactly one
  `cursor` record. A `PATCH` with an extra field returned 400.

Next broken hop: the webhook endpoint (stage 2) — a trigger of kind `webhook`
cannot receive a delivery yet, so only schedules produce fires. Nothing has
exercised a real model creating a trigger through `trigger_create` (no gateway key
in this session), and no image of the new sidebar row has been reviewed.

## 2026-10-29 10:35 — both trigger kinds deliver

Observed: a webhook trigger now receives work. A service posts to
`/v1/triggers/<botId>/<triggerId>` with that trigger's own bearer and gets `202`; the
delivery becomes one batched message whose origin chip says `webhook`, and the bot
answers. A schedule trigger fires at its minute on its own, and its message says
`schedule`. The app's trigger detail shows the endpoint and the token to copy, the
counters follow reality, and disabling a trigger makes its endpoint answer `409`.

Verified:

- `apps/bots`: `npm run check` 611 tests, coverage 95.08 / 88.02 / 90.19. New suites:
  the ingress contract (202/409/413/422/429/404, one 404 for unknown/wrong token,
  text extraction, clamping, idempotency with and without a key, the retry window),
  the secret store (mint once, 0600, reopen, forget, corrupt file), the HTTP route with
  and without an ingress, and the queue's last-delivered window.
- `apps/bots-macos`: `swift test` green, `./Scripts/coverage.sh` 90.8%.
  `apps/macos`: 134 + 49 tests green, coverage 95.7%.
- Live, real daemon on a temporary root with a local faux OpenAI Responses endpoint:
  the gateway saved over `PUT /v1/settings`, a webhook trigger replayed from its
  journal, a token minted at boot in `triggers.secrets.json`, `POST …/t_aaaaaaaaaa`
  → `202` and a user message `origin:{kind:"webhook"}` followed by an assistant answer;
  the same `Idempotency-Key` twice → `queued: 1` then `queued: 0`, and still `0` after
  the run had closed its batch; wrong token → `404`; the daemon bearer on the delivery
  route → `404`; disabled → `409`; a `* * * * *` schedule fired at its minute
  (`origin:{kind:"schedule"}`, envelope `[schedule · 1 item · …]`), advanced its cursor
  and incremented `fired`.

Next broken hop: `peers` (stage 3) is untouched. Two stage-2 limits are declared but
not implemented — the per-token bucket and `maxFiresPerHour`; the 32-item queue (`429`)
and the admission budget are the only backpressure. Nothing here exercised a model
creating a trigger through `trigger_create` (the triggers came from their journals), and
no image of the new rows has been reviewed.

## 2026-10-29 11:20 — acceptance cases, and the bug the cron case found

Observed: `tests/eval` now holds eight acceptance cases and a runner. Each one boots a
real daemon, plays a scripted model, runs real tools and then checks the transcript,
the tools that were called, the files on disk and the model request count. Both trigger
kinds were re-run until they were stable, and three different complex LLM + tool-call
loops pass.

Verified:

- `npm --prefix apps/bots run eval`, one full run: `chat-basic`, `coding-fix-loop`,
  `complex-self-trigger`, `complex-webhook-triage`, `complex-workspace-audit`,
  `search-unconfigured`, `trigger-cron`, `trigger-webhook` — all ok.
- Stability: `trigger-cron --repeat 3` ok three times (two fires each, ≈2 min a round);
  `trigger-webhook --repeat 3` ok three times (2 rows per round after dedupe).
- The three complex shapes, each an LLM + tool-call loop:
  1. `complex-workspace-audit` — list → read → `bash node -e …` → write `report.md`;
     the report is checked on disk.
  2. `complex-webhook-triage` — a delivery with no client involved → read
     `logs/deploy.log` → write `triage.md` → answer; origin and file both checked.
  3. `complex-self-trigger` — the model calls `trigger_create` for a webhook trigger,
     the case reads the minted endpoint, delivers to it, and the model answers the
     triggered run.
- `apps/bots`: `npm run check` 612 tests at 95.11 / 88.07 / 90.21.
- The cron case found a real defect: `ScheduleTicker`'s timer tick enqueued a fire but
  never woke the pump, so a schedule only delivered when an unrelated idle edge
  happened to drain it. Fixed in `479dd7f` with a test that drives the injected timer.

Next broken hop: `peers` (stage 3). A case cannot prove a real provider — the model is
scripted — and a case runs with a temporary `XDG_CONFIG_HOME`, so keyed search is
exercised only by the unit suite. Nothing here runs Herdr.

## 2026-10-29 11:55 — the window drives a real daemon

Observed: the macOS client logic, pointed at a running daemon, sees a Bot's triggers in
the sidebar with a switch each, toggles one (and the daemon's own event moves the row),
receives a webhook delivery as a transcript row labelled `Webhook`, and receives a
schedule fire as a row labelled `定时` — all without a stub.

Verified:

- `Tests/EagleFeaturesTests/LiveDaemonTests.swift`, gated by `BOTS_LIVE_ROOT` and
  `BOTS_LIVE_PORT`, against a real daemon on `/tmp/live-mac` (a `* * * * *` schedule and
  a webhook trigger, faux model endpoint): one run passed in 41 s. It asserts the
  `触发器` section holds both rows with `toggle.isOn == true`, a one-click toggle flips
  the row to `false` and back (the daemon's `triggers` event is what moves it), a
  `POST /v1/triggers/<bot>/<trigger>` with the trigger's own token returns 202 and
  produces a `Webhook` row, and a schedule fire produces a `定时` row.
- `apps/macos`: 136 + 49 tests green, coverage 95.7%, `build-app.sh` builds.
  (One performance test flaked while a daemon and a model server were running in the
  background; it passed once they were stopped.)
- Before that, the same daemon paths were driven by `npm --prefix apps/bots run eval`
  (8/8) and by `curl`/a raw WebSocket client.

Next broken hop: nobody has looked at the rendered window — the inline switch and the
section position are covered by unit tests and this live drive, not by an image review.
`peers` (stage 3) remains untouched.

## 2026-10-29 12:30 — default triggers, a shared face, and an honest daemon prompt

Observed: a new Bot can create its own schedule or webhook without a trip to Settings,
because the `trigger` group is now selected by default. The conversation header draws the
same Bot face (shape and colour) as the sidebar row and the inspector. When the daemon is
not running the app stops trying and says so, with one explicit retry.

Verified:

- `npm --prefix apps/bots run eval`: 9/9 cases, including the new
  `complex-default-trigger`, which sets no `toolGroups` and still creates a webhook
  trigger with `trigger_create` and receives a delivery.
- `apps/bots`: `npm run check` 612 tests at 95.12 / 88.05 / 90.21.
- `apps/bots-macos`: 51 tests. New policy tests: a connection that never reached
  `welcome` is stopped with the daemon message, a session that dropped still retries.
- `apps/macos`: 138 + 49 tests, coverage 95.7%, `build-app.sh` builds. New tests: the
  header's status offers `canRetry` (and the subtitle carries the daemon message), a
  retry opens exactly one fresh connection, and — against a real closed port — the
  connection ends `.failed` with the daemon message and is still failed 1.5 s later, so
  there is no blind retry loop.
- One performance test (`Transcript row cost`) flaked twice at 2.51 against a 2.5 bound
  under load. Fixed by measuring its least disturbed round instead of a median (load can
  only add time, and a real regression raises every round), not by widening the bound;
  an ordinary user bubble also went back to one `Text` instead of a container it only
  needed for the origin chip. The full pre-push gate then passed and `main` reached
  `origin/main` at `81b4c3d`.

Next broken hop: the per-trigger hourly cap and token bucket remain planned; `peers` is
untouched; nobody has reviewed a rendered screenshot of the new header face or the
trigger rows.

## 2026-11-07 11:20 — queued sends are visible, promotable, and never stranded

Observed: the live daemon log showed three sends admitted as `queued: true` while a bot
was answering, and all three later settled `done`; the App nevertheless showed no
waiting state, so they looked ignored. A failed run could leave them in the inbox
forever because `afterFailedRun` was never set and pi's default is `keep`.

Verified:

- `afterFailedRun: "continue"` is now explicit; a runtime test proves the input queued
  behind a provider error starts instead of waiting for another input.
- A queued optimistic bubble keeps its local id across a snapshot, so a reconnect or
  resync no longer hides it while it waits.
- The App draws a waiting icon on that bubble; clicking it sends `promote`, which moves
  the submission to the head of the bot's inbox and marks it `steer`. The icon switches
  to `已插队` until the entry is placed, then the ordinary user turn has no icon.
- `apps/bots`: `npm run check` passed (1105 tests; coverage 95.87 / 89.07 / 91.37).
- `apps/bots-macos`: `swift test` passed; `Scripts/coverage.sh` 90.9% lines.
- `apps/macos`: `swift test`, `swift build`, `npm run check:design` and strict
  `swift format lint` passed. A Dev App is running in the right pane against the
  isolated root `/tmp/eagle-bots-dev-20261107` on port 43119.

Next broken hop: nobody has clicked the new icon in a rendered window. That Dev App
has no gateway configured (the owner's production key was not copied); configure a
gateway in its Settings before checking the waiting/insert path.

## 2026-11-08 06:20 — SG-002 contract frozen, provider store slice green

Observed: the observation contract went through three read-only review rounds (12, then
12, then 15 findings) and the provider's read-only store slice now passes on real
stores.

Verified:

- `docs/bots/specs/OBSERVATION-SPIKE.md`: real-store probe — a read-only connection
  leaves committed data intact, `SqliteStorage.open` migrates, today's runtime history
  reports a compacted root window as complete while 30 child-scope entries exist, and
  `commit_seq` is per store with no fleet sequence.
- `SUPERAGENT-002-OBSERVATION.md` + `SUPERAGENT-002-PROTOCOL.md` + ten fixtures under
  `fixtures/bots-observation/`, with a 26-check mechanical self-audit saved at
  `.local/superagent-evidence/spec-selfcheck.log` (includes a measured 43,113-byte
  worst-case 200-Bot baseline against the 64 KiB body budget).
- `apps/bots/src/observation/{schema,store,cursor}.ts` plus `src/runtime/pi/schema.ts`
  and an architecture edge for the projection; 15 new tests; `npm run check` green with
  **1120** tests, observation files at 93–100% statements.
- `scripts/unit-files.sh` now includes `test/observation`, so those tests cannot go
  unrun.

Next broken hop: no HTTP route, observation credential or `changes` comparison exists
yet, so nothing is reachable from the Superagent or the App; S2's route slice, S3
consumer, S4 native surface and S5 acceptance are unstarted.

## 2026-11-08 06:55 — observation routes reachable on a real daemon

Verified:

- `apps/bots/src/observation/{credential,changes,routes}.ts`: a dedicated 0600
  observation bearer minted once with its own store identity, a `changes` comparator
  that pages by delivered ranges only, and the three frozen routes with loopback
  Host/Origin checks, typed errors and per-Bot baselines.
- The observation token is refused on `/v1/bots` (403 `credential_kind`), the worker
  token on `/v1/observe/*`, a missing bearer is 401, a wrong one 403, a relay Host 403
  and a browser Origin 403.
- A bot whose store was never opened reports `session_missing`, reads create no file,
  and `changes` refuses a foreign baseline with `cursor_invalid`.
- `apps/bots`: `npm run check` green, **1126** tests, coverage 95.32 / 88.17 / 90.91.

Next broken hop: nothing on the Superagent side consumes this yet — no `observe-*`
socket command, no consumer baseline store, no native status block, no CLI paging, and
the SG-002 acceptance matrix (A01–A17) has not been run.
