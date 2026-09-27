# Live Pane summaries

Two independent channels share machine-scoped Bearer authentication. The daemon's v1 report remains a complete deterministic inventory every 30 seconds. A local Manager reads that acknowledged snapshot plus bounded, redacted recent-unwrapped output and native final replies. It calls the machine's configured management Agent (Hermes recommended) only when stable inputs change, with a minimum interval, and sends semantic updates independently. Unchanged inputs generate checks/heartbeats, never another LLM call.

The v1 summary protocol binds entries to machine + space + pane + task ID. Snapshot and semantic streams are independent: no matching report timestamp or sequence is required. A delayed semantic update (up to 30 days) is assigned to its original UTC observation hour, including when its task is no longer current. Its evidence references must resolve to daemon facts collected for that same Pane/task; empty references are explicitly unverified interpretations. It cannot submit or replace Git/test/deployment facts.

A stable manager ID and durable increasing sequence serialize each machine's semantic writer. Identical sequence/body retries acknowledge without refreshing freshness; a reused sequence with different content conflicts. Sequences at or below the high-water mark are rejected once the receipt window expires. A different writer cannot silently take over. An accepted batch is atomic. Entries are unique by space + pane + task, so old-task updates and current-task checks may share a batch. Only changed semantic content appends a record; timestamp-only checks and identical interpretation updates do not add hourly history. The content hash covers taskId + the complete semantic summary, not observation time.

The DO stores semantic records independently of deterministic current state. Latest pointers are per Pane/task; newer sequence with older observation cannot roll back a more recent interpretation or freshness. Current view resolves the daemon's task ID first. Old tasks remain visible in hourly history and can only appear as superseded when no interpretation exists for the new task. Checks require the daemon's current exact fact basis, current task, a snapshot newer than 90 seconds and observations newer than five minutes; they cannot refresh stale facts. Native activity and Git changes immediately make the interpretation stale. Manager connection freshness is separate.

Changed semantic records are atomically stored in DO and its D1 outbox. Idempotent outbox writes replicate immutable history to D1. The API acknowledgement confirms DO persistence even during D1 outage. Whole-snapshot D1 history remains paused; daily AI reports aggregate the retained streams independently.

Manager transport failure preserves pending batches. Private state and input files use 0700 directories / 0600 files. Tokens never enter LLM input, summary bodies, browser persistence or D1. Context from terminals is untrusted data, not executable instructions. A single-instance lock prevents overlapping Manager runs; the daemon never waits for the LLM.

## Data contracts

Daemon `POST /api/v1/reports` keeps `schemaVersion: 1`:

```json
{
  "schemaVersion": 1,
  "reportId": "unique-retry-stable-id",
  "capturedAt": "2026-09-19T10:00:00.000Z",
  "machine": { "id": "mac-one", "name": "Mac", "platform": "darwin", "collectorVersion": "0.4.0", "telemetry": "CPU, RAM, disk, uptime and loopback ports" },
  "spaces": [{ "id": "default:w1", "session": "default", "name": "Eagle", "objective": "...", "tabs": [{ "id": "w1:t1", "name": "Build", "panes": [{ "id": "w1:p1", "agent": "codex", "hint": "working", "task": { "id": "native-task-hash", "title": "...", "requiresDeployment": true }, "rect": "normalized x/y/width/height", "evidence": "native final/Goal/activity, Git, process facts with observedAt/taskId/revision" }] }] }],
  "warnings": []
}
```

The shape above abbreviates large nested objects. `src/shared/schema.ts` is the executable, strict contract. Codex native final replies and turn/tool activity are collected; Grok/Pi final messages are read from bounded native files when their session identity matches the running harness. Native tests/deployment claims stay unverified. Unsupported harnesses bind to terminal/session identity; an animated title never creates a new task.

Manager reads `GET /api/v1/agent-state`, authenticated with the same machine credential, and posts:

