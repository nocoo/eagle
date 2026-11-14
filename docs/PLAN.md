# Eagle v1

Owner: Codex integrates on main; Grok/Pi in this Space provide read-only research/review.

- Vite + React 19 + Basalt 2.1.8, Biome, TypeScript exactly 7.0.2.
- Worker with one SQLite Durable Object per configured machine, versioned strict snapshots, per-machine Bearer secrets; viewers use Cloudflare Access (local viewing needs no token). Tokens never enter DO state, D1 or browser storage.
- Full inventory includes every Space/tab/pane and normalized layout. Explicit evidence combines final summaries, goals, Git, tests, processes and deployment checks. Lifecycle badges are weak hints. Unknown evidence remains unknown.
- Transactional, content-checked idempotency; stale delivery cannot rewind current state. Independent heartbeat and stale-machine indicator.
- Executive overview, topology, pane evidence drilldown and DO current changes. There is no database, no scheduled job and no AI configuration; the overview reads each machine DO directly. Browser refresh every five seconds with failure and freshness visibility.
- Node agent with durable retry spool and reusable Skill, secrets in a 0600 config. No arbitrary commands from remote reports.
- Local HTTPS `<dev host>` → Vite 7053 → Worker 37053. Tests use 17053/27053. Publish `<prod host>`.

## Test-first slices

1. Schema and evidence reducer adversarial tests → implementation.
2. Actual SQLite DO / legacy D1 API tests: auth, validation, dedup/conflict/concurrency, late reports, heartbeat, history → implementation.
3. Collector/redaction/retry tests → real inventory pipeline.
4. Browser behavior tests → Basalt app; desktop/mobile visual inspection.
5. Authenticated real local and production capture → upload → DO → browser (verify no new D1 rows); repeat upload; unauthenticated access; ongoing reporter.

## Checkpoints

Every 15 minutes from 2026-09-19 13:43 Asia/Shanghai, record what a user can actually see, the first broken hop and the next correction in CHECKPOINTS.md. No milestone is considered complete solely from a pane badge.

Device pairing uses the independent product service on its own custom domain (the ignored
deployment config names it; no `workers.dev` hostname is served).
Its current delivery scope and evidence live in [the device plan](bots/PLAN.md#共享设备与配对重构2026-10-29);
it does not deploy or alter the existing website/ingest services.
