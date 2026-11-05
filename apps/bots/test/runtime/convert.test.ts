// pi-ai → domain conversion (docs/bots/RUNTIME.md, "Event mapping"): the wire shapes the
// mapper mirrors, including the ones a faux provider does not produce on its own.
import assert from "node:assert/strict";
import test from "node:test";
import {
  convertBlock,
  convertMessage,
  convertUsage,
  entryMessageId,
  messageBytes,
  provisionalMessageId,
} from "../../src/runtime/pi/convert.ts";

const now = () => new Date(0);
const usage = {
  input: 3,
  output: 4,
  cacheRead: 1,
  cacheWrite: 2,
  totalTokens: 10,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (content: unknown[], stopReason = "stop") =>
  ({
    role: "assistant",
    content,
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage,
    stopReason,
    timestamp: 1_700_000_000_000,
  }) as never;

test("every content block becomes the wire block of the same meaning", () => {
  assert.deepEqual(convertBlock({ type: "text", text: "hi" } as never), {
    type: "text",
    text: "hi",
  });
  assert.deepEqual(convertBlock({ type: "thinking", thinking: "hmm" } as never), {
    type: "thinking",
    text: "hmm",
  });
  assert.deepEqual(
    convertBlock({
      type: "toolCall",
      id: "call_1",
      name: "search",
      arguments: { q: "paris" },
    } as never),
    { type: "toolCall", callId: "call_1", name: "search", args: { q: "paris" } },
  );
  assert.equal(convertBlock({ type: "image", data: "…" } as never), undefined);
});

test("interrupted device receipts retain diagnostics in valid JSON without changing other tool text", () => {
  const receipt = {
    type: "device-operation",
    version: 1,
    targetDeviceId: "11111111-1111-4111-8111-111111111111",
    operationId: "22222222-2222-4222-8222-222222222222",
    status: "unknown",
    error: "remote_not_configured",
    truncated: false,
  };
  const diagnostic = "<harness>\n[error] Tool remote_execute was interrupted\n</harness>";
  const message = (name: string, value: string) =>
    convertMessage(
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: name,
        isError: true,
        timestamp: 0,
        content: [
          { type: "text", text: value },
          { type: "text", text: diagnostic },
        ],
      } as never,
      { id: "e_1", now },
    );
  const recovered = message("remote_execute", JSON.stringify(receipt))?.blocks[0];
  assert.equal(recovered?.type, "toolResult");
  if (recovered?.type !== "toolResult") throw new Error("missing tool result");
  assert.deepEqual(JSON.parse(recovered.text), { ...receipt, diagnostics: [diagnostic] });
  const other = message("other_tool", JSON.stringify(receipt))?.blocks[0];
  assert.equal(other?.type, "toolResult");
  if (other?.type !== "toolResult") throw new Error("missing tool result");
  assert.equal(other.text, `${JSON.stringify(receipt)}\n${diagnostic}`);
  const malformed = message("remote_execute", "not-json")?.blocks[0];
  assert.equal(malformed?.type, "toolResult");
  if (malformed?.type !== "toolResult") throw new Error("missing tool result");
  assert.equal(malformed.text, `not-json\n${diagnostic}`);
});

test("message ids are the wire's ids", () => {
  assert.equal(entryMessageId(10), "e_10");
  assert.equal(entryMessageId("10"), "e_10");
  assert.equal(entryMessageId("e_10"), "e_10", "an already-converted id is not prefixed twice");
  assert.equal(provisionalMessageId(2), "p_a2");
});

test("a converted message carries the pi timestamp and no invented state", () => {
  const message = convertMessage(assistant([{ type: "text", text: "answer" }]), {
    id: "e_1",
    now,
  });
  assert.deepEqual(message, {
    id: "e_1",
    role: "assistant",
    state: "complete",
    createdAt: new Date(1_700_000_000_000).toISOString(),
    blocks: [{ type: "text", text: "answer" }],
    stopReason: "stop",
  });
  const streaming = convertMessage(assistant([{ type: "text", text: "" }], "pending"), {
    id: "p_a1",
    now,
  });
  assert.equal(streaming?.state, "streaming");
  assert.equal(streaming?.stopReason, undefined, "an in-flight message has no stop reason");
  const deferred = convertMessage(assistant([], "deferred"), { id: "e_2", now });
  assert.equal(deferred, undefined, "F23: a deferred response is no message at all");
  const user = convertMessage({ role: "user", content: "hi", timestamp: 0 } as never, {
    id: "e_3",
    now,
    requestId: "r_1",
  });
  assert.deepEqual(user, {
    id: "e_3",
    role: "user",
    state: "complete",
    createdAt: new Date(0).toISOString(),
    blocks: [{ type: "text", text: "hi" }],
    requestId: "r_1",
  });
  const images = convertMessage(
    {
      role: "user",
      content: [
        { type: "image", data: "x" },
        { type: "text", text: "ok" },
      ],
      timestamp: 0,
    } as never,
    { id: "e_4", now },
  );
  assert.deepEqual(images?.blocks, [{ type: "text", text: "ok" }], "phase 1 has no image block");
  const system = convertMessage(
    { role: "system", content: "instructions", timestamp: 0 } as never,
    { id: "e_5", now },
  );
  assert.deepEqual(system?.blocks, [{ type: "text", text: "instructions" }]);
  assert.equal(system?.role, "system");
  const toolResult = convertMessage(
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "search",
      content: [{ type: "text", text: "result" }],
      isError: false,
      timestamp: 0,
    } as never,
    { id: "e_6", now },
  );
  assert.deepEqual(toolResult, {
    id: "e_6",
    role: "tool",
    state: "complete",
    createdAt: new Date(0).toISOString(),
    blocks: [
      {
        type: "toolResult",
        callId: "call_1",
        name: "search",
        text: "result",
        isError: false,
      },
    ],
  });
  const clockless = convertMessage(
    { ...(assistant([{ type: "text", text: "x" }]) as object), timestamp: undefined } as never,
    { id: "e_7", now: () => new Date(5) },
  );
  assert.equal(
    clockless?.createdAt,
    new Date(5).toISOString(),
    "a missing timestamp uses the clock",
  );
});

test("usage sums every bucket, and the byte measure is the encoded size", () => {
  assert.deepEqual(
    convertUsage({
      models: { "faux/faux-1": usage },
      tools: { search: { ...usage, input: 1, output: 1, totalTokens: 2 } },
    }),
    { inputTokens: 4, outputTokens: 5, totalTokens: 12 },
  );
  const message = convertMessage(assistant([{ type: "text", text: "答案" }]), { id: "e_1", now });
  assert.ok(message !== undefined);
  assert.equal(messageBytes(message), new TextEncoder().encode(JSON.stringify(message)).length);
});
