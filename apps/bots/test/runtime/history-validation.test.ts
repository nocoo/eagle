import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getSystemMessageText } from "@earendil-works/pi-ai";
import { ClassifiedFailure } from "../../src/core/domain.ts";
import { type HistoryBundle, hash, validateBundle } from "../../src/runtime/pi/HistoryReplica.ts";
import { createBench, text, trace, waitFor } from "../support/pi.ts";

const fixture = JSON.parse(
  await readFile(
    new URL("../../../../fixtures/bots-sync/history.v1.json", import.meta.url),
    "utf8",
  ),
) as HistoryBundle;
const rehash = (value: Record<string, unknown>) => {
  const { head: _old, ...payload } = value;
  return { ...payload, head: hash(payload) };
};
test("the normative history fixture retains all original JSON fields", () => {
  assert.deepEqual(validateBundle(fixture), fixture);
  const { head, entries, ...rest } = fixture;
  const { head: _digest, ...payload } = fixture;
  assert.equal(head, createHash("sha256").update(JSON.stringify(payload)).digest("hex"));
  assert.deepEqual(
    validateBundle({ entries, head, ...rest }),
    fixture,
    "validation normalizes known envelope fields while retaining original model/data key order",
  );
});

test("different SDK section prompt orders cannot share a history head", () => {
  const first = fixture.entries[0];
  assert.ok(first);
  const sections = [
    ["bots-tools", "core instructions"],
    ["bots-herdr", "Herdr instructions"],
  ];
  const system = (ordered: string[][]) => ({
    role: "system" as const,
    content: "base prompt",
    timestamp: 0,
    sections: Object.fromEntries(ordered),
  });
  const forward = system(sections);
  const backward = system(sections.toReversed());
  assert.notEqual(getSystemMessageText(forward), getSystemMessageText(backward));
  const bundle = (message: typeof forward) =>
    rehash({
      ...fixture,
      entries: fixture.entries.map((entry) =>
        entry === first ? { ...entry, model: [message] } : entry,
      ),
    });
  const a = bundle(forward);
  const b = bundle(backward);
  assert.notEqual(a.head, b.head, "the digest binds section insertion order used by the SDK");
  validateBundle(a);
  validateBundle(b);
});

for (const [name, params] of [
  ["request ID grammar", { requestId: "bad.id", text: "valid prompt" }],
  ["request ID lower bound", { requestId: "short", text: "valid prompt" }],
  ["request ID upper bound", { requestId: "r".repeat(65), text: "valid prompt" }],
  ["ASCII code point bound", { requestId: "r_boundary", text: "x".repeat(8001) }],
  ["Unicode code point bound", { requestId: "r_boundary", text: "😀".repeat(8001) }],
] as const) {
  test(`local replica run respects existing ${name} without admission`, async () => {
    const bench = await createBench();
    const handle = await bench.runtime.open(bench.spec());
    assert.ok(handle.replica);
    try {
      await handle.replica({ method: "import", params: { bundle: fixture }, trace });
      await assert.rejects(
        handle.replica({ method: "run", params: { head: fixture.head, ...params }, trace }),
        (error: unknown) => {
          assert.ok(error instanceof ClassifiedFailure);
          assert.equal(error.failure.kind, "invalid_command");
          assert.equal(error.failure.layer, "runtime");
          assert.match(error.failure.id, /^f_[A-Za-z0-9_-]{1,32}$/);
          assert.equal(error.disposition, "not_admitted");
          return true;
        },
      );
      assert.equal(bench.faux.state.callCount, 0);
      assert.deepEqual(await handle.busy(), { run: false, tasks: false });
      assert.deepEqual(
        await handle.replica({ method: "status", params: { requestId: "r_boundary" }, trace }),
        { submission: null },
      );
    } finally {
      await handle.close(trace, 5000);
      await bench.cleanup();
    }
  });
}

test("preflight failures use the normal f_ identity", () => {
  assert.throws(
    () => validateBundle({}),
    (error: unknown) => {
      assert.ok(error instanceof ClassifiedFailure);
      assert.match(error.failure.id, /^f_[A-Za-z0-9_-]{1,32}$/);
      return true;
    },
  );
});

test("the 8000-code-point Unicode boundary and 8/64-character IDs remain admissible", async () => {
  const bench = await createBench();
  const handle = await bench.runtime.open(bench.spec());
  assert.ok(handle.replica);
  try {
    await handle.replica({ method: "import", params: { bundle: fixture }, trace });
    bench.faux.setResponses([text("minimum ID"), text("maximum ID")]);
    for (const requestId of ["valid_id", "r".repeat(64)]) {
      await handle.replica({
        method: "run",
        params: { head: fixture.head, requestId, text: "😀".repeat(8000) },
        trace,
      });
      await waitFor(async () => {
        assert.ok(handle.replica);
        const status = (await handle.replica({
          method: "status",
          params: { requestId },
          trace,
        })) as { submission: { status: string } };
        return status.submission.status === "done";
      }, "the valid boundary run to settle");
    }
    assert.equal(bench.faux.state.callCount, 2);
  } finally {
    await handle.close(trace, 5000);
    await bench.cleanup();
  }
});

