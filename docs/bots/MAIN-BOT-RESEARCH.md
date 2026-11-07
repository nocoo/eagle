# Main Bot — research and architecture proposal

Status: **owner decisions and independence principles accepted; implementation pending**.
The owner confirmed product choices and then required independent operation,
read-only observation first, strict interfaces, a native decision dashboard, MVVM
and TDD. [Superagent architecture](SUPERAGENT-ARCHITECTURE.md) now owns that design;
this document retains the comparative research and its source evidence. No runtime
permissions, model configuration or daemon lifecycle have changed.

## 1. Recommendation

Make the main Bot an Eagle-owned, nondeletable Superagent identity, independent of
the worker catalog and runtime. Use pi-durable in its own host. Start with passive
observation, complete-history queries, evidence-based suggestions and a native
human decision dashboard. Worker management is a later, separately contracted
capability, not a prerequisite for the first useful release.

Do not embed the pi-superagent daemon, Engine, PiSessions or CLI inside Eagle. Do
not implement the feature as a prompt plus a repeating `peer_send` loop.

The central distinction is:

> A model run ending is not a task finishing. A Bot receiving information is not
> that Bot receiving authority. Being the main Bot is not permission to do anything.

The owner chose a conversational coordinator with access to all Bots' complete
histories. It answers ordinary questions and suggests new goals. The first release
is strictly read-only toward unaware workers; eventual delegation remains limited
to authorized work. The first version runs with the App. Human-priority serial
worker execution remains required when management is introduced. Product presence
in one UI does not imply shared execution, storage or lifecycle ownership.

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

## 5. Current architecture direction

[Superagent architecture](SUPERAGENT-ARCHITECTURE.md) owns the revised boundaries,
read-interface semantics, dashboard, MVVM ownership and TDD acceptance matrix.
The owner explicitly chose independent, read-only supervision as the first slice.
It supersedes the earlier integrated-coordinator rollout, not the research above.

```text
Worker runtime / stored history
  -> generic passive observation provider
  -> narrow versioned read protocol
  -> independent Superagent + its own pi-durable Harness and store
  -> evidence, bounded analysis, suggestions and human decisions
  -> native MVVM dashboard and main-Bot conversation
```

The Superagent owns its stable nondeletable identity outside the worker catalog.
The shell composes the two identity sources. A full, unavailable or absent worker
catalog cannot prevent the main Bot from starting. No worker imports Superagent
core, depends on its acknowledgements, or gains supervision-specific prompts,
tools, report hooks or task wrappers. Both sides can operate independently.

The candidate read boundary has exactly three operation families: `snapshot`,
`history`, and `changes`. The detailed design requires frozen pagination, provenance,
coverage watermarks, source/epoch-bound cursors, explicit gaps, bounded load and
producer/consumer conformance tests. These are proposed contracts, not endpoints
already available. No generic execute RPC or phase-1 worker write capability exists.

Read-only is stronger than today's read credential scope: chat subscribe opens a
Bot and refreshes tools; runtime open enables recovery scheduling; sockets hold
idle leases; peer exchange detail can backfill persisted answers. These routes
must not be reused as a supposedly passive observer. See the architecture's source
map and passive-adapter feasibility gate. Do not directly parse worker SQLite from
the Superagent as a shortcut around the boundary.

The owner confirmed separate App-owned processes and separate stores. The
Superagent runs outside the existing worker daemon and uses only the versioned
local protocol. This does not require a separate process for every worker Bot or
introduce an always-on service after App quit. Process-local failure isolation
still needs real crash/stop tests; it is not an OS security sandbox.

## 6. First-release supervision semantics

The main Bot may read all Bots' complete retained histories, analyze committed
facts, answer the owner, and present suggestions. It may persist its own observations,
cursors, analyses and human decisions. It cannot send, steer, promote, abort,
recover, retry, configure, mutate triggers, assign work or request worker reports.
Workers do not need to know it exists or cooperate with it.

A suggestion marked reviewed or useful is still **not executed**. Even an explicit
request to delegate is a proposal in this phase, not permission to use a hidden
worker command path. Existing workers remain directly usable through their normal
UI; the Superagent's evidence viewer must use passive reads rather than open an
ordinary chat as an accidental warm-up.

Use deterministic coalescing and durable evidence identities before invoking a
model. Inferences retain uncertainty and source references; runtime idle or a
completed submission never establishes business acceptance. Supervisor failure,
source availability, evidence freshness and worker health are separate facts.
No raw hidden reasoning is required for observability.

Complete-history visibility includes retained pre-compaction entries. It does not
open credential stores, grant general file/shell access, or let old instructions
mint new authority. Missing or unavailable history stays explicit. Paging bounds
each query, not which Bot's history the owner allowed it to inspect.

