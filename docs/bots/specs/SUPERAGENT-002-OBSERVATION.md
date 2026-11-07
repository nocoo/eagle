# SG-002 — passive worker evidence

Status: **draft specification (revision 2) for review; no code written**. Gate
evidence: [cold-read spike](OBSERVATION-SPIKE.md), measured 2026-11-08. Frozen
interface: [observation protocol](SUPERAGENT-002-PROTOCOL.md). Architecture and
product boundaries belong to [SUPERAGENT-ARCHITECTURE.md](../SUPERAGENT-ARCHITECTURE.md);
delivery status to [PLAN](../PLAN.md). SG-001 is delivered and unchanged here.

Owner decision 2026-11-08: independence is an SG-001 obligation. SG-002 **reuses**
the daemon's infrastructure — HTTP route table, client credentials, catalog and
storage access, error helpers — and the Superagent's existing authenticated socket.
Only the read interface is new. Revision 2 closes the first review: per-Bot baselines
instead of a fleet sequence, range-based changes, store incarnation, entry-id
continuation, the pinned schema version and a dedicated non-rankable scope.

## 1. Outcome and scope

The owner can see, from the Super Bot side, what every Bot actually holds: which Bots
exist, how much retained history each has across all of its conversation scopes, what
was committed after the last look, and what is unknown because a store is missing,
unsupported, replaced or unreadable. Observation cannot start, steer, recover,
configure or mutate a worker.

### In scope

- `snapshot`, `history`, `changes` with frozen schemas, limits, errors, baselines and
  normative fixtures.
- A dedicated observation credential, separate from every existing credential, with a
  non-rankable scope.
- Inert cold reads of committed data: no Harness, no migration, no creation.
- Complete retained history: root plus forked child scopes, pre-compaction entries,
  three-part coverage.
- Superagent consumption on its existing socket with its own baseline and honest
  unavailable states.
- A read-only native surface: coverage, watermark, lag, gap reasons, CLI paging.
- Deterministic tests, real-store conformance and a real CLI/App acceptance.

### Not in scope

- Analysis, suggestions, decisions, notifications, scheduled rechecks (SG-003/004).
- Any worker command, delegation, recovery, retry, configuration or trigger mutation.
- Ordinary worker chat/history routes as an observation shortcut.
- Any worker model, tool, prompt, report or scheduling change.
- A second provider process, a copied schema layer or a parallel storage owner.
- Content the daemon never retained, or expanding bounded tool output.

## 2. Normative behavior

### SG002-R01 — one clean interface over reused implementation

`snapshot`, `history` and `changes` are the complete interface: no generic RPC, no
caller-supplied query language, no fourth capability manufactured from a scope filter.
The provider lives in the daemon and reuses its modules; the consumer uses only the
wire contract. What must be clean is the interface — schemas, credential, errors,
coverage, baselines — not a duplicated implementation.

### SG002-R02 — dedicated, non-rankable credential

The daemon mints its own observation token into its root with mode 0600 and reads it
through the same hardened reader as the dev token. Only that token authenticates
`/v1/observe/*`. The root token, the dev-agent token and every named client are
refused there, and the observation token is refused on every other route. The
`observe` scope is not rankable in either direction. A missing, symlinked, non-regular,
wrong-mode, foreign or short credential file is refused, never repaired or logged.

### SG002-R03 — source identity, epoch and store incarnation

Every response carries a source identity (root binding) and epoch (daemon observation
store id). Cursors bind both. Because a single Bot's database can be replaced,
restored or recreated independently, a cursor also binds each Bot's **store
incarnation**; a changed incarnation is a typed reset for that Bot, not a silent
continuation. A cursor presented to another source, epoch or operation is refused
rather than reinterpreted.

### SG002-R04 — inert cold reads

A read opens a Bot's committed store only when it exists. It never creates, migrates,
recovers, reconfigures, resumes or opens a Harness, and takes no lifecycle lease or
idle-close extension. Missing, older-schema, foreign-schema and corrupt stores are
distinct states; none becomes an empty history, and none is repaired.

Observed effects are exactly: committed worker data unchanged; WAL `-shm`/`-wal`
sidecars may appear or be rewritten; trace and credential-use bookkeeping.

### SG002-R05 — complete retained history with three-part coverage

History enumerates every retained scope of a Bot — the root conversation and forked
child conversations with their owner — in stable order, and reports whether that
enumeration was truncated. A child scope returns its own rows; it neither inherits nor
repeats the parent's.

