import assert from "node:assert/strict";
import test from "node:test";
import { assertOutputExcludes } from "../scripts/eval-assertions.ts";

test("forbidden output fails without copying the forbidden value into the diagnostic", () => {
  const fixture = "fictional-secret-4b2d";
  for (const stream of ["stdout", "stderr"] as const) {
    assert.doesNotThrow(() => assertOutputExcludes("clean", fixture, "eagle-dev", stream));
    assert.throws(
      () => assertOutputExcludes(`prefix ${fixture} suffix`, fixture, "eagle-dev", stream),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(stream) &&
        !error.message.includes(fixture),
    );
    assert.doesNotThrow(() => assertOutputExcludes(fixture, undefined, "eagle-dev", stream));
  }
});
