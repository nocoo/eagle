# Changelog

## Unreleased

## macOS v0.16.0 — 2026-11-01

- Ship the `eagle` command line client: Settings → CLI installs it into `~/.local/bin`,
  issues a named credential with scopes, and prints the agent-facing skill document; a
  source run installs the copy it just built and calls itself `eagle-dev`, so a
  development build and the installed App never share a link, a config file or a
  credential.
- A development daemon can accept a credential an agent mints itself at
  `~/.config/eagle-dev/token` (mode 0600, 32+ characters). The App arms it only from a
  source run; a packaged build never sets the variable, so a release cannot gain the
  behaviour. The bearer joins the log's redaction set and is refused when the file is a
  FIFO, unsafe or unreadable.
- Show a bot's own one-line note in its sidebar row, refreshed by every settled run and
  carried through the catalog, the CLI and the protocol.
- Fix three CLI reads against a real daemon: `usage` kept the `?days=` in the path,
  `chat watch` read the conversation from the wrong level and stayed silent, and
  `chat history` used the truncation marker as its cursor, so the first page was always
  empty.
- Fix `POST /v1/bots` dropping the `groupId` the CLI sends, so `bots create --group`
  silently created an unfiled bot; a refused creation now leaves no bot behind.
- Name a source run "Eagle Dev" in the menu bar, the About panel, the window title and
  the About card, and keep it after SwiftUI installs its own menu.
- Acceptance drives the Bots surface through the CLI: five `cli-*` cases in `tests/eval`
  boot a real daemon with a scripted model and run real commands, including an answer
  aborted while it is in flight.

- Adopt an npm workspace layout: `apps/web` (dashboard, Worker, D1 migrations),
  `apps/macos` (client placeholder), `packages/contracts` (shared schemas) and
  `packages/agent` (published Agent). The root manifest stays the version and
  workspace authority; the Agent tarball layout and `bin` path are unchanged.
- Contracts no longer import the website manifest; onboarding receives the
  published Agent version as an argument.
- CI cancels superseded runs on the same ref and documents that the workspace
  install covers every package.

## v0.14.1 — 2026-10-24

- Dependency maintenance: lucide-react 1.61.0, the AI SDK trio (`ai` 7.0.152,
  `@ai-sdk/openai` 4.0.101, `@ai-sdk/anthropic` 4.0.87, all pinned to provider
  4.0.33), vite 8.3.5, wrangler 4.152.0 and @biomejs/biome 2.6.2.
- Adopt biome 2.6.2 without reformatting the hand-authored docs: Markdown is
  excluded from the formatted set, `noInvalidGridAreas` is off because it
  reports valid multi-row `grid-template-areas`, and the new template-literal
  and `textContent` findings are fixed in code.
- No runtime behaviour, schema, API or Agent change; the published onboarding
  pin stays at Agent 1.0.0.

## v0.14.0 — 2026-10-24

- Remove the optional semantic layer end to end: the Manager, the summary
  protocol, UTC semantic hour buckets, the D1 `pane_summaries` archive and the
  Pane summary panel. Pane cards and task headers now show the collected task
  title, and evidence, state assessment and freshness drop no capability.
- Drop `/api/v1/summaries`, `/api/v1/agent-state`, `/api/v1/semantic-hours` and
  `/api/v1/summary-history`; initialization drops the retired Durable Object
  tables. `migrations/0005_drop_pane_summaries.sql` removes the D1 archive.
- Keep AI daily reports deterministic-input only. Bump the prompt template to
  `eagle-daily-zh-v2` and drop semantic counters from coverage and payloads;
  existing archived reports stay readable.
- Pair the website with independently published Agent 1.0.0, which removes
  `manager-once`, `manager-watch`, `manager.command` and the legacy
  `evidenceFile` input.

## Agent v1.0.0 — 2026-10-24

- Remove the semantic Manager, its configuration and the legacy evidence file
  input. `watch`, `realtime-watch`, `once`, `heartbeat`, `collect` and `upload`
  are unchanged; a stored `manager` block or `evidenceFile` path is ignored.