Compaction is not deletion: entries before a compaction boundary stay readable, the
boundary is reported as `{entryId, head}`, and the compaction entry itself appears as a
notice. A page has a fixed upper boundary and continues by entry id, so no entry can be
duplicated or skipped and older entries stay reachable.

Completeness is reported as three independent facts — scopes, page, content — with
reasons: `scopes` says whether every scope was enumerated, `page` whether the response
budget cut the page, and `content` whether any delivered message had to be trimmed to
fit the delivery budget. Entries the contract deliberately does not map (system
prompts, internal reasoning) are reported as counted omissions by kind, not as
incompleteness. No part is `complete` unless it truly is, and no response may read as
"that is all there is" when a scope or a page was cut.

### SG002-R06 — honest admission facts

Every message keeps provenance: Bot, scope, entry id, commit sequence and the stored
kind. Blocks are the daemon's existing wire blocks (`text`, `toolCall`, `toolResult`,
`notice`); internal reasoning is never exposed and is counted as omitted. Stored
content is returned as retained — the write-time bound is the limit, and the contract
never promises bytes that were not stored. Quoted historical instructions remain
untrusted context, not authority.

### SG002-R07 — changes are ranges, not a second log

`changes` compares a baseline with the current state and reports, per Bot, an appended
entry-id range, a replaced store, a changed store state, a changed activity, or a
changed catalog. No event identity is derived from a commit sequence, because one
commit can write several entries and tasks/submissions are updated in place. The
baseline therefore carries each Bot's previous state, activity and store generation,
and every change kind has a fixed dedupe key. Duplicates across reads are allowed and
replayable; no acknowledgement exists and no worker write depends on observer progress.

### SG002-R08 — baselines, lag and resets

A snapshot publishes its own baseline: catalog revision plus, per Bot, store
incarnation, entry generation and last known state and activity. There is no
fleet-wide sequence, so none is invented. A store replaced, copied or restored in
place is detected by a changed incarnation or a generation that regresses, not only by
the daemon's epoch.
A projection lag is published rather than implied freshness. An epoch change, a
replaced store or an unusable baseline is a typed reset requiring a new baseline; it
never continues silently. Sequence numbers and wall-clock times remain separate fields.

### SG002-R09 — noninterference under load

Reads stay inert while a Bot commits: no input, run, tool execution, recovery,
compaction, catalog/peer/trigger/secret mutation, no worker task success or failure
caused by an observer, no unbounded backpressure. Reader cancellation cancels only the
read. Reads use one short transaction and release handles before responding, so
checkpoints are not held.

### SG002-R10 — consumer state on the existing socket

The Superagent serves observation on its existing authenticated socket, reusing the
SG-001 proof handshake, command envelope and error codes. It keeps its own baseline,
last-read time, per-Bot coverage and last failure category, and commits a consumed
observation together with its new baseline. `reset`, `refused`, `unreachable`,
`unconfigured` are visible states; there is no private-file fallback and no stale fact
promoted to current. Observation never blocks or closes the chat surface.

### SG002-R11 — read-only native surface

The App shows per source: reachability, coverage (Bots visible / known), per-Bot state,
watermark, lag, reset/gap reason and last successful read time, with unknown states for
missing or unsupported stores. CLI paging renders scope, boundary, coverage and
truncation explicitly. No control in this milestone sends, steers, recovers or
configures.

### SG002-R12 — MVP rules of engagement

No analysis, suggestion or model call is added by SG-002, and observation reserves no
model budget. Failures are categorized and attributable to provider, credential,
schema or consumer. SG-001 chat keeps working with observation absent, refused or
failing.

## 3. Frozen interface

[SUPERAGENT-002-PROTOCOL.md](SUPERAGENT-002-PROTOCOL.md) freezes routes, credential,
host/origin checks, schemas, limits, error codes, cursor encoding and fixtures;
`fixtures/bots-observation/` is normative for both sides.

## 4. Slices

