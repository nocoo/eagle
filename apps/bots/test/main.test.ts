// The composition root: one daemon over one root, wired from configuration, closed cleanly.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { readConfig } from "../src/config.ts";
import { BotDirectory } from "../src/core/BotDirectory.ts";
import { startDaemon } from "../src/main.ts";
import { PiDurableRuntime } from "../src/runtime/pi/PiDurableRuntime.ts";
import { DEFAULT_CORE_PROMPT, readGateway, writeGateway } from "../src/server/gateway.ts";
import { acquireLock, LockError } from "../src/server/singleton.ts";
import {
  daemonRoot,
  lockPortOf,
  rootWithLockPort,
  spawnDaemon,
  startDaemonProcess,
} from "./support/daemon.ts";
import { waitFor } from "./support/pi.ts";

test("saved gateway credentials authorize model requests on every daemon boot", async () => {
  const root = await daemonRoot("bots-saved-gateway-");
  const key = "test-saved-gateway-key";
  let authorized = 0;
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${key}`) {
      response.writeHead(401).end();
      return;
    }
    authorized += 1;
    const id = `response_${authorized}`;
    const item = {
      type: "message",
      id: `message_${authorized}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "restored", annotations: [] }],
    };
    const event = (type: string, fields: object) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      event("response.created", { response: { id, status: "in_progress" } }) +
        event("response.output_item.added", { output_index: 0, item: { ...item, content: [] } }) +
        event("response.output_text.delta", {
          output_index: 0,
          content_index: 0,
          delta: "restored",
        }) +
        event("response.completed", {
          response: {
            id,
            status: "completed",
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  try {
    await writeGateway(root, {
      provider: "saved-test",
      model: "saved-model",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: key,
      thinkingLevel: "medium",
      toolGroups: ["core", "herdr"],
      corePrompt: "你是一个务实、友好的 agent。",
    });
    let botId: string | undefined;
    for (const boot of [1, 2]) {
      const daemon = await startDaemon(
        readConfig({ argv: ["--root", root, "--port", "0"], env: {} }),
      );
      try {
        botId ??= (await daemon.registry.create("Saved gateway", "tr_create_saved")).id;
        const handle = await daemon.registry.open(botId, "tr_open_saved");
        const requestId = `r_saved_${boot}`;
        await handle.submit({
          requestId,
          text: "test",
          whenBusy: "followUp",
          trace: "tr_saved_send",
        });
        await waitFor(async () => {
          const record = await handle.submission({ requestId });
          return record?.status === "done" || record?.status === "unanswered";
        }, "the saved-key request settles");
        assert.equal((await handle.submission({ requestId }))?.status, "done");
        assert.equal(authorized, boot, "the saved key reached the local model endpoint");
      } finally {
        await daemon.close();
      }
    }
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await rm(root, { recursive: true, force: true });
  }
});

test("a root that shares a lock port with a live daemon is refused, and says which port", async () => {
  // The lock port is derived from the root, so two roots can hash to the same port
  // (ARCHITECTURE.md, "Singleton lock"). The refusal is a fact about the machine, so it
  // has to be reported: the process exits non-zero and names the port it derived.
  const owner = await daemonRoot("bots-lock-owner-");
  const daemon = spawnDaemon({ root: owner });
  try {
    await daemon.waitForStart();
    const port = await lockPortOf(owner);
    const rival = await rootWithLockPort(port);
    const refused = spawnDaemon({ root: rival });
    try {
      const exit = await refused.exited();
      assert.notEqual(exit.code, 0, "the shared port refuses the second root");
      assert.match(refused.stderr(), /lock port \d+ is shared/, "and names the port");
      assert.equal(refused.stdout(), "", "a refused daemon prints no start line");
      // The harness reports the whole story, so a refusal is never an unexplained exit.
      await assert.rejects(
        () => refused.waitForStart(),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes("exit code: 1") &&
          error.message.includes("lock port") &&
          error.message.includes("is shared"),
      );
    } finally {
      await refused.stop();
      await rm(rival, { recursive: true, force: true });
    }
  } finally {
    await daemon.stop();
    await rm(owner, { recursive: true, force: true });
  }
});

test("a daemon that loses its lock port starts on another root", async () => {
  // The harness owns the root it hands the daemon, so a root that lost its port to
  // another root is retried: the daemon named the port, and a different root is the
  // documented remedy (ARCHITECTURE.md, "Singleton lock").
  const owner = await daemonRoot("bots-retry-owner-");
  const spare = await daemonRoot("bots-retry-spare-");
  const daemon = spawnDaemon({ root: owner });
  try {
    await daemon.waitForStart();
    const port = await lockPortOf(owner);
    const colliding = await rootWithLockPort(port);
    const started = await startDaemonProcess({ roots: [colliding, spare] });
    try {
      assert.notEqual(started.root, colliding, "the refused root was left behind");
      assert.ok(started.port > 0, "the daemon answers on the other root");
    } finally {
      await started.daemon.stop();
      await rm(started.root, { recursive: true, force: true });
    }
    await rm(colliding, { recursive: true, force: true });
  } finally {
    await daemon.stop();
    await rm(owner, { recursive: true, force: true });
    await rm(spare, { recursive: true, force: true });
  }
});

test("the daemon starts from configuration and closes without leaving work behind", async () => {
  const root = await daemonRoot("bots-main-");
  try {
    const config = readConfig({ argv: ["--root", root, "--port", "0"], env: {} });
    const daemon = await startDaemon(config);
    try {
      assert.ok(daemon.port > 0, "the kernel chose the port");
      assert.ok(daemon.token.length >= 32, "a token was issued");
      assert.equal((await stat(join(root, "token"))).mode & 0o777, 0o600);
      const health = await fetch(`http://127.0.0.1:${daemon.port}/v1/health`);
      assert.equal(health.status, 200);
      const body = (await health.json()) as { instance: string; bots: number };
      assert.equal(body.bots, 0);
      assert.match(body.instance, /^i_/);
      const refused = await fetch(`http://127.0.0.1:${daemon.port}/v1/bots`);
      assert.equal(refused.status, 401, "the catalog needs the token");
      const listed = await fetch(`http://127.0.0.1:${daemon.port}/v1/bots`, {
        headers: { authorization: `Bearer ${daemon.token}` },
      });
      assert.deepEqual(((await listed.json()) as { bots: unknown[] }).bots, []);

      // Creation warms the bot through the composed opener. With no reachable model
      // endpoint the open fails, and the catalog says so instead of pretending it is idle.
      const created = await fetch(`http://127.0.0.1:${daemon.port}/v1/bots`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${daemon.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: "组合根" }),
      });
      assert.equal(created.status, 201);
      const botId = ((await created.json()) as { bot: { id: string } }).bot.id;
      let state = "opening";
      for (let index = 0; index < 200 && state === "opening"; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const refreshed = await fetch(`http://127.0.0.1:${daemon.port}/v1/bots`, {
          headers: { authorization: `Bearer ${daemon.token}` },
        });
        state =
          ((await refreshed.json()) as { bots: { id: string; state: string }[] }).bots.find(
            (bot) => bot.id === botId,
          )?.state ?? "catalogued";
      }
      assert.equal(state, "idle", "creation warmed the bot through the composed opener");
    } finally {
      assert.equal(await daemon.close(), "closed");
    }
    // A second daemon on the same root is refused only while the first one lives; after a
    // close the lock is free again.
    const again = await startDaemon(readConfig({ argv: ["--root", root, "--port", "0"], env: {} }));
    await again.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shutdown retains the root lock until an in-flight open is closed", async (context) => {
  const root = await daemonRoot("bots-opening-lock-");
  let release = () => {};
  let markStarted = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const original = PiDurableRuntime.prototype.open;
  context.mock.method(
    PiDurableRuntime.prototype,
    "open",
    async function (this: PiDurableRuntime, spec: Parameters<typeof original>[0]) {
      markStarted();
      await gate;
      return original.call(this, spec);
    },
  );
  const daemon = await startDaemon(
    readConfig({ argv: ["--root", root, "--port", "0"], env: { BOTS_CLOSE_DEADLINE_MS: "200" } }),
  );
  let opening: Promise<unknown> | undefined;
  try {
    const bot = await daemon.registry.create("Opening", "tr_opening_lock");
    await started;
    opening = daemon.registry.open(bot.id, "tr_join_opening").catch(() => undefined);
    assert.equal(await daemon.close(), "timeout");
    assert.equal(await daemon.close(), "timeout");
    let unexpected: Awaited<ReturnType<typeof acquireLock>> | undefined;
    try {
      unexpected = await acquireLock({ root: daemon.config.root });
      assert.fail("the root lock was released while the opener was still running");
    } catch (error) {
      if (!(error instanceof LockError) || error.reason !== "running") throw error;
    } finally {
      await unexpected?.close();
    }
  } finally {
    release();
    await opening;
    await waitFor(async () => {
      try {
        const owner = await acquireLock({ root: daemon.config.root });
        await owner.close();
        return true;
      } catch (error) {
        if (error instanceof LockError && error.reason !== "collision") return false;
        throw error;
      }
    }, "the root lock to be released after cleanup");
    await rm(root, { recursive: true, force: true });
  }
});

