# Eagle

Herdr machine/Space overview (Vite/React dashboard, Cloudflare Worker, Durable Objects, Node Agent) plus the macOS SwiftUI app and isolated Bots/Superagent services.
Docs: [README](README.md) · [Deployment](docs/DEPLOYMENT.md) · [Agent](docs/AGENT.md) · [Realtime](docs/REALTIME.md) · [Cost cut](docs/COST-CUT.md) · [Bots plan](docs/bots/PLAN.md) · [Retrospective](Retrospective.md)

## Layout

```text
apps/web              Vite dashboard, Cloudflare Worker, public assets
apps/macos            Eagle SwiftUI app (SPM, macOS 15+); hosts Bots UI
apps/bots-macos       Bots client logic (SPM: BotsCore/BotsTransport/BotsFeatures)
apps/bots             Isolated Bots daemon (pi-durable); non-workspace, own lock
apps/superagent       Isolated Super Bot service; non-workspace, own lock & check
apps/superagent-macos Super Bot client logic (SPM); own tests & 90% coverage gate
packages/contracts    Shared Zod contracts and pure helpers (private)
packages/agent        @nocoo/eagle-agent (npm); compiles contracts into its dist
docs/bots             Bots/Superagent contracts; fixtures/bots-protocol wire samples
tests / scripts       Root Node/Playwright suite; live-verify and deploy scripts
```

## Commands

Run root commands with Node 24+ (CI: Node 26) and npm; workspace scripts delegate to `@eagle/web`. Use an **official Node build** (no non-system dylibs like Homebrew) for gates/hooks because `device-runtime` tests bundle `process.execPath`. Live collection needs Herdr; doc checks do not run the live Agent. Run `dev:api` and `dev` in separate terminals. Ignored `apps/web/.dev.vars` (0600) holds `AGENT_SIGNING_KEY` (>=32 chars), `LOCAL_DEV="true"`, optional `LOCAL_USER_EMAIL`, and optional `AGENT_TOKENS`; restart Wrangler after edits.

```sh
npm ci                                 # install root workspace & .githooks
npm run dev:api                        # Wrangler Worker 37053 (inspector 38053)
npm run dev                            # Vite 7053 -> https://eagle.dev.hexly.ai
npm run typecheck                      # S1 (tsc --noEmit)
npm run lint                           # S2 (biome check, 0 warnings; format edits only)
npm run test:coverage                  # L1 (c8 >=80% on packages/contracts/src/**)
npm run test:browser                   # L4 Playwright Desktop Chromium smoke suite (setup-playwright in CI)
npm run build                          # B1 (@eagle/web)
npm run check                          # test + typecheck + lint + build
npm run check:design && npm run test:design  # macOS SwiftSyntax style ownership & gate tests
npm run test:devices                   # cross-process device tests (after bots ci & agent build)
npm --prefix apps/bots run check       # Bots daemon gate (eval: npm --prefix apps/bots run eval)
npm --prefix apps/superagent run check # Superagent gate
```

macOS Swift tests, strict `swift format` lint, and 90% coverage (`apps/{macos,bots-macos,superagent-macos}/Scripts/coverage.sh`) require Xcode (`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`). `swift run SnapshotRenderer` writes PNGs under ignored `.local/`.

## Invariants

