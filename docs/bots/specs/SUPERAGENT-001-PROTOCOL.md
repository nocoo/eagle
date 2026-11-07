# SG-001 local protocol and implementation decisions

Status: **implementation contract, frozen for SG001-A and SG001-B**.
This document completes the engineering choices in [SG-001](SUPERAGENT-001-CHAT.md).
No worker protocol, credential or storage is used.

## Process foundation (SG001-A)

- Independent npm package: `apps/superagent`, not a root workspace member. Entry:
  `node scripts/serve.ts --root <absolute-root> --port <port>`. Node >=24; own lock
  and check gate. Runtime will pin pi-durable/pi-ai/chord to 1.4.0, matching the
  inspected SDK, without importing any worker source.
- Development default: `~/.local/share/eagle-superagent-dev`, loopback port 43127.
  Packaged profile uses `~/.local/share/eagle-superagent`, port 43128. The App/CLI
  may override through `SUPERAGENT_ROOT` and `SUPERAGENT_PORT`; tests always use
  isolated temporary roots and kernel-assigned service ports (`0`).
- Canonical root has mode 0700 on creation. Existing roots must be owned by the
  current user with mode 0700; unsafe roots are refused, never repaired.
  A nonempty foreign root is refused
  before credentials or identity are written. Root-owned files are private 0600.
- `identity.json` contains `{service:"eagle-superagent",storeId:<uuid>}`. A malformed
  existing identity fails closed. Identity survives process restarts. The fixed
  UI identity is `superagent`; it is not a worker Bot ID.
- `<root>/token` contains a cryptographically random bearer, created once with
  exclusive creation. Existing unsafe/nonregular/symlink credentials are refused;
  never repaired or logged. Later clients read their explicit Superagent credential,
  never a worker token. There is no `--token` argument.
- Kernel listener lock: TCP `127.0.0.1:(47000 + first32(SHA256(canonicalRoot)) % 1000)`.
  It is acquired before identity/storage access, independent of service port.
  A collision refuses startup; no stale lock file or takeover. SIGKILL releases it.
- HTTP binds only 127.0.0.1. Reject browser `Origin`, non-loopback Host and unknown
  routes. Public health is bodyless: Content-Length above zero and all chunked
  bodies are refused with 413. No credential appears in a URL.
- `GET /v1/health` returns `{service,version,protocolVersion:1,pid,instance,storeId,
  rootBinding,modelReady,failure?}`. Optional failure uses the same `{code,id}` as
  snapshots. `instance` is a fresh UUID per process; rootBinding is
  SHA256 of the canonical root. No absolute root, credential or prompt is exposed.
  No model is necessary for readiness.
- For client identity verification, a request may include `X-Eagle-Challenge`, a
  32..64-character hex nonce. The response adds `proof`, HMAC-SHA256 with the root
  token over `nonce + "\n" + endpoint + "\n" + rootBinding + "\n" + instance`,
  where endpoint is the server's actual `127.0.0.1:<bound-port>`, not a request
  header. A relay at a different port cannot reuse that proof. Authenticated chat
  and configuration stay on the same verified WebSocket connection; HTTP health
  verification is never cached as authorization to send secrets on a new connection.
  Clients reject redirects and verify a fresh challenge on every connection.
- Startup stdout emits one credential-free JSON ready record with service, port,
  instance and pid. Diagnostics use fixed categories, never exception/provider text.
- SIGTERM/SIGINT stops admissions and closes owned resources. Runtime close budget
  is six seconds; App grants eight seconds before SIGKILL of its own still-live
  child and waits for exit. An unconfirmed close retains the root lock until exit.
  App startup readiness budget is ten seconds; timeout cleans up its live owned
  Process even if health never verified. No stored PID is sufficient. These
  deadlines do not control worker processes.
- App ownership uses its live Process object plus verified instance/root identity.
  A verified pre-existing service is external and never stopped by the App. No
  persisted PID alone authorizes a signal. Multiple windows share the App host.

## Chat transport decision (SG001-B)

