// Ladder rows 17-18: a command needs a subscription, and a send is idempotent by
// requestId while its reply stays connection-scoped.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DirectoryError } from "../../src/core/BotDirectory.ts";
import {
  CommandError,
  ConversationService,
  RESERVATION_TTL_MS,
} from "../../src/core/ConversationService.ts";
import type {
  ConversationSnapshot,
  Message,
  SecretSave,
  SecretsPort,
  Submission,
} from "../../src/core/domain.ts";
import { ClassifiedFailure, SecretsStorageError } from "../../src/core/domain.ts";
import type { HubEvent } from "../../src/core/EventHub.ts";
import { SubscriberTooSlow } from "../../src/core/EventHub.ts";
import type { RuntimeEvent, RuntimeHandle, SubmitInput } from "../../src/core/RuntimePort.ts";
import type { SecretAnswerInput } from "../../src/core/secretCard.ts";
import { encodeServerEvent } from "../../src/protocol/encode.ts";
import { SecretsStore } from "../../src/secrets/store.ts";
import { FakeRuntime } from "../../src/testing/FakeRuntime.ts";

const trace = "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172";
const requestId = "r_0190a1b4-5061-7c72-8d3e-4f5061728394";

const utf8 = (event: RuntimeEvent): number => Buffer.byteLength(JSON.stringify(event), "utf8");

const serviceFor = (runtime: FakeRuntime): ConversationService =>
  new ConversationService({
    open: (botId, openTrace) =>
      runtime.open({
        id: botId,
        dir: `/tmp/${botId}`,
        model: { provider: "faux", modelId: "faux-1" },
        trace: openTrace,
      }),
    measure: utf8,
  });

const subscribe = async (
  service: ConversationService,
  received: HubEvent[],
  connectionId = "c_1",
  botId = "b_1",
) => service.subscribe(connectionId, botId, trace, (event) => received.push(event));

const message = (id: string) => ({
  id,
  role: "user" as const,
  state: "complete" as const,
  createdAt: "x",
  blocks: [{ type: "text" as const, text: id }],
});

/**
 * A scripted runtime handle that forwards raw events, so a case observes the service's
 * own fold instead of the fake runtime's copy of it.
 */
const scriptedHandle = (options: {
  readonly snapshot: ConversationSnapshot;
  readonly record?: (input: SubmitInput) => Submission;
  readonly onSubmit?: (input: SubmitInput) => RuntimeEvent[];
}): { handle: RuntimeHandle; emit: (event: RuntimeEvent) => void } => {
  let sink: ((event: RuntimeEvent) => void) | undefined;
  const handle: RuntimeHandle = {
    refreshTools: async () => {},
    subscribe: async (_trace, next) => {
      sink = next;
      return {
        snapshot: options.snapshot,
        detach: () => {
          sink = undefined;
        },
      };
    },
    submission: async () => undefined,
    submit: async (input) => {
      for (const event of options.onSubmit?.(input) ?? []) sink?.(event);
      return options.record?.(input) ?? { id: "s_1", requestId: input.requestId, status: "queued" };
    },
    history: async () => ({ messages: [], hasMore: false }),
    abort: async () => {},
    recover: async () => {},
    busy: async () => ({ run: false, tasks: false }),
    close: async () => "closed",
  };
  return { handle, emit: (event) => sink?.(event) };
};

/** A delegating handle: spreading a class instance would lose its private fields. */
const proxyHandle = (
  handle: RuntimeHandle,
  overrides: Partial<RuntimeHandle> = {},
): RuntimeHandle => ({
  refreshTools: (trace) => handle.refreshTools(trace),
  subscribe: (subscribeTrace, sink) => handle.subscribe(subscribeTrace, sink),
  submit: (input) => handle.submit(input),
  submission: (key) => handle.submission(key),
  history: (input) => handle.history(input),
  abort: (abortTrace) => handle.abort(abortTrace),
  recover: (recoverTrace) => handle.recover(recoverTrace),
  busy: () => handle.busy(),
  close: (closeTrace, deadlineMs) => handle.close(closeTrace, deadlineMs),
  ...overrides,
});

test("send requires a subscription and answers a connection-scoped record", async () => {
  const runtime = new FakeRuntime();
  const service = serviceFor(runtime);
  await assert.rejects(
    () => service.send("c_1", { requestId, text: "hi", whenBusy: "followUp", trace }),
    (error: unknown) =>
      error instanceof CommandError &&
      error.kind === "invalid_command" &&
      error.disposition === "not_admitted" &&
      error.requestId === requestId &&
      /^f_[A-Za-z0-9_-]{1,32}$/.test(error.failure.id) &&
      error.failure.kind === "invalid_command",
  );
  assert.equal(runtime.handles.size, 0, "an unsubscribed command opens no bot");

  const received: HubEvent[] = [];
  const joined = await subscribe(service, received);
  assert.deepEqual(
    received.map((event) => [event.type, event.rev]),
    [["snapshot", 1]],
    "the subscription starts from a snapshot at the current revision",
  );
  assert.equal(joined.rev, 1);
  assert.deepEqual(joined.snapshot.messages, []);

  const record = await service.send("c_1", {
    requestId,
    text: "hi",
    whenBusy: "followUp",
    trace,
  });
  assert.deepEqual(record, { id: "s_1", requestId, status: "queued" });
  assert.equal("rev" in record, false, "a connection-scoped reply carries no revision");
});

test("switching A to B to cached A refreshes tools without replacing the runtime watch", async () => {
  const runtime = new FakeRuntime();
  const refreshes: string[] = [];
  const watches: string[] = [];
  const service = new ConversationService({
    measure: utf8,
    open: async (id, openTrace) => {
      const handle = await runtime.open({
        id,
        dir: `/tmp/${id}`,
        model: { provider: "faux", modelId: "faux-1" },
        trace: openTrace,
      });
      return proxyHandle(handle, {
        refreshTools: async (refreshTrace) => {
          refreshes.push(`${id}:${refreshTrace}`);
        },
        subscribe: (subscribeTrace, sink) => {
          watches.push(id);
          return handle.subscribe(subscribeTrace, sink);
        },
      });
    },
  });
  for (const id of ["b_a", "b_b", "b_a"]) {
    const frames: HubEvent[] = [];
    await service.subscribe("c_switch", id, trace, (event) => frames.push(event));
    assert.equal(frames[0]?.type, "snapshot");
    service.unsubscribe("c_switch");
  }
  assert.deepEqual(refreshes, [`b_a:${trace}`, `b_b:${trace}`, `b_a:${trace}`]);
  assert.deepEqual(watches, ["b_a", "b_b"]);
});

test("a failed tool refresh sends no baseline and permits retrying the same connection", async () => {
  const runtime = new FakeRuntime();
  let fail = true;
  const service = new ConversationService({
    measure: utf8,
    open: async (id, openTrace) =>
      proxyHandle(
        await runtime.open({
          id,
          dir: `/tmp/${id}`,
          model: { provider: "faux", modelId: "faux-1" },
          trace: openTrace,
        }),
        {
          refreshTools: async () => {
            if (fail) throw new Error("refresh refused");
          },
        },
      ),
  });
  const frames: HubEvent[] = [];
  await assert.rejects(subscribe(service, frames), /refresh refused/);
  assert.equal(frames.length, 0);
  fail = false;
  await subscribe(service, frames);
  assert.equal(frames[0]?.type, "snapshot");
  service.unsubscribe("c_1");
});

test("a repeated send with the same requestId returns the stored record and emits nothing", async () => {
  const runtime = new FakeRuntime({
    script: {
      onSubmit: (input) => [
        {
          type: "submission",
          trace: input.trace,
          record: { id: "s_1", requestId: input.requestId, status: "placed", entryId: "e_1" },
        },
      ],
    },
  });
  const service = serviceFor(runtime);
  const received: HubEvent[] = [];
  await subscribe(service, received);

  const first = await service.send("c_1", { requestId, text: "hi", whenBusy: "followUp", trace });
  assert.deepEqual(first, { id: "s_1", requestId, status: "placed", entryId: "e_1" });
  const eventsAfterFirst = received.length;
  assert.deepEqual(
    received.map((event) => [event.type, event.rev]),
    [
      ["snapshot", 1],
      ["submission", 2],
    ],
    "admission is broadcast on the hub",
  );

  const second = await service.send("c_1", { requestId, text: "hi", whenBusy: "followUp", trace });
  assert.deepEqual(second, first, "the stored record is the reply");
  assert.equal(received.length, eventsAfterFirst, "a duplicate emits no new event");
  assert.equal(runtime.handle("b_1").snapshot.pending.length, 1);
});

test("one connection cannot subscribe twice", async () => {
  const service = serviceFor(new FakeRuntime());
  await subscribe(service, []);
  await assert.rejects(
    () => subscribe(service, [], "c_1", "b_2"),
    (error: unknown) => error instanceof CommandError && error.kind === "invalid_command",
  );
});

