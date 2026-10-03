import { execFile } from "node:child_process";
import { platform } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";
import type { MachineTelemetry } from "../src/shared/schema.ts";

const exec = promisify(execFile);
type Command = (file: string, args: string[]) => Promise<string | null>;
const command: Command = async (file, args) => {
  try {
    return (
      await exec(file, args, {
        timeout: 2500,
        maxBuffer: 65536,
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
      })
    ).stdout;
  } catch {
    return null;
  }
};
const temperature = z.number().min(-20).max(150).nullable().catch(null);
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const macmon = z.object({
  gpu_active_ratio: z.number().min(0).max(1).nullable().catch(null),
  temp: z
    .object({ cpu_temp_avg: temperature, gpu_temp_avg: temperature })
    .catch({ cpu_temp_avg: null, gpu_temp_avg: null }),
  fans: z
    .array(
      z
        .object({
          rpm: z.number().min(0).max(30000),
          max_rpm: z.number().positive().max(30000).nullable().catch(null),
        })
        .refine((fan) => fan.max_rpm === null || fan.rpm <= fan.max_rpm),
    )
    .max(8)
    .nullable()
    .catch(null),
  memory: z
    .object({
      ram_total: bytes.positive(),
      ram_usage: bytes,
      swap_usage: bytes.nullable().catch(null),
    })
    .refine((memory) => memory.ram_usage <= memory.ram_total)
    .nullable()
    .catch(null),
});
export function parseMacmon(output: string) {
  try {
    const value = macmon.parse(JSON.parse(output));
    return {
      cpuTemperature: value.temp.cpu_temp_avg,
      gpuUsagePercent:
        value.gpu_active_ratio === null
          ? null
          : Math.round(value.gpu_active_ratio * 1000) / 10,
      gpuTemperatureCelsius: value.temp.gpu_temp_avg,
      fans:
        value.fans?.map((fan) => ({ rpm: fan.rpm, maxRpm: fan.max_rpm })) ??
        null,
      memory: value.memory
        ? {
            totalBytes: value.memory.ram_total,
            usedBytes: value.memory.ram_usage,
          }
        : null,
      swapUsedBytes: value.memory?.swap_usage ?? null,
    };
  } catch {
    return null;
  }
}
export async function readHardware(os = platform(), run: Command = command) {
  if (os !== "darwin") return null;
  const output = await run("macmon", [
    "pipe",
    "--samples",
    "1",
    "--interval",
    "500",
  ]);
  return output === null ? null : parseMacmon(output);
}

type Counters = Record<string, { received: number; sent: number }>;
export function parseNetworkCounters(output: string): Counters {
  const counters: Counters = {};
  for (const line of output.trim().split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (!/^en\d+$/.test(fields[0]) || !/^<Link#\d+>$/.test(fields[2] ?? ""))
      continue;
    if (
      fields.length < 10 ||
      !/^\d+$/.test(fields.at(-5) ?? "") ||
      !/^\d+$/.test(fields.at(-2) ?? "")
    )
      return {};
    const received = Number(fields.at(-5));
    const sent = Number(fields.at(-2));
    if (
      !Number.isSafeInteger(received) ||
      !Number.isSafeInteger(sent) ||
      counters[fields[0]]
    )
      return {};
    counters[fields[0]] = { received, sent };
  }
  return counters;
}
export function networkRates(
  before: Counters,
  after: Counters,
  elapsed: number,
) {
  const names = Object.keys(before).sort();
  if (
    elapsed <= 0 ||
    elapsed > 10000 ||
    !names.length ||
    names.join(",") !== Object.keys(after).sort().join(",")
  )
    return null;
  let received = 0;
  let sent = 0;
  for (const name of names) {
    const incoming = after[name].received - before[name].received;
    const outgoing = after[name].sent - before[name].sent;
    if (incoming < 0 || outgoing < 0) return null;
    received += incoming;
    sent += outgoing;
  }
  return {
    downloadBytesPerSecond: Math.round((received * 1000) / elapsed),
    uploadBytesPerSecond: Math.round((sent * 1000) / elapsed),
  };
}
export async function readTraffic(): Promise<MachineTelemetry["traffic"]> {
  if (platform() !== "darwin") return undefined;
  const first = await command("/usr/sbin/netstat", ["-ibn"]);
  if (first === null) return undefined;
  const started = performance.now();
  await delay(500);
  const second = await command("/usr/sbin/netstat", ["-ibn"]);
  if (second === null) return undefined;
  const sampleMs = performance.now() - started;
  const rates = networkRates(
    parseNetworkCounters(first),
    parseNetworkCounters(second),
    sampleMs,
  );
  return rates
    ? {
        ...rates,
        sampleMs,
        source: "netstat-physical",
        observedAt: new Date().toISOString(),
      }
    : undefined;
}
