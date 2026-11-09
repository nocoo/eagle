// Deferred tools (docs/bots/RUNTIME.md, "Tools"): the terminal tools are not offered until
// the model asks for them, and tool_search is what makes them callable.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeEvent, RuntimeHandle } from "../../src/core/RuntimePort.ts";
import { assistant, createBench, toolCall, trace, waitFor } from "../support/pi.ts";

test("tool_search cannot discover remote tools while local device status is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-device-search-"));
  const bench = await createBench({ deviceSocket: join(root, "missing.sock") });
  let handle: RuntimeHandle | undefined;
  let failure: unknown;
  try {
    bench.faux.setResponses([
      assistant(
        [toolCall("tool_search", { query: "remote_execute remote_status remote_operation" })],
        { stopReason: "toolUse" },
      ),
      assistant("done"),
    ]);
    handle = await bench.runtime.open({ ...bench.spec(), toolGroups: ["core", "hc"] });
    const events: RuntimeEvent[] = [];
    await handle.subscribe(trace, (event) => events.push(event));
    await handle.submit({
      requestId: "r_device_search",
      text: "Find remote tools",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      () => events.some((event) => event.type === "submission" && event.record.status === "done"),
      "the run to settle",
      10_000,
    );
    const results = events
      .filter((event) => event.type === "append")
      .flatMap((event) => event.message.blocks)
      .flatMap((block) =>
        block.type === "toolResult" && block.name === "tool_search" ? [block] : [],
      );
    assert.equal(results.length, 1);
    assert.doesNotMatch(results[0]?.text ?? "", /remote_execute|remote_status|remote_operation/);
  } catch (error) {
    failure = error;
  }
  const closed = await Promise.allSettled([handle?.close(trace, 1_000)]);
  const cleaned = await Promise.allSettled([
    bench.cleanup(),
    rm(root, { recursive: true, force: true }),
  ]);
  const errors = [...closed, ...cleaned].flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failure !== undefined) errors.unshift(failure);
  if (errors.length) throw new AggregateError(errors, "device tool search test failed");
});

test("a terminal tool runs only after tool_search loads it", async () => {
  const bench = await createBench();
  try {
    bench.faux.setResponses([
      assistant([toolCall("tool_search", { query: "hc" })], { stopReason: "toolUse" }),
      assistant([toolCall("hc_list", {})], { stopReason: "toolUse" }),
      assistant("done"),
    ]);
    const handle = await bench.runtime.open({
      ...bench.spec(),
      toolGroups: ["core", "hc"],
    });
    const events: RuntimeEvent[] = [];
    await handle.subscribe(trace, (event) => events.push(event));
    await handle.submit({
      requestId: "r_deferred_1",
      text: "列一下 hc",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      () => events.some((event) => event.type === "submission" && event.record.status === "done"),
      "the run to settle",
      10_000,
    );
    const results = events
      .filter((event) => event.type === "append")
      .flatMap((event) => event.message.blocks)
      .flatMap((block) => (block.type === "toolResult" ? [block] : []));
    const search = results.find((block) => block.name === "tool_search");
    assert.ok(search, `tool_search ran (${results.map((block) => block.name).join(",")})`);
    assert.equal(search.isError, false, search.text);
    const listed = results.find((block) => block.name === "hc_list");
    assert.ok(listed, "the loaded tool became callable");
    // The call ran; what it answered depends on this machine, not on the loader.
    assert.ok(listed.text.length > 0);
    await handle.close(trace, 1_000);
  } finally {
    await bench.cleanup();
  }
});
