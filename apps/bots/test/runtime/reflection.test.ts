import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness, StorageRequestError, UsageDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ClassifiedFailure, type Failure } from "../../src/core/domain.ts";
import type { RuntimeEvent } from "../../src/core/RuntimePort.ts";
import { convertUsage } from "../../src/runtime/pi/convert.ts";
import type { UsageEntry } from "../../src/tools/usage.ts";
import {
  assistant,
  createBench,
  providerError,
  text,
  toolCall,
  trace,
  waitFor,
} from "../support/pi.ts";

test("reflection updates the note without replacing the user's answer", async () => {
  const notes: string[] = [];
  const bench = await createBench({
    note: (spec) => ({
      botId: spec.id,
      async set(value) {
        notes.push(value);
        return value === "" ? {} : { note: value };
      },
      current: () => (notes.length === 0 ? {} : { note: notes.at(-1) ?? "" }),
    }),
  });
  const events: RuntimeEvent[] = [];
  const handle = await bench.runtime.open(bench.spec());
  try {
    await handle.subscribe(trace, (event) => events.push(event));
    bench.faux.setResponses([
      text("The investigation is underway."),
      assistant([toolCall("note_set", { text: "Investigating the deployment" })], {
        stopReason: "toolUse",
      }),
      text("Internal reflection complete."),
    ]);
    await handle.submit({
      requestId: "r_reflection_1",
      text: "Investigate the deployment.",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      () => events.some((event) => event.type === "submission" && event.record.status === "done"),
      "the reflected run to settle",
    );
    assert.ok(notes.includes("Investigating the deployment"), "the reflection calls note_set");
    const messages = events.flatMap((event) => (event.type === "append" ? [event.message] : []));
    const answer = messages.find(
      (message) =>
        message.role === "assistant" &&
        message.id.startsWith("e_") &&
        message.blocks.some(
          (block) => block.type === "text" && block.text === "The investigation is underway.",
        ),
    );
    assert.ok(answer, "the original answer is visible");
    assert.ok(
      messages.some((message) =>
        message.blocks.some((block) => block.type === "toolCall" && block.name === "note_set"),
      ),
      "the real reflection tool call is visible",
    );
    const history = await handle.history({ limit: 50 });
    assert.ok(
      history.messages.some((message) =>
        message.blocks.some((block) => block.type === "toolCall" && block.name === "note_set"),
      ),
      "the tool call remains visible in history",
    );
    const later = await handle.subscribe("tr_reflection_late", () => undefined);
    for (const message of [...history.messages, ...later.snapshot.messages]) {
      assert.equal(
        message.blocks.some(
          (block) =>
            block.type === "text" &&
            (block.text === "Internal reflection complete." ||
              block.text.startsWith("Before finishing")),
        ),
        false,
      );
    }
    later.detach();
    assert.equal(
      messages.some((message) =>
        message.blocks.some(
          (block) => block.type === "text" && block.text === "Internal reflection complete.",
        ),
      ),
      false,
      "the reflection answer is not published",
    );
    const settled = events.find(
      (event) => event.type === "submission" && event.record.status === "done",
    );
    assert.equal(
      settled?.type === "submission" ? settled.record.answerEntryId : undefined,
      answer.id,
    );
  } finally {
    await handle.close(trace, 1_000);
    await bench.cleanup();
  }
});

test("a candidate survives a failed catalog write and is recovered on reopen", async () => {
  const notes: string[] = [];
  let fail = true;
  const failure: Failure = { id: "f_reflection_note", kind: "storage_failed", layer: "core" };
  const bench = await createBench({
    note: (spec) => ({
      botId: spec.id,
      async set(value) {
        if (fail) throw new ClassifiedFailure(failure, "unknown", "catalog unavailable");
        notes.push(value);
        return value === "" ? {} : { note: value };
      },
      current: () => (notes.length === 0 ? {} : { note: notes.at(-1) ?? "" }),
    }),
  });
  const events: RuntimeEvent[] = [];
  const handle = await bench.runtime.open(bench.spec());
  try {
    await handle.subscribe(trace, (event) => events.push(event));
    bench.faux.setResponses([
      text("Original answer."),
      assistant([toolCall("note_set", { text: "Waiting for approval" })], {
        stopReason: "toolUse",
      }),
      text("Checked."),
    ]);
    await handle.submit({
      requestId: "r_candidate_recover",
      text: "Question",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      () => bench.records.some((entry) => entry.evt === "core.catalog.write.fail"),
      "the catalog write failure",
    );
    assert.equal(notes.length, 0);
    assert.equal(await handle.close(trace, 1_000), "closed");
    fail = false;
    const reopened = await bench.runtime.open(bench.spec());
    try {
      await waitFor(() => notes.includes("Waiting for approval"), "the recovered candidate");
    } finally {
      await reopened.close(trace, 1_000);
    }
  } finally {
    await handle.close(trace, 1_000);
    await bench.cleanup();
  }
});

test("reflection setup failure preserves fallback unless a person changed the note", async () => {
  for (const changeNote of [false, true]) {
    let current = { note: "Original", at: "1", revision: "1" };
    let inject = false;
    const bench = await createBench({
      storage: async (path) => {
        const storage = await openNodeSqliteStorage(path);
        return new Proxy(storage, {
          get(target, property, receiver) {
            if (property === "scanEntries") {
              return async (...args: Parameters<typeof target.scanEntries>) => {
                if (inject) {
                  inject = false;
                  if (changeNote) current = { note: "Person's note", at: "2", revision: "2" };
                  throw new StorageRequestError("reflection setup refused");
                }
                return target.scanEntries(...args);
              };
            }
            return Reflect.get(target, property, receiver);
          },
        });
      },
      note: (spec) => ({
        botId: spec.id,
        async set(value, revision) {
          if (revision !== undefined && revision !== current.revision) return { applied: false };
          current = { note: value, at: "3", revision: "3" };
          return { note: value, applied: true };
        },
        current: () => current,
      }),
    });
    const events: RuntimeEvent[] = [];
    const handle = await bench.runtime.open(bench.spec());
    try {
      await handle.subscribe(trace, (event) => events.push(event));
      bench.faux.setResponses([
        () => {
          inject = true;
          return text("Fallback answer.");
        },
      ]);
      await handle.submit({
        requestId: `r_setup_${changeNote}`,
        text: "Question",
        whenBusy: "followUp",
        trace,
      });
      await waitFor(
        () => events.some((event) => event.type === "submission" && event.record.status === "done"),
        "the answer",
      );
      await handle.close(trace, 1_000);
      assert.equal(current.note, changeNote ? "Person's note" : "Fallback answer.");
    } finally {
      await handle.close(trace, 1_000);
      await bench.cleanup();
    }
  }
});

test("a failed fallback write is recovered after reopen", async () => {
  const notes: string[] = [];
  let fail = true;
  const failure: Failure = { id: "f_fallback_recover", kind: "storage_failed", layer: "core" };
  const bench = await createBench({
    note: (spec) => ({
      botId: spec.id,
      async set(value) {
        if (fail) throw new ClassifiedFailure(failure, "unknown", "catalog unavailable");
        notes.push(value);
        return value === "" ? {} : { note: value };
      },
      current: () => (notes.length === 0 ? {} : { note: notes.at(-1) ?? "" }),
    }),
  });
  const handle = await bench.runtime.open(bench.spec());
  try {
    await handle.subscribe(trace, () => undefined);
    bench.faux.setResponses([text("Original answer."), text("No update needed.")]);
    await handle.submit({
      requestId: "r_fallback_recover",
      text: "Question",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      () => bench.records.some((entry) => entry.evt === "core.catalog.write.fail"),
      "the fallback write failure",
    );
    assert.equal(await handle.close(trace, 1_000), "closed");
    fail = false;
    const reopened = await bench.runtime.open(bench.spec());
    try {
      assert.equal(notes.at(-1), "Original answer.");
    } finally {
      await reopened.close(trace, 1_000);
    }
  } finally {
    await handle.close(trace, 1_000);
    await bench.cleanup();
  }
});

test("a queued user message does not hide a prior committed candidate on reopen", async () => {
  const notes: string[] = [];
  let fail = true;
  let release = () => {};
  let reflectionStarted = () => {};
  let secondStarted = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reflection = new Promise<void>((resolve) => {
    reflectionStarted = resolve;
  });
  const second = new Promise<void>((resolve) => {
    secondStarted = resolve;
  });
  const deadline = async (value: Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        value,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("queued run did not reach its barrier")),
            5_000,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const failure: Failure = { id: "f_queued_candidate", kind: "storage_failed", layer: "core" };
  const bench = await createBench({
    note: (spec) => ({
      botId: spec.id,
      async set(value) {
        if (fail) throw new ClassifiedFailure(failure, "unknown", "catalog unavailable");
        notes.push(value);
        return value === "" ? {} : { note: value };
      },
      current: () => (notes.length === 0 ? {} : { note: notes.at(-1) ?? "" }),
    }),
  });
  const handle = await bench.runtime.open(bench.spec());
  try {
    await handle.subscribe(trace, () => undefined);
    bench.faux.setResponses([
      text("First answer."),
      async () => {
        reflectionStarted();
        await gate;
        return assistant([toolCall("note_set", { text: "First topic" })], {
          stopReason: "toolUse",
        });
      },
      text("Checked."),
      (_context, options) =>
        new Promise((_resolve, reject) => {
          secondStarted();
          options?.signal?.addEventListener("abort", () => reject(new Error("interrupted")), {
            once: true,
          });
        }),
    ]);
    await handle.submit({
      requestId: "r_recover_queue_1",
      text: "First",
      whenBusy: "followUp",
      trace,
    });
    await deadline(reflection);
    await handle.submit({
      requestId: "r_recover_queue_2",
      text: "Second",
      whenBusy: "followUp",
      trace,
    });
    release();
    await deadline(second);
    await waitFor(
      () => bench.records.some((entry) => entry.evt === "core.catalog.write.fail"),
      "the first note write to fail",
    );
    assert.equal(await handle.close(trace, 1_000), "closed");
    fail = false;
    bench.faux.setResponses([
      (_context, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("interrupted")), {
            once: true,
          });
        }),
    ]);
    const reopened = await bench.runtime.open(bench.spec());
    try {
      assert.equal(notes.at(-1), "First topic");
    } finally {
      await reopened.close(trace, 1_000);
    }
  } finally {
    release();
    await handle.close(trace, 1_000);
    await bench.cleanup();
  }
});

