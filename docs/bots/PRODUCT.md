# Bots — product contract

Status: **phase 1, documentation only**. No Bots code exists yet. This file is the
first of six documents; see [ARCHITECTURE.md](ARCHITECTURE.md) for structure,
[PROTOCOL.md](PROTOCOL.md) for the wire contract, [RUNTIME.md](RUNTIME.md) for the
pi-durable mapping, [OBSERVABILITY.md](OBSERVABILITY.md) for logging and
[TESTING.md](TESTING.md) for the test ladder.

The hosted App's in-window menu includes “设置…” beside “会话状态” and “基础控件”.
The host injects the action that returns to that workspace's real settings; the
gallery does not own another settings profile. Account menu and ⌘, open the same
settings, and repeating the open command keeps settings open.

Bots is a **new, isolated product** in this repository. It shares no code,
protocol, build or dependency with the Eagle website, Worker or Agent. Its only
shared asset is `apps/macos/Sources/EagleDesign`, a dependency-free SwiftUI
token/component library with no feature state.

## What it is

A macOS chat client plus a local daemon. A user creates bots; each bot is one
independent durable conversation backed by `@earendil-works/pi-durable`. One bot
is one sqlite file, one Harness, one agent configuration, one working directory
and one event stream. Bots never share mutable state; the daemon only multiplexes
I/O for them.

The daemon lives in `apps/bots`; the client is its own SPM package in
`apps/bots-macos`, which depends only on the dependency-free `EagleDesign`
library. Neither is part of the Eagle web, Worker, Agent or Swift builds.

