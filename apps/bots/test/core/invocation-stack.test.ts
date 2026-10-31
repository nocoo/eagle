// docs/bots/TRIGGERS.md §3.3 and §3.6 at the composition level: an invocation without a
// connection holds the registry's lease for its whole admission, and the daemon's shutdown
// order lets the admission finish before handles close.
import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationSnapshot, Submission } from "../../src/core/domain.ts";
import type { RuntimeBotSpec, RuntimeHandle, RuntimePort } from "../../src/core/RuntimePort.ts";
import { waitFor } from "../support/pi.ts";
import { startStack } from "../support/server.ts";

const trace = "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172";
const requestId = "r_0190a1b4-5061-7c72-8d3e-4f5061728394";

const deferred = (): { promise: Promise<void>; open(): void } => {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

/** Admissions are held open, and closes are counted, so the lease window is observable. */
const gatedRuntime = (hold: Promise<void>) => {
  const submits: string[] = [];
  const closes: string[] = [];
  const runtime: RuntimePort = {
    async open(spec: RuntimeBotSpec): Promise<RuntimeHandle> {
      const snapshot: ConversationSnapshot = {
        botId: spec.id,
        messages: [],
        pending: [],
        inbox: [],
        running: false,
        streaming: null,
      };
      return {
        refreshTools: async () => {},
        subscribe: async () => ({ snapshot, detach: () => undefined }),
        submit: async (input) => {
          submits.push(input.requestId);
          await hold;
          return { id: "s_1", requestId: input.requestId, status: "queued" } as Submission;
        },
        submission: async () => undefined,
        history: async () => ({ messages: [], hasMore: false }),
        abort: async () => {},
        recover: async () => {},
        busy: async () => ({ run: false, tasks: false }),
        close: async () => {
          closes.push(spec.id);
          return "closed";
        },
      };
    },
  };
  return { runtime, submits, closes };
};

test("an admission without a connection keeps the bot open and lets it idle-close after", async () => {
  const hold = deferred();
  const scripted = gatedRuntime(hold.promise);
  const stack = await startStack({ runtime: scripted.runtime, idleCloseMs: 0 });
  try {
    const botId = await stack.createBot("cold");
    // The warm-up open takes no lease, so at 0 ms it closes again: the admission starts
    // from a cold bot, which is the case a schedule and a webhook actually meet.
    await waitFor(
      () => scripted.closes.length > 0 && stack.registry.handleOf(botId) === undefined,
      "the warm-up open to idle-close",
    );
    const openedBefore = stack.opens();
    const closesBefore = scripted.closes.length;

    const admitted = stack.service.invoke({
      botId,
      requestId,
      text: "run the morning check",
      origin: { kind: "schedule", triggerId: "t_9f2a1c3d04" },
      trace,
    });
    await waitFor(() => scripted.submits.length === 1, "the admission to reach the runtime");
    assert.equal(stack.opens(), openedBefore + 1, "the admission opened the cold bot");

    // Idle close is armed at 0 ms; while the admission holds the lease nothing may close
    // the bot under it, and no second harness may appear.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(scripted.closes.length, closesBefore, "no close during an admitted invocation");
    assert.equal(stack.opens(), openedBefore + 1, "no second harness for one admission");

    hold.open();
    const record = await admitted;
    assert.equal(record.requestId, requestId);
    await waitFor(
      () => stack.registry.handleOf(botId) === undefined,
      "the bot to idle-close once the lease is released",
    );
    assert.equal(scripted.closes.length, closesBefore + 1, "the handle closed exactly once");
  } finally {
    await stack.close();
  }
});

test("drain refuses a late admission and lets the one in flight finish first", async () => {
  const hold = deferred();
  const scripted = gatedRuntime(hold.promise);
  const stack = await startStack({ runtime: scripted.runtime });
  try {
    const botId = await stack.createBot("draining");
    await waitFor(() => stack.registry.handleOf(botId) !== undefined, "the warm-up open");
    const admitted = stack.service.invoke({
      botId,
      requestId,
      text: "held admission",
      origin: { kind: "webhook", triggerId: "t_9f2a1c3d04" },
      trace,
    });
    await waitFor(() => scripted.submits.length === 1, "the admission to reach the runtime");

    const drained = stack.service.drain();
    await assert.rejects(
      () =>
        stack.service.invoke({
          botId,
          requestId: "r_late_admission",
          text: "too late",
          origin: { kind: "webhook", triggerId: "t_9f2a1c3d04" },
          trace,
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.name === "CommandError" &&
        error.message.includes("shutting"),
    );

    let done = false;
    void drained.then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(done, false, "drain waits for the admission already holding the lease");

    hold.open();
    await admitted;
    await drained;
    assert.equal(done, true);
  } finally {
    await stack.close();
  }
});
