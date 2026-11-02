// Provider keys (docs/bots/PROTOCOL.md, "Providers"): the catalogue is code, the secret lives
// in the user's own config with 0600, and the public shape only says whether a key is set.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PROVIDERS,
  providerDefinition,
  publicProviders,
  readProviders,
  selectedProvider,
  writeProviders,
} from "../../src/server/providers.ts";

test("a saved key is stored 0600 and never comes back out", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-providers-"));
  const path = join(root, "config", "eagle-bots", "providers.json");
  try {
    await writeProviders({ "deepseek-search": { apiKey: "sk-secret", enabled: true } }, path);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const raw = await readFile(path, "utf8");
    assert.match(raw, /sk-secret/, "the daemon owns the file; the API redacts it");
    const shown = publicProviders(await readProviders(path));
    assert.equal(shown[0]?.id, "deepseek-search");
    assert.equal(shown[0]?.title, "DeepSeek");
    assert.equal(shown[0]?.hasApiKey, true);
    assert.equal(shown[0]?.enabled, true);
    assert.equal(JSON.stringify(shown).includes("sk-secret"), false, "the key stays in the file");
    assert.equal(shown[0]?.docsUrl, "https://api-docs.deepseek.com/guides/search/");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an absent or malformed file is nothing configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-providers-"));
  const path = join(root, "providers.json");
  try {
    assert.deepEqual(await readProviders(path), {});
    await writeProviders({}, path);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "{ half");
    assert.deepEqual(await readProviders(path), {});
    await writeFile(path, JSON.stringify({ version: 1, providers: { x: { enabled: true } } }));
    assert.deepEqual(await readProviders(path), {}, "a config without a key is not a provider");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the catalogue serves two services: search and decision", () => {
  assert.deepEqual(
    PROVIDERS.map((provider) => [provider.id, provider.service]),
    [
      ["deepseek-search", "search"],
      ["tavily-search", "search"],
      ["typesafe", "decision"],
      ["falcon", "decision"],
      ["falcon-relay", "decision"],
      ["jev-relay", "decision"],
      ["raven", "decision"],
    ],
  );
  assert.equal(providerDefinition("deepseek-search")?.kind, "deepseek-search");
  assert.equal(providerDefinition("nope"), undefined);
  assert.deepEqual(
    publicProviders({}).map((provider) => [provider.hasApiKey, provider.enabled]),
    PROVIDERS.map(() => [false, false]),
    "an unconfigured provider is neither set nor enabled",
  );
});

// Every decision provider speaks System One, so only the address, the model name and whether the
// key is required differ (docs/bots/PROTOCOL.md, "Providers").
test("each decision provider states its own address, model and key rule", () => {
  const decision = PROVIDERS.filter((provider) => provider.service === "decision");
  assert.deepEqual(
    decision.map((provider) => [
      provider.id,
      provider.kind,
      provider.baseUrl,
      provider.model,
      provider.keyRequired,
    ]),
    [
      ["typesafe", "systemone", "https://api.typesafe.ai", "jev-latest", true],
      ["falcon", "systemone", "http://127.0.0.1:19823", "jev-latest", true],
      ["falcon-relay", "systemone", "https://falcon.hexly.ai", "jev-latest", true],
      ["jev-relay", "systemone", "http://127.0.0.1:3425", "typesafe/jev-latest", false],
      ["raven", "systemone", "http://127.0.0.1:7024", "microsoft-decision-1", true],
    ],
  );
  assert.deepEqual(
    publicProviders({}).find((provider) => provider.id === "raven"),
    {
      id: "raven",
      title: "Raven",
      service: "decision",
      kind: "systemone",
      baseUrl: "http://127.0.0.1:7024",
      model: "microsoft-decision-1",
      docsUrl: "https://github.com/nocoo/raven/blob/main/docs/30-systemone.md",
      keyLabel: "Raven API Key",
      keyRequired: true,
      hasApiKey: false,
      enabled: false,
      defaults: { baseUrl: "http://127.0.0.1:7024", model: "microsoft-decision-1" },
    },
  );
});

// A stored override moves the address or the model name without a release; the catalogue value
// stays visible so the page can name what it is falling back to.
test("a stored override wins, and the catalogue value is still reported", () => {
  const shown = publicProviders({
    "jev-relay": {
      apiKey: "",
      enabled: true,
      baseUrl: "http://127.0.0.1:9999",
      model: "typesafe/jev-preview",
    },
  }).find((provider) => provider.id === "jev-relay");
  assert.equal(shown?.baseUrl, "http://127.0.0.1:9999");
  assert.equal(shown?.model, "typesafe/jev-preview");
  assert.equal(shown?.enabled, true);
  assert.deepEqual(shown?.defaults, {
    baseUrl: "http://127.0.0.1:3425",
    model: "typesafe/jev-latest",
  });
});

// The two services select independently: choosing a decision provider cannot silence search.
test("selection is exclusive within a service and independent across services", () => {
  const shown = publicProviders({
    "tavily-search": { apiKey: "tvly", enabled: true },
    typesafe: { apiKey: "apikey", enabled: true },
  });
  assert.deepEqual(
    shown.filter((provider) => provider.enabled).map((provider) => provider.id),
    ["tavily-search", "typesafe"],
  );
  assert.equal(
    selectedProvider(
      {
        typesafe: { apiKey: "a", enabled: true },
        falcon: { apiKey: "b", enabled: true },
      },
      "decision",
    ),
    undefined,
    "an ambiguous stored selection picks nothing",
  );
});

test("an override survives the round trip; a cleared one is not stored", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-providers-override-"));
  const path = join(root, "providers.json");
  try {
    await writeProviders(
      {
        falcon: {
          apiKey: "falcon-source",
          enabled: true,
          baseUrl: "http://127.0.0.1:19999",
          model: "jev-preview",
        },
      },
      path,
    );
    assert.deepEqual(await readProviders(path), {
      falcon: {
        apiKey: "falcon-source",
        enabled: true,
        baseUrl: "http://127.0.0.1:19999",
        model: "jev-preview",
      },
    });
    await writeProviders({ falcon: { apiKey: "falcon-source", enabled: true } }, path);
    assert.deepEqual(await readProviders(path), {
      falcon: { apiKey: "falcon-source", enabled: true },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
