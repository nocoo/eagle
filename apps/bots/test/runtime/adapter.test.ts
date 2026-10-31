// Ladder rows 28, 30-32, 36: the adapter against a real Harness over real sqlite.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type ConversationId,
  defineExtension,
  defineTask,
  Harness,
  type Registry,
  type ReportInfo,
  section,
  wrapSection,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CommandError, ConversationService } from "../../src/core/ConversationService.ts";
import type { RuntimeEvent, RuntimeHandle } from "../../src/core/RuntimePort.ts";
import type { HistoryBundle } from "../../src/runtime/pi/HistoryReplica.ts";
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

test("real SDK reports stay with their context, including deferred errors and task fault deduplication", async (t) => {
  const bench = await createBench();
  const originalOpen = Harness.open;
  let sdk!: Harness;
  let registry!: Registry;
  const reports: { error: unknown; info: ReportInfo }[] = [];
  t.mock.method(Harness, "open", async (...args: Parameters<typeof Harness.open>) => {
    const [storage, options, context] = args;
    registry = options.registry as Registry;
    sdk = await originalOpen(
      storage,
      {
        ...options,
        onReport: (error, info) => {
          reports.push({ error, info });
          options.onReport?.(error, info);
        },
      },
      context,
    );
    return sdk;
  });
  const rootTrace = "tr_report_root";
  const handle = await bench.runtime.open(bench.spec(rootTrace));
  const rootEvents: RuntimeEvent[] = [];
  await handle.subscribe(rootTrace, (event) => rootEvents.push(event));
  const results: { trace: string; events: RuntimeEvent[]; taskId: string }[] = [];
  try {
    bench.faux.setResponses([text("seed"), text("live context"), text("deferred context")]);
    await handle.submit({
      requestId: "report_seed",
      text: "seed",
      whenBusy: "followUp",
      trace: rootTrace,
    });
    await waitFor(
      async () => (await handle.submission({ requestId: "report_seed" }))?.status === "done",
      "report seed",
    );
    const seed = (await handle.replica?.({
      method: "export",
      params: {},
      trace: rootTrace,
    })) as HistoryBundle;
    for (const mode of ["live", "deferred"] as const) {
      const contextId = `report_${mode}`;
      const contextTrace = `tr_report_${mode}`;
      await handle.replica?.({
        method: "context",
        params: { contextId, head: seed.head },
        trace: contextTrace,
      });
      assert.ok(handle.context);
      const child = await handle.context(contextId, contextTrace);
      const bundle = (await handle.replica?.({
        method: "export",
        params: { contextId },
        trace: contextTrace,
      })) as HistoryBundle;
      const conversation = await sdk.conversation(
        bundle.source.conversationId as ConversationId,
        BACKGROUND_CONTEXT,
      );
      assert.ok(conversation);
      const taskCause = new Error(`owned ${mode} extension task failure`);
      const wrapperCause = new Error(`owned ${mode} agent resolution failure`);
      let wrapperArmed = false;
      const fault = defineTask<null, { phase: "run" }, null>({
        name: `owned-report-${mode}`,
        version: 1,
        initial: () => ({ phase: "run" }),
        phases: {
          run: async (_task, runtime) => {
            runtime.report(taskCause, { type: "extension", extension: `owned-report-${mode}` });
            throw taskCause;
          },
        },
        abort: async () => {
          throw taskCause;
        },
      });
      const extension = defineExtension({
        name: `owned-report-${mode}`,
        tasks: [fault],
        sections: [section("owned-report", () => "owned report fixture")],
        wraps: [
          wrapSection("owned-report", (original) => {
            if (wrapperArmed) throw wrapperCause;
            return original;
          }),
        ],
      });
      registry.install(extension);
      await conversation.configure({ extensions: { add: [extension] } }, BACKGROUND_CONTEXT);
      const events: RuntimeEvent[] = [];
      if (mode === "live") await child.subscribe(contextTrace, (event) => events.push(event));
      const requestId = `report_input_${mode}`;
      await child.submit({ requestId, text: mode, whenBusy: "followUp", trace: contextTrace });
      await waitFor(
        async () => (await child.submission({ requestId }))?.status === "done",
        `${mode} context settles`,
      );
      const taskId = await conversation.commit(
        (tx) => tx.createTask(fault, null, { ownership: { kind: "conversation" } }),
        BACKGROUND_CONTEXT,
      );
      await conversation.waitForIdle(BACKGROUND_CONTEXT);
      assert.ok(
        reports.some(
          ({ error, info }) =>
            error === taskCause &&
            info.type === "extension_error" &&
            info.task?.id === taskId &&
            info.task.conversationId === conversation.id,
        ),
        "the real task runtime reports the original Error and conversation",
      );
      await waitFor(
        () => reports.some(({ info }) => info.type === "task_faulted" && info.task.id === taskId),
        "the SDK also faults the same task",
      );
      wrapperArmed = true;
      try {
        await conversation.agent(BACKGROUND_CONTEXT);
      } finally {
        wrapperArmed = false;
      }
      assert.ok(
        reports.some(
          ({ error, info }) =>
            error === wrapperCause &&
            info.type === "extension_error" &&
            info.task === undefined &&
            info.conversationId === conversation.id,
        ),
        "real agent resolution reports the explicit conversation without a task",
      );
      if (mode === "deferred") await child.subscribe(contextTrace, (event) => events.push(event));
      results.push({ trace: contextTrace, events, taskId: String(taskId) });
    }
    assert.equal(bench.faux.state.callCount, 3, "report delivery never replays execution");
    assert.equal(of(rootEvents, "error").length, 0, "root never consumes another context's error");
    for (const result of results) {
      const errors = of(result.events, "error");
      assert.equal(
        errors.length,
        2,
        "task report/fault dedupe, with one independent agent resolution failure",
      );
      assert.ok(errors.some((event) => event.taskId === result.taskId));
      for (const event of errors) {
        assert.equal(event.trace, result.trace);
        assert.equal(event.failure.kind, "extension_error");
        const origins = bench.records.filter(
          (record) =>
            record.level === "error" &&
            record.err?.failure === event.failure.id &&
            record.err.origin === true,
        );
        assert.equal(origins.length, 1);
        assert.equal(origins[0]?.trace, result.trace);
        assert.equal(origins[0]?.botId, bench.spec().id);
      }
    }
  } finally {
    await handle.close(rootTrace, 5_000);
    await bench.cleanup();
  }
});

