// Ladder rows 38-40: the handshake, refusal close codes and the one-subscription rule.
import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { WebSocket } from "ws";
import { ClientStore } from "../../src/server/clients.ts";
import { closeCode, frameQueue, hello, nextFrame, send, startStack } from "../support/server.ts";

const tr = (name: string) => `tr_${name}_0123456`;

test("closes 1008 when hello is not the first frame", async () => {
  const stack = await startStack();
  try {
    const socket = stack.connect();
    await send(socket, { type: "subscribe", botId: "b_x", trace: tr("first") });
    assert.equal(await closeCode(socket), 1008);
  } finally {
    await stack.close();
  }
});

test("a version the daemon does not speak answers then closes 4009", async () => {
  const stack = await startStack();
  try {
    const socket = stack.connect();
    await send(socket, { type: "hello", protocolVersion: 99, client: "BotsTest/0" });
    const frame = await nextFrame(socket);
    assert.equal(frame.type, "error");
    assert.equal(frame.kind, "version_mismatch");
    assert.equal((frame.server as { protocolVersion: number }).protocolVersion, 1);
    assert.equal(await closeCode(socket), 4009);
  } finally {
    await stack.close();
  }
});

test("closes 4004 for an unknown bot and 4090 while quarantined", async () => {
  const stack = await startStack();
  try {
    const unknown = stack.connect();
    await send(unknown, hello);
    await nextFrame(unknown);
    await send(unknown, { type: "subscribe", botId: "b_does_not_exist", trace: tr("unknown") });
    assert.equal(await closeCode(unknown), 4004);

    const botId = await stack.createBot("隔离");
    stack.quarantine(botId);
    const quarantined = stack.connect();
    await send(quarantined, hello);
    await nextFrame(quarantined);
    await send(quarantined, { type: "subscribe", botId, trace: tr("quarantine") });
    assert.equal(await closeCode(quarantined), 4090);
  } finally {
    await stack.close();
  }
});

test("a second subscribe on one connection closes 1008", async () => {
  const stack = await startStack();
  try {
    const botId = await stack.createBot("重复订阅");
    const socket = stack.connect();
    await send(socket, hello);
    await nextFrame(socket);
    await send(socket, { type: "subscribe", botId, trace: tr("once") });
    const snapshot = await nextFrame(socket);
    assert.equal(snapshot.type, "snapshot");
    await send(socket, { type: "subscribe", botId, trace: tr("twice") });
    assert.equal(await closeCode(socket), 1008);
  } finally {
    await stack.close();
  }
});

test("an unknown command is refused and the connection kept", async () => {
  const stack = await startStack();
  try {
    const socket = stack.connect();
    await send(socket, hello);
    await nextFrame(socket);
    await send(socket, { type: "nonsense", trace: tr("unknown") });
    const frame = await nextFrame(socket);
    assert.equal(frame.type, "error");
    assert.equal(frame.kind, "invalid_command");
    assert.equal(frame.disposition, "not_admitted");
    await send(socket, { type: "ping" });
    assert.equal((await nextFrame(socket)).type, "pong", "the connection still works");
    socket.close();
  } finally {
    await stack.close();
  }
});

test("malformed JSON closes 1008 with a protocol record only", async () => {
  const stack = await startStack();
  try {
    const before = stack.records.length;
    const socket = stack.connect();
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
    socket.send("{not json");
    assert.equal(await closeCode(socket), 1008);
    const records = stack.records.slice(before);
    assert.deepEqual(
      records.filter((record) => record.layer === "core" || record.layer === "runtime"),
      [],
      "no core or runtime record for a malformed frame",
    );
    assert.ok(
      records.some(
        (record) => record.evt === "protocol.decode.fail" && record.err?.origin === true,
      ),
      "the protocol layer owns the record",
    );
  } finally {
    await stack.close();
  }
});

