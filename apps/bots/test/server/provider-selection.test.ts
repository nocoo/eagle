import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProviderService } from "../../src/main.ts";
import { readProviders, writeProviders } from "../../src/server/providers.ts";

test("keys save independently; selection is exclusive, durable and never implicit", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-provider-selection-"));
  const path = join(root, "providers.json");
  try {
    const service = await createProviderService({ path });
    assert.ok((await service.save("tavily-search", { enabled: true })).error);
    await Promise.all([
      service.save("deepseek-search", { apiKey: "ds-fixture" }),
      service.save("tavily-search", { apiKey: "tvly-fixture" }),
    ]);
    assert.deepEqual(
      service
        .public()
        .filter((p) => p.service === "search")
        .map((p) => [p.hasApiKey, p.enabled]),
      [
        [true, false],
        [true, false],
      ],
    );
    await service.save("deepseek-search", { enabled: true });
    await service.save("tavily-search", { apiKey: "tvly-updated" });
    assert.equal(service.public().find((p) => p.enabled)?.id, "deepseek-search");
    await service.save("tavily-search", { enabled: true });
    assert.deepEqual(
      service
        .public()
        .filter((p) => p.service === "search")
        .map((p) => p.enabled),
      [false, true],
    );
    assert.equal((await readProviders(path))["deepseek-search"]?.apiKey, "ds-fixture");
    const reopened = await createProviderService({ path });
    assert.deepEqual(reopened.public(), service.public());
    await service.save("tavily-search", { enabled: false });
    assert.equal(
      service.public().some((p) => p.enabled),
      false,
    );
    assert.ok((await service.save("unknown", { apiKey: "x" })).error);
    assert.ok((await service.save("deepseek-search", { apiKey: " " })).error);
    assert.doesNotMatch(JSON.stringify(service.public()), /fixture|updated/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the same routing client follows saved selection and key changes with no fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-provider-route-"));
  const requests: string[] = [];
  let refuse = false;
  try {
    const service = await createProviderService({
      path: join(root, "providers.json"),
      fetch: async (url, init) => {
        requests.push(
          `${new URL(String(url)).host}:${new Headers(init?.headers).get("authorization")}`,
        );
        if (refuse) return new Response("upstream secret", { status: 401 });
        return Response.json({ results: [] });
      },
    });
    const client = service.client;
    await assert.rejects(client.search({ query: "x" }), /选择.*搜索/);
    assert.deepEqual(requests, []);
    await service.save("deepseek-search", { apiKey: "ds-1", enabled: true });
    await client.search({ query: "x" });
    await service.save("tavily-search", { apiKey: "tvly-1", enabled: true });
    await client.search({ query: "x" });
    await service.save("tavily-search", { apiKey: "tvly-2" });
    await client.search({ query: "x" });
    refuse = true;
    await assert.rejects(client.search({ query: "x" }), /refused the API key/);
    assert.deepEqual(requests, [
      "api.deepseek.com:Bearer ds-1",
      "api.tavily.com:Bearer tvly-1",
      "api.tavily.com:Bearer tvly-2",
      "api.tavily.com:Bearer tvly-2",
    ]);
    assert.equal((await service.test("deepseek-search")).ok, false);
    assert.equal(service.public().find((p) => p.enabled)?.id, "tavily-search");
    assert.equal((await service.test("unknown")).ok, false);
    refuse = false;
    assert.equal((await service.test("deepseek-search")).ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed persistence keeps the old route and a later queued save still succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-provider-write-"));
  const path = join(root, "providers.json");
  try {
    const service = await createProviderService({ path });
    await service.save("deepseek-search", { apiKey: "ds", enabled: true });
    await mkdir(`${path}.${process.pid}.tmp`);
    await assert.rejects(service.save("tavily-search", { apiKey: "tv", enabled: true }));
    assert.equal(service.public().find((p) => p.enabled)?.id, "deepseek-search");
    assert.equal((await readProviders(path))["tavily-search"], undefined);
    await rm(`${path}.${process.pid}.tmp`, { recursive: true });
    await service.save("tavily-search", { apiKey: "tv", enabled: true });
    assert.equal(service.public().find((p) => p.enabled)?.id, "tavily-search");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ambiguous stored selections never choose by catalogue order", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-provider-ambiguous-"));
  const path = join(root, "providers.json");
  try {
    await writeProviders(
      {
        "deepseek-search": { apiKey: "ds", enabled: true },
        "tavily-search": { apiKey: "tv", enabled: true },
      },
      path,
    );
    const service = await createProviderService({
      path,
      fetch: async () => {
        throw new Error("must not call");
      },
    });
    await assert.rejects(service.client.search({ query: "x" }), /选择.*搜索/);
    assert.equal(
      service.public().some((p) => p.enabled),
      false,
    );
    await service.save("tavily-search", { enabled: true });
    assert.equal(service.public().find((p) => p.enabled)?.id, "tavily-search");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("changing selection does not retarget a request that already started", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-provider-inflight-"));
  const pending = Promise.withResolvers<Response>();
  const seen: string[] = [];
  try {
    const service = await createProviderService({
      path: join(root, "providers.json"),
      fetch: async (url, init) => {
        seen.push(
          `${new URL(String(url)).host}:${new Headers(init?.headers).get("authorization")}`,
        );
        return seen.length === 1 ? pending.promise : Response.json({ results: [] });
      },
    });
    await service.save("deepseek-search", { apiKey: "old-key", enabled: true });
    const first = service.client.search({ query: "before" });
    await service.save("tavily-search", { apiKey: "new-key", enabled: true });
    pending.resolve(Response.json({ results: [] }));
    await first;
    await service.client.search({ query: "after" });
    assert.deepEqual(seen, ["api.deepseek.com:Bearer old-key", "api.tavily.com:Bearer new-key"]);
  } finally {
    pending.resolve(Response.json({ results: [] }));
    await rm(root, { recursive: true, force: true });
  }
});

// The decision service selects on its own axis: choosing a decision provider cannot silence
// search, and the opposite holds too (docs/bots/PROTOCOL.md, "Providers").
test("a decision provider is chosen without disturbing the search choice", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-provider-decision-"));
  const path = join(root, "providers.json");
  try {
    const service = await createProviderService({ path, fetch: async () => Response.json({}) });
    await service.save("tavily-search", { apiKey: "tvly", enabled: true });
    await service.save("typesafe", { apiKey: "apikey-one", enabled: true });
    assert.deepEqual(
      service
        .public()
        .filter((provider) => provider.enabled)
        .map((provider) => provider.id),
      ["tavily-search", "typesafe"],
    );
    await service.save("falcon", { apiKey: "falcon-source", enabled: true });
    assert.deepEqual(
      service
        .public()
        .filter((provider) => provider.enabled)
        .map((provider) => provider.id),
      ["tavily-search", "falcon"],
      "only the decision service switches",
    );
    await service.save("falcon", { enabled: false });
    assert.deepEqual(
      service
        .public()
        .filter((provider) => provider.enabled)
        .map((provider) => provider.id),
      ["tavily-search"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an address and a model name are overridden and reverted without a release", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-provider-override-"));
  const path = join(root, "providers.json");
  try {
    const service = await createProviderService({ path });
    await service.save("jev-relay", { baseUrl: "http://127.0.0.1:9999/v1", model: "jev-preview" });
    const overridden = service.public().find((provider) => provider.id === "jev-relay");
    assert.equal(overridden?.baseUrl, "http://127.0.0.1:9999", "a typed /v1 is the same root");
    assert.equal(overridden?.model, "jev-preview");
    assert.deepEqual(await readProviders(path), {
      "jev-relay": {
        apiKey: "",
        enabled: false,
        baseUrl: "http://127.0.0.1:9999",
        model: "jev-preview",
      },
    });
    assert.ok((await service.save("jev-relay", { baseUrl: "ftp://relay" })).error);
    assert.ok((await service.save("jev-relay", { baseUrl: "not-a-url" })).error);
    // The settings page echoes the address back, so a credential in it would be a visible key.
    assert.ok(
      (await service.save("jev-relay", { baseUrl: "http://user:a-real-secret@relay.test" })).error,
    );
    assert.equal(JSON.stringify(await readProviders(path)).includes("a-real-secret"), false);
    await service.save("jev-relay", { baseUrl: "", model: "" });
    const reverted = service.public().find((provider) => provider.id === "jev-relay");
    assert.equal(reverted?.baseUrl, "http://127.0.0.1:3425");
    assert.equal(reverted?.model, "typesafe/jev-latest");
    assert.deepEqual((await readProviders(path))["jev-relay"], { apiKey: "", enabled: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a relay that brings its own upstream key is selectable with no key at all", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-provider-keyless-"));
  try {
    const service = await createProviderService({ path: join(root, "providers.json") });
    assert.equal((await service.save("jev-relay", { enabled: true })).error, undefined);
    assert.equal(service.public().find((provider) => provider.id === "jev-relay")?.enabled, true);
    assert.ok(
      (await service.save("typesafe", { enabled: true })).error,
      "a provider that needs a key still refuses a bare selection",
    );
    // An optional key can be set and cleared again, so a person is never stuck with one.
    await service.save("jev-relay", { apiKey: "relay-only" });
    assert.equal(service.public().find((provider) => provider.id === "jev-relay")?.hasApiKey, true);
    await service.save("jev-relay", { apiKey: "" });
    assert.equal(
      service.public().find((provider) => provider.id === "jev-relay")?.hasApiKey,
      false,
      "an empty key clears the optional one",
    );
    assert.equal(service.public().find((provider) => provider.id === "jev-relay")?.enabled, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the probe follows the provider's kind, address and model", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-provider-probe-"));
  const seen: string[] = [];
  try {
    const service = await createProviderService({
      path: join(root, "providers.json"),
      fetch: async (url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
        seen.push(
          `${String(url)}|${new Headers(init?.headers).get("authorization")}|${body.model}`,
        );
        return Response.json({
          model: "jev-1.14.0",
          answers: {
            next_step: { type: "choice", choice: "test", probabilities: { test: 0.6, merge: 0.4 } },
          },
        });
      },
    });
    await service.save("typesafe", { apiKey: "apikey-one", enabled: true });
    const official = await service.test("typesafe");
    assert.equal(official.ok, true);
    assert.equal(official.resolvedModel, "jev-1.14.0");
    await service.save("jev-relay", { enabled: true, model: "typesafe/jev-preview" });
    const relay = await service.test("jev-relay");
    assert.equal(relay.ok, true);
    assert.deepEqual(seen, [
      "https://api.typesafe.ai/v1/systemone|Bearer apikey-one|jev-latest",
      "http://127.0.0.1:3425/v1/systemone|null|typesafe/jev-preview",
    ]);
    assert.equal((await service.test("unknown")).ok, false);
    const unconfigured = await service.test("raven");
    assert.equal(unconfigured.ok, false);
    assert.equal(seen.length, 2, "an unconfigured provider never reaches the network");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A judgment reads the selection at call time, so a new key or another relay applies to the next
// decision instead of the next conversation (docs/bots/PROTOCOL.md, "Providers").
test("a judgment follows the selected decision provider on every call", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-decision-select-"));
  const seen: string[] = [];
  const question = {
    state: "A small change has not been tested.",
    questions: {
      next_step: {
        type: "choice" as const,
        instructions: "Choose.",
        criteria: { test: "a", merge: "b" },
      },
    },
  };
  try {
    const service = await createProviderService({
      path: join(root, "providers.json"),
      fetch: async (url, init) => {
        seen.push(
          `${new URL(String(url)).origin}${new URL(String(url)).pathname}|${new Headers(init?.headers).get("authorization")}`,
        );
        return Response.json({
          model: "jev-1.14.0",
          answers: {
            next_step: {
              type: "choice",
              choice: "test",
              probabilities: { test: 0.9, merge: 0.1 },
              confidence: 0.8,
            },
          },
          usage: { input_tokens: 12, output_tokens: 1 },
        });
      },
    });
    await assert.rejects(() => service.decision.ask(question), /决策服务商/);
    assert.deepEqual(seen, [], "no selection means no request");

    await service.save("typesafe", { apiKey: "apikey-one", enabled: true });
    const official = await service.decision.ask(question);
    assert.equal(official.model, "jev-1.14.0");
    assert.equal(official.inputTokens, 12);
    assert.deepEqual(official.answers.next_step, {
      type: "choice",
      choice: "test",
      probabilities: { test: 0.9, merge: 0.1 },
      confidence: 0.8,
    });

    await service.save("jev-relay", { enabled: true });
    await service.decision.ask(question);
    assert.deepEqual(seen, [
      "https://api.typesafe.ai/v1/systemone|Bearer apikey-one",
      "http://127.0.0.1:3425/v1/systemone|null",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
