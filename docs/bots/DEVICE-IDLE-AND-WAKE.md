# Bots — shared-device idle and wake design

Status: **in progress**. Local-first startup, relay-origin binding, bounded
command timeouts and same-socket session renewal have landed. Remote tool refresh
is partial; target WebSocket hibernation and its idle savings have not landed.
The pre-change observations below are retained as a baseline, not a claim about
the current implementation. Existing wire and behaviour are governed
by [DEVICES.md](../DEVICES.md), [RUNTIME.md](RUNTIME.md) and
[PROTOCOL.md](PROTOCOL.md); [PLAN.md](PLAN.md) tracks delivery. A complete local
Bot is the baseline; remote discovery, execution and cloud connectivity are
optional enhancements, not prerequisites for local work. A visible device panel
is not the definition of Bot activity.

## Goal and boundaries

A Bot mostly works on its own computer. It must do so without configuring or
waiting for a remote service, while another paired computer can remain ready for
an occasional remote operation. A fresh installation with no remote address must
start its local device service and support local commands and files under the
normal local policy. When a Bot needs a peer, discovery and the first operation
should start promptly without a person opening a window. A running target helper
and its outbound connection are required; this design does not wake a sleeping,
offline or disconnected Mac and does not queue commands for its eventual return.

A device is both a possible caller and a possible target. An idle Bot or a closed
App window is not evidence that the device will not be targeted. The caller's
request connection is already on demand; the target's listening connection needs
to remain available independently of Bot and window lifecycles.

This is a fresh-cutover design: do not build a migration or compatibility path
for existing device identities, pairings, sessions, journal records, stored
observations or older device clients. Re-pairing may be required. This does not
authorize deleting unrelated Bot conversations or other products' data, nor does
it authorize a deployment or deletion of production resources. Before a future
cutover, stop or drain existing operations; never automatically replay an
uncertain old operation just because its old journal is unavailable. Within the
new system, operation identity and recovery remain durable across restarts.

## Implementation status

Source snapshot: `757e7be` on `opt-do`, reviewed on 2026-11-05. These are source
and local-test facts, not claims about the installed App or deployed Workers.

| Area | Source status | Remaining boundary |
| --- | --- | --- |
| Local-first baseline | Implemented: an empty relay starts the helper and local service without a cloud client; native Bot tools read local identity/policy and use admission, approval and the journal. Fresh local policy defaults to `always-ask`. | An enabled but unavailable protection service fails closed. A packaged fresh install and an arbitrary real model's choice of local tools have not been accepted end to end. |
| Remote tools | Partial: root selection refreshes on open, subscription and new input; app-managed children refresh at spawn/send, preserving local tools and the ban on delegation. Stale loaded calls recheck local configuration. | No configuration push before every already-running model request, no separate remote-disable control, and no complete child/nested restart-recovery proof. The settings toggle stops the local service, not just remote access. |
| Directory and panel | Implemented: discarded source-side `run/get/cancel` directory reads are gone. Bot discovery and fresh approval policy reads remain. Workspace observation reads local health; visible device views share directory observation. | No measured production request or billing reduction. |
| Remote identity and uncertainty | Implemented: operation, policy and pairing IDs are bound to their target and relay origin. Changing relay keeps local leases; post-forwarding authorization loss withholds output and returns `unknown`. A `sent` operation is not automatically re-executed or retargeted. | Cross-relay, restart and revoke behaviour is tested locally; no physical two-Mac acceptance. Unaccepted `busy`/`denied` runs may still be explicitly retried. |
| Sessions and renewal | Implemented: Registry stores session hashes and checks a target reference against expiry, device, credential generation and membership. The Worker and Agent renew on the same socket after key proof; in-flight work keeps its connection. | This reference is currently in memory, not a hibernation attachment. Renewal is preparation for hibernation, not hibernation itself. |
| Idle/wake | Not implemented: the target uses ordinary `socket.accept()`, a 10-second application heartbeat, a 30-second in-memory lease and in-memory pending maps. Heartbeats still wake Execution, check Registry and write Execution observation state. | Add hibernatable target sockets, bounded auto-ping liveness, safe wake/eviction and in-flight correlation handling. No idle latency or cost saving has been measured. |
| Long commands | Implemented: Bot-to-service command timeout is requested duration plus 95 seconds, 125 seconds by default and 395 seconds at the 300-second maximum. Timeout preserves an `unknown` original-ID receipt. | The long-duration socket test advances a simulated clock; a complete 300-second cross-machine run has not been verified. |

