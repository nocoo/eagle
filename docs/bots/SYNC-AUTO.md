# Automatic transport for an already bound replica

This slice starts at delivered `abec9dbb` / tree `8fbe3651`. The CF72h explicit
cache receipt is `.local/sync-p4-cf72h-cache/cache-delivery-final.json`,
SHA069c8aed510a4247cb058bdec34df044d89e778ec3e2c9e477b31340944e22a8.
It preserves the fixed upstream182fc1f; no further upstream update is allowed
until synchronization completes. This contract does not claim full P4 or P5/P6.

## Local connections and actual state

The existing local bearer and no-Origin boundary protects these additive ports:

- `GET /v1/bots/:botId/sync/connections`: preferences and actual transport state.
- `PUT /v1/bots/:botId/sync/connections/:peerDeviceId` with strict
  `{direction:"publish"|"receive"|"both",source?:{replicaId,epoch}}`.
- `DELETE /v1/bots/:botId/sync/connections/:peerDeviceId`: disable this preference.

Receive/both setup first publishes the helper-owned descriptor through the existing
`sync.key.publish` typed port; no generic signing or network authorization is added.
PUT requires an existing healthy ready handle and the actual complete binding
`localBotId/sharedBotId/replicaId/epoch`, saved with the preference. It does not
open/recover a Bot, create a grant or infer a reverse grant. At most32 explicit
preferences across the daemon are persisted under owned `sync-connections/v1.json`
using stage/fsync/rename/directory-fsync. This mutable local preference has no
URL, bearer, key or authority. A missing/deleted/rebound/closed handle pauses old
work. Ordinary explicit local open/recover can make a matching preference usable.

Optional preference read/parse/permission failures pause automatic synchronization
and return the retained storage_failed from connection management. They preserve
the original file and do not prevent daemon startup or explicit local chat/run.
A write/fsync uncertainty also cancels unadmitted automatic work and pauses only
synchronization until restart; management cannot overwrite the uncertain file.
Core Bot/SDK recovery and already admitted native operations retain their existing
semantics. No automatic repair or additional recovery port is introduced.

`publish` means independent background cache upload and availability to authorized
pulls. It does not push directly or invoke a peer; direct delivery requires that
peer's receive preference. Current received/applied positions come only from
ReadyReplica.status/ReplicaStore. `cloudCached` reports only actual cache ACKs;
`peerApplied` stays unknown. Empty cache/hasMore=false is not complete sync.
Unknown remote source without direct access is `needs_baseline`.

Each connection retains at most one pending local apply objectId in the same owned
preference. Save it after full cache storage and before apply; on a later receive
turn retry the original local stored object before online work, and clear it only
after apply returns successfully. Restart retains the slot. Ready/full-binding and
attempt guards still apply; disable/rebind/close cannot revive an old preference.
An apply that successfully waits for cross-source dependencies clears the slot,
so this does not add ineffective retries or a new drain/status API. The independent
upload slot and original offline pin/open path are unchanged.

## Minimal assembly and admission

`src/sync-auto.ts` is assembled by main alongside AuthenticatedSync and the
listener. It owns standard timers, one inbound competition of at most two
candidates per daemon and an independent one-upload slot. Each turn handles one
bounded page or object and rotates preferences/sources; no generic task queue or
scheduler is introduced. Main close synchronously stops timers and invalidates
attempts before waiting on original lifecycle cleanup; helper/network cannot
hold local exit. Self changes invalidate direct sessions only.

An optional internal attempt context carries AbortSignal and a synchronous guard;
it is never parsed from HTTP or peer wire. Existing authorization/time/generation
and ready-handle/full-binding/tombstone guards compose with it at final object,
recipient slot and accepted pin publish and ReplicaSync receive. Status guards
after its scan. Losing/disabled/closed attempts cannot publish or apply. An
operation already admitted to store.receive completes under existing semantics.
Upload is a separate slot and is not cancelled when an inbound route wins.

