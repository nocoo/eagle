# Eagle Superagent

Independent App-owned Super Bot service. No worker imports, credentials, storage
or calls. Independence is this milestone's obligation; the later worker observation
provider lives in the daemon and is reused, not duplicated. Contract:
[SG-001](../../docs/bots/specs/SUPERAGENT-001-CHAT.md).

```sh
npm ci
npm run check
npm start -- --root /absolute/private/root --port 43127
```

Node 24+. Bind is loopback-only. A canonical-root kernel lock prevents two owners.
`GET /v1/health` reports service identity and readiness without exposing credentials.
All tests allocate private temporary roots; they do not start an installed worker.

The service now owns a chat-only pi-durable conversation, private configuration and
an authenticated WebSocket at `/v1/chat`. See the exact
[protocol](../../docs/bots/specs/SUPERAGENT-001-PROTOCOL.md). It installs no tools or
worker connection. `check` enforces four 95% coverage floors, strict types and lint.
Native App/CLI integration follows; scripted-model tests do not prove a live gateway.
