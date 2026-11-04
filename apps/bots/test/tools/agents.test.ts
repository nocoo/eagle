// Subagents (docs/bots/RUNTIME.md, "Subagents"): a bot starts a child conversation, gives
// it work, and reads its answer back, over the real adapter and real sqlite.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import type { ConversationId, ToolExecutionApi } from "@earendil-works/pi-durable";
import type { RuntimeEvent, RuntimeHandle } from "../../src/core/RuntimePort.ts";
import { createAgentTools } from "../../src/tools/agents/tools.ts";
import type { SharedDevicePort } from "../../src/tools/devices/port.ts";
import { deviceExtension } from "../../src/tools/devices/tools.ts";
import { assistant, createBench, toolCall, trace, waitFor } from "../support/pi.ts";

const runWithTools = async (handle: {
  subscribe: (t: string, s: (e: RuntimeEvent) => void) => Promise<unknown>;
  submit: (i: {
    requestId: string;
    text: string;
    whenBusy: "followUp";
    trace: string;
  }) => Promise<unknown>;
}) => {
  const events: RuntimeEvent[] = [];
  await handle.subscribe(trace, (event) => events.push(event));
  await handle.submit({
    requestId: "r_subagent_1",
    text: "委派给子 agent",
    whenBusy: "followUp",
    trace,
  });
  await waitFor(
    () => events.some((event) => event.type === "submission" && event.record.status === "done"),
    "the run to settle",
    10_000,
  );
  return events
    .filter((event) => event.type === "append")
    .flatMap((event) => event.message.blocks)
    .flatMap((block) => (block.type === "toolResult" ? [block] : []));
};

test("existing children follow remote configuration without regaining delegation", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-child-device-"));
  const path = join(root, "access.sock");
  const deviceId = randomUUID();
  const sockets = new Set<Socket>();
  let configured = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end)) as { requestId: string; method: string };
      buffer = buffer.slice(end + 1);
      const response =
        request.method === "status"
          ? {
              result: {
                deviceId,
                localReady: true,
                cloudStatus: configured ? "offline" : "unconfigured",
                policy: { mode: "all-approve", version: 1 },
              },
            }
          : { error: "unexpected_method" };
      socket.write(
        `${JSON.stringify({ version: 2, requestId: request.requestId, ...response })}\n`,
      );
    });
  });
  let bench: Awaited<ReturnType<typeof createBench>> | undefined;
  let handle: RuntimeHandle | undefined;
  let failure: unknown;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    await chmod(path, 0o600);
    bench = await createBench({ deviceSocket: path });
    let childId = "";
    const childTools: string[][] = [];
    const send = () =>
      assistant([toolCall("agent_send", { agentId: childId, message: "respond" })], {
        stopReason: "toolUse",
      });
    const capture = (context: TranscriptContext) => {
      childTools.push(getCurrentTools(context.messages).map((tool) => tool.name));
      return assistant("READY");
    };
    bench.faux.setResponses([
      assistant([toolCall("agent_spawn", { name: "child" })], { stopReason: "toolUse" }),
      (context) => {
        const id = /as c_(\d+)/.exec(JSON.stringify(context.messages))?.[1];
        assert.ok(id);
        childId = `c_${id}`;
        configured = true;
        return send();
      },
      capture,
      () => {
        configured = false;
        return send();
      },
      capture,
      () => {
        configured = true;
        return send();
      },
      capture,
      assistant([toolCall("agent_spawn", { name: "later" })], { stopReason: "toolUse" }),
      (context) => {
        const ids = [...JSON.stringify(context.messages).matchAll(/as c_(\d+)/g)];
        const id = ids.at(-1)?.[1];
        assert.ok(id);
        childId = `c_${id}`;
        return send();
      },
      capture,
      assistant("done"),
    ]);
    handle = await bench.runtime.open({ ...bench.spec(), toolGroups: ["core", "agents"] });
    const results = await runWithTools(handle);
    assert.equal(results.filter((item) => item.name === "agent_send" && !item.isError).length, 4);
    assert.equal(childTools.length, 4);
    for (const [index, names] of childTools.entries()) {
      assert.equal(names.includes("remote_execute"), index !== 1);
      assert.equal(names.includes("remote_status"), index !== 1);
      assert.equal(names.includes("remote_operation"), index !== 1);
      assert.equal(
        names.some((name) => ["agent_spawn", "agent_send", "agent_stop"].includes(name)),
        false,
      );
      for (const name of ["bash", "read", "write", "edit", "list"]) assert.ok(names.includes(name));
    }
  } catch (error) {
    failure = error;
  }
  for (const socket of sockets) socket.destroy();
  const closed = await Promise.allSettled([
    handle?.close(trace, 1000),
    new Promise<void>((resolve) => server.close(() => resolve())),
  ]);
  const handleClosed = closed[0]?.status === "fulfilled" && closed[0].value !== "timeout";
  const cleaned = await Promise.allSettled([
    handleClosed ? bench?.cleanup() : undefined,
    rm(root, { recursive: true, force: true }),
  ]);
  const errors = [...closed, ...cleaned].flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (!handleClosed && closed[0]?.status === "fulfilled")
    errors.push(new Error("child handle did not close"));
  if (failure !== undefined) errors.unshift(failure);
  if (errors.length) throw new AggregateError(errors, "child device test failed");
});

