# Main Bot — research and architecture proposal

Status: **owner decisions accepted on 2026-11-07; implementation pending**.
Section 10 records the five product choices the owner confirmed after the research.
The technical architecture remains a proposal, not implemented behavior. No runtime
permissions, model configuration or daemon lifecycle have changed. The existing
contracts remain authoritative until an implementation updates them explicitly.

## 1. Recommendation

Make the main Bot an Eagle-owned, nondeletable catalog identity with an ordinary
conversation and a bounded supervision capability. Keep pi-durable as the only
execution runtime. Add the missing business responsibilities above it: authorized
work, ownership, structured reports, evidence, follow-up, and accountable actions.

Do not embed the pi-superagent daemon, Engine, PiSessions or CLI inside Eagle. Do
not implement the feature as a prompt plus a repeating `peer_send` loop.

The central distinction is:

> A model run ending is not a task finishing. A Bot receiving information is not
> that Bot receiving authority. Being the main Bot is not permission to do anything.

The owner chose a conversational coordinator: the main Bot answers ordinary
questions directly and delegates execution to existing Bots. It manages delegated
work within its grant and suggests new goals before starting them. It can read all
Bots' complete histories, but that visibility grants no new execution authority.
The first version runs with the App and serializes each Bot's execution, with
human priority at safe boundaries. Section 10 records these accepted choices.

## 2. Research baseline and upstream result

Inspected on 2026-11-07:

| Surface | Immutable baseline |
| --- | --- |
| Eagle | `6f1d2b16afe5da525c6382754b223218725c76ab` |
| pi-superagent | `2da25bb3cd522853f9565f48695ca271307c514f` |
| Local DSH reference | `6337fc823ce20251c8de8085948165c81aaa701e` |
| DSH upstream `main` / `HEAD` | `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` |
| Eagle execution dependency | `@earendil-works/pi-durable@1.4.0` |

**Upstream has no changed source in the checked main snapshot.** Both DSH commits
have the identical tree `3efbb036e5a56183c6bf642e2e1856a1f64e7be3`, no parent, the
same author timestamp and the same message. Only the committer timestamp differs:
20:05:39 versus 20:06:31, UTC+08:00, on October 31. Upstream's reachable main
history contains one commit. A direct `git diff --exit-code OLD NEW` returned 0.
This is a replacement root commit, not a fast-forward feature update.

The remote was inspected in a temporary clone. The local reference checkout and
its refs were not updated. This result concerns the checked default branch, not
unpublished internal work or the research article's aspirations.

Source abbreviations below:

- **E**: this repository at the Eagle baseline.
- **P**: `/Users/nocoo/workspace/personal/pi-superagent` at the Pi baseline.
- **D**: `deepseek-ai/dsh-superagent-prototype` at the upstream SHA above.

## 3. How macOS Bots actually runs

```text
Eagle App / BotsDaemonSupervisor
  -> local Node process, or adoption of an existing compatible daemon
  -> HTTP catalog/settings + authenticated WebSocket conversation
  -> BotsTransport -> BotsCore reducer -> BotsFeatures view models
  -> EagleFeatures sidebar / transcript / inspector

Node daemon composition
  -> BotDirectory + BotRegistry: catalog, lifecycle, leases, recovery
  -> ConversationService: one admission chain, origins, views, fanout
  -> RuntimePort / PiDurableRuntime
  -> one pi-durable Harness and session.sqlite per catalog Bot
       root conversation + child/reflection conversations
       model generations, tool tasks, inbox, compaction, recovery
```

The UI is a client, not the agent scheduler. Closing a conversation connection
leaves work running. Quitting the App normally stops its owned Bots daemon:
`BotsDaemonSupervisor.swift:177-188` and `EagleApp.swift:72-73`. The separate device
helper staying alive does not keep the Bot models or their supervisor alive.
A persistent SQLite file is restart recovery, not an always-running service.

Important existing capabilities and their limits:

