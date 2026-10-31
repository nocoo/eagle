import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { deviceSyncAccess, deviceSyncInput } from "../../src/core/DeviceSyncPort.ts";

test("the independent device sync codec retains the normative HTTP metadata and refuses spoofed scope", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../../../fixtures/bots-protocol/sync-access.http.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(deviceSyncInput.parse(fixture.request), fixture.request);
  assert.deepEqual(deviceSyncAccess.parse(fixture.response), fixture.response);
  for (const extra of [
    { sharedBotId: fixture.response.sharedBotId },
    { deviceId: fixture.response.local.deviceId },
    { purpose: "execute" },
  ])
    assert.equal(deviceSyncInput.safeParse({ ...fixture.request, ...extra }).success, false);
  for (const address of ["127.0.0.1", "192.168.1.1", "100.128.1.1", "fd00::1"])
    assert.equal(
      deviceSyncAccess.safeParse({
        ...fixture.response,
        endpoints: { ...fixture.response.endpoints, candidates: [{ address, port: 7015 }] },
      }).success,
      false,
    );
});