### Recorded verification

- Root `npm run check`: 309 tests passed for the Agent-renewal source; Bots
  `npm run check`: 1,022 tests plus coverage passed for the child-turn source.
- `npm run test:devices`: 11 passed. Three isolated scripted CLI eval rounds each
  passed 24 cases. The script proves tool/transport wiring, not a real provider's
  decisions. See [process tests](../../tests/device-integration/device-bots.test.ts),
  [root recovery tests](../../apps/bots/test/runtime/device-recovery.test.ts),
  [child tests](../../apps/bots/test/tools/agents.test.ts), and
  [session tests](../../tests/device-api.test.ts).
- Swift package runs reported 299, 52, 60 and 36 tests passed; the logic coverage
  gate reported 92.3%. The browser gate reported 191 passed and 11 existing
  desktop/mobile conditional skips. These are recorded executions, not a new run
  performed while preparing this snapshot.
- No production deployment, installed-App fresh-start acceptance, real-model
  evaluation, physical dual-Mac verification, Cloudflare hibernation measurement,
  live latency distribution or billing comparison has been completed here.

## Historical baseline (`25606ec`)

At that baseline, a packaged App injected a shared local device socket into the
Bots daemon. Existing and new Bots used the same host service; the separate Bots
package did not import Eagle implementation code. Once running, its local readiness
did not wait for cloud connectivity. The baseline App did not start that service
when its remote address was unconfigured; the current source has since changed.

```text
Bot on A -> local device socket -> device service on A
                                  | single request WSS
                                  v
                         target B's DeviceExecution DO
                                  | checks DeviceRegistry
                                  v
                         B's outbound agent WSS -> B's device service -> command/file
```

`remote_status` reads the shared directory, `remote_execute` binds an explicit
target, and `remote_operation` queries or cancels an existing operation. Before
sending, the Bot records an operation ID and target/digest; both source and
target services journal the operation. A target admits one new operation at a
time. Uncertain outcomes are queried on the original target and ID, not replayed
or moved to another machine.

The following observations describe source at `25606ec`, not a claim that every
installed client or live Worker runs that revision:

| Baseline path | Consequence |
| --- | --- |
| Packaged Bots receive a device socket even with an empty remote address; the App and helper do not start the service without that address | The socket is unavailable, so both remote tools and guarded local tools can return `device_unavailable`. The Node service also currently requires a URL and constructs `DeviceCloud` during initialization. |
| A socket path causes the runtime to install and always select the shared-device extension, whose prompt says the Bot can use a shared device group | Registration follows injected configuration rather than actual remote setup; the prompt can claim a capability that has never been configured. `core` and `coding` remain mandatory local groups. |
| The remote tool definitions have no `deferred: true` flag, but the extension inventory describes them as deferred | Source and documentation disagree about whether a configured Bot sees the remote tool schemas immediately. Child agents also persist the parent's then-current tool list. |
| `guardNativeTool` calls `directory()` before local `read`, `write`, `edit`, `bash` and `list` | Each local tool can request the cloud directory and its per-device observations before using local policy. Cloud failure falls back to local data only after the request fails; an individual HTTP request can wait up to 10 seconds. |
| A new local runtime with no saved policy defaults to `always-ask`, while `DEVICES.md` says the default is `all-approve` | Local startup and direct command execution cannot be specified honestly from the existing documentation alone. The default must be settled explicitly; neither outcome permits bypassing a chosen policy. |
| `getDirectory()` falls back to self with `cloudStatus: offline`, but the Bot adapter's directory schema drops that field | `remote_status` can show only the local machine without telling the Bot that the cloud directory is unavailable. |
| `remote_execute` reads the directory; the service reads it again before remote `run`, `get` and `cancel` | The latter result is discarded. `always-ask` additionally refreshes policy before signing approval. Removing an unused read must not remove a freshness or authorization check. |
| Every device service starts an outbound agent WSS; the agent sends a heartbeat every 10 seconds | Each received heartbeat checks Registry and refreshes the 30-second online lease. An idle but connected target still generates Registry RPC and writes observations. |
| The target relay uses `socket.accept()`, in-memory pending maps and `setTimeout` | It cannot use WebSocket hibernation as written. In-flight operation and policy correlations depend on that live instance. |
| The main workspace and device views share a five-second observation task while any is present | An open main workspace can query the cloud directory even when the device inspector is not being used. This is separate from Bot tool activity. |
| Each Bot-to-device channel has a 65-second timeout, while remote commands can request up to 300 seconds | A long operation can become `unknown` before its target finishes; a later query must use the original ID. |

