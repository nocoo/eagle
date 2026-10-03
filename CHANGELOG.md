# Changelog

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
