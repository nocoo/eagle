# SG-001 — independent process and native Super Bot chat

Status: **delivered and owner-accepted 2026-11-07 for the source dev App; packaged/crash matrix remains open**.
Owner-selected first milestone: start an independent Superagent process, then make
its permanent Super Bot conversational in the Eagle App. Worker observation is
not a prerequisite. [Architecture](../SUPERAGENT-ARCHITECTURE.md) owns invariant
boundaries; [PLAN](../PLAN.md) owns delivery/evidence status.

This spec is the first implementation unit. Product requirements and acceptance
IDs below are defined; the transport/schema choices listed in section 7 must be
resolved in this document and reviewed before their corresponding code is written.
Later milestone specs are not required to deliver SG-001.

## 1. User outcome and scope

With the worker daemon absent, the owner can launch Eagle, select the permanent
Super Bot, send a message, see a real streamed answer, close/reopen the conversation,
and recover the same history after restarting the Superagent.

### In scope

- An independent executable process and its own canonical storage root.
- Stable system identity, independent pi-durable Harness and persisted conversation.
- App ownership of start, readiness, stop and bounded recovery; explicit process identity.
- Model configuration usable without the worker daemon or its database.
- Authenticated local App-to-Superagent chat, history and cancellation.
- Native MVVM sidebar/conversation and the minimum health/error presentation.
- Deterministic tests, real isolated process/transport tests and native acceptance.

### Not in scope

- Worker catalog, history, observation credentials or any worker IPC connection.
- `snapshot/history/changes` of the future **worker observation** protocol.
- Worker prompts, tools, reporting hooks, task wrappers or scheduling changes.
- Fleet analysis, recommendations, recurring checks, notification scheduling or a
  complete decision dashboard.
- General coding/shell tools, peer messaging, delegation or device execution.
- A background service that survives App quit, deployment, or distribution release.

The chat API reads and writes the Superagent's **own** conversation. This does not
violate read-only-toward-workers, and must not be confused with the later worker
observation API. SG-001 has no worker boundary to invoke at all.

## 2. Normative behavior

### SG001-R01 — process and storage ownership

The Superagent runs outside the existing worker daemon. It owns a distinct root,
lock/listener identity, local credential, session storage and configuration. It must
not open worker storage or import worker core/runtime/repository modules.

Only one live owner may use a canonical Superagent root. Concurrent App windows
must share one App-owned process rather than launch one process per view. A second
launch for the same root must be rejected or attach only after verifying the full
service identity and ownership contract; a matching port or PID alone is not proof.
After a process crash, the same root can reopen without deleting its history.

### SG001-R02 — executable foundation before chat

A standalone launch can reach a health/readiness response without a worker daemon
and without a configured model. Service readiness and model readiness are separate.
A missing model means chat is unconfigured, not that the process is dead.

The first integration slice proves start -> identity/readiness -> clean stop with
real isolated storage and a real process. It does not need a model, observation
adapter, dashboard or worker test fixture.

### SG001-R03 — App-owned lifecycle

The App owns the process it starts and can retry a failed start. Startup has a
bounded deadline, failures are visible, and concurrent start attempts coalesce.
Stopping/restarting Superagent does not signal, reconfigure or restart workers.
App quit stops the Superagent it owns; closing a window alone does not.

An externally owned process is not killed on App quit. PID reuse, stale readiness
responses and an unexpected process at the address cannot authorize termination
or adoption. Verify the service identity and owned process generation.

App and daemon close budgets must be consistent. Shutdown first stops admissions,
then drains durable writes and closes the Harness. A forced termination is reported
as such and recovery remains correct; graceful shutdown is not assumed to finish.

### SG001-R04 — permanent independent identity

The App shows one default Super Bot even if the worker catalog is empty, full,
unavailable or absent. Identity persists across windows and restarts. It is not a
row created by worker BotRegistry, and ordinary worker CRUD cannot address it.
The Superagent's API offers no delete/demote action; the native UI has no Delete.

Selecting it must not select, subscribe to, warm or create a worker. Source-qualified
selection prevents a colliding string ID from crossing service boundaries.

