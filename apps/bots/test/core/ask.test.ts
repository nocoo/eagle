// The questions card (docs/bots/EXTENSIONS-AND-TOOLS.md, "ask_user"): the tool presents, the
// person answers, and the daemon composes the one hidden message the bot reads next.
import assert from "node:assert/strict";
import test from "node:test";
import { answerText, questionsOf } from "../../src/core/ask.ts";
import type { Message } from "../../src/core/domain.ts";

const call = (args: Record<string, unknown>): Message => ({
  id: "e_7",
  role: "assistant",
  state: "complete",
  createdAt: "2026-11-02T00:00:00.000Z",
  blocks: [{ type: "toolCall", callId: "c_9", name: "ask_user", args }],
});

const questions = [
  {
    prompt: "Which branch?",
    kind: "single" as const,
    options: [{ label: "main" }, { label: "release" }],
  },
  {
    prompt: "Which checks?",
    kind: "multi" as const,
    options: [{ label: "unit" }, { label: "browser" }],
  },
];

test("the card is read back out of the call that drew it", () => {
  const parsed = questionsOf(call({ questions }));
  assert.deepEqual(parsed, [
    {
      prompt: "Which branch?",
      kind: "single",
      options: [{ label: "main" }, { label: "release" }],
    },
    {
      prompt: "Which checks?",
      kind: "multi",
      options: [{ label: "unit" }, { label: "browser" }],
    },
  ]);
});

test("a message that is not an ask_user call has no questions", () => {
  const other: Message = {
    ...call({}),
    blocks: [{ type: "toolCall", callId: "c_1", name: "bash", args: {} }],
  };
  assert.equal(questionsOf(other), undefined);
});

test("the answer names each question and the labels that were chosen", () => {
  const text = answerText(questions, {
    entryId: "e_7",
    answers: [["release"], ["unit", "browser"]],
  });
  assert.equal(
    text,
    [
      "The person answered the questions from e_7:",
      "1. Which branch?",
      "   chosen: release",
      "2. Which checks?",
      "   chosen: unit, browser",
    ].join("\n"),
  );
});

test("a skipped card says so and asks the bot to continue", () => {
  const text = answerText(questions, { entryId: "e_7", skipped: true });
  assert.match(text, /skipped the questions from e_7/);
  assert.match(text, /Continue without them/);
});

test("an answer that does not fit the card is refused, not guessed", () => {
  assert.throws(
    () => answerText(questions, { entryId: "e_7", answers: [["main"]] }),
    /one list of choices/,
  );
  assert.throws(
    () => answerText(questions, { entryId: "e_7", answers: [["main"], []] }),
    /at least one choice/,
  );
  assert.throws(
    () => answerText(questions, { entryId: "e_7", answers: [["main", "release"], ["unit"]] }),
    /exactly one choice/,
  );
  assert.throws(
    () => answerText(questions, { entryId: "e_7", answers: [["trunk"], ["unit"]] }),
    /not an option/,
  );
});

test("a flat list of labels is grouped by the question it belongs to", () => {
  const text = answerText(questions, { entryId: "e_7", chosen: ["browser", "release"] });
  assert.match(text, /1\. Which branch\?\n {3}chosen: release/);
  assert.match(text, /2\. Which checks\?\n {3}chosen: browser/);
  assert.throws(
    () => answerText(questions, { entryId: "e_7", chosen: ["trunk"] }),
    /not an option/,
  );
});