Phase 1 is a pure chat product: create, rename, delete and talk to bots. Bots
have no tools. This is deliberate — the runtime, protocol and client are built so
tools and bot-to-bot conversation can be added later without reworking any layer
(see [Reserved capabilities](#reserved-capabilities)).

## Owner decisions (fixed)

| # | Decision | Consequence |
| --- | --- | --- |
| D1 | One daemon process hosts many bots | No per-bot process, no orchestration service |
| D2 | Complete isolation from Eagle | Separate npm project, separate lockfile, separate gates; no import of `apps/web`, `packages/agent`, `packages/contracts` |
| D3 | Every bot executes independently | Per-bot storage, Harness, settings, event stream; one bot's failure never stalls another |
| D4 | Phase 1 exposes chat only | The wire reserves the shape of tools, tasks, usage, raw entries, agent settings and peers; nothing renders them and no half-built UI ships |
| D5 | Tools and bot-to-bot chat are the next phase | Protocol, ports and capability flags reserve them now; no UI work for them in phase 1 |
| D6 | Busy default is `followUp` | A message sent while a run is active is queued and placed when the run answers |
| D7 | Speed is a feature | Bot creation must feel instantaneous; see [Speed targets](#speed-targets) |
| D8 | Local only | Loopback HTTP/WS with a 0600 bearer token; no remote access, no Cloudflare, no multi-user |

## User journeys (phase 1, complete list)

1. **Create.** The user picks "New Bot", types a name, confirms. The bot appears
   in the sidebar immediately and is ready to receive a message.
2. **Rename.** Inline rename from the sidebar; the new name survives a daemon
   restart.
3. **Delete.** Deletion removes the bot from the sidebar at once. The daemon
   closes the bot, moves its directory to `trash/` and updates the catalog.
   Restoring from trash is not a phase-1 feature; nothing is destroyed.
4. **Chat.** Selecting a bot shows its transcript and composer. Sending admits
   the message durably before it is echoed. Streaming answers update in place.
5. **Queue.** Sending while the bot is answering queues the message and shows it
   as queued, not as sent.
6. **Abort.** Stopping ends the run; the partial answer stays visible and is
   marked aborted.
7. **Reconnect.** Closing and reopening the window, or a temporary daemon
   restart, restores every transcript without user action. No message is
   duplicated or lost. Messages are bounded by construction; in the impossible case
   of an answer above the transport limit, the chat shows a notice instead of a
   silently shortened answer.
8. **Recover.** When a bot reports `unavailable` or a parked task, the chat offers
   one action: retry. It re-opens an unavailable bot or retries parked work, then
   reloads the transcript. It never interrupts a healthy answer; abort is a
   separate, explicit action.
9. **Quit.** Quitting the app does not stop the daemon. A daemon that was killed
   mid-answer resumes the run when it starts again.

Anything not in this list is phase 2.

## Delegation (phase 2)

A bot runs code and shell commands in its own workspace without asking (slice 1), and can
open a herdr space of its own, start a controller agent there, exchange messages with it,
wait for it, read its screen and close the space (slice 2). Tool calls are bot-side
activity: they stay on the left at the answer card's width, show what is running while it
runs, collapse into one line when the run's calls settle, and open a detail dialog with
each call's arguments and output.

## Native composer

The composer grows upward from one visible text line to three, for both soft wraps
and explicit newlines. Further text scrolls inside the native field without growing
the composer. Clearing or sending the draft restores its one-line height. The bottom
inset and attachment/send controls stay anchored; draft ownership and send semantics
remain unchanged.

Opening a Chat conversation or selecting another bot gives the native input focus
once. Streaming transcript updates do not take focus back from another control.
Clicking blank space inside the rounded composer, including its padding, focuses
the same input without changing the draft. Native text selection, Return and
Shift-Return handling, and the attachment/send controls keep their behavior.
Clicking empty space in the Chat transcript also returns focus to that input,
including the space below a short conversation and the side insets. Message text
selection, links and buttons keep their own click targets; scrolling preserves
the current focus.

## Conversation identity and activity

Sidebar group headers show only a positive count of visible unread conversations,
as an accent capsule with white text. Zero has no badge, and collapsed groups retain
the same count. The count uses the existing session-local mark-unread/read state,
not message totals or an inferred daemon delivery count; selecting a row marks it
read. There is no hard-coded unread footer in the live workspace.

The native sidebar subtitle shows a single-line excerpt of the latest received
user or assistant text, not runtime state. Thinking, tool output and system notices
are excluded. Preview text is bounded to 160 characters and Markdown markers are
removed for display. Received previews remain available while switching bots or
reconnecting; a fresh empty snapshot clears the old preview. A never-loaded bot
has no preview: the current catalog protocol does not supply global message
summaries, so these excerpts are session-local and not evidence of background freshness.

The centered, rounded-rectangle identity card is the conversation's single status/control surface. An
indeterminate highlight travels around its entire outer border during processing, answering and reconnecting;
the label reflects observed connection/runtime state, never inferred completion.
Connection loss overrides stale running state; a new welcome remains syncing until
the subscription snapshot arrives. Historical errors stay inspectable without hiding
a current answer or stopping its activity animation. A separate, accessible stop button
inside the capsule aborts the selected bot only while connected and running. Clicking
the identity still toggles the inspector. Recovery and an expandable, dismissible error
remain available in the same capsule; there is no top-left status strip. State changes
use a restrained spring/fade, with no continuous animation under Reduce Motion. Long
names truncate before overlapping the side-column controls.

## Message copying

Live transcript publication includes prepared Markdown blocks for every assistant
row. Preparation runs off MainActor before rows enter the lazy scroll container;
revealing history must not first lay out an empty bubble and later expand it.
Unchanged row text reuses prepared blocks, and the cache is bounded by the current
transcript. Scrolling history preserves user control over bottom following.

Hovering a message reveals a small copy control on the left of a user bubble and
the right of an assistant bubble. Its 10 pt glyph retains a 28 pt hit target. The
whole target is vertically centered beside a single rendered text line and remains
bottom-aligned beside multiple lines. Native text baselines include soft wrapping;
the decision is not based on newline characters in the source. The
action remains reachable while the pointer moves
onto it and through keyboard focus. Its reserved space prevents layout jumps. Copy
writes the original message source, including Markdown, to the clipboard and briefly
shows a checkmark; failure reports a retryable copy error. An empty streaming bubble
does not overwrite the clipboard. Copy feedback belongs to the leaf control, not the
transcript or workspace view model.

## CJK markdown emphasis

Chinese strong spans such as `**可以正常轮询。**截至...` render as bold even when
punctuation touches following text. The prepared display inserts hair-space delimiter
boundaries around paired CJK `**` spans for Foundation's CommonMark parser; code spans,
escaped markers and unfinished delimiters retain their meaning. The stored source is
unchanged. Other delimiter forms retain Foundation's parsing semantics.

## Profile editing

A bot's name, optional label and face are editable from its profile in the right panel:
hovering the face dims it and offers a pencil (the face editor reuses the create grid),
and clicking the name or the label edits it in place. A change is written over
`PATCH /v1/bots/:id` and the catalog push repaints the sidebar and inspector.

## Setup and guidance

The app starts the local Bots daemon on launch when it can find `apps/bots`
(settings shows its state and lets a person start, stop or restart it), and stops the daemon
it started when the app quits; a daemon that was already running is left alone. The model
gateway (URL, API key, model) is configured in the app's Settings under
`模型`; the same tab tests the endpoint and reports latency and model count. Setup is
progressive: a bot stays readable and usable until a send is attempted without a configured
gateway, and only then the conversation offers a short "去设置" hint. Nothing asks for
credentials at launch.

The saved gateway key is bound directly to the daemon's provider on startup and on
settings changes. Runtime authentication does not depend on a previous Save action
having populated process environment variables. Daemon health proves local service
availability, not upstream model authentication or generation success.

## Speed targets

Measured on this machine with Node 26.12.0 and `pi-durable@1.4.0`, using the faux
provider in `/tmp`: one bot, 200 turns with a 456-character answer and a
~140-character prompt, then a reopen immediately after close (warm page cache),
then 20 bots opened in one process. Single sample per row, not a percentile; the
scope of each claim is recorded in
[RUNTIME.md](RUNTIME.md#evidence). Real-model latency is network latency and is
excluded: the smoke test against the pinned development endpoint measured 1.3–1.7 s
per answered turn, which is upstream time, not Bots time.

| Operation | Measured (single sample) | Phase-1 bound (median of 5 samples, see [TESTING.md](TESTING.md#performance-measurement)) |
| --- | --- | --- |
| `Harness.open` + `root()` on an empty bot | 7 ms | < 250 ms |
| Reopen a bot with 400 entries / 479 KB | 3 ms | < 100 ms |
| One `submit()` → settled answer (faux) | 2–7 ms | < 200 ms |
| 200 answered turns, same bot | 164 ms total (≈1 ms/turn) | — |
| Storage growth per turn (456-char answers) | ≈2.4 KB | — |
| 20 bots open in one process | 30 ms, RSS 103 MB | < 1 s |
| Create bot (catalog write + directory) | — | < 50 ms |
| Delete bot (close + move to trash) | — | < 50 ms |

Implications recorded here so no later design contradicts them:

- Cold open is cheap enough that a bot is opened lazily on first use, with an
  asynchronous warm-up after creation. No connection pool, no pre-opened pool.
- Memory, not time, is the resource to manage: many open Harnesses cost RSS, so
  idle bots are closed (`idleCloseMs`, default 10 minutes). Reopening is 3 ms.
- The client never waits on the daemon to show that a message was admitted: the
  optimistic bubble is local, and durable admission arrives as a `submission`
  event.

## Reserved capabilities

The protocol carries a capability set in its handshake. The client renders only
what is enabled, so later phases flip flags instead of rebuilding screens.

| Capability | Phase 1 | What actually exists in phase 1 | Reserved for |
| --- | --- | --- | --- |
| `tools` | `true` (phase 2) | Tool calls and results render as transcript rows: name, arguments, status and output, live and after a snapshot; the workspace and herdr tools produce them. Settings → `通用` → `隐藏工具调用` drops those rows from the transcript without changing the stored conversation (off by default) | Approvals (none: tools execute without asking) |
| `tasks` | `false` | An `error` kind for parked tasks and a `recover` command | Task panel, per-task retry, compaction control |
| `entries` | `false` | Nothing beyond the transcript itself | Raw entry inspector |
| `usage` | `false` | A `usage` field in snapshots, populated from `pi.usage` (the data is live; only the panel is missing) | Token and cost panel |
| `agent` | `false` | Per-bot model stored in `bot.json` and used for every request | Model, thinking level and instructions editing |
| `peers` | `false` | A capability flag | Bot-to-bot messages and delegation |

Reserved means exactly two things: the wire can represent the concept, and a
client that receives it while the flag is off must ignore it. It does **not**
mean a hidden implementation exists. Each enable path is a change set of its own,
listed in [RUNTIME.md](RUNTIME.md#reserved-capability-enable-paths).

## Built-in tools (phase 2)

Tools are trusted, built-in pi-durable extensions, not third-party plugins. The mandatory
`coding` group uses the native `CodingTools` extension (`read`, `write`, `edit`, `bash`).
The mandatory `core` group supplies missing native functionality, starting with `list`.
Herdr and child-agent groups remain optional. Tool execution has no approval dialog.
The bot's workspace is its default working directory, not a security boundary. A plugin
marketplace, third-party module discovery and an execution sandbox are not product goals.
Argument validation, cancellation, bounded output and keeping credentials out of logs and
inherited command environments remain correctness requirements.

## Non-goals (phase 1)

- Tools, file access, shell, code execution.
- Bot-to-bot conversation, subagents, delegation, orchestration.
- Multi-user, sharing, remote access, mobile.
- Attachments, images, voice.
- Search across transcripts; export/import; transcript editing.
- Migrating existing pi coding-agent sessions (formats are unrelated and
  `pi-durable` explicitly does not provide a compatibility layer).
- Cloudflare Workers / Durable Objects hosting. The ports allow it later; nothing
  in phase 1 assumes it.

## Success criteria

Phase 1 is done when all of the following hold, each verified by a command
recorded in [CHECKPOINTS.md](CHECKPOINTS.md):

1. `cd apps/bots && npm run check` passes from a clean checkout, with no API key,
   and `npm run coverage` holds 90% lines / 90% functions / 85% branches with
   `--test-coverage-include-all`.
2. `cd apps/bots-macos && swift test` passes and `Scripts/coverage.sh` holds the
   90% Bots logic gate for its own target list.
3. The nine journeys above are exercised end to end against a real socket with the
   faux provider.
4. `npm run test:crash` passes: a `SIGKILL` mid-answer admits the input once,
   keeps the interrupted attempt as an aborted message, completes the answer once,
   and a delete interrupted between rename and catalog write reconciles on the next
   start.
5. One injected failure per layer is attributed to exactly one layer by
   `test/log/origin.test.ts` and `test/log/trace.test.ts`, not by reading code.
6. `npm run perf` prints its environment and samples and stays inside the bounds
   above.
7. Architecture guards pass: no `@earendil-works/*` import outside
   `src/runtime/**`, no protocol import from core, and no networking API in
   `BotsCore`/`BotsFeatures`/`EagleDesign`.
8. Isolation holds: root `npm run check`, the Eagle Swift package tests and biome
   do not touch `apps/bots` or `apps/bots-macos`.


## P0 local multi-replica history

The daemon's authenticated local history handoff can move a complete immutable head
between independent SQLite runtimes. Import preserves original history without running
models/tools or adopting the source's active work. A person/caller explicitly starts a
new local run from a ready head, under a fixed request ID. Two devices may create sibling
branches without replacing either; the workspace, provider session and credentials stay
local. This first slice has no App sync UI, discovery, network sync service or cloud.

Original model/tool records, reset/compaction sources, edits, inline attachments and
supplied versioned resource bytes are retained. P0 rejects nested tool history because
its full results are not transcript entries. Saved-but-uninstalled instructions/skill
resources block continuation; installing/loading complete resources remains P2.
The current production tools do not expose nested execution. See RUNTIME/TESTING for
actual local evidence; physical multi-Mac and P1–P6 remain unverified/planned.


## P1 first local incremental slice

A Bot can explicitly associate an empty local replica with a shared Bot UUID, pull/apply
new committed history and run from a complete locally materialized head without the
source online. Each machine owns its run intents; received input/run facts are passive.
Concurrent continuations remain distinct heads, including after restart and forwarding.
Missing or invalid source data does not claim applied status or prevent another complete
local head from running. The implementation is currently a local authenticated API, not
an App sync workflow or physical multi-Mac acceptance; resource installation and device/
network/UI stages remain planned.

Saved history can be passively restored into a new local Bot directory while retaining
its explicit shared identity. The runtime generates a new stable replica identity/epoch;
source facts keep their old identities and unsent branches. A local carrier inventory
covers legacy imported heads absent from source pages. Only a new user request runs on
the restored instance; pending/active work in saved facts stays passive. This does not
provide automatic directory rollback detection, resource installation or a backup service.


## P1 permanent shared-Bot deletion

Deleting a bound Bot permanently deletes its sharedBotId. Root catalog tombstones
survive removal/restart and can be passed explicitly between authenticated local
daemons. Old pages, imports, bindings and saved execution intents cannot restore that
identity. A new Bot has a new identity; there is no undelete or automatic trash cleanup.
Trash retains original history and unuploaded branches. This local API slice adds no
cloud transport, App workflow or physical-device acceptance.


## P2 fixed-head resource loading (first local slice)

An explicit local run selects the complete resources manifest from its immutable head.
Bot-specific AGENTS instructions, every file of each selected skill package and attachments
are installed in that Bot's state, never over the local workspace. Each branch retains
its selected version through completion/restart while another branch uses another version.
Imports/pages stay passive. Ordinary root-chat version selection is delivered: each input
selects an explicit ready resourceHead on the original root/queue, including fixed queued
versions after local edits. No selector on a new round preserves legacy empty resources.
This does not certify complete P2, device transport, cloud or physical-Mac acceptance.

A fresh empty Bot can capture a complete ordered package with replica export
`{kind:"resources",resources}` and passively import the explicit resource-only carrier.
Its immutable head selects the package for the first real ordinary input; no placeholder
chat/history is needed. All selected skill files and attachments retain their original
bytes and relative hierarchy. Model sections provide this Bot's installed paths; tools
write in its own local workspace. The package supplies no cwd, credentials or permissions.
Incomplete/invalid packages or failed installation admit no work; empty carriers are refused.
