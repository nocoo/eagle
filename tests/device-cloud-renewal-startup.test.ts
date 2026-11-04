import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyRenewal } from "./device-cloud-renewal-fixture.ts";

test("a missing ready frame is bounded even when the clock is mocked", {
  timeout: 8000,
}, async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  try {
    await assert.rejects(
      verifyRenewal("no-ready"),
      (error: unknown) =>
        error instanceof AggregateError &&
        error.errors.length === 1 &&
        error.errors[0] instanceof Error &&
        error.errors[0].message === "cloud startup timeout",
    );
  } finally {
    t.mock.timers.reset();
  }
});
