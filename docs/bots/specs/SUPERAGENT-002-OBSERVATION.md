# SG-002 — passive worker evidence

Status: **draft specification for review; no code written**. Gate evidence:
[cold-read spike](OBSERVATION-SPIKE.md), measured 2026-11-08. Architecture and
product boundaries are owned by
[SUPERAGENT-ARCHITECTURE.md](../SUPERAGENT-ARCHITECTURE.md); delivery status by
[PLAN](../PLAN.md). SG-001 is delivered and unchanged by this milestone.

Owner decision 2026-11-08: independence is an SG-001 obligation. SG-002 **reuses**
the daemon's existing infrastructure — storage access, authentication, route table,
registry and view mapping — and adds only a clean, versioned read interface. This
spec therefore specifies an interface and its inertness, not a second provider.

## 1. Outcome and scope

The owner can, from the Super Bot side, see what every Bot actually has: which Bots
exist, how much retained history each holds across all of its conversation scopes,
what was committed after the last look, and what is unknown because a store is
missing, unsupported or lagging. Nothing the observation does can start, steer,
recover, configure or mutate a worker.

### In scope

- Three read operations: `snapshot`, `history`, `changes`, with frozen schemas,
  limits, errors, cursors and normative fixtures.
- A dedicated observation credential with its own scope and no other authority.
- Inert cold reads of committed data from stores the daemon is not otherwise using,
  and safe reads beside a live writer.
- Complete retained history: root plus forked child/task scopes, pre-compaction
  entries retained, explicit coverage and truncation.
- Superagent-side consumption: its own cursor/evidence state, reset on epoch change,
  honest unavailable states.
- Worker-service status and coverage facts sufficient for a read-only native surface.
- Deterministic tests, real-store conformance and a real CLI/App acceptance.

### Not in scope

- Analysis, suggestions, decisions, notifications, scheduled rechecks (SG-003/004).
- Any worker command, delegation, recovery, retry, configure or trigger mutation.
- Ordinary worker chat/history routes as an observation shortcut.
- Worker model/tool/prompt/report changes of any kind.
- A second provider process, a copied schema layer or a parallel storage owner.
- Reading tool bytes that were never retained, or expanding bounded tool output.

## 2. Normative behavior

### SG002-R01 — one clean interface, reused implementation

`snapshot`, `history` and `changes` are the complete observation interface. No
generic RPC, no arbitrary method selection, no caller-supplied query language. The
implementation belongs to the daemon and reuses its existing modules; the Superagent
consumes only the wire contract. A caller-supplied scope may narrow visibility; it
may never manufacture a fourth capability.

### SG002-R02 — dedicated observation credential

The daemon mints an observation credential distinct from its bearer token, stored
with mode 0600 in its own root. It authenticates `/v1/observe/*` and nothing else.
The bearer token is refused on `/v1/observe/*`, and the observation credential is
refused on every other route. Missing, malformed, foreign or loosened credential
files fail closed without repair. No credential value appears in a URL, log, error
body or observation payload.

### SG002-R03 — source identity and epoch

Every response carries `source: {id, epoch, capturedAt}`. `id` is a binding hash of
the canonical daemon root; `epoch` changes when the daemon's observation identity is
recreated. Cursors are bound to both, plus the operation and the store/scope they
were issued for. A cursor presented to another source, epoch, operation, Bot or
scope is refused rather than reinterpreted.

### SG002-R04 — inert cold reads

A read opens the Bot's committed store only if it exists. It never creates, migrates,
recovers, reconfigures, resumes or opens a Harness, and never takes a worker lifecycle
lease or idle-close extension. A missing store is `session_missing`; a store written
by a different schema version is `schema_unsupported`; a corrupt store is
`store_unreadable`. None of those becomes an empty history.

Observed effects are exactly: committed worker data unchanged; WAL `-shm`/`-wal`
sidecars may appear or be rewritten; authentication/trace bookkeeping. Nothing else
is claimed.

### SG002-R05 — complete retained history

History enumerates every retained conversation scope of one Bot: the root
conversation and forked child conversations, each identified by scope, kind and
owner. Compaction is not deletion: entries before a compaction boundary remain
readable, and the boundary is reported. A page carries a fixed upper boundary so new
commits cannot shift it, and older entries remain reachable across paging.

`coverage.complete` is true only when every scope of the Bot was enumerated and
nothing was hidden. Otherwise coverage names the reason (`truncated`,
`unsupported_kind`, `scope_unavailable`) and the response must not read as "that is
all there is". Hidden entries (system prompts, internal reasoning) are counted as
omitted, never silently dropped from a claimed-complete page.

### SG002-R06 — honest admission facts

Each returned message keeps provenance: Bot, conversation scope, entry id, commit
sequence and the stored message kind. Tool output that was stored bounded stays
bounded and is marked; the contract never promises bytes that were not retained.
Quoted historical instructions remain untrusted context, not authority: no returned
content grants the Superagent a capability it did not have.

### SG002-R07 — changes without acknowledgement

`changes` returns committed catalog/history/status changes after a cursor, or typed
invalidation. Duplicates are allowed and identified; the worker never waits for an
observer acknowledgement and no worker write depends on observer progress.

### SG002-R08 — gaps, lag and retention

A snapshot publishes a change cursor paired with its own baseline and a per-Bot
coverage watermark. If the provider's projection lags, it publishes lag rather than
completeness. An epoch change or an unusable cursor returns a typed `reset` requiring
a new baseline; it never continues silently. Sequence numbers and wall-clock times
are separate fields. There is no fleet-wide sequence, so a fleet watermark is derived
from per-Bot cursors, not invented.

