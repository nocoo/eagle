import assert from "node:assert/strict";
import test from "node:test";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { RuntimeEvent, RuntimeHandle } from "../../src/core/RuntimePort.ts";
import {
  armedFailureStorage,
  assistant,
  type Bench,
  createBench,
  trace,
  waitFor,
} from "../support/pi.ts";

const offered = async (bench: Bench, handle: RuntimeHandle, events: RuntimeEvent[], id: string) => {
  bench.faux.setResponses([
    (context) =>
      assistant(JSON.stringify(getCurrentTools(context.messages).map((tool) => tool.name))),
  ]);
  await handle.submit({
    requestId: id,
    text: "report available tools",
    whenBusy: "followUp",
    trace,
  });
  await waitFor(
    () =>
      events.some(
        (event) =>
          event.type === "submission" &&
          event.record.requestId === id &&
          event.record.status === "done",
      ),
    "the tool catalog answer",
  );
  const answer = events
    .filter((event) => event.type === "append" && event.message.role === "assistant")
    .at(-1);
  assert.ok(answer?.type === "append");
  const block = answer.message.blocks[0];
  assert.ok(block?.type === "text");
  return JSON.parse(block.text) as string[];
};

test("a warm bot can enable groups it did not initially select", async () => {
  const bench = await createBench();
  try {
    const handle = await bench.runtime.open({ ...bench.spec(), toolGroups: [] });
    const events: RuntimeEvent[] = [];
    await handle.subscribe(trace, (event) => events.push(event));
    assert.deepEqual((await offered(bench, handle, events, "r_groups_1")).sort(), [
      "bash",
      "edit",
      "list",
      "note_set",
      "read",
      "write",
    ]);
    assert.ok(handle.configureToolGroups);
    await handle.configureToolGroups(["herdr", "agents"], trace);
    const enabled = await offered(bench, handle, events, "r_groups_2");
    assert.ok(enabled.includes("agent_spawn"));
    assert.ok(enabled.includes("tool_search"));
    assert.equal(
      enabled.some((name) => name.startsWith("herdr_")),
      false,
      "terminal tools remain deferred",
    );
    await handle.close(trace, 1_000);
  } finally {
    await bench.cleanup();
  }
});

test("disabling optional groups removes their tools and loader but retains both mandatory groups", async () => {
  const bench = await createBench();
  try {
    const handle = await bench.runtime.open({ ...bench.spec(), toolGroups: ["herdr", "agents"] });
    const events: RuntimeEvent[] = [];
    await handle.subscribe(trace, (event) => events.push(event));
    assert.ok(handle.configureToolGroups);
    await handle.configureToolGroups([], trace);
    assert.deepEqual((await offered(bench, handle, events, "r_groups_off")).sort(), [
      "bash",
      "edit",
      "list",
      "note_set",
      "read",
      "write",
    ]);
    await handle.close(trace, 1_000);
  } finally {
    await bench.cleanup();
  }
});

test("refreshing tools preserves an in-flight answer and records the supplied trace", async () => {
  const bench = await createBench();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let handle: RuntimeHandle | undefined;
  try {
    let generating = false;
    bench.faux.setResponses([
      async () => {
        generating = true;
        await gate;
        return assistant("answer preserved");
      },
    ]);
    handle = await bench.runtime.open(bench.spec());
    const events: RuntimeEvent[] = [];
    await handle.subscribe(trace, (event) => events.push(event));
    await handle.submit({
      requestId: "r_refresh_running",
      text: "keep answering",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(() => generating, "the model request to start");
    await handle.refreshTools("tr_switch_running");
    assert.equal((await handle.busy()).run, true);
    assert.equal(
      events.some((event) => event.type === "submission" && event.record.status === "unanswered"),
      false,
    );
    release();
    await waitFor(
      () => events.some((event) => event.type === "submission" && event.record.status === "done"),
      "the original answer to finish",
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "append" &&
          event.message.blocks.some(
            (block) => block.type === "text" && block.text === "answer preserved",
          ),
      ),
    );
    const refreshed = bench.records.filter((record) => record.evt === "runtime.tools.refresh.ok");
    assert.equal(refreshed.length, 1);
    assert.equal(refreshed[0]?.trace, "tr_switch_running");
  } finally {
    release();
    await handle?.close(trace, 1_000);
    await bench.cleanup();
  }
});

test("a refresh failure is classified once at the runtime origin", async () => {
  const bench = await createBench();
  try {
    const handle = await bench.runtime.open(bench.spec());
    await handle.close(trace, 1_000);
    await assert.rejects(handle.refreshTools("tr_refresh_closed"));
    const errors = bench.records.filter((record) => record.level === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.evt, "runtime.tools.refresh.fail");
    assert.equal(errors[0]?.layer, "runtime");
    assert.equal(errors[0]?.trace, "tr_refresh_closed");
    assert.equal(errors[0]?.err?.origin, true);
  } finally {
    await bench.cleanup();
  }
});

test("a refresh storage failure shares one identity with the session failure channels", async () => {
  const storage = armedFailureStorage(openNodeSqliteStorage);
  const bench = await createBench({ storage: storage.factory });
  try {
    const handle = await bench.runtime.open(bench.spec());
    await handle.subscribe(trace, () => undefined);
    storage.arm();
    assert.ok(handle.configureToolGroups);
    await assert.rejects(handle.configureToolGroups(["agents"], "tr_refresh_storage"));
    await waitFor(
      () => bench.records.some((record) => record.evt === "pi.session.closed"),
      "the failed session to close",
    );
    const failures = bench.records.filter((record) => record.err?.kind === "storage_failed");
    assert.equal(new Set(failures.map((record) => record.err?.failure)).size, 1);
    assert.equal(failures.filter((record) => record.level === "error").length, 1);
    assert.equal(
      failures.find((record) => record.evt === "runtime.tools.refresh.fail")?.trace,
      "tr_refresh_storage",
    );
    await handle.close(trace, 1_000);
  } finally {
    await bench.cleanup();
  }
});
