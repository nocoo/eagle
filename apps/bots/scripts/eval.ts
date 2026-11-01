// Acceptance runner for the cases under tests/eval/cases (format: tests/eval/README.md).
// It boots a real daemon on a temporary root, serves the case's model replies from a local
// Responses endpoint, drives the case's steps over HTTP and a WebSocket, and checks the
// transcript. Not part of `npm run check`: a case boots a process and runs real tools.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { WebSocket } from "ws";
import { readConfig } from "../src/config.ts";
import { type DaemonHandle, startDaemon } from "../src/main.ts";

type ScriptedReply =
  | { readonly text: string; readonly delayMs?: number; readonly holdFor?: string }
  | {
      readonly toolCall: { readonly name: string; readonly args: Record<string, unknown> };
      readonly delayMs?: number;
      readonly holdFor?: string;
    };

type CaseFile = {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly notes?: string;
  readonly timeoutMs?: number;
  readonly toolGroups?: readonly string[];
  readonly workspace?: Readonly<Record<string, string>>;
  readonly triggers?: readonly {
    readonly kind: "webhook" | "schedule";
    readonly name: string;
    readonly prompt: string;
    readonly cron?: string;
    readonly timezone?: string;
    readonly enabled?: boolean;
  }[];
  readonly model: { readonly script: readonly ScriptedReply[]; readonly repeatLast?: boolean };
  /** `mint` (default) writes a development agent token; `none` leaves it unwritten. */
  readonly devToken?: "mint" | "none";
  readonly steps: readonly Step[];
  readonly expect?: {
    readonly messages?: readonly {
      readonly role?: string;
      readonly origin?: string;
      readonly contains?: string;
    }[];
    /** Rows that must not exist: how a case proves an answer never arrived. */
    readonly messagesExcluded?: readonly {
      readonly role?: string;
      readonly contains?: string;
    }[];
    readonly atLeast?: readonly {
      readonly role?: string;
      readonly origin?: string;
      readonly count: number;
    }[];
    readonly toolsCalled?: readonly string[];
    readonly files?: Readonly<Record<string, string>>;
    readonly noErrors?: boolean;
    readonly modelRequests?: { readonly max: number };
  };
};

type Step =
  | { readonly kind: "chat"; readonly text: string; readonly timeoutMs?: number }
  | {
      readonly kind: "webhook";
      readonly trigger: string;
      readonly body: string;
      readonly idempotencyKey?: string;
      readonly expectStatus?: number;
    }
  | { readonly kind: "patch"; readonly trigger: string; readonly enabled: boolean }
  | {
      readonly kind: "http";
      readonly method: string;
      readonly path: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string;
      readonly expectStatus?: number;
      /** Stores the parsed answer under this name for later `{{name.path}}` references. */
      readonly capture?: string;
    }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly content?: string;
      /** Octal string, e.g. `"644"`: how a case makes a credential file unsafe. */
      readonly mode?: string;
    }
  | {
      /** Waits until a submission reached `status`: how a case sees an abort confirmed. */
      readonly kind: "waitSubmission";
      readonly status: string;
      readonly timeoutMs?: number;
    }
  | {
      /** Sends `count` messages in order, waiting for each to settle: a long transcript. */
      readonly kind: "chatBurst";
      readonly text: string;
      readonly count: number;
      readonly timeoutMs?: number;
    }
  | {
      /** Waits until the scripted model has answered `count` requests: an in-flight run. */
      readonly kind: "waitModelRequest";
      readonly count: number;
      readonly timeoutMs?: number;
    }
  | { readonly kind: "releaseModel"; readonly hold: string }
  | {
      readonly kind: "cli";
      readonly args: readonly string[];
      /** `dev` (default) runs a link named `eagle-dev`; `release` runs one named `eagle`. */
      readonly bin?: "dev" | "release";
      readonly expectExit?: number;
      readonly stdoutContains?: string;
      /** A string that must not appear: how a case proves a refused write did nothing. */
      readonly stdoutExcludes?: string;
      /** Dotted paths to arrays and the exact length each must have. */
      readonly jsonLengths?: Readonly<Record<string, number>>;
      readonly stderrContains?: string;
      /** Subset match against the last JSON line on stdout. */
      readonly json?: unknown;
      readonly capture?: string;
      readonly env?: Readonly<Record<string, string | null>>;
      /** The command is expected to outlive its budget and be killed. */
      readonly expectTimeout?: boolean;
    }
  | {
      readonly kind: "waitFor";
      readonly role?: string;
      readonly origin?: string;
      readonly contains?: string;
      readonly count: number;
      readonly timeoutMs?: number;
    }
  | { readonly kind: "sleep"; readonly ms: number };