### SG002-R09 — noninterference under load

Reads are inert while a Bot is committing: no input, run, tool execution, recovery,
compaction, catalog/peer/trigger mutation, no worker task success or failure caused by
an observer, no unbounded observer backpressure. Reader cancellation cancels only the
read. Reads use short transactions and release handles immediately, so SQLite
checkpoints are not held indefinitely.

### SG002-R10 — Superagent consumption state

The Superagent keeps its own observation state: per-source cursor, last snapshot
watermark, per-Bot coverage and the last failure category. It commits a consumed
observation and its cursor together. A reset, an unavailable provider or an
unsupported store is visible as such; no silent fallback to private files, no
promotion of a stale fact to current, and no reader that pretends workers are idle
because data is missing.

### SG002-R11 — read-only native surface

The App shows, for each source: reachability, coverage (Bots visible / Bots known),
per-Bot state and watermark, lag, gap/reset reason and last successful read time. A
Bot's history can be paged from the CLI with explicit scope, boundary and truncation
markers. No control in this milestone sends, steers, recovers or configures. The App
still displays a Bot as unknown when its store is missing or unsupported.

### SG002-R12 — MVP rules of engagement

No analysis, no suggestion, no model call is added by SG-002. Observation never
reserves model budget. Failures are categorized and distinguishable between provider,
credential, schema and consumer. The Superagent's chat (SG-001) must keep working
with observation absent, refused or failing.

## 3. Frozen interface

[SUPERAGENT-002-PROTOCOL.md](SUPERAGENT-002-PROTOCOL.md) freezes routes, credential,
headers, schemas, limits, error codes, cursor encoding and normative fixtures.
`fixtures/bots-observation/` is normative for both sides.

## 4. Slices

| Slice | Implement in order | Exit evidence |
| --- | --- | --- |
| SG002-A: provider | Observation credential, epoch, read-only store module with schema-conformance guard, three routes, limits and typed errors; failing noninterference tests first | Real store: snapshot/history/changes over real HTTP; read-before/after domain-state diff empty; missing/unsupported/corrupt stores typed; no Harness open |
| SG002-B: consumer | Superagent observation port, cursor/evidence store, reset and unavailable handling | Real provider + real Superagent: baseline, incremental changes, typed reset on epoch change, honest unavailable state; SG-001 chat unaffected |
| SG002-C: native surface | Read-only observation model, status block and CLI paging | Dev App shows coverage/watermark/lag for a real daemon and "unknown" for a missing store; CLI pages a real Bot history with truncation markers |
| SG002-D: acceptance | Integration regressions, independent review, package gates, real CLI acceptance and a hand-inspected dev App | Acceptance matrix below passes with recorded evidence |

## 5. Acceptance matrix

| ID | Requirements | Given / when / then |
| --- | --- | --- |
| SG002-A01 | R01, R02 | Given the observation credential, when any other route or a fourth operation is called, then it is refused; the worker bearer on `/v1/observe/*` is refused too |
| SG002-A02 | R03, R08 | Given a snapshot, when its cursor is used against another source/epoch/operation/Bot, then it is refused rather than reinterpreted |
| SG002-A03 | R04 | Given a cold Bot store, when history is read, then committed rows are returned and the pre/post fingerprint of the store matches (sidecars excluded by name) |
| SG002-A04 | R04 | Given a missing, older-schema and corrupt store, when each is read, then `session_missing` / `schema_unsupported` / `store_unreadable` appear and no file is created or migrated |
| SG002-A05 | R04, R09 | Given an open runtime with a committing writer, when snapshot/history/changes run repeatedly, then commits continue at baseline latency and the reader reports no worker failure |
| SG002-A06 | R05 | Given a compacted conversation with child/task scopes, then full history returns pre-compaction entries, every scope is enumerated, and the compaction boundary is reported |
| SG002-A07 | R05 | Given more entries than one page, when paging backwards, then the boundary is fixed, order is stable, no entry is duplicated or dropped, and completeness is not claimed for a page that hides scopes |
| SG002-A08 | R06 | Given a bounded tool output and a hidden entry, then the result marks truncation and counts the omission instead of claiming complete content |
| SG002-A09 | R07 | Given two identical `changes` reads with one cursor, then duplicates are allowed and identified, and the worker's progress does not depend on the read |
| SG002-A10 | R08, R10 | Given an epoch change or unusable cursor, then a typed `reset` reaches the Superagent, which drops the stale baseline instead of continuing |
| SG002-A11 | R10, R12 | Given observation refused, unavailable or failing, then chat still works, the reason is visible and no private file access occurs |
| SG002-A12 | R11 | Given a real daemon and a missing store, then the App and CLI show coverage, watermark, lag and unknown states without any mutation control |

## 6. Evidence discipline

Every requirement row above needs a deterministic test plus an evidence entry naming
the test, source revision, red behavior, green result and review disposition. Cold
reads are compared by store fingerprint before/after, excluding only the named WAL
sidecars. Manual/live checks are reported separately and are never inferred from a
scripted test.

## 7. Reviewed open items

| Before | Resolved by |
| --- | --- |
| SG002-A | This spec plus the spike: read-only connection, provider-owned schema constants with a conformance guard, existence check, epoch file, dedicated credential, three routes |
| SG002-B | This spec plus the protocol doc: consumer cursor/evidence commit, reset handling, unavailable categories |
| SG002-C | This spec: read-only status block and CLI paging; no analysis and no mutation control |
