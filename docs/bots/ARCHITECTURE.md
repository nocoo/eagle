# Bots — architecture

Status: **phase 1 contract**. Implementation must match this document; changes
here land in the same commit as the code they describe. Product scope lives in
[PRODUCT.md](PRODUCT.md), the wire format in [PROTOCOL.md](PROTOCOL.md), the
runtime mapping in [RUNTIME.md](RUNTIME.md), logging in
[OBSERVABILITY.md](OBSERVABILITY.md), tests in [TESTING.md](TESTING.md).

The current extension/tool structure, native SDK integration and planned tool
families are in [Extensions and tools](EXTENSIONS-AND-TOOLS.md).
Tool groups select native extensions; they do not replace the application core
or introduce another execution engine.

## Isolation

Bots is a separate project that happens to live in this repository.

| Aspect | Rule |
| --- | --- |
| Daemon | `apps/bots/**`. Own `package.json`, `package-lock.json`, `tsconfig.json`, `biome.json`. Not a member of the root npm workspace |
| Client logic | `apps/bots-macos/**`: an SPM package (BotsCore, BotsTransport, BotsFeatures) with its own tests and gates; it depends on nothing from Eagle |
| Client UI | `apps/macos/Sources/EagleFeatures/BotsWorkspace.swift` and `WorkspaceShellView.swift`: a Bots group in the Eagle main window, built from EagleDesign components; the Eagle app depends on the Bots package, never the reverse |
| Shared code | `apps/macos` exposes `EagleDesign` as a library product for the Eagle targets; Bots logic does not import it |
| Forbidden imports | No Bots package file imports `apps/web`, `packages/agent`, `packages/contracts` or any Eagle target; the Eagle app is the only side that imports Bots |
| Gates | `apps/bots` and `apps/bots-macos` have their own gates. Root `npm run check`, the Eagle Swift package tests and CI do not run Bots |
| Biome | Root `biome.json` excludes `apps/bots`; the Bots daemon lints itself with its own Biome version |
| Docs | `docs/bots/**`; the root `AGENTS.md` carries a short rules section only |

The client UI is one window inside Eagle, not a second app: a bot is a sidebar
item, and selecting it turns the middle column into that bot's conversation. The
logic package stays free of Eagle so it keeps its own tests and gates, and the
dependency direction is fixed: Eagle imports Bots, Bots never imports Eagle (and
`EagleDesign` stays dependency-free).

## Layers

Eagle may inject a version-1 shared-device access port at daemon composition.
The adapter in `tools/devices` owns its JSONL codec and Unix socket client; it
imports no Eagle, Worker, Agent or contracts source. Credentials remain behind
the independently managed host helper. The same injected port serves existing
and newly created Bots. Standalone Bots without a port retain native local tools.
The device extension is mandatory when injected, regardless of saved tool groups.


Five layers. Calls go one way; every crossing logs one `trace` (see
[OBSERVABILITY.md](OBSERVABILITY.md)).

```
L4  client              apps/bots-macos: BotsApp / BotsFeatures / BotsCore / BotsTransport
                          │  CatalogPort, ConversationPort  (domain level, no wire)
                          ▼
L3  wire                apps/bots/src/protocol/**  (maps domain ⇄ frames)
    transport           apps/bots/src/server/**    (auth, socket, dispatch)
                          │  ServerEvent / ClientCommand envelopes (PROTOCOL.md v1)
                          ▼
L2  core                apps/bots/src/core/**
                          │  domain types (domain.ts) + RuntimePort
                          ▼
L1  runtime adapter     apps/bots/src/runtime/pi/**
                          │  pi-durable API
                          ▼
L0  pi-durable          @earendil-works/pi-durable 1.4.0 (pinned dependency)
```

| Layer | Owns | Must not know | Type ownership |
| --- | --- | --- | --- |
| L4 client | Views, view models, reducer, drafts, connection state | Wire encoding, pi-durable, sqlite | `BotsCore/Model`, `BotsCore/Logic`, `BotsCore/Ports` |
| L3 wire | Frames, versions, limits, auth, close codes; mapping domain ⇄ frames | Bots behaviour, pi-durable | Envelope types live in `protocol/`; **domain types are imported from `core/`** |
| L2 core | Domain types, catalog, lifecycle, ordering, fanout, command routing | `@earendil-works/*`, sockets, frame shapes | `core/domain.ts` |
| L1 adapter | pi-durable ⇄ `RuntimeEvent`; failure classification | Catalog, transport, `rev` numbering | `runtime/pi/**` |
| L0 | Durability, model calls, compaction | Anything about Bots | Upstream |

Two depend on the third:

