// The hc CLI is the bot's only door to herdr-core (docs/bots/RUNTIME.md, "Herdr tools"):
// one argv, no shell, a deadline and a bounded answer. Everything the tools know about
// terminals and their state comes from these JSON answers, never from guessing.
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
/** A read is the only call whose answer is output rather than a fact, and it is capped. */
const DEFAULT_TIMEOUT_MS = 30_000;

export class HcCommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HcCommandError";
    this.code = code;
  }
}

/** One terminal as `hc ls` and `hc get` describe it. */
export type HcTerminal = {
  readonly address: string;
  readonly name: string | undefined;
  /** `live` or `finished`. */
  readonly state: string;
  /** What the program itself reported through OSC 7501, when it reports anything. */
  readonly status: string | undefined;
  readonly agent: string | undefined;
  readonly cwd: string | undefined;
  readonly labels: Readonly<Record<string, string>>;
  readonly exitCode: number | null;
};

export type HcWaitResult = {
  /** The status the wait ended on, when it ended on one. */
  readonly status: string | undefined;
  readonly reason: string | undefined;
  readonly ended: boolean;
  readonly exitCode: number | null;
};

export type RunOptions = {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal | undefined;
};

export type HcClient = {
  list(
    labels: Readonly<Record<string, string>>,
    options?: RunOptions,
  ): Promise<readonly HcTerminal[]>;
  get(address: string, options?: RunOptions): Promise<HcTerminal | undefined>;
  run(
    input: {
      readonly name: string;
      readonly cwd: string;
      readonly labels: Readonly<Record<string, string>>;
      readonly argv: readonly string[];
    },
    options?: RunOptions,
  ): Promise<string>;
  send(
    input: { readonly address: string; readonly text: string; readonly wait?: boolean },
    options?: RunOptions,
  ): Promise<string | undefined>;
  wait(input: { readonly address: string }, options?: RunOptions): Promise<HcWaitResult>;
  read(
    input: { readonly address: string; readonly lines?: number },
    options?: RunOptions,
  ): Promise<string>;
  keys(
    input: { readonly address: string; readonly keys: readonly string[] },
    options?: RunOptions,
  ): Promise<void>;
  kill(address: string, options?: RunOptions): Promise<void>;
  remove(address: string, options?: RunOptions): Promise<void>;
};

export type HcCliOptions = {
  readonly binary?: string;
  readonly env?: NodeJS.ProcessEnv;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const labelsOf = (value: unknown): Readonly<Record<string, string>> => {
  const record = asRecord(value);
  if (record === undefined) return {};
  const labels: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string") labels[key] = entry;
  }
  return labels;
};

/** `hc get` names the program's own status under `status.state`. */
const statusOf = (value: Record<string, unknown>): string | undefined =>
  asString(asRecord(value.status)?.state) ?? asString(value.status);

const terminalOf = (value: unknown): HcTerminal | undefined => {
  const record = asRecord(value);
  const address = asString(record?.address);
  if (record === undefined || address === undefined) return undefined;
  return {
    address,
    name: asString(record.name),
    state: asString(record.state) ?? "unknown",
    status: statusOf(record),
    agent: asString(record.agent),
    cwd: asString(record.cwd),
    labels: labelsOf(record.labels),
    exitCode: asNumber(record.exit_code) ?? null,
  };
};

/** A herdr-core error is JSON with a kind and a message; anything else keeps its detail. */
const errorOf = (body: string): HcCommandError | undefined => {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const error = asRecord(asRecord(parsed)?.error);
  if (error === undefined) return undefined;
  return new HcCommandError(
    asString(error.kind) ?? "hc_failed",
    asString(error.message) ?? "hc failed",
  );
};

const labelArgs = (labels: Readonly<Record<string, string>>): string[] =>
  Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);

