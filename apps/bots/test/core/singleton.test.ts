// Ladder row 48: the root is owned by a kernel listener, so a second daemon on the same
// root is refused and a killed one releases the port.
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import test from "node:test";
import { acquireLock, fnv1a, LockError, lockPort } from "../../src/server/singleton.ts";
import { daemonRoot, freeLockPort, rootWithLockPort } from "../support/daemon.ts";

test("a live daemon rejects a second instance on the same root", async () => {
  // The root decides the port, so the root is one whose port nobody holds: a port another
  // daemon took would refuse this owner for a reason that is not under test.
  const root = await daemonRoot("bots-lock-");
  try {
    const owner = await acquireLock({ root, pid: 4711 });
    assert.equal(owner.port, lockPort(root));
    await assert.rejects(
      () => acquireLock({ root, pid: 4712 }),
      (error: unknown) => error instanceof LockError && error.reason === "running",
      "the second daemon is refused, and the root alone decides the port",
    );
    await owner.close();
    const taken = await acquireLock({ root, pid: 4713 });
    assert.equal(taken.port, owner.port, "the port is free once the owner is gone");
    await taken.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the lock port is derived from the root alone", () => {
  assert.equal(lockPort("/tmp/a"), 44000 + (fnv1a("/tmp/a") % 1000));
  assert.notEqual(lockPort("/tmp/a"), lockPort("/tmp/b"));
  assert.ok(lockPort("/tmp/a") >= 44000 && lockPort("/tmp/a") < 45000);
  assert.equal(lockPort("/tmp/a"), lockPort("/tmp/a"), "the same root always maps to one port");
});

test("two roots that hash to one lock port fail as a collision", async () => {
  // Two roots on one port: the port is free, so the first root owns it and the second
  // is refused for the reason under test.
  const port = await freeLockPort();
  const first = await rootWithLockPort(port, "bots-collision-a-", { create: false });
  const second = await rootWithLockPort(port, "bots-collision-b-", { create: false });
  const owner = await acquireLock({ root: first, pid: 1 });
  await assert.rejects(
    () => acquireLock({ root: second, pid: 2 }),
    (error: unknown) =>
      error instanceof LockError &&
      error.reason === "collision" &&
      /different root/.test(error.message),
    "the message names both roots and offers no override",
  );
  await owner.close();
});

test("two different roots that hash to one lock port are refused with both names", async () => {
  // The port is derived from the root alone, so a collision is a real possibility.
  const port = await freeLockPort();
  const first = await rootWithLockPort(port, "bots-collision-c-", { create: false });
  const second = await rootWithLockPort(port, "bots-collision-d-", { create: false });
  const owner = await acquireLock({ root: first });
  try {
    const refused = await acquireLock({ root: second }).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(refused instanceof LockError);
    assert.equal(refused.reason, "collision");
    assert.match(refused.message, /shared/);
    assert.ok(refused.message.includes(second), "the message names the loser's root");
    assert.ok(refused.message.includes(first), "and the owner's root");
  } finally {
    await owner.close();
  }
});

test("a half-spoken lock owner does not hang the probe", async () => {
  // Bind a fake owner on a port the lock derivation can produce, then answer with a
  // partial line and close: the probe must resolve, not wait for a newline that never
  // comes.
  let root: string | undefined;
  const owner = createServer((socket) => {
    socket.once("data", () => {
      socket.write(root ?? "");
      socket.end();
    });
  });
  for (let index = 0; index < 40_000 && root === undefined; index += 1) {
    const candidate = `/tmp/bots-partial-${index}`;
    const port = lockPort(candidate);
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        owner.once("error", onError);
        owner.listen(port, "127.0.0.1", () => {
          owner.off("error", onError);
          resolve();
        });
      });
      root = candidate;
    } catch {
      // that port is taken; try the next candidate root
    }
  }
  assert.ok(root !== undefined, "a free port in the lock range was found");
  const started = Date.now();
  try {
    const outcome = await acquireLock({ root, probeTimeoutMs: 30 }).then(
      (acquired) => {
        void acquired.close();
        return "acquired";
      },
      (error: unknown) => error,
    );
    assert.ok(outcome instanceof LockError, "the probe fails instead of hanging");
    assert.equal((outcome as LockError).reason, "unavailable");
    assert.ok(Date.now() - started < 1_000, "and it does not wait for the deadline");
  } finally {
    await new Promise<void>((resolve) => owner.close(() => resolve()));
  }
});
