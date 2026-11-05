import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { redactScreen, terminalScreen } from "../packages/agent/realtime.ts";

test("an empty additional mask preserves star normalization and Unicode", () => {
  assert.equal(
    redactScreen("公开 😀 ******** status ***\n", []),
    "公开 😀 [REDACTED] status ***\n",
  );
  assert.equal(redactScreen("bearer fixture;\n", []), "bearer [REDACTED];\n");
  assert.equal(redactScreen("", []), "");
});

test("screen redaction preserves status labels instead of joining words into secret names", () => {
  for (const label of [
    "Token usage",
    "Token\tusage",
    "Token\u00a0usage",
    "Token usage\n  ",
    "Secret scanning",
    "Password policy",
    "API_KEY status",
    "Credential count",
  ]) {
    const text = `${label}: 42\nContext window: 96% left\nReady for the next task.`;
    assert.equal(redactScreen(text, []), text, label);
  }
});

test("Codex status text and following output retain their terminal colors", () => {
  const text =
    "│ Token usage: 55.4K total (47.9K input + 7.43K output) │\n" +
    "│ Context window: 96% left (48.7K used / 950K)          │\n" +
    "Hello! Ready when you are.";
  const frame = terminalScreen(
    `\u001b[36m${text.split("\n").slice(0, 2).join("\n")}\u001b[0m\n` +
      "\u001b[32mHello! Ready when you are.\u001b[0m",
    [],
  );
  assert.equal(frame.text, text);
  assert.equal(frame.runs?.map((run) => run.text).join(""), text);
  assert.equal(frame.runs?.[0].fg, 6);
  assert.deepEqual(frame.runs?.at(-1), {
    text: "Hello! Ready when you are.",
    fg: 2,
  });
});

test("ordinary status labels do not consume later wrapped token or assignment matches", () => {
  const prefix = "Token usage: 42 total\nNext output:\n";
  for (const sensitive of [
    "sk-proj-1234\nabcdefghijklmnopqrstuv;",
    "eag1.fixtureheader.fixturepayload.\nfixturesignature;",
    "API_\nKEY=private-fixture-value;",
    "API_\n  KEY=private-fixture-value;",
    "API_\r\n\tKEY=private-fixture-value;",
    "TOK\n  EN=private-fixture-value;",
    "TOKEN\n_NAME=private-fixture-value;",
    "TOKEN_\n\tNAME=private-fixture-value;",
  ]) {
    const frame = terminalScreen(`${prefix}${sensitive}\nDone.`, []);
    assert(frame.text.startsWith(prefix), sensitive);
    assert(frame.text.endsWith("\nDone."), sensitive);
    assert.equal(
      frame.runs?.map((run) => run.text).join("") ?? frame.text,
      frame.text,
    );
    for (const value of [
      "abcdefghijklmnopqrstuv",
      "fixturesignature",
      "private-fixture-value",
    ]) {
      assert(!JSON.stringify(frame).includes(value), sensitive);
    }
  }
});

test("known wrapped credentials remain hidden next to a safe status label", () => {
  const secret = "fixture-machine-credential-abcdefghijklmnopqrstuvwxyz";
  const prefix = "Token usage: 42 total\n";
  const frame = terminalScreen(
    `${prefix}${secret.slice(0, 23)}\n${secret.slice(23)}\nDone.`,
    [secret],
  );
  assert(frame.text.startsWith(prefix));
  assert(frame.text.endsWith("\nDone."));
  assert(!JSON.stringify(frame).includes(secret.slice(23)));
});

test("bearer redaction preserves the original prefix and its style", () => {
  for (const prefix of ["bearer ", "bEaReR\t ", "BEARER\n"]) {
    const frame = terminalScreen(`\u001b[32m${prefix}fixture;\u001b[0m`, []);
    assert.equal(frame.text, `${prefix}[REDACTED];`);
    assert.equal(frame.runs?.map((run) => run.text).join(""), frame.text);
    assert.deepEqual(frame.runs?.[0], { fg: 2, text: prefix });
  }
});

const assignmentProbes = [
  "Token usage API_\nKEY=private-fixture-value;",
  "Token usage API_\n  KEY=private-fixture-value;",
  "Token usage API_\r\n\tKEY=private-fixture-value;",
  "Token usage API_\nKEY=private-fixture-\nvalue;",
  "Token usage API_\r\nKEY=private-fixture-\r\nvalue;",
  "Token usage \u001b[31mAPI_\nKEY\u001b[0m=private-fixture-value;",
  "Token usage A\u001b[31mPI_\nK\u001b[1mEY=private-fixture-value;",
  "Token usage \u001b[31m\u001b[0mAPI_\nKEY:private-fixture-value;",
  "Token usage api_\nkey=private-fixture-value;",
  "Token usage ApI_\nKeY:private-fixture-value;",
  "Token usage API_KEY=private-fixture-value;",
  "Token usage\nAPI_KEY=private-fixture-value;",
  "Token usage\nAPI_\nKEY=private-fixture-value;",
  "Secret scanning TOK\nEN=private-fixture-value;",
  "Password policy SEC\nRET:private-fixture-value;",
  "API_KEY status PASS\nWORD=private-fixture-value;",
  "Credential count CRED\nENTIAL:private-fixture-value;",
  "Token usage MY_API_\nKEY=private-fixture-value;",
  "Token usage API_\nKEY=private-fixture-value; SEC\nRET=other-fixture-value;",
  "Token usage: 42; API_\nKEY=private-fixture-value;",
  "Token usage API_\nKEY=private-fixture-value",
  "API_\nKEY=private-fixture-value;",
  "Token usage API_\nKEY=private-fixture-value; Token count: 42;",
  'Token usage API_\nKEY="private-fixture-value";',
  "Token usage API_\nKEY='private-fixture-value';",
  'Token usage API_\nKEY="private-fixture-\nvalue";',
  "Token usage API_\r\nKEY='private-fixture-\r\nvalue';",
  'Token usage API_\nKEY="private-fixture-;value";',
  "Token usage API_\nKEY='private-fixture-;value';",
  'Token usage API_\nKEY="private-fixture-value',
  "Token usage API_\nKEY='private-fixture-value",
];

for (const [index, probe] of assignmentProbes.entries()) {
  test(`assignment probe ${index + 1} hides values in plain and styled frames`, () => {
    const plain = stripVTControlCharacters(probe);
    const redacted = redactScreen(plain, []);
    const frame = terminalScreen(
      `\u001b[32mREADY\u001b[0m\n${probe}\n\u001b[36mDONE\u001b[0m`,
      [],
    );
    assert(frame.runs?.some((run) => run.text === "READY" && run.fg === 2));
    assert.equal(frame.runs?.map((run) => run.text).join(""), frame.text);
    for (const output of [
      redacted,
      terminalScreen(probe, []).text,
      frame.text,
      frame.runs?.map((run) => run.text).join("") ?? "",
    ]) {
      for (const fragment of ["private-fixture-", "value", "other-fixture-"])
        assert(
          !output.replace(/\s/g, "").includes(fragment),
          `${index + 1}: ${fragment}`,
        );
      assert.match(output, /\[REDACTED\]|\*+/);
    }
  });
}
