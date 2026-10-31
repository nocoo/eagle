# P4 bounded encrypted cache contract

This local source/Miniflare slice starts at delivered ee26b2bb/tree92d79c1e.
Automatic fallback/switchback follows separately. No CF deployment/public bucket,
presigned URL, physical Mac or installed App is verified here. Fixed182fc1f is the
last upstream until overall sync completes; no newer fetch/pull/merge.

## Additive ports and independent build

- Node private `sync.key.publish {}` obtains the existing typed descriptor from
  the helper's successfully persistent eagle-bots-wrap-v1:<profile> key, then
  publishes metadata; it never signs a caller key/payload. `sync.key.lookup`
  takes strict {sharedBotId,peerDeviceId,purpose:"replica.read"}. B obtains
  offline A's descriptor only through current B→A grant.4096B vault unchanged.
- Session Registry endpoints `/sync/keys/publish`, `/sync/keys/lookup` and
  `/sync/cache/authority` are additive. Descriptor rows bind full current
  SyncIdentity, including group/membershipEpoch/credentialVersion. Verify both
  incoming and saved full signatures, compare unsigned bodies, return the
  original same-body winner. A different wrapping body in one context conflicts.
  After crypto await, transactionSync rechecks session/current identity.
- Node `sync.cache.authority` accepts only version1, operation publish/list/get,
  sharedBotId, peerDeviceId and requestDigest. Publish uses B's uploader session;
  list/get uses A's reader session. Short opaque dedicated authority binds exact
  operation, query/object digest and full current uploader/recipient identities.
  Registry stores only hash/expiry/metadata. Fixed service-binding RPC rechecks
  current identities and B→A grant. No exported session token/generic signer.
  Receiving requires neither B online, B's former session nor upload authority.
  Short authority expiry never becomes the object's72h retention expiry.
- `apps/bots-sync` owns the independent Worker/build/strict v1 codecs, one SQLite
  Sync DO per sharedBot and ciphertext-only R2. No Eagle Worker/Agent/contracts
  imports. Tool versions reuse installed selections, no generic key/token/runtime
  framework. API POST `/v1/cache/publish`, `/list`, `/get` uses exact-operation
  authority. Publish carries existing signed manifest/descriptor/envelope and
  bounded ciphertext; list uses bounded source/after/limit; get exact objectId.
- Bots local `/v1/bots/:id/sync/cache/publish`, `/list`, `/receive` is additive.
  Trusted daemon configuration owns the endpoint; no caller URL/IP/token. Direct
  pull/object/apply is unchanged. Cache does not depend on Self/listener generation
  or temporary direct proof. Closed/current-auth/full-binding/same-handle/tombstone
  actual-use fences remain. Stored objectId offline apply retains its old pin.

## Immutable persistence and72h

Original page/SDK JSON field order,8MiB plaintext/128 events/private512KiB limits,
objectId derivation, persistent object+self-envelope first-winner and append-only
recipient slots remain. Only controlled metadata is canonicalized; page/event
hashes use original JSON bytes. Read an existing logical object before random
DEK/nonce generation. Fresh objects use independent keys, not stream-key rotation.

Event primary key is exactly (sharedBotId,replicaId,epoch,seq). eventDigest is an
immutable conflict value, never part of the key. DO SQLite holds only signed
metadata/digests/identities/event clocks/pending/reference/cleanup; no plaintext,
cipher body or DEK. R2 holds bounded ciphertext only, with exact object/manifest/
cipherDigest/length metadata; ETag is not a digest. Workers conditional put uses
onlyIf: new Headers({"If-None-Match":"*"}); success is R2Object, failure null,
not S3 HTTP412. Conditional get without a body is not a body success.

Persist metadata-only pending intent before put. Overlapping event intents under
different packaging cannot bypass the original unknown outcome. First successful
non-overwritable R2 uploaded establishes event firstCachedAt; expiry is +72h
forever. Object expiry is no later than its earliest included event. Re-sign,
repackage, forward, retry or read never renews retention. Empty included/events
creates no cache object or cloud-cached ACK. Expired event tombstones prevent
resurrection and same-seq/different-digest replacement.

Lost ACK/reference failure/reopen recovers the same immutable key winner and
original uploaded; negative head cannot settle an unresolved old put or restart
a clock. Publish references only after full winner verification, before ACK.
Pending/missing/expired data is an explicit gap. Bounded empty lists do not
certify completeness or advance any replica-applied cursor.
Within one list request, each distinct candidate object's full body is read and
verified at most once, including failures. Candidate count and aggregate cipher
bytes are bounded; exhausting that budget reports unavailable gaps, not coverage.

Read full bounded R2 ciphertext, validate exact length/digest, await final current
Registry authorization, then synchronously recheck authority/event/object expiry
at response use. Current grant/identities remain required with an unexpired
capability. Every body follows this path; no public R2/CDN/presigned bypass.

Expired data immediately stops being served. Persist deletion alarm/retry on
failure. While writes remain unresolved, physical-deleted remains unknown; one
resolved delete/negative head cannot prove permanent deletion. A late old put
after delete re-registers cleanup. Stop-serving and actual-delete evidence differ.

Only first current-authorized receive constructs acceptedIssuerPin after complete
signature/digest/AEAD verification. Stage/helper awaits precede current-auth/
closed/full-binding publish admission. ReadyReplica.publish remains synchronous
link/unlink/directory-fsync only. Existing pin never authorizes a new network read
or share. Passive apply adds no provider/submission/task/peer/PR invocation;
explicit native local run works. cloud-cached != local-stored != peer-applied.

Cache DO SQL execution/result-materialization failures retain their original local
cause and return503/storage_failed; list must not turn a failed recipient/join
query into an ordinary gap. Missing/corrupt R2 winners retain truthful gap behavior.
Registry cache-authority RPC input/schema/identity/grant denials remain refusals;
unexpected internal failures reject the RPC with a bounded error and local cause,
using the existing503/internal unavailable path. No raw SQL text crosses logs/wire.

## Evidence and gate scope

.local/sync-p4-cf72h-cache protects1018 prior artifacts plus final itself, mapping
all tracked+new source/tests/fixtures/scripts before/after each command, with
cwd/start/exit/rawlog SHA. Tool/fixture/oracle failures retain their actual scope.

First red: real Registry SQLite, independent Swift helper/vault+Node identities,
actual pairing/B→A grant and bound ready Bots original resource page, then missing
private-port descriptor publication. Production before/after equals base. Main
chain publishes A's durable descriptor, closes A, then creates new B history/page,
recipient envelope/cache; B closes before A cold-starts/receives/applies exact
bytes/head/sections with passive delta0, then explicit native run. Both-online
prebuilt envelopes cannot substitute.

Owned clock/barriers cover identity/epoch/credential/signature changes, wrong
recipient/authority, revoked grant, seq conflict/empty page, same/different wrapping
concurrency/overlap, successful put with reference/ACK failure/reopen/negative head,
72h/cross-await expiry, body/digest/missing-key, delete retry/late old put. No
production debug API. Stable-source gates: normal root; Bots ordinary+coverage
same suite/types/lint; Worker strict/build/Miniflare; complete devices; affected
Swift/crash/exact eval by actual input changes. Browser remains normal pre-push.
Unchanged scopes are accurately reused. Review/candidate acceptance precedes Git
commit/push. No cache cloud/physical evidence is inferred from configuration.
