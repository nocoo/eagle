# Retrospective

## 2026-11-01 — Three ways this session produced work I could not trust

1. A Python rewrite helper wrote `t` into `p`: it replaced `DaemonClient.swift` with the
   contents of `Commands.swift`. The fix is mechanical now (re-read both files, restore one
   from `HEAD` and re-apply its hunks by hand), but the lesson is about the write: a
   cleanup script that holds two paths should assert the destination name and print it
   before writing, and `git status` should be read after every scripted edit, not after
   the batch. Recovery cost about ten minutes and risked losing a pane's whole diff.
2. The first red run of the new daemon tests hung for 41 minutes because it awaited a
   WebSocket frame that would never arrive. A wait without a rejection path is not a
   failing test, it is a hung session, and node's runner has no default timeout. Every
   wait over a socket, a file or a condition now needs a deadline and a rejection event,
   and the red run should be attempted on one file first.
3. Two tests could not fail and were only caught by a negative control: the log-redaction
   assertion passed while the redaction was removed (the token was in a field nobody
   logs), and the abort case slept long enough to assert before the answer could arrive.
   Each acceptance assertion now gets a negative control once: remove the mechanism, watch
   it go red, put the mechanism back. A test whose failure was never observed is a claim.

## 2026-10-21 — Accept the minifier's actual string syntax

The additional production UI verifier recognized quoted onboarding versions but
omitted backtick strings, which this Vite minifier emits. It therefore reported
an undefined pin even though the deployed bundle contained 0.9.0 and matched the
release asset. Inspect the actual owned asset before interpreting a static-match
failure as a deployment defect. The corrected ignored verifier accepts all three
string delimiters and compares health against the retained release SHA, not a
later documentation-only HEAD. Product code and publication artifacts did not
change. The associated checkpoint was one minute late; record actual times and
track the checkpoint deadline during operational verification too.

## 2026-10-21 — Preserve noisy performance failures during release

A final release gate failed the existing styled-Bearer timing ratio, despite
unchanged Agent code and passing pre-publication gates. The 128k/256k medians
were 35.91/130.22ms; the actual assertion is `max(60ms, small * 3)`, not the 3.5
multiplier initially stated in the progress message. Read the assertion before
quoting it. Three unchanged isolated runs passed with 20.19/29.31, 15.01/26.60
and 35.80/28.99ms. These observations do not prove that scheduling or the nearby
mirror installation caused the failure. Retain every result, avoid overlapping
owned maintenance work with timing gates, and rerun the complete unchanged gates
before deploying; do not loosen the threshold or discard the failed run.

## 2026-10-21 — Validate Access output independently of exit status

`cloudflared access token` returned status zero while reporting that no app
token existed. Parsing the redirected empty output then failed. A shell wrapper
that returned the original status also hid that parser failure. No verification
was accepted and no credential was exposed. Validate JWT structure and expiry
before use, propagate validation failures, and run the normal quiet login flow
when the cache has no token; never treat command exit zero as authentication.

## 2026-10-21 — Measure panel boxes at the same boundary

The UI-polish regression initially subtracted the inner snapshot region from
the viewport to calculate terminal width. The assertion differed by two pixels
because the sheet and inspector borders belonged to different boxes. Measure
the workspace column and outer inspector at the same layout boundary instead;
do not add an unexplained tolerance or restore the obsolete narrow panel width.
Similarly, natural-height icon/text shortcuts can have different top edges on
the same flex row; compare their vertical centers to detect wrapping. Caller
inspection also showed that the remaining old dashboard width was only a loading
skeleton, not a third live panel. Verify rendered callers before describing scope.

Widening the resource panel exposed a real extra toolbar row, which pushed the
first Space card beyond the existing 190px budget. Moving search into the region
heading removes that row without reducing font sizes. The corrected layout is
about 187px, but an immediate assertion still captured the 9px entrance translation.
Poll the unchanged geometry threshold using one browser measurement; do not
shrink spacing again merely to hide an animation timing race.

## 2026-10-20 — A rejected redaction label hid a nested assignment

PR #70 preserved ordinary status labels by validating a greedy match after
whitespace compaction. Rejecting that match also skipped an independent wrapped
assignment inside it. Its whitespace-normalization regex backtracked over long
horizontal gaps; shared preprocessing also rescanned repeated key names and
base64 line runs without a footer. Synthetic regression tests demonstrated the
leak and slow paths before implementation. Source-aware assignment boundaries
and bounded word/line-run matching remove those repeated scans. Plain output and
styled runs must both be asserted; a preserved status label alone does not
establish that the following output is safe.

Independent review then found two pre-existing gaps within the same objective:
quoted wrapped assignments were skipped by an unquoted-only value matcher, and
normalizing `bearer` to `Bearer` made style reconstruction repeatedly search for
nonexistent anchors. Both received failing synthetic regressions before their
fixes. Value parsing now accepts quoted viewport fragments; Bearer redaction
retains the exact source prefix. End-to-end performance tests must include
`terminalScreen`, not only the intermediate redactor.

