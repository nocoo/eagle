import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const input = JSON.parse(fs.readFileSync(0, "utf8"));
if (input.mode === "link-crash") {
  const original = fs.linkSync;
  fs.linkSync = (...args) => {
    original(...args);
    process.kill(process.pid, "SIGKILL");
  };
  syncBuiltinESMExports();
}
const { SyncObjectStore, acceptedPin, preparePage } = await import(
  pathToFileURL(resolve("apps/bots/src/sync-objects.ts")).href
);
if (input.mode === "prepare") {
  const prepared = preparePage(
    input.page,
    input.publisher,
    input.origin,
  ).encrypt();
  process.stdout.write(
    JSON.stringify({ ...prepared, key: prepared.key.toString("base64url") }),
  );
} else if (input.mode === "record") {
  const carrier = input.carrier;
  process.stdout.write(
    JSON.stringify({ ...input.record, carrier, pin: acceptedPin(carrier) }),
  );
} else if (input.mode === "wrong-object-winner") {
  const { root, record, other } = input;
  const objectId = record.carrier.manifest.objectId;
  assert.notEqual(other.carrier.manifest.objectId, objectId);
  assert.equal(other.botId, record.botId);
  assert.deepEqual(other.binding, record.binding);
  assert.deepEqual(other.pin.publisher, record.pin.publisher);
  const outcomes = [];
  for (const mode of ["EEXIST", "unknown-result"]) {
    const directory = join(root, mode);
    fs.mkdirSync(directory, { mode: 0o700 });
    const store = new SyncObjectStore(directory);
    const legal = await store.stage(other);
    legal.publish();
    assert.deepEqual(legal.complete(), other);
    assert.deepEqual(store.read(other.carrier.manifest.objectId), other);
    assert.equal(store.read(objectId), undefined);
    const pending = await store.stage(record);
    const destination = join(directory, "sync-objects/v1", objectId + ".json");
    const bytes = JSON.stringify(other);
    fs.writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
    if (mode === "EEXIST") pending.publish();
    assert.equal(pending.published, false);
    try {
      const winner = pending.complete();
      outcomes.push({
        mode,
        accepted: true,
        objectId: winner.carrier.manifest.objectId,
      });
    } catch (error) {
      assert.match(error.message, /sync_object_id_invalid/);
      outcomes.push({ mode, accepted: false, error: error.message });
    } finally {
      pending.discard();
    }
    assert.equal(fs.readFileSync(destination, "utf8"), bytes);
    assert.throws(() => store.read(objectId), /sync_object_id_invalid/);
  }
  process.stdout.write(JSON.stringify(outcomes));
} else if (input.mode === "slots") {
  const { root, record, issuer, recipient, descriptors } = input;
  const store = new SyncObjectStore(root);
  const first = store
    .recipient(
      record,
      issuer,
      recipient,
      descriptors[0].issuer,
      descriptors[0].recipient,
    )
    .read();
  assert(first);
  for (const pair of descriptors) {
    const selected = new SyncObjectStore(root)
      .recipient(record, issuer, recipient, pair.issuer, pair.recipient)
      .read();
    assert.deepEqual(selected, first);
    const bad = { ...pair.recipient, signature: "A".repeat(86) };
    assert.throws(() =>
      store.recipient(record, issuer, recipient, pair.issuer, bad),
    );
  }
  process.stdout.write(
    JSON.stringify({
      sameUnsignedSlot: true,
      originalEnvelope: true,
      actualDistinctSignature:
        descriptors[0].recipient.signature !==
        descriptors[1].recipient.signature,
    }),
  );
} else if (input.mode === "link-crash" || input.mode === "reply-crash") {
  const staged = await new SyncObjectStore(input.root).stage(input.record);
  staged.publish();
  process.kill(process.pid, "SIGKILL");
} else {
  const { root, record, other } = input;
  const objectId = record.carrier.manifest.objectId;
  assert.equal(other.carrier.manifest.objectId, objectId);
  assert.notEqual(
    other.carrier.manifest.cipherDigest,
    record.carrier.manifest.cipherDigest,
  );
  const store = new SyncObjectStore(root);
  const staged = await Promise.all([store.stage(record), store.stage(other)]);
  staged[0].publish();
  const winner = staged[0].complete();
  staged[1].publish();
  assert.deepEqual(staged[1].complete(), winner);
  assert.deepEqual(new SyncObjectStore(root).read(objectId), winner);
  const file = join(root, "sync-objects/v1", objectId + ".json");
  const bytes = fs.readFileSync(file);
  const retry = await store.stage(other);
  retry.publish();
  assert.deepEqual(retry.complete(), winner);
  assert.deepEqual(fs.readFileSync(file), bytes);

  const fixture = fileURLToPath(import.meta.url);
  for (const mode of ["link-crash", "reply-crash"]) {
    const crashRoot = join(root, mode);
    fs.mkdirSync(crashRoot, { mode: 0o700 });
    const result = spawnSync(process.execPath, [fixture], {
      input: JSON.stringify({ mode, root: crashRoot, record }),
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.signal, "SIGKILL", result.stderr);
    const destination = join(crashRoot, "sync-objects/v1", objectId + ".json");
    assert.equal(fs.statSync(destination).nlink, mode === "link-crash" ? 2 : 1);
    assert.deepEqual(new SyncObjectStore(crashRoot).read(objectId), record);
    assert.equal(fs.statSync(destination).nlink, 1);
    assert.deepEqual(fs.readdirSync(join(crashRoot, "sync-objects/v1")), [
      objectId + ".json",
    ]);
  }

  const unknown = join(root, "unknown-link");
  fs.linkSync(file, unknown);
  assert.throws(() => store.read(objectId), /sync_object_storage_failed/);
  assert.equal(fs.statSync(file).nlink, 2);
  assert(
    fs.existsSync(unknown),
    "unknown hardlinks are never repaired or removed",
  );
  fs.unlinkSync(unknown);
  fs.writeFileSync(file, "{broken", { mode: 0o600 });
  const corrupt = fs.readFileSync(file);
  assert.throws(() => store.read(objectId));
  const refused = await store.stage(other);
  refused.publish();
  assert.throws(() => refused.complete());
  assert.deepEqual(
    fs.readFileSync(file),
    corrupt,
    "a corrupt winner is never replaced",
  );
  process.stdout.write(
    JSON.stringify({
      concurrentWinner: true,
      retryStable: true,
      actualLinkCrash: true,
      lostReplyReopen: true,
      unknownLinkRejected: true,
      corruptWinnerRejected: true,
    }),
  );
}