### SG001-R05 — independent model configuration

The Superagent reads its own persisted model configuration. First-time setup is
provided by an App-owned configuration path, not by querying a running worker
service or reading its private gateway/session files. Reusing the owner's chosen
provider values through that explicit App path does not imply shared mutable state.

The implementation spec must name the configuration owner and bootstrap flow before
coding them. Credentials remain in secure host storage/transport, never command
arguments, URLs, logs, screenshots or model content. Missing/invalid configuration
shows a precise state; no silent provider/model fallback or fake answer.

### SG001-R06 — durable chat and honest streaming

Use pi-durable for conversation storage, submissions, model turns and recovery;
do not implement another generation engine. A submitted message has a stable
caller-owned request ID. Retrying the same admission after disconnect/restart
returns the same durable record, not another model run.

One conversation has at most one active run. Busy input follows the documented
bounded queue policy; queue admission/refusal must be explicit in the UI. A
request may be queued, placed, answered or unanswered. Answered is not a claim
that any worker task completed.

Stream actual runtime content; never synthesize streaming from a canned final
answer. A fast provider may deliver only a final answer. Persist the final message
before presenting it as complete. Provider errors, cancellation and interrupted
attempts are not rendered as successful answers.

Opening the App, reading health/history or reconnecting must not start a new model
request. Restart may resume previously admitted Superagent work through pi-durable;
that is recovery of explicit input, not a proactive worker task.

### SG001-R07 — history and reconnect

A connection starts with an authoritative conversation snapshot and a defined
revision boundary. Subsequent updates cannot be missed between snapshot and attach.
On gaps or reconnect, replace from a current baseline and reconcile pending sends
by stable IDs. Do not duplicate an optimistic message or final answer.

Own retained history is paginated with a stable boundary, bounded count/bytes and
explicit coverage. Restart and ordinary context compaction preserve access to
retained older messages. This is Superagent history only, not worker history.
A corrupt store is visible failure, never an empty new chat presented as recovery.

### SG001-R08 — stop and failure boundaries

A Stop intent addresses only the Superagent conversation. Define its treatment of
active and queued input in the wire contract before implementation. Match the chosen
pi-durable operation exactly; do not imply that withdrawing all queued work means
cancelling only one input. An unconfirmed cancellation remains unconfirmed.

Client disconnect or view closure does not cancel admitted work. Model timeout,
authentication refusal, runtime failure and process exit have distinct visible
outcomes. Retry cannot silently resubmit an already admitted message under a new ID.
There is no worker recovery or worker cancellation operation in this milestone.

### SG001-R09 — capability and resource bounds

The model is chat-only: no worker tools, shell/coding tools, arbitrary file reader,
peer tools, device tools or delegated agents. Restrict the actual callable tool set,
not just the advertised names. The system prompt must not claim access to worker
state that SG-001 does not have.

Before the first model call, define bounded input/output, outstanding admissions,
request timeout and retry count, and test refusals. Use established SDK mechanisms
where they meet the spec. There are no scheduled/background analysis calls. Exact
dollar caps are not claimed when prices are unknown; autonomous-analysis budget
accounting belongs to its later spec.

### SG001-R10 — native MVVM

Reuse EagleDesign visual primitives and the existing shell's composition patterns,
not worker lifecycle view models or writable worker ports.

- Domain models/reducers own chat and connection state without UI/network types.
- Transport owns codecs, authentication, revision handling and paging.
- ViewModels have injected ports, one writable draft, explicit intents, cancellation
  and generation guards for late results.
- Views render and forward intent; no networking, model calls or retry logic in body.
- App process supervision is shared by the App, not owned by a conversation view.

The minimum UI is the pinned identity, transcript, composer, actual streaming,
connection/model readiness, visible error and Stop. History/reconnect semantics must
work before adding visual polish. No empty future dashboard tabs or disabled fake
worker controls are required for acceptance.

### SG001-R11 — minimum observability now

Provide deterministic process/connection/model readiness, request correlation,
classified failures and safe diagnostic logs. The owner must distinguish starting,
ready, model-unconfigured, running, reconnecting, stopped and failed.

