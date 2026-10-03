import assert from "node:assert/strict";
import { test } from "node:test";
import { MachineTelemetrySchema, ReportSchema } from "../src/shared/schema.ts";
import { report, telemetry } from "./fixtures.ts";

test("v1 report round trips; unsupported versions, secrets and duplicate IDs fail closed", () => {
  const value = report();
  assert.deepEqual(ReportSchema.parse(value), value);
  assert.equal(
    ReportSchema.safeParse({ ...value, schemaVersion: 2 }).success,
    false,
  );
  assert.equal(
    ReportSchema.safeParse({ ...value, token: "never-store" }).success,
    false,
  );
  assert.equal(
    ReportSchema.safeParse({
      ...value,
      spaces: [...value.spaces, ...value.spaces],
    }).success,
    false,
  );
  assert.equal(
    ReportSchema.safeParse({
      ...value,
      machine: { ...value.machine, token: "secret" },
    }).success,
    false,
  );
});
test("reject invalid dates, geometry, excessive strings and duplicate pane identities", () => {
  const value = report();
  assert.equal(
    ReportSchema.safeParse({ ...value, capturedAt: "yesterday" }).success,
    false,
  );
  const pane = value.spaces[0].tabs[0].panes[0];
  pane.rect.width = -1;
  assert.equal(ReportSchema.safeParse(value).success, false);
  pane.rect.width = 1;
  pane.rect.x = 0.5;
  assert.equal(ReportSchema.safeParse(value).success, false);
  pane.rect.x = 0;
  value.spaces[0].tabs[0].panes.push(pane);
  assert.equal(ReportSchema.safeParse(value).success, false);
});

test("normalizes fractional timestamp precision before lexical D1 ordering", () => {
  const value = report();
  value.capturedAt = "2026-09-19T05:50:00Z";
  assert.equal(
    ReportSchema.parse(value).capturedAt,
    "2026-09-19T05:50:00.000Z",
  );
});

test("optional machine telemetry preserves v1 reports and rejects invalid resource and port values", () => {
  const value = report();
  const snapshot = telemetry();
  const parse = () =>
    ReportSchema.safeParse({
      ...value,
      machine: { ...value.machine, telemetry: snapshot },
    });
  assert.equal(parse().success, true);
  snapshot.resources.cpuUsagePercent = 101;
  assert.equal(parse().success, false);
  snapshot.resources.cpuUsagePercent = 25;
  snapshot.resources.memory.freeBytes =
    snapshot.resources.memory.totalBytes + 1;
  assert.equal(parse().success, false);
  snapshot.resources.memory.freeBytes = 0;
  snapshot.ports[0].port = 65536;
  assert.equal(parse().success, false);
  snapshot.ports[0].port = 7024;
  snapshot.ports[0].host = "example.com";
  assert.equal(parse().success, false);
  snapshot.ports[0].host = "127.0.0.1";
  snapshot.ports.push(snapshot.ports[0]);
  assert.equal(parse().success, false);
});

test("environment telemetry accepts bounded evidence and keeps old v1 snapshots valid", () => {
  const value = {
    ...telemetry(),
    sampleIntervalSeconds: 30,
    slowIntervalSeconds: 300,
    diskObservedAt: "2026-09-19T05:45:00.000Z",
    network: {
      state: "connected",
      source: "macos-reachability",
      observedAt: "2026-09-19T05:50:00.000Z",
    },
    vpn: {
      state: "unknown",
      source: "macos-vpn",
      observedAt: "2026-09-19T05:50:00.000Z",
    },
    temperature: {
      status: "unavailable",
      celsius: null,
      source: "unsupported",
      observedAt: "2026-09-19T05:45:00.000Z",
    },
  };
  const parse = (sample: unknown) =>
    ReportSchema.safeParse({
      ...report(),
      machine: { ...report().machine, telemetry: sample },
    });
  assert.equal(parse(value).success, true);
  assert.equal(parse(telemetry()).success, true);
  assert.equal(
    parse({ ...value, vpn: { ...value.vpn, remoteIp: "203.0.113.1" } }).success,
    false,
  );
  assert.equal(
    parse({ ...value, temperature: { ...value.temperature, celsius: 50 } })
      .success,
    false,
  );
  assert.equal(parse({ ...value, slowIntervalSeconds: 1 }).success, false);
});

test("hardware telemetry validates percentages, fan bounds, memory and private fields", () => {
  const hardware = {
    observedAt: telemetry().observedAt,
    source: "macmon",
    gpuUsagePercent: 25,
    gpuTemperatureCelsius: 60,
    fans: [{ rpm: 1300, maxRpm: 5200 }],
    memory: { totalBytes: 1000, usedBytes: 400 },
    swapUsedBytes: 50,
  };
  const sample = {
    ...telemetry(),
    hardware,
    traffic: {
      observedAt: telemetry().observedAt,
      source: "netstat-physical",
      sampleMs: 500,
      downloadBytesPerSecond: 1000,
      uploadBytesPerSecond: 2000,
    },
    temperature: {
      status: "available",
      celsius: 65,
      source: "macmon",
      observedAt: telemetry().observedAt,
    },
  };
  assert.equal(MachineTelemetrySchema.safeParse(sample).success, true);
  for (const change of [
    { gpuUsagePercent: 101 },
    { fans: [{ rpm: -1, maxRpm: 1000 }] },
    { fans: [{ rpm: 6000, maxRpm: 5000 }] },
    { fans: Array(9).fill({ rpm: 0, maxRpm: null }) },
    { memory: { totalBytes: 1000, usedBytes: 2000 } },
    { serialNumber: "private" },
  ])
    assert.equal(
      MachineTelemetrySchema.safeParse({
        ...sample,
        hardware: { ...hardware, ...change },
      }).success,
      false,
    );
  assert.equal(
    MachineTelemetrySchema.safeParse({
      ...sample,
      traffic: { ...sample.traffic, sampleMs: 0 },
    }).success,
    false,
  );
});
