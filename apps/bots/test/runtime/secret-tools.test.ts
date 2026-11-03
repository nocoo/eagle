// The secrets group through a real Harness (docs/bots/EXTENSIONS-AND-TOOLS.md §6.5): the
// model asks for a password on a card, the tool returns at once, and no value ever travels
// through the model's own arguments.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeEvent } from "../../src/core/RuntimePort.ts";
import { secretCardOf } from "../../src/core/secretCard.ts";
import { SecretsStore } from "../../src/secrets/store.ts";
import { assistant, type Bench, createBench, toolCall, trace, waitFor } from "../support/pi.ts";

type Responses = Parameters<NonNullable<Bench["faux"]>["setResponses"]>[0];

const results = (events: readonly RuntimeEvent[]) =>
  events
    .filter((event) => event.type === "append")
    .flatMap((event) => event.message.blocks)
    .flatMap((block) => (block.type === "toolResult" ? [block] : []));

test("a model asks for a password on a card and gets no value back", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-secret-runtime-"));
  const store = await SecretsStore.open({
    dir: join(root, "config"),
    keyPath: join(root, "state", "secrets.key"),
  });
  const bench = await createBench({
    toolGroups: ["core", "secrets"],
    secrets: (spec) => store.hostFor(spec.id),
  });
  const events: RuntimeEvent[] = [];
  const handle = await bench.runtime.open(bench.spec());
  try {
    await handle.subscribe(trace, (event) => events.push(event));
    bench.faux.setResponses([
      assistant(
        [
          toolCall("secret_request", {
            key: "github-pat",
            purpose: "发布 Eagle 用",
            ttlMinutes: 60,
          }),
        ],
        { stopReason: "toolUse" },
      ),
      assistant("好的，我已经发出去了。"),
    ] as Responses);
    await handle.submit({
      requestId: "r_secret_1",
      text: "帮我用 GitHub 发布",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      () => events.some((event) => event.type === "submission" && event.record.status === "done"),
      "the run to settle",
      10_000,
    );
    const asked = results(events).find((block) => block.name === "secret_request");
    assert.ok(asked, "the model asked for the secret");
    assert.equal(asked.isError, false, asked.text);
    assert.match(asked.text, /card/i);
    assert.deepEqual(store.values(), [], "no value arrived: the person has not answerd yet");

    // The card is the call's own arguments, read back from the transcript: the daemon
    // finds it by entry id, with no second copy anywhere.
    const entry = events.find(
      (event) =>
        event.type === "append" &&
        event.message.role === "assistant" &&
        /^e_/.test(event.message.id) &&
        event.message.blocks.some((block) => block.type === "toolCall"),
    );
    assert.ok(entry?.type === "append");
    const read = await handle.entryById?.(entry.message.id);
    assert.ok(read, "the entry that carries the call is readable");
    assert.deepEqual(secretCardOf(read), {
      key: "github-pat",
      purpose: "发布 Eagle 用",
      scope: "bot",
      ttlMinutes: 60,
    });
  } finally {
    await handle.close(trace, 1_000);
    await bench.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
