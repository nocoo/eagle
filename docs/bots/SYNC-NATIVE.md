# Native synchronized contexts — P5 contract

This slice starts at delivered `193f75bd` / tree `73695d14`. The two-Mac
scene5 receipt `f5b7827b` is independent API/SDK evidence; it does not certify
native composition. New execution inputs and evidence live under
`.local/sync-p5-native`. The 3194 inherited references remain immutable and are
reused without another hash sweep. `182fc1f` is that historical common baseline.
P5 source, final tree and the finite A/B native/restart scopes are accepted;
B's pre-send interruption remains cause-not-assigned. PR112 now integrates
the separately fixed upstream8674 and then19f4; new checks belong to each merged input.

## Heads and contexts

The ready replica provides a bounded head directory and one-head metadata/detail
through RuntimePort and the local bearer HTTP API. The directory includes newly
materialized incremental heads, parents, original source, readiness and resource
version references; it never downloads complete carriers for a list. A durable
local context has an immutable ready seed, a mutable tip and a separately selected
resource head. Omitting context retains the existing root behavior.

Context selection reaches Invocation/SubmitInput, SDK admission and all subsequent
lookup, status, history, entry, watch, export, abort and retry operations. A request
ID retains its original context, resource selection and submission across restart.
Outbox persists these fields before sending through the existing ConversationPort.
Changing selection cannot retarget pending work. FollowUp/steer remain per-context
SDK queue operations; the shared Harness and overall admission/busy boundary stay.
Terminal state is durably stored before removing the outbox entry.
The per-Bot serial admission check unions read-only Harness persisted queued/placed
records from all local conversations with unconfirmed reservations, including
contexts with no attached view after restart. Same-ID lookup/retry precedes the
32-slot check. It never opens every context or adds a second queue.
Abort/recover/history results can change the visible error or parked state only
while their captured selection generation and Bot/context still match; leaving
and returning to the same context does not admit a late result.
SDK reports with an explicit task or conversation ID route synchronously to that
existing context handle before classification. Its command/run trace, subscribers
and pre-subscription error buffer own delivery; a subsequent task fault reuses the
same failure identity and sole origin. Explicit child reports emitted during SDK
open retain their conversation key in that same buffer even before its local
handle is registered. Root subscription only drains root errors; later legal child
registration transfers its original failure and boot trace without reclassification.
An explicit child report with no registered handle always uses the boot trace,
including asynchronous SDK work while an unrelated root request is active.
Session-wide and unscoped host reports keep
the original shared Harness/classifier path. Routing never opens other contexts
or replays execution.

## Two-head merge

Merge accepts exactly two immutable ready heads and a caller-owned idempotency key.
Original parent receipts, raw entries, origin/task IDs, head/edit references and
resource bytes remain immutable. The new receipt names both logical parents.
Equal effective contributions sharing an original origin appear once. Conflicting
replace/omit contributions require an explicit parent selection for that origin;
same-path different resource versions likewise require an explicit SHA selection.
Parent order defines the order of independent contributions; system-section object
insertion order and tool-call/result association are preserved.

The SDK representation is one typed derived entry per effective message, with
full original origin, selected edit relation, group/index/size and parent-entry
provenance. Empty explicit omissions retain an addressable mapping. A later SDK
origin-target edit is kept in its passive fork receipt; the original merge
constructor rebuilds the complete ordered effective group into a new immutable
head before presentation. It never leaves multiple visible messages inside one
entry or appends changed group members after unrelated history. It uses public SDK context,
create/fork/append and defineEntry operations. Original raw streams remain in their
parent receipts rather than being rewritten into a flattened message marker.
Later edits resolve the original target through that mapping to the same visible
contribution after reopen. This representation must pass real SDK/provider tests
before it is treated as stable; no generic merge policy or queue is introduced.

## Native composition and verification

One owned BotsSettings/defaults, Supervisor and DeviceSettings(control) instance
is passed through liveApp, WorkspaceShell, Settings and delegate/publishSync.
DeviceSettings.perform uses the trusted DeviceSystemControl/XPC manage route for
share and bounded current-authorized incoming discovery. BOTS_DEVICE_SOCKET stays
a typed sync/identity port, never a management channel. The existing composer,
ConversationViewModel, Outbox and EagleDesign inspector host head/resource/merge
selection. Read Impeccable's craft floor before editing UI.

TDD runs complete original runtime/history-replica and client/Conversation files,
without focus or skip. First prove same-ancestor branches, tool/compaction/edit
contributions, ordered sections, resource conflicts, zero replay, actual first
provider input and old-target edit after reopen. Then prove two-context outbox
retry/restart and the owned native selector→composer→SDK→transcript chain.
FakeConversation is component evidence only. Keep the existing coverage/strict,
affected invocation eval/crash and normal delivery hooks.

