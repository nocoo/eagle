import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ChatRuntime } from "../src/runtime.ts";

const config = {
  baseUrl: "http://127.0.0.1:1/v1",
  model: "test",
  thinkingLevel: "off" as const,
  apiKey: "fixture-key",
};

test("one real storage failure keeps one failure identity across SDK report and close channels", async () => {
  const root = await mkdtemp(join(tmpdir(), "superagent-fault-"));
  let fail = false;
  const runtime = await ChatRuntime.open(root, undefined, async (path) => {
    const storage = await openNodeSqliteStorage(path);
    const commit = storage.commit.bind(storage);
    storage.commit = async (...args) => {
      if (fail) throw new Error("fixture_storage_failure");
      return commit(...args);
    };
    return storage;
  });
  try {
    await runtime.configure(config);
    const failures = new Set<string>();
    runtime.observe((value) => {
      if (value.failure) failures.add(value.failure.id);
    });
    fail = true;
    await assert.rejects(runtime.submit("r_storage_01", "must fail closed"));
    assert.equal(runtime.snapshot().failure?.code, "storage_failed");
    await assert.rejects(
      runtime.submit("r_storage_02", "no recovery by new input"),
      /storage_failed/,
    );
    await runtime.close();
    assert.equal(failures.size, 1);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed Harness open and failed root initialization release their real storage", async () => {
  for (const phase of ["open", "root"] as const) {
    const root = await mkdtemp(join(tmpdir(), "superagent-open-fault-"));
    let closes = 0;
    try {
      await assert.rejects(
        ChatRuntime.open(root, undefined, async (path) => {
          const storage = await openNodeSqliteStorage(path);
          const close = storage.close.bind(storage);
          storage.close = async (...args) => {
            closes += 1;
            return close(...args);
          };
          if (phase === "open")
            storage.scanTasks = async () => {
              throw new Error("fixture_open_failure");
            };
          else
            storage.mintId = async () => {
              throw new Error("fixture_root_failure");
            };
          return storage;
        }),
      );
      assert.ok(closes > 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
