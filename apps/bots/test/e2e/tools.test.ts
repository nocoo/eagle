// The acceptance test for tool rows: a run whose model calls a workspace tool must show
// the call and its result live on the socket, and a late subscriber must see the same
// rows in its snapshot (docs/bots/PROTOCOL.md, "Tool rows"; RUNTIME.md, "Tools").
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { Message } from "../../src/core/domain.ts";
import { assistant, text, toolCall } from "../support/pi.ts";
import { closeCode, frameQueue, hello, send, startStack } from "../support/server.ts";

const tr = (name: string) => `tr_${name}_0123456`;

test("a failed refresh closes with the client's retry code and reconnect gets a baseline", async () => {
  const stack = await startStack({ real: true });
  try {
    const botId = await stack.createBot("retry refresh");
    const handle = await stack.registry.open(botId, tr("warm_retry"));
    const refresh = handle.refreshTools.bind(handle);
    let first = true;
    handle.refreshTools = async (trace) => {
      if (first) {
        first = false;
        throw new Error("temporary refresh failure");
      }
      await refresh(trace);
    };
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    const closed = closeCode(socket);
    await send(socket, { type: "subscribe", botId, trace: tr("refresh_fail") });
    assert.equal((await frames.next()).type, "error");
    assert.equal(await closed, 1011);
    const retry = stack.connect();
    const retried = frameQueue(retry);
    await send(retry, hello);
    await retried.next();
    await send(retry, { type: "subscribe", botId, trace: tr("refresh_retry") });
    assert.equal((await retried.next()).type, "snapshot");
    assert.equal(stack.faux?.state.callCount, 0);
    retry.close();
  } finally {
    await stack.close();
  }
});

test("real socket bot switches refresh cached tools without extra runtimes or model calls", async () => {
  const stack = await startStack({ real: true });
  try {
    const first = await stack.createBot("first");
    const second = await stack.createBot("second");
    await stack.registry.open(first, tr("warm_first"));
    await stack.registry.open(second, tr("warm_second"));
    const opens = stack.opens();
    for (const [index, botId] of [first, second, first].entries()) {
      const socket = stack.connect();
      const frames = frameQueue(socket);
      await send(socket, hello);
      assert.equal((await frames.next()).type, "welcome");
      await send(socket, { type: "subscribe", botId, trace: tr(`switch_${index}`) });
      const frame = await frames.next();
      assert.equal(frame.type, "snapshot");
      assert.equal((frame.value as { botId: string }).botId, botId);
      socket.close();
    }
    const refreshes = stack.records.filter((record) => record.evt === "runtime.tools.refresh.ok");
    assert.deepEqual(
      refreshes.map((record) => record.botId),
      [first, second, first],
    );
    assert.deepEqual(
      refreshes.map((record) => record.trace),
      [tr("switch_0"), tr("switch_1"), tr("switch_2")],
    );
    assert.equal(stack.opens(), opens);
    assert.equal(
      stack.records.filter((record) => record.evt === "runtime.subscribe.start").length,
      2,
    );
    assert.equal(stack.faux?.state.callCount, 0);
  } finally {
    await stack.close();
  }
});

test("a tool round is live in the transcript and in a later snapshot", async () => {
  const stack = await startStack({ real: true });
  try {
    const faux = stack.faux;
    assert.ok(faux !== undefined, "a real stack scripts the model network");
    faux.setResponses([
      assistant([toolCall("list", { path: "." })], { stopReason: "toolUse" }),
      text("工作区里没有别的文件。"),
    ]);
    const botId = await stack.createBot("工具行");
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: tr("sub1") });
    await frames.next();
    await send(socket, {
      type: "send",
      requestId: "r_tools_0001",
      text: "列出文件",
      whenBusy: "followUp",
      trace: tr("send1"),
    });

    const appends: Message[] = [];
    for (;;) {
      const frame = await frames.next(20_000);
      if (frame.type === "append") appends.push(frame.message as Message);
      if (frame.type === "submission" && frame.requestId === "r_tools_0001") {
        if (frame.status === "done" || frame.status === "unanswered") break;
      }
    }

    const call = appends.find((message) =>
      message.blocks.some((block) => block.type === "toolCall"),
    );
    assert.equal(call?.role, "assistant", "the call rides in the assistant entry");
    const callBlock = call?.blocks.find((block) => block.type === "toolCall");
    assert.equal(callBlock?.type === "toolCall" ? callBlock.name : "", "list");

    const result = appends.find((message) => message.role === "tool");
    assert.ok(result !== undefined, "the tool result is appended as its own row");
    const resultBlock = result.blocks[0];
    assert.equal(resultBlock?.type, "toolResult");
    assert.equal(resultBlock?.type === "toolResult" ? resultBlock.name : "", "list");
    assert.equal(resultBlock?.type === "toolResult" ? resultBlock.isError : true, false);
    assert.match(resultBlock?.type === "toolResult" ? resultBlock.text : "", /\(empty directory\)/);

    // A late join after the run: the snapshot carries the same rows, in order.
    const again = stack.connect();
    const renewed = frameQueue(again);
    await send(again, hello);
    await renewed.next();
    await send(again, { type: "subscribe", botId, trace: tr("sub2") });
    const snapshot = await renewed.next();
    const messages = (snapshot.value as { messages: Message[] }).messages;
    assert.deepEqual(
      messages.map((message) => message.role),
      ["user", "assistant", "tool", "assistant"],
    );
    assert.deepEqual(
      messages.find((message) => message.role === "tool")?.blocks,
      result.blocks,
      "the snapshot's tool row is byte-identical to the live one",
    );
    again.close();
    socket.close();
  } finally {
    await stack.close();
  }
});

