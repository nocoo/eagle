# Hourly reporting incident, 2026-09-21

Audit window: **2026-09-20 19:00 to 2026-09-21 19:00, UTC+08:00**, covering 24 completed hours. Archive and current-health recheck: 2026-09-21 19:29. An hour in this document denotes its start time.

Production revision: `1a1baa6969549d02930014b7a0188661145f02f3`, version `0.5.0`, Worker version `6bfe4401-7bfb-4d9e-9558-5fafe8cc8472`. The production hourly implementation matches the inspected checkout. Investigation used authenticated viewer requests, Wrangler/D1, Cloudflare GraphQL Analytics, and temporary remote previews calling the deployed Durable Objects.

## Impact

MBP has **12/24** archived reports, with every hour from September 21 **07:00 through 18:00** missing. Mac Studio has **22/24**, missing **15:00 and 18:00**. Every missing machine-hour has persisted source input. The archive counts describe completed reports, not whether the agents uploaded data.

Among reports present in this window, the maximum delay from hour end to generation is **433.9 minutes for MBP** and **194.7 minutes for Mac Studio**. The previous audit used an 18:00-to-18:00 window; its counts and maximum delays therefore differ.

| Local hour | MBP snapshots | MBP semantic changes | MBP input chunks | MBP report | Studio input chunks | Studio report |
|---|---:|---:|---:|---|---:|---|
| 09-20 19:00 | 96 | 54 | 19 | Present | 14 | Present |
| 09-20 20:00 | 120 | 93 | 30 | Present | 13 | Present |
| 09-20 21:00 | 26 | 2 | 4 | Present | 14 | Present |
| 09-20 22:00 | 11 | 0 | 2 | Present | 13 | Present |
| 09-20 23:00 | 2 | 0 | 2 | Present | 13 | Present |
| 09-21 00:00 | 2 | 0 | 2 | Present | 13 | Present |
| 09-21 01:00 | 4 | 0 | 2 | Present | 13 | Present |
| 09-21 02:00 | 4 | 0 | 2 | Present | 13 | Present |
| 09-21 03:00 | 3 | 0 | 2 | Present | 13 | Present |
| 09-21 04:00 | 1 | 0 | 2 | Present | 13 | Present |
| 09-21 05:00 | 5 | 0 | 2 | Present | 17 | Present |
| 09-21 06:00 | 116 | 0 | 19 | Present | 27 | Present |
| 09-21 07:00 | 120 | 105 | 31 | Missing | 12 | Present |
| 09-21 08:00 | 120 | 141 | 44 | Missing | 9 | Present |
| 09-21 09:00 | 119 | 165 | 47 | Missing | 14 | Present |
| 09-21 10:00 | 113 | 109 | 34 | Missing | 13 | Present |
| 09-21 11:00 | 119 | 111 | 32 | Missing | 13 | Present |
| 09-21 12:00 | 120 | 76 | 24 | Missing | 15 | Present |
| 09-21 13:00 | 114 | 125 | 37 | Missing | 12 | Present |
| 09-21 14:00 | 120 | 155 | 43 | Missing | 9 | Present |
| 09-21 15:00 | 48 | 37 | 14 | Missing | 8 | Missing |
| 09-21 16:00 | 4 | 0 | 2 | Missing | 10 | Present |
| 09-21 17:00 | 69 | 44 | 16 | Missing | 14 | Present |
| 09-21 18:00 | 116 | 86 | 28 | Missing | 15 | Missing |

Semantic records represent persisted content changes. Zero changes do not establish that a Manager was offline. Snapshot counts and observation timestamps do not establish continuous monitoring.

## Confirmed failure: hourly input exceeds the generator's capacity

The deployed `MachineState.hourInput()` returns the actual compacted input used by generation. At 08:00, MBP has 120 snapshots, 141 semantic records and 1,355 input records, totaling **2,049,814 JavaScript string characters**. The production algorithm partitions these into **44 chunks**, then throws `Input too large` because the maximum is **32**. The largest individual record is only 5,935 characters, far below the separate 180,000-character record limit.

This is a deterministic failure before any model call. The same guard rejects MBP's 09:00, 10:00, 13:00 and 14:00 inputs: respectively 47, 34, 37 and 43 chunks. An isolated replay of 08:00 produced `stage=input`, `category=Error`, `message=Input too large` after 856 ms, with no model request or archive write.