test("reopen recognizes an earlier reflection write when recovering the next candidate", async () => {
  let current: { note: string; at: string; revision: string; owner?: number } = {
    note: "Original",
    at: "0",
    revision: "0",
  };
  let failSecond = true;
  let releaseFirst = () => {};
  let releaseModel = () => {};
  let firstWriteStarted = false;
  let modelStarted = false;
  const writeGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const modelGate = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  const failure: Failure = { id: "f_ordered_candidate", kind: "storage_failed", layer: "core" };
  const bench = await createBench({
    note: (spec) => ({
      botId: spec.id,
      async set(value, revision, owner) {
        if (value === "First topic") {
          firstWriteStarted = true;
          await writeGate;
        }
        if (value === "Second topic" && failSecond)
          throw new ClassifiedFailure(failure, "unknown", "catalog unavailable");
        if (revision !== undefined && revision !== current.revision) return { applied: false };
        current = {
          note: value,
          at: value,
          revision: value,
          ...(owner === undefined ? {} : { owner }),
        };
        return { note: value, applied: true };
      },
      current: () => current,
    }),
  });
  const events: RuntimeEvent[] = [];
  const handle = await bench.runtime.open(bench.spec());
  try {
    await handle.subscribe(trace, (event) => events.push(event));
    bench.faux.setResponses([
      async () => {
        modelStarted = true;
        await modelGate;
        return text("First answer.");
      },
      assistant([toolCall("note_set", { text: "First topic" })], { stopReason: "toolUse" }),
      text("Checked first."),
      text("Second answer."),
      assistant([toolCall("note_set", { text: "Second topic" })], { stopReason: "toolUse" }),
      text("Checked second."),
    ]);
    await handle.submit({ requestId: "r_ordered_1", text: "First", whenBusy: "followUp", trace });
    await waitFor(() => modelStarted, "the first request");
    await handle.submit({ requestId: "r_ordered_2", text: "Second", whenBusy: "followUp", trace });
    releaseModel();
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === "submission" &&
            event.record.requestId === "r_ordered_2" &&
            event.record.status === "done",
        ),
      "the second answer",
    );
    await waitFor(() => firstWriteStarted, "the first note write");
    releaseFirst();
    await waitFor(
      () => bench.records.some((entry) => entry.evt === "core.catalog.write.fail"),
      "the second write failure",
    );
    assert.equal(current.note, "First topic");
    assert.ok(current.owner !== undefined);
    assert.equal(await handle.close(trace, 1_000), "closed");
    failSecond = false;
    const reopened = await bench.runtime.open(bench.spec());
    try {
      assert.equal(current.note, "Second topic");
    } finally {
      await reopened.close(trace, 1_000);
    }
  } finally {
    releaseModel();
    releaseFirst();
    await handle.close(trace, 1_000);
    await bench.cleanup();
  }
});

