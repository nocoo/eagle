import assert from "node:assert/strict";
import { test } from "node:test";
import { metadataDigest, objectCanonical } from "../src/sync-objects.ts";

test("controlled object receipt metadata has the same digest before and after JSON transport", () => {
  const request = {
    source: undefined,
    after: 0,
    limit: 128,
    recipientDescriptor: { keyId: "example", version: 1 },
  };
  assert.equal(metadataDigest(request), metadataDigest(JSON.parse(JSON.stringify(request))));
  assert.equal(objectCanonical({ b: 2, a: 1 }), '{"a":1,"b":2}');
});

test("independent Bots codec verifies the shared CryptoKit object vector", async () => {
  const { readFileSync } = await import("node:fs");
  const { verifyDescriptor, verifyEnvelope, verifyManifest, unsignedDescriptor } = await import(
    "../src/sync-objects.ts"
  );
  const vector = JSON.parse(
    readFileSync(
      new URL("../../../fixtures/bots-protocol/sync-objects-v1/canonical.json", import.meta.url),
      "utf8",
    ),
  );
  const manifest = verifyManifest(vector.manifest),
    envelope = verifyEnvelope(vector.envelope, manifest);
  const descriptor = verifyDescriptor(
    vector.descriptor,
    manifest.publisher,
    manifest.registryOrigin,
  );
  assert.equal(
    "eagle-bots-wrap-descriptor-v1\n" + objectCanonical(unsignedDescriptor(descriptor)),
    vector.canonical.descriptor,
  );
  const { signature: _manifestSignature, ...manifestBody } = manifest;
  const { signature: _envelopeSignature, ...envelopeBody } = envelope;
  assert.equal(
    "eagle-bots-page-manifest-v1\n" + objectCanonical(manifestBody),
    vector.canonical.manifest,
  );
  assert.equal(
    "eagle-bots-key-envelope-signature-v1\n" + objectCanonical(envelopeBody),
    vector.canonical.envelope,
  );
});