| Capability | Actual behavior | What it does not establish |
| --- | --- | --- |
| Per-Bot Harness | SQLite persistence, request dedupe, retry, compaction, task recovery | A business objective or its acceptance criteria |
| `InvocationPort` | Connection-free admission, stable request ID, origin, submission lookup | Task ownership or authority to manage another Bot |
| Schedule/webhook triggers | Durable cursor, frozen batches, pump and reconciliation | An automatically installed global supervisor |
| `peer_list/send/read` | Independent catalog Bot communication and caller-owned receipts | Automatic return notification, work completion, general transcript access |
| `agent_spawn/send/stop` | Same-Harness child conversations, one delegation level | Other sidebar Bots or a fleet-wide worker model |
| Runtime task graph | Live generation/tool/compaction task state | A durable business work list; terminal tasks leave the graph |
| Reflection | Before settlement, bounded fork considers `note_set` | Quality review, cross-Bot supervision or general self-improvement |
| `ask_user` | A structured question; answer is a later hidden input | A capability approval or a host-enforced work pause |
| Shared device port | Existing execution policy, approvals and operation receipts | Permission for the main Bot to approve itself |

Evidence: E `apps/bots/src/main.ts:291-663`,
`core/Invocation.ts:1-44`, `core/ConversationService.ts:599-690`,
`runtime/pi/PiDurableRuntime.ts:257-440`, `runtime/pi/reflection.ts:34-39`,
`tools/ask.ts:10-15`, `tools/agents/tools.ts:177-280`, `peers/host.ts:78-176`.

Some documents retain historical phase-1 or planned paragraphs. Current source
has peers tools and HTTP exchange views even though `capabilities.peers` is false;
that flag is not an authorization boundary. Likewise, current tasks, agent and
usage capabilities are enabled. Treat a historical status heading as evidence of
history, not proof of the current implementation.

## 4. What DSH contributes, and what the Pi port changes

### The reusable DSH loop

```text
Source -> immutable Trigger / Thread
  -> existing owner's follow-up, or deterministic admission gate
  -> model assessment -> recorded Decision + immutable Mandate
  -> Ticket -> Assignment -> Executor
  -> structured Report / question / external evidence
  -> policy-scoped continuation, original-channel result, or human handoff
```

The strongest ideas are responsibility and continuity, not a more forceful model:

1. Explicit requests and inferred opportunities have different authority.
2. Inferred work starts in observe mode and requires an enabled rule before auto.
3. Tickets outlive execution attempts and model sessions.
4. Existing workers own follow-ups; handback returns out-of-scope work for routing.
5. Context subscriptions convey information, never new permission.
6. Admission, delivery, consumption, reporting and acceptance are distinct facts.
7. Effects and outgoing replies are persisted before delivery.
8. Paused processing, blocked work, runtime failure and human stop differ.
9. Human stop withdraws continuation authority; machine events cannot revive it.
10. Questions and useful results deserve attention; routine progress usually does not.

DSH's two-second pass advances deterministic effects and evaluations. It is not
a two-second LLM heartbeat. Its public Sources are GitHub and Feishu; it does not
provide a universal autonomous goal planner or general cron product. Time-based
conditions belong to an event producer, not a model that blocks in `sleep`.

Evidence: D `docs/000-philosophy.md:5-15`, `src/app/passes.ts:23-67`,
`src/core/engine.ts:75-85`, `src/core/model.ts:126-305`,
`src/core/intake.ts:38-57`, `src/core/tickets.ts:289-413`,
`src/app/notices.ts:107-128`, `src/core/replies.ts:48-90`.

### Comparison

| Dimension | DSH prototype | pi-superagent | Eagle today |
| --- | --- | --- | --- |
| Runtime | DSH/Cordis sessions and presets | pi-coding-agent SDK sessions | pi-durable Harnesses |
| Coordination | Persistent main Session | Persistent `coordinator` Session | No built-in coordinating identity |
| Execution identity | Worker per Ticket | Worker per Ticket | Long-lived catalog Bot plus internal children |
| Domain state | Ticket/Mandate/Assignment in SQLite | Almost unchanged DSH domain core | Catalog, submissions, triggers, exchanges |
| Proactivity | Sources + gate + rules + assessments | Same domain, GitHub/IM/inbox | Bot-owned triggers; no fleet responsibility |
| Recovery | Domain effects plus DSH session/inbox recovery | Effects plus persistent JSONL and assignment restart | Native durable generation/tool recovery plus host journals |
| Background work | Tracks jobs/subagents and worker slot ownership | No equivalent full background supervisor | Native durable tasks; external process ownership still limited |
| Human interaction | Original GitHub/Feishu conversation and panel | CLI/local channels and web management | Native macOS conversations and cards |
| Generality | Single-repository coding deployment | GitHub optional, generic Inbox and work prompts | General local Bots and shared devices |