test("malformed history, model content and missing dependencies fail before passive writes", async () => {
  const bench = await createBench();
  const handle = await bench.runtime.open(bench.spec());
  assert.ok(handle.replica);
  try {
    const invalid: unknown[] = [
      { ...fixture, head: "0".repeat(64) },
      rehash({ ...fixture, engine: "unknown" }),
      rehash({ ...fixture, entries: fixture.entries.slice(1) }),
      rehash({ ...fixture, entries: fixture.entries.toReversed() }),
      rehash({ ...fixture, entries: [...fixture.entries, fixture.entries[0]] }),
      rehash({ ...fixture, origins: {} }),
      rehash({ ...fixture, entries: [{ ...fixture.entries[0], head: 9999 }] }),
      rehash({
        ...fixture,
        entries: [{ ...fixture.entries[0], edits: [{ target: 9999, action: "omit" }] }],
      }),
      rehash({
        ...fixture,
        resources: [{ name: "bad", kind: "attachment", sha256: "0".repeat(64), base64: "YQ==" }],
      }),
      rehash({
        ...fixture,
        resources: [
          { name: "bad", kind: "attachment", sha256: "0".repeat(64), base64: "invalid==" },
        ],
      }),
    ];
    for (const model of [
      [{ role: "user", content: 3, timestamp: 0 }],
      [{ role: "user", content: [{ type: "text", text: 3 }], timestamp: 0 }],
      [{ role: "assistant", content: [], timestamp: 0 }],
      [{ role: "toolResult", content: [], timestamp: 0 }],
      [{ role: "system", content: "x", timestamp: 0, toolsAdded: [{ name: "missing schema" }] }],
      [{ role: "assistant", content: [{ type: "toolCall", arguments: [] }] }],
    ])
      invalid.push(rehash({ ...fixture, entries: [{ ...fixture.entries[0], model }] }));
    for (const bundle of invalid) {
      await assert.rejects(
        handle.replica({ method: "import", params: { bundle }, trace }),
        /invalid|mismatch|missing|unordered/,
      );
    }
    assert.equal(bench.faux.state.callCount, 0);
    assert.deepEqual(await handle.busy(), { run: false, tasks: false });
    assert.deepEqual(
      await handle.replica({ method: "status", params: { requestId: "absent-id" }, trace }),
      { submission: null },
    );
    await assert.rejects(handle.replica({ method: "export", params: {}, trace }), /empty/);
    await assert.rejects(
      handle.replica({ method: "export", params: { head: fixture.head }, trace }),
      /unknown/,
    );
    await assert.rejects(
      handle.replica({ method: "export", params: { branch: "unknown-id" }, trace }),
      /unknown/,
    );
    await assert.rejects(
      handle.replica({
        method: "run",
        params: { head: fixture.head, requestId: "unknown-id", text: "no" },
        trace,
      }),
      /unknown/,
    );
    await handle.replica({ method: "import", params: { bundle: fixture }, trace });
    assert.deepEqual(
      await handle.replica({ method: "export", params: { head: fixture.head }, trace }),
      fixture,
    );
    const edited = (await handle.replica({
      method: "export",
      params: { head: fixture.head, resources: [] },
      trace,
    })) as HistoryBundle;
    assert.deepEqual(edited.parents, [fixture.head]);
    assert.deepEqual(edited.resources, []);
    assert.deepEqual(edited.agent, fixture.agent);
    assert.deepEqual(
      await handle.replica({
        method: "export",
        params: { head: fixture.head, resources: [] },
        trace,
      }),
      edited,
    );
    await assert.rejects(
      handle.replica({
        method: "export",
        params: { head: fixture.head, branch: "unknown-id", resources: [] },
        trace,
      }),
      /select/,
    );
    const unavailable = rehash({
      ...fixture,
      agent: { ...fixture.agent, extensions: ["not-installed"] },
    });
    await handle.replica({ method: "import", params: { bundle: unavailable }, trace });
    await assert.rejects(
      handle.replica({
        method: "run",
        params: { head: unavailable.head, requestId: "extension", text: "no" },
        trace,
      }),
      /unavailable extensions/,
    );
    await assert.rejects(
      handle.replica({
        method: "import",
        params: { bundle: { ...fixture, ignored: "x".repeat(8 * 1024 * 1024) } },
        trace,
      }),
      /limit/,
    );
  } finally {
    await handle.close(trace, 5000);
    await bench.cleanup();
  }
});