test("shutdown retains the root lock until an accepted catalog write finishes", async (context) => {
  const root = await daemonRoot("bots-route-lock-");
  let release = () => {};
  let markStarted = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const original = BotDirectory.prototype.create;
  context.mock.method(
    BotDirectory.prototype,
    "create",
    async function (this: BotDirectory, config: Parameters<typeof original>[0]) {
      markStarted();
      await gate;
      return original.call(this, config);
    },
  );
  const daemon = await startDaemon(
    readConfig({ argv: ["--root", root, "--port", "0"], env: { BOTS_CLOSE_DEADLINE_MS: "200" } }),
  );
  const request = fetch(`http://127.0.0.1:${daemon.port}/v1/bots`, {
    method: "POST",
    headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
    body: JSON.stringify({ title: "Pending catalog write" }),
  }).catch(() => undefined);
  try {
    await started;
    assert.equal(await daemon.close(), "timeout");
    await assert.rejects(
      acquireLock({ root: daemon.config.root }),
      (error: unknown) => error instanceof LockError && error.reason === "running",
    );
  } finally {
    release();
    await request;
    await waitFor(
      () => daemon.registry.summaries().some((bot) => bot.title === "Pending catalog write"),
      "the accepted catalog write",
    );
    await waitFor(async () => {
      try {
        const owner = await acquireLock({ root: daemon.config.root });
        await owner.close();
        return true;
      } catch (error) {
        if (error instanceof LockError && error.reason !== "collision") return false;
        throw error;
      }
    }, "the root lock to be released after the catalog write");
    await rm(root, { recursive: true, force: true });
  }
});

