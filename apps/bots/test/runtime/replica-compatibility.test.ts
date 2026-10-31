import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, type TranscriptContext } from "@earendil-works/pi-ai";
import { type ConversationId, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ClassifiedFailure } from "../../src/core/domain.ts";
import type { HistoryBundle } from "../../src/runtime/pi/HistoryReplica.ts";
import { createToolRegistry } from "../../src/tools/registry.ts";
import { openWorkspace } from "../../src/tools/workspace.ts";
import { legacyImports, seedP0, sourceCarriers } from "../support/legacyReplica.ts";
import { createBench, text, trace, waitFor } from "../support/pi.ts";
import { openReplica, pull } from "../support/replica.ts";

test("a P0 SDK receipt without replica.sqlite directly runs after upgrade, including a standalone branch carrier", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bots-p0-upgrade-"));
  try {
    for (const bundle of await sourceCarriers(join(dir, "source")))
      await t.test(
        bundle.parents.length === 0 ? "root carrier" : "branch without parent receipt",
        async () => {
          const bench = await createBench();
          let handle: Awaited<ReturnType<typeof bench.runtime.open>> | undefined;
          try {
            const legacy = await seedP0(bench, bundle);
            const expected = (
              await (
                await legacy.harness.conversation(
                  legacy.saved.conversationId as ConversationId,
                  ctx,
                )
              )?.context(ctx)
            )?.messages;
            assert.ok(expected);
            await legacy.harness.close(ctx);
            const requests: TranscriptContext[] = [];
            bench.faux.setResponses([
              (request) => {
                requests.push(request);
                return text("upgraded local continuation");
              },
            ]);
            handle = await bench.runtime.open(bench.spec());
            assert.equal(
              bench.faux.state.callCount,
              0,
              "opening old imported history stays passive",
            );
            assert.ok(handle.replica);
            const command = handle.replica.bind(handle);
            const params = {
              head: bundle.head,
              requestId: "upgraded-run",
              text: "continue after upgrade",
            };
            await handle.replica({ method: "run", params, trace });
            await waitFor(
              async () =>
                (
                  (await command({
                    method: "status",
                    params: { requestId: params.requestId },
                    trace,
                  })) as { submission?: { status: string } }
                ).submission?.status === "done",
              "the upgraded same-ID run",
            );
            await handle.replica({ method: "run", params, trace });
            assert.equal(bench.faux.state.callCount, 1);
            assert.ok(requests[0]);
            assert.deepEqual(
              requests[0].messages.filter((message) => message.role !== "system").slice(0, -1),
              expected.filter((message) => message.role !== "system"),
            );
            assert.deepEqual(
              await handle.replica({ method: "export", params: { head: bundle.head }, trace }),
              bundle,
            );
            await handle.close(trace, 5000);
            handle = undefined;
            const verify = await Harness.open(
              await openNodeSqliteStorage(join(bench.spec().dir, "session.sqlite")),
              {
                models: createModels(),
                registry: createToolRegistry(
                  await openWorkspace(join(bench.spec().dir, "workspace")),
                ),
              },
              ctx,
            );
            try {
              assert.deepEqual(
                (await verify.snapshot(legacyImports, bundle.head, ctx))?.entries,
                legacy.saved.entries,
                "original P0 entry mappings are retained",
              );
            } finally {
              await verify.close(ctx);
            }
          } finally {
            await handle?.close(trace, 5000);
            await bench.cleanup();
          }
        },
      );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a complete P0 branch imports and runs/exports alone while bad or unknown receipts reject", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bots-p0-standalone-"));
  try {
    const bundle = (await sourceCarriers(join(dir, "source")))[1];
    assert.ok(bundle);
    const b = await openReplica(join(dir, "b"));
    try {
      await b.command("import", { bundle });
      assert.equal(b.faux.state.callCount, 0);
      assert.equal(b.sync.store.head(bundle.parents[0] ?? ""), undefined);
      await t.test("export standalone complete carrier", async () =>
        assert.deepEqual(await b.command("export", { head: bundle.head }), bundle),
      );
      await t.test("run standalone complete carrier", async () => {
        b.faux.setResponses([text("standalone continuation")]);
        await b.command("run", {
          head: bundle.head,
          requestId: "standalone-run",
          text: "continue",
        });
        await b.harness.waitForIdle(ctx);
        assert.equal(b.faux.state.callCount, 1);
      });
    } finally {
      await b.close();
    }
    const bench = await createBench();
    let handle: Awaited<ReturnType<typeof bench.runtime.open>> | undefined;
    try {
      const old = await seedP0(bench, bundle, true);
      await old.harness.close(ctx);
      handle = await bench.runtime.open(bench.spec());
      const invalid = (error: unknown) =>
        error instanceof ClassifiedFailure && error.failure.kind === "invalid_command";
      for (const head of [bundle.head, "f".repeat(64)])
        await assert.rejects(
          handle.replica?.({
            method: "run",
            params: { head, requestId: "bad-old-run", text: "never admitted" },
            trace,
          }) ?? Promise.reject(new Error("missing replica method")),
          invalid,
        );
      assert.equal(bench.faux.state.callCount, 0);
    } finally {
      await handle?.close(trace, 5000);
      await bench.cleanup();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a complete fixed-head branch publishes and exports while a later source-root task is still busy", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bots-fixed-busy-"));
  const a = await openReplica(dir);
  let providerEntered = false;
  const release = Promise.withResolvers<void>();
  let busy: Awaited<ReturnType<typeof a.root.submit>> | undefined;
  try {
    a.faux.setResponses([text("fixed source output")]);
    await (
      await a.root.submit({ type: "input", requestId: "fixed-source", content: "fixed input" }, ctx)
    ).wait(ctx);
    const h0 = (await pull(a)).events.filter((event) => event.body.kind === "head").at(-1)?.body;
    assert.ok(h0?.kind === "head");
    const requests: TranscriptContext[] = [];
    a.faux.setResponses([
      async () => {
        providerEntered = true;
        await release.promise;
        return text("later root result must not leak");
      },
      (request) => {
        requests.push(request);
        return text("independent branch complete");
      },
    ]);
    busy = await a.root.submit(
      { type: "input", requestId: "later-root", content: "later root input must not leak" },
      ctx,
    );
    await waitFor(() => providerEntered, "the later root provider to enter its real barrier");
    await a.command("run", {
      head: h0.head,
      requestId: "independent-branch",
      text: "continue fixed head",
    });
    await waitFor(
      async () =>
        (
          (await a.history.command({
            method: "status",
            params: { requestId: "independent-branch" },
            trace,
          })) as { submission?: { status: string } }
        ).submission?.status === "done",
      "the independent branch to finish while source is busy",
    );
    assert.notEqual((await busy.status(ctx)).status, "done");
    assert.ok(requests[0]);
    assert.doesNotMatch(JSON.stringify(requests[0].messages), /later root/);
    await t.test("pull and status expose complete branch", async () => {
      const page = await pull(a);
      const branch = page.events
        .filter((event) => event.body.kind === "head" && event.body.meta.parents.includes(h0.head))
        .at(-1)?.body;
      assert.ok(
        branch?.kind === "head",
        "fixed completed branch must publish while root remains busy",
      );
      const status = (await a.command("status", {})) as {
        heads: { head: string; ready: boolean }[];
      };
      assert.ok(status.heads.some((head) => head.head === branch.head && head.ready));
      assert.doesNotMatch(
        JSON.stringify(branch.entries.map((entry) => a.sync.store.fact(entry.ref))),
        /later root/,
      );
    });
    await t.test("explicit branch export", async () => {
      const bundle = (await a.command("export", { branch: "independent-branch" })) as HistoryBundle;
      assert.deepEqual(bundle.parents, [h0.head]);
      assert.doesNotMatch(JSON.stringify(bundle), /later root/);
      assert.ok(JSON.stringify(bundle).includes("independent branch complete"));
    });
    assert.notEqual((await busy.status(ctx)).status, "done");
  } finally {
    release.resolve();
    await busy?.wait(ctx);
    await a.close();
    await rm(dir, { recursive: true, force: true });
  }
});
