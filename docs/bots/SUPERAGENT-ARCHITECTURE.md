# Superagent — independent observation and native decisions

Status: **accepted product principles; proposed technical contract; not implemented**.
The owner added the independence, read-only-first, native dashboard, MVVM and TDD
requirements on 2026-11-07. They supersede the integrated-coordinator rollout in
[the research](MAIN-BOT-RESEARCH.md). The earlier product choices still apply,
but autonomous worker management is a later capability, not the first release.

## 1. Product and independence invariants

The Superagent is the default, nondeletable main Bot in the Eagle UI. It is not a
privileged worker and does not become an owner of worker runtime internals.

| Requirement | First-release contract |
| --- | --- |
| Independent execution | Own Harness, model turns, queue, storage, observation cursor, budget and lifecycle; no worker session owns it |
| Workers run alone | Starting, chatting, tools, recovery and shutdown require no Superagent, its storage or acknowledgement |
| Superagent runs alone | It starts, chats and shows its dashboard without workers; live observations are unavailable and retained facts are marked stale |
| Worker unawareness | No Superagent persona, tools, report hooks, task wrappers, new prompts, required acknowledgements or model-visible messages in workers |
| Read-only toward workers | No send, steer, promote, abort, recover, retry, configure, trigger mutation or delegation, including indirect calls |
| Full-history visibility | Main Bot can query all Bots' complete retained conversation history, not only managed-task evidence or current UI windows |
| Conversational role | Answer the owner, analyze evidence and make suggestions; no general shell/coding execution role |
| App-scoped lifetime | First version runs while the App runs; no new login/background service after App quit |
| Human decisions | Native decision dashboard, not only chat or raw logs |
| Engineering | MVVM presentation; backend behavior developed with failing tests first |

Read-only is a relationship, not inactivity: the Superagent may call its own model,
write its own analysis and decision history, remember a dismissal, and notify the
person under its own budget. None of those operations writes into a worker.

Independent hosts may use the same pi-durable library. That is not another bespoke
execution engine. They must not share live Harness handles, queues, writable
session databases, lifecycle leases or an in-memory service container. Pure wire
contracts and tested stateless presentation utilities may be shared; neither core
imports the other's core, runtime or repositories.

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
documentation update. Exact paths/wiring and the passive-read adapter still require
implementation and verification, but the topology choice is settled.

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

## 3. A narrow, passive observation boundary

```text
Worker runtime / stored history
    -> generic passive observation provider
    -> versioned read protocol
    -> Superagent observation adapter
    -> local evidence and decision store -> bounded model analysis
    -> supervisor read model -> native MVVM dashboard / main conversation

There is no Superagent -> worker command path in the first release.
```

The provider belongs to the worker service's generic read infrastructure, not to
worker model behavior. It may add an inert observation endpoint/projection; it may
not require workers to call a reporting tool or import Superagent domain concepts.
"Unaware" means no behavioral dependency or supervision-specific execution code,
not that an authenticated read never reaches the worker service's transport.

The Superagent cannot reach worker implementation objects, inspect worker SQLite
schemas, attach a second Harness to worker storage, or parse private log/session
formats. Any SDK/storage-specific reader stays behind the provider-owned adapter.
A raw filesystem sidecar would merely replace call coupling with schema coupling.

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

These are the complete candidate interface families for phase 1. Names below are
domain sketches, not already implemented endpoints. Freeze their exact wire
schemas, numeric limits and error fixtures before implementation.

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

## 4. Read-only supervision and evidence

The first release may:

- Observe all workers through the passive contract without changing their execution.
- Read complete retained history on demand using bounded queries.
- Identify possible blockers, missing evidence, repeated failures or conflicting work.
- Explain a suggestion with cited evidence and uncertainty.
- Answer the owner and record human decisions in supervisor-owned state.
- Recheck a suggestion after a new observation or an owner-requested analysis.

It may not ask a worker for status, send a reminder, modify a trigger, retry a failed
run, change a model, assign work, or silently apply a suggestion that the person
marked useful. In phase 1, even a direct request to delegate produces a proposal
and a clear "not executed" result, never a hidden worker command.

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

## 5. Native decision dashboard, not a log viewer

The DSH panel asks, in order: what needs me, is the system healthy, and what is the
history of this work (`docs/005-panel.md`). Preserve those questions, not its web
tabs, PR vocabulary or DSH controls. Use SwiftUI/AppKit and EagleDesign in the Eagle
shell; do not embed a web dashboard or introduce another style system.

| Native surface | Required content | Phase-1 actions |
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
Native View -> SuperagentDashboardViewModel -> domain use cases / ports
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

Before implementation, each operation needs a normative schema and fixtures that
fix field meaning, identity, ordering, count/byte limits, freshness, cancellation,
authentication, error types and version policy. Publish fixtures for both producer
and consumers; do not import provider domain classes into consumer tests.

Use the existing test stack, fake clocks and scripted models. Avoid a new test
framework or a generic event-bus platform. Each behavior starts with an observable
failing test, then the smallest implementation, then affected gates. Existing
fixture and CI enforcement remains in effect; no skip/focus or weaker threshold.

| Test level | Mandatory evidence |
| --- | --- |
| Architecture guards | No cross-core/runtime/storage imports; no worker dependency on supervisor; no View networking/business rules |
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

| Stage | Usable result | Exit condition |
| --- | --- | --- |
| 0: passive contract spike | Proves the observation boundary can serve complete history without opening workers | Normative fixtures, real adapter noninterference tests, explicit capability gaps |
| 1: independent identity and read-only native dashboard | Main Bot exists, reads all histories, answers and presents actionable suggestions | Independent startup, passive evidence viewer, supervisor health, local decision history, MVVM/TDD gates |
| 2: read-only supervision quality | Bounded recurring analysis, freshness, low-noise notification and robust recovery | Deterministic loop/race tests plus real model and App evaluation reported separately |
| Later: explicitly enabled management | Delegation and remediation of authorized work | A separately specified, tested command capability; not an automatic phase-1 upgrade |

The first read-only release is a complete, accepted product slice. It does not claim
to implement the eventual autonomous-management goal. This replaces the earlier
statement that automatic delegation must be the first minimum useful release.

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
No product choice remains open in this decision set. Exact schemas, passive cold
reads, IPC/authentication and process lifecycle are implementation gates, not
already proven capabilities.

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

This records a design review only. No implementation, conformance suite, process
isolation test, live model evaluation or native App acceptance has passed on its
strength. Those gates remain required before the feature can be claimed complete.
