# Superagent — independent observation and native decisions

Status: **accepted product principles; proposed technical contract; not implemented**.
The owner added the independence, read-only-first, native dashboard, MVVM and TDD
requirements on 2026-11-07, then selected **process foundation and native chat first**.
[SG-001](specs/SUPERAGENT-001-CHAT.md) is the active draft implementation spec:
start the independent process, then converse with its Super Bot in the App, with
no worker connection. Observation, analysis and the full dashboard come later.
These decisions supersede both the integrated-coordinator rollout and the proposed
observation-before-chat order. Development is spec-driven and behavior uses TDD.

## 1. Product and independence invariants

The Superagent is the default, nondeletable main Bot in the Eagle UI. It is not a
privileged worker and does not become an owner of worker runtime internals.

| Requirement | Invariant and delivery scope |
| --- | --- |
| Independent execution | Own process, Harness, model turns, queue, storage and lifecycle from SG-001, which is delivered; later milestones are not required to build parallel infrastructure |
| Workers run alone | Starting, chatting, tools, recovery and shutdown require no Superagent, its storage or acknowledgement |
| Superagent runs alone | SG-001 starts and chats without workers; later dashboards mark unavailable sources and stale retained facts honestly |
| Worker unawareness | No Superagent persona, tools, report hooks, task wrappers, new prompts, required acknowledgements or model-visible messages in workers |
| Read-only toward workers | No send, steer, promote, abort, recover, retry, configure, trigger mutation or delegation, including indirect calls |
| Full-history visibility | SG-002 will expose all Bots' complete retained conversation history; SG-001 has no worker history access or observation credential |
| Conversational role | SG-001 answers the owner; evidence-backed analysis follows in SG-003; no general shell/coding execution role |
| App-scoped lifetime | First version runs while the App runs; no new login/background service after App quit |
| Human decisions | Native decision dashboard remains required in SG-003; SG-001 needs chat and basic health/errors, not a complete dashboard |
| Engineering | MVVM presentation; backend behavior developed with failing tests first |

Read-only is a relationship, not inactivity: SG-001 calls its own model and writes
its own conversation. Later specs add analysis/decision history and bounded
notifications. None of those operations writes into a worker. The App-to-Superagent
chat protocol is separate from the later worker-to-Superagent observation contract.

Independent hosts may use the same pi-durable library. That is not another bespoke
execution engine. They must not share live Harness handles, queues, writable
session databases, lifecycle leases or an in-memory service container. Pure wire
contracts and tested stateless presentation utilities may be shared.

### Independence is an SG-001 property — 2026-11-08

The owner scoped the independence requirement to **SG-001**, which is delivered: its
own executable, root, credential, model configuration, gate and lifetime. Later
milestones are not asked to re-implement what the worker service already has. A
provider, read adapter, authenticated route, storage mapper or projection that lives
in the worker service is **reused in place**; a second parallel implementation is
out of scope and undesirable.

What "clean" means here is the **interface**, not the implementation: versioned read
contract, observation credential, typed errors, coverage watermarks and opaque
cursors are frozen and tested, and the consumer uses only the wire contract. These
invariants stay hard: no shared live Harness/queue/lease between the two services, no
Superagent import of worker runtime objects, no worker behavioral dependency on the
supervisor.

Worker and Superagent failures must remain distinguishable. A failing observer
must never mark a healthy worker unavailable or delay a worker commit while it
waits for the observer to consume an event. Bounded observation load is permitted;
zero CPU/I/O overhead is not a realistic promise.

### Accepted process topology — 2026-11-07

The owner confirmed **separate App-owned processes and separate stores**. The
Superagent runs outside the existing worker daemon; this does not require one new
process per worker Bot. Each service owns its lifecycle, execution state and storage,
and they communicate only through the versioned local protocol.

The App starts/stops its owned processes independently. Neither service supervises
or restarts the other. The first release still stops with the App; no login or
always-on background service is introduced. Existing externally owned processes
must not be terminated merely because the App quits.

