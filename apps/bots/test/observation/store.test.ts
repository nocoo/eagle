// SG-002 provider reads (docs/bots/specs/SUPERAGENT-002-PROTOCOL.md): a cold Bot store is
// read over real sqlite written by the real runtime, and the read changes nothing.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { Storage } from "@earendil-works/pi-durable";
import {
  inspectStore,
  readGeneration,
  readHistoryPage,
  readScopes,
  readSnapshotFacts,
} from "../../src/observation/store.ts";
import { createBench, text, trace, waitFor } from "../support/pi.ts";

type Fingerprint = Readonly<Record<string, string>>;

const fingerprint = async (dir: string): Promise<Fingerprint> => {
  const found: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const path = join(current, item.name);
      if (item.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!item.isFile()) continue;
      const body = await readFile(path);
      found[relative(dir, path)] =
        `${(await stat(path)).size}:${createHash("sha256").update(body).digest("hex")}`;
    }
  };
  await walk(dir);
  return found;
};

/** Only the named WAL sidecars may move: committed bytes are the contract. */
const dataFiles = (print: Fingerprint): Fingerprint =>
  Object.fromEntries(
    Object.entries(print).filter(([name]) => !name.endsWith("-wal") && !name.endsWith("-shm")),
  );

const settle = (
  handle: { submission: (key: { requestId: string }) => Promise<{ status: string } | undefined> },
  requestId: string,
) =>
  waitFor(async () => {
    const status = (await handle.submission({ requestId }))?.status;
    return status === "done" || status === "unanswered";
  }, `${requestId} to settle`);

test("a cold store reports available with the pinned schema version, incarnation and generation", async () => {
  const bench = await createBench();
  const spec = bench.spec();
  const path = join(spec.dir, "session.sqlite");
  try {
    bench.faux.setResponses([() => text("first"), () => text("second")]);
    const handle = await bench.runtime.open(spec);
    for (const index of [0, 1]) {
      const admission = await handle.submit({
        requestId: `r_store_${index}`,
        text: `question ${index}`,
        whenBusy: "followUp",
        trace,
      });
      await settle(handle, admission.requestId);
    }
    await handle.close(trace, 6_000);

    const state = await inspectStore(path);
    assert.equal(state.state, "available");
    assert.equal(state.schemaVersion, 2, "the pinned pi-durable schema version");
    assert.match(state.incarnation ?? "", /^[0-9a-f]{16}$/);

    const generation = await readGeneration(path);
    assert.equal(generation.min?.startsWith("e_"), true);
    assert.equal(generation.max?.startsWith("e_"), true);
    assert.equal(generation.count, generation.count);
    assert.ok(generation.count > 0);
  } finally {
    await bench.cleanup();
  }
});

test("a cold store read returns committed scopes and leaves every committed byte alone", async () => {
  const bench = await createBench();
  const spec = bench.spec();
  const path = join(spec.dir, "session.sqlite");
  try {
    bench.faux.setResponses([() => text("answer")]);
    const handle = await bench.runtime.open(spec);
    const admission = await handle.submit({
      requestId: "r_scope",
      text: "question",
      whenBusy: "followUp",
      trace,
    });
    await settle(handle, admission.requestId);
    await handle.close(trace, 6_000);

    const before = dataFiles(await fingerprint(spec.dir));
    const scopes = await readScopes(path);
    const facts = await readSnapshotFacts(path);
    const page = await readHistoryPage(path, { scopeId: scopes[0]?.id ?? "root", limit: 10 });
    const after = dataFiles(await fingerprint(spec.dir));

    assert.deepEqual(after, before, "a read must not change committed data");
    assert.equal(scopes.length, 1);
    assert.equal(scopes[0]?.kind, "root");
    assert.equal(facts.activity, "idle");
    assert.ok(page.messages.length > 0, "the conversation is readable");
  } finally {
    await bench.cleanup();
  }
});

