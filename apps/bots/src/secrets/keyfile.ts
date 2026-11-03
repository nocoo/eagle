// The secrets key file (docs/bots/EXTENSIONS-AND-TOOLS.md §6.5 "Where the value goes"):
// 32 random bytes, base64url, 0600 in a 0700 directory. It is written by the first store
// that needs it and never speculatively, and a missing key beside an existing ciphertext is
// a refusal rather than a reset.
import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const SECRET_KEY_BYTES = 32;

let scratches = 0;

/** Why the key file could not be used; the caller names the rule, not the bytes. */
export type SecretKeyFailure = "missing" | "invalid" | "unreadable" | "insecure";

export class SecretKeyError extends Error {
  readonly reason: SecretKeyFailure;

  constructor(reason: SecretKeyFailure, message: string) {
    super(message);
    this.name = "SecretKeyError";
    this.reason = reason;
  }
}

const missing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

/**
 * The key is only as private as its mode: a file another account can read is refused before
 * its bytes are trusted, because "0600 was requested at creation" proves nothing about now.
 */
const assertPrivate = async (path: string): Promise<void> => {
  const stats = await stat(path).catch(() => undefined);
  if (stats === undefined) return;
  if ((stats.mode & 0o077) !== 0) {
    throw new SecretKeyError(
      "insecure",
      `the secrets key file ${path} is readable by another account; chmod 600 it`,
    );
  }
};

/** Reads the key that is already there; a missing file is a refusal, not a new key. */
export const readSecretKey = async (path: string): Promise<Uint8Array> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (missing(error)) {
      throw new SecretKeyError("missing", "the secrets key file is missing");
    }
    throw new SecretKeyError("unreadable", "the secrets key file could not be read");
  }
  await assertPrivate(path);
  const key = Buffer.from(text.trim(), "base64url");
  if (key.length !== SECRET_KEY_BYTES) {
    throw new SecretKeyError(
      "invalid",
      `the secrets key file does not hold a ${SECRET_KEY_BYTES}-byte key`,
    );
  }
  return key;
};

/**
 * Writes the key: a private scratch file published by `link`, which fails if the key already
 * exists. Creating the target first and writing into it would let a second reader see half a
 * key; publishing a finished file is the atomic version of the same exclusion.
 */
export const writeSecretKey = async (path: string, key: Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  scratches += 1;
  const scratch = `${path}.tmp-${process.pid}-${scratches}`;
  try {
    await writeFile(scratch, Buffer.from(key).toString("base64url"), { mode: 0o600, flag: "wx" });
    await link(scratch, path);
  } finally {
    await rm(scratch, { force: true }).catch(() => undefined);
  }
};

/** The key a store uses: the one that is there, or a new one written exactly once. */
export const loadOrCreateSecretKey = async (path: string): Promise<Uint8Array> => {
  try {
    return await readSecretKey(path);
  } catch (error) {
    if (!(error instanceof SecretKeyError) || error.reason !== "missing") throw error;
    const key = randomBytes(SECRET_KEY_BYTES);
    try {
      await writeSecretKey(path, key);
    } catch (writeError) {
      // Another store wrote it first: that key is the one this machine uses.
      if ((writeError as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") throw writeError;
      return readSecretKey(path);
    }
    return key;
  }
};