Separate processes isolate process-local crashes and event-loop stalls; they do
not provide an OS security sandbox or eliminate shared machine-resource failures.
Local authentication, explicit process ownership and bounded reconnect behavior
remain implementation requirements. No process or configuration is changed by this
documentation update. Exact paths/wiring require SG-001 specification and verification.
The passive-read adapter is a gate for SG-002, not for launching or chatting with
the independent Super Bot. The topology choice is settled.

## 2. First-class identity without worker dependency

The Superagent owns its stable system identity and persistence, outside the worker
catalog. The Eagle shell composes two sources: a pinned system identity from the
Superagent side and ordinary Bot identities from the worker directory. Selection
must retain the source namespace so an identical string ID cannot cross surfaces.

This replaces the earlier proposal to create the main Bot through worker
`BotRegistry` startup. A missing, full or failed worker catalog must not prevent the
main Bot or its dashboard from appearing. Worker `DELETE /v1/bots/:id` does not
own this identity. The Superagent's public API exposes no delete/demote operation;
UI menus also omit it. No worker field or prompt announces that it is supervised.

The main Bot can be paused, unavailable or unconfigured without being deleted.
Corrupt supervisor storage fails visibly rather than recreating an empty identity
as if no history existed. Filesystem tamper resistance is not promised.

Its model configuration must not require a live worker daemon to be read. The App
may supply separately scoped configuration and credentials to each host; workers
must not serve as the credential broker or lifecycle owner of the Superagent.
No credential value is part of an observation or model prompt.

## 3. Later worker observation boundary — SG-002

This boundary is absent from SG-001. Specify and prove it after the independent
native chat milestone works; do not make it the prerequisite for process startup.


```text
Worker runtime / stored history
    -> generic passive observation provider
    -> versioned read protocol
    -> Superagent observation adapter
    -> local evidence and decision store -> bounded model analysis
    -> supervisor read model -> native MVVM dashboard / main conversation

SG-001 has no worker connection. SG-002 through SG-004 add reads, never commands.
```

The provider belongs to the worker service's generic read infrastructure, not to
worker model behavior, and it is built **inside** that service by reusing its
existing storage access, authentication, route table and view mapping. It adds no
parallel observation subsystem, no second opener and no copied schema layer. It may
add an inert observation endpoint/projection; it may not require workers to call a
reporting tool or import Superagent domain concepts. "Unaware" means no behavioral
dependency or supervision-specific execution code, not that an authenticated read
never reaches the worker service's transport.

The Superagent cannot import worker implementation objects, open worker SQLite
files, attach a second Harness to worker storage, or parse private log/session
formats. It consumes the read contract over the wire. A raw filesystem sidecar in
the Superagent would merely replace call coupling with schema coupling; inside the
worker service the existing storage adapter is the right owner of that coupling.

### Why the current read routes are not sufficient

Static source at Eagle `69cf615d` establishes these call paths:

| Existing path | Observable side effect or boundary |
| --- | --- |
| `GET /v1/bots` | Reads registry summaries; this route itself does not open a Harness (`server/http.ts:833-838`) |
| Chat `subscribe` | Resolves/opens the Bot and refreshes tools (`core/ConversationService.ts:289-293`) |
| Runtime open | Configures the stored agent and enables scheduling with `harness.resume()` (`runtime/pi/PiDurableRuntime.ts:382-426`) |
| Subscribed socket | Takes `registry.touch`, holding idle-close eligibility (`server/socket.ts:498-500`) |
| Chat `history` | Requires an existing chat subscription (`core/ConversationService.ts:910-923`) |
| Peer exchange detail | Can read a submission and persist its answer into the exchange (`peers/api.ts:61-73`) |
| Submission lookup | Resolves a Bot through `#bot`, which can open it (`core/ConversationService.ts:604-609`) |
| Trigger detail GET | Returns webhook credentials and can create a missing token (`main.ts:411-433`, `core/TriggerSecrets.ts:43-48`); a generic GET/read bearer is too broad |

