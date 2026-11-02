// The log sink (docs/bots/OBSERVABILITY.md "Record shape"): one JSON object per line, a
// size rotation with a fixed number of files, and a flush barrier a test can wait on.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { declareEvent } from "../../src/log/events.ts";
import { captureLog } from "../../src/log/log.ts";
import { FileLogSink } from "../../src/log/sink.ts";

const record = (index: number) => {
  const { log } = captureLog();
  return log.emit("info", "runtime", declareEvent("runtime.open.ok"), {
    trace: `tr_sink_${index}`,
  });
};

test("writes one json record per line, rotates, and keeps the newest files", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-sink-"));
  const day = "2026-01-01T00:00:00.000Z";
  try {
    const sink = new FileLogSink({ root, maxBytes: 300, keep: 3, now: () => new Date(day) });
    for (let index = 0; index < 8; index += 1) sink.write(record(index));
    await sink.flush();
    const files = (await readdir(join(root, "logs"))).sort();
    assert.deepEqual(files, [
      "daemon-20260101.jsonl",
      "daemon-20260101.jsonl.1",
      "daemon-20260101.jsonl.2",
    ]);
    const newest = await readFile(join(root, "logs", "daemon-20260101.jsonl"), "utf8");
    for (const line of newest.trim().split("\n")) {
      const parsed = JSON.parse(line) as { evt: string; trace: string };
      assert.equal(parsed.evt, declareEvent("runtime.open.ok"));
      assert.match(parsed.trace, /^tr_sink_/);
    }
    await sink.close();
    await sink.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("close drains accepted writes and never reopens for late writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-sink-"));
  const sink = new FileLogSink({ root, now: () => new Date("2026-01-02T00:00:00.000Z") });
  const path = join(root, "logs", "daemon-20260102.jsonl");
  try {
    sink.write(record(1));
    sink.write(record(2));
    const first = sink.close();
    sink.write(record(3));
    const second = sink.close();
    assert.equal(first, second, "concurrent callers wait for the same close");
    await Promise.all([first, second]);
    sink.write(record(4));
    await sink.flush();
    const rows = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { trace: string });
    assert.deepEqual(
      rows.map((row) => row.trace),
      ["tr_sink_1", "tr_sink_2"],
    );
  } finally {
    await sink.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("records below the minimum level never reach the file", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-sink-"));
  try {
    const sink = new FileLogSink({
      root,
      minimum: "warn",
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });
    const { log } = captureLog();
    sink.write(
      log.emit("info", "runtime", declareEvent("runtime.open.ok"), { trace: "tr_below_0001" }),
    );
    sink.write(
      log.emit("warn", "runtime", declareEvent("runtime.watch.end.ok"), {
        trace: "tr_above_0001",
        detail: { reason: "retired" },
      }),
    );
    await sink.flush();
    const body = await readFile(join(root, "logs", "daemon-20260102.jsonl"), "utf8");
    assert.equal(body.trim().split("\n").length, 1);
    assert.match(body, /tr_above_0001/);
    await sink.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a new day prunes older days so five files stay five files", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-sink-"));
  let day = 1;
  try {
    const sink = new FileLogSink({ root, keep: 5, now: () => new Date(Date.UTC(2026, 0, day)) });
    for (day = 1; day <= 8; day += 1) {
      sink.write(record(day));
      await sink.flush();
    }
    const files = (await readdir(join(root, "logs"))).sort();
    assert.equal(files.length, 5, "the retention bound holds across day boundaries");
    assert.deepEqual(files, [
      "daemon-20260104.jsonl",
      "daemon-20260105.jsonl",
      "daemon-20260106.jsonl",
      "daemon-20260107.jsonl",
      "daemon-20260108.jsonl",
    ]);
    await sink.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
