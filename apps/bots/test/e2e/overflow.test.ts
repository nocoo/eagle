// Ladder row 52g: an over-limit attempt is withdrawn through a snapshot, the notice takes
// the withheld entry's id after the commit, and nothing above the transport cap is ever
// presented as the answer (docs/bots/PROTOCOL.md, "Message").
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import type { Message } from "../../src/core/domain.ts";
import { OVERSIZED_NOTICE } from "../../src/runtime/pi/limits.ts";
import { type Provider, startProvider } from "../crash/support/provider.ts";
import { startDaemonProcess } from "../support/daemon.ts";
import { text } from "../support/pi.ts";
import { frameQueue, hello, send, startStack } from "../support/server.ts";

const tr = (name: string) => `tr_${name}_0123456`;
const MAX_FRAME_BYTES = 256 * 1024;

test("an over-limit answer is withheld, announced after commit and stable on reconnect", async () => {
  const stack = await startStack({ real: true, maxMessageBytes: 400, tokensPerSecond: 20 });
  try {
    // Spaces matter: the faux provider streams per token, so the withdrawal window lasts.
    const long = "很长的回答 ".repeat(60);
    stack.faux?.setResponses([text(long)]);
    const botId = await stack.createBot("超限");
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: tr("over1") });
    await frames.next();
    await send(socket, {
      type: "send",
      requestId: "r_over_00001",
      text: "请长一点",
      whenBusy: "followUp",
      trace: tr("over2"),
    });

    let withdrawn = false;
    let settled: Record<string, unknown> | undefined;
    let early: Record<string, unknown> | undefined;
    for (;;) {
      const frame = await frames.next(15_000);
      assert.ok(
        Buffer.byteLength(JSON.stringify(frame)) < MAX_FRAME_BYTES,
        "no frame goes over the transport cap",
      );
      const value = frame.value as { running?: boolean; streaming?: unknown } | undefined;
      if (frame.type === "snapshot" && value?.running === true && value.streaming === null) {
        // The withdrawal window: the attempt is still running and already withdrawn.
        withdrawn = true;
        const during = stack.connect();
        const joinedEarly = frameQueue(during);
        await send(during, hello);
        await joinedEarly.next();
        await send(during, { type: "subscribe", botId, trace: tr("over5") });
        for (;;) {
          const joined = await joinedEarly.next(10_000);
          if (joined.type !== "snapshot") continue;
          early = joined;
          break;
        }
        during.close();
      }
      if (frame.type === "submission" && frame.status === "done") {
        settled = frame;
        break;
      }
    }
    assert.equal(withdrawn, true, "the attempt was withdrawn before its entry existed");
    assert.equal(typeof settled?.answerEntryId, "string", "the submission still settles");

    // The client that joined inside the window saw the withdrawn state, not a partial.
    const earlyValue = early?.value as {
      messages: Message[];
      streaming: unknown;
      running: boolean;
    };
    assert.equal(early?.type, "snapshot");
    assert.equal(earlyValue.streaming, null, "nothing is streaming for a late join");
    // The join is in the withdrawal window or already past it; either way the answer is
    // never a partial and never the oversized content.
    assert.ok(
      earlyValue.running === true ||
        earlyValue.messages.some((message) => message.role === "notice"),
      "a late join sees the withdrawn attempt or its notice",
    );
    assert.equal(
      earlyValue.messages.some((message) => JSON.stringify(message).includes(long)),
      false,
      "no oversized partial reaches a client that joins mid-attempt",
    );

    await send(socket, { type: "resync", trace: tr("over3") });
    let transcript: Message[] = [];
    for (;;) {
      const frame = await frames.next(15_000);
      if (frame.type !== "snapshot") continue;
      transcript = (frame.value as { messages: Message[] }).messages;
      break;
    }
    const notices = transcript.filter((message) => message.role === "notice");
    assert.equal(notices.length, 1, "one notice replaces the withheld answer");
    const notice = notices[0] as Message;
    assert.equal(notice.id, settled?.answerEntryId, "the notice takes the withheld entry id");
    assert.equal(notice.state, "complete");
    assert.equal(notice.blocks[0]?.type === "text" ? notice.blocks[0].text : "", OVERSIZED_NOTICE);
    assert.equal(
      transcript.some((message) => JSON.stringify(message).includes(long)),
      false,
      "the oversized content was never presented",
    );

    // A late join sees the same notice from its snapshot: same id, same text, no duplicate.
    const late = stack.connect();
    const joined = frameQueue(late);
    await send(late, hello);
    await joined.next();
    await send(late, { type: "subscribe", botId, trace: tr("over4") });
    const baseline = await joined.next();
    const lateTranscript = (baseline.value as { messages: Message[] }).messages;
    assert.deepEqual(
      lateTranscript.map((message) => [message.id, message.role]),
      transcript.map((message) => [message.id, message.role]),
      "the reconnect sees the same transcript, not a second variant",
    );
    assert.equal(
      (baseline.value as { streaming: unknown }).streaming,
      null,
      "nothing is left streaming",
    );
    late.close();
    socket.close();
  } finally {
    await stack.close();
  }
});

