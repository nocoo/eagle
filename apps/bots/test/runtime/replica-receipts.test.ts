import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BACKGROUND_CONTEXT as ctx, withAbortSignal } from "@earendil-works/chord/context";
import { defineDocFamily, SessionFailed, StorageRequestError } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ClassifiedFailure } from "../../src/core/domain.ts";
import { bundleSchema, type HistoryBundle, hash } from "../../src/runtime/pi/HistoryReplica.ts";
import { legacyImports } from "../support/legacyReplica.ts";
import { createBench, text, trace, waitFor } from "../support/pi.ts";
import { openReplica } from "../support/replica.ts";

test("shared receipt validation keeps the public Session read failure guard", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-receipt-guard-"));
  let armed = false;
  let failedReads = 0;
  const a = await openReplica(dir, "b_replica", [text("saved")], async (path) => {
    const inner = await openNodeSqliteStorage(path);
    return new Proxy(inner, {
      get(target, property, receiver) {
        if (property === "scanEntries")
          return (...args: Parameters<typeof inner.scanEntries>) => {
            if (armed && args[0].minEntryId !== undefined && args[0].maxEntryId !== undefined) {
              failedReads += 1;
              throw new Error("receipt storage went away");
            }
            return target.scanEntries(...args);
          };
        return Reflect.get(target, property, receiver);
      },
    });
  });
  try {
    await (
      await a.root.submit({ type: "input", requestId: "receipt-source", content: "saved" }, ctx)
    ).wait(ctx);
    const bundle = (await a.command("export", {})) as HistoryBundle;
    const receipt = await a.history.receipt(bundle.head);
    armed = true;
    await assert.rejects(a.history.checkedEntries(bundle, receipt), /receipt storage went away/);
    assert.equal(failedReads, 1);
    await assert.rejects(a.history.checkedEntries(bundle, receipt), SessionFailed);
    assert.equal(failedReads, 1, "a failed Session must not reach Storage again");
    assert.equal(a.faux.state.callCount, 1);
  } finally {
    await a.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("receipt inventory bounds checked documents, skips compact/empty records and resumes after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-receipt-pages-"));
  const reads: number[] = [];
  let reading = 0;
  let maxReading = 0;
  const storage = async (path: string) => {
    const inner = await openNodeSqliteStorage(path);
    return new Proxy(inner, {
      get(target, property, receiver) {
        if (property === "document")
          return async (...args: Parameters<typeof inner.document>) => {
            reads.push(args[0]);
            reading += 1;
            maxReading = Math.max(maxReading, reading);
            try {
              return await target.document(...args);
            } finally {
              reading -= 1;
            }
          };
        return Reflect.get(target, property, receiver);
      },
    });
  };
  let a = await openReplica(dir, "b_replica", [text("original")], storage);
  try {
    await (
      await a.root.submit({ type: "input", requestId: "receipt-source", content: "saved" }, ctx)
    ).wait(ctx);
    const original = (await a.command("export", {})) as HistoryBundle;
    const expected = [original.head];
    for (let i = 0; i < 130; i++) {
      const { head: _head, ...payload } = original;
      const changed = bundleSchema
        .omit({ head: true })
        .parse({ ...payload, agent: { ...payload.agent, instructions: `saved version ${i}` } });
      const bundle = { ...changed, head: hash(changed) };
      await a.history.command({ method: "import", params: { bundle }, trace });
      expected.push(bundle.head);
      if (i === 40) {
        const complete = await a.history.receipt(original.head);
        assert.ok(complete);
        await a.harness.commit(async (tx) => {
          const compact = await tx.doc(legacyImports, hash("compact receipt"), null);
          Object.assign(compact, { ...complete, bundle: "" });
          await tx.doc(legacyImports, hash("empty incomplete receipt"), null);
        }, ctx);
      }
    }
    reads.length = 0;
    const first = await a.history.receipts({ after: 0 });
    assert.equal(first.hasMore, true);
    assert.ok(
      first.items.length < 128,
      "compact/incomplete documents consume the checked budget too",
    );
    assert.ok(reads.length <= 128);
    assert.equal(maxReading, 1, "carrier bodies are validated serially, never in a 128-body batch");
    assert.ok(first.nextAfter > 0);
    const repeated = await a.history.receipts({ after: 0 });
    assert.deepEqual(repeated, first);
    await a.close();
    a = await openReplica(dir, "b_replica", [], storage);
    reads.length = 0;
    const last = await a.history.receipts({ after: first.nextAfter });
    assert.equal(last.hasMore, false);
    assert.ok(reads.length <= 128);
    assert.deepEqual(
      [...first.items, ...last.items].map((item) => item.head).sort(),
      expected.sort(),
    );
    const empty = await a.history.receipts({ after: last.nextAfter, limit: 1 });
    assert.deepEqual(empty, { items: [], nextAfter: last.nextAfter, hasMore: false });
    // Scan one checked document per call, including a page returning no complete carrier.
    let after = 0;
    let sawEmptyAdvance = false;
    for (;;) {
      const page = await a.history.receipts({ after, limit: 1 });
      if (page.items.length === 0 && page.nextAfter > after) sawEmptyAdvance = true;
      assert.ok(page.nextAfter > after || !page.hasMore);
      after = page.nextAfter;
      if (!page.hasMore) break;
    }
    assert.ok(sawEmptyAdvance);
    assert.equal(a.faux.state.callCount, 0);
  } finally {
    await a.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("inventory rejects malformed complete carriers/maps/keys without closing a healthy Session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-receipt-invalid-"));
  const a = await openReplica(dir, "b_replica", [text("saved")]);
  try {
    await (
      await a.root.submit({ type: "input", requestId: "receipt-source", content: "saved" }, ctx)
    ).wait(ctx);
    const bundle = (await a.command("export", {})) as HistoryBundle;
    const valid = await a.history.receipt(bundle.head);
    assert.ok(valid);
    const invalid = (error: unknown) =>
      error instanceof ClassifiedFailure && error.failure.kind === "invalid_command";
    for (const change of [
      { bundle: "{" },
      { bundle: 1 },
      { bundle: JSON.stringify({ ...bundle, head: "0".repeat(64) }) },
      { entries: {} },
      { conversationId: 999_999 },
    ]) {
      await a.harness.commit(
        async (tx) => Object.assign(await tx.doc(legacyImports, bundle.head, null), change),
        ctx,
      );
      await assert.rejects(a.history.receipts({ after: 0 }), invalid);
      await a.harness.commit(
        async (tx) => Object.assign(await tx.doc(legacyImports, bundle.head, null), valid),
        ctx,
      );
    }
    const unsupported = defineDocFamily({ ...legacyImports.definition, version: 2 });
    const { head: _head, ...payload } = bundle;
    const versionedPayload = bundleSchema.omit({ head: true }).parse({
      ...payload,
      agent: { ...payload.agent, instructions: "unsupported receipt version" },
    });
    const versionedBundle = { ...versionedPayload, head: hash(versionedPayload) };
    await a.harness.commit(async (tx) => {
      Object.assign(await tx.doc(unsupported, versionedBundle.head, null), valid, {
        bundle: JSON.stringify(versionedBundle),
      });
    }, ctx);
    await assert.rejects(a.history.receipts({ after: 0 }), invalid);
    await a.harness.commit((tx) => tx.retireDoc(unsupported, versionedBundle.head), ctx);
    await a.harness.commit(async (tx) => {
      Object.assign(await tx.doc(legacyImports, "bad-family-key", null), valid);
    }, ctx);
    await assert.rejects(a.history.receipts({ after: 0 }), invalid);
    await a.harness.commit((tx) => tx.retireDoc(legacyImports, "bad-family-key"), ctx);
    assert.deepEqual(
      (await a.history.receipts({ after: 0 })).items.map((item) => item.head),
      [bundle.head],
    );
    assert.equal(a.faux.state.callCount, 1);
  } finally {
    await a.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const operation of ["scanDocuments", "document"] as const)
  test(`receipts command ${operation} I/O failure ends the same Session before any later backend read`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "bots-inventory-failure-"));
    const io = new Error(`inventory ${operation} I/O failed`);
    let armed = false;
    let reads = 0;
    const a = await openReplica(dir, "b_replica", [text("saved")], async (path) => {
      const inner = await openNodeSqliteStorage(path);
      return new Proxy(inner, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== "function" || property === "close") return value;
          return (...args: unknown[]) => {
            if (armed) {
              reads += 1;
              if (property === operation) throw io;
            }
            return Reflect.apply(value, target, args);
          };
        },
      });
    });
    try {
      await (
        await a.root.submit({ type: "input", requestId: "receipt-source", content: "saved" }, ctx)
      ).wait(ctx);
      await a.command("export", {});
      armed = true;
      await assert.rejects(a.command("receipts", { after: 0 }), (error) => error === io);
      const afterFailure = reads;
      for (const method of ["receipts", "status"] as const) {
        await assert.rejects(
          a.command(method, method === "receipts" ? { after: 0 } : {}),
          (error) => error instanceof Error && error.message === "Session is closed",
        );
        assert.equal(
          reads,
          afterFailure,
          "the failed Session refuses before touching any backend method",
        );
      }
      assert.deepEqual(
        await a.harness.closed,
        { reason: "closed" },
        "public close seals the instance without fabricating an SDK failed reason",
      );
      assert.equal(a.faux.state.callCount, 1);
    } finally {
      await a.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

test("healthy close scans committed facts before the scheduled background scan can run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-inventory-healthy-close-"));
  const a = await openReplica(dir);
  try {
    const data = "committed before healthy close";
    const entry = await a.root.commit(
      (tx) => tx.appendEntry(a.root.id, { kind: "fixture.close", data }),
      ctx,
    );
    assert.ok(
      !a.sync.store.db
        .prepare("SELECT event FROM source_events")
        .all()
        .some((row) => String(row.event).includes(data)),
    );
    await a.close();
    const saved = new DatabaseSync(join(dir, "replica.sqlite"), { readOnly: true });
    try {
      const facts = saved
        .prepare("SELECT event FROM source_events")
        .all()
        .map((row) => JSON.parse(String(row.event)))
        .filter((body) => body.kind === "entry" && body.content.kind === "fixture.close");
      assert.equal(facts.length, 1);
      assert.equal(facts[0].origin.entryId, entry.id);
      assert.equal(facts[0].content.data, data);
    } finally {
      saved.close();
    }
  } finally {
    await a.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const [operation, closeQueued] of [
  ["scanDocuments", false],
  ["document", false],
  ["scanDocuments", true],
  ["document", true],
] as const)
  test(`runtime receipts ${operation} failure keeps one redacted origin and propagates its identity${closeQueued ? " with close queued in the same turn" : ""}`, async () => {
    const io = new Error("fixture body must never appear in logs");
    let armed = false;
    const bench = await createBench({
      storage: async (path) => {
        const inner = await openNodeSqliteStorage(path);
        return new Proxy(inner, {
          get(target, property, receiver) {
            if (property === operation)
              return (...args: unknown[]) => {
                if (armed) throw io;
                return Reflect.apply(Reflect.get(target, property, receiver), target, args);
              };
            return Reflect.get(target, property, receiver);
          },
        });
      },
    });
    let handle: Awaited<ReturnType<typeof bench.runtime.open>> | undefined;
    try {
      handle = await bench.runtime.open(bench.spec());
      assert.ok(handle.replica);
      const command = handle.replica.bind(handle);
      const bundle = JSON.parse(
        await readFile(
          new URL("../../../../fixtures/bots-sync/history.v1.json", import.meta.url),
          "utf8",
        ),
      );
      await command({ method: "import", params: { bundle }, trace });
      armed = true;
      const pending = command({ method: "receipts", params: { after: 0 }, trace }).then(
        () => assert.fail("I/O must reject"),
        (error: unknown) => error,
      );
      const closing = closeQueued ? handle.close(trace, 5000) : undefined;
      const [first, outcome] = await Promise.all([pending, closing]);
      if (closeQueued) assert.equal(outcome, "closed");
      assert.ok(
        first instanceof ClassifiedFailure &&
          first.failure.kind === "storage_failed" &&
          first.cause === io,
      );
      const again = await command({ method: "receipts", params: { after: 0 }, trace }).then(
        () => assert.fail("a failed instance must reject"),
        (error: unknown) => error,
      );
      assert.ok(again instanceof ClassifiedFailure);
      assert.deepEqual(again.failure, first.failure);
      await handle.close(trace, 5000);
      handle = undefined;
      const origins = bench.records.filter((record) => record.level === "error");
      assert.equal(origins.length, 1, "only the innermost failure origin is logged at error");
      assert.equal(origins[0]?.err?.failure, first.failure.id);
      assert.equal(origins[0]?.evt, "runtime.replica.fail");
      assert.equal(origins[0]?.layer, "runtime");
      assert.equal(origins[0]?.trace, trace);
      assert.equal(origins[0]?.err?.origin, true);
      assert.ok(
        bench.records.some(
          (record) =>
            record.level === "warn" &&
            record.err?.failure === first.failure.id &&
            record.detail?.propagated === true,
        ),
      );
      assert.ok(!JSON.stringify(bench.records).includes(io.message));
      assert.equal(bench.faux.state.callCount, 0);
    } finally {
      await handle?.close(trace, 5000);
      await bench.cleanup();
    }
  });