Use one authenticated WebSocket for commands and whole-snapshot streaming, with
HTTP only for public health. A fresh server proof is checked on that same socket
before authentication/configuration; no identity proof is transferred across a new
connection. Reuse the installed `ws` library, not a custom socket implementation.
Snapshots carry actual committed partial model content from pi-durable. Every frame
is a complete bounded current window, so replacing state tolerates skipped
coalesced revisions without losing text; no second delta engine is needed. Precise
message, submission, configuration and error fixtures accompany B.

### Wire v1

WebSocket path `/v1/chat`. No query string, redirect or browser Origin. Maximum
frame 256 KiB; unauthenticated lifetime five seconds; at most 16 clients. On each
new connection:

1. Client sends `{type:"hello",nonce:<32 hex>}`.
2. Server sends `{type:"challenge",identity:<health identity>,serverNonce:<fresh 32 hex>,proof}`.
   Server proof is HMAC over clientNonce, serverNonce, actual endpoint, rootBinding,
   instance, separated by LF. The server nonce is fresh per socket and consumed once.
   Client checks service, protocol, configured root binding and proof on this socket.
3. Client sends `{type:"authenticate",proof:HMAC(token,"client"+LF+clientNonce+LF+serverNonce+LF+instance)}`.
4. Server sends `{type:"ready"}`, then a whole snapshot. No bearer is transmitted.
   An invalid proof closes 4001; protocol violations close 1008. Replaying a prior
   authentication frame on a new socket is refused even if the client nonce repeats.
   HMAC keys are UTF-8 bytes of the stored lowercase hex token, not hex-decoded bytes.
   LF means byte 0x0a, never literal backslash-n; nonces/proofs are lowercase hex.
   Golden vectors and JSON samples live in `fixtures/superagent-protocol/`.

Authenticated commands have a caller-owned `id` (8..64 `[A-Za-z0-9_-]`). Durable
`requestId` uses exactly the same length and character grammar. Submission IDs
are `s_<positive integer>`, the same identity used by queued previews.
Challenge identity contains service/version/protocolVersion/pid/instance/storeId/
rootBinding; modelReady/failure belong to health and snapshots, not that identity.


| Command | Fields | Result value |
| --- | --- | --- |
| `state` | `type,id` | Versioned snapshot envelope (`instance`, `rev`, `value`), not an unversioned reducer update |
| `configure` | `type,id,configuration:{baseUrl,model,thinkingLevel,apiKey?}` | Public configuration; absent key keeps existing, empty key clears it |
| `send` | `type,id,requestId,text` | Durable submission; dedupe is by requestId, not transport id |
| `submission` | `type,id,requestId` | That durable submission, with answer text when done, or null |
| `history` | `type,id,before?:positive entry number,limit?:1..100` | `{messages,nextBefore?:number,hasMore,coverage:"complete"|"partial"}`; oldest-first within the requested earlier page; unavailable data is an error, never an empty success |
| `abort` | `type,id` | `{stopped:true}` after previously accepted active/queued inputs are terminal; normal completion winning the race remains done, never relabelled aborted |

Replies are `{type:"result",id,value}` or `{type:"error",id,code}`. Codes are fixed:
`invalid_command`, `unauthorized`, `unconfigured`, `busy`, `limit_exceeded`,
`storage_failed`, `internal`, `shutting_down`, `cancellation_unconfirmed`. Failures never reflect upstream text.
Unknown fields or commands are refused. No delete, worker or generic execute command.

Broadcast: `{type:"snapshot",instance,rev,value}`. Revision is per process and
monotonic; instances reset the client's baseline. Every snapshot wholly replaces
its newest window, not previously fetched historical pages. Coalescing/skipped revs
are valid because no delta is required. Historical pages are discarded on reconnect
or a changed live-window oldest boundary; clients show that older history must be
loaded again, not a silently merged gap. A slow socket retains only the newest
snapshot; sustained overflow closes it, and reconnect starts from a fresh snapshot.

