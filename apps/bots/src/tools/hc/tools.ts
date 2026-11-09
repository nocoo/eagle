// The Herdr tools (docs/bots/RUNTIME.md, "Herdr tools"): a bot drives real coding agents in
// herdr-core terminals through `hc`. It never shares the person's own terminals: every
// terminal it starts carries this bot's label and name prefix, and anything else is refused.
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ThinkingLevel } from "../../core/domain.ts";
import { type BotWorkspace, failed, ToolError, type ToolOutcome } from "../types.ts";
import { resolveInside } from "../workspace.ts";
import { type HcClient, HcCommandError, type HcTerminal } from "./client.ts";

/** The extension's name; a conversation stores it, so it is part of the runtime contract. */
export const HC_TOOLS_EXTENSION = "bots-hc";

/** The three jobs a bot hands out, and the only roles this extension starts. */
export const HC_ROLES = ["steering", "coding", "reviewing"] as const;
export type HcRole = (typeof HC_ROLES)[number];

/** One role's launch: which model the child runs on, and how hard it thinks. */
export type HcRoleConfig = {
  readonly model: string;
  readonly thinkingLevel: ThinkingLevel;
};

export type HcRoles = {
  /** The provider `pi --provider` gets: the daemon's own gateway provider. */
  readonly provider: string;
  readonly roles: Readonly<Record<HcRole, HcRoleConfig>>;
};

const isRole = (value: string): value is HcRole => (HC_ROLES as readonly string[]).includes(value);

const NAME_SUFFIX = /^[a-z][a-z0-9_-]{0,15}$/;
const KEY_NAME = /^[a-z0-9+_-]{1,24}$/;
const MAX_TASK_BYTES = 16 * 1024;
const MAX_READ_LINES = 2_000;
const MAX_READ_BYTES = 64 * 1024;
const MAX_TIMEOUT_SECONDS = 600;
const DEFAULT_TIMEOUT_SECONDS = 120;
const START_TIMEOUT_MS = 60_000;
/** The most terminals one list or one close walks; a bot that started more is refused. */
const MAX_OWNED = 8;

export type HcToolOptions = {
  readonly client: HcClient;
  readonly workspace: BotWorkspace;
  readonly botId: string;
  /** Read on every call, so a save on the Herdr page lands on the next tool call. */
  readonly roles: () => HcRoles;
};

const shortId = (botId: string): string => {
  const normalized = botId.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized.length === 0 ? "bot" : normalized.slice(0, 8);
};

/** Every terminal this bot starts shares this prefix, and only those are its own. */
export const hcNamePrefix = (botId: string): string => `bots-${shortId(botId)}`;

const namedFor = (terminal: HcTerminal, botId: string): boolean =>
  (terminal.name ?? "").startsWith(`${hcNamePrefix(botId)}-`);

/** `hc ls` answers no labels, so the label is checked on the one terminal a call addresses. */
const owns = (terminal: HcTerminal, botId: string): boolean =>
  terminal.labels.bots === botId && namedFor(terminal, botId);

const describe = (terminal: HcTerminal): string => {
  const name = terminal.name ?? terminal.address;
  const status = terminal.status ?? terminal.state;
  const agent = terminal.agent === undefined ? "" : ` ${terminal.agent}`;
  return `${terminal.address} ${name}${agent} · ${status}`;
};

const describeError = (error: unknown): string => {
  if (error instanceof ToolError) return error.message;
  if (error instanceof HcCommandError) {
    const generic = new Set(["hc_failed", "timeout", "aborted", "spawn_failed"]);
    return generic.has(error.code) ? error.message : `${error.code}: ${error.message}`;
  }
  return "the hc command failed";
};

const clipTail = (text: string): string => {
  const encoded = Buffer.from(text);
  if (encoded.length <= MAX_READ_BYTES) return text;
  let slice = encoded.subarray(encoded.length - MAX_READ_BYTES);
  let decoded = slice.toString("utf8");
  for (let guard = 0; guard < 4 && decoded.startsWith("\uFFFD"); guard += 1) {
    slice = slice.subarray(1);
    decoded = slice.toString("utf8");
  }
  return `[showing the last ${MAX_READ_BYTES} bytes]\n${decoded}`;
};

const timeoutOf = (seconds: number | undefined): number => {
  const value = seconds ?? DEFAULT_TIMEOUT_SECONDS;
  return Math.min(Math.max(Math.round(value), 1), MAX_TIMEOUT_SECONDS) * 1_000;
};

