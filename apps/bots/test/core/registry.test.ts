// Ladder rows 44-47: one open per bot, idle close, quarantine and the recovery scan.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BotDirectory, nodeDirectoryFs } from "../../src/core/BotDirectory.ts";
import { BotRegistry } from "../../src/core/BotRegistry.ts";
import type { DeviceSyncPort } from "../../src/core/DeviceSyncPort.ts";
import { ClassifiedFailure } from "../../src/core/domain.ts";
import type { RuntimeBotSpec } from "../../src/core/RuntimePort.ts";
import { captureLog } from "../../src/log/log.ts";
import { FakeRuntime } from "../../src/testing/FakeRuntime.ts";
import { createBench } from "../support/pi.ts";

const fakeTimers = () => {
  let now = 0;
  let sequence = 0;
  const pending = new Map<number, { at: number; run: () => void }>();
  return {
    setTimer: (run: () => void, delayMs: number) => {
      sequence += 1;
      const id = sequence;
      pending.set(id, { at: now + delayMs, run });
      return () => pending.delete(id);
    },
    advance: async (ms: number) => {
      now += ms;
      for (const [id, timer] of [...pending.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now) continue;
        pending.delete(id);
        timer.run();
      }
      await settle();
    },
    pending: () => pending.size,
  };
};

const settle = async (times = 8): Promise<void> => {
  for (let index = 0; index < times; index += 1)
    await new Promise((resolve) => setTimeout(resolve, 2));
};