During investigation, an unbounded repeated-key benchmark stalled its local
Node process; only that process was terminated. Subsequent exploratory probes
used child-process timeouts and smaller inputs before increasing sizes. Timing
evidence should be collected without competing benchmarks, and performance
tests use warm-up, medians and generous absolute bounds rather than relying on
a single fast sample. An initial checkpoint patch also used an unverified
heading and was rejected without changing the file; verify the exact anchor
before patching documentation. The scratch benchmark initially imported
`stripTypeScriptTypes` from `node:util` instead of its documented `node:module`
export; the corrected harness then completed under a parent-enforced timeout.

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
## 2026-10-21 — retained output cleanup must keep its original owner

The tab-unread fix added a content baseline to saved reading positions. A follow-up
audit found that the existing unmount callback dereferenced `view.current` at
cleanup time: authorization failure replaced that view, then cleanup wrote old
positions into the fresh cache. The new baseline would also retain old redacted
screen content there. Desktop/mobile regressions proved the issue by revoking
authorization, reconnecting and observing the old history offset instead of a
fresh bottom-following view. Capturing the rendered position map keeps cleanup
on its original, discarded owner rather than adding another authentication guard.
Test both the blank revoked view and a fresh connection; an empty DOM alone does
not prove retained memory was cleared.

During test formatting, a generated numbered unified diff was rejected by the
patch tool without changing files. Convert hunk headers to the tool's context
format before applying formatter output; do not bypass check-only lint or hooks.

## 2026-10-21 — synthetic long-press recognition is platform-dependent

PR76's Ubuntu headless Chromium run failed because CDP's 800 ms touch tap did
not emit `contextmenu`, although repeated macOS runs passed. The test coupled
Eagle's event contract to the host's gesture recognizer. Dispatch a cancelable,
bubbling touch-pointer/context-menu sequence instead, while retaining the real
desktop right-click and the selection, frozen-output and navigation assertions.
Observe context-menu cancellation above React's root, not at the target before
application handlers run; check touch dispatch results after propagation too.
A temporary ancestor `preventDefault()` made both projects fail, proving the
replacement catches suppression; the fault injection is not retained. These
checks establish application behavior, not native OS callout appearance or
physical-device long-press recognition. Verify those separately when needed.

## 2026-10-21 — isolate timing-sensitive migration gates

During the Basalt major upgrade, the controller started the Node and browser
gates concurrently. The existing 100ms Manager lock assertion reported `lock
missing` while 179 other Node tests passed. The unchanged six-test Manager rerun
passed in isolation. This establishes a scheduling-sensitive observation, not
proof of a dependency defect or proof that concurrency alone caused it. Run the
remaining full gates serially and keep the original assertions and timeouts.

Herdr's `pane resize --current` unexpectedly resolved to another focused Space;
the response reported no change. The controller then used its previously
verified explicit pane ID and changed only its own split. Check the returned
Space and pane IDs on layout operations; use explicit IDs for resizing.

## 2026-10-21 — terminal migration approval missed horizontal panning

The first Basalt 3 migration signoff passed its local gates but independent bot
verification subsequently failed the mobile terminal viewport assertion in five
of five repeats. The controller reproduced intermittent failures and initially
investigated control height; the retained screenshot instead showed horizontal
displacement. A scroll listener captured the application-owned workspace column
container at scrollLeft 70 while the header remained stationary. Its hidden,
translated inspector extends the scroll area: `overflow: hidden` clips painting
but still permits programmatic scrolling. Use `overflow: clip` for this
non-scrolling layout boundary rather than shrinking Basalt controls or resetting
scroll position in JavaScript. Keep real terminal and inspector scrollers intact.

The unchanged test passed 40 repeats after the one-line repair. An additive
scroll-displacement assertion deterministically failed five of five mobile runs
with the old rule. Preserve failure evidence and repeat the complete gates;
one green run and an independent review do not establish absence of timing
failures. Distinguish observed horizontal movement from an unproven assumption
about which browser focus/selection event initiated it.

While inspecting the retained Playwright trace, the controller initially assumed
screencast records used a `sha1` field; this installed trace format uses `file`.
The archive read failed without changing tracked files. Inspect record keys
before extracting artifacts rather than assuming a trace-version schema.

## 2026-10-26 — A filtered check hid a type error, and a test hung the session