Relevant source: [Bot device tools](../../apps/bots/src/tools/devices/tools.ts),
[Bot socket](../../apps/bots/src/tools/devices/socket.ts),
[device service](../../packages/agent/device-service.ts),
[device cloud client](../../packages/agent/device-cloud.ts),
[packaged helper](../../apps/macos/Sources/EagleDeviceHelper/EagleDeviceHelper.swift),
[App startup](../../apps/macos/Sources/EagleFeatures/DeviceSettingsViewModel.swift),
[Registry](../../apps/web/src/worker/device-registry.ts),
[Execution](../../apps/web/src/worker/device-execution.ts), and
[workspace observation](../../apps/macos/Sources/EagleFeatures/WorkspaceShellView.swift).

Read-only Cloudflare analytics for **2026-11-02 23:32 to 2026-11-03 23:32 UTC**
showed approximately 43,388 Registry invocations, including about 17,918 HTTP
and 25,470 RPC. Analytics are
adaptive-sampling estimates, not billed requests; they do not attribute those
calls to specific endpoints, Bots or UI views. Billing and storage usage were
not available with the queried identity. The counts are a baseline, not a
forecast or proof of the cause of each call.

## Target behaviour

### Local operations stay local

A standalone Bot without the optional device integration keeps the existing
native local tools. In the packaged App, start the local helper and device service
even when remote access is unconfigured or disabled: initialize local identity,
policy, journal and socket without constructing a cloud client. Remote settings
must not start, stop or weaken an enabled local policy. The shared port exposes
local identity and current local policy without a cloud request; native tools
retain trusted local admission, approval, serialization, journal and output
redaction. A missing remote configuration, cloud timeout or expired cloud session
must not delay or authorize local work. If an enabled local protection service is
actually unavailable or its policy is unknown, fail closed and identify that local
failure; never silently bypass it. Multiple Bots share the same local service.

Remote discovery is explicitly a cloud operation. Configuration state and any
`remote_status` result distinguish an unconfigured service or unavailable/stale
cloud directory from an authoritative group containing only the local machine,
without implying that local commands are unavailable. Unknown, offline and
unconfirmed policy remain distinct; no cached observation grants permission.
Before a new remote action, get current target evidence. The target and Registry
remain authoritative at dispatch.

For remote `run`, `get` and `cancel`, remove the discarded pre-dispatch directory
read only after proving the actual session and live membership checks remain in
place. Keep the fresh policy check needed to bind an `always-ask` approval and
recheck authorization and policy at the target. Avoid a new shared cache or
connection pool merely to optimize rare remote actions.

### Tool registration and model-facing semantics

The existing mandatory `core` and `coding` groups remain selected: `list`,
`read`, `write`, `edit` and `bash` are local tools, with one native implementation
per name and the current conversation's local working directory. Remote setup
must not register a second local runner, alter those tools' target, disable them,
or make `tool_search` a prerequisite for local work.

Treat local protection, remote configuration and transient connection state as
separate facts. A socket path alone proves none of them:

| State | Model-facing tools and instructions |
| --- | --- |
| No optional device integration, or remote access unconfigured/disabled | Local tools remain offered and usable under their local policy. Do not select, offer or make `remote_status`, `remote_execute` or `remote_operation` discoverable; do not claim a shared device group is available. If asked to use another computer, explain that remote access is not configured or enabled. |
| Remote access configured and enabled | Select the shared remote extension and eagerly offer all three remote tool schemas; accurately explain that they are for explicit remote targets. This capability is independent of `tool_search` and of Herdr or other optional groups. Configuration is not proof that any target is online or authorized. |
| Remote access enabled but cloud or a target is unreachable | Keep remote capability distinguishable from its current availability; discovery or execution returns a precise unavailable/unknown result. Local tool registration and local execution remain unchanged. |
| An enabled local protection service actually fails or its policy is unknown | Report the local protection failure and recovery path; do not claim that remote setup is needed and do not bypass the local policy. |