/** The tools, bound to one bot's own terminals in the person's herdr-core session. */
export const createHcTools = (options: HcToolOptions): readonly ToolRegistration[] => {
  const { client, workspace, botId } = options;
  const prefix = hcNamePrefix(botId);
  const labels = { bots: botId } as const;
  // The tools share one process-level session; one call at a time keeps start/close ordered.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  /** The bot's own terminals: `ls` filters by label and the name prefix decides. */
  const owned = async (signal?: AbortSignal): Promise<readonly HcTerminal[]> => {
    const listed = await client.list(labels, { signal, timeoutMs: 30_000 });
    const mine = listed.filter((terminal) => namedFor(terminal, botId));
    if (mine.length > MAX_OWNED) {
      throw new ToolError(`more than ${MAX_OWNED} terminals are yours; close some first`);
    }
    return mine;
  };

  const resolveTarget = async (
    target: string | undefined,
    signal?: AbortSignal,
  ): Promise<HcTerminal> => {
    const mine = await owned(signal);
    if (mine.length === 0) {
      throw new ToolError("no terminal is yours yet; call hc_start first");
    }
    if (target === undefined) {
      const steering = mine.find((terminal) => terminal.name?.endsWith("-steering") === true);
      if (steering !== undefined) return steering;
      const [only] = mine;
      if (mine.length === 1 && only !== undefined) return only;
      throw new ToolError(
        `name a target: ${mine.map((terminal) => terminal.name ?? terminal.address).join(", ")}`,
      );
    }
    const found = mine.find((terminal) => terminal.address === target || terminal.name === target);
    if (found === undefined) throw new ToolError(`no terminal ${target} is yours`);
    const verified = await client.get(found.address, { signal });
    if (verified === undefined) throw new ToolError(`terminal ${target} is gone`);
    // The label and the prefix are the ownership record; a reassigned name is not trusted.
    if (!owns(verified, botId)) {
      throw new ToolError(`terminal ${target} is not this bot's own terminal`);
    }
    return verified;
  };

  const roleConfig = (role: HcRole): HcRoleConfig => {
    const config = options.roles().roles[role];
    if (config.model.trim().length === 0) {
      throw new ToolError(`the Herdr page has no model for ${role}; set one there first`);
    }
    return config;
  };

  const result = (outcome: ToolOutcome) => ({
    output: [{ type: "text" as const, text: outcome.output }],
    ...(outcome.isError === true ? { isError: true } : {}),
  });
  const run = (signal: AbortSignal | undefined, work: () => Promise<ToolOutcome>) =>
    serial(async () => {
      if (signal?.aborted === true) return failed("the hc command was aborted");
      return work();
    }).then(result);

  const tools: ToolRegistration[] = [
    defineTool({
      name: "hc_start",
      description:
        "Start an agent in your own hc terminal. `steering` takes a whole requirement (it plans and dispatches coding and reviewing itself); `coding` and `reviewing` are for one simple task. Each role's model is set on the Herdr page. Returns the terminal address.",
      parameters: Type.Object({
        role: Type.String({ description: "steering, coding or reviewing" }),
        task: Type.String({ description: "The first message the agent gets" }),
        name: Type.Optional(
          Type.String({ description: "Suffix for the terminal name, [a-z][a-z0-9_-]{0,15}" }),
        ),
        cwd: Type.Optional(
          Type.String({ description: "Directory inside the workspace (default the root)" }),
        ),
      }),
      outputLimits: { maxBytes: 8 * 1024, maxLines: 100, retain: "head" },
      // Seven terminal tools are too much prompt to carry in every request; the model
      // loads the ones it needs with tool_search.
      deferred: true,
      execute: (args, _api, context) =>
        run(context.abortSignal, async (): Promise<ToolOutcome> => {
          try {
            if (!isRole(args.role)) {
              return failed(`unknown role: ${args.role} (use steering, coding or reviewing)`);
            }
            const task = args.task;
            if (task.trim().length === 0) return failed("a task is required");
            if (Buffer.byteLength(task) > MAX_TASK_BYTES) {
              return failed(`the task exceeds ${MAX_TASK_BYTES} bytes`);
            }
            if (task.includes("\0")) return failed("the task contains a null byte");
            if (args.name !== undefined && !NAME_SUFFIX.test(args.name)) {
              return failed(`the name must match [a-z][a-z0-9_-]{0,15}: ${args.name}`);
            }
            const config = roleConfig(args.role);
            const base = `${prefix}-${args.role}`;
            const name = args.name === undefined ? base : `${base}-${args.name}`;
            if (name.length > 32) return failed(`the terminal name is longer than 32: ${name}`);
            const mine = await owned(context.abortSignal);
            const existing = mine.find((terminal) => terminal.name === name);
            if (existing !== undefined) {
              // One agent per name: a second start would spend a second model for nothing.
              const live = await client.get(existing.address, { signal: context.abortSignal });
              return {
                output: `${name} is already running (${live?.status ?? live?.state ?? "live"}) at ${existing.address}; use hc_send, or hc_close first`,
              };
            }
            if (mine.length >= MAX_OWNED) {
              return failed(`you already have ${mine.length} terminals; close one first`);
            }
            const cwd = await resolveInside(workspace.root, args.cwd ?? ".");
            const address = await client.run(
              {
                name,
                cwd,
                labels,
                argv: [
                  "pi",
                  "--provider",
                  options.roles().provider,
                  "--model",
                  config.model,
                  "--thinking",
                  config.thinkingLevel,
                  task,
                ],
              },
              { signal: context.abortSignal, timeoutMs: START_TIMEOUT_MS },
            );
            return {
              output: `started ${args.role} as ${name} (${config.model} · ${config.thinkingLevel}) at ${address}`,
            };
          } catch (error) {
            return failed(describeError(error));
          }
        }),
    }),
    defineTool({
      name: "hc_list",
      description:
        "List the hc terminals you own, with their agent and its reported state (idle, working, done, blocked, error).",
      parameters: Type.Object({}),
      replay: "safe",
      outputLimits: { maxBytes: 8 * 1024, maxLines: 100, retain: "head" },
      deferred: true,
      execute: (_args, _api, context) =>
        run(context.abortSignal, async (): Promise<ToolOutcome> => {
          try {
            const mine = await owned(context.abortSignal);
            if (mine.length === 0) return { output: "no terminal is yours yet" };
            return { output: mine.map(describe).join("\n") };
          } catch (error) {
            return failed(describeError(error));
          }
        }),
    }),
    defineTool({
      name: "hc_send",
      description:
        "Send a message to one of your agents (default your steering agent) and, by default, wait for its turn to settle. Use hc_read for the answer.",
      parameters: Type.Object({
        target: Type.Optional(Type.String({ description: "Terminal address or name you own" })),
        text: Type.String({ description: "The message to submit" }),
        wait: Type.Optional(
          Type.Boolean({ description: "Wait for the turn to settle (default true)" }),
        ),
        timeoutSeconds: Type.Optional(
          Type.Number({ description: "Deadline in seconds (default 120, at most 600)" }),
        ),
      }),
      outputLimits: { maxBytes: 8 * 1024, maxLines: 100, retain: "head" },
      deferred: true,
      execute: (args, _api, context) =>
        run(context.abortSignal, async (): Promise<ToolOutcome> => {
          try {
            if (args.text.trim().length === 0) return failed("a message is required");
            if (Buffer.byteLength(args.text) > MAX_TASK_BYTES) {
              return failed(`the message exceeds ${MAX_TASK_BYTES} bytes`);
            }
            if (args.text.includes("\0")) return failed("the message contains a null byte");
            const target = await resolveTarget(args.target, context.abortSignal);
            const status = await client.send(
              { address: target.address, text: args.text, wait: args.wait ?? true },
              {
                signal: context.abortSignal,
                timeoutMs: timeoutOf(args.timeoutSeconds) + 30_000,
              },
            );
            return {
              output: `sent to ${target.name ?? target.address}${
                status === undefined ? "" : ` (${status})`
              }`,
            };
          } catch (error) {
            return failed(describeError(error));
          }
        }),
    }),
    defineTool({
      name: "hc_wait",
      description:
        "Wait until one of your agents stops working, reports a state, or exits. A timeout is a check-in, not a failure: wait again.",
      parameters: Type.Object({
        target: Type.Optional(Type.String({ description: "Terminal address or name you own" })),
        timeoutSeconds: Type.Optional(
          Type.Number({ description: "Seconds before it checks in (default 120, at most 600)" }),
        ),
      }),
      replay: "safe",
      outputLimits: { maxBytes: 8 * 1024, maxLines: 100, retain: "head" },
      deferred: true,
      execute: (args, _api, context) =>
        run(context.abortSignal, async (): Promise<ToolOutcome> => {
          try {
            const target = await resolveTarget(args.target, context.abortSignal);
            const outcome = await client.wait(
              { address: target.address },
              {
                signal: context.abortSignal,
                timeoutMs: timeoutOf(args.timeoutSeconds) + 30_000,
              },
            );
            return {
              output: `${target.name ?? target.address}: ${outcome.status ?? "no status"}${
                outcome.ended ? " (ended)" : ""
              }${outcome.reason === undefined ? "" : ` · ${outcome.reason}`}`,
            };
          } catch (error) {
            return failed(describeError(error));
          }
        }),
    }),
    defineTool({
      name: "hc_read",
      description:
        "Read the screen and recent history of one of your agents (default your steering agent). The answer keeps the newest text when it is larger than the cap.",
      parameters: Type.Object({
        target: Type.Optional(Type.String({ description: "Terminal address or name you own" })),
        lines: Type.Optional(
          Type.Number({
            description: "History lines above the screen (default 200, at most 2000)",
          }),
        ),
      }),
      replay: "safe",
      outputLimits: { maxBytes: 128 * 1024, maxLines: 4_000, retain: "tail" },
      deferred: true,
      execute: (args, _api, context) =>
        run(context.abortSignal, async (): Promise<ToolOutcome> => {
          try {
            if (
              args.lines !== undefined &&
              (!Number.isInteger(args.lines) || args.lines < 0 || args.lines > MAX_READ_LINES)
            ) {
              return failed(`lines must be an integer between 0 and ${MAX_READ_LINES}`);
            }
            const target = await resolveTarget(args.target, context.abortSignal);
            const text = await client.read(
              { address: target.address, lines: args.lines ?? 200 },
              { signal: context.abortSignal, timeoutMs: 30_000 },
            );
            return { output: clipTail(text) };
          } catch (error) {
            return failed(describeError(error));
          }
        }),
    }),
    defineTool({
      name: "hc_keys",
      description:
        "Press named keys (enter, esc, up, ctrl+c, 1, ...) in one of your agents, for example to answer a dialog it is blocked on.",
      parameters: Type.Object({
        target: Type.Optional(Type.String({ description: "Terminal address or name you own" })),
        keys: Type.Array(Type.String({ description: "One key name per entry" })),
      }),
      outputLimits: { maxBytes: 4 * 1024, maxLines: 50, retain: "head" },
      deferred: true,
      execute: (args, _api, context) =>
        run(context.abortSignal, async (): Promise<ToolOutcome> => {
          try {
            if (args.keys.length === 0 || args.keys.length > 8) {
              return failed("send between 1 and 8 keys");
            }
            for (const key of args.keys) {
              if (!KEY_NAME.test(key)) return failed(`not a key name: ${key}`);
            }
            const target = await resolveTarget(args.target, context.abortSignal);
            await client.keys(
              { address: target.address, keys: args.keys },
              { signal: context.abortSignal, timeoutMs: 30_000 },
            );
            return { output: `sent ${args.keys.join(" ")} to ${target.name ?? target.address}` };
          } catch (error) {
            return failed(describeError(error));
          }
        }),
    }),
    defineTool({
      name: "hc_close",
      description:
        "Close one of your terminals, or every terminal you own when no target is named, and forget it.",
      parameters: Type.Object({
        target: Type.Optional(Type.String({ description: "Terminal address or name you own" })),
      }),
      outputLimits: { maxBytes: 4 * 1024, maxLines: 50, retain: "head" },
      deferred: true,
      execute: (args, _api, context) =>
        run(context.abortSignal, async (): Promise<ToolOutcome> => {
          try {
            const closing =
              args.target === undefined
                ? await owned(context.abortSignal)
                : [await resolveTarget(args.target, context.abortSignal)];
            if (closing.length === 0) return { output: "no terminal is yours to close" };
            const closed: string[] = [];
            for (const terminal of closing) {
              await client.kill(terminal.address, {
                signal: context.abortSignal,
                timeoutMs: 30_000,
              });
              // `rm` refuses a terminal that is still running, so one retry covers the kill;
              // a terminal that is live both times is reported, never reported as closed.
              let stuck: unknown;
              for (let attempt = 0; attempt < 2; attempt += 1) {
                try {
                  await client.remove(terminal.address, {
                    signal: context.abortSignal,
                    timeoutMs: 30_000,
                  });
                  stuck = undefined;
                  break;
                } catch (error) {
                  stuck = error;
                  if (!(error instanceof HcCommandError) || error.code !== "live") throw error;
                }
              }
              if (stuck !== undefined) throw stuck;
              closed.push(terminal.name ?? terminal.address);
            }
            return { output: `closed ${closed.join(", ")}` };
          } catch (error) {
            return failed(describeError(error));
          }
        }),
    }),
  ];

  return tools;
};

/** The section that tells the model what the Herdr tools are for and in what order. */
export const hcSection = (botId: string): string =>
  [
    `You drive coding agents through hc in your own herdr-core terminals (${hcNamePrefix(botId)}-*); terminals that are not yours are never visible to these tools.`,
    'The tools are not loaded yet: call tool_search with a query like "hc" to enable them.',
    "Hand a whole requirement to the steering agent with hc_start role=steering: it plans, dispatches its own coding and reviewing agents, and reports back.",
    "For one simple change start hc_start role=coding; for a read-only review start hc_start role=reviewing. Each role's model is configured on the Herdr page.",
    "Then hc_wait until the turn settles and hc_read the answer; hc_keys answers a dialog the agent is blocked on.",
    "Close what you started with hc_close when the work is done.",
  ].join("\n");