Three process failures while closing the Bots stage-2 ladder. First, `npm run check`
output was filtered through `rg` for test counts and coverage lines, which hid a
`tsc --noEmit` failure for one commit; the reviewer found it with a direct `tsc`. Check
the command's exit status, never a filtered view of its output. Second, two commits
described regression cases they did not actually contain, because the work-in-progress
tree was split into commits by slicing files and the slices dropped the cases; the
reviewer caught it twice. Verify a promised test exists in the commit itself
(`git show <sha>:path | rg "name"`), not just in the working tree. Third, a new test
made one sink publish a delta on every delta it received, so the serial fanout loop
never terminated and a `node --test` process ran for hours until the user killed it.
Any reentrancy test must bound its trigger to a single occurrence, and a test run needs
a timeout.

## 2026-10-26 — Verify pane identity and read-only environment values

During the native chat UX change, the shell's inherited `HERDR_PANE_ID` identified
an unrelated workflow Space. A reviewer pane was briefly created there before the
live agent inventory exposed the mismatch. Only the newly created pane was closed;
the reviewer was restarted beside Eagle's verified controller. Before splitting,
match the explicit pane ID, live agent cwd and task, rather than trusting inherited
environment variables or the focused Space.

A snapshot fixture also tried to write `accessibilityReduceMotion` through SwiftUI's
environment modifier. The installed SDK exposes that value as read-only, so the
build rejected it. Remove the unsupported override; the component reads the actual
system preference. Do not claim a reduced-motion UI test from that failed fixture
or change the user's system preference just to produce a snapshot.

An offscreen NSHostingView footer test also returned no accessibility descendants,
including the already-existing account button. That is not evidence that every
button is absent. The unsupported test was replaced with a rendered-pixel regression
for the ignored circular style; actual footer action routing is verified in the live
native window. Static TextField snapshots omitted a line that was present during
native editing, so the three-line viewport and five-line scrolling were checked in
the isolated gallery instead of treating an offscreen bitmap as input-behavior proof.

## 2026-10-26 — Healthy daemon, missing runtime credentials, repeated transcript work

The native app showed a healthy daemon while repeated sends immediately settled
`model_error`. The durable assistant metadata said `Provider is not configured` with
zero request duration; a read-only gateway model-list request succeeded. Gateway Save
had populated an environment variable, but startup only read the persisted file and
never activated its key for the provider. The repair binds provider authentication
directly to the loaded configuration, with a real local HTTP/SQLite test across two
boots and an empty-key fail-closed check. A healthy daemon or successful model-list
probe must not be presented as proof that a generation succeeds.

The UI investigation found that 30 draft changes republished the entire transcript
30 times, and an error-only event did it twice more. Whole-workspace notifications
recomputed tool formatting on MainActor, and View.body reparsed markdown. The repair
coalesces metadata, isolates transcript observation, prepares content on actors and
reuses unchanged results. Review then caught two consequences of asynchronous cold
rendering: separate streaming/terminal branches discarded prepared state, and row-count
scrolling ran before content acquired its final height. Share the assistant branch and
follow measured height only while the user follows the bottom. Test cancellation,
selection changes, publication counts and user-controlled history scrolling separately;
none of these is a substitute for measured frame-time acceptance.

## 2026-10-26 — CJK strong delimiters need a contiguous-text fixture

Testing isolated `**可以正常轮询。**` did not expose the real failure: Foundation's
CommonMark parser leaves the delimiters literal when CJK text immediately follows
the closing punctuation. Keep the adjacent-text case in the regression suite, not
only English strong text or standalone Chinese spans. The display-only normalizer
adds hair-space delimiter boundaries for paired CJK strong spans while preserving
code and escaped markers; clipboard actions use the untouched source. Match backtick
runs once rather than repeatedly scanning suffixes when model output has unfinished
code delimiters.

## 2026-10-26 — Prepare lazy transcript rows before publication

Moving Markdown parsing out of View.body was not sufficient: a newly visible
assistant row still started empty and acquired its height after its task completed.
A first-layout test with twenty paragraphs failed before the change. The live
transcript projector now prepares all assistant blocks before publishing entries,
reuses unchanged row text and retains only the current transcript's prepared data.
The first-layout regression passes without putting parsing back on MainActor.
An independent hosted probe did not reproduce the suspected whole-view invalidation
from geometry bookkeeping; do not claim that suspicion as a measured root cause.
Frame-time improvement still needs interactive acceptance, not just layout tests.

The first UI lookup by the display name Eagle selected the unrelated asset manager.
No input was sent to it. Bind future native checks to `ai.hexly.eagle.macos` or the
exact build bundle path, and verify the SwiftUI window before any action. The UI
tool's wheel action returned `noWindowsAvailable` despite a valid tree and screenshot;
the exposed accessibility scroll action worked and is the appropriate alternative.

## 2026-10-26 — Generated output must stay outside source lint

Pre-push passed 168 Node tests and type checking, then failed because Biome scanned
an untracked legacy `agent/dist` directory. Git already ignores `dist/` at every
depth, but Biome excluded only three named build locations. Replace those location
exceptions with `!**/dist`; do not format generated JavaScript, remove local user
artifacts or bypass the hook. Source lint rules and all push gates remain unchanged.

