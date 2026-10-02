import { statfs } from "node:fs/promises";
import { createConnection } from "node:net";
import {
  availableParallelism,
  cpus,
  freemem,
  homedir,
  loadavg,
  platform,
  totalmem,
  uptime,
} from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  type MachineTelemetry,
  MachineTelemetrySchema,
  type PortCheck,
  SlowIntervalSchema,
  WatchPortsSchema,
} from "../src/shared/schema.ts";

import { readConnections, readTemperature } from "./environment.ts";

type CpuSample = { idle: number; total: number };
export function cpuUsage(before: CpuSample, after: CpuSample): number | null {
  const total = after.total - before.total;
  const idle = after.idle - before.idle;
  if (total <= 0 || idle < 0 || idle > total) return null;
  return Math.round((1 - idle / total) * 1000) / 10;
}
function cpuSample(values: ReturnType<typeof cpus>): CpuSample {
  return values.reduce(
    (sum, cpu) => ({
      idle: sum.idle + cpu.times.idle,
      total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
    }),
    { idle: 0, total: 0 },
  );
}
async function resources(): Promise<MachineTelemetry["resources"]> {
  const processors = cpus();
  const before = cpuSample(processors);
  const started = performance.now();
  // A short fresh sample also works for one-shot collectors; no process-lifetime counters.
  await delay(250);
  const after = cpus();
  const cpuSampleMs = Math.round(performance.now() - started);
  return {
    cpuModel: processors[0]?.model || "",
    cpuCores: processors.length || availableParallelism(),
    cpuUsagePercent:
      processors.length === after.length
        ? cpuUsage(before, cpuSample(after))
        : null,
    cpuSampleMs,
    loadAverage:
      platform() === "win32" ? null : (loadavg() as [number, number, number]),
    memory: { totalBytes: totalmem(), freeBytes: freemem() },
    disk: null,
    uptimeSeconds: Math.floor(uptime()),
  };
}
function checkPort(target: {
  name: string;
  host: PortCheck["host"];
  port: number;
}): Promise<PortCheck> {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = createConnection({ host: target.host, port: target.port });
    let settled = false;
    const finish = (status: PortCheck["status"]) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({
        ...target,
        status,
        latencyMs:
          status === "open"
            ? Math.round((performance.now() - started) * 10) / 10
            : null,
        checkedAt: new Date().toISOString(),
      });
    };
    socket.setTimeout(1000, () => finish("timeout"));
    socket.once("connect", () => finish("open"));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(
        error.code === "ECONNREFUSED"
          ? "closed"
          : error.code === "ETIMEDOUT"
            ? "timeout"
            : "error",
      ),
    );
  });
}
type SlowSample = {
  disk: NonNullable<MachineTelemetry["resources"]>["disk"];
  temperature: Omit<NonNullable<MachineTelemetry["temperature"]>, "observedAt">;
};
type Probes = {
  now: () => number;
  fast: () => Promise<MachineTelemetry["resources"]>;
  slow: () => Promise<SlowSample>;
  connections: () => Promise<Pick<MachineTelemetry, "network" | "vpn">>;
};
const probes: Probes = {
  now: Date.now,
  fast: resources,
  slow: async () => {
    const [disk, temperature] = await Promise.all([
      statfs(homedir())
        .then((fs) => ({
          totalBytes: fs.blocks * fs.bsize,
          availableBytes: fs.bavail * fs.bsize,
        }))
        .catch(() => null),
      readTemperature(),
    ]);
    return { disk, temperature };
  },
  connections: readConnections,
};
export function createTelemetrySampler(source: Probes = probes) {
  let slow: (SlowSample & { observedAt: string }) | undefined;
  let pending: Promise<MachineTelemetry> | undefined;
  return async (
    watchPorts: unknown = [],
    interval: number = 300,
    previous?: MachineTelemetry,
  ): Promise<MachineTelemetry> => {
    const targets = WatchPortsSchema.parse(watchPorts);
    const slowIntervalSeconds = SlowIntervalSchema.parse(interval);
    if (pending) return pending;
    pending = (async () => {
      if (!slow && previous?.diskObservedAt && previous.temperature)
        slow = {
          disk: previous.resources?.disk ?? null,
          temperature: previous.temperature,
          observedAt: previous.diskObservedAt,
        };
      const elapsed = slow
        ? source.now() - Date.parse(slow.observedAt)
        : Infinity;
      const low =
        elapsed < 0 || elapsed >= slowIntervalSeconds * 1000
          ? source.slow().then((value) => {
              slow = {
                ...value,
                observedAt: new Date(source.now()).toISOString(),
              };
            })
          : Promise.resolve();
      const [sample, ports, connections] = await Promise.all([
        source.fast().catch(() => null),
        Promise.all(targets.map(checkPort)),
        source.connections(),
        low,
      ]);
      return MachineTelemetrySchema.parse({
        observedAt: new Date(source.now()).toISOString(),
        sampleIntervalSeconds: 30,
        slowIntervalSeconds,
        diskObservedAt: slow?.observedAt,
        temperature: slow && {
          ...slow.temperature,
          observedAt: slow.observedAt,
        },
        resources: sample && { ...sample, disk: slow?.disk ?? null },
        ports,
        ...connections,
      });
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
}
export const collectTelemetry = createTelemetrySampler();