test("an unregistered SDK child report retains its boot trace while root runs", async (t) => {
  const bench = await createBench();
  const originalOpen = Harness.open;
  let sdk!: Harness;
  let registry!: Registry;
  const reports: ReportInfo[] = [];
  t.mock.method(Harness, "open", async (...args: Parameters<typeof Harness.open>) => {
    const [storage, options, context] = args;
    registry = options.registry as Registry;
    sdk = await originalOpen(
      storage,
      {
        ...options,
        onReport: (error, info) => {
          reports.push(info);
          options.onReport?.(error, info);
        },
      },
      context,
    );
    return sdk;
  });
  const bootTrace = "tr_report_unregistered_boot";
  const rootTrace = "tr_report_unregistered_root_run";
  const handle = await bench.runtime.open(bench.spec(bootTrace));
  const rootEvents: RuntimeEvent[] = [];
  await handle.subscribe(bootTrace, (event) => rootEvents.push(event));
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  try {
    bench.faux.setResponses([text("seed")]);
    await handle.submit({
      requestId: "unregistered_seed",
      text: "seed",
      whenBusy: "followUp",
      trace: bootTrace,
    });
    await waitFor(
      async () => (await handle.submission({ requestId: "unregistered_seed" }))?.status === "done",
      "unregistered child seed",
    );
    const seed = (await handle.replica?.({
      method: "export",
      params: {},
      trace: bootTrace,
    })) as HistoryBundle;
    const contextId = "report_unregistered_child";
    await handle.replica?.({
      method: "context",
      params: { contextId, head: seed.head },
      trace: bootTrace,
    });
    const bundle = (await handle.replica?.({
      method: "export",
      params: { contextId },
      trace: bootTrace,
    })) as HistoryBundle;
    const conversation = await sdk.conversation(
      bundle.source.conversationId as ConversationId,
      BACKGROUND_CONTEXT,
    );
    assert.ok(conversation);
    const cause = new Error("owned unregistered child extension task failure");
    const fault = defineTask<null, { phase: "run" }, null>({
      name: "owned-report-unregistered",
      version: 1,
      initial: () => ({ phase: "run" }),
      phases: {
        run: async (_task, runtime) => {
          runtime.report(cause, { type: "extension", extension: "owned-report-unregistered" });
          throw cause;
        },
      },
      abort: async () => {
        throw cause;
      },
    });
    const extension = defineExtension({ name: "owned-report-unregistered", tasks: [fault] });
    registry.install(extension);
    await conversation.configure({ extensions: { add: [extension] } }, BACKGROUND_CONTEXT);
    let entered = false;
    bench.faux.setResponses([
      async () => {
        entered = true;
        await held;
        return text("root completes");
      },
    ]);
    await handle.submit({
      requestId: "unregistered_root_running",
      text: "keep root active",
      whenBusy: "followUp",
      trace: rootTrace,
    });
    await waitFor(() => entered, "real root provider barrier");
    const taskId = await conversation.commit(
      (tx) => tx.createTask(fault, null, { ownership: { kind: "conversation" } }),
      BACKGROUND_CONTEXT,
    );
    await waitFor(
      () => reports.some((info) => info.type === "task_faulted" && info.task.id === taskId),
      "the real unregistered child reports and faults while root is active",
    );
    assert.ok(
      reports.some(
        (info) =>
          info.type === "extension_error" &&
          info.task?.id === taskId &&
          info.task.conversationId === conversation.id,
      ),
    );
    assert.equal(
      (await handle.submission({ requestId: "unregistered_root_running" }))?.status,
      "placed",
      "the root provider barrier still holds its placed submission",
    );
    assert.ok(handle.context);
    const child = await handle.context(contextId, "tr_report_unregistered_later");
    const childEvents: RuntimeEvent[] = [];
    await child.subscribe("tr_report_unregistered_later", (event) => childEvents.push(event));
    await waitFor(() => of(childEvents, "error").length === 1, "original deferred child failure");
    assert.equal(of(rootEvents, "error").length, 0);
    const error = of(childEvents, "error")[0];
    assert.ok(error);
    const origins = bench.records.filter(
      (record) =>
        record.level === "error" &&
        record.err?.failure === error.failure.id &&
        record.err.origin === true,
    );
    assert.equal(origins.length, 1);
    assert.equal(origins[0]?.botId, bench.spec().id);
    assert.equal(error.taskId, String(taskId));
    assert.equal(error.failure.kind, "extension_error");
    assert.equal(
      error.trace,
      bootTrace,
      "unregistered child never borrows the active root request trace",
    );
    assert.equal(
      origins[0]?.trace,
      bootTrace,
      "the unique original classification uses the same boot trace",
    );
    assert.equal(
      bench.faux.state.callCount,
      2,
      "child report/registration never executes a provider",
    );
  } finally {
    release();
    await handle.close(bootTrace, 5_000);
    await bench.cleanup();
  }
});