```json
{
  "protocolVersion": 1,
  "machineId": "mac-one",
  "managerId": "manager",
  "sequence": 42,
  "sentAt": "2026-09-19T10:00:30.000Z",
  "updates": [{
    "spaceId": "default:w1", "paneId": "w1:p1", "taskId": "native-task-hash",
    "basis": ["sha256-of-daemon-evidence"], "observedAt": "2026-09-19T10:00:00.000Z",
    "summary": {
      "task": "Implement real-time Pane summaries", "phase": "verify",
      "progress": "Live Manager upload is working",
      "outcomes": [{ "kind": "test", "text": "Terminal claims tests passed; no independent receipt", "evidenceRefs": [] }],
      "blocker": null, "nextStep": "Verify production",
      "rationale": "Native activity and Git indicate work continues", "evidenceRefs": ["sha256-of-daemon-evidence"]
    }
  }],
  "checks": []
}
```

Hashes are 64 lowercase hex digits; illustrative placeholders above must be replaced by `evidenceKeys`. `checks` entries have the same binding/basis/observedAt but omit `summary`. Evidence source, kind, status, revision and content are hashed; routine Git/process sampling timestamps are excluded. The immutable history stores the original evidence objects, including timestamps/revisions. Raw recent-unwrapped text is never added to this protocol.

## DO storage and hourly queries

All hour keys use UTC: `observedAt.slice(0,13) + ":00:00.000Z"`. An upload spanning multiple hours splits entries by their observation hours, independently of `sentAt` / receipt time. `source` is stamped by the server as `{managerId,protocolVersion}`; `contentHash` is server-computed SHA-256. Evidence objects retain their own original observation time and revision.

| DO record/key | Purpose / index |
| --- | --- |
| KV `current`, `fact-keys` | daemon's current deterministic snapshot and evidence index; semantic updates never overwrite them |
| SQLite `receipts` | report-ID deduplication, separate from semantic sequence |
| SQLite `fact_evidence` | known facts keyed by `(pane_key,hash)`, task-bound, original payload; supports delayed semantic citations |
| SQLite `semantic_records` | immutable semantic changes with seq, event_id, UTC hour, space/pane/task IDs, Manager sequence, observed/received times, content hash, source, payload |
| `semantic_hours` index | `(hour DESC,seq DESC)` for machine-level hourly aggregation |
| `semantic_pane_hours` index | `(space_id,pane_id,hour DESC,observed_at DESC,seq DESC)` for Pane drilldown |
| SQLite `semantic_current`, `live_tasks` | latest interpretation per `(space_id,pane_id,task_id)`; checks update freshness only; daemon live task pointers are protected from historical retention |
| KV `manager`, SQLite `summary_receipts` | semantic writer/high-water heartbeat and last 128 idempotent batch receipts |
| SQLite `summary_outbox` | durable D1 delivery queue, max 1,000 pending updates with backpressure; alarm retries |

Access-protected query API:

- `GET /api/v1/semantic-hours?machine=M` groups all machine semantic changes by UTC hour. Optional `space=S&pane=P` narrows scope. Returns `{hours:[{hour,count,latest}],nextCursor,retention}`.
- Add `hour=2026-09-19T10:00:00.000Z&mode=latest` for the most recent observation in that hour (sequence breaks equal-time ties).
- Add `hour=...&mode=all` for every record in the hour, paginated by DO record `seq` descending. `limit` is 1–100, default 12. `before` is exclusive: UTC hour for bucket pagination, integer seq for records.
- Each record includes `{seq,hour,contentHash,source,receivedAt,value}`; `value` includes `paneId`, `taskId`, Manager sequence, `observedAt`, summary and original evidence.
- `GET /api/v1/summary-history?machine=M&space=S&pane=P` reads the independent D1 archive, including older replicated records. D1 and DO cursors are distinct.

DO keeps 30 days from receipt, at most 10,000 semantic change records per machine (whichever expires first). Records still in the outbox are protected from deletion until D1 acknowledges them; backpressure bounds the extra queue. Inactive task pointers use the same 30-day / 10,000-entry bound; pointers for the current live inventory (at most 1,000 Panes) remain pinned so delayed historical tasks cannot evict current interpretations. Fact attestations retain 30 days / 50,000 entries; an expired reference is rejected rather than invented. Inputs observed over 30 days ago or more than 30 seconds in the future are rejected. D1 replicas currently retain history without automatic deletion. Retention is enforced on collection, semantic writes and history reads; an idle object's expired rows are removed on its next access.

