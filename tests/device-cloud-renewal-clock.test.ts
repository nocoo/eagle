import { test } from "node:test";
import { verifyRenewal } from "./device-cloud-renewal-fixture.ts";

test("renewal remains live past the old expiry and schedules the next renewal", {
  timeout: 15000,
}, async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  try {
    await verifyRenewal("success-clock", (milliseconds) =>
      t.mock.timers.tick(milliseconds),
    );
  } finally {
    t.mock.timers.reset();
  }
});
