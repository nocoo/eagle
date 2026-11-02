// PROTOCOL.md v1, additive: a user message may carry who admitted it. The wire carries
// only what a client renders, so the daemon's internal trigger ids stay home.
import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "../../src/core/domain.ts";
import { encodeMessage } from "../../src/protocol/encode.ts";
import { decodeServerEvent, FrameError } from "../../src/protocol/frames.ts";

const trace = "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172";

const message = (extra: Partial<Message> = {}): Message => ({
  id: "e_1",
  role: "user",
  state: "complete",
  createdAt: "2026-10-28T00:00:00.000Z",
  blocks: [{ type: "text", text: "hello" }],
  ...extra,
});

const decode = (payload: Record<string, unknown>) =>
  decodeServerEvent({ type: "append", rev: 1, trace, message: payload });

test("an origin encodes as its kind and label, never its internal id", () => {
  const wire = encodeMessage(message({ origin: { kind: "webhook", triggerId: "t_9f2a1c3d04" } }));
  assert.deepEqual(wire.origin, { kind: "webhook" }, "the trigger id is not a wire field");
  assert.deepEqual(
    encodeMessage(message({ origin: { kind: "human" } })).origin,
    { kind: "human" },
    "a human admission is explicit, not omitted",
  );
  assert.deepEqual(
    encodeMessage(message({ origin: { kind: "unknown" } })).origin,
    { kind: "unknown" },
    "a reconstruction says so",
  );
  assert.equal("origin" in encodeMessage(message()), false, "an unlabelled message stays so");
});

test("a client keeps the label it is given", () => {
  const event = decode({
    id: "e_1",
    role: "user",
    state: "complete",
    createdAt: "2026-10-28T00:00:00.000Z",
    blocks: [{ type: "text", text: "hi" }],
    origin: { kind: "webhook", label: "deploy-notify" },
  });
  assert.deepEqual(event.type === "append" ? event.message.origin : undefined, {
    kind: "webhook",
    label: "deploy-notify",
  });
});

test("an origin on anything but a user message is refused", () => {
  assert.throws(
    () =>
      decode({
        id: "e_1",
        role: "assistant",
        state: "complete",
        createdAt: "2026-10-28T00:00:00.000Z",
        blocks: [{ type: "text", text: "hi" }],
        origin: { kind: "human" },
      }),
    (error: unknown) =>
      error instanceof FrameError && error.message.includes("origin belongs to user messages"),
  );
});

test("an unknown origin kind is refused rather than passed through", () => {
  assert.throws(
    () =>
      decode({
        id: "e_1",
        role: "user",
        state: "complete",
        createdAt: "2026-10-28T00:00:00.000Z",
        blocks: [{ type: "text", text: "hi" }],
        origin: { kind: "telepathy" },
      }),
    (error: unknown) => error instanceof FrameError,
  );
});

test("a hidden answer carries its marks on the wire, and nothing else does", () => {
  const hidden = encodeMessage(message({ hidden: true, answersTo: "e_12" })) as Record<
    string,
    unknown
  >;
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.answersTo, "e_12");
  const plain = encodeMessage(message()) as Record<string, unknown>;
  assert.equal("hidden" in plain, false, "an ordinary message stays ordinary");
  assert.equal("answersTo" in plain, false);
});