test("a timed-out handle keeps its root locked until process exit", async () => {
  const root = await daemonRoot("bots-timeout-lock-");
  const script = `
    import assert from 'node:assert/strict';
    import { startDaemon } from ${JSON.stringify(import.meta.resolve("../src/main.ts"))};
    import { readConfig } from ${JSON.stringify(import.meta.resolve("../src/config.ts"))};
    import { acquireLock, LockError } from ${JSON.stringify(import.meta.resolve("../src/server/singleton.ts"))};
    const daemon = await startDaemon(readConfig({ argv: ['--root', process.argv[1], '--port', '0'], env: {} }));
    const bot = await daemon.registry.create('Timeout', 'tr_timeout_lock');
    const handle = await daemon.registry.open(bot.id, 'tr_timeout_lock');
    handle.close = async () => 'timeout';
    assert.equal(await daemon.close(), 'timeout');
    await assert.rejects(acquireLock({ root: daemon.config.root }),
      error => error instanceof LockError && error.reason === 'running');
    process.exit(0);
  `;
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", script, root], {
      timeout: 10_000,
    });
    const { realpath } = await import("node:fs/promises");
    const owner = await acquireLock({ root: await realpath(root) });
    await owner.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the daemon process reports shutdown success and timeout distinctly", async () => {
  for (const timeout of [false, true]) {
    const root = await daemonRoot("bots-signal-exit-");
    const script = `
      import { readFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { PiDurableRuntime } from ${JSON.stringify(import.meta.resolve("../src/runtime/pi/PiDurableRuntime.ts"))};
      let markOpened;
      const opened = new Promise(resolve => { markOpened = resolve; });
      const original = PiDurableRuntime.prototype.open;
      PiDurableRuntime.prototype.open = async function(spec) {
        const handle = await original.call(this, spec);
        if (${timeout}) handle.close = async () => 'timeout';
        markOpened();
        return handle;
      };
      let start;
      const write = process.stdout.write;
      process.stdout.write = function(chunk) { start = JSON.parse(String(chunk)); return true; };
      process.argv.splice(2, Infinity, '--root', process.argv[1], '--port', '0');
      await import(${JSON.stringify(import.meta.resolve("../scripts/serve.ts"))});
      process.stdout.write = write;
      const token = (await readFile(join(process.argv[1], 'token'), 'utf8')).trim();
      const response = await fetch('http://127.0.0.1:' + start.port + '/v1/bots', {
        method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Signal' })
      });
      if (response.status !== 201) throw new Error('bot creation failed');
      await opened;
      process.kill(process.pid, 'SIGTERM');
    `;
    try {
      let status = 0;
      try {
        execFileSync(process.execPath, ["--input-type=module", "-e", script, root], {
          timeout: 10_000,
        });
      } catch (error) {
        if (typeof error !== "object" || error === null || !("status" in error)) throw error;
        status = error.status as number;
      }
      assert.equal(status, timeout ? 1 : 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("the development bearer is redacted from the log it authenticates with", async () => {
  const root = await daemonRoot("bots-devtoken-redact-");
  const dir = await mkdtemp(join(tmpdir(), "bots-devtoken-redact-file-"));
  const path = join(dir, "token");
  const token = "dev-agent-token-0123456789-abcdefghijklmnop";
  await writeFile(path, `${token}\n`);
  await chmod(path, 0o600);
  try {
    const daemon = await startDaemon(
      readConfig({ argv: ["--root", root, "--port", "0"], env: { BOTS_DEV_AGENT_TOKEN: path } }),
    );
    try {
      const created = await fetch(`http://127.0.0.1:${daemon.port}/v1/bots`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ title: "开发代理" }),
      });
      const botId = ((await created.json()) as { bot: { id: string } }).bot.id;
      // A client that puts its credential where a trace belongs must not paint it into
      // the record: the subscribe trace is logged, and the accepted bearer is redacted.
      const socket = new WebSocket(`ws://127.0.0.1:${daemon.port}/v1/socket`, {
        headers: { authorization: `Bearer ${token}` },
      });
      await new Promise<void>((resolve_, reject) => {
        socket.once("open", () => resolve_());
        socket.once("error", reject);
      });
      const snapshot = new Promise<void>((resolve_) => {
        socket.on("message", (data) => {
          const frame = JSON.parse(data.toString()) as { type?: string };
          if (frame.type === "snapshot") resolve_();
        });
      });
      socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, client: "redact" }));
      socket.send(JSON.stringify({ type: "subscribe", botId, trace: token }));
      await snapshot;
      socket.close();
    } finally {
      await daemon.close();
    }
    const logs = (await readdir(join(root, "logs"))).filter((name) => name.endsWith(".jsonl"));
    const body = (
      await Promise.all(logs.map((name) => readFile(join(root, "logs", name), "utf8")))
    ).join("");
    assert.equal(body.includes("core.subscribe.ok"), true, "the traced subscribe was logged");
    assert.equal(body.includes(token), false, "no record carries the development bearer");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("the daemon arms the development agent token it was told about", async () => {
  const root = await daemonRoot("bots-devtoken-");
  const dir = await mkdtemp(join(tmpdir(), "bots-devtoken-file-"));
  const path = join(dir, "token");
  const token = "dev-agent-token-0123456789-abcdefghijklmnop";
  await writeFile(path, `${token}\n`);
  await chmod(path, 0o600);
  try {
    const daemon = await startDaemon(
      readConfig({
        argv: ["--root", root, "--port", "0"],
        env: { BOTS_DEV_AGENT_TOKEN: path },
      }),
    );
    try {
      const listed = await fetch(`http://127.0.0.1:${daemon.port}/v1/bots`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(listed.status, 200, "the development token reads the catalog");
      const me = await fetch(`http://127.0.0.1:${daemon.port}/v1/clients/me`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(((await me.json()) as { client: { name: string } }).client.name, "dev-agent");
    } finally {
      await daemon.close();
    }
    const logs = await readdir(join(root, "logs"));
    const records = (
      await Promise.all(
        logs
          .filter((name) => name.endsWith(".jsonl"))
          .map(async (name) => await readFile(join(root, "logs", name), "utf8")),
      )
    )
      .join("")
      .split("\n")
      .filter((line) => line.length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            evt?: string;
            level?: string;
            layer?: string;
            detail?: { path?: string };
          },
      );
    const armed = records.filter((record) => record.evt === "transport.devtoken.ok");
    assert.equal(armed.length, 1, "the startup armed the token once");
    assert.equal(armed[0]?.level, "info");
    assert.equal(armed[0]?.layer, "transport");
    assert.equal(armed[0]?.detail?.path, path, "the record names the file, never the token");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("health identifies the configured shared device port even while that service is offline", async () => {
  const root = await daemonRoot("bots-device-health-");
  const socket = join(root, "offline.sock");
  const daemon = await startDaemon(
    readConfig({ argv: ["--root", root, "--port", "0"], env: { BOTS_DEVICE_SOCKET: socket } }),
  );
  try {
    const response = await fetch(`http://127.0.0.1:${daemon.port}/v1/health`);
    const health = (await response.json()) as { deviceAccess?: unknown };
    assert.deepEqual(health.deviceAccess, {
      version: 1,
      binding: createHash("sha256").update(socket).digest("hex"),
    });
    assert.ok(!JSON.stringify(health).includes(socket));
  } finally {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("settings store the thinking level, refuse an unknown one and apply it to bots", async () => {
  const root = await daemonRoot("bots-levels-");
  try {
    const config = readConfig({ argv: ["--root", root, "--port", "0"], env: {} });
    const daemon = await startDaemon(config);
    const put = (body: unknown) =>
      fetch(`http://127.0.0.1:${daemon.port}/v1/settings`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${daemon.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const settings = {
      baseUrl: "http://127.0.0.1:9/v1",
      model: "auto/gpt-6-luna",
      apiKey: "sk-levels-000000000000000000",
    };
    try {
      const refused = await put({ ...settings, thinkingLevel: "loud" });
      assert.equal(refused.status, 400, "an unknown level is refused");
      assert.equal(
        (await readGateway(root))?.thinkingLevel ?? "medium",
        "medium",
        "a refused save writes nothing",
      );

      const saved = await put({ ...settings, thinkingLevel: "xhigh" });
      assert.equal(saved.status, 200);
      const shown = (await saved.json()) as { settings: { thinkingLevel: string; model: string } };
      assert.equal(shown.settings.thinkingLevel, "xhigh");
      assert.equal(shown.settings.model, "auto/gpt-6-luna");
      assert.equal((await readGateway(root))?.thinkingLevel, "xhigh", "the choice is stored");

      const created = await fetch(`http://127.0.0.1:${daemon.port}/v1/bots`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${daemon.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: "等级" }),
      });
      const botId = ((await created.json()) as { bot: { id: string } }).bot.id;
      const stored = JSON.parse(await readFile(join(root, "bots", botId, "bot.json"), "utf8")) as {
        thinkingLevel?: string;
        model: { modelId: string };
      };
      assert.equal(stored.thinkingLevel, "xhigh", "a new bot records the settings level");
      assert.equal(stored.model.modelId, "auto/gpt-6-luna");
    } finally {
      await daemon.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("settings store tool groups, reject unknown names and keep core and coding mandatory", async () => {
  const root = await daemonRoot("bots-groups-");
  try {
    const config = readConfig({ argv: ["--root", root, "--port", "0"], env: {} });
    const daemon = await startDaemon(config);
    const put = (body: unknown) =>
      fetch(`http://127.0.0.1:${daemon.port}/v1/settings`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${daemon.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const settings = {
      baseUrl: "http://127.0.0.1:9/v1",
      model: "auto/gpt-6-luna",
      apiKey: "sk-groups-000000000000000000",
      thinkingLevel: "medium",
    };
    try {
      const refused = await put({ ...settings, toolGroups: ["core", "web"] });
      assert.equal(refused.status, 400, "an unknown group is refused");
      assert.equal(await readGateway(root), undefined, "a refused save writes nothing");

      const saved = await put({ ...settings, toolGroups: ["herdr"] });
      assert.equal(saved.status, 200);
      const shown = (await saved.json()) as { settings: { toolGroups: string[] } };
      assert.deepEqual(
        shown.settings.toolGroups,
        ["core", "coding", "herdr"],
        "both required groups are implied",
      );
      assert.deepEqual((await readGateway(root))?.toolGroups, ["core", "coding", "herdr"]);

      const trimmed = await put({ ...settings, toolGroups: [] });
      assert.equal(trimmed.status, 200);
      assert.deepEqual(
        (await readGateway(root))?.toolGroups,
        ["core", "coding"],
        "neither required group can be disabled",
      );
    } finally {
      await daemon.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compaction thresholds follow the declared window and can be turned off", async () => {
  const { compactionFromEnv } = await import("../src/main.ts");
  assert.deepEqual(compactionFromEnv({}, 200_000), {
    enabled: true,
    reserveTokens: 16_384,
    keepRecentTokens: 8_192,
    backgroundTokens: 32_768,
  });
  const tiny = compactionFromEnv({}, 1_200);
  assert.equal(tiny?.enabled, true);
  assert.equal(tiny?.reserveTokens, 600, "the reserve never exceeds half the window");
  assert.equal(tiny?.backgroundTokens, 300, "background work stays within a quarter");
  assert.deepEqual(compactionFromEnv({ BOTS_COMPACTION: "off" }, 200_000), { enabled: false });
  assert.equal(
    compactionFromEnv({ BOTS_COMPACTION_RESERVE_TOKENS: "2048" }, 200_000)?.reserveTokens,
    2_048,
  );
});

test("the usage endpoint reports an empty window before anything runs", async () => {
  const root = await daemonRoot("bots-usage-http-");
  try {
    const daemon = await startDaemon(
      readConfig({ argv: ["--root", root, "--port", "0"], env: {} }),
    );
    try {
      const response = await fetch(`http://127.0.0.1:${daemon.port}/v1/usage?days=7`, {
        headers: { authorization: `Bearer ${daemon.token}` },
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        usage: { retentionDays: number; days: unknown[]; today: { totalTokens: number } };
      };
      assert.equal(body.usage.retentionDays, 90, "ninety days are kept");
      assert.equal(body.usage.days.length, 7, "the requested window is served");
      assert.equal(body.usage.today.totalTokens, 0);
      const unknown = await fetch(`http://127.0.0.1:${daemon.port}/v1/usage`);
      assert.equal(unknown.status, 401, "the statistics need the bearer token");
    } finally {
      await daemon.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider keys are saved behind the bearer and never returned", async () => {
  const root = await daemonRoot("bots-providers-http-");
  const configHome = await mkdtemp(join(tmpdir(), "bots-providers-home-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configHome;
  try {
    const daemon = await startDaemon(
      readConfig({ argv: ["--root", root, "--port", "0"], env: {} }),
    );
    const headers = { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" };
    try {
      const initial = await fetch(`http://127.0.0.1:${daemon.port}/v1/providers`, { headers });
      const listed = (await initial.json()) as {
        providers: { id: string; hasApiKey: boolean; enabled: boolean }[];
      };
      assert.equal(listed.providers[0]?.id, "deepseek-search");
      assert.equal(listed.providers[0]?.hasApiKey, false);

      const saved = await fetch(`http://127.0.0.1:${daemon.port}/v1/providers/deepseek-search`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ apiKey: "sk-http-secret", enabled: true }),
      });
      assert.equal(saved.status, 200);
      const body = (await saved.json()) as {
        provider: { hasApiKey: boolean; enabled: boolean; title: string };
      };
      assert.equal(body.provider.hasApiKey, true);
      assert.equal(body.provider.enabled, true);
      assert.equal(JSON.stringify(body).includes("sk-http-secret"), false, "the key stays stored");

      const unknown = await fetch(`http://127.0.0.1:${daemon.port}/v1/providers/nope`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ apiKey: "k" }),
      });
      assert.equal(unknown.status, 400);
      const blank = await fetch(`http://127.0.0.1:${daemon.port}/v1/providers/deepseek-search`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ apiKey: "   " }),
      });
      assert.equal(blank.status, 400, "a blank key is refused rather than clearing the stored one");
      const tavily = await fetch(`http://127.0.0.1:${daemon.port}/v1/providers/tavily-search`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ apiKey: "tvly-http-fixture" }),
      });
      assert.equal(tavily.status, 200, "a second provider key saves independently");
      const choose = await fetch(`http://127.0.0.1:${daemon.port}/v1/providers/tavily-search`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ enabled: true }),
      });
      assert.equal(choose.status, 200);
      const state = await fetch(`http://127.0.0.1:${daemon.port}/v1/providers`, { headers });
      const providers = (
        (await state.json()) as {
          providers: { id: string; hasApiKey: boolean; enabled: boolean }[];
        }
      ).providers;
      assert.deepEqual(
        providers.map((provider) => [provider.id, provider.hasApiKey, provider.enabled]),
        [
          ["deepseek-search", true, false],
          ["tavily-search", true, true],
          ["typesafe", false, false],
          ["falcon", false, false],
          ["falcon-relay", false, false],
          ["jev-relay", false, false],
          ["raven", false, false],
        ],
      );
      const unauthenticated = await fetch(`http://127.0.0.1:${daemon.port}/v1/providers`);
      assert.equal(unauthenticated.status, 401);

      const decision = await fetch(`http://127.0.0.1:${daemon.port}/v1/providers/raven`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          apiKey: "rk-http-fixture",
          enabled: true,
          baseUrl: "http://127.0.0.1:7024/v1",
          model: "auto",
        }),
      });
      assert.equal(decision.status, 200);
      const chosen = (
        (await decision.json()) as {
          provider: { id: string; baseUrl: string; model: string; enabled: boolean };
        }
      ).provider;
      assert.equal(chosen.baseUrl, "http://127.0.0.1:7024", "a typed /v1 collapses to the root");
      assert.equal(chosen.model, "auto");
      assert.equal(chosen.enabled, true);
      assert.equal(
        (
          (await (
            await fetch(`http://127.0.0.1:${daemon.port}/v1/providers`, { headers })
          ).json()) as { providers: { id: string; enabled: boolean }[] }
        ).providers
          .filter((provider) => provider.enabled)
          .map((provider) => provider.id)
          .join(","),
        "tavily-search,raven",
        "both services are chosen at once",
      );
      const badAddress = await fetch(`http://127.0.0.1:${daemon.port}/v1/providers/raven`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ baseUrl: "127.0.0.1:7024" }),
      });
      assert.equal(badAddress.status, 400);
      const searchOverride = await fetch(
        `http://127.0.0.1:${daemon.port}/v1/providers/tavily-search`,
        { method: "PUT", headers, body: JSON.stringify({ model: "x" }) },
      );
      assert.equal(searchOverride.status, 400, "a search provider has no model to override");
    } finally {
      await daemon.close();
    }
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    await rm(root, { recursive: true, force: true });
    await rm(configHome, { recursive: true, force: true });
  }
});

