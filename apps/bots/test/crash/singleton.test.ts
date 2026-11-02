// Ladder rows 48 and 54: a real daemon process, the kernel lock, and a takeover after the
// owner is killed outright (docs/bots/ARCHITECTURE.md, "Singleton lock").
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { type DaemonProcess, daemonRoot, spawnDaemon } from "../support/daemon.ts";

const start = (root: string): DaemonProcess => spawnDaemon({ root });

test("a SIGKILLed daemon is taken over on the next start", async () => {
  const root = await daemonRoot("bots-crash-");
  let first: DaemonProcess | undefined;
  let second: DaemonProcess | undefined;
  try {
    first = start(root);
    await first.waitForStart();

    // While it lives, a second daemon on the same root is refused even on another port.
    const rival = start(root);
    const refused = await rival.exited();
    assert.notEqual(refused.code, 0, "a live owner wins");
    assert.match(rival.stderr(), /already owns/, "and says which root it refused");
    // The kill is the point: no lock file to delete, no takeover race.
    await first.stop();
    first = undefined;

    second = start(root);
    await second.waitForStart();
  } finally {
    await second?.stop();
    await first?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("two daemons starting at once leave exactly one owner", async () => {
  const root = await daemonRoot("bots-crash-race-");
  const children = [start(root), start(root)];
  try {
    const settled = await Promise.all(
      children.map(async (child) => {
        try {
          await child.waitForStart();
          return "started" as const;
        } catch {
          return "refused" as const;
        }
      }),
    );
    assert.equal(settled.filter((state) => state === "started").length, 1, "one owner");
    assert.equal(settled.filter((state) => state === "refused").length, 1, "one refusal");
  } finally {
    for (const child of children) await child.stop();
    await rm(root, { recursive: true, force: true });
  }
});
