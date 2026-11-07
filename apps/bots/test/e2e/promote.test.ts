// A person can pull one of their own queued inputs ahead of the follow-ups already
// waiting (PROTOCOL.md, `promote`). The submission keeps its id; only its place and
// mode change, so nothing is duplicated and a reconnect still finds it.
import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "../../src/core/domain.ts";
import { text } from "../support/pi.ts";
import { frameQueue, hello, send, startStack } from "../support/server.ts";

const tr = (name: string) => `tr_${name}_0123456`;

test("promote moves a queued input ahead of the follow-ups and keeps its id", async () => {
  const stack = await startStack({ real: true, tokensPerSecond: 5 });
  try {
    stack.faux?.setResponses([text(`长回答。${"继续。".repeat(80)}`), text("同时回答")]);
    const botId = await stack.createBot("插队");
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: tr("p1") });
    await frames.next();

    await send(socket, {
      type: "send",
      requestId: "r_promote_1",
      text: "第一条",
      whenBusy: "followUp",
      trace: tr("p2"),
    });
    for (const [requestId, text_] of [
      ["r_promote_2", "第二条"],
      ["r_promote_3", "第三条"],
    ]) {
      await send(socket, {
        type: "send",
        requestId,
        text: text_,
        whenBusy: "followUp",
        trace: tr("p3"),
      });
    }

    const ids = new Map<string, string>();
    for (;;) {
      const frame = await frames.next(10_000);
      if (frame.type !== "submission") continue;
      const requestId = frame.requestId as string;
      if (requestId === "r_promote_2" || requestId === "r_promote_3") {
        ids.set(requestId, frame.submissionId as string);
      }
      if (ids.size === 2) break;
    }

    const promoted = ids.get("r_promote_3") as string;
    await send(socket, {
      type: "promote",
      requestId: "r_promote_3",
      trace: tr("p4"),
    });

    let sawSteer = false;
    for (;;) {
      const frame = await frames.next(10_000);
      if (frame.type !== "status") continue;
      const inbox = frame.inbox as { id: string; mode: string }[];
      if (inbox.some((item) => item.id === promoted && item.mode === "steer")) {
        sawSteer = true;
        break;
      }
    }
    assert.equal(sawSteer, true, "the queued input is now a steer");

    for (;;) {
      const frame = await frames.next(30_000);
      if (frame.type !== "submission") continue;
      if (frame.requestId === "r_promote_3" && frame.status === "done") break;
    }

    await send(socket, { type: "resync", trace: tr("p5") });
    for (;;) {
      const frame = await frames.next(10_000);
      if (frame.type !== "snapshot") continue;
      const messages = (frame.value as { messages: Message[] }).messages;
      const texts = messages
        .filter((message) => message.role === "user")
        .map((message) => (message.blocks[0]?.type === "text" ? message.blocks[0].text : ""));
      const third = texts.indexOf("第三条");
      const second = texts.indexOf("第二条");
      assert.ok(third >= 0 && second >= 0, "both queued inputs were placed");
      assert.ok(third < second, "the promoted input is placed before the older follow-up");
      break;
    }
    socket.close();
  } finally {
    await stack.close();
  }
});