The local instruction says that inspecting or operating **this computer** uses
`bash`, `read`, `write`, `edit` or `list`; it must not first discover a remote
group. If no other target is requested or justified, local is the default. Remote
operations require an explicit device ID and must never silently fall back to
local or retarget after uncertainty. A remote discovery failure is not evidence
that local tools cannot run. Tool descriptions, selected extensions, model-offered
schemas, `tool_search` results and prompt sections must agree; prompts explain
the behaviour but are not an authorization boundary. Installed objects are not
necessarily selected; selected eager tools are initially offered; only selected
deferred tools may be discovered through `tool_search`. The existing
`health.deviceAccess` socket binding is not evidence that remote access is
configured, reachable or authorized.

Use the existing native Registry and tool-refresh mechanism, not a second tool
registry or cloud polling. On configuration changes, existing and newly created
Bots see the correct capability and prompt before their next model request,
without waiting for a window switch or a daemon restart. Temporary network
failure alone does not toggle the registered capability. A remote tool already
loaded in a conversation must not remain callable after remote access is disabled;
new dispatch also checks the current authorization at invocation, including in
child conversations that retained older SDK selections. Refresh the root and each
app-managed child before its next model request: update both its selected remote
extension and explicit tool filter, adding or removing only the three remote tools.
Preserve the child's other selections, its ban on further delegation, and the
reflection conversation's note-only scope; never widen them by copying the whole
parent tool list. Children created before and after a change see the same current
remote state. In-flight work is not silently repeated or retargeted when settings
change: settle it or return unknown and retain the original ID for authorized
recovery after re-enablement.

### Idle target, immediate wake

Use Cloudflare's WebSocket hibernation for the target agent connection. A target
helper stays connected through Cloudflare while the Execution DO is idle; a new
operation, a policy change or another meaningful event wakes the DO. Simple
application ping/pong can use `setWebSocketAutoResponse` without waking the DO;
`getWebSocketAutoResponseTimestamp` and the connected socket can supply bounded
transport-liveness evidence. Send policy/capability changes as real messages,
not as an implicit effect of a static heartbeat. The exact heartbeat interval and
staleness threshold must be selected and verified against real connection
behaviour before they become a contract; do not claim a tested latency yet.

An auto-response is only liveness evidence, not authentication, group membership
or permission. Preserve the 15-minute session expiry. For a hibernatable target
socket, its attachment holds the target ID, credential generation, session expiry
and the SHA-256 reference of the high-entropy session token, never the token itself.
Registry revalidates that reference against its stored session, expiry, current
device and credential generation through an internal-only RPC. The reference is
sensitive: do not expose it as a client credential, accept it from public requests,
or log it. After wake, expired or revoked sessions fail closed even if the socket
has answered pings. Remove the existing 30-second in-memory lease timer; derive
liveness from the socket and auto-response timestamp instead.

The target refreshes its short-lived session in-band before expiry, using the
existing key proof. Execution validates the replacement and changes the reference
on the same authenticated socket without replacing that socket or interrupting an
in-flight operation. A failed refresh never extends authorization. Before
forwarding, revalidate current source and target identities, membership, target
credential generation, policy and any operation-bound approval. Recheck the
relevant authority before returning a result. Revocation must fail closed even if
a best-effort socket notification is lost.

Hibernation discards in-memory state. Keep the instance active while an operation
or policy request is in flight, with bounded deadlines; hibernate only after its
pending correlation has settled. A runtime restart can still happen: source and
target journals must preserve the original operation binding and unknown outcome.
A wake, disconnect, replacement or restart must not deliver a late result to
another request, leak credentials or execute a command twice. The Execution DO
must not persist bearer tokens, terminal input or full command payloads merely to
hibernate.

A rejection **before forwarding** is unaccepted and may be explicitly retried.
After forwarding, loss of source authorization, session expiry or membership
before the result does not prove that the target did nothing. Withhold the output,
return `unknown` bound to the original target and operation ID, and never mark
that run retryable. If authorization no longer permits a result query, report that
fact without disclosing the result or resubmitting the run; an authorized query
can only use the original ID. The source journal must not mark that run retryable;
this post-forwarding change is already implemented, as noted in the status table.

