// Ladder row 53: a real daemon killed mid-answer, then restarted over the same root. The
// barrier is a fact about the provider — one streamed chunk, then it never returns — so no
// answer can land between the barrier and the kill (docs/bots/TESTING.md, "Crash test").
import assert from "node:assert/strict";
import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import type { Message } from "../../src/core/domain.ts";
import { type DaemonProcess, daemonRoot, spawnDaemon } from "../support/daemon.ts";
import { frameQueue, hello, send } from "../support/server.ts";
import { startProvider } from "./support/provider.ts";

type Daemon = {
  readonly port: number;
  readonly token: string;
  readonly child: DaemonProcess;
  kill(): Promise<void>;
};

const startDaemon = async (root: string, env: Record<string, string>): Promise<Daemon> => {
  const child = spawnDaemon({ root, env });
  const start = await child.waitForStart();
  return {
    port: start.port,
    token: start.token,
    child,
    kill: async () => {
      await child.stop();
    },
  };
};

const connect = (daemon: Daemon): WebSocket =>
  new WebSocket(`ws://127.0.0.1:${daemon.port}/v1/socket`, {
    headers: { authorization: `Bearer ${daemon.token}` },
  });

const api = async <T>(daemon: Daemon, path: string, method: string, body?: unknown): Promise<T> => {
  const response = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${daemon.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.ok(response.status < 400, `${method} ${path} answered ${response.status}`);
  return (await response.json()) as T;
};

test("killing the daemon right after admission loses no message and duplicates none", async () => {
  // No streamed chunk: the kill lands after the input is admitted and before any
  // assistant provisional exists, so recovery must not require an aborted entry.
  const root = await daemonRoot("bots-sigkill-early-");
  const sentinel = join(root, "blocked");
  const provider = await startProvider(sentinel, { chunk: false });
  const env = {
    BOTS_BASE_URL: provider.baseUrl,
    BOTS_API_KEY: "test-key-0123456789",
    BOTS_MODEL: "auto/stub",
    BOTS_MODEL_PROVIDER: "stub",
  };
  let running: Daemon | undefined;
  try {
    running = await startDaemon(root, env);
    const created = await api<{ bot: { id: string } }>(running, "/v1/bots", "POST", {
      title: "早杀",
    });
    const botId = created.bot.id;
    const socket = connect(running);
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: "tr_crash_sub_0" });
    await frames.next();
    await send(socket, {
      type: "send",
      requestId: "r_crash_00000",
      text: "刚被接收就被杀的问题",
      whenBusy: "followUp",
      trace: "tr_crash_send_0",
    });
    // The barrier: the user entry is committed and the provider is blocked with no chunk.
    for (;;) {
      const frame = await frames.next(20_000);
      if (frame.type === "append" && (frame.message as Message).role === "user") break;
    }
    await provider.blocked;
    socket.close();
    await running.kill();
    running = undefined;

    running = await startDaemon(root, env);
    const after = connect(running);
    const renewed = frameQueue(after);
    await send(after, hello);
    await renewed.next();
    await send(after, { type: "subscribe", botId, trace: "tr_crash_sub_1" });
    let messages: Message[] = [];
    for (;;) {
      const frame = await renewed.next(20_000);
      if (frame.type !== "snapshot") continue;
      messages = (frame.value as { messages: Message[] }).messages;
      break;
    }
    assert.equal(
      messages.filter((message) => message.role === "user").length,
      1,
      "the submission was admitted exactly once",
    );
    assert.equal(
      messages.filter((message) => message.role === "assistant" && message.state === "complete")
        .length,
      1,
      "the resumed run answered once",
    );
    assert.equal(
      messages.some((message) => message.state === "aborted"),
      false,
      "nothing was streamed, so nothing is presented as aborted",
    );
    after.close();
  } finally {
    await running?.kill();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("killing the daemon mid-answer loses no message and duplicates none", async () => {
  const root = await daemonRoot("bots-sigkill-");
  const sentinel = join(root, "blocked");
  const provider = await startProvider(sentinel);
  const env = {
    BOTS_BASE_URL: provider.baseUrl,
    BOTS_API_KEY: "test-key-0123456789",
    BOTS_MODEL: "auto/stub",
    BOTS_MODEL_PROVIDER: "stub",
  };
  let running: Daemon | undefined;
  try {
    running = await startDaemon(root, env);
    const created = await api<{ bot: { id: string } }>(running, "/v1/bots", "POST", {
      title: "崩溃",
    });
    const botId = created.bot.id;
    const socket = connect(running);
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: "tr_crash_sub_1" });
    await frames.next();
    await send(socket, {
      type: "send",
      requestId: "r_crash_00001",
      text: "会被杀掉的问题",
      whenBusy: "followUp",
      trace: "tr_crash_send_1",
    });
    // The barrier: a streamed assistant provisional is on the wire *and* the provider has
    // written its sentinel, so the answer cannot complete before the kill.
    let streamed = false;
    for (;;) {
      const frame = await frames.next(20_000);
      if (
        frame.type === "append" &&
        (frame.message as Message).role === "assistant" &&
        (frame.message as Message).state === "streaming"
      ) {
        streamed = true;
        break;
      }
    }
    assert.equal(streamed, true, "the interrupted attempt was streaming");
    await provider.blocked;
    await access(sentinel);
    socket.close();
    await running.kill();
    running = undefined;

    // Restart over the same root: recovery resumes the interrupted task.
    running = await startDaemon(root, env);
    const after = connect(running);
    const renewed = frameQueue(after);
    await send(after, hello);
    await renewed.next();
    await send(after, { type: "subscribe", botId, trace: "tr_crash_sub_2" });
    const baseline = await renewed.next();
    const messages = (baseline.value as { messages: Message[] }).messages;
    assert.deepEqual(
      messages.map((message) => [message.role, message.state]),
      [
        ["user", "complete"],
        ["assistant", "aborted"],
        ["assistant", "complete"],
      ],
      "one question, the interrupted attempt kept as aborted, one answer",
    );
    assert.equal(
      messages.filter((message) => message.role === "user").length,
      1,
      "the submission was admitted exactly once",
    );
    assert.equal(provider.requests(), 2, "the resumed task asked the provider again");

    // The outbox is recovered the documented way: re-send the same requestId and read the
    // stored record (the in-memory ledger does not survive a restart, RUNTIME.md).
    await send(after, {
      type: "send",
      requestId: "r_crash_00001",
      text: "会被杀掉的问题",
      whenBusy: "followUp",
      trace: "tr_crash_send_2",
    });
    for (;;) {
      const frame = await renewed.next(20_000);
      if (frame.type !== "submission") continue;
      assert.equal(frame.requestId, "r_crash_00001");
      assert.equal(frame.status, "done", "the resumed run settled the stored record");
      break;
    }
    await send(after, { type: "resync", trace: "tr_crash_resync" });
    for (;;) {
      const frame = await renewed.next(20_000);
      if (frame.type !== "snapshot") continue;
      const settled = (frame.value as { messages: Message[] }).messages;
      assert.equal(
        settled.filter((message) => message.role === "user").length,
        1,
        "the re-send admitted nothing new",
      );
      break;
    }
    after.close();
  } finally {
    await running?.kill();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});