- `protocol/` depends on `core/domain.ts` and maps it to frames. It never defines
  a second copy of `Message`, `ConversationSnapshot` or `Submission`.
- `core/` never imports `protocol/`: a core test constructs domain values and
  never mentions a frame.
- `server/` depends on `protocol/` and `core/`; it owns sockets only.

Guard tests: `test/architecture.test.ts` asserts (a) no `@earendil-works/*`
import outside `src/runtime/**` and `src/tools/**` (the adapter boundary), (b) `src/core/**` and `src/protocol/**` do not
import each other's internals in the forbidden direction (`core` imports nothing
from `protocol`), (c) `src/runtime/**` imports no `core/` module other than
`core/domain.ts` and `core/RuntimePort.ts`.
`BotsCoreTests/DependencyRulesTests.swift` asserts `BotsCore` and `BotsFeatures`
contain no `URLSession`/`URLRequest`/`WebSocket`/`URLProtocol` and that wire
decoding lives only in `BotsTransport`.

### Native presentation boundary

The Eagle shell observes catalog/selection metadata, not transcript deltas or draft
keystrokes. `BotsConversationContent` observes a dedicated `BotsTranscriptViewModel`;
the original conversation view model still owns the only writable draft. Synchronous
notification bursts coalesce into one metadata publication, with unchanged values
left unpublished. Transcript projection and tool formatting run on a serial actor,
reuse identical input and discard cancelled results after a selection/content change.

Markdown parsing and inline attributed-text preparation run on a separate renderer
actor, outside `View.body` and MainActor. A bubble retains its prepared content until
its text changes; a cancelled render cannot overwrite a newer one. Only the active
caret owns periodic animation. The transcript uses lazy rows, without whole-stack or
whole-document streaming animations. These boundaries do not certify a frame-time
budget; event replay and live rendering remain separate verification obligations.

Streaming and terminal assistant content share one view branch so preparation survives
a status-only transition. Bottom following responds to measured content height, including
late markdown preparation, and is suspended when the user scrolls into history. Selecting
another bot resets that scroll state; a new content height must not drag a history reader
back to the bottom.

## Module inventory

### Daemon (`apps/bots`)

```
src/
  main.ts                     paths, singleton lock, servers, closing (composition only)
  config.ts                   defaults; the only place env vars are read
  core/
    domain.ts                 Message, ContentBlock, ConversationSnapshot, Submission,
                              BotSummary, BotState, ErrorKind, BusyMode  (wire-independent)
    RuntimePort.ts            RuntimePort, RuntimeHandle, RuntimeEvent, RuntimeBotSpec
    Invocation.ts             InvocationPort, Invocation, InvocationOrigin, id and text caps
    BotDirectory.ts           catalog.json CRUD, atomic write
    BotRegistry.ts            open/close/quarantine, idle close, recovery scan, deadlock-free lock
    EventHub.ts               per-bot rev, fanout, coalescing, snapshot rerender, paging
    view.ts                   pure fold of runtime events into a ConversationSnapshot
    ConversationService.ts    connections, command routing, submission ranking, history, resync
  protocol/
    version.ts  limits.ts     PROTOCOL_VERSION, frame and page budgets
    events.ts   commands.ts   encode/decode domain ⇄ frames, validation
  tools/                      the bot's tools, inside the adapter boundary
    registry.ts               native CodingTools, core list, Herdr and child-agent extensions
    list.ts                   native-style bounded directory listing through ExecutionEnv
    workspace.ts              default directory creation and Herdr-owned cwd resolution
    types.ts                  the Herdr workspace and business-tool outcome shapes
    herdr/client.ts           the herdr CLI as typed calls (argv, JSON, deadline, abort)
    herdr/tools.ts            the eight herdr tools and the one-space-per-bot rule
  runtime/pi/
    mapEvents.ts              pi AgentEvent / reports / watch end → RuntimeEvent
    PiDurableRuntime.ts       Harness ownership, submission ledger, close, recover
  server/
    http.ts ws.ts auth.ts     catalog and gateway endpoints, socket, bearer
    gateway.ts                model gateway store, public shape and connection probe
  log/                        see OBSERVABILITY.md
  testing/                    FakeRuntime, fixture server
test/
  protocol/ core/ runtime/ server/ e2e/ log/ perf/ crash/ architecture.test.ts
```

### Client logic (`apps/bots-macos`) and its UI in Eagle

