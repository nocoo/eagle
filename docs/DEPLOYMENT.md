# Deployment and live verification

Commands run from the repository root. See [local setup](../README.md#开发) before verifying the development origin.

## Verify the live path

```sh
NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" node scripts/verify-live.ts
```

`verify-live.ts` reads `.local/agent-dev.json` by default; local viewing needs no credentials. For production, set `EAGLE_VERIFY_ORIGIN=https://eagle.hexly.ai`, `EAGLE_CONFIG` to the production agent configuration and `EAGLE_ACCESS_JWT_FILE` to a mode-0600 file containing a genuine Access application JWT. Obtain it through `cloudflared access login --quiet https://eagle.hexly.ai`; never paste credentials into commands or logs. Screenshots and sanitized receipts remain in ignored `.local/`. The script checks anonymous Access redirection, authenticated viewing, idempotency, every real Space, automatic updates, history and mobile layout.

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
