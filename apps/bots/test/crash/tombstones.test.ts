import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readReplicaBinding } from "../../src/runtime/pi/ReplicaStore.ts";
import { waitFor } from "../support/pi.ts";
import { startStack } from "../support/server.ts";

test("SIGKILL after the tombstone commit reconciles before any SDK recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-tombstone-crash-"));
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "test/crash/support/tombstone-child.ts", root],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk.toString();
  });
  const exited = once(child, "exit");
  try {
    await waitFor(() => output.includes("marked-before-move"), "catalog committed before move");
    assert.equal(errors, "");
    child.kill("SIGKILL");
    assert.deepEqual(await exited, [null, "SIGKILL"]);
    const binding = await readReplicaBinding(
      join(root, "bots/b_marked/replica.sqlite"),
      "b_marked",
    );
    assert.ok(binding);
    const before = JSON.parse(await readFile(join(root, "catalog.json"), "utf8"));
    assert.deepEqual(before.tombstones, [{ sharedBotId: binding.sharedBotId }]);
    assert.deepEqual(before.cleanup, { b_marked: binding.sharedBotId });
    await access(join(root, "bots/b_marked/session.sqlite"));
    await assert.rejects(access(join(root, "trash/b_marked")), { code: "ENOENT" });
    const daemon = await startStack({ root, real: true });
    try {
      assert.equal(daemon.opens(), 0, "cleanup precedes all SDK opens/resume");
      assert.equal(daemon.faux?.state.callCount, 0);
      assert.deepEqual(daemon.registry.summaries(), []);
      assert.deepEqual(
        await readFile(join(root, "trash/b_marked/workspace/original.txt")),
        Buffer.from("preserved before move 原字节"),
      );
      assert.deepEqual(
        await readReplicaBinding(join(root, "trash/b_marked/replica.sqlite"), "b_marked"),
        binding,
      );
      const after = JSON.parse(await readFile(join(root, "catalog.json"), "utf8"));
      assert.deepEqual(after.bots, []);
      assert.deepEqual(after.tombstones, before.tombstones);
      assert.equal(after.cleanup, undefined);
    } finally {
      await daemon.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});
