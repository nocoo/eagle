// The secrets store (docs/bots/EXTENSIONS-AND-TOOLS.md §6.5): one encrypted document, two
// scopes, lazy expiry, and a refusal that never rewrites a file it could not read.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SecretsStorageError } from "../../src/core/domain.ts";
import { captureLog } from "../../src/log/log.ts";
import { SecretAudit } from "../../src/secrets/audit.ts";
import { SecretsStore } from "../../src/secrets/store.ts";

const bench = async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-secret-store-"));
  let clock = Date.parse("2026-11-03T01:10:00.000Z");
  const options = {
    dir: join(root, "config"),
    keyPath: join(root, "state", "secrets.key"),
    now: () => new Date(clock),
  };
  return {
    root,
    options,
    advance: (minutes: number) => {
      clock += minutes * 60_000;
    },
    done: () => rm(root, { recursive: true, force: true }),
  };
};

test("a saved value comes back and never sits in the file in plaintext", async () => {
  const { options, done } = await bench();
  try {
    const store = await SecretsStore.open(options);
    await store.save({
      botId: "b_1",
      key: "github-pat",
      value: "ghp_example",
      scope: "bot",
      purpose: "发布 Eagle 用",
      ttlMinutes: 60,
    });
    const read = await store.read({ botId: "b_1", key: "github-pat" });
    assert.deepEqual(read, { key: "github-pat", scope: "bot", value: "ghp_example" });

    const file = join(options.dir, "secrets.v1.enc");
    const raw = await readFile(file);
    assert.equal(raw.subarray(0, 4).toString("ascii"), "EGLS");
    assert.equal(raw.includes(Buffer.from("ghp_example")), false, "the value is encrypted");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(options.dir)).mode & 0o777, 0o700);
    assert.deepEqual(store.values(), ["ghp_example"]);
  } finally {
    await done();
  }
});

test("a store that has never been written is empty, not broken", async () => {
  const { done } = await bench();
  try {
    const store = await SecretsStore.open({
      dir: join(await mkdtemp(join(tmpdir(), "bots-secret-empty-")), "config"),
      keyPath: join(await mkdtemp(join(tmpdir(), "bots-secret-empty-")), "secrets.key"),
    });
    assert.equal(await store.read({ botId: "b_1", key: "absent" }), undefined);
    assert.deepEqual(await store.list({ botId: "b_1", limit: 20 }), {
      items: [],
      truncated: false,
    });
    assert.deepEqual(store.values(), []);
  } finally {
    await done();
  }
});

test("a store that cannot be decrypted is refused and never rewritten", async () => {
  const { root, options, done } = await bench();
  try {
    const store = await SecretsStore.open(options);
    await store.save({ botId: "b_1", key: "k", value: "v", scope: "bot" });
    const file = join(options.dir, "secrets.v1.enc");
    const before = await readFile(file);

    await assert.rejects(
      SecretsStore.open({ ...options, keyPath: join(root, "other.key") }),
      (error: unknown) => error instanceof SecretsStorageError,
    );
    assert.deepEqual(await readFile(file), before, "the file is untouched");
  } finally {
    await done();
  }
});

test("a body that is not the documented shape is refused and never rewritten", async () => {
  const { options, done } = await bench();
  try {
    const store = await SecretsStore.open(options);
    await store.save({ botId: "b_1", key: "k", value: "v", scope: "bot" });
    const file = join(options.dir, "secrets.v1.enc");
    const before = await readFile(file);

    // A container that decrypts but does not hold the documented document.
    const { seal } = await import("../../src/secrets/container.ts");
    const { loadOrCreateSecretKey } = await import("../../src/secrets/keyfile.ts");
    const key = await loadOrCreateSecretKey(options.keyPath);
    const broken = [
      "not json at all",
      "null",
      JSON.stringify(["records"]),
      JSON.stringify({ version: 2, records: [] }),
      JSON.stringify({ version: 1, records: {} }),
      JSON.stringify({ version: 1, records: ["a record"] }),
      JSON.stringify({ version: 1, records: [{ key: 7 }] }),
      JSON.stringify({ version: 1, records: [{ key: "k", scope: "all" }] }),
      JSON.stringify({ version: 1, records: [{ key: "k", scope: "bot" }] }),
      JSON.stringify({ version: 1, records: [{ key: "k", scope: "bot", botId: "b" }] }),
      JSON.stringify({
        version: 1,
        records: [{ key: "k", scope: "bot", botId: "b", value: "v", createdAt: "t" }],
      }),
      JSON.stringify({
        version: 1,
        records: [
          {
            key: "k",
            scope: "bot",
            botId: "b",
            value: "v",
            createdAt: "t",
            updatedAt: "t",
            purpose: 7,
          },
        ],
      }),
      JSON.stringify({
        version: 1,
        records: [
          {
            key: "k",
            scope: "bot",
            botId: "b",
            value: "v",
            createdAt: "t",
            updatedAt: "t",
            expiresAt: 7,
          },
        ],
      }),
    ];
    for (const document of broken) {
      await writeFile(file, seal(key, document));
      const written = await readFile(file);
      await assert.rejects(
        SecretsStore.open(options),
        (error: unknown) => error instanceof SecretsStorageError,
        document,
      );
      assert.deepEqual(await readFile(file), written, "the file is untouched");
    }
    assert.notDeepEqual(await readFile(file), before);
  } finally {
    await done();
  }
});