- Preserve report schema v1, spool recovery, redaction and realtime behaviour.

## v0.13.0 — 2026-10-22

- Add machine groups with Connect management and sidebar sections. Unassigned
  machines use the default group 「机器」; empty groups stay hidden.
- Allow deleting disabled machine credentials from Connect; active tokens must
  still be revoked first.

## v0.12.0 — 2026-10-21

- Align sidebar partitions, navigation insets and application typography with
  Basalt 3.2.0. Use the shared 12/14/18/24px type scale and keep mobile controls
  readable without hiding navigation or input actions.
- Give the machine resource column and Space inspector the same responsive
  desktop width. Keep search in the Space heading, preserve the compact first-card
  position, and prevent the closed inspector from panning the terminal viewport.
- Retain terminal frames, reading positions, unread output and uncertain input
  receipts across views within an open workspace. Clear protected state on
  authorization loss; never reacquire control or replay inputs automatically.
- Add safely clickable visible HTTP(S) terminal links with preserved styling
  and native text selection. Freeze selected output while receiving newer frames;
  keep primary mobile keys visible with 44px targets.
- Include the dependency upgrades prepared in 0.10.3 and 0.11.0, including
  React, AI SDKs, jose, icons, Wrangler, Playwright and Node types.
- Pair the website/Worker with independently published Agent 0.9.0 for repaired
  redaction and native history keys. Pin onboarding and installation guides to
  the verified npm artifact; preserve existing machine and Manager identities.

## Agent v0.9.0 — 2026-10-21

- Prevent status labels from hiding independent wrapped secret assignments in
  realtime plain text or styled runs, while preserving ordinary status output.
- Remove repeated scanning of horizontal whitespace, assignment names and
  footerless base64 line runs before terminal screen truncation.
- Protect quoted wrapped values and preserve Bearer prefix spelling and
  whitespace so styled reconstruction does not repeatedly search for changed
  source text.
- Add native up/down history keys for supported Kitty modes, including
  report-all-keys encoding, and explicit Ctrl+P/N. Unsupported cursor modes
  reject before writing; history actions never submit the command draft.
- Include the independent Agent dependency updates since 0.8.1. Preserve
  read-only hardware collection, secure configuration and Manager state.
- Publish independently from website/Worker 0.12.0; onboarding advances only
  after the exact package has passed registry integrity and installation checks.

## v0.11.0 — 2026-10-21

- Upgrade Basalt to 3.2.0 and adopt its native control sizing, surfaces and
  workspace selection. Remove conflicting Eagle overrides instead of adding
  a compatibility layer; retain mobile target sizes with short text actions.
- Upgrade Node types to 26.6.5 with a caret range and fix strict summary-verifier
  inference using the existing domain type, without changing runtime behavior.
- Preserve original browser thresholds and strengthen selection and tooltip
  dismissal checks. Record the complete removed-override list and local visual
  evidence in [the migration notes](docs/DEPENDENCY-MIGRATION-0.11.0.md).
- Keep the terminal workspace stationary when its closed inspector extends
  beyond the viewport; clip the non-scrolling layout boundary and verify that
  attempted horizontal scrolling cannot hide the primary terminal keys.
- Prepare a website/Worker-only minor release. Agent source stays at unpublished
  0.8.3 and onboarding stays at published 0.8.1; no tag, publication or deployment
  is included.

## v0.10.3 — 2026-10-21

- Update jose to 6.2.13, OpenAI SDK to 4.0.98, Anthropic SDK to 4.0.84 and AI SDK to 7.0.147, including their required shared provider dependencies.
- Update React and React DOM together to 19.3.1, lucide-react to 1.60.0, Wrangler to 4.151.3 and Playwright to 1.64.1; preserve existing exact/caret specifiers and official npm lockfile URLs.
- Prepare a website/Worker-only dependency patch. Agent source remains the unpublished 0.8.3 candidate and onboarding remains pinned to published Agent 0.8.1; no publication or deployment is included.

