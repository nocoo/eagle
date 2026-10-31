import assert from "node:assert/strict";
import {
  createCipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  verify,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import WebSocket from "ws";

import {
  SyncProofRequest,
  syncProofPayload,
} from "../../packages/contracts/src/device-sync.ts";

import {
  deviceProcess,
  localCall,
  processPort,
  until,
  workerFixture,
} from "./device-fixtures.ts";

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
type ModelStep = { name: string; args: JSONRecord } | { text: string };
async function modelFixture(key: string) {
  const steps: ModelStep[] = [];
  const failures: string[] = [];
  let requests = 0;
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
      const input = JSON.parse(body) as { tools: { name: string }[] };
      const step = steps.shift();
      assert(step, "unexpected model request");
      requests++;
      const id = `resp_${requests}`;
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
    script(name: string, args: JSONRecord) {
      steps.push({ name, args }, { text: "done" });
    },
    verify() {
      assert.deepEqual(failures, []);
      assert.equal(steps.length, 0);
      return requests;
    },
  };
}

async function daemonProcess(
  root: string,
  socketPath: string,
  baseUrl: string,
  key: string,
  owned: { listener?: boolean; peerPort?: number } = {},
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
const {PiDurableRuntime}=await import(pathToFileURL(config.source+'/src/runtime/pi/PiDurableRuntime.ts').href);
const {Harness}=await import(pathToFileURL(config.source+'/node_modules/@earendil-works/pi-durable/dist/index.js').href);
const originalOpen=Harness.open.bind(Harness);
let commitRemaining=0,releaseCommit;
Harness.open=async(...args)=>{
 const harness=await originalOpen(...args);const originalCommit=harness.commit.bind(harness);
 harness.commit=async(...params)=>{
  const result=await originalCommit(...params);
  if(commitRemaining>0&&--commitRemaining===0){
   process.stdout.write(JSON.stringify({type:'commitHeld'})+'\\n');
   await new Promise(resolve=>{releaseCommit=resolve;});
  }
  return result;
 };
 return harness;
};
const originalBinding=PiDurableRuntime.prototype.readReplicaBinding;
let bindingRemaining=0,releaseBinding;
PiDurableRuntime.prototype.readReplicaBinding=async function(spec){
 const result=await originalBinding.call(this,spec);
 if(bindingRemaining>0&&--bindingRemaining===0){
  process.stdout.write(JSON.stringify({type:'bindingHeld',botId:spec.id})+'\\n');
  await new Promise(resolve=>{releaseBinding=resolve;});
 }
 return result;
};
let dispatcher;
if(config.owned.peerPort){
 const {Agent,buildConnector,setGlobalDispatcher}=await import(pathToFileURL(config.repository+'/node_modules/undici/index.js').href);
 const connector=buildConnector({});
 dispatcher=new Agent({connect(options,callback){
  connector(options.hostname==='100.64.1.2'&&Number(options.port)===config.owned.peerPort?{...options,hostname:'127.0.0.1',host:'127.0.0.1'}:options,callback);
 }});
 setGlobalDispatcher(dispatcher);
}
const daemon=await startDaemon(readConfig({argv:['--root',config.root,'--port','0'],env:{BOTS_DEVICE_SOCKET:config.socketPath}}));
let ownedServer;
let syncPages=0;
let cutResponse;
let malformedResponse=false;
if(config.owned.listener){
 const {createServer}=await import('node:http');
 ownedServer=createServer((request,response)=>{
  if(request.url==='/v1/sync/page')syncPages++;
  if(request.url===cutResponse){
   if(malformedResponse){response.writeHead(200,{'content-type':'application/json'}).end('{');return;}
   response.writeHead(200,{'content-type':'application/json','content-length':'100'});
   response.write('{');setImmediate(()=>response.destroy());return;
  }
  daemon.sync.handler(request,response);
 });
 await new Promise(resolve=>ownedServer.listen(0,'127.0.0.1',resolve));
}
process.stdout.write(JSON.stringify({type:'ready',port:daemon.port,peerPort:ownedServer?.address().port})+'\\n');
const originalNow=Date.now;
for await(const line of lines){
 const control=JSON.parse(line);
 let failure;
 if(control.method==='clockOffset')Date.now=()=>originalNow()+control.value;
 else if(control.method==='invalidateSync')daemon.sync.setReady(undefined);
 else if(control.method==='holdBinding')bindingRemaining=control.value;
 else if(control.method==='releaseBinding'){releaseBinding?.();releaseBinding=undefined;}
 else if(control.method==='holdCommit')commitRemaining=control.value;
 else if(control.method==='releaseCommit'){releaseCommit?.();releaseCommit=undefined;}
 else if(control.method==='stats'){}
 else if(control.method==='cutResponse')cutResponse=control.value;
 else if(control.method==='malformedResponse')malformedResponse=control.value;
 else if(control.method==='probePullError'){
  try{await daemon.sync.pull(control.value.botId,{peerDeviceId:control.value.peerDeviceId,after:0},'tr_body_cause_probe');}
  catch(error){failure={kind:error.failure?.kind,cause:error.cause?.message,underlying:error.cause?.cause?.name,code:error.cause?.cause?.cause?.code};}
 }
 else break;
 process.stdout.write(JSON.stringify({type:'controlled',id:control.id,syncPages,failure})+'\\n');
}
if(ownedServer)await new Promise(resolve=>{ownedServer.close(resolve);ownedServer.closeAllConnections();});
await daemon.close();
await dispatcher?.close();
input.close();
`,
  );
  const daemon = processPort(script, root);
  // Private test configuration arrives on stdin, never argv or the inherited environment.
  try {
    daemon.send({
      source: botsSource,
      repository: resolve("."),
      root,
      socketPath,
      baseUrl,
      key,
      owned,
    });
    const ready = await daemon.message((message) => message.type === "ready");
    const token = readFileSync(join(root, "token"), "utf8").trim();
    const origin = `http://127.0.0.1:${ready.port}`;
    return {
      ...daemon,
      origin,
      token,
      peerPort: Number(ready.peerPort),
      async control(method: string, value?: unknown) {
        const id = randomUUID();
        daemon.send({ method, value, id });
        return daemon.message(
          (message) => message.type === "controlled" && message.id === id,
        );
      },
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
    await Promise.all([
      a.ready({ approveTools: false }),
      b.ready({ approveTools: false }),
    ]);
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
    assert.equal(health.deviceAccess.version, 1);
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

test("Bot sync access traverses private service and current Registry grants without opening the SDK", {
  timeout: 90000,
}, async () => {
  mkdirSync(".local", { recursive: true });
  const workerRoot = mkdtempSync(resolve(".local/device-sync-bots-worker-"));
  const root = mkdtempSync("/tmp/eagle-device-sync-bots-");
  const key = randomBytes(32).toString("base64url");
  const model = await modelFixture(key);
  let worker: Awaited<ReturnType<typeof workerFixture>> | undefined;
  let a: ReturnType<typeof deviceProcess> | undefined;
  let b: ReturnType<typeof deviceProcess> | undefined;
  let daemon: Awaited<ReturnType<typeof daemonProcess>> | undefined;
  let client: Awaited<ReturnType<typeof botConnection>> | undefined;
  try {
    worker = await workerFixture(workerRoot);
    a = deviceProcess(join(root, "a"), worker.origin);
    b = deviceProcess(join(root, "b"), worker.origin);
    await Promise.all([a.ready(), b.ready()]);
    const invitation = await a.manage("pairing.create", {});
    await b.manage("pairing.redeem", {
      requestId: randomUUID(),
      code: invitation.code,
    });
    daemon = await daemonProcess(
      join(root, "bots"),
      a.socketPath,
      model.baseUrl,
      key,
    );
    const botId = await daemon.createBot("Sync metadata only");
    const sharedBotId = randomUUID();
    const request = async (
      path: string,
      body: unknown,
      extra: Record<string, string> = {},
    ) => {
      assert(daemon);
      const response = await fetch(`${daemon.origin}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${daemon.token}`,
          "content-type": "application/json",
          ...extra,
        },
        body: JSON.stringify(body),
      });
      return {
        status: response.status,
        body: (await response.json()) as JSONRecord,
      };
    };
    const path = `/v1/bots/${botId}/sync/access`;
    const input = { peerDeviceId: b.deviceId, purpose: "replica.read" };
    const logs = () =>
      readdirSync(join(root, "bots/logs")).flatMap((file) =>
        readFileSync(join(root, "bots/logs", file), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as JSONRecord),
      );
    const opens = () =>
      logs().filter((r) => r.evt === "runtime.open.start").length;
    await until(
      async () =>
        logs().some((r) => r.evt === "runtime.open.ok" && r.botId === botId)
          ? true
          : undefined,
      "existing create warm-up",
    );
    const initialOpens = opens();
    assert.equal(
      (await request(path, input)).status,
      403,
      "the existing auto-bound local identity has no explicit grant",
    );
    assert.equal(opens(), initialOpens);
    assert.equal(
      (await request(`/v1/bots/${botId}/replica/bind`, { sharedBotId })).status,
      200,
    );
    const boundOpens = opens();
    const refused = await request(path, input);
    assert.equal(refused.status, 403, JSON.stringify(refused));
    const err = refused.body.error as { failure: string };
    await until(
      async () =>
        logs().some(
          (r) => r.trace === refused.body.trace && r.evt === "core.sync.fail",
        )
          ? true
          : undefined,
      "this trace's core sync propagation is on disk",
    );
    const failureLogs = logs().filter((r) => r.trace === refused.body.trace);
    const origins = failureLogs.filter((r) => r.level === "error");
    assert.equal(origins.length, 1);
    assert.equal(origins[0].evt, "runtime.sync.fail");
    assert.equal(origins[0].botId, botId);
    assert.equal((origins[0].err as { failure: string }).failure, err.failure);
    assert.equal(
      (origins[0].detail as { providerCode: string }).providerCode,
      "sync_not_shared",
    );
    assert.ok(
      failureLogs.some(
        (r) =>
          r.evt === "core.sync.fail" &&
          (r.err as { failure: string }).failure === err.failure,
      ),
    );
    await b.manage("sync.share", {
      sharedBotId,
      peerDeviceId: a.deviceId,
      enabled: true,
    });
    await b.manage("sync.endpoints.publish", { syncPort: null });
    const allowed = await request(path, input);
    assert.equal(allowed.status, 200, JSON.stringify(allowed));
    const uppercase = await request(path, {
      ...input,
      peerDeviceId: b.deviceId.toUpperCase(),
    });
    assert.equal(uppercase.status, 200, JSON.stringify(uppercase));
    assert.deepEqual(uppercase.body, allowed.body);
    assert.equal(allowed.body.sharedBotId, sharedBotId);
    assert.equal(
      (allowed.body.local as { deviceId: string }).deviceId,
      a.deviceId,
    );
    assert.equal(
      (allowed.body.peer as { deviceId: string }).deviceId,
      b.deviceId,
    );
    assert.deepEqual(
      (allowed.body.endpoints as { candidates: unknown[] }).candidates,
      [],
    );
    assert.equal(
      (await request(path, input, { origin: "http://hostile.test" })).status,
      403,
    );
    assert.equal(
      (await request(path, { ...input, sharedBotId: randomUUID() })).status,
      400,
    );
    assert.equal(
      (await request(path, { ...input, purpose: "execute" })).status,
      400,
    );
    assert.equal(opens(), boundOpens, "metadata never creates a Harness");
    assert.equal(model.verify(), 0);
    const storage = await worker.mf.unsafeGetDurableObjectStorage(
      "eagle",
      "DeviceRegistry",
      { name: "registry" },
    );
    await storage.exec(
      "CREATE TABLE test_sync_reply(started INTEGER,released INTEGER); INSERT INTO test_sync_reply VALUES(0,0)",
    );
    const inFlight = request(path, input);
    await until(
      async () =>
        (await storage.exec("SELECT started FROM test_sync_reply"))[0]
          .started === 1
          ? true
          : undefined,
      "actual Registry access reply barrier",
    );
    const otherScope = randomUUID();
    assert.equal(
      (
        await request(`/v1/bots/${botId}/replica/bind`, {
          sharedBotId: otherScope,
        })
      ).status,
      200,
    );
    await storage.exec("UPDATE test_sync_reply SET released=1");
    assert.equal(
      (await inFlight).status,
      400,
      "in-flight old scope cannot authorize rebound Bot",
    );
    await storage.exec("DROP TABLE test_sync_reply");
    await request(`/v1/bots/${botId}/replica/bind`, { sharedBotId });
    await storage.exec(
      "CREATE TABLE test_sync_reply(started INTEGER,released INTEGER); INSERT INTO test_sync_reply VALUES(0,0)",
    );
    const deletedFlight = request(path, input);
    await until(
      async () =>
        (await storage.exec("SELECT started FROM test_sync_reply"))[0]
          .started === 1
          ? true
          : undefined,
      "actual access before tombstone",
    );
    assert.equal(
      (
        await request("/v1/replica/tombstones/apply", {
          items: [{ sharedBotId }],
        })
      ).status,
      200,
    );
    await storage.exec("UPDATE test_sync_reply SET released=1");
    assert.equal(
      (await deletedFlight).status,
      404,
      "tombstone invalidates in-flight access",
    );
    await storage.exec("DROP TABLE test_sync_reply");
    const localBot = await daemon.createBot(
      "Local execution independent of Registry",
    );
    const localShared = randomUUID();
    await request(`/v1/bots/${localBot}/replica/bind`, {
      sharedBotId: localShared,
    });
    await b.manage("sync.share", {
      sharedBotId: localShared,
      peerDeviceId: a.deviceId,
      enabled: true,
    });
    await b.stop();
    b = undefined;
    assert.equal(
      (await request(`/v1/bots/${localBot}/sync/access`, input)).status,
      200,
      "granting device need not be online",
    );
    await worker.mf.dispose();
    worker = undefined;
    const offline = await request(`/v1/bots/${localBot}/sync/access`, input);
    assert.equal(offline.status, 503, JSON.stringify(offline));
    assert.notEqual(
      offline.body.local,
      a.deviceId,
      "no offline directory authorization",
    );
    client = await botConnection(daemon.origin, daemon.token, localBot);
    const output = join(root, "local-native-proof");
    const native = await client.run("bash", model, {
      command: `printf p3-local > '${output}'; cat '${output}'`,
    });
    assert.equal(native.isError, false);
    assert.equal((native.value as unknown as Receipt).status, "completed");
    assert.match((native.value as unknown as Receipt).output ?? "", /p3-local/);
    assert.equal(readFileSync(output, "utf8"), "p3-local");
    assert.equal(model.verify(), 2);
    assert.equal(
      JSON.stringify(logs()).includes(a.socketPath),
      false,
      "sync logs do not disclose the private socket path",
    );
  } finally {
    client?.socket.close();
    await daemon?.stop();
    await a?.stop();
    await b?.stop();
    await worker?.mf.dispose();
    await closeServer(model.server);
    rmSync(workerRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("paired reader and server authorize one directional replica page without reverse sharing", {
  timeout: 90000,
}, async () => {
  mkdirSync(".local", { recursive: true });
  const workerRoot = mkdtempSync(resolve(".local/authenticated-pull-worker-"));
  const root = mkdtempSync("/tmp/eagle-authenticated-pull-");
  const key = randomBytes(32).toString("base64url");
  const model = await modelFixture(key);
  let worker: Awaited<ReturnType<typeof workerFixture>> | undefined;
  const devices: ReturnType<typeof deviceProcess>[] = [];
  const daemons: Awaited<ReturnType<typeof daemonProcess>>[] = [];
  try {
    worker = await workerFixture(workerRoot);
    const a = deviceProcess(join(root, "a"), worker.origin);
    const cli = join(root, "cli");
    mkdirSync(cli);
    writeFileSync(
      join(cli, "tailscale"),
      `#!/bin/sh\nprintf '%s' '{"BackendState":"Running","Self":{"TailscaleIPs":["100.64.1.2"]}}'\n`,
    );
    chmodSync(join(cli, "tailscale"), 0o700);
    const b = deviceProcess(join(root, "b"), worker.origin, cli);
    devices.push(a, b);
    await Promise.all([a.ready(), b.ready()]);
    const invitation = await a.manage("pairing.create", {});
    await b.manage("pairing.redeem", {
      requestId: randomUUID(),
      code: invitation.code,
    });
    // Owned TCP maps a fixture candidate to a real loopback-mounted production handler.
    // It does not claim an actual Tailscale interface or add a production bypass.
    const bDaemon = await daemonProcess(
      join(root, "b-bots"),
      b.socketPath,
      model.baseUrl,
      key,
      { listener: true },
    );
    daemons.push(bDaemon);
    assert(Number.isInteger(bDaemon.peerPort) && bDaemon.peerPort > 0);
    const aDaemon = await daemonProcess(
      join(root, "a-bots"),
      a.socketPath,
      model.baseUrl,
      key,
      { peerPort: bDaemon.peerPort },
    );
    daemons.push(aDaemon);
    const [aBot, bBot] = await Promise.all([
      aDaemon.createBot("Reader"),
      bDaemon.createBot("Page source"),
    ]);
    const command = async (
      daemon: typeof aDaemon,
      botId: string,
      method: string,
      params: unknown,
    ) => {
      const response = await fetch(
        `${daemon.origin}/v1/bots/${botId}/replica/${method}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${daemon.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(params),
        },
      );
      const value = (await response.json()) as JSONRecord;
      assert.equal(response.status, 200, JSON.stringify(value));
      return value;
    };
    const sharedBotId = randomUUID();
    await command(aDaemon, aBot, "bind", { sharedBotId });
    await command(bDaemon, bBot, "bind", { sharedBotId });
    const resources = JSON.parse(
      readFileSync("fixtures/bots-sync/resources.v1.json", "utf8"),
    );
    const carrier = await command(bDaemon, bBot, "export", {
      kind: "resources",
      resources,
    });
    assert.equal(carrier.kind, "resources");
    const page = await command(bDaemon, bBot, "pull", { after: 0 });
    assert.equal((page.events as unknown[]).length, resources.length + 1);
    assert.equal(page.sharedBotId, sharedBotId);
    await b.manage("sync.share", {
      sharedBotId,
      peerDeviceId: a.deviceId,
      enabled: true,
    });
    const access = (await localCall(a.socketPath, "sync.access", {
      sharedBotId,
      peerDeviceId: b.deviceId,
      purpose: "replica.read",
    })) as JSONRecord;
    assert.equal((access.local as JSONRecord).deviceId, a.deviceId);
    assert.equal((access.peer as JSONRecord).deviceId, b.deviceId);
    const storage = await worker.mf.unsafeGetDurableObjectStorage(
      "eagle",
      "DeviceRegistry",
      { name: "registry" },
    );
    const grants = await storage.exec(
      "SELECT grantingDeviceId,peerDeviceId FROM sync_grants WHERE sharedBotId=?",
      sharedBotId,
    );
    assert.deepEqual(
      grants.map((row) => [row.grantingDeviceId, row.peerDeviceId]),
      [[b.deviceId, a.deviceId]],
    );
    assert.equal(
      model.verify(),
      0,
      "real page and authorization prerequisites are passive",
    );
    console.log(
      "authenticated-pull prerequisites: two registered/paired services, two bound Bots, original page, B-to-A-only grant; provider0",
    );
    const authorized = (await localCall(b.socketPath, "sync.peer.authorize", {
      sharedBotId,
      peerDeviceId: a.deviceId,
      purpose: "replica.read",
    })) as JSONRecord;
    assert.equal((authorized.local as JSONRecord).deviceId, b.deviceId);
    assert.equal((authorized.peer as JSONRecord).deviceId, a.deviceId);
    await assert.rejects(
      localCall(a.socketPath, "sync.peer.authorize", {
        sharedBotId,
        peerDeviceId: b.deviceId,
        purpose: "replica.read",
      }),
      /sync_not_shared/,
    );
    await b.manage("sync.endpoints.publish", { syncPort: bDaemon.peerPort });
    const syncPull = async (
      daemon: typeof aDaemon,
      botId: string,
      peerDeviceId: string,
    ) => {
      const response = await fetch(
        `${daemon.origin}/v1/bots/${botId}/sync/pull`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${daemon.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ peerDeviceId, after: 0 }),
        },
      );
      return {
        status: response.status,
        value: (await response.json()) as JSONRecord,
      };
    };
    const remote = async (path: string, value: unknown) => {
      const response = await fetch(
        `http://127.0.0.1:${bDaemon.peerPort}${path}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-bots-sync-trace": "tr_owned_handshake",
          },
          body: JSON.stringify(value),
        },
      );
      return {
        status: response.status,
        value: (await response.json()) as JSONRecord,
      };
    };
    const begin = async () => {
      const pair = generateKeyPairSync("x25519");
      const ephemeral = pair.publicKey
        .export({ type: "spki", format: "der" })
        .subarray(-32)
        .toString("base64url");
      const response = await remote("/v1/sync/challenge", {
        version: 1,
        sharedBotId,
        readerDeviceId: a.deviceId,
        readerNonce: randomBytes(32).toString("base64url"),
        readerEphemeral: ephemeral,
      });
      assert.equal(response.status, 200, JSON.stringify(response));
      const serverProof = SyncProofRequest.parse(response.value.proof);
      assert(
        verify(
          null,
          Buffer.from(syncProofPayload(serverProof)),
          createPublicKey({
            key: Buffer.from(b.publicKey, "base64url"),
            type: "spki",
            format: "der",
          }),
          Buffer.from(String(response.value.signature), "base64url"),
        ),
      );
      return {
        pair,
        proof: SyncProofRequest.parse({ ...serverProof, role: "reader" }),
      };
    };
    const session = await begin();
    const beforeWrongOrigin = a.proofRequests();
    await assert.rejects(
      localCall(a.socketPath, "sync.proof", {
        ...session.proof,
        registryOrigin: "https://wrong.example",
      }),
      /invalid_sync_proof/,
    );
    assert.equal(
      a.proofRequests(),
      beforeWrongOrigin,
      "wrong origin never reaches the owned signer",
    );
    for (const change of [
      { role: "server" },
      { purpose: "execute" },
      { reader: session.proof.server },
      { expiresAt: Date.now() - 1 },
      { expiresAt: Date.now() + 120000 },
    ])
      await assert.rejects(
        localCall(a.socketPath, "sync.proof", { ...session.proof, ...change }),
      );
    const signed = (await localCall(
      a.socketPath,
      "sync.proof",
      session.proof,
    )) as { signature: string };
    const serverKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b656e032100", "hex"),
        Buffer.from(session.proof.serverEphemeral, "base64url"),
      ]),
      type: "spki",
      format: "der",
    });
    const transcript = syncProofPayload({ ...session.proof, role: "server" });
    const aad = Buffer.from(transcript + "\nreader\n0");
    const keyBytes = hkdfSync(
      "sha256",
      diffieHellman({
        privateKey: session.pair.privateKey,
        publicKey: serverKey,
      }),
      createHash("sha256").update(transcript).digest(),
      createHash("sha256").update(aad).digest(),
      32,
    );
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyBytes), iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify({ after: 0, limit: 128 })),
      cipher.final(),
    ]);
    const frame = {
      sessionId: session.proof.sessionId,
      signature: signed.signature,
      box: {
        version: 1,
        sequence: 0,
        nonce: iv.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
      },
    };
    assert.equal((await remote("/v1/sync/page", frame)).status, 200);
    assert.equal(
      (await remote("/v1/sync/page", frame)).status,
      403,
      "challenge is consumed exactly once",
    );
    const expired = await begin();
    try {
      await bDaemon.control("clockOffset", 60001);
      assert.equal(
        (
          await remote("/v1/sync/page", {
            ...frame,
            sessionId: expired.proof.sessionId,
          })
        ).status,
        403,
      );
    } finally {
      await bDaemon.control("clockOffset", 0);
    }
    const oldGeneration = await begin();
    await bDaemon.control("invalidateSync");
    assert.equal(
      (
        await remote("/v1/sync/page", {
          ...frame,
          sessionId: oldGeneration.proof.sessionId,
        })
      ).status,
      403,
      "old generation challenge cannot survive readiness loss",
    );
    assert.equal(
      model.verify(),
      0,
      "proof refusals and raw page reads cannot execute",
    );
    const emptyReplica = new DatabaseSync(
      join(root, "a-bots", "bots", aBot, "replica.sqlite"),
      { readOnly: true },
    );
    try {
      assert.equal(
        emptyReplica.prepare("SELECT count(*) AS n FROM facts").get()?.n,
        0,
        "proof refusals and raw B reads do not apply on A",
      );
      assert.equal(
        emptyReplica.prepare("SELECT count(*) AS n FROM local_runs").get()?.n,
        0,
      );
    } finally {
      emptyReplica.close();
    }
    const transferred = await syncPull(aDaemon, aBot, b.deviceId);
    if (transferred.status !== 200) {
      const records = ["a-bots", "b-bots"].map((name) => ({
        name,
        records: readdirSync(join(root, name, "logs")).flatMap((file) =>
          readFileSync(join(root, name, "logs", file), "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as JSONRecord),
        ),
      }));
      writeFileSync(
        resolve(
          ".local/sync-p4-authenticated-pull/network-diagnostic-" +
            Date.now() +
            ".json",
        ),
        JSON.stringify({ transferred, records }, null, 2),
      );
      console.log(
        JSON.stringify(
          records.map((item) => ({
            name: item.name,
            failures: item.records.filter((row) => row.level === "error"),
          })),
        ),
      );
    }
    assert.equal(transferred.status, 200, JSON.stringify(transferred));
    assert.equal(
      JSON.stringify(transferred.value.page),
      JSON.stringify(page),
      "original plaintext page bytes are unchanged through mutual proof and AEAD",
    );
    assert.deepEqual(
      await command(aDaemon, aBot, "export", {
        kind: "resources",
        head: carrier.head,
      }),
      carrier,
    );
    assert.equal(model.verify(), 0, "network decrypt/apply is passive");
    const records = () =>
      ["a-bots", "b-bots"].flatMap((name) =>
        readdirSync(join(root, name, "logs")).flatMap((file) =>
          readFileSync(join(root, name, "logs", file), "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as JSONRecord),
        ),
      );
    const reverse = await syncPull(bDaemon, bBot, a.deviceId);
    assert.equal(
      reverse.status,
      403,
      "B cannot read A without a distinct reverse grant",
    );
    assert.equal((reverse.value.error as JSONRecord).kind, "auth_failed");
    assert.match(String(reverse.value.trace), /^tr_http_/);
    assert.match(String((reverse.value.error as JSONRecord).failure), /^f_/);
    const reverseFailure = (reverse.value.error as JSONRecord).failure;
    const failures = records().filter(
      (row) => (row.err as JSONRecord | undefined)?.failure === reverseFailure,
    );
    assert.equal(
      failures.filter((row) => (row.err as JSONRecord).origin === true).length,
      1,
    );
    assert(
      failures.every(
        (row) => row.trace === reverse.value.trace && row.botId === bBot,
      ),
    );
    assert(
      records().some(
        (row) =>
          (row.detail as JSONRecord | undefined)?.providerCode ===
          "sync_proof_expired",
      ),
    );
    assert.equal(JSON.stringify(records()).includes(a.socketPath), false);
    assert.equal(
      JSON.stringify(records()).includes("resource-version-one instructions"),
      false,
    );
    assert.equal(model.verify(), 0);
    b.holdProof();
    const revokedDuringProof = syncPull(aDaemon, aBot, b.deviceId);
    await until(
      async () => (b.heldProofs() === 1 ? true : undefined),
      "actual server helper signing barrier",
    );
    try {
      await b.manage("sync.share", {
        sharedBotId,
        peerDeviceId: a.deviceId,
        enabled: false,
      });
    } finally {
      b.releaseProof();
    }
    assert.equal(
      (await revokedDuringProof).status,
      403,
      "post-sign current authorization refuses revoked grant",
    );
    assert.equal(model.verify(), 0);
    await b.manage("sync.share", {
      sharedBotId,
      peerDeviceId: a.deviceId,
      enabled: true,
    });
    const otherBot = await aDaemon.createBot("Rebinding reader");
    await command(aDaemon, otherBot, "bind", { sharedBotId });
    a.holdProof();
    const reboundDuringProof = syncPull(aDaemon, otherBot, b.deviceId);
    await until(
      async () => (a.heldProofs() === 1 ? true : undefined),
      "actual reader helper signing barrier",
    );
    try {
      await command(aDaemon, otherBot, "bind", { sharedBotId: randomUUID() });
    } finally {
      a.releaseProof();
    }
    assert.equal(
      (await reboundDuringProof).status,
      400,
      "old-scope proof cannot apply after local rebinding",
    );
    assert.equal(model.verify(), 0);
    const client = await botConnection(aDaemon.origin, aDaemon.token, aBot);
    try {
      const result = await client.run("bash", model, {
        command: `printf authenticated-local > '${join(root, "local-result")}'`,
      });
      assert.equal(result.isError, false);
      assert.equal(
        readFileSync(join(root, "local-result"), "utf8"),
        "authenticated-local",
      );
      assert.equal(
        model.verify(),
        2,
        "only the later explicit local tool round executes",
      );
    } finally {
      client.socket.terminate();
    }
    a.holdProof();
    const deletedDuringProof = syncPull(aDaemon, aBot, b.deviceId);
    await until(
      async () => (a.heldProofs() === 1 ? true : undefined),
      "reader proof before tombstone",
    );
    try {
      const deleted = await fetch(`${aDaemon.origin}/v1/bots/${aBot}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${aDaemon.token}` },
      });
      assert.equal(deleted.status, 204);
    } finally {
      a.releaseProof();
    }
    assert.equal(
      (await deletedDuringProof).status,
      404,
      "tombstone during network await rejects without apply",
    );
    assert.equal(model.verify(), 2);
    const aliasShared = randomUUID();
    const alias = await bDaemon.createBot("Ambiguous source alias");
    const aliasTwo = await bDaemon.createBot("Second source alias");
    await command(bDaemon, alias, "bind", { sharedBotId: aliasShared });
    await command(bDaemon, aliasTwo, "bind", { sharedBotId: aliasShared });
    await b.manage("sync.share", {
      sharedBotId: aliasShared,
      peerDeviceId: a.deviceId,
      enabled: true,
    });
    const aliasReader = await aDaemon.createBot("Alias guard reader");
    await command(aDaemon, aliasReader, "bind", { sharedBotId: aliasShared });
    assert.equal(
      (await syncPull(aDaemon, aliasReader, b.deviceId)).status,
      400,
      "network server never guesses between local shared aliases",
    );
    b.holdProof();
    const epochChanged = remote("/v1/sync/challenge", {
      version: 1,
      sharedBotId,
      readerDeviceId: a.deviceId,
      readerNonce: randomBytes(32).toString("base64url"),
      readerEphemeral: session.proof.readerEphemeral,
    });
    await until(
      async () => (b.heldProofs() === 1 ? true : undefined),
      "proof barrier before current member epoch change",
    );
    try {
      await b.manage("member.remove", { deviceId: a.deviceId });
    } finally {
      b.releaseProof();
    }
    assert.equal(
      (await epochChanged).status,
      403,
      "membership/credential change invalidates proof prepared under prior identity",
    );
    assert.equal(model.verify(), 2);
  } finally {
    await Promise.allSettled(daemons.map((daemon) => daemon.stop()));
    await Promise.allSettled(devices.map((device) => device.stop()));
    await worker?.mf.dispose();
    await closeServer(model.server);
    rmSync(workerRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("proof expiry is enforced after final authorization and ready binding awaits", {
  timeout: 90000,
}, async (t) => {
  const workerRoot = mkdtempSync(resolve(".local/expiry-await-worker-"));
  const root = mkdtempSync("/tmp/eagle-expiry-await-");
  const key = randomBytes(32).toString("base64url");
  const model = await modelFixture(key);
  let worker: Awaited<ReturnType<typeof workerFixture>> | undefined;
  const devices: ReturnType<typeof deviceProcess>[] = [];
  const daemons: Awaited<ReturnType<typeof daemonProcess>>[] = [];
  try {
    worker = await workerFixture(workerRoot);
    const cli = join(root, "cli");
    mkdirSync(cli);
    writeFileSync(
      join(cli, "tailscale"),
      `#!/bin/sh\nprintf '%s' '{"BackendState":"Running","Self":{"TailscaleIPs":["100.64.1.2"]}}'\n`,
    );
    chmodSync(join(cli, "tailscale"), 0o700);
    const a = deviceProcess(join(root, "a"), worker.origin);
    const b = deviceProcess(join(root, "b"), worker.origin, cli);
    devices.push(a, b);
    await Promise.all([a.ready(), b.ready()]);
    const invitation = await a.manage("pairing.create", {});
    await b.manage("pairing.redeem", {
      requestId: randomUUID(),
      code: invitation.code,
    });
    const server = await daemonProcess(
      join(root, "b-bots"),
      b.socketPath,
      model.baseUrl,
      key,
      { listener: true },
    );
    const reader = await daemonProcess(
      join(root, "a-bots"),
      a.socketPath,
      model.baseUrl,
      key,
      { peerPort: server.peerPort },
    );
    daemons.push(server, reader);
    const command = async (
      daemon: typeof reader,
      botId: string,
      method: string,
      params: unknown,
    ) => {
      const response = await fetch(
        `${daemon.origin}/v1/bots/${botId}/replica/${method}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${daemon.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(params),
        },
      );
      assert.equal(response.status, 200);
      return response.json();
    };
    const bBot = await server.createBot("Expiry page source");
    const sharedBotId = randomUUID();
    await command(server, bBot, "bind", { sharedBotId });
    await command(server, bBot, "export", {
      kind: "resources",
      resources: JSON.parse(
        readFileSync("fixtures/bots-sync/resources.v1.json", "utf8"),
      ),
    });
    const originalPage = await command(server, bBot, "pull", { after: 0 });
    await b.manage("sync.share", {
      sharedBotId,
      peerDeviceId: a.deviceId,
      enabled: true,
    });
    await b.manage("sync.endpoints.publish", { syncPort: server.peerPort });
    const storage = await worker.mf.unsafeGetDurableObjectStorage(
      "eagle",
      "DeviceRegistry",
      { name: "registry" },
    );
    const counts = (botId: string) => {
      const result: JSONRecord = {};
      for (const file of ["replica.sqlite", "session.sqlite"]) {
        const db = new DatabaseSync(join(root, "a-bots", "bots", botId, file), {
          readOnly: true,
        });
        try {
          const names = db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .all();
          for (const row of names) {
            const name = String(row.name);
            assert.match(name, /^[A-Za-z0-9_]+$/);
            result[`${file}:${name}`] = db
              .prepare(`SELECT count(*) AS n FROM ${name}`)
              .get()?.n;
          }
        } finally {
          db.close();
        }
      }
      return result;
    };
    for (const scenario of [
      {
        name: "server challenge final authorize",
        route: "/sync/peer/authorize",
        target: 4,
        side: server,
        challenge: true,
      },
      {
        name: "server page final authorize",
        route: "/sync/peer/authorize",
        target: 6,
        side: server,
      },
      {
        name: "server page public SDK commit return preserves remote failure",
        route: "/sync/peer/authorize",
        target: 5,
        side: server,
        commit: true,
        remote: true,
      },
      {
        name: "server generation changes inside replica commit preserve remote failure",
        route: "/sync/peer/authorize",
        target: 5,
        side: server,
        commit: true,
        remote: true,
        generation: true,
      },
      {
        name: "reader request final authorize",
        route: "/sync/access",
        target: 5,
        side: reader,
        request: true,
      },
      {
        name: "reader apply final authorize",
        route: "/sync/access",
        target: 6,
        side: reader,
      },
      {
        name: "reader apply actual binding return",
        route: "/sync/access",
        target: 6,
        side: reader,
        binding: true,
      },
      {
        name: "reader generation changes inside command binding",
        route: "/sync/access",
        target: 6,
        side: reader,
        binding: true,
        generation: true,
      },
      {
        name: "reader apply public SDK commit return",
        route: "/sync/access",
        target: 6,
        side: reader,
        commit: true,
      },
      {
        name: "reader generation changes inside replica command commit",
        route: "/sync/access",
        target: 6,
        side: reader,
        commit: true,
        generation: true,
      },
    ])
      await t.test(scenario.name, async () => {
        const aBot = await reader.createBot(scenario.name);
        await command(reader, aBot, "bind", { sharedBotId });
        const before = counts(aBot);
        const beforePages = (await server.control("stats")).syncPages;
        await storage.exec(
          "CREATE TABLE test_sync_expiry_gate(route TEXT,target INTEGER,seen INTEGER,started INTEGER,released INTEGER)",
        );
        await storage.exec(
          "INSERT INTO test_sync_expiry_gate VALUES(?,?,0,0,0)",
          scenario.route,
          scenario.target,
        );
        const url = scenario.challenge
          ? `http://127.0.0.1:${server.peerPort}/v1/sync/challenge`
          : `${reader.origin}/v1/bots/${aBot}/sync/pull`;
        const operation = fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${reader.token}`,
            "content-type": "application/json",
            "x-bots-sync-trace": "tr_expiry_challenge",
          },
          body: JSON.stringify(
            scenario.challenge
              ? {
                  version: 1,
                  sharedBotId,
                  readerDeviceId: a.deviceId,
                  readerNonce: randomBytes(32).toString("base64url"),
                  readerEphemeral: generateKeyPairSync("x25519")
                    .publicKey.export({ type: "spki", format: "der" })
                    .subarray(-32)
                    .toString("base64url"),
                }
              : { peerDeviceId: b.deviceId, after: 0 },
          ),
        });
        try {
          await until(
            async () =>
              (await storage.exec("SELECT * FROM test_sync_expiry_gate"))[0]
                ?.started === 1
                ? true
                : undefined,
            scenario.name,
          );
          if (scenario.binding || scenario.commit) {
            // Delay only the return of a real public SQLite binding read, after check()'s read.
            await scenario.side.control(
              scenario.commit ? "holdCommit" : "holdBinding",
              scenario.commit ? 1 : 2,
            );
            await storage.exec("UPDATE test_sync_expiry_gate SET released=1");
            const held = await scenario.side.message(
              (message) =>
                message.type ===
                (scenario.commit ? "commitHeld" : "bindingHeld"),
            );
            if (scenario.binding) assert.equal(held.botId, aBot);
          }
          await scenario.side.control(
            scenario.generation ? "invalidateSync" : "clockOffset",
            60001,
          );
        } finally {
          await storage.exec("UPDATE test_sync_expiry_gate SET released=1");
          await scenario.side.control("releaseBinding");
          await scenario.side.control("releaseCommit");
        }
        const response = await operation;
        const value = (await response.json()) as JSONRecord;
        const after = counts(aBot);
        const pages = (await server.control("stats")).syncPages;
        await scenario.side.control("clockOffset", 0);
        await storage.exec("DROP TABLE test_sync_expiry_gate");
        assert.deepEqual(
          await command(server, bBot, "pull", { after: 0 }),
          originalPage,
        );
        assert.equal(model.verify(), 0, "expiry never submits provider/tools");
        console.log(
          JSON.stringify({
            expiryAwait: scenario.name,
            status: response.status,
            replicaAndSdkUnchanged:
              JSON.stringify(before) === JSON.stringify(after),
            newPageRequests: Number(pages) - Number(beforePages),
            provider: 0,
          }),
        );
        assert.equal(
          response.status,
          403,
          `${scenario.name} must refuse at the actual use point`,
        );
        assert.deepEqual(
          after,
          before,
          "expired page cannot change source/applied state or SDK work",
        );
        if (scenario.request)
          assert.equal(
            pages,
            beforePages,
            "expired reader request is never sent",
          );
        const failure = scenario.challenge
          ? ((value.error as JSONRecord).failure as JSONRecord)
          : { id: (value.error as JSONRecord).failure };
        const failureId = failure.id;
        const traceRows = ["a-bots", "b-bots"]
          .flatMap((name) =>
            readdirSync(join(root, name, "logs")).flatMap((file) =>
              readFileSync(join(root, name, "logs", file), "utf8")
                .split("\n")
                .filter(Boolean)
                .map(
                  (line): JSONRecord => ({
                    ...(JSON.parse(line) as JSONRecord),
                    daemon: name,
                  }),
                ),
            ),
          )
          .filter((row) => row.trace === value.trace);
        if (scenario.remote) {
          const origins = traceRows.filter(
            (row) => (row.err as JSONRecord | undefined)?.origin === true,
          );
          const serverOrigin = origins.find((row) => row.daemon === "b-bots");
          assert(serverOrigin, "actual server runtime guard owns the failure");
          assert.equal(serverOrigin.level, "error");
          assert.equal(serverOrigin.layer, "runtime");
          assert.equal((serverOrigin.err as JSONRecord).kind, "auth_failed");
          assert.equal(serverOrigin.evt, "runtime.replica.fail");
          assert.equal(serverOrigin.botId, bBot);
          assert.equal(
            failureId,
            (serverOrigin.err as JSONRecord).failure,
            "reader must propagate the server classifier identity",
          );
          assert.equal(origins.length, 1, "reader cannot mint a second origin");
          assert.equal(
            traceRows.filter((row) => row.level === "error").length,
            1,
          );
          assert(
            traceRows.some(
              (row) =>
                row.daemon === "a-bots" &&
                row.botId === aBot &&
                row.level === "warn" &&
                (row.err as JSONRecord | undefined)?.failure === failureId,
            ),
            "reader warns with the original failure and its local Bot",
          );
        }
        const rows = traceRows.filter(
          (row) => (row.err as JSONRecord | undefined)?.failure === failureId,
        );
        assert.equal(
          rows.filter((row) => (row.err as JSONRecord).origin === true).length,
          1,
        );
        assert(rows.every((row) => row.trace === value.trace));
        const origin = rows.find(
          (row) => (row.err as JSONRecord).origin === true,
        );
        assert.equal(origin?.botId, scenario.side === server ? bBot : aBot);
        assert.equal(JSON.stringify(rows).includes(a.socketPath), false);
      });
    await t.test(
      "headers then truncated TCP body is a network failure",
      async () => {
        const botId = await reader.createBot("Truncated network response");
        await command(reader, botId, "bind", { sharedBotId });
        const before = counts(botId);
        await server.control("cutResponse", "/v1/sync/challenge");
        let response: Response;
        try {
          response = await fetch(
            `${reader.origin}/v1/bots/${botId}/sync/pull`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${reader.token}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ peerDeviceId: b.deviceId, after: 0 }),
            },
          );
        } finally {
          await server.control("cutResponse", null);
        }
        const value = (await response.json()) as {
          trace: string;
          error: { kind: string; failure: string };
        };
        assert.deepEqual(counts(botId), before);
        assert.equal(model.verify(), 0);
        assert.equal(
          response.status,
          503,
          "body transport I/O retains the existing network/internal HTTP mapping",
        );
        assert.equal(value.error.kind, "internal");
        const rows = readdirSync(join(root, "a-bots", "logs"))
          .flatMap((file) =>
            readFileSync(join(root, "a-bots", "logs", file), "utf8")
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line) as JSONRecord),
          )
          .filter(
            (row) =>
              (row.err as JSONRecord | undefined)?.failure ===
              value.error.failure,
          );
        assert.equal(
          rows.filter((row) => (row.err as JSONRecord).origin === true).length,
          1,
        );
        assert(
          rows.every((row) => row.trace === value.trace && row.botId === botId),
        );
        assert(
          rows.some(
            (row) =>
              (row.detail as JSONRecord | undefined)?.providerCode ===
              "sync_network_unreachable",
          ),
        );
        await server.control("cutResponse", "/v1/sync/challenge");
        try {
          const probe = await reader.control("probePullError", {
            botId,
            peerDeviceId: b.deviceId,
          });
          assert.deepEqual(probe.failure, {
            kind: "internal",
            cause: "sync_network_unreachable",
            underlying: "TypeError",
            code: "UND_ERR_SOCKET",
          });
          await server.control("malformedResponse", true);
          const malformed = await fetch(
            `${reader.origin}/v1/bots/${botId}/sync/pull`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${reader.token}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ peerDeviceId: b.deviceId, after: 0 }),
            },
          );
          assert.equal(
            malformed.status,
            403,
            "complete but malformed JSON remains a protocol refusal",
          );
          assert.equal(
            ((await malformed.json()) as { error: { kind: string } }).error
              .kind,
            "auth_failed",
          );
        } finally {
          await server.control("cutResponse", null);
          await server.control("malformedResponse", false);
        }
        assert.deepEqual(counts(botId), before);
        assert.equal(model.verify(), 0);
      },
    );
  } finally {
    await Promise.allSettled(daemons.map((daemon) => daemon.stop()));
    await Promise.allSettled(devices.map((device) => device.stop()));
    await worker?.mf.dispose();
    await closeServer(model.server);
    rmSync(workerRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("endpoint management receive order makes a later withdrawal final despite a slow old publish", {
  timeout: 30000,
}, async () => {
  const workerRoot = mkdtempSync(resolve(".local/endpoint-writer-worker-"));
  const root = mkdtempSync("/tmp/eagle-endpoint-writer-");
  let worker: Awaited<ReturnType<typeof workerFixture>> | undefined;
  const devices: ReturnType<typeof deviceProcess>[] = [];
  let release: (() => Promise<unknown>) | undefined;
  try {
    worker = await workerFixture(workerRoot);
    const cli = join(root, "cli");
    mkdirSync(cli);
    writeFileSync(
      join(cli, "tailscale"),
      `#!/bin/sh\nprintf '%s' '{"BackendState":"Running","Self":{"TailscaleIPs":["100.64.1.2"]}}'\n`,
    );
    chmodSync(join(cli, "tailscale"), 0o700);
    const a = deviceProcess(join(root, "a"), worker.origin);
    const b = deviceProcess(join(root, "b"), worker.origin, cli);
    devices.push(a, b);
    await Promise.all([a.ready(), b.ready()]);
    const invitation = await a.manage("pairing.create", {});
    await b.manage("pairing.redeem", {
      requestId: randomUUID(),
      code: invitation.code,
    });
    const sharedBotId = randomUUID();
    await b.manage("sync.share", {
      sharedBotId,
      peerDeviceId: a.deviceId,
      enabled: true,
    });
    const storage = await worker.mf.unsafeGetDurableObjectStorage(
      "eagle",
      "DeviceRegistry",
      { name: "registry" },
    );
    await storage.exec(
      "CREATE TABLE test_endpoint_gate(started INTEGER,released INTEGER)",
    );
    await storage.exec("INSERT INTO test_endpoint_gate VALUES(0,0)");
    release = () => storage.exec("UPDATE test_endpoint_gate SET released=1");
    const publish = b.manage("sync.endpoints.publish", { syncPort: 43210 });
    await until(
      async () =>
        (await storage.exec("SELECT started FROM test_endpoint_gate"))[0]
          ?.started === 1
          ? true
          : undefined,
      "actual Registry publish before-write barrier",
    );
    const withdraw = b.manage("sync.endpoints.publish", { syncPort: null });
    // The following response proves stdin has processed the later management frames.
    await b.manage("policy.get", {});
    await release();
    await Promise.all([publish, withdraw]);
    const access = (await localCall(a.socketPath, "sync.access", {
      sharedBotId,
      peerDeviceId: b.deviceId,
      purpose: "replica.read",
    })) as JSONRecord;
    assert.deepEqual(
      (access.endpoints as JSONRecord).candidates,
      [],
      "slow old publish must not restore withdrawn endpoints",
    );
    const self = (await localCall(b.socketPath, "sync.endpoints.self")) as {
      digest: string;
    };
    await assert.rejects(
      b.manage("sync.endpoints.publish", {
        syncPort: 43210,
        expectedSelfDigest: "0".repeat(64),
      }),
    );
    assert.notEqual(self.digest, "0".repeat(64));
    assert.deepEqual(
      (
        (
          (await localCall(a.socketPath, "sync.access", {
            sharedBotId,
            peerDeviceId: b.deviceId,
            purpose: "replica.read",
          })) as JSONRecord
        ).endpoints as JSONRecord
      ).candidates,
      [],
    );
    await b.manage("sync.endpoints.publish", { syncPort: null });
  } finally {
    await release?.();
    await Promise.allSettled(devices.map((device) => device.stop()));
    await worker?.mf.dispose();
    rmSync(workerRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
