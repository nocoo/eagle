// The per-bot agent over HTTP (docs/bots/PROTOCOL.md, "Per-bot agent"): the pair a bot
// runs with, the defaults the settings name, and what the daemon refuses.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { readConfig } from "../../src/config.ts";
import { startDaemon } from "../../src/main.ts";
import { frameQueue, hello, send } from "../support/server.ts";

const gateway = {
  baseUrl: "http://127.0.0.1:9/v1",
  model: "auto/gpt-6-luna",
  apiKey: "sk-agent-http-00000000000",
};

const daemonRoot = async (prefix: string): Promise<string> => mkdtemp(join(tmpdir(), prefix));

test("the pair a bot records is the pair it was asked for", async () => {
  const root = await daemonRoot("bots-agent-refuse-");
  try {
    const config = readConfig({ argv: ["--root", root, "--port", "0"], env: {} });
    const daemon = await startDaemon(config);
    const authorized = (path: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${daemon.port}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${daemon.token}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      });
    try {
      assert.equal(
        (
          await authorized("/v1/settings", {
            method: "PUT",
            body: JSON.stringify(gateway),
          })
        ).status,
        200,
      );
      const created = await authorized("/v1/bots", {
        method: "POST",
        body: JSON.stringify({ title: "等级" }),
      });
      const botId = ((await created.json()) as { bot: { id: string } }).bot.id;

      const refused = await authorized(`/v1/bots/${botId}`, {
        method: "PATCH",
        body: JSON.stringify({ thinkingLevel: "loud" }),
      });
      assert.equal(refused.status, 400, "a level outside the seven is refused");
      const catalog = JSON.parse(await readFile(join(root, "catalog.json"), "utf8")) as {
        bots: { id: string; thinkingLevel?: string }[];
      };
      assert.equal(
        catalog.bots.find((bot) => bot.id === botId)?.thinkingLevel,
        "medium",
        "the refused change wrote nothing",
      );

      const accepted = await authorized(`/v1/bots/${botId}`, {
        method: "PATCH",
        body: JSON.stringify({ model: "auto/gpt-6-sol", thinkingLevel: "xhigh" }),
      });
      assert.equal(accepted.status, 200, "the model takes this level");
      const shown = (await accepted.json()) as { bot: { model: { modelId: string } } };
      assert.equal(shown.bot.model.modelId, "auto/gpt-6-sol");
    } finally {
      await daemon.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the settings name the default for a new bot and leave an existing one alone", async () => {
  const root = await daemonRoot("bots-agent-default-");
  try {
    const config = readConfig({ argv: ["--root", root, "--port", "0"], env: {} });
    const daemon = await startDaemon(config);
    const authorized = (path: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${daemon.port}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${daemon.token}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      });
    try {
      assert.equal(
        (
          await authorized("/v1/settings", {
            method: "PUT",
            body: JSON.stringify({ ...gateway, thinkingLevel: "low" }),
          })
        ).status,
        200,
      );
      const created = await authorized("/v1/bots", {
        method: "POST",
        body: JSON.stringify({ title: "第一个" }),
      });
      const botId = ((await created.json()) as { bot: { id: string } }).bot.id;

      assert.equal(
        (
          await authorized("/v1/settings", {
            method: "PUT",
            body: JSON.stringify({ ...gateway, model: "auto/gpt-6-sol", thinkingLevel: "high" }),
          })
        ).status,
        200,
      );
      const catalog = JSON.parse(await readFile(join(root, "catalog.json"), "utf8")) as {
        bots: { id: string; thinkingLevel?: string; model: { modelId: string } }[];
      };
      const bot = catalog.bots.find((entry) => entry.id === botId);
      assert.equal(bot?.model.modelId, "auto/gpt-6-luna", "the bot keeps its own model");
      assert.equal(bot?.thinkingLevel, "low", "the bot keeps its own level");

      const another = await authorized("/v1/bots", {
        method: "POST",
        body: JSON.stringify({ title: "第二个" }),
      });
      const otherId = ((await another.json()) as { bot: { id: string } }).bot.id;
      const after = JSON.parse(await readFile(join(root, "catalog.json"), "utf8")) as {
        bots: { id: string; thinkingLevel?: string; model: { modelId: string } }[];
      };
      const fresh = after.bots.find((entry) => entry.id === otherId);
      assert.equal(fresh?.model.modelId, "auto/gpt-6-sol", "a new bot records the default model");
      assert.equal(fresh?.thinkingLevel, "high", "a new bot records the default level");
    } finally {
      await daemon.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the model list names the ids and what the daemon knows about them", async () => {
  const root = await daemonRoot("bots-agent-models-");
  try {
    const config = readConfig({ argv: ["--root", root, "--port", "0"], env: {} });
    const daemon = await startDaemon(config);
    try {
      assert.equal(
        (
          await fetch(`http://127.0.0.1:${daemon.port}/v1/settings`, {
            method: "PUT",
            headers: {
              authorization: `Bearer ${daemon.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(gateway),
          })
        ).status,
        200,
      );
      const response = await fetch(`http://127.0.0.1:${daemon.port}/v1/models`, {
        headers: { authorization: `Bearer ${daemon.token}` },
      });
      const body = (await response.json()) as {
        models: string[];
        modelDetails: { id: string; thinkingLevels: string[] }[];
        discoveryError?: string;
      };
      assert.deepEqual(body.models, ["auto/gpt-6-luna"], "the ids stay strings");
      const detail = body.modelDetails.find((entry) => entry.id === "auto/gpt-6-luna");
      assert.ok(detail !== undefined, "the daemon describes the model it knows");
      assert.deepEqual(
        [...detail.thinkingLevels],
        ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
        "every level is requested; the gateway decides what it takes",
      );
      assert.equal(
        body.discoveryError,
        "the gateway could not be asked for its models",
        "a gateway that cannot be reached is reported apart from an empty list",
      );
    } finally {
      await daemon.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const frame = (type: string, body: unknown): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...(body as object) })}\n\n`;

/** A Responses endpoint that records what it was asked and answers one sentence. */
const modelServer = async () => {
  const seen: { authorization?: string; model?: string }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST") {
        response.writeHead(404).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
        model?: string;
      };
      const authorization = request.headers.authorization;
      seen.push({
        ...(authorization === undefined ? {} : { authorization }),
        ...(body.model === undefined ? {} : { model: body.model }),
      });
      const id = `resp_${seen.length}`;
      const output = {
        type: "message",
        id: `msg_${id}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "巴黎是法国的首都。", annotations: [] }],
      };
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write(
        frame("response.created", { response: { id, status: "in_progress" } }) +
          frame("response.output_item.added", {
            output_index: 0,
            item: { type: "message", id: `msg_${id}`, role: "assistant", content: [] },
          }) +
          frame("response.output_text.done", {
            output_index: 0,
            item_id: `msg_${id}`,
            text: "巴黎是法国的首都。",
          }) +
          frame("response.output_item.done", { output_index: 0, item: output }) +
          frame("response.completed", {
            response: {
              id,
              status: "completed",
              output: [output],
              usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
            },
          }),
      );
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
};

test("a stored provider that differs from the gateway reaches the gateway's endpoint", async () => {
  const first = await modelServer();
  const second = await modelServer();
  const root = await daemonRoot("bots-agent-provider-");
  try {
    // A catalog written under another provider id, as a gateway change leaves behind.
    await writeFile(
      join(root, "catalog.json"),
      `${JSON.stringify(
        {
          version: 1,
          groups: [],
          bots: [
            {
              id: "b_legacy",
              title: "legacy",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              model: { provider: "stale", modelId: "auto/a" },
              thinkingLevel: "medium",
            },
          ],
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(root, "gateway.json"),
      `${JSON.stringify(
        {
          provider: "magpie",
          baseUrl: first.baseUrl,
          model: "auto/a",
          apiKey: "sk-first-0000000000000000",
          thinkingLevel: "medium",
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    const config = readConfig({ argv: ["--root", root, "--port", "0"], env: {} });
    const daemon = await startDaemon(config);
    try {
      const turn = async (requestId: string, text: string): Promise<void> => {
        const socket = new WebSocket(`ws://127.0.0.1:${daemon.port}/v1/socket`, {
          headers: { authorization: `Bearer ${daemon.token}` },
        });
        const frames = frameQueue(socket);
        await send(socket, hello);
        await frames.next();
        await send(socket, { type: "subscribe", botId: "b_legacy", trace: `tr_${requestId}` });
        await frames.next();
        await send(socket, {
          type: "send",
          requestId,
          text,
          whenBusy: "followUp",
          trace: `tr_${requestId}`,
        });
        const seen: Record<string, unknown>[] = [];
        for (;;) {
          const frame_ = await frames.next(20_000).catch(() => {
            throw new Error(`no settlement for ${requestId}: ${JSON.stringify(seen)}`);
          });
          seen.push(frame_);
          if (
            frame_.type === "submission" &&
            frame_.requestId === requestId &&
            (frame_.status === "done" || frame_.status === "unanswered")
          ) {
            assert.equal(
              frame_.status,
              "done",
              `the run was answered, not refused: ${JSON.stringify(frame_)}`,
            );
            break;
          }
        }
        socket.close();
      };
      await turn("r_0190a1b4-5061-7c72-8d3e-4f5061728394", "第一个问题");
      assert.equal(first.seen.at(-1)?.authorization, "Bearer sk-first-0000000000000000");
      assert.equal(first.seen.at(-1)?.model, "auto/a");

      // The person moves the gateway: another provider id, address and key.
      const saved = await fetch(`http://127.0.0.1:${daemon.port}/v1/settings`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${daemon.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider: "next",
          baseUrl: second.baseUrl,
          model: "auto/a",
          apiKey: "sk-second-000000000000000",
        }),
      });
      assert.equal(saved.status, 200);
      await turn("r_0190a1b4-5061-7c72-8d3e-4f5061728395", "第二个问题");
      assert.equal(second.seen.at(-1)?.authorization, "Bearer sk-second-000000000000000");
      assert.equal(second.seen.at(-1)?.model, "auto/a", "the bot keeps its own model");
      const catalog = JSON.parse(await readFile(join(root, "catalog.json"), "utf8")) as {
        bots: { model: { provider: string } }[];
      };
      assert.equal(catalog.bots[0]?.model.provider, "next");
    } finally {
      await daemon.close();
    }
  } finally {
    await first.close();
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});
