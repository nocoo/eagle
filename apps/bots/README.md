# Bots daemon

Local multi-bot chat daemon. Each bot is one independent durable conversation
backed by [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi).

This is an **isolated project** inside the repository: its own npm project, own
lockfile, own lint and test gates. It shares nothing with the Eagle website,
Worker or Agent; the only shared code in the whole product is
`apps/macos/Sources/EagleDesign`, used by the separate client package
`apps/bots-macos`.

The contract is documentation-first:

| Document | Owns |
| --- | --- |
| [PRODUCT.md](../../docs/bots/PRODUCT.md) | Scope, decisions, journeys, speed targets |
| [ARCHITECTURE.md](../../docs/bots/ARCHITECTURE.md) | Layers, ports, lifecycle, isolation |
| [PROTOCOL.md](../../docs/bots/PROTOCOL.md) | Wire format v1 and its fixtures |
| [RUNTIME.md](../../docs/bots/RUNTIME.md) | pi-durable mapping, probed facts, recovery |
| [OBSERVABILITY.md](../../docs/bots/OBSERVABILITY.md) | Layer logging and trace rules |
| [TESTING.md](../../docs/bots/TESTING.md) | Test ladder, fakes, gates |

## Status

Implementation in progress (stage 2 of 5). What exists: the protocol codec, command
validation and budgets, the layered log, the bot catalog with delete reconciliation,
the revision hub with delta coalescing, and the runtime port with a fake runtime.
143 tests, coverage above the gate. What does not exist yet: the conversation
service, the pi-durable adapter, the transport, the entrypoint and the macOS client,
so nothing listens on a socket.

`docs/bots/PLAN.md` is the authoritative status and order of work.

## Setup

Node ≥ 24 (pi-durable needs ≥ 22.19; verified on Node 26.12.0). Runtime TypeScript
goes through Node's type stripper, so there is no build step and only erasable
syntax (`type`, `interface`, `satisfies`; no `enum` or `namespace`).

```sh
cd apps/bots
npm install
cp .env.example .env      # then fill BOTS_API_KEY
chmod 600 .env
```

`.env` is ignored by Git and must never be committed. It holds:

| Variable | Meaning |
| --- | --- |
| `BOTS_BASE_URL` | Model endpoint, OpenAI Responses shape (`POST /responses`) |
| `BOTS_API_KEY` | Bearer key for that endpoint |
| `BOTS_PROVIDER` | Provider id stored in the catalog and carried by the protocol |
| `BOTS_MODEL` | Pinned development model |

## Commands

```sh
npm run smoke:model    # one real conversation against BOTS_BASE_URL, prints timings
npm test               # fast gate
npm run typecheck
npm run lint
npm run coverage       # enforced thresholds
npm run coverage       # unit file list, thresholds enforced
npm run test:crash     # real SIGKILL recovery, from stage 4
npm run perf           # documented measurement, informational
npm run check          # fixtures:check, test, typecheck, lint, coverage
```

`smoke:model` never prints the key and exits non-zero when the endpoint, the model
or the conversation fails.
