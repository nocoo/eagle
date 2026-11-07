# Eagle Superagent

Independent App-owned Super Bot service. No worker imports, credentials, storage
or calls. Contract: [SG-001](../../docs/bots/specs/SUPERAGENT-001-CHAT.md).

```sh
npm ci
npm run check
npm start -- --root /absolute/private/root --port 43127
```

Node 24+. Bind is loopback-only. A canonical-root kernel lock prevents two owners.
`GET /v1/health` reports service identity and readiness without exposing credentials.
All tests allocate private temporary roots; they do not start an installed worker.

Current slice: process foundation. Conversation and App integration follow under
the spec; readiness alone is not evidence that chat works.