Logs carry IDs and categories, not prompts, messages or credentials. A model failure
cannot prevent the UI from showing service health. Rich fleet dashboards, analysis
provenance and decision timelines are deferred; diagnosable startup and chat errors
are not deferred.

### SG001-R12 — no worker interaction

Normal startup, model setup, send, streaming, paging, reconnect, Stop, recovery and
shutdown make zero worker-service calls and touch no worker-owned persistence.
No observation credential is provisioned. Missing worker configuration cannot
block this service or App surface. Workers receive no hint that a supervisor exists.

The App may continue running its existing workers independently; the Super Bot
path must also pass with that subsystem disabled/unavailable. Do not redefine the
worker product or its existing behavior to make this test pass.

## 3. App-to-Superagent contract boundary

This boundary is independent of the later worker ObservationPort. Reuse mature
transport libraries and pure tested codecs when appropriate, not worker services.
The active wire specification must cover exactly these responsibilities:

| Responsibility | Required semantics |
| --- | --- |
| Health/readiness | Service identity/version, process generation and ready/error categories; model readiness separate; no secrets |
| Configure own model | Explicit authorized App path, persistence owner and fail-closed validation; no worker dependency |
| Snapshot/observe own chat | Atomic initial boundary, ordered committed updates, bounded slow-consumer behavior and resync |
| Read own history | Fixed page boundary, identity, next cursor, complete/partial/unavailable distinction |
| Submit own input | Stable request ID, durable admission, busy policy, queue limit and duplicate lookup |
| Stop own chat | Exact active/queued cancellation semantics, target scope and confirmed/unconfirmed outcome |

Before transport code lands, add the exact versioned frames/routes, limits, errors,
authentication rules and normative fixtures to this spec or a directly linked
SG-001 protocol file. Those fixtures drive both service and Swift conformance.
Do not treat this responsibilities table as an already frozen wire protocol.

## 4. Implementation slices inside milestone 1

| Slice | Implement in order | Exit evidence |
| --- | --- | --- |
| SG001-A: process foundation | Resolve root/entrypoint/identity/lock and health contract; failing lifecycle tests; independent executable and storage bootstrap | Real standalone start, health, duplicate-root refusal, clean stop and restart; worker absent; no model required |
| SG001-B: own durable conversation | Freeze chat/configuration contract and fixtures; failing admission/stream/reconnect tests; own pi-durable runtime and authenticated transport | Real local client can configure, send, receive, stop and reopen the same history with a scripted provider; no worker calls |
| SG001-C: native conversation | Domain/reducer and fake-port ViewModel tests; App-owned launcher/configuration path; pinned identity, transcript/composer and real transport | Eagle launches the service and a person can converse in the native UI; selecting it never opens a worker |
| SG001-D: milestone acceptance | Integration regressions, independent review, package gates, real CLI/process acceptance and hand-inspectable dev App | The complete scenario in section 5 passes with documented evidence; real-provider and rendered-UI evidence are reported separately |

Each slice retains a runnable result. Do not create a temporary executor that will
be replaced by pi-durable later. Do not start SG-002 to avoid an unresolved SG-001
failure, and do not implement observation infrastructure merely to make startup
look more complete.

## 5. Acceptance scenarios and traceability

Every requirement needs a deterministic test and an evidence row. Names below are
planned test descriptions, not files that already exist or passed runs.