Physical concurrent branches, candidate-App restart and remaining PR scenarios
follow stable P5 inputs, with separately bound execution copies. For scenario6,
pause the owned Sync isolate's network/metadata/upload/socket work, settle puts,
advance only a private alarm window to max target expiresAt+1 in try/finally, run
the original alarm, then restore wall time. Fresh real authority must prove GET410,
actual R2 deletion and unchanged original event clocks before an empty C on A
receives from online B through relay. No system time, production clock endpoint,
R2 fixture deletion, history copy or future-time authorization claim is allowed.

Execution evidence remains bound to each frozen source and actual copy. PR creation
remains after the six physical acceptance scenarios and minimal P5, with no
merge/deployment/publication.

The additive socket fields are `subscribe.contextId` and
`send.contextId/resourceHead`; omitted context selects the original root. A socket
is bound to the selected context for its lifetime. CommandContext and OutboxEntry
retain the same selection; retries reuse the original context, resource head and
whenBusy. Root reconciliation must not replay non-root entries. SettledRequest
keeps the selection while its terminal record and outbox removal are written
atomically. Selection changes cannot redirect an already captured command.

The native client reuses CatalogHTTPClient's local bearer request boundary for
`replica/heads`, `head`, `context` and `merge`. Head pages carry metadata only;
one-head details expose immutable resource names and digests. A read-only
`merge` preview over the same two ready parents returns bounded conflict
origin/action/count/digest and resource-version choices, without admitting work
or returning full carriers. Selection creates a durable context once, then the
original conversation socket and composer use that identity.

Scene5 inherits the accepted final `f5b7827b`, whole-window `6766880e` and timing
`38377da4` combination. Only after all physical/native acceptance, the authorized
PR preparation will normally fast-forward own `bot-sync/base` from `165d154` to
the already-local fixed `182fc1f704774eb37bdbc11cde017f8ff61f1c1a`, retaining
own `bot-sync/eagle` as head. It does not update development inputs or authorize
fetch, force, early PR creation or merge.

The trusted incoming selector adds only `sync.incoming {after?,limit?}` on the
helper management channel and POST `/sync/incoming` on Registry (default128,
maximum128). It scans the recipient's actual `sync_grants` rows in rowid order,
revalidates each complete current holder→receiver identity pair, and returns
`{version:1,local,items:[{sharedBotId,holder}],nextAfter,hasMore}`. The cursor is
the last actual inspected row, including stale grants; an empty window keeps it.
It is a bounded metadata hint, never a data grant or baseline-completeness claim.
No group-directory fallback is used. Current SQL failures return503 rather than
an empty list. The Bot socket rejects both incoming discovery and `sync.share`.
The App feeds explicit grant/receive choices through the same owned
DeviceSettings.control and existing local replica/connection APIs.


Head metadata with resources returns that immutable ready history head as its
`resourceHead`; empty resource lists keep null. The existing resource selector
already accepts ready history heads as well as standalone resource manifests.
It must not advertise a computed standalone manifest digest that is absent from
local facts. This also works for already imported/ready heads without adding
facts, publishing events, changing resource bytes or replaying execution.

Physical v5 concurrency (`dc891c81`) is two real Macs using API/SDK fixed-head
branches and actual selected local skills, then both branches continue. Both
immutable histories/resources synchronize exactly with passive provider delta0.
It is separate from native GUI acceptance.

Scene6 finite receipt `physical-v5/physical-retention-final.json` (`114d482d`)
under `.local/sync-p5-native/` covers two physical Macs and a third fresh isolated
C on A. Original A daemon stays offline, B is the current authorized online
holder. Eight original objects cross their deadline only inside the private
original-alarm window; actual R2 bodies are deleted and original clocks stay
unchanged. Restored real time/fresh real Registry authority returns Worker410;
the owned Bots HTTP wrapper returns403, separately clarified by
`physical-retention-authority-supplement.json` (`1b733989`). C restores original
A/B source history and six resources through four successful relay exchanges,
R2get0/put0 and passive provider/task/submission/local-run0. One original C
request then runs the real SDK/local skill with selected resource bytes. This is
API/SDK and an owned alarm deadline model, not wall-clock72h or deployed CF.

After that closed offline window and user unlock, A's actual external public
AX controls select both parents and an explicit AGENTS version. Its first
merge creates one ready immutable head `d693d210`; follow-on context selection
exposes the missing manifest-reference bug (`3d2841f0`). No composer send or
repeated merge is used to hide it. That original head/evidence remains unchanged;
metadata repair and subsequent native continuation have separate exact inputs.
The user's later desktop notifications supersede the earlier A SSO/B lock facts.
A continues that same original merge using the real external public AX selector,
then the original composer's `AXButton` labelled `发送`. The one request
`r_2D083507-9F5D-4066-92ED-086DCAC995C5` reaches submission160; provider5→7
contains both branches and the selected six resources, and the actual local skill
produces the expected binary result. The pending and terminal Outbox keep the
original context/resource selection. No second merge or replacement request is sent.