test("a missing store is unknown, never an empty history", async () => {
  const bench = await createBench();
  const spec = bench.spec();
  try {
    const state = await inspectStore(join(spec.dir, "session.sqlite"));
    assert.equal(state.state, "session_missing");
    assert.deepEqual(await readdir(spec.dir).catch(() => []), [], "nothing was created");
  } finally {
    await bench.cleanup();
  }
});

test("a store from another schema version is unsupported and is not migrated", async () => {
  const bench = await createBench();
  const spec = bench.spec();
  const path = join(spec.dir, "session.sqlite");
  try {
    bench.faux.setResponses([() => text("answer")]);
    const handle = await bench.runtime.open(spec);
    const admission = await handle.submit({
      requestId: "r_old",
      text: "question",
      whenBusy: "followUp",
      trace,
    });
    await settle(handle, admission.requestId);
    await handle.close(trace, 6_000);

    const db = new DatabaseSync(path);
    db.prepare("UPDATE durable_schema SET version = 1").run();
    db.close();
    const before = dataFiles(await fingerprint(spec.dir));

    const state = await inspectStore(path);
    assert.equal(state.state, "schema_unsupported");
    assert.equal(state.schemaVersion, 1);
    assert.deepEqual(dataFiles(await fingerprint(spec.dir)), before, "no migration ran");
  } finally {
    await bench.cleanup();
  }
});

test("a corrupt store is unreadable rather than empty", async () => {
  const bench = await createBench();
  const spec = bench.spec();
  const path = join(spec.dir, "session.sqlite");
  try {
    bench.faux.setResponses([() => text("answer")]);
    const handle = await bench.runtime.open(spec);
    const admission = await handle.submit({
      requestId: "r_corrupt",
      text: "question",
      whenBusy: "followUp",
      trace,
    });
    await settle(handle, admission.requestId);
    await handle.close(trace, 6_000);

    await (await import("node:fs/promises")).writeFile(path, Buffer.alloc(64));
    const state = await inspectStore(path);
    assert.equal(state.state, "store_unreadable");
  } finally {
    await bench.cleanup();
  }
});

test("child scopes are enumerated with their owner, and the root page keeps its own rows", async () => {
  const bench = await createBench({
    provider: { models: [{ id: "faux-tiny", contextWindow: 1_200, maxTokens: 200 }] },
    settings: {
      compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 150, backgroundTokens: 0 },
    },
    note: (spec) => ({
      botId: spec.id,
      current: () => ({}),
      set: async (note: string) => ({ note }),
    }),
  });
  const spec = bench.spec();
  const path = join(spec.dir, "session.sqlite");
  try {
    const long = "please summarise the state of the build ".repeat(12);
    bench.faux.setResponses(
      Array.from({ length: 40 }, (_unused, index) => () => text(`${long}Turn ${index} done.`)),
    );
    const handle = await bench.runtime.open(spec);
    for (let turn = 1; turn <= 5; turn += 1) {
      const admission = await handle.submit({
        requestId: `r_child_${turn}`,
        text: `Turn ${turn}: ${long}`,
        whenBusy: "followUp",
        trace,
      });
      await settle(handle, admission.requestId);
    }
    await waitFor(async () => (await handle.busy()).tasks === false, "reflection to finish");
    await handle.close(trace, 6_000);

    const scopes = await readScopes(path);
    const root = scopes.find((scope) => scope.kind === "root");
    const children = scopes.filter((scope) => scope.kind === "child");
    assert.ok(root !== undefined);
    assert.ok(children.length > 0, "a forked reflection conversation is a scope of its own");
    assert.ok(
      children.every((scope) => scope.owner !== null),
      "a child names its owner",
    );

    const rootPage = await readHistoryPage(path, { scopeId: root.id, limit: 200 });
    const childPage = await readHistoryPage(path, { scopeId: children[0]?.id ?? "", limit: 200 });
    assert.ok(
      rootPage.messages.every(
        (message) => !childPage.messages.some((other) => other.entryId === message.entryId),
      ),
      "a child page does not repeat the parent's rows",
    );
    assert.ok(
      rootPage.boundary.compactions.length > 0,
      "a compaction boundary is reported in the root page",
    );
  } finally {
    await bench.cleanup();
  }
});

