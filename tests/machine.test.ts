import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";
import { collectTelemetry, cpuUsage } from "../agent/machine.ts";

test("CPU usage uses sample deltas, handles missing samples and idle CPUs", () => {
  assert.equal(
    cpuUsage({ idle: 100, total: 200 }, { idle: 175, total: 300 }),
    25,
  );
  assert.equal(
    cpuUsage({ idle: 100, total: 200 }, { idle: 200, total: 300 }),
    0,
  );
  assert.equal(
    cpuUsage({ idle: 100, total: 200 }, { idle: 100, total: 200 }),
    null,
  );
});

test("real local resource sampling and configured TCP checks distinguish open and closed ports", async () => {
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const target = { name: "Test service", port: address.port };
  try {
    const value = await collectTelemetry([target]);
    assert(value.resources);
    assert(value.resources.cpuCores > 0);
    assert(value.resources.memory.totalBytes > 0);
    assert(
      value.resources.cpuUsagePercent === null ||
        value.resources.cpuUsagePercent >= 0,
    );
    assert.equal(value.ports[0].status, "open");
    assert(value.ports[0].latencyMs !== null);
    assert.equal(value.ports[0].host, "127.0.0.1");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  const closed = await collectTelemetry([target]);
  assert.equal(closed.ports[0].status, "closed");
  assert.equal(closed.ports[0].latencyMs, null);
  assert.equal((await collectTelemetry([])).ports.length, 0);
  await assert.rejects(collectTelemetry([{ ...target, host: "example.com" }]));
});

test("slow probes are cached with their original timestamps, configurable, and shared during overlapping calls", async () => {
  const { createTelemetrySampler } = await import("../agent/machine.ts");
  const { telemetry } = await import("./fixtures.ts");
  let now = Date.parse("2026-10-02T00:00:00Z");
  let slowCalls = 0;
  let fastCalls = 0;
  const sample = createTelemetrySampler({
    now: () => now,
    fast: async () => {
      fastCalls++;
      return { ...telemetry().resources, loadAverage: [1, 2, 3] };
    },
    slow: async () => {
      slowCalls++;
      return {
        disk: telemetry().resources.disk,
        temperature: {
          status: "unavailable",
          celsius: null,
          source: "unsupported",
        },
      };
    },
    connections: async () => ({}),
  });
  const [first, concurrent] = await Promise.all([
    sample([], 300),
    sample([], 300),
  ]);
  assert.deepEqual(first, concurrent);
  assert.equal(fastCalls, 1);
  now += 30000;
  const second = await sample([], 300);
  assert.equal(slowCalls, 1);
  assert.equal(second.diskObservedAt, first.diskObservedAt);
  assert.notEqual(second.observedAt, first.observedAt);
  now += 30000;
  await sample([], 60);
  assert.equal(slowCalls, 2);
  now += 30000;
  const restarted = createTelemetrySampler({
    now: () => now,
    fast: async () => ({ ...telemetry().resources, loadAverage: [1, 2, 3] }),
    slow: async () => {
      throw Error("cached slow sample should survive restart");
    },
    connections: async () => ({}),
  });
  const cached = await restarted([], 300, second);
  assert.equal(cached.diskObservedAt, second.diskObservedAt);
  await assert.rejects(sample([], 1));
});