test("a delta, a status and a runtime error each reach the wire", async () => {
  const stack = await startStack({
    script: {
      onSubmit: (input) => [
        {
          type: "delta",
          trace: input.trace,
          messageId: "p_a1",
          changes: [{ kind: "text", index: 0, append: "半" }],
        },
        { type: "status", trace: input.trace, running: true, streaming: "p_a1", inbox: [] },
        {
          type: "error",
          trace: input.trace,
          failure: { id: "f_wire_1", kind: "task_parked", layer: "runtime" },
          message: "a task was parked",
        },
        { type: "status", trace: input.trace, running: false, streaming: null, inbox: [] },
      ],
    },
  });
  try {
    const botId = await stack.createBot("帧");
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: tr("frames") });
    await frames.next();
    await send(socket, {
      type: "send",
      requestId: "r_frames_01",
      text: "问题",
      whenBusy: "followUp",
      trace: tr("frames2"),
    });
    const seen = new Map<string, Record<string, unknown>>();
    for (let index = 0; index < 6; index += 1) {
      const frame = await frames.next();
      seen.set(String(frame.type), frame);
      if (frame.type === "error") break;
    }
    assert.ok(seen.has("delta"), "a delta reaches the wire");
    const changes = (seen.get("delta")?.changes ?? []) as { append: string }[];
    assert.equal(changes[0]?.append, "半");
    assert.ok(seen.has("status"), "a status reaches the wire");
    assert.equal(seen.get("error")?.kind, "task_parked");
    assert.equal(seen.get("error")?.failure, "f_wire_1");
    assert.equal(seen.get("error")?.disposition, "runtime");
    socket.close();
  } finally {
    await stack.close();
  }
});

test("the seventeenth connection is refused with 503", async () => {
  const stack = await startStack();
  try {
    const sockets = [];
    for (let index = 0; index < 16; index += 1) {
      const socket = stack.connect();
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
      });
      sockets.push(socket);
    }
    const refused = stack.connect();
    const status = await new Promise<number>((resolve) => {
      refused.once("unexpected-response", (_request, response) =>
        resolve(response.statusCode ?? 0),
      );
      refused.once("error", () => resolve(-1));
    });
    assert.equal(status, 503, "the connection cap sits in front of the upgrade");
    for (const socket of sockets) socket.close();
  } finally {
    await stack.close();
  }
});

test("a command before the subscription is refused with a keep-alive error", async () => {
  const stack = await startStack();
  try {
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, {
      type: "send",
      requestId: "r_early_001",
      text: "还没有订阅",
      whenBusy: "followUp",
      trace: tr("early"),
    });
    const frame = await frames.next();
    assert.equal(frame.type, "error");
    assert.equal(frame.kind, "invalid_command");
    assert.equal(frame.disposition, "not_admitted");
    assert.equal(frame.requestId, "r_early_001", "the client can restore its draft");
    socket.close();
  } finally {
    await stack.close();
  }
});

test("the first frame is the only baseline and revisions never go back", async () => {
  const stack = await startStack({
    script: {
      onSubmit: (input) => [
        {
          type: "append",
          trace: input.trace,
          message: {
            id: "e_1",
            role: "user",
            state: "complete",
            createdAt: "2026-01-01T00:00:00.000Z",
            blocks: [{ type: "text", text: input.text }],
          },
        },
      ],
    },
  });
  try {
    const botId = await stack.createBot("基线");
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: tr("base") });
    const seen: Record<string, unknown>[] = [await frames.next()];
    await send(socket, {
      type: "send",
      requestId: "r_baseline_01",
      text: "问题",
      whenBusy: "followUp",
      trace: tr("base2"),
    });
    for (let index = 0; index < 40; index += 1) {
      const frame = await frames.next(200).catch(() => undefined);
      if (frame === undefined) break;
      seen.push(frame);
    }
    assert.equal(seen.filter((frame) => frame.type === "snapshot").length, 1, "one baseline only");
    const revs = seen
      .map((frame) => frame.rev)
      .filter((rev): rev is number => typeof rev === "number");
    assert.deepEqual(
      revs,
      [...revs].sort((a, b) => a - b),
      "a later frame never carries an older revision",
    );
    socket.close();
  } finally {
    await stack.close();
  }
});