Therefore `read` credential scope or HTTP GET is not proof of passive behavior.
Do not implement the observer by keeping one chat socket open per worker. Do not
call the existing peer detail API merely because its HTTP method is GET.

### Three proposed read operations

These are the complete candidate worker-read interface families for SG-002, not
the SG-001 App chat API. Names below are domain sketches, not implemented endpoints.
Freeze exact schemas, numeric limits and error fixtures in the SG-002 spec before
implementing this capability. They need not be frozen to deliver SG-001.

| Operation | Input | Result and strict semantics |
| --- | --- | --- |
| `snapshot` | Protocol version, requested source, optional previous observation revision | Bounded fleet catalog and recorded runtime facts, source identity/epoch, capture time, coverage watermark and a change cursor paired with that baseline; missing evidence is unknown, not idle |
| `history` | Source, Bot, optional history cursor, bounded page size | Committed retained messages with Bot/conversation/entry provenance, fixed history boundary, next cursor and explicit coverage/truncation; no generation, recovery, compaction or tool refresh |
| `changes` | Source/epoch-bound change cursor, bounded page size | Committed catalog/history/status changes or invalidations plus next cursor; no observer acknowledgement required for worker progress; duplicates are allowed and identified |

A single generic `execute` or arbitrary-method RPC is not an acceptable replacement
for these three operations. A caller's optional scope may narrow visibility; it
must never be used to manufacture a fourth, unvalidated capability.

The snapshot and change cursor need a defined cut: after applying the snapshot,
changes after its cursor must cover later committed observations. If the provider
uses an asynchronous projection, publish its covered watermark and lag, not a
claim that it includes a worker commit it has not indexed. Record per-Bot coverage;
a fleet projection is not a transactionally atomic snapshot of all worker Harnesses.
A sequence number and wall-clock time are different fields with different semantics.

History is paginated at a fixed upper boundary so a busy Bot cannot shift the page
under the reader. Complete history includes retained entries before compaction;
compaction is not history deletion. A missing/tombstoned or unavailable range is
explicit, never an empty success implying no history. Bounded tool output already
stored in the transcript cannot be expanded into bytes that were never retained.
The protocol must state which stored message kinds and conversation scopes it
covers, including child/reflection scope handling, and make unsupported ranges
visible rather than silently presenting a subset as complete. Today's runtime
history reads only the root and maps/clips entries (`PiDurableRuntime.ts:895-925`,
`mapEvents.ts:476-511`); it is not already this complete retained-history contract.
Complete-history delivery cannot be signed off while required scopes are missing.

Cursors are opaque and bound to source identity, epoch, query and projection
version. Cross-Bot history cursor reuse is rejected. Expired change retention or
an epoch change returns a typed gap/reset outcome requiring a new baseline, not a
silent best-effort continuation. The Superagent commits consumed observations,
its cursor and any analysis intent together in its own store. A reconnect never
reuses chat `rev` as a durable global event cursor.

Observation data is untrusted context. Each claim retains source provenance;
quoted historical instructions do not become new commands or authorization.
The permission to read all histories does not grant arbitrary onward disclosure,
credential-store access or the same privilege to ordinary workers.

### Noninterference and failure semantics

All three reads must be inert with respect to worker execution and domain state:

- No input, new run, tool execution, recovery/resume, compaction or configuration.
- No conversation entry, catalog mutation, peer receipt backfill or worker note write.
- No worker lifecycle lease, idle-close extension or unbounded observer backpressure.
- No observer failure propagated into worker task success/failure.
- Reader cancellation cancels only the read; it never aborts worker work.
- Cold/unavailable data does not trigger a warm-up to make it look available.

Transport auditing and credential-use bookkeeping are allowed, bounded side
effects, not conversation or business-state mutations. Keep their whitelist
explicit in the contract; do not assert that every disk byte remains unchanged.
Readers must bound transaction duration and release handles so SQLite reads do not
hold WAL checkpoints indefinitely or monopolize worker I/O.