test("a queued candidate survives an earlier fallback and restart", async () => {
  let current: { note: string; at: string; revision: string; owner?: number } = {
    note: "Original",
    at: "0",
    revision: "0",
  };
  let failSecond = true;
  let releaseFirst = () => {};
  let releaseModel = () => {};
  let firstWriteStarted = false;
  let modelStarted = false;
  const writeGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const modelGate = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  const failure: Failure = { id: "f_fallback_candidate", kind: "storage_failed", layer: "core" };
  const bench = await createBench({
    note: (spec) => ({
      botId: spec.id,
      async set(value, revision, owner) {
        if (value === "First answer.") {
          firstWriteStarted = true;
          await writeGate;
        }
        if (value === "Second topic" && failSecond)
          throw new ClassifiedFailure(failure, "unknown", "catalog unavailable");
        if (revision !== undefined && revision !== current.revision) return { applied: false };
        current = {
          note: value,
          at: value,
          revision: value,
          ...(owner === undefined ? {} : { owner }),
        };
        return { note: value, applied: true };
      },
      current: () => current,
    }),
  });
  const events: RuntimeEvent[] = [];
  const handle = await bench.runtime.open(bench.spec());
  try {
    await handle.subscribe(trace, (event) => events.push(event));
    bench.faux.setResponses([
      async () => {
        modelStarted = true;
        await modelGate;
        return text("First answer.");
      },
      text("No update needed."),
      text("Second answer."),
      assistant([toolCall("note_set", { text: "Second topic" })], { stopReason: "toolUse" }),
      text("Checked second."),
    ]);
    await handle.submit({ requestId: "r_fallback_1", text: "First", whenBusy: "followUp", trace });
    await waitFor(() => modelStarted, "the first request");
    await handle.submit({ requestId: "r_fallback_2", text: "Second", whenBusy: "followUp", trace });
    releaseModel();
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === "submission" &&
            event.record.requestId === "r_fallback_2" &&
            event.record.status === "done",
        ),
      "the second answer",
    );
    await waitFor(() => firstWriteStarted, "the first fallback write");
    releaseFirst();
    assert.equal(await handle.close(trace, 1_000), "closed");
    assert.ok(
      bench.records.some((entry) => entry.evt === "core.catalog.write.fail"),
      "the second write was attempted",
    );
    assert.equal(current.note, "First answer.");
    assert.ok(current.owner !== undefined);
    failSecond = false;
    const reopened = await bench.runtime.open(bench.spec());
    try {
      assert.equal(current.note, "Second topic");
    } finally {
      await reopened.close(trace, 1_000);
    }
  } finally {
    releaseModel();
    releaseFirst();
    await handle.close(trace, 1_000);
    await bench.cleanup();
  }
});