test("a memory write is a live tool row, a snapshot row, and a person's file", async () => {
  const stack = await startStack({ real: true, memory: true });
  try {
    const faux = stack.faux;
    assert.ok(faux !== undefined, "a real stack scripts the model network");
    faux.setResponses([
      assistant(
        [toolCall("memory_write", { scope: "bot", key: "deploy", content: "先连 VPN。" })],
        {
          stopReason: "toolUse",
        },
      ),
      text("记下了。"),
    ]);
    const botId = await stack.createBot("记忆");
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: tr("mem1") });
    await frames.next();
    await send(socket, {
      type: "send",
      requestId: "r_memory_0001",
      text: "记住发版要先连 VPN",
      whenBusy: "followUp",
      trace: tr("memsend"),
    });

    const appends: Message[] = [];
    for (;;) {
      const frame = await frames.next(20_000);
      if (frame.type === "append") appends.push(frame.message as Message);
      if (frame.type === "submission" && frame.requestId === "r_memory_0001") {
        if (frame.status === "done" || frame.status === "unanswered") break;
      }
    }
    const call = appends
      .flatMap((message) => message.blocks)
      .find((block) => block.type === "toolCall");
    assert.equal(call?.type === "toolCall" ? call.name : "", "memory_write");
    const row = appends
      .filter((message) => message.role === "tool")
      .flatMap((message) => message.blocks)
      .find((block) => block.type === "toolResult");
    assert.equal(row?.type === "toolResult" ? row.name : "", "memory_write");
    assert.equal(row?.type === "toolResult" ? row.isError : true, false);
    assert.match(row?.type === "toolResult" ? row.text : "", /"created":true/);

    // The write is a file a person can read and edit, not a conversation record.
    const file = await readFile(join(stack.root, "memory", `${botId}.md`), "utf8");
    assert.match(file, /^## deploy\n先连 VPN。$/m);

    const again = stack.connect();
    const renewed = frameQueue(again);
    await send(again, hello);
    await renewed.next();
    await send(again, { type: "subscribe", botId, trace: tr("mem2") });
    const snapshot = await renewed.next();
    const rows = (snapshot.value as { messages: Message[] }).messages
      .filter((message) => message.role === "tool")
      .flatMap((message) => message.blocks);
    assert.deepEqual(rows, [row], "the snapshot's row is the live one");
    again.close();
    socket.close();
  } finally {
    await stack.close();
  }
});

test("a hostile tool output is clamped by its encoded size and the socket stays open", async () => {
  const stack = await startStack({ real: true });
  try {
    const faux = stack.faux;
    assert.ok(faux !== undefined);
    faux.setResponses([
      assistant(
        [toolCall("bash", { command: "head -c 65536 /dev/zero | LC_ALL=C tr '\\0' '\"'" })],
        { stopReason: "toolUse" },
      ),
      text("输出已经被裁剪。"),
    ]);
    const botId = await stack.createBot("大输出");
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: tr("sub1") });
    await frames.next();
    await send(socket, {
      type: "send",
      requestId: "r_tools_0002",
      text: "输出很多引号",
      whenBusy: "followUp",
      trace: tr("send2"),
    });

    let toolText: string | undefined;
    let answered = false;
    for (;;) {
      const frame = await frames.next(20_000);
      if (frame.type === "append") {
        const message = frame.message as Message;
        if (message.role === "tool") {
          const block = message.blocks[0];
          if (block?.type === "toolResult") toolText = block.text;
        }
        if (message.role === "assistant" && message.blocks.some((block) => block.type === "text")) {
          answered = true;
        }
      }
      if (frame.type === "submission" && frame.requestId === "r_tools_0002") {
        if (frame.status === "done" || frame.status === "unanswered") break;
      }
    }
    assert.equal(answered, true, "the answer still arrives; the socket was not closed");
    assert.ok(toolText?.endsWith("[tool output truncated]"), "the tool row is clamped");
    assert.ok(Buffer.byteLength(toolText ?? "", "utf8") < 64 * 1024);
    socket.close();
  } finally {
    await stack.close();
  }
});
