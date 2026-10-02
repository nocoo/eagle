import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { networkInterfaces, platform } from "node:os";
import { promisify } from "node:util";
import type { MachineTelemetry } from "../src/shared/schema.ts";

type ConnectionState = "connected" | "disconnected" | "unknown";
const exec = promisify(execFile);
async function command(file: string, args: string[]) {
  try {
    return (
      await exec(file, args, {
        timeout: 1500,
        maxBuffer: 32768,
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
      })
    ).stdout.trim();
  } catch {
    return null;
  }
}
export function networkState(
  os: string,
  value: string | null,
): ConnectionState {
  if (value === null) return "unknown";
  if (os === "darwin") {
    if (value === "Not Reachable") return "disconnected";
    if (
      /^Reachable(?:,|$)/.test(value) &&
      !/Connection Required|Connection On Demand|Connection On Traffic/.test(
        value,
      )
    )
      return "connected";
  }
  if (os === "linux") {
    if (/^connected(?: \(.*\))?$/.test(value)) return "connected";
    if (value === "disconnected" || value === "asleep") return "disconnected";
  }
  return "unknown";
}
export function vpnState(
  os: string,
  value: string | null,
  interfaces: string[],
): ConnectionState {
  if (value === null) return "unknown";
  if (os === "darwin" && /^\s*\*?\s*\(Connected\)\s/m.test(value))
    return "connected";
  if (os === "linux" && /^vpn:activated$/m.test(value)) return "connected";
  if (interfaces.some((name) => /^(utun|tun|tap|wg|ppp|ipsec)/i.test(name)))
    return "unknown";
  const statuses = [...value.matchAll(/^\s*\*?\s*\(([^)]+)\)\s/gm)].map(
    (match) => match[1],
  );
  if (
    os === "darwin" &&
    statuses.length &&
    statuses.every((state) => state === "Disconnected")
  )
    return "disconnected";
  if (
    os === "linux" &&
    value
      .split("\n")
      .every((line) =>
        /^(802-3-ethernet|802-11-wireless|bridge|loopback|bond|team|vlan):activated$/.test(
          line,
        ),
      )
  )
    return "disconnected";
  return "unknown";
}
export async function readConnections(): Promise<
  Pick<MachineTelemetry, "network" | "vpn">
> {
  const os = platform();
  const [network, vpn] =
    os === "darwin"
      ? await Promise.all([
          command("/usr/sbin/scutil", ["-r", "0.0.0.0"]),
          command("/usr/sbin/scutil", ["--nc", "list"]),
        ])
      : os === "linux"
        ? await Promise.all([
            command("nmcli", ["-t", "-f", "STATE", "general"]),
            command("nmcli", [
              "-t",
              "-f",
              "TYPE,STATE",
              "connection",
              "show",
              "--active",
            ]),
          ])
        : [null, null];
  const observedAt = new Date().toISOString();
  return {
    network: {
      state: networkState(os, network),
      source:
        os === "darwin"
          ? "macos-reachability"
          : os === "linux"
            ? "network-manager"
            : "unsupported",
      observedAt,
    },
    vpn: {
      state: vpnState(os, vpn, Object.keys(networkInterfaces())),
      source:
        os === "darwin"
          ? "macos-vpn"
          : os === "linux"
            ? "network-manager"
            : "unsupported",
      observedAt,
    },
  };
}
export async function readTemperature(
  os = platform(),
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
  list: (path: string) => Promise<string[]> = readdir,
): Promise<Omit<NonNullable<MachineTelemetry["temperature"]>, "observedAt">> {
  const unavailable = {
    status: "unavailable",
    celsius: null,
    source: "unsupported",
  } as const;
  if (os !== "linux") return unavailable;
  const zones = await list("/sys/class/thermal").catch(() => []);
  const temperatures: number[] = [];
  for (const zone of zones
    .filter((name) => /^thermal_zone\d+$/.test(name))
    .slice(0, 16)) {
    try {
      const base = `/sys/class/thermal/${zone}`;
      const type = (await read(`${base}/type`)).trim();
      if (!/^(x86_pkg_temp|cpu-thermal|cpu_thermal|soc_thermal)$/.test(type))
        continue;
      const value = Number((await read(`${base}/temp`)).trim()) / 1000;
      if (Number.isFinite(value) && value >= -20 && value <= 150)
        temperatures.push(value);
    } catch {
      /* Unreadable sensors must not become zero degrees. */
    }
  }
  return temperatures.length
    ? {
        status: "available",
        celsius: Math.max(...temperatures),
        source: "linux-cpu-thermal",
      }
    : { ...unavailable, source: "linux-cpu-thermal" };
}