test("a regenerated answer never applies a candidate from the abandoned answer", async () => {
  const notes: string[] = [];
  let started = () => {};
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const bench = await createBench({
    note: (spec) => ({
      botId: spec.id,
      async set(value) {
        notes.push(value);
        return value === "" ? {} : { note: value };
      },
      current: () => (notes.length === 0 ? {} : { note: notes.at(-1) ?? "" }),
    }),
  });
  const handle = await bench.runtime.open(bench.spec());
  try {
    await handle.subscribe(trace, () => undefined);
    bench.faux.setResponses([
      text("The first answer."),
      assistant([toolCall("note_set", { text: "Status from the first answer" })], {
        stopReason: "toolUse",
      }),
      (_context, options) =>
        new Promise((_resolve, reject) => {
          started();
          options?.signal?.addEventListener("abort", () => reject(new Error("interrupted")), {
            once: true,
          });
        }),
    ]);
    await handle.submit({
      requestId: "r_candidate_restart",
      text: "Question",
      whenBusy: "followUp",
      trace,
    });
    await Promise.race([
      waiting,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("reflection did not reach its last request")),
          5_000,
        );
        timer.unref();
      }),
    ]);
    assert.equal(await handle.close(trace, 1_000), "closed");
    const reply = (context: { messages: readonly { role: string; content?: unknown }[] }) =>
      context.messages.some(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.startsWith("Before finishing"),
      )
        ? text("Checked.")
        : text("The regenerated answer.");
    bench.faux.setResponses([reply, reply, reply, reply]);
    const events: RuntimeEvent[] = [];
    const reopened = await bench.runtime.open(bench.spec());
    try {
      await reopened.subscribe(trace, (event) => events.push(event));
      await waitFor(
        () =>
          events.some((event) => event.type === "submission" && event.record.status === "done") ||
          notes.length > 0,
        "the recovered run to settle",
      );
      await waitFor(() => notes.length > 0, "the final note");
      assert.equal(notes.includes("Status from the first answer"), false);
      assert.equal(notes.at(-1), "The regenerated answer.");
    } finally {
      await reopened.close(trace, 1_000);
    }
  } finally {
    await handle.close(trace, 1_000);
    await bench.cleanup();
  }
});

