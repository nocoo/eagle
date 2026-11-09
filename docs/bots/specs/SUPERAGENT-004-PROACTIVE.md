# SG-004 proactive observation and management

Status: **active spec; implemented tonight against the dev App and the dev Superagent**.
Requirements: [SG-002](SUPERAGENT-002-OBSERVATION.md) supplies the read-only evidence;
this spec adds what reads it on a schedule and what may act on it.
Supersedes, for a named action set only, the `Read-only toward workers` invariant in
[SUPERAGENT-ARCHITECTURE.md](../SUPERAGENT-ARCHITECTURE.md).

## 1. Owner decision — 2026-11-09

The owner restored the prototype's essence: the Super Bot is not a passive viewer. It
watches the worker Bots on its own schedule, decides what needs attention, reports to the
person, and — inside an explicit policy — manages a worker through the same surface the
person uses.

What stays true:

- **The worker stays unaware.** No Superagent persona, prompt section, tool, report hook or
  required acknowledgement reaches a worker. A management action is an ordinary client
  write, indistinguishable from the person typing.
- **Evidence is read, not owned.** The Superagent keeps its own baseline and its own
  attention store; it never reads a worker's runtime objects, storage handles or queues.
- **Every action is bounded, attributable and reversible in description.** An action names
  the Bot, the attention item, the exact text, and its outcome in an audit trail the person
  can read. There is no unbounded loop, no retry storm, no silent action.
- **Failures stay distinguishable.** A refused or unreachable observation provider must
  never look like a worker failure, and must never cause an action against a worker.

## 2. Behaviour

### 2.1 Watch loop

One tick every `intervalMs` (default 60 000, minimum 15 000), at most one tick in flight:

1. `POST /v1/observe/changes` with **the watcher's own baseline** (`watch-state.json`), so
   the App's own `observe-changes` command keeps its separate cursor.
2. Classify the returned changes into candidate attention items (section 2.2).
3. For `history_appended` candidates, read the Bot's newest `history` page (root scope,
   `limit: 3`) and classify the tail.
4. Store the items, then hand "new or re-raised" ones to the action policy (section 2.3).

A provider that answers `unconfigured`, `refused`, `unreachable` or `reset` records the
state and produces no items. A tick never throws out of the timer.

### 2.2 Attention items

One open item per `(botId, kind)`; a re-detection raises `count` and `lastSeenAt` instead of
creating a second item. An item older than `reopenAfterMs` (default 900 000) is closed and
may be re-created.

| Kind | Evidence | Severity | Action policy may |
| --- | --- | --- | --- |
| `worker_unavailable` | `store_state_changed` with a state other than `available` | high | report only |
| `worker_error` | newest root entry is an assistant message in state `error` or `aborted` | medium | nudge |
| `worker_stalled` | activity stays `queued` or `running` past `stallAfterMs` (default 600 000) | medium | nudge |
| `worker_idle_unfinished` | activity returns to `idle` while a submission is still `queued` | low | report only |

`worker_stalled` needs the first observation of the activity, so the watcher stores
`activitySince` per Bot; a restart without that timestamp waits one more interval instead
of guessing.

### 2.3 Actions

`mode` is `off`, `notify` (default) or `act`.

| Mode | What happens |
| --- | --- |
| `off` | Items are stored and listed; nothing is sent and no model turn is spent |
| `notify` | Plus at most one proactive report per `reportBudgetMs` (default 1 800 000): the Super Bot is asked, in its own conversation, to tell the person what it found. The report is a normal assistant turn, so the person can answer it |
| `act` | Plus at most one management write per item and per `actionCooldownMs` (default 900 000), and at most `maxActionsPerHour` (default 6) across all Bots |

Management verbs are exactly two, and both reuse the person's own surface through the
`eagle` CLI with a scoped credential: `nudge` (`chat send --text …`) and `abort`
(`chat abort`). The text is a fixed template per kind — the Super Bot never composes an
unbounded command for a worker.

Every action writes one audit record `{at, itemId, botId, verb, text, result, detail}` to
the attention store, which is bounded to 200 items and 200 records. A refused CLI call
(exit 3, exit 4) closes that item's action for the cooldown and never retries inside the
same tick.

## 3. Protocol

Three commands on the Superagent's existing socket, all additive to SG-001 v1:

```text
attention       { type, id, limit? }        -> { items, provider }
attention-ack   { type, id, itemId }        -> { item }
manage-mode     { type, id, mode? }         -> { mode, policy }
```

`attention` returns newest first, `provider` as `observe-*` reports it. `attention-ack`
closes one item and is idempotent. `manage-mode` reads the mode with no body and replaces it
with one, and refuses an unknown mode with `invalid_command`.

CLI (Superagent's own `scripts/serve.ts` sibling commands are out of scope tonight): the
App reaches these through the socket it already holds; a person can read the same items in
the Superagent root's `attention.json`.

## 3a. What the dev acceptance taught (2026-11-09)

Two triggers were missing from the first draft and are now part of the behaviour:

- **A run settles after its entry exists.** `history_appended` arrives while the answer is
  still streaming, so the tail reads `complete` and an abort that lands afterwards is never
  seen again: the changes feed has no "answer state changed" kind. The watcher therefore
  reads the tail when a Bot's `activity_changed` leaves `queued`/`running`, which is the
  moment the answer becomes a fact.
- **A new Bot is invisible until a snapshot.** `catalog_changed` must be answered with one
  `snapshot` read before any comparison is meaningful; that read also carries the new Bot's
  state for the next tick.

## 4. Bounds and failure behaviour

- At most 200 open items, 200 audit records, one tick in flight, 60 s minimum interval.
- The action budget is global and per item; the report budget is global.
- A management call runs with a 30 s deadline and its stderr is never stored.
- Nothing here writes to a worker's runtime, configuration, triggers or storage.

## 5. Acceptance rows

| Row | Proves |
| --- | --- |
| SG004-A1 | A `store_state_changed` change produces one `worker_unavailable` item, listed with its Bot and evidence |
| SG004-A2 | A Bot whose newest answer is an error produces `worker_error`, and the item's count rises instead of duplicating |
| SG004-A3 | A running Bot past the stall window produces `worker_stalled`; a run that finishes clears it on the next tick |
| SG004-A4 | `mode: off` sends nothing and spends no model turn; `notify` produces one Super Bot turn inside the report budget, and a second item inside the window produces none |
| SG004-A5 | `act` sends exactly one `nudge` for one item, records the audit row, and a second tick inside the cooldown sends nothing |
| SG004-A6 | A refused CLI credential (exit 3) records `refused`, closes the item's action for the cooldown, and does not throw out of the tick |
| SG004-A7 | An unconfigured or unreachable provider produces no items and no actions, and keeps the previous items readable |
| SG004-A8 | The watcher's baseline and the App's `observe-changes` baseline stay independent |
| SG004-A9 | Real dev acceptance: dev App Bots observed, one managed by the Super Bot with the audit row, and the person's window shows the report. **Verified 2026-11-09**: five Bots on the dev daemon, an aborted run noticed after it settled, `report` and `nudge` sent, and the worker's own transcript shows the nudge followed by a real model answer |