The Pi port really is a substantial decoupling: it has no DSH dependency, can run
without a GitHub repository, and has generic IM/inbox inputs. Its `src/core/`
differs from the reference in only four files, with eight added and four removed
lines in the inspected snapshots. It uses `@earendil-works/pi-coding-agent`, not
pi-durable. Coordinator assessments and notifications share a serial session;
workers use persistent `worker-<ticketId>` session files.

The port does not preserve all DSH executor behavior: background job/subagent
tracking, the extra human-priority slot, and business-level transient recovery
are reduced. Coding assumptions also remain in default rules, assessment fields,
worktree naming and PR completion handling. Translate those semantics rather than
copying the host or renaming its classes.

Evidence: P `src/agents/pi-coordinator.ts:28-90`,
`src/agents/pi-executor.ts:30-80,124-214`, `src/agents/sessions.ts:55-85`,
`src/policy.ts:19-31,61-64`, `src/runtime/host.ts:123-133`;
D `src/executor/dsh.ts:170-198,547-575,584-673`.

### Do not import guarantees the prototype does not have

DSH has no nondeletable Bot entity, independent universal completion verifier,
semantic long-term memory system, self-deploying policy improvement, or OS sandbox.
Its `core/memory.ts` is an in-memory repository implementation, not agent memory.
`ready` is primarily a worker report, not independently verified evidence.
Prompts carry several review/merge requirements that the host does not enforce.
The DSH prototype has no persistent fleet-wide cost/turn budget; general effects
can keep retrying, and investigation/implementation has no fixed total round cap.
Both original and port have privileged configuration tools whose human-intent
claims are not a cryptographic or host-issued approval.

Retain the philosophy, but improve these boundaries in Eagle rather than inherit
them. Keep Eagle's memory and reflection facilities; do not call the existing
sidebar-note reflection a quality reviewer.

## 5. Proposed Eagle architecture

### 5.1 A system identity, not a special title

Add a host-owned immutable role, for example `systemRole: "coordinator"`, and a
reserved stable Bot ID. These are illustrative field names, not an API commitment.

- Exactly one coordinator per canonical daemon root, not one per window or device group.
- Ensure it during serialized catalog initialization, before runtime recovery.
- Its history, model and appearance remain normal Bot-owned data.
- Refuse removal in the domain deletion boundary, before taking leases or moving files.
- Refuse role/identity replacement through ordinary create/update/import paths.
- Publish capabilities for UI affordances; hiding Delete is not the enforcement.
- Reserve capacity for it; a full ordinary catalog must not prevent initialization.
- A valid catalog without it may initialize it. Corrupt storage must fail visibly,
  not be interpreted as a fresh installation and silently discard history.
- Allow pausing supervision and changing its model. Nondeletable does not mean
  uninterruptible, unconfigurable, always generating, or immune to storage failure.

Application-level nondeletion cannot prevent an OS user or unrestricted shell
from deleting files. Do not market it as filesystem tamper resistance.

### 5.2 Keep the runtime; add a small business control layer

```text
Bot reports / settled submissions / failures / due checks
  -> CoordinationService: durable facts, ownership, policy and coalescing
  -> bounded decision run in the main Bot's pi-durable Harness
  -> typed action proposal
  -> host authorization + current-state check + action receipt
  -> InvocationPort -> target Bot's existing runtime adapter
  -> report / result -> durable notification -> next decision or human handoff
```

Proposed ownership:

| Layer | Responsibility |
| --- | --- |
| `core/coordination` | WorkItem, Grant, Assignment, Report/Evidence, decisions, attention, action receipts |
| `coordination/` composition | Event production, reconciliation, low-cost wake scheduling, host bindings |
| `runtime/pi/` | Internal conversations, native tasks/documents, model runs, recovery and event conversion |
| `tools/coordination` | Narrow typed management/report tools; identity comes from the host |
| `protocol/`, `server/` | Additive read models, authenticated human controls and revision semantics |
| BotsCore / BotsFeatures | Work and attention models, pure folds, view models |
| EagleFeatures | Pinned main Bot, task cards, concise attention and activity views |

