// SG-002 baseline cursors (docs/bots/specs/SUPERAGENT-002-PROTOCOL.md §7): opaque, bound
// to source, epoch, catalog revision and per-Bot positions, and strict on decode.
import assert from "node:assert/strict";
import test from "node:test";
import {
  BASELINE_BODY_BYTES,
  BASELINE_MAX_BOTS,
  type Baseline,
  BaselineError,
  decodeBaseline,
  encodeBaseline,
} from "../../src/observation/cursor.ts";

const source = { id: "8f2a1c0d9be4f7a1", epoch: "6f1c2a90-1c1b-4a55-9a13-0d1e2f3a4b5c" };

const baseline: Baseline = {
  ...source,
  catalog: "a1b2c3d4e5f60718",
  positions: {
    b_3f1a: {
      incarnation: "9f31c0b4a7d20e55",
      generation: { min: "e_10", max: "e_91", count: 28 },
      state: "available",
      activity: "idle",
    },
    b_55e: {
      incarnation: "3d2a7c11be90f4a2",
      generation: { min: "e_1", max: "e_4", count: 4 },
      state: "available",
      activity: "running",
    },
  },
};

test("a baseline round-trips with its catalog revision and per-bot positions", () => {
  const token = encodeBaseline(baseline);
  assert.match(token, /^[A-Za-z0-9_-]+$/, "a token never needs escaping in a body");
  assert.deepEqual(decodeBaseline(token), baseline);
});

test("a baseline bound to another source, epoch or operation is refused", () => {
  const token = encodeBaseline(baseline);
  assert.throws(
    () => decodeBaseline(token, { source: "ffffffffffffffff" }),
    (error: unknown) => error instanceof BaselineError && error.reason === "cursor_invalid",
  );
  assert.throws(
    () => decodeBaseline(token, { epoch: "00000000-0000-4000-8000-000000000000" }),
    (error: unknown) => error instanceof BaselineError && error.reason === "cursor_reset",
  );
  assert.throws(
    () => decodeBaseline(token, { operation: "history" }),
    (error: unknown) => error instanceof BaselineError && error.reason === "cursor_invalid",
  );
});

test("a malformed or foreign baseline is invalid rather than best-effort", () => {
  for (const token of ["", "not-a-cursor", "e30", "eyJ2IjoxfQ"]) {
    assert.throws(
      () => decodeBaseline(token, source),
      (error: unknown) => error instanceof BaselineError && error.reason === "cursor_invalid",
      token,
    );
  }
  const unknownField = Buffer.from(
    JSON.stringify({ v: 1, k: "changes", s: source.id, e: source.epoch, c: "x", p: {}, x: 1 }),
  ).toString("base64url");
  assert.throws(
    () => decodeBaseline(unknownField, source),
    (error: unknown) => error instanceof BaselineError && error.reason === "cursor_invalid",
  );
});

test("a full 200-bot fleet fits the frozen changes body budget", () => {
  const positions: Record<string, Baseline["positions"][string]> = {};
  for (let index = 0; index < BASELINE_MAX_BOTS; index += 1) {
    positions[`b_${"x".repeat(22)}_${String(index).padStart(3, "0")}`] = {
      incarnation: "9f31c0b4a7d20e55",
      generation: { min: "e_12345678", max: "e_98765432", count: 123456 },
      state: "available",
      activity: "running",
    };
  }
  const token = encodeBaseline({ ...baseline, positions });
  const body = JSON.stringify({ cursor: token, limit: 100 });
  assert.ok(
    Buffer.byteLength(body) <= BASELINE_BODY_BYTES,
    `a 200-bot baseline body is ${Buffer.byteLength(body)} bytes`,
  );
});
