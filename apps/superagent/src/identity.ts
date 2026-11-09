import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { isAbsolute, join } from "node:path";

export const SERVICE = "eagle-superagent";
export const VERSION = "0.1.0";

export async function readPrivate(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.()) {
      throw new Error("unsafe_private_file");
    }
    if (info.size > 64 * 1024) throw new Error("private_file_too_large");
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

export const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

export async function listen(server: Server, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen_failed");
  return address.port;
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

export type Identity = {
  service: typeof SERVICE;
  version: string;
  protocolVersion: 1;
  pid: number;
  instance: string;
  storeId: string;
  rootBinding: string;
};

/**
 * A kernel lock nobody can reuse: the owner listens on an ephemeral loopback port and names
 * it in `<root>/lock.json`. A second owner of the same root connects, succeeds and refuses;
 * a lock whose port nobody answers is a crash and is replaced. Two different roots can never
 * collide, because the kernel, not a hash, chose the port. SIGKILL releases it with the
 * process, and the file is removed on a clean close.
 */
const LOCK_FILE = "lock.json";

const lockAlive = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (value: boolean): void => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(500, () => done(false));
  });

async function acquireRootLock(root: string): Promise<{ release: () => Promise<void> }> {
  const path = join(root, LOCK_FILE);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let holder: { port?: unknown } | undefined;
    try {
      holder = JSON.parse(await readPrivate(path)) as { port?: unknown };
    } catch (error) {
      if (!missing(error) && !(error instanceof SyntaxError)) throw error;
    }
    if (holder !== undefined) {
      const port = typeof holder.port === "number" ? holder.port : undefined;
      if (port !== undefined && (await lockAlive(port))) throw new Error("root_locked");
      await rm(path, { force: true });
      continue;
    }
    const server = createServer((socket) => socket.destroy());
    const port = await listen(server, 0);
    try {
      await writeFile(path, JSON.stringify({ port, pid: process.pid }), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      await closeServer(server);
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") continue;
      throw error;
    }
    return {
      release: async () => {
        await closeServer(server);
        await rm(path, { force: true });
      },
    };
  }
  throw new Error("root_locked");
}

export async function ownRoot(input: string) {
  if (!isAbsolute(input)) throw new Error("absolute_root_required");
  await mkdir(input, { recursive: true, mode: 0o700 });
  const root = await realpath(input);
  const directory = await stat(root);
  if (directory.uid !== process.getuid?.() || (directory.mode & 0o777) !== 0o700)
    throw new Error("unsafe_root");
  const digest = createHash("sha256").update(root).digest();
  const lock = await acquireRootLock(root);
  try {
    const identityPath = join(root, "identity.json");
    let storeId: string;
    try {
      const stored: unknown = JSON.parse(await readPrivate(identityPath));
      if (
        typeof stored !== "object" ||
        stored === null ||
        !("service" in stored) ||
        stored.service !== SERVICE ||
        !("storeId" in stored) ||
        typeof stored.storeId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          stored.storeId,
        )
      )
        throw new Error("invalid_identity");
      storeId = stored.storeId;
    } catch (error) {
      if (!missing(error)) throw new Error("invalid_identity");
      if ((await readdir(root)).some((name) => name !== LOCK_FILE)) throw new Error("foreign_root");
      storeId = randomUUID();
      await writeFile(identityPath, JSON.stringify({ service: SERVICE, storeId }), {
        mode: 0o600,
        flag: "wx",
      });
    }
    const tokenPath = join(root, "token");
    let token: string;
    try {
      token = (await readPrivate(tokenPath)).trim();
    } catch (error) {
      if (!missing(error)) throw new Error("unsafe_token");
      token = randomBytes(32).toString("hex");
      await writeFile(tokenPath, token, { mode: 0o600, flag: "wx" });
    }
    if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("unsafe_token");
    const identity: Identity = {
      service: SERVICE,
      version: VERSION,
      protocolVersion: 1,
      pid: process.pid,
      instance: randomUUID(),
      storeId,
      rootBinding: digest.toString("hex"),
    };
    return { root, token, identity, release: () => lock.release() };
  } catch (error) {
    await lock.release();
    throw error;
  }
}

export function serverProof(
  token: string,
  nonce: string,
  port: number,
  identity: Identity,
): string {
  return createHmac("sha256", token)
    .update(`${nonce}\n127.0.0.1:${port}\n${identity.rootBinding}\n${identity.instance}`)
    .digest("hex");
}