test("an unsubscribed connection is refused and receives nothing more", async () => {
  const runtime = new FakeRuntime();
  const service = serviceFor(runtime);
  const received: HubEvent[] = [];
  await subscribe(service, received);
  service.unsubscribe("c_1");
  await assert.rejects(
    () => service.send("c_1", { requestId, text: "hi", whenBusy: "followUp", trace }),
    (error: unknown) =>
      error instanceof CommandError &&
      error.disposition === "not_admitted" &&
      error.requestId === requestId,
  );
  runtime.handle("b_1").emit({ type: "status", trace, running: true, streaming: null, inbox: [] });
  assert.deepEqual(
    received.map((event) => event.type),
    ["snapshot"],
    "a detached sink stops receiving",
  );
});

test("a failed open does not poison the next attempt", async () => {
  let attempts = 0;
  const runtime = new FakeRuntime();
  const service = new ConversationService({
    open: async (botId, openTrace) => {
      attempts += 1;
      if (attempts === 1) throw new Error("sqlite is busy");
      return runtime.open({
        id: botId,
        dir: `/tmp/${botId}`,
        model: { provider: "faux", modelId: "faux-1" },
        trace: openTrace,
      });
    },
    measure: utf8,
  });
  // A bot that cannot open is unavailable, not a failed connection: the client sees the
  // reason and can recover it (PROTOCOL.md, "Subscription").
  const refused = await subscribe(service, []);
  assert.equal(refused.snapshot.unavailable?.reason, "storage_failed");
  assert.deepEqual(refused.snapshot.messages, []);
  const received: HubEvent[] = [];
  await subscribe(service, received, "c_recover");
  const before = received.length;
  await service.recover("c_recover", "tr_recover_1");
  assert.equal(attempts, 2, "recover re-opens the harness");
  assert.deepEqual(
    received.slice(before).map((event) => event.type),
    ["snapshot"],
    "recover broadcasts the new view",
  );
});

test("an event delivered while opening is already in the baseline a client first sees", async () => {
  const runtime = new FakeRuntime();
  const service = new ConversationService({
    open: async (botId, openTrace) => {
      const handle = await runtime.open({
        id: botId,
        dir: `/tmp/${botId}`,
        model: { provider: "faux", modelId: "faux-1" },
        trace: openTrace,
      });
      return proxyHandle(handle, {
        subscribe: async (subscribeTrace, sink) => {
          const subscription = await handle.subscribe(subscribeTrace, sink);
          sink({
            type: "status",
            trace: subscribeTrace,
            running: true,
            streaming: null,
            inbox: [],
          });
          return subscription;
        },
      });
    },
    measure: utf8,
  });
  const received: HubEvent[] = [];
  const joined = await subscribe(service, received);
  assert.deepEqual(
    received.map((event) => [event.type, event.rev]),
    [["snapshot", 2]],
    "a commit that arrives during the open is folded into the baseline, not sent before it",
  );
  assert.equal(joined.rev, 2, "the baseline carries the revision that names its content");
  assert.equal(joined.snapshot.running, true, "the baseline carries the run that already started");
});

test("a later connection starts from the current view, not the open-time snapshot", async () => {
  const runtime = new FakeRuntime();
  const service = serviceFor(runtime);
  const first: HubEvent[] = [];
  await subscribe(service, first);
  runtime.handle("b_1").emit({ type: "append", trace, message: message("e_1") });

  const second: HubEvent[] = [];
  const joined = await service.subscribe("c_2", "b_1", trace, (event) => second.push(event));
  assert.deepEqual(
    joined.snapshot.messages.map((entry) => entry.id),
    ["e_1"],
    "the baseline is the current view",
  );
  assert.deepEqual(
    second.map((event) => event.type),
    ["snapshot"],
  );
  assert.deepEqual(
    second[0]?.type === "snapshot" ? second[0].value.messages.map((entry) => entry.id) : [],
    ["e_1"],
    "the new connection is told about the message, not shown an empty snapshot",
  );
});

test("a concurrent second subscribe on one connection is refused", async () => {
  const service = serviceFor(new FakeRuntime());
  const first = service.subscribe("c_1", "b_1", trace, () => {});
  const second = service.subscribe("c_1", "b_2", trace, () => {});
  await assert.rejects(
    second,
    (error: unknown) => error instanceof CommandError && error.disposition === "not_admitted",
  );
  await first;
});

test("unsubscribing while the open is in flight cancels the subscription", async () => {
  const runtime = new FakeRuntime();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = new ConversationService({
    open: async (botId, openTrace) => {
      await gate;
      return runtime.open({
        id: botId,
        dir: `/tmp/${botId}`,
        model: { provider: "faux", modelId: "faux-1" },
        trace: openTrace,
      });
    },
    measure: utf8,
  });
  const received: HubEvent[] = [];
  const pending = service.subscribe("c_1", "b_1", trace, (event) => received.push(event));
  service.unsubscribe("c_1");
  release?.();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof CommandError && error.kind === "internal",
  );
  runtime.handle("b_1").emit({ type: "status", trace, running: true, streaming: null, inbox: [] });
  assert.deepEqual(received, [], "a cancelled subscription is never attached");
});

test("the baseline snapshot is the first frame and its revision is returned", async () => {
  const runtime = new FakeRuntime();
  const service = serviceFor(runtime);
  await subscribe(service, []);
  runtime.handle("b_1").emit({
    type: "delta",
    trace,
    messageId: "p_a1",
    changes: [{ kind: "text", index: 0, append: "x" }],
  });
  const second: HubEvent[] = [];
  const joined = await service.subscribe("c_2", "b_1", trace, (event) => {
    second.push(event);
    if (event.type === "snapshot") {
      runtime
        .handle("b_1")
        .emit({ type: "status", trace, running: true, streaming: null, inbox: [] });
    }
  });
  assert.equal(second[0]?.type, "snapshot", "the coalescing window cannot precede the baseline");
  assert.equal(
    joined.rev,
    second[0]?.rev,
    "the returned revision is the baseline's, not the latest",
  );
  assert.deepEqual(
    second.map((event) => event.type),
    ["snapshot", "status"],
    "an event published from the snapshot callback lands after the baseline",
  );
});

test("a commit published from the baseline callback lands after it", async () => {
  const runtime = new FakeRuntime();
  const service = new ConversationService({
    open: async (botId, openTrace) => {
      const handle = await runtime.open({
        id: botId,
        dir: `/tmp/${botId}`,
        model: { provider: "faux", modelId: "faux-1" },
        trace: openTrace,
      });
      return proxyHandle(handle, {
        subscribe: async (subscribeTrace, sink) => {
          const subscription = await handle.subscribe(subscribeTrace, sink);
          sink({ type: "append", trace: subscribeTrace, message: message("e_1") });
          sink({
            type: "snapshot",
            trace: subscribeTrace,
            value: {
              botId,
              messages: [message("e_1"), message("e_2")],
              streaming: null,
              pending: [],
              inbox: [],
              running: false,
            },
          });
          return subscription;
        },
      });
    },
    measure: utf8,
  });
  const seen: string[] = [];
  await service.subscribe("c_1", "b_1", trace, (event) => {
    seen.push(event.type === "append" ? event.message.id : event.type);
    if (event.type === "snapshot") {
      runtime.handle("b_1").emit({ type: "append", trace, message: message("e_3") });
    }
  });
  assert.deepEqual(
    seen,
    ["snapshot", "e_3"],
    "commits that landed during the open are in the baseline; one produced by its sink follows it",
  );
  const joined = await service.subscribe("c_2", "b_1", trace, () => {});
  assert.deepEqual(
    joined.snapshot.messages.map((entry) => entry.id),
    ["e_1", "e_2", "e_3"],
    "the view kept the event that arrived during the release",
  );
});

test("a failed admission answers an unknown disposition instead of escaping", async () => {
  const runtime = new FakeRuntime();
  const service = new ConversationService({
    open: async (botId, openTrace) => {
      const handle = await runtime.open({
        id: botId,
        dir: `/tmp/${botId}`,
        model: { provider: "faux", modelId: "faux-1" },
        trace: openTrace,
      });
      return proxyHandle(handle, {
        submission: async () => {
          throw new Error("sqlite is busy");
        },
        submit: async () => {
          throw new Error("save failed");
        },
      });
    },
    measure: utf8,
  });
  await subscribe(service, []);
  await assert.rejects(
    () => service.send("c_1", { requestId, text: "hi", whenBusy: "followUp", trace }),
    (error: unknown) =>
      error instanceof CommandError &&
      error.kind === "internal" &&
      error.disposition === "unknown" &&
      error.requestId === requestId &&
      /^f_[A-Za-z0-9_-]{1,32}$/.test(error.failure.id),
  );
});

