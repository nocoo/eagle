// The daemon's configuration (docs/bots/ARCHITECTURE.md "Process model"): the only module
// that reads the environment, so every default lives in one place and a test can build a
// config without touching the process.
import { homedir } from "node:os";
import { join } from "node:path";
import type { Level } from "./log/log.ts";

export type DaemonConfig = {
  /** Optional host-owned, version-1 private device port. No credentials. */
  readonly deviceSocket?: string;
  /** The development agent's credential file; armed only when this is set. */
  readonly devAgentTokenPath?: string;
  /** Canonical root: the catalog, the token, the logs and every bot directory. */
  readonly root: string;
  /** The person-editable memory directory: `global.md` plus one file per bot. */
  readonly memoryDir: string;
  /** Where the encrypted secrets and their audit ledger live. */
  readonly secretsDir: string;
  /** The key file that opens them; a missing key beside a ciphertext is a refusal. */
  readonly secretsKeyPath: string;
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

/** Memory is the person's own knowledge, so it lives beside `providers.json`, not in state. */
export const defaultMemoryDir = (home: string, configHome: string | undefined): string =>
  join(configHome?.trim() || join(home, ".config"), "eagle-bots", "memory");

/** The secrets follow the configuration root, beside the memory and the provider keys. */
export const defaultSecretsDir = (home: string, configHome: string | undefined): string =>
  join(configHome?.trim() || join(home, ".config"), "eagle-bots");

/**
 * The key file (docs/bots/EXTENSIONS-AND-TOOLS.md §6.5): macOS keeps it in the app's
 * application support directory, every other platform in the state directory.
 */
export const defaultSecretsKeyPath = (
  home: string,
  stateHome: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string => {
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "ai.hexly.bots", "secrets.key");
  }
  const root = stateHome?.trim() || join(home, ".local", "state");
  return join(root, "eagle-bots", "secrets.key");
};

/**
 * The development agent's credential file, named by `BOTS_DEV_AGENT_TOKEN`. An empty
 * variable arms nothing, and without the variable the daemon never accepts one.
 */
const devAgentTokenPath = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

export type ConfigInput = {
  readonly argv?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
  /** The platform the defaults are computed for; the running one when absent. */
  readonly platform?: NodeJS.Platform;
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
  const devTokenPath = devAgentTokenPath(env.BOTS_DEV_AGENT_TOKEN);
  const home = input.home ?? homedir();
  const memoryDir = env.BOTS_MEMORY_DIR?.trim() || defaultMemoryDir(home, env.XDG_CONFIG_HOME);
  const secretsDir = env.BOTS_SECRETS_DIR?.trim() || defaultSecretsDir(home, env.XDG_CONFIG_HOME);
  const secretsKeyPath =
    env.BOTS_SECRETS_KEY?.trim() ||
    defaultSecretsKeyPath(home, env.XDG_STATE_HOME, input.platform ?? process.platform);
  return {
    ...(env.BOTS_DEVICE_SOCKET === undefined ? {} : { deviceSocket: env.BOTS_DEVICE_SOCKET }),
    ...(devTokenPath === undefined ? {} : { devAgentTokenPath: devTokenPath }),
    root,
    memoryDir,
    secretsDir,
    secretsKeyPath,
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