test("a client that joins inside the withdrawal window sees no partial", async () => {
  // The window is a fact about the runtime, not about timing: the attempt is withdrawn,
  // the run is still going, and the commit waits for this gate.
  let release: () => void = () => undefined;
  const commit = new Promise<void>((resolve) => {
    release = resolve;
  });
  const user = {
    id: "e_7",
    role: "user" as const,
    state: "complete" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    blocks: [{ type: "text" as const, text: "请长一点" }],
    requestId: "r_window_0001",
  };
  const base = {
    botId: "b_window",
    messages: [user],
    pending: [],
    inbox: [],
    running: false,
    streaming: null as string | null,
  };
  let sink: ((event: import("../../src/core/RuntimePort.ts").RuntimeEvent) => void) | undefined;
  const runtime = {
    async open() {
      return {
        refreshTools: async () => {},
        subscribe: async (
          _trace: string,
          next: (event: import("../../src/core/RuntimePort.ts").RuntimeEvent) => void,
        ) => {
          sink = next;
          return { snapshot: { ...base }, detach: () => undefined };
        },
        submission: async () => undefined,
        submit: async (input: import("../../src/core/RuntimePort.ts").SubmitInput) => {
          sink?.({ type: "append", trace: input.trace, message: user });
          sink?.({
            type: "snapshot",
            trace: input.trace,
            value: { ...base, running: true, streaming: null },
          });
          void commit.then(() => {
            sink?.({
              type: "append",
              trace: input.trace,
              message: {
                id: "e_10",
                role: "notice",
                state: "complete",
                createdAt: "2026-01-01T00:00:01.000Z",
                blocks: [{ type: "text", text: "回答超出传输上限" }],
              },
            });
            sink?.({
              type: "submission",
              trace: input.trace,
              record: {
                id: "s_1",
                requestId: input.requestId,
                status: "done",
                entryId: "e_7",
                answerEntryId: "e_10",
              },
            });
            sink?.({
              type: "status",
              trace: input.trace,
              running: false,
              streaming: null,
              inbox: [],
            });
          });
          return { id: "s_1", requestId: input.requestId, status: "queued" as const };
        },
        history: async () => ({ messages: [], hasMore: false }),
        abort: async () => undefined,
        recover: async () => undefined,
        busy: async () => ({ run: true, tasks: false }),
        close: async () => "closed" as const,
      };
    },
  };
  const stack = await startStack({ runtime });
  try {
    const botId = await stack.createBot("窗口");
    const first = stack.connect();
    const frames = frameQueue(first);
    await send(first, hello);
    await frames.next();
    await send(first, { type: "subscribe", botId, trace: tr("win1") });
    await frames.next();
    await send(first, {
      type: "send",
      requestId: "r_window_0001",
      text: "请长一点",
      whenBusy: "followUp",
      trace: tr("win2"),
    });
    for (;;) {
      const frame = await frames.next(10_000);
      const value = frame.value as { running?: boolean; streaming?: unknown } | undefined;
      if (frame.type === "snapshot" && value?.running === true && value.streaming === null) break;
    }
    // The run is still going and the commit is gated: join now.
    const join = stack.connect();
    const joined = frameQueue(join);
    await send(join, hello);
    await joined.next();
    await send(join, { type: "subscribe", botId, trace: tr("win3") });
    let baseline: Record<string, unknown> | undefined;
    for (;;) {
      const frame = await joined.next(10_000);
      if (frame.type !== "snapshot") continue;
      baseline = frame;
      break;
    }
    const value = baseline.value as {
      running: boolean;
      streaming: unknown;
      messages: Message[];
    };
    assert.equal(value.running, true, "the join happened while the run was still going");
    assert.equal(value.streaming, null, "the withdrawn attempt is not streaming");
    assert.deepEqual(
      value.messages.map((message) => message.role),
      ["user"],
      "and it is not in the transcript",
    );
    release();
    for (;;) {
      const frame = await frames.next(10_000);
      if (frame.type === "submission" && frame.status === "done") break;
    }
    join.close();
    first.close();
  } finally {
    release();
    await stack.close();
  }
});

