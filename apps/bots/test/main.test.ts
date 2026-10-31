// The composition root: one daemon over one root, wired from configuration, closed cleanly.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createSocketServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { readConfig } from "../src/config.ts";
import { startDaemon } from "../src/main.ts";
import { readGateway, writeGateway } from "../src/server/gateway.ts";
import { waitFor } from "./support/pi.ts";

test("close and SIGTERM start local cleanup while real private Self I/O is held", async (t) => {
  for (const mode of ["close", "SIGTERM"] as const)
    await t.test(mode, async () => {
      const root = await mkdtemp("/tmp/bots-self-close-");
      const socketPath = join(root, "device.sock");
      const sockets: Socket[] = [];
      const releases: (() => void)[] = [];
      let held!: () => void;
      const selfRequested = new Promise<void>((resolve) => {
        held = resolve;
      });
      const socketServer = createSocketServer((socket) => {
        sockets.push(socket);
        let text = "";
        socket.on("data", (bytes) => {
          text += bytes.toString();
          if (!text.includes("\n")) return;
          const request = JSON.parse(text.slice(0, text.indexOf("\n"))) as {
            requestId: string;
            method: string;
          };
          assert.equal(request.method, "sync.endpoints.self");
          releases.push(() =>
            socket.end(
              JSON.stringify({
                requestId: request.requestId,
                result: {
                  version: 1,
                  addresses: ["100.64.1.1"],
                  digest: createHash("sha256")
                    .update(JSON.stringify(["100.64.1.1"]))
                    .digest("hex"),
                },
              }) + "\n",
            ),
          );
          held();
        });
      });
      await new Promise<void>((resolve) => socketServer.listen(socketPath, resolve));
      await chmod(socketPath, 0o600);
      const script = join(root, "owned.mjs");
      await writeFile(
        script,
        `
import {createInterface} from 'node:readline';
import {readConfig} from ${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)};
import {startDaemon} from ${JSON.stringify(new URL("../src/main.ts", import.meta.url).href)};
const daemon=await startDaemon(readConfig({argv:['--root',${JSON.stringify(root)},'--port','0','--sync-port','0'],env:{BOTS_DEVICE_SOCKET:${JSON.stringify(socketPath)}}}));
console.log(JSON.stringify({port:daemon.port}));
for await(const line of createInterface({input:process.stdin})){
 if(line==='close'){await daemon.close();console.log(JSON.stringify({closed:true,ready:daemon.sync.status().ready}));break;}
}
`,
      );
      const child = spawn(
        process.execPath,
        mode === "SIGTERM"
          ? [
              new URL("../scripts/serve.ts", import.meta.url).pathname,
              "--root",
              root,
              "--port",
              "0",
              "--sync-port",
              "0",
            ]
          : [script],
        {
          env: { ...process.env, BOTS_DEVICE_SOCKET: socketPath },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const lines = createInterface({ input: child.stdout });
      let stderr = "";
      child.stderr.on("data", (bytes) => {
        stderr += bytes.toString();
      });
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      let cleanupStarted = false;
      try {
        const first = await lines[Symbol.asyncIterator]().next();
        const ready = JSON.parse(first.value as string) as { port: number };
        assert.equal((await fetch(`http://127.0.0.1:${ready.port}/v1/health`)).status, 200);
        await selfRequested;
        if (mode === "SIGTERM") child.kill("SIGTERM");
        else child.stdin.end("close\n");
        for (let i = 0; i < 50; i++) {
          try {
            await fetch(`http://127.0.0.1:${ready.port}/v1/health`);
          } catch {
            cleanupStarted = true;
            break;
          }
          await delay(10);
        }
      } finally {
        for (const release of releases) release();
        const code = await exited;
        lines.close();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => socketServer.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
        assert.equal(code, 0, stderr);
      }
      assert.equal(
        cleanupStarted,
        true,
        "local HTTP cleanup starts before releasing Self, within the original shutdown budget",
      );
    });
});

test("saved gateway credentials authorize model requests on every daemon boot", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-saved-gateway-"));
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

test("the daemon starts from configuration and closes without leaving work behind", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-main-"));
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
      await daemon.close();
    }
    // A second daemon on the same root is refused only while the first one lives; after a
    // close the lock is free again.
    const again = await startDaemon(readConfig({ argv: ["--root", root, "--port", "0"], env: {} }));
    await again.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("health identifies the configured shared device port even while that service is offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-device-health-"));
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
  const root = await mkdtemp(join(tmpdir(), "bots-levels-"));
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
  const root = await mkdtemp(join(tmpdir(), "bots-groups-"));
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
  const root = await mkdtemp(join(tmpdir(), "bots-usage-http-"));
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
  const root = await mkdtemp(join(tmpdir(), "bots-providers-http-"));
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
        ],
      );
      const unauthenticated = await fetch(`http://127.0.0.1:${daemon.port}/v1/providers`);
      assert.equal(unauthenticated.status, 401);
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
