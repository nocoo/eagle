import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../packages/agent/config.ts";

const secure = {
  url: "https://eagle.example.test",
  token: "x".repeat(32),
  machineId: "mac-one",
  machineName: "Mac One",
};

test("a secure config keeps starting after a feature it named is retired", () => {
  const parsed = parseConfig({
    ...secure,
    manager: { id: "manager", command: ["hermes"] },
    evidenceFile: "/tmp/evidence.json",
  });
  assert.equal(parsed.machineId, "mac-one");
  assert.equal(parsed.intervalSeconds, 30);
  assert.deepEqual(parsed.watchPorts, []);
  assert.equal("manager" in parsed, false);
  assert.equal("evidenceFile" in parsed, false);
});

test("an invalid credential, cadence or endpoint still fails closed", () => {
  assert.throws(() => parseConfig({ ...secure, token: "short" }));
  assert.throws(() => parseConfig({ ...secure, url: "not-a-url" }));
  assert.throws(() => parseConfig({ ...secure, intervalSeconds: 60 }));
  assert.throws(() => parseConfig({ ...secure, machineId: "Mac One" }));
});