Core must not import pi-durable. Runtime must not become the owner of the catalog
or product policy. Use a typed host port, as existing peer/trigger tools do.

A small root-owned SQLite coordination store is a suitable recommendation for
cross-Bot product state and atomic decision/outbox writes. It is not another
session database or execution engine. pi-durable still owns transcripts, model
inboxes, generation/tool task checkpoints, retry and compaction. Store references
to transcript entries and artifacts rather than duplicate all conversations.

There is no transaction spanning that store and every Bot's separate Harness.
Use write-ahead intents, stable IDs and reconciliation; do not claim cross-Harness
atomicity or arbitrary exactly-once side effects.

### 5.3 Distinguish identity, work and conversation

A Bot is a long-lived participant with its own model, tools and memory. A WorkItem
is an authorized objective. An Assignment is one executor's responsibility for
that objective. A conversation is the context in which that responsibility runs.

Recommended target:

- Main Bot root: human conversation, with normal responsiveness and result cards.
- Main Bot supervision conversation: bounded internal decisions, not a new Bot.
- Worker Bot root: its existing human conversation.
- Managed WorkItem conversation: stable within the assigned worker's Harness,
  reused across execution attempts; bound to its grant by the host.
- An optional short reviewer conversation: bounded and owned, used only when
  the acceptance policy needs it; not an always-on second supervisor.

This avoids injecting background reviews into the person's FIFO chat queue and
avoids combining unrelated task authority in one mutable conversation. Start with
one active managed Assignment per worker Bot; keep ordinary human chat available.
The owner chose serialized execution turns per Bot, with human priority at safe
boundaries, without aborting managed work merely to switch chats. Separate
conversations do not isolate files, accounts or external services. Parallel
execution needs an explicit resource-conflict policy; separate working directories
alone would not establish it. A safe boundary also accounts for background jobs:
a model turn ending does not stop their writes. Before handing conflicting
resources to a human turn, those jobs must finish, pause, or be proven nonconflicting.

Independent catalog Bots must not be reclassified as `agent_*` children. Native
child tasks and task-owned conversations are useful inside one Harness, but their
ownership and cancellation do not span other Bots' SQLite files.

**This is a real adapter change.** Today's InvocationPort targets only a Bot's
root conversation. Add a host-only typed conversation scope with durable lookup,
origin, lease, status, cancellation and observation semantics. Scope must also
cover history, cursors, question answers, configuration and admission budgets;
Bot-level busy is only the lifecycle aggregate. Do not let a client supply an
arbitrary SDK conversation ID. Lookup identity is `(botId, scope, requestId)`;
pi dedupes within a conversation, not across the whole Bot.

Bind assignment ID, fencing epoch and grant ID durably to the invocation and its
actual generation/tool tasks. Never infer authority from a conversation's latest
assignment: an old tool or report may finish after reassignment. Before replacing
an attempt, settle or explicitly fence its pending input and owned background work.
A timeout is not proof the old execution stopped. A Grant is immutable; revocation
is a separate host-owned fact, not a model edit to the Grant. Late reports retain
their original assignment, attempt and grant epoch. Keep stale reports as audit
evidence, but do not let them advance current work, satisfy acceptance or trigger
a fresh action after cancellation or reassignment.

Direct user chats are initially observations, not automatically accepted tasks.
The main Bot can notice a problem and propose adoption. A user delegation or an
approved standing rule creates the WorkItem. This prevents a casual conversation
from becoming an unsolicited autonomous project.

### 5.4 Minimal product state

| Record | Essential facts |
| --- | --- |
| WorkItem | Goal, acceptance criteria, origin, owner, dependencies, state, revision |
| Grant | Explicit delegation or standing rule, scope, permitted actions/targets, policy revision, revocation |
| Assignment | WorkItem, Bot, stable conversation, attempt, request/submission IDs, current owner |
| Report | Progress/wait/blocked/failed/ready, question if any, evidence references, source run |
| Decision/action | Evidence revision, reason, action key, authorization, delivery/outcome state |
| Attention | One current question or actionable problem, owner, resolution, notification identity |