Use a narrowly scoped observation credential at the transport boundary; the
Superagent gets no worker write/admin bearer and no shell escape hatch. Authentication
or version failure disables live observation and shows a reason. It does not
upgrade scopes, refresh worker configuration or fall back to private file access.

The pinned SDK's passive cold-read capabilities require a source/type/probe spike.
Opening a Harness as a workaround is forbidden. If the existing SDK cannot serve
a required read without writes/recovery, implement a worker-owned inert adapter or
projection with a tested schema boundary. Do not silently downgrade full history to
currently open conversations. This is a feasibility gate, not a proven capability.

## 4. Later read-only supervision and evidence — SG-003/004

After SG-001 chat and SG-002 observation, the relevant specs may enable:

- Observe all workers through the passive contract without changing their execution.
- Read complete retained history on demand using bounded queries.
- Identify possible blockers, missing evidence, repeated failures or conflicting work.
- Explain a suggestion with cited evidence and uncertainty.
- Answer the owner and record human decisions in supervisor-owned state.
- Recheck a suggestion after a new observation or an owner-requested analysis.

It may not ask a worker for status, send a reminder, modify a trigger, retry a failed
run, change a model, assign work, or silently apply a suggestion that the person
marked useful. Throughout SG-001 to SG-004, a direct request to delegate must say
it was not executed; no hidden worker command exists. SG-001 must also be clear
that it has not observed worker history yet.

The minimal supervisor records are observations, evidence references, analyses,
suggestions, human decisions and source health. Do not require WorkItem/Assignment
or structured worker reports before delivering the first useful read-only product.
Workers' existing task graph and prose are evidence of activity, not an accepted
business-task state machine. Labels such as "may be blocked" remain inferences.

An analysis records its input watermark, evidence references, model/prompt revision,
start/end, outcome, measured usage and limitations. A human disposition records
which suggestion revision it refers to. A changed evidence set can supersede an
old suggestion; dismissing it does not erase the old decision or mutate workers.
Do not publish private chain-of-thought as observability: record concise rationale,
input evidence and outcomes, not hidden reasoning traces.

Use deterministic coalescing and limits before calling the model. Reanalysis of
the same evidence must not form a self-triggered loop. Unknown prices remain unknown;
do not infer an exact cost or worker completion from absent data. Display supervisor
failure even if its model cannot run, through a deterministic health projection.

## 5. Later native decision dashboard — SG-003

SG-001 first ships the native main-Bot conversation with basic process, connection
and model readiness/errors. The complete decision dashboard below is additive,
not a dependency of that chat milestone. MVVM applies from the first UI change.

The DSH panel asks, in order: what needs me, is the system healthy, and what is the
history of this work (`docs/005-panel.md`). Preserve those questions, not its web
tabs, PR vocabulary or DSH controls. Use SwiftUI/AppKit and EagleDesign in the Eagle
shell; do not embed a web dashboard or introduce another style system.

| Native surface | Required content when delivered | Read-only actions |
| --- | --- | --- |
| Overview / Needs attention | Prioritized suggestions, evidence freshness, what decision is requested | Read evidence, mark reviewed, dismiss or defer a suggestion in supervisor state |
| Workers | Observed state, last observation, source availability, warnings with provenance | Open a passive evidence/history viewer, filter; no worker controls |
| Decision detail | Triggering observation, evidence references, concise rationale, uncertainty, revisions and human disposition | Inspect original evidence; record a local decision explicitly marked not executed |
| Superagent health | Running/paused/failed, observation lag/gaps, analysis state, retry budget and measured usage | Pause/resume observation or analysis; retry only supervisor-owned reads/analysis |
| History | Observation -> analysis -> suggestion -> human decision timeline | Search/filter and navigate evidence, without replaying worker work |

Healthy state takes little space. A counter equals the list behind it. Source
connection, worker health, analysis health and model uncertainty are separate axes.
A stale observation cannot become a green "healthy" badge because a request failed.