| Slice | Implement in order | Exit evidence |
| --- | --- | --- |
| SG002-A: provider | Observation token and identity, scope and route checks, read-only store module with schema-conformance guard, three routes, limits, errors; failing noninterference tests first | Real store: all three operations over real HTTP; logical store-state diff empty before/after; missing/unsupported/corrupt/replaced stores typed; zero runtime/model/tool calls |
| SG002-B: consumer | Observation commands on the existing socket, baseline/evidence store, reset and unavailable handling | Real provider + real Superagent: baseline, incremental ranges, typed reset on epoch and incarnation change, honest unavailable state; chat unaffected |
| SG002-C: native surface | Read-only observation model, status block and CLI paging | Dev App shows coverage/watermark/lag for a real daemon and unknown for a missing store; CLI pages real history with coverage markers |
| SG002-D: acceptance | Integration regressions, independent review, package gates, real CLI acceptance, hand-inspected dev App | Acceptance matrix passes with recorded evidence |

## 5. Acceptance matrix

Deterministic tests use a real daemon, real SQLite stores and the scripted provider.
Instrumentation counters (runtime open/resume, model calls, tool executions,
`registry.touch`, idle-lease changes) are asserted to stay zero; state comparison is
logical (tables, catalog bytes, credential files, conversation rows), not a file
fingerprint alone.

| ID | Requirements | Given / when / then |
| --- | --- | --- |
| SG002-A01 | R01, R02 | Given each credential, when used on the wrong surface, then it is refused; `observe` is neither implied by nor implying another scope |
| SG002-A02 | R02 | Given a missing, symlinked, wrong-mode, short or foreign observation token file, then observation is disabled and nothing is repaired or written |
| SG002-A03 | R03, R08 | Given a baseline, when it is presented for another source/epoch/operation or after an epoch change, then `cursor_invalid` / `cursor_reset` appear and no range is fabricated |
| SG002-A04 | R03 | Given a Bot store replaced or restored in place, when changes or history run, then the incarnation mismatch is reported and the stale baseline is not continued |
| SG002-A05 | R04 | Given a cold Bot store, when history is read, then committed rows return and the logical state before/after is identical, with no Harness open, no migration and no new file other than the named WAL sidecars |
| SG002-A06 | R04 | Given missing, older-schema, foreign-schema and corrupt stores, then `session_missing` / `schema_unsupported` / `store_unreadable` appear and no file is created, migrated or repaired |
| SG002-A07 | R04, R09 | Given a committing writer, when reads run repeatedly, then every submission still settles `done`, no `SQLITE_BUSY` or worker failure occurs, no idle lease is taken and cancelling a read cancels only the read; the observed latency distribution is reported separately, never asserted as a gate |
| SG002-A08 | R05 | Given a compacted conversation with child scopes, then pre-compaction entries return, every scope is enumerated with its owner, and boundaries are reported |
| SG002-A09 | R05, R08 | Given more entries than a page, when continuing by `next.before`, then boundaries are fixed, no entry is duplicated or skipped, an oldest page reports no `next`, and a page whose store changed in between answers `stale_page` instead of mixing stores |
| SG002-A10 | R05, R06 | Given more than 500 scopes, an entry kind that cannot be mapped, or a page over the response cap, then the corresponding coverage part is not `complete` and states its reason |
| SG002-A11 | R06 | Given a tool result and a hidden reasoning entry, then the tool result keeps `callId/name/isError`, reasoning never appears, and omitted entries are counted by kind |
| SG002-A12 | R07 | Given two reads with one baseline, then ranges and duplicates are identical, a replaced store, a state change and a catalog change each appear once per Bot, and no worker progress depends on the read |
| SG002-A13 | R10 | Given a provider reset, refusal, unreachability or unconfigured state, then the consumer reports that state, drops the stale baseline, keeps chat working and reads no daemon file |
| SG002-A14 | R10 | Given a consumer crash between consuming an observation and committing its baseline, then no duplicate is presented as new evidence and the next read re-baselines honestly |
| SG002-A15 | R11, R12 | Given a real daemon and a missing store, then App and CLI show coverage, watermark, lag and unknown states with no mutation control and no model call |
| SG002-A16 | R01, R08 | Given a 200-Bot fleet, then its baseline fits the frozen `changes` body budget and round-trips through both decoders unchanged |
| SG002-A17 | R01, R05 | Given the largest allowed history page, then the consumer result frame stays inside the existing socket cap and no frame is silently closed |

## 6. Evidence discipline

Each row needs a deterministic test plus an evidence entry naming test, revision, red
behavior, green result and review disposition. Performance measurements, live-model
runs and rendered-UI checks are reported separately and are never inferred from a
scripted test; they cannot substitute for a deterministic row.

## 7. Resolved freeze items