## 2026-10-28 - Match edit paths to the selected working directory

During native-tool consolidation, an edit command used a repository-relative path while
its shell was already in `apps/bots`. The edit failed before writing anything, but the
following test command still ran against the old registry. The nonzero result was not
mistaken for success. The command was corrected to a package-relative path and rerun with
`set -e`. Compound edit-and-check commands must use one explicit directory convention and
stop when preparation fails; a test result after a failed edit is not implementation
evidence.

## 2026-10-28 - Refresh failures need a transport recovery path

The first tool-refresh implementation handled the successful subscription path but left
a failed client connected without a subscription. A service-level retry test passed even
though the real client only subscribes after a welcome. Review exposed that dead end;
the real-socket regression failed with `socket stayed open` before the fix. Runtime
subscription failures now send their error and close with the existing retryable `1011`.

The refresh catch also minted a separate failure identity after the SDK had already
reported the storage failure. A real SQLite commit-fault test demonstrated two identities.
Refresh and submit now share the classifier's operation/session path, and the regression
requires one identity and one origin error. Test failure propagation across SDK, service
and transport together; calling a service twice is not proof that the actual client can
recover. The new tests use pi-ai's `getCurrentTools` for normalized transcript declarations
and the wire snapshot's `value.botId`, rather than assuming raw context/envelope fields.

## 2026-10-28 - Native path visitors and the formatter

The task-guide raster and geometry tests passed, but pre-commit rejected `Path.forEach`
under `ReplaceForEachWithForLoop`. That API visits path elements rather than iterating a
Sequence, so the suggested collection rewrite was not appropriate. The test now uses
CoreGraphics' native `applyWithBlock` visitor without disabling the rule. Strict formatting
must run alongside rendering tests before staging; a passing Swift compiler does not prove
the project's formatter accepts a native API idiom.

## 2026-10-28 - A declared option that nothing reads is not wired

The search-provider slice stopped mid-flight with `PiRuntimeOptions.search` and `.usage`
declared, `main.ts` passing both, and `PiDurableRuntime.open` never reading them. Every
existing gate was green: TypeScript accepts an unused optional property, Biome does not flag
an options field, and the 492 tests never selected the new `search` group against the real
runtime. The half-wiring was invisible until a test drove a faux model to call `web_search`
and read `Tool web_search is not available`.

Pass a new collaborator through the seam it is declared for and test that seam, not only its
sides. A thread of `options.x` from composition root to consumer is one behaviour and needs
one end-to-end test; a test of the consumer in isolation would have accepted the dead handoff.
The same review found the sibling leak: selecting an unavailable group still offered its
loader, because selection matched extension names without asking which were installed.

## 2026-10-28 - A truncated wire id is not a selector

Verifying the search tool end to end created two throwaway bots, then cleaned their usage rows
with `delete from usage_daily where bot_id like 'b_01a18114%'`. Wire ids are ULID-shaped, so
a bot the person had just created shared that prefix; the predicate deleted their bot's day
of usage too (30,871 tokens, 2 search calls). The damage was noticed because the next
`/v1/usage` lost a bot that the catalog still listed, and it was repaired from the numbers
printed before the delete (same day, model tokens and search calls, plus `last_seen` so the
next cumulative report cannot book the total twice) and confirmed through the API.

Always list the rows first and delete by exact id, one id at a time. A prefix match against a
time-ordered id selects more than the artifact just created, and deleting rows is not a
reversible cleanup step. Cleanup of verification artifacts must be scoped to ids the command
itself created and printed.

## 2026-10-28 - Keep provider composition out of transport

The first exclusive-provider implementation moved the factory into `server/providers.ts`,
which made transport import the tool adapters. The full architecture gate rejected those
three imports. The factory now stays in `main.ts`, while the server module owns only
provider definitions and persistence. Moving a factory for tidiness is not a reason to
change the layer allowlist; inspect dependency rules before choosing its destination.

The first native selection test also crashed before its assertion: a nested `Optional.flatMap`
closure created in a MainActor test inherited isolation but ran inside URLProtocol's
background callback. The crash report identified the executor assertion. Replacing the
nested callback with ordinary decoding exposed the intended red test (both providers
remained selected). A crashed or uncompilable test is not behavioral red evidence.

## 2026-10-29 — device-service worktree dependency installation

At base `7101566`, normal `npm ci` failed with proxy E404 for locked
`wrangler@4.152.0`. The independent service worktree verified 215 cached original
artifact bodies against its own committed root lock SRI; missing entries were
optional artifacts for other platforms. A task-private cache then completed
normal offline `npm ci`, including prepare/hook installation. The lock remained
unchanged. This is local dependency recovery evidence, not release validation or
a permanent registry exception. Receipts stay in ignored `.local/device-npm/`.