test("SDK open reports a SIGKILLed child to its later subscriber while root stays isolated", async (t) => {
  const bench = await createBench({ settings: { restartLimit: 1 } });
  const child = spawn(
    process.execPath,
    ["test/runtime/support/context-report-child.ts", bench.spec().dir],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let errors = "";
  child.stdout.on("data", (part) => {
    output += part.toString();
    assert.ok(output.length < 16_384);
  });
  child.stderr.on("data", (part) => {
    errors += part.toString();
  });
  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  let fixtureRoot: string | undefined;
  let handle: RuntimeHandle | undefined;
  try {
    await waitFor(() => output.includes("\n"), `persistent child is running: ${errors}`, 10_000);
    const ready = JSON.parse(output.trim()) as {
      fixtureRoot: string;
      contextId: string;
      conversationId: number;
      requestId: string;
      submissionId: string;
    };
    fixtureRoot = ready.fixtureRoot;
    child.kill("SIGKILL");
    assert.deepEqual(await exited, { code: null, signal: "SIGKILL" });
    const originalOpen = Harness.open;
    const reports: { info: ReportInfo; beforeReturn: boolean }[] = [];
    t.mock.method(Harness, "open", async (...args: Parameters<typeof Harness.open>) => {
      const [storage, options, context] = args;
      let beforeReturn = true;
      const sdk = await originalOpen(
        storage,
        {
          ...options,
          onReport: (error, info) => {
            reports.push({ info, beforeReturn });
            options.onReport?.(error, info);
          },
        },
        context,
      );
      beforeReturn = false;
      return sdk;
    });
    const bootTrace = "tr_report_child_boot";
    handle = await bench.runtime.open(bench.spec(bootTrace));
    assert.ok(
      reports.some(
        ({ info, beforeReturn }) =>
          beforeReturn &&
          info.type === "task_parked" &&
          info.task.conversationId === ready.conversationId,
      ),
      "real openTasks reports this child before Harness.open returns",
    );
    const rootEvents: RuntimeEvent[] = [];
    await handle.subscribe(bootTrace, (event) => rootEvents.push(event));
    const origins = bench.records.filter(
      (record) =>
        record.level === "error" &&
        record.err?.kind === "task_parked" &&
        record.err.origin === true,
    );
    assert.equal(origins.length, 1);
    assert.equal(origins[0]?.trace, bootTrace, "a cold report retains its boot trace");
    assert.ok(handle.context);
    const selected = await handle.context(ready.contextId, "tr_report_child_later");
    const childEvents: RuntimeEvent[] = [];
    await selected.subscribe("tr_report_child_later", (event) => childEvents.push(event));
    assert.equal(
      (await selected.submission({ requestId: ready.requestId }))?.id,
      ready.submissionId,
    );
    assert.equal(
      bench.faux.state.callCount,
      0,
      "open/registration/subscription never retries the parked run",
    );
    assert.equal(
      of(rootEvents, "error").length,
      0,
      "root cannot consume an unopened child's report",
    );
    const parked = of(childEvents, "error");
    assert.equal(parked.length, 1, "later child registration preserves the report");
    assert.equal(parked[0]?.failure.id, origins[0]?.err?.failure);
    assert.equal(parked[0]?.failure.kind, "task_parked");
    assert.equal(parked[0]?.trace, bootTrace);
    assert.equal(origins[0]?.botId, bench.spec().id);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await handle?.close(trace, 10_000);
    if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true });
    await bench.cleanup();
  }
});

