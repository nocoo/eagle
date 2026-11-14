# Durable Objects cost reduction

Status: executing. Owner decisions fixed the product boundary on 2026-11-13.

## Product boundary

Keep only three capabilities:

1. Each machine reports its own state (ingest → current snapshot).
2. A viewer can connect (realtime relay).
3. A person can send commands (realtime input + device execution).

Delete everything outside that line: the semantic manager layer (hermes), AI daily
reports, password/credential leak scanning, and the retention buckets that existed
only to feed them.

## Baseline (14 days of Cloudflare analytics, monthly run rate)

| Item | Usage | Included | Cost |
| --- | --- | --- | --- |
| DO requests | 4.56 M | 1 M | $0.53 |
| SQL rows read | 1.74 B | 25 B | $0 |
| SQL rows written | 8.4 M | 50 M | $0 |
| Duration | 3.46 M GB-s | 0.4 M | $38.2 |

Duration is 98.7% of the bill and has exactly two sources: `MachineState` (2.3 M,
67%, kept awake by a 10 s agent ping) and `DeviceExecution` (1.15 M, 33%, a long
suspended fetch that blocks hibernation). Requests, rows read and rows written are
free at this volume; they are still cut because they cost latency.

`wallTime × 128 MB` is used as the duration proxy. Cloudflare subtracts I/O wait
from billed duration, so these numbers are upper bounds.

## Evidence that the deletions are dead code

| Feature | Evidence |
| --- | --- |
| Daily reports | Remote D1 has no `machine_daily_reports`; `/api/v1/daily-reports` had 0 requests in 7 days |
| Resource history | `/api/v1/resources` 21 requests in 7 days |
| Machine history | D1 `reports` stops at 2026-09-19, 847 rows, no INSERT in code |
| Dashboard pages | `overview` 91, `machines`/`settings` 0 in 7 days; `/api/live` 12,248 (probe) |
| Realtime relay | 11 viewer connections in 7 days, but it is a kept capability, so it is optimized rather than deleted |

## P0 — delete dead paths

Deletions, no behaviour change to the kept capabilities.

- P0.1 Credential scanning: `noSecrets` and its 8 call sites, `containsCredential`,
  `ai-secret.ts`, `MachineDirectory.aiKey/saveSettings/settings`, `/api/v1/settings`,
  `/api/v1/settings/test`, `web/Settings.tsx`. `agentIdentity` stays.
- P0.2 AI reports: `worker/daily.ts`, `contracts/daily.ts`, `/api/v1/daily-reports`,
  `/api/v1/daily-reports/run`, the cron trigger, `daily_jobs`, `web/DailyHistory.tsx`,
  `migrations/0004_daily_reports.sql`.
- P0.3 Retention buckets: `hourly_facts`, `resource_samples`, `pruneResources`,
  `resources()`, `contracts/resources.ts`, `contracts/report-input.ts`,
  `/api/v1/resources`, `web/useResourceHistory.ts` and its chart. `report.telemetry`
  and the current resource card stay.
- P0.4 Semantic residue: the six `DROP TABLE` and two `kv.delete` statements in the
  `MachineState` constructor, agent `RETIRED_CONFIG_KEYS`, doc sections.
- P0.5 Dead data: `/api/v1/history`, `/api/v1/history/previous`, D1 `reports` and
  `machines`, and the `/api/live` call into `MACHINES.current()`.

`receipts` stays: it is the idempotency ledger.

After P0 one `ingest` reads about three indexed rows instead of scanning 2,800.

## P1 — realtime relay cost model (capability kept)

- Agent ping 10 s → 60 s; server heartbeat timeout 35 s → 90 s.
- Stop re-arming an alarm on every websocket message; arm on socket set changes.
- Device heartbeat 10 s → 60 s, lease 30 s → 90 s.
- Release order: worker first (tolerate old 10 s agents), then the npm agent.

## P2 — device execution cost model (capability kept)

Replace the suspended long fetch with alarm-driven completion plus
`GET /api/v1/devices/v1/execution/{id}/result` short polling. Additive to the
wire v1 contract; needs one App/bots client change.

## P3 — report cadence

`intervalSeconds` 30 → 60.

## Expected bill

| Stage | Requests | Rows read | Duration | Cost |
| --- | --- | --- | --- | --- |
| Baseline | 4.56 M | 1.74 B | 3.46 M GB-s | $38.7 |
| P0 | 3.3 M | 0.6 M | 3.46 M | $38.6 |
| P0+P1 | 1.5 M | 0.6 M | 0.5 M | $1.5 |
| +P2 | 1.5 M | 0.6 M | 0.15 M | $0.3 |
| +P3 | 0.9 M | 0.6 M | 0.15 M | $0 |

## Verification

- Every stage: `npm run check` and `npm run test:browser`; deleted tests are deleted,
  never skipped.
- Every stage: compare requests, rows read, rows written and wall time over a fresh
  three-day window.
- Final: the dashboard Durable Objects duration chart is the billing truth.
- P1 needs a real machine check: terminal latency at a 60 s ping and disconnect
  detection within 90 s.

## Execution log

| Stage | Commit | Checks | Measured after deploy |
| --- | --- | --- | --- |
| P0 | this commit | `npm test` 293/295 (2 known Homebrew-Node failures), `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:browser` 158 passed / 10 skipped | awaiting deploy |
| P1 | pending | pending | pending |
| P2 | pending | pending | pending |
| P3 | pending | pending | pending |
