import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BotDirectory, nodeDirectoryFs } from "../../src/core/BotDirectory.ts";
import { BotRegistry } from "../../src/core/BotRegistry.ts";
import type { RuntimeHandle } from "../../src/core/RuntimePort.ts";
import { captureLog } from "../../src/log/log.ts";
import { FakeRuntime } from "../../src/testing/FakeRuntime.ts";
import { createBench, trace, waitFor } from "../support/pi.ts";

const config = (id: string, model = { provider: "faux", modelId: "faux-1" }) => ({
  id,
  title: id,
  model,
  createdAt: "2026-10-30T00:00:00Z",
  updatedAt: "2026-10-30T00:00:00Z",
});

const deletionBench = async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-delete-marks-"));
  const fs = await nodeDirectoryFs();
  const sharedBotId = randomUUID();
  let retry: (() => void) | undefined;
  const state = {
    failMark: false,
    failMove: false,
    closeTimeout: false,
    opens: 0,
    moves: 0,
    bindEntered: false,
    bindGate: Promise.resolve(),
  };
  const bindings = new Map<string, string>([["b_one", sharedBotId]]);
  const directory = new BotDirectory(root, {
    ...fs,
    writeFile: async (path, body, mode) => {
      if (state.failMark && body.includes('"tombstones"')) throw new Error("mark write failed");
      await fs.writeFile(path, body, mode);
    },
    rename: async (from, to) => {
      if (from.includes("/bots/")) {
        state.moves++;
        if (state.failMove) throw new Error("move failed");
      }
      await fs.rename(from, to);
    },
  });
  await directory.create(config("b_one"));
  const runtime = new FakeRuntime();
  const { log, records } = captureLog();
  const options = {
    directory,
    log,
    model: config("b_one").model,
    readReplicaBinding: async ({ id }: { id: string }) => {
      const shared = bindings.get(id);
      return shared === undefined ? undefined : { sharedBotId: shared };
    },
    openRuntime: async (spec: Parameters<typeof runtime.open>[0]) => {
      state.opens++;
      const handle = await runtime.open(spec);
      return {
        refreshTools: (trace: string) => handle.refreshTools(trace),
        subscribe: handle.subscribe.bind(handle),
        submit: handle.submit.bind(handle),
        submission: handle.submission.bind(handle),
        history: handle.history.bind(handle),
        abort: handle.abort.bind(handle),
        recover: handle.recover.bind(handle),
        busy: handle.busy.bind(handle),
        replica: async (command: { method: string; params: unknown }) => {
          if (command.method === "bind") {
            const value = command.params as { sharedBotId: string };
            bindings.set(spec.id, value.sharedBotId);
            state.bindEntered = true;
            await state.bindGate;
            return value;
          }
          return {};
        },
        close: async () => (state.closeTimeout ? ("timeout" as const) : ("closed" as const)),
      };
    },
    idleCloseMs: 600_000,
    quarantineRetryMs: 30_000,
    closeDeadlineMs: 10,
    setTimer: (run: () => void, delay: number) => {
      if (delay === 30_000) {
        retry = run;
        return () => {
          retry = undefined;
        };
      }
      const timer = setTimeout(run, delay);
      timer.unref();
      return () => clearTimeout(timer);
    },
  };
  const registry = new BotRegistry(options);
  await registry.start();
  return {
    root,
    directory,
    registry,
    options,
    state,
    records,
    sharedBotId,
    retryClose: () => {
      assert.ok(retry);
      retry();
    },
    cleanup: async () => {
      state.closeTimeout = false;
      await registry.shutdown();
      await rm(root, { recursive: true, force: true });
    },
  };
};

test("the normative tombstone page round-trips through the root catalog", async () => {
  const s = await deletionBench();
  try {
    const page = JSON.parse(
      await readFile(
        new URL("../../../../fixtures/bots-sync/tombstones.v1.json", import.meta.url),
        "utf8",
      ),
    );
    await s.registry.tombstones("apply", { items: page.items }, trace);
    assert.deepEqual(await s.registry.tombstones("pull", { after: 0 }, trace), page);
  } finally {
    await s.cleanup();
  }
});

test("binding a deleted shared identity is a logged core refusal before runtime mutation", async () => {
  const s = await deletionBench();
  try {
    const sharedBotId = randomUUID();
    await s.registry.tombstones("apply", { items: [{ sharedBotId }] }, trace);
    await assert.rejects(
      s.registry.replica("b_one", {
        method: "bind",
        params: { sharedBotId },
        trace: "tr_deleted_bind",
      }),
    );
    assert.equal(s.state.bindEntered, false);
    const records = s.records.filter((record) => record.trace === "tr_deleted_bind");
    assert.equal(records.filter((record) => record.level === "error").length, 1);
    assert.equal(
      records.find((record) => record.evt === "core.replica.fail")?.err?.kind,
      "invalid_command",
    );
  } finally {
    await s.cleanup();
  }
});

