import assert from "node:assert/strict";
import { test } from "node:test";
import { terminalScreen } from "../packages/agent/realtime.ts";
import { terminalLinkParts } from "../packages/contracts/src/terminal-links.ts";

const hrefs = (text: string) =>
  terminalLinkParts(text).flatMap((part) => (part.href ? [part.href] : []));

test("terminal links preserve every character and style across ANSI boundaries", () => {
  const text = "See (https://example.test/path?q=1&n=2).\nDone.";
  const runs = [
    { text: text.slice(0, 20), fg: 2 },
    { text: text.slice(20), bold: true as const },
  ];
  const parts = terminalLinkParts(text, runs);
  assert.equal(
    parts.flatMap((part) => part.runs.map((run) => run.text)).join(""),
    text,
  );
  assert.deepEqual(
    parts.filter((part) => part.href).map((part) => part.href),
    ["https://example.test/path?q=1&n=2"],
  );
  const linked = parts.find((part) => part.href);
  assert.equal(linked?.runs[0].fg, 2);
  assert.equal(linked?.runs.at(-1)?.bold, true);
});

test("only complete visible HTTP(S) candidates are linked without joining lines", () => {
  assert.deepEqual(hrefs("prefixhttps://example.test/nope"), []);
  assert.deepEqual(hrefs("https://example.test/foo]."), ["https://example.test/foo"]);
  assert.deepEqual(
    hrefs(
      "https://example.test/wiki/Foo_(bar) http://localhost:7053/ http://[::1]:80/",
    ),
    [
      "https://example.test/wiki/Foo_(bar)",
      "http://localhost:7053/",
      "http://[::1]:80/",
    ],
  );
  for (const text of [
    "javascript:alert(1)",
    "javascript:https://example.test",
    "file:///x",
    "data:text/html,x",
    "https://user:pass@example.test/x",
    "https://example.test/[REDACTED]",
    "https://example.test/[REDACTED KEY]",
    "https://example.test/[REDACTED",
    "https://example.test/***",
    "https://example.test/\\evil",
    "https://example.test/\u202eabc",
    "https://example.test:bad",
    "https://",
    "http://?query",
    "https://#fragment",
    `https://example.test/${"x".repeat(4096)}`,
  ])
    assert.deepEqual(hrefs(text), [], text);
  assert.deepEqual(hrefs("https://example.test/first\nsecond"), [
    "https://example.test/first",
  ]);
});

test("hidden OSC destinations, redacted values and mismatched runs are never restored", () => {
  const frame = terminalScreen(
    "\x1b]8;;https://hidden.test/\x07label\x1b]8;;\x07",
    [],
  );
  assert.deepEqual(hrefs(frame.text), []);
  const secret = "synthetic-secret-value-123456";
  const redacted = terminalScreen(`https://example.test/?token=${secret}`, [
    secret,
  ]);
  assert.deepEqual(hrefs(redacted.text), []);
  const parts = terminalLinkParts("safe text", [
    { text: "https://hidden.test/" },
  ]);
  assert.equal(
    parts.flatMap((part) => part.runs.map((run) => run.text)).join(""),
    "safe text",
  );
  assert.deepEqual(
    parts.filter((part) => part.href),
    [],
  );
});

test("link count is bounded and excess links remain unchanged text", () => {
  const text = Array.from(
    { length: 200 },
    (_, i) => `https://example.test/${i}`,
  ).join("\n");
  const parts = terminalLinkParts(text);
  assert.equal(parts.filter((part) => part.href).length, 128);
  assert.equal(
    parts.flatMap((part) => part.runs.map((run) => run.text)).join(""),
    text,
  );
});