test("a submit that fails after the read is unconfirmed admission, not a refusal", async () => {
  const runtime = new FakeRuntime();
  const service = new ConversationService({
    open: async (botId, openTrace) => {
      const handle = await runtime.open({
        id: botId,
        dir: `/tmp/${botId}`,
        model: { provider: "faux", modelId: "faux-1" },
        trace: openTrace,
      });
      return proxyHandle(handle, {
        submission: async () => undefined,
        submit: async () => {
          throw new Error("save failed");
        },
      });
    },
    measure: utf8,
  });
  await subscribe(service, []);
  await assert.rejects(
    () => service.send("c_1", { requestId, text: "hi", whenBusy: "followUp", trace }),
    (error: unknown) =>
      error instanceof CommandError &&
      error.disposition === "unknown" &&
      error.requestId === requestId &&
      error.cause instanceof Error,
  );
});

test("a delta flushed for an older connection cannot precede a new baseline", async () => {
  const runtime = new FakeRuntime();
  const service = serviceFor(runtime);
  let reentered = false;
  await service.subscribe("c_1", "b_1", trace, (event) => {
    if (event.type !== "delta" || reentered) return;
    reentered = true;
    runtime.handle("b_1").emit({
      type: "delta",
      trace,
      messageId: "p_a1",
      changes: [{ kind: "text", index: 0, append: "B" }],
    });
  });
  runtime.handle("b_1").emit({
    type: "delta",
    trace,
    messageId: "p_a1",
    changes: [{ kind: "text", index: 0, append: "A" }],
  });
  const second: HubEvent[] = [];
  const joined = await service.subscribe("c_2", "b_1", trace, (event) => second.push(event));
  assert.deepEqual(
    second.map((event) => event.type),
    ["snapshot"],
    "the flush and its reentrant sibling stay out of the new connection",
  );
  assert.equal(joined.rev, second[0]?.rev);
});

test("a connection cancelled by a flush is not attached", async () => {
  const runtime = new FakeRuntime();
  const service = serviceFor(runtime);
  await service.subscribe("c_1", "b_1", trace, (event) => {
    if (event.type === "delta") service.unsubscribe("c_2");
  });
  runtime.handle("b_1").emit({
    type: "delta",
    trace,
    messageId: "p_a1",
    changes: [{ kind: "text", index: 0, append: "A" }],
  });
  const received: HubEvent[] = [];
  await assert.rejects(
    () => service.subscribe("c_2", "b_1", trace, (event) => received.push(event)),
    (error: unknown) => error instanceof CommandError && error.kind === "internal",
  );
  assert.deepEqual(received, [], "a cancelled connection never receives a frame");
});

test("a classified failure keeps its identity and disposition", async () => {
  const snapshot: ConversationSnapshot = {
    botId: "b_1",
    messages: [],
    streaming: null,
    pending: [],
    inbox: [],
    running: false,
  };
  const storage = new ClassifiedFailure(
    { id: "f_episode", kind: "storage_failed", layer: "runtime" },
    "runtime",
    "disk is full",
  );
  const busy = new ClassifiedFailure(
    { id: "f_busy", kind: "invalid_command", layer: "core" },
    "not_admitted",
    "busy with reject",
  );
  const reading = scriptedHandle({ snapshot });
  const service = new ConversationService({
    open: async () => ({
      ...reading.handle,
      subscribe: async (subscribeTrace, sink) => {
        const subscription = await reading.handle.subscribe(subscribeTrace, sink);
        return subscription;
      },
      submission: async () => {
        throw storage;
      },
      submit: async () => {
        throw busy;
      },
    }),
    measure: utf8,
  });
  await subscribe(service, []);
  await assert.rejects(
    () => service.send("c_1", { requestId, text: "hi", whenBusy: "followUp", trace }),
    (error: unknown) => error === storage,
    "a runtime-classified read failure is not rewritten",
  );
  const writing = scriptedHandle({ snapshot });
  const second = new ConversationService({
    open: async () => ({
      ...writing.handle,
      submission: async () => undefined,
      submit: async () => {
        throw busy;
      },
    }),
    measure: utf8,
  });
  await subscribe(second, []);
  await assert.rejects(
    () => second.send("c_1", { requestId, text: "hi", whenBusy: "followUp", trace }),
    (error: unknown) => error === busy,
    "an explicit refusal keeps not_admitted so the outbox entry can be restored",
  );
});

test("a stale snapshot cannot downgrade a settlement for the connection or a new one", async () => {
  const snapshot: ConversationSnapshot = {
    botId: "b_1",
    messages: [],
    streaming: null,
    pending: [],
    inbox: [],
    running: false,
  };
  const settled = (input: SubmitInput): Submission => ({
    id: "s_1",
    requestId: input.requestId,
    status: "done",
    entryId: "e_1",
    answerEntryId: "e_2",
  });
  const scripted = scriptedHandle({
    snapshot,
    record: settled,
    onSubmit: (input) => [{ type: "submission", trace: input.trace, record: settled(input) }],
  });
  const service = new ConversationService({ open: async () => scripted.handle, measure: utf8 });
  const received: HubEvent[] = [];
  await subscribe(service, received);
  await service.send("c_1", { requestId, text: "hi", whenBusy: "followUp", trace });
  scripted.emit({
    type: "snapshot",
    trace,
    value: { ...snapshot, pending: [{ id: "s_1", requestId, status: "queued" }] },
  });
  const broadcast = received.filter((event) => event.type === "snapshot").at(-1);
  assert.deepEqual(
    broadcast?.type === "snapshot" ? broadcast.value.pending : ["unchecked"],
    [],
    "the existing connection is broadcast a normalized snapshot",
  );
  const joined = await service.subscribe("c_2", "b_1", trace, () => {});
  assert.deepEqual(joined.snapshot.pending, [], "a new connection's baseline stays settled");
});

test("a stale snapshot keeps the placed record with its entry id", async () => {
  const snapshot: ConversationSnapshot = {
    botId: "b_1",
    messages: [],
    streaming: null,
    pending: [],
    inbox: [],
    running: false,
  };
  const placed = (input: SubmitInput): Submission => ({
    id: "s_1",
    requestId: input.requestId,
    status: "placed",
    entryId: "e_1",
  });
  const scripted = scriptedHandle({
    snapshot,
    record: placed,
    onSubmit: (input) => [{ type: "submission", trace: input.trace, record: placed(input) }],
  });
  const service = new ConversationService({ open: async () => scripted.handle, measure: utf8 });
  const received: HubEvent[] = [];
  await subscribe(service, received);
  await service.send("c_1", { requestId, text: "hi", whenBusy: "followUp", trace });
  scripted.emit({
    type: "snapshot",
    trace,
    value: { ...snapshot, pending: [{ id: "s_1", requestId, status: "queued" }] },
  });
  const expected = [{ id: "s_1", requestId, status: "placed", entryId: "e_1" }];
  const broadcast = received.filter((event) => event.type === "snapshot").at(-1);
  assert.deepEqual(
    broadcast?.type === "snapshot" ? broadcast.value.pending : ["unchecked"],
    expected,
  );
  const joined = await service.subscribe("c_2", "b_1", trace, () => {});
  assert.deepEqual(joined.snapshot.pending, expected);
});

test("the rank of the initial snapshot is seeded, so a duplicate cannot downgrade it", async () => {
  const snapshot: ConversationSnapshot = {
    botId: "b_1",
    messages: [],
    streaming: null,
    pending: [{ id: "s_9", requestId, status: "placed", entryId: "e_1" }],
    inbox: [],
    running: false,
  };
  const scripted = scriptedHandle({ snapshot });
  const service = new ConversationService({ open: async () => scripted.handle, measure: utf8 });
  await subscribe(service, []);
  scripted.emit({
    type: "submission",
    trace,
    record: { id: "s_9", requestId, status: "queued" },
  });
  const joined = await service.subscribe("c_2", "b_1", trace, () => {});
  assert.deepEqual(joined.snapshot.pending, snapshot.pending);
});

test("a runtime snapshot seeds ranks for records a connection never saw", async () => {
  const base: ConversationSnapshot = {
    botId: "b_1",
    messages: [],
    streaming: null,
    pending: [],
    inbox: [],
    running: false,
  };
  const scripted = scriptedHandle({ snapshot: base });
  const service = new ConversationService({ open: async () => scripted.handle, measure: utf8 });
  const received: HubEvent[] = [];
  await subscribe(service, received);
  scripted.emit({
    type: "snapshot",
    trace,
    value: {
      ...base,
      pending: [{ id: "s_4", requestId, status: "placed", entryId: "e_7" }],
    },
  });
  scripted.emit({
    type: "submission",
    trace,
    record: { id: "s_4", requestId, status: "queued" },
  });
  const expected = [{ id: "s_4", requestId, status: "placed", entryId: "e_7" }];
  const joined = await service.subscribe("c_2", "b_1", trace, () => {});
  assert.deepEqual(joined.snapshot.pending, expected);
  const broadcast = received.filter((event) => event.type === "snapshot").at(-1);
  assert.deepEqual(
    broadcast?.type === "snapshot" ? broadcast.value.pending : ["unchecked"],
    expected,
  );
});

