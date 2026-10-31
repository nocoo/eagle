import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { MAX_REPLICA_BODY_BYTES } from "../../src/core/RuntimePort.ts";
import { pageSchema } from "../../src/runtime/pi/syncProtocol.ts";
import { assistant, text, toolCall, trace, waitFor } from "../support/pi.ts";
import { openReplica } from "../support/replica.ts";
import { startStack } from "../support/server.ts";

test("a committed real tool run is available as bounded incremental source facts", async () => {
  const a = await startStack({ real: true });
  try {
    const bot = await a.createBot("incremental source");
    const handle = await a.registry.open(bot, trace);
    a.faux?.setResponses([
      assistant([toolCall("write", { path: "original.txt", content: "P1 原始工具字节" })], {
        stopReason: "toolUse",
      }),
      text("source committed"),
    ]);
    await handle.submit({
      requestId: "r_sync_source",
      text: "write once",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      async () => (await handle.submission({ requestId: "r_sync_source" }))?.status === "done",
      "the real source tool result",
    );
    assert.equal(
      await readFile(join(a.directory.botDir(bot), "workspace/original.txt"), "utf8"),
      "P1 原始工具字节",
    );
    const response = await fetch(`http://127.0.0.1:${a.port}/v1/bots/${bot}/replica/pull`, {
      method: "POST",
      headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" },
      body: JSON.stringify({ after: 0, limit: 128 }),
    });
    assert.equal(
      response.status,
      200,
      "committed history must be pulled from the persistent source log",
    );
    const page = pageSchema.parse(await response.json());
    assert.ok(Array.isArray(page.events));
    assert.ok(page.events.some((event: { body: { kind: string } }) => event.body.kind === "entry"));
    assert.ok(JSON.stringify(page).includes("P1 原始工具字节"));
  } finally {
    await a.close();
  }
});

test("authenticated byte-bounded incremental pages materialize and continue a history larger than the P0 carrier", async () => {
  const a = await startStack({ real: true });
  const b = await startStack({
    real: true,
    root: await mkdtemp(join(tmpdir(), "bots-large-target-")),
  });
  const post = (stack: typeof a, bot: string, method: string, body: unknown) =>
    fetch(`http://127.0.0.1:${stack.port}/v1/bots/${bot}/replica/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${stack.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  let originalBytes = 0;
  try {
    const source = await a.createBot("large source");
    const target = await b.createBot("large target");
    const seed = await openReplica(a.directory.botDir(source), source);
    const opaque = "原".repeat(1_000_000);
    await seed.root.commit(async (tx) => {
      for (let index = 0; index < 3; index += 1)
        await tx.appendEntry(seed.root.id, { kind: "fixture.original", data: { index, opaque } });
      await tx.appendEntry(seed.root.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "small complete context", timestamp: 0 }],
      });
    }, ctx);
    const original = (await seed.root.entries({ order: "ascending" }, 128, undefined, ctx)).items;
    originalBytes = Buffer.byteLength(JSON.stringify(original));
    assert.ok(originalBytes > MAX_REPLICA_BODY_BYTES, "actual raw SDK records exceed 8 MiB");
    const expected = await seed.root.context(ctx);
    await seed.close();
    const status = await post(a, source, "status", {});
    assert.equal(
      status.status,
      200,
      "cumulative raw history size cannot block bounded incremental pull",
    );
    const binding = (await status.json()) as { sharedBotId: string };
    assert.equal((await post(b, target, "bind", { sharedBotId: binding.sharedBotId })).status, 200);
    const requests: TranscriptContext[] = [];
    b.faux?.setResponses([
      (request) => {
        requests.push(request);
        return text("large history continued");
      },
    ]);
    let after = 0;
    let pageCount = 0;
    let head = "";
    let hasMore = true;
    do {
      const response = await post(a, source, "pull", { after, limit: 128 });
      assert.equal(response.status, 200);
      const page = pageSchema.parse(await response.json());
      const bytes = Buffer.byteLength(JSON.stringify({ page }));
      assert.ok(bytes <= MAX_REPLICA_BODY_BYTES, `encoded apply body ${bytes}`);
      assert.ok(page.nextAfter > after);
      assert.equal((await post(b, target, "apply", { page })).status, 200);
      assert.equal(
        (await post(b, target, "apply", { page })).status,
        200,
        "re-pulling a page never duplicates application",
      );
      pageCount += 1;
      after = page.nextAfter;
      for (const event of page.events) if (event.body.kind === "head") head = event.body.head;
      hasMore = page.hasMore;
    } while (hasMore);
    assert.ok(pageCount >= 2 && head.length === 64);
    assert.equal(b.faux?.state.callCount, 0, "large history imports remain passive");
    assert.equal(
      (await post(a, source, "export", {})).status,
      400,
      "P0 public carrier cap remains intact",
    );
    assert.equal(
      (await post(b, target, "run", { head, requestId: "large-run-B", text: "continue locally" }))
        .status,
      200,
    );
    await waitFor(() => requests.length === 1, "large-history local provider admission");
    const request = requests[0];
    assert.ok(request);
    assert.ok(JSON.stringify(request.messages).includes("small complete context"));
    await waitFor(async () => {
      const status = await post(b, target, "status", { requestId: "large-run-B" });
      const result = (await status.json()) as { submission?: { status: string } };
      return result.submission?.status === "done";
    }, "large-history run settlement");
    const next = pageSchema.parse(
      await (await post(a, source, "pull", { after, limit: 128 })).json(),
    );
    assert.equal(next.events.length, 0);
    await Promise.all([a.close(), b.close()]);
    const reopened = await openReplica(b.directory.botDir(target), target);
    try {
      const receipt = await reopened.history.receipt(head);
      assert.ok(receipt);
      const imported = await reopened.harness.conversation(
        receipt.conversationId as import("@earendil-works/pi-durable").ConversationId,
        ctx,
      );
      assert.ok(imported);
      const actual = (await imported.entries({ order: "ascending" }, 128, undefined, ctx)).items;
      assert.deepEqual(
        actual.map(({ id: _id, conversationId: _conversation, ...entry }) => entry),
        original.map(({ id: _id, conversationId: _conversation, ...entry }) => entry),
      );
      assert.deepEqual((await imported.context(ctx)).messages, expected.messages);
      assert.equal(reopened.faux.state.callCount, 0);
    } finally {
      await reopened.close();
    }
  } finally {
    await Promise.allSettled([a.close(), b.close()]);
    await rm(b.root, { recursive: true, force: true });
  }
});
