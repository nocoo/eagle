// Ladder rows 53b and R4: a delete killed after the rename is finished by the next start,
// and a killed process cannot log its own failure (docs/bots/OBSERVABILITY.md, R4).
import assert from "node:assert/strict";
import { access, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { daemonRoot, spawnDaemon, spawnScript } from "../support/daemon.ts";

test("a delete killed after its rename reconciles on the next start", async () => {
  const root = await daemonRoot("bots-crash-delete-");
  const child = spawnScript({
    script: "test/crash/support/rename-child.ts",
    args: [root, "b_crash"],
  });
  try {
    await child.waitForMarker("renamed", 10_000);
    await child.stop();

    // The state a killed delete leaves: trash/<id> present, the catalog still naming it.
    const before = JSON.parse(await readFile(join(root, "catalog.json"), "utf8")) as {
      bots: { id: string }[];
    };
    assert.deepEqual(
      before.bots.map((bot) => bot.id),
      ["b_crash"],
      "the kill landed between the two steps",
    );
    await access(join(root, "trash", "b_crash"));
  } finally {
    await child.stop();
  }

  const daemon = spawnDaemon({ root });
  try {
    await daemon.waitForStart();
    const after = JSON.parse(await readFile(join(root, "catalog.json"), "utf8")) as {
      bots: { id: string }[];
    };
    assert.deepEqual(after.bots, [], "startup reconciliation finished the delete");
    await access(join(root, "trash", "b_crash"));

    const logs = (await readdir(join(root, "logs"))).filter((name) => name.endsWith(".jsonl"));
    const records = (
      await Promise.all(logs.map((name) => readFile(join(root, "logs", name), "utf8")))
    )
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { evt: string; trace: string; botId?: string });
    const reconciled = records.filter((record) => record.evt === "core.reconcile.ok");
    assert.ok(reconciled.length > 0, "the restart records what it finished");
    assert.ok(
      records.every((record) => record.evt !== "core.delete.fail"),
      "a killed process cannot log a failure it never saw",
    );
  } finally {
    await daemon.stop();
    await rm(root, { recursive: true, force: true });
  }
});
