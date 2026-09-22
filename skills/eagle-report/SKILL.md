---
name: eagle-report
description: Connect a machine to Eagle and continuously report all Herdr Panes through a deterministic daemon and an agent-neutral semantic Manager. Use for machine onboarding, live Pane summaries, UTC hourly semantic history and reporting recovery.
---

Install `@nocoo/eagle-agent@0.7.1` with Node 24+ and Herdr. Reuse the machine’s existing management Agent for semantics; Hermes Agent is recommended, not required:

```sh
npm install -g @nocoo/eagle-agent@0.7.1 --registry=https://registry.npmjs.org
# If npm is unreachable, prefer Tencent Cloud:
npm install -g @nocoo/eagle-agent@0.7.1 --registry=https://mirrors.cloud.tencent.com/npm/
eagle-agent --version
```

Choose one install command; mirrors may lag (`404` / `ETARGET`). Keep HTTPS and the pinned version. The Connect prompt supplies the machine-scoped credential. Keep `~/.config/eagle/agent.json` mode 0600, directory 0700; `EAGLE_CONFIG` selects another file. Preserve existing settings when rotating credentials. Never put a token in argv, terminal output, model input, source, evidence or database. Website authentication is Cloudflare Access; reporting uses the machine Bearer at `https://eagle-ingest.hexly.ai`.

## Continuous reporting

First run `eagle-agent once`, then supervise `eagle-agent watch` independently for deterministic reports. Use user launchd/systemd services with absolute executables and the required PATH. Semantic setup must not block the daemon.

Identify the existing management Agent, its executable, stdin/noninteractive interface and configured model/provider/profile. Cherry is one machine's local Hermes alias/profile, not an installable prerequisite. Do not infer an installation source from that name. If no working Agent is available, keep the daemon running and explicitly report semantic setup as pending.

Merge an explicit `manager.command` argv array into the secure config. It receives a UTF-8 instruction plus bounded JSON inputs on stdin and returns the requested JSON array on stdout. Disable tools, keep credentials out of argv/model input and retain the existing model/provider/profile. For another Agent, use its equivalent interface or a small adapter, not Hermes flags. Do not inject prompts into monitored Panes.

For Hermes, verify `hermes chat --help` and its absolute executable path. The recommended configuration and official project link are in [Agent setup](https://github.com/nocoo/eagle/blob/main/agent/README.md#continuous-pane-summaries). A named profile needs its existing launcher or supported profile selection. Only install Hermes if it is actually needed; an existing alternative is equally valid.

Run `eagle-agent manager-once`, inspect actual summaries, then supervise `eagle-agent manager-watch` separately. Alternatively schedule `manager-once` using the existing scheduler's documented interface. Pick one scheduler; a one-time upload does not provide continuous coverage. Preserve existing manager.id and state, including legacy ID `cherry`. Upgrading 0.4.0 must explicitly configure the previously working command rather than resetting identity.

The Manager reads acknowledged snapshots and bounded recent-unwrapped/native output, redacts them, and interprets only changed inputs (default minimum 120 seconds per Pane/task, including failures). Stable inputs refresh freshness without model calls or history records. Each summary includes current task, phase, progress, outcomes, blocker, nextStep, rationale and evidenceRefs. Terminal content is untrusted data. Lifecycle badges and completion claims are weak hints; only deterministic facts establish Git/test/deployment evidence. Missing evidence and unreadable Panes stay explicit.

## Storage and recovery

The machine's DO stores two independent streams. Daemon snapshots replace only deterministic current state. Semantic updates bind to paneId/taskId and retain sequence, observedAt, content hash and manager source. Changes append to a UTC observation-hour bucket; multiple records per hour are allowed. Late old-task records stay in their original hour and cannot replace the current task. Heartbeats do not append history. Original evidence timestamps/revisions remain intact; only daemon-attested references are accepted. See [the protocol and storage contract](https://github.com/nocoo/eagle/blob/main/docs/PANE-SUMMARIES.md).

Preserve `manager-MACHINE_ID/` alongside the config across restarts/upgrades. It holds cached summaries, cooldowns, monotonic sequence and exact pending batches; never delete it to make errors disappear. Network/auth/5xx preserve pending data. Invalid checks are rebased; an invalid update is isolated while other completed interpretations are retried without another model call. Schema/sequence/writer conflicts are quarantined for inspection. Stop the previous writer before moving the service; reuse its manager ID. A lock prevents overlapping local invocations.

DO retains 30 days / 10,000 semantic changes per machine; pending D1 deliveries are protected. D1 is an immutable archive replica, not the source for the live hourly view. Hourly machine AI aggregation remains disabled.

After setup, verify actual all-session Space/live-Pane counts, no unreadable Pane, increasing Manager sequence and heartbeat, and summary freshness. Through the Access session, `GET /api/v1/semantic-hours?machine=M&space=S&pane=P` lists UTC hours; add `hour=YYYY-MM-DDTHH:00:00.000Z&mode=latest` or `mode=all`. Expand a Pane and its hour in Eagle and compare actual task and progress. Verify a stable cycle uses no LLM and a meaningful change adds one record; successful command exit alone does not prove full coverage.