```
apps/bots-macos/
Package.swift                 no Eagle dependency; swiftLanguageModes: [.v5]
Sources/
  BotsCore/
    Model/Domain.swift        domain types mirroring core/domain.ts names
    Logic/Reducer.swift       pure fold into ConversationState, ranked submissions
    Logic/RevisionGap.swift   the gap rule the transport applies
    Ports/Ports.swift         CatalogPort, ConversationPort, ConversationEvent, ConnectionState
  BotsTransport/
    Wire.swift                frame codec (decode server events, encode commands)
    CatalogHTTPClient.swift   /v1/bots over HTTP
    ConversationSocket.swift  handshake, subscribe, gap/resync, close codes, backoff
    TokenStore.swift          `<root>/token` (env override for a dev shell), AppPaths
  BotsFeatures/
    AppViewModel.swift        catalog, selection, create/rename/delete
    ConversationViewModel.swift  connection, transcript, composer, outbox reconciliation
    OutboxStore.swift         persisted unsent sends (PROTOCOL.md, client duties)
Tests/
  BotsCoreTests/ BotsTransportTests/ BotsFeaturesTests/
Scripts/coverage.sh           logic coverage gate (90% lines)

apps/macos/Sources/EagleFeatures/
  BotsWorkspace.swift         BotsWorkspaceViewModel (observes the logic view models,
                              republishes as SidebarSection/TranscriptEntry), BotsPresenter
                              (pairs tool calls and results by callId into ToolRow entries)
  WorkspaceShellView.swift    merges the Bots group into the sidebar and routes the
                              conversation column to it when a bot is selected
```

The UI is the existing Eagle shell: `SidebarPanel`, `ConversationColumn` and
`InspectorColumn` are unchanged, and a bot is a sidebar item whose conversation is
rendered through them. Streaming is real: the reducer folds each delta into the
message, and the presenter re-emits the assistant paragraph as it grows (with the
typing row while an attempt has no text yet).

`BotsCore` names mirror `core/domain.ts` one-to-one so a log line, a fixture and a
Swift type use the same word. Wire decoding is confined to `BotsTransport`.

## Ports

Two boundaries. `RuntimePort` is the runtime adapter's contract, one Harness per
bot. `InvocationPort` (`core/Invocation.ts`) is the one way a caller **without a
client connection** admits work — a schedule, a webhook delivery or another bot —
and it is defined in [TRIGGERS.md](TRIGGERS.md) §3. The service implements both
sides of routing: `subscribe`/`send` for a connection, `invoke`/`observe` for a
port caller, over one per-bot view and one admission chain.

```ts
// apps/bots/src/core/RuntimePort.ts
// Every event carries the trace that caused it: the submission trace for run
// output, the connection or boot trace otherwise. Failures carry a minted identity
// so one underlying failure reported on several channels collapses to one record.
export type RuntimeEvent = { readonly trace: string } & (
  | { type: "append"; message: Message; replaces?: string }
  | { type: "delta"; messageId: string; changes: DeltaChange[] }
  | { type: "status"; running: boolean; inbox: InboxItem[]; streaming: string | null }
  | { type: "submission"; record: Submission }
  | { type: "snapshot"; value: ConversationSnapshot }   // watch fell behind: replace everything
  | { type: "error"; failure: { id: string; kind: ErrorKind; origin: Layer }; message: string; taskId?: string }
);

export type DeltaChange =
  | { kind: "text"; index: number; append: string }
  | { kind: "thinking"; index: number; append: string }
  | { kind: "toolcall"; index: number; callId: string; path: readonly (string | number)[]; append: string }
  | { kind: "block"; index: number; block: ContentBlock }   // the whole block
  | { kind: "message"; message: Message };                  // the whole message

export type SubmitInput = {
  readonly requestId: string;
  readonly text: string;
  readonly whenBusy: BusyMode;
  readonly trace: string;
};

export type Submission = {
  readonly id: string;
  readonly requestId: string;
  readonly status: "queued" | "placed" | "done" | "unanswered";
  readonly entryId?: string;        // pi.user entry, once placed
  readonly answerEntryId?: string;  // pi.assistant entry, once done
  readonly reason?: string;         // only unanswered
};

export interface RuntimePort {
  /** Opens, recovers (resume), and returns a handle. Idempotent per bot id. */
  open(spec: RuntimeBotSpec): Promise<RuntimeHandle>;
}

export interface RuntimeBotSpec {
  readonly id: string;
  readonly dir: string;
  readonly model: { readonly provider: string; readonly modelId: string };
  readonly trace: string;
}

export interface RuntimeHandle {
  /** Atomic: returns the committed view at attachment plus a sink for later commits.
   *  No commit is lost between the two, because the runtime acquires the snapshot
   *  and the event stream in one operation (pi `watchEvents`). */
  subscribe(trace: string, sink: (event: RuntimeEvent) => void): Promise<RuntimeSubscription>;
  /** Idempotent by requestId. Returns the submission's current record. */
  submit(input: SubmitInput): Promise<Submission>;
  /** Current record by submission id or requestId; used for duplicate replies. */
  submission(key: { submissionId: string } | { requestId: string }): Promise<Submission | undefined>;
  /** Older messages, oldest first. Byte budgets and paging stay in the wire layer. */
  history(input: { beforeEntryId?: string; limit: number }): Promise<{ messages: Message[]; hasMore: boolean }>;
  abort(trace: string): Promise<void>;
  /** Retries parked work for this bot and leaves a healthy bot untouched.
   *  It never aborts a running answer; `abort` does that. */
  recover(trace: string): Promise<void>;
  /** Live work, so the registry can decide whether closing is safe. */
  busy(): Promise<{ run: boolean; tasks: boolean }>;
  /** Resolves with `closed` or `timeout`. Never silently abandons the handle. */
  close(trace: string, deadlineMs: number): Promise<"closed" | "timeout">;
}

export interface RuntimeSubscription {
  readonly snapshot: ConversationSnapshot;
  detach(): void;
}
```

