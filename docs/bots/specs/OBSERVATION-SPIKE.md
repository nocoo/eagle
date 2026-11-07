# SG-002 cold-read spike — evidence and frozen decisions

Status: **measured 2026-11-08 on the pinned SDK (`@earendil-works/pi-durable` 1.4.0,
`@earendil-works/chord` 1.4.0); no product code depends on this document yet**.
This is the feasibility gate from
[SUPERAGENT-ARCHITECTURE.md §3](../SUPERAGENT-ARCHITECTURE.md) before SG-002 code.
It measures a **real** pi-durable SQLite written by the real worker runtime over the
faux model provider; nothing here is inferred from source reading alone.

Reproduce: `cd apps/bots && node scripts/probe-cold-read.ts`. Raw log:
`.local/superagent-evidence/observation-spike.log`.

## 1. What was asked

Can the worker service serve `snapshot` / `history` / `changes` from its own
infrastructure, from a **cold** Bot (no Harness, no runtime open, no recovery), while

1. leaving committed worker data byte-identical,
2. returning **complete retained** history including pre-compaction entries and
   child/task scopes,
3. staying inert while a worker is committing,
4. deriving a change cursor that cannot silently skip committed rows?

## 2. Results

| # | Probe | Measured | Verdict |
| --- | --- | --- | --- |
| S1 | `node:sqlite` `DatabaseSync(path,{readOnly:true})` on a closed store | `session.sqlite` unchanged; directory gains `session.sqlite-shm` (32 KiB) and `session.sqlite-wal` (0 B) | **Usable.** Data inert; the sidecars are the WAL shared-memory files any later opener would create anyway. Must be stated, not claimed as "zero files touched" |
| S2a | `openNodeSqliteDatabase` (chord facade, SELECT only) | data unchanged; only `-shm` content rewritten | Usable, but read-write by construction |
| S2b | `openNodeSqliteStorage` (pi-durable storage) | on a current schema: data unchanged, no new tables; runs `applySqliteMigrationsForSchema` on every open | **Not acceptable as the read path.** It writes whenever the SDK schema advances and would mutate a store it is only supposed to observe |
| S3 | Complete retained history, tiny-window bot with compaction + reflection | root conversation 23 entries (11 `pi.compaction`, 11 `head` markers), 6 forked child conversations owned by task, 53 entries total; `history()` returned **12 messages, `hasMore:false`**, 6 author turns | **The runtime read is not the contract.** It serves a compacted root window and reports "no more" while 30 child-scope entries exist. Complete history needs `entries` enumeration across every conversation scope of the store |
| S4 | Missing `session.sqlite` | read-only refuses (creates nothing); `chordFacade` and `sqliteStorage` **create an empty store** | **Existence must be checked before opening.** A fabricated empty DB would present "no history" as a fact |
| S5 | Reader beside a committing writer (40 turns) | 126 reads, 0 failures, p50 0.14 ms, max 0.44 ms; writer unaffected | Inert under load at this scale |
| S6 | `entries.commit_seq` as change cursor | 91 rows, 91 distinct seq values, monotonic; `durable_metadata.next_seq` = 227 (it also advances for tasks, submissions, documents) | **Usable per store**, but there is **no fleet-wide sequence**: the provider must compose per-Bot cursors plus a fleet watermark. A cursor is only invalidated by store replacement (epoch), not by entry deletion — entries are never deleted |
| S7 | Reader holding an open read transaction across 5 writer commits | writer 5.8 ms/turn versus 5.7 ms/turn baseline; no `SQLITE_BUSY` | A held read does not block the writer, but transactions must still be bounded and short (29 ms held here, not a stress result) |

## 3. Frozen decisions

1. **Read path = read-only SQLite connection plus provider-owned schema constants.**
   Not `SqliteStorage.open` (S2b). The constants live in the worker service with a
   conformance test that fails when the pinned SDK's schema changes, so the coupling
   is explicit and guarded rather than implicit.
2. **Existence before open** (S4). A missing `session.sqlite` is `unavailable`, never
   an empty history. Same for a store whose schema version differs from the pinned one:
   report `unsupported`, do not migrate.
3. **History scope enumeration is part of the contract** (S3). Root conversation plus
   forked child conversations (`owner_conversation_id`, `owner_task_id`) are enumerated
   and reported with explicit scope metadata. Serving only the root while claiming
   completeness is the defect this spike found.
4. **Compaction is not deletion** (S3). `entries` retains everything; a `head` marker
   records the compacted boundary and `pi.compaction` entries record the event. History
   returns retained entries and marks the compaction boundary; it never presents the
   compacted window as the whole conversation.
5. **Change cursor = per-store `commit_seq` plus an epoch.** Expiry/gap outcomes are
   typed: store epoch changed → `reset`; the provider's projection watermark lags →
   report lag, not completeness. No fleet-wide sequence is invented (S6).
6. **Reads are single short transactions** (S7), released immediately; no held handle,
   no long transaction, no second Harness.
7. **Sidecar honesty** (S1/S2a). The contract names the allowed side effect: WAL
   `-shm`/`-wal` files may appear or be rewritten; committed data is unchanged.

## 4. Not measured here

- Mapping `entries.record` JSON into the message kinds the contract will expose,
  including tool-output bounding and hidden-entry filtering.
- A real daemon under real model latency and concurrent Bot activity (this spike used
  one Bot and the faux provider).
- Cross-process reads (the provider is intended to live inside the daemon process, so
  the spike measured in-process connections only).
- Store-epoch behaviour across an SDK schema upgrade, and retention/gap injection.
- Any App surface.

These become SG-002 acceptance rows, not new feasibility questions.