Reports and verification evidence should be append-only facts; the current card
is a projection. Keep model-authored claims separate from runtime observations and
independent checks. Do not use a model's sidebar note as proof of progress.

Illustrative work states:

```text
proposed -> authorized -> assigned -> running
                             -> waiting_external / waiting_human / blocked
                             -> ready_for_review -> completed
any live state -> cancelled (explicit revocation)
```

Keep runtime health on a separate axis. A crashed runtime does not make the goal
failed forever; an idle runtime does not make it complete. `submission.done`
means answered. Even an independently reviewed answer may remain awaiting the
owner's acceptance, depending on the stated criteria.

## 6. The proactive loop and its safety properties

### Events first, deadlines second, no model heartbeat

Wake on a new authorized goal, structured worker report, committed result,
classified failure, overdue dependency, changed relevant artifact, or resolved
human question. Suppress token deltas and routine tool progress. Use deterministic
coalescing by work/reason/evidence revision before considering a model call.

Use the existing trigger infrastructure for user schedules. A narrow supervisor
producer handles work deadlines and startup reconciliation. One layer must own
each deadline: either a host producer or a native durable sleeping task, never
both. Persist the deadline and work revision in the product ledger; any timer
only wakes a recheck against that authority. Missed recurring schedule ticks may
be skipped, as today, but an overdue work obligation must be reconciled after
restart rather than discarded under the schedule's 90-second freshness rule.
A model does not poll `peer_read` or wait for time inside a turn.

Native `defineTask` / `sleepUntil` can persist internal waits. They do not wake a
terminated process, and closing an idle Harness removes its in-process timers.
The host therefore needs a known wake/reopen path, or an explicitly retained
coordinator Harness. This lifecycle choice must be proven, not inferred from the
existence of durable sleep.

### Observation must survive missed UI events

Today's `observe()` exposes only a running boolean; an unopened Bot can report
false. WebSocket `rev` and bounded snapshots are delivery mechanisms, not a durable
audit feed. Add narrow committed observations and durable reconciliation keys.

For managed work, bind a stable assignment before admitting its input. Record the
source submission/report and consume it idempotently. If the daemon crashes after
an answer commits but before its notification, reopening must reconstruct the
missing notification by querying the original submission. A structured report
tool returns success only after the business report is durable; replay uses the
same operation ID. Commit an observation cursor together with its consumed fact
and notification intent, never before them. A live callback is only a wake hint.
Historical unregistered work may remain unknown; never invent it.

Install event/report hosts, the service and policy state before calling
`harness.resume()`. Current startup opens/recoveries happen before the service is
fully composed; a new cross-Bot recovery path must not inherit that temporal gap.
Stop producers first, drain admissions and durable writes, then close Harnesses.
The App currently allows three seconds before SIGKILL, while the daemon defaults
to a six-second close budget (`config.ts:38`); ordinary quit can therefore cut the
drain short. Reconcile this lifecycle budget when implementing, and keep recovery
correct even when graceful shutdown does not complete.

### Decide briefly; execute through typed boundaries

A decision receives a compact evidence packet and reads more only through scoped
queries. It chooses no action, clarification, assignment, bounded follow-up,
recovery proposal, verification or escalation. A structured decision records even
"do nothing" when needed for dedupe/audit. No internal prose is silently treated as
a command, completion or a message sent to the person.

The host validates current grant, identity, work revision, target and budget at
execution time. An action based on a superseded revision is rejected or re-evaluated.
User stop has a durable generation/revocation fence; queued or recovered actions
from the old generation cannot resume work.

A peer answer cannot mint authority. Preserve the existing prohibition on
non-human `steer` for ordinary root chats. If managed work needs mid-run correction,
add an explicit assignment-scoped command with grant checks; never label it human
or reuse whole-Bot abort, which also withdraws unrelated queued inputs.

### Delivery and recovery

1. Atomically persist the authorized decision and its outbound action intent.
2. Deliver through the core admission boundary with a stable action-derived ID.
3. Record the recipient's durable admission receipt.
4. Observe or reconcile that same submission; do not resend to a new target on timeout.
5. Persist its outcome and the notification intent together.
6. Publish one work/result/attention update; wake the main Bot only when useful.

