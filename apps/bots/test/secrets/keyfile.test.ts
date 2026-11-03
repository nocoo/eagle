// The secrets key file (docs/bots/EXTENSIONS-AND-TOOLS.md §6.5): 32 random bytes, base64url,
// written 0600 in a 0700 directory, and created only when a store really needs it.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadOrCreateSecretKey,
  readSecretKey,
  SECRET_KEY_BYTES,
  SecretKeyError,
  writeSecretKey,
} from "../../src/secrets/keyfile.ts";

const bench = async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-secret-key-"));
  return { root, path: join(root, "state", "secrets.key") };
};

test("a missing key file is a refusal, not a new key", async () => {
  const { root, path } = await bench();
  try {
    await assert.rejects(readSecretKey(path), (error: unknown) => {
      assert.ok(error instanceof SecretKeyError);
      assert.equal(error.reason, "missing");
      return true;
    });
    await assert.rejects(readFile(path), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the first store that needs a key creates it, private", async () => {
  const { root, path } = await bench();
  try {
    const key = await loadOrCreateSecretKey(path);
    assert.equal(key.length, SECRET_KEY_BYTES);
    const info = await stat(path);
    assert.equal(info.mode & 0o777, 0o600, "the key file is private");
    assert.equal((await stat(join(root, "state"))).mode & 0o777, 0o700, "so is its directory");
    const text = await readFile(path, "utf8");
    assert.match(text, /^[A-Za-z0-9_-]{43}$/, "base64url without padding");
    assert.deepEqual(Buffer.from(text, "base64url"), Buffer.from(key));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a key that is already there is read, never replaced", async () => {
  const { root, path } = await bench();
  try {
    const first = await loadOrCreateSecretKey(path);
    const second = await loadOrCreateSecretKey(path);
    assert.deepEqual(Buffer.from(second), Buffer.from(first));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file that is not a 32-byte key is refused", async () => {
  const { root, path } = await bench();
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "state"), { recursive: true });
    await writeFile(path, Buffer.from(randomBytes(16)).toString("base64url"), "utf8");
    await assert.rejects(readSecretKey(path), (error: unknown) => {
      assert.ok(error instanceof SecretKeyError);
      assert.equal(error.reason, "invalid");
      return true;
    });
    await assert.rejects(loadOrCreateSecretKey(path), (error: unknown) => {
      assert.ok(error instanceof SecretKeyError);
      assert.equal(error.reason, "invalid");
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writing a key is exclusive: an existing file is never overwritten", async () => {
  const { root, path } = await bench();
  try {
    const first = randomBytes(SECRET_KEY_BYTES);
    await writeSecretKey(path, first);
    await assert.rejects(writeSecretKey(path, randomBytes(SECRET_KEY_BYTES)), /EEXIST/);
    assert.deepEqual(Buffer.from(await readSecretKey(path)), first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a key file that cannot be read says so", async () => {
  const { root, path } = await bench();
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path, { recursive: true });
    await assert.rejects(readSecretKey(path), (error: unknown) => {
      assert.ok(error instanceof SecretKeyError);
      assert.equal(error.reason, "unreadable");
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
