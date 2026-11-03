// The secrets container (docs/bots/EXTENSIONS-AND-TOOLS.md §6.5): "EGLS", a version, a
// nonce and an AES-256-GCM body. The header is authenticated, so a flipped byte is a
// refusal instead of a silently wrong password.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  CONTAINER_MAGIC,
  CONTAINER_VERSION,
  ContainerError,
  HEADER_BYTES,
  KEY_BYTES,
  NONCE_BYTES,
  open,
  seal,
} from "../../src/secrets/container.ts";

const key = (): Buffer => randomBytes(KEY_BYTES);

test("the header is the magic, the version and a nonce", () => {
  const container = seal(key(), "hello");
  assert.equal(container.subarray(0, 4).toString("ascii"), "EGLS");
  assert.equal(container[4], CONTAINER_VERSION);
  assert.equal(HEADER_BYTES, 4 + 1 + NONCE_BYTES);
  assert.ok(container.length > HEADER_BYTES, "the body follows the header");
});

test("a sealed value opens again", () => {
  const secret = key();
  const container = seal(secret, "ghp_example");
  assert.equal(open(secret, container), "ghp_example");
});

test("every seal uses a fresh nonce", () => {
  const secret = key();
  const first = seal(secret, "same");
  const second = seal(secret, "same");
  assert.equal(first.equals(second), false, "two seals of the same text differ");
  assert.equal(
    first.subarray(5, HEADER_BYTES).equals(second.subarray(5, HEADER_BYTES)),
    false,
    "the nonce differs",
  );
  assert.equal(open(secret, first), "same");
  assert.equal(open(secret, second), "same");
});

test("another key cannot open the container", () => {
  const container = seal(key(), "ghp_example");
  assert.throws(
    () => open(key(), container),
    (error: unknown) => error instanceof ContainerError && error.reason === "cipher",
  );
});

test("a flipped byte is a refusal, not a wrong value", () => {
  const secret = key();
  const container = seal(secret, "ghp_example");
  const flipped = Buffer.from(container);
  flipped[flipped.length - 3] = (flipped[flipped.length - 3] ?? 0) ^ 0x01;
  assert.throws(
    () => open(secret, flipped),
    (error: unknown) => error instanceof ContainerError && error.reason === "cipher",
  );
});

test("a file that is not a container says so", () => {
  const secret = key();
  const foreign = Buffer.from("this is a notes file, not a container at all");
  assert.throws(
    () => open(secret, foreign),
    (error: unknown) => error instanceof ContainerError && error.reason === "magic",
  );
});

test("an unknown version is refused by version, not by decryption", () => {
  const secret = key();
  const container = seal(secret, "ghp_example");
  const future = Buffer.from(container);
  future[4] = 0x02;
  assert.throws(
    () => open(secret, future),
    (error: unknown) => error instanceof ContainerError && error.reason === "version",
  );
});

test("a truncated container is refused", () => {
  const secret = key();
  const container = seal(secret, "ghp_example");
  assert.throws(
    () => open(secret, container.subarray(0, 8)),
    (error: unknown) => error instanceof ContainerError,
  );
});

test("a key of the wrong size is refused before any cipher runs", () => {
  assert.throws(
    () => seal(randomBytes(16), "x"),
    (error: unknown) => error instanceof ContainerError,
  );
});

test("the magic is the documented one", () => {
  assert.equal(CONTAINER_MAGIC.toString("ascii"), "EGLS");
  assert.equal(CONTAINER_VERSION, 0x01);
  assert.equal(NONCE_BYTES, 12);
  assert.equal(KEY_BYTES, 32);
});
