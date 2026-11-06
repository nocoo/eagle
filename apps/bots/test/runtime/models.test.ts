// The model registry (docs/bots/RUNTIME.md, "The model registry"): what the gateway
// offers, what the daemon will request from each model, and what happens when the gateway
// cannot be asked.
import assert from "node:assert/strict";
import test from "node:test";
import { ModelRegistry } from "../../src/runtime/pi/models.ts";

const gateway = (body: unknown, status: () => number = () => 200): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status: status(),
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

const registry = (options: { fetch?: typeof fetch } = {}) =>
  new ModelRegistry({
    provider: "magpie",
    baseUrl: "http://127.0.0.1:3425/v1",
    apiKey: "sk-registry-000000000000",
    contextWindow: 200_000,
    maxTokens: 8_192,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

test("the gateway's models are registered and described", async () => {
  const models = registry({
    fetch: gateway({ data: [{ id: "auto/gpt-6-luna" }, { id: "auto/gpt-6-sol" }] }),
  });
  const found = await models.discover();
  assert.equal(found.ok, true);
  assert.deepEqual([...models.ids()].sort(), ["auto/gpt-6-luna", "auto/gpt-6-sol"]);
  const details = models.metadata();
  const luna = details.find((entry) => entry.id === "auto/gpt-6-luna");
  assert.ok(luna !== undefined);
  assert.equal(luna.reasoning, true);
  assert.equal(
    luna.contextWindow,
    200_000,
    "the window is the daemon's declared cap, not a claim about the model",
  );
  assert.equal(luna.maxTokens, 8_192);
  assert.deepEqual(
    [...luna.thinkingLevels],
    ALL_LEVELS,
    "every level is requested, `xhigh` and `max` included",
  );
});

test("a failed discovery is not an empty list and keeps what the daemon knows", async () => {
  let answer = 200;
  const models = registry({
    fetch: gateway({ data: [{ id: "auto/gpt-6-luna" }] }, () => answer),
  });
  assert.equal((await models.discover()).ok, true);
  answer = 500;
  const failed = await models.discover();
  assert.equal(failed.ok, false);
  assert.ok(models.discoveryError !== undefined, "the failure is reported");
  assert.deepEqual(
    [...models.ids()],
    ["auto/gpt-6-luna"],
    "the models the daemon knew stay usable",
  );
});

test("a gateway that offers no model is an empty list, not a failure", async () => {
  const models = registry({ fetch: gateway({ data: [] }) });
  const found = await models.discover();
  assert.equal(found.ok, true);
  assert.equal(models.discoveryError, undefined);
  assert.deepEqual([...models.ids()], []);
});

test("a model a bot stores stays usable when the gateway does not list it", async () => {
  const models = registry({ fetch: gateway({ data: [{ id: "auto/gpt-6-luna" }] }) });
  await models.discover();
  models.ensure(["house/kept"]);
  assert.ok(models.models.getModel("magpie", "house/kept") !== undefined);
  const support = models.support({ provider: "magpie", modelId: "house/kept" });
  assert.equal(support.known, true);
  assert.deepEqual([...support.levels], ALL_LEVELS);
});

test("without an endpoint or a key the registry holds no model at all", async () => {
  const models = new ModelRegistry({
    provider: "magpie",
    baseUrl: "",
    apiKey: "",
    contextWindow: 200_000,
    maxTokens: 8_192,
  });
  models.ensure(["auto/gpt-6-luna"]);
  assert.deepEqual([...models.ids()], []);
  assert.equal(models.models.getModel("magpie", "auto/gpt-6-luna"), undefined);
});

test("a new endpoint and key under one provider never resurrect the old address", async () => {
  let reachable = true;
  const bodies: { authorization?: string }[] = [];
  const recorded: typeof fetch = (async (_url: string, init?: RequestInit) => {
    const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
    bodies.push(authorization === undefined ? {} : { authorization });
    if (!reachable) return new Response("no", { status: 500 });
    return new Response(JSON.stringify({ data: [{ id: "auto/a" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const models = new ModelRegistry({
    provider: "magpie",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "sk-a",
    contextWindow: 200_000,
    maxTokens: 8_192,
    fetch: recorded,
  });
  assert.equal((await models.discover()).ok, true);
  assert.equal(models.models.getModel("magpie", "auto/a")?.baseUrl, "http://127.0.0.1:1/v1");

  // The person moves the gateway to another address and key under the same provider id,
  // and the new gateway cannot be asked for its list.
  reachable = false;
  models.reconfigure({
    provider: "magpie",
    baseUrl: "http://127.0.0.1:2/v1",
    apiKey: "sk-b",
    contextWindow: 200_000,
    maxTokens: 8_192,
    fetch: recorded,
  });
  assert.equal((await models.discover()).ok, false);
  const model = models.models.getModel("magpie", "auto/a");
  assert.ok(model !== undefined, "the model the daemon knew stays usable");
  assert.equal(model.baseUrl, "http://127.0.0.1:2/v1", "it resolves the new address");
  assert.equal((await models.models.getAuth(model))?.auth.apiKey, "sk-b", "and the new key");
  assert.equal(bodies.at(-1)?.authorization, "Bearer sk-b", "the discovery asked with it too");
});

test("a provider id that moves is removed from the collection", async () => {
  const models = new ModelRegistry({
    provider: "old",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "sk-old",
    contextWindow: 200_000,
    maxTokens: 8_192,
    fetch: gateway({ data: [{ id: "auto/a" }] }),
  });
  models.ensure(["auto/a"]);
  assert.ok(models.models.getModel("old", "auto/a") !== undefined);
  models.reconfigure({
    provider: "new",
    baseUrl: "http://127.0.0.1:2/v1",
    apiKey: "sk-new",
    contextWindow: 200_000,
    maxTokens: 8_192,
  });
  assert.equal(models.models.getProvider("old"), undefined, "the old provider is gone");
  assert.equal(
    models.models.getModel("new", "auto/a")?.baseUrl,
    "http://127.0.0.1:2/v1",
    "the model moved with it",
  );
});