## v0.10.1 — 2026-10-03

- Organize machine resources into six compact Basalt cards for CPU, GPU, memory, disk, network and fans, with equal-width meters, per-card help and responsive layouts.
- Publish Agent v0.8.1 with optional unprivileged macmon CPU/GPU temperatures, GPU activity, fan RPM and memory/swap observations, plus bounded physical-interface traffic rates.
- Preserve missing/stale evidence, network/VPN status, watched ports, uptime and existing 6h/12h/24h history. No fan control, health scoring or retention-policy change is introduced.
- Integrate upstream AI SDK, icons, WebSocket, Vite, Wrangler and Biome dependency updates; keep strict warning rejection and CSS cascade ordering.
- Keep independently verified npm onboarding and install the released Agent on the authorized local machine without changing its configuration.

## v0.10.0 — 2026-10-03

- Switch the local frontend between Local and Prod with authenticated HTTP and realtime proxying, per-tab selection and environment-isolated drafts.
- Default resource history to six hours with 6h/12h/24h selection, fixed rolling axes and equal-width CPU, memory and disk usage meters alongside numeric readings.
- Preserve sections 01/02, number runtime pulse 03, widen the resource/pulse column on large displays and move static card explanations into accessible info controls.
- Bound resource-history requests, retain isolated samples and preserve unknown sampling cadence without fabricating gaps or readings.
- Publish independent Agent v0.8.0 with OS network/VPN evidence, unavailable-aware CPU temperature, 30-second fast samples and configurable slow observations; update onboarding to the verified npm artifact.
- Include Basalt 2.2.0 and the upstream undici 7.29.1 security override. Storage-retention recommendations remain unimplemented; existing policies are unchanged.

## v0.9.0 — 2026-10-02

- Extend the existing Agent/report/DO flow with bounded OS network/VPN evidence, unavailable-aware CPU temperature, 30-second fast samples and configurable 300-second slow observations.
- Retain 24 hours / 2880 resource samples without duplicating full reports or re-enabling D1 snapshot history; preserve late-arrival ordering, idempotency and old v1 reports.
- Keep machine Space topology and add environment cards with CPU/memory percent charts, independent dashed load axes and explicit gaps/offline states.
- Publish the website/Worker independently; Connect explicitly pins published Agent 0.7.1 from website metadata. Agent source 0.8.0 remains unpublished, and installed Agents are not upgraded or restarted.
- Existing Agent telemetry can populate CPU/memory/load history after this Worker deployment; new network/VPN/temperature observations require the future Agent release. No historical data is fabricated or backfilled.

## v0.8.0 — 2026-09-27

- Replace hourly AI reports and five-minute polling with one daily Cron at 23:59 Beijing time, generating one report per machine with 24 hourly entries.
- Enforce a fixed Chinese JSON format: overview up to 160 characters, each hour up to 80, and at most three next steps of 60 characters each; validate sources and retry at most once.
- Freeze each run at one receipt boundary, distinguish quiet hours from missing collection, and give the bounded retry precise validation feedback.
- Bound model input with disclosed hourly samples, retain raw collection and semantic history, and preserve cached reports across archive failures.
- Browse daily reports by Beijing date with compact mobile rows, clear coverage and manual retry; preserve existing AI connection settings and encrypted credentials.
- Delete the retired hourly archive and generation state. Keep the published Agent and onboarding at v0.7.1.

## v0.7.5 — 2026-09-27

- Keep mobile machine, overview, Connect, history and settings page titles and accessible icon actions in one compact row.
- Hide redundant mobile descriptions, synchronization metadata and the framework breadcrumb while preserving machine freshness and connection errors.
- Arrange Connect steps horizontally, reduce section gaps and keep long machine names within narrow screens.
- Keep the published Agent and onboarding at v0.7.1; this website-only release does not publish an npm package.

## v0.7.4 — 2026-09-27

