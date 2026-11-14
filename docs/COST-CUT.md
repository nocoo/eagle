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

### P0 cleanup pass (2026-11-14)

After the first deploy a residue audit found leftovers that the plan did not list
because they only surfaced once the endpoints were gone:

- `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@nocoo/next-ai` and `ai` were still in
  `apps/web/package.json`; nothing imported them after `daily.ts` and `ai-secret.ts`
  went away. The lockfile lost 166 lines.
- `apps/web/migrations/` still carried `0001`, `0002`, `0003` and `0005`; the D1
  binding was already gone, so the whole directory went.
- `worker-configuration.d.ts` still declared `DB: D1Database` plus the AI bindings.
  Regenerated with `wrangler types`; deploy-time variables (`AGENT_TOKENS`,
  `LOCAL_USER_EMAIL`, `MACOS_VERSION`, `MACOS_RELEASE_URL`) move to a hand-written
  `apps/web/src/worker/env.d.ts`.
- `scripts/verify-connect.ts` and `scripts/verify-live.ts` still asserted against
  `/api/v1/history`, so both would have failed on the next live run.
- Browser tests still mocked `/api/v1/resources`; `tests/api.test.ts` still listed
  `/api/v1/history` in the ingress allow-list check.
- `.resource-history` and `.resource-note` CSS rules had no remaining consumer.
- The production `AI_ENCRYPTION_KEY` secret was deleted from the Worker.

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
| P0 | 30b66a67 | `npm test` 293/295 (2 known Homebrew-Node failures), `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:browser` 158 passed / 10 skipped | awaiting deploy |
| P1 | 694eba5c | `npm run check` 295/295, `npm run test:browser` 158 passed | deployed 2026-11-14 00:04 UTC, Version `0c159b4c`. MachineState on 2026-11-14 (first 20 min): 476 requests, 3 errors, **6 s wall time** against 594,540 s on 2026-11-13; rows read 136k against 54.5M. Ingest healthy: 167 reports in 15 minutes, 2 WS devices connected, `/api/live` reports revision 694eba5c |
| P2 | not started | - | - |
| P3 | dropped | - | Agent contract change; see below |

## Post-deploy observation (2026-11-14 00:04 UTC, version 0c159b4c)

Twenty minutes after deploy, with the still-unupgraded 10 s agent pings:

| Namespace | Requests | Wall time | Rows read |
| --- | --- | --- | --- |
| MachineState 2026-11-13 (all day) | 97,804 | 594,540 s | 54.5 M |
| MachineState 2026-11-14 (20 min) | 1,138 | 1,808 s | 136 k |
| DeviceExecution 2026-11-14 (20 min) | 1 | 901 s | - |

MachineState duration fell by roughly 78% per day-equivalent, rows read by three
orders of magnitude. What remains is the price of waking a Durable Object at all:
about 1.6 s of billed time per invocation regardless of how much work it does, so
the agent's 10 s ping still costs more than the upload it precedes.

Ingestion stayed healthy throughout: 167 reports in 15 minutes on the ingest host,
one websocket agent connected, `/api/live` reporting revision `694eba5c`.

## P3 dropped

Raising `intervalSeconds` from 30 to 60 would need `sampleIntervalSeconds` to move
with it. `packages/contracts/src/schema.ts` pins that field to the literal `30`, so
every installed agent would start failing report validation until it upgrades. The
saving is about 0.4 M requests per month (under $0.10) against an install-wide
outage window, so it stays undone until an agent release carries both changes.

## P2 remains

`DeviceExecution` keeps a plain `socket.accept()` agent connection, which prevents
hibernation for as long as a device is online. Moving the agent side to
`ctx.acceptWebSocket(socket, ["agent"])` would let the object sleep between
operations; the request side and its in-memory waiters stay as they are, because a
live request keeps the object awake by design. This is a rewrite of the agent frame
path (authentication, heartbeat, renewal, policy result, result relay) across the
638-line `device-execution.ts`, covered by 38 device tests.

## Device plane stopped (2026-11-14)

`DeviceExecution` was the last cost centre: a device keeps one plain
`socket.accept()` websocket open, so the object never hibernates while a machine is
online. The usage came from the Mac's own background item, not from an active Bots
conversation: `launchctl print gui/501/ai.hexly.eagle.devices` showed the App 0.25.0
service running for three days, re-registering every ~5 minutes (25
`register/challenge` calls in two hours) and holding one
`/execution/{deviceId}/agent` connection.

Both sides are now stopped by hand:

- Local: `launchctl bootout gui/$(id -u)/ai.hexly.eagle.devices`.
- Worker: deployed a maintenance entry instead of `device-service.ts` — the same
  Durable Object bindings and custom domain, a handler that answers `503` without
  touching a Durable Object. Version `314b585f`. The entry lives outside the
  repository (`.local/maintenance/`) and re-exports `DeviceRegistry` and
  `DeviceExecution` so wrangler keeps both classes.

Restore the product with `npx wrangler deploy --config apps/web/wrangler.devices.jsonc`
after the App registers its device service again. Restoring before P2 ships returns
the duration charge with it.

The ~5 minute re-registration loop is a separate defect: a session that renews
normally would register once and renew, so the client is most likely falling back to
a fresh registration after a failed renewal.

## Retired storage dropped (2026-11-14, version 49ae8bd7)

`MachineState` now drops eleven retired tables and two keys when an object starts,
and `MachineDirectory` drops `daily-settings`, `hourly-settings` and `ai-credential`.
Both objects are left with the receipt ledger, the current snapshot and the machine
index.

Every machine object ran the cleanup within two minutes of the deploy because the
agents keep reporting (63 reports in six minutes afterwards). `MachineDirectory` is
only reached by authenticated viewer calls, so its three keys disappear the next time
a dashboard or App loads the fleet overview; nothing reads them meanwhile.

## Agent 1.2.0 published (2026-11-14 10:27 UTC)

`@nocoo/eagle-agent@1.2.0` is on the official registry as `latest`; shasum
`0ffa4be0…` and `sha512-YAUz6S4R…` match the tarball built from `06ea7caf`, the
Tencent mirror carries the same version, and a clean install in an empty cache
reports `1.2.0`. The website deploy `1f3c620f` (Version `093bb54c`) pins onboarding
to it.

This machine's two launchd services were restarted on 1.2.0. The other machines still
run 1.0.0 until they are upgraded; the server accepts both cadences, so the relay and
ingestion keep working across a staged rollout.

Per machine, the ping change removes about 7,200 requests a day (8,640 → 1,440). With
all eight upgraded the fleet drops from ~80k to ~28k requests a day.
