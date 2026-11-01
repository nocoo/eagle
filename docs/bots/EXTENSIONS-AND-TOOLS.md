# Bot extensions and tools

Status: **development guide and proposed tool roadmap**, 2026-10-28.
The native baseline includes consolidation (`cd8971c`) and Registry refresh
(`e5f2200`); the inventory also includes the current first-party search providers.
The SDK remains `@earendil-works/pi-durable@1.4.0`. Every item marked **planned** is a design for
review, not an installed tool, enabled capability or passing test.

[PLAN.md](PLAN.md) owns delivery status; this guide owns tool taxonomy, naming
and extension-development rules. [RUNTIME.md](RUNTIME.md) owns runtime semantics,
[PROTOCOL.md](PROTOCOL.md) the client wire contract, and
[TESTING.md](TESTING.md) the gates. Older phase snapshots are historical, not the
current tool inventory.

## 1. Product boundary and vocabulary

Extensions are first-party modules inside the local Bots daemon. They are not a
third-party plugin platform: no marketplace, plugin manifest, module scanning,
dynamic source imports or second extension manager. The product does not provide
an execution sandbox. Normal validation, bounded output, cancellation, credential
hygiene and correct resource targeting still apply.

| Concept | Responsibility | Not the same as |
| --- | --- | --- |
| Bot | A catalog identity with its own directory, Harness and root conversation | A tool, extension, child conversation or terminal agent |
| Harness | pi-durable execution, persistence, scheduling and recovery for one Bot | Eagle's application core or a host process per Bot |
| Extension | Native `Extension`: a named bundle of `tools`, `sections`, `hooks`, `wraps`, and optionally `tasks` | A user-facing group or a serialized executable |
| Tool | Native `defineTool`: one model-callable operation, input schema, handler and execution policy | A prompt instruction or UI action |
| Registry | Native in-memory registrations, resolved through immutable snapshots | Conversation history or the selected tool list |
| Tool group | Product setting selecting one or more registered extensions | A security permission or protocol capability flag |
| Agent configuration | Per-conversation `pi.agent` choices: model, extension/tool names, instructions and `cwd` | Another agent implementation |
| Prompt section | Short instructions explaining when and how to use selected tools | An enforcement mechanism |
| Protocol capability | A feature the daemon and client can represent/render | Whether a particular model tool is enabled |

Three uses of "core" must remain separate. `src/core/` is the SDK-independent
application layer. The `core` tool group maps to the first-party `bots-tools`
extension. Neither replaces pi-durable's Harness. Native `CodingTools` replaces
our redundant file/shell implementations, not BotRegistry, ConversationService,
the runtime adapter or the whole application core.

## 2. Native assembly and invocation

```text
daemon settings -> normalized tool groups -> each Bot's stored selection
                                                 |
PiDurableRuntime.open -> one Registry + Harness per Bot
    Registry.install(first-party extensions + native CodingTools)
    selectToolExtensions(current Registry snapshot, selected groups)
    root.configure({ extensions }) before resume
                                                 |
model request -> native enabled/offered tool selection -> tool task
    validate arguments -> execute(args, api, context) -> native result
                                                 |
pi events -> runtime mapping -> Bots protocol -> generic macOS tool rows
```

The implementation entry points are
[registry.ts](../../apps/bots/src/tools/registry.ts) and
[PiDurableRuntime.ts](../../apps/bots/src/runtime/pi/PiDurableRuntime.ts).
The daemon shares its Models catalog, but creates each Bot's Registry separately
because extensions can capture Bot-specific services and directories.

- Install extension objects directly. `root.configure` accepts those native
  objects; the SDK stores their names in `pi.agent`, not JavaScript handlers.
- Use `defineTool`, the installed pi-ai `Type` schemas and the native execution
  API. Do not translate through an application-wide tool schema or executor.
- The existing `ToolOutcome` helper in Herdr/agents is a local text-result helper,
  not a mandatory intermediate format. New tools may return native results directly.
