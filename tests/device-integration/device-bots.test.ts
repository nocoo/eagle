import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import WebSocket from "ws";
import { canonicalDeviceJSON } from "../../packages/contracts/src/devices.ts";

type JSONRecord = Record<string, unknown>;
type Directory = {
  localDeviceId: string;
  groupId: string | null;
  devices: {
    deviceId: string;
    online: boolean | null;
    policy: { mode: string } | null;
  }[];
};
type Receipt = {
  operationId: string;
  targetDeviceId: string;
  status: string;
  output?: string;
  error?: string;
};

// Deliberately outside tests/*.test.ts: candidate acceptance installs the two
// products independently before invoking this suite. No Bots imports in root.
// A source override lets an isolated test worktree exercise an integrated Bot
// commit read-only; the ordinary command always uses this checkout's product.
const botsSource = resolve(
  process.env.EAGLE_BOTS_INTEGRATION_SOURCE ?? "apps/bots",
);
const childEnv = (home: string): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: home,
    NODE_OPTIONS: "",
    NODE_PATH: "",
  };
  for (const name of Object.keys(environment))
    if (!["HOME", "PATH", "TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(name))
      delete environment[name];
  return environment;
};

async function until<T>(
  probe: () => Promise<T | undefined>,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 12000;
  do {
    const value = await probe();
    if (value !== undefined) return value;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error(`timeout waiting for ${label}`);
}

function processPort(file: string, root: string) {
  const child = spawn(process.execPath, [file], {
    cwd: resolve("."),
    env: childEnv(root),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = createInterface({ input: child.stdout });
  const messages: JSONRecord[] = [];
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (text: string) => {
    stderr = (stderr + text).slice(-12000);
  });
  let onMessage: ((message: JSONRecord) => void) | undefined;
  reader.on("line", (line) => {
    const message = JSON.parse(line) as JSONRecord;
    messages.push(message);
    onMessage?.(message);
  });
  return {
    child,
    send(value: unknown) {
      child.stdin.write(`${JSON.stringify(value)}\n`);
    },
    handle(handler: (message: JSONRecord) => void) {
      onMessage = handler;
    },
    async message(predicate: (message: JSONRecord) => boolean) {
      return until(async () => {
        const index = messages.findIndex(predicate);
        if (index >= 0) return messages.splice(index, 1)[0];
        assert.equal(
          child.exitCode,
          null,
          `child exited before response: ${stderr}`,
        );
        return undefined;
      }, "child response");
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((done) =>
          child.once("exit", () => done()),
        );
        child.stdin.end();
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        try {
          await exited;
        } finally {
          clearTimeout(timer);
        }
      }
      reader.close();
      assert.equal(
        child.exitCode,
        0,
        `child did not shut down normally: ${stderr}`,
      );
    },
  };
}

function deviceProcess(root: string, baseUrl: string) {
  mkdirSync(root, { mode: 0o700 });
  const keys = generateKeyPairSync("ed25519");
  const deviceId = randomUUID();
  const publicKey = keys.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64url");
  const socketPath = join(root, "access.sock");
  const process = processPort(
    resolve("packages/agent/device-service.ts"),
    root,
  );
  process.handle((message) => {
    if (message.type !== "sign") return;
    const payload = String(message.payload);
    const fields = payload.split("\n");
    assert.deepEqual(fields.slice(0, 4), [
      "eagle-device-register-v1",
      baseUrl,
      deviceId,
      publicKey,
    ]);
    assert.equal(fields.length, 7);
    process.send({
      type: "signature",
      requestId: message.requestId,
      signature: sign(null, Buffer.from(payload), keys.privateKey).toString(
        "base64url",
      ),
    });
  });
  process.send({
    type: "configure",
    version: 1,
    baseUrl,
    deviceId,
    publicKey,
    name: `Device ${deviceId.slice(0, 4)}`,
    platform: "darwin",
    arch: "arm64",
    stateDirectory: root,
    socketPath,
  });
  return {
    ...process,
    root,
    deviceId,
    socketPath,
    async ready(expectedCloud = "online") {
      await process.message((message) => message.type === "ready");
      await process.message(
        (message) =>
          message.type === "cloud" && message.status === expectedCloud,
      );
    },
    async manage(method: string, params?: unknown) {
      const requestId = randomUUID();
      const remote =
        method.startsWith("pairing.") ||
        method === "member.remove" ||
        (method === "policy.set" &&
          params &&
          typeof params === "object" &&
          "deviceId" in params &&
          params.deviceId !== deviceId);
      const routed =
        remote && baseUrl
          ? {
              ...(params as object | undefined),
              relayOrigin: new URL(baseUrl).origin,
            }
          : params;
      process.send({ type: "manage", requestId, method, params: routed });
      const reply = await process.message(
        (message) =>
          message.type === "managed" && message.requestId === requestId,
      );
      assert.equal(reply.error, undefined, "trusted management request failed");
      return reply.result as JSONRecord;
    },
  };
}

async function localCall(
  path: string,
  method: string,
  params?: unknown,
): Promise<unknown> {
  const socket = connect(path);
  const reader = createInterface({ input: socket });
  try {
    return await new Promise((done, reject) => {
      socket.once("error", reject);
      socket.setTimeout(5000, () => reject(new Error("local port timeout")));
      reader.once("line", (line) => {
        const reply = JSON.parse(line) as JSONRecord;
        if (reply.error) reject(new Error("local port rejected request"));
        else done(reply.result);
      });
      socket.write(
        `${JSON.stringify({ version: 2, requestId: randomUUID(), method, ...(params === undefined ? {} : { params }) })}\n`,
      );
    });
  } finally {
    reader.close();
    socket.destroy();
  }
}

async function workerFixture(directory: string) {
  // Only a test transport fault: the real target finishes and the real relay
  // authorizes its result, then the caller loses that one response. No executor,
  // registry, SDK or device-port implementation is replaced.
  writeFileSync(
    join(directory, "entry.ts"),
    `
import worker,{DeviceRegistry,DeviceExecution as Execution} from "../../apps/web/src/worker/device-service.ts";
export {DeviceRegistry};
export class DeviceExecution extends Execution {
 respond(socket,request,result,unauthorized=false) {
  if(request.action==='run'&&request.operation?.command?.includes('device-integration-drop-response')&&result.status==='completed') {
   socket.close(1011,'test_response_lost');return;
  }
  return super.respond(socket,request,result,unauthorized);
 }
}
let directoryReads = 0;
export default {
 fetch(request,env,ctx) {
  const path = new URL(request.url).pathname;
  if(path==='/__test/directory-count') return new Response(String(directoryReads));
  if(path==='/api/devices/v1/directory') directoryReads++;
  return worker.fetch(request,env,ctx);
 }
};
`,
  );
  execFileSync(
    resolve("node_modules/.bin/wrangler"),
    [
      "deploy",
      join(directory, "entry.ts"),
      "--dry-run",
      "--config",
      "apps/web/wrangler.devices.example.jsonc",
      "--outdir",
      join(directory, "worker"),
    ],
    { stdio: "pipe" },
  );
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "eagle",
          modules: true,
          scriptPath: join(directory, "worker/entry.js"),
          compatibilityDate: "2026-09-19",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: {
            DEVICE_REGISTRY: { className: "DeviceRegistry", useSQLite: true },
            DEVICE_EXECUTION: { className: "DeviceExecution", useSQLite: true },
          },
          bindings: { BUILD_REVISION: "local-device-integration" },
        },
      ],
    }),
  );
  try {
    return { mf, origin: (await mf.ready).origin };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}

