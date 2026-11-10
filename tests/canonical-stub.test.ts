import assert from "node:assert/strict";
import { test } from "node:test";
import { canonical, digest } from "../packages/contracts/src/canonical.ts";

test("canonical sorts object keys and recurses", () => {
  assert.equal(canonical({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(canonical([1, { z: 0, y: true }]), '[1,{"y":true,"z":0}]');
  assert.equal(canonical(null), "null");
});

test("digest hashes canonical form", async () => {
  const hash = await digest({ a: 1 });
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, await digest({ a: 1 }));
});