## 2026-10-29 — Re-signing a candidate does not update its registered helper

The first signed device candidate registered through SMAppService and worked locally
and against the isolated API. Quitting the App left the same helper and socket alive;
a fresh write and original-ID query both completed. After staging and replacing that
candidate with the final window fix, deep/strict verification still passed, but killing
the old helper did not refresh its registration. launchd rejected the replacement with
`OS_REASON_CODESIGNING / Launch Constraint Violation` and then reported `EX_CONFIG`.

The ServiceManagement SDK requires re-registering an updated LaunchAgent executable
and recommends unregistering it first. The existing App device switch already awaits
unregister before committing the disabled state; enabling it then registers the signed
bundle again. An external `swift -e` process has the wrong calling bundle context.
The pending local recovery uses that existing App switch, not a global BTM reset,
weaker signature requirement, identity deletion or repeated helper kills. Future
candidate updates must account for this registration boundary as well as file signing.
Logs remain under `.local/device-evidence/candidate-update-system.log`; this is an
observed local ad-hoc update failure, not evidence of a distribution-signed update.

The later `d32ea1a` candidate was fully assembled and signed in a fresh staging
directory. Its `.build` copy still failed after a successful SM submission:
amfid reported -423 and launchd rejected the current helper's launch constraint.
The running App and on-disk App CDHashes matched; the live job's expected hash
could not be extracted from the public dump. A forced registration of only this
bundle with LaunchServices returned zero but did not recover the existing job.
Do not reduce these observations to an old-inode diagnosis or infer that every
ad-hoc helper is unsupported.

Root then stopped the service, quit the App and copied the signed bundle unchanged
to `~/Applications/Eagle Device Candidate.app`. App/helper/Node hashes were identical,
inodes were new, deep/strict verification passed and no re-signing occurred. Normal
GUI registration there started the helper and created the file-vault identity;
the page showed local readiness and the isolated API connection. A real Bot wrote
and read a marker, with independent disk verification. This does not distinguish
the new path from the fresh inodes. The normal installed copy is the local delivery
path; no global BTM/LaunchServices reset, weaker code requirement or data deletion
was used. Evidence is in `gui/application-install.json`, `gui/installed-startup.json`
and `gui/local-command.json` under `.local/device-evidence/`.

The later settings-only candidate update also encountered amfid -423 and a helper
launch constraint failure. Temporarily disabling the service exposed a separate UI
gap: reopening the App with no service directory removed even the local machine
from the list. The default preference was still enabled; the visible disabled
state came from the recovery operation. After re-enabling, the installed new
helper ran and the UI reported local readiness; a staged old-helper recovery
bundle was not installed. The bounded observations do not establish why the first
registration failed. Service recovery must restore the previous user preference,
and the device list must retain the OS-provided local name while making unavailable
execution explicit. Evidence: `.local/settings-layout/layout-service-recovered.json`;
the local-row regression covers disabled startup and failed startup without a
directory, plus disabling an already known device.

## 2026-10-29 — Upstream Croner dependency missing from the npm proxy

Preparing the device-group PR against upstream `4eefe0a` introduced the locked
`croner@11.0.0` dependency. Normal `npm --prefix apps/bots ci` failed with a
tarball 404 from the configured proxy. Inventory of the task cache found every
required artifact except Croner; a retained local cache held its original bytes.
The bytes matched the committed SHA512 and the archive's package name/version.
After normal `npm cache add` into the private device-task cache, offline `npm ci`
completed with the unchanged Bots lock. All 102 installed package versions
matched; 28 optional packages for other platforms were absent. No package was
repacked and no registry or TLS setting changed. Evidence is retained under
`.local/device-evidence/upstream-pr/npm-recovery/`; installation success alone
does not establish the subsequent build, push or two-Mac acceptance results.

## 2026-10-30 — Installed helper update rejected before execution

The `20b13f0` candidate was assembled, verified with deep/strict codesign and
installed intact in `~/Applications`. Its automatic unregister/register ran,
but launchd rejected the helper with `OS_REASON_CODESIGNING / Launch Constraint
Violation` at 09:57:38, followed by `EX_CONFIG`. The helper file existed; the later
"could not find and/or execute" messages did not establish a missing-file cause.
The App and Bots daemon remained alive while device tools returned unavailable.

Normal App unregister, a forced LaunchServices refresh for this App only, and
App re-enable recovered the same installed signed bytes at 10:09:58. The UI showed
local readiness and the public cloud connection; the installed Bots device
adapter completed `/bin/df -k /` with exit 0. Identity, Raven configuration,
daemon token and catalogue hashes matched, and both Bot histories remained.
This establishes recovery, not which cached OS record caused the first rejection.
Evidence: `.local/device-evidence/reinstall-20261030-mm44r90m/`.