type ModelStep = ({ name: string; args: JSONRecord } | { text: string }) & {
  remote?: boolean;
};
async function modelFixture(key: string) {
  const steps: ModelStep[] = [];
  const failures: string[] = [];
  let requests = 0;
  let reflectionRequests = 0;
  const sessions = new Map<string, "root" | "reflection">();
  const server = createServer(async (request, response) => {
    try {
      assert.equal(
        request.headers.authorization === `Bearer ${key}`,
        true,
        "local model authentication",
      );
      assert.equal(request.url, "/v1/responses");
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body) as {
        tools: { name: string }[];
        prompt_cache_key: string;
      };
      assert.equal(typeof input.prompt_cache_key, "string");
      assert(
        input.prompt_cache_key.length > 0,
        "model session identity is required",
      );
      const kind =
        sessions.get(input.prompt_cache_key) ??
        (input.tools.length === 1 && input.tools[0]?.name === "note_set"
          ? "reflection"
          : "root");
      sessions.set(input.prompt_cache_key, kind);
      const step =
        kind === "reflection"
          ? { text: "No status update needed." }
          : steps.shift();
      assert(step, "unexpected root model request");
      if (kind === "reflection") reflectionRequests++;
      else requests++;
      if ("remote" in step && step.remote !== undefined) {
        const offered = input.tools
          .filter((tool) => tool.name.startsWith("remote_"))
          .map((tool) => tool.name)
          .sort();
        assert.deepEqual(
          offered,
          step.remote
            ? ["remote_execute", "remote_operation", "remote_status"]
            : [],
        );
      }
      const id = `resp_${requests + reflectionRequests}`;
      const event = (type: string, fields: object) =>
        `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
      const item =
        "name" in step
          ? {
              type: "function_call",
              id: `fc_${requests}`,
              call_id: `call_${requests}`,
              name: step.name,
              arguments: JSON.stringify(step.args),
              status: "completed",
            }
          : {
              type: "message",
              id: `msg_${requests}`,
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: step.text, annotations: [] },
              ],
            };
      if ("name" in step)
        assert(
          input.tools.some((tool) => tool.name === step.name),
          `SDK did not offer ${step.name}`,
        );
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        event("response.created", { response: { id, status: "in_progress" } }),
      );
      response.write(
        event("response.output_item.added", {
          output_index: 0,
          item:
            "name" in step
              ? { ...item, arguments: "", status: "in_progress" }
              : { ...item, content: [] },
        }),
      );
      if ("name" in step)
        response.write(
          event("response.function_call_arguments.delta", {
            output_index: 0,
            delta: JSON.stringify(step.args),
          }),
        );
      else
        response.write(
          event("response.output_text.delta", {
            output_index: 0,
            content_index: 0,
            delta: step.text,
          }),
        );
      response.write(
        event("response.output_item.done", { output_index: 0, item }),
      );
      response.end(
        event("response.completed", {
          response: {
            id,
            status: "completed",
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        }),
      );
    } catch (error) {
      failures.push(
        error instanceof Error ? error.message : "model fixture failure",
      );
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    failures,
    script(name: string, args: JSONRecord, remote?: boolean) {
      steps.push(
        { name, args, ...(remote === undefined ? {} : { remote }) },
        { text: "done", ...(remote === undefined ? {} : { remote }) },
      );
    },
    verify(expectedReflections = 9) {
      assert.deepEqual(failures, []);
      assert.equal(steps.length, 0);
      assert.equal(
        reflectionRequests,
        expectedReflections,
        "each completed tool round reflects exactly once",
      );
      return requests;
    },
  };
}

async function daemonProcess(
  root: string,
  socketPath: string,
  baseUrl: string,
  key: string,
) {
  mkdirSync(root, { mode: 0o700 });
  const script = join(root, "daemon.mjs");
  writeFileSync(
    script,
    `
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
const input=createInterface({input:process.stdin});
const lines=input[Symbol.asyncIterator]();
const config=JSON.parse((await lines.next()).value);
Object.assign(process.env,{BOTS_BASE_URL:config.baseUrl,BOTS_API_KEY:config.key,BOTS_PROVIDER:'device-local',BOTS_MODEL:'scripted-local',BOTS_THINKING_LEVEL:'off',BOTS_TOOL_GROUPS:'core',BOTS_COMPACTION:'off'});
const {readConfig}=await import(pathToFileURL(config.source+'/src/config.ts').href);
const {startDaemon}=await import(pathToFileURL(config.source+'/src/main.ts').href);
const daemon=await startDaemon(readConfig({argv:['--root',config.root,'--port','0'],env:{BOTS_DEVICE_SOCKET:config.socketPath}}));
process.stdout.write(JSON.stringify({type:'ready',port:daemon.port})+'\\n');
await lines.next();
await daemon.close();
input.close();
`,
  );
  const daemon = processPort(script, root);
  // Private test configuration arrives on stdin, never argv or the inherited environment.
  try {
    daemon.send({ source: botsSource, root, socketPath, baseUrl, key });
    const ready = await daemon.message((message) => message.type === "ready");
    const token = readFileSync(join(root, "token"), "utf8").trim();
    const origin = `http://127.0.0.1:${ready.port}`;
    return {
      ...daemon,
      origin,
      token,
      async createBot(title: string) {
        const response = await fetch(`${origin}/v1/bots`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ title }),
        });
        assert.equal(response.status, 201);
        return ((await response.json()) as { bot: { id: string } }).bot.id;
      },
    };
  } catch (error) {
    try {
      await daemon.stop();
    } catch (shutdownError) {
      throw new AggregateError(
        [error, shutdownError],
        "daemon startup and cleanup failed",
      );
    }
    throw error;
  }
}