test("queued, placed and done keep one submission id and settle the pending list", async () => {
  const runtime = new FakeRuntime({
    script: {
      onSubmit: (input) => [
        {
          type: "submission",
          trace: input.trace,
          record: { id: "s_1", requestId: input.requestId, status: "queued" },
        },
        {
          type: "submission",
          trace: input.trace,
          record: {
            id: "s_1",
            requestId: input.requestId,
            status: "placed",
            entryId: "e_1",
          },
        },
        {
          type: "submission",
          trace: input.trace,
          record: {
            id: "s_1",
            requestId: input.requestId,
            status: "done",
            entryId: "e_1",
            answerEntryId: "e_2",
          },
        },
      ],
    },
  });
  const service = serviceFor(runtime);
  const received: HubEvent[] = [];
  await subscribe(service, received);
  const reply = await service.send("c_1", { requestId, text: "hi", whenBusy: "followUp", trace });
  const records = received.flatMap((event) => (event.type === "submission" ? [event.record] : []));
  assert.deepEqual(
    records.map((record) => [record.id, record.status]),
    [
      ["s_1", "queued"],
      ["s_1", "placed"],
      ["s_1", "done"],
    ],
    "one submission id across every status",
  );
  assert.equal(reply.id, "s_1");
  assert.equal(reply.status, "done", "the reply may already carry the settlement");

  const later: HubEvent[] = [];
  const joined = await service.subscribe("c_2", "b_1", trace, (event) => later.push(event));
  assert.deepEqual(
    joined.snapshot.pending,
    [],
    "a settled submission is not pending for a new joiner",
  );
  assert.deepEqual(
    later.map((event) => event.type),
    ["snapshot"],
  );
});

test("unanswered keeps its reason and a late queued record cannot resurrect it", async () => {
  const runtime = new FakeRuntime({
    script: {
      onSubmit: (input) => [
        {
          type: "submission",
          trace: input.trace,
          record: { id: "s_1", requestId: input.requestId, status: "queued" },
        },
        {
          type: "submission",
          trace: input.trace,
          record: {
            id: "s_1",
            requestId: input.requestId,
            status: "unanswered",
            reason: "model_error",
          },
        },
      ],
    },
  });
  const service = serviceFor(runtime);
  const received: HubEvent[] = [];
  await subscribe(service, received);
  const reply = await service.send("c_1", { requestId, text: "hi", whenBusy: "followUp", trace });
  assert.equal(reply.status, "unanswered");
  assert.equal(reply.reason, "model_error");
  assert.equal(reply.answerEntryId, undefined, "no settlement is invented");
  const statuses = received.flatMap((event) =>
    event.type === "submission" ? [event.record.status] : [],
  );
  assert.deepEqual(statuses, ["queued", "unanswered"]);
  assert.equal(statuses.includes("done"), false);

  runtime.handle("b_1").emit({
    type: "submission",
    trace,
    record: { id: "s_1", requestId, status: "queued" },
  });
  const joined = await service.subscribe("c_2", "b_1", trace, () => {});
  assert.deepEqual(
    joined.snapshot.pending,
    [],
    "a ranked-lower duplicate never becomes pending again",
  );
});
test("a runtime error never fabricates a settlement", async () => {
  const runtime = new FakeRuntime({
    script: {
      onSubmit: (input) => [
        {
          type: "submission",
          trace: input.trace,
          record: { id: "s_1", requestId: input.requestId, status: "queued" },
        },
      ],
    },
  });
  const service = serviceFor(runtime);
  const received: HubEvent[] = [];
  await subscribe(service, received);
  await service.send("c_1", { requestId, text: "hi", whenBusy: "followUp", trace });
  runtime.handle("b_1").emit({
    type: "error",
    trace,
    failure: { id: "f_7f3a", kind: "task_parked", layer: "runtime" },
    message: "a task is parked",
  });
  const joined = await service.subscribe("c_2", "b_1", trace, () => {});
  assert.deepEqual(
    joined.snapshot.pending.map((record) => [record.id, record.status]),
    [["s_1", "queued"]],
    "an error does not settle the submission",
  );
  assert.deepEqual(
    received.flatMap((event) => (event.type === "submission" ? [event.record.status] : [])),
    ["queued"],
  );
});

test("history pages older messages without touching the newest window", async () => {
  const runtime = new FakeRuntime();
  const service = serviceFor(runtime);
  const received: HubEvent[] = [];
  await subscribe(service, received);
  const handle = runtime.handle("b_1");
  for (const id of ["e_1", "e_2", "e_3"]) {
    handle.emit({ type: "append", trace, message: message(id) });
  }
  const revBefore = received.at(-1)?.rev;
  const page = await service.history("c_1", { beforeEntryId: "e_3", limit: 1 }, trace);
  assert.deepEqual(
    page.messages.map((entry) => entry.id),
    ["e_2"],
  );
  assert.equal(page.hasMore, true);
  assert.equal(received.at(-1)?.rev, revBefore, "paging publishes nothing");

  const joined = await service.subscribe("c_2", "b_1", trace, () => {});
  assert.deepEqual(
    joined.snapshot.messages.map((entry) => entry.id),
    ["e_1", "e_2", "e_3"],
    "the newest window is untouched by a history page",
  );
});

test("resync broadcasts the snapshot with the command trace", async () => {
  const runtime = new FakeRuntime();
  const service = serviceFor(runtime);
  const received: HubEvent[] = [];
  await subscribe(service, received);
  runtime.handle("b_1").emit({ type: "status", trace, running: true, streaming: null, inbox: [] });
  const commandTrace = "tr_0190a1b5-6172-7d83-9e4f-506172839405";
  const answer = service.resync("c_1", commandTrace);
  const last = received.at(-1);
  assert.equal(answer, undefined, "the broadcast is the only reply");
  assert.equal(last?.type, "snapshot");
  assert.equal(last?.trace, commandTrace);
  assert.equal(
    last?.type === "snapshot" ? last.value.running : undefined,
    true,
    "the snapshot names the state it carries",
  );
});

test("resync folds a pending delta before it names the revision", async () => {
  const runtime = new FakeRuntime();
  const service = serviceFor(runtime);
  const received: HubEvent[] = [];
  await subscribe(service, received);
  runtime.handle("b_1").emit({ type: "append", trace, message: message("e_1") });
  runtime.handle("b_1").emit({
    type: "delta",
    trace,
    messageId: "e_1",
    changes: [{ kind: "text", index: 0, append: "!" }],
  });
  service.resync("c_1", trace);
  assert.deepEqual(
    received.map((event) => event.type),
    ["snapshot", "append", "delta", "snapshot"],
    "the delta is broadcast, not skipped",
  );
  const snapshot = received.at(-1);
  const block = snapshot?.type === "snapshot" ? snapshot.value.messages[0]?.blocks[0] : undefined;
  assert.equal(block?.type === "text" ? block.text : "", "e_1!", "the snapshot covers that delta");
});

test("resync answers a snapshot that is complete for its window", async () => {
  const streaming = {
    id: "p_a1",
    role: "assistant" as const,
    state: "streaming" as const,
    createdAt: "x",
    blocks: [{ type: "text" as const, text: "half" }],
  };
  const complete: ConversationSnapshot = {
    botId: "b_1",
    messages: [message("e_0"), message("e_1"), streaming],
    truncatedBefore: "e_0",
    streaming: "p_a1",
    pending: [{ id: "s_1", requestId, status: "placed", entryId: "e_1" }],
    inbox: [{ id: "i_1", mode: "followUp" }],
    running: true,
  };
  const scripted = scriptedHandle({ snapshot: complete });
  const service = new ConversationService({ open: async () => scripted.handle, measure: utf8 });
  const received: HubEvent[] = [];
  await subscribe(service, received);
  service.resync("c_1", trace);
  const snapshot = received.at(-1);
  assert.deepEqual(
    snapshot?.type === "snapshot" ? snapshot.value : undefined,
    complete,
    "the client receives provisional, pending, inbox and paging intact",
  );
});

test("a reentrant delta during resync is numbered after the snapshot and applies once", async () => {
  const runtime = new FakeRuntime();
  const service = serviceFor(runtime);
  const received: HubEvent[] = [];
  let reentered = false;
  await service.subscribe("c_1", "b_1", trace, (event) => {
    received.push(event);
    if (event.type === "delta" && !reentered) {
      reentered = true;
      runtime.handle("b_1").emit({
        type: "delta",
        trace,
        messageId: "e_1",
        changes: [{ kind: "text", index: 0, append: "B" }],
      });
    }
  });
  runtime.handle("b_1").emit({ type: "append", trace, message: message("e_1") });
  runtime.handle("b_1").emit({
    type: "delta",
    trace,
    messageId: "e_1",
    changes: [{ kind: "text", index: 0, append: "A" }],
  });
  service.resync("c_1", trace);
  const snapshots = received.filter((event) => event.type === "snapshot");
  const resync = snapshots.at(-1);
  const block = resync?.type === "snapshot" ? resync.value.messages[0]?.blocks[0] : undefined;
  assert.equal(
    block?.type === "text" ? block.text : "",
    "e_1A",
    "the snapshot covers only what was numbered before it",
  );
  service.resync("c_1", trace);
  const after = received.filter((event) => event.type === "snapshot").at(-1);
  const final = after?.type === "snapshot" ? after.value.messages[0]?.blocks[0] : undefined;
  assert.equal(final?.type === "text" ? final.text : "", "e_1AB", "the delta applied exactly once");
});

