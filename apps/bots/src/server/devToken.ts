// The development agent's own credential (docs/bots/PROTOCOL.md "CLI clients and
// scopes"): a bearer an agent minted for itself, so an acceptance run needs nobody at a
// switch. It is armed only while the daemon was told where its file is, the file is
// read again on every authentication, and a file that is not conforming is refused
// rather than repaired.
import { open } from "node:fs/promises";
import { declareEvent } from "../log/events.ts";
import type { Log } from "../log/log.ts";
import { CLIENT_SCOPES, type Client } from "./clients.ts";

/** The identity a development token acts as. */
export const DEV_AGENT_CLIENT_ID = "c_dev-agent";
export const DEV_AGENT_CLIENT_NAME = "dev-agent";
/** A bearer shorter than this is not a credential. */
export const MIN_DEV_TOKEN_CHARS = 32;

const Events = {
  ok: declareEvent("transport.devtoken.ok"),
  unsafe: declareEvent("transport.devtoken.unsafe"),
} as const;

/** The credential and the identity's creation time: the file's own mtime. */
export type DevCredential = { readonly token: string; readonly createdAt: string };

/** Reads the file again on every call, so a rewritten file takes effect at once. */
export type DevTokenReader = () => Promise<DevCredential | undefined>;

/**
 * The credential in the file, or undefined when the file cannot be one: a mode other
 * than 0600, a content shorter than 32 characters after trimming and an unreadable
 * file are all refused, and nothing is repaired on the way. The mode and the bytes come
 * from one descriptor, so the file that was checked is the file that is read.
 */
export const readDevToken = async (path: string): Promise<DevCredential | undefined> => {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch {
    return undefined;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return undefined;
    if ((stats.mode & 0o777) !== 0o600) return undefined;
    const body = await handle.readFile("utf8");
    const token = body.trim();
    if (token.length < MIN_DEV_TOKEN_CHARS) return undefined;
    return { token, createdAt: stats.mtime.toISOString() };
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
};

/** The client a development token acts as: every scope, named `dev-agent`. */
export const devAgentClient = (createdAt: string): Client => ({
  id: DEV_AGENT_CLIENT_ID,
  name: DEV_AGENT_CLIENT_NAME,
  scopes: CLIENT_SCOPES,
  createdAt,
});

/**
 * Arms the development token for a daemon that was told where its file is, and says
 * what the file was at startup. The reader it returns reads the file again on every
 * authentication, so a file fixed later starts working and a file broken later stops
 * working, with no second credential and no restart.
 */
export const armDevToken = async (options: {
  readonly path: string;
  readonly log: Log;
  readonly trace: string;
  /** Hands each usable bearer to the log's redaction set, including a rotated one. */
  readonly remember?: (token: string) => void;
}): Promise<DevTokenReader> => {
  const credential = await readDevToken(options.path);
  if (credential === undefined) {
    options.log.emit("warn", "transport", Events.unsafe, {
      trace: options.trace,
      detail: { path: options.path, reason: "invalid" },
    });
  } else {
    options.log.emit("info", "transport", Events.ok, {
      trace: options.trace,
      detail: { path: options.path },
    });
  }
  if (credential !== undefined) options.remember?.(credential.token);
  // Read again on every authentication: a usable bearer joins the redaction set the
  // first time it is presented, so a rotated file is covered as well.
  return async () => {
    const fresh = await readDevToken(options.path);
    if (fresh !== undefined) options.remember?.(fresh.token);
    return fresh;
  };
};