async function botConnection(origin: string, token: string, botId: string) {
  const socket = new WebSocket(`${origin.replace("http", "ws")}/v1/socket`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const messages: JSONRecord[] = [];
  socket.on("message", (bytes) =>
    messages.push(JSON.parse(bytes.toString()) as JSONRecord),
  );
  const frame = (type: string) =>
    until(async () => {
      const index = messages.findIndex((message) => message.type === type);
      return index < 0 ? undefined : messages.splice(index, 1)[0];
    }, `Bots ${type}`);
  await new Promise<void>((done, reject) => {
    socket.once("open", done);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      client: "device-integration",
    }),
  );
  await frame("welcome");
  socket.send(
    JSON.stringify({
      type: "subscribe",
      botId,
      trace: `tr_sub_${randomUUID()}`,
    }),
  );
  await frame("snapshot");
  return {
    socket,
    async run(
      name: string,
      model: Awaited<ReturnType<typeof modelFixture>>,
      args: JSONRecord = {},
    ) {
      messages.length = 0;
      model.script(name, args);
      const requestId = `r_${randomUUID()}`;
      socket.send(
        JSON.stringify({
          type: "send",
          requestId,
          text: `Integration: ${name}`,
          whenBusy: "followUp",
          trace: `tr_run_${randomUUID()}`,
        }),
      );
      await until(
        async () =>
          messages.some(
            (message) =>
              message.type === "submission" &&
              message.requestId === requestId &&
              ["done", "unanswered"].includes(String(message.status)),
          )
            ? true
            : undefined,
        `Bot ${name} settlement`,
      );
      assert.deepEqual(model.failures, []);
      const settled = messages.find(
        (message) =>
          message.type === "submission" &&
          message.requestId === requestId &&
          message.status === "done",
      );
      assert(settled, `SDK submission failed for ${name}`);
      const rows = messages
        .filter((message) => message.type === "append")
        .flatMap(
          (message) =>
            (
              message.message as {
                role: string;
                blocks: {
                  type: string;
                  name: string;
                  text: string;
                  isError: boolean;
                }[];
              }
            ).blocks,
        );
      const result = rows.find(
        (block) => block.type === "toolResult" && block.name === name,
      );
      assert(result, `missing actual SDK tool result for ${name}`);
      return {
        value: JSON.parse(result.text) as JSONRecord,
        isError: result.isError,
      };
    },
  };
}