test("closing the socket releases the bot so it can go idle", async () => {
  const stack = await startStack({ idleCloseMs: 30 });
  try {
    const botId = await stack.createBot("释放");
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: tr("release") });
    await frames.next();
    assert.notEqual(stack.registry.handleOf(botId), undefined);
    socket.close();
    for (let index = 0; index < 200 && stack.registry.handleOf(botId) !== undefined; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      stack.registry.handleOf(botId),
      undefined,
      "with no subscriber the idle close takes the handle",
    );
    const again = stack.connect();
    const renewed = frameQueue(again);
    await send(again, hello);
    await renewed.next();
    await send(again, { type: "subscribe", botId, trace: tr("reopen") });
    assert.equal((await renewed.next()).type, "snapshot", "a later subscribe reopens the bot");
    assert.notEqual(stack.registry.handleOf(botId), undefined, "and owns a live handle again");
    again.close();
  } finally {
    await stack.close();
  }
});

test("the wire limits refuse a bad requestId and an over-long text", async () => {
  const stack = await startStack();
  try {
    const botId = await stack.createBot("限额");
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: tr("limits") });
    await frames.next();
    await send(socket, {
      type: "send",
      requestId: "x",
      text: "hi",
      whenBusy: "followUp",
      trace: tr("l1"),
    });
    const short = await frames.next();
    assert.equal(short.type, "error");
    assert.equal(short.kind, "invalid_command");
    assert.equal(short.disposition, "not_admitted");
    await send(socket, {
      type: "send",
      requestId: "r_long_000001",
      text: "x".repeat(8_001),
      whenBusy: "followUp",
      trace: tr("l2"),
    });
    const long = await frames.next();
    assert.equal(long.type, "error");
    assert.equal(
      long.kind,
      "invalid_command",
      "PROTOCOL.md maps an over-long text to invalid_command",
    );
    assert.equal(long.requestId, "r_long_000001", "the client can clear that outbox entry");
    socket.close();
  } finally {
    await stack.close();
  }
});

test("a refused upgrade does not consume one of the sixteen slots", async () => {
  const stack = await startStack();
  try {
    const port = stack.port;
    const bad = async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        const socket = net.connect({ host: "127.0.0.1", port }, () => {
          socket.write(
            "GET /v1/socket HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
              `Authorization: Bearer ${stack.token}\r\n` +
              "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
              "Sec-WebSocket-Version: 13\r\n\r\n",
          );
        });
        socket.on("data", () => undefined);
        socket.on("close", () => resolve());
        socket.on("error", () => resolve());
      });
    };
    for (let index = 0; index < 16; index += 1) await bad();
    const socket = stack.connect();
    const opened = await new Promise<string>((resolve) => {
      socket.once("open", () => resolve("open"));
      socket.once("unexpected-response", (_request, response) =>
        resolve(`status ${String(response.statusCode)}`),
      );
      socket.once("error", (error: Error) => resolve(`error ${error.message}`));
    });
    assert.equal(opened, "open", "a failed upgrade frees its slot");
    const frames = frameQueue(socket);
    await send(socket, hello);
    assert.equal((await frames.next()).type, "welcome");
    socket.close();
  } finally {
    await stack.close();
  }
});

test("a ninth subscriber is refused with limit_exceeded and the connection kept", async () => {
  const stack = await startStack();
  try {
    const botId = await stack.createBot("上限");
    const sockets = [];
    for (let index = 0; index < 8; index += 1) {
      const socket = stack.connect();
      const frames = frameQueue(socket);
      await send(socket, hello);
      await frames.next();
      await send(socket, { type: "subscribe", botId, trace: tr(`sub${index}`) });
      assert.equal((await frames.next()).type, "snapshot");
      sockets.push({ socket, frames });
    }
    const ninth = stack.connect();
    const frames = frameQueue(ninth);
    await send(ninth, hello);
    await frames.next();
    await send(ninth, { type: "subscribe", botId, trace: tr("ninth") });
    const refused = await frames.next();
    assert.equal(refused.type, "error");
    assert.equal(refused.kind, "limit_exceeded");
    assert.equal(refused.disposition, "not_admitted");
    await send(ninth, { type: "ping" });
    assert.equal((await frames.next()).type, "pong", "the refusal keeps the connection");
    ninth.close();
    for (const held of sockets) held.socket.close();
  } finally {
    await stack.close();
  }
});

