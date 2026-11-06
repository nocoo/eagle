# Bots — pi-durable runtime mapping

Status: **phase 1 contract** for `apps/bots/src/runtime/pi/**`. Claims carry the
evidence that established them. Protocol shape is in
[PROTOCOL.md](PROTOCOL.md), layers in [ARCHITECTURE.md](ARCHITECTURE.md), logs in
[OBSERVABILITY.md](OBSERVABILITY.md).

For the current inventory, extension-development rules and explicitly planned
tool families, see [Extensions and tools](EXTENSIONS-AND-TOOLS.md).

The adapter owns a Harness per bot, translates its behaviour into `RuntimeEvent`,
classifies failures, and owns the submission ledger. It owns no catalog, no
transport and no `rev`.

## Verified facts

Established with `@earendil-works/pi-durable@1.4.0` on Node 26.12.0 unless the
evidence says upstream source. Probe scripts and inputs are listed in
[Evidence](#evidence) so each claim can be reproduced or narrowed.

| # | Fact | Evidence |
| --- | --- | --- |
| F1 | The generation task appends the assistant entry itself; `wait()` returns `answer` = that entry id. No host commit is needed | P1: `answer: 10`, entries `10:pi.assistant, 7:pi.user` |
| F2 | The README quick start's `tx.entry(AssistantEntry, answer)` is therefore redundant; `test/examples/13-chat.ts` plus F1 describe the real behaviour | P1 vs README |
| F3 | `message_end` fires for every appended entry, including the user entry; `message_start` precedes entries that were never streamed | P1: `message_start, message_end#7(pi.user), …, message_start, message_end#10(pi.assistant)` |
| F4 | `message_start` for the assistant carries the **full partial content so far**; `message_update` carries only relative changes | P3: `message_start` content `"alpha beta gamma delta epsilon zeta eta thet"` |
| F5 | `message_update` is **not guaranteed**: a fast provider produced none, and the recorded run had only `message_start` → `message_end` | P3: zero `message_update` events; P2 saw two |
| F6 | With an empty registry the transcript holds only `pi.user` and `pi.assistant`; no `pi.system` entry appears | P2 |
| F7 | `requestId` is idempotent: a repeated submit returns the same submission id, and a settled submission's record (entry + answer) without emitting new events | P4: `12 12 true`, record `status:"done"` |
| F8 | `watchEvents()` yields a `snapshot` at attach (`entries/tools/compactions/inbox/agent/usage`, plus the live partial) and then batches per commit; falling >100 batches behind yields a fresh snapshot | upstream `src/harness/events.ts`; P1 late join |
| F9 | A provider error settles `unanswered{reason:"model_error", detail:"<upstream text>"}` | P2 |
| F10 | `abort()` settles the running input `unanswered{reason:"aborted"}` **with** its `entry`, and every queued input `unanswered{reason:"aborted"}` **without** one; `inbox` empties | P4 |
| F11 | Submitting while busy queues into `pi.inbox` with `mode:"followUp"` | P4: `[{"id":10,"mode":"followUp"}]` |
| F12 | `Submission.status(context)` returns the current record; `harness.submission(id)` reacquires one by id | upstream `harness/types.d.ts` |
| F13 | `StopReason` is `pending \| stop \| length \| toolUse \| error \| aborted \| deferred` | upstream `pi-ai/dist/types.d.ts` |
| F14 | A storage error fails and closes the whole Harness (`SessionFailed`); reopening is the only recovery | upstream README "Errors" |
| F15 | A task cut off by crash/eviction/reset is counted; at `settings.restartLimit` (5) it is parked and reported through `onReport` as `task_parked` | upstream README "Crash loops" |
| F16 | Automatic compaction is a conversation-owned **background task** and is enabled by default | upstream README "Compaction" |
| F17 | A watch that ends resolves a `WatchEnd` rather than throwing; `harness.closed` reports harness end separately | upstream `chord` `WatchHandle`, README "Errors" |
| F18 | Progress commits are throttled by `settings.progress.partialIntervalMs` (default 100) | upstream README |
| F19 | `settings` are host-level and read at every use; only `pi.agent` is per conversation | upstream README |
| F20 | Sleeping tasks survive restarts, and the Node default timer keeps the process alive, so `onWake` is unnecessary in the daemon | upstream `spec §5.6` |
| F21 | Cold open 7 ms; reopen of 400 entries 3 ms; 20 bots open in 30 ms at 103 MB RSS; ≈2.4 KB storage per answered turn | P5 |
| F22 | An interrupted attempt is **converted into a committed `aborted` assistant entry** (`convertPartial`) before the run resumes, so a crash mid-answer leaves an aborted entry plus the eventual answer | upstream `dist/harness/generation.js` `convertPartial` |
| F23 | `deferred` responses commit a polling checkpoint instead of an assistant entry; the run stays active with no message | upstream `generation.js`, `spec §8.3` |
| F24 | Reading `status()` after `submit()` can already show `done`, because admission starts the run | P4 (duplicate `requestId` returned `done` with entry + answer) |
| F25 | `harness.closed` reports `{reason}` and normal `close()` also settles it; it is not a failure by itself | upstream README "Errors", `spec §10.1` |

## Harness construction (per bot)

The snippet below records the original phase-1 chat-only baseline. Current
construction creates a Registry per Bot, installs built-in extensions, supplies
`NodeExecutionEnv`, and configures selected extensions before resume; see
[Tools](#tools-phase-2) and the extension guide.

```ts
const harness = await Harness.open(
  await openNodeSqliteStorage(join(spec.dir, "session.sqlite")),
  {
    models,                   // one shared Models for the process
    registry,                 // empty in this phase-1 baseline
    settings: perBotSettings(),  // fresh object per bot, never shared
    onReport: (error, info) => classifyReport(info),   // F15
  },
  BACKGROUND_CONTEXT,
);
harness.closed.then((end) => classifyClose(end));      // F14/F17
const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: spec.model } });
harness.resume();                                      // recovery, before serving
```

- `open()` performs recovery. The registry never calls `resume()` separately, so a
  run interrupted by a crash continues without an extra port operation.
- `Models` is shared process-wide. The phase-1 empty Registry could be shared;
  the current Registry is per Bot because tools bind Bot-specific dependencies.
  Settings and storage remain per Bot (F19).
- `root()` is idempotent: conversation `1` for a new storage, the same root after
  reopen. Its `agent` choices only apply when it *creates* the conversation, so the
  adapter configures the stored pair (`model`, `thinkingLevel`) on every open, in the
  same commit as the extensions. A reopened bot therefore runs with what the catalog
  stores and not with what an earlier session left behind.
- Phase 1 kept exactly one conversation per bot and never called
  `createConversation`, `fork` or subagent APIs.

## The model registry

The daemon holds one provider and many models (PROTOCOL.md, "Per-bot agent"):

- **One provider, many models.** The provider is the gateway: its id, its address and
  its key. The models are the ids the gateway lists, the ids bots store and the id the
  settings name as the default. A model the gateway stops listing stays registered while
  a bot stores it, so a stored bot keeps running with it.
- **The gateway publishes ids, and nothing else.** An alias says nothing about the model
  behind it — the same name can be a 272k model at one endpoint and a 1M one at another —
  so the daemon does not infer capabilities from a name. Every model is registered with
  the daemon's declared caps (`BOTS_CONTEXT_WINDOW`, `BOTS_MAX_TOKENS`) and with all seven
  reasoning levels mapped to themselves (`off` to the gateway's no-effort value `none`).
  pi-ai would otherwise lower `xhigh` and `max`; the explicit map is what makes the
  request carry the level the person chose. A gateway that refuses it is the run's error,
  never a silent fallback.
- **A partial model list is the gateway's, not the daemon's.** `GET /v1/models` asks the
  gateway what it lists; the daemon's own declaration is what `/v1/models` answers about
  each of those ids.
- **Discovery is apart from emptiness.** `GET /v1/models` asks the gateway for its list.
  A gateway that answers with no model is an empty list; a gateway that cannot be asked
  is a failure, and the daemon keeps the models it already knew.
- **The level belongs to the model.** The runtime adapter asks pi-ai which levels a
  model accepts (`getSupportedThinkingLevels`) and refuses a level the model does not
  take, instead of letting the provider lower it silently.

The provider is read through a getter, so a gateway change reaches the conversations
that are already open. The endpoint, the key and the provider are global; the model and
the level are the bot's own.

## Event mapping

`mapEvents.ts` is pure and golden-tested. Adapter state per bot:

```
attempt: number            // increments per generation attempt (F13 retries)
provisional: { id, attempt } | null   // id = "p_a<attempt>"
```

| pi source | Adapter action | `RuntimeEvent` |
| --- | --- | --- |
| attach snapshot (F8) | Build the view; if a partial exists, include it as a provisional message with its current content | `subscribe()` result |
| `message_start` where `message.role === "assistant"` | Start an attempt if none is open; emit the provisional once, **with the converted content from F4**, `state:"streaming"` | `append` |
| `message_start` where `message.role === "user"` | Ignore (F3) | — |
| `message_update` | Convert every `MessageChange` to a `DeltaChange` with its `index` (table below) and forward it | `delta{messageId:"p_a<n>"}` |
| `message_start` for an assistant attempt that already has a provisional (retry inside the same turn) | Keep the provisional; apply the new content as one `message` change | `delta{kind:"message"}` |
| `message_end` with `entry.kind === "pi.assistant"` | Convert the entry's message to a domain `Message`; final state from `stopReason` (F13); clear the provisional | `append{message, replaces: p_a<n>}` |
| `message_end` with `entry.kind === "pi.assistant"` whose `stopReason === "aborted"` (F22) | Convert with `state:"aborted"`; carry `replaces` **whenever a provisional for that attempt is open** — after a late attach the snapshot already holds the partial, and an unreplaced aborted entry would duplicate it | `append` |
| `message_end` with `entry.kind === "pi.user"` | Map the user entry, including its `requestId` when known | `append` |
| `message_end` with `entry.kind === "pi.tool-result"` | Map the durable result to `role:"tool"` with one `toolResult` block (`callId`, `name`, joined text, `isError`, `durationMs`); it never ends or replaces the streaming attempt | `append` |
| `submission` | Map the record: status, `entryId`, `answerEntryId`, `reason` | `submission` |
| `inbox_update` | Map queue items | `status` |
| `agent_changed` | Update and publish only the complete agent configuration; preserve the attempt, transcript and submission ledger | `agent` |
| `run_start` / `run_end` | `status{running, streaming: provisionalId \| null}`; `run_end` closes any open provisional | `status` |
| `tool_execution_*` | The call itself rides in the assistant attempt (`toolcall` deltas); the result arrives as the `pi.tool-result` entry above. Execution telemetry is not projected | `delta{kind:"toolcall"}` / `append{role:"tool"}` |
| `auto_retry_start` / `auto_retry_end` | Log only; the provisional stays open because the failed entry arrives after `auto_retry_start` | — |
| `deferred_poll` | Upstream dropped the partial: emit a `snapshot` with `streaming:null`, `running:true`, then `status` | `snapshot`, `status` |
| `task_failed` | Classify as `task_faulted` (a park only ever arrives through `onReport`) | `error{kind:"task_faulted", taskId}` |
| `onReport` (`task_parked`, `session_failed`, `extension_error`, …) (F15) | Pass the report to the classifier, which owns minting; the channel never mints | `error{kind, failureId}` |
| `harness.closed` (F25) | `reason:"closed"` because we called `close()` → expected, no error. `reason:"failed"` → `storage_failed` | `error{kind:"storage_failed"}` only for the failed case |
| watch end (F17) | Follow the exhaustive `WatchEnd` table below; `session_failed` goes straight to the storage-failure path | `snapshot` after reattach, or `error` |
| watch falls behind → fresh `snapshot` (F8) | Reset provisional state from the snapshot | `snapshot` |

`MessageChange` must be applied without loss. The wire mirrors each kind
([PROTOCOL.md](PROTOCOL.md#server-events)):

| pi change | Wire `DeltaChange` |
| --- | --- |
| `text_start` | `{kind:"block", index: contentIndex, block: {type:"text", text: block.text}}` |
| `text_delta` | `{kind:"text", index: contentIndex, append}` |
| `thinking_start` | `{kind:"block", index, block: {type:"thinking", text: block.thinking}}` |
| `thinking_delta` | `{kind:"thinking", index, append}` |
| `toolcall_start` | `{kind:"block", index, block: {type:"toolCall", callId, name, args}}` |
| `toolcall_delta` | `{kind:"toolcall", index, callId, path, append}` — pi's path is relative to the call's arguments, so the mapper prefixes `"args"` to make the wire path block-rooted |
| `block` | `{kind:"block", index, block}` — the whole converted block |
| `message` | `{kind:"message", message: convertMessage(message)}` |

`convertMessage` is the only place pi-ai types are read. Nothing from
`@earendil-works/pi-ai` crosses into `core/domain.ts`: blocks, messages, usage and
stop reasons are all converted. A golden case covers a block that is announced by
`text_start` and then receives no delta at all (F5), and a case with two text
blocks where deltas must land on the right index.

`stopReason` (F13) → `Message.state`:

| `stopReason` | `state` | Note |
| --- | --- | --- |
| `stop` | `complete` | Normal answer |
| `length` | `complete` | Token limit reached. `Message.stopReason` says `length`, so the client renders its own notice instead of guessing from text |
| `toolUse` | `complete` | A tool round follows; the assistant entry keeps its `toolCall` blocks and the run continues with a `tool` message (see "Tools") |
| `aborted` | `aborted` | User abort or shutdown |
| `error` | `error` | Upstream failure; reason text becomes a `notice`, never model context |
| `deferred` | — (no message) | F23: the run sleeps in a polling checkpoint; the adapter only emits `status{running:true}`, never a fake streaming message |
| `pending` | `streaming` | In-flight partial |

Because `message_update` is optional (F5), the adapter must never treat deltas as
the source of truth: the provisional content comes from `message_start`, and the
final `append` from the entry.

Message identity, as built:

- A committed entry is `e_<entry id>`, a provisional is `p_a<attempt>`.
- `createdAt` is the pi message's own `timestamp` (milliseconds), so a snapshot
  rerender and a live frame describe the same message identically. A message
  without a timestamp uses the host clock, which only happens for a message pi
  never stamped.
- Attribution: a run's progress carries the trace of the `send` that owns it, resolved
  from the submission record; the `status` published by that same `run_start` can still
  carry the watching connection's trace, because the admission record arrives after the
  event. Everything the client turns into a message, and every settlement, is exact.
- A user message carries `requestId` when the adapter knows it. The entry and its
  submission record land in the same commit, and `message_end` is published first,
  so the live `append` may lack the id: the daemon's view attaches it when the
  submission names its `entryId`, and every later snapshot, resync and page carries
  it. The ledger itself is in memory, so after a restart a message recorded before
  the crash has no id until its `requestId` is re-sent; reconciliation does not
  depend on it (PROTOCOL.md, client duties).
- The mapper projects `pi.user`, `pi.assistant` and (since tool rows) `pi.tool-result`
  into the transcript. A tool result is an `append` like any other message and is part of
  every `snapshot`, `history` page and `resync`, so a reconnecting client sees exactly the
  rows the live client saw. A tool result never clears the provisional of an assistant
  attempt that is still streaming.

### Attempt lifecycle

One run may contain several generation attempts (retries, deferred polls, a crash
that resumes). The provisional id is scoped to the attempt so a stale stream can
never write into a finalized message:

Upstream order matters: `auto_retry_start` is published **before** the failed
attempt's assistant entry, so the provisional must survive it; the entry itself then
finalizes it.

```
first message_start(assistant)   → open provisional "p_a<n>" with current content
message_update*                  → deltas to "p_a<n>" (block-scoped, indexed)
auto_retry_start                 → log only; the provisional stays open
message_end(pi.assistant)        → append the entry with replaces p_a<n>; attempt n closed
message_end(aborted)             → append the aborted entry (F22); attempt n closed
deferred_poll                    → upstream drops generation.message: broadcast a
                                   snapshot with streaming:null (running:true) so the
                                   client removes the provisional
message_start after a closed attempt → new attempt id "p_a<n+1>"
run_end                          → close any open provisional via status{streaming:null}
```

Rules that follow:

| Situation | Provisional handling |
| --- | --- |
| Failed attempt followed by a retry | The failed entry finalizes `p_a<n>`; the retry starts `p_a<n+1>` |
| Deferred poll | Upstream removed the partial, so the adapter broadcasts `snapshot{streaming:null, running:true}`; the next attempt starts a new id |
| Late join or snapshot rerender | The snapshot carries the live attempt's content and its `p_a<n>` id |
| Watch fell behind (F8) | Reset attempt state from the snapshot; a delta for an unknown id is dropped |

### Failure channels

pi reports trouble through four channels, not one. Each needs wiring and each can
double-report the same underlying failure, so the adapter mints a `failureId` at
the classification point and dedupes on it:

| Channel | Covers |
| --- | --- |
| `AgentEvent` (`task_failed`) | A task that faulted while running |
| `onReport` (F15) | Parked tasks, session failure, extension/hook errors |
| `harness.closed` (F25) | Harness end; only `reason:"failed"` is a failure |
| Watch end (F17) | The event stream ended; reattach before reporting |

`WatchEnd.reason` is one of `stopped | cancelled | session_closed | retired |
listener_error | session_failed`. Only the last two are faults:

| Reason | Meaning | Adapter |
| --- | --- | --- |
| `stopped` | We detached | Nothing |
| `cancelled` | The acquisition context was cancelled (shutdown) | Nothing |
| `session_closed` | `close()` ended the session | Nothing |
| `retired` | A document watch's incarnation retired | Re-acquire the watch; not a failure, no counter |
| `listener_error` | A sink callback threw | Reattach with a snapshot; escalate after three in 60 s |
| `session_failed` | The harness failed | Classify `storage_failed`; same failure identity as `harness.closed` |

Failure identity correlation works per **failure episode**, not per bot, and each
duplicate pair has a named key:

| Duplicate notifications | Correlation | Result |
| --- | --- | --- |
| `task_failed` + `onReport(task_faulted)` for one task | `taskId` | One failure |
| `harness.closed{failed}` + watch end `session_failed` + `onReport(session_failed)` | harness episode (`harnessGeneration` counter) | One failure, classified `storage_failed`; a reopen starts a new generation, so a later failure gets a new identity |
| `onReport(extension_error)` + a task fault that the same hook caused | `taskId` when present, else the report's sequence | One failure |
| First recoverable listener error: `onReport(listener_error)` + watch end `listener_error` | episode key `listener:<n>` | **No failure at all** for the first two occurrences; the third within 60 s mints one `internal` failure |

The rule that makes this decidable: only the *classifier* mints a failure, and it
runs once per episode key. Channels never mint on their own.

Normal ends (`close()` we asked for, `stopped`/`session_closed` watch reasons) are
not failures and produce no `error` event.

## Reflection before settlement

Before a root conversation settles its answer, `GenerationTask.onYield` asks a forked, owned
conversation to consider a fixed checklist. The fork sees the original context and answer but
only the checklist tools. The initial checklist asks whether to update the sidebar with
`note_set`; it never includes memory. The prompt and the fork's answer are not root chat.
Reflection happens at most once per input, including after a restart. Each fork has at most
two model requests and a fifteen-second deadline, both recorded with its durable plan/candidate.
Exhaustion cancels and joins the owned child; it never leaves a background reflection running.
A failed reflection is reported separately and does not replace the original answer or make it
unanswered. Auxiliary candidate/decision storage failures cannot interrupt delivery of an
already committed submission. Opening a Bot releases its acquired Harness and usage subscription
if reflection recovery fails.

A reflection's note is a durable candidate, not an immediate catalog write: it is applied only
when the original answer commits and still matches the answer the fork saw. A restart can
regenerate a different answer, so a candidate for the abandoned answer is discarded. Queued
user inputs remain ordered behind the current run. Reflection tool calls are observable without
adding the internal prompt or answer to the root conversation.

## Submission ledger

The adapter keeps `requestId → submissionId` in memory and answers from it:

- `submit(input)` calls `root.submit({type:"input", content, requestId})`, then
  `status(context)` (F12) and returns the record. A repeated `requestId` returns the
  existing record and emits **no** new events (F7), which is why the daemon replies
  with a connection-scoped `submission` frame itself.
- The record read here can already be `done` (F24), because admission starts the
  run. The wire therefore ranks statuses and clients never downgrade
  ([PROTOCOL.md](PROTOCOL.md#client-commands)).
- `submission(key)` resolves by either id for duplicate replies.
- The ledger is not persisted: pi-dedupes by `requestId` in storage, so a daemon
  restart plus a re-sent `send` still converges (F7).

Projection, which is also part of the mapping contract:

- A snapshot carries the newest `PAGE_MAX_MESSAGES` displayable messages, oldest
  first, with `truncatedBefore` naming the first message it could not keep;
  `history` pages the rest from `Conversation.entries()` newest-first, skipping
  entries the wire does not show, and reverses.
- `pending` is rebuilt from the snapshot itself: the submission ids the run and the
  inbox name, with records the adapter already holds supplying their details. Work
  the snapshot does not name is settled, so it leaves `pending` even if a settlement
  event was missed, and a cold start still shows the input a crash interrupted.
- An internal view is live as soon as the bot is open, whether or not a client ever
  subscribes: `ConversationService` releases the buffered commits at attach, so a
  port caller observes them and a later subscriber's baseline already contains them
  (TRIGGERS.md §3.5). The baseline is read synchronously before it is published, so
  a commit that arrives during the open is folded into the snapshot a client first
  sees, and a commit that arrives after it is numbered later.
- Each converted message is measured as its encoded JSON; above `MAX_MESSAGE_BYTES`
  it is withheld and replaced by the notice (PROTOCOL.md). The adapter may not
  import the wire layer, so `src/runtime/pi/limits.ts` mirrors those two numbers and
  `test/runtime/limits.test.ts` fails if they drift.
- An expired watch or a deferred poll re-emits a complete snapshot rather than a
  patch, and the hub rerenders it at the next revision.

`unanswered.reason` values the adapter can produce:

| `reason` | When |
| --- | --- |
| `model_error` | Provider/upstream failure (F9) |
| `aborted` | `abort()` or shutdown (F10) |
| `run_failed` | `settings.afterFailedRun = "withdraw"` — not used in phase 1 |
| `stale` | A compaction summary placed past the input — phase 1 has compaction off |
| `withdrawn` | A queued input removed by an explicit withdrawal other than abort |

## Settings per bot

| Setting | Value | Why |
| --- | --- | --- |
| `stream.timeoutMs` | 120 000 | A stalled provider must eventually fail the run |
| `retry.maxRetries` | 3 | 429/5xx are transient |
| `compaction.enabled` | **true** | F16: compaction is a conversation-owned background task. The close condition reads `busy().tasks`, so a compacting bot stays warm instead of being closed mid-summary. Thresholds: `reserveTokens` 16 384, `keepRecentTokens` 8 192, `backgroundTokens` 32 768, each capped to the declared window (`BOTS_CONTEXT_WINDOW`, default 200 000) and overridable per `BOTS_COMPACTION_*`; `BOTS_COMPACTION=off` disables it. `test/e2e/compaction.test.ts` is the acceptance on a 1 200-token window: four `pi.compaction` entries, the request context stops growing at ~2 095 characters while five turns stay readable. The `tasks` capability stays false, so the UI does not show a running compaction yet |
| `progress.partialIntervalMs` | 100 | Matches the protocol's 50 ms coalescing; local storage makes 100 cheap |
| `progress.outputIntervalMs` | 100 | Reserved (tool output) |
| `afterFailedRun` | `"continue"` | A failed run must not strand queued follow-ups |
| `restartLimit` | 5 (default) | Parked tasks surface as `task_parked` and are cleared by `recover` |
| `toolGroups` (per bot) | from stored config, default `["core", "coding", "herdr", "agents", "trigger"]` | `core` and `coding` are mandatory. The former adds `list`; the latter is native `CodingTools`. Herdr and child-agent extensions are optional. See "Tool groups" below |
| `thinkingLevel` (per bot) | from the stored pair, default `medium` | Every bot stores its own level. The settings name the level a new bot records; the inspector changes the level of one bot, in one commit (`root.configure`), and the change reaches the next prepared request — a running answer is never interrupted. A level the model does not take is refused |
| Search provider | `<XDG_CONFIG_HOME or ~/.config>/eagle-bots/providers.json` (0600) | Independent DeepSeek/Tavily keys with one selected provider. The `search` tool group is off by default. Its deferred `web_search`/`web_fetch` use a stable routing client that resolves the selected provider/key at invocation, including existing conversations; missing configuration is an error result, and failures never trigger fallback. Successful calls each book one `search` call |
| Usage statistics | `<root>/usage.sqlite`, 90 days | `usage_daily(bot_id, day, source, tokens, calls, cost_usd)` plus `last_seen(bot_id, total_tokens, cost_usd)` so a cumulative model report becomes a delta. A source is a string (`model`, `search`), so a new spender needs no schema change; the first token-only `daily` table is migrated into the `model` source on open. Kept outside a bot's session, so deleting a bot keeps its history; pruned on boot and on write |
| Model gateway | `<root>/gateway.json` (0600), dotenv fallback | The daemon registers one provider from the stored `{provider, baseUrl, apiKey}` and every model the gateway offers, plus the models bots store and the default the settings name. `PUT /v1/settings` rewrites the file, rebuilds the provider (the Harness reads it through a getter), binds the saved key directly to the provider auth resolver (the same path used on startup, without mutating process environment), and sets the default for new bots. The endpoint, the key and the provider are global and reach every bot at once; the model id and the level stay the bot's own |
| `skills` (daemon) | from `gateway.json`, default none | The App's ticks are the only input: the daemon never scans a folder for skills. The selection becomes the `bots-skills` prompt index and `skill_read`, read again on every ask, so a tick lands on the next turn instead of at the next Harness open (see "Skills" below) |
| `contextRetentionMs`, `documentRetentionMs` | 600 000 (default) | Idle close frees memory; defaults keep reopen cheap |

Each bot owns its settings object so one bot's policy cannot affect another
(F19).

## Tools (phase 2)

The mandatory `coding` group installs pi-durable's native `CodingTools` extension.
The mandatory `core` group installs `bots-tools`, containing the native-style `list` tool.
There is one implementation per capability and no aliases for the old tool names.

| Tool | Behaviour |
| --- | --- |
| `read` | Native text paging and supported image input, with the SDK's output limits and diagnostics |
| `write` | Native whole-file UTF-8 write, creating parent directories |
| `edit` | Native unique, non-overlapping exact-text replacements, serialized with writes to the same file |
| `bash` | Native shell execution, streamed output, cancellation, retained output and spill-file diagnostics; optional `timeout` is in seconds and has no default |
| `list` | A recursive directory listing, defaulting to the conversation's working directory; at most 2 000 entries and 50 KiB, sorted within each directory, without traversing symlinks or common build/dependency directories |

The Harness supplies a `NodeExecutionEnv` from the conversation's `cwd`; tools use that
SDK environment instead of their own filesystem or process adapters. The workspace is
`<bot dir>/workspace`, a default working directory rather than a security boundary.
Absolute paths and normal local file access are supported. Execution sandboxes and
third-party plugins are explicitly outside the product scope.

- Calls execute without a separate approval dialog. Schema validation, cancellation,
  output bounds and model-visible failures are still required.
- The native coding tools retain their SDK replay policy (default `unsafe` in 1.4.0).
  `list` is replay-safe. No side-effecting command is silently repeated after interruption.
- Shell calls must not inherit daemon credentials. This policy uses the SDK's native
  shell preparation hook, not another command runner or a sandbox.
- The native timeout and output semantics replace the old `run_command` contract. Tests
  cover timeout, abort, UTF-8 output, nonzero exits and the full model-facing result.
- Tool calls and results use the existing wire blocks and generic macOS tool rows.
  Text and diagnostics are rendered; image attachment rendering is not added by this
  change and remains outside the client's current text-only tool-result shape.
- A hard kill of the daemon can orphan an external process. Durable recovery records an
  interrupted unsafe call; it does not promise to undo effects or kill arbitrary old pids.

### Skills

`bots-skills` is installed whenever the runtime is given a selection reader, and it belongs to
no tool group: the person's ticks are the switch, and a group switch would be a second,
contradictory one.

- Its one section re-reads the selection on every ask. With nothing ticked it renders nothing
  at all; otherwise it lists each skill as `name · version — description` (the version is
  left out when the skill states none), in the order the App pushed, on one line per skill.
  Building the section does no filesystem work.
- Its one tool, `skill_read({ name })`, reads `SKILL.md` inside that selected skill's
  directory. It takes a name and never a path, so the model cannot turn it into a file
  reader: the folder is resolved and its device and inode are recorded, the manifest is
  resolved and has to stay inside that folder, the file is opened with `O_NONBLOCK` and
  without following a final symlink, and the opened descriptor is checked with `fstat` — a
  regular file, and the same one the path resolved to. The folder is then stated again and
  must still be that directory, and the manifest is resolved once more from it, which has to
  lead inside it again and end at the descriptor's inode: an intermediate directory of the
  resolved path swapped for a symlink to another tree is refused that way. An unselected
  name, a manifest that is gone, unreadable, outside the folder or not a regular file, or a
  tree that changed under the read is refused with a message naming what is selected. The
  checks are not atomic with the open, so a swap after the last one, or one made and unmade
  between two, is not detected; the bytes read always come from the checked descriptor.
- The read is bounded twice over: at most 64 KiB are pulled from the file, in chunks, and the
  kept text is at most 32 000 characters and 4 096 lines, cut on a UTF-8 boundary. Every
  budget leaves a prefix, so the returned text is the shortest of them and the
  `[truncated at <n> <unit>]` note names the budget that produced it — 100 000 ASCII bytes
  say `characters`, 40 000 short lines say `lines`. The tool declares output limits above
  those budgets, so the harness neither cuts the manifest nor drops the note in its own
  defaults (50 KiB and 2 000 lines).
- `~/…` paths are expanded against the daemon's home, which is where the App scanned. A
  selection change reaches a conversation that is already open: the section and the tool both
  read the live list, and no `root.configure`, reopen or subscription is involved.

### Tool groups

`core/domain.ts` owns the product vocabulary: `core`, `coding`, `herdr`, `agents`,
`search`, `trigger`.
`core` and `coding` are always selected, including when settings request an empty list.
`core` maps to `bots-tools`, `coding` to native `coding-tools`, `herdr` to `bots-herdr`
and the native `tool-search` loader, `agents` to `bots-agents`, `search` to `bots-search`,
and `trigger` to `bots-trigger`. Both required groups
are shown enabled and disabled for editing in the settings UI.

`bots-trigger` is installed only when the runtime is given a trigger host bound to that
bot's store; the five tools are deferred behind `tool-search`, and the host carries the
durable tool-task id as each mutation's operation id (TRIGGERS.md §7).

### Hot registry refresh

Each Harness registers the built-in extensions once. Group selection is a separate native
agent configuration, resolved from the live Registry snapshot rather than a startup cache.
Every accepted client subscription, including a cached A -> B -> A switch, refreshes that
selection before its baseline snapshot. No new wire command, loading UI, Harness, runtime
watch or model request is needed. The refresh carries the subscription trace.

Enabling a previously disabled group immediately makes its registered tools available;
disabling Herdr also removes its loader and prompt section from the selected agent.
Already executing calls retain their SDK execution phase, while later requests use the
new selection. Existing child conversations keep their own stored agent choices; this is
configuration, not a permission-revocation or sandbox system.

The host may replace an extension through native `Registry.install`; refresh reads the
current registry objects. There is no filesystem watcher, dynamic source import or
third-party plugin discovery. A failed refresh is logged once at the runtime origin and
refuses that subscription; retrying the same selection or subscription must remain possible.
The failed subscription closes with `1011` after its error frame, reusing the client's
existing automatic reconnect policy. Storage failures reuse the Harness episode identity
across refresh, reports and watch/session termination instead of logging another origin.

### Subagents (phase 2, slice 3)

`bots-agents` lets a bot delegate a self-contained task to a child conversation instead of
doing everything in one context.

| Tool | Behaviour |
| --- | --- |
| `agent_spawn` | Creates an ownerless conversation in the same Harness, configured from the caller's agent (model, reasoning level, extensions, tool list, `cwd`, instructions) minus these three tools — one level of delegation, never a tree. Appends a `bots.agent` marker entry (no `model`, so the child never sees it) and answers the child id |
| `agent_send` | Submits to the child with a request id derived from the call, waits for settlement, and answers the child's final text; a run that ends `unanswered` is an error result naming the reason |
| `agent_stop` | Aborts the child: queued work is withdrawn and the transcript stays readable |

The child is not a second product: it lives in the same sqlite file, so the daemon's one
`busy()` and idle close cover it while a tool waits on it. There is no child-conversation
listing in the client protocol; the parent transcript contains the tool results, while
the SDK can inspect the child by conversation id. The generic task graph is separate
from a child-conversation UI. The `peers` capability stays false.

`agent_send` requires a `bots.agent` marker naming the caller as direct parent.
Sends with shared devices serialize each child's idle wait, remote refresh and
submission, so parallel sends cannot reconfigure active work. `agent_stop` still
looks up a conversation without checking its parent marker; `agent_list` remains
planned. Independent catalog Bot communication belongs to planned `peer_*`
tools, not a reinterpretation of these same-Harness `agent_*` operations.

### Deferred tools

The eight `herdr` tools are declared `deferred: true`, so they are installed and callable
but **not offered** in each request; `createToolSearchExtension()` is installed with them
and `tool_search` loads the matches into the conversation's `modelTools`, after which they
stay offered (also across a compaction). The core tools and the subagent tools are always
offered: they are what every turn needs. The herdr prompt section says the tools are loaded
on demand, because a model that never searches would never see them.
`test/runtime/deferred-tools.test.ts` proves the fallback works: the model searches, then
calls `herdr_list`, and the call runs.

## Herdr tools (phase 2, slice 2)

A second extension, `bots-herdr`, gives a bot a terminal collaborator. It talks to the
installed `herdr` CLI over the running session; the bot owns exactly one space and every
target is resolved inside it.

| Tool | Behaviour |
| --- | --- |
| `herdr_open_space` | Opens this bot's space (a workspace labelled `bots-<bot id prefix>-<nonce>` with one shell pane) and returns its ids; calling it again reuses the live space |
| `herdr_start_controller` | Starts one controller agent in that space's root pane with a herdr kind (`pi`, `codex`, `grok`, ...) and native arguments after `--`; idempotent while the controller lives |
| `herdr_list` | Lists the panes and agents of that space only |
| `herdr_send` | Submits a prompt to an agent in the space (default the controller) and by default waits for a settled state |
| `herdr_wait` | Waits for a named state (`idle`, `working`, `blocked`, `done`, `unknown`) or a settled one |
| `herdr_read` | Reads that agent's screen text (`visible`, `recent`, `recent-unwrapped`, `detection`), keeping the newest 64 KiB |
| `herdr_keys` | Sends logical keys (`esc`, `enter`, `ctrl+c`, `1`, ...), for a dialog the controller is blocked on |
| `herdr_close_space` | Closes this bot's own space and forgets it |

Rules:

- **The prompt does not advertise the scope.** The `bots-herdr` section names the space and
  how to use the tools; the scope is enforced by the tools (and their refusals), not stated
  as a prohibition in the prompt, because the shell a bot may also use can reach the
  machine. A model that asks the tools for another space still gets a refusal.
- **One space, and only its contents.** The space id, its full label (prefix plus a
  per-instance nonce) and its root pane live in `<bot dir>/herdr.json` (0600, outside the
  model's workspace). Every call re-reads the space from herdr and requires **both** the
  recorded label and the recorded root pane in that space, so neither a different space
  nor a same-id replacement is ever touched; a space that disappeared is replaced by a
  fresh instance, and the refused id stays tombstoned across that replacement and a later
  close. With no usable state (missing or corrupt file), exactly one space with
  this bot's prefix is adopted, and several are refused rather than guessed; a recorded
  space that fails verification is revoked in place, and its id is also written to
  `herdr.revoked.json` beside the record, so replacing the space and closing the new one
  cannot make a later open adopt it. If that tombstone cannot be written, the replacement
  does not happen at all ("nothing was changed"); tombstones are pruned (before the size
  ceiling is judged) only for spaces herdr no longer reports, never evicted while live, and
  a list that is still full of live entries fails safely rather than forgetting one. Only a
  missing file means "no refusals": a tombstone that cannot be read, parsed or attributed
  to this bot disables adoption and is never overwritten — a refusal that cannot be
  recorded fails with nothing changed. A record whose owner is another bot, or whose label
  carries another bot's prefix, is foreign and is never obeyed. A space that could not be recorded
  is closed again; when even that close fails, the result names the leftover space so a
  person can close it.
  `herdr_list`, `herdr_send`, `herdr_wait`, `herdr_read` and `herdr_keys` resolve their
  target against the agents herdr reports **in that space**, and then address it by its
  workspace-qualified pane id — never by a name that can be reassigned or moved.
- **argv, not a shell.** Each call is one `herdr` argv with a deadline (30 s default,
  120 s for talk, at most 600 s) and a bounded answer. The run's abort signal kills the
  CLI process group, a call that is already queued behind another is cancelled before it
  starts, and a deadline settles at once instead of waiting for an inherited pipe to
  close. The CLI's own output keeps its newest 4 MiB (a screen is only useful at its end)
  and is decoded across chunk boundaries. A herdr JSON error becomes the tool result with
  its own code and message (`agent_blocked: ...`); a non-zero exit without JSON keeps the
  exit and the detail.
- **The CLI is a host tool, not a sandboxed process.** `herdr` needs the session socket;
  these tools constrain their targets by the Space rule above. There is no workspace
  sandbox or filesystem profile, and native coding tools retain normal local access.
- **A label is not an ownership credential.** The nonce makes a collision with a user
  workspace implausible, but a user who copies the exact label of a bot's space can be
  adopted when that bot has lost both its state file and its tombstone list. That trade-off
  keeps a lost state from leaking a second space; several candidates are refused instead of
  guessed, and a state file that is present but fails verification is never adopted. Both
  files live in the bot's own directory, outside its default workspace. That location
  is not a security boundary: native coding tools can access it. Removing both records
  discards the targeting evidence, and adoption then resumes as described above.
- **Reading is evidence, not proof.** `idle`/`done` mean herdr saw a settled agent, not
  that its work finished; `blocked` is a dialog the controller raised, and the bot may
  inspect it with `herdr_read` and answer it with `herdr_keys`.
- **Replay and state.** `herdr_open_space`, `herdr_list`, `herdr_wait` and `herdr_read`
  are `replay: "safe"`; prompting, keying, starting and closing are not, so a restart does
  not repeat them. The tools share one state file and run one call at a time.

## Reserved capability enable paths

"Reserved" means the wire can represent it and the client must ignore it while
disabled. It does **not** mean half-implemented behaviour. Each capability is its
own change set:

| Capability | Work required when enabling |
| --- | --- |
| `tools` | Enabled: native coding, core list, Herdr, child-agent tools and deferred discovery; calls/results render through the existing generic client rows. The extension guide maps the current inventory and tests |
| `agent` | Add a `configure` command and a model catalog endpoint; add `configure` to the port; render the settings panel |
| `tasks` | Emit `task` events from `watchTaskGraph`; add a `retry` command; make the close condition task-aware |
| `entries` | Serve raw entries from `conversation.entries()` behind a paging command |
| `usage` | Already populated in phase 1: `snapshot.usage` comes from `pi.usage`; the panel is what phase 2 adds |
| `peers` | Planned independent Bot discovery/delivery via `peer_list`, `peer_send`, `peer_read`; the extension guide defines boundaries and acceptance before capability enablement |

None of them may change v1 semantics for existing fields.

## Recovery semantics

Shared device access uses `remote_status`, `remote_execute(deviceId, operation)`
and `remote_operation(deviceId, operationId, action)` from the injected v2 device port.
At root open and before each new input, local status decides whether those eager tools
are selected: configured-but-offline remains configured; unconfigured or unavailable
is not selected. Already loaded remote calls check current local status before dispatch.
An app-managed child is synchronized from local configuration before `agent_spawn`
and before an idle `agent_send`; only the three remote names change, leaving its
other filters and its ban on further delegation intact. Child work already in
flight settles first. Automatic propagation to an already-running root or child
between model requests remains open work in [DEVICE-IDLE-AND-WAKE.md](DEVICE-IDLE-AND-WAKE.md).
The model reads current names, online evidence and capabilities before choosing
a remote target; local coding tools keep the local execution environment. A
durable tool memo records the target, full operation, digest, operation ID and
validated relay origin before transmission. The local service binds the operation
and origin atomically; an operation cannot be claimed by another relay. Retries
query the original ID at its original relay; they never resend unknown effects or
substitute a local target. Remote command calls keep their local socket open for
the requested command timeout plus 95 seconds for bounded authentication and
relay overhead, up to 395 seconds. A timeout is still unknown, never proof of
failure or permission to replay. A busy response is unaccepted and creates no queue.
If a root tool was interrupted and remote access is unconfigured or the local service
unavailable at reopen, the adapter validates the saved binding against the SDK's final
execution arguments and preserves an `unknown` receipt before scheduling resumes. It
uses the pinned SDK's public `LiveDoc` progress and lets the SDK settle the interrupted
task; it sends no recovery request and does not invent an outcome. The wire
`toolResult.text` remains JSON and includes the SDK's diagnostic in `diagnostics`;
the model transcript retains that diagnostic as a separate block. This path is tested
with real Harness/SIGKILL restarts, including a second crash before resume. It does not
establish child or nested-call recovery after a configuration change.
All native coding tools and `list` cross the same local policy/admission seam
when a device port is configured. They obtain the local device ID and policy from
the local status method, without reading the remote directory or waiting for the
cloud. Approval requests carry the complete operation; only the initiating App
can confirm them. No port credentials enter Bot storage.

The shared adapter captures native `output`, `retainedOutput`, diagnostics and
details in bounded memory. No raw progress is published to pi.live, and native
shell output does not spill to an unsanitized file. Completion sends retained
text and diagnostics/details through the host sanitizer and journal; model and
nested callers receive the same versioned device receipt with output, status,
exit code and original target/operation ID. Native image blocks are explicitly
omitted at this textual device boundary. Recovery returns that same receipt.
Only payload text is shortened to fit the 64 KiB encoded receipt; metadata and
valid JSON remain intact and truncation is explicit. With a device port injected,
Herdr currently exposes inspection only; write/control tools stay unavailable
until they participate in shared admission.
If native output or its metadata was truncated before the trusted sanitizer,
the incomplete segment is omitted in full. This includes native SDK truncation;
an appended marker must never hide a partial credential's original boundary.


| Situation | pi behaviour | Adapter action |
| --- | --- | --- |
| Process killed mid-run | Committed entries survive; the generation task is still `running` on disk; on resume the interrupted partial becomes a committed `aborted` assistant entry (F22) | `open()` resumes; the client shows the aborted attempt followed by the final answer |
| Killed while a tool ran (phase 2) | Replayed only when `replay:"safe"`, else an `interrupted` error result | No adapter involvement |
| Crash loop ≥ `restartLimit` | Task parked, `onReport(task_parked)` (F15) | `error{kind:"task_parked"}`; `recover` retries it |
| Storage error | Harness closes itself (F14) | Classify `storage_failed`, mark the bot `unavailable`, serve a snapshot with `unavailable` |
| Watch ends (F17) | See the exhaustive `WatchEnd` table: `listener_error` reattaches and escalates at three in 60 s; `session_failed` takes the storage-failure path immediately; normal reasons end silently |
| `close()` stalls on non-cooperative code | `close()` joins invocations | `close` resolves `timeout`; the registry quarantines the bot and retries; it is never dropped |
| Reopen after idle close | No state lost | New snapshot; the client replaces its view |

`recover` is the operator's escape hatch and is state-dependent
([PROTOCOL.md](PROTOCOL.md#client-commands)). The adapter exposes parked-task retry
and leaves a running answer alone; `abort` is the only destructive command.

## Pitfalls

1. Do not commit the answer entry (F1/F2).
2. Do not map `message_start`/`message_end` literally (F3): ignore user-role
   `message_start`.
3. Do not build the provisional from empty blocks (F4): it carries real content.
4. Do not rely on `message_update` (F5): a run can arrive with zero deltas.
5. Do not key deltas on the pi-ai message (deltas have no entry id): use the
   attempt-scoped provisional id.
6. Do not assume a `pi.system` entry exists (F6).
7. Never open one bot twice (F19, no cross-process locking).
12. Do not expect exactly one assistant entry after a crash: F22 commits an
    `aborted` attempt first. Assert one admission, one retained interrupted
    attempt, one final answer.
13. Do not treat a missing delta as a stall (F5), and do not treat a
    `harness.closed` with `reason:"closed"` as a failure (F25).
14. Do not claim trace continuity into pi: phase 1 installs no pi telemetry, so
    trace ids live in the daemon's own logs and in-memory ledger. A resumed run
    after restart is attributed to `tr_boot_<n>`, not to the original `send`.
15. Do not clear the provisional on `auto_retry_start`: upstream publishes the
    failed attempt's entry afterwards, and that entry is what carries `replaces`.
    Do close it when that entry arrives — the retry gets a new id.
16. Do not treat `deferred_poll` as a message event; it is a polling sleep.
17. Do not expect `retired` to be an error; it means a document watch's
    incarnation rotated, and the watch is simply re-acquired.
8. Do not synthesize `unanswered` from a thrown command (F7/F12): only a stored
   record settles an input. `abort` settles with `reason:"aborted"` (F10), which is
   not a model failure.
9. A lost acknowledgement is not a failure: re-send the same `requestId` and read
   the returned record (F7).
10. Do not close a bot on "no run" alone once compaction or tools exist (F16).
11. A watch that falls behind delivers a snapshot; reset provisional state or the
    next deltas target a message the client dropped (F8).

## Evidence

| Probe | Input | Establishes |
| --- | --- | --- |
| P1 | `fauxProvider`, one turn, no host commit; print `wait()` result and entry kinds | F1, F2, F3 |
| P2 | Same plus `watchEvents` collection; 1 scripted answer, then a provider error, then abort | F5 (two deltas seen), F6, F9 |
| P3 | `tokensPerSecond:120, tokenSize:2..3`, answer `"alpha beta … theta"`; capture `message_start` content and every `message_update` | F4, and F5 (no deltas in this run) |
| P4 | Hanging response, queued follow-up, `abort()`; then duplicate `requestId` submits | F7, F10, F11 |
| P5 | One bot: 200 turns with a 456-character answer and a ~140-character prompt; then reopen immediately after close, then 20 bots opened in one process | F21 |

Scope notes: F21's reopen was measured immediately after close (warm page cache)
and in `/tmp`; the numbers prove order of magnitude, not a percentile. Threads and
process count were not varied. Real-model latency is network latency and is
excluded from every number here.

## Upgrade procedure

1. Bump the exact pin in `apps/bots/package.json`; install.
2. Run `npm run test:runtime` and `npm run test:protocol`; the `mapEvents` golden
   sequence is the early-warning signal. `npm run golden:record -- <scenario>`
   re-records a sequence from a real Harness over pi-ai's faux provider and rewrites
   its frozen expectation, so review that diff before committing it.
3. Read the upstream diff for `docs/spec.md` §2.1 (context), §5.6 (wakeups), §8.2
   (`pi.live`), §9.3–9.4 (views, agent events) and `CHANGELOG.md`.
4. Update the fact table if any of F1–F21 changed; the pin bump commit names the
   facts that changed.
