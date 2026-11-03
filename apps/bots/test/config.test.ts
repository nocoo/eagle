// The daemon configuration is the only place the environment is read, so its defaults and
// its argument handling are pinned here.
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CLOSE_DEADLINE_MS,
  DEFAULT_IDLE_CLOSE_MS,
  DEFAULT_PORT,
  DEFAULT_QUARANTINE_RETRY_MS,
  readConfig,
} from "../src/config.ts";
import { createDaemonModels } from "../src/runtime/pi/models.ts";

test("defaults, arguments and environment agree", () => {
  const defaults = readConfig({ argv: [], env: {}, home: "/home/tester" });
  assert.equal(defaults.root, "/home/tester/.local/share/eagle-bots");
  assert.equal(defaults.port, DEFAULT_PORT);
  assert.equal(defaults.idleCloseMs, DEFAULT_IDLE_CLOSE_MS);
  assert.equal(defaults.quarantineRetryMs, DEFAULT_QUARANTINE_RETRY_MS);
  assert.equal(defaults.closeDeadlineMs, DEFAULT_CLOSE_DEADLINE_MS);
  assert.equal(defaults.logLevel, "debug");
  assert.deepEqual(defaults.model, { provider: "magpie", modelId: "auto/gpt-6-luna" });
  assert.equal(defaults.memoryDir, "/home/tester/.config/eagle-bots/memory");

  const explicit = readConfig({
    argv: ["--root", "/tmp/root", "--port", "43118"],
    env: { BOTS_LOG_LEVEL: "warn", BOTS_MODEL: "auto/gpt-6-1-sol", BOTS_IDLE_CLOSE_MS: "2500" },
  });
  assert.equal(explicit.root, "/tmp/root");
  assert.equal(explicit.port, 43118);
  assert.equal(
    readConfig({ argv: ["--port", "0"], env: {} }).port,
    0,
    "zero asks the kernel for a free port",
  );
  assert.equal(explicit.logLevel, "warn");
  assert.equal(explicit.model.modelId, "auto/gpt-6-1-sol");
  assert.equal(explicit.idleCloseMs, 2_500);

  assert.equal(
    readConfig({ argv: [], env: { XDG_CONFIG_HOME: "/tmp/cfg" }, home: "/home/tester" }).memoryDir,
    "/tmp/cfg/eagle-bots/memory",
    "memory follows the configuration root, not the state root",
  );
  assert.equal(
    readConfig({ argv: [], env: { BOTS_MEMORY_DIR: "/tmp/mem" }, home: "/home/tester" }).memoryDir,
    "/tmp/mem",
    "an explicit directory wins",
  );

  assert.throws(() => readConfig({ argv: ["--root"], env: {} }), /--root needs a path/);
  assert.throws(() => readConfig({ argv: ["--port"], env: {} }), /--port needs a number/);
  assert.equal(
    readConfig({ argv: ["--port", "not-a-number"], env: {} }).port,
    DEFAULT_PORT,
    "a malformed port falls back to the default",
  );
});

test("the development agent token path comes from the environment", () => {
  assert.equal(
    readConfig({ argv: [], env: {} }).devAgentTokenPath,
    undefined,
    "an unset variable arms nothing",
  );
  assert.equal(
    readConfig({
      argv: [],
      env: { BOTS_DEV_AGENT_TOKEN: "/home/tester/.config/eagle-dev/token" },
    }).devAgentTokenPath,
    "/home/tester/.config/eagle-dev/token",
  );
});

test("the configured model endpoint becomes the daemon's one provider", async () => {
  const models = createDaemonModels({
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "test-key",
    provider: "stub",
    modelId: "auto/stub",
  });
  const model = models.getModel("stub", "auto/stub");
  assert.ok(model !== undefined, "the configured model exists");
  assert.equal(model.provider, "stub");
  assert.equal(model.id, "auto/stub");
  assert.equal(model.api, "openai-responses");
  assert.equal(model.baseUrl, "http://127.0.0.1:9/v1");
  assert.equal(models.getModel("stub", "missing"), undefined, "only the configured model exists");
  assert.equal((await models.getAuth(model))?.auth.apiKey, "test-key");
  const unconfigured = createDaemonModels({
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "",
    provider: "stub",
    modelId: "auto/stub",
  });
  assert.equal(await unconfigured.getAuth("stub"), undefined, "an empty key fails closed");
});

test("the secrets paths follow the documented places", () => {
  const linux = readConfig({ argv: [], env: {}, home: "/home/tester", platform: "linux" });
  assert.equal(linux.secretsDir, "/home/tester/.config/eagle-bots");
  assert.equal(linux.secretsKeyPath, "/home/tester/.local/state/eagle-bots/secrets.key");

  const mac = readConfig({ argv: [], env: {}, home: "/Users/tester", platform: "darwin" });
  assert.equal(mac.secretsDir, "/Users/tester/.config/eagle-bots");
  assert.equal(
    mac.secretsKeyPath,
    "/Users/tester/Library/Application Support/ai.hexly.bots/secrets.key",
  );

  const state = readConfig({
    argv: [],
    env: { XDG_STATE_HOME: "/state" },
    home: "/home/tester",
    platform: "linux",
  });
  assert.equal(state.secretsKeyPath, "/state/eagle-bots/secrets.key");

  const explicit = readConfig({
    argv: [],
    env: { BOTS_SECRETS_DIR: "/tmp/secrets", BOTS_SECRETS_KEY: "/tmp/secrets.key" },
    home: "/home/tester",
  });
  assert.equal(explicit.secretsDir, "/tmp/secrets");
  assert.equal(explicit.secretsKeyPath, "/tmp/secrets.key");
});