test("a missing key beside an existing ciphertext is a refusal, not a reset", async () => {
  const { options, done } = await bench();
  try {
    const store = await SecretsStore.open(options);
    await store.save({ botId: "b_1", key: "k", value: "v", scope: "bot" });
    const file = join(options.dir, "secrets.v1.enc");
    const before = await readFile(file);
    await rm(options.keyPath, { force: true });
    await assert.rejects(
      SecretsStore.open(options),
      (error: unknown) => error instanceof SecretsStorageError,
    );
    assert.deepEqual(await readFile(file), before, "the ciphertext is untouched");
    assert.equal(store.values().length, 1);
  } finally {
    await done();
  }
});

test("a container that is replaced by something else refuses every later call", async () => {
  const { options, done } = await bench();
  try {
    const store = await SecretsStore.open(options);
    await store.save({ botId: "b_1", key: "k", value: "v", scope: "bot" });
    await writeFile(join(options.dir, "secrets.v1.enc"), "not a container");
    await assert.rejects(
      store.read({ botId: "b_1", key: "k" }),
      (error: unknown) => error instanceof SecretsStorageError,
    );
    assert.equal(
      await readFile(join(options.dir, "secrets.v1.enc"), "utf8"),
      "not a container",
      "the file is never rewritten by a refusal",
    );
  } finally {
    await done();
  }
});

test("a container that cannot be read is a refusal", async () => {
  const { options, done } = await bench();
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(options.dir, { recursive: true });
    // A directory where the container belongs: not "missing", so it is not an empty store.
    await mkdir(join(options.dir, "secrets.v1.enc"), { recursive: true });
    await assert.rejects(
      SecretsStore.open(options),
      (error: unknown) => error instanceof SecretsStorageError,
    );
  } finally {
    await done();
  }
});

test("a container that cannot be written is a refusal, and leaves no scratch file", async () => {
  const { options, done } = await bench();
  try {
    const { chmod, mkdir, readdir } = await import("node:fs/promises");
    const store = await SecretsStore.open(options);
    await mkdir(options.dir, { recursive: true });
    await chmod(options.dir, 0o500);
    await assert.rejects(
      store.save({ botId: "b_1", key: "k", value: "v", scope: "bot" }),
      (error: unknown) => error instanceof SecretsStorageError,
    );
    assert.deepEqual(await readdir(options.dir), [], "nothing was written");
    await chmod(options.dir, 0o700);
  } finally {
    await done();
  }
});

test("the secret events name the scope and never a key or a value", async () => {
  const { options, done } = await bench();
  try {
    const { log, records } = captureLog();
    const store = await SecretsStore.open({ ...options, log });
    await store.save({
      botId: "b_1",
      key: "github-pat",
      value: "ghp_example",
      scope: "bot",
      ttlMinutes: 5,
    });
    await store.read({ botId: "b_1", key: "github-pat" });
    await store.reveal({ key: "github-pat", scope: "bot" });
    await store.remove({ botId: "b_1", key: "github-pat" });
    const events = records.map((record) => record.evt);
    assert.deepEqual(
      events.filter((evt) => evt.startsWith("core.secret.")),
      [
        "core.secret.write.ok",
        "core.secret.read.ok",
        "core.secret.reveal.ok",
        "core.secret.delete.ok",
      ],
    );
    for (const record of records) {
      assert.deepEqual(record.detail, { scope: "bot" }, record.evt);
    }
    const serialized = JSON.stringify(records);
    assert.equal(serialized.includes("ghp_example"), false, "a value never reaches a log record");
    assert.equal(serialized.includes("github-pat"), false, "a key never reaches a log record");
  } finally {
    await done();
  }
});