The largest contributor at 08:00 is **631 distinct visible-terminal summaries**, totaling **1,118,761 characters (54.6%)**. All evidence records together account for 1,401,836 characters. `compactHour()` merges identical values; changing terminal screens remain distinct and accumulate across the hour. Raw evidence preservation is useful, but the model input currently grows with all of these screen changes.

The same failure predates this reboot. Retained MBP hours on September 20 at 10:00, 11:00, 12:00 and 13:00 have 36, 55, 36 and 35 chunks; Mac Studio's September 20 06:00 input has 34.

Code: [input partitioning and size guard](https://github.com/nocoo/eagle/blob/1a1baa6969549d02930014b7a0188661145f02f3/src/worker/hourly.ts), [hour compaction](https://github.com/nocoo/eagle/blob/1a1baa6969549d02930014b7a0188661145f02f3/src/shared/hourly.ts).

## Confirmed scheduling and retry constraints

`pendingHours()` sorts unfinished hours oldest first within the 48-hour input-retention window. `runHourly()` interleaves the machine queues and processes fixed pairs using `Promise.all`. The entire invocation has a **shared 12-minute budget** and stops starting new pairs when less than 90 seconds remain. A single hour receives at most 10 minutes, or the invocation's remaining budget if shorter.

Within an hour, chunk calls are sequential. Each model call has a 90-second timeout. Intermediate validated results exist only in a local `parts[]` array. A chunk, final synthesis, or validation failure discards that progress; the next run starts from the first chunk. Only a complete final report is durably cached for an archive retry. Unchanged oversized hours are retried without a separate permanent-failure state.

These constraints make old expensive hours consume the budget needed for newer hours, including small inputs. Interleaving machines does not provide fairness among hours on one machine, and waiting for each fixed pair delays the next pair even when one member has already failed.

Comparing retained input counts with archived reports suggests that the missing two-chunk MBP 16:00 hour is behind several oversized hours and the 31-/32-chunk morning hours. This ordering is **inferred**, not a direct read of `hourly_jobs`. The exact attempt history of each missing hour is not available from the captured evidence.

Code: [pending hours and job state](../src/worker/machine.ts), [sequential generation and shared scheduler budget](https://github.com/nocoo/eagle/blob/1a1baa6969549d02930014b7a0188661145f02f3/src/worker/hourly.ts).

## Isolated model replay

The temporary remote preview reused the production `completeReport()` and `reportPrompt()`, production settings and the deployed hour input. It followed the same chunking, sequential generation, final synthesis and validation flow. The AI credential stayed in the remote runtime. It did not call `claimHour()`, `cacheHour()`, `finishHour()` or write to D1. Model output was validated and discarded; only stage, timing, count and error metadata were retained.

| MBP hour | Chunks | Isolated result |
|---|---:|---|
| 07:00 | 31 | All chunks passed; final synthesis failed with `TimeoutError` at the 10-minute deadline |
| 08:00 | 44 | Deterministic `Input too large` before any model call, 856 ms |
| 16:00 | 2 | All chunks and the final report passed validation in 96.448 seconds |

The 07:00 replay ran from 19:26:24 to 19:36:25. Its 31 chunks took **555.260 seconds (9 minutes 15 seconds)**, with a median of 19.322 seconds per chunk. They produced 113,606 characters of validated intermediate output, below the 180,000-character reduction limit. Final synthesis began with only 44.740 seconds left and failed at `stage=model_final`, `category=TimeoutError`, `aborted=true`; total request time was 600.544 seconds including input setup. This directly reproduces the timeout mechanism even when the hour receives its full 10-minute allowance. A production attempt after earlier queued work may receive less time.

Under the deployed implementation, all 31 successful chunks would be lost because durable caching happens only after final synthesis and validation. The next scheduled attempt would repeat the model work. The 16:00 control establishes that another missing archived report has usable input and a working current model connection. These replays do not assert that every historical attempt had the same result.

## Production execution evidence

Cron is enabled as `5 * * * *`; hourly settings are enabled and have a configured server-side model credential. Cloudflare GraphQL Analytics records **20 `scriptThrewException` invocations** in the audit window, at :05/:06. Of these, **12 lasted more than 715 seconds**, close to the application's 12-minute budget. The largest measured CPU time is **444 ms**; these measurements do not indicate CPU exhaustion. Analytics timing units were verified from the GraphQL schema as microseconds.

The scheduled handler explicitly throws if any per-hour result contains an error. An invocation marked `scriptThrewException` can therefore also have generated some other hours successfully. It must not be interpreted as all machines failing throughout that hour. WebSocket disconnect outcomes were excluded from this finding.

The subsequent 19:06 invocation also failed, after 163.474 seconds, and no new reports appeared by 19:29. This shorter run shows why every failure cannot be attributed to hitting the total deadline.

Historical Observability log access returned HTTP 403 with the available credential. A live `wrangler tail` session did not capture the targeted Cron event. GraphQL timings establish invocation failures, while size limits, code and isolated replays establish specific failure mechanisms; no uncaptured historical exception category is asserted.

## MBP reboot, sleep and current daemons

`kern.boottime` confirms a reboot at **05:52:30**. Retained source data contains MBP snapshots captured from **06:02:09** onward; the 06:00 hour has 116 snapshots, and 07:00 has 120 snapshots plus 105 semantic records. Capture timestamps alone do not establish upload time.

Server receipt timestamps provide stronger evidence: all **105 semantic changes for 07:00** were accepted between **07:16:48 and 07:58:57**, with a maximum observation-to-receipt delay of **38.127 seconds**. All **141 changes for 08:00** were accepted between **08:01:09 and 08:59:20**, with a maximum delay of **62.711 seconds**. These were already in the cloud that morning. A continuing upload outage after reboot cannot explain the entire missing-report run. The legacy D1 `reports` table provided no snapshot receipt rows for this window; no precise snapshot-upload timing is inferred from it.

`pmset` records clamshell sleep from September 20 **21:11:27** until the next morning's wake, and again on September 21 **15:19:02**, with full wake at **17:28:21**. Intermittent maintenance wakes explain sparse overnight/afternoon sampling. Sleep limits collection; it does not explain why the cloud cannot generate a report from an already persisted hour.

The collector, Manager and realtime services are installed, loaded and running as user LaunchAgents: `com.hexly.eagle-agent`, `com.hexly.eagle-manager`, and `com.hexly.eagle-realtime`. All have `RunAtLoad=true`, `KeepAlive=true`, no disabled override, and direct networking by default without a fixed proxy address. These services start after user login. The separate proxy problem found earlier is documented in [Retrospective](../Retrospective.md); correcting it did not repair the cloud report pipeline.

At 19:29, both machines had recent collector and Manager uploads. Mac Studio had 20/20 current pane summaries; MBP had 27/30 current, two stale and one superseded. The latter counts are a point-in-time freshness result, not proof that those panes were disconnected for the audit window.

## Required correction

1. Bound the model input while retaining original evidence and coverage of every task. Reduce repeated visible-terminal material without silently discarding closed tasks or treating screen text as verified outcomes.
2. Persist validated chunk progress against the input version, so a later failure does not restart all completed work. Keep the existing lease/idempotency guarantees.
3. Prevent old expensive or permanently rejected hours from consuming every run's budget. Give newer pending hours a bounded opportunity to run and distinguish retryable failures from unchanged oversized input.
4. Expose pending hours, failure stage, retry counts and last success. A history view containing only successful archive rows hides the failing queue.

Raising the 32-chunk cap alone does not address sequential latency, lost progress or starvation. Changing the MBP startup configuration alone cannot resolve the confirmed cloud-side input failure.

## Evidence and change scope

Sanitized local evidence is retained under `.local/root-cause-24h/`: D1 archive and semantic metadata, 96 retained machine-hour input summaries, the input-size breakdown, analytics invocation timings, power events, current health and replay stage logs. Raw terminal content, AI credentials and request authentication headers are excluded from these evidence files.

This investigation did not deploy application changes, alter production settings, or backfill archived reports. Temporary diagnostic previews and tail sessions are stopped at closeout. Runtime changes remain a separate implementation task.

## v0.5.1 correction

The follow-up implementation retains raw inputs and all non-terminal facts/semantic records, while projecting the first/latest weak terminal screen per task/source/status for the model. A read-only production projection check reduced MBP 08:00 from 44 chunks to 24 (2,049,814 to 1,080,015 characters) and 07:00 from 31 to 21. The original snapshot/semantic counts and evidence IDs remain unchanged; screen sampling is disclosed in template v4.

Validated chunks, recursive reductions and final synthesis now have durable input/model fingerprints and lease checks. Every five-minute tick resumes eligible work with two independent hour workers, two-minute hour turns, a four-minute run budget and persisted retry backoff. Late input cannot certify an obsolete generation. Pending/error/progress state is included in authenticated history queries and displayed beside archived reports. Full behavior and verification are in [HOURLY-REPORTS.md](https://github.com/nocoo/eagle/blob/300ca885c7412fef94b6b3b4df004c571e6fce55/docs/HOURLY-REPORTS.md).

Pre-release validation passed the isolated eviction/resume, oversized-hour, reduction, fairness, late-input, backoff and stale-lease regressions. Release/deployment and real archive recovery require separate post-release evidence; these implementation checks alone do not establish that historical gaps have been filled.

## Release and recovery verification, 2026-09-22

Published [v0.5.1](https://github.com/nocoo/eagle/releases/tag/v0.5.1) at `31ab65ece258fe2995782f842710a08ebe0dfcff`. Worker version `fef9e222-08a1-4269-af79-e2d19c587a77` serves the matching version/revision on both public origins. Exact-revision CI `35599230216` passed 89 unit/API tests, types, lint, build and 64 browser checks. Real local/public collection, authenticated ingestion and desktop/mobile history verification passed. Both public health endpoints remained HTTP 200 at 05:52:55 on September 22.

The published npm package and downloaded GitHub asset match the tested Agent tarball: SHA-1 `fed657f045af563434d4d4074964c178c2bca92f`. Anonymous official metadata confirms `latest=0.5.1`; an independent Tencent mirror download/install passed version/help checks with empty npm configuration and a fresh cache.

The fixed incident window now has **MBP 23/24 and Mac Studio 24/24**, recovering **13 of the original 14 missing machine-hours**. The original MBP 07:00 timeout and 08:00 oversized-input cases both archived under template v4, retaining respectively 120 snapshots/105 semantic changes and 120 snapshots/141 semantic changes. A captured five-minute Cron completed with three generated hours, three deferred hours and zero failures. The latest complete 24-hour window, September 21 05:00 to September 22 05:00, also has MBP 23/24 and Studio 24/24.

**MBP September 21 13:00 remains unresolved.** All 23/23 chunks are persisted, but final synthesis encounters model timeouts or invalid output. A 90-second diagnostic reproduced `TimeoutError`. Two diagnostic-only attempts extended the individual model limit to 180 seconds and the hour budget to 240 seconds: both returned after approximately 95–99 seconds and failed `ZodError`, `too_big`, on the `workspaces` field, whose maximum is 16,000 characters. Extending the timeout alone does not fix this report. These attempts preserved the same prompt, evidence and validation rules; no invalid report was archived. Production retains its documented 90-second model limit and two-minute hour turns. The pending job retains its progress and retry backoff.

Temporary previews and log watchers are stopped. Sanitized release, registry, archive, Cron and final-stage diagnostic receipts are under `.local/release-v0.5.1-GbSnfD/`. Complete recovery is not claimed; bounded final composition for this oversized output remains follow-up work.

## Follow-up: concise output and explicit cancellation (2026-09-22)

The owner authorized abandoning the remaining backlog and limiting both Manager and cloud narrative output. Release v0.6.0 (`493b671`) adds Manager field/total budgets, v5 hourly section budgets and one bounded compression attempt. It also adds explicit unfinished-job cancellation while preserving raw inputs and completed reports; template-only changes no longer rewrite completed hours.

At 06:15 +08, MBP September 21 13:00 was cancelled, not recovered. Its 114 snapshots, 125 semantic changes and 1,179 input records remained readable after generation checkpoints were cleared. A forced retry returned `discarded`; production history displays cancellation on desktop and mobile. The original audit remains MBP 23/24 and Studio 24/24, with the one missing report deliberately abandoned.

The local Manager was restarted and 24 new bounded summaries were verified in cloud state. Mac Studio's Manager still requires its local package upgrade because SSH authentication was unavailable. Cloud limits apply to reports from both machines. Full verification and the non-archiving real-model sample are recorded in [CHECKPOINTS](CHECKPOINTS.md).
