import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { deviceSyncProof } from "../src/core/DeviceSyncPort.ts";
import {
  checkTime,
  ephemeral,
  proofPayload,
  seal,
  unseal,
  verifyProof,
} from "../src/sync-crypto.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/bots-protocol/sync-proof.http.json", import.meta.url),
    "utf8",
  ),
);

test("typed sync signing bytes match the public Node/Swift fixture", () => {
  assert.equal(proofPayload(fixture.request), fixture.signingPayload);
  verifyProof(fixture.request, fixture.signature);
  assert.throws(() => verifyProof({ ...fixture.request, role: "server" }, fixture.signature));
});

test("real X25519 HKDF AEAD preserves full bytes and rejects direction, sequence and transcript substitution", () => {
  const a = ephemeral();
  const b = ephemeral();
  const reader = deviceSyncProof.parse({
    ...fixture.request,
    expiresAt: Date.now() + 30000,
    readerEphemeral: a.publicKey,
    serverEphemeral: b.publicKey,
  });
  const server = { ...reader, role: "server" as const };
  assert.ok(Buffer.byteLength(proofPayload(server) + "\nreader\n0") > 1024);
  const bytes = Buffer.concat([Buffer.from("original bytes 原文"), Buffer.from([0, 255, 13, 10])]);
  const box = seal(reader, a.privateKey, "reader", bytes);
  assert.deepEqual(unseal(server, b.privateKey, "reader", box), bytes);
  assert.deepEqual(
    unseal(reader, a.privateKey, "server", seal(server, b.privateKey, "server", bytes)),
    bytes,
  );
  for (const change of [
    { sequence: 1 },
    { tag: "A".repeat(22) },
    { ciphertext: "AAAA" },
    { nonce: "A".repeat(16) },
  ])
    assert.throws(() => unseal(server, b.privateKey, "reader", { ...box, ...change }));
  for (const change of [
    { sessionId: reader.generation },
    { generation: reader.sessionId },
    { readerNonce: reader.serverNonce },
    { readerEphemeral: ephemeral().publicKey },
    { sharedBotId: "55555555-5555-4555-8555-555555555555" },
  ])
    assert.throws(() => unseal({ ...server, ...change }, b.privateKey, "reader", box));
  assert.throws(() => unseal(server, b.privateKey, "server", box));
  assert.throws(() => seal(reader, a.privateKey, "reader", Buffer.alloc(8 * 1024 * 1024 + 1)));
  assert.throws(() => checkTime({ ...reader, expiresAt: Date.now() - 1 }));
  assert.throws(() => checkTime({ ...reader, expiresAt: Date.now() + 120000 }));
});