The follow-up distinguishes authenticated helper contact from Node readiness:
`service.ping` never waits for the Node socket or cloud. A bounded failed-handshake
recovery refreshes only this App and preserves pairing IDs and user preferences.
Ordinary management timeouts keep their uncertainty semantics. The local status
and policy publish before cloud directory reads so a slow network cannot hold the
local controls in their startup state.

The first follow-up's real upgrade (`bda3ef8`, 11:07:37) still produced two launch
constraint crashes before connecting at 11:08:53. The trigger for that eventual
recovery was not observed; its final 1.139-second handshake is not evidence of a
fast initial launch. The internal `LSRegisterURL` refresh had not reproduced the
earlier external registrar recovery. Inspection confirmed that Apple's `lsregister`
uses a different private registration entry point and has Apple-only entitlements;
the two paths must not be treated as equivalent.

The next candidate-only change runs that Apple registrar with `-f` and the exact
current App path, after asynchronous unregister finishes and before registering
the helper. Its completion is bounded and a failed refresh prevents registration.
Healthy same-bundle openings and status reads do not invoke it. No signature rule,
Keychain policy or system database is relaxed or reset. Real upgrade verification,
including local readiness and an installed command, remains the decisive check.

The bounded external registrar in `b13030d` still failed the real 11:23 upgrade:
launchd again rejected the helper and no helper became available during the
20-second startup observation. The extra process and its cleanup did not establish
a fix. A subsequent complete assembly at `fa1d1cd` gave the candidate a distinct
`CFBundleVersion`, preserving its product version, identity and signing rules.
That upgrade started the helper in about 4.95 seconds, reported local readiness
in 15.50 seconds and cloud online in 16.40 seconds without a manual retry; the
installed Bots adapter then completed `/bin/df -k /` with exit 0.

The job's parent build version now matched the new bundle. This supports distinct
candidate build identities but does not prove macOS's internal cache key. The next
trial removed the external registrar and checked a further complete upgrade with
only the public LaunchServices refresh and distinct build version. Earlier failed
observations remain under
`.local/device-evidence/device-settings-ui-20261030/`; do not recast eventual
recovery as fast startup.

The simplification trial at `05b3099` disproved that a distinct candidate build
version alone was sufficient on this Mac. The full signed upgrade launched at
11:45:35 with build `1793331893645`, but neither the first registration nor its
one automatic recovery reached a usable helper. The 20-second observation saw
only a transient process, and launchd subsequently reported `EX_CONFIG` 78.
That transient PID is not a successful start. No manual retry or registration
tool was used during this observation.

The observed successful combination at `fa1d1cd` included both a distinct build
version and the bounded Apple registrar. Restore that already-reviewed candidate
path and verify the combination in a further complete signed upgrade. The earlier
same-version registrar failure does not establish that the registrar is unnecessary
when combined with distinct build identity. Detailed observations remain in
`simplified-upgrade/` under the same evidence root; the OS cache mechanism is still
unproven, and release signing requirements are unchanged.

Restoring that exact combination at `67a0029` also failed the 11:48:25 upgrade:
the registrar completed and SM submission succeeded, but the helper never became
usable and launchd again reported `EX_CONFIG` 78. The successful `fa1d1cd` run
therefore cannot certify the combination as a reliable fix. The next narrow change
recreates the `SMAppService` instance after bundle refresh, rather than registering
through the instance constructed before that refresh. Whether that earlier object
retained stale registration metadata remains a hypothesis; the installed upgrade
is again the acceptance check. Evidence: `combined-upgrade/`.

The fresh-instance trial `872a31b` also failed automatic upgrade. The same signed
bytes recovered after the existing UI Retry at 12:00:27; a 12:00:47 probe found
local readiness, cloud online, both devices and both Bots. This is manual recovery
evidence. BTM logs for the failed 11:51 registration reused the same item and the
unchanged LaunchAgent configuration checksum, with invalidation occurring after
both attempted registrations. This points to registration propagation, without
proving that the hidden LWCR contained a stale hash.

Candidate assembly now writes its unique bundle build into the LaunchAgent's
`EAGLE_DEVICE_BUNDLE_BUILD` environment field, so BTM sees a changed configuration
alongside the changed signed bundle. Labels, Mach services, identity and signature
requirements stay fixed. The packaging regression failed first because the two
builds reused an identical launch configuration; the actual upgrade remains the
decisive check. The recovered `872a31b` also completed a real command from MacMini-2
to MacMini 1 and returned the identical result when queried by its original ID.

The final `fef7203` candidate passed two consecutive complete signed upgrades at
12:06:18 and 12:08:20 with no manual retry. Local readiness was observed at
12.83/11.39 seconds and cloud online at 13.53/12.17 seconds. Each job reported one
run and no exit; each installed adapter completed a local read-only command. The
two LaunchAgent configuration checksums differed and their build markers matched
their enclosing bundle versions. Identity, gateway, daemon token and catalogue
hashes matched the pre-install records, and both histories remained. This verifies
the final combination on this Mac, not Apple's internal cache key or notarized
distribution behavior. Evidence: `versioned-launch-upgrade/` and
`versioned-launch-repeat/` under the same evidence root.