Human decision support is useful before automation: the owner can understand and
act through the ordinary worker UI manually. The dashboard must not disguise a
worker mutation as "refresh", "inspect", "acknowledge" or "accept". Its evidence
viewer uses the passive port; simply opening ordinary chat today can open/resume a
worker, so passive evidence navigation must not accidentally take that path.
In particular, the existing worker `AppViewModel.start()` auto-selects a Bot and
opens its chat. The dashboard needs its own read-only ports/ViewModel rather than
reusing that startup path or retaining a writable ConversationPort.

No approved suggestion is an implicit dispatch. Later execution controls require
a separate accepted capability and explicitly executed action, with receipts.
The first dashboard should not show disabled future controls as if they were ready.

### MVVM ownership

```text
Native View -> Superagent ViewModels -> domain use cases / ports
                                               -> transport adapter -> service
Service facts -> reducer / read model -> ViewModel -> Native View
```

- **Model:** typed facts, inference labels, suggestion versions, disposition rules,
  freshness and pure reducers; no SwiftUI, URLSession or pi types.
- **ViewModel:** observable screen state, selection/filtering and explicit intents;
  injected ports, cancellation and generation fences for late responses.
- **View:** renders state and forwards intent; no networking, model calls, retry
  loops, storage mutation or task classification in `body`.
- **Transport:** owns authentication, wire DTOs, version checks, paging and gaps;
  views and domain logic never decode frames themselves.
- **Design:** existing EagleDesign tokens and controls; no copied palette/control
  layer. Keep updates compact and coalesced, and do parsing off the UI actor.

The dashboard and main conversation may share supervisor read models, not mutable
view state or two writable drafts. Closing a view detaches UI work, not the
Superagent service or a worker. MVVM tests prove late results cannot revive a
closed view or overwrite a newer selection.

## 6. Strict contracts and TDD gates

Before implementing an active spec's operation, define its normative schema and
fixtures: field meaning, identity, ordering, count/byte limits, freshness,
cancellation, authentication, error types and version policy. Freeze the SG-001
process/chat contracts first; worker observation contracts belong to SG-002.
Publish fixtures for both producer and consumers; do not import provider domain
classes into consumer tests. SG-001's detailed requirements and acceptance IDs
are in its [active spec](specs/SUPERAGENT-001-CHAT.md).

Use the existing test stack, fake clocks and scripted models. Avoid a new test
framework or a generic event-bus platform. Each behavior starts with an observable
failing test, then the smallest implementation, then affected gates. Existing
fixture and CI enforcement remains in effect; no skip/focus or weaker threshold.

The matrix applies when each capability is introduced, not all before SG-001:
process/chat/auth/isolation/MVVM gates apply now; worker observation and analysis
rows become gates for their later specs. Diagnostic errors are never deferred.

| Test level | Mandatory evidence |
| --- | --- |
| SG-001 foundation and chat | Real independent startup, ownership/readiness/shutdown, own durable streaming conversation, native chat and zero worker calls/writes |
| Architecture guards | Superagent imports no worker core/runtime/storage or objects; worker imports no supervisor domain concept; shared pure helpers and normative fixtures are allowed; no View networking/business rules |
| Producer conformance | Same fixture contracts over real local transport; cold reads do not call runtime open/resume or mutate execution |
| Consumer conformance | Supervisor handles valid/invalid/gapped/expired/out-of-order observations with honest coverage |
| Pagination | Frozen boundary, complete retained history including pre-compaction, stable order, no missing/duplicate entries, explicit unavailable data |
| Noninterference | Cold, warm and pending-work reads do not change prompts/tools/session entries, origins, notes, exchange answers or webhook secrets; no models, idle leases or observer backpressure |
| Isolation | Workers pass their gates with supervisor absent; supervisor starts with no worker source; supervisor faults do not change worker business state |
| Recovery | Crash between observation, cursor, analysis intent and suggestion; replay does not duplicate human notifications |
| Security | Observation credential refuses every mutation; old chat commands/peer tools cannot be used as a fallback; no secrets in logs or read results |
| Native MVVM | Pure reducer tests, fake-port ViewModel tests, no auto-open on launch/selection, cancellation/stale-response cases and truthful dashboard counts |
| End-to-end | Two unchanged-behavior workers, real passive reads and supervisor analysis, one native decision, zero worker-side writes attributable to supervision |