test("cold admission counts persistent work in an unopened context across the whole Bot", async () => {
  const bench = await createBench();
  let handle: RuntimeHandle | undefined;
  let fixtureRoot: string | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const child = spawn(
    process.execPath,
    ["test/runtime/support/context-budget-child.ts", bench.spec().dir],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (part) => {
    output += part.toString();
    assert.ok(output.length < 16_384);
  });
  let errors = "";
  child.stderr.on("data", (part) => {
    errors += part.toString();
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  try {
    await waitFor(
      () => output.includes("\n"),
      `child commits32 original context inputs: ${errors}`,
      10_000,
    );
    const ready = JSON.parse(output.trim()) as {
      fixtureRoot: string;
      first: { id: string };
      pending: number;
    };
    fixtureRoot = ready.fixtureRoot;
    assert.equal(ready.pending, 32);
    child.kill("SIGKILL");
    assert.deepEqual(await exited, { code: null, signal: "SIGKILL" });
    bench.faux.setResponses([
      async () => {
        await gate;
        return text("released answer");
      },
    ]);
    handle = await bench.runtime.open(bench.spec());
    const current = handle;
    const service = new ConversationService({
      open: async () => current,
      measure: (event) => Buffer.byteLength(JSON.stringify(event)),
    });
    const view = await service.subscribe(
      "budget_cold",
      bench.spec().id,
      trace,
      () => {},
      "budget_selected",
    );
    assert.equal(
      view.snapshot.pending.length,
      0,
      "only the other context has been attached after cold open",
    );
    await assert.rejects(
      () =>
        service.send("budget_cold", {
          requestId: "budget_new_after_restart",
          contextId: "budget_selected",
          text: "must not admit",
          whenBusy: "followUp",
          trace,
        }),
      (error: unknown) =>
        error instanceof CommandError &&
        error.kind === "limit_exceeded" &&
        error.disposition === "not_admitted",
      "persistent unopened work still owns the Bot's32 slots",
    );
    const original = {
      requestId: "budget_persisted_0",
      contextId: "budget_unopened",
      text: "pending 0",
      whenBusy: "followUp" as const,
      trace,
    };
    assert.equal(
      (
        await service.submission({
          botId: bench.spec().id,
          requestId: original.requestId,
          contextId: original.contextId,
        })
      )?.id,
      ready.first.id,
    );
    assert.equal(
      (await service.invoke({ ...original, botId: bench.spec().id, origin: { kind: "human" } })).id,
      ready.first.id,
      "same-ID retry is allowed at capacity",
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    release();
    await handle?.close(trace, 10_000);
    if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true });
    await bench.cleanup();
  }
});

test("durable selected contexts use the shared runtime for send, watch, lookup, history and restart without retargeting IDs", async () => {
  const bench = await createBench();
  let handle = await bench.runtime.open(bench.spec());
  try {
    bench.faux.setResponses([text("root seed answer")]);
    await handle.submit({
      requestId: "ctx_root_seed",
      text: "root seed",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      async () => (await handle.submission({ requestId: "ctx_root_seed" }))?.status === "done",
      "seed context",
    );
    const seed = (await handle.replica?.({ method: "export", params: {}, trace })) as HistoryBundle;
    const ids = ["ctx_local_left", "ctx_local_right"] as const;
    const resourceHeads: string[] = [];
    for (const [index, contextId] of ids.entries()) {
      const bytes = Buffer.from(`selected context resources ${index}`);
      const resource = (await handle.replica?.({
        method: "export",
        params: {
          kind: "resources",
          resources: [
            {
              name: "AGENTS.md",
              kind: "instructions",
              sha256: createHash("sha256").update(bytes).digest("hex"),
              base64: bytes.toString("base64"),
            },
          ],
        },
        trace,
      })) as { head: string };
      resourceHeads.push(resource.head);
      const selected = (await handle.replica?.({
        method: "context",
        params: { contextId, head: seed.head, resourceHead: resource.head },
        trace,
      })) as { contextId: string; seedHead: string };
      assert.equal(
        selected?.contextId,
        contextId,
        "the runtime persists a context before admitting input",
      );
      assert.equal(selected.seedHead, seed.head);
      assert.deepEqual(
        await handle.replica?.({
          method: "context",
          params: { contextId, head: seed.head, resourceHead: resource.head },
          trace,
        }),
        selected,
      );
    }
    const [leftResources, rightResources] = resourceHeads;
    assert.ok(leftResources && rightResources);
    assert.ok(handle.context);
    const left = await handle.context(ids[0], trace);
    const right = await handle.context(ids[1], trace);
    await assert.rejects(
      left.submit({
        requestId: "ctx_mismatch",
        contextId: ids[1],
        text: "must not retarget",
        whenBusy: "followUp",
        trace,
      }),
      /context.*conflict/,
    );
    const l = await collect(left);
    const r = await collect(right);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const providerInputs: string[] = [];
    bench.faux.setResponses([
      async (request) => {
        providerInputs.push(JSON.stringify(request.messages));
        await gate;
        return text("left answer");
      },
      (request) => {
        providerInputs.push(JSON.stringify(request.messages));
        return text("other context answer");
      },
      (request) => {
        providerInputs.push(JSON.stringify(request.messages));
        return text("queued left answer");
      },
    ]);
    const a = await handle.submit({
      requestId: "ctx_send_left_1",
      contextId: ids[0],
      resourceHead: leftResources,
      text: "left first",
      whenBusy: "followUp",
      trace,
    });
    const queued = await left.submit({
      requestId: "ctx_send_left_2",
      text: "left queued",
      whenBusy: "followUp",
      trace,
    });
    assert.equal(queued.status, "queued");
    await right.submit({
      requestId: "ctx_send_right_1",
      text: "right first",
      whenBusy: "followUp",
      trace,
    });
    assert.equal((await handle.busy()).run, true, "whole-bot lifecycle sees context work");
    release();
    await waitFor(
      async () =>
        (await left.submission({ requestId: "ctx_send_left_2" }))?.status === "done" &&
        (await right.submission({ requestId: "ctx_send_right_1" }))?.status === "done",
      "both contextual queues",
    );
    assert.equal(
      (await handle.history({ limit: 50 })).messages.some((message) =>
        JSON.stringify(message).includes("left first"),
      ),
      false,
    );
    assert.equal(
      (await right.history({ limit: 50 })).messages.some((message) =>
        JSON.stringify(message).includes("left first"),
      ),
      false,
    );
    assert.ok(
      of(l.events, "append").some((event) => JSON.stringify(event.message).includes("left first")),
    );
    assert.equal(
      of(l.events, "append").some((event) => JSON.stringify(event.message).includes("right first")),
      false,
    );
    assert.ok(
      of(r.events, "append").some((event) => JSON.stringify(event.message).includes("right first")),
    );
    assert.ok(a.entryId && (await left.entryById?.(a.entryId)));
    assert.equal(await right.entryById?.(a.entryId), undefined);
    for (const input of providerInputs) {
      if (input.includes('"right first"')) assert.match(input, /selected context resources 1/);
      else assert.match(input, /selected context resources 0/);
    }
    const tip = (await handle.replica?.({
      method: "export",
      params: { contextId: ids[0] },
      trace,
    })) as HistoryBundle;
    assert.ok(JSON.stringify(tip).includes("left first"));
    assert.deepEqual(tip.parents, [seed.head]);
    await handle.close(trace, 5000);
    handle = await bench.runtime.open(bench.spec());
    const count = bench.faux.state.callCount;
    const found = await handle.submission({ requestId: "ctx_send_left_1", contextId: ids[0] });
    assert.equal(found?.id, a.id);
    assert.equal(found?.status, "done");
    const replay = await handle.submit({
      requestId: "ctx_send_left_1",
      contextId: ids[0],
      resourceHead: leftResources,
      text: "left first",
      whenBusy: "followUp",
      trace,
    });
    assert.equal(replay.id, a.id);
    assert.equal(bench.faux.state.callCount, count);
    await assert.rejects(
      handle.submit({
        requestId: "ctx_send_left_1",
        contextId: ids[1],
        text: "left first",
        whenBusy: "followUp",
        trace,
      }),
      /binding conflict/,
    );
    await assert.rejects(
      handle.submit({
        requestId: "ctx_send_left_1",
        contextId: ids[0],
        resourceHead: rightResources,
        text: "left first",
        whenBusy: "followUp",
        trace,
      }),
      /binding conflict/,
    );
    assert.deepEqual(
      await handle.replica?.({ method: "export", params: { contextId: ids[0] }, trace }),
      tip,
    );
  } finally {
    await handle.close(trace, 5000);
    await bench.cleanup();
  }
});

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
    assert.match(record.entryId ?? "", /^e_\d+$/);
    assert.equal(record.entryId, appends[0]?.message.id);
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
