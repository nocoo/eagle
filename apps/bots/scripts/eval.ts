// Acceptance runner for the cases under tests/eval/cases (format: tests/eval/README.md).
// It boots a real daemon on a temporary root, serves the case's model replies from a local
// Responses endpoint, drives the case's steps over HTTP and a WebSocket, and checks the
// transcript. Not part of `npm run check`: a case boots a process and runs real tools.

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { WebSocket } from "ws";
import { readConfig } from "../src/config.ts";
import { type DaemonHandle, startDaemon } from "../src/main.ts";
import {
  type HistoryBundle,
  hash,
  resourceSchema,
  validateBundle,
} from "../src/runtime/pi/HistoryReplica.ts";
import {
  pageSchema,
  type ResourceCarrier,
  validateResourceCarrier,
} from "../src/runtime/pi/syncProtocol.ts";

type ScriptedReply =
  | { readonly text: string }
  | {
      readonly toolCall: { readonly name: string; readonly args: Record<string, unknown> };
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
  readonly steps: readonly Step[];
  readonly expect?: {
    readonly messages?: readonly {
      readonly role?: string;
      readonly origin?: string;
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
  | { readonly kind: "replicaSync"; readonly text: string; readonly contains: string }
  | {
      readonly kind: "replicaRun";
      readonly text: string;
      readonly contains: string;
      readonly resources?: true;
      readonly root?: true;
      readonly fresh?: true;
    }
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

const failure = (message: string): never => {
  throw new Error(message);
};

/** A local OpenAI Responses endpoint: streams the case's replies, in order. */
const scriptedModel = (script: readonly ScriptedReply[], repeatLast: boolean) => {
  const requests: {
    readonly lastInput: string;
    readonly tools: number;
    readonly resourceVersion: string | undefined;
    readonly completeSkill: boolean;
  }[] = [];
  let index = 0;
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
      const inputText = JSON.stringify(body.input);
      requests.push({
        lastInput: JSON.stringify(body.input?.at(-1) ?? null).slice(0, 2_000),
        tools: body.tools?.length ?? 0,
        resourceVersion: /Resource version: ([a-f0-9]{64})/.exec(inputText)?.[1],
        completeSkill:
          inputText.includes("resource-version-one instructions") &&
          inputText.includes("Skill directory:") &&
          inputText.includes("scripts/nested/run.sh"),
      });
      const reply = index < script.length ? script[index] : repeatLast ? script.at(-1) : undefined;
      index += 1;
      if (reply === undefined) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "eval script exhausted" } }));
        return;
      }
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
    });
  });
  return { server, requests };
};

const listen = (server: ReturnType<typeof createServer>): Promise<number> =>
  new Promise((resolve_) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve_(typeof address === "object" && address !== null ? address.port : 0);
    });
  });

