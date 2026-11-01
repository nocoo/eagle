# Eagle

Herdr machine/Space overview with a Vite/React dashboard, Cloudflare Worker,
Durable Objects/D1 and a standalone Node Agent. Human overview: [README.md](README.md).

## Scope and sources

Maintain project instructions only in this root AGENTS.md; do not create a
CLAUDE.md alias or copy. Root `package.json` is the npm workspace root and owns
the website/Worker release version; keep its lockfile synchronized. Releases are
independent per surface: the website/Worker take the root version, the Agent takes
`packages/agent/package.json`, and the macOS app takes
`apps/macos/Support/Version.json` (a release bumps only the surface it ships).
`packages/agent/package.json` owns the independent Agent version; CLI output and
packed artifacts derive from it. Website onboarding uses root
`config.publishedAgentVersion`, which must reference a verified published Agent
version and can differ from an unpublished source candidate. The App may ship or be
skipped at will: root `config.publishedMacosVersion` is `/api/live`'s `macos.latest`
and changes only in a release that attaches an app to a GitHub release, never because
`apps/macos/Support/Version.json` moved; only a release-profile app build asks that
endpoint, and a newer answer is a link to the release page, never an automatic
replacement. Published App builds are ad-hoc signed and not notarized, so the download
instructions carry the quarantine removal and approvals by hand; `spctl
--master-disable` is never the fix.
Website-only releases may keep the currently published Agent version and skip npm
publication when Agent behavior, dependencies and protocol requirements are
unchanged. Changes to those require an Agent version bump and publication before
onboarding uses it.
Package tests must verify the packed manifest and installed CLI match the Agent
manifest, while website health/UI versions match the root manifest.

### Repository layout

```
apps/web          Vite dashboard, Cloudflare Worker, D1 migrations, public assets
apps/macos        Eagle SwiftUI app (SPM, macOS 15+); it also hosts the Bots client UI
apps/bots-macos   Bots client logic (SPM package: BotsCore/BotsTransport/BotsFeatures); see its README
packages/contracts  shared zod contracts and pure helpers (private, not published)
packages/agent    @nocoo/eagle-agent, published to npm
apps/bots         Bots daemon: independent product, not a workspace member
docs/bots         Bots contracts; fixtures/bots-protocol holds the wire samples
tests             one Node/Playwright suite at the root, spanning all packages
scripts           live verification and deployment entry points
```

Workspace scripts at the root delegate to `@eagle/web`; run them from the root.
`apps/macos` builds with Command Line Tools alone: no SwiftUI macros
(`@State`, `@Observable`, `#Preview`), no XCTest and no Swift Testing, so it
uses `ObservableObject` and the `LocalState` shim. Tests, strict `swift
format` lint and the 90% logic-coverage gate need the Xcode toolchain, which
`apps/macos/Scripts/*.sh` selects through `DEVELOPER_DIR`.
`swift run SnapshotRenderer` writes review PNGs under the ignored `.local/`.
`packages/agent` compiles `packages/contracts/src` into its own `dist`, so the
published tarball stays self-contained and its `bin` path is unchanged.

- [Bots plan](docs/bots/PLAN.md) owns what is built and what is next.
- [Environment resources](docs/RESOURCES.md) defines cadence, OS evidence and resource history.
- [Agent contract](docs/AGENT.md), [real-time protocol](docs/REALTIME.md),
  [daily reports](docs/DAILY-REPORTS.md) describe product behavior.
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
requires Herdr, but documentation checks do not run the installed live Agent. The
device-runtime test bundles `process.execPath` and refuses a Node that links a
non-system library, which Homebrew's build does, so run the gates (and the pre-push
hook, which runs them) with an official Node build.
Use the machine-approved registry. Ignored `apps/web/.dev.vars` holds `AGENT_SIGNING_KEY`
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