test("a queued user message waits for reflection and receives its own reflection", async () => {
  const notes: string[] = [];
  let release = () => {};
  let reached = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const bench = await createBench({
    note: (spec) => ({
      botId: spec.id,
      async set(value) {
        notes.push(value);
        return value === "" ? {} : { note: value };
      },
      current: () => (notes.length === 0 ? {} : { note: notes.at(-1) ?? "" }),
    }),
  });
  const events: RuntimeEvent[] = [];
  const handle = await bench.runtime.open(bench.spec());
  try {
    await handle.subscribe(trace, (event) => events.push(event));
    bench.faux.setResponses([
      text("First answer."),
      async () => {
        reached();
        await gate;
        return assistant([toolCall("note_set", { text: "First topic" })], {
          stopReason: "toolUse",
        });
      },
      text("Checked first."),
      text("Second answer."),
      assistant([toolCall("note_set", { text: "Second topic" })], { stopReason: "toolUse" }),
      text("Checked second."),
    ]);
    await handle.submit({
      requestId: "r_queue_first",
      text: "First question",
      whenBusy: "followUp",
      trace,
    });
    await Promise.race([
      started,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("reflection did not start")), 5_000);
        timer.unref();
      }),
    ]);
    const second = await handle.submit({
      requestId: "r_queue_second",
      text: "Second question",
      whenBusy: "followUp",
      trace,
    });
    assert.equal(second.status, "queued");
    release();
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === "submission" &&
            event.record.requestId === "r_queue_second" &&
            event.record.status === "done",
        ),
      "the second run to settle",
    );
    await waitFor(() => notes.includes("Second topic"), "the second note");
    assert.deepEqual(notes, ["First topic", "Second topic"]);
    const tools = events
      .flatMap((event) => (event.type === "append" ? event.message.blocks : []))
      .filter((block) => block.type === "toolCall" && block.name === "note_set");
    assert.equal(tools.length, 2);
  } finally {
    release();
    await handle.close(trace, 1_000);
    await bench.cleanup();
  }
});