| Before | Resolved by |
| --- | --- |
| SG002-A | This spec plus the protocol: read-only connection and schema constants with a conformance guard, existence check, observation token/identity, non-rankable scope, three routes, per-store incarnation |
| SG002-B | This spec plus the protocol: existing socket commands, consumer baseline committed with the observation, mapping provider codes onto SG-001 codes |
| SG002-C | This spec: read-only status block and CLI paging, no analysis, no mutation control |

## 8. Acceptance evidence (2026-11-08, source; no release artifact)

Deterministic rows live beside the code and name their row, so the matrix cannot drift
from what runs.

| Row | Test | Status |
| --- | --- | --- |
| A01 | `test/observation/http.test.ts` "the observation credential works only on the observation routes…" | pass |
| A02 | `test/observation/acceptance.test.ts` "SG002-A02" | pass |
| A03 | `test/observation/cursor.test.ts` (binding refusals) + `routes` baseline checks | pass |
| A04 | "SG002-A12/A04" (replaced store forces `cursor_reset`) | pass |
| A05 | "SG002-A05" (reads leave open count at zero) + `store.test.ts` byte diff | pass, with the named WAL sidecars allowed |
| A06 | `store.test.ts` (missing / older schema / corrupt) | pass |
| A07 | "SG002-A07" (concurrent reads never fail; an abandoned read cancels only itself and the next read is served) + spike read-beside-writer probe | pass |
| A08 | "SG002-A08/A09" (child scope with owner, compaction boundary) | pass |
| A09 | same test + `store.test.ts` paging | pass |
| A10 | "SG002-A10" (501 scopes page at 500 and continue by `scopeAfter`) and an unmappable kind forcing `content: partial` with `unsupported_kind` | pass |
| A11 | "SG002-A11" (no reasoning on the wire, tool row keeps its shape) | pass |
| A12 | "SG002-A12/A04" (same baseline replays) + `changes.ts` ranges | pass |
| A13 | `apps/superagent/test/observation.test.ts` (refused / unreachable / unconfigured / reset) | pass |
| A14 | `apps/superagent/test/observation.test.ts` "SG002-A14" (a read that cannot commit its baseline is reported `state_unwritable` and the stored baseline does not advance) | pass |
| A15 | CLI chain on a real daemon (`observe-chain.log`); App strip compiled and running, not yet inspected by eye (gap) | partial |
| A16 | `cursor.test.ts` measured 200-Bot baseline against 64 KiB | pass |
| A17 | "SG002-A17" (provider page inside 192 KiB with a next boundary) and the consumer's largest page serialized as one `result` frame under 256 KiB | pass |

Real-data evidence: the acceptance tests run against stores written by the real runtime
(five turns, a compaction, six forked reflection scopes). The CLI chain evidence uses a
Bot whose store the daemon had just created, so it proves plumbing, not content.

One gap is listed, not hidden: **A15 needs the owner's eye** — the strip compiles, the dev
App runs, and nobody has looked at it. Every other row above is a deterministic test.

## 9. Review record (2026-11-08)

An independent read-only reviewer (`group/reviewing`, `xhigh`) reviewed this spec, its
protocol and its fixtures over three rounds:

| Round | Range | Verdict | Disposition |
| --- | --- | --- | --- |
| 1 | `86f17213..6372c33f` | REQUEST CHANGES, 12 findings (6 P1) | All accepted: per-Bot baselines, range changes, store incarnation, entry-id continuation, pinned schema version 2, non-rankable scope, existing socket, three-part coverage, closed limit/error semantics |
| 2 | `6372c33f..a6397259` | REQUEST CHANGES, 2 closed, 8 partial, 5 new defects | Accepted: `changes` moved to a body-carried baseline, one end-to-end byte budget under the socket cap, delivery trim that still advances, store generation and `stale_page`, scope continuation, mapping/omission split |
| 3 | `a6397259..316e1656` | REQUEST CHANGES, 5 closed, 7 partial, 3 new defects | Fixed: page advance limited to delivered Bots, baseline-comparison identity, 409 disambiguation, continuation pins, `omitted.blocks`, provider state/mapping table, structured store state, empty-store fixture, unknown kinds, fixture ids |

The repository's review limit is three rounds, so the round-3 fixes were verified by a
mechanical specification self-check instead of a fourth review:
`.local/superagent-evidence/spec-selfcheck.log` (26/26 checks, including a measured
43,113-byte worst-case 200-Bot baseline against the 64 KiB body budget). No
implementation, conformance run or live evidence is claimed by this record.
