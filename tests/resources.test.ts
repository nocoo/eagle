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