test("aborting during reflection never applies its candidate", async () => {
  const notes: string[] = [];
  const usage: UsageEntry[] = [];
  let reached = () => {};
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const bench = await createBench({
    provider: { tokensPerSecond: 1000, tokenSize: { min: 2, max: 3 } },
    usage: { record: (entry) => usage.push(entry) },
    note: (spec) => ({
      botId: spec.id,
      async set(value) {
        notes.push(value);
        return value === "" ? {} : { note: value };
      },
      current: () => ({}),
    }),
  });
  const events: RuntimeEvent[] = [];
  const handle = await bench.runtime.open(bench.spec());
  try {
    await handle.subscribe(trace, (event) => events.push(event));
    bench.faux.setResponses([
      text("The original answer is ready for the person."),
      assistant([toolCall("note_set", { text: "Candidate from cancelled run" })], {
        stopReason: "toolUse",
      }),
      (_context, options) =>
        new Promise((_resolve, reject) => {
          reached();
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    ]);
    await handle.submit({
      requestId: "r_reflection_abort",
      text: "Question",
      whenBusy: "followUp",
      trace,
    });
    await Promise.race([
      started,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("reflection did not start")), 5_000);
        timer.unref();
      }),
    ]);
    await waitFor(
      () =>
        events.some(
          (event) =>
            event.type === "append" &&
            event.message.blocks.some(
              (block) => block.type === "toolCall" && block.name === "note_set",
            ),
        ),
      "the committed reflection tool call",
      1_000,
    );
    await handle.abort(trace);
    await waitFor(
      () =>
        events.some((event) => event.type === "submission" && event.record.status === "unanswered"),
      "the aborted submission",
    );
    await handle.close(trace, 1_000);
    assert.deepEqual(notes, []);
    assert.ok(
      usage.some((entry) => entry.counter?.startsWith("reflection:") && (entry.tokens ?? 0) > 0),
    );
  } finally {
    await handle.close(trace, 1_000);
    await bench.cleanup();
  }
});

test("a person's newer sidebar note is not overwritten by an older reflection", async () => {
  let current = { note: "Original", at: "1" };
  let release = () => {};
  let reached = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const bench = await createBench({
    note: (spec) => ({
      botId: spec.id,
      async set(value) {
        current = { note: value, at: "3" };
        return { note: value };
      },
      current: () => current,
    }),
  });
  const events: RuntimeEvent[] = [];
  const handle = await bench.runtime.open(bench.spec());
  try {
    await handle.subscribe(trace, (event) => events.push(event));
    bench.faux.setResponses([
      text("Original answer."),
      async () => {
        reached();
        await gate;
        return assistant([toolCall("note_set", { text: "Old reflection" })], {
          stopReason: "toolUse",
        });
      },
      text("Checked."),
    ]);
    await handle.submit({
      requestId: "r_note_conflict",
      text: "Question",
      whenBusy: "followUp",
      trace,
    });
    await Promise.race([
      started,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("reflection did not start")), 5_000);
        timer.unref();
      }),
    ]);
    current = { note: "Person's newer note", at: "2" };
    release();
    await waitFor(
      () => events.some((event) => event.type === "submission" && event.record.status === "done"),
      "the run to settle",
    );
    await handle.close(trace, 1_000);
    assert.deepEqual(current, { note: "Person's newer note", at: "2" });
  } finally {
    release();
    await handle.close(trace, 1_000);
    await bench.cleanup();
  }
});