Snapshot value: `{botId:"superagent",messages,pending,running,modelReady,
configuration,window,failure?}`. `window` is `{oldestEntryId:number|null,
newestEntryId:number|null,coverage:"window"}`; it certifies only the supplied window.
`failure` is `{code,id}`; id is a nonempty string identifying one failure episode,
not a request ID. The same episode keeps its ID across SDK report/close channels.
Fixed codes are `storage_failed`, `task_parked`,
`model_timeout`, `model_authentication`, `model_error`. Runtime failure also appears
in public health; modelReady only means configuration is present, not runtime health.
Provider text never crosses this boundary. Known SDK timeout/HTTP 401/403 error
patterns map to the corresponding safe code; unclassified provider failure is
model_error, never guessed into success. Configuration is null or `{baseUrl,model,thinkingLevel,
hasApiKey}`; never the key. `pending` holds bounded previews of queued inputs.
Message: `{id,role:"user"|"assistant",text,state:"complete"|"streaming"|"error"|"aborted",
createdAt,requestId?}`. createdAt is epoch milliseconds. Entry IDs are `e_<number>`,
partial IDs `p_<attempt>`. Queued previews are `{id:"s_<number>",requestId,text}`.
Error text is a fixed notice; hidden reasoning and arbitrary tool content are not
part of this chat-only display contract. Every truncated text ends in `\n[truncated]`.

Submission: `{id,requestId,status:"queued"|"placed"|"done"|"unanswered",entryId?,
answerEntryId?,answer?,reason?}`. Re-sending an existing requestId returns its record
even when the model is now unconfigured or the queue is full. Only a genuinely new
submission consumes budget. A lost acknowledgement is unknown, not permission to
use a new ID. Clients persist pending sends in their own store until admission is
confirmed; disconnect does not abort accepted work. `queued` has no entry IDs;
`placed` has entryId; `done` has entryId/answerEntryId and answer when retained;
`unanswered` has optional entryId and a required reason. Reason is one of aborted,
withdrawn, stale, model_timeout, model_authentication, model_error, run_failed.

Abort closes the admission gate synchronously when the runtime accepts the command;
previously accepted admissions drain before cancellation starts. New sends/configures
are refused busy while it is outstanding. Confirmation waits at most five seconds;
the five seconds starts at runtime acceptance, including admission draining and
terminal persistence. Timeout returns cancellation_unconfirmed while the original
cancellation continues; its admission gate stays closed until that operation settles.
No automatic resubmission/abort replay occurs. A disconnect is unconfirmed. Already
completed submissions keep their original result. No new input is included in the
original cancellation target.

### Configuration, bounds and persistence

`configuration.json` is a private atomic file in the Superagent root, never the
worker gateway file. Only a verified socket can update it. App Settings and scoped
CLI configure the service; they share no worker bootstrap. An update while a run
or queued input exists is refused `busy`, without writing. Provider id is the
internal constant `superagent`; one configured OpenAI Responses endpoint/model is
registered with the SDK. No discovery, environment credential lookup or fallback.
URL is http/https without credentials, query or fragment; localhost is valid.
Thinking levels are off/minimal/low/medium/high/xhigh/max, passed explicitly.

Input: nonempty, at most 8000 code points. At most 16 outstanding inputs per
conversation. Model window 200000 tokens, response cap 8192, stream timeout 120 s,
transient retries 2, native crash restart limit 5, afterFailedRun `continue`.
No tools, extensions, execution environment or autonomous submissions are installed.
Native compaction is enabled; older entries remain accessible through history.
Whole snapshots/history pages keep at most 100 messages and 192 KiB; one displayed
text is capped at 32000 code points with a marker. Queued previews are capped at
160 code points. The runtime keeps only bounded presentation state; pi storage
remains the complete durable authority.