type Frame = { readonly type: string } & Record<string, unknown>;
type Loose = Record<string, unknown>;
type Row = { readonly role: string; readonly origin: string | null; readonly text: string };

function failure(message: string): never {
  throw new Error(message);
}

/**
 * A local OpenAI Responses endpoint: streams the case's replies, in order. A reply may
 * hold until the case releases it, so a test about aborting knows the answer is really
 * in flight instead of guessing with a sleep.
 */
const scriptedModel = (script: readonly ScriptedReply[], repeatLast: boolean) => {
  const requests: { readonly lastInput: string; readonly tools: number }[] = [];
  const waiters = new Map<string, (() => void)[]>();
  let arrivals = 0;
  let index = 0;
  const holdUntilReleased = (hold: string): Promise<void> =>
    new Promise((resolve_) => {
      const waiting = waiters.get(hold) ?? [];
      waiting.push(resolve_);
      waiters.set(hold, waiting);
    });
  const release = (hold: string): void => {
    for (const resolve_ of waiters.get(hold) ?? []) resolve_();
    waiters.delete(hold);
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.url?.endsWith("/models") === true) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "eval-model", object: "model" }] }));
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
        model?: string;
        stream?: boolean;
        tools?: unknown[];
        input?: unknown[];
      };
      if (process.env.EVAL_TRACE === "1") {
        process.stdout.write(`model request ${requests.length + 1}\n`);
      }
      requests.push({
        lastInput: JSON.stringify(body.input?.at(-1) ?? null).slice(0, 2_000),
        tools: body.tools?.length ?? 0,
      });
      const reply = index < script.length ? script[index] : repeatLast ? script.at(-1) : undefined;
      index += 1;
      arrivals += 1;
      if (reply === undefined) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "eval script exhausted" } }));
        return;
      }
      const respond = (): void => {
        const text = "text" in reply ? reply.text : "";
        const call =
          "toolCall" in reply
            ? {
                type: "function_call",
                id: "fc_eval",
                call_id: `call_${index}`,
                name: reply.toolCall.name,
                arguments: JSON.stringify(reply.toolCall.args),
              }
            : undefined;
        const item = call ?? {
          type: "message",
          id: "msg_eval",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
        };
        const base = {
          id: "resp_eval",
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          model: body.model ?? "eval-model",
        };
        const usage = { input_tokens: 20, output_tokens: 12, total_tokens: 32 };
        if (body.stream !== true) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ...base, status: "completed", output: [item], usage }));
          return;
        }
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        const send = (event: string, data: Record<string, unknown>): void => {
          response.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
        };
        send("response.created", {
          response: { ...base, status: "in_progress", output: [] },
        });
        send("response.output_item.added", {
          output_index: 0,
          item:
            call === undefined
              ? {
                  type: "message",
                  id: "msg_eval",
                  status: "in_progress",
                  role: "assistant",
                  content: [],
                }
              : { ...call, status: "in_progress" },
        });
        if (call !== undefined) {
          send("response.function_call_arguments.delta", {
            item_id: call.id,
            output_index: 0,
            delta: call.arguments,
          });
          send("response.function_call_arguments.done", {
            item_id: call.id,
            output_index: 0,
            arguments: call.arguments,
          });
        } else {
          send("response.content_part.added", {
            item_id: "msg_eval",
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          });
          send("response.output_text.delta", {
            item_id: "msg_eval",
            output_index: 0,
            content_index: 0,
            delta: text,
          });
          send("response.output_text.done", {
            item_id: "msg_eval",
            output_index: 0,
            content_index: 0,
            text,
          });
          send("response.content_part.done", {
            item_id: "msg_eval",
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text, annotations: [] },
          });
        }
        send("response.output_item.done", { output_index: 0, item });
        send("response.completed", {
          response: { ...base, status: "completed", output: [item], usage },
        });
        response.end();
      };
      // A case about aborting needs an answer that is still in flight when it aborts.
      const delay = reply.delayMs ?? 0;
      const hold = reply.holdFor;
      if (hold !== undefined) {
        void holdUntilReleased(hold).then(() =>
          delay > 0 ? setTimeout(respond, delay) : respond(),
        );
      } else if (delay > 0) setTimeout(respond, delay);
      else respond();
    });
  });
  return { server, requests, arrivals: () => arrivals, release };
};

