import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Snapshot } from "../src/domain.ts";
import { ChatRuntime } from "../src/runtime.ts";

const config = {
  baseUrl: "http://127.0.0.1:1/v1",
  model: "test-model",
  thinkingLevel: "medium" as const,
  apiKey: "fixture-only-key",
};
async function bench(tokensPerSecond = 10000) {
  const root = await mkdtemp(join(tmpdir(), "superagent-runtime-"));
  const faux = fauxProvider({
    provider: "superagent",
    models: [{ id: "test-model" }],
    tokensPerSecond,
    tokenSize: { min: 1, max: 1 },
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = await ChatRuntime.open(root, models);
  return {
    root,
    faux,
    models,
    runtime,
    async close() {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not become true");
}

test("SG001-R05: own configuration persists, is redacted, and readiness does not call a model", async () => {
  const b = await bench();
  try {
    assert.equal(b.runtime.snapshot().modelReady, false);
    await assert.rejects(b.runtime.submit("r_missing_01", "hello"), /unconfigured/);
    await b.runtime.configure(config);
    assert.equal(b.runtime.snapshot().modelReady, true);
    assert.equal(JSON.stringify(b.runtime.snapshot()).includes(config.apiKey), false);
    assert.equal(b.faux.state.callCount, 0);
    const stored = JSON.parse(await readFile(join(b.root, "configuration.json"), "utf8"));
    assert.equal(stored.model, config.model);
    await b.runtime.configure({ ...config, apiKey: "" });
    assert.equal(b.runtime.snapshot().modelReady, false);
  } finally {
    await b.close();
  }
});

test("SG001-R06/R07: real Harness answers, dedupes after reopen and retains history", async () => {
  const b = await bench();
  try {
    await b.runtime.configure(config);
    b.faux.setResponses([fauxAssistantMessage("Hello from the independent Super Bot.")]);
    const first = await b.runtime.submit("r_first_001", "hello");
    await until(async () => (await b.runtime.submission("r_first_001"))?.status === "done");
    assert.equal(b.faux.state.callCount, 1);
    assert.equal(
      (await b.runtime.submission("r_first_001"))?.answer,
      "Hello from the independent Super Bot.",
    );
    assert.deepEqual(
      (await b.runtime.history()).messages.map((m) => m.role),
      ["user", "assistant"],
    );
    await b.runtime.close();
    const reopened = await ChatRuntime.open(b.root, b.models);
    try {
      const again = await reopened.submit("r_first_001", "hello");
      assert.equal(again.id, first.id);
      assert.equal(again.status, "done");
      assert.equal(b.faux.state.callCount, 1);
      assert.equal((await reopened.history()).messages.length, 2);
    } finally {
      await reopened.close();
    }
  } finally {
    await b.close();
  }
});

test("SG001-R06/R08: actual partials stream, queued input is visible, Stop withdraws both", async () => {
  const b = await bench(20);
  try {
    await b.runtime.configure(config);
    b.faux.setResponses([
      fauxAssistantMessage(
        "A long streamed response that must still be running when the person asks to stop it.",
      ),
    ]);
    const states: Snapshot[] = [];
    const detach = b.runtime.observe((state) => states.push(state));
    await b.runtime.submit("r_stream_01", "stream");
    await until(() =>
      states.some((s) => s.messages.some((m) => m.state === "streaming" && m.text.length > 0)),
    );
    const queued = await b.runtime.submit("r_queued_01", "later");
    assert.equal(queued.status, "queued");
    await until(() => b.runtime.snapshot().pending.length === 1);
    await assert.rejects(b.runtime.configure({ ...config, model: "other" }), /busy/);
    const stopping = b.runtime.abort();
    await assert.rejects(b.runtime.submit("r_stop_race01", "must not race stop"), /busy/);
    await stopping;
    assert.equal((await b.runtime.submission("r_stream_01"))?.status, "unanswered");
    assert.equal((await b.runtime.submission("r_queued_01"))?.status, "unanswered");
    await until(() => !b.runtime.snapshot().running);
    assert.equal(b.runtime.snapshot().pending.length, 0);
    detach();
  } finally {
    await b.close();
  }
});

test("SG001-R07: history boundaries stay stable as new turns append", async () => {
  const b = await bench();
  try {
    await b.runtime.configure(config);
    b.faux.setResponses([
      fauxAssistantMessage("first answer"),
      fauxAssistantMessage("second answer"),
    ]);
    await b.runtime.submit("r_history_01", "first");
    await until(async () => (await b.runtime.submission("r_history_01"))?.status === "done");
    const page = await b.runtime.history(undefined, 1);
    assert.equal(page.messages[0]?.text, "first answer");
    assert.equal(page.hasMore, true);
    assert.equal((page as { coverage?: string }).coverage, "partial");
    assert.ok(
      (b.runtime.snapshot() as { window?: { oldestEntryId: number } }).window?.oldestEntryId,
    );
    await b.runtime.submit("r_history_02", "second");
    await until(async () => (await b.runtime.submission("r_history_02"))?.status === "done");
    const older = await b.runtime.history(page.nextBefore, 100);
    assert.deepEqual(
      older.messages.map((m) => m.text),
      ["first"],
    );
    assert.equal(older.hasMore, false);
  } finally {
    await b.close();
  }
});

test("SG001-R09: malformed configuration and input are refused without admission", async () => {
  const b = await bench();
  try {
    await assert.rejects(
      b.runtime.configure({ ...config, baseUrl: "http://user:password@example.com" }),
      /invalid_command/,
    );
    await b.runtime.configure(config);
    await assert.rejects(b.runtime.submit("bad", "hello"), /invalid_command/);
    await assert.rejects(b.runtime.submit("r_badtext_01", "x".repeat(8001)), /limit_exceeded/);
    assert.equal(b.faux.state.callCount, 0);
    assert.equal((await b.runtime.history()).messages.length, 0);
  } finally {
    await b.close();
  }
});

test("provider authentication failure is a safe category rather than an echoed upstream secret", async () => {
  const b = await bench();
  try {
    await b.runtime.configure(config);
    b.faux.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "401 unauthorized fixture-only-key",
      }),
    ]);
    await b.runtime.submit("r_autherror01", "hello");
    await until(async () => (await b.runtime.submission("r_autherror01"))?.status === "unanswered");
    assert.equal((await b.runtime.submission("r_autherror01"))?.reason, "model_authentication");
    assert.equal(
      (b.runtime.snapshot() as { failure?: { code: string } }).failure?.code,
      "model_authentication",
    );
    assert.equal(JSON.stringify(b.runtime.snapshot()).includes(config.apiKey), false);
  } finally {
    await b.close();
  }
});

