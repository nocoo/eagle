import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(`apps/macos/${path}`, "utf8");

test("message selection keeps the original Markdown view and never inserts a selection", () => {
  const assistant = read("Sources/EagleDesign/Chat/MarkdownView.swift");
  const user = read("Sources/EagleDesign/Chat/Transcript.swift");
  const column = read("Sources/EagleDesign/Panels/ConversationColumn.swift");
  for (const source of [assistant, user]) {
    assert.match(source, /content\.textSelection\(\.enabled\)/);
    assert.match(source, /MessageCopyButton/);
    assert.doesNotMatch(
      source,
      /SelectableTranscriptText|selectionOverride|发送到对话/,
    );
  }
  assert.match(assistant, /blockView\(block, caret:/);
  assert.doesNotMatch(
    column,
    /TranscriptSelectionObserver|BubbleSelectionAction/,
  );
});
