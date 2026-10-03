# Retrospective

## 2026-09-21 — Reporting depended on an unavailable local proxy

After reboot, all three Eagle services started, but the collector and Manager could not upload because their launchd environments required a local proxy that was not running. Direct Node requests to the ingestion origin succeeded. Removed the fixed proxy environment, reloaded the services, and verified successful collection, Manager reporting, realtime connection and an empty pending spool. Onboarding now specifies direct networking by default and explicit optional proxy configuration.

During recovery, registering the collector immediately after `launchctl bootout` returned error 5 while its previous registration was still being removed. Checking that the service was no longer registered before bootstrapping succeeded. Service reload instructions now require waiting for shutdown before registering again.

## 2026-09-21 — Hourly generation failed after successful uploads

The 19:00-to-19:00 production audit found 12/24 MBP reports and 22/24 Mac Studio reports, despite persisted source input for every missing hour. MBP's morning semantic records reached the server within seconds of observation. Growing visible-terminal evidence pushed five missing MBP hours over the generator's 32-chunk limit. An isolated replay of the 31-chunk 07:00 input completed every chunk in 555 seconds, then timed out during final synthesis at the 10-minute deadline. A missing two-chunk hour succeeded independently in 96 seconds.

The implementation caches only a complete report, so a late failure loses all validated chunk progress. Oldest-first retries and a shared 12-minute scheduled budget can then delay newer hours. This investigation reproduced the size rejection and final-synthesis timeout without writing reports or changing production job state; historical per-hour attempt details remain unavailable. No runtime fix or deployment was made. The input, retry, scheduling and visibility corrections are recorded in [the incident investigation](docs/HOURLY-INCIDENT-2026-09-21.md).


## 2026-09-23 — Workspace layout checks missed a clipped mobile label

During the vertical-navigation implementation, browser tests found that handling
Escape in an input or a document listener happened after Radix dismissed the
workspace. The workspace now owns its Basalt SheetContent and handles dismissal
through onEscapeKeyDown; search clearing and narrow-panel closure have explicit
regressions that preserve the parent workspace and focus.

The first complete browser run passed while the mobile Space picker name was
invisible: a generic direct-child button rule forced the picker to icon width.
A screenshot exposed the clipping, and a new geometry assertion failed with a
zero-width label. Restricting the rule to icon buttons restores the picker.
Text-presence assertions alone do not prove a label is readable; changed compact
controls need rendered geometry and screenshot inspection alongside interaction
checks. These defects were caught locally before committing or publishing.

## 2026-09-23 — Compact header remounted the mobile Space picker

Consolidating workspace headers initially placed the mobile navigation inside
SpaceDetail, which is keyed by Space identity. Selecting another Space remounted
the popover trigger before Radix could restore focus. The existing mobile picker
regression failed even though layout and terminal continuity tests passed.
Navigation now remains in the stable workspace shell, while only Space-specific
detail state resets. Keep navigation and its focus targets outside keyed content
when rearranging headers; verify selection, dismissal and focus after the move.

## 2026-09-23 — Status placement assertion missed during compaction

The focused realtime tests passed after moving output status into the input,
but the full browser gate found four terminal-preview assertions still expecting
it above the input. The application matched the requested layout; the existing
visual contract had not been updated across both suites. Updated those assertions
to verify containment and vertical centering in both themes and viewport projects.
For future cross-component layout changes, search all geometry assertions for the
moved control before treating a focused suite as complete regression evidence.

A subsequent run was invalidated by editing AGENTS.md while Vite browser tests
were active. Trace timestamps showed fresh page navigation at the same second
as that write, detaching controls in two tests and invalidating a third geometry
snapshot. Freeze all watched repository files during browser gates, including
documentation; finish edits before starting the server-backed run.

## 2026-09-26 — Compact Select triggers constrained their popups

The mobile terminal-theme trigger was reduced to 32px without overriding
Basalt's trigger-sized SelectContent. Its four-character labels wrapped into
four lines, while the adjacent tab and pane selectors also cramped their labels.
Selection tests passed because they checked behavior rather than readability.
Realtime popups now size to their content within the available viewport; browser
regressions check line counts, text containment and focus restoration.

The first long-label fixture exceeded the realtime protocol's 240-character
limit, so validation rejected it before rendering. The fixture now uses that
valid boundary. Check transport constraints before constructing visual edge cases
so a layout regression reaches the intended UI state.

## 2026-09-26 — Browser gates competed with development loading and real time

The full dropdown regression run took 8.5 minutes and failed eleven existing
cases. Traces showed 8–12 second Vite development navigations and scenarios
exceeding 30 seconds. Two output-status checks also let the four-second activity
window expire while measuring layout and taking screenshots.