test("parallel sends cannot reconfigure a child while an earlier send is active", async () => {
  const childId = 2 as ConversationId;
  const parentId = 1 as ConversationId;
  const state = {
    extensions: ["bots-tools", "coding-tools"],
    tools: ["bash", "read", "write", "edit", "list"],
  };
  let statusCalls = 0;
  let markerReads = 0;
  let submissions = 0;
  let active = false;
  let releaseStatus!: () => void;
  let completeFirst!: () => void;
  let completeThird!: () => void;
  let releaseMarker!: () => void;
  let blockMarker = false;
  const statusGate = new Promise<void>((resolve) => {
    releaseStatus = resolve;
  });
  const firstDone = new Promise<void>((resolve) => {
    completeFirst = resolve;
  });
  const thirdDone = new Promise<void>((resolve) => {
    completeThird = resolve;
  });
  const markerGate = new Promise<void>((resolve) => {
    releaseMarker = resolve;
  });
  const idle: (() => void)[] = [];
  const port: SharedDevicePort = {
    version: 2,
    status: async () => {
      statusCalls++;
      if (statusCalls === 1) await statusGate;
      return {
        deviceId: randomUUID(),
        localReady: true,
        cloudStatus: statusCalls === 1 ? "offline" : "unconfigured",
        policy: { mode: "all-approve", version: 1 },
      };
    },
    directory: async () => {
      throw new Error("unexpected_directory");
    },
    request: async () => {
      throw new Error("unexpected_request");
    },
    approve: async () => {
      throw new Error("unexpected_approval");
    },
    begin: async () => {
      throw new Error("unexpected_begin");
    },
  };
  const child = {
    waitForIdle: async () => {
      if (active) await new Promise<void>((resolve) => idle.push(resolve));
    },
    submit: async () => {
      submissions++;
      const current = submissions;
      active = true;
      return {
        wait: async () => {
          if (current === 1) await firstDone;
          if (current === 3) await thirdDone;
          active = false;
          for (const resolve of idle.splice(0)) resolve();
          return { status: "done", entry: current };
        },
      };
    },
    abort: async () => {
      completeFirst();
      completeThird();
      active = false;
      for (const resolve of idle.splice(0)) resolve();
    },
  };
  const tx = {
    scanEntries: async () => {
      markerReads++;
      if (blockMarker) await markerGate;
      return {
        items: [
          { conversationId: childId, kind: "bots.agent", data: { parentConversationId: parentId } },
        ],
      };
    },
    doc: async () => state,
    entry: async () => ({ model: [{ content: "READY" }] }),
  };
  const api = {
    conversationId: parentId,
    taskId: 10,
    now: () => 1,
    conversation: async () => child,
    commit: async (action: (value: typeof tx) => unknown) => action(tx),
  } as unknown as ToolExecutionApi;
  const extension = deviceExtension({ botId: "fixture", port });
  const tools = createAgentTools({ port, extension });
  const tool = tools.find((item) => item.name === "agent_send");
  const stop = tools.find((item) => item.name === "agent_stop");
  assert.ok(tool);
  assert.ok(stop);
  const first = tool.execute({ agentId: "c_2", message: "first" }, api, BACKGROUND_CONTEXT);
  let second: Promise<unknown> | undefined;
  let cancelled: Promise<unknown> | undefined;
  let third: Promise<unknown> | undefined;
  let fourth: Promise<unknown> | undefined;
  let fifth: Promise<unknown> | undefined;
  try {
    await waitFor(() => statusCalls === 1, "first status");
    const controller = new AbortController();
    let cancelledStarted = false;
    cancelled = tool.execute(
      {
        get agentId() {
          cancelledStarted = true;
          return "c_2";
        },
        message: "cancelled",
      },
      api,
      withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
    );
    const rejected = assert.rejects(cancelled);
    await waitFor(() => cancelledStarted, "cancelled send started");
    controller.abort();
    await rejected;
    let secondStarted = false;
    second = tool.execute(
      {
        get agentId() {
          secondStarted = true;
          return "c_2";
        },
        message: "second",
      },
      api,
      BACKGROUND_CONTEXT,
    );
    await waitFor(() => secondStarted, "second send started");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(statusCalls, 1, "second send must wait for the first admission");
    releaseStatus();
    await waitFor(() => submissions === 1, "first child submission");
    assert.equal(statusCalls, 1, "second status must wait for the active child");
    completeFirst();
    await waitFor(() => submissions === 2, "second child submission");
    const [one, two] = await Promise.all([first, second]);
    assert.equal(one.isError, undefined);
    assert.equal((two as { isError?: boolean }).isError, undefined);
    third = tool.execute({ agentId: "c_2", message: "third" }, api, BACKGROUND_CONTEXT);
    await waitFor(() => submissions === 3, "third child submission");
    let fourthStarted = false;
    fourth = tool.execute(
      {
        get agentId() {
          fourthStarted = true;
          return "c_2";
        },
        message: "fourth",
      },
      api,
      BACKGROUND_CONTEXT,
    );
    const withdrawn = assert.rejects(fourth);
    await waitFor(() => fourthStarted, "fourth send queued");
    await stop.execute({ agentId: "c_2" }, api, BACKGROUND_CONTEXT);
    await withdrawn;
    await third;
    assert.equal(submissions, 3, "stop must withdraw unsent admissions");
    blockMarker = true;
    fifth = tool.execute({ agentId: "c_2", message: "fifth" }, api, BACKGROUND_CONTEXT);
    const stoppedDuringMarker = assert.rejects(fifth);
    await waitFor(() => markerReads === 4, "fifth marker check");
    await stop.execute({ agentId: "c_2" }, api, BACKGROUND_CONTEXT);
    releaseMarker();
    await stoppedDuringMarker;
    assert.equal(submissions, 3, "stop must withdraw sends awaiting marker validation");
  } finally {
    releaseStatus();
    completeFirst();
    completeThird();
    releaseMarker();
    for (const resolve of idle.splice(0)) resolve();
    await Promise.allSettled([first, second, cancelled, third, fourth, fifth]);
  }
});