- `NodeExecutionEnv` supplies file/process operations from the conversation's
  `cwd`. The default is `<bot dir>/workspace`, not a filesystem confinement root.
- The only coding customization is the native `createBashTool({ prepare })`
  wrapper in `bots-tools`. It prevents ambient daemon-secret inheritance while
  retaining the SDK's command execution, timeout, cancellation and diagnostics.
  It does not register another `bash` name or fork the runner.
- Client projection is a necessary product boundary, not another extension
  system. The current tool-result wire/UI shape renders text and diagnostics;
  native image input to the model does not imply image-result rendering in Swift.

## 3. Implemented inventory

### Groups

| Group | Native extension names | Selection | Initial model visibility |
| --- | --- | --- | --- |
| `core` | `bots-tools` | Mandatory | `list`, `note_set` |
| `coding` | `coding-tools` (`CodingTools`) | Mandatory | `read`, `write`, `edit`, `bash` |
| `agents` | `bots-agents` | Optional | All three child-agent tools when selected |
| `herdr` | `bots-herdr`, `tool-search` | Optional | `tool_search`; the eight Herdr tools are deferred |
| `search` | `bots-search`, `tool-search` | Optional, **off by default** | `tool_search` is offered; `web_search` and `web_fetch` are deferred |
| `trigger` | `bots-trigger`, `tool-search` | Optional, **on by default** | `tool_search` is offered; the five `trigger_*` tools are deferred |

Current defaults select `core`, `coding`, `herdr`, `agents` and `trigger`; `search` stays
off until a person turns it on. `trigger` is on by default because a Bot that cannot
create its own schedule or webhook cannot answer "every morning, check this". Settings are daemon-wide and applied to
existing/new Bots, not independently editable group policies for each sidebar
Bot. `core` and `coding` are normalized back in even for an empty selection;
their settings switches stay on and cannot be disabled. Herdr registrations
require an injected CLI client, which the normal daemon runtime supplies. The
search registrations use the daemon's provider-independent routing client.

The `trigger` registrations exist only when the daemon supplies the per-bot
storage host, so a build without trigger storage offers no trigger tools and no
loader for them. Definitions, the scheduler, the webhook endpoint and the sidebar
surface are implemented (TRIGGERS.md §12); the per-trigger hourly cap is not.

A group whose own extension is not installed contributes nothing, not even its
loader. The normal daemon installs search even before configuration: its tools
can explain a missing selection without making an external request. A test/host
that supplies no search client installs no search extension or loader for it.

There are **20 tool names** with all current groups registered: five filesystem/
coding tools, three child-agent tools, eight Herdr tools, two search tools and one
SDK loader. With the default selection (no `search`) ten are initially offered and
eight are deferred; selecting `search` defers two more tools and reuses the same
`tool_search` loader.

### Filesystem and coding

Signatures below summarize the installed schemas; `?` means optional. The SDK's
types/source remain authoritative for native argument details and output limits.

| Group / tool | Input | Behavior | Replay |
| --- | --- | --- | --- |
| `core` / `note_set` | `text` | The Bot's own line for the sidebar, replacing the answer's first sentence the daemon would otherwise derive for this run; trimmed, whitespace collapsed, at most 120 characters; an empty string clears it for this run. Idempotent by value | Safe |
| `core` / `list` | `path?, limit?` | Recursive, directory-relative paths; default 2,000 entries, at most 50 KiB; sorted per directory; does not traverse symlinks or common generated/dependency directories | Safe |
| `coding` / `read` | `path, offset?, limit?` | Native text paging, diagnostics and supported image input; offset is one-based | SDK default unsafe |
| `coding` / `write` | `path, content` | Native whole-file UTF-8 creation/replacement, including parent directories | SDK default unsafe |
| `coding` / `edit` | `path, edits: [{oldText, newText}]` | Native unique, non-overlapping exact replacements against the original file; serialized with writes to the same file | SDK default unsafe |
| `coding` / `bash` | `command, timeout?` | Native shell, streamed stdout/stderr, abort and spill diagnostics; timeout is seconds, with no default timeout | SDK default unsafe |

