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
import {
  assistant,
  type Bench,
  createBench,
  text,
  toolCall,
  trace,
  waitFor,
} from "../support/pi.ts";

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

test("a saved value reaches a command as environment, and never the transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-secret-runtime-"));
  const store = await SecretsStore.open({
    dir: join(root, "config"),
    keyPath: join(root, "state", "secrets.key"),
  });
  const bench = await createBench({
    toolGroups: ["core", "coding", "secrets"],
    secrets: (spec) => store.hostFor(spec.id),
  });
  const events: RuntimeEvent[] = [];
  const handle = await bench.runtime.open(bench.spec());
  try {
    // The person answered the card before this turn: this is the value the model must never
    // see, in the transcript or in a tool result.
    await store.save({
      botId: bench.spec().id,
      key: "github-pat",
      value: "sentinel-value-9c1f",
      scope: "bot",
    });
    await handle.subscribe(trace, (event) => events.push(event));
    bench.faux.setResponses([
      assistant([toolCall("secret_read", { key: "github-pat" })], { stopReason: "toolUse" }),
      assistant(
        [
          toolCall("bash", {
            command: 'if [ -n "$EAGLE_SECRET_GITHUB_PAT" ]; then printf present; fi',
          }),
        ],
        { stopReason: "toolUse" },
      ),
      text("done"),
    ]);
    await handle.submit({
      requestId: "r_secret_2",
      text: "用我的 GitHub token 试一下",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      () => events.some((event) => event.type === "submission" && event.record.status === "done"),
      "the run to settle",
      10_000,
    );

    const asked = results(events).find((block) => block.name === "secret_read");
    assert.ok(asked, "the model read the record");
    assert.equal(asked.isError, false, asked.text);
    assert.match(asked.text, /EAGLE_SECRET_GITHUB_PAT/);

    const ran = results(events).find((block) => block.name === "bash");
    assert.ok(ran, "the command ran");
    assert.equal(ran.isError, false, ran.text);
    assert.match(ran.text, /present/, "the value was in the command's environment");

    // Nothing persisted — tool results, deltas, the lot — carries the value.
    const transcript = JSON.stringify(events);
    assert.equal(
      transcript.includes("sentinel-value-9c1f"),
      false,
      "the value never enters the transcript",
    );
    const history = await handle.history({ limit: 200 });
    assert.equal(JSON.stringify(history).includes("sentinel-value-9c1f"), false);
  } finally {
    await handle.close(trace, 1_000);
    await bench.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("switching the group off takes the environment with it", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-secret-runtime-"));
  const store = await SecretsStore.open({
    dir: join(root, "config"),
    keyPath: join(root, "state", "secrets.key"),
  });
  // The host is available, but this bot was not given the 密码 group: the stored value must
  // not reach its commands either.
  const bench = await createBench({
    toolGroups: ["core", "coding"],
    secrets: (spec) => store.hostFor(spec.id),
  });
  const events: RuntimeEvent[] = [];
  const handle = await bench.runtime.open(bench.spec());
  try {
    await store.save({
      botId: bench.spec().id,
      key: "github-pat",
      value: "sentinel-value-9c1f",
      scope: "bot",
    });
    await handle.subscribe(trace, (event) => events.push(event));
    bench.faux.setResponses([
      assistant(
        [
          toolCall("bash", {
            command:
              'if [ -n "$EAGLE_SECRET_GITHUB_PAT" ]; then printf present; else printf absent; fi',
          }),
        ],
        { stopReason: "toolUse" },
      ),
      text("done"),
    ]);
    await handle.submit({
      requestId: "r_secret_3",
      text: "看看环境",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      () => events.some((event) => event.type === "submission" && event.record.status === "done"),
      "the run to settle",
      10_000,
    );
    const ran = results(events).find((block) => block.name === "bash");
    assert.ok(ran, "the command ran");
    assert.match(ran.text, /absent/, "a group that is off hands out nothing");
  } finally {
    await handle.close(trace, 1_000);
    await bench.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