An unconfirmed admission can be retried under the same key. An admitted run that
ends `unanswered` is not a delivery retry: another execution needs a new, bounded
business decision. An external side effect with unknown outcome needs its original
operation receipt or a human decision, never blind replay.

A `peer_send` receipt is useful precedent, but the current pairwise exchange is
not a durable task-return subscription. Its ten-messages-per-side limit is also
not a fleet budget; closed exchanges can be replaced by new ones.

### Safety, cost and attention

- Separate automatic remediation from new inferred work. Delegated work may be
  managed within its grant while new goals remain observe-only.
- Bound decision requests, elapsed time, retries, outstanding work, notifications
  and automated follow-ups. Persist counters across restart.
- Reserve capacity for human interactions; automation cannot consume every slot.
- Classify unknown/stale observations honestly. Time without output is not proof
  of a stuck worker, especially during a long tool call or human approval.
- Use root event/work causality and dedupe across Bot pairs, not just exchange caps.
- Suppress self-generated no-change notifications; aggregate routine progress.
  A supervision/reviewer run settling must not itself trigger another review of
  the same work revision. Deterministic reduction precedes model consideration.
- Blocked-on-human work remains held until the actual answer/approval arrives.
- Distinguish pause supervision, cancel one task, and emergency stop managed work.
- A failure of the main Bot must appear in ordinary deterministic UI health; do
  not ask the failed model to diagnose itself or restart indefinitely.

Budget enforcement needs an adapter spike. pi-durable reports and skips most
throwing generation hooks; throwing from `beforeRequest` is not a reliable hard
budget gate. The host must prove the admission/reservation and actual cancellation
boundary, including retry, compaction, reflection and child spend. Unknown model
pricing cannot support a claimed exact dollar cap.

## 7. Permissions, scope and native presentation

### Role policy must be real

Today `core` and `coding` are mandatory, and gateway tool-group changes apply to
all Bots. Adding a coordinator prompt does not remove `bash`, `write`, shared
memory mutation, remote execution or inherited child tools.

Introduce role-aware capability selection and enforcement, with ordinary worker
behavior explicitly preserved. A supervision run should receive read/work/report
management tools, not unrestricted coding tools, secrets, policy editing or device
approval. Validate the callable set, not just what the model is offered:
`modelTools` filtering alone does not remove tools from nested callers.

Management design implementing the accepted product choices:

| Operation | Design target |
| --- | --- |
| Observe Bot health and queue state | Allowed; missing or stale facts remain unknown |
| Read any Bot's complete stored history | Allowed for the main Bot through controlled history queries, not general filesystem access |
| Ask a worker for a bounded status/result update | Allowed for assigned work, with dedupe and budget |
| Delegate/review/continue a person's authorized task | Allowed inside the recorded grant |
| Start an unrelated inferred project | Observe/propose; needs a standing rule or human approval |
| Interrupt another Bot's human conversation | Not allowed |
| Delete Bots, change permissions, reveal secrets, approve devices | Not allowed |
| Change provider/model spending policy or supervision grants | Human control only by default |
| Publish, deploy, spend money or perform destructive external actions | Existing approval plus explicit action scope |

Complete-history access replaces the earlier recommendation to read only managed
work evidence. It includes retained history before compaction, not just the current
UI page or a summary. Read it through bounded, paginated queries with Bot and entry
provenance; do not inject every transcript into every model request. Unavailable or
removed records remain unavailable, never reconstructed as if they were retrieved.
This permission does not expose credential stores, enable arbitrary file or shell
access, or grant blanket onward disclosure to workers. Relevant task context may
be shared within its grant; ordinary Bots do not inherit the main Bot's global
history access. Existing secret redaction remains in force.

`ask_user` is reusable presentation, not an approval credential. A permission
answer must resolve a host-authored proposal bound to action digest, target,
revision and expiry, through a verified human control path. Do not accept a model
boolean such as `confirmed_human_request` as authorization. Development CLI
credentials can currently carry human origin; origin labels alone are insufficient
for a stronger future human-only authorization boundary.

Existing native shell/file tools are not a sandbox. Role restrictions reduce what
the supervisor can call, but do not magically confine unrestricted workers or the
OS user. Strong control-state isolation from arbitrary shell access would require
an additional execution boundary and explicit product/security work.

### First-class, not another management app

