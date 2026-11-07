// Negative cases for the wire contract: required fields, closed unions and the
// one-of-two error shapes. A decoder that accepts these would let a broken daemon or
// client look healthy.
import assert from "node:assert/strict";
import test from "node:test";
import { decodeCommand, decodeServerEvent } from "../../src/protocol/frames.ts";
import { validateCommand } from "../../src/protocol/validate.ts";

const trace = "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172";
const requestId = "r_0190a1b4-5061-7c72-8d3e-4f5061728394";

const invalidEvent = (wire: Record<string, unknown>) => {
  assert.throws(
    () => decodeServerEvent(wire),
    (error: Error & { reason?: string }) => error.reason === "invalid_event",
  );
};
const invalidCommand = (wire: Record<string, unknown>) => {
  assert.throws(
    () => validateCommand(decodeCommand(wire)),
    (error: Error & { reason?: string }) => error.reason === "invalid_command",
  );
};

const sessionError = (extra: Record<string, unknown> = {}) => ({
  type: "error",
  trace,
  kind: "storage_failed",
  failure: "f_7",
  disposition: "runtime",
  message: "boom",
  ...extra,
});

test("a session error requires trace, failure and disposition", () => {
  assert.equal(decodeServerEvent(sessionError()).type, "error");
  invalidEvent(sessionError({ failure: undefined }));
  invalidEvent(sessionError({ disposition: undefined }));
  invalidEvent({ ...sessionError(), trace: undefined });
  invalidEvent(sessionError({ disposition: "maybe" }));
  invalidEvent(sessionError({ kind: "made_up" }));
});

test("the handshake error carries server and no disposition", () => {
  const handshake = {
    type: "error",
    kind: "version_mismatch",
    message: "server speaks protocol 1",
    server: { protocolVersion: 1 },
  };
  assert.equal(decodeServerEvent(handshake).type, "error");
  invalidEvent({ ...handshake, server: undefined });
  invalidEvent({ ...handshake, disposition: "runtime" });
});

test("required event fields are not defaulted", () => {
  const status = { type: "status", rev: 1, trace, running: true, inbox: [] };
  invalidEvent(status); // streaming is required, null or a string
  assert.equal(decodeServerEvent({ ...status, streaming: null }).type, "status");
  invalidEvent({ type: "history", trace }); // messages and hasMore are required
  invalidEvent({ type: "snapshot", rev: 1, trace, value: {} });
  invalidEvent({ type: "append", trace, message: { id: "e_1" } }); // rev required
});

test("a snapshot's streaming id must be one of its messages", () => {
  const value = {
    botId: "b_1",
    messages: [],
    streaming: { messageId: "p_a1" },
    pending: [],
    inbox: [],
    running: true,
  };
  invalidEvent({ type: "snapshot", rev: 1, trace, value });
  assert.equal(
    decodeServerEvent({
      ...{ type: "snapshot", rev: 1, trace },
      value: { ...value, streaming: null },
    }).type,
    "snapshot",
  );
});

test("submission fields must agree with the status", () => {
  const base = { type: "submission", trace, requestId, submissionId: "s_1" };
  assert.equal(decodeServerEvent({ ...base, status: "queued" }).type, "submission");
  for (const status of ["placed", "done", "unanswered"]) {
    invalidEvent({ ...base, status }); // these need their own fields
  }
  assert.equal(
    decodeServerEvent({ ...base, status: "done", entryId: "e_1", answerEntryId: "e_2" }).type,
    "submission",
  );
  invalidEvent({ ...base, status: "done", entryId: "e_1" });
  invalidEvent({ ...base, status: "unanswered", answerEntryId: "e_2", reason: "aborted" });
});

test("delta indexes and paths are validated", () => {
  const frame = { type: "delta", rev: 1, trace, messageId: "p_a1" };
  invalidEvent({ ...frame, changes: [{ kind: "text", index: -1, append: "x" }] });
  invalidEvent({ ...frame, changes: [{ kind: "text", index: 1.5, append: "x" }] });
  invalidEvent({
    ...frame,
    changes: [{ kind: "toolcall", index: 0, callId: "c", path: [{}], append: "x" }],
  });
  assert.equal(
    decodeServerEvent({ ...frame, changes: [{ kind: "text", index: 0, append: "x" }] }).type,
    "delta",
  );
});

test("requestId belongs to user messages only", () => {
  const message = {
    id: "e_1",
    role: "assistant",
    state: "complete",
    createdAt: "2026-10-25T02:11:04.001Z",
    blocks: [],
    requestId,
  };
  invalidEvent({ type: "append", rev: 1, trace, message });
});