test("a cold delete never opens a runtime; mark-write failure leaves data unmoved and retryable", async () => {
  const s = await deletionBench();
  try {
    await s.registry.shutdown();
    const opens = s.state.opens;
    s.state.failMark = true;
    await assert.rejects(s.registry.remove("b_one", trace), /could not be deleted/);
    assert.equal(s.state.moves, 0);
    assert.equal(await s.directory.isDeleted(s.sharedBotId), false);
    await access(s.directory.botDir("b_one"));
    s.state.failMark = false;
    await s.registry.remove("b_one", trace);
    assert.equal(s.state.opens, opens, "deletion reads the binding without SDK open");
    assert.equal(await s.directory.isDeleted(s.sharedBotId), true);
  } finally {
    await s.cleanup();
  }
});

test("a saved mark survives move failure, seals the live process and reconciles before restart opens", async () => {
  const s = await deletionBench();
  let reopened: BotRegistry | undefined;
  try {
    s.state.failMove = true;
    const failure = await s.registry
      .tombstones("apply", { items: [{ sharedBotId: s.sharedBotId }] }, trace)
      .catch((error: unknown) => error);
    assert.ok(failure instanceof Error);
    assert.equal(await s.directory.isDeleted(s.sharedBotId), true);
    assert.equal(s.registry.touch("b_one"), false);
    await assert.rejects(s.registry.open("b_one", trace));
    await access(s.directory.botDir("b_one"));
    const errors = s.records.filter(
      (record) => record.level === "error" && record.evt !== "core.bot.resolve.fail",
    );
    assert.equal(
      errors.length,
      1,
      "cleanup failure has one origin and its wrapper only propagates",
    );
    const propagated = s.records.find((record) => record.evt === "core.replica.fail");
    assert.equal(propagated?.level, "warn");
    assert.equal(propagated?.err?.failure, errors[0]?.err?.failure);
    s.state.failMove = false;
    await s.registry.shutdown();
    const opens = s.state.opens;
    reopened = new BotRegistry(s.options);
    await reopened.start();
    assert.equal(s.state.opens, opens);
    assert.deepEqual(reopened.summaries(), []);
    await access(s.directory.trashDir("b_one"));
    assert.ok(JSON.parse(await readFile(s.directory.catalogPath, "utf8")).tombstones.length === 1);
  } finally {
    await reopened?.shutdown();
    await s.cleanup();
  }
});

for (const alias of [false, true])
  test(`persistent ${alias ? "newly discovered alias" : "pending cleanup"} move failure isolates the deleted Bot at startup`, async () => {
    const s = await deletionBench();
    let reopened: BotRegistry | undefined;
    try {
      await s.registry.shutdown();
      await s.directory.create(config("b_good"));
      await s.directory.markDeleted(
        [{ sharedBotId: s.sharedBotId }],
        alias ? {} : { b_one: s.sharedBotId },
      );
      s.state.failMove = true;
      const before = s.records.length;
      const opens = s.state.opens;
      reopened = new BotRegistry(s.options);
      await reopened.start();
      assert.equal(s.state.opens, opens + 1, "only the healthy Bot opens");
      assert.deepEqual(
        reopened.summaries().map((bot) => bot.id),
        ["b_good"],
      );
      assert.ok(await reopened.open("b_good", trace));
      await assert.rejects(reopened.open("b_one", trace));
      assert.equal(reopened.touch("b_one"), false);
      const catalog = JSON.parse(await readFile(s.directory.catalogPath, "utf8"));
      assert.deepEqual(catalog.cleanup, { b_one: s.sharedBotId });
      assert.deepEqual(catalog.tombstones, [{ sharedBotId: s.sharedBotId }]);
      await access(s.directory.botDir("b_one"));
      const failed = s.records.slice(before).filter((record) => record.evt === "core.delete.fail");
      assert.equal(failed.length, 1);
      assert.equal(failed[0]?.level, "error");
      assert.equal(failed[0]?.err?.kind, "storage_failed");
      assert.equal(
        s.records.slice(before).find((record) => record.evt === "core.reconcile.ok")?.detail?.count,
        0,
      );
    } finally {
      s.state.failMove = false;
      await reopened?.shutdown();
      await s.cleanup();
    }
  });

for (const fault of ["read", "write"])
  test(`root catalog ${fault} I/O still fails startup closed`, async () => {
    const s = await deletionBench();
    let reopened: BotRegistry | undefined;
    try {
      await s.registry.shutdown();
      await s.directory.create(config("b_good"));
      await s.directory.markDeleted([{ sharedBotId: s.sharedBotId }], { b_one: s.sharedBotId });
      const fs = await nodeDirectoryFs();
      const directory = new BotDirectory(s.root, {
        ...fs,
        readFile: async (path) => {
          if (fault === "read" && path === s.directory.catalogPath)
            throw new Error("catalog read I/O");
          return fs.readFile(path);
        },
        writeFile: async (path, body, mode) => {
          if (fault === "write") throw new Error("catalog write I/O");
          await fs.writeFile(path, body, mode);
        },
      });
      const opens = s.state.opens;
      reopened = new BotRegistry({ ...s.options, directory });
      await assert.rejects(reopened.start(), /catalog could not be loaded/);
      assert.equal(s.state.opens, opens, "no runtime may open on unknown root catalog state");
      const catalog = JSON.parse(await readFile(s.directory.catalogPath, "utf8"));
      assert.deepEqual(catalog.cleanup, { b_one: s.sharedBotId });
      assert.deepEqual(catalog.tombstones, [{ sharedBotId: s.sharedBotId }]);
    } finally {
      await reopened?.shutdown();
      await s.cleanup();
    }
  });