test("agent_send refuses conversations without an app-managed child marker", async () => {
  const bench = await createBench();
  try {
    bench.faux.setResponses([
      assistant([toolCall("agent_send", { agentId: "c_1", message: "do not recurse" })], {
        stopReason: "toolUse",
      }),
      assistant("done"),
    ]);
    const handle = await bench.runtime.open({ ...bench.spec(), toolGroups: ["core", "agents"] });
    const results = await runWithTools(handle);
    const refused = results.find((item) => item.name === "agent_send");
    assert.ok(refused);
    assert.equal(refused.isError, true);
    assert.match(refused.text, /unknown child agent/);
    await handle.close(trace, 1000);
  } finally {
    await bench.cleanup();
  }
});

test("a child agent runs the delegated turn and its answer comes back", async () => {
  const bench = await createBench();
  try {
    bench.faux.setResponses([
      // 1. the parent asks to start a child
      assistant([toolCall("agent_spawn", { name: "计数" })], { stopReason: "toolUse" }),
      // 2. the parent hands it work
      (context: { messages: readonly { content: unknown }[] }) => {
        const seen = JSON.stringify(context.messages);
        const id = /as c_(\d+)/.exec(seen)?.[1];
        assert.ok(id, "the spawn result names the child id");
        return assistant([toolCall("agent_send", { agentId: `c_${id}`, message: "回复 READY" })], {
          stopReason: "toolUse",
        });
      },
      // 3. the child answers
      assistant("READY"),
      // 4. the parent closes the turn
      assistant("子 agent 已完成"),
    ]);
    const handle = await bench.runtime.open({ ...bench.spec(), toolGroups: ["core", "agents"] });
    const results = await runWithTools(handle);
    const spawn = results.find((block) => block.name === "agent_spawn");
    assert.ok(spawn, `the spawn call ran (${results.map((block) => block.name).join(",")})`);
    assert.match(spawn.text, /c_\d+/);
    const send = results.find((block) => block.name === "agent_send");
    assert.ok(send, "the send call ran");
    assert.equal(send.isError, false, `the child answered (${send.text})`);
    assert.match(send.text, /READY/);
    await handle.close(trace, 1_000);
  } finally {
    await bench.cleanup();
  }
});