| Acceptance ID | Requirement IDs | Given / when / then |
| --- | --- | --- |
| SG001-A01 | R01, R02, R12 | Given no workers/model, when the standalone process starts, then health is ready and model is unconfigured; worker calls/writes remain zero |
| SG001-A02 | R01, R03 | Given one owned root, when a duplicate launch or two windows start it, then only one owner exists; stale PID/address evidence cannot authorize adoption/termination |
| SG001-A03 | R03, R04, R10 | Given worker service absent, when Eagle opens and Super Bot is selected, then its pinned nondeletable identity and chat appear without worker subscription |
| SG001-A04 | R05, R06, R09 | Given valid independent configuration, when input is submitted, then a scripted provider receives it and actual runtime content reaches the native transcript |
| SG001-A05 | R06, R07 | Given an admission whose reply was lost, when the same ID is retried or the connection rejoins, then one input and one answer exist with no duplicate generation |
| SG001-A06 | R06, R08, R09 | Given a running answer, when bounded extra input or Stop arrives, then queue/refusal/cancellation follows the exact contract; no false completed state |
| SG001-A07 | R01, R06, R07 | Given committed history and an interrupted answer, when the process restarts, then history remains and recovery follows native durable semantics rather than resubmitting a new request |
| SG001-A08 | R05, R08, R11 | Given missing config, auth refusal, model timeout or process exit, then the correct visible state and safe diagnostic identity appear; no fallback or fake success |
| SG001-A09 | R03, R10 | Given multiple windows or late network responses, when a view closes/switches/reopens, then no duplicate process, revived closed view, stale draft overwrite or lost committed history occurs |
| SG001-A10 | R01, R03, R12 | Given both services, when one stops/crashes/restarts, then the other retains its ownership and work; App quit only stops its owned processes |
| SG001-A11 | R04, R09, R12 | Given direct API/tool attempts, then identity deletion and unregistered tools are refused; all Super Bot journeys produce zero worker calls/writes |
| SG001-A12 | R07, R10 | Given retained history across paging/compaction, then older Superagent messages remain reachable and no partial page is represented as complete |

**Human acceptance:** launch the dev App with the worker service unavailable; see
the permanent Super Bot; send two turns; see actual answers; exercise Stop and one
failure; restart Superagent; verify history; close/reopen the window; quit the App
and verify its owned process exits. Repeat the unaffected worker journey separately.

Use real isolated storage/process/transport plus a scripted model for deterministic
gates. The acceptance product journey uses `eagle-dev` with an explicitly scoped
Superagent target/commands specified before implementation, not a bespoke HTTP
script masquerading as CLI acceptance. Existing Bots eval commands do not already
cover the new service; define its executable gate explicitly. Real-provider checks
and native UI inspection cannot be inferred from scripted CLI success.

Evidence rows must record spec/test ID, source revision, red behavior, green result,
review disposition and any unrun manual/live check. No row is complete merely
because a test file or CI configuration exists.

## 6. Spec-driven workflow

1. Resolve the active slice's open technical choices in this spec; update normative
   fixtures and acceptance cases before implementation.
2. Review changed boundaries with an independent read-only reviewer, using explicit
   base/head. Do not infer this spec passed from the historical architecture PASS.
3. Demonstrate a failing behavior for its requirement ID, then implement the smallest
   correct change. A missing import alone is not the behavioral red.
4. Run affected checks, commit a coherent runnable slice, and address review findings
   with regression proof. Use at most three review/fix rounds per review scope.
5. Record actual acceptance evidence and remaining gaps. Update PLAN when the slice
   or milestone exits, not when its code is first written.
6. Only after SG-001 meets its gate, prepare/freeze SG-002 before adding observation.
   If behavior changes, revise the spec and tests first; never document a deviation
   after the fact to turn it into a pass.

One integrating writer owns repository changes on main; reviewers are read-only.
Keep tests and daily-development state separate. Run broad gates at milestone
integration rather than after every small edit; required final gates are not optional.
Every macOS code change ends with an inspectable foreground dev App under the
project's pane/toolchain rules. Record the actual user-visible checkpoint during
long implementation, not a forecast of success.

## 7. Technical decisions to freeze before their code

These are engineering completion items, not requests to reopen the owner's product
choices. Do not block process foundation on future observation decisions.

| Before | Required spec addition |
| --- | --- |
| SG001-A | Executable/package location and gate, own root/profile defaults, listener/lock identity, readiness/shutdown budgets, process ownership proof |
| SG001-B | App chat protocol/fixtures, exact auth/bootstrap/config owner, model route/limits, busy/Stop semantics, stream/history/recovery mapping |
| SG001-C | Swift targets/ports and UI routing, App launcher/configuration integration, scoped CLI acceptance commands |