async function closeServer(server: Server) {
  await new Promise<void>((done) => {
    server.close(() => done());
    server.closeAllConnections();
  });
}

async function runCli(
  executable: string,
  args: string[],
  root: string,
  origin: string,
  token: string,
): Promise<string> {
  const child = spawn(executable, args, {
    cwd: root,
    env: {
      ...childEnv(root),
      EAGLE_ROOT: root,
      EAGLE_PORT: new URL(origin).port,
      EAGLE_TOKEN: token,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let error = "";
  child.stdout
    .setEncoding("utf8")
    .on("data", (text: string) => (output += text));
  child.stderr
    .setEncoding("utf8")
    .on("data", (text: string) => (error += text));
  const exit = await new Promise<number | null>((done, reject) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      done(code);
    });
  });
  assert.equal(exit, 0, `CLI failed: ${error}`);
  return output;
}

test("CLI drives local Bot tools without a configured remote", {
  timeout: 90000,
}, async () => {
  const swiftEnv = {
    ...process.env,
    DEVELOPER_DIR:
      process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer",
  };
  const macos = resolve("apps/macos");
  execFileSync("swift", ["build", "--product", "eagle-cli"], {
    cwd: macos,
    env: swiftEnv,
    stdio: "pipe",
    timeout: 60000,
    killSignal: "SIGKILL",
  });
  const bin = execFileSync("swift", ["build", "--show-bin-path"], {
    cwd: macos,
    env: swiftEnv,
    encoding: "utf8",
    timeout: 10000,
    killSignal: "SIGKILL",
  }).trim();
  const cli = join(bin, "eagle-cli");
  const root = mkdtempSync("/tmp/eagle-device-cli-");
  const key = randomBytes(32).toString("base64url");
  let model: Awaited<ReturnType<typeof modelFixture>> | undefined;
  let device: ReturnType<typeof deviceProcess> | undefined;
  let daemon: Awaited<ReturnType<typeof daemonProcess>> | undefined;
  let failure: unknown;
  try {
    model = await modelFixture(key);
    device = deviceProcess(join(root, "device"), "");
    await device.ready("unconfigured");
    await device.manage("policy.set", { mode: "paused" });
    daemon = await daemonProcess(
      join(root, "bots"),
      device.socketPath,
      model.baseUrl,
      key,
    );
    const created = JSON.parse(
      await runCli(
        cli,
        ["bots", "create", "--title", "Local health", "--json"],
        root,
        daemon.origin,
        daemon.token,
      ),
    ) as { bot: { id: string } };
    const deniedPath = join(root, "denied");
    model.script(
      "bash",
      { command: `printf forbidden > '${deniedPath}'` },
      false,
    );
    const denied = await runCli(
      cli,
      [
        "chat",
        "send",
        created.bot.id,
        "--text",
        "Check this computer",
        "--wait",
        "--json",
      ],
      root,
      daemon.origin,
      daemon.token,
    );
    assert.match(denied, /device_access_paused/);
    assert.equal(existsSync(deniedPath), false);
    await device.manage("policy.set", { mode: "all-approve" });
    const resultPath = join(root, "local-result");
    model.script(
      "bash",
      { command: `printf local-ok > '${resultPath}'` },
      false,
    );
    const accepted = await runCli(
      cli,
      [
        "chat",
        "send",
        created.bot.id,
        "--text",
        "Check this computer again",
        "--wait",
        "--json",
      ],
      root,
      daemon.origin,
      daemon.token,
    );
    assert.match(accepted, /"name":"bash"/);
    assert.equal(readFileSync(resultPath, "utf8"), "local-ok");
    for (const [baseUrl, offered] of [
      ["http://127.0.0.1:1", true],
      ["", false],
    ] as const) {
      await device.manage("remote.configure", { baseUrl });
      const marker = join(root, offered ? "configured" : "disabled");
      model.script("bash", { command: `printf local > '${marker}'` }, offered);
      await runCli(
        cli,
        [
          "chat",
          "send",
          created.bot.id,
          "--text",
          "Check this computer",
          "--wait",
          "--json",
        ],
        root,
        daemon.origin,
        daemon.token,
      );
      assert.equal(readFileSync(marker, "utf8"), "local");
    }
    model.verify(4);
  } catch (error) {
    failure = error;
  }
  const results = await Promise.allSettled([
    daemon?.stop(),
    device?.stop(),
    model ? closeServer(model.server) : undefined,
  ]);
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    errors.push(error);
  }
  if (failure !== undefined) errors.unshift(failure);
  if (model?.failures.length) errors.push(new Error(model.failures.join("; ")));
  if (errors.length)
    throw new AggregateError(errors, "device CLI acceptance failed");
});