Do not restore `read_file`, `write_file`, `run_command` or `list_files` aliases.
Do not add custom paging, edit matching or process execution already provided by
`CodingTools`. Only genuinely missing operations belong in `core`.

### Search

| Group / tool | Input | Behavior | Replay |
| --- | --- | --- | --- |
| `search` / `web_search` | `query, count?, needContent?` | Ranked title, URL, snippet and summary; content on request, through the user's selected search provider | Unsafe |
| `search` / `web_fetch` | `url` | One page as Markdown through the same provider, at most 50 KiB of model-facing text | Safe |

Both are deferred. Settings -> Services -> Search stores independent DeepSeek and
Tavily keys and explicitly selects one provider (`GET /v1/providers`, PROTOCOL.md
"Providers"). Tool schemas and output formatting never depend on that selection;
there is no provider argument or provider-specific tool name. The route resolves
at invocation, not Harness open, and has no automatic fallback. With no selection,
the tools return a configuration error without an external request.

The Tavily adapter uses [Search](https://docs.tavily.com/documentation/api-reference/endpoint/search)
and [Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract).
`count` stays an upper bound of 1-50; Tavily returns at most its native 20 results.
`needContent` maps to `include_raw_content`; fetch extracts exactly one URL.
Native basic search/extraction is explicit, with no automatic paid depth upgrade.
Timeouts and cancellation reach both providers; raw provider fields are normalized
inside their adapters, never by the Bot or its UI.
Each performed call books one `search` call in the usage statistics, so the Settings page
shows search next to model spend.

### Child conversations and terminal agents

| Group / tool | Input | Behavior | Replay |
| --- | --- | --- | --- |
| `agents` / `agent_spawn` | `name, instructions?` | Creates an ownerless conversation in this Harness, copies the parent's model/effort/tools/cwd, removes delegation tools, records a `bots.agent` marker, returns `c_<id>` | Default unsafe |
| `agents` / `agent_send` | `agentId, message` | Submits with `followUp`, waits for settlement, returns final text or the unanswered reason | Default unsafe |
| `agents` / `agent_stop` | `agentId` | Aborts work; conversation remains readable | Default unsafe |
| `herdr` / `herdr_open_space` | `path?` | Creates or reuses this Bot's recorded Space | Safe |
| `herdr` / `herdr_start_controller` | `kind, name?, args?` | Starts one controller in the recorded root pane with native CLI arguments | Default unsafe |
| `herdr` / `herdr_list` | none | Lists agents and panes in the recorded Space | Safe |
| `herdr` / `herdr_send` | `target?, text, wait?, timeoutMs?` | Sends to a target in that Space; defaults to the controller and waiting for settlement | Default unsafe |
| `herdr` / `herdr_wait` | `target?, until?, timeoutMs?` | Waits for requested/settled states; does not certify work completion | Safe |
| `herdr` / `herdr_read` | `target?, lines?, source?` | Reads bounded terminal text, retaining the newest content | Safe |
| `herdr` / `herdr_keys` | `target?, keys` | Sends logical keys to a target in that Space | Default unsafe |
| `herdr` / `herdr_close_space` | none | Closes the recorded Space and clears its active record | Default unsafe |
| SDK loader / `tool_search` | `query, limit?` | Searches enabled deferred tool metadata and offers matches on the next model request | Safe |

`agent_*` is same-Harness delegation, `herdr_*` controls terminal collaborators,
and planned `peer_*` addresses independent catalog Bots. These identities and
lifecycles are not interchangeable. `herdr_send` is not a screen read;
`herdr_wait` is not a verdict that a task succeeded.

Current child-target validation only parses an ID and looks up the conversation
in this Harness. `agent_send`/`agent_stop` do not yet verify that its `bots.agent`
marker names the caller as parent. The send request ID also includes `api.now()`;
do not describe it as proven replay deduplication. The one-level configuration
and happy-path test are not evidence for stronger targeting/recovery guarantees.

### Existing test evidence

These are committed tests, not claims that every upstream SDK branch is covered.
Paths in this table are relative to `apps/bots/`.

| Area | Tests | What they establish / remaining gap |
| --- | --- | --- |
| Native reuse and names | `test/tools/registry.test.ts` | Original `CodingTools` object; exact five mandatory tools; no legacy aliases; group selection, deferred loader, Registry replacement/removal |
| `list` and working directories | `test/tools/list.test.ts`, `test/tools/workspace.test.ts` | Ordering, absolute paths, traversal exclusions, empty/error/cancel paths, byte/count truncation; retained Herdr-specific path checks |
| Native execution | `test/runtime/tools.test.ts` | Real file effects; edit ambiguity leaves file unchanged; absolute read outside cwd; paging; bash timeout, abort, split UTF-8, both streams, exit/spill diagnostics, secret-inheritance prevention and reopen configuration |
| Herdr tools | `test/tools/herdr.test.ts` | All eight operations with a fake client; resource targeting, state loss, replacement/refusal, failed rollback and cancellation |
| Herdr CLI adapter | `test/tools/herdr-client.test.ts` | Executable fixture responses, argv/result handling, deadlines, cancellation, large/split output; not acceptance of every installed live agent kind |
| Child agents | `test/tools/agents.test.ts` | Real Harness/SQLite spawn -> send -> answer with a deterministic model; dedicated stop, invalid-target, interrupted-send and one-level negative tests are still needed |
| Search | `test/tools/search.test.ts`, `test/runtime/search-tools.test.ts`, `test/server/providers.test.ts`, `test/main.test.ts` | Documented request/response shape, refused key, deferred flags, one booked call per search, blank query refused; provider store is 0600, write-only and never returned; HTTP round trip behind the bearer |
| Deferred discovery | `test/runtime/deferred-tools.test.ts` | Model calls `tool_search`, then the discovered `herdr_list`; persistence across compaction is an SDK-source fact, not a separate regression established here |
| Hot refresh | `test/runtime/tool-groups.test.ts`, `test/core/registry.test.ts`, `test/core/service.test.ts` | Warm enable/disable, cached switching, no interrupted answer, same-value retry, failed refresh and single failure identity |
| Wire round trip | `test/e2e/tools.test.ts` | Real socket tool rows and later snapshot, encoded-size clamp, A -> B -> A refresh without extra model calls/watches, `1011` reconnect recovery |

Historical full-gate evidence is recorded in [PLAN.md](PLAN.md) and
[../CHECKPOINTS.md](../CHECKPOINTS.md): after Registry refresh, 482 daemon tests,
95.10% lines / 87.96% branches / 90.81% functions; `list` and retained workspace
helpers have 100% in those three measured metrics. This is not 95% in all four
L1 metrics, not full coverage of all tools, and not a fresh run for this
documentation-only change. Planned tools have no implementation/test evidence.

### Coding reports: the pull requests a bot opened

The coding group also carries two eager tools, because a PR is what a coding bot produces:

| Tool | Input | Result | Replay |
| --- | --- | --- | --- |
| `pr_register` | `url, title, status` | Stores one entry per link and returns it; any `http(s)` forge is accepted | Safe (keyed by the durable tool-task id) |
| `pr_list` | — | The bot's own reports, newest first | Safe |

`status` is the closed set `draft`, `open`, `reviewing`, `merged`, `closed`, `failed`; the App
draws each one with its own glyph and colour, so a state the daemon does not know is refused
rather than guessed. The daemon **stores and never queries**: a forge's state reaches the App
only when the bot reports it again, which the prompt says explicitly. One journal per bot
(`pulls.journal.jsonl`), the last record per URL wins, and the newest 20 rows are kept.

## 4. Discovery and refresh are different operations

1. **Register:** host code installs an extension in this Harness's Registry.
2. **Select:** the Bot's groups select extensions; their tools become enabled.
3. **Offer:** non-deferred tools enter the model request. Deferred tools remain
   enabled but are initially omitted from the model's offered schema list.
4. **Discover:** native `tool_search` ranks enabled deferred metadata with BM25;
   its `control.addTools` updates `modelTools`. It neither installs code nor
   searches the internet. Other tools may invoke enabled deferred tools through
   the SDK without this model-discovery step.
5. **Refresh:** every client subscription, including cached A -> B -> A,
   reselects extensions from the live Registry snapshot before the baseline.

Loaded deferred names remain offered on the branch, including after compaction.
`modelTools` cannot widen the enabled set: a loaded name does not keep a disabled
extension callable. Existing child conversations retain their stored choices;
parent group changes are not a permission-revocation system.

Registry publication is native `install`/`uninstall`, not source hot loading.
The host can replace an installed object; no production filesystem watcher or
external plugin install API exists. A source-code change still requires deploying/
restarting the daemon. Refresh does not open a new Harness, replace the runtime
watch, send a model request or interrupt a running answer. It adds no UI spinner
or protocol command. A failed refresh refuses the baseline, closes `1011` and
uses the existing reconnect path; errors retain their single origin identity.

## 5. Naming and extension rules

- Keep native names exactly: `read`, `write`, `edit`, `bash`. `list` follows that
  simple vocabulary for missing filesystem functionality.
- First-party domain tools use singular `domain_verb`: `memory_read`,
  `web_fetch`, `agent_list`, `peer_send`. Groups are product categories; they need
  not be identical to prefixes (`search` groups the `web_*` tools).
- An extension uses `bots-<group>`; existing `bots-tools` is the core name.
  Preserve native `coding-tools` and `tool-search`. No duplicate tool names
  across our extensions, even though the SDK permits name-based composition.
- One operation has one name. Use arguments for scope/target, not duplicate
  `shared_memory_*` and `private_memory_*` families. Do not add synonymous
  `find`/`discover`/`list` tools for the same catalog query.
- Browse metadata with `list`, retrieve a known record with `read`, replace its
  whole content with `write`, retrieve a URL with `fetch`, rank content matches
  with `search`. A list operation must not start work.
- Tool names and parameter keys are English `snake_case` and `camelCase`
  respectively. Include units in new duration arguments (`timeoutMs`); native
  exceptions such as `bash.timeout` keep upstream semantics.
- Replay is a recovery policy, not a synonym for read-only or deterministic.
  The default is unsafe. Mark safe only when an interrupted retry is acceptable
  and tested; even a read can observe changed content after recovery.

## 6. Planned optional groups

All tools in this section are **planned**. `memory`, `peers` and `trigger` are new optional
groups; none enters the mandatory pair. (`search` has since shipped, see the inventory above.)
Introduce them unselected by default. Do not accidentally enable them for everyone by extending
the current `DEFAULT_TOOL_GROUPS = [...TOOL_GROUP_NAMES]` expression.

| Group | Extension | Planned tool names | Offering policy |
| --- | --- | --- | --- |
| `memory` | `bots-memory` | `memory_list`, `memory_search`, `memory_read`, `memory_write`, `memory_delete` | Deferred |
| `trigger` | `bots-trigger` | `trigger_create`, `trigger_list`, `trigger_update`, `trigger_enable`, `trigger_delete` | Deferred; shipped and on by default |
| `peers` | `bots-peers` | `peer_list`, `peer_send`, `peer_read` | Deferred; shipped behind a toggle |
| Existing `agents` | `bots-agents` | Add `agent_list`; retain the existing three names/semantics | Eager when selected |

Each deferred group selects the same native `tool-search` extension. Install it
once per Registry, select it once when any selected group needs it, and remove
it from selection only when none does. Do not tie future discovery exclusively
to `herdr`, create a loader per group, or duplicate BM25/`modelTools` logic.
Each selected extension needs a short prompt section naming its use and how to
discover it. Discovery metadata must contain enough domain vocabulary to match.

### 6.1 Memory: shared knowledge and Bot-private knowledge

"Shared" means shared by Bots in this local daemon, not public on the internet.
"Private" means the current Bot's namespace, not a sandbox or encryption claim.
Child conversations use their owning Bot's namespace. Memory tools never take
an arbitrary other `botId` to select private storage. Native coding tools retain
normal host access; private namespaces do not prevent host filesystem access.

Memory is explicit persistent knowledge, not a copy of the transcript, an outbox,
a system-prompt replacement or pi-durable's internal task checkpoints.

| Tool | Planned input | Result and single responsibility | Replay |
| --- | --- | --- | --- |
| `memory_list` | `scope, cursor?, limit?` | Browse `{key, updatedAt, bytes}` metadata in stable key order, with `nextCursor` | Safe |
| `memory_search` | `scope, query, limit?` | Ranked key/content matches with bounded excerpts and keys; no automatic full-record load | Safe |
| `memory_read` | `scope, key` | Return one record's content and metadata | Safe |
| `memory_write` | `scope, key, content` | Create or replace the whole record at a stable key; return metadata | Unsafe |
| `memory_delete` | `scope, key` | Delete that record; return whether it existed | Unsafe |

`scope` is required and exactly `shared` or `private`, including for reads/search.
No implicit combined scope, promotion to shared, append mode or model-generated
filesystem path. Keys are bounded logical identifiers, not paths. Start with
UTF-8 records, a 32 KiB content cap, query cap of 2 KiB, list/search default of
20 and maximum of 100, and bounded 50 KiB tool output with explicit truncation.

Use local daemon-owned storage: shared records under the daemon root and private
records under the Bot directory, separate from `session.sqlite` and the default
workspace. Atomic replacement and serialized mutations preserve other keys;
concurrent writes to the same key use last committed write wins. Do not silently
merge content. Bot deletion follows existing trash lifecycle for private records
and leaves shared records intact. An interrupted unsafe mutation is not replayed
over a newer record. Missing reads are errors; deleting an absent key is a no-op.

Start with bounded text search over these records. No vector database, embedding
pipeline, automatic memory extraction or pluggable storage interface is required.
Choose the smallest existing storage/search primitive during implementation;
shared mutation and crash tests are prerequisites, not optional optimizations.

### 6.2 Search: delivered

The implemented [Search inventory](#search) replaces the original planning
signatures. Do not introduce a second `limit` argument or a direct-GET fetch
implementation alongside the current `count` and provider-backed extraction.
`web_search` finds pages and includes content only when requested; `web_fetch`
extracts one URL. Neither is tool discovery or local memory search.

The shared `SearchClient` interface lives in `src/tools/search/client.ts`.
Provider adapters own external wire differences. The composition root binds
stored credentials and exclusive selection; server storage never imports tools.
Adding a provider means adding its adapter/catalog entry and the same contract
tests, not adding a new Bot tool or extending the model's schema with vendor
options. Actual provider acceptance is separate from deterministic local tests.

### 6.3 Schedule and webhook triggers

Trigger semantics, the invocation port they use, their storage, queue and batching
rules, the transcript origin field and the read-only app surface are owned by
[Triggers, invocation and peers](TRIGGERS.md). This guide owns only the tool faces:

| Tool | Planned input | Result and single responsibility | Replay |
| --- | --- | --- | --- |
| `trigger_create` | `kind, name, prompt, cron?, timezone?` | Creates one trigger owned by the calling Bot; returns its summary and a credential-free endpoint path | Safe by `opId` (§4 and §7 of TRIGGERS.md) |
| `trigger_list` | `{}` | Lists the calling Bot's triggers with `enabled`, counters and the last fired/skipped instant | Safe |
| `trigger_update` | `triggerId, name?, prompt?` | Replaces name or prompt only; a payload that changes the schedule is a separate operation | Safe by `opId` |
| `trigger_enable` | `triggerId, enabled` | Switches one trigger; the queue is untouched. Disabling clears the schedule cursor, enabling sets it to the next instant after now, so neither direction catches up | Safe by `opId` |
| `trigger_delete` | `triggerId` | Removes the definition, its secret and its queue | Safe by `opId` |

A Bot creates and manages its own triggers; the app lists them read-only with one
enable switch. No user-facing creation, editing or deletion exists. The model never
receives a webhook secret: the endpoint path it is given has no credential, and the
per-trigger bearer token is shown only in the app. No trigger mutation tool may be
marked replay-safe before the journal's `opId` record exists, because SDK `safe`
re-executes the handler rather than caching its result.

### 6.4 Agents and peers: discovery, listing and communication

Add **`agent_list({})`** to the existing `agents` group: list the caller's direct
child conversations from `bots.agent` markers, returning `agentId`, name,
creation time and observed activity. It creates nothing and is replay-safe.
An empty child list is success. Do not add `agent_discover` as a synonym.

In the same delivery slice, require matching parent markers in `agent_send` and
`agent_stop`; reject root, unrelated and missing conversation IDs. Keep one-level
delegation and same-Harness IDs. Add the currently missing negative/stop/recovery
tests rather than claiming the existing happy path proves these behaviors.

Independent Bots use the new **`peers`** group:

| Tool | Planned input | Result and single responsibility | Replay |
| --- | --- | --- | --- |
| `peer_list` | `query?, cursor?, limit?` | Discover/list other local catalog Bots, optionally matching their names; return stable `botId`, display name and observed availability, with `nextCursor` | Safe |
| `peer_send` | `botId, message` | Admit one message to that Bot, normally with `followUp`; return recipient `botId`, the caller-owned `requestId` and admission status, without waiting for its answer | Unsafe initially |
| `peer_read` | `botId, requestId?` | Observe one submission **this caller** sent: with `requestId`, its status and answer; without it, a bounded list of this caller's own outbound receipts so a lost acknowledgement is recoverable. Never submits, never reads an unrelated transcript | Safe |

`peer_list` serves both discovery and listing; do not add `peer_discover` or
`peer_search`. `peer_read` polls durable delivery/answer state, not a general
conversation history reader. This intentionally differs from synchronous
`agent_send`. No peer creation, stop-all, broadcast or automatic response
forwarding is part of this slice.

Reuse the existing submission statuses `queued`, `placed`, `done`, `unanswered`
and their reason semantics; do not invent another delivery state machine. A
successful send acknowledges admission, not completion of the requested work.

The host binds sender identity; the model supplies only recipient and message.
Target a stable catalog Bot ID, never a child ID, pane ID or ambiguous display
name. Exclude self from discovery, reject self-send, and distinguish deleted,
unavailable and unknown recipients from a queued message. Availability is an
observation, not an assertion that work is complete. Use list default 20/max 100,
message cap 16 KiB and bounded 50 KiB output; preserve settlement status when
clamping answer text.

Route through existing Bot lifecycle/admission and runtime submission storage,
not through loopback HTTP, a forged UI subscription or a second agent engine.
Compose narrow host callbacks at the daemon composition root; do not import
BotRegistry/transport into SDK-bound tool handlers or create a circular core
dependency. Reuse the existing durable submission ledger instead of adding a
parallel mailbox database for the same messages.

Recipient admission needs a stable request key derived from sender Bot and
durable tool-call identity, not time or a new random value on retry. Resolve
lost acknowledgements to the same recipient submission; do not promise atomic
cross-Harness commits or exactly-once external effects. Prove the admission/
acknowledgement crash windows before considering safe replay. A timeout is not
proof of non-delivery. Reading a reply never starts another turn.

Carry a durable route origin and visited-Bot path with peer-originated work;
reject repeated recipients and cap the initial route at four Bots. Do not wait
synchronously for peers from within a peer send. Test A -> B -> A and longer
cycles so communication cannot silently turn into an unbounded model loop.
This is product routing/cost control, not an execution sandbox.

As built (2026-10-29): the three tools exist, deferred behind `tool_search`, and the
daemon enforces a ten-message budget per side per exchange
(`core/PeerExchangeStore.ts`, TRIGGERS.md §10 "Stage 3, as built"). The route/visited-path
spike below is still open for routes longer than a pair.

`peer_send` is not registered until the route-enforcement spike in
[TRIGGERS.md](TRIGGERS.md) §10 decides its mechanism: a numeric-only release would
contradict the durable visited-path requirement above, and `peers: false` does not
prevent an already-selected tool from being called. The wire flag stays false until
the documented enable slice lands; tool selection and a future peer UI capability
are separate, and any new sender/delivery wire field needs an additive protocol
definition plus shared fixtures.

## 7. Development and acceptance recipe

1. Record the operation, group, inputs/results, output bounds, failure cases,
   side effects and replay decision here and in the relevant contract before
   code. Inspect the pinned SDK's exports/types; reuse an existing native tool
   instead of adding an equivalent implementation.
2. Add the first failing behavior test. Build the smallest `defineTool` handler
   and native extension in `src/tools/<group>/`; use a factory only when Bot-
   specific dependencies need binding. Do not introduce a universal plugin API.
3. Install once in `createToolRegistry`; extend the explicit group mapping and
   domain/client vocabulary. Keep mandatory groups mandatory. Supply the shared
   loader for deferred groups and test both selected and unselected states.
4. Exercise the real Harness with a deterministic model and temporary local
   state. Verify schema -> handler -> durable result -> next model request, not
   just a directly invoked function. Add protocol/Swift tests when wire or
   settings presentation changes; generic tool text needs no custom result UI.
5. Run the applicable gates, retain failing-then-passing evidence, update
   [PLAN.md](PLAN.md), and commit a complete usable slice. No stubs advertised as
   available tools, weakened thresholds, skipped tests or new coverage exclusions.

| Planned slice | Required acceptance beyond handler success |
| --- | --- |
| Shared deferred loader | Each new optional group works without Herdr; loader installed/selected once; disabling one group preserves other discovery; disabled tools stay unavailable even if previously loaded |
| Memory | Private A/B separation and shared visibility; child namespace; persistence/reopen; atomic failed write, concurrent keys, overwrite/delete semantics, key validation, bounded search/list/read and Bot-trash behavior |
| Web | Local HTTP fixtures for redirects, error statuses, non-text/large bodies, extraction, timeout/cancel and secret-free requests; fake-provider ranking attribution, no-results versus failure, and no implicit fetch after search |
| Child discovery | Marker-based listing, direct-parent checks, root/foreign/invalid IDs, stop of running/queued work, no nested delegation, interrupted-send behavior |
| Peers | Two real Harnesses, no UI subscription requirement, discovery without opening every Bot, busy follow-up, answer/unanswered state, recipient deletion, read ownership, duplicate admission, lost ack/restart, cycles and output bounds |
| Every group | Existing-session reopen, warm enable/disable, cached A -> B -> A refresh, in-flight answer continuity, native tool transcript and single-origin error attribution |

For daemon behavior, run `cd apps/bots && npm run check` (fixtures, tests, strict
types, check-only lint and coverage). Its current configured thresholds are
90% lines / 85% branches / 90% functions. Preserve them and aim for complete
coverage of the newly introduced small logic; do not equate these three metrics
with the repository's planned four-metric L1 standard. Crash cases use the
separate `npm run test:crash` lane when recovery changes.

For client changes, run `swift test` and `./Scripts/coverage.sh` from
`apps/bots-macos/`. Hosted UI changes also require those commands from
`apps/macos/`, its `./Scripts/build-app.sh` and visual acceptance. Follow each
package's toolchain/strict-format instructions. Root website/Worker checks do
not validate the isolated Bots daemon. No public service, real paid model call,
live terminal agent or production memory is needed for deterministic tests.

Recommended order: close the child-targeting/test gaps, deliver memory, deliver
web search/fetch, then deliver cross-Bot peers with durable routing. Generalize
the shared loader as part of the first new deferred group, not as a separate
framework project. Concrete provider/extractor selection and new wire fixtures
belong to their implementation slices; the names and boundaries above guide
those decisions.
