import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ResourceSample,
  resourcePoints,
} from "../src/shared/resources.ts";

test("resource chart preserves non-percent load, null measurements, long gaps and offline tails", () => {
  const point = (seconds: number): ResourceSample => ({
    observedAt: new Date(seconds * 1000).toISOString(),
    intervalSeconds: 30,
    cpu: 20,
    memory: 75,
    load: [150, 60, 40],
  });
  const points = resourcePoints(
    [point(0), { ...point(30), cpu: null }, point(180)],
    new Date(300000).toISOString(),
  );
  assert.deepEqual(
    points.map((p) => p.at),
    [0, 30000, 60000, 180000, 300000],
  );
  assert.equal(points[0].load1, 150);
  assert.equal(points[1].cpu, null);
  assert.equal(points[2].memory, null);
  assert.equal(points[4].load1, null);
  assert.deepEqual(resourcePoints([], new Date().toISOString()), []);
});

test("unknown resource cadence does not fabricate gaps or extrapolate its tail", () => {
  const samples: ResourceSample[] = [0, 120, 240].map((seconds) => ({
    observedAt: new Date(seconds * 1000).toISOString(),
    intervalSeconds: null,
    cpu: 25,
    memory: 75,
    load: [1, 2, 3],
  }));
  const current = resourcePoints(samples, samples[2].observedAt);
  assert.deepEqual(
    current.map((point) => [point.at, point.cpu]),
    [
      [0, 25],
      [120000, 25],
      [240000, 25],
    ],
  );
  const historical = resourcePoints(samples, new Date(250000).toISOString());
  assert.deepEqual(historical.slice(0, -1), current);
  assert.equal(historical.at(-1)?.at, 250000);
  assert.equal(historical.at(-1)?.cpu, null);
  samples[1].intervalSeconds = 30;
  assert.deepEqual(
    resourcePoints(samples, samples[2].observedAt).map((point) => point.at),
    [0, 120000, 150000, 240000],
  );
});
