import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readReplicaBinding } from "../../src/runtime/pi/ReplicaStore.ts";
import { openReplica } from "../support/replica.ts";

test("binding discovery reads only existing replica storage and refuses corrupt or foreign ownership", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-read-binding-"));
  const a = await openReplica(dir);
  try {
    const binding = { ...a.sync.store.binding };
    await a.close();
    const path = join(dir, "replica.sqlite");
    const before = await readFile(path);
    assert.deepEqual(await readReplicaBinding(path, "b_replica"), binding);
    assert.deepEqual(await readFile(path), before);
    assert.equal(a.faux.state.callCount, 0);
    await assert.rejects(readReplicaBinding(path, "b_foreign"), /another Bot/);
    assert.equal(await readReplicaBinding(join(dir, "missing.sqlite"), "b_replica"), undefined);
    await assert.rejects(access(join(dir, "missing.sqlite")), { code: "ENOENT" });
    const corrupt = join(dir, "corrupt.sqlite");
    await writeFile(corrupt, "not SQLite");
    await assert.rejects(readReplicaBinding(corrupt, "b_replica"));
    await assert.rejects(readReplicaBinding(dir, "b_replica"));
    const empty = join(dir, "empty.sqlite");
    const db = new DatabaseSync(empty);
    db.exec("CREATE TABLE binding(id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    db.close();
    await assert.rejects(readReplicaBinding(empty, "b_replica"), /missing replica binding/);
  } finally {
    await a.close();
    await rm(dir, { recursive: true, force: true });
  }
});
