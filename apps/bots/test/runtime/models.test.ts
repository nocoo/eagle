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
