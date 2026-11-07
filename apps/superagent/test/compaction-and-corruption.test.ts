import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { emptySnapshot } from "../src/domain.ts";
import { entryMessage, project } from "../src/projection.ts";
import { ChatRuntime } from "../src/runtime.ts";

const config = {
  baseUrl: "http://127.0.0.1:1/v1",
  model: "test-model",
  thinkingLevel: "medium" as const,
  apiKey: "fixture-key",
};

test("an SDK compaction summary is not a chat turn and does not become a paging boundary", () => {
  const compaction = {
    id: 21,
    kind: "pi.compaction",
    model: [
      {
        role: "user",
        timestamp: 5,
        content: [{ type: "text", text: "Internal summary of older work" }],
      },
    ],
  } as unknown as EntryRecord;
  const user = {
    id: 10,
    kind: "pi.user",
    model: [{ role: "user", timestamp: 1, content: [{ type: "text", text: "real question" }] }],
  } as unknown as EntryRecord;
  const answer = {
    id: 15,
    kind: "pi.assistant",
    model: [
      {
        role: "assistant",
        timestamp: 2,
        stopReason: "stop",
        content: [{ type: "text", text: "real answer" }],
      },
    ],
  } as unknown as EntryRecord;
  assert.equal(entryMessage(compaction), undefined);
  const snapshot = project(
    { entries: [user, answer, compaction], docs: {} } as unknown as ConversationView,
    emptySnapshot(),
  );
  assert.deepEqual(
    snapshot.messages.map((message) => message.text),
    ["real question", "real answer"],
  );
  assert.equal(snapshot.window.oldestEntryId, 10);
  assert.equal(snapshot.window.newestEntryId, 15);
});

async function bench() {
  const root = await mkdtemp(join(tmpdir(), "superagent-corrupt-"));
  const faux = fauxProvider({
    provider: "superagent",
    models: [{ id: "test-model" }],
    tokensPerSecond: 10000,
  });
  const models = createModels();
  models.setProvider(faux.provider);
  return { root, faux, models };
}

async function seed(
  root: string,
  models: ReturnType<typeof createModels>,
  faux: ReturnType<typeof fauxProvider>,
) {
  const runtime = await ChatRuntime.open(root, models);
  await runtime.configure(config);
  faux.setResponses([fauxAssistantMessage("durable answer")]);
  await runtime.submit("r_corrupt_01", "hello");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await runtime.submission("r_corrupt_01"))?.status === "done") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await runtime.close();
}

test("a truncated zero-byte session database is refused instead of becoming a healthy empty chat", async () => {
  const b = await bench();
  try {
    await seed(b.root, b.models, b.faux);
    await truncate(join(b.root, "session.sqlite"), 0);
    await assert.rejects(ChatRuntime.open(b.root, b.models), /storage_failed/);
  } finally {
    await rm(b.root, { recursive: true, force: true });
  }
});

test("a missing session database after a completed first run is refused", async () => {
  const b = await bench();
  try {
    await seed(b.root, b.models, b.faux);
    await unlink(join(b.root, "session.sqlite"));
    await assert.rejects(ChatRuntime.open(b.root, b.models), /storage_failed/);
  } finally {
    await rm(b.root, { recursive: true, force: true });
  }
});

test("a corrupt non-SQLite database is refused without replacing the player's history", async () => {
  const b = await bench();
  try {
    await seed(b.root, b.models, b.faux);
    await writeFile(join(b.root, "session.sqlite"), "not a database");
    await assert.rejects(ChatRuntime.open(b.root, b.models), /storage_failed/);
  } finally {
    await rm(b.root, { recursive: true, force: true });
  }
});
