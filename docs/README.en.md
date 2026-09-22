<p align="center">
  <img src="../assets/brand/readme.png" width="128" height="128" alt="Eagle golden eagle logo" />
</p>
<h1 align="center">Eagle</h1>
<p align="center">Herdr Spaces, task evidence and work status across reporting machines.</p>
<p align="center">
  <a href="https://eagle.hexly.ai">Website</a> · <a href="../README.md">简体中文</a>
</p>

## What it does

Eagle is a private dashboard for Herdr users, bringing together each reporting machine's Spaces, pane layouts, resources and task evidence. Missing, conflicting or stale data stays explicit. Agent lifecycle labels such as `idle`, `done` and `blocked` are hints, not proof of task completion.

## Features

- **Cross-machine overview**: inspect machine states, resources and agent distribution, then open a machine for Spaces, actual pane geometry, task evidence and change timelines.
- **Space realtime mode**: a separate machine bridge streams terminal text/layout and accepts input after explicit control. Switching views, leaving or hiding the page releases subscriptions; disconnected inputs are never replayed. See [realtime mode and protocol limits](REALTIME.md).
- **Machine onboarding**: use Connect to add or rename machines, generate one-time onboarding prompts, rotate credentials, disable reporting and re-enable machines.
- **Resources and ports**: report CPU, RAM, home-filesystem capacity and uptime, with optional local TCP endpoint checks. A listening port proves connectivity, not business health.
- **Task evidence**: compare the current task summary, Goal, Git revision and test receipts, with deployment evidence when required. A running Goal or actual tool execution takes priority over apparent completion.
- **Live semantic summaries**: an independent Manager supplies each Pane's task, phase, progress, outcomes, blocker, next step and rationale. Model claims of completion or passing tests do not become verified facts automatically.

The dashboard refreshes every 5 seconds while visible and immediately on return. A heartbeat older than 90 seconds or a snapshot older than 5 minutes is marked stale. Failed refreshes retain the last data with a connection warning. The desktop sidebar collapses, loading placeholders preserve layout, and motion respects reduced-motion preferences.

Each machine has an independent SQLite Durable Object, with current snapshots and semantic streams persisted separately. Semantic changes use UTC hourly buckets based on observation time, support multiple entries per hour and pagination, and are unaffected by heartbeats. Late reports from old tasks cannot overwrite the current task. DOs retain 30 days or 10,000 semantic changes while protecting records awaiting archival; D1 stores archive copies. Whole-snapshot D1 writes remain paused. DOs retain 48 hours of temporary inputs for independent Chinese hourly reports, archived in D1 and available in History. Settings reuses next-ai configuration and defaults to a one-hour cadence; missing AI configuration skips generation. See [hourly reports](HOURLY-REPORTS.md). The overview reads DOs directly without polling D1.

### Authentication and privacy

Cloudflare Access protects the website. The Worker verifies signatures, issuer, application audience, expiry and required claims. Local viewing bypasses authentication only on explicit development/loopback hosts with `LOCAL_DEV="true"`; production disables this flag.

Machines report to `https://eagle-ingest.hexly.ai` with independent signed Bearer tokens, keeping browser SSO out of collection. This host serves machine reports, heartbeats, semantic uploads, the authenticated machine's own snapshot, the realtime bridge and public `/api/live`, but no dashboard or website history. Private APIs do not support CORS. Tokens can be copied only when issued and belong in mode-`0600` machine configuration. The signing key stays in a Worker secret; databases and persistent browser storage hold no tokens. Existing `AGENT_TOKENS` credentials remain supported until rotated or disabled.

The sidebar shows the verified Access account and logout control. Avatar lookup sends only a SHA-256 hash of the normalized email, falling back to the account name and initial on failure. Local preview can set `LOCAL_USER_EMAIL`; logout is disabled locally.

The Codex adapter extracts only final replies and lifecycle events, excluding reasoning and tool arguments. Other harnesses use bounded terminal excerpts and management-agent evidence. Text is redacted before spool/upload, but heuristics cannot guarantee removal of arbitrary secrets. Supply concise summaries and verification receipts instead of raw terminal dumps.

Realtime mode separately transmits redacted current terminal screens. Screen text and input are never persisted in D1, DO storage or browser storage.

## Usage