test("abort and recover reach the runtime and need a subscription", async () => {
  const runtime = new FakeRuntime();
  const calls: string[] = [];
  const service = new ConversationService({
    open: async (botId, openTrace) => {
      const handle = await runtime.open({
        id: botId,
        dir: `/tmp/${botId}`,
        model: { provider: "faux", modelId: "faux-1" },
        trace: openTrace,
      });
      return proxyHandle(handle, {
        abort: async (abortTrace) => {
          calls.push(`abort:${abortTrace}`);
        },
        recover: async (recoverTrace) => {
          calls.push(`recover:${recoverTrace}`);
        },
      });
    },
    measure: utf8,
  });
  await assert.rejects(
    () => service.abort("c_1", trace),
    (error: unknown) => error instanceof CommandError && error.disposition === "not_admitted",
  );
  await subscribe(service, []);
  await service.abort("c_1", trace);
  await service.recover("c_1", trace);
  assert.deepEqual(calls, [`abort:${trace}`, `recover:${trace}`]);
});

test("a broadcast settlement carries every field of the record", async () => {
  const snapshot: ConversationSnapshot = {
    botId: "b_1",
    messages: [],
    streaming: null,
    pending: [],
    inbox: [],
    running: false,
  };
  const placed = (input: SubmitInput): Submission => ({
    id: "s_2",
    requestId: input.requestId,
    status: "placed",
    entryId: "e_5",
  });
  const done = (input: SubmitInput): Submission => ({
    id: "s_2",
    requestId: input.requestId,
    status: "done",
    entryId: "e_5",
    answerEntryId: "e_6",
  });
  const scripted = scriptedHandle({
    snapshot,
    record: done,
    onSubmit: (input) => [
      { type: "submission", trace: input.trace, record: placed(input) },
      { type: "submission", trace: input.trace, record: done(input) },
    ],
  });
  const service = new ConversationService({ open: async () => scripted.handle, measure: utf8 });
  const received: HubEvent[] = [];
  await subscribe(service, received);
  const reply = await service.send("c_1", {
    requestId,
    text: "hi",
    whenBusy: "followUp",
    trace,
  });
  assert.deepEqual(
    received.flatMap((event) => (event.type === "submission" ? [event.record] : [])),
    [
      placed({ requestId, text: "hi", whenBusy: "followUp", trace }),
      done({ requestId, text: "hi", whenBusy: "followUp", trace }),
    ],
  );
  assert.deepEqual(reply, done({ requestId, text: "hi", whenBusy: "followUp", trace }));
});

test("an unanswered broadcast keeps its reason and carries no answer entry", async () => {
  const snapshot: ConversationSnapshot = {
    botId: "b_1",
    messages: [],
    streaming: null,
    pending: [],
    inbox: [],
    running: false,
  };
  const failed = (input: SubmitInput): Submission => ({
    id: "s_3",
    requestId: input.requestId,
    status: "unanswered",
    reason: "model_error",
    entryId: "e_7",
  });
  const scripted = scriptedHandle({
    snapshot,
    record: failed,
    onSubmit: (input) => [{ type: "submission", trace: input.trace, record: failed(input) }],
  });
  const service = new ConversationService({ open: async () => scripted.handle, measure: utf8 });
  const received: HubEvent[] = [];
  await subscribe(service, received);
  const reply = await service.send("c_1", {
    requestId,
    text: "hi",
    whenBusy: "followUp",
    trace,
  });
  const expected = {
    id: "s_3",
    requestId,
    status: "unanswered",
    reason: "model_error",
    entryId: "e_7",
  };
  assert.deepEqual(
    received.flatMap((event) => (event.type === "submission" ? [event.record] : [])),
    [expected],
  );
  assert.deepEqual(reply, expected);
});

test("send is refused when the pending or inbox budget is full", async () => {
  const input = {
    requestId: "r_budget_0001",
    text: "预算",
    whenBusy: "followUp" as const,
    trace,
  };
  const full = (overrides: Partial<ConversationSnapshot>): ConversationSnapshot => ({
    botId: "b_1",
    messages: [],
    pending: [],
    inbox: [],
    running: false,
    streaming: null,
    ...overrides,
  });
  const queued = Array.from({ length: 32 }, (_, index) => ({
    id: `s_${index + 1}`,
    requestId: `r_pending_${String(index).padStart(4, "0")}`,
    status: "queued" as const,
  }));
  const inbox = Array.from({ length: 32 }, (_, index) => ({
    id: `s_i${index + 1}`,
    mode: "followUp" as const,
  }));

  for (const snapshot of [full({ pending: queued }), full({ inbox })]) {
    const runtime = new FakeRuntime({ snapshot: () => snapshot });
    const service = serviceFor(runtime);
    const received: HubEvent[] = [];
    await subscribe(service, received);
    await assert.rejects(
      () => service.send("c_1", input),
      (error: unknown) =>
        error instanceof CommandError &&
        error.kind === "limit_exceeded" &&
        error.disposition === "not_admitted" &&
        error.requestId === input.requestId,
      "admission beyond the budget restores the draft",
    );
  }

  // A duplicate requestId is not new admission: the stored record still comes back.
  const runtime = new FakeRuntime({ snapshot: () => full({ pending: queued }) });
  const service = serviceFor(runtime);
  await subscribe(service, []);
  const stored = await service.send("c_1", { ...input, requestId: queued[0]?.requestId ?? "" });
  assert.equal(stored.id, "s_1");
});

const gatedHandle = (options: {
  snapshot: ConversationSnapshot;
  onOpen?: () => void;
  openGate?: Promise<void>;
  records?: Map<string, Submission>;
}) => {
  let sink: ((event: RuntimeEvent) => void) | undefined;
  const handle: RuntimeHandle = {
    refreshTools: async () => {},
    subscribe: async (_trace, next) => {
      sink = next;
      return {
        snapshot: options.snapshot,
        detach: () => {
          sink = undefined;
        },
      };
    },
    submission: async (key) =>
      "requestId" in key
        ? [...(options.records ?? records).values()].find(
            (record) => record.requestId === key.requestId,
          )
        : undefined,
    submit: async (input) => {
      await options.openGate;
      const record = {
        id: `s_${records.size + 1}`,
        requestId: input.requestId,
        status: "queued" as const,
      };
      records.set(input.requestId, record);
      return record;
    },
    history: async () => ({ messages: [], hasMore: false }),
    abort: async () => undefined,
    recover: async () => undefined,
    busy: async () => ({ run: false, tasks: false }),
    close: async () => "closed",
  };
  const records = new Map<string, Submission>();
  return { handle, emit: (event: RuntimeEvent) => sink?.(event) };
};

test("concurrent sends cannot pass the admission budget", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const snapshot: ConversationSnapshot = {
    botId: "b_1",
    messages: [],
    pending: [],
    inbox: [],
    running: false,
    streaming: null,
  };
  const scripted = gatedHandle({ snapshot, openGate: gate });
  const opened: (() => void)[] = [];
  const service = new ConversationService({
    open: async () => {
      opened.push(() => undefined);
      return scripted.handle;
    },
    measure: utf8,
  });
  await subscribe(service, []);
  const attempts = Array.from({ length: 33 }, (_, index) =>
    service
      .send("c_1", {
        requestId: `r_race_${String(index).padStart(4, "0")}`,
        text: "并发",
        whenBusy: "followUp",
        trace,
      })
      .then(
        () => "admitted" as const,
        (error: unknown) =>
          error instanceof CommandError && error.disposition === "not_admitted"
            ? ("refused" as const)
            : ("other" as const),
      ),
  );
  release();
  const outcomes = await Promise.all(attempts);
  assert.equal(outcomes.filter((outcome) => outcome === "admitted").length, 32);
  assert.equal(outcomes.filter((outcome) => outcome === "refused").length, 1);
});

test("a session failure makes the bot unavailable and recover opens it again", async () => {
  const snapshot: ConversationSnapshot = {
    botId: "b_1",
    messages: [],
    pending: [],
    inbox: [],
    running: false,
    streaming: null,
  };
  const scripted = gatedHandle({ snapshot });
  let opens = 0;
  const handle = scripted.handle;
  const service = new ConversationService({
    open: async () => {
      opens += 1;
      return opens === 1
        ? handle
        : {
            ...handle,
            subscribe: async () => ({ snapshot, detach: () => undefined }),
          };
    },
    measure: utf8,
  });
  const received: HubEvent[] = [];
  await subscribe(service, received);
  scripted.emit({
    type: "error",
    trace,
    failure: { id: "f_session_1", kind: "storage_failed", layer: "runtime" },
    message: "the session closed",
  });
  await service.resync("c_1", trace);
  const degraded = received.filter((event) => event.type === "snapshot").at(-1);
  assert.ok(degraded?.type === "snapshot", "a snapshot rendered the failure");
  assert.equal(
    degraded.value.unavailable?.reason,
    "storage_failed",
    "the view renders the reason instead of pretending the bot is idle",
  );
  await service.recover("c_1", trace);
  assert.equal(opens, 2, "recover re-opens the dead harness instead of reusing it");
  const recovered = received.filter((event) => event.type === "snapshot").at(-1);
  assert.ok(recovered?.type === "snapshot", "recover published a snapshot");
  assert.equal(recovered.value.unavailable, undefined);
});