Own chat history uses numeric immutable entry boundaries (`before` is exclusive),
so newly appended entries cannot shift older pages. `hasMore` means more entries
remain in the requested earlier range; nextBefore exists exactly when hasMore is
true and is its next exclusive boundary. `coverage:complete` means that requested
range is exhausted and returned text is not truncated. Any hasMore or truncated
text makes coverage partial, including a truncated last page with hasMore false.
Unavailable history is a command error; complete never certifies newer history
outside the requested boundary. A corrupt storage/configuration
fails closed. Runtime failure is visible in snapshots/health; there is no silent
new-session creation. SDK native recovery may retain an aborted partial plus the
completed attempt; this is not duplicate admission.

The service owns only one permanent conversation and no executable tools. Its
store, runtime and transport are independent from Bots. Snapshot/history admission
and cancellation semantics must implement SG001-R06/R07/R08 exactly.

## Native and CLI ownership (SG001-C, frozen)

- `apps/superagent-macos` owns SuperagentCore, SuperagentTransport and
  SuperagentFeatures. Features depends on Core ports, not worker logic or network
  objects. EagleFeatures composes native EagleDesign views; EagleCLIKit uses the
  same independent transport, not Bots DaemonClient.
- Development defaults are root `~/.local/share/eagle-superagent-dev`, port 43127;
  packaged release root is `~/.local/share/eagle-superagent`, port 43128. Explicit
  `SUPERAGENT_ROOT`/`SUPERAGENT_PORT` override them. `SUPERAGENT_TOKEN` may provide an
  explicit credential; otherwise the scoped client reads this root's private token.
  There is no EAGLE_TOKEN, worker config, worker token or global Pi credential fallback.
- Token and root permissions/owner are validated before use. The client verifies
  service/version/root binding, fresh nonces and endpoint-bound proof on the same
  WebSocket before authenticating or configuring; redirects are refused.
- Commands: `eagle-dev superagent health`, `config show`, `config set --stdin`,
  `chat send --text TEXT [--request-id ID] [--wait] [--timeout SECONDS]`,
  `chat history [--before NUMBER] [--limit N]`, `chat watch`, `chat stop`.
  Each supports `--json`. Configuration JSON arrives on noninteractive stdin,
  bounded at 64 KiB; no token/API-key flag exists. Exit codes retain Eagle's
  0 success / 1 service or wait failure / 2 usage / 3 credential/identity refusal /
  4 unreachable meanings. Wait timeout never aborts/resubmits model work.
- The scoped namespace is dispatched before loading any worker CLI configuration.
  A send exits successfully only after durable admission; --wait additionally
  requires its own submission to settle, not an unrelated stream event.
- App Settings has an independent Super Bot page. It reads public configuration
  through its own client; a blank key keeps the saved key, and an explicit clear
  action removes it. No worker gateway file is imported. Native settings can be
  reached directly without first opening the worker settings page.
- App owns one shared process host; each window owns its chat ViewModel/client.
  Closing the last window does not quit the App. Explicit Quit awaits the bounded
  shutdown of owned Superagent work, then permits termination. No PID-only adoption.
- Source-run acceptance can set `EAGLE_DISABLE_WORKERS=1` to omit the worker/device
  startup and connection tasks entirely; normal defaults preserve existing worker
  behavior. This switch is not a worker protocol or an automatic fallback.
- App pending inputs persist only in its own private outbox. Reconnect queries
  their original request IDs; an unadmitted/unconfirmed send needs an explicit
  user retry with that same ID, never a new autonomous model turn on reconnect.
  Confirmed inputs leave the outbox. Historical caches reset on reconnect/window
  boundary change as above; the main transcript remains the authoritative window.
- Native UI uses source-qualified selection `superagent:main`, distinct from worker
  Bot IDs. The system row cannot be renamed, moved, hidden, unpinned or deleted.
  Unimplemented attachments, microphone, task promotion and inspector controls
  are absent, not inert actions. Status/error/model readiness are visible text.

## Gates

Foundation: real process/HTTP/root ownership/authentication tests; strict typecheck
and check-only Biome. Add coverage with the runtime slice and enforce the project's
95% four-metric unit target over owned logic rather than excluding failures.
The exact executable gate lives in `apps/superagent/package.json`. Root unrelated
workspace checks must not silently import this independent package.
