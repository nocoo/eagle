import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import { ConfigurationStore, publicConfiguration } from "../src/configuration.ts";
import { emptySnapshot, MAX_PAGE, type Message } from "../src/domain.ts";
import { confirmedWithin, modelFailure } from "../src/failure.ts";
import { ownRoot, readPrivate } from "../src/identity.ts";
import { boundedText, entryMessage, fitMessages, project } from "../src/projection.ts";
import { startService } from "../src/server.ts";

const config = {
  baseUrl: "https://example.invalid/v1",
  model: "test",
  thinkingLevel: "off" as const,
  apiKey: "fixture-only-key",
};

test("configuration keeps keys only in private storage, rejects corruption and leaves failed saves unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "superagent-config-"));
  try {
    const store = new ConfigurationStore(root);
    await store.load();
    assert.equal(publicConfiguration(store.value), null);
    const { apiKey: _key, ...withoutKey } = config;
    await store.save(withoutKey);
    assert.equal(store.value?.apiKey, "");
    await store.save(config);
    await store.save({ ...withoutKey, model: "next" });
    assert.equal(store.value?.apiKey, config.apiKey);
    assert.equal(publicConfiguration(store.value)?.hasApiKey, true);
    const reopened = new ConfigurationStore(root);
    await reopened.load();
    assert.equal(reopened.value?.model, "next");
    for (const baseUrl of [
      "bad",
      "file:///tmp/x",
      "https://example.invalid?key=x",
      "https://example.invalid#secret",
    ]) {
      await assert.rejects(store.save({ ...config, baseUrl }), /invalid_command/);
    }
    await writeFile(store.path, "broken", { mode: 0o600 });
    await assert.rejects(new ConfigurationStore(root).load(), /storage_failed/);
    await writeFile(store.path, JSON.stringify(withoutKey), { mode: 0o600 });
    await assert.rejects(new ConfigurationStore(root).load(), /storage_failed/);
    await rm(store.path);
    await mkdir(store.path);
    await assert.rejects(store.save(config), /storage_failed/);
    assert.equal(store.value?.model, "next");
    assert.equal(
      (await readdir(root)).some((name) => name.endsWith(".tmp")),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private-file readers refuse symlinks, oversized files and unsafe modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "superagent-private-"));
  try {
    const file = join(root, "file");
    await writeFile(file, "safe", { mode: 0o600 });
    assert.equal(await readPrivate(file), "safe");
    await symlink(file, join(root, "link"));
    await assert.rejects(readPrivate(join(root, "link")));
    await writeFile(file, "x".repeat(65537));
    await assert.rejects(readPrivate(file), /too_large/);
    await chmod(file, 0o644);
    await assert.rejects(readPrivate(file), /unsafe/);
    await assert.rejects(ownRoot("relative"), /absolute_root_required/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model errors have only safe categories and cancellation timeout does not cancel the underlying work", async () => {
  assert.equal(modelFailure("request timed out"), "model_timeout");
  assert.equal(modelFailure({ status: 403 }), "model_authentication");
  assert.equal(modelFailure(undefined), "model_error");
  assert.equal(await confirmedWithin(Promise.resolve(42), 100), 42);
  await assert.rejects(confirmedWithin(Promise.reject(new Error("failed")), 100), /failed/);
  let finish!: (value: string) => void;
  const pending = new Promise<string>((resolve) => {
    finish = resolve;
  });
  await assert.rejects(confirmedWithin(pending, 1), /cancellation_unconfirmed/);
  finish("still finishes");
  assert.equal(await pending, "still finishes");
});

const entry = (value: unknown) => value as EntryRecord;
const view = (value: unknown) => value as ConversationView;

test("projection preserves text boundaries, suppresses hidden reasoning, and labels errors and empty windows", () => {
  assert.equal(boundedText("abc", 3), "abc");
  assert.equal(boundedText("你好世界", 2), "你好\n[truncated]");
  assert.equal(entryMessage(entry({ id: 1 })), undefined);
  assert.equal(
    entryMessage(entry({ id: 2, model: [{ role: "toolResult", content: [] }] })),
    undefined,
  );
  const failed = entryMessage(
    entry({
      id: 3,
      model: [
        {
          role: "assistant",
          timestamp: 1,
          stopReason: "error",
          content: [{ type: "text", text: "private upstream" }],
        },
      ],
    }),
  );
  assert.equal(failed?.text.includes("private"), false);
  const aborted = entryMessage(
    entry({
      id: 4,
      model: [
        {
          role: "assistant",
          timestamp: 2,
          stopReason: "aborted",
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: "kept" },
          ],
        },
      ],
    }),
  );
  assert.equal(aborted?.state, "aborted");
  assert.equal(aborted.text, "kept");
  const empty = project(view({ entries: [], docs: {} }), emptySnapshot());
  assert.deepEqual(empty.window, { oldestEntryId: null, newestEntryId: null, coverage: "window" });
  const state = project(
    view({
      entries: [{ id: 5, kind: "internal" }],
      docs: {
        "pi.live": {
          generation: {
            message: {
              role: "assistant",
              content: [{ type: "text", text: "partial" }],
              timestamp: 3,
            },
          },
        },
        "pi.inbox": {
          items: [
            { id: 6, mode: "write" },
            { id: 7, mode: "followUp", content: [] },
          ],
        },
      },
    }),
    { ...emptySnapshot(), failure: { code: "storage_failed", id: "f1" } },
  );
  assert.equal(state.messages[0]?.id, "p_0");
  assert.equal(state.pending[0]?.text, "Queued message");
  assert.equal(state.pending[0]?.requestId, "");
  assert.equal(state.failure?.id, "f1");
  const messages: Message[] = Array.from({ length: 110 }, (_, index) => ({
    id: `e_${index}`,
    role: "user",
    text: "x".repeat(32000),
    state: "complete",
    createdAt: index,
  }));
  const fitted = fitMessages(messages);
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= MAX_PAGE);
  assert.equal(fitted.at(-1)?.id, "e_109");
});

test("HTTP listen failure releases the root and a corrupt runtime store does not become an empty healthy chat", async () => {
  const root = await mkdtemp(join(tmpdir(), "superagent-bind-"));
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  try {
    await assert.rejects(startService({ root, port: address.port }), /EADDRINUSE/);
    const service = await startService({ root, port: 0 });
    await service.close();
    const identity = await readFile(join(root, "identity.json"), "utf8");
    await writeFile(join(root, "session.sqlite"), "not sqlite");
    await assert.rejects(startService({ root, port: 0 }));
    assert.equal(await readFile(join(root, "identity.json"), "utf8"), identity);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
