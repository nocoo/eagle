// Ladder rows 28, 30-32, 36: the adapter against a real Harness over real sqlite.
import assert from "node:assert/strict";
import test from "node:test";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { RuntimeEvent } from "../../src/core/RuntimePort.ts";
import {
  assistant,
  createBench,
  hangingCloseStorage,
  providerError,
  requestId,
  text,
  textBlock,
  toolCall,
  trace,
  waitFor,
} from "../support/pi.ts";

const of = <T extends RuntimeEvent["type"]>(events: readonly RuntimeEvent[], type: T) =>
  events.filter((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type);

const collect = async (handle: {
  subscribe: (trace: string, sink: (event: RuntimeEvent) => void) => Promise<unknown>;
}) => {
  const events: RuntimeEvent[] = [];
  const subscription = await handle.subscribe(trace, (event) => events.push(event));
  return { events, subscription };
};

test("one turn appends exactly one pi.assistant entry", async () => {
  const bench = await createBench();
  try {
    bench.faux.setResponses([text("巴黎是法国的首都。")]);
    const handle = await bench.runtime.open(bench.spec());
    const { events } = await collect(handle);
    const record = await handle.submit({
      requestId,
      text: "法国的首都是哪里？",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      () => of(events, "submission").some((event) => event.record.status === "done"),
      "the run to settle",
    );
    const appends = of(events, "append");
    // The entry ids depend on the system entries a run writes (the tools section is one),
    // so the shape is asserted instead of fixed numbers.
    assert.deepEqual(
      appends.map((event) => [event.message.role, event.message.state]),
      [
        ["user", "complete"],
        ["assistant", "streaming"],
        ["assistant", "complete"],
      ],
      "the host commits nothing: the generation task appended the answer itself (F1)",
    );
    assert.equal(appends[1]?.message.id, "p_a1");
    assert.equal(appends[2]?.replaces, "p_a1");
    assert.match(appends[2]?.message.id ?? "", /^e_\d+$/);
    assert.deepEqual(appends[1]?.message.blocks, [{ type: "text", text: "巴黎是法国的首都。" }]);
    assert.equal(appends[2]?.replaces, "p_a1");
    // F24: the record read at admission may already be settled or still be `placed`;
    // either is legal, and the settlement follows on the event stream.
    assert.ok(record.status === "placed" || record.status === "done");
    assert.equal(record.requestId, requestId);
    assert.equal(record.entryId, "e_7");
    const settled = of(events, "submission").at(-1)?.record;
    assert.deepEqual(
      {
        status: settled?.status,
        requestId: settled?.requestId,
        entryId: settled?.entryId,
        answerEntryId: settled?.answerEntryId,
      },
      {
        status: "done",
        requestId,
        entryId: appends[0]?.message.id,
        answerEntryId: appends[2]?.message.id,
      },
    );
    const history = await handle.history({ limit: 10 });
    assert.deepEqual(
      history.messages.map((message) => message.role),
      ["user", "assistant"],
      "no second assistant entry, no host-written duplicate",
    );
    assert.equal(history.hasMore, false);
    assert.equal((await handle.busy()).run, false);
    assert.equal(await handle.close(trace, 5_000), "closed");
  } finally {
    await bench.cleanup();
  }
});

test("abort settles the running and queued inputs with reason aborted", async () => {
  const bench = await createBench({ provider: { tokensPerSecond: 5 }, settings: {} });
  try {
    bench.faux.setResponses([text("一个很长很长的回答，永远也说不完。")]);
    const handle = await bench.runtime.open(bench.spec());
    const { events } = await collect(handle);
    const running = await handle.submit({
      requestId: "r_running_1",
      text: "第一个问题",
      whenBusy: "followUp",
      trace,
    });
    const queued = await handle.submit({
      requestId: "r_queued_1",
      text: "排队的问题",
      whenBusy: "followUp",
      trace,
    });
    assert.equal(queued.status, "queued", "a busy bot queues the follow-up (F11)");
    assert.equal(running.status, "placed", "the first input owns the run");
    await waitFor(
      () => of(events, "append").some((event) => event.message.state === "streaming"),
      "the attempt to start streaming",
    );
    await handle.abort(trace);
    await waitFor(
      () =>
        of(events, "submission").filter((event) => event.record.status === "unanswered").length ===
        2,
      "both inputs to settle unanswered",
    );
    const settlements = of(events, "submission")
      .filter((event) => event.record.status === "unanswered")
      .map((event) => [event.record.requestId, event.record.reason]);
    const byRequest = new Map(
      of(events, "submission")
        .filter((event) => event.record.status === "unanswered")
        .map((event) => [event.record.requestId, event.record]),
    );
    assert.notEqual(
      byRequest.get("r_running_1")?.entryId,
      undefined,
      "F10: the running input settles with its entry",
    );
    assert.equal(
      byRequest.get("r_queued_1")?.entryId,
      undefined,
      "F10: a queued input that never placed settles without one",
    );
    assert.deepEqual(settlements.sort(), [
      ["r_queued_1", "aborted"],
      ["r_running_1", "aborted"],
    ]);
    const status = of(events, "status").at(-1);
    assert.deepEqual(status?.inbox, [], "the inbox empties (F10)");
    assert.equal(status?.running, false);
    const aborted = of(events, "append").find((event) => event.message.state === "aborted");
    assert.ok(aborted !== undefined, "the interrupted attempt stays visible as aborted (F22)");
    assert.equal(aborted.replaces, "p_a1");
    await handle.close(trace, 5_000);
  } finally {
    await bench.cleanup();
  }
});

test("a provider error settles unanswered with reason model_error", async () => {
  // One attempt: the retry policy is its own case, and its backoff is real time.
  const bench = await createBench({ settings: { retry: { maxRetries: 0 } } });
  try {
    const echoed = "upstream 500 while handling 会失败的问题";
    bench.faux.setResponses([
      providerError(echoed),
      providerError(echoed),
      providerError(echoed),
      providerError(echoed),
    ]);
    const handle = await bench.runtime.open(bench.spec());
    const { events } = await collect(handle);
    const record = await handle.submit({
      requestId,
      text: "会失败的问题",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      () => of(events, "submission").some((event) => event.record.status === "unanswered"),
      "the failure to settle",
    );
    const settlement = of(events, "submission").at(-1);
    assert.deepEqual(
      settlement === undefined ? undefined : [settlement.record.status, settlement.record.reason],
      ["unanswered", "model_error"],
      "F9: the provider error settles the input, it does not throw",
    );
    assert.ok(
      record.status === "placed" || record.status === "unanswered",
      "F24: the admission read may already be settled by the time it is read",
    );
    const logged = JSON.stringify(bench.records);
    assert.ok(!logged.includes("upstream 500"), "provider text never reaches a log");
    assert.ok(!logged.includes(echoed), "a provider error that echoes the prompt stays out too");
    assert.ok(!logged.includes("会失败的问题"), "message text never reaches a log");
    await handle.close(trace, 5_000);
  } finally {
    await bench.cleanup();
  }
});

test("a failed run starts the follow-up queued behind it", async () => {
  // A model error must not strand the input the person already queued behind it
  // (RUNTIME.md, settings per bot: afterFailedRun).
  const bench = await createBench({ settings: { retry: { maxRetries: 0 } } });
  try {
    bench.faux.setResponses([providerError("upstream 500"), text("第二条回答")]);
    const handle = await bench.runtime.open(bench.spec());
    const { events } = await collect(handle);
    await handle.submit({
      requestId: "r_fail_first",
      text: "会失败的问题",
      whenBusy: "followUp",
      trace,
    });
    const queued = await handle.submit({
      requestId: "r_fail_next",
      text: "排队的问题",
      whenBusy: "followUp",
      trace,
    });
    assert.equal(queued.status, "queued", "the second input is waiting behind the run");
    await waitFor(
      () =>
        of(events, "submission").some(
          (event) => event.record.requestId === "r_fail_next" && event.record.status === "done",
        ),
      "the queued follow-up to run after the failed run",
      15_000,
    );
    const settled = of(events, "submission").find(
      (event) => event.record.requestId === "r_fail_next" && event.record.status === "done",
    );
    assert.equal(settled?.record.status, "done");
    await handle.close(trace, 5_000);
  } finally {
    await bench.cleanup();
  }
});

test("a model asking for a tool gets an error result and the run continues", async () => {
  const bench = await createBench();
  try {
    let secondRequest: unknown;
    bench.faux.setResponses([
      assistant([textBlock("我查一下。"), toolCall("search", { q: "paris" })], {
        stopReason: "toolUse",
      }),
      (context: unknown) => {
        secondRequest = context;
        return text("没有这个工具，我直接回答。");
      },
    ]);
    const handle = await bench.runtime.open(bench.spec());
    const { events } = await collect(handle);
    const record = await handle.submit({
      requestId,
      text: "搜索一下",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      () => of(events, "submission").some((event) => event.record.status === "done"),
      "the run to answer after the tool round",
    );
    assert.ok(record.status === "done" || record.status === "placed");
    const answer = of(events, "append")
      .filter((event) => event.message.role === "assistant")
      .at(-1);
    assert.deepEqual(answer?.message.blocks, [
      { type: "text", text: "没有这个工具，我直接回答。" },
    ]);
    const toolBlocks = of(events, "append")
      .filter((event) => !event.message.id.startsWith("p_a"))
      .flatMap((event) => event.message.blocks)
      .filter((block) => block.type === "toolCall" || block.type === "toolResult");
    assert.equal(toolBlocks.length, 2, "the call and its result stay in the transcript");
    assert.equal(toolBlocks[0]?.type, "toolCall");
    assert.equal(toolBlocks[1]?.type, "toolResult");
    const history = await handle.history({ limit: 10 });
    assert.deepEqual(
      history.messages.map((message) => message.role),
      ["user", "assistant", "tool", "assistant"],
      "the durable tool result is a transcript row of its own",
    );
    const asked = JSON.stringify(secondRequest);
    assert.match(asked, /toolResult/, "RUNTIME.md: the model gets a result for the call it made");
    assert.match(asked, /"isError":true/, "and that result is an error, not a silent skip");
    assert.match(asked, /not available/, "the result says the tool is not available");
    await handle.close(trace, 5_000);
  } finally {
    await bench.cleanup();
  }
});

test("history pages older messages, oldest first, with a cursor", async () => {
  const bench = await createBench();
  try {
    const handle = await bench.runtime.open(bench.spec());
    await collect(handle);
    for (const [index, answer] of ["一。", "二。", "三。"].entries()) {
      bench.faux.setResponses([text(answer)]);
      await handle.submit({
        requestId: `r_history_${index}`,
        text: `问题 ${index}`,
        whenBusy: "followUp",
        trace,
      });
      await waitFor(async () => (await handle.busy()).run === false, `turn ${index} to settle`);
    }
    const all = await handle.history({ limit: 10 });
    assert.deepEqual(
      all.messages.map((message) => message.role),
      ["user", "assistant", "user", "assistant", "user", "assistant"],
      "oldest first",
    );
    assert.equal(all.hasMore, false);
    const cursor = all.messages[4]?.id as string;
    const older = await handle.history({ beforeEntryId: cursor, limit: 2 });
    assert.deepEqual(
      older.messages.map((message) => message.id),
      [all.messages[2]?.id, all.messages[3]?.id],
      "the cursor itself is not re-served",
    );
    assert.equal(older.hasMore, true);
    const oldest = await handle.history({ beforeEntryId: all.messages[2]?.id as string, limit: 2 });
    assert.deepEqual(
      oldest.messages.map((message) => message.id),
      [all.messages[0]?.id, all.messages[1]?.id],
    );
    assert.equal(oldest.hasMore, false);
    await handle.close(trace, 5_000);
  } finally {
    await bench.cleanup();
  }
});

test("close resolves timeout without dropping the handle", async () => {
  // Storage that ignores close: the shape RUNTIME.md calls "close() stalls on
  // non-cooperative code", and the one case the deadline exists for.
  const storage = hangingCloseStorage((path: string) => openNodeSqliteStorage(path));
  const bench = await createBench({ storage: storage.factory });
  try {
    bench.faux.setResponses([text("一个很快的回答。")]);
    const handle = await bench.runtime.open(bench.spec());
    await collect(handle);
    assert.equal(await handle.close(trace, 20), "timeout", "close() joins the stuck close");
    assert.equal(
      await handle.close(trace, 20),
      "timeout",
      "a second close joins the close already in flight, so the handle is retained",
    );
    assert.equal(storage.counter.calls, 1, "the storage close is not started twice");
    const timedOut = bench.records.filter((record) => record.evt === "runtime.close.fail");
    assert.equal(timedOut.length, 2, "each close call reports the deadline it hit");
    assert.deepEqual(
      timedOut.map((record) => [record.level, record.detail?.reason]),
      [
        ["warn", "timeout"],
        ["warn", "timeout"],
      ],
      "a timeout is never logged as success (ARCHITECTURE.md, bot lifecycle)",
    );
    assert.equal(
      bench.records.filter((record) => record.evt === "runtime.close.ok").length,
      0,
      "no close is reported as closed",
    );
  } finally {
    await bench.cleanup();
  }
});