test("nothing reaches the client before welcome", async () => {
  const stack = await startStack();
  try {
    const socket = stack.connect();
    const seen: Record<string, unknown>[] = [];
    socket.on("message", (data: { toString(): string }) => {
      seen.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    await send(socket, { type: "nonsense", trace: tr("earlyframe") });
    assert.equal(await closeCode(socket), 1008, "hello must be the first frame");
    assert.deepEqual(seen, [], "no error frame overtakes the handshake");
  } finally {
    await stack.close();
  }
});

test("a second subscribe in flight closes 1008", async () => {
  const stack = await startStack();
  try {
    const botId = await stack.createBot("并发订阅");
    const socket = stack.connect();
    await send(socket, hello);
    await nextFrame(socket);
    await send(socket, { type: "subscribe", botId, trace: tr("burst1") });
    await send(socket, { type: "subscribe", botId, trace: tr("burst2") });
    assert.equal(await closeCode(socket), 1008);
  } finally {
    await stack.close();
  }
});

test("a refusal carries the same failure id in the frame and the log", async () => {
  const stack = await startStack();
  try {
    const botId = await stack.createBot("身份");
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: tr("identity") });
    await frames.next();
    const before = stack.records.length;
    await send(socket, {
      type: "send",
      requestId: "x",
      text: "hi",
      whenBusy: "followUp",
      trace: tr("identity2"),
    });
    const refused = await frames.next();
    assert.equal(refused.type, "error");
    const rejection = stack.records
      .slice(before)
      .find((record) => record.trace === tr("identity2") && record.err !== undefined);
    assert.ok(rejection, "the refusal is logged");
    assert.equal(
      refused.failure,
      rejection.err?.failure,
      "one identity for one refusal (PROTOCOL.md, Client commands)",
    );
    socket.close();
  } finally {
    await stack.close();
  }
});

test("shutting down closes 4010 so the client reconnects with backoff", async () => {
  const stack = await startStack();
  try {
    const botId = await stack.createBot("关停");
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: tr("shutdown") });
    await frames.next();
    const closing = closeCode(socket);
    await stack.daemon.close();
    assert.equal(await closing, 4010, "the close code names a shutdown, not a crash");
  } finally {
    await stack.close();
  }
});

test("shutdown waits for a WebSocket history command already in flight", {
  timeout: 8_000,
}, async (context) => {
  const stack = await startStack();
  let release = () => {};
  let markStarted = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  context.mock.method(stack.service, "history", async () => {
    markStarted();
    await gate;
    return { messages: [], hasMore: false };
  });
  try {
    const botId = await stack.createBot("History");
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: tr("history_subscribe") });
    await frames.next();
    await send(socket, { type: "history", before: "e_10", limit: 1, trace: tr("history_wait") });
    await Promise.race([
      started,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("history dispatch did not start")), 1_000);
        timer.unref();
      }),
    ]);
    const closedSocket = closeCode(socket);
    let completed = false;
    const shutdown = stack.daemon.close().then(() => {
      completed = true;
    });
    await closedSocket;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(completed, false);
    release();
    await shutdown;
  } finally {
    release();
    await stack.close();
  }
});

test("an upgrade waiting for authentication is refused after shutdown starts", async (context) => {
  let release = () => {};
  let markStarted = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  context.mock.method(ClientStore.prototype, "authenticate", async () => {
    markStarted();
    await gate;
    return {
      client: { id: "c_test", name: "test", scopes: ["read"], createdAt: "2026-01-01" },
      scopes: new Set(["read" as const]),
    };
  });
  const stack = await startStack();
  const socket = stack.connect({ token: "non-root-test-token" });
  const outcome = new Promise<string>((resolve) => {
    socket.once("open", () => resolve("open"));
    socket.once("unexpected-response", (_request, response) =>
      resolve(`http:${response.statusCode}`),
    );
    socket.once("error", () => resolve("error"));
  });
  try {
    await started;
    const closing = stack.daemon.close();
    release();
    assert.equal(await outcome, "http:503");
    await closing;
  } finally {
    release();
    socket.terminate();
    await stack.close();
  }
});