/** `--port 0` asks the kernel for a free port, so cases never collide with a real daemon. */
const boot = async (root: string): Promise<DaemonHandle> =>
  startDaemon(readConfig({ argv: ["--root", root, "--port", "0"], env: {} }));

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
    send: (text: string, requestId: string, resourceHead?: string): void => {
      socket.send(
        JSON.stringify({
          type: "send",
          requestId,
          text,
          ...(resourceHead === undefined ? {} : { resourceHead }),
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
  check: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs: number,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await wait(50);
  }
  failure(`${message} within ${timeoutMs} ms`);
};

type Report = { readonly id: string; readonly ok: boolean; readonly detail: string };

const runCase = async (
  file: string,
  options: { readonly verbose: boolean; readonly keep: boolean },
): Promise<Report> => {
  const study = JSON.parse(await readFile(file, "utf8")) as CaseFile;
  const budget = study.timeoutMs ?? 120_000;
  const started = Date.now();
  const root = await mkdtemp(join(tmpdir(), `bots-eval-${study.id}-`));
  const model = scriptedModel(study.model.script, study.model.repeatLast === true);
  const modelPort = await listen(model.server);
  let handle: DaemonHandle | undefined;
  let botId = "";
  try {
    await mkdir(root, { recursive: true });
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

    handle = await boot(root);
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
      handle = await boot(root);
    }

    const running = handle;
    const token2 = running.token;
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
        case "replicaSync": {
          const call = async (target: string, method: string, body: unknown) => {
            const response = await api(
              running.port,
              token2,
              `/v1/bots/${target}/replica/${method}`,
              { method: "POST", body },
            );
            if (response.status !== 200)
              failure(`incremental ${method} answered ${response.status}`);
            return response.json();
          };
          const created = await api(running.port, token2, "/v1/bots", {
            method: "POST",
            body: { title: "incremental passive peer" },
          });
          if (created.status !== 201) failure("could not create incremental peer");
          const target = ((await created.json()) as { bot: { id: string } }).bot.id;
          const binding = (await call(botId, "status", {})) as { sharedBotId: string };
          await call(target, "bind", { sharedBotId: binding.sharedBotId });
          const before = model.requests.length;
          let after = 0;
          let head = "";
          let hasMore = true;
          do {
            const page = pageSchema.parse(await call(botId, "pull", { after, limit: 128 }));
            await call(target, "apply", { page });
            await call(target, "apply", { page });
            for (const event of page.events) if (event.body.kind === "head") head = event.body.head;
            after = page.nextAfter;
            hasMore = page.hasMore;
          } while (hasMore);
          if (model.requests.length !== before || head.length !== 64)
            failure("incremental receive executed or failed to materialize");
          const requestId = `incremental_eval_${++requestSeq}`;
          const params = { head, requestId, text: step.text };
          await call(target, "run", params);
          await waitUntil(
            async () =>
              ((await call(target, "status", { requestId })) as { submission?: { status: string } })
                .submission?.status === "done",
            "incremental local run",
            stepBudget,
          );
          await call(target, "run", params);
          if (model.requests.length !== before + 1) failure("incremental run did not execute once");
          const output = pageSchema.parse(await call(target, "pull", { after: 0, limit: 128 }));
          if (
            !output.events.some(
              (event) =>
                event.body.kind === "entry" &&
                event.body.content.kind === "pi.assistant" &&
                JSON.stringify(event.body.content.model).includes(step.contains),
            )
          )
            failure("incremental output not in durable outbox");
          const empty = pageSchema.parse(await call(botId, "pull", { after, limit: 128 }));
          if (empty.events.length !== 0) failure("old source history was published again");
          break;
        }
        case "replicaRun": {
          const path = `/v1/bots/${botId}/replica`;
          const call = async (method: string, body: unknown) => {
            const response = await api(running.port, token2, `${path}/${method}`, {
              method: "POST",
              body,
            });
            if (response.status !== 200) failure(`replica ${method} answered ${response.status}`);
            return response.json();
          };
          let bundle: HistoryBundle | ResourceCarrier;
          if (step.fresh === true) {
            if (step.root !== true || step.resources !== true)
              failure("fresh resources require ordinary root selection");
            if (view.rows.length !== 0 || model.requests.length !== 0)
              failure("fresh resource fixture already has chat history or provider work");
            const status = (await call("status", {})) as { sharedBotId: string; heads: unknown[] };
            if (status.heads.length !== 0) failure("fresh root already has history heads");
            await call("bind", { sharedBotId: status.sharedBotId });
            const resources = resourceSchema
              .array()
              .parse(
                JSON.parse(
                  await readFile(
                    new URL("../../../fixtures/bots-sync/resources.v1.json", import.meta.url),
                    "utf8",
                  ),
                ),
              );
            for (const resource of resources) {
              const path = join(root, "bots", botId, "workspace", resource.name);
              await mkdir(dirname(path), { recursive: true });
              await writeFile(path, Buffer.from(resource.base64, "base64"));
              if (!(await readFile(path)).equals(Buffer.from(resource.base64, "base64")))
                failure("fresh original file bytes changed");
            }
            bundle = validateResourceCarrier(
              await call("export", { kind: "resources", resources }),
            );
          } else {
            const original = validateBundle(
              JSON.parse(
                await readFile(
                  new URL("../../../fixtures/bots-sync/history.v1.json", import.meta.url),
                  "utf8",
                ),
              ),
            );
            const { head: _sourceHead, ...payload } = original;
            const localPayload = {
              ...payload,
              agent: { ...payload.agent, model: { provider: "magpie", modelId: "eval-model" } },
              ...(step.resources === true
                ? {
                    resources: resourceSchema
                      .array()
                      .parse(
                        JSON.parse(
                          await readFile(
                            new URL(
                              "../../../fixtures/bots-sync/resources.v1.json",
                              import.meta.url,
                            ),
                            "utf8",
                          ),
                        ),
                      ),
                  }
                : {}),
            };
            bundle = { ...localPayload, head: hash(localPayload) };
          }
          const before = model.requests.length;
          await call("import", { bundle });
          await call("import", { bundle });
          const inventory = (await call("receipts", { after: 0, limit: 128 })) as {
            items: { id: number; head: string }[];
          };
          if (
            step.fresh === true
              ? inventory.items.length !== 0
              : !inventory.items.some(
                  (item) => item.head === bundle.head && Number.isSafeInteger(item.id),
                )
          )
            failure("saved full carrier missing from recovery inventory");
          if (model.requests.length !== before)
            failure("passive import/inventory executed a model");
          const requestId = `replica_eval_${++requestSeq}`;
          const params = { head: bundle.head, requestId, text: step.text };
          const run = () =>
            step.root === true ? view.send(step.text, requestId, bundle.head) : call("run", params);
          await run();
          await waitUntil(
            async () => {
              if (step.root === true) return view.settled(requestId) === "done";
              const status = (await call("status", { requestId })) as {
                submission: { status: string } | null;
              };
              return status.submission?.status === "done";
            },
            "the local replica run to settle",
            stepBudget,
          );
          if (step.root !== true) await call("run", params);
          if (model.requests.length !== before + 1)
            failure("local replica run did not execute exactly once");
          if (step.resources === true) {
            const request = model.requests[before];
            if (request?.resourceVersion !== hash(bundle.resources) || !request.completeSkill)
              failure(
                "the provider did not receive the selected AGENTS and complete skill binding",
              );
          }
          const result = (await call(
            "export",
            step.root === true ? {} : { branch: requestId },
          )) as HistoryBundle;
          if (
            !result.entries.some(
              (entry) =>
                entry.kind === "pi.assistant" &&
                JSON.stringify(entry.model).includes(step.contains),
            )
          )
            failure("replica output was not durably exportable");
          break;
        }
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
          const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
            method: step.method,
            headers: step.headers ?? {},
            ...(step.body === undefined ? {} : { body: step.body }),
          });
          if (step.expectStatus !== undefined && response.status !== step.expectStatus) {
            failure(`${step.method} ${path} answered ${response.status}`);
          }
          break;
        }
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
  const files = (await readdir(dir))
    .filter((name) => name.endsWith(".json"))
    .filter((name) => wanted === undefined || name === `${wanted}.json`)
    .sort();
  if (files.length === 0) failure(`no eval cases in ${dir}`);
  let failed = 0;
  for (const file of files) {
    for (let round = 1; round <= repeat; round += 1) {
      const report = await runCase(join(dir, file), { verbose, keep });
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