Noninterference tests compare worker domain state and instrument model/tool/runtime
calls. Logs and credential-use records are excluded only by the explicit allowed
bookkeeping list, not by broad filesystem exclusions. Inject a slow or failing
observer to prove worker progress is independent. With separate processes now
selected, real independent crash/stop/restart tests are required in addition to
in-process fake failures.

No tests or App acceptance ran in this documentation update. A future daemon/UI
change must run the affected independent package gates and actual native acceptance;
documentation is not evidence that these protections already work.

## 7. Delivery sequence and later automation

The owner changed the order to **foundation -> native chat -> added capabilities**.
The previous passive-read-first sequence is superseded. Only SG-001 is the active
draft spec; later rows describe future outcomes, not a requirement to write or
implement the entire platform before chat works.

| Milestone | Scope | Exit evidence / dependency |
| --- | --- | --- |
| SG-001: independent native chat — **delivered, owner-accepted** | Executable/storage foundation -> own pi-durable chat -> App launcher and native MVVM conversation | Start with workers absent; converse in the App; restart retains own history; bounded stop/errors work; zero Superagent-to-worker calls or writes. Residual: packaged App, forced-quit/crash matrix, two-window manual run |
| SG-002: passive worker evidence | Freeze snapshot/history/changes contracts, prove inert cold reading, add authenticated bounded observation in the worker service's existing read infrastructure | Complete retained worker history and honest coverage without open/resume/configure, idle retention or worker mutation; SG-001 remains usable |
| SG-003: analysis and native decisions | Bounded evidence-backed analysis, suggestions, evidence details and human decision dashboard | One auditable suggestion and decision from real observations, with budget/replay controls; worker state unchanged |
| SG-004: proactive supervision and richer observability | Change-driven analysis, rechecks, dedupe, source/analysis diagnostics and recovery timeline | Useful unattended suggestions, no self-trigger loops, explicit gaps/staleness, proven recovery and bounded resource use |
| Future management, separately enabled | A later command spec for authorized delegation/remediation | Strict write contract, grants, receipts, cancellation and acceptance tests; not an automatic continuation of these read-only milestones |

### Spec-driven delivery

[SG-001](specs/SUPERAGENT-001-CHAT.md) defines the first outcome, non-goals,
requirement IDs, App chat boundary, slices and acceptance scenarios. Before a
slice's code, resolve its technical choices in the spec and freeze its fixtures.
Review -> failing behavior -> smallest implementation -> affected tests -> atomic
commit -> acceptance evidence. If behavior changes, revise the spec/tests first.
The architecture and previous reviews are not substitutes for that active spec.

SG-001 is delivered in four runnable slices:

1. **SG001-A:** standalone executable, own root/identity, readiness and shutdown.
2. **SG001-B:** own durable chat, configuration and authenticated local protocol.
3. **SG001-C:** App-owned launch plus a permanent, conversational native Super Bot.
4. **SG001-D:** complete milestone acceptance with isolated CLI/process tests and
   a hand-inspectable App; report scripted, real-model and rendered evidence separately.

The first executable proof is independent start -> health -> stop -> reopen with
workers absent. The first user milestone is a real two-turn conversation in the
App, not only a ready process or an empty chat screen. No worker read-adapter spike,
full-history API or complete Dashboard is a prerequisite for SG-001.

### Capability-specific gates

SG-001 includes auth, process/storage ownership, bounded chat, durable admission,
basic failure visibility and MVVM tests from the start. Rich observability is later;
a broken startup or chat must still be diagnosable now. Worker calls/writes must be
zero, which is stronger than merely promising that an observation is harmless.

SG-002 is where the passive cold-read proof becomes mandatory. If it cannot meet
the full-history/noninterference contract, stop that capability, not the working
chat product. The proof is about observable behavior, not code location: reusing the
worker service's own read path is the intended way to satisfy it. Do not replace it
with an active chat subscription or private SQL in the Superagent. SG-003 must prove
analysis budgets and evidence/decision durability
before enabling its model-driven feature. SG-004 extends these controls to unattended
work rather than introducing safety for the first time.