test("history pages walk backwards by entry id without repeating or skipping", async () => {
  const bench = await createBench();
  const spec = bench.spec();
  const path = join(spec.dir, "session.sqlite");
  try {
    bench.faux.setResponses(
      Array.from({ length: 20 }, (_unused, index) => () => text(`a${index}`)),
    );
    const handle = await bench.runtime.open(spec);
    for (let turn = 0; turn < 5; turn += 1) {
      const admission = await handle.submit({
        requestId: `r_page_${turn}`,
        text: `question ${turn}`,
        whenBusy: "followUp",
        trace,
      });
      await settle(handle, admission.requestId);
    }
    await handle.close(trace, 6_000);

    const all = await readHistoryPage(path, { scopeId: "root", limit: 200 });
    const first = await readHistoryPage(path, { scopeId: "root", limit: 3 });
    assert.equal(first.messages.length, 3);
    assert.equal(first.next?.before, first.messages[0]?.entryId);
    const second = await readHistoryPage(path, {
      scopeId: "root",
      limit: 3,
      ...(first.next === undefined ? {} : { before: first.next.before }),
    });
    const seen = new Set([...first.messages, ...second.messages].map((message) => message.entryId));
    assert.equal(seen.size, first.messages.length + second.messages.length);
    assert.equal(
      first.boundary.newestEntryId,
      all.boundary.newestEntryId,
      "the boundary is the store's newest entry at capture, mapped or not",
    );
  } finally {
    await bench.cleanup();
  }
});

test("an oversized stored entry is trimmed at delivery and still advances the page", async () => {
  const bench = await createBench({
    storage: async (path: string) => {
      const { openNodeSqliteStorage } = await import(
        "@earendil-works/pi-durable/storage/sqlite/node"
      );
      const storage: Storage = await openNodeSqliteStorage(path);
      return storage;
    },
    maxMessageBytes: 200_000,
  });
  const spec = bench.spec();
  const path = join(spec.dir, "session.sqlite");
  try {
    const huge = "x".repeat(120_000);
    bench.faux.setResponses([() => text(huge)]);
    const handle = await bench.runtime.open(spec);
    const admission = await handle.submit({
      requestId: "r_huge",
      text: "question",
      whenBusy: "followUp",
      trace,
    });
    await settle(handle, admission.requestId);
    await handle.close(trace, 6_000);

    const page = await readHistoryPage(path, { scopeId: "root", limit: 10 });
    const trimmed = page.messages.filter((message) => message.trimmed === true);
    assert.ok(trimmed.length > 0, "the oversized message was trimmed");
    assert.equal(page.coverage.content, "partial");
    assert.deepEqual(page.coverage.reasons, ["entry_trimmed"]);
    assert.equal(page.next, undefined, "a trimmed oldest row still ends the walk");
  } finally {
    await bench.cleanup();
  }
});

test("activity derives from committed task rows only", async () => {
  const bench = await createBench();
  const spec = bench.spec();
  const path = join(spec.dir, "session.sqlite");
  try {
    bench.faux.setResponses([() => text("answer")]);
    const handle = await bench.runtime.open(spec);
    const admission = await handle.submit({
      requestId: "r_activity",
      text: "question",
      whenBusy: "followUp",
      trace,
    });
    await settle(handle, admission.requestId);
    await handle.close(trace, 6_000);

    assert.equal((await readSnapshotFacts(path)).activity, "idle");
    assert.equal((await readSnapshotFacts(join(spec.dir, "missing.sqlite"))).activity, "unknown");
  } finally {
    await bench.cleanup();
  }
});
