// Ladder rows 9-10: the catalog is atomic and a delete is finishable after a crash.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BotDirectory,
  DirectoryError,
  type DirectoryFs,
  nodeDirectoryFs,
} from "../../src/core/BotDirectory.ts";
import type { BotRecord } from "../../src/core/domain.ts";

const record = (id: string, title = id): BotRecord => ({
  id,
  title,
  createdAt: "2026-10-25T02:11:03.412Z",
  updatedAt: "2026-10-25T02:11:03.412Z",
  model: { provider: "magpie", modelId: "auto/gpt-6-luna" },
});

const workspace = async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-dir-"));
  return { root, dir: new BotDirectory(root, await nodeDirectoryFs()) };
};

test("a fresh root has an empty catalog", async () => {
  const { root, dir } = await workspace();
  try {
    assert.deepEqual(await dir.load(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("create, rename and remove are visible to the next load", async () => {
  const { root, dir } = await workspace();
  try {
    await dir.create(record("b_1"));
    await dir.create(record("b_2"));
    assert.deepEqual(
      (await dir.load()).map((bot) => bot.id),
      ["b_1", "b_2"],
    );
    const renamed = await dir.rename("b_1", "研究员", "2026-10-25T03:00:00.000Z");
    assert.equal(renamed.title, "研究员");
    assert.deepEqual(
      (await dir.load()).map((bot) => bot.title),
      ["研究员", "b_2"],
    );
    await dir.remove("b_2");
    assert.deepEqual(
      (await dir.load()).map((bot) => bot.id),
      ["b_1"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a duplicate id is refused and the catalog is unchanged", async () => {
  const { root, dir } = await workspace();
  try {
    await dir.create(record("b_1"));
    await assert.rejects(
      dir.create(record("b_1")),
      (error: DirectoryError) => error.reason === "duplicate_bot",
    );
    assert.deepEqual(
      (await dir.load()).map((bot) => bot.id),
      ["b_1"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an interrupted write leaves the previous catalog readable", async () => {
  const { root, dir } = await workspace();
  try {
    await dir.create(record("b_1"));
    const before = await readFile(join(root, "catalog.json"), "utf8");

    // A crash between writing the temp file and renaming it.
    const real = await nodeDirectoryFs();
    const failing: DirectoryFs = {
      ...real,
      rename: async () => {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      },
    };
    const interrupted = new BotDirectory(root, failing);
    await assert.rejects(
      interrupted.create(record("b_2")),
      (error: DirectoryError) => error.reason === "storage_failed",
    );
    assert.equal(await readFile(join(root, "catalog.json"), "utf8"), before);
    assert.deepEqual(
      (await dir.load()).map((bot) => bot.id),
      ["b_1"],
    );

    // The temp file is cleaned up rather than left to look like a catalog.
    const leftovers = (await real.readdir(root)).filter((entry) => entry.name.includes(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a corrupt catalog is reported, never silently treated as empty", async () => {
  const { root, dir } = await workspace();
  try {
    await writeFile(join(root, "catalog.json"), "{ not json", { mode: 0o600 });
    await assert.rejects(
      dir.load(),
      (error: DirectoryError) =>
        error.reason === "corrupt_catalog" && /not JSON/.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reconcile finishes a delete that was interrupted after the move", async () => {
  const { root, dir } = await workspace();
  try {
    await dir.create(record("b_1"));
    await dir.create(record("b_2"));
    // Simulate a crash between the rename and the catalog write: trash exists, the
    // bot directory has already moved, and the catalog still lists it.
    const real = await nodeDirectoryFs();
    await real.mkdir(join(root, "trash"), { recursive: true });
    await real.rename(join(root, "bots", "b_2"), join(root, "trash", "b_2"));

    const result = await dir.reconcile();
    assert.deepEqual(result.finishedDeletes, ["b_2"]);
    assert.deepEqual(result.orphanedTrash, []);
    assert.deepEqual(
      (await dir.load()).map((bot) => bot.id),
      ["b_1"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reconcile leaves an unknown trash directory alone", async () => {
  const { root, dir } = await workspace();
  try {
    await dir.create(record("b_1"));
    const real = await nodeDirectoryFs();
    await real.mkdir(join(root, "trash", "b_gone"), { recursive: true });
    const result = await dir.reconcile();
    assert.deepEqual(result.finishedDeletes, []);
    assert.deepEqual(result.orphanedTrash, ["b_gone"]);
    assert.deepEqual(
      (await dir.load()).map((bot) => bot.id),
      ["b_1"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent creates keep every bot", async () => {
  const { root, dir } = await workspace();
  try {
    await Promise.all([
      dir.create(record("b_1")),
      dir.create(record("b_2")),
      dir.create(record("b_3")),
    ]);
    assert.deepEqual((await dir.load()).map((bot) => bot.id).sort(), ["b_1", "b_2", "b_3"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interleaved rename and remove do not clobber each other", async () => {
  const { root, dir } = await workspace();
  try {
    await dir.create(record("b_1"));
    await dir.create(record("b_2"));
    await Promise.all([dir.rename("b_1", "研究员", "2026-10-25T03:00:00.000Z"), dir.remove("b_2")]);
    const bots = await dir.load();
    assert.deepEqual(
      bots.map((bot) => [bot.id, bot.title]),
      [["b_1", "研究员"]],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const corrupt = async (body: string) => {
  const { root, dir } = await workspace();
  await writeFile(join(root, "catalog.json"), body, { mode: 0o600 });
  return { root, dir };
};

test("a malformed catalog entry is refused instead of being trusted", async () => {
  const cases = [
    "null",
    '{"version":1,"bots":[null]}',
    '{"version":1,"bots":[{"id":"b_1"}]}',
    '{"version":2,"bots":[]}',
    `{"version":1,"bots":[{"id":"b_1","title":"a","createdAt":"x","updatedAt":"x","model":{"provider":"p","modelId":"m"}},{"id":"b_1","title":"b","createdAt":"x","updatedAt":"x","model":{"provider":"p","modelId":"m"}}]}`,
  ];
  for (const body of cases) {
    const { root, dir } = await corrupt(body);
    try {
      await assert.rejects(
        dir.load(),
        (error: DirectoryError) => error.reason === "corrupt_catalog",
      );
      const before = await readFile(join(root, "catalog.json"), "utf8");
      await assert.rejects(dir.create(record("b_9")), DirectoryError);
      assert.equal(await readFile(join(root, "catalog.json"), "utf8"), before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("create persists bot.json before publishing the catalog entry", async () => {
  const { root, dir } = await workspace();
  try {
    await dir.create({ ...record("b_1"), instructions: "be brief" });
    const config = JSON.parse(await readFile(join(root, "bots", "b_1", "bot.json"), "utf8"));
    assert.equal(config.instructions, "be brief");
    assert.equal(config.id, "b_1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed bot.json write does not create a catalog entry", async () => {
  const { root, dir } = await workspace();
  try {
    const real = await nodeDirectoryFs();
    const failing: DirectoryFs = {
      ...real,
      writeFile: async (path, body, mode) => {
        if (path.endsWith("bot.json")) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
        return real.writeFile(path, body, mode);
      },
    };
    await assert.rejects(
      new BotDirectory(root, failing).create(record("b_1")),
      (error: DirectoryError) => error.reason === "storage_failed",
    );
    assert.deepEqual(await dir.load(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remove refuses to drop the entry when the move fails but the bot is still there", async () => {
  const { root, dir } = await workspace();
  try {
    await dir.create(record("b_1"));
    const real = await nodeDirectoryFs();
    const failing: DirectoryFs = {
      ...real,
      rename: async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    };
    await assert.rejects(
      new BotDirectory(root, failing).remove("b_1"),
      (error: DirectoryError) => error.reason === "storage_failed",
    );
    assert.deepEqual(
      (await dir.load()).map((bot) => bot.id),
      ["b_1"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remove finishes when the source is gone and trash has it", async () => {
  const { root, dir } = await workspace();
  try {
    await dir.create(record("b_1"));
    const real = await nodeDirectoryFs();
    await real.mkdir(join(root, "trash"), { recursive: true });
    await real.rename(join(root, "bots", "b_1"), join(root, "trash", "b_1"));
    await dir.remove("b_1");
    assert.deepEqual(await dir.load(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remove refuses when neither the bot nor its trash exists", async () => {
  const { root, dir } = await workspace();
  try {
    await dir.create(record("b_1"));
    // The directory vanished without a trash copy: dropping the entry would make the
    // bot unreachable, so the catalog keeps it and the caller sees a storage failure.
    await rm(join(root, "bots", "b_1"), { recursive: true, force: true });
    await assert.rejects(
      dir.remove("b_1"),
      (error: DirectoryError) => error.reason === "storage_failed",
    );
    assert.deepEqual(
      (await dir.load()).map((bot) => bot.id),
      ["b_1"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a malformed record is refused on write as well as on read", async () => {
  const { root, dir } = await workspace();
  try {
    await dir.create(record("b_1"));
    const before = await readFile(join(root, "catalog.json"), "utf8");
    // A caller cannot smuggle an unknown or mistyped field into the catalog.
    const smuggled = { ...record("b_2"), surprise: 1 } as never;
    await assert.rejects(
      dir.create(smuggled),
      (error: DirectoryError) => error.reason === "corrupt_catalog",
    );
    // Nothing was created on disk either.
    await assert.rejects(readFile(join(root, "bots", "b_2", "bot.json")), /ENOENT/);
    assert.equal(await readFile(join(root, "catalog.json"), "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("groups are created, renamed, reordered and only removed when empty", async () => {
  const { root, dir } = await workspace();
  try {
    const work = await dir.createGroup("  工作  ");
    assert.equal(work.title, "工作", "the title is trimmed");
    const life = await dir.createGroup("生活");
    assert.deepEqual(
      (await dir.loadGroups()).map((group) => group.title),
      ["工作", "生活"],
    );

    await dir.renameGroup(work.id, "项目");
    assert.equal((await dir.loadGroups())[0]?.title, "项目");

    await dir.reorderGroups([life.id, work.id]);
    assert.deepEqual(
      (await dir.loadGroups()).map((group) => group.id),
      [life.id, work.id],
    );

    await dir.create({ ...record("b_1"), groupId: life.id });
    await assert.rejects(
      () => dir.deleteGroup(life.id),
      (error: unknown) => error instanceof DirectoryError && error.reason === "group_not_empty",
      "a group that holds a bot cannot be deleted",
    );

    await dir.setBotGroup("b_1", null, "2026-10-27T00:00:00.000Z");
    assert.equal((await dir.load())[0]?.groupId, undefined, "null clears the membership");
    await dir.deleteGroup(life.id);
    assert.deepEqual(
      (await dir.loadGroups()).map((group) => group.title),
      ["项目"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stored membership pointing at a missing group reads as ungrouped", async () => {
  const { root, dir } = await workspace();
  try {
    const group = await dir.createGroup("临时");
    await dir.create({ ...record("b_1"), groupId: group.id });
    const catalog = JSON.parse(await readFile(dir.catalogPath, "utf8")) as {
      version: number;
      bots: BotRecord[];
    };
    await writeFile(
      dir.catalogPath,
      JSON.stringify({ version: catalog.version, bots: catalog.bots, groups: [] }),
    );
    assert.equal((await dir.load())[0]?.groupId, undefined, "the sidebar keeps working");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unknown group order or a missing group is refused", async () => {
  const { root, dir } = await workspace();
  try {
    const group = await dir.createGroup("唯一");
    await assert.rejects(() => dir.reorderGroups([group.id, "g_missing1"]));
    await assert.rejects(() => dir.reorderGroups([]));
    await assert.rejects(() => dir.renameGroup("g_missing1", "x"));
    await assert.rejects(() => dir.create({ ...record("b_1"), groupId: "g_missing1" }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a note is normalized, survives a restart and is cleared without an empty field", async () => {
  const { root, dir } = await workspace();
  try {
    await dir.create(record("b_1"));
    const set = await dir.update(
      "b_1",
      { note: "  在核对   10-24\n的依赖报告 " },
      "2026-10-25T04:00:00.000Z",
    );
    assert.equal(set.note, "在核对 10-24 的依赖报告");

    const restarted = new BotDirectory(root, await nodeDirectoryFs());
    assert.equal((await restarted.load())[0]?.note, "在核对 10-24 的依赖报告");

    const cleared = await dir.update("b_1", { note: null }, "2026-10-25T05:00:00.000Z");
    assert.equal(cleared.note, undefined);
    const catalog = JSON.parse(await readFile(dir.catalogPath, "utf8")) as {
      bots: Record<string, unknown>[];
    };
    assert.equal("note" in (catalog.bots[0] ?? {}), false, "clearing deletes the field");

    const blank = await dir.update("b_1", { note: "   " }, "2026-10-25T06:00:00.000Z");
    assert.equal(blank.note, undefined, "a blank note clears it too");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a note keeps when it was written, and clearing it deletes the time too", async () => {
  const { root, dir } = await workspace();
  try {
    await dir.create(record("b_1"));
    await dir.update("b_1", { note: "正在核对" }, "2026-10-25T04:00:00.000Z");
    const kept = await dir.update("b_1", { title: "改个名字" }, "2026-10-25T05:00:00.000Z");
    assert.equal(kept.noteAt, "2026-10-25T04:00:00.000Z", "an unrelated edit keeps the time");

    const restarted = new BotDirectory(root, await nodeDirectoryFs());
    const reloaded = (await restarted.load())[0];
    assert.equal(reloaded?.note, "正在核对");
    assert.equal(reloaded?.noteAt, "2026-10-25T04:00:00.000Z", "the time survives a restart");

    await dir.update("b_1", { note: null }, "2026-10-25T06:00:00.000Z");
    const catalog = JSON.parse(await readFile(dir.catalogPath, "utf8")) as {
      bots: Record<string, unknown>[];
    };
    assert.equal("note" in (catalog.bots[0] ?? {}), false, "clearing deletes the note");
    assert.equal("noteAt" in (catalog.bots[0] ?? {}), false, "and the time goes with it");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an over-long note is refused and the stored note is untouched", async () => {
  const { root, dir } = await workspace();
  try {
    await dir.create(record("b_1"));
    await dir.update("b_1", { note: "正在核对" }, "2026-10-25T04:00:00.000Z");
    await assert.rejects(
      () => dir.update("b_1", { note: "字".repeat(121) }, "2026-10-25T05:00:00.000Z"),
      (error: DirectoryError) => error.reason === "invalid_note",
    );
    assert.equal((await dir.load())[0]?.note, "正在核对", "a refused note writes nothing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
