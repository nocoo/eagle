import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HistoryBundle } from "../../src/runtime/pi/HistoryReplica.ts";
import { assistant, text, toolCall, trace, waitFor } from "../support/pi.ts";
import { frameQueue, hello, type Stack, send, startStack } from "../support/server.ts";

const post = (stack: Stack, botId: string, method: string, body: unknown) =>
  fetch(`http://127.0.0.1:${stack.port}/v1/bots/${botId}/replica/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${stack.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("the actual bearer head/context API and original socket send/watch keep context identity through daemon restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-context-http-"));
  let stack = await startStack({ real: true, root: dir });
  const sockets: ReturnType<Stack["connect"]>[] = [];
  try {
    const bot = await stack.createBot("context native chain");
    const root = await stack.registry.open(bot, trace);
    stack.faux?.setResponses([text("common root answer")]);
    await root.submit({
      requestId: "http_context_seed",
      text: "common ancestor",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      async () => (await root.submission({ requestId: "http_context_seed" }))?.status === "done",
      "original root seed",
    );
    const seed = (await (await post(stack, bot, "export", {})).json()) as HistoryBundle;
    const heads = await post(stack, bot, "heads", { after: 0, limit: 128 });
    assert.equal(heads.status, 200);
    assert.equal(JSON.stringify(await heads.json()).includes("common ancestor"), false);
    for (const contextId of ["http_context_left", "http_context_right"]) {
      const created = await post(stack, bot, "context", { contextId, head: seed.head });
      assert.equal(
        created.status,
        200,
        "context creation uses the same ready runtime and local bearer boundary",
      );
      assert.equal(((await created.json()) as { contextId: string }).contextId, contextId);
      const socket = stack.connect();
      sockets.push(socket);
      const frames = frameQueue(socket);
      await send(socket, hello);
      await frames.next();
      await send(socket, { type: "subscribe", botId: bot, contextId, trace });
      assert.equal((await frames.next()).type, "snapshot");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered = false;
      stack.faux?.setResponses([
        async () => {
          entered = true;
          await gate;
          return text(`answer for ${contextId}`);
        },
      ]);
      await send(socket, {
        type: "send",
        requestId: `r_${contextId}`,
        contextId,
        text: `input for ${contextId}`,
        whenBusy: "followUp",
        trace,
      });
      await waitFor(() => entered, "selected context enters the provider");
      const running: boolean[] = [];
      const observer = stack.service.observe(bot, (value) => running.push(value));
      try {
        assert.equal(
          running.at(-1),
          true,
          "whole-bot observers include a running selected context",
        );
      } finally {
        observer.detach();
        release();
      }
      let done = false;
      while (!done) {
        const frame = await frames.next();
        assert.doesNotMatch(
          JSON.stringify(frame),
          contextId.endsWith("right")
            ? /input for http_context_left/
            : /input for http_context_right/,
        );
        done =
          frame.type === "submission" &&
          frame.requestId === `r_${contextId}` &&
          frame.status === "done";
      }
    }
    assert.equal(stack.opens(), 1, "contexts share the registry-owned Harness");
    const left = (await (
      await post(stack, bot, "export", { contextId: "http_context_left" })
    ).json()) as HistoryBundle;
    const right = (await (
      await post(stack, bot, "export", { contextId: "http_context_right" })
    ).json()) as HistoryBundle;
    assert.ok(JSON.stringify(left).includes("input for http_context_left"));
    assert.equal(JSON.stringify(left).includes("input for http_context_right"), false);
    assert.deepEqual(left.parents, [seed.head]);
    const calls = stack.faux?.state.callCount;
    const merge = await post(stack, bot, "merge", {
      heads: [left.head, right.head],
      requestId: "http_merge_001",
    });
    assert.equal(merge.status, 200);
    assert.equal(stack.faux?.state.callCount, calls, "merge admits no provider work");
    const merged = (await merge.json()) as { head: string };
    assert.equal(
      (await post(stack, bot, "context", { contextId: "http_merged_context", head: merged.head }))
        .status,
      200,
    );
    const mergedSocket = stack.connect();
    sockets.push(mergedSocket);
    const mergedFrames = frameQueue(mergedSocket);
    await send(mergedSocket, hello);
    await mergedFrames.next();
    await send(mergedSocket, {
      type: "subscribe",
      botId: bot,
      contextId: "http_merged_context",
      trace,
    });
    const mergedSnapshot = await mergedFrames.next();
    assert.equal(mergedSnapshot.type, "snapshot");
    assert.match(JSON.stringify(mergedSnapshot), /input for http_context_left/);
    assert.match(JSON.stringify(mergedSnapshot), /answer for http_context_left/);
    assert.match(JSON.stringify(mergedSnapshot), /input for http_context_right/);
    assert.match(JSON.stringify(mergedSnapshot), /answer for http_context_right/);
    for (const socket of sockets) socket.terminate();
    await stack.close();
    stack = await startStack({ real: true, root: dir });
    const original = await stack.service.submission({
      botId: bot,
      requestId: "r_http_context_left",
      contextId: "http_context_left",
    });
    assert.equal(original?.status, "done");
    const duplicate = await stack.service.invoke({
      botId: bot,
      requestId: "r_http_context_left",
      contextId: "http_context_left",
      text: "input for http_context_left",
      origin: { kind: "human" },
      trace,
    });
    assert.equal(duplicate.id, original?.id);
    assert.equal(stack.faux?.state.callCount, 0);
    await assert.rejects(
      stack.service.invoke({
        botId: bot,
        requestId: "r_http_context_left",
        contextId: "http_context_right",
        text: "input for http_context_left",
        origin: { kind: "human" },
        trace,
      }),
      /binding conflict/,
    );
  } finally {
    for (const socket of sockets) socket.terminate();
    await stack.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("two independent runtimes transfer original tool history without executing it on import", async () => {
  const a = await startStack({ real: true });
  const b = await startStack({ real: true });
  try {
    const sourceId = await a.createBot("source");
    const targetId = await b.createBot("replica");
    const source = await a.registry.open(sourceId, trace);
    a.faux?.setResponses([
      assistant([toolCall("write", { path: "original.txt", content: "原始工具结果" })], {
        stopReason: "toolUse",
      }),
      text("saved"),
    ]);
    await source.submit({ requestId: "r_source", text: "write once", whenBusy: "followUp", trace });
    await waitFor(
      async () => (await source.submission({ requestId: "r_source" }))?.status === "done",
      "source output commit",
    );
    const exported = await post(a, sourceId, "export", {});
    assert.equal(
      exported.status,
      200,
      "the daemon exports durable history rather than a UI projection",
    );
    assert.equal(
      await readFile(join(a.directory.botDir(sourceId), "workspace/original.txt"), "utf8"),
      "原始工具结果",
    );
    const bundle = (await exported.json()) as HistoryBundle;
    assert.ok(bundle.entries.some((entry) => entry.kind === "pi.tool-result"));
    const imported = await post(b, targetId, "import", { bundle });
    assert.equal(imported.status, 200);
    const receipt = (await imported.json()) as { head: string };
    const importedAgain = await post(b, targetId, "import", { bundle });
    assert.deepEqual(
      await importedAgain.json(),
      receipt,
      "passive admission is durable and idempotent",
    );
    await assert.rejects(readFile(join(b.directory.botDir(targetId), "workspace/original.txt")), {
      code: "ENOENT",
    });
    assert.equal(b.faux?.state.callCount, 0, "import invokes no model");
    const reexported = await post(b, targetId, "export", { head: receipt.head });
    assert.equal(reexported.status, 200);
    assert.deepEqual(
      await reexported.json(),
      bundle,
      "original entries and source ids survive unchanged",
    );
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});

test("history handoff keeps authentication, bot leases, method and dedicated body boundaries", async () => {
  const stack = await startStack({ real: true });
  const fake = await startStack();
  try {
    const bot = await stack.createBot("boundaries");
    const url = `http://127.0.0.1:${stack.port}/v1/bots/${bot}/replica/export`;
    assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 401);
    assert.equal(
      (await fetch(url, { headers: { authorization: `Bearer ${stack.token}` } })).status,
      404,
    );
    assert.equal((await post(stack, "b_absent", "export", {})).status, 404);
    assert.equal((await post(stack, bot, "import", { bundle: {} })).status, 400);
    assert.equal((await post(stack, bot, "import", {})).status, 400);
    assert.equal(
      (await post(stack, bot, "export", { oversized: "x".repeat(8 * 1024 * 1024) })).status,
      400,
    );
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${stack.token}` },
          body: "{",
        })
      ).status,
      400,
    );
    const fakeBot = await fake.createBot("unsupported");
    assert.equal((await post(fake, fakeBot, "export", {})).status, 400);
    const failed = stack.records.filter((record) => record.evt === "runtime.replica.fail");
    assert.equal(failed.length, 2);
    assert.equal(
      stack.records.filter(
        (record) => record.level === "error" && record.evt === "core.replica.fail",
      ).length,
      1,
      "unknown bot is a core origin; runtime errors only propagate",
    );
  } finally {
    await Promise.all([stack.close(), fake.close()]);
  }
});
