// HTTP surface for the model gateway settings (docs/bots/PROTOCOL.md, "Gateway settings"):
// reading is redacted, writing validates, testing is separate, and none of it is reachable
// without the bearer token.
import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayApi, GatewayInput, PublicGateway } from "../../src/server/gateway.ts";
import { startStack } from "../support/server.ts";

test("the settings endpoints read, validate, save and test behind the bearer", async () => {
  let stored: PublicGateway = {
    configured: false,
    provider: "magpie",
    baseUrl: "",
    model: "",
    hasApiKey: false,
    thinkingLevel: "medium",
    toolGroups: ["core", "coding", "herdr"],
    corePrompt: "你是一个务实、友好的 agent。",
  };
  const saves: GatewayInput[] = [];
  const tests: GatewayInput[] = [];
  const settings: GatewayApi = {
    public: () => stored,
    save: async (input) => {
      saves.push(input);
      if (input.baseUrl === "http://bad") {
        return { settings: stored, error: "网关地址必须是 http(s) URL" };
      }
      if (input.baseUrl === undefined || input.model === undefined) {
        return { settings: stored, error: "网关地址和模型不能为空" };
      }
      stored = {
        configured: true,
        provider: input.provider ?? "magpie",
        baseUrl: input.baseUrl ?? "",
        model: input.model ?? "",
        hasApiKey: true,
        thinkingLevel: "medium",
        toolGroups: ["core", "coding", "herdr"],
        corePrompt: input.corePrompt ?? "你是一个务实、友好的 agent。",
      };
      return { settings: stored };
    },
    test: async (input) => {
      tests.push(input);
      return { ok: true, message: "连接成功", latencyMs: 3 };
    },
  };
  const stack = await startStack({ settings });
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${stack.port}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${stack.token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  try {
    const initial = await request("/v1/settings");
    assert.equal(initial.status, 200);
    assert.deepEqual(((await initial.json()) as { settings: PublicGateway }).settings, stored);

    assert.equal((await request("/v1/settings", { method: "PUT", body: "{}" })).status, 400);
    assert.equal(
      (
        await request("/v1/settings", {
          method: "PUT",
          body: JSON.stringify({ baseUrl: 5 }),
        })
      ).status,
      400,
    );
    const badUrl = await request("/v1/settings", {
      method: "PUT",
      body: JSON.stringify({ baseUrl: "http://bad", model: "m" }),
    });
    assert.equal(badUrl.status, 400);
    assert.match(JSON.stringify(await badUrl.json()), /http\(s\)/);

    const saved = await request("/v1/settings", {
      method: "PUT",
      body: JSON.stringify({
        baseUrl: "http://127.0.0.1:3425/v1",
        model: "auto/gpt-6-astra",
        apiKey: "sk-new",
      }),
    });
    assert.equal(saved.status, 200);
    const savedBody = (await saved.json()) as { settings: PublicGateway };
    assert.equal(savedBody.settings.configured, true);
    assert.equal(JSON.stringify(savedBody).includes("sk-new"), false);
    assert.deepEqual(saves.at(-1), {
      baseUrl: "http://127.0.0.1:3425/v1",
      model: "auto/gpt-6-astra",
      apiKey: "sk-new",
    });

    const probed = await request("/v1/settings/test", {
      method: "POST",
      body: JSON.stringify({ apiKey: "sk-other" }),
    });
    assert.equal(probed.status, 200);
    assert.deepEqual(((await probed.json()) as { result: unknown }).result, {
      ok: true,
      message: "连接成功",
      latencyMs: 3,
    });
    assert.deepEqual(tests.at(-1), { apiKey: "sk-other" });

    const unauthorized = await fetch(`http://127.0.0.1:${stack.port}/v1/settings`);
    assert.equal(unauthorized.status, 401);
  } finally {
    await stack.close();
  }
});

test("the core prompt is saved with the gateway, and the machine prompt is read-only", async () => {
  let stored: PublicGateway = {
    configured: true,
    provider: "magpie",
    baseUrl: "http://127.0.0.1:3425/v1",
    model: "auto/gpt-6-astra",
    hasApiKey: true,
    thinkingLevel: "medium",
    toolGroups: ["persona", "machine", "core", "coding"],
    corePrompt: "旧的人格",
  };
  const settings: GatewayApi = {
    public: () => stored,
    save: async (input) => {
      stored = { ...stored, corePrompt: input.corePrompt ?? stored.corePrompt };
      return { settings: stored };
    },
    test: async () => ({ ok: true, message: "ok", latencyMs: 1 }),
  };
  const machine = { path: "/Users/x/.agents/AGENTS.md", text: "机器说明" };
  const stack = await startStack({ settings, machinePrompt: () => machine });
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${stack.port}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${stack.token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  try {
    const initial = (await (await request("/v1/settings")).json()) as {
      settings: PublicGateway;
      machinePrompt: unknown;
    };
    assert.equal(initial.settings.corePrompt, "旧的人格");
    assert.deepEqual(initial.machinePrompt, machine);

    const saved = (await (
      await request("/v1/settings", {
        method: "PUT",
        body: JSON.stringify({ corePrompt: "  新的人格  " }),
      })
    ).json()) as { settings: PublicGateway; machinePrompt: unknown };
    assert.equal(saved.settings.corePrompt, "  新的人格  ");
    assert.deepEqual(saved.machinePrompt, machine);
  } finally {
    await stack.close();
  }
});

test("the settings read carries the tool catalogue, and says nothing when it has none", async () => {
  const settings: GatewayApi = {
    public: () => ({
      configured: true,
      provider: "magpie",
      baseUrl: "http://gw/v1",
      model: "m1",
      hasApiKey: true,
      thinkingLevel: "medium",
      toolGroups: ["core", "coding"],
      corePrompt: "",
    }),
    save: async () => ({ settings: settings.public() }),
    test: async () => ({ ok: true, message: "ok", latencyMs: 1 }),
  };
  const withCatalog = await startStack({
    settings,
    toolCatalog: () => [
      { group: "core", tools: [{ name: "list", description: "List a directory." }] },
    ],
  });
  try {
    const response = await fetch(`http://127.0.0.1:${withCatalog.port}/v1/settings`, {
      headers: { authorization: `Bearer ${withCatalog.token}` },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      tools?: readonly { group: string; tools: readonly { name: string }[] }[];
    };
    assert.deepEqual(body.tools, [
      { group: "core", tools: [{ name: "list", description: "List a directory." }] },
    ]);
  } finally {
    await withCatalog.close();
  }

  const without = await startStack({ settings });
  try {
    const response = await fetch(`http://127.0.0.1:${without.port}/v1/settings`, {
      headers: { authorization: `Bearer ${without.token}` },
    });
    const body = (await response.json()) as { tools?: unknown };
    assert.equal(body.tools, undefined, "an older daemon publishes no catalogue");
  } finally {
    await without.close();
  }
});