Browser checks now serve an isolated production build with no development API
proxy and a bounded four-worker default. Time-sensitive checks pause the clock
and advance it explicitly; the frozen-summary check no longer sleeps for six
real seconds. The same 136-case matrix then finished in 4.8 minutes with 125
passes and the unchanged eleven viewport-specific skips. Assertions, timeouts
and retry policy were preserved. These are measured local runs, not a guaranteed
cross-machine speedup.


## 2026-09-27 — Overbroad mobile test edit

While replacing mobile search with a select, a text replacement also removed a desktop search fixture step. The focused suite exposed the resulting keyboard-focus failure; the desktop filter step was restored. Scope scripted test edits to the intended test block and inspect the diff before running the suite.

## 2026-09-27 — freeze daily input before model generation

The initial daily rewrite carried forward the hourly generator's rule that any
late input invalidates the in-flight final. During release review, this proved
inappropriate for a 23:59 one-shot schedule: a normal delayed collector upload
could cancel the only daily run. No production deployment had occurred.

A failing local API test reproduced the cancellation. Daily claims now freeze
snapshot and semantic sequence limits, all 24 buckets read that same boundary,
and input counts are verified before model work. Receipt time is archived;
manual regeneration incorporates late arrivals. Future one-shot aggregates must
separate their immutable input boundary from the continuously updated source.

## 2026-09-27 — distinguish quiet hours from missing collection

Production daily generation passed on MBP but failed on Mac Studio. An isolated
instrumented retry showed valid JSON and compliant lengths; the model called
00–07 empty even though each hour had four retained input records. It conflated
missing new task progress with missing collection, and the generic retry prompt
repeated that mistake. Invalid content was never archived.

The prompt now explicitly lists populated/empty hour buckets and states that
quiet or stale task evidence still counts as collection. Validation collects all
bad hourly citations and gives the single retry the actual hour-specific source
IDs and previous output. The validator and two-call limit remain unchanged.
A regression test covers eight populated hours incorrectly marked empty.

## 2026-10-02 — A regression run raced its implementation

While adding resource-history coverage, the first API regression was launched asynchronously and source edits began before its process completed. Both API invocations bundled into the same `.local/test-worker` path, so the purported red run actually saw the implementation and passed. That run is not failing-baseline evidence. Re-ran the regression against the original Worker entrypoint sequentially, observed the missing endpoint failure, restored the implementation in `finally`, and then continued verification. Dependent red/edit/green steps must complete in order; only checks with independent state may overlap. No production state was used.

## 2026-10-03 — Classify historical scanner matches precisely

The full-history scan returned five non-secret matches: documentation prose, two isolated test fixture values, and the public JWT audience identifier in configuration and generated types. Independent reviews checked the exact historical locations. Only those five complete historical fingerprints are listed in `.gitleaksignore`; no path, rule or vulnerability is broadly excluded. A separate temporary Git fixture verifies that a newly introduced synthetic credential still fails scanning with this same fingerprint file.

## 2026-10-03 — Keep stricter Biome checks green

Biome 2.5.15 exposed 25 descending-specificity warnings that 2.5.10 did not report on the same baseline. The normal lint command did not reject warnings, so a dependency commit alone was insufficient for acceptance. The remaining uncommitted upgrade was deferred while the stylesheet order was repaired. Parser checks verified all 509 selectors, declaration values, conditional scopes and equal-specificity ordering, along with imports, layers and keyframes. The rule stays enabled and normal lint now rejects warnings. Existing browser CI provides rendering acceptance; no React component tests were added.

The first user-view checkpoint during the scanner and lint investigation was later than the requested 15-minute interval. Its actual timestamp is retained rather than backfilled. Future long maintenance work must track that checkpoint timer alongside running validation.


## 2026-10-03 — Browser success did not validate a fixture's type

The resource-timeout regression passed in both browsers, but assigning the inferred telemetry fixture directly to a typed report failed TypeScript: its load array was not a fixed-length tuple. Parsing the fixture through the existing telemetry schema restored the contract without a cast. Browser execution does not replace strict type and formatting checks; complete both before committing a regression fix.

The isolated-sample regression initially searched beneath each line group, but Recharts renders dots through a separate SVG z-index portal. That selector could not distinguish a missing dot from a correctly portaled one. Added explicit series-specific dot classes, repeated the failing baseline with the corrected selector, then verified actual visibility and counts. Inspect library rendering boundaries before relying on DOM ancestry in chart assertions.

## 2026-10-03 — verify library and command contracts first

The environment regression initially assumed Basalt segments were pressed
buttons and tried to reach the header while a modal was open. The installed
component exposes radios; modal focus isolation correctly hides the header.
The corrected test follows the actual roles and closes the modal before
switching. Socket isolation now asserts no active old connections rather than
assuming exactly one connection lifecycle. Node fetch also ignores a custom
Host override; the host-boundary check now uses the native HTTP client.