The device panel refreshes on opening and after user mutations, and only while
its data is being displayed. Local helper health and recovery are independent of
cloud directory observation. Bot discovery and execution must work with every
window closed. A slower visible-panel cadence is a UI trade-off, not a prerequisite
for target readiness.

### Latency, timeout and measurement

Measure separately: local native tool admission with cloud healthy and blocked;
Bot discovery; source request to target admission/first execution evidence;
and operation completion. Report healthy warm and idle-wake distributions,
including p50/p95, sample count and environment. Human approval and command
runtime are separate from connection/admission latency. Establish a baseline
before choosing a numeric SLO; no claim of sub-second wake or savings is made.

Align the local channel, relay and target timeout budgets with the documented
maximum command duration. If a response is lost or a deadline expires after
possible admission, return `unknown` with the original operation and target IDs;
query the same ID rather than automatically running again. A timeout before
admission must not be reported as proof of execution.

## Delivery and verification

Implement in end-to-end slices, each with a failing behaviour test before the
smallest fix and its owning documentation/fixtures in the same commit:

1. Local startup and identity/policy path, plus explicit remote-unavailable
   evidence. First reproduce the empty-address failure on the packaged App startup
   path, then prove a fresh instance with no remote address starts its real local
   helper/socket and a Bot can run `bash` and read/write files without any cloud
   endpoint or directory fetch. Repeat with a configured but unreachable cloud.
   Verify paused and always-ask policies, genuinely unavailable local helper and
   helper recovery separately; never bypass admission. An `eagle-dev` CLI
   acceptance case must drive a Bot's local health-check command through the real
   local tool and show that a remote-discovery failure is not reported as proof
   that local execution is impossible. A scripted model proves the tools and
   protocol, not an arbitrary model's future tool selection; evaluate that
   behaviour separately. Replace the existing assertion that forbids local startup
   before a remote address is chosen with a regression for local readiness.
   Assert the actual selected/offered schemas, prompt and `tool_search` results
   for no integration, remote unconfigured/disabled, enabled and offline states;
   local `bash`/files remain available throughout. With remote enabled, assert the
   three eager schemas are offered even with Herdr and `tool_search` disabled;
   when remote is disabled they are neither offered nor callable. Exercise warm
   existing and new Bots and child conversations created before and after each
   enable/disable/re-enable, including a previously offered remote tool, an
   in-flight operation and recovery with its original ID. Assert child delegation
   remains blocked and reflection stays note-only. Verify a local
   health-check prompt uses local tooling without requiring remote discovery; a
   scripted fixture validates wiring, while real-model behaviour is reported
   separately.
2. Eliminate the discarded remote read. Prove discovery, fresh approval, live
   membership checks, original-ID recovery and `run`/`get`/`cancel` remain correct.
3. Hibernatable target and heartbeat. Prove idle wake and bidirectional real
   process/socket execution with the App windows closed; explicit instance-memory
   eviction followed by valid, expired and revoked session checks; in-band session
   renewal during a running operation; policy change and approval; revocation
   between awaits; disconnect/replacement and late replies; and long-running,
   lost-response, `get`/`cancel` and original-ID recovery. Hold a result after the
   target's side effect, revoke or expire the source, then prove the result is
   unknown, its output is withheld and the source never marks the run retryable.
   An operation is never replayed on reconnect or redirected to the local machine.
4. Restrict panel refresh to actual observation without disabling local helper
   health/recovery. Verify opening, closing and explicit refresh independently of
   Bot operations.

Update [DEVICES.md](../DEVICES.md), [RUNTIME.md](RUNTIME.md),
[EXTENSIONS-AND-TOOLS.md](EXTENSIONS-AND-TOOLS.md), [PROTOCOL.md](PROTOCOL.md),
the normative device fixtures and
[OBSERVABILITY.md](OBSERVABILITY.md) when their respective contracts change;
keep conversation protocol v1 additive and Bots independent of Eagle source.
Use existing layer tests and `npm run test:devices` for process boundaries, plus
`cd apps/bots && npm run check` and the affected macOS gates. Do not weaken tests
or report a simulated runtime as proof of real Cloudflare billing, hibernation or
physical multi-Mac execution. Authorized live verification should compare actual
Registry HTTP/RPC, Execution DO duration, device connectivity and wake latency
before/after under comparable workloads; do not infer savings from CPU time or
analytics invocation counts alone. Physical two-Mac acceptance is separate from
local integration tests.
