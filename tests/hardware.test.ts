import assert from "node:assert/strict";
import { test } from "node:test";
import {
  networkRates,
  parseMacmon,
  parseNetworkCounters,
  readHardware,
} from "../agent/hardware.ts";

test("macmon maps bounded hardware evidence without leaking device identifiers", () => {
  const value = parseMacmon(
    JSON.stringify({
      gpu_active_ratio: 0.25,
      temp: { cpu_temp_avg: 65.5, gpu_temp_avg: 61 },
      fans: [{ name: "private-label", rpm: 1300, max_rpm: 5200 }],
      memory: { ram_total: 1000, ram_usage: 400, swap_usage: 50 },
      private: "not telemetry",
    }),
  );
  assert.deepEqual(value, {
    cpuTemperature: 65.5,
    gpuUsagePercent: 25,
    gpuTemperatureCelsius: 61,
    fans: [{ rpm: 1300, maxRpm: 5200 }],
    memory: { totalBytes: 1000, usedBytes: 400 },
    swapUsedBytes: 50,
  });
  assert.equal(parseMacmon("garbage"), null);
  const invalid = parseMacmon(
    JSON.stringify({
      gpu_active_ratio: 2,
      temp: { cpu_temp_avg: 999 },
      fans: [{ rpm: -1, max_rpm: 0 }],
    }),
  );
  assert.equal(invalid?.gpuUsagePercent, null);
  assert.equal(invalid?.cpuTemperature, null);
  assert.equal(invalid?.fans, null);
  assert.deepEqual(parseMacmon('{"fans":[]}')?.fans, []);
  assert.equal(
    parseMacmon('{"fans":[{"rpm":0,"max_rpm":5200}]}')?.fans?.[0].rpm,
    0,
  );
});

test("network rates count each physical interface once and reject resets or topology changes", () => {
  const counters =
    parseNetworkCounters(`Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
en0 1500 <Link#4> private 5 0 1000 5 0 2000 0
en0 1500 192.0.2 private 5 - 1000 5 - 2000 -
lo0 16384 <Link#1> 9 0 99000 9 0 99000 0
utun0 1500 <Link#8> 9 0 99000 9 0 99000 0`);
  assert.deepEqual(counters, { en0: { received: 1000, sent: 2000 } });
  assert.deepEqual(
    networkRates(counters, { en0: { received: 2000, sent: 2500 } }, 500),
    { downloadBytesPerSecond: 2000, uploadBytesPerSecond: 1000 },
  );
  assert.equal(
    networkRates(counters, { en0: { received: 0, sent: 0 } }, 500),
    null,
  );
  assert.equal(networkRates(counters, {}, 500), null);
  assert.equal(networkRates(counters, counters, 0), null);
  assert.equal(networkRates({}, {}, 500), null);
  assert.deepEqual(parseNetworkCounters("en0 1500 <Link#4> bad"), {});
});

test("hardware probe is unprivileged, bounded and optional", async () => {
  const calls: string[][] = [];
  const sample = await readHardware("darwin", async (file, args) => {
    calls.push([file, ...args]);
    return '{"gpu_active_ratio":0,"fans":[]}';
  });
  assert.equal(sample?.gpuUsagePercent, 0);
  assert.deepEqual(calls, [
    ["macmon", "pipe", "--samples", "1", "--interval", "500"],
  ]);
  assert.equal(
    await readHardware("linux", async () => {
      throw Error("must not run");
    }),
    null,
  );
  assert.equal(await readHardware("darwin", async () => null), null);
});
