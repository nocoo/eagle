import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ClassifiedFailure } from "../../src/core/domain.ts";
import { type HistoryBundle, validateBundle } from "../../src/runtime/pi/HistoryReplica.ts";
import {
  keyOf,
  pageSchema,
  type ResourceCarrier,
  resourceManifest,
} from "../../src/runtime/pi/syncProtocol.ts";
import { createBench, trace } from "../support/pi.ts";
import { openReplica, pull } from "../support/replica.ts";

const resources = JSON.parse(
  await readFile(
    new URL("../../../../fixtures/bots-sync/resources.v1.json", import.meta.url),
    "utf8",
  ),
) as HistoryBundle["resources"];

test("resource-only carriers are stable facts with no history receipt, source copies or continuation", async () => {
  const bench = await createBench();
  const a = await openReplica(join(bench.dir, "a"));
  const b = await openReplica(join(bench.dir, "b"));
  try {
    await b.command("bind", { sharedBotId: a.sync.store.binding.sharedBotId });
    const carrier = (await a.command("export", {
      kind: "resources",
      resources,
    })) as ResourceCarrier;
    const page = await pull(a);
    assert.equal(page.events.length, resources.length + 1);
    assert.deepEqual(page.events.at(-1)?.body, resourceManifest(resources));
    assert.equal(keyOf(resourceManifest(resources)), carrier.head);
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(await a.command("export", { kind: "resources", resources }), carrier);
      await b.command("import", { bundle: carrier });
      assert.deepEqual(
        await b.command("export", { kind: "resources", head: carrier.head }),
        carrier,
      );
    }
    assert.deepEqual(await pull(a), page);
    assert.deepEqual((await pull(b)).events, []);
    await assert.rejects(b.command("bind", { sharedBotId: randomUUID() }), ClassifiedFailure);
    for (const replica of [a, b]) {
      assert.deepEqual((await replica.root.entries({}, 128, undefined, ctx)).items, []);
      assert.deepEqual(
        (await replica.harness.commit((tx) => tx.scanTasks({}, 128), ctx)).items,
        [],
      );
      assert.deepEqual(await replica.history.receipt(carrier.head), undefined);
      assert.deepEqual(await replica.command("receipts", { after: 0 }), {
        items: [],
        nextAfter: 0,
        hasMore: false,
      });
      assert.deepEqual(replica.sync.store.pending(), []);
      assert.deepEqual(replica.sync.store.readyHeads(), []);
      assert.equal(replica.faux.state.callCount, 0);
      assert.throws(() => validateBundle(carrier), ClassifiedFailure);
      for (const params of [
        { head: carrier.head },
        { kind: "resources", branch: "forbidden" },
        { kind: "resources", head: carrier.head, resources },
        { kind: "resources", resources: [] },
        { kind: "resources", head: "0".repeat(64) },
      ])
        await assert.rejects(replica.command("export", params), ClassifiedFailure);
      await assert.rejects(
        replica.command("run", {
          head: carrier.head,
          requestId: "no-synthetic-branch",
          text: "must not run",
        }),
        ClassifiedFailure,
      );
    }
  } finally {
    await Promise.allSettled([a.close(), b.close()]);
    await bench.cleanup();
  }
});

