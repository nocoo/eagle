# Authenticated persistent replica status

This document retains the all-path status slice contract and its dated execution
records. The all-path slice was delivered as `193f75bd` / tree `73695d14`, single parent6575f53f;
accepted source-v2863cd483 and final25b2ea37 close its Review, normal hooks and
own-ref/tracking checks. Direct/cache/relay receiver reporting and sender reads
are implemented. `peerApplied` remains unknown when the current complete key has
no authenticated snapshot; received/applied/cloudCached stay separate.

Later paragraphs about pending candidates or physical route prerequisites describe
those earlier stages, not current progress. Scene5 is accepted only with
f5b7827b+6766880e+timing38377da4 (application direct over Tail DERP, owned Miniflare
cache fallback/return). P5 source-v6/normal gates and finite A native/restart are
accepted, as are finite B native/restart/passive482935b0 and final Review/tree
binding. B's pre-send interruption remains cause-not-assigned. See
[current architecture](SYNC-ARCHITECTURE.md),
[PLAN](PLAN.md) and [SYNC-NATIVE](SYNC-NATIVE.md) for present scope, and
[TESTING](TESTING.md) for original runs and failures. Historical common baseline182fc1f
is distinct from the upstream8674 and subsequent fixed19f4 integration for PR112.

The smallest connection uses two additional typed metadata operations,
`status-report` and `status-read`, through existing Node manage, Registry authority
and named service-binding verification. They use distinct operation/digest-bound
short authorities; old relay/cache authorities cannot authorize them. No signer,
session token export, persistent ACK queue or data-read reverse grant is added.

- `POST /v1/bots/:id/sync/relay/status-report {peerDeviceId}` reads the same ready
  handle's actual durable status. Callers cannot supply a binding or cursors. It
  reports at most128 original-source received/applied pairs, with full receiver
  binding. The requester is the receiver; current holder→receiver grant applies.
- `POST /v1/bots/:id/sync/relay/status-read {peerDeviceId}` independently reads
  authenticated reports as holder/grantor under that same directed grant. It
  returns bounded full-key snapshots and an explicit truncation indicator. An
  unknown current receiver binding stays unknown; exact old binding snapshots
  are timestamped history, not progress of a new replica.
- Independent Worker `/v1/relay/status-report` and `/v1/relay/status-read` strictly
  validate/recompute the actual request digest before Registry RPC. The Registry
  checks the operation, session, both complete current identities and directed
  grant. Worker compares claims with its actual sharedBot namespace/peer/operation,
  then rechecks current authority and deadline at publication/supply.

DO SQLite stores only metadata keyed by registryOrigin, sharedBotId, complete
holder/receiver identities, receiverBinding{localBotId,sharedBotId,replicaId,epoch}
and original source{replicaId,epoch}. Same-key received/applied updates are monotonic
and idempotent, with a server recording time. Different device/binding/source/epoch
cannot share a cursor. Receiver reports are trusted current-device statements;
old direct AEAD receipts are not presented as independently verifiable apply proof.
Actual SQL errors retain cause at the owned layer and one bounded503 failure origin.
The status-report transaction boundary also preserves the original storage cause
and503 attribution. Existing CacheError refusals (including429 capacity) and
callback ZodError/SyntaxError protocol failures retain their original semantics.


Automatic receive/both preferences rebuild reports from persistent ReadyReplica
status; publish/both preferences independently read reports. One bounded metadata
action runs separately from inbound competition and cache upload. Failures do not
undo/delay applied data, local run, direct supply or cache publication. Restart
rebuilds reports from the original DB without another object get/apply. Offline
stored-object apply keeps its existing pin-only behavior and makes no Registry call.
The metadata path does not touch R2 or event retention clocks.

The implementation reaches contracts/device-relay, Registry authority, private
Node device-service, independent Worker relay-wire/relay, Bots DeviceSyncRelay,
AuthenticatedSync, HTTP selectors and AutomaticSync connection status. Swift's
existing typed host protocol needs no new signer or body transport. Complete-file
TDD covers real direct/cache/pending-apply paths, report/read outage and recovery,
grant/identity/binding/source/epoch separation and actual owned SQLite faults;
normal affected gates and independent Review follow stable source.

Current behavioral evidence is the original complete encrypted-objects file:
status-windows-third11/11,0skip/cancel,exit0,741 maps unchanged; log
5a82fd45df40fd4a22e36b7aa836f0591632b9ab45cf3089c89b14f6f1d2f870.
It covers actual direct/cache failures without blocking direct apply, independent
sender recovery, receive27/applied22 during real SQLite materialization failure,
local pendingApply recovery/get0, both status SQL faults with one origin, current
grant/final-RPC/namespace checks, distinct old binding keys and post-commit real
socket loss followed by cold report-only recovery. Component/static scopes and
the malformed-JSON fixture failures are separately recorded in TESTING.
Source-v1 f790dafc76543315269d02e875c4e66b9e19962a137afd5fcd7e365b1a7edb3f
binds697 canonical source entries,741 full paths and16 actual base deltas.
Normal root269, Bots916 ordinary/same coverage, Worker26 and complete devices33
all pass on that frozen source. gates-v1.json SHA8da2d96c binds their actual
logs/raw starts/exits; only subsequent final docs differ. Candidate binding and
independent Review/Lead acceptance remain pending; this is not delivery.

Physical direct→relay→direct PR scenario5 still needs two running genuine
Tailscale Self routes and publishable/listenable/reachable sync endpoints. The
owned LAN10.172.44.34 backend is not an allowed direct Self; no production
listener/candidate substitution is used. Cache/relay, owned72h and P5 are independent.
Official client preparation/login handoff belongs to Root and the user, not
Service. Physical scene5 remains unpassed until the genuine product route is tested.


Review P2 #1 paused candidate c0e6bb8d. The narrow repair now freezes source-v2
863cd483 (697/741, three source deltas), with complete-file boundary-injected
red1e1ddfa8→final green50a46c80. The real deferred-FK attempt532c94ef instead
reset the DO at its output gate; it is retained as a platform limitation, not a
synchronous commit red. The owned Error injection occurs only after the actual
callback/transactionSync return. Same cause/single origin, unchanged status/time
on retry and zero additional get/apply/provider/retention effects are verified.
Existing CacheError429/ZodError/SyntaxError preserve original semantics.
Normal root269/Worker26/complete devices33 and strict types/lint pass on v2.
The earlier gates-v1 paragraph records f790; new bindings are gates-v2.json SHA
1e856a377530d19a7f2238e12fc52cc083ed35d6fdb4a93b469935d3677ff216. Unchanged Bots/Swift/crash/eval keep exact prior scope. Final
candidate/Review acceptance and normal hooks/delivery remain pending.