test("a person's newer sidebar note survives a reflection with no note call", async () => {
  let current = { note: "Original", at: "1", revision: "1" };
  let release = () => {};
  let reached = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bench = await createBench({
    note: (spec) => ({
      botId: spec.id,
      async set(value, revision) {
        if (revision !== undefined && revision !== current.revision) return { applied: false };
        current = { note: value, at: "3", revision: "3" };
        return { note: value, applied: true };
      },
      current: () => current,
    }),
  });
  const events: RuntimeEvent[] = [];
  const handle = await bench.runtime.open(bench.spec());
  try {
    await handle.subscribe(trace, (event) => events.push(event));
    bench.faux.setResponses([
      text("Fallback answer."),
      async () => {
        reached = true;
        await gate;
        return text("No update needed.");
      },
    ]);
    await handle.submit({
      requestId: "r_no_note_conflict",
      text: "Question",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(() => reached, "the reflection request");
    current = { note: "Person's note", at: "2", revision: "2" };
    release();
    await waitFor(
      () => events.some((event) => event.type === "submission" && event.record.status === "done"),
      "the run to settle",
    );
    await handle.close(trace, 1_000);
    assert.deepEqual(current, { note: "Person's note", at: "2", revision: "2" });
  } finally {
    release();
    await handle.close(trace, 1_000);
    await bench.cleanup();
  }
});

test("reflection spend reaches bot statistics without changing root conversation usage", async () => {
  const records: UsageEntry[] = [];
  const bench = await createBench({
    usage: { record: (entry) => records.push(entry) },
    note: (spec) => ({
      botId: spec.id,
      async set(value) {
        return value === "" ? {} : { note: value };
      },
      current: () => ({}),
    }),
  });
  const events: RuntimeEvent[] = [];
  const handle = await bench.runtime.open(bench.spec());
  try {
    await handle.subscribe(trace, (event) => events.push(event));
    bench.faux.setResponses([
      text("Original answer."),
      assistant([toolCall("note_set", { text: "Reviewing" })], { stopReason: "toolUse" }),
      text("Checked."),
    ]);
    await handle.submit({
      requestId: "r_reflection_usage",
      text: "Question",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      () => events.some((event) => event.type === "submission" && event.record.status === "done"),
      "the run to settle",
    );
    const published = events.filter((event) => event.type === "usage").at(-1);
    assert.ok(published?.type === "usage");
    await handle.close(trace, 1_000);
    const storage = await openNodeSqliteStorage(join(bench.dir, "b_runtime", "session.sqlite"));
    const harness = await Harness.open(
      storage,
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    try {
      const root = await harness.root(BACKGROUND_CONTEXT);
      const rootUsage = await harness.snapshot(UsageDoc, root.id, BACKGROUND_CONTEXT);
      assert.ok(rootUsage !== undefined);
      assert.deepEqual(published.usage, convertUsage(rootUsage));
      const total = convertUsage(await harness.usage(BACKGROUND_CONTEXT));
      assert.equal(records.length, 2, "both reflection model requests are recorded");
      assert.equal(records[0]?.source, "model");
      assert.equal(records[0]?.counter, records[1]?.counter);
      assert.ok((records[1]?.tokens ?? 0) > (records[0]?.tokens ?? 0));
      assert.equal(published.usage.totalTokens + (records[1]?.tokens ?? 0), total.totalTokens);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  } finally {
    await handle.close(trace, 1_000);
    await bench.cleanup();
  }
});

test("a failed reflection does not change the original answer", async () => {
  const bench = await createBench({
    settings: { retry: { maxRetries: 0 } },
    note: (spec) => ({
      botId: spec.id,
      async set(value) {
        return value === "" ? {} : { note: value };
      },
      current: () => ({}),
    }),
  });
  const events: RuntimeEvent[] = [];
  const handle = await bench.runtime.open(bench.spec());
  try {
    await handle.subscribe(trace, (event) => events.push(event));
    bench.faux.setResponses([text("Original answer."), providerError("reflection unavailable")]);
    await handle.submit({
      requestId: "r_reflection_failure",
      text: "Question",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      () => events.some((event) => event.type === "submission" && event.record.status === "done"),
      "the original answer to settle",
    );
    assert.ok(bench.records.some((entry) => entry.evt === "runtime.reflection.fail"));
    const answer = events.find(
      (event) =>
        event.type === "append" &&
        event.message.id.startsWith("e_") &&
        event.message.blocks.some(
          (block) => block.type === "text" && block.text === "Original answer.",
        ),
    );
    const settled = events.find(
      (event) => event.type === "submission" && event.record.status === "done",
    );
    assert.equal(
      settled?.type === "submission" ? settled.record.answerEntryId : undefined,
      answer?.type === "append" ? answer.message.id : undefined,
    );
  } finally {
    await handle.close(trace, 1_000);
    await bench.cleanup();
  }
});