test("missing resource refs stay unapplied until actual facts arrive; foreign input remains passive", async () => {
  const bench = await createBench();
  const a = await openReplica(join(bench.dir, "a"));
  const b = await openReplica(join(bench.dir, "b"));
  try {
    await b.command("bind", { sharedBotId: a.sync.store.binding.sharedBotId });
    const carrier = (await a.command("export", {
      kind: "resources",
      resources,
    })) as ResourceCarrier;
    const original = await pull(a);
    const foreign = {
      ...original,
      source: { replicaId: randomUUID(), epoch: randomUUID() },
      range: { from: 1, to: 2 },
      events: [
        { seq: 1, body: resourceManifest(resources) },
        {
          seq: 2,
          body: {
            kind: "run",
            mode: "root",
            requestId: "foreign-resource-run",
            head: null,
            text: "must remain foreign",
            resourceHead: carrier.head,
            resourceVersion: createHash("sha256").update(JSON.stringify(resources)).digest("hex"),
          },
        },
      ],
      nextAfter: 2,
      hasMore: false,
    };
    await b.command("apply", { page: foreign });
    assert.deepEqual(b.sync.store.stream(foreign.source), { known: 2, received: 2, applied: 0 });
    assert.equal(b.sync.store.fact(carrier.head), undefined);
    await assert.rejects(
      b.command("export", { kind: "resources", head: carrier.head }),
      ClassifiedFailure,
    );
    assert.equal(b.faux.state.callCount, 0);
    await b.command("apply", { page: original });
    assert.equal(b.sync.store.stream(foreign.source).applied, 2);
    assert.deepEqual(await b.command("export", { kind: "resources", head: carrier.head }), carrier);
    assert.equal(b.sync.store.run("foreign-resource-run"), undefined);
    assert.deepEqual((await b.root.entries({}, 128, undefined, ctx)).items, []);
    const altered = structuredClone(original);
    const first = altered.events[0];
    assert.ok(first && first.body.kind === "resource");
    first.body.resource.base64 = "YmFk";
    const c = await openReplica(join(bench.dir, "c"));
    try {
      await c.command("bind", { sharedBotId: a.sync.store.binding.sharedBotId });
      await assert.rejects(c.command("apply", { page: altered }), ClassifiedFailure);
      assert.equal(c.sync.store.stream(altered.source).applied, 0);
      assert.equal(c.sync.store.fact(carrier.head), undefined);
      assert.equal(c.faux.state.callCount, 0);
      assert.equal(
        pageSchema.safeParse({
          ...original,
          events: [{ seq: 1, body: { kind: "resource_manifest", resources: [] } }],
        }).success,
        false,
      );
    } finally {
      await c.close();
    }
  } finally {
    await Promise.allSettled([a.close(), b.close()]);
    await bench.cleanup();
  }
});

for (const bad of ["path", "skill", "utf8", "EACCES"] as const) {
  test(`fresh ${bad} resource refusal is not admitted and cannot auto-run after repair/reopen`, async () => {
    const bench = await createBench();
    const spec = bench.spec();
    let handle = await bench.runtime.open(spec);
    const call = (method: "export" | "import", params: unknown) =>
      handle.replica?.({ method, params, trace });
    try {
      const selected = structuredClone(resources);
      const first = selected[0];
      assert.ok(first);
      if (bad === "path") selected[0] = { ...first, name: "../escape.txt" };
      if (bad === "skill") selected.splice(1, 1);
      if (bad === "utf8") {
        const bytes = Buffer.from([0xff]);
        selected[0] = {
          ...first,
          base64: bytes.toString("base64"),
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      }
      const carrier = (await call("export", {
        kind: "resources",
        resources: selected,
      })) as ResourceCarrier;
      const install = join(spec.dir, "resources");
      if (bad === "EACCES") {
        await mkdir(install);
        await chmod(install, 0o500);
      }
      let failure: ClassifiedFailure | undefined;
      await assert.rejects(
        handle.submit({
          requestId: `fresh-refused-${bad}`,
          text: "do not execute",
          resourceHead: carrier.head,
          whenBusy: "followUp",
          trace,
        }),
        (error: unknown) => {
          assert.ok(error instanceof ClassifiedFailure);
          failure = error;
          assert.equal(error.disposition, "not_admitted");
          assert.equal(error.failure.kind, bad === "EACCES" ? "storage_failed" : "invalid_command");
          if (bad === "EACCES") assert.equal((error.cause as NodeJS.ErrnoException).code, "EACCES");
          return true;
        },
      );
      assert.equal(await handle.submission({ requestId: `fresh-refused-${bad}` }), undefined);
      assert.equal(bench.faux.state.callCount, 0);
      const errors = bench.records.filter((r) => r.level === "error");
      assert.equal(errors.length, 1);
      assert.equal(errors[0]?.evt, "runtime.submit.fail");
      assert.equal(errors[0]?.err?.failure, failure?.failure.id);
      const db = new DatabaseSync(join(spec.dir, "replica.sqlite"));
      try {
        const run = JSON.parse(String(db.prepare("SELECT value FROM local_runs").get()?.value)) as {
          admitted: boolean;
          rejected: boolean;
        };
        assert.equal(run.admitted, false);
        assert.equal(run.rejected, true);
      } finally {
        db.close();
      }
      await handle.close(trace, 1_000);
      if (bad === "EACCES") {
        await chmod(install, 0o700);
        await rm(install, { recursive: true });
      }
      handle = await bench.runtime.open(spec);
      assert.deepEqual(await handle.busy(), { run: false, tasks: false });
      assert.equal(bench.faux.state.callCount, 0);
      assert.equal(await handle.submission({ requestId: `fresh-refused-${bad}` }), undefined);
    } finally {
      await chmod(join(spec.dir, "resources"), 0o700).catch(() => undefined);
      await handle.close(trace, 1_000);
      await bench.cleanup();
    }
  });
}
