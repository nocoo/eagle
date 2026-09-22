# Reporting from another machine

The collector is read-only toward Herdr/Git. It never prompts agents, presses keys, runs repository tests, or changes workspaces. Use a management agent (Hermes recommended; alternatives supported) to interpret outcomes and supply structured receipts.

## Secure config

### Credential rotation versus moving to another deployment

Resolve the config used by the existing service (`EAGLE_CONFIG`, otherwise the
default below) before changing anything. Compare **both** `machineId` and the
parsed URL origin (scheme, hostname and port). An equal machine ID on two
deployments is not an equal credential scope.

- **Same identity and origin:** back up securely, rotate only the credential,
  preserve all other settings and Manager state, then restart that service.
- **Different identity:** stop and ask; do not overwrite an unrelated machine.
- **Different origin:** confirm the destination, preserve the old configuration
  and create a new private configuration directory. Set the new URL/token and
  an explicit `spoolDir` inside that directory. An alternate
  `EAGLE_CONFIG` alone does not relocate the collector cache; explicit `spoolDir`
  also isolates `latest-report.json`. Never point the new deployment at the old
  spool, evidence file or Manager pending/sequence directory. History transfer
  requires a separate decision, not an incidental `once` replay.

Use the same absolute `EAGLE_CONFIG` for `init`, `once`, `watch` and any explicitly
enabled Manager/realtime command, including the supervised service environment.
Validate a fresh snapshot and the destination dashboard before stopping the
identified old collector and switching continuous collection. Preserve the old
config/queue for rollback; do not rotate credentials or delete pending reports
merely to recover from an uncertain response. Avoid duplicate service instances.

Create `~/.config/eagle/agent.json`, directory mode 0700 and file mode 0600:

```json
{
  "url": "https://eagle-ingest.hexly.ai",
  "machineId": "your-machine",
  "machineName": "Your machine",
  "token": "REPLACE_WITH_MACHINE_SECRET",
  "intervalSeconds": 30,
  "watchPorts": [{ "name": "Raven", "port": 7024 }],
  "evidenceFile": "/absolute/private/path/evidence.json"
}
```

Each machine has one SQLite-backed Durable Object selected by its `machineId`; the agent only posts reports and heartbeats to the authenticated Worker. No object ID or database credential is needed on the machine. The next valid full snapshot replaces the prior current state. A success receipt confirms persistence in DO, not insertion into D1. Semantic Pane changes are independently persisted in the same machine DO, grouped by UTC observation hour, and replicated to D1. Whole-report history and hourly AI aggregation remain paused.

Open **Connect** on the Eagle website. Add a machine ID, display name and optional watched ports, then copy the generated prompt to the existing management Agent (Hermes recommended) on that machine. Connect also supports renaming, rotating credentials, disabling and re-enabling machines. Token-bearing prompts exist only in browser memory until dismissed or navigation; the visible preview hides the token. Save the credential securely before leaving. Rotation invalidates the previous token immediately; re-enabling always issues a new token.

The platform signs machine-scoped tokens using the `AGENT_SIGNING_KEY` Worker secret (at least 32 random characters). Raw tokens and the signing key never enter a database. Each machine DO stores only its configuration, public credential ID, enabled state and expiry. Tokens expire after one year. The directory DO indexes machine IDs only; ingestion goes directly to the corresponding machine DO. The old `AGENT_TOKENS` secret remains compatible; Connect can rotate a legacy machine to signed credentials or disable it. Removing a legacy secret alone does not disable a machine already migrated to signed credentials; use Connect.

Install Agent v0.7.1 from npm. Website and Agent releases use the same version from the root package manifest. Check `node --version`, `npm --version` and `herdr --version`: Node 24+ and a running Herdr installation are required. Node downloads: https://nodejs.org/en/download. The installed Agent needs no Eagle checkout or TypeScript compiler.

```sh
npm install -g @nocoo/eagle-agent@0.7.1 --registry=https://registry.npmjs.org
```

If npm downloads are unreachable, **Tencent Cloud is the preferred mirror**:

```sh
npm install -g @nocoo/eagle-agent@0.7.1 --registry=https://mirrors.cloud.tencent.com/npm/
```

This changes the registry for this command only. A new version may not have synchronized yet (`404` / `ETARGET`); retry later or use the official registry when reachable, keeping the pinned version. Public installation needs no npm login. Never send an Eagle token to npm or a mirror, or disable HTTPS certificate verification.

```sh
eagle-agent --version # expected: 0.7.1
eagle-agent --help
```

Configure the machine from its Connect prompt, then run:

```sh
eagle-agent once
eagle-agent watch
eagle-agent collect /private/path/report.json
eagle-agent upload /private/path/report.json
eagle-agent heartbeat
```

`eagle-agent init` accepts config JSON through stdin, writes a 0600 file in a 0700 directory, and refuses to overwrite existing configuration. Never pass tokens in command arguments. Existing checkout commands (`node agent/cli.ts …`) remain supported. For local package verification use `npm pack ./agent --pack-destination .local`, then install that tarball in an isolated directory.

`EAGLE_CONFIG` selects another 0600 config. `once` collects, atomically writes a 0600 spool entry, then drains pending reports newest first. Network/429/5xx failures retry with backoff using the same report body and ID; 400/409/413/415 或损坏 JSON 会移入 `spool/rejected/` 保留，并在心跳中提示；后续有效快照继续发送。401/403 和网络故障保留整个待发送队列等待修复。Reports remain on disk until acknowledged or explicitly quarantined. At 1000 pending entries the spool first attempts to drain before collecting more; it never deletes unacknowledged data. An explicit auth/schema failure requires operator correction; do not discard old reports to make the queue green. `watch` repeats after the configured interval. Alternatively run `once` with launchd/systemd at the same interval; prevent overlapping invocations.