Every change under `apps/macos` ends with a dev App the owner can inspect by
hand: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift run Eagle`
from `apps/macos`, in a pane split to the right of the main pane, never a new tab
and never a background process. The Command Line Tools alone cannot build the
SwiftUI macros, so the toolchain is explicit. The App starts the Bots daemon
itself against `~/.local/share/eagle-bots` on 43117; a `swift run` shell reuses
whatever daemon that root already answers on.

## Bots (isolated product)

`apps/bots`, the `Bots*` Swift targets and `docs/bots/` implement a local
multi-bot chat product backed by `@earendil-works/pi-durable`. It is a separate
product that lives in this repository:

- No code, protocol or build coupling with the website, Worker, Agent or
  contracts. `apps/bots` is not a root workspace member; root `check` and its Linux
  CI job install only the root lock, and root `biome.json` must exclude it. The
  macOS App integration job explicitly installs both independent locks and runs
  `npm run test:devices` through process/port boundaries before the Swift checks;
  Bots retains its own `npm run check`. The client logic is the
  separate SPM package `apps/bots-macos` (BotsCore, BotsTransport, BotsFeatures),
  which depends on nothing from Eagle; the Eagle app depends on it and hosts the
  Bots group in the main window (`apps/macos/Sources/EagleFeatures/BotsWorkspace.swift`).
  The dependency direction is one way: Eagle → Bots logic, never back.
- Documentation is the contract and precedes code: `docs/bots/PRODUCT.md`,
  `ARCHITECTURE.md`, `PROTOCOL.md`, `RUNTIME.md`, `OBSERVABILITY.md`,
  `TESTING.md`, with [PLAN.md](docs/bots/PLAN.md) owning what is built and what is
  next. A behaviour, protocol or log-event change lands with its document
  in the same commit; [PROTOCOL.md](docs/bots/PROTOCOL.md) v1 is additive only and
  `fixtures/bots-protocol/` is normative for both languages.
- Strict TDD per `docs/bots/TESTING.md`: demonstrate the failing test, then the
  smallest implementation, then `cd apps/bots && npm run check` (the client gate,
  `cd apps/bots-macos && swift test`, starts in stage 5). Never skip or focus a test, never widen a limit
  or silence a log to pass. End-to-end acceptance lives in `tests/eval`
  (`npm --prefix apps/bots run eval`): real daemon, scripted model, real tools. It is
  not part of `check`; run it after changing a trigger, a tool or the invocation path.
- Acceptance drives the product through the `eagle-dev` CLI, not a bespoke
  HTTP/WebSocket script: a real command proves the wire, the credential, the scope and
  the exit code at once. The development daemon also accepts a credential an agent
  mints itself at `~/.config/eagle-dev/token`, so a run needs no person at a switch; a
  bundled build never accepts it. `apps/bots/test` keeps the deterministic gates, and a
  permission rule still needs its own assertion there.
- Layer attribution is part of correctness: every crossing logs its layer with
  the shared `trace`, the innermost failure is the only error logged, and the
  diagnosis recipes in `docs/bots/OBSERVABILITY.md` are asserted by tests.
- Phase 1 is chat only. Tools, tasks, usage, raw entries, agent settings and
  bot-to-bot conversation stay behind protocol capability flags and are not
  rendered; they are not deleted or stubbed out.

## Quality contract and current evidence

6DQ retains its name; former G1 merged into L1 on 2026-09-21. Statuses are
`enforced`, `planned`, `manual`, and justified `N/A`. Preserve stricter project
requirements. Configuration evidence is separate from successful execution.

| Dimension | Contract and current state |
| --- | --- |
| L1 | Planned: UT, statements/branches/functions/lines each >=95%, strict types and check-only lint with zero errors/warnings, automatic index-snapshot pre-commit and proven rejection. CI runs Node tests, strict TypeScript, Biome and build via `check`; lint now rejects warnings; coverage thresholds, installed project hooks and complete skip/focus enforcement remain unimplemented. |
| L2 | Planned: every owned endpoint/method over local HTTP plus real SQL/process integration. `tests/api.test.ts` uses real Miniflare/D1 and package/process tests exist; exhaustive endpoint/method coverage and a dedicated push gate are not established. |
| L3 | Configured in CI: Playwright desktop/mobile journeys through `test:browser`. Fresh browser contexts and `reuseExistingServer: false` are configured; this is not proof of every live Herdr/Access journey. |
| G2 | Planned: dependency and secret scanning with missing required tools failing. No scanner step is configured in `check.yml` or a project push hook. |
| D1 | Planned: isolated per-run test state, local targets and guards before fixture writes/cleanup. API tests allocate temporary storage; browser tests use a dedicated port/cache. Complete fixture/marker, daily-dev separation and cleanup proof remain unverified. |

Hooks live in `.githooks/` and are installed by `npm ci` through the `prepare`
script (`core.hooksPath`). Pre-commit lints the staged snapshot with Biome and
swift-format; pre-push runs `npm run check`, the browser suite and the macOS
package tests. `.github/workflows/check.yml` runs the same gates in CI and
`deploy.yml` deploys main after a green Check, skipping with a notice until
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets exist. Never lower
thresholds, skip/focus tests, bypass hooks or suppress failures.

## Resources and operations

Local preview: `https://eagle.dev.hexly.ai` -> Vite 7053 -> Worker 37053
(inspector 38053). Browser tests use 27053; 17053 is reserved for API E2E.
Daily development and test state must remain separate. Use real local
Miniflare/D1 for API checks; never create remote test resources or seed production.
Browser tests build into `.local/browser-dist` and serve Vite preview on 27053
with no API proxy. Each test owns its API/WebSocket fixtures and fresh context;
time-sensitive assertions must pause the browser clock and advance it explicitly.

Public dashboard: `eagle.hexly.ai`; machine ingestion: `eagle-ingest.hexly.ai`.
Deployment and live checks require authorization for that operation. Releases
require real local and public verification per `docs/DEPLOYMENT.md`. Use
`scripts/verify-live.ts` for authorized collection changes; website-only releases
that exclude collection use the documented read-only API/browser checks.
Live checks are not routine documentation validation.

Report actual checks and unresolved gaps with each change. Preserve accident
narratives in the root retrospective; keep only brief recurring project rules
here, cross-project lessons in global rules/nmem and deterministic guards in tests.