- Save unsent commands per terminal in localStorage and restore drafts after refresh, navigation or disconnect; keep recognizable credentials out of the cache.
- Preserve the last terminal screen with a retry indicator and allow uninterrupted draft editing while offline or awaiting a receipt; sending still requires a fresh connection and controller lease.
- Replace the mobile workspace search picker with a touch-friendly select.
- Keep machine Spaces in Herdr order, show compact three-line mobile entries with whole-card navigation, and fill the available width with resource and activity cards.
- Keep the published Agent and onboarding at v0.7.1; this website-only release does not publish an npm package.

## v0.7.3 — 2026-09-26

- Size realtime tab, pane and palette menus to their content while keeping long names within narrow mobile viewports.
- Serve browser tests from an isolated production build without the development API proxy, and control time explicitly in output-status and stale-summary checks.
- Keep the published Agent and onboarding at v0.7.1; this website-only release does not publish an npm package.

## v0.7.2 — 2026-09-23

- Place Space navigation in a searchable vertical rail, with a compact mobile picker and preserved keyboard/focus behavior.
- Consolidate workspace headers, connection status and terminal controls; group take/release input beside the bottom composer and send action.
- Animate the collapsible information panel, show capture age counting upward, and retain exact timestamps and snapshot details in tooltips.
- Strengthen selected-pane borders and improve mobile terminal space while preserving submission feedback and errors.
- Allow independent website releases. The published Agent and onboarding remain at v0.7.1; no npm package is published for this release.

## v0.7.1 — 2026-09-22

- Refresh current-task snapshots on entry and align task details for compact reading.
- Use machine-first navigation, fold workspace tabs, and place responsive machine snapshots below tasks.
- Return to realtime when selecting the same pane from Current Tasks or History.
- Preserve the main terminal layout during isolated realtime verification.
- Keep the website, standalone Agent and installation guides synchronized at v0.7.1.

## v0.7.0 — 2026-09-22

- Preserve safe terminal colors and emphasis through redaction, negotiate bounded styled frames, and offer persistent terminal palettes.
- Follow live output at the bottom, pause while inspecting earlier output, and compact recognized idle Codex chrome without changing source frames or input routing.
- Open Spaces in realtime mode and request input control once by default. Keep server-granted exclusive control, explicit release, target replacement and reconnect protections.
- Distinguish same-origin credential rotation from cross-origin onboarding migration. Isolate config, spool, cache and Manager state, and restart only already-enabled services.
- Keep the website, standalone Agent and installation guides synchronized at v0.7.0.

## v0.6.0 — 2026-09-22

- Bound Manager summaries to 600 narrative characters, three outcomes and explicit per-field budgets; retain source evidence and verification qualifiers.
- Generate concise v5 hourly reports with per-section limits and one validated compression attempt for oversized output. Preserve raw records for detailed inspection.
- Allow authenticated cancellation of unfinished hourly jobs without deleting source data or archived reports. Cancellation survives late input and restarts and is visible in history.
- Preserve completed archives when only the report template changes.


## v0.5.1 — 2026-09-21

- Fix missing hourly reports caused by repetitive terminal input, a 32-chunk rejection and lost progress after model timeouts. Sample weak terminal screens per task while preserving raw evidence; validate and checkpoint chunks, bounded reductions and final synthesis in the existing machine Durable Object.
- Resume eligible hours every five minutes with bounded concurrency, fair scheduling and persisted retry backoff. Reject obsolete leases and late-input races, retain completed reports through D1 outages, and expose progress, failure stage, retry timing and last success in history.
- Make collector, semantic Manager and realtime proxy use opt-in. Default to direct networking and document per-machine proxy selection without a fixed host or port.
- Keep the website, standalone Agent, onboarding and installation guides synchronized at v0.5.1.

## v0.5.0 — 2026-09-20

