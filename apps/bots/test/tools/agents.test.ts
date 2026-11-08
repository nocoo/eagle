// Subagents (docs/bots/RUNTIME.md, "Subagents"): a bot starts a child conversation, gives
// it work, and reads its answer back, over the real adapter and real sqlite.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import type { ConversationId, ToolExecutionApi } from "@earendil-works/pi-durable";
import type { RuntimeEvent, RuntimeHandle } from "../../src/core/RuntimePort.ts";
import { fileMemoryHost } from "../../src/memory/fileHost.ts";
import { createAgentTools } from "../../src/tools/agents/tools.ts";
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

test("a child gets the core and coding tools and nothing else", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-child-tools-"));
  const bench = await createBench({ memory: () => fileMemoryHost({ dir, botId: "b_runtime" }) });
  let handle: RuntimeHandle | undefined;
  try {
    const parentTools: string[][] = [];
    const childTools: string[][] = [];
    bench.faux.setResponses([
      (context: TranscriptContext) => {
        parentTools.push(getCurrentTools(context.messages).map((tool) => tool.name));
        return assistant([toolCall("agent_spawn", { name: "child" })], { stopReason: "toolUse" });
      },
      (context: TranscriptContext) => {
        const id = /as c_(\d+)/.exec(JSON.stringify(context.messages))?.[1];
        assert.ok(id, "the spawn result names the child id");
        return assistant([toolCall("agent_send", { agentId: `c_${id}`, message: "work" })], {
          stopReason: "toolUse",
        });
      },
      (context: TranscriptContext) => {
        childTools.push(getCurrentTools(context.messages).map((tool) => tool.name));
        return assistant("READY");
      },
      assistant("done"),
    ]);
    handle = await bench.runtime.open({
      ...bench.spec(),
      toolGroups: ["core", "coding", "agents", "memory", "herdr"],
    });
    const results = await runWithTools(handle);
    const send = results.find((item) => item.name === "agent_send");
    assert.equal(send?.isError, false, `the child answered (${send?.text})`);
    const parent = parentTools[0] ?? [];
    assert.ok(parent.includes("memory_write"), "the parent offered memory");
    assert.ok(parent.includes("tool_search"), "the parent offered the deferred loader");
    assert.ok(parent.includes("agent_spawn"), "the parent offered delegation");
    assert.deepEqual(
      [...(childTools[0] ?? [])].sort(),
      ["ask_user", "bash", "edit", "list", "note_set", "read", "write"],
      "only the two mandatory groups reach a child",
    );
  } finally {
    await handle?.close(trace, 1_000);
    await bench.cleanup();
  }
});

test("agent_stop withdraws a send that is still validating its marker", async () => {
  const childId = 2 as ConversationId;
  const parentId = 1 as ConversationId;
  let releaseMarker!: () => void;
  const markerGate = new Promise<void>((resolve) => {
    releaseMarker = resolve;
  });
  let markerChecks = 0;
  let submissions = 0;
  const tx = {
    scanEntries: async () => {
      markerChecks++;
      await markerGate;
      return { items: [] };
    },
  };
  const api = {
    conversationId: parentId,
    taskId: 10,
    now: () => 1,
    conversation: async () => ({
      waitForIdle: async () => undefined,
      submit: async () => {
        submissions++;
        return { wait: async () => ({ status: "done", entry: 1 }) };
      },
      abort: async () => undefined,
    }),
    commit: async (action: (value: typeof tx) => unknown) => action(tx),
  } as unknown as ToolExecutionApi;
  const tools = createAgentTools(["bots-tools", "coding-tools"]);
  const send = tools.find((item) => item.name === "agent_send");
  const stop = tools.find((item) => item.name === "agent_stop");
  assert.ok(send);
  assert.ok(stop);
  const pending = send.execute({ agentId: "c_2", message: "queued" }, api, BACKGROUND_CONTEXT);
  const withdrawn = assert.rejects(pending);
  try {
    await waitFor(() => markerChecks === 1, "the marker check");
    await stop.execute({ agentId: "c_2" }, api, BACKGROUND_CONTEXT);
    releaseMarker();
    await withdrawn;
    assert.equal(submissions, 0, "stop must withdraw a send awaiting marker validation");
    assert.equal(childId, 2, "the child id is the one the marker names");
  } finally {
    releaseMarker();
    await Promise.allSettled([pending]);
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
