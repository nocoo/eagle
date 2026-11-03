// The secrets key file (docs/bots/EXTENSIONS-AND-TOOLS.md §6.5 "Where the value goes"):
// 32 random bytes, base64url, 0600 in a 0700 directory. It is written by the first store
// that needs it and never speculatively, and a missing key beside an existing ciphertext is
// a refusal rather than a reset.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const SECRET_KEY_BYTES = 32;

/** Why the key file could not be used; the caller names the rule, not the bytes. */
export type SecretKeyFailure = "missing" | "invalid" | "unreadable";

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
  const key = Buffer.from(text.trim(), "base64url");
  if (key.length !== SECRET_KEY_BYTES) {
    throw new SecretKeyError(
      "invalid",
      `the secrets key file does not hold a ${SECRET_KEY_BYTES}-byte key`,
    );
  }
  return key;
};

/** Writes the key: exclusive creation, so an existing key is never overwritten. */
export const writeSecretKey = async (path: string, key: Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, Buffer.from(key).toString("base64url"), { mode: 0o600, flag: "wx" });
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
