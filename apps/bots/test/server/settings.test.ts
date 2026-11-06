// HTTP surface for the model gateway settings (docs/bots/PROTOCOL.md, "Gateway settings"):
// reading is redacted, writing validates, testing is separate, and none of it is reachable
// without the bearer token.
import assert from "node:assert/strict";
import test from "node:test";
import type {
  GatewayApi,
  GatewayConfig,
  GatewayInput,
  PublicGateway,
} from "../../src/server/gateway.ts";
import { createSettingsSaver } from "../../src/server/settings.ts";
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
    skills: [],
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
        skills: input.skills ?? [],
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
    skills: [],
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
      skills: [],
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

test("the skills selection is validated on the wire and crosses it additively", async () => {
  let stored: PublicGateway = {
    configured: true,
    provider: "magpie",
    baseUrl: "http://127.0.0.1:3425/v1",
    model: "auto/gpt-6-astra",
    hasApiKey: true,
    thinkingLevel: "medium",
    toolGroups: ["persona", "machine", "core", "coding"],
    corePrompt: "只说结论。",
    skills: [],
  };
  const saves: GatewayInput[] = [];
  const settings: GatewayApi = {
    public: () => stored,
    save: async (input) => {
      saves.push(input);
      if (input.skills !== undefined) stored = { ...stored, skills: input.skills };
      return { settings: stored };
    },
    test: async () => ({ ok: true, message: "ok", latencyMs: 1 }),
  };
  const stack = await startStack({ settings });
  const put = (body: unknown) =>
    fetch(`http://127.0.0.1:${stack.port}/v1/settings`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${stack.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    const skill = {
      name: "humanizer-zh",
      version: "1.0.0",
      description: "去除文本里的 AI 痕迹。",
      path: "~/.agents/skills/humanizer-zh",
    };

    const absent = await put({ corePrompt: "只说结论。" });
    assert.equal(absent.status, 200);
    assert.equal(saves.at(-1)?.skills, undefined, "an absent field keeps what is stored");

    const saved = await put({ skills: [skill] });
    assert.equal(saved.status, 200);
    const body = (await saved.json()) as { settings: PublicGateway };
    assert.deepEqual(body.settings.skills, [skill]);
    assert.deepEqual(saves.at(-1)?.skills, [skill]);

    const read = (await (
      await fetch(`http://127.0.0.1:${stack.port}/v1/settings`, {
        headers: { authorization: `Bearer ${stack.token}` },
      })
    ).json()) as { settings: PublicGateway };
    assert.deepEqual(read.settings.skills, [skill], "GET reports the same shape");

    const cleared = await put({ skills: [] });
    assert.equal(cleared.status, 200);
    assert.deepEqual(((await cleared.json()) as { settings: PublicGateway }).settings.skills, []);

    for (const malformed of [[{ name: "alpha" }], [null], "alpha", [{ name: 5 }]]) {
      const refused = await put({ skills: malformed });
      assert.equal(refused.status, 400, `${JSON.stringify(malformed)} is refused`);
      const error = (await refused.json()) as { error: { kind: string; message: string } };
      assert.equal(error.error.kind, "invalid_command");
      assert.match(error.error.message, /skill/i);
    }
  } finally {
    await stack.close();
  }
});

test("two saves that overlap keep both fields: the second reads what the first stored", async () => {
  let stored: GatewayConfig | undefined;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const applied: (readonly string[])[] = [];
  const save = createSettingsSaver({
    current: () => stored,
    write: async (config) => {
      await gate;
      stored = config;
    },
    apply: async (_config, carried) => {
      applied.push([
        ...(carried.model ? ["model"] : []),
        ...(carried.thinkingLevel ? ["level"] : []),
        ...(carried.toolGroups ? ["groups"] : []),
      ]);
    },
  });
  const first = save({ corePrompt: "第一条人格" });
  const second = save({
    skills: [
      { name: "alpha", version: "1.0.0", description: "Runs alpha.", path: "/skills/alpha" },
    ],
  });
  release();
  const answers = await Promise.all([first, second]);
  assert.equal(answers[0]?.error, undefined);
  assert.equal(answers[1]?.error, undefined);
  assert.equal(stored?.corePrompt, "第一条人格", "the first save's field survived");
  assert.equal(stored?.skills.length, 1, "the second save's field survived");
  assert.deepEqual(applied, [[], []], "neither save named a field to apply");
});

test("a save applies only the fields it carries", async () => {
  let stored: GatewayConfig | undefined;
  const applied: (readonly string[])[] = [];
  const save = createSettingsSaver({
    current: () => stored,
    write: async (config) => {
      stored = config;
    },
    apply: async (_config, carried) => {
      applied.push([
        ...(carried.model ? ["model"] : []),
        ...(carried.thinkingLevel ? ["level"] : []),
        ...(carried.toolGroups ? ["groups"] : []),
      ]);
    },
  });
  await save({
    baseUrl: "http://127.0.0.1:3425/v1",
    model: "auto/gpt-6-astra",
    apiKey: "sk-x",
    thinkingLevel: "high",
    toolGroups: ["core", "herdr"],
  });
  await save({
    skills: [
      { name: "alpha", version: "1.0.0", description: "Runs alpha.", path: "/skills/alpha" },
    ],
  });
  assert.deepEqual(applied[0], ["model", "level", "groups"]);
  assert.deepEqual(applied[1], [], "a skills-only save applies nothing");
  assert.equal(stored?.thinkingLevel, "high", "the stored level is untouched");
  assert.deepEqual(
    stored?.toolGroups,
    ["core", "coding", "herdr"],
    "the stored groups are untouched",
  );
  assert.equal(stored?.model, "auto/gpt-6-astra", "the stored model is untouched");
});
