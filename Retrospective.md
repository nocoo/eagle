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
