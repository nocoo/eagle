// The secrets container (docs/bots/EXTENSIONS-AND-TOOLS.md §6.5 "Container format, v1"):
// "EGLS", a version, a fresh nonce and an AES-256-GCM body. The 17-byte header is the
// additional authenticated data, so a flipped byte anywhere is a refusal rather than a
// silently wrong password.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const CONTAINER_MAGIC = Buffer.from("EGLS", "ascii");
export const CONTAINER_VERSION = 0x01;
export const NONCE_BYTES = 12;
export const KEY_BYTES = 32;
/** magic (4) + version (1) + nonce (12) */
export const HEADER_BYTES = CONTAINER_MAGIC.length + 1 + NONCE_BYTES;
/** The GCM tag that closes every body. */
const TAG_BYTES = 16;

/** Why a container could not be opened; the caller names the rule, not the bytes. */
export type ContainerFailure = "magic" | "version" | "cipher";

export class ContainerError extends Error {
  readonly reason: ContainerFailure;

  constructor(reason: ContainerFailure, message: string) {
    super(message);
    this.name = "ContainerError";
    this.reason = reason;
  }
}

const keyOf = (key: Uint8Array): Buffer => {
  if (key.length !== KEY_BYTES) {
    throw new ContainerError("cipher", `a secrets key is ${KEY_BYTES} bytes`);
  }
  return Buffer.from(key);
};

/** Seals one plaintext under one key with a fresh nonce. */
export const seal = (key: Uint8Array, plaintext: string): Buffer => {
  const nonce = randomBytes(NONCE_BYTES);
  const header = Buffer.concat([CONTAINER_MAGIC, Buffer.from([CONTAINER_VERSION]), nonce]);
  const cipher = createCipheriv("aes-256-gcm", keyOf(key), nonce);
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([header, body, cipher.getAuthTag()]);
};

/** Opens one container; every failure names the rule it broke. */
export const open = (key: Uint8Array, container: Buffer): string => {
  if (container.length < HEADER_BYTES + TAG_BYTES) {
    throw new ContainerError("cipher", "the secrets container is too short to be valid");
  }
  const header = container.subarray(0, HEADER_BYTES);
  if (!header.subarray(0, CONTAINER_MAGIC.length).equals(CONTAINER_MAGIC)) {
    throw new ContainerError("magic", "this file is not a secrets container");
  }
  if (header[4] !== CONTAINER_VERSION) {
    throw new ContainerError(
      "version",
      `secrets container version ${String(header[4])} is not supported`,
    );
  }
  const nonce = header.subarray(5, HEADER_BYTES);
  const body = container.subarray(HEADER_BYTES);
  const tag = body.subarray(body.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", keyOf(key), nonce);
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  try {
    const plain = Buffer.concat([
      decipher.update(body.subarray(0, body.length - TAG_BYTES)),
      decipher.final(),
    ]);
    return plain.toString("utf8");
  } catch {
    throw new ContainerError("cipher", "the secrets container could not be decrypted");
  }
};