- **Workflow & TDD**: Work on `main` (integrator writes; Herdr Space reviewers read-only). Use strict TDD; log 15-min checkpoints on long runs ([Deployment](docs/DEPLOYMENT.md#user-view-checkpoints)).
- **Web stack & UI**: Fixed stack of Vite, Biome, and TypeScript 7.0.2. Build all web controls and chrome with published `@nocoo/basalt`; never add a second component or color system.
- **Auth & secrets**: Tokens live only in secure config (never payloads, URLs, source, browser storage, screenshots, or CLI args); auth errors fail closed.
- **Provenance & state**: Preserve idempotency, capture order, session-scoped identities, freshness, and provenance; lifecycle badges never certify completion and missing data stays unknown.
- **Releases**: Bump only the shipped surface — root, `packages/agent` (self-contained `dist` + `bin`), or `apps/macos/Support/Version.json` ([rules](docs/DEPLOYMENT.md#release-surfaces-and-versioning)).
- **macOS signing**: Published App builds are ad-hoc signed and un-notarized; follow manual quarantine/approval steps in [apps/macos/README.md](apps/macos/README.md) and never use `spctl --master-disable`.
- **macOS toolchain**: `apps/macos` builds with CLT alone (no `@State`/`@Observable`/`#Preview`/XCTest/Swift Testing); use `ObservableObject` and `LocalState`. Tests, `swift format`, and coverage need Xcode.
- **macOS design**: Enforce palette, type, control, and visual-argument ownership via `npm run check:design` ([DESIGN.md](apps/macos/DESIGN.md), [coverage](docs/MACOS-STYLE-COVERAGE.md)).
- **macOS Dev App**: End `apps/macos` changes with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift run "Eagle Dev"` in a right-split pane (never new tab/background); `Eagle` is the packaged product.
- **Bots & Superagent isolation**: Decoupled from web/Worker/Agent/contracts and excluded from root workspaces and `biome.json`. Dependency direction is one-way: `apps/macos` -> `apps/bots-macos`, never back.
- **Bots contracts**: Update docs with code; [PROTOCOL](docs/bots/PROTOCOL.md) v1 is additive and `fixtures/bots-protocol/` is normative. Keep unenabled features behind flags ([PRODUCT](docs/bots/PRODUCT.md)).
- **Bots observability**: Every crossing logs its layer with shared `trace`; only the innermost failure logs `error`, asserted by tests ([OBSERVABILITY](docs/bots/OBSERVABILITY.md)).
- **Bots acceptance**: Drive evals via `eagle-dev` (dev-only `~/.config/eagle-dev/token`) after trigger/tool/invocation edits; keep permission tests in `apps/bots/test` ([TESTING](docs/bots/TESTING.md)).

## Quality & Local Gates

Follows `system1-quality`; CI runs `.github/workflows/pipeline.yml` -> `.github/workflows/quality-slots.yml` (`quality / Z1: Gate` required on `main`, aggregating all blocking slots including `S2: Lint (Swift & Design)`, `B1: Build (macOS)`, `L1: Unit (macOS App)`, `L1: Unit (Bots Swift)`, `L1: Unit (Design)`, `L1: Unit (Focus)`, and `L3: Integration (macOS)`). Status vocabulary: `enforced`, `planned`, `manual`, `N/A`.

- **Exceptions (`N/A`)**: `L2 Runtime` (Miniflare DO tests run in `L1`) and `P1 Package` (private root; Agent packing tested in `L1`). `L3: Integration (macOS)` runs `npm run test:devices` using the prebuilt `B1: Build (macOS)` `eagle-cli` artifact (`EAGLE_CLI_BIN` in CI). `L4: E2E` serves the prebuilt `B1: Build` `apps/web/dist` artifact in CI without rebuilding.
- **Coverage & deploy**: `c8` enforces >=80% on `packages/contracts/src/**` (`.c8rc.json`); Swift logic suites enforce 90%. `.github/workflows/pipeline.yml` (`deploy` job, `D1`–`D5` via `deploy-worker.yml`) deploys Worker on `main` push after `quality / Z1: Gate` passes (or `workflow_dispatch` with `deploy=true`), reusing the `B1` `web-dist` artifact without rebuilding (`node scripts/deploy.ts --prebuilt` with `EAGLE_WRANGLER_CONFIG`) and verifying `/api/live` revision.
- **Local hooks (`pre-commit`)**: Installed via `npm ci` (`prepare` -> `.githooks/`). Validates staged index with `l1-index-gate.sh`, plus `check:design`, `superagent`, and `swift format` when touched.
- **Local hooks (`pre-push`)**: Runs `npm run check`, `apps/superagent` `check` + `superagent-macos` coverage, `test:browser`, and `apps/macos` + `apps/bots-macos` `swift test` (`test:focus` is CI-only).
- **Release gates**: `npm run check` and `npm run test:browser` remain release gates. Never lower thresholds, skip or focus tests, bypass hooks, or suppress failures.

## Resources & Isolation

| Lane | Endpoint / State | Boundary |
| --- | --- | --- |
| Web dev | `https://eagle.dev.hexly.ai` -> Vite `7053` -> Worker `37053` (inspector `38053`) | Daily local state; never seed prod or copy prod secrets |
| Web tests | Browser 27053 (`apps/web/dist`, no API proxy); API E2E 17053 | Real local Miniflare; own fixtures; pause/advance browser clock |
| Prod | `eagle.hexly.ai` (UI), `eagle-ingest.hexly.ai` (ingest) | Authorized ops only; live/read-only checks per [Deployment](docs/DEPLOYMENT.md) |

macOS surface ownership (single-instance lock per build under `~/Library/Application Support/ai.hexly.eagle`; explicit `BOTS_ROOT`/`BOTS_PORT`/`SUPERAGENT_ROOT`/`SUPERAGENT_PORT`/`EAGLE_ROOT`/`EAGLE_PORT` overrides always win):

| Surface | Bots root / port | Superagent root / port | Client state | CLI |
| --- | --- | --- | --- | --- |
| Packaged App (`Eagle`) | `~/.local/share/eagle-bots` / `43117` | `~/.local/share/eagle-superagent` / `43128` | `~/Library/Application Support/ai.hexly.bots` | `eagle` |
| Source (`Eagle Dev`) | `~/.local/share/eagle-bots-dev` / `43119` | `~/.local/share/eagle-superagent-dev` / `43127` | `<dev root>/client` | `eagle-dev` |
| Candidate bundle | `<daily root>-device-candidate` / `43118` | as packaged / `43128` | `<candidate root>/client` | `eagle-dev` |

## Retrospective

Record incident narratives in [Retrospective.md](Retrospective.md); promote recurring project constraints to `Invariants` above and deterministic guards to tests or hooks.