test("only the documented socket path upgrades", async () => {
  const stack = await startStack();
  try {
    for (const path of ["/", "/v2/socket", "/v1/socket/"]) {
      const refused = await new Promise<number>((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${stack.port}${path}`, {
          headers: { authorization: `Bearer ${stack.token}` },
        });
        socket.once("unexpected-response", (_request, response) =>
          resolve(response.statusCode ?? 0),
        );
        socket.once("error", () => resolve(-1));
        socket.once("open", () => resolve(0));
      });
      assert.equal(refused, 404, `${path} is not the socket endpoint`);
    }
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    assert.equal((await frames.next()).type, "welcome", "/v1/socket upgrades");
    socket.close();
  } finally {
    await stack.close();
  }
});

test("an invalid trace never reaches a log record", async () => {
  const stack = await startStack();
  try {
    const botId = await stack.createBot("轨迹");
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: tr("tracesafe") });
    await frames.next();
    const sentinel = "PROMPT SENTINEL do not log this";
    const before = stack.records.length;
    await send(socket, {
      type: "send",
      requestId: "r_trace_00001",
      text: "hi",
      whenBusy: "followUp",
      trace: sentinel,
    });
    const refused = await frames.next();
    assert.equal(refused.type, "error");
    assert.equal(refused.kind, "invalid_command");
    assert.equal(
      JSON.stringify(stack.records.slice(before)).includes(sentinel),
      false,
      "an invalid trace is user text, not an id",
    );
    socket.close();
  } finally {
    await stack.close();
  }
});

test("a failed send between two subscribes still closes 1008", async () => {
  const stack = await startStack();
  try {
    const botId = await stack.createBot("两次");
    const socket = stack.connect();
    await send(socket, hello);
    await nextFrame(socket);
    await send(socket, { type: "subscribe", botId, trace: tr("guard1") });
    await send(socket, {
      type: "send",
      requestId: "r_guard_00001",
      text: "还没订阅",
      whenBusy: "followUp",
      trace: tr("guard2"),
    });
    await send(socket, { type: "subscribe", botId, trace: tr("guard3") });
    assert.equal(await closeCode(socket), 1008);
  } finally {
    await stack.close();
  }
});

test("a send before the subscription has one origin error and one identity", async () => {
  const stack = await startStack();
  try {
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    const before = stack.records.length;
    await send(socket, {
      type: "send",
      requestId: "r_early_00001",
      text: "太早了",
      whenBusy: "followUp",
      trace: tr("early2"),
    });
    const refused = await frames.next();
    assert.equal(refused.type, "error");
    assert.equal(refused.disposition, "not_admitted");
    const records = stack.records.slice(before);
    const failed = records.filter((record) => record.level === "error");
    assert.equal(failed.length, 1, "one error record for the refusal");
    assert.equal(
      failed[0]?.evt,
      "protocol.command.fail",
      "a command that cannot reach a bot is refused at the wire boundary",
    );
    assert.equal(failed[0]?.err?.origin, true);
    assert.equal(refused.failure, failed[0]?.err?.failure, "frame and log share the identity");
    for (const record of records.filter((record) => record.err !== undefined)) {
      assert.equal(record.err?.failure, refused.failure, "no second identity for one refusal");
    }
    socket.close();
  } finally {
    await stack.close();
  }
});

test("a bot that became quarantined while subscribing closes 4090, not 4004", async () => {
  const stack = await startStack({ idleCloseMs: 20, closeHangs: true, closeDeadlineMs: 120 });
  try {
    const botId = await stack.createBot("隔离竞态");
    const first = stack.connect();
    const frames = frameQueue(first);
    await send(first, hello);
    await frames.next();
    await send(first, { type: "subscribe", botId, trace: tr("race1") });
    await frames.next();
    // Leaving releases the subscription; the idle close starts and never finishes.
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 40));

    const second = stack.connect();
    const secondFrames = frameQueue(second);
    await send(second, hello);
    await secondFrames.next();
    await send(second, { type: "subscribe", botId, trace: tr("race2") });
    // The subscription waits for the close; when it times out the bot is quarantined, so
    // the client must retry (4090) rather than treat it as deleted (4004).
    assert.equal(await closeCode(second), 4090);
    assert.equal(stack.registry.state(botId), "quarantined");
  } finally {
    await stack.close();
  }
});