test("a store that cannot be read records one failure and no key", async () => {
  const { options, done } = await bench();
  try {
    const { log, records } = captureLog();
    const store = await SecretsStore.open({ ...options, log });
    await store.save({ botId: "b_1", key: "github-pat", value: "ghp_example", scope: "bot" });
    await writeFile(join(options.dir, "secrets.v1.enc"), "not a container");
    await assert.rejects(store.read({ botId: "b_1", key: "github-pat" }));
    const failures = records.filter((record) => record.evt === "core.secret.fail");
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.level, "error");
    assert.equal(failures[0]?.err?.kind, "storage_failed");
    assert.equal(JSON.stringify(records).includes("github-pat"), false);
  } finally {
    await done();
  }
});

test("a bot's own record shadows a shared one with the same key", async () => {
  const { options, done } = await bench();
  try {
    const store = await SecretsStore.open(options);
    await store.save({ botId: "b_1", key: "k", value: "shared-value", scope: "shared" });
    await store.save({ botId: "b_1", key: "k", value: "own-value", scope: "bot" });
    assert.deepEqual(await store.read({ botId: "b_1", key: "k" }), {
      key: "k",
      scope: "bot",
      value: "own-value",
    });
    assert.deepEqual(await store.read({ botId: "b_2", key: "k" }), {
      key: "k",
      scope: "shared",
      value: "shared-value",
    });
    const listed = await store.list({ botId: "b_1", limit: 20 });
    assert.deepEqual(
      listed.items.map((item) => `${item.scope}:${item.key}`),
      ["bot:k"],
      "the bot's own record shadows the shared one with the same name",
    );
    const shared = await store.list({ botId: "b_1", scope: "shared", limit: 20 });
    assert.deepEqual(
      shared.items.map((item) => `${item.scope}:${item.key}`),
      ["shared:k"],
      "an explicit scope shows the shared record",
    );
  } finally {
    await done();
  }
});

test("an expired record is deleted by the call that would have read it", async () => {
  const { options, advance, done } = await bench();
  try {
    const store = await SecretsStore.open(options);
    await store.save({
      botId: "b_1",
      key: "k",
      value: "v",
      scope: "bot",
      ttlMinutes: 60,
    });
    advance(61);
    assert.equal(await store.read({ botId: "b_1", key: "k" }), undefined);
    assert.deepEqual(await store.list({ botId: "b_1", limit: 20 }), {
      items: [],
      truncated: false,
    });
    assert.deepEqual(store.values(), [], "the value is gone with the record");
  } finally {
    await done();
  }
});

test("the startup sweep deletes what expired while the daemon was off", async () => {
  const { options, advance, done } = await bench();
  try {
    const store = await SecretsStore.open(options);
    await store.save({ botId: "b_1", key: "gone", value: "v", scope: "bot", ttlMinutes: 5 });
    await store.save({ botId: "b_1", key: "kept", value: "v2", scope: "bot" });
    advance(10);
    assert.equal(await store.sweep(), 1);
    assert.deepEqual(
      (await store.list({ botId: "b_1", limit: 20 })).items.map((item) => item.key),
      ["kept"],
    );
  } finally {
    await done();
  }
});

test("a list that finds an expired record removes it too", async () => {
  const { options, advance, done } = await bench();
  try {
    const store = await SecretsStore.open(options);
    await store.save({
      botId: "b_1",
      key: "gone",
      value: "v",
      scope: "bot",
      ttlMinutes: 5,
    });
    advance(10);
    assert.deepEqual(await store.list({ botId: "b_1", limit: 20 }), {
      items: [],
      truncated: false,
    });
    assert.deepEqual(store.values(), []);
  } finally {
    await done();
  }
});

test("the person reveals nothing from an expired record", async () => {
  const { options, advance, done } = await bench();
  try {
    const store = await SecretsStore.open(options);
    await store.save({
      botId: "b_1",
      key: "k",
      value: "v",
      scope: "shared",
      ttlMinutes: 5,
    });
    advance(10);
    assert.equal(await store.reveal({ key: "k", scope: "shared" }), undefined);
    assert.deepEqual(store.values(), []);
  } finally {
    await done();
  }
});

test("the same key in the same scope is one record that keeps its creation time", async () => {
  const { options, advance, done } = await bench();
  try {
    const store = await SecretsStore.open(options);
    const first = await store.save({ botId: "b_1", key: "k", value: "one", scope: "bot" });
    advance(5);
    const second = await store.save({ botId: "b_1", key: "k", value: "two", scope: "bot" });
    const listed = await store.list({ botId: "b_1", limit: 20 });
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0]?.createdAt, new Date(first.createdAt).toISOString());
    assert.equal(listed.items[0]?.updatedAt, new Date(second.updatedAt).toISOString());
    assert.equal((await store.read({ botId: "b_1", key: "k" }))?.value, "two");
  } finally {
    await done();
  }
});