Command-help review caught that cloudflared login prints its JWT by default.
The displayed login instruction now includes `--quiet`; the unsafe suggestion
was not executed. Check credential-bearing CLI output contracts before adding
onboarding commands, even when their arguments contain no secrets.

The machine-card fixture repeated the telemetry literal-widening mistake; it
now uses `MachineTelemetrySchema.parse` rather than manually narrowing selected
fields. The paused-clock tooltip check also initially focused a scroll-moving
trigger; Radix correctly dismissed the tooltip on scroll. Scroll into view
first, activate the control, then advance the paused clock explicitly. The final
complete browser run passes without raising timeouts or weakening assertions.

## 2026-10-03 — resource-window checks must await actual layout

The time-axis assertion repeated the Recharts portal assumption by looking
inside the empty axis group. It now checks the accessible chart application.
A 320px viewport transition also exposed the header's inflexible action row;
the row can wrap, and geometry assertions wait for responsive layout to settle.
Paused-clock tests advance the real five-second dashboard refresh cadence.
The final suite passes with all range, point-count and width assertions intact.

The final v0.10.0 release run exposed the same resize race in the separate
machine-card layout check. It read the three section rectangles in different
browser turns while the mobile shell was changing layout. The trace placed all
reads within 19 ms of resize completion, and the eventual snapshot was already
stacked. The assertion now reads all rectangles in one browser evaluation and
polls the unchanged ordering conditions. No product CSS, timeout, retry count or
skip was changed; release publication waits for the complete rerun.

## 2026-10-03 — inspect deployed roles and asset ownership

An additional release smoke check assumed Basalt Meter exposed the `meter`
role, although the existing browser tests correctly use `progressbar`. After
fixing that selector, an unrestricted module-script lookup matched both the
application bundle and Cloudflare's injected analytics script. Neither failure
was a product defect. The corrected check uses the established accessible role
and the application's `/assets/` module in the document head. It verified three
206px bars, sidebar version 0.10.0, the published Agent pin 0.8.0 and the deployed
revision. Reuse tested library selectors and scope asset checks to owned files
instead of assuming deployment infrastructure adds no scripts.

## 2026-10-03 — distinguish missing integration from unavailable hardware

While explaining the missing environment readings, I described macOS temperature
collection as unsupported without privilege. That conclusion came from Eagle's
Linux-only temperature probe, not a check of this machine's available tools.
The installed macmon 0.8.2 subsequently returned two fan RPM readings and CPU/GPU
temperature readings from a single bounded, unprivileged JSON sample. The system
powermetrics command required root, but that did not establish a platform-wide
limitation. State that Eagle has not integrated a probe when that is the actual
boundary; inspect installed tools and verify a bounded read before ruling out
host capabilities. The sample establishes availability on this machine only,
not sensor accuracy or support across every Mac model. No integration or service
change was made during this investigation.

## 2026-10-03 — missing hardware must not fail a complete report

The initial optional hardware integration used a short-circuit object expression
that emitted null when macmon was absent, but the protocol accepts an omitted
field, not null. An injected missing-tool regression caught the complete-report
failure. The branch now omits hardware and never revives the previous macmon
temperature as a cached slow probe. The browser regression also caught lost
historical network labels in the new cards; each network/VPN label now retains
its own freshness. Hardware absence and stale evidence must be tested alongside
the successful local sensor path, not inferred from it.

The remote advanced during PR CI with a concurrent v0.10.0 release. Old green checks were not used to merge. After its final tag and exact-revision CI were verified, the candidate incorporated the completed release. Both documentation histories and new features were preserved; CSS ordering was regenerated against the new510-selector baseline. Combined-tree tests, reviews and CI must pass again.

## 2026-10-03 — Advance frozen frames before viewport captures

The integrated candidate passed layout assertions in CI, but Chromium refused the overview screenshot after a viewport change while the test clock was paused. The existing page-header test now advances two virtual animation frames after viewport and stale-heading changes before measuring/capturing the resulting layout. All assertions and screenshot artifacts remain; no retries, skips or timeout increases were added. Browser verification remains in CI under this duty’s local-browser restriction.

## 2026-10-04: Audit Agent declarations separately from the root lock

Dependency issue #26 targets the independent Agent manifest and its ignored generated copy in `agent/dist/agent/`. The root npm lock already resolved Zod 4.6.5, but the source Agent still declared ^4.1.0. The source minimum now requires ^4.6.5 and the independent source version is 0.8.2. Build and pack must regenerate and verify both manifest copies; never edit the ignored distribution as a source. This duty does not publish npm or change onboarding: the verified install pin stays 0.8.1 until separately authorized publication.
