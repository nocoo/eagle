import { test } from "node:test";
import { verifyRenewal } from "./device-cloud-renewal-fixture.ts";

test(
  "the real device client renews its target session without interrupting an operation",
  { timeout: 15000 },
  () => verifyRenewal("success"),
);
test(
  "a rejected renewal closes safely without repeating the operation",
  { timeout: 15000 },
  () => verifyRenewal("rejected"),
);
test(
  "a failed renewal reconnects with the still-valid new credential",
  { timeout: 15000 },
  () => verifyRenewal("reconnect"),
);
test(
  "a mismatched renewal acknowledgement closes safely",
  { timeout: 15000 },
  () => verifyRenewal("mismatched"),
);
test(
  "a lost renewal acknowledgement cannot extend the socket",
  { timeout: 15000 },
  () => verifyRenewal("lost"),
);
