# Eagle

Herdr machine/Space overview with a Vite/React dashboard, Cloudflare Worker,
Durable Objects/D1 and a standalone Node Agent. Human overview: [README.md](README.md).

## Scope and sources

Maintain project instructions only in this root AGENTS.md; do not create a
CLAUDE.md alias or copy. Root `package.json` owns the release version. Keep
`agent/package.json`, the root lockfile and installation docs synchronized;
runtime/onboarding versions derive from the root manifest. The package test
must verify the published manifest and installed CLI match it.

- [Agent contract](docs/AGENT.md), [real-time protocol](docs/REALTIME.md),
  [hourly reports](docs/HOURLY-REPORTS.md) describe product behavior.
- `.github/workflows/check.yml`, `package.json`, `tests/`, TypeScript/Biome and
  Playwright configs describe current enforcement, not guaranteed passing runs.
- [Deployment](docs/DEPLOYMENT.md) owns operational setup and live verification.
- [Retrospective.md](Retrospective.md) owns incident narratives.

## Project boundaries

- Implement on `main` with coherent atomic commits. Preserve user changes. The
  integrating agent owns writes; reviewers in the Herdr Space are read-only.
- Strict TDD for behavior changes: demonstrate a failing behavior, implement the
  smallest fix, then run affected checks. `npm run check` and
  `npm run test:browser` remain release gates.
- Fixed stack: Vite, Biome, TypeScript 7.0.2. All controls/application chrome use
  published `@nocoo/basalt`; consult its installed integration docs. Do not add a
  second component or color system.
- Tokens live only in secure configuration. Never put them in report payloads,
  D1, URLs, source, browser storage, screenshots or command arguments.
  Authentication errors fail closed.
- Preserve versioned whole-machine snapshots, idempotency, capture ordering,
  session-scoped identities, freshness and evidence provenance. Lifecycle badges
  never certify task completion; missing data remains unknown.
- During long implementation work, record a user-view checkpoint every 15 minutes
  in `docs/CHECKPOINTS.md`: actual Herdr collection, authentication, D1, rendering
  and the next broken hop. Do not invent successful verification.

## Setup and commands

Run from the root with Node.js 24+ and npm; CI uses Node 26. Actual collection
requires Herdr, but documentation checks do not run the installed live Agent.
Use the machine-approved registry. Ignored `.dev.vars` holds `AGENT_SIGNING_KEY`
(at least 32 random characters, file mode 0600), `LOCAL_DEV="true"` for local
browsing, optional `LOCAL_USER_EMAIL`, and optional existing `AGENT_TOKENS`.
Never copy production credentials into tests. Restart Wrangler after changes.

```sh
npm ci
npm run db:local
npm run dev:api
npm run dev
npm test
npm run typecheck
npm run lint
npm run build
npm run check
npm run test:browser
```

Run API and Vite development servers in separate terminals. CI installs Chromium
with `npx playwright install --with-deps chromium` before browser tests. `format`
is an editing command, not a check; checks must not run autofix.

## Quality contract and current evidence

6DQ retains its name; former G1 merged into L1 on 2026-09-21. Statuses are
`enforced`, `planned`, `manual`, and justified `N/A`. Preserve stricter project
requirements. Configuration evidence is separate from successful execution.

| Dimension | Contract and current state |
| --- | --- |
| L1 | Planned: UT, statements/branches/functions/lines each >=95%, strict types and check-only lint with zero errors/warnings, automatic index-snapshot pre-commit and proven rejection. CI runs Node tests, strict TypeScript, Biome and build via `check`; no coverage threshold, explicit warning rejection, installed project hook or complete skip/focus gate is established. |
| L2 | Planned: every owned endpoint/method over local HTTP plus real SQL/process integration. `tests/api.test.ts` uses real Miniflare/D1 and package/process tests exist; exhaustive endpoint/method coverage and a dedicated push gate are not established. |
| L3 | Configured in CI: Playwright desktop/mobile journeys through `test:browser`. Fresh browser contexts and `reuseExistingServer: false` are configured; this is not proof of every live Herdr/Access journey. |
| G2 | Planned: dependency and secret scanning with missing required tools failing. No scanner step is configured in `check.yml` or a project push hook. |
| D1 | Planned: isolated per-run test state, local targets and guards before fixture writes/cleanup. API tests allocate temporary storage; browser tests use a dedicated port/cache. Complete fixture/marker, daily-dev separation and cleanup proof remain unverified. |

There are no tracked project commit/push hooks or manifest hook installation.
Target: unified L1 on the index snapshot in pre-commit (<30s); applicable L2/G2
on stdin push refs in pre-push (<3min). These targets are not implemented by CI
alone. Never lower thresholds, skip/focus tests, bypass hooks or suppress failures.

## Resources and operations

Local preview: `https://eagle.dev.hexly.ai` -> Vite 7053 -> Worker 37053
(inspector 38053). Browser tests use 27053; 17053 is reserved for API E2E.
Daily development and test state must remain separate. Use real local
Miniflare/D1 for API checks; never create remote test resources or seed production.

Public dashboard: `eagle.hexly.ai`; machine ingestion: `eagle-ingest.hexly.ai`.
Deployment and live checks require authorization for that operation. Releases
require `scripts/verify-live.ts` against the real local and public origins;
those live checks are not routine documentation validation.

Report actual checks and unresolved gaps with each change. Preserve accident
narratives in the root retrospective; keep only brief recurring project rules
here, cross-project lessons in global rules/nmem and deterministic guards in tests.