test("a snapshot page is bounded by encoded bytes, not only by count", async () => {
  const big = (id: string): Message => ({
    id,
    role: "assistant",
    state: "complete",
    createdAt: "x",
    blocks: [{ type: "text", text: "x".repeat(70_000) }],
  });
  const snapshot: ConversationSnapshot = {
    botId: "b_1",
    messages: [big("e_1"), big("e_2"), big("e_3")],
    pending: [],
    inbox: [],
    running: false,
    streaming: null,
  };
  const runtime = new FakeRuntime({ snapshot: () => snapshot });
  const service = serviceFor(runtime);
  const received: HubEvent[] = [];
  await subscribe(service, received);
  const baseline = received[0];
  assert.equal(baseline?.type, "snapshot");
  const page = (baseline as { value: ConversationSnapshot }).value;
  assert.ok(
    Buffer.byteLength(JSON.stringify(page)) < 192 * 1024,
    "the page the client is told about fits the documented budget",
  );
  assert.equal(page.messages.length, 2, "the newest messages are the ones kept");
  assert.equal(page.truncatedBefore, "e_1", "and the dropped entry is the page cursor");

  const history = await service.history("c_1", { beforeEntryId: "e_2", limit: 10 }, trace);
  assert.equal(history.messages.length, 1, "the older message is still reachable");
  assert.equal(history.messages[0]?.id, "e_1");
  assert.equal(history.hasMore, false);
});

test("an escalated watch makes the bot unavailable and recover opens it again", async () => {
  const snapshot: ConversationSnapshot = {
    botId: "b_1",
    messages: [],
    pending: [],
    inbox: [],
    running: false,
    streaming: null,
  };
  const scripted = gatedHandle({ snapshot });
  const handle = scripted.handle;
  let opens = 0;
  let recovered = 0;
  const recoveredHandle = {
    ...handle,
    recover: async () => {
      recovered += 1;
    },
  };
  const service = new ConversationService({
    open: async () => {
      opens += 1;
      return recoveredHandle;
    },
    measure: utf8,
  });
  const received: HubEvent[] = [];
  await subscribe(service, received);
  // The adapter escalates three listener faults in a minute to one `internal` error and
  // stops reattaching: the bot has no live watch, so it is unavailable.
  scripted.emit({
    type: "error",
    trace,
    failure: { id: "f_listener_3", kind: "internal", layer: "runtime" },
    message: "the event stream kept failing",
  });
  await service.resync("c_1", trace);
  const degraded = received.filter((event) => event.type === "snapshot").at(-1);
  assert.ok(degraded?.type === "snapshot");
  assert.equal(degraded.value.unavailable?.reason, "internal");
  assert.deepEqual(degraded.value.messages, [], "an unavailable snapshot carries no collections");
  await service.recover("c_1", trace);
  assert.equal(opens, 1, "the harness survived, so recover must not open a second owner");
  assert.equal(recovered, 1, "the runtime is asked to re-attach its own watch");
  const revived = received.filter((event) => event.type === "snapshot").at(-1);
  assert.ok(revived?.type === "snapshot");
  assert.equal(revived.value.unavailable, undefined, "the bot is available again");
});

test("a reservation the view already lists is not counted twice", async () => {
  const pending = Array.from({ length: 16 }, (_, index) => ({
    id: `s_${index + 1}`,
    requestId: `r_dup_${String(index).padStart(4, "0")}`,
    status: "queued" as const,
  }));
  const snapshot: ConversationSnapshot = {
    botId: "b_1",
    messages: [],
    pending,
    inbox: [],
    running: true,
    streaming: null,
  };
  const scripted = gatedHandle({ snapshot });
  const service = new ConversationService({ open: async () => scripted.handle, measure: utf8 });
  await subscribe(service, []);
  // A snapshot that lists the work the service is already counting must not double it:
  // 16 pending + 16 duplicated reservations is 16 admissions, so a 17th still fits.
  scripted.emit({ type: "snapshot", trace, value: snapshot });
  const admitted = await service
    .send("c_1", { requestId: "r_dup_9999", text: "还行", whenBusy: "followUp", trace })
    .then(
      () => true,
      () => false,
    );
  assert.equal(admitted, true, "the budget counts distinct admissions");
});

test("a lost settlement event expires, but a stale snapshot does not release it", async () => {
  const snapshot: ConversationSnapshot = {
    botId: "b_1",
    messages: [],
    pending: [],
    inbox: [],
    running: false,
    streaming: null,
  };
  const records = new Map<string, Submission>();
  const scripted = gatedHandle({ snapshot, records });
  let now = 1_000;
  const service = new ConversationService({
    open: async () => scripted.handle,
    measure: utf8,
    now: () => now,
  });
  await subscribe(service, []);
  const fill = () =>
    Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        service.send("c_1", {
          requestId: `r_lost_${String(index).padStart(4, "0")}_${now}`,
          text: "丢了",
          whenBusy: "followUp",
          trace,
        }),
      ),
    );
  const attempt = () =>
    service
      .send("c_1", { requestId: `r_next_${now}`, text: "又来了", whenBusy: "followUp", trace })
      .then(
        () => true,
        () => false,
      );

  await fill();
  // A snapshot captured before these admissions must not free their slots.
  scripted.emit({ type: "snapshot", trace, value: { ...snapshot } });
  assert.equal(await attempt(), false, "a stale snapshot never releases a reservation");

  // Time alone is not evidence: the runtime still reports each admission as queued.
  for (const [index] of Array.from({ length: 32 }).entries()) {
    records.set(`r_lost_${String(index).padStart(4, "0")}_1000`, {
      id: `s_${index + 1}`,
      requestId: `r_lost_${String(index).padStart(4, "0")}_1000`,
      status: "queued",
    });
  }
  now += RESERVATION_TTL_MS + 1;
  assert.equal(await attempt(), false, "an outstanding admission keeps its slot after the TTL");

  // A status read that fails is not evidence that the admission ended.
  records.clear();
  const originalSubmission = scripted.handle.submission;
  scripted.handle.submission = async (key) => {
    // Only the already-reserved ids fail: a new request is looked up normally, so the
    // budget check (not the lookup) has to refuse it.
    if ("requestId" in key && key.requestId.startsWith("r_lost_")) {
      throw new Error("the ledger is unreadable");
    }
    return originalSubmission(key);
  };
  now += RESERVATION_TTL_MS + 1;
  assert.equal(await attempt(), false, "an unreadable status keeps the slot");
  scripted.handle.submission = originalSubmission;

  // Once the runtime reports no such record, the next expiry check releases it.
  now += RESERVATION_TTL_MS + 1;
  assert.equal(await attempt(), true, "a reservation the runtime no longer knows is released");
});

