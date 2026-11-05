import { test } from "node:test";
import { verifyRenewal } from "./device-cloud-renewal-fixture.ts";

test("an old HTTP 401 cannot invalidate a newly renewed session", {
  timeout: 15000,
}, async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  try {
    await verifyRenewal("stale-http", (milliseconds) =>
      t.mock.timers.tick(milliseconds),
    );
  } finally {
    t.mock.timers.reset();
  }
});
