// Ladder rows 44-47: one open per bot, idle close, quarantine and the recovery scan.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BotDirectory, nodeDirectoryFs } from "../../src/core/BotDirectory.ts";
import { BotRegistry } from "../../src/core/BotRegistry.ts";
import { ClassifiedFailure, DEFAULT_THINKING_LEVEL } from "../../src/core/domain.ts";
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
    newBotId?: () => string;
    closeOutcome?: "closed" | "timeout" | "rejected";
    bots?: readonly string[];
    /** Held open, so a close or a warm-up open can be observed in flight. */
    closeGate?: Promise<void>;
    /** Held open so a delete can be observed between its two steps. */
    renameGate?: Promise<void>;
    openGate?: Promise<void>;
    waitDeadline?: boolean;
    /** Held open inside `busy()`, to land a lease across the idle-close decision. */
    busyGate?: Promise<void>;
    /** The levels the models accept, when the daemon knows the models. */
    agentLevels?: (modelId: string) => readonly string[];
    /** The first N pair applications fail, so a save can be observed not reaching it. */
    failAgentApply?: number;
    /** Held open, so a catalog write can be observed in flight. */
    writeGate?: Promise<void>;
  } = {},
) => {
  const root = await mkdtemp(join(tmpdir(), "bots-registry-"));
  const fs = await nodeDirectoryFs();
  let failWrites = false;
  let writeGate = options.writeGate;
  let agentFailures = 0;
  let refuseFor: string | undefined;
  const directory = new BotDirectory(root, {
    ...fs,
    rename: async (from, to) => {
      if (options.renameGate !== undefined && from.includes("/bots/")) {
        await options.renameGate;
      }
      return fs.rename(from, to);
    },
    writeFile: async (path, body, mode) => {
      if (writeGate !== undefined && path.includes("catalog.json")) await writeGate;
      if (failWrites && path.includes("catalog.json")) {
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      }
      return fs.writeFile(path, body, mode);
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
  let closes = 0;
  let closing = false;
  const closeDeadlines: number[] = [];
  const specs: RuntimeBotSpec[] = [];
  const agents: { model: { provider: string; modelId: string }; thinkingLevel: string }[] = [];
  const groupCalls: (readonly string[])[] = [];
  const registry = new BotRegistry({
    directory,
    openRuntime: async (spec) => {
      const owner = spec.id;
      opens += 1;
      specs.push(spec);
      if (openGate !== undefined) await openGate;
      const handle = await runtime.open(spec);
      const busy = (options.busy ?? []).includes(spec.id);
      return {
        ...handle,
        configureAgent: async (change: {
          model: { provider: string; modelId: string };
          thinkingLevel: string;
        }) => {
          // A conversation on its way out cannot take a new pair.
          if (closing) throw new Error("the conversation is closing");
          if (refuseFor === owner) throw new Error("this conversation refuses the provider");
          if (options.failAgentApply !== undefined && agentFailures < options.failAgentApply) {
            agentFailures += 1;
            throw new Error("the conversation did not take the pair");
          }
          agents.push(change);
        },
        configureToolGroups: async (groups: readonly string[]) => {
          groupCalls.push(groups);
        },
        busy: async () => {
          if (busyGate !== undefined) await busyGate;
          return busy ? { run: true, tasks: false } : handle.busy();
        },
        close: async (_trace: string, deadlineMs: number) => {
          closes += 1;
          closing = true;
          closeDeadlines.push(deadlineMs);
          if (options.waitDeadline === true) {
            await new Promise((resolve) => setTimeout(resolve, deadlineMs));
            return "timeout" as const;
          }
          if (options.closeGate !== undefined) await options.closeGate;
          closing = false;
          if (options.closeOutcome === "rejected") throw new Error("close failed");
          if (options.closeOutcome === "timeout") return "timeout" as const;
          await handle.close("tr_close_probe", 100);
          return "closed" as const;
        },
      };
    },
    model: { provider: "faux", modelId: "faux-1" },
    ...(options.agentLevels === undefined
      ? {}
      : {
          agentSupport: (model: { readonly modelId: string }) => ({
            levels: options.agentLevels?.(model.modelId) ?? [],
          }),
        }),
    log,
    idleCloseMs: 1_000,
    quarantineRetryMs: 5_000,
    closeDeadlineMs: 40,
    setTimer: timers.setTimer,
    bootTrace: () => "tr_boot_probe",
    ...(options.newBotId === undefined ? {} : { newBotId: options.newBotId }),
  });
  return {
    root,
    registry,
    records,
    timers,
    directory,
    specs,
    agents,
    groupCalls,
    /** The level the bench's daemon runs as its default, so a migration can be read. */
    defaultLevel: DEFAULT_THINKING_LEVEL,
    opens: () => opens,
    closes: () => closes,
    closeDeadlines,
    setCloseOutcome: (outcome: "closed" | "timeout") => {
      options.closeOutcome = outcome;
    },
    setOpenGate: (gate: Promise<void> | undefined) => {
      openGate = gate;
    },
    setBusyGate: (gate: Promise<void> | undefined) => {
      busyGate = gate;
    },
    failWrites: (on: boolean) => {
      failWrites = on;
    },
    setWriteGate: (gate: Promise<void> | undefined) => {
      writeGate = gate;
    },
    refuseAgentFor: (botId: string | undefined) => {
      refuseFor = botId;
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

test("fixed identity vectors persist once across restart and rename", async () => {
  const vectors = [
    ["b_color0", "violet"],
    ["b_color1", "blue"],
    ["b_color2", "pink"],
    ["b_color4", "red"],
    ["b_color5", "orange"],
    ["b_color6", "teal"],
    ["b_color14", "yellow"],
    ["b_color32", "green"],
  ] as const;
  let next = 0;
  const setup = await bench({
    bots: ["Existing appearance-absent bot"],
    newBotId: () => {
      const vector = vectors[next++];
      assert.ok(vector);
      return vector[0];
    },
  });
  try {
    await setup.registry.start();
    for (const [id, tint] of vectors) {
      const bot = await setup.registry.create("Same name", "tr_color_create");
      assert.equal(bot.id, id);
      assert.deepEqual(bot.appearance, { shape: "blob", tint });
    }
    await setup.registry.update(
      "b_color4",
      { appearance: { shape: "heart", tint: "graphite" } },
      "tr_color_manual",
    );
    await setup.registry.update(
      "b_color1",
      { appearance: { shape: "star", tint: "green" } },
      "tr_color_manual",
    );
    const saved = await setup.directory.load();
    await setup.registry.shutdown();
    const runtime = new FakeRuntime();
    const restarted = new BotRegistry({
      directory: setup.directory,
      openRuntime: (spec) => runtime.open(spec),
      model: { provider: "faux", modelId: "faux-1" },
      log: captureLog().log,
      idleCloseMs: 1_000,
      quarantineRetryMs: 5_000,
      closeDeadlineMs: 40,
    });
    try {
      await restarted.start();
      for (const record of saved) {
        const expected = record.appearance ?? { shape: "blob", tint: "green" };
        assert.deepEqual(
          restarted.summaries().find((bot) => bot.id === record.id)?.appearance,
          expected,
        );
        const renamed = await restarted.rename(record.id, "Another name", "tr_color_rename");
        assert.deepEqual(renamed.appearance, expected);
      }
      assert.equal(
        (await setup.directory.load()).find((bot) => bot.id === "b_bot0")?.appearance,
        undefined,
      );
    } finally {
      await restarted.shutdown();
    }
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

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
    const started = setup.records.length;
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
    assert.deepEqual(
      setup.agents,
      [{ model: { provider: "faux", modelId: "faux-9" }, thinkingLevel: "high" }],
      "the live conversation follows the pair",
    );
    const writes = setup.records
      .slice(started)
      .filter((record) => record.evt === "core.catalog.write.ok");
    assert.equal(writes.length, 1, "the pair is one catalog write");
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
    assert.deepEqual(
      setup.groupCalls.at(-1),
      ["core", "core-ui", "coding"],
      "the live conversation follows",
    );
    const stored = await setup.directory.load();
    assert.deepEqual(
      stored[0]?.toolGroups,
      ["core", "core-ui", "coding"],
      "the catalog is the source of truth",
    );
    await setup.registry.create("new", "tr_groups_0003");
    const created = (await setup.directory.load()).find((bot) => bot.title === "new");
    assert.deepEqual(
      created?.toolGroups,
      ["core", "core-ui", "coding"],
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
    await setup.registry.applyToolGroups(["core", "coding", "hc"], "tr_groups_0004");
    const after = (await setup.directory.load())[0];
    assert.deepEqual(
      after?.toolGroups,
      ["core", "core-ui", "coding", "hc"],
      "the default is now explicit",
    );
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
    assert.deepEqual((await setup.directory.load())[0]?.toolGroups, ["core", "core-ui", "coding"]);
    await setup.registry.applyToolGroups([], "tr_tools_retry");
    assert.equal(attempts, 2);
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("a bot created before the level existed is migrated once and keeps it", async () => {
  const setup = await bench({ bots: ["a"] });
  try {
    // The fixture has no stored level, exactly like a catalog written before the field
    // existed. The daemon it upgrades to runs `low`.
    await setup.registry.start();
    const migrated = (await setup.directory.load())[0];
    assert.equal(migrated?.thinkingLevel, setup.defaultLevel, "the upgrade writes the level");
    assert.equal(migrated?.model.modelId, "faux-1", "and nothing else");
    // The write happens before the recovery scan touches the bot: a bot nobody opens is
    // migrated too.
    const wrote = setup.records.findIndex(
      (record) => record.evt === "core.catalog.write.ok" && record.botId === "b_bot0",
    );
    const opened = setup.records.findIndex((record) => record.evt === "core.bot.open.start");
    assert.ok(wrote !== -1, "the migration wrote the catalog");
    assert.ok(
      opened === -1 || wrote < opened,
      "the migration lands before the recovery scan opens the bot",
    );

    // A later change of the daemon's default cannot move the bot any more.
    setup.registry.setDefaultThinkingLevel("high");
    await setup.registry.open("b_bot0", "tr_migrate_0001");
    const spec = setup.specs.at(-1);
    assert.equal(spec?.thinkingLevel, setup.defaultLevel, "the bot runs with what it stores");
    const stored = (await setup.directory.load())[0];
    assert.equal(stored?.thinkingLevel, setup.defaultLevel, "the catalog did not move");

    // An idle close and a reopen still run the level the catalog holds, and a level-only
    // change is written against the bot's own model.
    await setup.timers.advance(1_000);
    await setup.registry.open("b_bot0", "tr_migrate_0003");
    assert.equal(
      setup.specs.at(-1)?.thinkingLevel,
      setup.defaultLevel,
      "the reopen keeps the migrated level",
    );
    const patched = await setup.registry.setAgent(
      "b_bot0",
      { thinkingLevel: "off" },
      "tr_migrate_0004",
    );
    assert.equal(patched.model.modelId, "faux-1", "the level-only change keeps the model");
    assert.equal((await setup.directory.load())[0]?.thinkingLevel, "off");

    // A new daemon with another default leaves it alone, and a new bot takes that default.
    await setup.registry.shutdown();
    const restarted = new BotRegistry({
      directory: setup.directory,
      openRuntime: (spec) => new FakeRuntime().open(spec),
      model: { provider: "faux", modelId: "faux-1" },
      thinkingLevel: "max",
      log: captureLog().log,
      idleCloseMs: 1_000,
      quarantineRetryMs: 5_000,
      closeDeadlineMs: 40,
      bootTrace: () => "tr_boot_probe",
    });
    await restarted.start();
    const afterRestart = (await setup.directory.load()).find((bot) => bot.id === "b_bot0");
    assert.equal(afterRestart?.thinkingLevel, "off", "a second daemon does not migrate it again");
    await restarted.create("new", "tr_migrate_0002");
    const created = (await setup.directory.load()).find((bot) => bot.title === "new");
    assert.equal(created?.thinkingLevel, "max", "a new bot records the later default");
    await restarted.shutdown();
  } finally {
    await setup.registry.shutdown().catch(() => false);
    await setup.cleanup();
  }
});

test("a bare catalog is given the level before its first open", async () => {
  const setup = await bench({ bots: ["a"], agentLevels: () => ["off", "low", "high"] });
  try {
    await setup.registry.start();
    // A hand-edited catalog after the start: the daemon must not invent a level for it.
    await setup.directory.setAgent(
      "b_bot0",
      { model: { provider: "faux", modelId: "faux-1" } },
      "x",
    );
    const edited = (await setup.directory.load())[0];
    assert.equal(edited?.thinkingLevel, setup.defaultLevel, "the write kept the level");
    await setup.registry.shutdown();

    const root = await mkdtemp(join(tmpdir(), "bots-registry-"));
    try {
      const real = await nodeDirectoryFs();
      const directory = new BotDirectory(root, real);
      await directory.create({
        id: "b_bare",
        title: "no level",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        model: { provider: "faux", modelId: "faux-1" },
      });
      const { log } = captureLog();
      const levels: string[] = [];
      const registry = new BotRegistry({
        directory,
        openRuntime: async (spec) => {
          levels.push(spec.thinkingLevel ?? "none");
          return new FakeRuntime().open(spec);
        },
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "high",
        log,
        idleCloseMs: 1_000,
        quarantineRetryMs: 5_000,
        closeDeadlineMs: 40,
        bootTrace: () => "tr_boot_probe",
      });
      // The startup migration writes the default once, so an open afterwards is fine.
      await registry.start();
      await registry.open("b_bare", "tr_bare_0001");
      assert.deepEqual(levels, ["high"], "the migrated level is what the bot runs");
      await registry.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  } finally {
    await setup.cleanup();
  }
});

test("a migration that cannot be written fails the start instead of falling back", async () => {
  const setup = await bench({ bots: ["a"] });
  try {
    setup.failWrites(true);
    await assert.rejects(
      () => setup.registry.start(),
      /catalog could not be written/,
      "a bot the upgrade cannot record stops the daemon",
    );
  } finally {
    await setup.cleanup();
  }
});

test("a gateway thinking-level change is the default for new bots only", async () => {
  const setup = await bench({ bots: ["a"] });
  try {
    await setup.registry.start();
    await setup.registry.open("b_bot0", "tr_level_0001");
    setup.registry.setDefaultThinkingLevel("high");
    assert.deepEqual(setup.agents, [], "an existing conversation is not moved");
    const stored = await setup.directory.load();
    assert.notEqual(stored[0]?.thinkingLevel, "high", "the bot keeps the level it stores");
    await setup.registry.create("new", "tr_level_0003");
    const created = (await setup.directory.load()).find((bot) => bot.title === "new");
    assert.equal(created?.thinkingLevel, "high", "a new bot records the default level");
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("a gateway model change is the default for new bots only", async () => {
  const setup = await bench({ bots: ["a"] });
  try {
    await setup.registry.start();
    await setup.registry.open("b_bot0", "tr_model_0001");
    setup.registry.setDefaultModel({ provider: "faux", modelId: "faux-2" });
    assert.deepEqual(setup.agents, [], "an existing conversation is not moved");
    const stored = await setup.directory.load();
    assert.equal(stored[0]?.model.modelId, "faux-1", "the bot keeps the model it stores");
    await setup.registry.create("new", "tr_model_0003");
    const created = (await setup.directory.load()).find((bot) => bot.title === "new");
    assert.equal(created?.model.modelId, "faux-2", "a new bot records the default model");
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("the gateway's provider follows every stored reference, the model id does not", async () => {
  const setup = await bench({ bots: ["a"] });
  try {
    await setup.registry.start();
    await setup.registry.applyGatewayProvider("other", "tr_provider_0001");
    const stored = (await setup.directory.load())[0];
    assert.equal(stored?.model.provider, "other", "the provider belongs to the gateway");
    assert.equal(stored?.model.modelId, "faux-1", "the model id stays the bot's own");
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("a level the model cannot take is refused and nothing is written", async () => {
  const setup = await bench({
    bots: ["a"],
    agentLevels: (modelId) => (modelId === "faux-9" ? ["off", "low"] : ["off", "low", "high"]),
  });
  try {
    await setup.registry.start();
    await setup.registry.open("b_bot0", "tr_level_refuse_0001");
    await assert.rejects(
      () =>
        setup.registry.setAgent(
          "b_bot0",
          { model: { provider: "faux", modelId: "faux-9" }, thinkingLevel: "high" },
          "tr_level_refuse_0002",
        ),
      /does not support the high thinking level/,
    );
    assert.deepEqual(setup.agents, [], "the conversation did not move");
    const stored = (await setup.directory.load())[0];
    assert.equal(stored?.model.modelId, "faux-1", "the catalog did not move either");
    assert.equal(
      stored?.thinkingLevel,
      "medium",
      "the refused change left the migrated level alone",
    );
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("a failed catalog write never reaches the conversation", async () => {
  const setup = await bench({ bots: ["a"] });
  try {
    await setup.registry.start();
    await setup.registry.open("b_bot0", "tr_apply_fail_0001");
    setup.failWrites(true);
    await assert.rejects(
      () =>
        setup.registry.setAgent(
          "b_bot0",
          { model: { provider: "faux", modelId: "faux-9" }, thinkingLevel: "high" },
          "tr_apply_fail_0002",
        ),
      /catalog could not be written/,
    );
    assert.deepEqual(setup.agents, [], "the conversation was not configured at all");
    const stored = (await setup.directory.load())[0];
    assert.equal(stored?.model.modelId, "faux-1", "the catalog kept the old pair");
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("a pair that is saved but not applied is reported, and the next change applies it", async () => {
  const setup = await bench({ bots: ["a"], failAgentApply: 1 });
  try {
    await setup.registry.start();
    await setup.registry.open("b_bot0", "tr_saved_0001");
    await assert.rejects(
      () =>
        setup.registry.setAgent(
          "b_bot0",
          { model: { provider: "faux", modelId: "faux-9" }, thinkingLevel: "high" },
          "tr_saved_0002",
        ),
      /the bot now records faux-9 at high, but the running conversation did not take it/,
      "a save that did not reach the conversation is not reported as applied",
    );
    const stored = (await setup.directory.load())[0];
    assert.equal(stored?.model.modelId, "faux-9", "the catalog holds the saved pair");
    assert.equal(setup.registry.summaries()[0]?.model.modelId, "faux-9");

    // The same pair again: the catalog already holds it, and the conversation still does
    // not — so the change is applied rather than answered from catalog equality.
    await setup.registry.setAgent(
      "b_bot0",
      { model: { provider: "faux", modelId: "faux-9" }, thinkingLevel: "high" },
      "tr_saved_0003",
    );
    assert.deepEqual(
      setup.agents.map((agent) => agent.model.modelId),
      ["faux-9"],
      "the retry configured the conversation, even though the catalog already held the pair",
    );
    await setup.registry.setAgent(
      "b_bot0",
      { model: { provider: "faux", modelId: "faux-9" }, thinkingLevel: "high" },
      "tr_saved_0004",
    );
    assert.equal(setup.agents.length, 1, "and a third identical change is a no-op");
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("a request prepared while the catalog write is in flight keeps the pair it had", async () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const setup = await bench({ bots: ["a"] });
  try {
    await setup.registry.start();
    await setup.registry.open("b_bot0", "tr_held_0001");
    setup.setWriteGate(undefined);
    const edit = setup.registry.setAgent(
      "b_bot0",
      { model: { provider: "faux", modelId: "faux-9" }, thinkingLevel: "high" },
      "tr_held_0002",
    );
    setup.setWriteGate(held);
    await settle();
    assert.equal(setup.agents.length, 0, "nothing claims the pair before the catalog holds it");
    release();
    await edit;
    assert.deepEqual(
      setup.agents.map((agent) => agent.model.modelId),
      ["faux-9"],
      "the conversation follows the catalog once it is written",
    );
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("a close, a reopen and a change settle in one order and the bot runs the saved pair", async () => {
  let release: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const setup = await bench({ bots: ["a"], closeGate: closed });
  try {
    await setup.registry.start();
    await setup.registry.open("b_bot0", "tr_race_0001");
    // The idle close starts and is held; the change waits for it; a reopen arrives while
    // the change owns the settling window and waits for that.
    await setup.timers.advance(1_000);
    const edit = setup.registry.setAgent(
      "b_bot0",
      { model: { provider: "faux", modelId: "faux-9" }, thinkingLevel: "high" },
      "tr_race_0002",
    );
    await settle();
    const reopen = setup.registry.open("b_bot0", "tr_race_0003");
    await settle();
    release();
    await edit;
    await reopen;
    // Whichever of the two won the wake order — the reopen installing its handle or the
    // change configuring it — the conversation the bot keeps runs the pair the catalog
    // holds, and it was configured exactly once.
    const configured = setup.agents.at(-1);
    const spec = setup.specs.at(-1);
    const effective = configured?.model.modelId ?? spec?.model.modelId;
    assert.equal(effective, "faux-9", "the conversation runs the saved pair");
    assert.ok(setup.agents.length <= 1, "at most one configuration was needed");
    // The same pair again is a no-op: `applied` names what the conversation really runs.
    await setup.registry.setAgent(
      "b_bot0",
      { model: { provider: "faux", modelId: "faux-9" }, thinkingLevel: "high" },
      "tr_race_0004",
    );
    assert.equal(
      setup.agents.length,
      configured === undefined ? 0 : 1,
      "nothing was configured again",
    );
    const stored = (await setup.directory.load())[0];
    assert.equal(stored?.model.modelId, "faux-9", "the catalog holds the saved pair");
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("a reopen that wakes with a change waits for it instead of starting from the old spec", async () => {
  let releaseClose: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  let releaseOpen: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  const setup = await bench({ bots: ["a"], closeGate: closed });
  try {
    await setup.registry.start();
    await setup.registry.open("b_bot0", "tr_wake_0001");
    await setup.timers.advance(1_000);
    // The change queues first; the reopen queues second; both wait for the close.
    const edit = setup.registry.setAgent(
      "b_bot0",
      { model: { provider: "faux", modelId: "faux-9" }, thinkingLevel: "high" },
      "tr_wake_0002",
    );
    await settle();
    setup.setOpenGate(opened);
    const reopen = setup.registry.open("b_bot0", "tr_wake_0003");
    await settle();
    // The change wakes first and owns a window; the reopen must wait for it.
    releaseClose();
    await edit;
    await settle();
    const beforeOpen = setup.specs.length;
    releaseOpen();
    await reopen;
    // The reopen started after the catalog held the saved pair, so the spec it used is the
    // saved one — a reopen that woke on the close alone would have read the old pair.
    const last = setup.specs.at(-1);
    assert.ok(setup.specs.length > beforeOpen || last?.model.modelId === "faux-9");
    assert.equal(last?.model.modelId, "faux-9", "the reopened conversation runs the saved pair");
    assert.equal(last?.thinkingLevel, "high");
    assert.deepEqual(setup.agents, [], "and no live handle had to be corrected");
    const stored = (await setup.directory.load())[0];
    assert.equal(stored?.model.modelId, "faux-9", "the catalog holds the saved pair");
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("a change that arrives while the bot is opening reaches the handle it installs", async () => {
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  const setup = await bench({ openGate: opened });
  try {
    await setup.registry.start();
    // The warm-up open is held inside the runtime: the handle is not installed yet.
    const created = await setup.registry.create("a", "tr_open_0001");
    const edit = setup.registry.setAgent(
      created.id,
      { model: { provider: "faux", modelId: "faux-9" }, thinkingLevel: "high" },
      "tr_open_0002",
    );
    await settle();
    release();
    await edit;
    // Without the open being awaited, the change answers success while the handle the
    // warm-up installs still runs the old pair.
    assert.deepEqual(
      setup.agents.map((agent) => agent.model.modelId),
      ["faux-9"],
      "the installed conversation takes the pair the catalog now holds",
    );
    assert.equal(setup.registry.handleOf(created.id) !== undefined, true);
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("a change that arrives while the bot is closing is stored and the next open uses it", async () => {
  let release: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const setup = await bench({ bots: ["a"], closeGate: closed });
  try {
    await setup.registry.start();
    await setup.registry.open("b_bot0", "tr_closing_0001");
    // An idle close starts and is held open by the gate: the handle is on its way out.
    await setup.timers.advance(1_000);
    const edit = setup.registry.setAgent(
      "b_bot0",
      { model: { provider: "faux", modelId: "faux-7" }, thinkingLevel: "low" },
      "tr_closing_0002",
    );
    await settle();
    release();
    await edit;
    const stored = (await setup.directory.load())[0];
    assert.equal(
      stored?.model.modelId,
      "faux-7",
      "the pair is the catalog's, even without a handle",
    );
    assert.equal(stored?.thinkingLevel, "low");
    await setup.registry.open("b_bot0", "tr_closing_0003");
    const spec = setup.specs.at(-1);
    assert.equal(spec?.model.modelId, "faux-7", "the reopened bot runs with the stored pair");
    assert.equal(spec?.thinkingLevel, "low");
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});

test("two rapid agent changes are applied one after the other", async () => {
  const setup = await bench({ bots: ["a"] });
  try {
    await setup.registry.start();
    await setup.registry.open("b_bot0", "tr_rapid_0001");
    const first = setup.registry.setAgent(
      "b_bot0",
      { model: { provider: "faux", modelId: "faux-2" }, thinkingLevel: "low" },
      "tr_rapid_0002",
    );
    const second = setup.registry.setAgent(
      "b_bot0",
      { model: { provider: "faux", modelId: "faux-3" }, thinkingLevel: "high" },
      "tr_rapid_0003",
    );
    await Promise.all([first, second]);
    assert.deepEqual(
      setup.agents.map((agent) => agent.model.modelId),
      ["faux-2", "faux-3"],
      "the second change waits for the first",
    );
    const stored = (await setup.directory.load())[0];
    assert.equal(stored?.model.modelId, "faux-3", "the last change is the one that is stored");
    assert.equal(stored?.thinkingLevel, "high");
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

test("shutdown keeps a timed-out handle quarantined without scheduling a retry", async () => {
  const setup = await bench({ bots: ["stuck"], closeOutcome: "timeout" });
  try {
    await setup.registry.start();
    assert.equal(await setup.registry.shutdown(), false);
    assert.equal(setup.registry.state("b_bot0"), "quarantined");
    assert.equal(setup.timers.pending(), 0);
    await setup.timers.advance(10_000);
    assert.equal(setup.timers.pending(), 0);
    assert.ok(setup.records.some((record) => record.evt === "core.bot.close.degrade"));
    assert.ok(!setup.records.some((record) => record.evt === "core.bot.close.ok"));
  } finally {
    await setup.cleanup();
  }
});

test("a warm-up finishing after shutdown starts is closed instead of published", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const setup = await bench({ openGate: gate });
  try {
    await setup.registry.start();
    const bot = await setup.registry.create("warming", "tr_warm_shutdown");
    const opening = setup.registry.open(bot.id, "tr_join_shutdown");
    const shutdown = setup.registry.shutdown();
    release?.();
    await assert.rejects(opening, /shut.*down/i);
    assert.equal(await shutdown, true);
    assert.equal(setup.closes(), 1);
    assert.equal(setup.registry.handleOf(bot.id), undefined);
    assert.equal(setup.timers.pending(), 0);
  } finally {
    release?.();
    await setup.cleanup();
  }
});

test("late warm-up close failures retain ownership without another deadline", async () => {
  for (const outcome of ["timeout", "rejected"] as const) {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const setup = await bench({ openGate: gate, closeOutcome: outcome });
    try {
      await setup.registry.start();
      const bot = await setup.registry.create("warming", "tr_warm_failure");
      const opening = setup.registry.open(bot.id, "tr_join_failure");
      const shutdown = setup.registry.shutdown();
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      await assert.rejects(opening, /shut.*down/i);
      assert.equal(await shutdown, false, outcome);
      assert.equal(setup.registry.state(bot.id), "quarantined", outcome);
      assert.notEqual(setup.registry.handleOf(bot.id), undefined, outcome);
      assert.deepEqual(setup.closeDeadlines, [1], outcome);
      assert.equal(setup.timers.pending(), 0, outcome);
    } finally {
      release();
      await setup.cleanup();
    }
  }
});

test("an in-flight quarantine retry cannot outlive shutdown", async () => {
  for (const outcome of ["timeout", "closed", "rejected"] as const) {
    const setup = await bench({ bots: ["stuck"] });
    try {
      await setup.registry.start();
      const handle = await setup.registry.open("b_bot0", "tr_retry_shutdown");
      let calls = 0;
      let started: (() => void) | undefined;
      let finish: ((outcome: "closed" | "timeout") => void) | undefined;
      let fail: (() => void) | undefined;
      const retryStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      handle.close = async () => {
        calls += 1;
        if (calls === 1) return "timeout";
        if (calls === 3) return "closed";
        started?.();
        return new Promise((resolve, reject) => {
          finish = resolve;
          fail = () => reject(new Error("retry failed"));
        });
      };
      await setup.timers.advance(1_000);
      assert.equal(setup.registry.state("b_bot0"), "quarantined");
      await setup.timers.advance(5_000);
      await retryStarted;
      await setup.registry.shutdown();
      const successCount = setup.records.filter(
        (record) => record.evt === "core.bot.close.ok",
      ).length;
      if (outcome === "rejected") fail?.();
      else finish?.(outcome);
      await settle();
      assert.equal(setup.timers.pending(), 0, outcome);
      assert.equal(
        setup.records.filter((record) => record.evt === "core.bot.close.ok").length,
        successCount,
        outcome,
      );
    } finally {
      await setup.cleanup();
    }
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

test("a cold Bot lease timeout never quarantines a handleless Bot", async () => {
  let releaseOpen: () => void = () => undefined;
  const openGate = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  const setup = await bench({ openGate });
  try {
    await setup.registry.start();
    const summary = await setup.registry.create("冷文件", "tr_create_cold_file");
    assert.equal(setup.registry.handleOf(summary.id), undefined, "the warm open is still cold");
    assert.equal(setup.registry.touch(summary.id), true, "the file request owns a lease");

    const removal = setup.registry.remove(summary.id, "tr_delete_cold_file").then(
      () => undefined,
      (error) => error,
    );
    await setup.timers.advance(40);
    const refused = await removal;
    assert.equal(refused instanceof ClassifiedFailure, true, "the delete waits for the slow lease");
    assert.notEqual(
      setup.registry.state(summary.id),
      "quarantined",
      "no handleless lease becomes quarantine",
    );

    releaseOpen();
    await settle();
    const handle = await setup.registry.open(summary.id, "tr_reopen_cold_file");
    assert.ok(handle, "the warm open can finish after the lease ends");
    setup.registry.release(summary.id);
    await setup.registry.remove(summary.id, "tr_delete_after_cold_file");
    assert.deepEqual(
      setup.registry.summaries(),
      [],
      "a retry delete succeeds after the request ends",
    );
  } finally {
    releaseOpen();
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

test("saving a legacy selection writes the mandatory groups into the catalog row", async () => {
  const setup = await bench({ bots: ["a"] });
  try {
    await setup.registry.start();
    // A row written before core-ui existed: it resolves to the mandatory groups without naming
    // them, so comparing normalized values would see "no change" and never write.
    await setup.directory.setToolGroups("b_bot0", ["core", "coding"], new Date().toISOString());
    await setup.registry.applyToolGroups([], "tr_groups_legacy");
    assert.deepEqual(
      (await setup.directory.load())[0]?.toolGroups,
      ["core", "core-ui", "coding"],
      "the saved row names the mandatory groups",
    );

    // The same save on a row that already names them writes nothing new.
    const written = (await setup.directory.load())[0]?.updatedAt;
    await setup.registry.applyToolGroups([], "tr_groups_same");
    assert.equal((await setup.directory.load())[0]?.updatedAt, written, "nothing to write");
  } finally {
    await setup.registry.shutdown();
    await setup.cleanup();
  }
});