const listen = (server: ReturnType<typeof createServer>): Promise<number> =>
  new Promise((resolve_) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve_(typeof address === "object" && address !== null ? address.port : 0);
    });
  });

/** `--port 0` asks the kernel for a free port, so cases never collide with a real daemon. */
const boot = async (
  root: string,
  env: Readonly<Record<string, string>> = {},
): Promise<DaemonHandle> => startDaemon(readConfig({ argv: ["--root", root, "--port", "0"], env }));

const api = async (
  port: number,
  token: string,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

/** A viewer: one bot subscriber that records messages, tool names and errors. */
const viewer = async (port: number, token: string, botId: string) => {
  const rows: Row[] = [];
  const tools: string[] = [];
  const errors: string[] = [];
  const submissions = new Map<string, string>();
  const triggers: { id: string; name: string; kind: string; enabled: boolean }[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/socket`, {
    headers: { authorization: `Bearer ${token}` },
  });
  let closed: string | undefined;
  const ready = new Promise<void>((resolve_, reject) => {
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, client: "eval" }));
    });
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as Frame;
      const loose = frame as Loose;
      if (process.env.EVAL_TRACE === "1") {
        process.stdout.write(`frame ${frame.type} ${JSON.stringify(frame).slice(0, 300)}\n`);
      }
      if (frame.type === "welcome") {
        socket.send(JSON.stringify({ type: "subscribe", botId, trace: "tr_eval_0001" }));
      }
      if (frame.type === "snapshot" || frame.type === "append") {
        const messages =
          frame.type === "append"
            ? [(loose.message ?? {}) as Loose]
            : (((loose.value as Loose | undefined)?.messages ?? []) as Loose[]);
        if (frame.type === "snapshot") {
          rows.length = 0;
          resolve_();
        }
        for (const message of messages) {
          // A provisional is a projection of the attempt the committed entry replaces.
          if (String(message.id).startsWith("p_")) continue;
          const origin = (message.origin as { kind?: string } | undefined)?.kind ?? null;
          const blocks = (message.blocks ?? []) as { type: string; name?: string; text?: string }[];
          rows.push({
            role: String(message.role),
            origin,
            text: blocks.map((block) => block.text ?? "").join(" "),
          });
          for (const block of blocks) {
            if (block.type === "toolCall" && block.name !== undefined) tools.push(block.name);
          }
        }
        const list = ((loose.value as Loose | undefined)?.triggers ?? undefined) as
          | typeof triggers
          | undefined;
        if (list !== undefined) {
          triggers.length = 0;
          triggers.push(
            ...list.map((entry) => ({
              id: entry.id,
              name: entry.name,
              kind: entry.kind,
              enabled: entry.enabled,
            })),
          );
        }
      }
      if (frame.type === "triggers") {
        const list = (loose.triggers ?? []) as typeof triggers;
        triggers.length = 0;
        triggers.push(...list.map((entry) => ({ ...entry })));
      }
      if (frame.type === "submission") {
        // The wire flattens the record: requestId and status sit on the frame.
        const requestId = loose.requestId as string | undefined;
        const status = loose.status as string | undefined;
        if (requestId !== undefined && status !== undefined) submissions.set(requestId, status);
      }
      if (frame.type === "error") {
        errors.push(String(loose.message ?? "error"));
      }
    });
    socket.on("error", reject);
    socket.on("close", (code: number) => {
      closed = `socket closed ${code}`;
    });
  });
  // A case can wait a minute for a schedule; an idle connection would be closed under it.
  const keepalive = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "ping", trace: "tr_eval_ping" }));
    }
  }, 20_000);
  keepalive.unref?.();
  return {
    ready,
    rows,
    tools,
    errors,
    triggers,
    settled: (requestId: string): string | undefined => submissions.get(requestId),
    statuses: (): string[] => [...submissions.values()],
    send: (text: string, requestId: string): void => {
      socket.send(
        JSON.stringify({
          type: "send",
          requestId,
          text,
          whenBusy: "followUp",
          trace: `tr_eval_${requestId}`,
        }),
      );
    },
    closed: (): string | undefined => closed,
    close: (): void => {
      clearInterval(keepalive);
      socket.close();
    },
  };
};

const wait = async (ms: number): Promise<void> =>
  new Promise((resolve_) => setTimeout(resolve_, ms));

const waitUntil = async (
  check: () => boolean,
  message: string,
  timeoutMs: number,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await wait(50);
  }
  failure(`${message} within ${timeoutMs} ms`);
};

type Report = { readonly id: string; readonly ok: boolean; readonly detail: string };

/** Every expected key and array prefix must hold; a case asserts what it read, not all of it. */
const assertSubset = (actual: unknown, expected: unknown, where: string): void => {
  if (Array.isArray(expected)) {
    const list = Array.isArray(actual) ? actual : undefined;
    if (list === undefined || list.length < expected.length) {
      failure(`${where}: expected ${expected.length} entries, got ${JSON.stringify(actual)}`);
    }
    for (const [index, item] of expected.entries()) {
      assertSubset(list[index], item, `${where}[${index}]`);
    }
    return;
  }
  if (expected !== null && typeof expected === "object") {
    const record =
      actual !== null && typeof actual === "object" && !Array.isArray(actual)
        ? (actual as Record<string, unknown>)
        : undefined;
    if (record === undefined) {
      failure(`${where}: expected an object, got ${JSON.stringify(actual)}`);
    }
    for (const [key, value] of Object.entries(expected)) {
      assertSubset(record[key], value, `${where}.${key}`);
    }
    return;
  }
  if (actual !== expected) {
    failure(`${where}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

type ProcessResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
};

/**
 * Runs a command without blocking: the daemon this runner boots lives in its own event
 * loop, so a synchronous child would starve it and every request would time out.
 */
const runProcess = (
  bin: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<ProcessResult> =>
  new Promise((resolve_) => {
    const child = spawn(bin, args, { env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve_({ status: null, stdout, stderr: `${stderr}${String(error)}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve_({ status: code, stdout, stderr, timedOut });
    });
  });

/** The last stdout line that parses as JSON. `--json` prints one object per line. */
const lastJsonLine = (stdout: string): unknown => {
  const lines = stdout.split("\n").filter((line) => line.trim().startsWith("{"));
  const last = lines.at(-1) ?? failure(`no JSON line on stdout: ${JSON.stringify(stdout)}`);
  try {
    return JSON.parse(last);
  } catch {
    return failure(`the last JSON line does not parse: ${JSON.stringify(last)}`);
  }
};

const runCase = async (
  file: string,
  options: { readonly verbose: boolean; readonly keep: boolean; readonly cli?: string },
): Promise<Report> => {
  const study = JSON.parse(await readFile(file, "utf8")) as CaseFile;
  const budget = study.timeoutMs ?? 120_000;
  const started = Date.now();
  const root = await mkdtemp(join(tmpdir(), `bots-eval-${study.id}-`));
  const usesCli = study.steps.some((step) => step.kind === "cli");
  const home = join(root, "home");
  const devTokenPath = join(home, ".config", "eagle-dev", "token");
  /** Values a step captured, addressed by later steps as `{{name.path}}`. */
  const captured = new Map<string, unknown>();
  const model = scriptedModel(study.model.script, study.model.repeatLast === true);
  const modelPort = await listen(model.server);
  let handle: DaemonHandle | undefined;
  let botId = "";
  try {
    if (usesCli && options.cli === undefined) {
      failure(
        `case ${study.id} drives the CLI: build it and pass --cli (apps/bots/scripts/eval-cli.sh does both)`,
      );
    }
    await mkdir(root, { recursive: true });
    const devToken = study.devToken === "none" ? undefined : randomBytes(48).toString("base64url");
    if (devToken !== undefined) {
      await mkdir(dirname(devTokenPath), { recursive: true, mode: 0o700 });
      await writeFile(devTokenPath, `${devToken}\n`, { mode: 0o600 });
      captured.set("dev", { token: devToken, path: devTokenPath, home });
    }
    /** Only a case that drives the CLI arms the development credential. */
    const daemonEnv = (): Readonly<Record<string, string>> =>
      devToken === undefined ? {} : { BOTS_DEV_AGENT_TOKEN: devTokenPath };
    // Hermetic: provider keys and other user configuration must never be read by a case.
    process.env.XDG_CONFIG_HOME = join(root, "config");
    await writeFile(
      join(root, "gateway.json"),
      `${JSON.stringify(
        {
          provider: "magpie",
          baseUrl: `http://127.0.0.1:${modelPort}/v1`,
          model: "eval-model",
          apiKey: "eval-key",
          thinkingLevel: "low",
          // No `toolGroups` means "whatever the daemon defaults to", which is what a case
          // without the field is testing.
          ...(study.toolGroups === undefined ? {} : { toolGroups: study.toolGroups }),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    handle = await boot(root, daemonEnv());
    const token = handle.token;
    const created = await api(handle.port, token, "/v1/bots", {
      method: "POST",
      body: { title: `eval ${study.id}` },
    });
    if (created.status !== 201) failure(`could not create a bot: ${created.status}`);
    botId = ((await created.json()) as { bot: { id: string } }).bot.id;

    // Triggers and workspace files exist before the bot opens, so its first store read sees them.
    if (study.triggers !== undefined || study.workspace !== undefined) {
      await handle.daemon.close();
      await handle.close();
      const botDir = join(root, "bots", botId);
      if (study.triggers !== undefined) {
        const lines = study.triggers.map((trigger, index) => {
          const id = `t_eval${String(index).padStart(6, "0")}`;
          return JSON.stringify({
            op: "create",
            opId: `op_${index}`,
            trigger: {
              id,
              botId,
              kind: trigger.kind,
              name: trigger.name,
              prompt: trigger.prompt,
              enabled: trigger.enabled !== false,
              createdAt: "2026-10-29T00:00:00.000Z",
              updatedAt: "2026-10-29T00:00:00.000Z",
              ...(trigger.kind === "schedule"
                ? {
                    schedule: {
                      cron: trigger.cron ?? "* * * * *",
                      timezone: trigger.timezone ?? "Asia/Shanghai",
                    },
                  }
                : {}),
              counters: { fired: 0, dropped: 0, refused: 0 },
            },
          });
        });
        await writeFile(join(botDir, "triggers.journal.jsonl"), `${lines.join("\n")}\n`, {
          mode: 0o600,
        });
      }
      for (const [path, body] of Object.entries(study.workspace ?? {})) {
        const target = join(botDir, "workspace", path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, body);
      }
      handle = await boot(root, daemonEnv());
    }

    const running = handle;
    const token2 = running.token;
    /** Fills `{{name.path}}` from a captured value, so a step can name what an earlier one made. */
    const fill = (text: string): string =>
      text.replace(/\{\{([a-z][\w-]*)((?:\.[\w-]+)*)\}\}/g, (_all, name: string, path: string) => {
        let value: unknown = captured.get(name);
        if (value === undefined) failure(`no captured value named ${name}`);
        for (const key of path.split(".").filter((part) => part.length > 0)) {
          value = (value as Record<string, unknown> | undefined)?.[key];
          if (value === undefined) failure(`captured ${name} has no ${path}`);
        }
        return typeof value === "string" ? value : JSON.stringify(value);
      });
    /** The CLI reads its own name from argv0, so each build gets its real link name. */
    const cliLink = async (bin: "dev" | "release"): Promise<string> => {
      const link = join(root, "bin", bin === "dev" ? "eagle-dev" : "eagle");
      await mkdir(dirname(link), { recursive: true });
      await symlink(options.cli as string, link).catch(() => undefined);
      return link;
    };
    const view = await viewer(running.port, token2, botId);
    await view.ready;
    type Detail = { id: string; name: string; token?: string };
    const byName = new Map<string, Detail>();
    /** A trigger may be created by the model mid-case, so the map refreshes on a miss. */
    const triggerNamed = async (name: string): Promise<Detail | undefined> => {
      const known = byName.get(name);
      if (known !== undefined) return known;
      const details = (await (
        await api(running.port, token2, `/v1/triggers?botId=${botId}`)
      ).json()) as { triggers: Detail[] };
      for (const trigger of details.triggers) byName.set(trigger.name, trigger);
      return byName.get(name);
    };

    let requestSeq = 0;
    for (const step of study.steps) {
      const left = budget - (Date.now() - started);
      const stepBudget =
        "timeoutMs" in step && step.timeoutMs !== undefined ? step.timeoutMs : left;
      if (stepBudget <= 0) failure(`case budget exhausted at a ${step.kind} step`);
      switch (step.kind) {
        case "chat": {
          requestSeq += 1;
          const requestId = `r_eval_${String(requestSeq).padStart(4, "0")}`;
          view.send(step.text, requestId);
          await waitUntil(
            () => view.settled(requestId) === "done" || view.settled(requestId) === "unanswered",
            `the chat run ${requestId} to settle`,
            stepBudget,
          );
          break;
        }
        case "webhook": {
          const trigger = await triggerNamed(step.trigger);
          if (trigger?.token === undefined) {
            failure(`no webhook trigger named ${step.trigger}`);
            break;
          }
          const response = await fetch(
            `http://127.0.0.1:${handle.port}/v1/triggers/${botId}/${trigger.id}`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${trigger.token}`,
                "content-type": "text/plain",
                ...(step.idempotencyKey === undefined
                  ? {}
                  : { "idempotency-key": step.idempotencyKey }),
              },
              body: step.body,
            },
          );
          const expected = step.expectStatus ?? 202;
          if (response.status !== expected) {
            failure(`delivery answered ${response.status}, expected ${expected}`);
          }
          break;
        }
        case "patch": {
          const trigger = await triggerNamed(step.trigger);
          if (trigger === undefined) {
            failure(`no trigger named ${step.trigger}`);
            break;
          }
          const response = await api(handle.port, token2, `/v1/triggers/${botId}/${trigger.id}`, {
            method: "PATCH",
            body: { enabled: step.enabled },
          });
          if (response.status !== 200) failure(`toggle answered ${response.status}`);
          break;
        }
        case "http": {
          const path = step.path
            .replace("<bot>", botId)
            .replace(/<trigger:([^>]+)>/g, (_all, name: string) => byName.get(name)?.id ?? "");
          // The owner's bearer by default: a case that tests a refusal states its own.
          const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
            method: step.method,
            headers: { authorization: `Bearer ${token2}`, ...(step.headers ?? {}) },
            ...(step.body === undefined ? {} : { body: step.body }),
          });
          if (step.expectStatus !== undefined && response.status !== step.expectStatus) {
            failure(`${step.method} ${path} answered ${response.status}`);
          }
          if (step.capture !== undefined) captured.set(step.capture, await response.json());
          break;
        }
        case "file": {
          const target = join(root, fill(step.path));
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, fill(step.content ?? ""));
          if (step.mode !== undefined) await chmod(target, Number.parseInt(step.mode, 8));
          break;
        }
        case "cli": {
          const bin = await cliLink(step.bin ?? "dev");
          const env: Record<string, string> = {
            PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
            // The CLI reads its files from HOME, so a case never touches the real ones.
            HOME: home,
            EAGLE_ROOT: root,
            EAGLE_PORT: String(running.port),
          };
          for (const [key, value] of Object.entries(step.env ?? {})) {
            if (value === null) delete env[key];
            else env[key] = fill(value);
          }
          const args = step.args.map(fill);
          const result = await runProcess(bin, args, env, stepBudget);
          const stdout = result.stdout;
          const stderr = result.stderr;
          const command = `${step.bin ?? "dev"} ${args.join(" ")}`;
          if (step.expectTimeout === true) {
            if (!result.timedOut) {
              failure(`${command} finished instead of running past its budget`);
            }
          } else if (result.status !== (step.expectExit ?? 0)) {
            failure(
              `${command} exited ${String(result.status)}: ${(stderr || stdout).trim().slice(0, 400)}`,
            );
          }
          if (step.stdoutContains !== undefined && !stdout.includes(fill(step.stdoutContains))) {
            failure(
              `${command} printed no ${JSON.stringify(step.stdoutContains)}: ${stdout}${stderr === "" ? "" : ` / stderr ${stderr}`}`,
            );
          }
          if (step.stdoutExcludes !== undefined && stdout.includes(fill(step.stdoutExcludes))) {
            failure(`${command} printed ${JSON.stringify(step.stdoutExcludes)}: ${stdout}`);
          }
          if (step.stderrContains !== undefined && !stderr.includes(fill(step.stderrContains))) {
            failure(`${command} said no ${JSON.stringify(step.stderrContains)}: ${stderr}`);
          }
          if (step.json !== undefined) {
            // Either form lets an expectation name an id an earlier step captured.
            const expected = JSON.parse(
              typeof step.json === "string" ? fill(step.json) : fill(JSON.stringify(step.json)),
            );
            assertSubset(lastJsonLine(stdout), expected, command);
          }
          for (const [path, length] of Object.entries(step.jsonLengths ?? {})) {
            const value = path
              .split(".")
              .reduce<unknown>(
                (node, key) => (node as Record<string, unknown> | undefined)?.[key],
                lastJsonLine(stdout),
              );
            if (!Array.isArray(value) || value.length !== length) {
              failure(
                `${command}: ${path} has ${Array.isArray(value) ? value.length : "no"} entries, expected ${length}`,
              );
            }
          }
          if (step.capture !== undefined) captured.set(step.capture, lastJsonLine(stdout));
          break;
        }
        case "waitSubmission":
          await waitUntil(
            () => view.statuses().includes(step.status),
            `a ${step.status} submission`,
            stepBudget,
          );
          break;
        case "chatBurst": {
          for (let sent = 0; sent < step.count; sent += 1) {
            requestSeq += 1;
            const requestId = `r_burst_${String(requestSeq).padStart(4, "0")}`;
            view.send(`${step.text} ${sent + 1}`, requestId);
            await waitUntil(
              () => {
                const status = view.settled(requestId);
                return status === "done" || status === "unanswered";
              },
              `burst message ${sent + 1} to settle`,
              stepBudget,
            );
          }
          break;
        }
        case "waitModelRequest":
          await waitUntil(
            () => model.arrivals() >= step.count,
            `${step.count} model request(s)`,
            stepBudget,
          );
          break;
        case "releaseModel":
          model.release(step.hold);
          break;
        case "waitFor":
          await waitUntil(
            () =>
              view.rows.filter(
                (row) =>
                  (step.role === undefined || row.role === step.role) &&
                  (step.origin === undefined || row.origin === step.origin) &&
                  (step.contains === undefined || row.text.includes(step.contains)),
              ).length >= step.count,
            `at least ${step.count} matching rows${view.closed() === undefined ? "" : ` (${view.closed()})`}`,
            stepBudget,
          );
          break;
        case "sleep":
          await wait(step.ms);
          break;
      }
    }

    const expect = study.expect ?? {};
    if (expect.modelRequests !== undefined && model.requests.length > expect.modelRequests.max) {
      failure(
        `${model.requests.length} model requests, expected at most ${expect.modelRequests.max}`,
      );
    }
    if (expect.messages !== undefined) {
      let cursor = 0;
      for (const wanted of expect.messages) {
        const found = view.rows.findIndex(
          (row, index) =>
            index >= cursor &&
            (wanted.role === undefined || row.role === wanted.role) &&
            (wanted.origin === undefined || row.origin === wanted.origin) &&
            (wanted.contains === undefined || row.text.includes(wanted.contains)),
        );
        if (found < 0) {
          failure(`no ${JSON.stringify(wanted)} after row ${cursor}: ${JSON.stringify(view.rows)}`);
        }
        cursor = found + 1;
      }
    }
    for (const unwanted of expect.messagesExcluded ?? []) {
      const found = view.rows.find(
        (row) =>
          (unwanted.role === undefined || row.role === unwanted.role) &&
          (unwanted.contains === undefined || row.text.includes(unwanted.contains)),
      );
      if (found !== undefined) {
        failure(`unexpected row ${JSON.stringify(found)}: ${JSON.stringify(view.rows)}`);
      }
    }
    for (const want of expect.atLeast ?? []) {
      const count = view.rows.filter(
        (row) =>
          (want.role === undefined || row.role === want.role) &&
          (want.origin === undefined || row.origin === want.origin),
      ).length;
      if (count < want.count) failure(`only ${count} rows for ${JSON.stringify(want)}`);
    }
    for (const tool of expect.toolsCalled ?? []) {
      if (!view.tools.includes(tool)) failure(`the model never called ${tool}`);
    }
    for (const [path, needle] of Object.entries(expect.files ?? {})) {
      const body = await readFile(join(root, "bots", botId, "workspace", path), "utf8").catch(
        () => "",
      );
      if (!body.includes(needle)) failure(`${path} does not contain ${JSON.stringify(needle)}`);
    }
    if (expect.noErrors === true && view.errors.length > 0) {
      failure(`unexpected error frames: ${view.errors.join("; ")}`);
    }
    if (options.verbose) {
      process.stdout.write(
        `${JSON.stringify({ id: study.id, rows: view.rows, tools: view.tools, modelRequests: model.requests }, null, 1)}\n`,
      );
    }
    view.close();
    return { id: study.id, ok: true, detail: `${view.rows.length} rows` };
  } catch (error) {
    return {
      id: study.id,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await handle?.close().catch(() => undefined);
    await new Promise<void>((resolve_) => model.server.close(() => resolve_()));
    if (!options.keep) await rm(root, { recursive: true, force: true });
    else process.stdout.write(`kept the eval root: ${root}\n`);
  }
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at < 0 ? undefined : argv[at + 1];
  };
  const verbose = argv.includes("--verbose");
  const keep = argv.includes("--keep");
  const repeatAt = argv.indexOf("--repeat");
  const repeat = repeatAt < 0 ? 1 : Number(argv[repeatAt + 1] ?? "1");
  const dir = resolve(option("--dir") ?? resolve(import.meta.dirname, "../../../tests/eval/cases"));
  const wanted = option("--case");
  const match = option("--match");
  const cli = option("--cli") ?? process.env.EAGLE_CLI_BIN;
  const cases = (await readdir(dir))
    .filter((name) => name.endsWith(".json"))
    .filter((name) => wanted === undefined || name === `${wanted}.json`)
    .filter((name) => match === undefined || name.startsWith(match))
    .sort();
  // A case that drives the CLI needs the built binary. Without one the plain run stays the
  // daemon's acceptance and says so; `eval:cli` builds the binary and runs those cases.
  const files = cases;
  if (files.length === 0) failure(`no eval cases in ${dir}`);
  let failed = 0;
  for (const file of files) {
    for (let round = 1; round <= repeat; round += 1) {
      const report = await runCase(join(dir, file), {
        verbose,
        keep,
        ...(cli === undefined ? {} : { cli }),
      });
      const label = repeat > 1 ? `${report.id} (${round}/${repeat})` : report.id;
      process.stdout.write(
        `${report.ok ? "ok  " : "FAIL"} ${label}${report.ok ? ` — ${report.detail}` : ` — ${report.detail}`}\n`,
      );
      if (!report.ok) {
        failed += 1;
        break;
      }
    }
  }
  process.exit(failed === 0 ? 0 : 1);
};

await main();
