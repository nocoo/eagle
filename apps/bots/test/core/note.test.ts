// The sidebar line a settled run derives from its answer (docs/bots/PROTOCOL.md, "The
// bot's own note"): local and deterministic, no model call and no extra tokens.
import assert from "node:assert/strict";
import test from "node:test";
import {
  createRunNote,
  deriveBotNote,
  formatNoteAge,
  MAX_BOT_NOTE_CHARS,
  noteLine,
} from "../../src/core/domain.ts";

test("the derived line is the answer's first sentence", () => {
  assert.equal(deriveBotNote("已提交 PR。等待审核。"), "已提交 PR。");
  assert.equal(deriveBotNote("Opened the PR. Waiting for review."), "Opened the PR.");
  assert.equal(deriveBotNote("Are you there? Yes!"), "Are you there?");
});

test("an answer without a sentence end is the whole line", () => {
  assert.equal(deriveBotNote("正在核对 10-24 的依赖报告"), "正在核对 10-24 的依赖报告");
});

test("whitespace runs collapse and the ends are trimmed", () => {
  assert.equal(deriveBotNote("  在核对\n\n 10-24\t的依赖报告  "), "在核对 10-24 的依赖报告");
});

test("a long line is cut at a character boundary, never inside a surrogate pair", () => {
  const emoji = "🙂";
  const derived = deriveBotNote(emoji.repeat(MAX_BOT_NOTE_CHARS + 10));
  assert.equal(derived === undefined ? 0 : [...derived].length, MAX_BOT_NOTE_CHARS);
  assert.equal(derived?.endsWith(emoji), true, "no half of a surrogate pair is left behind");
  assert.equal(derived?.includes("\uFFFD"), false);
});

test("an empty or blank answer derives no line at all", () => {
  assert.equal(deriveBotNote(""), undefined);
  assert.equal(deriveBotNote("  \n\t "), undefined);
});

test("the age of a line reads as minutes, hours or days", () => {
  const now = Date.parse("2026-10-25T06:00:00.000Z");
  const at = (iso: string) => Date.parse(iso);
  assert.equal(formatNoteAge("2026-10-25T05:59:59.000Z", now), "just now");
  assert.equal(formatNoteAge("2026-10-25T05:59:00.000Z", now), "1 minute ago");
  assert.equal(formatNoteAge("2026-10-25T05:12:00.000Z", now), "48 minutes ago");
  assert.equal(formatNoteAge("2026-10-25T03:00:00.000Z", now), "3 hours ago");
  assert.equal(formatNoteAge("2026-10-24T05:00:00.000Z", now), "1 day ago");
  assert.equal(formatNoteAge("2026-10-22T05:00:00.000Z", now), "3 days ago");
  assert.equal(formatNoteAge("not a date", now), undefined);
  assert.equal(at("2026-10-25T06:00:00.000Z"), now);
});

test("the prompt line shows the note and its age, or says the line is empty", () => {
  const now = Date.parse("2026-10-25T06:00:00.000Z");
  const written = noteLine({ note: "在等 PR 审核", at: "2026-10-25T03:00:00.000Z" }, now);
  assert.match(written, /在等 PR 审核/);
  assert.match(written, /3 hours ago/);
  const empty = noteLine({}, now);
  assert.match(empty, /empty/);
  assert.equal(empty.includes("ago"), false);
  const undated = noteLine({ note: "在等 PR 审核" }, now);
  assert.match(undated, /在等 PR 审核/);
  assert.equal(undated.includes("written"), false, "a line with no time claims no age");
});

test("one run's own note_set value is read once and then forgotten", () => {
  const run = createRunNote();
  assert.equal(run.take(), undefined, "a run that never called the tool has no value");
  run.record("在等 PR 审核");
  run.record("在等合并");
  assert.equal(run.take(), "在等合并", "the last call of the run wins");
  assert.equal(run.take(), undefined, "one value belongs to one run");
});