Pin the main Bot above ordinary user groups, with a visible coordinator role and
no Delete/Hide control. It still uses normal catalog identity, model selection,
usage, history and unavailable/recover behavior.

Its conversation should show useful summaries, linked work cards and one concrete
question when blocked. An activity view exposes what it observed, why it acted,
which Bot it addressed, the receipt and evidence. Healthy checks need not occupy
chat space. Workers show which work is supervised and can hand back scope conflicts.

Internal supervision inputs need an explicit protocol representation or an
internal-only lane. Do not misuse today's `hidden` answer-to-question flag, and do
not fabricate a human message. Publishing a result without another model call may
use a new typed entry projected by the adapter; current arbitrary custom entries
are not automatically visible in the transcript.

Reuse existing conversation/sidebar/inspector components, question cards and
peer exchange detail where appropriate. Add a business-work read model distinct
from runtime tasks. Keep the Bots logic package independent of Eagle UI and of the
website/Worker/Agent contracts. Preserve v1's additive wire rules and fixtures.

## 8. Example: supervision without taking over

The owner asks the main Bot to coordinate a research comparison and a local
implementation prototype, with no publication.

- The main Bot records the goal, separate acceptance criteria and a no-publish grant.
- It assigns research to Bot A and the dependent prototype to Bot B.
- Bot A's answer settles. A durable completion notification wakes supervision.
- The answer lacks an important source. The main Bot requests that missing evidence
  once; it does not report the research complete or ask the person to chase Bot A.
- Bot B waits for the accepted research. This is a dependency, not a stuck runtime.
- Bot B later needs a device approval. The main Bot surfaces the existing approval;
  it cannot impersonate the owner or switch the device to All approve.
- A runtime crash resumes the original assignment. Unknown external effects are
  queried by their original receipt, not repeated because the worker restarted.
- Both results meet the recorded criteria. The main Bot delivers one concise result
  with evidence and leaves any required human acceptance open.

This is proactive management of authorized work, not unsolicited task generation.

## 9. Delivery slices and acceptance evidence

Each slice must be end-to-end usable. No timeframe estimate is asserted here.

| Slice | User-visible outcome | Required proof |
| --- | --- | --- |
| 1: identity and observation | Main Bot always exists, chats normally, reports one meaningful fleet issue | Fresh/existing/full catalog, restart uniqueness, API deletion refusal, no-page-selected observation, pause |
| 2: one delegated task | Main Bot delegates to an existing Bot and returns the result without another user prompt | Grant and work identity, durable admission, automatic return, scoped evidence, no duplicate execution |
| 3: supervision and handoff | Main Bot notices blocked or incomplete work and manages bounded follow-up | Structured reports, acceptance evidence, no-progress dedupe, human hold, user-stop fence |
| 4: multi-Bot coordination | Dependencies and bounded reassignment, useful aggregated suggestions | Resource conflicts, human priority, cross-Bot cycle caps, stale action rejection, revoked grants |

Background operation after App quit is excluded from the accepted first version.
Closing a window may leave supervision running while the App remains alive. A
separate background service would require a new product decision, not an implicit
fifth delivery slice.

Observation-only delivery is not completion of the requested management feature;
slice 2 is the minimum autonomous delegation loop. Role/grant enforcement,
revocation fences, scoped cancellation and a proven minimum persistent automation
budget are prerequisites to enabling its first automatic dispatch. Later slices
extend these safeguards; they do not introduce them for the first time. Do not
claim hard budget enforcement until the adapter spike proves it. Design the
grant/identity/receipt boundaries first so later slices extend a working product
rather than replace it.

Mandatory scenarios include:

- Crash before admission, after recipient commit, after answer, and before notification.
- Return notification while no conversation window is subscribed.
- Model says "done" without evidence; idle/ready/accepted remain distinguishable.
- Existing human follow-up stays with its owner; out-of-scope handback creates no duplicate.
- Pause/revocation races with admission, a running tool, restart and delayed results.
- An old `ready` after reassignment, or a late result after cancellation, cannot
  complete or reactivate the current work.
- A loop of two or three Bots exhausts a durable global work budget and stops.
- Corrupt catalog, missing main model, supervisor failure and offline device remain visible.
- Supervisor cannot use nested tools, child agents or peer origins to expand its grant.
- The main Bot can page every Bot's complete retained history, including entries
  before compaction; provenance, pagination and unavailable history remain explicit.
