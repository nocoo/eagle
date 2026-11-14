# @nocoo/eagle-agent

Agent 1.0.0 removes the optional semantic layer: `manager-once`,
`manager-watch`, `manager.command` and the legacy `evidenceFile` input are gone,
so the package now ships only deterministic collection, realtime bridging and
their storage. Stop and delete any supervised `manager-watch` service when
upgrading; a stored `manager` block or `evidenceFile` path is ignored with one
`retired_config_keys` log line rather than failing startup. Optional macOS GPU, temperature, fan and traffic observations
remain read-only. Install macmon separately and include it in the service PATH for
hardware readings; no sudo or fan control is used.

Read-only Herdr inventory, task evidence, machine resources and named TCP port checks for Eagle. Requires Node.js 24+ and the Herdr CLI on macOS or Linux.

## Download and install

Check `node --version`, `npm --version` and `herdr --version` first. Install Node.js 24+ from https://nodejs.org/en/download if needed, and have Herdr installed and running. No Eagle repository checkout, TypeScript compiler or npm login is required to install this public package.

Install Agent v1.0.0 from npm. Website releases are independent:

```sh
npm install -g @nocoo/eagle-agent@1.0.0 --registry=https://registry.npmjs.org
```

**If npm downloads time out, use the Tencent Cloud mirror / 下载超时时首选腾讯云镜像：**

```sh
npm install -g @nocoo/eagle-agent@1.0.0 --registry=https://mirrors.cloud.tencent.com/npm/
```

`--registry` applies only to this installation; it does not change your global npm configuration. Mirrors may lag (`404` / `ETARGET`); retry later or use the official registry when reachable. Keep the pinned version, HTTPS and certificate verification. Eagle credentials are unrelated to npm and must never be sent to a registry.

Verify the installation before configuring the agent:

```sh
eagle-agent --version # expected: 1.0.0
eagle-agent --help
```

If the command is missing, ensure npm's global `bin` directory is on your PATH. Use a user-owned Node/npm installation if global installation fails with `EACCES`.

## Connect a machine

When an Agent is already configured, check the service's `EAGLE_CONFIG`, machine
ID **and URL origin** first. Only a matching ID and origin permits token-only
rotation. Moving to another deployment requires a separate private config
directory and explicit new `spoolDir`; preserve, but do not replay, the old queue,
cache. Verify the new destination before switching the service,
and set its `EAGLE_CONFIG` explicitly. See `docs/AGENT.md` in the repository for
the rotation/migration procedure. Do not overwrite a different machine identity.

Open Eagle's **Connect** page, create a machine and copy its onboarding prompt. Give the prompt to the management agent on that machine. It contains a machine-scoped credential shown only once.

Store configuration at `~/.config/eagle/agent.json` (directory 0700, file 0600). `EAGLE_CONFIG` selects another file. `eagle-agent init` reads JSON from stdin and creates this file securely; it refuses to overwrite an existing file. Never pass a token in command arguments, commit it, print it, or include it in reports. Rotation requires updating the token in the existing secure configuration.

```sh
eagle-agent once
eagle-agent watch
eagle-agent collect /private/path/report.json
eagle-agent upload /private/path/report.json
eagle-agent heartbeat
```

`once` collects all running Herdr sessions and sends a complete snapshot. `watch` repeats every 30 seconds by default. Set up a user launchd or systemd service to keep it running across restarts, with the correct absolute executable paths and PATH for Node and Herdr. Do not run overlapping collectors for one configuration.

The machine's Durable Object maintains current state. Unacknowledged reports remain in a private local spool; retries preserve their IDs. Older reports cannot roll back current state. Eagle keeps no database and no scheduled job; only the latest snapshot is retained.

Optional `watchPorts`: `[{ "name": "Raven", "port": 7024 }]`. Only loopback TCP checks are supported; a listening port does not prove service or task health. CPU, RAM, disk and uptime are sampled automatically. Task status combines terminal summaries, goals, Git, tests, processes and deployment evidence; pane lifecycle badges are weak hints.

Detailed configuration and reporting contract: https://github.com/nocoo/eagle/blob/main/docs/AGENT.md