const bench = async (
  options: {
    busy?: readonly string[];
    closeOutcome?: "closed" | "timeout";
    bots?: readonly string[];
    /** Held open, so a close or a warm-up open can be observed in flight. */
    closeGate?: Promise<void>;
    /** Held open so a delete can be observed between its two steps. */
    renameGate?: Promise<void>;
    openGate?: Promise<void>;
    waitDeadline?: boolean;
    /** Held open inside `busy()`, to land a lease across the idle-close decision. */
    busyGate?: Promise<void>;
    readReplicaBinding?: (
      spec: Pick<RuntimeBotSpec, "id" | "dir">,
    ) => Promise<{ sharedBotId: string } | undefined>;
    deviceSync?: DeviceSyncPort;
  } = {},
) => {
  const root = await mkdtemp(join(tmpdir(), "bots-registry-"));
  const fs = await nodeDirectoryFs();
  const directory = new BotDirectory(root, {
    ...fs,
    rename: async (from, to) => {
      if (options.renameGate !== undefined && from.includes("/bots/")) {
        await options.renameGate;
      }
      return fs.rename(from, to);
    },
  });
  for (const [index, title] of (options.bots ?? []).entries()) {
    await directory.create({
      id: `b_bot${index}`,
      title,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      model: { provider: "faux", modelId: "faux-1" },
    });
  }
  const { log, records } = captureLog();
  const runtime = new FakeRuntime();
  const timers = fakeTimers();
  let openGate = options.openGate;
  let busyGate = options.busyGate;
  let opens = 0;
  const specs: RuntimeBotSpec[] = [];
  const levels: string[] = [];
  const groupCalls: (readonly string[])[] = [];
  const registry = new BotRegistry({
    ...(options.readReplicaBinding === undefined
      ? {}
      : { readReplicaBinding: options.readReplicaBinding }),
    ...(options.deviceSync === undefined ? {} : { deviceSync: options.deviceSync }),
    directory,
    openRuntime: async (spec) => {
      opens += 1;
      specs.push(spec);
      if (openGate !== undefined) await openGate;
      const handle = await runtime.open(spec);
      const busy = (options.busy ?? []).includes(spec.id);
      return {
        ...handle,
        configureThinkingLevel: async (level: string) => {
          levels.push(level);
        },
        configureToolGroups: async (groups: readonly string[]) => {
          groupCalls.push(groups);
        },
        busy: async () => {
          if (busyGate !== undefined) await busyGate;
          return busy ? { run: true, tasks: false } : handle.busy();
        },
        close: async (_trace: string, deadlineMs: number) => {
          if (options.waitDeadline === true) {
            await new Promise((resolve) => setTimeout(resolve, deadlineMs));
            return "timeout" as const;
          }
          if (options.closeGate !== undefined) await options.closeGate;
          await handle.close("tr_close_probe", 100);
          return options.closeOutcome ?? "closed";
        },
      };
    },
    model: { provider: "faux", modelId: "faux-1" },
    log,
    idleCloseMs: 1_000,
    quarantineRetryMs: 5_000,
    closeDeadlineMs: 40,
    setTimer: timers.setTimer,
    bootTrace: () => "tr_boot_probe",
  });
  return {
    root,
    registry,
    records,
    timers,
    directory,
    specs,
    levels,
    groupCalls,
    opens: () => opens,
    setCloseOutcome: (outcome: "closed" | "timeout") => {
      options.closeOutcome = outcome;
    },
    setOpenGate: (gate: Promise<void> | undefined) => {
      openGate = gate;
    },
    setBusyGate: (gate: Promise<void> | undefined) => {
      busyGate = gate;
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

test("a bot's stored thinking level reaches the runtime spec", async () => {
  const setup = await bench();
  try {
    await setup.directory.create({
      id: "b_think",
      title: "think",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      model: { provider: "faux", modelId: "faux-1" },
      thinkingLevel: "medium",
    });
    await setup.registry.start();
    await setup.registry.open("b_think", "tr_think_0001");
    assert.equal(setup.specs.at(-1)?.thinkingLevel, "medium");
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("a per-bot model and level reach the catalog and the live conversation", async () => {
  const setup = await bench({ bots: ["a"] });
  try {
    await setup.registry.start();
    await setup.registry.open("b_bot0", "tr_agent_0001");
    const summary = await setup.registry.setAgent(
      "b_bot0",
      { model: { provider: "faux", modelId: "faux-9" }, thinkingLevel: "high" },
      "tr_agent_0002",
    );
    assert.equal(summary.model.modelId, "faux-9");
    const stored = (await setup.directory.load())[0];
    assert.equal(stored?.model.modelId, "faux-9", "the catalog is the source of truth");
    assert.equal(stored?.thinkingLevel, "high");
    assert.deepEqual(setup.levels, ["high"], "the live conversation follows the level");
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("a task action refuses an id that is not a wire task id", async () => {
  const setup = await bench({ bots: ["a"] });
  try {
    await setup.registry.start();
    await assert.rejects(() => setup.registry.abortTask("b_bot0", "not-a-task", "tr_task_0001"));
    await assert.rejects(() => setup.registry.retryTask("b_bot0", "t_x", "tr_task_0002"));
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("groups load at start and a moved bot's summary carries its group", async () => {
  const setup = await bench({ bots: ["a"] });
  try {
    await setup.directory.createGroup("工作");
    await setup.directory.createGroup("生活");
    await setup.registry.start();
    assert.deepEqual(
      setup.registry.groups().map((group) => group.title),
      ["工作", "生活"],
      "the sidebar order comes from the catalog",
    );
    const group = setup.registry.groups()[0];
    assert.ok(group);
    const summary = await setup.registry.moveBot("b_bot0", group.id, "tr_move_0001");
    assert.equal(summary.groupId, group.id, "the summary follows the move");
    const reordered = await setup.registry.reorderGroups(
      setup.registry
        .groups()
        .map((entry) => entry.id)
        .reverse(),
      "tr_move_0002",
    );
    assert.deepEqual(
      reordered.map((entry) => entry.title),
      ["生活", "工作"],
    );
    await setup.registry.deleteGroup(setup.registry.groups()[0]?.id ?? "", "tr_move_0003");
    assert.equal(setup.registry.groups().length, 1, "an empty group is deleted");
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("a gateway tool-group change reaches existing bots and new ones", async () => {
  const setup = await bench({ bots: ["a"] });
  try {
    await setup.registry.start();
    await setup.registry.open("b_bot0", "tr_groups_0001");
    await setup.registry.applyToolGroups(["core", "coding"], "tr_groups_0002");
    assert.deepEqual(setup.groupCalls.at(-1), ["core", "coding"], "the live conversation follows");
    const stored = await setup.directory.load();
    assert.deepEqual(
      stored[0]?.toolGroups,
      ["core", "coding"],
      "the catalog is the source of truth",
    );
    await setup.registry.create("new", "tr_groups_0003");
    const created = (await setup.directory.load()).find((bot) => bot.title === "new");
    assert.deepEqual(
      created?.toolGroups,
      ["core", "coding"],
      "a new bot records the settings groups",
    );
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("a bot that never stored tool groups gets them written on the first save", async () => {
  const setup = await bench({ bots: ["a"] });
  try {
    await setup.registry.start();
    const before = (await setup.directory.load())[0];
    assert.equal(before?.toolGroups, undefined, "the fixture stores no selection");
    await setup.registry.applyToolGroups(["core", "coding", "herdr"], "tr_groups_0004");
    const after = (await setup.directory.load())[0];
    assert.deepEqual(after?.toolGroups, ["core", "coding", "herdr"], "the default is now explicit");
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("a failed live tool refresh is reported and an identical save retries it", async () => {
  const setup = await bench({ bots: ["a"] });
  try {
    await setup.registry.start();
    const handle = await setup.registry.open("b_bot0", "tr_tools_retry");
    let attempts = 0;
    handle.configureToolGroups = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("tool refresh failed");
    };
    await assert.rejects(
      setup.registry.applyToolGroups([], "tr_tools_retry"),
      /tool refresh failed/,
    );
    assert.deepEqual((await setup.directory.load())[0]?.toolGroups, ["core", "coding"]);
    await setup.registry.applyToolGroups([], "tr_tools_retry");
    assert.equal(attempts, 2);
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("a gateway thinking-level change reaches existing bots and new ones", async () => {
  const setup = await bench({ bots: ["a"] });
  try {
    await setup.registry.start();
    await setup.registry.open("b_bot0", "tr_level_0001");
    await setup.registry.applyThinkingLevel("high", "tr_level_0002");
    assert.deepEqual(setup.levels, ["high"], "the live conversation follows in place");
    const stored = await setup.directory.load();
    assert.equal(stored[0]?.thinkingLevel, "high", "the catalog is the source of truth");
    await setup.registry.create("new", "tr_level_0003");
    const created = (await setup.directory.load()).find((bot) => bot.title === "new");
    assert.equal(created?.thinkingLevel, "high", "a new bot records the settings level");
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("a gateway model change reaches existing bots and new ones", async () => {
  const setup = await bench({ bots: ["a"] });
  try {
    await setup.registry.start();
    await setup.registry.open("b_bot0", "tr_model_0001");
    await setup.registry.applyModel({ provider: "faux", modelId: "faux-2" }, "tr_model_0002");
    assert.equal(setup.registry.summaries()[0]?.model.modelId, "faux-2");
    const stored = await setup.directory.load();
    assert.equal(stored[0]?.model.modelId, "faux-2", "the catalog is the source of truth");
    const created = await setup.registry.create("new", "tr_model_0003");
    assert.equal(created.model.modelId, "faux-2", "a new bot records the new model");
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("open is idempotent and shared by concurrent subscribers", async () => {
  const setup = await bench({ bots: ["shared"] });
  try {
    await setup.registry.start();
    const [first, second] = await Promise.all([
      setup.registry.open("b_bot0", "tr_a_00000001"),
      setup.registry.open("b_bot0", "tr_b_00000002"),
    ]);
    assert.equal(first, second, "both subscribers share one handle");
    assert.equal(setup.opens(), 1, "the Harness opened once");
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("an idle bot closes after idleCloseMs and reopens on demand", async () => {
  const setup = await bench();
  try {
    await setup.registry.start();
    const summary = await setup.registry.create("idle", "tr_create_0001");
    const handle = await setup.registry.open(summary.id, "tr_open_000001");
    setup.registry.touch(summary.id);
    setup.registry.release(summary.id);
    await setup.timers.advance(1_000);
    assert.equal(setup.registry.state(summary.id), "catalogued", "the idle bot closed");
    assert.deepEqual(await handle.busy(), { run: false, tasks: false });
    const reopened = await setup.registry.open(summary.id, "tr_open_000002");
    assert.notEqual(reopened, handle, "a reopen creates a new handle");
    assert.equal(setup.opens(), 2);
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("a timed-out close quarantines and refuses open and delete", async () => {
  const setup = await bench({ closeOutcome: "timeout" });
  try {
    await setup.registry.start();
    const summary = await setup.registry.create("stuck", "tr_create_0002");
    await setup.registry.open(summary.id, "tr_open_000003");
    setup.registry.touch(summary.id);
    setup.registry.release(summary.id);
    await setup.timers.advance(1_000);
    assert.equal(setup.registry.state(summary.id), "quarantined");
    await assert.rejects(
      () => setup.registry.open(summary.id, "tr_open_000004"),
      /quarantined/,
      "open is refused",
    );
    await assert.rejects(
      () => setup.registry.remove(summary.id, "tr_delete_0001"),
      /quarantined/,
      "delete is refused",
    );
    assert.ok(
      setup.records.some((record) => record.evt === "core.bot.close.degrade"),
      "the timeout is logged as a degradation, never as success",
    );
  } finally {
    await setup.cleanup();
  }
});

test("recovery scan resumes active bots and leaves the rest closed", async () => {
  const setup = await bench({ bots: ["busy", "quiet"], busy: ["b_bot0"] });
  try {
    await setup.registry.start();
    assert.equal(setup.registry.state("b_bot0"), "running", "the busy bot keeps its handle");
    assert.equal(setup.registry.state("b_bot1"), "idle", "the quiet bot is open but idle");
    await setup.timers.advance(1_000);
    assert.equal(setup.registry.state("b_bot0"), "running", "a busy bot is never idle-closed");
    assert.equal(setup.registry.state("b_bot1"), "catalogued", "the quiet bot closed");
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("delete closes the handle and removes the bot from the catalog", async () => {
  const setup = await bench();
  try {
    await setup.registry.start();
    const summary = await setup.registry.create("gone", "tr_create_0003");
    await setup.registry.open(summary.id, "tr_open_000005");
    await setup.registry.remove(summary.id, "tr_delete_0002");
    assert.deepEqual(setup.registry.summaries(), []);
    assert.deepEqual(
      await setup.registry.open
        .call(setup.registry, summary.id, "tr_open_000006")
        .catch((error: unknown) => (error as Error).message),
      "unknown bot",
    );
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("recover re-opens a bot whose open failed", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-registry-"));
  const directory = new BotDirectory(root, await nodeDirectoryFs());
  const { log } = captureLog();
  const runtime = new FakeRuntime();
  let attempts = 0;
  const registry = new BotRegistry({
    directory,
    openRuntime: async (spec) => {
      attempts += 1;
      if (attempts === 1) throw new Error("sqlite is locked");
      return runtime.open(spec);
    },
    model: { provider: "faux", modelId: "faux-1" },
    log,
    idleCloseMs: 60_000,
    quarantineRetryMs: 60_000,
    closeDeadlineMs: 100,
    bootTrace: () => "tr_boot_probe",
  });
  try {
    await directory.create({
      id: "b_flaky",
      title: "flaky",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      model: { provider: "faux", modelId: "faux-1" },
    });
    // The recovery scan is the first open, and it fails: the bot is unavailable.
    await registry.start();
    const summary = { id: "b_flaky" };
    assert.equal(registry.state(summary.id), "unavailable", "a failed scan leaves it unavailable");
    assert.deepEqual(registry.summaries()[0]?.unavailable?.reason, "storage_failed");
    await registry.recover(summary.id, "tr_recover_0001");
    assert.equal(registry.state(summary.id), "idle");
    assert.equal(attempts, 2);
    assert.equal(registry.summaries()[0]?.unavailable, undefined);
  } finally {
    await registry.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("a delete whose close times out leaves the bot in quarantine", async () => {
  const setup = await bench({ closeOutcome: "timeout" });
  try {
    await setup.registry.start();
    const summary = await setup.registry.create("stuck2", "tr_create_0005");
    await setup.registry.open(summary.id, "tr_open_000008");
    await assert.rejects(
      () => setup.registry.remove(summary.id, "tr_delete_0003"),
      /quarantined/,
      "a close that did not finish refuses the delete",
    );
    assert.equal(setup.registry.state(summary.id), "quarantined");
    assert.deepEqual(
      setup.registry.summaries().map((bot) => bot.id),
      [summary.id],
      "the catalog entry is still there",
    );
  } finally {
    await setup.cleanup();
  }
});

test("an upstream open failure is propagated, not re-originated at core", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-registry-"));
  const directory = new BotDirectory(root, await nodeDirectoryFs());
  const { log, records } = captureLog();
  const failure = { id: "f_runtime_1", kind: "session_failed" as const, layer: "runtime" as const };
  const registry = new BotRegistry({
    directory,
    openRuntime: async () => {
      throw new ClassifiedFailure(failure, "runtime", "the harness would not open");
    },
    model: { provider: "faux", modelId: "faux-1" },
    log,
    idleCloseMs: 60_000,
    quarantineRetryMs: 60_000,
    closeDeadlineMs: 100,
    bootTrace: () => "tr_boot_probe",
  });
  try {
    await directory.create({
      id: "b_upstream",
      title: "upstream",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      model: { provider: "faux", modelId: "faux-1" },
    });
    await registry.start();
    const open = await registry
      .open("b_upstream", "tr_open_upstream")
      .then(() => undefined)
      .catch((error: unknown) => error);
    assert.ok(open instanceof ClassifiedFailure, "the refusal keeps its class and identity");
    assert.equal(open.failure.id, failure.id);
    assert.equal(registry.state("b_upstream"), "unavailable");
    const core = records.filter((record) => record.evt === "core.bot.open.fail");
    assert.equal(core.length, 2, "both the scan and the explicit open are recorded");
    for (const record of core) {
      assert.equal(record.level, "warn", "only the originating layer logs at error");
      assert.equal(record.err?.failure, failure.id, "same identity as the runtime record");
      assert.equal(record.err?.origin, undefined);
      assert.equal(record.detail?.propagated, true, "the record says core propagated it");
    }
    assert.equal(
      records.filter((record) => record.level === "error" && record.err?.failure === failure.id)
        .length,
      0,
      "no second error record for one failure",
    );
  } finally {
    await registry.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("two subscribers share one real Harness, so one sqlite file has one owner", async () => {
  const bench = await createBench();
  let release: () => void = () => undefined;
  const gate = {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  const root = await mkdtemp(join(tmpdir(), "bots-registry-"));
  const directory = new BotDirectory(root, await nodeDirectoryFs());
  const { log } = captureLog();
  let opens = 0;
  const registry = new BotRegistry({
    directory,
    openRuntime: async (spec) => {
      opens += 1;
      await gate.promise;
      return bench.runtime.open(spec);
    },
    model: { provider: "faux", modelId: "faux-1" },
    log,
    idleCloseMs: 60_000,
    quarantineRetryMs: 60_000,
    closeDeadlineMs: 1_000,
    bootTrace: () => "tr_boot_probe",
  });
  try {
    await registry.start();
    // The bot is catalogued, and its warm-up open is held: both opens below must join it.
    const summary = await registry.create("real", "tr_create_real");
    const [first, second] = [
      registry.open(summary.id, "tr_a_00000001"),
      registry.open(summary.id, "tr_b_00000002"),
    ];
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a, b, "one handle for the bot");
    assert.equal(opens, 1, "one Harness opened over the one sqlite file");
    assert.deepEqual(await a.busy(), { run: false, tasks: false });
  } finally {
    await registry.shutdown();
    await bench.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("a quarantined bot leaves quarantine when its retry closes", async () => {
  const setup = await bench({ closeOutcome: "timeout" });
  try {
    await setup.registry.start();
    const summary = await setup.registry.create("重试", "tr_create_retry");
    await setup.registry.open(summary.id, "tr_open_retry");
    setup.registry.touch(summary.id);
    setup.registry.release(summary.id);
    await setup.timers.advance(1_000);
    assert.equal(setup.registry.state(summary.id), "quarantined");
    // The retry succeeds: the handle is released and the bot is catalogued again.
    setup.setCloseOutcome("closed");
    await setup.timers.advance(5_000);
    assert.equal(setup.registry.state(summary.id), "catalogued", "the retry cleared quarantine");
    const closed = setup.records.filter((record) => record.evt === "core.bot.close.ok");
    assert.equal(closed.length, 1, "the retry's close is recorded once");
    assert.equal(closed[0]?.detail?.quarantined, true, "as the retry of a quarantine");
  } finally {
    await setup.cleanup();
  }
});

test("an open during a close waits for it and keeps the handle it creates", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const setup = await bench({ closeGate: gate });
  try {
    await setup.registry.start();
    const summary = await setup.registry.create("重开", "tr_create_0010");
    const first = await setup.registry.open(summary.id, "tr_open_0010");
    setup.registry.touch(summary.id);
    setup.registry.release(summary.id);
    // The idle close is now in flight and holds the handle.
    await setup.timers.advance(1_000);
    assert.equal(setup.registry.state(summary.id), "idle", "the close has not finished");
    const reopening = setup.registry.open(summary.id, "tr_open_0011");
    release();
    const second = await reopening;
    assert.notEqual(second, first, "the reopen waits for the close and opens once");
    assert.equal(setup.opens(), 2, "one open for the first handle, one for the reopen");
    assert.equal(setup.registry.handleOf(summary.id), second, "the close never cleared it");
    assert.equal(setup.registry.state(summary.id), "idle");
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("a delete waits for a warm-up open instead of leaking its handle", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const setup = await bench({ openGate: gate });
  try {
    await setup.registry.start();
    const summary = await setup.registry.create("预热删除", "tr_create_0011");
    // create() warms asynchronously and the opener is held: the handle does not exist yet.
    let done = false;
    const removing = setup.registry.remove(summary.id, "tr_delete_0010").then(() => {
      done = true;
    });
    await settle();
    assert.equal(done, false, "the delete waits for the warm-up open to settle");
    release();
    await removing;
    assert.deepEqual(setup.registry.summaries(), []);
    assert.equal(setup.registry.handleOf(summary.id), undefined, "no handle outlives the bot");
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("two concurrent creates cannot take the last catalog slot twice", async () => {
  const setup = await bench({ bots: Array.from({ length: 199 }, (_, index) => `b${index}`) });
  try {
    await setup.registry.start();
    const outcomes = await Promise.allSettled([
      setup.registry.create("一", "tr_create_0020"),
      setup.registry.create("二", "tr_create_0021"),
    ]);
    assert.equal(
      outcomes.filter((outcome) => outcome.status === "fulfilled").length,
      1,
      "one create wins the last slot",
    );
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    assert.match(
      String((rejected as PromiseRejectedResult).reason),
      /limit_exceeded|catalog is full/,
    );
    assert.equal(setup.registry.summaries().length, 200, "the catalog never exceeds its cap");
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("shutdown spends one shared deadline, not one per bot", async () => {
  const setup = await bench({ bots: ["a", "b", "c"], waitDeadline: true });
  try {
    await setup.registry.start();
    const started = Date.now();
    await setup.registry.shutdown();
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 90, `three 40 ms deadlines shared one budget, took ${elapsed} ms`);
    const degraded = setup.records.filter((record) => record.evt === "core.bot.close.degrade");
    assert.equal(degraded.length, 3, "every timed-out close is a degradation, never success");
    assert.ok(
      setup.records.every((record) => record.evt !== "core.bot.close.ok"),
      "no timeout is logged as closed",
    );
  } finally {
    await setup.cleanup();
  }
});

test("an idle close finishing during a delete does not open a second handle", async () => {
  let releaseClose: () => void = () => undefined;
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  let releaseRename: () => void = () => undefined;
  const renameGate = new Promise<void>((resolve) => {
    releaseRename = resolve;
  });
  const setup = await bench({ closeGate, renameGate });
  try {
    await setup.registry.start();
    const summary = await setup.registry.create("删除中", "tr_create_0030");
    await setup.registry.open(summary.id, "tr_open_0030");
    setup.registry.touch(summary.id);
    setup.registry.release(summary.id);
    await setup.timers.advance(1_000);
    // The idle close is in flight; the delete takes over the lifecycle from here.
    const removing = setup.registry.remove(summary.id, "tr_delete_0030");
    await settle();
    releaseClose();
    await settle();
    // The directory move is blocked: an open must wait for the delete window, not open.
    let outcome = "pending";
    const opening = setup.registry.open(summary.id, "tr_open_0031").then(
      () => {
        outcome = "opened";
      },
      () => {
        outcome = "rejected";
      },
    );
    await settle();
    assert.equal(outcome, "pending", "the delete still owns the bot");
    releaseRename();
    await removing;
    await opening;
    assert.equal(outcome, "rejected", "the deleted bot never opens");
    assert.equal(setup.opens(), 1, "no second harness was created during the delete");
  } finally {
    await setup.cleanup();
  }
});

test("an idle close cannot close a bot whose lease was taken while it awaited busy()", async () => {
  let releaseBusy: () => void = () => undefined;
  const busyGate = new Promise<void>((resolve) => {
    releaseBusy = resolve;
  });
  const setup = await bench({ bots: ["a"] });
  try {
    await setup.registry.start();
    // The recovery scan left the bot open; let its idle window pass so a real open happens.
    await setup.timers.advance(1_000);
    await settle();
    setup.setBusyGate(busyGate);
    await setup.registry.open("b_bot0", "tr_lease_0001");
    setup.registry.touch("b_bot0");
    setup.registry.release("b_bot0");

    const closing = setup.timers.advance(1_000);
    await settle();
    // The close decision is now parked inside `busy()`. A trigger admission lands here:
    // lease taken and released while that answer is still outstanding.
    assert.equal(setup.registry.touch("b_bot0"), true, "a lease is still grantable");
    setup.registry.release("b_bot0");
    setup.setBusyGate(undefined);
    releaseBusy();
    await closing;
    assert.notEqual(
      setup.registry.handleOf("b_bot0"),
      undefined,
      "the stale busy() answer must not close a bot that just took a lease",
    );
  } finally {
    await setup.registry.shutdown().catch(() => undefined);
    await setup.cleanup();
  }
});

test("a delete waits for a lease that is already granted", async () => {
  const setup = await bench({ bots: ["a"] });
  try {
    await setup.registry.start();
    await setup.registry.open("b_bot0", "tr_lease_0002");
    assert.equal(setup.registry.touch("b_bot0"), true, "the lease is granted");
    const removing = setup.registry.remove("b_bot0", "tr_delete_0002");
    await settle();
    assert.equal(setup.registry.touch("b_bot0"), false, "a deleting bot grants no new lease");
    assert.notEqual(
      await setup.directory.load().then((bots) => bots.length),
      0,
      "the directory is still there while the lease is held",
    );
    setup.registry.release("b_bot0");
    await removing;
    assert.equal(
      await setup.directory.load().then((bots) => bots.length),
      0,
      "the delete finished",
    );
  } finally {
    await setup.cleanup();
  }
});

test("a delete that cannot drain a lease quarantines instead of moving the directory", async () => {
  const setup = await bench({ bots: ["a"] });
  try {
    await setup.registry.start();
    await setup.registry.open("b_bot0", "tr_lease_0003");
    setup.registry.touch("b_bot0");
    const removing = setup.registry.remove("b_bot0", "tr_delete_0003").then(
      () => "resolved" as const,
      (error: unknown) => error,
    );
    await settle();
    await setup.timers.advance(40);
    const outcome = await removing;
    assert.equal(
      outcome instanceof ClassifiedFailure && outcome.disposition === "not_admitted",
      true,
      "a drain that misses its deadline refuses the delete",
    );
    assert.equal(setup.registry.state("b_bot0"), "quarantined");
    assert.equal(await setup.directory.load().then((bots) => bots.length), 1, "nothing moved");
  } finally {
    await setup.cleanup();
  }
});

test("a lease granted before its open cannot deadlock a delete", async () => {
  let releaseOpen: () => void = () => undefined;
  const openGate = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  const setup = await bench({ bots: ["a"] });
  try {
    await setup.registry.start();
    await setup.timers.advance(1_000);
    await settle();
    assert.equal(setup.registry.handleOf("b_bot0"), undefined, "the recovery scan closed it");
    const before = setup.opens();
    setup.setOpenGate(openGate);
    setup.registry.touch("b_bot0");
    const opening = setup.registry.open("b_bot0", "tr_open_0010");
    await settle();
    const removing = setup.registry.remove("b_bot0", "tr_delete_0010");
    await settle();
    releaseOpen();
    await opening;
    assert.equal(setup.opens(), before + 1, "the delete did not force a second open");
    setup.registry.release("b_bot0");
    await removing;
    assert.equal(await setup.directory.load().then((bots) => bots.length), 0);
  } finally {
    await setup.cleanup();
  }
});

test("sync access rejects missing binding, missing port and real binding I/O before any extra runtime open", async () => {
  for (const mode of ["unbound", "unconfigured", "io"] as const) {
    const cause = new Error("owned binding read failed");
    const setup = await bench({
      bots: ["sync"],
      readReplicaBinding: async () => {
        if (mode === "io") throw cause;
        return mode === "unbound"
          ? undefined
          : { sharedBotId: "44444444-4444-4444-8444-444444444444" };
      },
    });
    try {
      await setup.registry.start();
      const opens = setup.opens();
      setup.records.length = 0;
      await assert.rejects(
        setup.registry.syncAccess(
          "b_bot0",
          { peerDeviceId: "22222222-2222-4222-8222-222222222222", purpose: "replica.read" },
          "tr_sync_missing",
        ),
        (error: unknown) => {
          assert(error instanceof ClassifiedFailure);
          assert.equal(error.failure.kind, mode === "io" ? "storage_failed" : "invalid_command");
          if (mode === "io") assert.equal(error.cause, cause);
          return true;
        },
      );
      assert.equal(setup.opens(), opens);
      assert.equal(setup.records.filter((r) => r.level === "error").length, 1);
      assert.equal(setup.records.filter((r) => r.evt === "runtime.open.start").length, 0);
    } finally {
      await setup.registry.shutdown();
      await setup.cleanup();
    }
  }
});