One integrating writer owns changes on main; reviewers remain read-only. Each
boundary change receives explicit base/head review, at most three review/fix rounds,
with incremental follow-up. Each coherent slice ends with affected checks and an
atomic commit. Run required broad gates at integration milestones, never weaken them,
and give the new independent service its own explicit gate. Every macOS code change
ends with the required inspectable dev App; long implementation keeps the required
user-view checkpoints. No implementation or running-product evidence is claimed here.

Later command design must preserve independent operation. Commands cross a narrow,
versioned, authenticated port with stable action IDs, grants, cancellation fences,
receipts and unknown-outcome semantics. Worker-side implementation may translate
that public command into its own InvocationPort; the Superagent never imports or
calls the in-process ConversationService or RuntimeHandle.

Explicit delegation authority does not come from quoted history. User stop prevents
resurrection; stale reports do not advance a newer assignment. Runtime `done` stays
distinct from business acceptance, and external unknown effects are never blindly
replayed. Retain the DSH ideas of authorization, ownership, follow-up, evidence and
low-noise delivery without importing its execution engine.

Do not add dormant write tools or obtain a write credential now. A disabled button
is not an adequate boundary. The future managed-work scope, worker report format,
resource serialization and command methods require a separate contract and failing
tests before they exist. Human-priority serial worker execution remains the owner's
accepted requirement for that future managed phase.

## 8. Accepted decisions and remaining implementation gates

Accepted: default nondeletable main Bot; all retained histories visible; ordinary
questions answered directly; execution delegated eventually; new goals suggested
first; App-scoped first release; worker execution serial with human priority when
management is introduced.

New accepted principles: independent Superagent and workers; narrow strict
interfaces; standalone operation in both directions; read-only observation first
with unaware workers; native human decision dashboard; MVVM UI and TDD backend.

The owner subsequently confirmed separate App-owned processes and separate stores.
The owner then selected spec-driven, process-and-chat-first delivery. SG-001 must
start independently and provide native App conversation before worker observation
or the full Dashboard is added. On 2026-11-08 the owner scoped that independence to
SG-001: SG-002 and later reuse the worker service's existing infrastructure behind a
clean, versioned interface instead of duplicating a provider or read adapter. Exact
active-spec schemas, IPC/authentication and
lifecycle remain implementation gates; passive cold reads are a later SG-002 gate.
No capability is represented as already implemented or verified.

## 9. Design review record — 2026-11-07

An independent read-only Pi reviewer (`group/reviewing`, `xhigh`) reviewed the design
content committed as `f79033d3`, covering this document, `MAIN-BOT-RESEARCH.md`
and the Superagent entry in `PLAN.md`. Its final verdict was **PASS (document
review)**: no concrete semantic conflicts or missing necessary acceptance items
were reported in that pass.

The review checked independent identity and standalone operation, worker
unawareness, phase-1 prohibition of commands, passive-read side effects, credential
scope, retained-history coverage, paging/cursors/gaps, noninterference tests, native
MVVM and removal of the earlier dispatch-first plan. It also checked that topology,
exact schemas and the read-adapter spike were not represented as verified runtime
capabilities. The owner's later topology confirmation resolves that product choice;
it is not a new runtime verification or a second review pass.

That historical review predates the owner's subsequent chat-first sequence and
SG-001, so it does not approve their detailed contracts. A new independent
`group/reviewing` / `xhigh` document review covered the SG-001 draft and synchronized
architecture/research/PLAN changes over base `09985c0d`, returning PASS. Its scope
and remaining freeze items are recorded in [SG-001](specs/SUPERAGENT-001-CHAT.md#8-current-evidence).

Neither review is an implementation, conformance-suite, process-isolation, live-model
or native-App acceptance result. Those gates remain required before the corresponding
feature can be claimed complete.
