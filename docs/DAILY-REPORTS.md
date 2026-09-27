# AI daily reports

Each machine gets one Chinese report per Beijing calendar date. The only Worker
Cron is `59 15 * * *`: 23:59 in `Asia/Shanghai`. It starts at 23:59 and covers
00:00 inclusive through 23:59 exclusive. The final minute is deliberately outside
this cutoff. Uploads received after generation are absent until a manual rerun.
The UI states this coverage; an empty hour means unknown, not inactivity.

## Collection and input

The deterministic collector and local Manager keep their existing schedules.
Snapshots remain in DO `hourly_facts` for 48 hours. Semantic changes remain in
UTC hour buckets for 30 days or 10,000 entries, with the independent D1 outbox
unchanged. The cloud report reads 24 UTC buckets corresponding to Beijing 00–23.
It does not generate or archive separate hourly AI reports.

Each bucket is compacted without changing raw evidence. Visible terminal evidence
retains first/latest screens per task. The model receives a bounded sample:
semantic records first, then other records, newest observation first. Each record
retains its source ID and first/latest timestamps; values over 1,000 characters
are marked excerpts. Each hour has a 4,000-character serialized record budget,
for at most 96,000 characters of records per day. Coverage stores raw and retained
counts, excerpt/omission counts, snapshot/semantic counts and observation bounds.
The UI marks sampled hours. The report does not claim exhaustive task coverage.

## Model and output

The global settings retain the current provider/model/endpoint/credential.
Production currently uses Manifest's OpenAI-compatible endpoint with model `auto`;
Eagle records that configured model, not the resolved upstream model or its cost.
No Workers AI binding is used. OpenAI Chat Completions and Anthropic Messages
remain supported with endpoint-bound encrypted keys and redirects rejected.

Template `eagle-daily-zh-v1` accepts only this JSON shape:

```json
{
  "overview": "Chinese overview, at most 160 characters",
  "hours": [
    { "hour": 0, "summary": "At most 80 characters", "evidenceIds": [] }
  ],
  "nextSteps": ["At most 60 characters per item; at most three items"]
}
```

The actual `hours` array must contain exactly 24 ordered items, 0 through 23.
Unknown fields, invalid JSON, non-Chinese prose, excess length, unknown citations,
cross-hour citations and missing evidence for populated hours fail validation.
An empty hour must say `无采集数据。` with no citations. Each populated hour cites
1–3 supplied `Hxx-Fn`/`Hxx-Sn` IDs. Maximum prose length is 2,260 characters,
including punctuation. Metadata, hour labels and citation arrays are separate.
The parser never truncates an invalid model output into an accepted report.

## Execution and failure

Each machine/day normally needs one model call. At most one retry is allowed for
transport, output or validation failure. Authentication errors fail immediately.
Each call has a 90-second timeout and 6,000 output-token cap; each machine has a
four-minute turn. Two machines can run concurrently within a 12-minute invocation
budget, below Cloudflare's 15-minute Cron wall limit. Excess fleet work is reported
as deferred and requires a manual run. One Cron does not mean one fleet-wide call.

DO `daily_jobs` persists a five-minute exclusive lease, input version, attempt,
stage, safe error, completion and pending final report. A changed input cannot
cache an obsolete final; an expired/replaced lease cannot update job state.
Duplicate Cron delivery never regenerates an already attempted day. Failure is
visible and can be manually retried, without periodic report polling or alarms.
Successful validated content is cached before D1 writes. Archive retries reuse
that content even after raw input expiry; later daily runs also drain pending
archives. D1 enforces one row per `(machine_id,date)` with a guarded upsert.

Jobs without pending content retain 30 days. Raw regeneration requires the entire
date to fit the 48-hour snapshot-retention window; expired input is reported,
never silently treated as a complete day. The archive has no automatic expiry.

## API and UI

- `GET/POST /api/v1/settings`: AI connection and daily enablement; no cadence field.
- `POST /api/v1/settings/test`: bounded connection test without saving a draft key.
- `POST /api/v1/daily-reports/run`: optional `{machine,date}`; `date` is a Beijing
  `YYYY-MM-DD` already due at 23:59. Defaults to the latest due date. Same input
  returns unchanged; late input triggers regeneration. Old dates may still retry
  a cached archive, otherwise return `input_expired`.
- `GET /api/v1/daily-reports?machine=...&date=...&limit=12&before=...`: D1 entries,
  date/sequence pagination, and safe persisted job state.

All report/settings APIs require viewer Access; machine credentials cannot call
them. History filters by Beijing date independently of display timezone. Expanded
cards use 24 compact hour rows and keep expansion during refresh. Failed jobs have
a manual retry button. Settings explains the fixed schedule and format limits.

## Cutover and verification

Migration `0004_daily_reports.sql` creates `machine_daily_reports` and deletes
the old hourly archive. Machine DO initialization drops hourly jobs/steps while
preserving raw snapshots and semantic tables. Directory initialization moves
the existing AI configuration to `daily-settings`, removes its cadence field and
deletes the old settings record; the encrypted credential remains intact.
The old hourly endpoints, UI and generation code are removed.

Run `npm run check`, `npm run test:browser`, real local/public `scripts/verify-live.ts`
and `scripts/verify-daily.ts`. The latter checks authentication, settings, schema,
D1 reads, expansion continuity and mobile rendering without generating reports
when AI is already configured. Production generation verification must explicitly
run a real date and inspect the archived result; mocks alone do not establish it.