Finite A receipt `physical-v6/physical-A-native-final.json` (`a0ca410d`) binds the
actual701-source Node copy, its separate749-file map (retained v4 docs), the
unchanged App/helper binaries and six compiled native modules. After actual owned
App96585→55452 and daemon38270→55513 restart, the complete SDK export and Outbox
bytes are unchanged, the original selection/request remain, and the real window
restores both branches and the original answer. Provider/task/submission/local-run
counts do not increase. EOF cleanup required a verified-PID SIGTERM to that owned
App only; the true process termination remains in the raw log.
Read-only supplement `physical-v6/physical-A-to-B-passive-supplement.json`
(`7b7f6794`) then binds physical B's product-synchronized complete export of that
same A native head and all six resources. B provider stays3 and its persisted
task/submission/local-run counts do not increase. It creates no B context or run
and does not substitute for B's own native controls.

Reviewer/Lead accept this finite A scope as `a0ca410d` + input supplement
`421f922c` + passive supplement `7b7f6794`, with no new P1/P2. The file named
`A-instance-after-restart.log-prefix.jsonl` contains the earlier instance prefix
only through10:21:54Z; its name does not make it the10:55 restart-event log.
That actual restart is evidenced by original control loge42b3b00, persisted
before/after exports/Outbox/counts and actual AX transcript. The old prefix and
the three exit0/four exit1 preparation records remain unchanged; no rerun is needed.

B's actual owned target is PID42619, separate from the other candidate App66554.
Its first Swift interpreter read timed out before producing AX evidence. The next
existing authenticated bridge operation returned `denied/revoked_agent` before
App activation. Both preparation failures remain original evidence, without a
product-red claim or B GUI pass. Root then formally hands off the current same
caller/target identity: fresh operations transfer the exact bounded AX helpers
and activate owned App42619 successfully. The next actual external AX read fails
at `AXIsProcessTrusted()` (helper exit-5), before any control press. Finite boundary
`physical-v6/B-native-AX-boundary.json` (`ff597b09`) keeps the old denied operation
and the new actual trust rejection separate. Service changes no TCC permission,
does not retry the old operation or ask for another unlock. The existing public
same-window hitTest observation reaches the real text field but only a hosting
group at the library tab; it does not certify selector/button success.
At that historical boundary, two-Mac native acceptance was pending actual B controls.
Root's later TCC attribution identifies the responsible Accessibility client as
`/Users/mengxionghan/Applications/Eagle Device Candidate.app/Contents/Library/LaunchServices/EagleDeviceHelper`,
not the owned window or its AX child. Its Identifier is
`EagleDeviceHelper-55554944ad1283820097373fb6dec9eca32eee2f`, cdhash
`6793046d963ff72bee66141349f9c9d770e7c530`. Root owns the single user handoff for
that exact helper; Service does not change permissions or test other entries.

After the user's permission change, one public no-prompt `AXIsProcessTrusted`
call returns true at19:17:33 through that same responsible host PID67663;
operationbe8782f6 and receipt4a838650 bind its exact parent chain/path/signature.
Finite `physical-v6/physical-B-native-final.json` (`482935b0`) then binds the actual
B selector choosing already-ready A native head2f685a07, explicit same-head
resources, and one real composer's labelled send-button press. Original request
`r_421B189D-6923-4F1D-A143-F34B74356D66` settles as submission171/e_178;
provider3→5 contains original A+B history and A's latest native continuation.
All six resource bytes and actual B local skill output match. No new merge or
direct `replica/run` API replaces the controls.

Same-identity App5198→6962 and daemon68572→6987 restart preserves the complete
SDK export, Outbox bytes, selected context/resources and original request; the
actual AX transcript restores its answer. Provider/task/submission/local-run
counts remain unchanged. A's passive before is captured before B's original
send; the complete new head e8f5a483 and resources arrive with those execution
deltas0. Actual B701-source copy/separate749 map, App/helper binaries and six
compiled modules are bound independently of root input snapshots.

The18 new records preserve10exit0/8exit1. The first driver misread the press
helper's action-before tree; later selection was durable while the original
reader's one-window assumption and harness snapshot failed. Cause remains
unassigned. Before any send, only the verified owned App is restarted, preserving
identity/data/daemon/selection/counts. Both this and the final restart retain the
actual EOF7s/precise-owned-PID SIGTERM cleanup events. Sample/output-capacity and
later byte-transfer failures retain their real scopes. The interrupted read-only
chunk is queried by its original operation ID, then joined with prior raw chunks;
no native request or physical action is replayed. B's finite scope and final
docs/tree now go to the existing Review; no additional source/gate round is implied.
