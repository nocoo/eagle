import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { emptySnapshot } from "../src/domain.ts";
import { project } from "../src/projection.ts";
import { ChatRuntime } from "../src/runtime.ts";
import { startService } from "../src/server.ts";

test("a completed bootstrap writes a private marker and a later start accepts it", async () => {
  const root = await mkdtemp(join(tmpdir(), "superagent-marker-"));
  try {
    const first = await startService({ root, port: 0 });
    await first.close();
    const marker = join(root, "session.initialized.json");
    assert.equal((await stat(marker)).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(marker, "utf8"))).sort(), [
      "storeId",
      "version",
    ]);
    const second = await startService({ root, port: 0 });
    await second.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stores with a wrong SQLite header or no pi tables are refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "superagent-invalid-"));
  const path = join(root, "session.sqlite");
  try {
    await writeFile(path, Buffer.concat([Buffer.from("SQLite format 4\0"), Buffer.alloc(200)]));
    await assert.rejects(ChatRuntime.open(root), /storage_failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const second = await mkdtemp(join(tmpdir(), "superagent-foreign-"));
  const foreignPath = join(second, "session.sqlite");
  try {
    const database = new DatabaseSync(foreignPath);
    database.exec(
      "CREATE TABLE foreign_only (value TEXT); INSERT INTO foreign_only VALUES (printf('%.*c', 300, 'x'));",
    );
    database.close();
    await assert.rejects(ChatRuntime.open(second), /storage_failed/);
  } finally {
    await rm(second, { recursive: true, force: true });
  }
});

test("a valid header with corrupted pages fails closed rather than reading as empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "superagent-corrupt-page-"));
  const path = join(root, "session.sqlite");
  try {
    const database = new DatabaseSync(path);
    database.exec(
      "CREATE TABLE entries (value TEXT); INSERT INTO entries VALUES (printf('%.*c', 400, 'x'));",
    );
    database.close();
    const buffer = await readFile(path);
    buffer.fill(0x41, 100, 240);
    await writeFile(path, buffer);
    await assert.rejects(ChatRuntime.open(root), /storage_failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("projection keeps runtime failures, ignores compaction entries, and reports a live window", () => {
  const message = (kind: string, role: string, text: string, id: number) =>
    ({
      id,
      kind,
      model: [{ role, timestamp: id, stopReason: "stop", content: [{ type: "text", text }] }],
    }) as unknown as EntryRecord;
  const view = {
    entries: [
      message("pi.user", "user", "question", 10),
      message("pi.compaction", "user", "summary", 12),
    ],
    docs: { "pi.live": { run: { taskId: 4, inputs: [1] }, generation: { attempt: 3 } } },
  } as unknown as ConversationView;
  const state = project(view, {
    ...emptySnapshot(),
    failure: { code: "model_timeout", id: "old" },
  });
  assert.deepEqual(
    state.messages.map((entry) => entry.text),
    ["question"],
  );
  assert.equal(state.running, true);
  assert.equal(
    state.failure,
    undefined,
    "a later successful view replaces an old ephemeral failure",
  );
  assert.equal(state.window.newestEntryId, 10);
});
