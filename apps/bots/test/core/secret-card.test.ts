// The secret card (docs/bots/EXTENSIONS-AND-TOOLS.md §6.5): the card is the tool call's own
// arguments, read back from the transcript, and the hidden message never carries the value.
import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "../../src/core/domain.ts";
import { SECRET_REQUEST_TOOL, secretAnswerText, secretCardOf } from "../../src/core/secretCard.ts";

const message = (args: Record<string, unknown> | undefined, name = SECRET_REQUEST_TOOL): Message =>
  ({
    id: "e_12",
    role: "assistant",
    state: "complete",
    createdAt: "2026-11-03T01:10:00.000Z",
    blocks: [
      { type: "text", text: "我需要这个密码。" },
      ...(args === undefined ? [] : [{ type: "toolCall" as const, callId: "c_1", name, args }]),
    ],
  }) as Message;

test("the card is the tool call's own arguments", () => {
  const card = secretCardOf(
    message({ key: "github-pat", purpose: "发布 Eagle 用", scope: "shared", ttlMinutes: 60 }),
  );
  assert.deepEqual(card, {
    key: "github-pat",
    purpose: "发布 Eagle 用",
    scope: "shared",
    ttlMinutes: 60,
  });
});

test("a card without a scope is this bot's own, and without a lifetime it is permanent", () => {
  const card = secretCardOf(message({ key: "github-pat", purpose: "发布用" }));
  assert.deepEqual(card, { key: "github-pat", purpose: "发布用", scope: "bot" });
  assert.equal(card?.ttlMinutes, undefined);
});

test("a message without a secret request is not a card", () => {
  assert.equal(secretCardOf(message(undefined)), undefined);
  assert.equal(secretCardOf(message({ key: "k", purpose: "p" }, "ask_user")), undefined);
  assert.equal(secretCardOf(message({ purpose: "no key" })), undefined);
  assert.equal(secretCardOf(message({ key: "k" })), undefined);
});

test("the hidden message names the record, its scope and its lifetime", () => {
  const card = secretCardOf(message({ key: "github-pat", purpose: "发布用", ttlMinutes: 60 }));
  assert.ok(card);
  const text = secretAnswerText(card, { entryId: "e_12", scope: "bot", ttlMinutes: 60 });
  assert.equal(
    text,
    'The person saved the secret "github-pat" (this bot only, expires in 1 hour) from e_12. Read it with secret_read and use the environment variable it names; the value itself never enters the conversation.',
  );
});

test("a shared record and a permanent one say so", () => {
  const card = secretCardOf(message({ key: "github-pat", purpose: "发布用" }));
  assert.ok(card);
  assert.equal(
    secretAnswerText(card, { entryId: "e_12", scope: "shared" }),
    'The person saved the secret "github-pat" (every bot on this machine, no expiry) from e_12. Read it with secret_read and use the environment variable it names; the value itself never enters the conversation.',
  );
});

test("the hidden message never carries a value", () => {
  const card = secretCardOf(message({ key: "github-pat", purpose: "发布用" }));
  assert.ok(card);
  const text = secretAnswerText(card, { entryId: "e_12", scope: "bot" });
  assert.equal(text.includes("ghp_example"), false);
  assert.equal(text.includes("EAGLE_SECRET"), false, "not even the variable is invented here");
});

test("a skipped card says the person did not answer", () => {
  const card = secretCardOf(message({ key: "github-pat", purpose: "发布用" }));
  assert.ok(card);
  const text = secretAnswerText(card, { entryId: "e_12", skipped: true });
  assert.match(text, /skipped/);
  assert.match(text, /e_12/);
  assert.equal(text.includes("github-pat"), true, "the bot still knows which record it asked for");
});

test("a lifetime of minutes reads the way a person says it", () => {
  const card = secretCardOf(message({ key: "k", purpose: "p" }));
  assert.ok(card);
  assert.match(
    secretAnswerText(card, { entryId: "e_1", scope: "bot", ttlMinutes: 30 }),
    /expires in 30 minutes/,
  );
  assert.match(
    secretAnswerText(card, { entryId: "e_1", scope: "bot", ttlMinutes: 1440 }),
    /expires in 24 hours/,
  );
  assert.match(
    secretAnswerText(card, { entryId: "e_1", scope: "bot", ttlMinutes: 90 }),
    /expires in 1 hour 30 minutes/,
  );
});