Automatic collection covers **every running local Herdr session** and every Space/tab/pane, not just the active tab. A whole-session error preserves the previous inventory. Stopped sessions retain cached Spaces with `availability:unavailable`; they cannot count as live or verified. The last validated report is cached as a 0600 file alongside the spool. The optional local Codex adapter uses `state_5.sqlite` and `goals_1.sqlite` in `codexDir` (default `~/.codex`), reads bounded transcript tails, and records native final replies and explicit activity. Unknown/changed store schemas fall back to terminal evidence. Raw command arguments and reasoning are never extracted. All outbound strings redact known credentials, common token formats, secret assignments and private-key blocks.

## Machine resources and watched ports

Collector 0.2.0 adds optional `machine.telemetry` to v1 snapshots. It samples CPU utilization across all logical cores over approximately 250 ms, CPU model/core count, 1/5/15-minute load average, total/free RAM, home-filesystem total/available space and system uptime. Memory usage is total minus free, which may include caches; it is not a memory-pressure measurement. Missing resources or disk measurements remain unknown. Values and their observation times are kept in the machine DO current snapshot and returned by overview. New D1 history writes and hourly summaries are paused.

`watchPorts` is optional and defaults to an empty list. Each entry has `name`, `port` and optional `host` (`127.0.0.1` by default; `::1` is also supported). At most 32 unique host/port pairs can be configured. For Raven, 7023 is the dashboard and 7024 is the proxy; configure either or both. Checks run concurrently, each bounded to one second, and send no application data or credentials. Results distinguish TCP connect success, connection refusal, timeout and check error. A listening port does not prove business health or successful task deployment. The UI marks observations older than 90 seconds as historical.

Restart the collector after editing its configuration. For an upgrade, deploy the compatible Worker **before** restarting production collectors: old strict v1 servers reject the newly added telemetry field. Older agent reports without telemetry continue to work on the new server. The current preview is configured in `.local/agent-dev.json`; its Raven port check and resource snapshots go to its independent local Durable Object.

## Manager evidence

`evidenceFile` is an atomically replaced JSON object keyed by `session:paneId`. Omit the config field if no file is provided. Each entry has a task and an evidence list; all data is validated with the same report schema:

```json
{
  "default:w1:p1": {
    "task": { "id": "release-123", "title": "Publish release 123", "requiresDeployment": true },
    "evidence": [
      { "kind": "goal", "status": "running", "summary": "Implementation complete; checking production", "source": "manager:review", "observedAt": "2026-09-19T06:00:00.000Z", "taskId": "release-123" }
    ]
  }
}
```

First collect the live report and copy its pane.task.id into the manager entry. For Codex it is derived from the native session/turn; Grok and Pi use the latest native user prompt when available. A manager cannot replace this identity: stale IDs are ignored. Unsupported harnesses fall back to terminal/session identity and require the manager to verify task continuity. Retain actual evidence timestamps; never renew old tests merely because the collector ran. Test and deployment receipts include the **tested/deployed full Git SHA**. Legacy Manager evidence is now forced to unknown status and a manager:legacy source; it cannot lower the daemon requiresDeployment requirement or masquerade as Git/test/deployment facts. A terminal's final answer alone remains an unverified claim until the independent receipts agree.

Prefer a short human outcome: what changed, what remains, what needs a decision. Do not send entire scrollback, internal reasoning, environment dumps, or credentials. The UI defaults to this summary and allows inspecting evidence underneath.

## Installed on MBPM5MSFT

The production machine ID is `mbpm5msft`. Its macOS LaunchAgent at `~/Library/LaunchAgents/com.hexly.eagle-agent.plist` runs this checkout's `agent/cli.ts watch` every 30 seconds and restarts on failure. Configuration, the manager evidence file, durable spool, and `agent.stdout.log` / `agent.stderr.log` are under `~/.config/eagle/`. The website uses Cloudflare Access; the former viewer-token file has been removed. Machine Bearer credentials remain required for reporting.

```sh
# Restart after updating collector code:
launchctl kickstart -k gui/501/com.hexly.eagle-agent
# Stop reporting:
launchctl bootout gui/501 ~/Library/LaunchAgents/com.hexly.eagle-agent.plist
# Resume reporting:
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.hexly.eagle-agent.plist
```

These commands are for this machine's user ID 501. Other machines need their own token, identity, checkout path and service configuration. A valid success acknowledgement is required before a queued report is removed; malformed responses preserve the report for an idempotent retry.

All three Eagle LaunchAgents on this Mac use direct connections by default. Proxying is an explicit per-machine option through `NODE_USE_ENV_PROXY=1` and a verified `HTTPS_PROXY` URL; no proxy host or port is fixed. See [optional reporting proxy](../agent/README.md#optional-reporting-proxy) for enabling it or returning to direct connections. Preserve the spool and Manager state when reloading services.

## Live semantic Manager

The maintained integration is `eagle-agent manager-once` / `manager-watch`, not the legacy evidence file. Run Manager separately from the deterministic `watch` service. See [PANE-SUMMARIES.md](PANE-SUMMARIES.md) for complete v1 protocols, independent DO streams, UTC hourly API/indexes, retention, conflict recovery and agent-neutral scheduler setup. The project [eagle-report Skill](../skills/eagle-report/SKILL.md) is reusable on every machine.