## 2026-10-30 — Cron acceptance observed admission before completion

After integrating upstream `d69359b`, the complete Bots evaluation suite reported
two scheduled inputs but only one assistant reply in `trigger-cron`. Its wait
condition ended as soon as the second input appeared, then immediately asserted
that the second reply had also arrived. The assertion raced normal asynchronous
generation; the failure was not evidence that the second schedule failed to fire.
The case now waits for both assistant replies before making the existing schedule
origin and message assertions. The 240-second step and 300-second case budgets
are unchanged. The first failing run is retained in
`.local/device-evidence/device-settings-ui-20261030/final/bots-eval-serial.log`.

The preceding parallel Bots check and Swift compile also exposed the existing
50-millisecond shell-timeout fixture before its initial output arrived. Running
the unchanged complete Bots check without the concurrent compile passed both
636-test runs and coverage. Both observations are preserved; no timeout, coverage
threshold, test selection or project hook was weakened.

## 2026-10-30 — ServiceManagement async import differs across SDKs

PR #109's first macOS CI run passed dependency installation and the real device
integration suite, then rejected the async call to `SMAppService.unregister()`:
the CI SDK treats the service object as non-Sendable, so its synthesized async
method would send an actor-owned object to another executor. The local Xcode
build and normal push gates had accepted that import. The build failure is
retained in the ignored final `ci-macos-job.log` for run `41001859266`.

The wrapper now calls the system's completion-handler API synchronously on its
own actor and resumes a checked continuation after that callback. It preserves
the documented process-exit boundary before re-registration without adding an
unchecked Sendable declaration or disabling concurrency checks. The subsequent
CI build, rather than local compilation alone, verifies the older SDK path.

## 2026-10-30 — Repeated same-binary upgrades missed the helper update boundary

The complete `4cbeb98` SDK-fix package again hit a Launch Constraint Violation
and EX_CONFIG after installation. Its app and LaunchAgent build markers matched
and changed, but the helper identifier and CDHash also changed. Comparison of the
two successful `fef7203` packages showed identical helper bytes and CDHashes, so
those passes do not establish an upgrade across helper signatures. BTM's new
configuration still reused an existing item; its hidden hash set was not read.

The installation script quit the UI and moved the old App before the new App
unregistered the old service. The next change makes installation preparation
explicit: a signed App capability and a maintenance entry before SwiftUI, with
successful unregister completion and independent old job/PID disappearance before
whole-bundle replacement. The installer retains the previous bundle and refuses
replacement on an ambiguous preparation. For older candidates it may try the new
maintenance process once, but the same bundle ID or its status alone is never
accepted as proof that the old service stopped. Actual cross-signature upgrade
verification remains necessary; no signature constraint or user policy is relaxed.

The first prepared installer refused before quitting or replacing the old App:
`ps comm` returned SMAppService's relative `BundleProgram` as argv[0], not the
executable's absolute path. The guard stayed closed. The adapter now reads that
PID's executable path through the kernel's `proc_pidpath`, preserving the exact
installed-bundle comparison rather than accepting a relative name.

The prepared legacy migration to `7ed57d4` debug passed automatically and preserved
the existing data. It reused the helper bytes. The following debug-to-release
upgrade changed the helper, awaited the old installed App's unregister callback,
confirmed the old job and PID absent, then replaced the bundle; launch constraints
still rejected the new helper. Earlier unregistration is therefore an installer
safeguard, not a demonstrated complete fix for the cached constraint.

The next candidate-only trial puts its build version in the actual helper filename
and points BundleProgram at it. Signing, the App's code-identity lookup and installer
ownership checks read that same signed plist. The label, Mach service, code-signing
requirements and device data do not change. Its real changed-helper installation
remains the deciding check; no successful upgrade is inferred from the new layout.

The `1034f43` versioned-helper trial also failed twice with explicit Launch
Constraint Violation before execution. The observed PID was transient and did
not establish readiness. Changing the executable path did not close the cached
constraint issue. The next narrow signing trial assigns only the candidate helper
a stable reverse-DNS identifier, retaining its exact ad-hoc CDHash requirement.

The `59e6b37` fixed-identifier package still failed twice at launch. Its actual
identifier and exact CDHash were verified, so this is not a missing signing flag.
The next bounded trial versions the candidate's Label, MachService and plist name
together, preserving its profile and data paths, and selects the old service for
installer cleanup from the old signed bundle. This targets the observed reuse of
the older BTM item rather than adding another delay. Live acceptance remains open.

