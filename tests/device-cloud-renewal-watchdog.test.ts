import assert from "node:assert/strict";
import { test } from "node:test";
import { deadline } from "./device-cloud-renewal-fixture.ts";

test("renewal fixture deadlines expire without advancing a mocked clock", {
  timeout: 8000,
}, async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  try {
    await assert.rejects(
      deadline(new Promise(() => {}), "fixture"),
      /fixture timeout/,
    );
  } finally {
    t.mock.timers.reset();
  }
});
