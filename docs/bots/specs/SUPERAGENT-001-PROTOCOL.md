# SG-001 local protocol and implementation decisions

Status: **implementation contract, frozen for SG001-A; chat section frozen before B**.
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
  rootBinding,modelReady}`. `instance` is a fresh UUID per process; rootBinding is
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
message, submission, configuration and error fixtures land before B code.

The service owns only one permanent conversation and no executable tools. Its
store, runtime and transport are independent from Bots. Snapshot/history admission
and cancellation semantics must implement SG001-R06/R07/R08 exactly.

## Planned native and CLI ownership (SG001-C)

- Independent Swift logic targets/package own the Superagent domain, transport and
  ViewModel. EagleFeatures owns native composition using EagleDesign. No worker
  CatalogPort/ConversationPort or lifecycle ViewModel is a Superagent dependency.
- `eagle-dev superagent ...` is an explicit service namespace, with independent
  root/port/credential resolution. No worker CLI credential or fallback is used.
- Independent configuration is saved by an App-owned Superagent settings path into
  this service's own store. A source build can configure through the scoped CLI
  using JSON on stdin; keys never enter argv or output. The App does not fetch or
  copy worker gateway files to bootstrap this service.

## Gates

Foundation: real process/HTTP/root ownership/authentication tests; strict typecheck
and check-only Biome. Add coverage with the runtime slice and enforce the project's
95% four-metric unit target over owned logic rather than excluding failures.
The exact executable gate lives in `apps/superagent/package.json`. Root unrelated
workspace checks must not silently import this independent package.