- Ordinary Bots cannot inherit the main Bot's history privilege, and a history
  read grants neither credential access nor unrestricted onward disclosure.
- Human and managed execution on one Bot remain serialized, including conflicting
  background work; human priority does not silently abort or replay managed work.
- Closing a window leaves App-owned supervision possible; quitting the App stops
  its owned daemon. A disabled or sleeping App is not shown as actively supervising.

Use strict TDD, the independent Bots gate, both Swift package gates, and real
`eagle-dev` CLI acceptance with isolated state and a scripted model. Add real
Harness/SIGKILL cases for the crash boundaries. Model quality and installed-App
acceptance remain separate from deterministic tests. No such checks ran for this
research-only change.

## 10. Accepted owner decisions — 2026-11-07

The owner explicitly answered all five choices in panel H of the research page.
These are accepted product requirements, not recommendations awaiting an answer:

| Decision | Accepted choice | Consequence |
| --- | --- | --- |
| Autonomy | Manage delegated work; suggest new goals first | Automatically assign, follow up and assess within the original grant; do not self-authorize a new goal |
| Visibility | All Bots' complete histories | Replace the earlier managed-evidence-only recommendation with controlled access to complete retained transcripts |
| Lifetime | First version runs with the App | No new always-on service; window closure and App quit remain distinct |
| Main role | Answer ordinary questions; delegate execution | No general shell/coding executor role for the main Bot |
| Worker concurrency | Serial execution, human requests first | Prioritize humans at safe resource boundaries, without silently aborting existing work |

The main Bot's default presence and nondeletion remain required. The five choices
are settled; they do not enable any runtime behavior in this documentation change.
Implementation, its technical contracts and its acceptance evidence are pending.

Full-history visibility is a reading permission, not authority to execute what an
old message says. Historical instructions retain their original provenance and
cannot authorize a new action. Access also does not grant blanket onward disclosure.
Define retention and recipient checks in the implementation contract. Any later
revocation blocks future use but cannot make a model forget material already in
its durable conversation; retire that context when necessary, without claiming
retroactive erasure of information or audit records.

## 11. Verification and source map

Verified in this investigation: local revisions and clean starting worktrees;
remote main identity; identical old/new DSH trees and empty diff; static code,
installed pi-durable README/types, and independent read-only architecture research.
Not verified: runtime performance, live model behavior, App interactions, tests,
background service installation or any new feature.

Key implementation seams:

- E `apps/macos/Sources/EagleFeatures/BotsDaemonSupervisor.swift:79-188`.
- E `apps/bots/src/core/BotRegistry.ts:185-246,591-724`.
- E `apps/bots/src/core/BotDirectory.ts:86-105,203-255`.
- E `apps/bots/src/core/ConversationService.ts:599-690,770-793,1368-1465`.
- E `apps/bots/src/core/RuntimePort.ts` and `core/Invocation.ts`.
- E `apps/bots/src/core/domain.ts:517-594` and `tools/registry.ts:65-110`.
- E `apps/bots/src/peers/host.ts:78-176` and `core/PeerExchangeStore.ts:14-44`.
- E `apps/bots/src/triggers/producers.ts:27-121`.
- E `apps/bots/src/runtime/pi/reflection.ts:34-39,190-279`.
- P `src/core/model.ts`, `core/engine.ts`, `core/tickets.ts`, `core/replies.ts`.
- P `src/agents/pi-coordinator.ts`, `pi-executor.ts`, `sessions.ts`.
- D `docs/000-philosophy.md`, `001-domain.md`, `002-authorization.md`, `003-execution.md`.
- D `src/app/effects.ts`, `delivery.ts`, `outbox.ts`, `notices.ts`.
- D `src/executor/dsh.ts` and `background.ts`.
- Installed pi-durable README: sleeping/waking at 140-212, tools/replay at 278-353,
  busy input/custom entries at 506-547, hooks at 606-625, owned conversations/tasks
  at 637-708, documents at 726-749, and storage boundaries at 758-800.

If source or tests are adapted from the MIT-licensed reference or port, preserve
license and attribution. This proposal introduces no source dependency on either
repository.