export const createHcClient = (options: HcCliOptions = {}): HcClient => {
  const binary = options.binary ?? "hc";

  const run = async (
    args: readonly string[],
    runOptions: RunOptions = {},
  ): Promise<{ readonly text: string; readonly json: unknown }> => {
    const { text } = await runCli(args, runOptions);
    const trimmed = text.trim();
    if (!trimmed.startsWith("{")) return { text: trimmed, json: undefined };
    try {
      return { text: trimmed, json: JSON.parse(trimmed) };
    } catch {
      return { text: trimmed, json: undefined };
    }
  };

  const runCli = (
    args: readonly string[],
    runOptions: RunOptions,
  ): Promise<{ readonly text: string; readonly stderr: string }> =>
    new Promise((resolve, reject) => {
      if (runOptions.signal?.aborted === true) {
        reject(new HcCommandError("aborted", "the hc command was aborted"));
        return;
      }
      const timeoutMs = runOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const child = spawn(binary, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...options.env },
        detached: true,
      });
      // Both streams keep the newest bytes: a screen read is only useful at its end.
      let stdout = "";
      let stderr = "";
      const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
      let settled = false;
      const settle = (outcome: { ok: true } | { ok: false; error: HcCommandError }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        runOptions.signal?.removeEventListener("abort", onAbort);
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        if (outcome.ok) resolve({ text: stdout, stderr });
        else reject(outcome.error);
      };
      const stop = () => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const timer = setTimeout(() => {
        stop();
        settle({
          ok: false,
          error: new HcCommandError("timeout", `hc ${args[0]} timed out after ${timeoutMs} ms`),
        });
      }, timeoutMs);
      timer.unref?.();
      const onAbort = () => {
        stop();
        settle({ ok: false, error: new HcCommandError("aborted", "the hc command was aborted") });
      };
      runOptions.signal?.addEventListener("abort", onAbort, { once: true });
      const keepTail = (current: string, piece: string, limit: number): string => {
        const next = current + piece;
        if (Buffer.byteLength(next) <= limit) return next;
        const bytes = Buffer.from(next);
        let slice = bytes.subarray(bytes.length - limit);
        let decoded = slice.toString("utf8");
        for (let guard = 0; guard < 4 && decoded.startsWith("\uFFFD"); guard += 1) {
          slice = slice.subarray(1);
          decoded = slice.toString("utf8");
        }
        return decoded;
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = keepTail(stdout, decoders.stdout.write(chunk), MAX_STDOUT_BYTES);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = keepTail(stderr, decoders.stderr.write(chunk), MAX_STDERR_BYTES);
      });
      child.once("error", () => {
        settle({
          ok: false,
          error: new HcCommandError("spawn_failed", `hc could not start: ${binary}`),
        });
      });
      child.once("close", (code) => {
        stdout = keepTail(stdout, decoders.stdout.end(), MAX_STDOUT_BYTES);
        stderr = keepTail(stderr, decoders.stderr.end(), MAX_STDERR_BYTES);
        // An hc error is JSON on either stream and does not always set the exit code.
        const failure = errorOf(stderr) ?? errorOf(stdout);
        if (failure !== undefined) {
          settle({ ok: false, error: failure });
          return;
        }
        if (code === 0) {
          settle({ ok: true });
          return;
        }
        const detail = stderr.trim() || stdout.trim();
        settle({
          ok: false,
          error: new HcCommandError(
            "hc_failed",
            `hc ${args.slice(0, 2).join(" ")} failed (exit ${code ?? "none"}): ${
              detail.slice(0, 2_000) || "no detail"
            }`,
          ),
        });
      });
    });

  const jsonOf = async (args: readonly string[], runOptions: RunOptions = {}) =>
    (await run(args, runOptions)).json;

  return {
    async list(labels, runOptions = {}) {
      const output = asRecord(await jsonOf(["ls", "--json", ...labelArgs(labels)], runOptions));
      const terminals = Array.isArray(output?.terminals) ? output.terminals : [];
      return terminals.flatMap((entry) => {
        const terminal = terminalOf(entry);
        return terminal === undefined ? [] : [terminal];
      });
    },
    async get(address, runOptions = {}) {
      const json = asRecord(await jsonOf(["get", address, "--json"], runOptions));
      return terminalOf(json);
    },
    async run(input, runOptions = {}) {
      const json = asRecord(
        await jsonOf(
          [
            "run",
            "--bg",
            "--json",
            "--name",
            input.name,
            "--cwd",
            input.cwd,
            ...labelArgs(input.labels),
            "--",
            ...input.argv,
          ],
          runOptions,
        ),
      );
      const address = asString(json?.address);
      if (address === undefined) {
        throw new HcCommandError("invalid_response", "hc did not return the new terminal");
      }
      return address;
    },
    async send(input, runOptions = {}) {
      const args = ["send", input.address, input.text, "--json"];
      if (input.wait === true) args.push("--wait");
      const json = asRecord(await jsonOf(args, runOptions));
      return asString(json?.status) ?? asString(json?.started);
    },
    async wait(input, runOptions = {}) {
      const json = asRecord(await jsonOf(["wait", input.address, "--json"], runOptions));
      return {
        status: asString(json?.status),
        reason: asString(json?.reason),
        ended: json?.ended === true,
        exitCode: asNumber(json?.exit_code) ?? null,
      };
    },
    async read(input, runOptions = {}) {
      // Plain text, not `--json`: a screen longer than the cap loses its tail when the JSON
      // wrapper is cut, and the tail is the only part of a screen worth keeping.
      const { text } = await runCli(
        [
          "read",
          input.address,
          ...(input.lines === undefined ? [] : ["--lines", String(input.lines)]),
        ],
        runOptions,
      );
      return text.replace(/\n+$/, "");
    },
    async keys(input, runOptions = {}) {
      await jsonOf(["keys", input.address, ...input.keys, "--json"], runOptions);
    },
    async kill(address, runOptions = {}) {
      await jsonOf(["kill", address, "--json"], runOptions);
    },
    async remove(address, runOptions = {}) {
      await jsonOf(["rm", address, "--json"], runOptions);
    },
  };
};