test("remote operations skip discarded directory reads but still enforce live membership", {
  timeout: 90000,
}, async () => {
  mkdirSync(".local", { recursive: true });
  const workerRoot = mkdtempSync(resolve(".local/device-dispatch-worker-"));
  const root = mkdtempSync("/tmp/eagle-device-dispatch-");
  let worker: Awaited<ReturnType<typeof workerFixture>> | undefined;
  let a: ReturnType<typeof deviceProcess> | undefined;
  let b: ReturnType<typeof deviceProcess> | undefined;
  let failure: unknown;
  try {
    worker = await workerFixture(workerRoot);
    a = deviceProcess(join(root, "a"), worker.origin);
    b = deviceProcess(join(root, "b"), worker.origin);
    await Promise.all([a.ready(), b.ready()]);
    await b.manage("policy.set", { mode: "all-approve" });
    const invitation = await a.manage("pairing.create", {});
    await b.manage("pairing.redeem", {
      requestId: randomUUID(),
      code: invitation.code,
    });
    const source = a;
    const target = b;
    const relay = worker.origin;
    await until(async () => {
      const directory = (await localCall(
        source.socketPath,
        "directory",
      )) as Directory;
      const peer = directory.devices.find(
        (device) => device.deviceId === target.deviceId,
      );
      return peer?.online && peer.policy?.mode === "all-approve"
        ? true
        : undefined;
    }, "remote target observation");
    const directoryReads = async () =>
      Number(await (await fetch(`${relay}/__test/directory-count`)).text());
    const before = await directoryReads();
    assert(before > 0);
    const operation = { kind: "command", command: "printf on-target" };
    const request = {
      requestId: randomUUID(),
      operationId: randomUUID(),
      targetDeviceId: target.deviceId,
      action: "run",
      operation,
      digest: createHash("sha256")
        .update(canonicalDeviceJSON(operation))
        .digest("hex"),
      relayOrigin: relay,
    };
    const completed = (await localCall(
      source.socketPath,
      "execute",
      request,
    )) as Receipt;
    assert.equal(completed.status, "completed");
    assert.equal(completed.output, "on-target");
    assert.equal(
      await directoryReads(),
      before,
      "run fetched an unused directory",
    );
    const query = (await localCall(source.socketPath, "operation.get", {
      requestId: randomUUID(),
      operationId: request.operationId,
      targetDeviceId: target.deviceId,
      action: "get",
    })) as Receipt;
    assert.equal(query.status, "completed");
    assert.equal(
      await directoryReads(),
      before,
      "get fetched an unused directory",
    );
    const cancelled = (await localCall(source.socketPath, "operation.cancel", {
      requestId: randomUUID(),
      operationId: request.operationId,
      targetDeviceId: target.deviceId,
      action: "cancel",
    })) as Receipt;
    assert.equal(cancelled.status, "completed");
    assert.equal(
      await directoryReads(),
      before,
      "cancel fetched an unused directory",
    );
    await source.manage("member.remove", { deviceId: target.deviceId });
    const marker = join(target.root, "revoked-write");
    const forbidden = {
      kind: "file.write",
      path: marker,
      content: "forbidden",
    };
    const denied = (await localCall(source.socketPath, "execute", {
      requestId: randomUUID(),
      operationId: randomUUID(),
      targetDeviceId: target.deviceId,
      action: "run",
      operation: forbidden,
      relayOrigin: relay,
      digest: createHash("sha256")
        .update(canonicalDeviceJSON(forbidden))
        .digest("hex"),
    })) as Receipt;
    assert.equal(denied.status, "denied");
    assert.equal(existsSync(marker), false);
    assert.equal(
      await directoryReads(),
      before,
      "revoked run fetched an unused directory",
    );
  } catch (error) {
    failure = error;
  }
  const cleaned = await Promise.allSettled([
    a?.stop(),
    b?.stop(),
    worker?.mf.dispose(),
  ]);
  const errors = cleaned.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  for (const path of [workerRoot, root]) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (failure !== undefined) errors.unshift(failure);
  if (errors.length)
    throw new AggregateError(errors, "device dispatch test failed");
});

