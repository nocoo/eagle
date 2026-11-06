// The bot's own pair (docs/bots/PROTOCOL.md, "Per-bot agent"): the model and the
// reasoning level a bot runs with, the pair every open configures, and the rule that a
// running answer is never interrupted by a change.
import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeEvent } from "../../src/core/RuntimePort.ts";
import { createBench, text, trace, waitFor } from "../support/pi.ts";

const of = <T extends RuntimeEvent["type"]>(events: readonly RuntimeEvent[], type: T) =>
  events.filter((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type);

const twoModels = {
  models: [
    { id: "faux-1", name: "Faux One", reasoning: true },
    { id: "faux-2", name: "Faux Two", reasoning: true },
  ],
};

test("the stored pair is configured on every open", async () => {
  const bench = await createBench();
  try {
    const handle = await bench.runtime.open({
      ...bench.spec(),
      model: { provider: "faux", modelId: "faux-2" },
      thinkingLevel: "high",
    });
    const subscription = await handle.subscribe(trace, () => undefined);
    assert.equal(
      subscription.snapshot.agent?.model.modelId,
      "faux-2",
      "the conversation runs with the pair the catalog stores",
    );
    assert.equal(subscription.snapshot.agent?.thinkingLevel, "high");
  } finally {
    await bench.cleanup();
  }
});

test("a change reaches the next prepared request and never interrupts the running one", async () => {
  const bench = await createBench({ provider: twoModels });
  try {
    const seen: string[] = [];
    let release = (): void => undefined;
    const held = new Promise<void>((resolve_) => {
      release = resolve_;
    });
    bench.faux.setResponses([
      async (_context, _options, _state, model) => {
        seen.push(model.id);
        await held;
        return text("The first answer.");
      },
      (_context, _options, _state, model) => {
        seen.push(model.id);
        return text("The second answer.");
      },
    ]);
    const handle = await bench.runtime.open(bench.spec());
    const events: RuntimeEvent[] = [];
    await handle.subscribe(trace, (event) => events.push(event));
    const configure = handle.configureAgent;
    assert.ok(configure !== undefined, "the adapter configures the pair");
    const first = handle.submit({
      requestId: "r_first",
      text: "the first question",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(() => seen.length === 1, "the first request to reach the model");
    await configure.call(
      handle,
      { model: { provider: "faux", modelId: "faux-2" }, thinkingLevel: "high" },
      trace,
    );
    assert.deepEqual(
      seen,
      ["faux-1"],
      "the request in flight keeps the model it was prepared with",
    );
    release();
    await first;
    await waitFor(
      () => of(events, "submission").some((event) => event.record.status === "done"),
      "the running answer to settle",
    );
    const settled = of(events, "submission").at(-1)?.record;
    assert.equal(settled?.status, "done", "the answer was not interrupted");
    await handle.submit({
      requestId: "r_second",
      text: "the second question",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(() => seen.length === 2, "the second request to reach the model");
    assert.deepEqual(seen, ["faux-1", "faux-2"], "the next request runs with the new model");
  } finally {
    await bench.cleanup();
  }
});

test("a level the model cannot take is refused and the conversation keeps its pair", async () => {
  const bench = await createBench({ provider: twoModels });
  try {
    const handle = await bench.runtime.open(bench.spec());
    const configure = handle.configureAgent;
    assert.ok(configure !== undefined, "the adapter configures the pair");
    await assert.rejects(
      () =>
        configure.call(
          handle,
          { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "xhigh" },
          trace,
        ),
      /does not support the xhigh thinking level/,
    );
    const subscription = await handle.subscribe(trace, () => undefined);
    assert.equal(subscription.snapshot.agent?.thinkingLevel, "off", "the pair did not move");
  } finally {
    await bench.cleanup();
  }
});

test("a model the daemon does not know is refused rather than replaced", async () => {
  const bench = await createBench({ provider: twoModels });
  try {
    const handle = await bench.runtime.open(bench.spec());
    const configure = handle.configureAgent;
    assert.ok(configure !== undefined, "the adapter configures the pair");
    await assert.rejects(
      () =>
        configure.call(
          handle,
          { model: { provider: "faux", modelId: "faux-9" }, thinkingLevel: "high" },
          trace,
        ),
      /does not offer faux-9/,
    );
  } finally {
    await bench.cleanup();
  }
});