UI polls DO current state every five seconds, keeps mounted content while refreshing, and shows UTC hour buckets with their latest summary and count. Expanding a bucket fetches all its records with pagination. History polling every 15 seconds updates counts and records without clearing loaded content. Daily reports read these UTC buckets as Beijing 00–23 hourly sections; there is no hourly AI job.

## Continuous Manager

Eagle is agent-neutral. Reuse the machine's existing management Agent; **Hermes Agent is recommended, not required**. Cherry is one machine's local Hermes profile/alias, not a product or dependency to install. Do not search for or install an unrelated Cherry package. If no suitable Agent is configured yet, keep `eagle-agent watch` running and report that semantic setup is pending.

Set `manager.command` explicitly in the existing secure config, preserving its other fields. The command is an argv array, executed without a shell: it receives a UTF-8 instruction followed by bounded input JSON on stdin and must return the requested JSON array on stdout. Use the existing model/provider/profile, disable tools and avoid interactive prompts. A small adapter script can normalize another Agent's input/output. Eagle does not install an Agent or change its model configuration.

For an already configured Hermes, inspect `hermes chat --help`, locate its executable and replace the example path below. Only use flags supported by that installed version. The official project is https://github.com/NousResearch/hermes-agent; follow its installation instructions only if Hermes is actually needed. A working alternative Agent needs no Hermes installation.

```json
{
  "manager": {
    "id": "manager",
    "command": ["/absolute/path/to/hermes", "chat", "--query-file", "-", "--oneshot", "--quiet", "--toolsets", "none", "--ignore-rules", "--source", "tool", "--max-turns", "1", "--run-budget", "55"],
    "minIntervalSeconds": 120,
    "batchSize": 8
  }
}
```

This is a config fragment, not a replacement for `agent.json`. For a named Hermes profile, use its existing launcher/wrapper or documented profile selection; retain the same provider credentials and service environment. The example does not pass model/provider overrides or `--ignore-user-config`. For another Agent, replace the entire `command` array with its verified stdin/noninteractive invocation or adapter; do not reuse Hermes flags blindly. Keep credentials out of argv and model input.

Run `eagle-agent manager-once`, verify actual summaries, then supervise `eagle-agent manager-watch` separately from `watch` using absolute paths and the required PATH/profile environment. Alternatively schedule `manager-once` with the machine's existing cron/scheduler; verify that scheduler's syntax and do not run both schedulers. A single successful cycle does not provide continuous coverage.

Manager has a 65-second subprocess deadline and a persistent 120-second minimum per Pane/task. It interprets changed inputs only; stable inputs refresh freshness without another model call or history entry. Each summary describes task, phase, progress, outcomes, blocker, next step and rationale with deterministic evidence references. Neither Agent output nor a terminal completion claim certifies tests or deployment.

Preserve the existing `manager.id` and `manager-MACHINE_ID/` directory across upgrades, even if its old ID is `cherry`: IDs are durable writer identities, not executable names. Keep sequence, pending batches and cached summaries. When upgrading from 0.4.0's implicit Cherry default, explicitly configure the already working command and keep ID `cherry`; do not reset identity or install a different Agent.

Protocol, independent DO streams, hourly history and retention: https://github.com/nocoo/eagle/blob/main/docs/PANE-SUMMARIES.md
Reusable Skill: https://github.com/nocoo/eagle/blob/main/skills/eagle-report/SKILL.md

Semantic Pane history and daily machine reports are enabled. Historical whole-snapshot D1 writes remain paused.


## Concise Manager output

New Manager interpretations target 200–350 Chinese characters with a hard 600-character total across narrative fields, excluding evidence hashes. Field limits are task 80, progress 120, blocker 80, next step 80 and rationale 100; at most three outcomes may each contain 100 characters. Prompts ask for one sentence per field and preserve verification qualifiers. Oversized output fails before publication or freshness updates and follows the existing retry debounce. The generation policy is included in the input fingerprint; an oversized cached summary is not supplied as the previous interpretation. Original evidence, archived semantic records and writer identities remain unchanged.