test("relay changes cannot move pairing or policy IDs to another service", {
  timeout: 90000,
}, async () => {
  mkdirSync(".local", { recursive: true });
  const workerRoot = mkdtempSync(resolve(".local/device-origin-worker-"));
  const root = mkdtempSync("/tmp/eagle-device-origin-");
  let worker: Awaited<ReturnType<typeof workerFixture>> | undefined;
  let a: ReturnType<typeof deviceProcess> | undefined;
  let b: ReturnType<typeof deviceProcess> | undefined;
  let challengeSeen = () => {};
  const challenge = new Promise<void>((resolve) => {
    challengeSeen = resolve;
  });
  let forbiddenRequests = 0;
  let unexpectedAuthorization = false;
  const other = createServer((request, response) => {
    if (request.url?.includes("/register/challenge")) {
      unexpectedAuthorization ||= request.headers.authorization !== undefined;
      challengeSeen();
    }
    if (request.url?.includes("/pairings") || request.url?.endsWith("/policy"))
      forbiddenRequests++;
    response
      .writeHead(503, { "content-type": "application/json" })
      .end(JSON.stringify({ error: "offline" }));
  });
  let failure: unknown;
  try {
    await new Promise<void>((resolve, reject) => {
      other.once("error", reject);
      other.listen(0, "127.0.0.1", () => {
        other.off("error", reject);
        resolve();
      });
    });
    const address = other.address();
    assert(address && typeof address !== "string");
    const otherOrigin = `http://127.0.0.1:${address.port}`;
    worker = await workerFixture(workerRoot);
    a = deviceProcess(join(root, "a"), worker.origin);
    b = deviceProcess(join(root, "b"), worker.origin);
    await Promise.all([a.ready(), b.ready()]);
    const invitation = await b.manage("pairing.create", {});
    const pairingId = randomUUID();
    const prepared = await a.manage("pairing.prepare", {
      requestId: pairingId,
      codeHash: createHash("sha256")
        .update(String(invitation.code))
        .digest("hex"),
    });
    assert.equal(prepared.prepared, true);
    const lookupId = randomUUID();
    a.send({
      type: "manage",
      requestId: lookupId,
      method: "pairing.result",
      params: { requestId: pairingId, relayOrigin: worker.origin },
    });
    const lookup: Record<string, unknown> = await a.message(
      (message) => message.type === "managed" && message.requestId === lookupId,
    );
    assert.equal(lookup.error, "result_not_found");
    await a.manage("pairing.redeem", {
      requestId: pairingId,
      code: invitation.code,
    });
    const policyId = randomUUID();
    await a.manage("policy.set", {
      deviceId: b.deviceId,
      mode: "paused",
      requestId: policyId,
    });
    await a.manage("remote.configure", { baseUrl: otherOrigin });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      challenge,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("other relay timeout")),
          5000,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    for (const [method, params, expected] of [
      [
        "pairing.result",
        { requestId: pairingId, relayOrigin: worker.origin },
        "remote_configuration_changed",
      ],
      [
        "pairing.redeem",
        {
          requestId: pairingId,
          code: invitation.code,
          relayOrigin: otherOrigin,
        },
        "relay_origin_mismatch",
      ],
      [
        "policy.set",
        {
          deviceId: b.deviceId,
          mode: "paused",
          requestId: policyId,
          relayOrigin: otherOrigin,
        },
        "relay_origin_mismatch",
      ],
    ] as const) {
      const requestId = randomUUID();
      a.send({ type: "manage", requestId, method, params });
      const result: Record<string, unknown> = await a.message(
        (message) =>
          message.type === "managed" && message.requestId === requestId,
      );
      assert.equal(result.error, expected, method);
    }
    assert.equal(forbiddenRequests, 0);
    assert.equal(unexpectedAuthorization, false);
    await a.manage("remote.configure", { baseUrl: worker.origin });
    await until(async () => {
      const status = (await localCall(a?.socketPath ?? "", "status")) as {
        cloudStatus: string;
      };
      return status.cloudStatus === "online" ? true : undefined;
    }, "original relay reconnection");
    const recovered = await a.manage("pairing.result", {
      requestId: pairingId,
    });
    assert.equal(recovered.requestId, pairingId);
    assert.equal(
      (recovered.directory as { relayOrigin: string }).relayOrigin,
      worker.origin,
    );
  } catch (error) {
    failure = error;
  }
  const cleaned = await Promise.allSettled([
    a?.stop(),
    b?.stop(),
    worker?.mf.dispose(),
    closeServer(other),
  ]);
  const errors = cleaned.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  for (const path of [workerRoot, root]) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (failure !== undefined) errors.unshift(failure);
  if (errors.length)
    throw new AggregateError(errors, "device origin test failed");
});

