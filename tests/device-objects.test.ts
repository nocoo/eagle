import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  verifyKeyEnvelope,
  verifyObjectManifest,
  verifyWrappingDescriptor,
} from "../packages/agent/device-objects.ts";
import {
  SyncEnvelopeHeader,
  SyncObjectBody,
  syncDescriptorPayload,
  syncEnvelopePayload,
  syncObjectPayload,
} from "../packages/contracts/src/device-objects.ts";

const vector = JSON.parse(
  readFileSync("fixtures/bots-protocol/sync-objects-v1/canonical.json", "utf8"),
);

test("real CryptoKit object signatures use the same fixed typed bytes in Node", () => {
  const manifest = verifyObjectManifest(vector.manifest);
  const descriptor = verifyWrappingDescriptor(
    vector.descriptor,
    manifest.publisher,
    manifest.registryOrigin,
  );
  const envelope = verifyKeyEnvelope(vector.envelope, manifest);
  const { signature: _descriptorSignature, ...descriptorBody } = descriptor;
  const { signature: _manifestSignature, ...manifestBody } = manifest;
  const { signature: _envelopeSignature, ...envelopeBody } = envelope;
  assert.equal(
    syncDescriptorPayload(descriptorBody),
    vector.canonical.descriptor,
  );
  assert.equal(syncObjectPayload(manifestBody), vector.canonical.manifest);
  assert.equal(syncEnvelopePayload(envelopeBody), vector.canonical.envelope);
});

test("object metadata remains strict and signatures bind identity, source, range and recipient", () => {
  for (const change of [
    { purpose: "replica.read" },
    { keyId: "0".repeat(64) },
    { source: { ...vector.manifest.source, epoch: crypto.randomUUID() } },
    { sharedBotId: crypto.randomUUID() },
    { range: { from: 0, to: 999 } },
    { signature: "A".repeat(86) },
  ])
    assert.throws(() =>
      verifyObjectManifest({ ...vector.manifest, ...change }),
    );
  for (const change of [
    { recipient: vector.envelope.issuer },
    { objectId: "0".repeat(64) },
    { keyId: "0".repeat(64) },
    { nonce: "A".repeat(16) },
    { ciphertext: "A".repeat(43) },
    { signature: "A".repeat(86) },
  ])
    assert.throws(() =>
      verifyKeyEnvelope({ ...vector.envelope, ...change }, vector.manifest),
    );
  assert.equal(
    SyncObjectBody.safeParse({ ...vector.manifest, arbitrary: true }).success,
    false,
  );
  assert.equal(
    SyncEnvelopeHeader.safeParse({ ...vector.envelope, arbitrary: true })
      .success,
    false,
  );
  assert.throws(() =>
    verifyWrappingDescriptor(
      { ...vector.descriptor, signature: "A".repeat(86) },
      vector.manifest.publisher,
      vector.manifest.registryOrigin,
    ),
  );
});