```swift
// apps/bots-macos/Sources/BotsCore/Ports/ConversationPort.swift
public enum ConnectionState: Equatable {
  case connecting, ready, reconnecting(attempt: Int), failed(reason: String), stopped
}

// `rev` is present on every bot-scoped case and absent on connection-scoped
// replies. BotsTransport owns close codes, envelope decoding and therefore gap
// detection: it drops out-of-order frames and emits `.snapshot` after a resync,
// so the reducer stays pure and never sees a gap.
public struct ConversationEvent {
  public let trace: String              // command trace, or the connection's
  public let rev: Int?                  // nil for connection-scoped replies
  public let body: Body

  public enum Body {
    case connection(ConnectionState)
    case snapshot(ConversationSnapshot)          // initial, resync, or a rerender
    case append(Message, replaces: String?)
    case delta(messageId: String, changes: [DeltaChange])
    case status(running: Bool, inbox: [InboxItem], streaming: String?)
    case submission(Submission)
    case history([Message], hasMore: Bool)
    case error(kind: ErrorKind, disposition: ErrorDisposition, message: String,
               failure: String?, requestId: String?)
  }
}

// Mirrors the wire field verbatim: only `.notAdmitted` clears an outbox entry, so
// the transport must not collapse it into an ErrorKind.
public enum ErrorDisposition: String { case notAdmitted = "not_admitted", unknown, runtime }

// Command context is created by the view model, so the call site and the daemon
// share one trace and one requestId.
public struct CommandContext { public let trace: String; public let requestId: String? }

public protocol ConversationPort: AnyObject {
  func open(botId: String) -> AsyncStream<ConversationEvent>
  func send(_ text: String, whenBusy: BusyMode, context: CommandContext) async throws
  func abort(context: CommandContext) async throws
  func recover(context: CommandContext) async throws
  func resync(context: CommandContext) async throws
  func loadHistory(before messageId: String, context: CommandContext) async throws
  func close()
}

public protocol CatalogPort: AnyObject {
  func load() async throws -> [BotSummary]
  func create(title: String) async throws -> BotSummary
  func rename(id: String, title: String) async throws -> BotSummary
  func delete(id: String) async throws
  func catalogEvents() -> AsyncStream<[BotSummary]>     // server pushes `bots`
}
```

Notes that the review forced:

- `subscribe` is one atomic operation; a separate `snapshot()` + `attach()` pair
  could drop a commit between them.
- `rev` is not in `RuntimePort`: the hub owns numbering, so a different runtime
  cannot change ordering semantics, and a different transport cannot change pi
  semantics.
- `close` returns an outcome. A timeout leaves the handle owned by the registry
  (see *Quarantine*), never dropped.
