# SG-003 analysis and native decisions

Status: **delivered in source 2026-11-10** and verified through `eagle-dev superagent`
against the dev stack. The native dashboard (section 3.3) is the remaining App-side surface;
the service, storage, bounds, protocol and CLI are in. Requirements from
[SUPERAGENT-ARCHITECTURE.md](../SUPERAGENT-ARCHITECTURE.md) and the owner's
2026-11-07 decision that the decision dashboard is native and MVVM. Evidence comes from
[SG-002](SUPERAGENT-002-OBSERVATION.md); what the watcher already noticed comes from
[SG-004](SUPERAGENT-004-PROACTIVE.md). This spec closes the documentation plan: with it,
the Super Bot has a contract for every surface the product promised.

## 1. What it is

SG-004 answers "something changed, and here is a bounded action". SG-003 answers "what does
the evidence mean, and what should the person decide". It is the only place the Super Bot
suggests work, and the only place a person's decision becomes a durable record.

Three products, one contract:

1. **A suggestion** — a short, bounded statement of what the evidence supports, with the
   entries it rests on. Never free prose from a model alone: every suggestion names its
   evidence ids, so a person can check it.
2. **A decision** — the person accepting, rejecting or deferring a suggestion. Decisions are
   durable, immutable records with a reason, and they are what the Super Bot reports on
   later.
3. **The dashboard** — a native surface listing open suggestions newest first, grouped by
   Bot, with the evidence behind each one a chevron away.

## 2. Invariants

- **Evidence first.** A suggestion that cannot name at least one entry id, one attention
  item or one provider fact is refused by the service, not merely discouraged by the prompt.
- **Bounded.** At most 3 open suggestions per Bot and 50 open in total; a suggestion has at
  most 240 characters of text and at most 8 evidence references. A refused write is a value
  the client shows, never a silent drop.
- **The person decides.** No suggestion changes a worker. Accepting one may, in a later
  slice, hand a management action to SG-004 with the decision id attached; SG-003 itself
  writes nothing to a worker.
- **Honest staleness.** A suggestion whose evidence is older than the provider's own
  watermark, or whose Bot disappeared, is marked stale on read rather than deleted: the
  person sees what they were told and that it no longer holds.
- **No second engine.** Analysis reuses the SG-004 attention items, the SG-002 history pages
  and the Superagent's existing model configuration and conversation. It adds storage and a
  socket surface, not another runtime.

## 3. Behaviour

### 3.1 When a suggestion is produced

Only when at least one of these holds, and at most once per Bot per `analysisCooldownMs`
(default 900 000):

| Trigger | Evidence it must cite |
| --- | --- |
| An open `worker_error` or `worker_stalled` item older than one cooldown | the item id and the entry range the tail came from |
| Three or more `history_appended` changes for one Bot since the last accepted decision | the entry ids |
| The person asks, in the Super Bot's conversation, what it thinks about one Bot | the Bot id and whatever the watcher holds |

The prompt carries the bounded evidence and asks for one JSON object
`{ text, evidence: [ids] }`. The service validates it against the bounds above; a model
answer that fails validation is discarded with an audit row, never stored half-formed.

### 3.2 Decisions

`POST`-shaped commands on the existing socket, additive to SG-001 v1:

```text
suggestion-list   { type, id, botId?, limit? }              -> { suggestions }
suggestion-ack    { type, id, suggestionId, verdict, reason? } -> { suggestion, decision }
decision-list     { type, id, botId?, limit? }               -> { decisions }
```

`verdict` is `accepted`, `rejected` or `deferred`. A decision records
`{id, suggestionId, botId, verdict, reason, at}` and is immutable: a second ack for the same
suggestion is `409 decision_exists`. `decision-list` pages newest first.

### 3.3 Native dashboard

One `SuperagentPanel` view model owns the list, the selection and the detail; the view
renders `SettingsSectionRow`-style rows from the App's design system, newest first, each with
its Bot, its one-line suggestion and its verdict buttons. The panel is read-only toward
workers. It shows the provider's state honestly: unconfigured, refused, unreachable and stale
each have their own line, and no stale suggestion is shown as fresh.

## 4. Storage and bounds

`<superagent root>/analysis.json` (0600, atomic replace): `suggestions[]` (at most 200,
closed ones pruned first), `decisions[]` (at most 200), `lastAnalysisAt` per Bot. A damaged
file is read as empty, like the attention store; a write that fails leaves the previous file.

## 5. Acceptance rows

| Row | Proves |
| --- | --- |
| SG003-A1 | Evidence-free model output is refused with an audit row, and nothing is listed |
| SG003-A2 | A suggestion over 240 characters or over 8 evidence ids is refused |
| SG003-A3 | A `worker_error` item older than the cooldown produces at most one suggestion per Bot per cooldown |
| SG003-A4 | An accepted decision is durable, immutable, and a second ack is `409 decision_exists` |
| SG003-A5 | A suggestion whose Bot disappears reads as stale, never as open and fresh |
| SG003-A6 | The dashboard lists newest first and shows the provider's own state for unconfigured, refused and unreachable |
| SG003-A7 | `/api/health` and the conversation are unaffected by analysis storage failures. **Verified 2026-11-10** with `test/analysis.test.ts` |

## 6. Dev acceptance — 2026-11-10

Driven entirely through `eagle-dev superagent` against a source Superagent on the dev
ports, with two real dev Bots:

- Both Bots were aborted mid-answer; the watcher raised `worker_error`, reported to the Super
  Bot and nudged the Bot (SG-004), and the analyzer produced one suggestion per Bot citing
  `a_…` and entry ids (`e_7`, `e_11`, `e_12`).
- `eagle-dev superagent suggest` listed both; `suggest now --bot` refused with the cooldown;
  `suggest ack --verdict accepted --reason …` recorded the decision; a second ack answered
  `decision_exists` and exited 1; `decisions` listed the accepted one.
- `attention ack --item …` closed an item, and the suggestion behind it then read
  `"stale": true` instead of disappearing.
- `manage` read `act`, set `notify`, read it back, and set `act` again.

Not exercised in dev: a suggestion produced on an explicit `suggest now` (the automatic pass
had already spent each Bot's cooldown), and the native dashboard.
