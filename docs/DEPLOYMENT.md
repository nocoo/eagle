# Deployment and live verification

Commands run from the repository root. See [local setup](../README.md#开发) before verifying the development origin.

## Local frontend, Local or Prod backend

`npm run dev` exposes a Local / Prod segment in the header at
`https://eagle.dev.hexly.ai`. Local is the default; it uses the local Worker
on port 37053. Prod keeps the local frontend and proxies viewer API requests
and realtime WebSockets to `https://eagle.hexly.ai`. **Prod has full production
read/write access**, including settings, machine credentials and terminal input.
It is not a preview or a read-only mode. Automated checks use synthetic upstreams.

Before selecting Prod, authenticate the local proxy in your terminal:

```sh
cloudflared access login --quiet https://eagle.hexly.ai
```

The proxy retrieves the cached application token using `cloudflared access token`;
it never sends it to the frontend. Missing or expired authentication fails closed
with a login instruction, without falling back to Local. Browser logout is
disabled for this local proxy identity, which is managed by cloudflared.

The selection is per-tab session storage. Switching reloads the home page,
discards unsaved forms and closes existing realtime connections. Terminal drafts
are separated by environment and are never sent automatically. Previously
submitted production operations may still finish; switching does not undo them.
Each request has a fixed environment path, so another tab cannot retarget it.
Production onboarding uses `eagle-ingest.hexly.ai`; Local uses the local origin.
The gateway is dev-server-only and does not add a production Worker route.

## Verify the live path

```sh
NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" node scripts/verify-live.ts
```

`verify-live.ts` reads `.local/agent-dev.json` by default; local viewing needs no credentials. For production, set `EAGLE_VERIFY_ORIGIN=https://eagle.hexly.ai`, `EAGLE_CONFIG` to the production agent configuration and `EAGLE_ACCESS_JWT_FILE` to a mode-0600 file containing a genuine Access application JWT. Obtain it through `cloudflared access login --quiet https://eagle.hexly.ai`; never paste credentials into commands or logs. Screenshots and sanitized receipts remain in ignored `.local/`. The script checks anonymous Access redirection, authenticated viewing, idempotency, every real Space, automatic updates, history and mobile layout.

## Website-only releases

The root manifest owns the website/Worker version and
`config.publishedAgentVersion` owns its verified npm onboarding pin. An
unpublished Agent source version is not an installation target. A website-only
release may leave `agent/package.json` unchanged and use the existing published
Agent; do not publish npm, restart collectors, or change real machine configs.

The current GitHub workflow runs checks on main/PR only; it has no npm/tag/release
publication trigger. `npm run deploy` builds the website and deploys only the
Eagle Worker with `BUILD_REVISION` from a clean, committed HEAD. Inspect these
triggers again for every release before pushing a tag. Use an ordinary version
tag and GitHub Release only after exact-SHA CI and the authorized deployment.

Run `wrangler d1 migrations list eagle --remote` first. Apply only genuinely
pending required migrations; the resource-history table is initialized inside
each existing machine DO, with no new D1 migration. Preserve Worker secrets.

`verify-live.ts` actively collects and uploads a real machine report. When the
release explicitly excludes collection, use a separate read-only verifier:
check the real local origin and production health/version/revision, anonymous
Access redirects, authenticated viewer/overview/resource reads and actual
Chromium rendering. Reuse a genuine application JWT in a private file, never
an Agent token as viewer auth. Do not modify machines, issue tokens, ingest
fixtures, send realtime input, or trigger daily jobs. Record actual existing
collector versions, sample timestamps and empty history instead of treating
synthetic validation as production evidence. Missing Access login blocks
protected-page verification, not permission to disable authentication.

## Deploy

For realtime changes, also run `node scripts/verify-realtime.ts` against both origins with their realtime bridges running. See [Space realtime mode](REALTIME.md). On this Mac the production realtime bridge is supervised separately as `com.hexly.eagle-realtime`.

```sh
npm run check
npm run test:browser
npm run db:remote
# Never put secret values on the command line or in source.
npx wrangler secret bulk /secure/path/platform-secrets.json
npm run deploy
```

The Worker owns `eagle.hexly.ai` as a custom domain. `https://eagle-ingest.hexly.ai/api/live` publicly probes the first configured machine DO and returns no inventory. The read-only reviewers are advisory; the integrator commits on `main`. See [checkpoints](CHECKPOINTS.md) for real data verification and [API](API.md) for ingestion/query semantics.

## AI daily reports

Migration `0004_daily_reports.sql` creates the daily archive and drops the old
hourly archive; apply it immediately before deploying the matching Worker. The
new Worker installs only `59 15 * * *` (Beijing 23:59). Each machine DO drops old
hourly jobs/steps when initialized, retaining raw snapshots and semantics. The
existing AI connection and encrypted credential are preserved. Set `AI_ENCRYPTION_KEY` once using a cryptographically random value of at least 32 characters (`npx wrangler secret put AI_ENCRYPTION_KEY`, interactive input or secure file stdin). Do not overwrite an existing wrapping key. Local development uses the same binding in gitignored `.dev.vars`.

Users save provider/model and API keys in `/settings`. The directory DO stores authenticated ciphertext in the separate `ai-credential` record; API responses never return the key. Blank input keeps the existing credential, explicit clearing removes it, and changing provider/endpoint/protocol/authentication requires a new key. Without a complete AI configuration the schedule is a no-op.

Run `scripts/verify-daily.ts` with the same origin/Access settings as `verify-live.ts` to verify settings, no secret exposure, unconfigured skip, D1 query, report UI and mobile layout. The detailed generation/storage contract is in [DAILY-REPORTS.md](DAILY-REPORTS.md).