- Unify the website, health endpoint, standalone Agent and onboarding version. Runtime versions derive from the root package manifest; package tests reject version drift in manifests, the lockfile and the installed CLI.
- Publish `@nocoo/eagle-agent@0.5.0` through npm and use pinned registry installation commands in Connect and the installation guides.
- Add `realtime-watch`, a separate supervised outbound bridge to the local Herdr socket. Existing collection and Manager state remain independent. Include the explicit Manager command configuration prepared in v0.4.1.
- Refine the workspace sheet and realtime layout for desktop and mobile, and add a persistent display timezone preference for structured timestamps and archive filters.

## v0.4.0 — 2026-09-20

- Add Space realtime viewing and exclusive web input through authenticated WebSocket connections and the existing per-machine Durable Object. Mirrors Herdr text screens/layout and supports text, Enter and common terminal keys.
- Cancel subscriptions, socket reads and timers on view switches, page hiding and disconnects. Bound viewers, Spaces, screen sizes and transport queues; reject stale terminal identities and duplicate input. Inputs are never replayed after an uncertain acknowledgement.
- Add isolated API/socket/browser tests and real local/public terminal round-trip verification. Screen and input content is redacted and never archived.

## v0.3.0 — 2026-09-20

- Hourly report template v3 keeps evidence timestamps, task boundaries and source attribution explicit. It instructs the model to retain uncertainty around historical blockers, cancelled tasks and sparse resource samples.
- Large hours use compact intermediate evidence notes, validated inline citations and one bounded rewrite for an oversized executive summary. Truncated or invalid model responses fail before archival; template upgrades can regenerate an hour without creating duplicate D1 rows.
- Add a reproducible real-model evaluation with five controlled cases and documented results from real Herdr hourly inputs. Shared AI credential decryption verifies the intended endpoint in both generation and evaluation.
- History uses Basalt date and hour selectors with themed calendar/chevron icons, Chinese calendar labels, keyboard navigation and clear-filter feedback. The hour menu scrolls within mobile screens and local time still maps to UTC archive buckets.

## v0.2.2 — 2026-09-19

- Sidebar machine items show glowing online, stale-snapshot and offline indicators in expanded, collapsed and mobile layouts.
- A Basalt settings page reuses next-ai provider configuration and a fixed seven-section Chinese report template. API keys can be saved, replaced, tested and cleared in the UI; authenticated encryption protects them in a separate DO configuration record, with the wrapping key in Worker secrets.
- Hourly Cron combines each machine's independent factual and semantic streams, defaults to a one-hour cadence and skips unconfigured AI.
- Durable leases, protected pending results, late-input revisions and a unique machine/hour D1 archive prevent duplicate reports and preserve failed writes for retry.
- History supports machine/hour queries, chronological pagination and detailed report expansion without remounting during refresh.

## v0.2.1 — 2026-09-19

- Compact machine headers combine freshness, inventory and sync status. CPU, memory, disk and watched ports sit above the activity column.
- Basalt buttons retain readable labels and padding in narrow layouts, including machine rename and evidence controls.
- Space columns follow available content width so an expanded sidebar cannot squeeze multi-Pane topology controls.
- Copying an onboarding prompt confirms success inside the button, keeps its width stable and resets automatically. Token copy has its own feedback.
- Onboarding is agent-neutral, recommends Hermes with an explicit command example and preserves each machine's existing model/provider/profile.

## Agent v0.4.1 — unreleased; included in v0.5.0

- Remove the implicit Cherry executable. Manager requires an explicit command for the machine's existing Agent; deterministic collection remains independent.
- Explain missing configuration and executable failures without exposing credentials. Preserve legacy Manager identity and state during upgrades.
- Document the stdin/stdout integration contract, verified Hermes example and equivalent adapters for other Agents.

## Agent v0.4.0 — 2026-09-19

- Independent deterministic collection and continuous Cherry semantic reporting with `manager-once` and `manager-watch`.
- Per-Pane summaries bind to tasks and evidence, with idempotent updates, freshness and UTC hourly history in each machine's Durable Object.
- Install `@nocoo/eagle-agent@0.4.0` from npm or the Tencent npm mirror.
