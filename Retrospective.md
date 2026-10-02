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