- `send` at the port level returns when the daemon has the submission record. The
  Swift `send` returns when the frame is written; durable admission arrives as a
  `.submission` event ([PROTOCOL.md](PROTOCOL.md#invariants)).

## Process model

One daemon process owns every bot under one root directory (default
`~/.local/share/eagle-bots`, `--root` to override).

```
botd (single process, launchd-supervised)
├─ <root>/token                     0600 bearer token, generated on first start
├─ <root>/catalog.json              bot list + sidebar groups, atomic write (tmp + rename)
├─ <root>/logs/daemon-YYYYMMDD.jsonl
├─ <root>/trash/<botId>/            deleted bots, deterministic name, never auto-removed
└─ <root>/bots/<botId>/
     ├─ bot.json                    { id, title, createdAt, model, thinkingLevel, instructions }
     ├─ session.sqlite              pi-durable storage, 0700
     └─ …
```

### Singleton lock

Any file-based stale-lock recovery has an unlink race, so the singleton is a
**kernel-exclusive listener**: the daemon binds a second loopback port derived from
the canonical root path, and the kernel releases it when the process dies, including
on `SIGKILL`.

```
lock port = 44000 + (fnv1a(realpath(root)) % 1000)   // no override: the root alone decides
```

The port range sits above the default service port (43117) and has no per-process
override, because an override would let two processes with the same root take
different lock ports and both open the same sqlite files. Changing `--port` does not
change the lock port.

1. `listen(127.0.0.1:<lock port>)`. Success means this process owns the root.
2. `EADDRINUSE` → connect and exchange one line. A daemon answering with the same
   root means a live owner: print its pid and exit non-zero. An answer with a
   different root means a hash collision between two roots; exit with an explicit
   message naming both roots and the derived port (there is no override to reach
   for, so the fix is a different root path).
3. No answer (`ECONNREFUSED`) means nothing is listening even though the port is
   held — a state the kernel does not allow for a live listener — so retry once and
   then fail with the error. There is no file to delete and no takeover.

The unix socket is gone: the client transport is the TCP listener from
[PROTOCOL.md](PROTOCOL.md). Tests: a live daemon rejects a second start with the same
root *and different `--port`*; a `SIGKILL`ed daemon is taken over on the next start;
two different roots that hash to the same lock port fail with the documented
message.

### Bot lifecycle

```
catalogued ──open──▶ opening ──ok──▶ idle ⇄ running ──idle close──▶ closing ──▶ catalogued
    ▲                    │             │                                   │
    │                    └──fail──▶ unavailable ──recover──▶ opening       │
    │                          ▲                                         │
    └── deleted ◀── trash ◀─────┴──────────── quarantined ◀── close timeout
```

- **catalogued**: in `catalog.json`, no Harness, no memory cost.
- **opening**: one in-flight `Harness.open` promise; concurrent callers share it.
  `open` also performs recovery (`harness.resume()`), so a run interrupted by a
  crash continues without a separate recovery call in the port.
- **idle / running**: Harness open, subscription attached.
- **unavailable**: open failed. The client gets a snapshot with `unavailable` and
  can send `recover`; the state is re-entered on the next open attempt.
- **closing**: idle-evicting, deleting or shutting down.
- **quarantined**: `close()` timed out. The handle stays owned, `open` and
  `delete` are refused for that bot, and a background retry repeats `close`
  every 30 s. The bot leaves quarantine only when `close` resolves `closed`.
- **deleted**: directory moved to `trash/<botId>`, entry removed from the catalog.

Rules:

1. `create` never opens a Harness: write `bot.json` + the catalog entry, reply,
   then warm asynchronously. Creation stays under 50 ms
   ([PRODUCT.md](PRODUCT.md#speed-targets)).
2. Opening is serialized per bot; two subscribers never create two Harnesses for
   one sqlite file.
3. Idle close requires `busy() === {run:false, tasks:false}` and no subscribers.
   Phase 1 disables compaction precisely so `tasks` is always false
   ([RUNTIME.md](RUNTIME.md#settings-per-bot)); the condition already reads it, so
   enabling compaction later does not need a redesign.
4. Delete is two idempotent steps with a deterministic destination:
   `rename(bots/<id>, trash/<id>)`, then update `catalog.json`. Startup
   reconciliation finishes any interrupted delete: a catalog entry with no bot
   directory but a `trash/<id>` is removed from the catalog; a `trash/<id>`
   without a catalog entry stays as is. A failure in either step is retryable and
   never leaves a catalog entry pointing at nothing after the next start.
5. Recovery scan at startup: for each catalogued bot, open + resume; keep active
   ones open, queue the rest for idle close. A failing bot is reported and
   skipped; the scan never aborts the daemon.
6. Shutdown: stop accepting work, drain the admissions already in flight,
   `close` every handle with a shared deadline. Handles that time out are
   logged as quarantined; process exit releases the socket lock and the OS
   closes their files. A timeout is never logged as success.
7. Delete order is part of the contract: mark the bot deleting (no new lease, no
   new open), drain the leases already granted with the close deadline, then take
   the lifecycle window, close, and move. The window cannot be taken first,
   because an `open()` in flight waits for it and the drain would wait for that
   open.
8. An idle-close decision that spans `await busy()` is abandoned when any lease was
   taken meanwhile: the port's answer may predate a run that has just started. The
   registry tracks that with a per-bot activity generation, not with a second
   subscriber counter.

### Lifecycle windows

Close, delete and shutdown each own the bot for their whole duration: an `open` that
arrives during one waits for it (the registry's per-bot `settling` promise), then
decides again — a reopened bot gets the handle the close created and released, and a
deleted bot resolves to `unknown_bot`. The service never assumes a cached handle is
alive: it asks the registry, and only reuses a view whose handle the registry still
owns. A path that cannot wait (a warm-up open that a delete meets) is what the windows
are for: the delete waits for the open, closes the handle it created, and only then
moves the directory.

### Concurrency

| Concern | Rule |
| --- | --- |
| One bot, two runs | Impossible: pi queues the second input in `inbox` |
| Many bots | Parallel; each has its own Harness, storage and settings |
| Connection ↔ bot | One bot per connection for the connection's whole life. Switching bots means a new connection; `unsubscribe` does not exist |
| Subscribers per bot | Many; `EventHub` fans out and owns `rev` and coalescing on a per-bot serial queue |
| Shared mutable state | Only the catalog and the log; everything else is per bot |
| Snapshot rerender | When the runtime sends `snapshot` (watch fell behind) the hub renders a fresh wire snapshot to every subscriber at the next `rev` |

`EventHub` requires an injected `measure` function, so the frame encoder owns the
byte count and `core/` keeps no wire knowledge. A delta is numbered only when its
batch is broadcast, so folding never leaves a revision gap, and a batch is split
between whole changes. While a subscriber is snapshot-only, the newest snapshot is
held as its recovery anchor; once an increment is lost after it the anchor is stale
and is never delivered, so the subscriber waits for a current snapshot instead of
silently rendering an outdated state.

`ConversationService` folds those events into the bot's current view, so a new
connection starts from what the bot is now, not from what it was when the bot
opened. The fold keeps the newest page only and remembers `truncatedBefore`, so a
rendered snapshot stays inside the documented page budget however long the
conversation runs; everything older stays reachable through `history`. It reserves the connection before opening, flushes the coalescing window
and captures the baseline's own revision inside the same serial section, and only
then goes live, so a first frame is always the snapshot whose `rev` the reply names.

## Failure containment

| Failure | Layer | Containment |
| --- | --- | --- |
| Auth/token mismatch | L3 transport | HTTP 401 before upgrade; no bot opened |
| Malformed command | L3 protocol | Command rejected, connection kept |
| Unknown bot id | L2 core | Close `4004`, no runtime call |
| Model/provider error | L0 → L1 | Submission settles `unanswered{reason:"model_error"}`; bot usable |
| Provider error echoing user text | L1 | `err.kind` only; provider text never logged, message redacted to a fixed notice |
| Storage error (`SessionFailed`) | L0 | Harness closes itself; L1 classifies `storage_failed`, L2 marks `unavailable` and drops the handle, so `recover` opens a new Harness |
| Parked task (`onReport`) | L0 → L1 | `error{kind:"task_parked"}`; `recover` clears it |
| Watch ended (`listener_error`) | L0 → L1 | Reattach with a fresh snapshot; no client-visible error on the first, three within 60 s mint one `internal` failure and mark the bot `unavailable` while keeping the Harness it owns. `recover` re-attaches that harness's watch; only a dead session may open a second one |
| Watch ended (`session_failed`) | L0 → L1 | Immediate `storage_failed` failure, same identity as `harness.closed{failed}`; no reattach counting |
| Whole process crash | — | Next start resumes; `SIGKILL` recovery is a mandatory test |
| `close()` timeout | L2 | Bot quarantined; open/delete refused until closed |
| Client disconnect | L4 | Daemon keeps working; reconnect starts from a snapshot |

A layer that cannot classify a failure rethrows it unchanged, so the log shows
the innermost layer rather than a generic wrapper.

## Dependency and version policy

- `@earendil-works/pi-durable` pinned exactly (`1.4.0`); experimental upstream.
- Upgrade = bump the pin, run `npm run test:runtime` (golden mapping), read the
  changed upstream sections (§2.1 context, §5.6 wakeups, §8.2 live, §9.3–9.4
  views/events), update the fact table in [RUNTIME.md](RUNTIME.md), one commit.
- Node ≥ 24 for the daemon (pi-durable needs ≥ 22.19). Verified on Node 26.12.0.
- Runtime TypeScript is erasable only: `type`, `interface`, `satisfies`. No
  `enum`, `namespace`, parameter properties or decorators, because the daemon runs
  through Node's type stripper. `tsc --noEmit` is a type gate, not a build.
- Swift: `ObservableObject` and the `LocalState` shim (no SwiftUI macros), because
  Command Line Tools must build the app; tests and the coverage gate need the
  Xcode toolchain, as in `apps/macos/Scripts`.


## P0 local handoff boundary

`server/http` authenticates and bounds the four additive `replica` endpoints;
`BotRegistry.replica` holds the ordinary Bot lease and delegates through
`RuntimeHandle.replica`. `runtime/pi/HistoryReplica` uses only public SDK APIs:
fork-aware entry/task reads and atomic Harness transactions. It preserves the original
bundle and local entry map in session-scoped SDK documents, creating ownerless passive
conversations. Original task IDs are provenance, never local scheduler ownership.
Explicit continuation has a durable head/text/request binding and a fresh local fork.
The SDK's existing admission/scheduling/recovery executes that new input.

This is the P0 cross-SQLite validation slice. Separate replica logs/outbox and causal
incremental transport remain P1; resource installation is P2. Task-scoped nested results
are not archived by P0, so a complete export rejects nested calls in the selected
conversation or any fork ancestor. No foreign task, ProviderDoc, queue or active database
is copied, and no SharedDevicePort dependency or general synchronization engine is added.


## P1 local incremental boundary

`ReplicaSync` joins the runtime's existing submission/history calls to a separate per-Bot
`ReplicaStore` (`replica.sqlite`). The SDK owns session.sqlite; its public commit listener
only queues an asynchronous, ascending entry-ID scan. Source facts/cursors, local intent+
outbox and incoming deduplication are replica transactions. There is no transaction spanning
both databases. Fixed SDK request IDs and passive import receipts repair the intervening
crash windows; only local intents recover execution. Imported provider/task documents are
never created, and imported entry provenance is forwarded without a new local origin.

Native heads pin bounded public SDK forks; automatic SDK receipts hold only manifest
references/ID maps. Incoming matching complete prefixes fork and append only their suffix,
while initial unrelated history materializes once. Agent config is explicitly restored at
both pin and run, including configure commits after the tail; ProviderDoc/inbox stay initial.
Head manifests reference durable facts; dependencies gate passive SDK materialization and
peer-applied positions. Incoming protocol-invalid sources remain retained/blocked separately
from other runnable heads. This is a local incremental API, with complete local assembly
cost, not a cloud baseline/cache or a generic transport. P2 installation, P3 device binding,
P4 transport/cache, P5 UI/merge and P1 epoch/tombstone follow-ups retain their planned scope.

Passive recovery composes bind/import/apply/run in a newly created local runtime. The only
new surface is a full-carrier summary inventory: HistoryReplica receives public Storage
scanDocuments/document from PiDurableRuntime's existing owner. Entry-map validation stays
on Harness.commit/Tx.scanEntries so it observes conversation visibility and the Session's
serial/failure guard. Metadata cursors remain request-local; HTTP after uses DocumentId.
No database/queue/provider session is copied, no new epoch setter is introduced, and legacy
carriers without source events are exported explicitly rather than reissued as local facts.


## P1 directory tombstones

Root catalog.json owns an append-only deduplicated tombstone set of {sharedBotId}.
Local cleanup mappings stay beside it, never on the wire. All catalog/group mutations
preserve both. After the ordinary lease drain/close succeeds, deletion reads the actual
replica binding through RuntimePort.readReplicaBinding without opening an SDK runtime.
It atomically saves the tombstone/cleanup mapping before moving the directory to trash.
Mark failure cannot move data; a saved mark fences all aliases even when cleanup fails.
Startup reconciles pending cleanup before opening/resuming any runtime. Existing rename
atomicity is process-crash protection, not an explicit fsync/power-loss guarantee.
Root tombstone pull/apply is independent of a deleted local Bot ID. Bind and deletion
are ordered at the registry boundary; incoming deletion closes the entry door before
waiting for existing leases/close, retaining the existing timeout/quarantine rules.
An existing WebSocket holds its lease until it closes; apply can therefore time out
honestly with a saved tombstone and an unmoved active database. A later successful
quarantine close does not remove that tombstone. Socket recover acquires the same owner
lease inside its serialized callback, before reopening or retrying any work, and releases
it in finally. Cached subscriptions cannot revive a deleted Bot.
Reconciliation isolates individual pending directory-move failures, keeps their cleanup
mappings hidden from runtime startup and reports only successful deletes as finished.
Newly discovered bound aliases follow that same path. Root catalog read/validation/write
failures still stop startup; they are not classified as individual cleanup failures.
After the requested local delete succeeds, alias cleanup is limited to that target's
actual shared binding read after close. An unrelated tombstoned/quarantined owner must
not change this delete's result or catalog broadcast. An unbound legacy target has no
shared aliases to clean. Same-identity aliases still retain the ordinary close/failure
and trash-preservation rules.


## Fixed-head resources (P2 first local slice)

History resources remain immutable replica facts. The runtime alone installs complete
selected manifests into per-Bot content-addressed version directories and pins a version
reference with the public SDK conversation-document API. The extension's ordered section
uses committed branch reads; installation/readiness validation happens before run admission
and before any startup pending-submit/global scheduler resume. It does not install code
extensions from packages, change local cwd/credentials/permissions or add network services.
Ordinary chat resource selection/local edits and fresh first-package loading are delivered
as recorded in PLAN; they reuse these immutable resources and per-input pins.


## P3 device synchronization port

Core owns DeviceSyncPort version1 and metadata domain types. A daemon-owned adapter
uses the private DeviceChannel JSONL transport and its own strict codec, importing no
Eagle source/contracts. Composition injects the optional port into BotRegistry; its
metadata HTTP operation reads the actual local binding without starting the SDK and
uses existing deletion guards. RuntimeHandle, pi-durable and execution journals do not
participate. Device service/Registry own authenticated membership/grant decisions;
private helper management owns grant and candidate publication writes. No synchronization
request uses the device directory's offline-local presentation fallback.

Sync access snapshots the real binding under the existing directory serialization, releases
that serialization during the private-service request, then rechecks binding and deletion
under it before returning. It never leases/opens a Harness or blocks ordinary local input.


## P4 durable object ownership

Bots owns its version1 key codec,immutable SyncObjectStore and authenticated object delivery
composition. DeviceSyncPort carries only typed key metadata across the existing private socket;
Swift helper/vault alone retains wrapping private keys. Bots imports no Eagle contracts or
Worker/Agent source. A global owned `sync-objects/v1/<objectId>.json` contains the complete cipher,
signed manifest,descriptor,envelope and fixed accepted identity pin; the record also binds all
four actual local replica identity fields. Recipient slots are append-only under that object.
No plaintext DEK enters replica DB,Registry or logs, and ciphertext does not enter the vault.

ReadyReplica.publish is an internal synchronous first-winner admission seam, not a public
transaction API. Staging and full winner verification remain outside the short lease; actual
exclusive link is fenced against directory/binding/handle/tombstone and lifetime changes.
Local stored apply uses the existing runtime command actual-use guard and passive receive;
network readiness cannot invalidate that offline capability. Ordinary open/recover and SDK
scheduling retain their existing contract. No cache,transport retry or new execution queue exists.

## Online-holder relay ownership

Bots owns its own finite relay schemas/SyncRelay adapter and automatic ready-only
composition. The independent Bots Sync Worker owns bounded in-memory encrypted
forwarding plus holder/delivery/receipt metadata in the existing per-sharedBot DO.
Its only Registry dependency is the named metadata-authority RPC, never source
imports from Eagle. Swift/helper carries typed identity/auth/proof metadata only.
No plaintext baseline/body or private key enters DO metadata, and relay never
writes R2 or renews the72h event clock.

Relay transport generation and one-use challenges are independent of direct Self
readiness. Both share original closed/full-binding/tombstone/time/current-grant
and actual publish/receive admission fences. The automatic cloud candidate tries
relay only for a truthful cache gap or absent baseline; it remains one inbound
candidate beside at most one complete direct probe, with independent upload.
Source coverage is an authorized hint; pages retain original source events and
resource pins. Existing local full-source drain handles cross-source dependencies.

One pendingApply objectId and one associated pendingReceipt per preference suffice
for cold local retry and lost ACK recovery. Local apply precedes network work;
current-authorized explicit delivery-unavailable can release only ACK waiting.
No generic queue, scheduler, crypto session, drain API or new reverse grant.
This slice reports only relay-associated receipts; all-path status follows before P5.

## All-path persistent status ownership

The additive status-report/status-read path uses existing metadata authority and
named Registry RPC. The current receiver rebuilds bounded source progress from
the same ReadyReplica durable status; the holder independently reads exact-key
snapshots under the original holder→receiver grant. Worker persists metadata only,
keyed by registry/sharedBot/full identities/receiver binding/original source; it
does not touch bodies, R2 or retention. Receiver reports are authenticated statements,
not Worker-verifiable direct receipts or remote execution proof.

AutomaticSync owns a single independent metadata action beside inbound and upload.
Original configuration/ready/attempt guards apply after authority waits and at send;
close cancels it, while direct Self loss does not disable legitimate cloud status.
No persistent ACK queue or core/drain API is introduced: restart reports the actual
DB again without another get/apply. Local offline apply keeps its fixed-pin path.
Sender connection status preserves full timestamped snapshots and keeps the
receiver's current binding unknown. See SYNC-STATUS for the exact bounded schema.
