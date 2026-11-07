import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { type Identity, serverProof } from "../src/identity.ts";
import { authentication, command, hello } from "../src/protocol.ts";

const base = new URL("../../../fixtures/superagent-protocol/", import.meta.url);
const read = async (name: string) => JSON.parse(await readFile(new URL(name, base), "utf8"));

test("normative fixture inventory and client codecs stay explicit", async () => {
  assert.deepEqual((await readdir(base)).sort(), [
    "auth-vector.json",
    "authenticate.client.json",
    "cancellation.server.json",
    "challenge.server.json",
    "configure.client.json",
    "done.server.json",
    "error.server.json",
    "failure.server.json",
    "health.server.json",
    "hello.client.json",
    "history.partial.server.json",
    "history.server.json",
    "queued.server.json",
    "send.client.json",
    "snapshot.server.json",
    "state.server.json",
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
  assert.deepEqual(
    authentication.parse(await read("authenticate.client.json")),
    await read("authenticate.client.json"),
  );
  assert.equal(
    (await read("challenge.server.json")).serverNonce,
    (await read("auth-vector.json")).serverNonce,
  );
  assert.equal((await read("state.server.json")).value.type, "snapshot");
  assert.equal((await read("failure.server.json")).value.failure.code, "model_authentication");
  assert.equal((await read("health.server.json")).failure.code, "storage_failed");
  assert.equal((await read("history.partial.server.json")).value.coverage, "partial");
  assert.equal((await read("cancellation.server.json")).code, "cancellation_unconfirmed");
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
  assert.equal(serverProof(vector.token, vector.clientNonce, 43127, identity), vector.healthProof);
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