test("unknown fields are tolerated, unknown events are ignorable, unknown commands are refused", () => {
  const append = {
    type: "append",
    rev: 1,
    trace,
    message: { id: "e_1", role: "user", state: "complete", createdAt: "x", blocks: [], requestId },
    futureField: "ignored",
  };
  assert.equal(decodeServerEvent(append).type, "append");
  // PROTOCOL I8: an unknown event keeps its envelope so the revision is consumed.
  const ignored = decodeServerEvent({ type: "future_event", rev: 44, trace });
  assert.equal(ignored.type, "unknown");
  assert.equal(ignored.type === "unknown" ? ignored.rev : undefined, 44);
  invalidCommand({ type: "future_command", trace });
});

test("an explicit null whenBusy is a client bug, not a default", () => {
  invalidCommand({ type: "send", requestId, text: "hi", trace, whenBusy: null });
  assert.equal(
    decodeCommand({ type: "send", requestId, text: "hi", trace, whenBusy: "steer" }).type,
    "send",
  );
});

test("a provisional id is not a history cursor", () => {
  const trace = "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172";
  invalidCommand({ type: "history", before: "p_a1", limit: 10, trace });
  invalidCommand({ type: "history", before: "e1", limit: 10, trace });
});

test("event envelopes carry well-formed ids", () => {
  invalidEvent({
    type: "status",
    rev: 1,
    trace: "short",
    running: false,
    streaming: null,
    inbox: [],
  });
});

test("tool blocks require their name and a sane duration", () => {
  const message = (block: Record<string, unknown>) => ({
    type: "append",
    rev: 1,
    trace,
    message: {
      id: "e_11",
      role: "tool",
      state: "complete",
      createdAt: "x",
      blocks: [block],
    },
  });
  const result = {
    type: "toolResult",
    callId: "c_1",
    name: "list_files",
    text: "a",
    isError: false,
  };
  assert.equal(decodeServerEvent(message(result)).type, "append");
  invalidEvent(message({ ...result, name: undefined }));
  invalidEvent(message({ ...result, name: "" }));
  invalidEvent(message({ ...result, durationMs: -1 }));
  invalidEvent(message({ ...result, durationMs: 1.5 }));
  const call = { type: "toolCall", callId: "c_1", name: "list_files", args: {} };
  assert.equal(decodeServerEvent(message({ ...call, role: "assistant" })).type, "append");
  invalidEvent(message({ ...call, name: "" }));
});

test("snapshot state relations are enforced", () => {
  const base = { type: "snapshot", rev: 1, trace };
  const complete = {
    id: "e_1",
    role: "assistant",
    state: "complete",
    createdAt: "x",
    blocks: [],
  };
  // streaming must point at a message in streaming state
  invalidEvent({
    ...base,
    value: {
      botId: "b_1",
      messages: [complete],
      streaming: { messageId: "e_1" },
      pending: [],
      inbox: [],
      running: true,
    },
  });
  // pending holds unsettled records only
  invalidEvent({
    ...base,
    value: {
      botId: "b_1",
      messages: [],
      streaming: null,
      pending: [
        { requestId, submissionId: "s_1", status: "done", entryId: "e_1", answerEntryId: "e_2" },
      ],
      inbox: [],
      running: false,
    },
  });
  // an unavailable snapshot has empty collections
  invalidEvent({
    ...base,
    value: {
      botId: "b_1",
      messages: [complete],
      streaming: null,
      pending: [],
      inbox: [],
      running: false,
      unavailable: { reason: "storage_failed", message: "boom" },
    },
  });
});

test("a bot summary only carries a reason while unavailable", () => {
  const bot = {
    id: "b_1",
    title: "t",
    createdAt: "x",
    updatedAt: "x",
    model: { provider: "magpie", modelId: "auto/gpt-6-luna" },
    state: "idle",
  };
  assert.equal(decodeServerEvent({ type: "bots", bots: [bot] }).type, "bots");

  // Groups travel with the catalog; a malformed one is refused like any other entity.
  const grouped = decodeServerEvent({
    type: "bots",
    bots: [{ ...bot, groupId: "g_0123456789" }],
    groups: [{ id: "g_0123456789", title: "工作" }],
  });
  assert.equal(grouped.type, "bots");
  if (grouped.type === "bots") assert.equal(grouped.groups?.[0]?.title, "工作");
  invalidEvent({ type: "bots", bots: [bot], groups: [{ id: "g_0123456789" }] });
  invalidEvent({ type: "bots", bots: [bot], groups: "工作" });
  invalidEvent({ type: "bots", bots: [{ ...bot, state: "unavailable" }] });
  invalidEvent({
    type: "bots",
    bots: [{ ...bot, unavailable: { reason: "storage_failed", message: "boom" } }],
  });
});