for (const operation of ["scanDocuments", "document"] as const)
  test(`in-flight receipts ${operation} result is refused after public Session close`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "bots-inventory-inflight-"));
    let armed = false;
    let entered = false;
    let reads = 0;
    const release = Promise.withResolvers<void>();
    const a = await openReplica(dir, "b_replica", [text("saved")], async (path) => {
      const inner = await openNodeSqliteStorage(path);
      return new Proxy(inner, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== "function" || property === "close") return value;
          return async (...args: unknown[]) => {
            if (armed) reads += 1;
            const result = await Reflect.apply(value, target, args);
            if (armed && property === operation) {
              entered = true;
              await release.promise;
            }
            return result;
          };
        },
      });
    });
    try {
      if (operation === "document") {
        await a.harness.commit(async (tx) => {
          await tx.appendEntry(a.root.id, { kind: "fixture.compact", data: "saved" });
        }, ctx);
        await a.command("status", {});
      }
      assert.equal(
        (await a.history.receipts({ after: 0 })).items.length,
        0,
        "the result would be empty, including the compact-only path",
      );
      armed = true;
      const pending = a.command("receipts", { after: 0 });
      const rejected = assert.rejects(pending, /Session is closed/);
      await waitFor(() => entered, "the actual inventory backend read to reach its result barrier");
      await a.harness.close(ctx);
      const atClose = reads;
      release.resolve();
      await rejected;
      assert.equal(reads, atClose, "no receipt/map read follows the discarded backend result");
    } finally {
      release.resolve();
      await a.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

for (const kind of ["empty", "compact"] as const)
  test(`a closed Session cannot enumerate ${kind} inventory or accept another replica command`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "bots-inventory-closed-"));
    let armed = false;
    let reads = 0;
    const a = await openReplica(dir, "b_replica", [], async (path) => {
      const inner = await openNodeSqliteStorage(path);
      return new Proxy(inner, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== "function" || property === "close") return value;
          return (...args: unknown[]) => {
            if (armed) reads += 1;
            return Reflect.apply(value, target, args);
          };
        },
      });
    });
    try {
      if (kind === "compact") {
        await a.harness.commit(async (tx) => {
          await tx.appendEntry(a.root.id, { kind: "fixture.compact", data: "saved" });
        }, ctx);
        await a.command("status", {});
        assert.ok(a.sync.store.latestHead(a.root.id));
      }
      assert.equal((await a.history.receipts({ after: 0 })).items.length, 0);
      await a.harness.close(ctx);
      armed = true;
      await assert.rejects(a.command("receipts", { after: 0 }), /Session is closed/);
      await assert.rejects(
        a.command("bind", { sharedBotId: a.sync.store.binding.sharedBotId }),
        /Session is closed/,
      );
      assert.equal(reads, 0);
    } finally {
      await a.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

test("invalid protocol, StorageRequestError and a genuinely canceled read leave the Session usable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-inventory-exempt-"));
  let requestError = true;
  let cancel = false;
  const controller = new AbortController();
  const a = await openReplica(dir, "b_replica", [], async (path) => {
    const inner = await openNodeSqliteStorage(path);
    return new Proxy(inner, {
      get(target, property, receiver) {
        if (property === "scanDocuments")
          return (...args: Parameters<typeof inner.scanDocuments>) => {
            if (requestError) throw new StorageRequestError("invalid inventory cursor");
            if (cancel) {
              assert.equal(args[3].abortSignal?.aborted, false);
              controller.abort(new Error("actual canceled inventory read"));
              args[3].abortSignal?.throwIfAborted();
            }
            return target.scanDocuments(...args);
          };
        return Reflect.get(target, property, receiver);
      },
    });
  });
  try {
    await assert.rejects(
      a.command("receipts", { after: -1 }),
      (error) => error instanceof ClassifiedFailure && error.failure.kind === "invalid_command",
    );
    await assert.rejects(a.command("receipts", { after: 0 }), StorageRequestError);
    requestError = false;
    assert.deepEqual(await a.command("receipts", { after: 0 }), {
      items: [],
      nextAfter: 0,
      hasMore: false,
    });
    cancel = true;
    await assert.rejects(
      a.history.receipts({ after: 0 }, withAbortSignal(controller.signal, ctx)),
      (error) => error === controller.signal.reason,
    );
    cancel = false;
    assert.deepEqual(await a.command("receipts", { after: 0 }), {
      items: [],
      nextAfter: 0,
      hasMore: false,
    });
    await a.harness.commit(() => undefined, ctx);
  } finally {
    await a.close();
    await rm(dir, { recursive: true, force: true });
  }
});
