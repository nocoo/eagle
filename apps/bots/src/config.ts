// The daemon's configuration (docs/bots/ARCHITECTURE.md "Process model"): the only module
// that reads the environment, so every default lives in one place and a test can build a
// config without touching the process.
import { homedir } from "node:os";
import { join } from "node:path";
import type { Level } from "./log/log.ts";

export type DaemonConfig = {
  /** Optional host-owned, version-1 private device port. No credentials. */
  readonly deviceSocket?: string;
  /** Separate Self-only sync listener; absent disables listening, zero selects a port. */
  readonly syncPort?: number;
  /** Trusted dedicated cache service, never selected by an HTTP caller. */
  readonly syncCacheOrigin?: string;
  /** Canonical root: the catalog, the token, the logs and every bot directory. */
  readonly root: string;
  /** Loopback service port. */
  readonly port: number;
  /** Idle bots are closed after this, and reopened on demand. */
  readonly idleCloseMs: number;
  /** A close that times out is retried every this often. */
  readonly quarantineRetryMs: number;
  /** Shared deadline for every close during shutdown. */
  readonly closeDeadlineMs: number;
  /** Lowest level that reaches the log files. */
  readonly logLevel: Level;
  /** `BOTS_MODEL` / `BOTS_MODEL_PROVIDER` pick the model a new bot is created with. */
  readonly model: { readonly provider: string; readonly modelId: string };
};

export const DEFAULT_PORT = 43117;
export const DEFAULT_IDLE_CLOSE_MS = 10 * 60 * 1000;
export const DEFAULT_QUARANTINE_RETRY_MS = 30 * 1000;
export const DEFAULT_CLOSE_DEADLINE_MS = 5 * 1000;

const level = (value: string | undefined): Level => {
  if (value === "trace" || value === "debug" || value === "info" || value === "warn") return value;
  if (value === "error") return "error";
  return "debug";
};

const integer = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/** `--port 0` asks the kernel for a free port, which is how a supervised test runs. */
const portNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

export const defaultRoot = (): string => join(homedir(), ".local", "share", "eagle-bots");

export type ConfigInput = {
  readonly argv?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
};

/** Reads `--root`, `--port` and the documented environment variables. */
export const readConfig = (input: ConfigInput = {}): DaemonConfig => {
  const argv = input.argv ?? process.argv.slice(2);
  const env = input.env ?? process.env;
  let root =
    env.BOTS_ROOT ??
    (input.home === undefined ? defaultRoot() : join(input.home, ".local", "share", "eagle-bots"));
  let port = integer(env.BOTS_PORT, DEFAULT_PORT);
  for (const [index, argument] of argv.entries()) {
    if (argument === "--root") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--root needs a path");
      root = value;
    }
    if (argument === "--port") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--port needs a number");
      port = portNumber(value, DEFAULT_PORT);
    }
  }
  const selectedSyncPort = argv.includes("--sync-port")
    ? argv[argv.indexOf("--sync-port") + 1]
    : env.BOTS_SYNC_PORT;
  const syncCacheOrigin = env.BOTS_SYNC_CACHE_ORIGIN;
  if (syncCacheOrigin !== undefined) {
    const url = new URL(syncCacheOrigin);
    if (
      url.origin !== syncCacheOrigin ||
      url.username ||
      url.password ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))
    )
      throw new Error("BOTS_SYNC_CACHE_ORIGIN needs an HTTPS origin or owned loopback HTTP");
  }
  if (
    (argv.includes("--sync-port") || selectedSyncPort !== undefined) &&
    (selectedSyncPort === undefined ||
      !/^\d+$/.test(selectedSyncPort) ||
      Number(selectedSyncPort) > 65535)
  )
    throw new Error("--sync-port needs a port from0 to65535");
  return {
    ...(selectedSyncPort === undefined ? {} : { syncPort: Number(selectedSyncPort) }),
    ...(syncCacheOrigin === undefined ? {} : { syncCacheOrigin }),
    ...(env.BOTS_DEVICE_SOCKET === undefined ? {} : { deviceSocket: env.BOTS_DEVICE_SOCKET }),
    root,
    port,
    idleCloseMs: integer(env.BOTS_IDLE_CLOSE_MS, DEFAULT_IDLE_CLOSE_MS),
    quarantineRetryMs: integer(env.BOTS_QUARANTINE_RETRY_MS, DEFAULT_QUARANTINE_RETRY_MS),
    closeDeadlineMs: integer(env.BOTS_CLOSE_DEADLINE_MS, DEFAULT_CLOSE_DEADLINE_MS),
    logLevel: level(env.BOTS_LOG_LEVEL),
    model: {
      provider: env.BOTS_MODEL_PROVIDER?.trim() || "magpie",
      modelId: env.BOTS_MODEL?.trim() || "auto/gpt-6-luna",
    },
  };
};