test("a bot may delete its own records and a shared record it created, not another's", async () => {
  const { options, done } = await bench();
  try {
    const store = await SecretsStore.open(options);
    await store.save({ botId: "b_1", key: "mine", value: "v", scope: "bot" });
    await store.save({ botId: "b_1", key: "ours", value: "v", scope: "shared" });
    await store.save({ botId: "b_2", key: "theirs", value: "v", scope: "shared" });

    assert.deepEqual(await store.remove({ botId: "b_1", key: "mine" }), {
      key: "mine",
      scope: "bot",
      deleted: true,
    });
    assert.deepEqual(await store.remove({ botId: "b_1", key: "ours" }), {
      key: "ours",
      scope: "shared",
      deleted: true,
    });
    await assert.rejects(store.remove({ botId: "b_1", key: "theirs" }), /another bot/);
    assert.equal((await store.read({ botId: "b_2", key: "theirs", scope: "shared" }))?.value, "v");
  } finally {
    await done();
  }
});

test("deleting a record that is gone is success, not an error", async () => {
  const { options, done } = await bench();
  try {
    const store = await SecretsStore.open(options);
    assert.deepEqual(await store.remove({ botId: "b_1", key: "absent" }), {
      key: "absent",
      scope: "bot",
      deleted: false,
    });
  } finally {
    await done();
  }
});

test("the store refuses a key, a value or a lifetime it cannot keep", async () => {
  const { options, done } = await bench();
  try {
    const store = await SecretsStore.open(options);
    await assert.rejects(
      store.save({ botId: "b_1", key: "Bad Key", value: "v", scope: "bot" }),
      /key/,
    );
    await assert.rejects(store.save({ botId: "b_1", key: "k", value: "", scope: "bot" }), /value/);
    await assert.rejects(
      store.save({ botId: "b_1", key: "k", value: "x".repeat(8193), scope: "bot" }),
      /8192/,
    );
    await assert.rejects(
      store.save({ botId: "b_1", key: "k", value: "v", scope: "bot", ttlMinutes: 1441 }),
      /1440/,
    );
    await assert.rejects(
      store.save({ botId: "b_1", key: "k", value: "v", scope: "bot", ttlMinutes: 0 }),
      /1440/,
    );
    await assert.rejects(
      store.save({
        botId: "b_1",
        key: "k",
        value: "v",
        scope: "bot",
        purpose: "x".repeat(241),
      }),
      /240/,
    );
    assert.deepEqual(store.values(), [], "nothing was written");
  } finally {
    await done();
  }
});

test("every operation is on the ledger, and the ledger holds no value", async () => {
  const { root, options, done } = await bench();
  try {
    const store = await SecretsStore.open(options);
    await store.save({ botId: "b_1", key: "k", value: "the-secret-value", scope: "bot" });
    await store.read({ botId: "b_1", key: "k" });
    await store.remove({ botId: "b_1", key: "k" });
    const audit = new SecretAudit({ path: join(options.dir, "secrets.audit.jsonl") });
    const entries = await audit.entries();
    assert.deepEqual(
      entries.map((row) => row.op),
      ["write", "read", "delete"],
    );
    assert.equal(entries[0]?.by, "person", "the person answered the card");
    assert.equal(entries[1]?.by, "bot");
    const text = await readFile(join(options.dir, "secrets.audit.jsonl"), "utf8");
    assert.equal(text.includes("the-secret-value"), false, "the ledger never holds a value");
    assert.equal(root.length > 0, true);
  } finally {
    await done();
  }
});

test("the person may reveal a value, and the reveal is on the ledger", async () => {
  const { options, done } = await bench();
  try {
    const store = await SecretsStore.open(options);
    await store.save({ botId: "b_1", key: "k", value: "v", scope: "shared" });
    assert.deepEqual(await store.reveal({ key: "k", scope: "shared" }), {
      key: "k",
      scope: "shared",
      value: "v",
    });
    assert.equal(await store.reveal({ key: "absent", scope: "shared" }), undefined);
    const audit = new SecretAudit({ path: join(options.dir, "secrets.audit.jsonl") });
    const entries = await audit.entries();
    assert.equal(entries.at(-1)?.op, "reveal");
    assert.equal(entries.at(-1)?.by, "person");
  } finally {
    await done();
  }
});

test("a bot's host is bound to that bot and never names another one", async () => {
  const { options, done } = await bench();
  try {
    const store = await SecretsStore.open(options);
    await store.save({ botId: "b_1", key: "mine", value: "v", scope: "bot" });
    const host = store.hostFor("b_1");
    assert.equal(host.botId, "b_1");
    assert.deepEqual(
      (await host.list({ limit: 20 })).items.map((item) => item.key),
      ["mine"],
    );
    assert.equal((await host.read({ key: "mine" }))?.value, "v");
  } finally {
    await done();
  }
});
