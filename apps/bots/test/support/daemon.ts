// A child process, started the way the product starts it: the same entry script, the same
// root, the same kernel lock. The helper exists because a process that does not come up
// has to say why: the exit code, the signal, and everything it wrote to stdout and stderr
// (docs/bots/TESTING.md, "Process model").
//
// The daemon's lock port is `44000 + fnv1a(realpath(root)) % 1000` (ARCHITECTURE.md,
// "Singleton lock"), so a root that hashes onto a port another daemon already holds is
// refused with an explicit message. That is a fact about the machine, not about the code
// under test: `daemonRoot` therefore picks a root whose derived port is free, and
// `startDaemonProcess` retries with another root when the refusal is exactly that
// collision.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCK_PORT_BASE, lockPort } from "../../src/server/singleton.ts";

/** The daemon prints one start line; this is what a supervisor reads. */
const START_MARKER = '"daemon.start"';
/** The window a start has to appear in: the daemon needs about 300 ms on an idle machine. */
const START_TIMEOUT_MS = 12_000;

export type ProcessExit = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
};

export type ScriptProcess = {
  readonly child: ChildProcess;
  /** Everything the process wrote to stdout so far. */
  stdout(): string;
  /** Everything the process wrote to stderr so far. */
  stderr(): string;
  /** Resolves when the process is gone. */
  exited(): Promise<ProcessExit>;
  /** Resolves when the marker appears in stdout, or rejects with the whole story. */
  waitForMarker(marker: string, timeoutMs?: number): Promise<string>;
  /** Kills the process and waits for it to be gone. */
  stop(): Promise<void>;
};

export type DaemonStart = {
  readonly port: number;
  readonly token: string;
};

export type DaemonProcess = ScriptProcess & {
  readonly root: string;
  /** Resolves with the port and the token, or rejects with the whole story. */
  waitForStart(timeoutMs?: number): Promise<DaemonStart>;
};

/** Children this process started: they die with it, so no daemon outlives its test. */
const live = new Set<ChildProcess>();
let cleanupRegistered = false;
const registerCleanup = (): void => {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const killAll = (): void => {
    for (const child of live) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process is leaving anyway; a dead child needs nothing.
      }
    }
  };
  process.on("exit", killAll);
  // An interrupted run must not leave a daemon behind: it would keep its lock port and
  // refuse the next run's root for as long as it lives.
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    process.on(signal, () => {
      killAll();
      process.exit(code);
    });
  }
};

/** True when nothing holds the port: the daemon can take it. */
export const portIsFree = async (port: number): Promise<boolean> => {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port }, () => {
        server.off("error", reject);
        resolve();
      });
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return false;
    throw error;
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
};

/**
 * A fresh root whose derived lock port is free. The daemon refuses a root whose port
 * another daemon holds, so the harness picks one that can actually be taken.
 */