test("the real adapter leaves a joining client the withdrawn state, not a partial", async () => {
  // A real daemon over a provider that streams one chunk and then never returns: the
  // chunk exceeds the message cap, so the attempt is withdrawn and the run stays open.
  let provider: Provider | undefined;
  // The daemon takes a lock port derived from its root, so the root is one whose port is
  // free: a root that lost the port to another daemon is refused, not started.
  const started = await startDaemonProcess({
    prefix: "bots-window-",
    prepare: async (root) => {
      // One chunk over the 96 KiB projection cap: the attempt is withdrawn immediately.
      provider = await startProvider(join(root, "blocked"), { text: "长".repeat(40 * 1024) });
      return {
        env: {
          BOTS_BASE_URL: provider.baseUrl,
          BOTS_API_KEY: "test-key-0123456789",
          BOTS_MODEL: "auto/stub",
          BOTS_MODEL_PROVIDER: "stub",
        },
      };
    },
  });
  const { port, token } = started;
  try {
    const connect = () =>
      new WebSocket(`ws://127.0.0.1:${port}/v1/socket`, {
        headers: { authorization: `Bearer ${token}` },
      });
    const created = await fetch(`http://127.0.0.1:${port}/v1/bots`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "窗口" }),
    });
    const botId = ((await created.json()) as { bot: { id: string } }).bot.id;

    const first = connect();
    const frames = frameQueue(first);
    await send(first, hello);
    await frames.next();
    await send(first, { type: "subscribe", botId, trace: tr("real1") });
    await frames.next();
    await send(first, {
      type: "send",
      requestId: "r_real_00001",
      text: "请长一点",
      whenBusy: "followUp",
      trace: tr("real2"),
    });
    for (;;) {
      const frame = await frames.next(20_000);
      const value = frame.value as { running?: boolean; streaming?: unknown } | undefined;
      if (frame.type === "snapshot" && value?.running === true && value.streaming === null) break;
    }
    await provider?.blocked;
    const late = connect();
    const joined = frameQueue(late);
    await send(late, hello);
    await joined.next();
    await send(late, { type: "subscribe", botId, trace: tr("real3") });
    let baseline: Record<string, unknown> | undefined;
    for (;;) {
      const frame = await joined.next(20_000);
      if (frame.type !== "snapshot") continue;
      baseline = frame;
      break;
    }
    const value = baseline.value as {
      running: boolean;
      streaming: unknown;
      messages: Message[];
    };
    assert.equal(value.running, true, "the run is still open behind the withdrawn attempt");
    assert.equal(value.streaming, null, "nothing is streaming");
    assert.equal(
      value.messages.some((message) => message.role === "assistant"),
      false,
      "the withheld attempt is not in the transcript",
    );
    late.close();
    first.close();
  } finally {
    await started.daemon.stop();
    await provider?.close();
    await rm(started.root, { recursive: true, force: true });
  }
});
