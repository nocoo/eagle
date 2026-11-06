// The per-bot agent over HTTP (docs/bots/PROTOCOL.md, "Per-bot agent"): the pair a bot
// runs with, the defaults the settings name, and what the daemon refuses.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readConfig } from "../../src/config.ts";
import { startDaemon } from "../../src/main.ts";

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