Open [Eagle](https://eagle.hexly.ai), sign in through Access, add a machine in **Connect**, and give its generated onboarding prompt to the existing management Agent (Hermes recommended; alternatives supported) on that machine.

The collector requires Node.js 24+, npm and Herdr 0.9.1+; realtime input currently requires Herdr 0.9.1 protocol 22. Install it independently from npm without cloning Eagle. The website and Agent share release v0.7.1:

```sh
npm install -g @nocoo/eagle-agent@0.7.1 --registry=https://registry.npmjs.org
eagle-agent --version
```

If npm downloads fail, use the Tencent Cloud mirror instead. Choose one installation command:

```sh
npm install -g @nocoo/eagle-agent@0.7.1 --registry=https://mirrors.cloud.tencent.com/npm/
```

The expected version is `0.7.1`. These commands select a registry for this installation only, without changing the global npm registry. Mirrors may lag (`404` / `ETARGET`); retry later and keep the pinned version. Save onboarding credentials following the [installation and configuration guide](../agent/README.md), then run:

```sh
eagle-agent once
eagle-agent watch
# In a separate process, run the semantic Manager after explicitly configuring manager.command for Hermes or another Agent:
eagle-agent manager-watch
# For web viewing/input, use another process with the same secure configuration; run only one instance:
eagle-agent realtime-watch
```

The deterministic collector runs every 30 seconds by default. Manager uses the existing management Agent and model only when inputs change and the per-task rate limit permits, independently of collection. The secure configuration's `watchPorts` field selects local endpoints, for example:

```json
{"watchPorts":[{"name":"Raven","port":7024}]}
```

See the [agent contract](AGENT.md) for machine identity, credentials, retries, background services and upgrade order. Give the [eagle-report Skill](../skills/eagle-report/SKILL.md) to your management agent. The [report schema](../public/report-v1.schema.json) is generated from the TypeScript validator; the server also checks cross-object uniqueness.

## Development

Requires Node.js 24+ and npm, with Herdr for actual collection. Install dependencies first:

```sh
npm ci
```

Create an ignored `.dev.vars` with an `AGENT_SIGNING_KEY` of at least 32 random characters and set the file mode to `0600`. Use `LOCAL_DEV="true"` for local viewing, with optional `LOCAL_USER_EMAIL` for avatar preview. Optional `AGENT_TOKENS` retains existing machine credentials. Restart Wrangler after changing secrets.

```sh
npm run db:local
npm run dev:api
# In a second terminal:
npm run dev
```

With the local Caddy mapping configured, use [eagle.dev.hexly.ai](https://eagle.dev.hexly.ai). Vite, Worker and inspector use ports `7053`, `37053` and `38053`; browser tests use `27053`, and `17053` is reserved for standalone API E2E. Development, test and production storage are separate.

```sh
npm run build
# Build the independent Agent package from the complete checkout:
npm pack ./agent --pack-destination .local
```

See the [deployment guide](DEPLOYMENT.md) for production deployment and live verification. Availability of interface features in production depends on the actual deployed revision.

## Tests

```sh
npm test
npm run typecheck
npm run lint
npm run build
npm run test:browser
```

`npm test` runs Node tests, with API cases using isolated Miniflare / D1. Playwright covers desktop and mobile pages. `npm run check` combines Node tests, typechecking, linting and the build.

`scripts/verify-live.ts` verifies the real machine-to-authenticated-upload-to-DO-to-Chromium path. It requires a working local or production Agent configuration; production also needs a valid Access JWT. See [live verification](DEPLOYMENT.md#verify-the-live-path) for credential preparation, verification scope and sanitized receipts stored under `.local/`.

## Stack

| Technology | Role |
| --- | --- |
| React, Vite, Basalt, Recharts | Private dashboard, components and visualization |
| TypeScript, Biome | Typechecking and source formatting/linting |
| Cloudflare Workers, Durable Objects, D1 | Authenticated APIs, per-machine state and semantic archives |
| Cloudflare Access, jose | Viewer identity and JWT verification |
| Node.js, Herdr, Zod | Local collection, management agent and report validation |
| Node test runner, Miniflare, Playwright | Unit, API and browser tests |

## Documentation

- [Agent installation](../agent/README.md) and [configuration/reporting contract](AGENT.md).
- [API](API.md), [live Pane semantic contract](PANE-SUMMARIES.md) and [eagle-report Skill](../skills/eagle-report/SKILL.md).
- [Deployment and live verification](DEPLOYMENT.md), [implementation plan](PLAN.md) and [verification checkpoints](CHECKPOINTS.md).
- [Brand provenance](../assets/brand/provenance.json), [Hexly archive](https://hexly.ai/projects/eagle) and [service status](https://status.hexly.ai).

The README uses the rounded golden-eagle presentation. Sidebar, loading, authentication and browser icons use the transparent foreground. Root `logo.png` preserves the 2048px transparent master; the application retains its independent Basalt palette.

## License

The repository has no project-level LICENSE; the Agent package declares `UNLICENSED`.
