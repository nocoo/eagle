# Online holders, relay and actual apply receipts

This slice starts at delivered `01d90a70` / tree `9c0949f3`. Its authoritative
automatic-transport receipt is `.local/sync-p4-auto-transport/delivery/auto-delivery-final.json`,
SHAaecf6d4908129ae59b2469a648c9ffd9c2e72fc111ece460a18c0673550753fe.
All1934 references plus that final remain protected. Upstream182fc1f remains the
last update until synchronization completes; no fetch/pull/merge of newer input.

This is a finite relay slice, not complete P4. Direct and cache passive-apply
sender confirmation and connection-status peerApplied remain unknown. The next
accepted narrow contract adds current-receiver status-report/status-read from
real persistent status; it does not change this slice's old direct handshake.

## Finite interfaces

The independent Bots Sync Worker adds holder registration/discovery, a bounded
outbound WebSocket relay and actual apply metadata receipts. It imports no Eagle
Worker/Agent/contracts source. Dedicated local schemas and the root's independent
metadata schemas stay equivalent through wire fixtures and process tests.

- Private typed `sync.relay.authority` uses current DeviceCloud.manage/session
  through Registry `/sync/relay/authority`. Its finite operations are register,
  discover, exchange, ack and receipt query, each with a requestDigest. These are
  separate from replica.cache publish/list/get authority. No session token or
  generic signer is exported. Register describes only the current session's device.
- Named Registry service-binding RPC `checkRelayAuthority` checks actual operation,
  sharedBot namespace, full current identities, complete request claims/digest and
  the current holder→reader grant. Discover returns only currently authorized
  holders; registration/advertisements themselves are hints, not read authority.
- Worker `/v1/relay/connect` first accepts the 101 upgrade (at most32 sockets,
  unregistered for at most10s). The first ≤64KiB register frame must pass dedicated
  authority validation before the socket becomes a holder. Registration contains complete
  local binding, original sources/actual available ranges, generation and a bounded
  online lifetime. DO restart starts offline; persisted rows cannot revive sockets.
- Worker POST `/v1/relay/discover`, `/v1/relay/exchange`, `/v1/relay/ack` and
  `/v1/relay/receipts` carry bounded typed metadata or the existing challenge/object
  exchange. The Worker recomputes every digest from strictly parsed actual fields.
  R2 is untouched by relay; expired histories are neither recached nor refreshed.
- Local bearer/no-Origin relay discovery/read and receipt status ports expose the
  same owned ready-only operations for controlled integration. Automatic cache
  receive invokes them only for a truthful cache gap or missing source baseline.

## Transport and admission

Each page has a fresh existing challenge and mutually authenticated object
exchange; WSS is not a reusable crypto session. An explicit original source is
required for holder history: ReplicaStore.page supplies original epoch/seq/body/
resource bytes. A holder's recipient object is never treated as its publisher
object. The holder prepares its own immutable transfer object for that original
page; existing recipient slots, fixed pins and first-winner rules remain.

Direct generation and pending challenges remain isolated from relay generation
and one-use relay challenges. Self loss cancels direct only. Common daemon closed,
readySharedReplica alias rejection, same handle/full binding/tombstone, proof time,
current grant and actual object/slot/pin/receive use-point guards still apply.
No cold open/recover/run, helper body forwarding or remote management bearer.

Automatic holder registration retains its original connection preference and
captured ready binding across status, check, authority and socket awaits. Deleting
or replacing that preference, uncertain preference storage or daemon close rejects
late registration and supply. Legal renewal keeps the same configuration ownership;
finishing an independent upload or cancelling an inbound candidate does not cancel it.

Frames remain within the existing approximately11MiB object bound plus a small
strict envelope, below the DO32MiB message limit. Request/session/method/direction,
pending count/bytes, buffered socket output,10s request lifetime and cancellation
are bounded. Replacement/closed/old sockets cannot complete a current request.
The controller retains at most two inbound candidates including a direct probe,
and one independent cache upload. A probe and cache/relay work run concurrently;
cache→relay is sequential within that same candidate. Existing2.5s competition,
two authenticated completions at least15s apart and30s CF residence remain.
Pending local apply runs before any online work; unknown upload ID/72h logic stays.

## Discovery, gaps and receipts

Directory source/coverage positions come from real ready status and only suggest
where to ask. Queries and actual supply recheck current holder→reader authorization.
Empty cache/directory, a known upper bound or an empty page never certifies a full
baseline. All holders offline leaves needs_baseline/gap; a complete local replica
continues native run. SQL/I/O failures retain actual cause locally and one bounded
failure origin/trace/Bot, returning503 rather than auth/gap. Protocol, identity,
signature and digest refusals remain fail-closed and cannot start another route.

Post-apply ACK comes from the complete ReadyReplica.command(status), including
receiver device/full local binding, original source, received/applied/available
and the referenced request/one-use authenticated delivery session. It is not
cache ACK, local storage ACK or remote run completion. Dependency waits report
actual applied below received. ACK/receipt queries use the same holder→reader
grant in their respective roles; no reverse read grant is created or required.
Idempotent metadata persistence binds the receiver epoch and original source;
retries/lost replies/restart cannot invent progress or reuse an old epoch as a new
instance. Until an actual receiver confirms, peerApplied is unknown. A bounded
pending receipt can be reconstructed from the stored object and actual status;
this adds no drain API, generic queue, token or lifecycle framework.

## Local verification

First red reaches a missing relay metadata/transport interface through a real
paired Registry SQLite/Swift helper/independent Node/Bots prerequisite. Later cases
use A's original history/resources held by B, close A, remove/expire the cache,
and restore a new C through B's outbound relay. Verify original multi-page/source
bytes, branches/head/sections/pins, passive execution0 and explicit native success.
Owned barriers cover no holders, grant/identity changes, old sockets, SQL faults,
post-receive apply failure and actual ACK/retry. Existing direct/CF/stable-return,
disable/rebind/close and pending local apply cases remain. Miniflare/owned clock
evidence is not a deployment, physical Tailscale or elapsed72h claim.

## Stable local slice and remaining scope

Stable source-v1-complete088cf33d freezes697 selected inputs/740 full files and22
actual source deltas at base01d90a70. Its independent source patch/current/base
archives remain under `.local/sync-p4-online-relay`. Preliminary694 selection is
retained and explicitly corrected by including3 unchanged README inputs. This is
a preserved historical Review input, not a delivery receipt. Candidate911653b9 /
tree1a2fba9f was paused for the sole registration-ownership P2; its nonfinding scope
is independently closed. Source-v26ab23ace retains the same697/740 selection and22
base source deltas, with exactly5 changes from v1:3 Bots production modules and
2 owned test/fixture files. Full-file red/green and actual new normal gates plus
explicit old-scope reuse are recorded in TESTING and gates-v2.json. Incremental
Review/final candidate acceptance still precede normal delivery.

The real three-helper/Node/Bots/Registry/Miniflare chain restores two original-A
pages and a true B-source parent into C after A is offline and R2 is absent.
Exactly3 object exchanges, original143 A events/bytes/history/resources, passive0,
final native+2, cold pendingApply/receipt, lost reply and explicit expired-delivery
recovery are asserted. Original CF-only gap counters and late-socket/stage fences
remain. Miniflare/owned clock/barriers are local evidence, not deployed WSS,
physical Tailscale, a live multi-Mac run or elapsed72h.

Relay receipt does not update connection peerApplied or prove direct/cache sender
confirmation. The already authorized next finite slice adds current-receiver
status-report and holder status-read, from actual persistent full-binding/source
status, without changing direct proof or delaying native/apply. Then P5/P6.