## Direct preference, fallback and stable return

Use existing `/v1/sync/page` wire. A full authenticated page exchange can be
performed without local apply for a probe. A challenge, TCP connection or local
proof signature alone is not a successful probe. An available direct route is
preferred. No qualified endpoint or actual fetch/body-I/O failure starts cache
immediately; a2.5s soft connection/handshake deadline starts a cache competitor.
That deadline begins only after current private access returns a qualified
endpoint, and ends after the authenticated page response/current authorization;
private-channel or SDK waiting does not start a network timeout.
Only the winning attempt may admit publication/application. Active abort is
separate from transport failure. Remote bounded code/status/failure provenance
survives exchange; Registry/private-channel SQL503, identity/grant refusal,
bad JSON/signature/digest and protocol errors do not authorize fallback.

While on cache, probe direct every15s. Require two complete authenticated
successes at least15s apart and at least30s cache residence before returning to
direct. A failed probe resets the streak. Probes do not pin, apply or execute.

## Upload scanning, cache scanning and gaps

Background upload proceeds even while direct is healthy or incomplete. The local
cachePublish result adds the actual immutable manifest's `source`, `included`
and `nextAfter`; the Worker publish response stays unchanged. Advance only from that
ACKed object result. Keep the failed object's ID for an unknown-ACK retry; never
re-pull or increment after by limit after ACK. Event expiry may skip old events
for scan progress only, recording the gap and never claiming them cached. An old
mixed page must be split at the expired boundary so fresh events still publish;
retrying an unknown old result cannot restart its event clock.

Receive cache scans use exact known source and a bounded event window (limit128).
The Worker adds `nextAfter` from the last sequence actually selected and inspected
by its SQL window (empty keeps after), alongside hasMore. Included remains the
whole immutable object. Node never derives scan progress from included. Objects
are deduplicated in a pass. A forward cursor alternates with bounded earliest-gap
revisits so held suffixes and new tails do not rescan all received history.
Verified owned objects plus actual available ranges avoid repeated downloads and
ineffective apply. Missing received facts retry through the stored object; the
existing core drain already loops all sources for new dependencies. Source rotation
allows dependencies to catch up. Scan progress cannot update received or
applied. Empty results remain incomplete. The current [SYNC-RELAY.md](SYNC-RELAY.md)
slice adds online-holder discovery/expired-or-missing-cache reread and only
relay-delivery-associated receipts. Direct/cache sender ACK and connection-status
peerApplied remain unknown until the next status-report/status-read slice, before P5.

For upload ACK loss, persist the exact prepared objectId and immutable source,
seq/eventDigest list and nextAfter before the request. Retry that objectId through
authority refresh, unknown outcomes and daemon restart. Generic410, authority
expiry and I/O do not advance or split it. Only an authenticated explicit
`sync_cache_event_expired`410 releases the retry into expiry recovery. A mixed
manifest then fixes a `splitThrough` bound to that original window's nextAfter,
keeps its original after, and inspects single-event pages within that window.
Single-event TTL refusal can advance only the matched original seq/digest and
records an expired gap. A fresh event advances only after actual cache ACK.
Once scan reaches splitThrough, ordinary128-event/8MiB pagination resumes.
This exception does not occupy the independent inbound slot, never refreshes old
event clocks and never marks skipped events cached. Local native run never waits.

## Verification boundary

First red uses the existing real paired Registry/Swift/helper/two-Node fixture,
actual directional grant and bound ready baseline, then the new local connection
port. Archive exact loaded test bytes for each new red. Narrow cases cover TCP
refusal/truncated body versus auth/SQL/bad JSON; actual stage/use-point races;
stable switchback; independent upload;8MiB pages and72h old/new boundaries.
The real automatic staggered chain keeps original history bytes/head/sections,
zero passive provider/submission/task/peer/PR increments and explicit native run.
No physical Mac, live CF/App or deployment evidence is implied.