for (const heldLease of [false, true])
  test(`received deletion keeps its mark and fence across ${heldLease ? "lease" : "close"} quarantine`, async () => {
    const s = await deletionBench();
    try {
      if (heldLease) assert.equal(s.registry.touch("b_one"), true);
      else s.state.closeTimeout = true;
      await assert.rejects(
        s.registry.tombstones("apply", { items: [{ sharedBotId: s.sharedBotId }] }, trace),
      );
      assert.equal(s.registry.state("b_one"), "quarantined");
      assert.equal(s.state.moves, 0, "an owned active database cannot be moved");
      assert.equal(await s.directory.isDeleted(s.sharedBotId), true);
      assert.equal(s.registry.touch("b_one"), false);
      if (heldLease) s.registry.release("b_one");
      s.state.closeTimeout = false;
      s.retryClose();
      await waitFor(
        () => s.registry.state("b_one") === "catalogued",
        "quarantine retry really closed",
      );
      assert.equal(s.registry.handleOf("b_one"), undefined);
      await assert.rejects(
        s.registry.open("b_one", trace),
        "a later successful close cannot unseal a tombstoned identity",
      );
      assert.equal(s.registry.touch("b_one"), false);
      assert.equal(await s.directory.isDeleted(s.sharedBotId), true);
    } finally {
      await s.cleanup();
    }
  });

test("an admitted bind and deletion are serialized through the actual await window", async () => {
  const s = await deletionBench();
  let release = () => {};
  try {
    const target = randomUUID();
    s.state.bindGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const binding = s.registry.replica("b_one", {
      method: "bind",
      params: { sharedBotId: target },
      trace,
    });
    await waitFor(() => s.state.bindEntered, "binding persisted before response");
    const deletion = s.registry.tombstones("apply", { items: [{ sharedBotId: target }] }, trace);
    release();
    await Promise.all([binding, deletion]);
    assert.equal(s.registry.touch("b_one"), false);
    await access(s.directory.trashDir("b_one"));
    assert.equal(await s.directory.isDeleted(target), true);
  } finally {
    release();
    await s.cleanup();
  }
});

test("startup binding I/O isolates one Bot without preventing the other runtime from opening", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-binding-start-"));
  const directory = new BotDirectory(root, await nodeDirectoryFs());
  await directory.create(config("b_bad"));
  await directory.create(config("b_good"));
  const runtime = new FakeRuntime();
  const { log, records } = captureLog();
  const registry = new BotRegistry({
    directory,
    log,
    model: config("b_good").model,
    openRuntime: (spec) => runtime.open(spec),
    readReplicaBinding: async ({ id }) => {
      if (id === "b_bad") throw new Error("binding backend failed");
      return undefined;
    },
    idleCloseMs: 600_000,
    quarantineRetryMs: 30_000,
    closeDeadlineMs: 500,
  });
  try {
    await registry.start();
    assert.equal(registry.state("b_bad"), "unavailable");
    assert.ok(await registry.open("b_good", trace));
    assert.equal(
      records.filter((item) => item.botId === "b_bad" && item.level === "error").length,
      1,
    );
  } finally {
    await registry.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("a post-open binding I/O error closes the newly owned real SDK handle", async () => {
  const bench = await createBench();
  const directory = new BotDirectory(bench.dir, await nodeDirectoryFs());
  const spec = bench.spec();
  await directory.create(config(spec.id, spec.model));
  let reads = 0;
  let owned: RuntimeHandle | undefined;
  const { log } = captureLog();
  const registry = new BotRegistry({
    directory,
    log,
    model: spec.model,
    openRuntime: async (input) => {
      owned = await bench.runtime.open(input);
      return owned;
    },
    readReplicaBinding: async () => {
      if (++reads > 1) throw new Error("post-open binding I/O");
      return undefined;
    },
    idleCloseMs: 600_000,
    quarantineRetryMs: 30_000,
    closeDeadlineMs: 500,
  });
  try {
    await registry.start();
    assert.equal(registry.state(spec.id), "unavailable");
    assert.equal(
      bench.records.filter((item) => item.evt === "runtime.close.ok").length,
      1,
      "the open succeeded, so the registry must settle that owner before reporting failure",
    );
  } finally {
    await registry.shutdown();
    await owned?.close(trace, 500);
    await bench.cleanup();
  }
});