test("queue limits are atomic, duplicates keep their receipt, and stopping closes new admissions", async () => {
  const b = await bench(1);
  try {
    await b.runtime.configure(config);
    b.faux.setResponses([
      fauxAssistantMessage(
        "This answer remains in flight while sixteen inputs reserve the bounded queue.",
      ),
    ]);
    const first = await b.runtime.submit("r_limit_0000", "first");
    for (let index = 1; index < 16; index += 1)
      await b.runtime.submit(`r_limit_${String(index).padStart(4, "0")}`, "queued");
    await assert.rejects(b.runtime.submit("r_limit_0016", "overflow"), /limit_exceeded/);
    assert.equal((await b.runtime.submit("r_limit_0000", "first")).id, first.id);
    const stopped = b.runtime.abort();
    await assert.rejects(b.runtime.abort(), /cancellation_unconfirmed/);
    await assert.rejects(b.runtime.configure(config), /busy/);
    await stopped;
    await b.runtime.configure({ ...config, apiKey: "" });
    assert.equal((await b.runtime.submit("r_limit_0000", "first")).id, first.id);
    for (const [before, limit] of [
      [0, 100],
      [1.5, 100],
      [undefined, 0],
      [undefined, 101],
    ] as const) {
      await assert.rejects(b.runtime.history(before, limit), /invalid_command/);
    }
    await assert.rejects(b.runtime.submit("r_empty_001", "   "), /invalid_command/);
    await b.runtime.close();
    await assert.rejects(b.runtime.submit("r_closed_01", "closed"), /shutting_down/);
  } finally {
    await b.close();
  }
});
