// The observation credential and store identity (SG-002 protocol §2). It is a dedicated
// bearer in the daemon root, read through the same hardened rules as the development
// token: a regular file, mode exactly 0600, at least 32 characters, never repaired.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const OBSERVATION_DIR = "observation";
export const OBSERVATION_TOKEN_CHARS = 32;

export type ObservationCredential = { readonly token: string; readonly storeId: string };

const dirOf = (root: string): string => join(root, OBSERVATION_DIR);
const tokenPath = (root: string): string => join(dirOf(root), "token");
const identityPath = (root: string): string => join(dirOf(root), "identity.json");

/** The source identity: a binding hash of the canonical root, never the root itself. */
export const sourceIdOf = (root: string): string =>
  createHash("sha256").update(root).digest("hex").slice(0, 16);

type Identity = { readonly storeId: string; readonly createdAt: string };

const readIdentity = async (root: string): Promise<Identity | undefined> => {
  try {
    const value = JSON.parse(await readFile(identityPath(root), "utf8")) as unknown;
    if (value === null || typeof value !== "object") return undefined;
    const candidate = value as Partial<Identity>;
    if (typeof candidate.storeId !== "string" || typeof candidate.createdAt !== "string") {
      return undefined;
    }
    return { storeId: candidate.storeId, createdAt: candidate.createdAt };
  } catch {
    return undefined;
  }
};

/** Reads the token under the development token's rules; anything unsafe is refused. */
const readToken = async (root: string): Promise<string | undefined> => {
  const path = tokenPath(root);
  const entry = await lstat(path).catch(() => undefined);
  if (entry === undefined || !entry.isFile()) return undefined;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return undefined;
    if ((stats.mode & 0o777) !== 0o600) return undefined;
    const token = (await handle.readFile("utf8")).trim();
    return token.length >= OBSERVATION_TOKEN_CHARS ? token : undefined;
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
};

export const readObservationCredential = async (
  root: string,
): Promise<ObservationCredential | undefined> => {
  const identity = await readIdentity(root);
  if (identity === undefined) return undefined;
  const token = await readToken(root);
  if (token === undefined) return undefined;
  return { token, storeId: identity.storeId };
};

const publish = async (path: string, body: string): Promise<void> => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, body, { mode: 0o600 });
  try {
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  await chmod(path, 0o600);
};

/**
 * Mints the credential once. An existing but unusable file is left alone: the owner has
 * to remove it, because silently replacing it would rotate a credential behind a running
 * consumer's back.
 */
export const mintObservationCredential = async (
  root: string,
): Promise<ObservationCredential | undefined> => {
  const existing = await readObservationCredential(root);
  if (existing !== undefined) return existing;
  await mkdir(dirOf(root), { recursive: true, mode: 0o700 });
  if ((await readIdentity(root)) === undefined) {
    await publish(
      identityPath(root),
      `${JSON.stringify({ storeId: randomUUID(), createdAt: new Date().toISOString() }, null, 2)}\n`,
    );
  }
  if ((await readToken(root)) === undefined) {
    await publish(tokenPath(root), `${randomBytes(32).toString("base64url")}\n`);
  }
  return readObservationCredential(root);
};