[Local implementation protocol](SUPERAGENT-001-PROTOCOL.md) freezes SG001-A's
entrypoint, roots, identity proof, lock, readiness and cleanup budgets. Two
independent spec-review findings (endpoint binding and owned-child cleanup) were
fixed and accepted before foundation implementation. B/C details remain gated.

The separate-process, separate-store, default identity, App lifetime and chat-first
decisions are already accepted. No worker read-adapter investigation, complete
Dashboard specification or autonomous-management policy belongs in this table.

## 8. Current evidence

An independent read-only reviewer (`group/reviewing`, `xhigh`) reviewed this draft
and the synchronized architecture/research/PLAN changes over base `09985c0d` on
2026-11-07. Verdict: **PASS (document review)**, with no concrete contradiction or
necessary acceptance omission reported in that scope. The review confirmed the
chat-first order, zero worker dependency, R01-R12 acceptance mapping and honest
freeze-before-code items. It does not freeze unresolved wire/configuration details.

SG001-A: seven initial behavior reds, followed by real process start/stop and
SIGKILL/reopen. Independent review found four additional negative-boundary gaps;
regressions failed first and passed at `8ec860c0`. The reviewer independently ran
12 tests/types/lint at that revision and closed all four findings.

SG001-B: five initial runtime reds and real socket reds preceded implementation.
Independent review then reproduced two P1 defects: an SDK compaction summary was
rendered as a player turn with an inverted page boundary, and a truncated/missing
session database reopened as a healthy empty chat. Both were demonstrated red,
fixed and are covered by regression tests. The daemon gate now passes **43 tests**,
strict types and check-only lint, with C8 four-metric coverage
**98.72 / 95.13 / 98.14 / 98.72**.

SG001-C: `apps/superagent-macos` (Core/Transport/Features), the App-owned process
host, native conversation/settings and `eagle-dev superagent` are implemented.
Its gate passes **27 tests**, and every logic file is at or above the project's
**90% line floor** (regions/functions reported; Swift does not instrument
branches). The App suite passes **428 tests**; design guard and strict format pass.

Real-gateway acceptance through the product CLI: two model turns answered, history
retained across a Superagent restart, idle Stop confirmed. The same conversation
rendered in the native App, whose system row is permanent and whose composer shows
no unsupported attachment/voice action. Evidence:
`.local/superagent-evidence/cli-acceptance.log`, `app-superbot.png`.

Final independent C review (range `4792c187..5662d494`) returned REQUEST CHANGES:
5 P1 and 8 P2 findings. They were reproduced, fixed and regression-tested:
outbox races across windows (C2), quit-during-launch (C3), byte-trimmed history
reachability (C6), unconfirmed-send identity/draft handling (C1/C10), late
connection revival (C11), queued/aborted/error rows (C8/C9), worker termination
under `EAGLE_DISABLE_WORKERS` (C4), owned-process exit and retry (C5), settings
client lifecycle (C7), authenticated health proof for process adoption (C12), and
supervisor status publication (C13).

Second incremental review over `5662d494..94b54d9e` closed 9 of 13 findings and
left C1 (reconciliation left an admitted draft sendable), C5 (owned-child exit kept
readiness), C10 (overlapping same-draft sends) and C11 (close during settings load)
open with isolated probes. They were fixed with regressions at `9070b771`: draft
settlement on reconciliation, one in-flight send, owned-child liveness recheck, and a
window-lifetime guard after settings. A third round replayed only those four probes
and returned **PASS**, plus 37 package tests.

Owner acceptance on 2026-11-07: with an isolated worker workspace (`BOTS_ROOT`
separate, port 43119) and the dev Superagent on 43127, the owner created a worker
bot and chatted with Super Bot in the native App, then accepted the result.

Remaining environment gates, not reopened product requirements: installed/packaged
App, a real two-window run, and forced-quit/crash cases (dead child, quit mid-answer,
SIGKILL service). No worker service call or worker storage access is part of the
Superagent path; the isolated worker was used only for owner convenience.