test("a bot that becomes unavailable during the lookup refuses the admission", async () => {
  const snapshot: ConversationSnapshot = {
    botId: "b_1",
    messages: [],
    pending: [],
    inbox: [],
    running: false,
    streaming: null,
  };
  let release: () => void = () => undefined;
  const lookupGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let submitCalls = 0;
  let sink: ((event: RuntimeEvent) => void) | undefined;
  const handle: RuntimeHandle = {
    refreshTools: async () => {},
    subscribe: async (_trace, next) => {
      sink = next;
      return { snapshot, detach: () => undefined };
    },
    submission: async () => {
      await lookupGate;
      return undefined;
    },
    submit: async (input) => {
      submitCalls += 1;
      return { id: "s_1", requestId: input.requestId, status: "queued" };
    },
    history: async () => ({ messages: [], hasMore: false }),
    abort: async () => undefined,
    recover: async () => undefined,
    busy: async () => ({ run: false, tasks: false }),
    close: async () => "closed",
  };
  const service = new ConversationService({ open: async () => handle, measure: utf8 });
  await subscribe(service, []);
  const sending = service.send("c_1", {
    requestId: "r_slow_0001",
    text: "慢查询",
    whenBusy: "followUp",
    trace,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  sink?.({
    type: "error",
    trace,
    failure: { id: "f_escalate_1", kind: "internal", layer: "runtime" },
    message: "the watch escalated",
  });
  release();
  await assert.rejects(sending, (error: unknown) => error instanceof CommandError);
  assert.equal(submitCalls, 0, "the dead handle never receives the input");
});

test("two subscriptions after an eviction share one view and one runtime watch", async () => {
  const snapshot: ConversationSnapshot = {
    botId: "b_1",
    messages: [],
    pending: [],
    inbox: [],
    running: false,
    streaming: null,
  };
  let opens = 0;
  let watches = 0;
  let live = false;
  let current: RuntimeHandle | undefined;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handle = (): RuntimeHandle => ({
    refreshTools: async () => {},
    subscribe: async (_trace, next) => {
      watches += 1;
      if (watches > 1) await gate;
      next({ type: "snapshot", trace, value: snapshot });
      return { snapshot, detach: () => undefined };
    },
    submission: async () => undefined,
    submit: async (input) => ({
      id: `s_${input.requestId}`,
      requestId: input.requestId,
      status: "queued",
    }),
    history: async () => ({ messages: [], hasMore: false }),
    abort: async () => undefined,
    recover: async () => undefined,
    busy: async () => ({ run: false, tasks: false }),
    close: async () => {
      live = false;
      return "closed";
    },
  });
  const service = new ConversationService({
    open: async () => {
      opens += 1;
      live = true;
      current = handle();
      return current;
    },
    handleOf: () => (live ? current : undefined),
    // The idle close cleared the handle: this is what an eviction looks like to a subscriber.
    settlingOf: () => false,
    measure: utf8,
  });
  const first = await subscribe(service, [], "c_1");
  assert.equal(opens, 1);
  service.unsubscribe("c_1");
  live = false;
  // Two callers arrive after the eviction, while the new watch is still being acquired.
  const one = service.subscribe("c_2", "b_1", trace, () => undefined);
  const two = service.subscribe("c_3", "b_1", trace, () => undefined);
  release();
  const baselines = await Promise.all([one, two]);
  assert.equal(opens, 2, "one reopen for the evicted bot");
  assert.equal(watches, 2, "one watch for the first subscription, one for the shared reopen");
  assert.equal(baselines[0].snapshot.botId, "b_1");
  assert.equal(baselines[1].snapshot.botId, "b_1");
  void first;
});

test("recover keeps the admissions that were already in flight", async () => {
  const snapshot: ConversationSnapshot = {
    botId: "b_1",
    messages: [],
    pending: [],
    inbox: [],
    running: false,
    streaming: null,
  };
  let release: () => void = () => undefined;
  const submitGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sink: ((event: RuntimeEvent) => void) | undefined;
  let submits = 0;
  const handle: RuntimeHandle = {
    refreshTools: async () => {},
    subscribe: async (_trace, next) => {
      sink = next;
      return { snapshot, detach: () => undefined };
    },
    submission: async () => undefined,
    submit: async (input) => {
      submits += 1;
      if (submits === 1) await submitGate;
      return { id: `s_${submits}`, requestId: input.requestId, status: "queued" };
    },
    history: async () => ({ messages: [], hasMore: false }),
    abort: async () => undefined,
    recover: async () => undefined,
    busy: async () => ({ run: false, tasks: false }),
    close: async () => "closed",
  };
  const service = new ConversationService({ open: async () => handle, measure: utf8 });
  await subscribe(service, []);

  const first = service.send("c_1", {
    requestId: "r_inflight_0001",
    text: "在途",
    whenBusy: "followUp",
    trace,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  // The watch escalates while the admission is in flight; recover re-attaches the harness.
  sink?.({
    type: "error",
    trace,
    failure: { id: "f_escalate_2", kind: "internal", layer: "runtime" },
    message: "the watch escalated",
  });
  await service.resync("c_1", trace);
  await service.recover("c_1", trace);
  release();
  await first;

  // Fill the rest of the budget: the recovered view must still count that admission.
  const rest = Array.from({ length: 31 }, (_, index) =>
    service.send("c_1", {
      requestId: `r_rest_${String(index).padStart(4, "0")}`,
      text: "更多",
      whenBusy: "followUp",
      trace,
    }),
  );
  await Promise.all(rest);
  await assert.rejects(
    () =>
      service.send("c_1", {
        requestId: "r_over_0001",
        text: "超出",
        whenBusy: "followUp",
        trace,
      }),
    (error: unknown) => error instanceof CommandError && error.kind === "limit_exceeded",
    "an in-flight admission survives a recovery",
  );
});

test("a degraded subscriber receives a fresh snapshot instead of waiting forever", async () => {
  const snapshot: ConversationSnapshot = {
    botId: "b_1",
    messages: [],
    pending: [],
    inbox: [],
    running: false,
    streaming: null,
  };
  const runtime = new FakeRuntime({ snapshot: () => snapshot });
  const service = serviceFor(runtime);
  const received: HubEvent[] = [];
  let backpressured = true;
  await service.subscribe("c_1", "b_1", trace, (event) => {
    if (backpressured) throw new SubscriberTooSlow();
    received.push(event);
  });
  backpressured = false;
  runtime.handle("b_1").emit({
    type: "status",
    trace,
    running: true,
    streaming: null,
    inbox: [],
  });
  // The hub downgraded the subscriber and asked for a fresh view; the next event it sees
  // is that snapshot, not a silent stream.
  for (
    let index = 0;
    index < 100 && !received.some((event) => event.type === "snapshot");
    index += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(
    received.some((event) => event.type === "snapshot"),
    "a downgraded subscriber is handed the current view",
  );
});

test("a subscriber that never reads does not spin the daemon", async () => {
  const snapshot: ConversationSnapshot = {
    botId: "b_1",
    messages: [],
    pending: [],
    inbox: [],
    running: false,
    streaming: null,
  };
  const runtime = new FakeRuntime({ snapshot: () => snapshot });
  const service = serviceFor(runtime);
  let calls = 0;
  const refusing = () => {
    calls += 1;
    throw new SubscriberTooSlow();
  };
  await service.subscribe("c_1", "b_1", trace, refusing).catch(() => undefined);
  calls = 0;
  runtime.handle("b_1").emit({
    type: "status",
    trace,
    running: true,
    streaming: null,
    inbox: [],
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(
    calls <= 4,
    `a client that never reads gets one refresh attempt per episode, saw ${calls}`,
  );
});

test("the final events of a run are recoverable after the backpressure clears", async () => {
  const snapshot: ConversationSnapshot = {
    botId: "b_1",
    messages: [],
    pending: [],
    inbox: [],
    running: false,
    streaming: null,
  };
  const runtime = new FakeRuntime({ snapshot: () => snapshot });
  const service = serviceFor(runtime);
  const received: HubEvent[] = [];
  let blocked = true;
  await service
    .subscribe("c_1", "b_1", trace, (event) => {
      if (blocked) throw new SubscriberTooSlow();
      received.push(event);
    })
    .catch(() => undefined);
  // The final append and the stop status are lost while the client is not reading, and so
  // is the compensating snapshot; nothing else happens afterwards.
  runtime.handle("b_1").emit({
    type: "append",
    trace,
    message: {
      id: "e_10",
      role: "assistant",
      state: "complete",
      createdAt: "x",
      blocks: [{ type: "text", text: "最终回答" }],
    },
  });
  runtime.handle("b_1").emit({ type: "status", trace, running: false, streaming: null, inbox: [] });
  blocked = false;
  for (
    let index = 0;
    index < 100 && !received.some((event) => event.type === "snapshot");
    index += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(
    received.some((event) => event.type === "snapshot"),
    "the degraded subscriber is refreshed without a new bot event",
  );
});

test("a parked task is visible in the snapshot, so a new client can recover it", async () => {
  const snapshot: ConversationSnapshot = {
    botId: "b_1",
    messages: [],
    pending: [],
    inbox: [],
    running: true,
    streaming: null,
  };
  const runtime = new FakeRuntime({ snapshot: () => snapshot });
  const service = serviceFor(runtime);
  const received: HubEvent[] = [];
  await subscribe(service, received);
  runtime.handle("b_1").emit({
    type: "error",
    trace,
    failure: { id: "f_parked_1", kind: "task_parked", layer: "runtime" },
    message: "a task was parked",
  });
  await service.resync("c_1", trace);
  const parked = received.filter((event) => event.type === "snapshot").at(-1);
  assert.ok(parked?.type === "snapshot");
  assert.equal(parked.value.parked, true, "a fresh snapshot names the parked task");

  await service.recover("c_1", trace);
  const recovered = received.filter((event) => event.type === "snapshot").at(-1);
  assert.ok(recovered?.type === "snapshot");
  assert.notEqual(recovered.value.parked, true, "a recovery snapshot no longer asks for it");

  // The wire codec carries the flag; a fixture without it stays valid.
  const wire = encodeServerEvent({
    type: "snapshot",
    rev: 1,
    trace,
    value: parked.value,
  });
  assert.equal((wire.value as { parked?: boolean }).parked, true);
});

test("a usage event is reported to the host's statistics hook", async () => {
  const bookings: { botId: string; totalTokens: number }[] = [];
  const runtime = new FakeRuntime();
  const service = new ConversationService({
    open: (botId, openTrace) =>
      runtime.open({
        id: botId,
        dir: `/tmp/${botId}`,
        model: { provider: "faux", modelId: "faux-1" },
        trace: openTrace,
      }),
    measure: utf8,
    onUsage: (botId, usage) => bookings.push({ botId, totalTokens: usage.totalTokens }),
  });
  const received: HubEvent[] = [];
  await subscribe(service, received);
  runtime.handle("b_1").emit({
    type: "usage",
    trace,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.01 },
  });
  assert.deepEqual(bookings, [{ botId: "b_1", totalTokens: 15 }]);
  assert.ok(
    received.some((event) => event.type === "usage"),
    "the client still sees the totals",
  );
});

/** A runtime whose transcript holds one secret card, and that remembers what it was told. */
const cardRuntime = (card: Message | undefined) => {
  const submitted: SubmitInput[] = [];
  const handle: RuntimeHandle = {
    refreshTools: async () => {},
    subscribe: async (_trace, _sink) => ({
      snapshot: {
        botId: "b_1",
        messages: [],
        streaming: null,
        pending: [],
        inbox: [],
        running: false,
      },
      detach: () => undefined,
    }),
    submission: async () => undefined,
    submit: async (input) => {
      submitted.push(input);
      return { id: "s_1", requestId: input.requestId, status: "queued" };
    },
    entryById: async (entryId) => (card === undefined || card.id !== entryId ? undefined : card),
    history: async () => ({ messages: [], hasMore: false }),
    abort: async () => {},
    recover: async () => {},
    busy: async () => ({ run: false, tasks: false }),
    close: async () => "closed",
  };
  return { handle, submitted };
};

const askCard = (): Message => ({
  id: "e_card_1",
  role: "assistant",
  state: "complete",
  createdAt: "2026-11-03T01:10:00.000Z",
  blocks: [
    {
      type: "toolCall",
      callId: "c_1",
      name: "ask_user",
      args: {
        questions: [
          { prompt: "Proceed?", kind: "single", options: [{ label: "Yes" }, { label: "No" }] },
        ],
      },
    },
  ],
});

const secretCard = (args: Record<string, unknown>): Message => ({
  id: "e_card_1",
  role: "assistant",
  state: "complete",
  createdAt: "2026-11-03T01:10:00.000Z",
  blocks: [{ type: "toolCall", callId: "c_1", name: "secret_request", args }],
});

const secretService = (
  runtime: ReturnType<typeof cardRuntime>,
  secrets?: SecretsPort,
): ConversationService =>
  new ConversationService({
    open: async () => runtime.handle,
    measure: utf8,
    ...(secrets === undefined ? {} : { secrets }),
  });

test("the secret answer stores the value and admits a hidden message without it", async () => {
  const runtime = cardRuntime(secretCard({ key: "github-pat", purpose: "发布用", ttlMinutes: 60 }));
  const saved: SecretSave[] = [];
  const service = secretService(runtime, {
    save: async (input) => {
      saved.push(input);
      return { scope: input.scope, createdAt: "t", updatedAt: "t" };
    },
    claimAnswer: async () => true,
    releaseAnswer: async () => undefined,
  });
  const record = await service.answerSecret("b_1", {
    entryId: "e_card_1",
    key: "github-pat",
    value: "ghp_example",
  });
  assert.equal(record.status, "queued");
  assert.deepEqual(saved, [
    {
      botId: "b_1",
      key: "github-pat",
      value: "ghp_example",
      scope: "bot",
      purpose: "发布用",
      ttlMinutes: 60,
    },
  ]);
  const hidden = runtime.submitted.at(-1);
  assert.ok(hidden);
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.answersTo, "secret:e_card_1");
  assert.equal(
    hidden.text.includes("ghp_example"),
    false,
    "the value never reaches the transcript",
  );
  assert.match(hidden.text, /github-pat/);
  assert.match(hidden.text, /expires in 1 hour/);
});

test("a card answer that breaks a rule is refused and stores nothing", async () => {
  const runtime = cardRuntime(secretCard({ key: "github-pat", purpose: "发布用" }));
  const saved: SecretSave[] = [];
  const service = secretService(runtime, {
    save: async (input) => {
      saved.push(input);
      return { scope: input.scope, createdAt: "t", updatedAt: "t" };
    },
    claimAnswer: async () => true,
    releaseAnswer: async () => undefined,
  });
  const cases: readonly (Partial<SecretAnswerInput> & { readonly key: string })[] = [
    { key: "other", value: "v" },
    { key: "github-pat", value: "" },
    { key: "github-pat", value: "x".repeat(8193) },
    { key: "github-pat", value: "v", ttlMinutes: 1441 },
    { key: "github-pat", value: "v", scope: "all" as never },
  ];
  for (const input of cases) {
    await assert.rejects(
      service.answerSecret("b_1", {
        entryId: "e_card_1",
        value: "",
        ...input,
      }),
      (error: unknown) => error instanceof DirectoryError,
      JSON.stringify(input),
    );
  }
  await assert.rejects(
    service.answerSecret("b_1", { entryId: "e_unknown", key: "github-pat", value: "v" }),
    (error: unknown) => error instanceof DirectoryError,
  );
  assert.deepEqual(saved, [], "nothing was stored");
});

test("a skipped card stores nothing and says the person did not answer", async () => {
  const runtime = cardRuntime(secretCard({ key: "github-pat", purpose: "发布用" }));
  const saved: SecretSave[] = [];
  const service = secretService(runtime, {
    save: async (input) => {
      saved.push(input);
      return { scope: input.scope, createdAt: "t", updatedAt: "t" };
    },
    claimAnswer: async () => true,
    releaseAnswer: async () => undefined,
  });
  await service.answerSecret("b_1", {
    entryId: "e_card_1",
    key: "github-pat",
    value: "",
    skipped: true,
  });
  assert.deepEqual(saved, []);
  const hidden = runtime.submitted.at(-1);
  assert.ok(hidden);
  assert.match(hidden.text, /skipped/);
});

test("an unknown secret admission keeps its durable receipt", async () => {
  const runtime = cardRuntime(secretCard({ key: "github-pat", purpose: "Publish" }));
  const saved: SecretSave[] = [];
  let claimed = false;
  runtime.handle.submit = async (input) => {
    runtime.submitted.push(input);
    throw new Error("the admission response was lost");
  };
  const service = secretService(runtime, {
    save: async (input) => {
      saved.push(input);
      return { scope: input.scope, createdAt: "t", updatedAt: "t" };
    },
    claimAnswer: async () => {
      if (claimed) return false;
      claimed = true;
      return true;
    },
    releaseAnswer: async () => {
      claimed = false;
    },
  });
  const answer = { entryId: "e_card_1", key: "github-pat", value: "first-value" };
  await assert.rejects(
    service.answerSecret("b_1", answer),
    (error: unknown) => error instanceof CommandError && error.disposition === "unknown",
  );
  assert.equal(claimed, true, "unknown is not proof that no answer was admitted");
  await assert.rejects(service.answerSecret("b_1", { ...answer, value: "second-value" }));
  assert.equal(saved.length, 1, "a retry must not rotate the stored value or renew its TTL");
  assert.equal(runtime.submitted.length, 1);
});

test("a repeated question answer reuses its admission instead of starting another input", async () => {
  const runtime = cardRuntime(askCard());
  const service = secretService(runtime);
  const answer = { entryId: "e_card_1", answers: [["Yes"]] };
  const first = await service.answerBot("b_1", answer);
  const second = await service.answerBot("b_1", answer);
  assert.equal(first.requestId, second.requestId, "one card, one submission identity");
});

test("a value the store cannot accept leaves the card answerable", async () => {
  const runtime = cardRuntime(secretCard({ key: "github-pat", purpose: "Publish" }));
  const store = await SecretsStore.open({
    dir: join(await mkdtemp(join(tmpdir(), "bots-secret-card-")), "config"),
    keyPath: join(await mkdtemp(join(tmpdir(), "bots-secret-card-")), "state", "s.key"),
  });
  const service = secretService(runtime, {
    save: (input) => store.save(input),
    claimAnswer: (input) => store.claimAnswer(input),
    releaseAnswer: (input) => store.releaseAnswer(input),
  });
  try {
    await assert.rejects(
      service.answerSecret("b_1", {
        entryId: "e_card_1",
        key: "github-pat",
        value: "bad\u0000value",
      }),
      /NUL/,
    );
    const accepted = await service.answerSecret("b_1", {
      entryId: "e_card_1",
      key: "github-pat",
      value: "valid-value",
    });
    assert.equal(accepted.status, "queued", "a refused value never spends the card");
  } finally {
    await service.drain();
  }
});

test("a daemon without a secrets store refuses a card answer", async () => {
  const runtime = cardRuntime(secretCard({ key: "github-pat", purpose: "发布用" }));
  const service = secretService(runtime);
  await assert.rejects(
    service.answerSecret("b_1", {
      entryId: "e_card_1",
      key: "github-pat",
      value: "ghp_example",
    }),
    (error: unknown) => error instanceof SecretsStorageError,
  );
});