export const daemonRoot = async (
  prefix = "bots-daemon-",
  suffix: () => string = () => randomBytes(6).toString("hex"),
): Promise<string> => {
  // The daemon hashes the canonical root, so the search runs over canonical names: no
  // directory is created for a candidate that loses.
  if (!/^[a-zA-Z0-9_-]+$/.test(prefix)) throw new Error("invalid root prefix");
  const canonical = await realpath(tmpdir());
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const value = suffix();
    if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("invalid root suffix");
    const name = `${prefix}${value}`;
    const candidate = join(canonical, name);
    if (!(await portIsFree(lockPort(candidate)))) continue;
    try {
      await mkdir(candidate, { mode: 0o700 });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("no root with a free lock port was found");
};

/** The lock port a root derives to, for a test that needs to collide with it. */
export const lockPortOf = async (root: string): Promise<number> => lockPort(await realpath(root));

/**
 * A root whose derived lock port is the given one. The search only hashes names, so it
 * costs no directories: the winner is the first path with that hash.
 */
export const rootWithLockPort = async (
  port: number,
  prefix = "bots-collide-",
  options: { readonly create?: boolean } = {},
): Promise<string> => {
  const canonical = await realpath(tmpdir());
  for (let attempt = 0; attempt < 100_000; attempt += 1) {
    const candidate = join(canonical, `${prefix}${randomBytes(6).toString("hex")}`);
    if (lockPort(candidate) !== port) continue;
    if (options.create !== false) await mkdir(candidate, { recursive: true, mode: 0o700 });
    return candidate;
  }
  throw new Error(`no root hashes to the lock port ${port}`);
};

/** A lock port nobody holds, for a test that needs to take one. */
export const freeLockPort = async (): Promise<number> => {
  for (let port = LOCK_PORT_BASE; port < LOCK_PORT_BASE + 1_000; port += 1) {
    if (await portIsFree(port)) return port;
  }
  throw new Error("every lock port is taken");
};

/** Starts a TypeScript entry script of this package and collects everything it says. */
export const spawnScript = (options: {
  readonly script: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}): ScriptProcess => {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      join(options.cwd ?? process.cwd(), options.script),
      ...(options.args ?? []),
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
    },
  );
  registerCleanup();
  live.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exitPromise = new Promise<ProcessExit>((resolve) => {
    child.once("exit", (code, signal) => {
      live.delete(child);
      resolve({ code, signal });
    });
  });
  /** The whole story of a process that did not do what it was started for. */
  const failure = (what: string): Error => {
    const tail = stdout.length > 2_000 ? stdout.slice(-2_000) : stdout;
    return new Error(
      `${what}\nexit code: ${String(child.exitCode)}\nsignal: ${String(child.signalCode)}\n` +
        `stdout:\n${tail}\nstderr:\n${stderr}`,
    );
  };
  const waitForMarker = async (marker: string, timeoutMs = START_TIMEOUT_MS): Promise<string> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const line = stdout.split("\n").find((entry) => entry.includes(marker));
      if (line !== undefined) return line;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw failure(`the process exited before it wrote ${marker}`);
      }
      if (Date.now() >= deadline) {
        throw failure(`the process did not write ${marker} within ${timeoutMs} ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    exited: () => exitPromise,
    waitForMarker,
    stop: async (): Promise<void> => {
      child.kill("SIGKILL");
      if (child.exitCode === null && child.signalCode === null) await exitPromise;
    },
  };
};

/** Starts `scripts/serve.ts` on a root and collects everything it says. */
export const spawnDaemon = (options: {
  readonly root: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}): DaemonProcess => {
  const script = spawnScript({
    script: "scripts/serve.ts",
    args: ["--root", options.root, "--port", "0"],
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  return {
    ...script,
    root: options.root,
    waitForStart: async (timeoutMs = START_TIMEOUT_MS): Promise<DaemonStart> => {
      const line = await script.waitForMarker(START_MARKER, timeoutMs);
      const parsed = JSON.parse(line) as { port?: unknown };
      if (typeof parsed.port !== "number") {
        throw new Error(`the daemon start line has no port: ${line}`);
      }
      const token = (await readFile(join(options.root, "token"), "utf8")).trim();
      return { port: parsed.port, token };
    },
  };
};

/** The refusal the daemon writes when two roots hash to the same lock port. */
export const isLockCollision = (stderr: string): boolean => /lock port \d+ is shared/.test(stderr);

export type StartedDaemon = {
  readonly root: string;
  readonly port: number;
  readonly token: string;
  readonly daemon: DaemonProcess;
};

/**
 * A daemon on a root of its own, ready to answer. A root that loses its lock port to
 * another root is the one failure worth retrying: the daemon named the port it derived,
 * and a different root is the documented remedy (ARCHITECTURE.md, "Singleton lock").
 */
export const startDaemonProcess = async (options: {
  readonly prefix?: string;
  /** The roots to try, in order; the default is a fresh collision-free root per attempt. */
  readonly roots?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly attempts?: number;
  /** Builds the environment for a root, so a stub model can be started beside it. */
  readonly prepare?: (root: string) => Promise<{
    readonly env?: Readonly<Record<string, string>>;
    readonly cleanup?: () => Promise<void>;
  }>;
}): Promise<StartedDaemon> => {
  const attempts = options.attempts ?? 3;
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const given = options.roots?.[attempt];
    const root = given ?? (await daemonRoot(options.prefix));
    let cleanup: (() => Promise<void>) | undefined;
    let daemon: DaemonProcess | undefined;
    try {
      const prepared = await options.prepare?.(root);
      cleanup = prepared?.cleanup;
      daemon = spawnDaemon({
        root,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: { ...(prepared?.env ?? {}), ...(options.env ?? {}) },
      });
      const start = await daemon.waitForStart();
      return { root, port: start.port, token: start.token, daemon };
    } catch (error) {
      await daemon?.stop();
      await cleanup?.();
      if (given === undefined) await rm(root, { recursive: true, force: true });
      const stderr = daemon?.stderr() ?? "";
      // Only a lost lock port is worth another root: the daemon named the port it
      // derived, and a different root is the documented remedy.
      if (!isLockCollision(stderr)) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error("the daemon did not start");
};