## 7. Native human decision dashboard

DSH's panel prioritizes three questions: does anything need me, is the system
healthy, and what led to this outcome (`D docs/005-panel.md`). Eagle needs the same
decision support in SwiftUI/AppKit, not a web view or only a conversation transcript.

The first release includes an attention overview, observed workers, evidence and
decision details, supervisor/source health, and a decision timeline. Each suggestion
links to facts and states what is uncertain. Counts match their drill-down lists.
Healthy state takes little space. Dashboard actions affect only supervisor-owned
state: review, dismiss, defer, or reanalyze. No worker retry/dispatch controls ship.

MVVM is mandatory: pure domain models/reducers; ViewModels with injected ports,
selection, cancellation and explicit intent; passive Views; transport-owned codecs
and authentication. Views do not run network requests, classify work or schedule
models. Reuse EagleDesign controls/tokens and retain Bots/Eagle dependency direction.
The detailed architecture owns this split and its tests.

## 8. Example: the first useful read-only product

Bot A has produced a research answer and Bot B is working on a prototype. Neither
was started or modified by the Superagent. The observer reads their committed
history through the passive interface and notices a missing source in A's answer.

It shows a suggestion with the precise evidence, freshness and uncertainty. The
owner can inspect it, dismiss it, or act manually through the usual worker UI.
The Superagent does not prompt A, unblock B, retry either Bot or approve a device.
If the worker source disappears, the dashboard keeps the last observation marked
stale while the main conversation remains available. If the Superagent fails,
both workers keep operating normally within the chosen process-isolation limits.

This is the accepted initial product, not a claim that autonomous management has
already shipped.

## 9. Delivery and future-management boundary

The delivery order is now: prove the passive contract; ship independent identity,
complete-history observation and a native decision dashboard; harden read-only
analysis and recovery; only later introduce an explicitly enabled command contract.
The architecture document contains the strict TDD and producer/consumer test matrix.

Tests must demonstrate noninterference, not just successful reads: no model starts,
worker writes, prompt/tool changes, runtime opens, idle retention or worker commit
backpressure attributable to observation. Allow only explicitly listed transport
logging/credential bookkeeping. Test each side without the other, source gaps,
fixed-boundary paging, stale responses, cursor recovery and native MVVM behavior.

Future management still needs the DSH-derived authorization and ownership model:
WorkItem is not a model run, Assignment is not a Bot, and ready is not accepted.
Any command must cross a small authenticated public contract, never an in-process
ConversationService or RuntimeHandle reference. The worker may implement that
contract with its existing InvocationPort internally; that choice stays private.

Preserve stable action IDs, durable receipts, grant/attempt fences, human stop,
evidence-based acceptance, human-priority serialization and unknown-effect handling.
A timeout does not prove execution stopped. An old report after reassignment cannot
advance current work. Cross-Harness atomicity and exactly-once arbitrary external
side effects remain unsupported claims. These future requirements must not impose
worker changes or dormant write capabilities on the read-only release.

Backend work follows strict TDD. Native logic follows MVVM and fake-port/reducer
tests, with real transport and App acceptance separately reported. No product tests
or running App checks were executed for this documentation change.

## 10. Accepted decisions and additional principles — 2026-11-07

| Decision | Accepted choice | First-release meaning |
| --- | --- | --- |
| Autonomy | Manage delegated work eventually; suggest new goals first | Initially read-only: analyze and advise, no worker commands |
| Visibility | All Bots' complete histories | Controlled access to complete retained transcripts, including pre-compaction |
| Lifetime | First version runs with the App | No new always-on service; a closed window is not a quit App |
| Main role | Answer ordinary questions; delegate execution eventually | No general shell/coding executor role and no phase-1 delegation |
| Worker concurrency | Serial execution, human requests first | Required when management is added; no worker scheduler change for observation |
| Independence | Each side can run without the other | Separate runtime/storage ownership; no worker awareness or reporting dependency |
| Process topology | Independent App-owned processes and stores | Superagent outside the worker daemon; explicit lifecycle and authenticated IPC |
| Interfaces | Few, strictly defined and tested | Versioned passive contracts; no cross-core/runtime/schema coupling |
| Human decisions | Native dashboard | Evidence, suggestions, source health and decision history, not only logs |
| Engineering | MVVM UI, TDD backend | Explicit ownership and failing behavior tests before implementation |

Default presence and nondeletion remain required. The new read-only-first principles
refine the earlier management goal; they are not an approval to enable writes now.
Separate App-owned processes and stores are now confirmed. Technical schemas,
implementation and runtime acceptance are pending. The architecture document's
review record distinguishes the completed design review from those unrun gates.

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