The versioned-service trial passed a real changed-helper upgrade at `2bea0d6`:
debug-to-release changed its SHA/CDHash; the normal installer removed the old job,
then the new job ran once and reached local readiness in 10.60 seconds and cloud
online in 11.77 seconds. No manual retry was used for that upgrade. First adoption
had explicitly cleared the previously failed legacy job through the old signed
App and is recorded separately. Identity/configuration hashes and both history
files were preserved; installed local execution and physical A-to-B execution
with an original-ID query passed. This demonstrates the candidate upgrade path;
it does not claim knowledge of Apple's private cache key or distribution signing.

The subsequent scope review found the website still exposing the device routes
and provisioning duplicate DO bindings after the product had moved to its own
Worker. The redundant website changes were restored to main, and the same API
and process tests now use the actual standalone entry. A website isolation
regression first returned 503 instead of 404; all 67 affected cases then passed.

Root is also validating a combined startup simplification: use the existing
background `LSRegisterURL` API instead of a registrar subprocess, give new helpers
a fixed filename and omit the duplicate build environment marker. Versioned
service names, old-bundle path parsing, update preparation and exact peer signing
requirements remain. The prior failed trials are retained above; local packaging
tests alone do not establish that the simplified real upgrades work.

That combined simplification passed both complete installed upgrades at `d121736`.
The second kept the helper path fixed while changing its SHA/CDHash, automatically
reached local readiness in 12.70 seconds and cloud online in 13.48 seconds, and
left the old job absent and the new job running once without exit. The first took
11.55/12.51 seconds. Installed local and physical peer execution/result retrieval
also passed. This supports deleting those three redundant mechanisms while
retaining versioned service identities and update preparation. Identity, Raven,
token and catalogue hashes matched. Both recorded history files exist; the old
size baseline was not refreshed, so it cannot prove byte-identical histories.

PR #109's Check run `41013306952` failed one of 287 Swift tests at `d68e210`:
`BotsWindowLifecycleTests.waitUntil` expired its two-second wall-clock deadline
while other MainActor tests took about 14.5 seconds. This was a test failure before
coverage calculation, not a coverage percentage failure. The lifecycle fixture
now signals factory calls and entry of the second start task with continuations,
keeping the factory result suspended until the test releases it. The existing
connection-count, close, replacement and retry assertions remain, with an added
final count assertion. Product connection logic and test concurrency are unchanged;
the original CI log remains in `.local/device-evidence/pr109-scope/github-macos-d68e210.log`.
The fixture retains the result of releasing all calls, so a late duplicate factory
call still increments the count and completes instead of hanging before the final
assertion. Individually released old/new calls remain independently controlled.

The next run at `2a28287` passed Linux but timed out while executing the native
focus fixture, before reaching coverage. Compilation, signing and cursor lookup
had succeeded; the unchanged 60-second process deadline stopped the fixture.
The probe, its Swift fixture, all EagleDesign inputs and CI configuration match
`d68e210`, whose focus check passed. This does not yet establish a transient cause.
The requested single macOS-job rerun returned HTTP 403 because the personal
account lacks upstream repository admin rights; no rerun started. The failure log
and rejected request remain in `.local/device-evidence/pr109-scope/`. The next
verification follows the normal checkpoint/documentation push to the owned fork;
no timeout, assertion, hook or account permission was changed.

The documentation-only head `82b4cfd` failed the same native fixture execution
deadline in run `41016561875`; Linux passed again. The second log is retained in
`.local/device-evidence/pr109-scope/github-macos-82b4cfd.log`. Neither failure
identified an internal stage: the fixture wrote its report only after closing
all windows, and the parent threw on the process error before printing captured
output. The fixture now writes elapsed time, completed-check count and stage
entry/return markers directly to stderr, including layout, hover, sheet and
window cleanup boundaries. The parent prints status, signal, error and captured
streams before preserving the original assertion. This is diagnostic evidence
collection, not a demonstrated timeout fix; the 60-second CI limit, all 42 checks,
execution mode and gates remain unchanged. The local verification compiles the
fixture and checks formatting without running the interactive probe while the
user tests the installed App. The next normal CI run supplies runtime evidence.

During the 0.15.2 release, the shell's inherited Herdr pane identifiers pointed
to another workspace. A split using `--current` opened an empty pane there; it
was closed immediately, without running a command in it. The active agent list
identified Eagle's actual pane. Before controlling Herdr, compare inherited
identifiers with the live agent list and target the verified pane explicitly.

During the 0.15.2 release, the green Check triggered deployment before the tag
push's normal pre-push checks completed and before the draft was published.
From 13:39:23 to 13:41:27 UTC, `/api/live` advertised 0.15.2 while the Latest
release still pointed to 0.15.1; no affected client was observed. The release
was then published and both endpoints agreed. Before the next app release,
coordinate the automatic deployment with publication so the downloadable asset
is public before the update endpoint advertises it; do not bypass the hooks.