## Environment resources

Agent 0.8.0 adds 30-second CPU/load/memory and OS network/VPN samples,
with configurable disk/temperature sampling (`slowIntervalSeconds`, default 300,
range 60–3600). `intervalSeconds` must be 30; update any previous custom value
explicitly before upgrading. Cached slow observations keep their original times.
Agent 0.8.1 reads macOS hardware through optional unprivileged
macmon. A
`tun`/`utun` interface alone never proves VPN connectivity. No addresses,
connection details or profile names are uploaded. The machine page displays
24-hour CPU/memory/load history from the same report stream.

The receiving Worker must support the additional telemetry fields before
upgrading an installed collector. Publishing a package does not upgrade or
restart existing services. Preserve the configured identity, credentials and
spool when explicitly upgrading. Full contract: https://github.com/nocoo/eagle/blob/main/docs/RESOURCES.md

## Optional reporting proxy

Direct connections are the default. Set `NODE_USE_ENV_PROXY=0` in the service environment and leave proxy addresses unset. A local proxy is not a prerequisite for Eagle.

Only when the machine needs a proxy, set `NODE_USE_ENV_PROXY=1` and `HTTPS_PROXY` to the user's verified HTTP(S) proxy URL. Use `HTTP_PROXY` for HTTP destinations and `NO_PROXY` for destinations that should bypass the proxy. Do not assume a host or port. These are Node environment settings, not fields in `agent.json`; no new Agent package is required. Node.js 24.5+ is required for proxying the `realtime-watch` WebSocket connection.

Apply the selected environment to each Eagle service (`watch` and `realtime-watch`) and to any foreground verification command. On macOS, use the LaunchAgent's `EnvironmentVariables`; on Linux, use the user systemd unit's environment. Keep proxy credentials, if needed, in protected service configuration, never in command arguments or reports.

To return to direct connections, remove the service's proxy address variables and set `NODE_USE_ENV_PROXY=0`. Reload the service definition and restart it; restarting alone does not reload a changed launchd plist. Wait until the old service has fully stopped before registering it again. Preserve the secure Agent config and spool. Confirm a fresh successful report and an empty pending spool; a running process alone does not prove connectivity. An explicitly selected proxy remains required until disabled; there is no automatic direct fallback.

## Space realtime control

Run `eagle-agent realtime-watch` as a separate user service using the same secure configuration. This enables authenticated web control through an outbound WebSocket; the collector remains read-only. Open a Space in Eagle and select 实时模式, then 接管输入. Unwatched Spaces consume no screen polling. Leaving/hiding the page releases the subscription; input is never replayed after a disconnect. Details and limits: https://github.com/nocoo/eagle/blob/main/docs/REALTIME.md

## Realtime upgrade

The realtime bridge preserves ordinary status labels while masking wrapped and
quoted credentials in both plain and styled terminal output. Bounded redaction avoids
repeated scanning of long whitespace, base64 and Bearer sequences.

Up/down history keys require Kitty disambiguation or report-all-keys mode;
unsupported cursor modes fail closed. Explicit Ctrl+P/N remain separate actions,
not automatic substitutes. Deploy the matching Worker before restarting existing
bridges. Preserve the machine configuration and spool;
installing the package does not start or restart services automatically.

## Unpublished shared-device candidate

The source candidate additionally bundles `dist/agent/device-service.js`, an
App/helper-managed entrypoint separate from the existing collector CLI. The App
supplies its bundled Node runtime and private JSONL bootstrap; users do not install
Node, copy owner secrets, or configure per-Bot credentials. The helper uses its
private file identity to sign exact registration challenges and typed operation
approvals through the private parent pipe. Multiple Bots share a 0600 Unix socket whose execution/read methods cannot
change policy or pairing. Local command/file/native admission works offline;
Herdr is optional for this path. See `docs/DEVICES.md` in the repository for wire,
policy, journal, native ownership and error semantics.

This candidate is not an npm publication. Its independent Agent manifest version
must be advanced and its installed artifact verified before release; website
onboarding keeps the last verified published Agent version until then.