test("welcome sendFiles capability is independent, defaults false and rejects non-booleans", () => {
  const welcome = {
    type: "welcome",
    protocolVersion: 1,
    server: { version: "0.1.0", instance: "i_test", pid: 1 },
    capabilities: {
      agent: false,
      tools: false,
      tasks: false,
      entries: false,
      usage: false,
      peers: false,
      triggers: false,
    },
    bots: [],
  };
  const old = decodeServerEvent({
    ...welcome,
    capabilities: { ...welcome.capabilities, files: true },
  });
  assert.equal(old.type, "welcome");
  if (old.type === "welcome") {
    assert.equal(old.capabilities.files, true);
    assert.equal(old.capabilities.sendFiles, false);
  }

  const withSendFiles = decodeServerEvent({
    ...welcome,
    capabilities: { ...welcome.capabilities, files: true, sendFiles: true },
  });
  assert.equal(withSendFiles.type, "welcome");
  if (withSendFiles.type === "welcome") {
    assert.equal(withSendFiles.capabilities.sendFiles, true);
  }

  invalidEvent({
    ...welcome,
    capabilities: { ...welcome.capabilities, sendFiles: "yes" },
  });
});

test("Message.files is generic and FileRef unknown fields are tolerated", () => {
  const ref = {
    id: "f_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    name: "result.txt",
    mimeType: "text/plain",
    size: 42,
    sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    path: "/must-not-cross-wire",
  };
  const tool = decodeServerEvent({
    type: "append",
    rev: 1,
    trace,
    message: {
      id: "e_11",
      role: "tool",
      state: "complete",
      createdAt: "x",
      blocks: [{ type: "toolResult", callId: "c1", name: "read", text: "ok", isError: false }],
      files: [ref],
    },
  });
  assert.equal(tool.type, "append");
  if (tool.type === "append") {
    assert.equal(tool.message.files?.[0]?.name, "result.txt");
    const ref = tool.message.files?.[0];
    assert.equal(ref === undefined ? true : !("path" in ref), true);
  }
});

test("send fileIds are bounded, unique and strict", () => {
  const fileId = `f_${"a".repeat(64)}`;
  const decoded = decodeCommand({
    type: "send",
    requestId,
    text: "带附件",
    fileIds: [fileId],
    whenBusy: "followUp",
    trace,
  });
  assert.equal(decoded.type, "send");
  if (decoded.type === "send") {
    assert.deepEqual((decoded as unknown as { fileIds?: readonly string[] }).fileIds, [fileId]);
  }

  invalidCommand({
    type: "send",
    requestId,
    text: "带附件",
    fileIds: [fileId, fileId],
    trace,
  });
  invalidCommand({
    type: "send",
    requestId,
    text: "带附件",
    fileIds: ["f_bad"],
    trace,
  });
  invalidCommand({
    type: "send",
    requestId,
    text: "带附件",
    fileIds: Array.from({ length: 17 }, (_, index) => `f_${index.toString(16).padStart(64, "0")}`),
    trace,
  });
});

test("live tasks decode with a status the client can render", () => {
  const task = {
    id: "t_12",
    kind: "pi.generation",
    status: "running",
    phase: "generate",
    background: false,
    conversationId: "c_1",
  };
  const decoded = decodeServerEvent({ type: "tasks", rev: 4, trace, tasks: [task] });
  assert.equal(decoded.type, "tasks");
  if (decoded.type === "tasks") assert.equal(decoded.tasks[0]?.kind, "pi.generation");
  invalidEvent({ type: "tasks", rev: 4, trace, tasks: [{ ...task, status: "thinking" }] });
  invalidEvent({ type: "tasks", rev: 4, trace, tasks: [{ ...task, background: "no" }] });
});

test("submission entry references must be committed entries", () => {
  const base = { type: "submission", trace, requestId, submissionId: "s_1" };
  invalidEvent({ ...base, status: "done", entryId: "", answerEntryId: "e_2" });
  invalidEvent({ ...base, status: "done", entryId: "e_1", answerEntryId: "p_a2" });
  invalidEvent({ ...base, status: "unanswered", reason: "  " });
});

test("agent instructions are bounded and requestIds are well formed", () => {
  const value = (instructions: string) => ({
    botId: "b_1",
    messages: [],
    streaming: null,
    pending: [],
    inbox: [],
    running: false,
    agent: { model: { provider: "p", modelId: "m" }, thinkingLevel: "off", instructions },
  });
  assert.equal(
    decodeServerEvent({ type: "snapshot", rev: 1, trace, value: value("x".repeat(4000)) }).type,
    "snapshot",
  );
  invalidEvent({ type: "snapshot", rev: 1, trace, value: value("x".repeat(4001)) });
  invalidEvent({
    type: "append",
    rev: 1,
    trace,
    message: {
      id: "e_1",
      role: "user",
      state: "complete",
      createdAt: "x",
      blocks: [],
      requestId: "bad",
    },
  });
  invalidEvent({
    type: "submission",
    trace,
    requestId: "bad",
    submissionId: "s_1",
    status: "queued",
  });
});

test("a bot summary rejects a malformed reason field", () => {
  const bot = {
    id: "b_1",
    title: "t",
    createdAt: "x",
    updatedAt: "x",
    model: { provider: "magpie", modelId: "auto/gpt-6-luna" },
    state: "idle",
  };
  for (const unavailable of ["storage_failed", null, [], 3]) {
    invalidEvent({ type: "bots", bots: [{ ...bot, unavailable }] });
  }
});