test("existing and new Bots share real paired devices, native tools and original remote operation IDs", {
  timeout: 90000,
}, async () => {
  mkdirSync(".local", { recursive: true });
  const workerRoot = mkdtempSync(resolve(".local/device-bots-worker-"));
  const root = mkdtempSync("/tmp/eagle-device-bots-");
  const key = randomBytes(32).toString("base64url");
  const model = await modelFixture(key);
  let worker: Awaited<ReturnType<typeof workerFixture>> | undefined;
  let a: ReturnType<typeof deviceProcess> | undefined;
  let b: ReturnType<typeof deviceProcess> | undefined;
  let daemon: Awaited<ReturnType<typeof daemonProcess>> | undefined;
  const clients: Awaited<ReturnType<typeof botConnection>>[] = [];
  let stopped = false;
  try {
    worker = await workerFixture(workerRoot);
    a = deviceProcess(join(root, "a"), worker.origin);
    b = deviceProcess(join(root, "b"), worker.origin);
    await Promise.all([a.ready(), b.ready()]);
    for (const device of [a, b]) {
      assert.equal((await device.manage("policy.get")).mode, "always-ask");
      assert.equal(
        (await device.manage("policy.set", { mode: "all-approve" })).mode,
        "all-approve",
      );
    }
    daemon = await daemonProcess(
      join(root, "bots"),
      a.socketPath,
      model.baseUrl,
      key,
    );
    const health = (await fetch(`${daemon.origin}/v1/health`).then((response) =>
      response.json(),
    )) as { deviceAccess: { version: number } };
    assert.equal(health.deviceAccess.version, 2);
    const existingId = await daemon.createBot("Existing before pairing");
    const existing = await botConnection(
      daemon.origin,
      daemon.token,
      existingId,
    );
    clients.push(existing);
    const initial = await existing.run("remote_status", model);
    assert.equal(initial.isError, false);
    assert.deepEqual(
      (initial.value as unknown as Directory).devices.map(
        (device) => device.deviceId,
      ),
      [a.deviceId],
    );
    const invitation = await a.manage("pairing.create", {});
    await b.manage("pairing.redeem", {
      requestId: randomUUID(),
      code: invitation.code,
    });
    await until(async () => {
      const directory = (await localCall(
        a?.socketPath ?? "",
        "directory",
      )) as Directory;
      return directory.devices.length === 2 &&
        directory.devices.every(
          (device) =>
            device.online === true && device.policy?.mode === "all-approve",
        )
        ? directory
        : undefined;
    }, "paired Agent observations");
    const newlyCreatedId = await daemon.createBot("New after pairing");
    const newlyCreated = await botConnection(
      daemon.origin,
      daemon.token,
      newlyCreatedId,
    );
    clients.push(newlyCreated);
    const oldDirectory = (await existing.run("remote_status", model))
      .value as unknown as Directory;
    const newDirectory = (await newlyCreated.run("remote_status", model))
      .value as unknown as Directory;
    assert.equal(oldDirectory.groupId, newDirectory.groupId);
    assert.deepEqual(
      oldDirectory.devices.map((device) => device.deviceId).sort(),
      [a.deviceId, b.deviceId].sort(),
    );
    assert.deepEqual(
      newDirectory.devices.map((device) => device.deviceId).sort(),
      [a.deviceId, b.deviceId].sort(),
    );
    const execute = async (client: typeof existing, suffix: string) => {
      const result = await client.run("remote_execute", model, {
        deviceId: b?.deviceId,
        operation: {
          kind: "command",
          command: `printf ${suffix} >> remote-count; printf remote-${suffix}`,
          cwd: b?.root,
        },
      });
      assert.equal(
        result.isError,
        false,
        "real SDK accepts the device receipt",
      );
      const receipt = result.value as unknown as Receipt;
      assert.equal(receipt.targetDeviceId, b?.deviceId);
      assert.equal(receipt.status, "completed");
      assert.equal(receipt.output, `remote-${suffix}`);
      return receipt;
    };
    const first = await execute(existing, "a");
    const local = await existing.run("bash", model, {
      command: "printf native-ok",
    });
    assert.equal(
      local.isError,
      false,
      "normal native SDK tool passes through local.begin/complete",
    );
    const native = local.value as unknown as Receipt;
    assert.equal(native.targetDeviceId, a.deviceId);
    assert.equal(native.status, "completed");
    assert.match(native.output ?? "", /native-ok/);
    const second = await execute(newlyCreated, "b");
    assert.equal(readFileSync(join(b.root, "remote-count"), "utf8"), "ab");
    assert.equal(existsSync(join(a.root, "remote-count")), false);
    const uncertain = await existing.run("remote_execute", model, {
      deviceId: b.deviceId,
      operation: {
        kind: "command",
        command:
          "printf x >> uncertain-count; printf finished-on-target # device-integration-drop-response",
        cwd: b.root,
      },
    });
    const original = uncertain.value as unknown as Receipt;
    assert.equal(
      original.status,
      "unknown",
      "lost relay response remains uncertain",
    );
    assert.equal(original.targetDeviceId, b.deviceId);
    assert.equal(uncertain.isError, true);
    const recovered = await newlyCreated.run("remote_operation", model, {
      deviceId: b.deviceId,
      operationId: original.operationId,
      action: "get",
    });
    assert.equal(recovered.isError, false);
    const recoveredReceipt = recovered.value as unknown as Receipt;
    assert.equal(recoveredReceipt.operationId, original.operationId);
    assert.equal(recoveredReceipt.targetDeviceId, b.deviceId);
    assert.equal(recoveredReceipt.status, "completed");
    assert.equal(recoveredReceipt.output, "finished-on-target");
    assert.equal(readFileSync(join(b.root, "uncertain-count"), "utf8"), "x");
    await b.stop();
    await until(async () => {
      const directory = (await localCall(
        a?.socketPath ?? "",
        "directory",
      )) as Directory;
      return directory.devices.find((device) => device.deviceId === b?.deviceId)
        ?.online === false
        ? true
        : undefined;
    }, "real target disconnect");
    const forbiddenFile = join(root, "must-never-run-locally");
    const offline = await newlyCreated.run("remote_execute", model, {
      deviceId: b.deviceId,
      operation: {
        kind: "command",
        command: `printf unsafe > '${forbiddenFile}'`,
      },
    });
    const offlineReceipt = offline.value as unknown as Receipt;
    assert.equal(offline.isError, true);
    assert.equal(offlineReceipt.targetDeviceId, b.deviceId);
    assert.equal(offlineReceipt.status, "unknown");
    assert.equal(offlineReceipt.error, "target_offline_or_unknown");
    assert.equal(
      existsSync(forbiddenFile),
      false,
      "offline explicit target never executes locally",
    );
    assert.equal(
      model.verify(),
      18,
      "only the nine scripted tool rounds reached the local model",
    );
    for (const client of clients) client.socket.close();
    await daemon.stop();
    await a.stop();
    stopped = true;
    // Read the real journals after their exclusive process owners release them.
    const source = new DatabaseSync(join(a.root, "operations.sqlite"), {
      readOnly: true,
    });
    const target = new DatabaseSync(join(b.root, "operations.sqlite"), {
      readOnly: true,
    });
    try {
      const nativeRow = source
        .prepare("SELECT state,scope,native_blocked FROM operations WHERE id=?")
        .get(native.operationId) as {
        state: string;
        scope: string;
        native_blocked: number;
      };
      assert.equal(nativeRow.state, "succeeded");
      assert.equal(
        nativeRow.native_blocked,
        0,
        "normal native completion releases admission",
      );
      assert.equal(
        (JSON.parse(nativeRow.scope) as { sourceBotId: string }).sourceBotId,
        existingId,
      );
      for (const [receipt, botId] of [
        [first, existingId],
        [second, newlyCreatedId],
        [original, existingId],
      ] as const) {
        const row = target
          .prepare("SELECT state,scope FROM operations WHERE id=?")
          .get(receipt.operationId) as { state: string; scope: string };
        assert.equal(row.state, "succeeded");
        assert.deepEqual(JSON.parse(row.scope), {
          kind: "device",
          sourceDeviceId: a.deviceId,
          targetDeviceId: b.deviceId,
          sourceBotId: botId,
        });
        assert.equal(
          source
            .prepare("SELECT id FROM operations WHERE id=?")
            .get(receipt.operationId),
          undefined,
          "source never executed a remote operation",
        );
      }
    } finally {
      source.close();
      target.close();
    }
  } finally {
    for (const client of clients) client.socket.terminate();
    if (!stopped)
      await Promise.allSettled([daemon?.stop(), a?.stop(), b?.stop()]);
    await worker?.mf.dispose();
    await closeServer(model.server);
    rmSync(workerRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
