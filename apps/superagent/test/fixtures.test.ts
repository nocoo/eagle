import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { type Identity, serverProof } from "../src/identity.ts";
import { command, hello } from "../src/protocol.ts";

const base = new URL("../../../fixtures/superagent-protocol/", import.meta.url);
const read = async (name: string) => JSON.parse(await readFile(new URL(name, base), "utf8"));

test("normative fixture inventory and client codecs stay explicit", async () => {
  assert.deepEqual((await readdir(base)).sort(), [
    "auth-vector.json",
    "configure.client.json",
    "done.server.json",
    "error.server.json",
    "hello.client.json",
    "history.server.json",
    "queued.server.json",
    "send.client.json",
    "snapshot.server.json",
    "unanswered.server.json",
  ]);
  assert.deepEqual(hello.parse(await read("hello.client.json")), await read("hello.client.json"));
  for (const name of ["configure.client.json", "send.client.json"])
    assert.deepEqual(command.parse(await read(name)), await read(name));
  const state = await read("snapshot.server.json");
  assert.equal(state.value.window.oldestEntryId, 10);
  assert.equal(state.value.messages[1].state, "complete");
  assert.equal((await read("history.server.json")).value.coverage, "complete");
  assert.equal((await read("queued.server.json")).value.status, "queued");
  assert.equal((await read("done.server.json")).value.answerEntryId, "e_12");
  assert.equal((await read("unanswered.server.json")).value.reason, "aborted");
  assert.equal((await read("error.server.json")).code, "unconfigured");
});

test("shared HMAC vectors bind fresh client/server nonces, actual endpoint and instance using LF and UTF8 key bytes", async () => {
  const vector = await read("auth-vector.json");
  const identity = { rootBinding: vector.rootBinding, instance: vector.instance } as Identity;
  assert.equal(
    serverProof(vector.token, `${vector.clientNonce}\n${vector.serverNonce}`, 43127, identity),
    vector.serverProof,
  );
  assert.notEqual(
    serverProof(vector.token, `${vector.clientNonce}\n${vector.serverNonce}`, 43128, identity),
    vector.serverProof,
  );
  assert.equal(
    createHmac("sha256", vector.token)
      .update(["client", vector.clientNonce, vector.serverNonce, vector.instance].join("\n"))
      .digest("hex"),
    vector.clientProof,
  );
  assert.notEqual(
    createHmac("sha256", Buffer.from(vector.token, "hex"))
      .update(["client", vector.clientNonce, vector.serverNonce, vector.instance].join("\n"))
      .digest("hex"),
    vector.clientProof,
  );
});
