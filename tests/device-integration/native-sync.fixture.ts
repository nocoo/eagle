// Real Registry and independent holder for the owned anonymous-XPC native control test.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { deviceProcess, localCall, workerFixture } from "./device-fixtures.ts";

const root = mkdtempSync("/private/tmp/eagle-native-sync-");
const workerRoot = mkdtempSync(resolve(".local/native-sync-worker-"));
const worker = await workerFixture(workerRoot);
const holder = deviceProcess(join(root, "holder"), worker.origin);
const sharedBotId = randomUUID();
try {
  await holder.ready();
  console.log(
    JSON.stringify({
      root,
      origin: worker.origin,
      node: process.execPath,
      entry: resolve("packages/agent/dist/agent/device-service.js"),
      peerDeviceId: holder.deviceId,
    }),
  );
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line) as {
      method: string;
      code?: string;
      receiver?: string;
    };
    let result: unknown;
    if (request.method === "pair") {
      await holder.manage("pairing.redeem", {
        requestId: randomUUID(),
        code: request.code,
      });
      await holder.manage("sync.share", {
        sharedBotId,
        peerDeviceId: request.receiver,
        enabled: true,
      });
      result = { sharedBotId };
    } else if (request.method === "read") {
      const access = await localCall(holder.socketPath, "sync.access", {
        sharedBotId,
        peerDeviceId: request.receiver,
        purpose: "replica.read",
      });
      result = {
        authorized:
          (access as { sharedBotId: string }).sharedBotId === sharedBotId,
      };
    } else {
      assert.equal(request.method, "revoke");
      result = await holder.manage("sync.share", {
        sharedBotId,
        peerDeviceId: request.receiver,
        enabled: false,
      });
    }
    console.log(JSON.stringify(result));
  }
} finally {
  await holder.stop();
  await worker.mf.dispose();
  rmSync(root, { recursive: true, force: true });
  rmSync(workerRoot, { recursive: true, force: true });
}
