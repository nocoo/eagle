# Changelog

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
