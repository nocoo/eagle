// SG-004: the one place the Superagent writes toward a worker. It uses the same command a
// person uses — `eagle chat send` / `eagle chat abort` — with its own scoped credential, so a
// nudge is an ordinary client message and the worker learns nothing about the Superagent.
import { spawn } from "node:child_process";
import type { ActionResult } from "./attention.ts";
import { readObservationToken } from "./observation.ts";

export type ManageCall = {
  readonly botId: string;
  readonly verb: "nudge" | "abort";
  readonly text: string;
};

export type ManageOptions = {
  /** The released CLI, or one from a bundle; the Superagent never speaks the socket itself. */
  readonly bin: string;
  readonly port: string;
  readonly tokenFile: string;
  readonly timeoutMs?: number;
  /** Injected by the tests: the same argv and environment the CLI would receive. */
  readonly run?: (input: {
    readonly bin: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
  }) => Promise<{ readonly code: number | null }>;
};

const DEFAULT_TIMEOUT_MS = 30_000;

const spawnRun: NonNullable<ManageOptions["run"]> = ({ bin, args, env, timeoutMs }) =>
  new Promise((resolve) => {
    const child = spawn(bin, [...args], {
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, ...env },
      detached: true,
    });
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    timer.unref?.();
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ code: null });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code });
    });
  });

/** The argv a management call becomes: one bot, one verb, the text as its own argument. */
export const manageArgs = (call: ManageCall): readonly string[] =>
  call.verb === "abort"
    ? ["chat", "abort", call.botId, "--json"]
    : ["chat", "send", call.botId, "--text", call.text, "--json"];

export const createManage =
  (options: ManageOptions) =>
  async (
    call: ManageCall,
  ): Promise<{ readonly result: ActionResult; readonly detail?: string }> => {
    const token = await readObservationToken(options.tokenFile);
    if (token === undefined) return { result: "failed", detail: "no_credential" };
    const outcome = await (options.run ?? spawnRun)({
      bin: options.bin,
      args: manageArgs(call),
      env: { EAGLE_TOKEN: token, EAGLE_PORT: options.port },
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (outcome.code === 0) return { result: "sent" };
    // 3 is "this credential lacks the scope", 4 is "the daemon is unreachable"; both are
    // remembered as codes, never as the CLI's text.
    if (outcome.code === 3) return { result: "refused", detail: "scope_refused" };
    if (outcome.code === 4) return { result: "failed", detail: "daemon_unreachable" };
    return { result: "failed", detail: "cli_failed" };
  };
