#!/usr/bin/env node
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  ReportSchema,
  SlowIntervalSchema,
  WatchPortsSchema,
} from "../src/shared/schema.ts";
import {
  type AgentConfig,
  checkUrl,
  collect,
  sendReport,
} from "./collector.ts";
import { ManagerConfigSchema, managerTick } from "./manager.ts";
import { realtimeWatch } from "./realtime.ts";
import { drainSpool } from "./spool.ts";
import { AGENT_VERSION } from "./version.ts";

const ConfigSchema = z.strictObject({
  url: z.string().url(),
  token: z.string().min(32),
  machineId: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  machineName: z.string().min(1),
  evidenceFile: z.string().optional(),
  intervalSeconds: z.literal(30).default(30),
  slowIntervalSeconds: SlowIntervalSchema,
  codexDir: z.string().optional(),
  spoolDir: z.string().optional(),
  watchPorts: WatchPortsSchema.default([]),
  manager: ManagerConfigSchema.optional(),
});
const path =
  process.env.EAGLE_CONFIG || join(homedir(), ".config/eagle/agent.json");
async function heartbeat(config: AgentConfig, warning?: string) {
  const response = await fetch(`${checkUrl(config.url)}/api/v1/heartbeat`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      schemaVersion: 1,
      machineId: config.machineId,
      sentAt: new Date().toISOString(),
      ...(warning ? { warning } : {}),
    }),
  });
  if (!response.ok) throw new Error(`Heartbeat rejected (${response.status})`);
}
async function cycle(config: AgentConfig) {
  const spool = config.spoolDir || join(dirname(path), "spool");
  await mkdir(spool, { recursive: true, mode: 0o700 });
  const files = (await readdir(spool))
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length >= 1000)
    await drainSpool(spool, config.machineId, (pending) =>
      sendReport(config.url, config.token, pending),
    );
  let report: Awaited<ReturnType<typeof collect>>;
  try {
    report = await collect(config);
  } catch {
    await heartbeat(
      config,
      "采集失败：保留上一次完整快照，请检查本机 Agent 日志",
    ).catch(() => {});
    throw new Error("Collection failed; previous complete inventory preserved");
  }
  const name = `${report.capturedAt.replaceAll(":", "-")}-${report.reportId}.json`;
  await writeFile(join(spool, `${name}.tmp`), JSON.stringify(report), {
    mode: 0o600,
  });
  await rename(join(spool, `${name}.tmp`), join(spool, name));
  const drained = await drainSpool(spool, config.machineId, (pending) =>
    sendReport(config.url, config.token, pending),
  );
  if (drained.rejected)
    await heartbeat(
      config,
      `${drained.rejected} 份无效上报已隔离保留，请检查本机 spool/rejected`,
    );
  console.log(
    JSON.stringify({
      event: "reported",
      at: report.capturedAt,
      spaces: report.spaces.length,
      panes: report.spaces.flatMap((s) => s.tabs.flatMap((t) => t.panes))
        .length,
      warnings: report.warnings.length,
    }),
  );
}
async function main() {
  const action = process.argv[2] || "once";
  if (action === "--help" || action === "help") {
    console.log(
      "Eagle Agent\nCommands: init (JSON on stdin), collect <file>, upload <file>, once, watch, realtime-watch, heartbeat, manager-once, manager-watch\nConfig: EAGLE_CONFIG or ~/.config/eagle/agent.json (0600). Node.js 24+ and Herdr required. Manager requires explicit manager.command for your existing agent (Hermes recommended); deterministic collection is independent.",
    );
    return;
  }
  if (action === "--version") {
    console.log(AGENT_VERSION);
    return;
  }
  if (action === "init") {
    if (process.stdin.isTTY)
      throw new Error(
        "Pass configuration JSON through stdin; never pass credentials as arguments",
      );
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 65536) throw new Error("Configuration exceeds 64 KiB");
    }
    let value: unknown;
    try {
      value = JSON.parse(input);
    } catch {
      throw new Error("Invalid configuration JSON");
    }
    const config = ConfigSchema.parse(value);
    checkUrl(config.url);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(config, null, 2));
    } finally {
      await file.close();
    }
    console.log(
      "Secure configuration created. Run eagle-agent once to verify reporting.",
    );
    return;
  }
  const permissions = await stat(path);
  if (process.platform !== "win32" && (permissions.mode & 0o077) !== 0)
    throw new Error("Config must have mode 0600");
  const config = ConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
  checkUrl(config.url);
  if (action.startsWith("manager-") && !config.manager?.command)
    throw new Error(
      "Configure manager.command for your existing agent (Hermes recommended) before starting Manager; watch works independently.",
    );
  if (action === "collect") {
    const output = process.argv[3];
    if (!output) throw new Error("Usage: collect <output.json>");
    const report = await collect(config);
    await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(
      JSON.stringify({
        event: "collected",
        spaces: report.spaces.length,
        warnings: report.warnings.length,
      }),
    );
  } else if (action === "upload") {
    const report = ReportSchema.parse(
      JSON.parse(await readFile(process.argv[3], "utf8")),
    );
    if (report.machine.id !== config.machineId)
      throw new Error("Machine identity mismatch");
    console.log(
      JSON.stringify(await sendReport(config.url, config.token, report)),
    );
  } else if (action === "realtime-watch") {
    const stop = new AbortController();
    process.once("SIGTERM", () => stop.abort());
    process.once("SIGINT", () => stop.abort());
    await realtimeWatch(config, stop.signal);
  } else if (action === "heartbeat") {
    await heartbeat(config);
    console.log("Heartbeat accepted");
  } else if (action === "once") await cycle(config);
  else if (action === "manager-once")
    console.log(
      JSON.stringify(
        await managerTick(
          config,
          join(dirname(path), `manager-${config.machineId}`),
        ),
      ),
    );
  else if (action === "watch" || action === "manager-watch") {
    let running = true;
    process.on("SIGTERM", () => {
      running = false;
    });
    process.on("SIGINT", () => {
      running = false;
    });
    while (running) {
      const start = Date.now();
      try {
        if (action === "manager-watch")
          console.log(
            JSON.stringify({
              event: "manager_reported",
              at: new Date().toISOString(),
              ...(await managerTick(
                config,
                join(dirname(path), `manager-${config.machineId}`),
              )),
            }),
          );
        else await cycle(config);
      } catch (e) {
        console.error(
          JSON.stringify({
            event:
              action === "manager-watch" ? "manager_failed" : "report_failed",
            message:
              e instanceof z.ZodError
                ? "Invalid config or report schema"
                : e instanceof Error
                  ? e.message
                  : "Unknown error",
          }),
        );
      }
      if (running)
        await new Promise((r) =>
          setTimeout(
            r,
            Math.max(
              1000,
              config.intervalSeconds * 1000 - (Date.now() - start),
            ),
          ),
        );
    }
  } else
    throw new Error(
      "Commands: collect <file>, upload <file>, once, watch, realtime-watch, heartbeat, manager-once, manager-watch",
    );
}
void main().catch((e: unknown) => {
  console.error(
    e instanceof z.ZodError
      ? "Invalid config or report schema"
      : e instanceof Error
        ? e.message
        : "Agent failed",
  );
  process.exitCode = 1;
});