// The two core prompts cross the composition root: the file is read from the machine, and the
// standing instruction is stored and reported back (docs/bots/PRODUCT.md, "Core prompts").
test("the daemon reads the machine prompt and saves the core prompt", async () => {
  const root = await daemonRoot("bots-core-prompt-");
  const machineFile = join(root, "machine-AGENTS.md");
  await writeFile(machineFile, "# 机器规则\n\n始终先跑测试。");
  const previous = process.env.BOTS_MACHINE_AGENTS;
  process.env.BOTS_MACHINE_AGENTS = machineFile;
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
      const initial = (await (await authorized("/v1/settings")).json()) as {
        settings: { corePrompt: string; toolGroups: string[] };
        machinePrompt: { path: string; text: string } | null;
      };
      assert.equal(initial.settings.corePrompt, DEFAULT_CORE_PROMPT);
      assert.deepEqual(initial.settings.toolGroups.slice(0, 2), ["persona", "machine"]);
      assert.equal(initial.machinePrompt?.text.includes("始终先跑测试。"), true);

      const saved = (await (
        await authorized("/v1/settings", {
          method: "PUT",
          body: JSON.stringify({ corePrompt: "  只说结论。 " }),
        })
      ).json()) as { settings: { corePrompt: string } };
      assert.equal(saved.settings.corePrompt, "只说结论。");
      assert.equal((await readGateway(root))?.corePrompt, "只说结论。");

      const tooLong = await authorized("/v1/settings", {
        method: "PUT",
        body: JSON.stringify({ corePrompt: "字".repeat(4_001) }),
      });
      assert.equal(tooLong.status, 400, "an oversized instruction is refused");
    } finally {
      await daemon.close();
    }
  } finally {
    if (previous === undefined) delete process.env.BOTS_MACHINE_AGENTS;
    else process.env.BOTS_MACHINE_AGENTS = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("the daemon mounts the secret routes and keeps the store out of the way", async () => {
  const root = await daemonRoot("bots-main-secrets-");
  const home = await mkdtemp(join(tmpdir(), "bots-main-secrets-home-"));
  try {
    const config = readConfig({
      argv: ["--root", root, "--port", "0"],
      env: {
        BOTS_SECRETS_DIR: join(home, "config"),
        BOTS_SECRETS_KEY: join(home, "state", "secrets.key"),
      },
    });
    const daemon = await startDaemon(config);
    try {
      const authorized = async (path: string, init: RequestInit = {}) =>
        fetch(`http://127.0.0.1:${daemon.port}${path}`, {
          ...init,
          headers: {
            authorization: `Bearer ${daemon.token}`,
            "content-type": "application/json",
            ...(init.headers ?? {}),
          },
        });
      const listed = await authorized("/v1/secrets");
      assert.equal(listed.status, 200);
      assert.deepEqual(((await listed.json()) as { secrets: unknown[] }).secrets, []);

      const revealed = await authorized("/v1/secrets/reveal", {
        method: "POST",
        body: JSON.stringify({ key: "absent", scope: "bot" }),
      });
      assert.equal(revealed.status, 404, "an unknown record is not a secret");

      const removed = await authorized("/v1/secrets/bot/absent", { method: "DELETE" });
      assert.equal(removed.status, 404);

      // The settings page is the only place a value comes back, and it needs the admin scope.
      const issued = (await (
        await authorized("/v1/clients", {
          method: "POST",
          body: JSON.stringify({ name: "reader", scopes: ["read"] }),
        })
      ).json()) as { token: string };
      const refused = await authorized("/v1/secrets/reveal", {
        method: "POST",
        body: JSON.stringify({ key: "absent", scope: "bot" }),
        headers: { authorization: `Bearer ${issued.token}` },
      });
      assert.equal(refused.status, 403);
    } finally {
      assert.equal(await daemon.close(), "closed");
    }
    // Nothing was stored, so the store wrote nothing: the key file is created on demand.
    await assert.rejects(readFile(join(home, "state", "secrets.key"), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
