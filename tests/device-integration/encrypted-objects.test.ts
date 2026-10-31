import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { DurableObjectStorageHandle } from "miniflare";
import WebSocket from "ws";
import { verifySyncKeyDescriptor } from "../../packages/contracts/src/device-objects.ts";
import { SyncIdentityResult } from "../../packages/contracts/src/device-sync.ts";
import { canonicalDeviceJSON } from "../../packages/contracts/src/devices.ts";
import {
  localCall,
  processPort,
  until,
  workerFixture,
} from "./device-fixtures.ts";

type Page = { sharedBotId: string; source: unknown; events: unknown[] };
type History = { head: string; entries: { model?: { sections?: object }[] }[] };
type Access = { local: { deviceId: string }; peer: { deviceId: string } };
const storeFixture = resolve(
  "tests/device-integration/sync-objects-store.fixture.mjs",
);
mkdirSync(".local", { recursive: true });
function counts(directory: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const name of ["replica.sqlite", "session.sqlite"]) {
    const db = new DatabaseSync(join(directory, name), { readOnly: true });
    try {
      for (const row of db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()) {
        const table = String(row.name);
        assert.match(table, /^[A-Za-z0-9_]+$/);
        result[name + ":" + table] = db
          .prepare(`SELECT count(*) AS n FROM ${table}`)
          .get()?.n;
      }
    } finally {
      db.close();
    }
  }
  return result;
}
function changeBinding(
  directory: string,
  field: string,
  value: string,
): () => void {
  const db = new DatabaseSync(join(directory, "replica.sqlite"));
  try {
    const original = String(
      db.prepare("SELECT value FROM binding WHERE id=1").get()?.value,
    );
    const body = JSON.parse(original);
    body[field] = value;
    db.prepare("UPDATE binding SET value=? WHERE id=1").run(
      JSON.stringify(body),
    );
    return () => {
      const reopened = new DatabaseSync(join(directory, "replica.sqlite"));
      try {
        reopened.prepare("UPDATE binding SET value=? WHERE id=1").run(original);
      } finally {
        reopened.close();
      }
    };
  } finally {
    db.close();
  }
}
function storeCommand<T>(input: unknown): T {
  const result = spawnSync(process.execPath, [storeFixture], {
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as T;
}
type RecordJSON = Record<string, unknown>;

const SWIFT_INPUTS = [
  "swiftc",
  "-parse-as-library",
  "-swift-version",
  "6",
  "apps/macos/Sources/EagleDevices/DeviceJSON.swift",
  "apps/macos/Sources/EagleDevices/DeviceHostConfiguration.swift",
  "apps/macos/Sources/EagleDevices/DeviceFileVault.swift",
  "apps/macos/Sources/EagleDevices/DeviceIdentity.swift",
  "apps/macos/Sources/EagleDevices/DeviceWrappingKey.swift",
  "apps/macos/Sources/EagleDevices/DevicePageKeys.swift",
  "apps/macos/Sources/EagleDevices/DeviceSyncProof.swift",
  "apps/macos/Sources/EagleDevices/DeviceLocalPort.swift",
  "apps/macos/Sources/EagleDevices/DeviceServiceHost.swift",
  "tests/device-integration/sync-objects-helper.fixture.swift",
];
type JSONRecord = Record<string, unknown>;
type ModelStep = { name: string; args: JSONRecord } | { text: string };
async function modelFixture(key: string) {
  const steps: ModelStep[] = [];
  const failures: string[] = [];
  const inputs: JSONRecord[] = [];
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
      inputs.push(JSON.parse(body) as JSONRecord);
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
    inputs,
    script(name: string, args: JSONRecord, extraReplies = 0) {
      steps.push({ name, args }, { text: "done" });
      for (let i = 0; i < extraReplies; i++) steps.push({ text: "done" });
    },
    verify() {
      assert.deepEqual(failures, []);
      assert.equal(steps.length, 0);
      return requests;
    },
  };
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
  const snapshot = await frame("snapshot");
  const request = async (input: JSONRecord) => {
    messages.length = 0;
    socket.send(
      JSON.stringify({
        type: "send",
        whenBusy: "followUp",
        trace: `tr_retry_${randomUUID()}`,
        ...input,
      }),
    );
    return until(
      async () =>
        messages.find(
          (message) =>
            message.requestId === input.requestId &&
            (message.type === "error" ||
              (message.type === "submission" &&
                ["done", "unanswered"].includes(String(message.status)))),
        ),
      "actual SDK request outcome",
    );
  };
  return {
    socket,
    snapshot,
    messages,
    request,
    async run(
      name: string,
      model: Awaited<ReturnType<typeof modelFixture>>,
      args: JSONRecord = {},
      options: { resourceHead?: string; extraReplies?: number } = {},
    ) {
      messages.length = 0;
      model.script(name, args, options.extraReplies);
      const requestId = `r_${randomUUID()}`;
      socket.send(
        JSON.stringify({
          type: "send",
          requestId,
          text: `Integration: ${name}`,
          whenBusy: "followUp",
          trace: `tr_run_${randomUUID()}`,
          ...(options.resourceHead === undefined
            ? {}
            : { resourceHead: options.resourceHead }),
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
        requestId,
        text: result.text,
        isError: result.isError,
      };
    },
  };
}

async function helper(
  root: string,
  origin: string,
  waitCloud = true,
  cli?: string,
) {
  mkdirSync(root, { mode: 0o700, recursive: true });
  const executable = join(root, "../object-helper");
  if (!existsSync(executable)) {
    const built = spawnSync("xcrun", [...SWIFT_INPUTS, "-o", executable], {
      encoding: "utf8",
      env: {
        ...process.env,
        DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
      },
      timeout: 60000,
    });
    assert.equal(
      built.status,
      0,
      `real Swift helper compilation: ${built.stderr}`,
    );
  }
  const script = join(root, "helper.mjs");
  writeFileSync(
    script,
    `import {spawn} from 'node:child_process';
const child=spawn(${JSON.stringify(executable)},[],{stdio:'inherit'});
child.on('exit',code=>{process.exitCode=code??1;});`,
  );
  const service = processPort(script, root);
  const node = join(root, "owned-node");
  writeFileSync(
    node,
    `#!/bin/sh\nPATH='${cli ?? "/usr/bin"}:/usr/bin:/bin:/usr/sbin:/sbin' exec '${process.execPath}' '${resolve("tests/device-integration/sync-objects-node.fixture.mjs")}' '${root}' "$@"\n`,
  );
  chmodSync(node, 0o700);
  service.send({
    root,
    origin,
    waitCloud,
    node,
    entry: resolve("packages/agent/device-service.ts"),
  });
  try {
    const ready = await service.message((m) => m.type === "ready");
    return {
      ...service,
      deviceId: String(ready.deviceId),
      publicKey: String(ready.publicKey),
      socketPath: String(ready.socketPath),
      async manage(method: string, params: unknown) {
        const requestId = randomUUID();
        service.send({ method, params, requestId });
        const reply = await service.message(
          (m) => m.type === "managed" && m.requestId === requestId,
        );
        assert.equal(
          reply.error,
          undefined,
          "actual trusted Host management call",
        );
        return reply.result as RecordJSON;
      },
    };
  } catch (error) {
    await service.stop();
    throw error;
  }
}
async function daemon(
  root: string,
  socketPath: string,
  baseUrl: string,
  key: string,
  owned: {
    listener?: boolean;
    peerPort?: number;
    listenerPort?: number;
    cacheOrigin?: string;
    seed?: { botId: string; count: number; bytes: number; spread?: boolean };
    holdAuto?: boolean;
  } = {},
) {
  mkdirSync(root, { mode: 0o700, recursive: true });
  const script = join(root, "daemon.mjs");
  writeFileSync(
    script,
    `import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
const reader=createInterface({input:process.stdin});const lines=reader[Symbol.asyncIterator]();
const config=JSON.parse((await lines.next()).value);
Object.assign(process.env,{BOTS_BASE_URL:config.baseUrl,BOTS_API_KEY:config.key,BOTS_PROVIDER:'device-local',BOTS_MODEL:'scripted-local',BOTS_THINKING_LEVEL:'off',BOTS_TOOL_GROUPS:'core',BOTS_COMPACTION:'off'});
const fs=await import('node:fs/promises');
const {syncBuiltinESMExports}=await import('node:module');
let holdStage=false,releaseStage;
const originalFileOpen=fs.default.open;
fs.default.open=async function(path,...args){
 const file=await originalFileOpen(path,...args);
 if(String(path).includes('/.stage-')){
  const originalSync=file.sync.bind(file);
  file.sync=async()=>{await originalSync();if(holdStage && (holdStage!=='slot'||String(path).includes('.recipients/'))){holdStage=false;process.stdout.write(JSON.stringify({type:'stageHeld'})+'\\n');await new Promise(resolve=>{releaseStage=resolve;});}};
 }
 return file;
};syncBuiltinESMExports();
const originalNow=Date.now;
const {readConfig}=await import(pathToFileURL(config.source+'/src/config.ts').href);
const {startDaemon}=await import(pathToFileURL(config.source+'/src/main.ts').href);
const {SocketDeviceSyncPort}=await import(pathToFileURL(config.source+'/src/device-sync.ts').href);
let holdKey=false,releaseKey;
const originalOpen=SocketDeviceSyncPort.prototype.openKey;
SocketDeviceSyncPort.prototype.openKey=async function(...args){
 const result=await originalOpen.apply(this,args);
 if(holdKey){holdKey=false;process.stdout.write(JSON.stringify({type:'keyHeld'})+'\\n');await new Promise(resolve=>{releaseKey=resolve;});}
 return result;
};
let dispatcher;
if(config.owned.peerPort){
 const {Agent,buildConnector,setGlobalDispatcher}=await import(pathToFileURL(config.repository+'/node_modules/undici/index.js').href);
 const connector=buildConnector({});dispatcher=new Agent({connect(options,callback){connector(options.hostname==='100.64.1.2'&&Number(options.port)===config.owned.peerPort?{...options,hostname:'127.0.0.1',host:'127.0.0.1'}:options,callback);}});setGlobalDispatcher(dispatcher);
}
if(config.owned.seed){
 const {openReplica}=await import(pathToFileURL(config.source+'/test/support/replica.ts').href);
 const {BACKGROUND_CONTEXT:ctx}=await import(pathToFileURL(config.source+'/node_modules/@earendil-works/chord/dist/context/index.js').href);
 const seed=config.owned.seed,replica=await openReplica(config.root+'/bots/'+seed.botId,seed.botId);
 try{const targets=seed.spread?replica.sync.store.conversations().map(c=>c.id):[replica.root.id];await replica.root.commit(async tx=>{for(let i=0;i<seed.count;i++)await tx.appendEntry(targets[i%targets.length],{kind:'fixture.auto.large',data:{i,body:'x'.repeat(seed.bytes)}});},ctx);await replica.command('status',{});}finally{await replica.close();}
}
const {AutomaticSync}=await import(pathToFileURL(config.source+'/src/sync-auto.ts').href);
let faultReceive=false,faultStore,sqlCause,applyFailure,applyCalls=0;
const {ReplicaStore}=await import(pathToFileURL(config.source+'/src/runtime/pi/ReplicaStore.ts').href);
const originalReceive=ReplicaStore.prototype.receive;
ReplicaStore.prototype.receive=function(page){const result=originalReceive.call(this,page);if(faultReceive){faultReceive=false;faultStore=this;this.db.exec('ALTER TABLE facts RENAME TO owned_failed_facts');process.stdout.write(JSON.stringify({type:'receiveCommittedIO',source:page.source,through:page.nextAfter})+'\\n');}return result;};
for(const name of ['fact','putFact']){const original=ReplicaStore.prototype[name];ReplicaStore.prototype[name]=function(...args){try{return original.apply(this,args);}catch(cause){if(this===faultStore)sqlCause=cause;throw cause;}};}
const {AuthenticatedSync}=await import(pathToFileURL(config.source+'/src/sync-pull.ts').href);
const statusReportTracked=AuthenticatedSync.prototype.statusReport;
AuthenticatedSync.prototype.statusReport=async function(...args){try{return await statusReportTracked.apply(this,args);}catch(error){process.stdout.write(JSON.stringify({type:'ownedStatusReportFailure',trace:args[2],causeName:error.cause?.name,causeCode:error.cause?.message?.match(/^[a-z_]+$/)?.[0],issues:error.cause?.issues?.map(i=>({path:i.path,code:i.code}))})+'\\n');throw error;}};
const originalRelayRegister=AuthenticatedSync.prototype.relayRegister;
AuthenticatedSync.prototype.relayRegister=async function(...args){try{return await originalRelayRegister.apply(this,args);}catch(error){process.stdout.write(JSON.stringify({type:'ownedRelayRegisterFailure',causeName:error.cause?.name,causeCode:error.cause?.message?.match(/^[a-z_]+$/)?.[0],issues:error.cause?.issues?.map(i=>({path:i.path,code:i.code}))})+'\\n');throw error;}};
const originalApply=AuthenticatedSync.prototype.applyObject;
AuthenticatedSync.prototype.applyObject=async function(...args){applyCalls++;try{return await originalApply.apply(this,args);}catch(error){if(sqlCause)applyFailure={kind:error.failure?.kind,failure:error.failure?.id,trace:args[2],botId:args[0],causeCode:error.cause?.code,originalCause:error.cause===sqlCause};throw error;}};
let registerGate='',registerStatusDone=false,releaseRegisterGate,registerPending=0,registerCalls=0;
const {BotRegistry}=await import(pathToFileURL(config.source+'/src/core/BotRegistry.ts').href);
const originalReadyReplica=BotRegistry.prototype.readyReplica;
const registrationGate=async(stage)=>{if(registerGate!==stage)return;registerGate='';process.stdout.write(JSON.stringify({type:'registrationHeld',stage})+'\\n');await new Promise(resolve=>{releaseRegisterGate=resolve;});};
BotRegistry.prototype.readyReplica=async function(...args){
 const replica=await originalReadyReplica.apply(this,args);if(!String(args[1]).startsWith('tr_auto_'))return replica;
 return {...replica,command:async(...command)=>{const result=await replica.command(...command);if(command[0]==='status'){registerStatusDone=true;await registrationGate('status');}return result;},check:async()=>{await replica.check();if(registerStatusDone)await registrationGate('check');}};
};
const registerTracked=AuthenticatedSync.prototype.relayRegister;
AuthenticatedSync.prototype.relayRegister=async function(...args){registerCalls++;registerPending++;try{return await registerTracked.apply(this,args);}finally{registerPending--;}};
const originalAutoStart=AutomaticSync.prototype.start;let automatic;
AutomaticSync.prototype.start=function(){automatic=this;if(!config.owned.holdAuto)originalAutoStart.call(this);};
const daemon=await startDaemon(readConfig({argv:['--root',config.root,'--port','0'],env:{BOTS_DEVICE_SOCKET:config.socketPath,BOTS_SYNC_CACHE_ORIGIN:config.owned.cacheOrigin}}));
let metadataDrop,dropStatusReply=false,lostStatusReplies=0,lastStatusReply;
const originalFetch=globalThis.fetch;
globalThis.fetch=(url,options)=>{
 if(dropStatusReply&&String(url).endsWith('/v1/relay/status-report')){dropStatusReply=false;return originalFetch('http://127.0.0.1:'+metadataDrop.address().port+'/v1/relay/status-report',options);}
 return originalFetch(url,options);
};
let server,listenerPort,networkMode='',networkReleased=[],pageSuccess=0,challengeSeen=0;
const serve=async(request,response)=>{
 if(request.url==='/v1/sync/challenge'){
  challengeSeen++;
  if(networkMode==='hold-challenge'){
   process.stdout.write(JSON.stringify({type:'networkHeld'})+'\\n');
   await new Promise(resolve=>networkReleased.push(resolve));
  }
 }
 response.once('finish',()=>{if(request.url==='/v1/sync/page'&&response.statusCode===200)pageSuccess++;});
 daemon.sync.handler(request,response);
};
if(config.owned.listener){
 const {createServer}=await import('node:http');server=createServer(serve);
 await new Promise(resolve=>server.listen(config.owned.listenerPort??0,'127.0.0.1',resolve));
 listenerPort=server.address().port;
}
process.stdout.write(JSON.stringify({type:'ready',port:daemon.port,peerPort:server?.address().port})+'\\n');
for await(const line of lines){
 const input=JSON.parse(line);let result={};
 if(input.command==='holdKey')holdKey=true;
 if(input.command==='holdStage')holdStage=true;
 if(input.command==='holdSlot')holdStage='slot';
 if(input.command==='releaseStage'){releaseStage?.();releaseStage=undefined;}
 if(input.command==='advance')Date.now=()=>originalNow()+60001;
 if(input.command==='resetClock')Date.now=originalNow;
 if(input.command==='clock')Date.now=()=>originalNow()+Number(input.offset);
 if(input.command==='networkMode')networkMode=input.mode;
 if(input.command==='releaseNetwork'){for(const release of networkReleased)release();networkReleased=[];networkMode='';}
 if(input.command==='networkStats')result={pageSuccess,challengeSeen};
 if(input.command==='stopListener'&&server){await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});server=undefined;}
 if(input.command==='restartListener'&&!server){const {createServer}=await import('node:http');server=createServer(serve);await new Promise(resolve=>server.listen(listenerPort,'127.0.0.1',resolve));}
 if(input.command==='shutdownRegistry')await daemon.registry.shutdown();
 if(input.command==='releaseKey'){releaseKey?.();releaseKey=undefined;}
 if(input.command==='faultReceiveIO')faultReceive=true;
 if(input.command==='receiveIOStats')result={failure:applyFailure};
 if(input.command==='restoreReceiveIO'&&faultStore){faultStore.db.exec('ALTER TABLE owned_failed_facts RENAME TO facts');faultStore=undefined;}
 if(input.command==='holdRegistration'){registerGate=input.stage;registerStatusDone=false;}
 if(input.command==='releaseRegistration'){releaseRegisterGate?.();releaseRegisterGate=undefined;}
 if(input.command==='registrationStats'){await new Promise(resolve=>setImmediate(resolve));result={registerCalls,registerPending};}
 if(input.command==='dropStatusReply'){
  if(!metadataDrop){
   const {createServer}=await import('node:http');
   metadataDrop=createServer(async(request,response)=>{
    try{
     const chunks=[];let bytes=0;for await(const chunk of request){bytes+=chunk.length;if(bytes>65536)throw new Error('owned metadata budget');chunks.push(chunk);}
     const upstream=await originalFetch(config.owned.cacheOrigin+'/v1/relay/status-report',{method:'POST',headers:{'content-type':'application/json',authorization:request.headers.authorization,'x-bots-sync-trace':request.headers['x-bots-sync-trace'],'x-bots-sync-bot':request.headers['x-bots-sync-bot']},body:Buffer.concat(chunks)});
     await upstream.arrayBuffer();lastStatusReply=upstream.status;if(upstream.ok)lostStatusReplies++;
    }catch{lastStatusReply=0;}finally{response.destroy();}
   });
   await new Promise(resolve=>metadataDrop.listen(0,'127.0.0.1',resolve));
  }
  dropStatusReply=true;
 }
 if(input.command==='statusReplyStats')result={lostStatusReplies,lastStatusReply};
 if(input.command==='startAuto')originalAutoStart.call(automatic);
 if(input.command==='stopRelay')daemon.sync.relayStop(input.botId);
 if(input.command==='syncObjectCalls')result={applyCalls};
 if(input.command==='clearReady')daemon.sync.setReady(undefined);
 if(input.command==='closeSync')daemon.sync.close();
 if(input.command==='applyProbe'){
  try{await daemon.sync.applyObject(input.botId,input.objectId,input.trace);result={unexpected:true};}
  catch(error){result={kind:error.failure?.kind,causeCode:error.cause?.code,failure:error.failure?.id};}
 }
 process.stdout.write(JSON.stringify({type:'controlled',requestId:input.requestId,...result})+'\\n');
};
for(const release of networkReleased)release();
if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
if(metadataDrop)await new Promise(resolve=>{metadataDrop.close(resolve);metadataDrop.closeAllConnections();});
await daemon.close();await dispatcher?.close();reader.close();`,
  );
  const service = processPort(script, root);
  service.send({
    root,
    socketPath,
    baseUrl,
    key,
    source: resolve("apps/bots"),
    repository: resolve("."),
    owned,
  });
  try {
    const ready = await service.message((m) => m.type === "ready");
    const token = readFileSync(join(root, "token"), "utf8").trim();
    return {
      ...service,
      origin: `http://127.0.0.1:${ready.port}`,
      token,
      peerPort: Number(ready.peerPort),
      async control(command: string, params: RecordJSON = {}) {
        const requestId = randomUUID();
        service.send({ command, requestId, ...params });
        return service.message(
          (m) => m.type === "controlled" && m.requestId === requestId,
        );
      },
      async post<T = RecordJSON>(path: string, body: unknown, method = "POST") {
        const response = await fetch(`http://127.0.0.1:${ready.port}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
        });
        const result = (await response.json()) as T;
        if (!response.ok && path.endsWith("/sync/relay/register"))
          console.log(
            JSON.stringify(
              await service.message(
                (m) => m.type === "ownedRelayRegisterFailure",
              ),
            ),
          );
        assert(
          response.ok,
          `actual Bot route ${path}: ${response.status} ${JSON.stringify(result)}`,
        );
        return result;
      },
    };
  } catch (error) {
    await service.stop();
    throw error;
  }
}

test("real main peer/PR history object cold-starts offline with exact bytes/head/sections and passive zero execution", {
  timeout: 90000,
}, async () => {
  const root = realpathSync(mkdtempSync("/tmp/eagle-encrypted-entry-"));
  const workerRoot = mkdtempSync(resolve(".local/encrypted-entry-worker-"));
  const key = randomBytes(32).toString("base64url");
  const model = await modelFixture(key),
    server = model.server,
    modelOrigin = model.baseUrl;
  let baseline = 0;
  const clients: Awaited<ReturnType<typeof botConnection>>[] = [];
  const services: { stop(): Promise<void> }[] = [];
  const bots: { stop(): Promise<void> }[] = [];
  let worker: Awaited<ReturnType<typeof workerFixture>> | undefined;
  try {
    worker = await workerFixture(workerRoot);
    const a = await helper(join(root, "a"), worker.origin);
    services.push(a);
    const cli = join(root, "cli");
    mkdirSync(cli);
    writeFileSync(
      join(cli, "tailscale"),
      `#!/bin/sh\nprintf '%s' '{"BackendState":"Running","Self":{"TailscaleIPs":["100.64.1.2"]}}'\n`,
    );
    chmodSync(join(cli, "tailscale"), 0o700);
    const b = await helper(join(root, "b"), worker.origin, true, cli);
    services.push(b);
    assert.notEqual(a.deviceId, b.deviceId);
    assert.notEqual(a.publicKey, b.publicKey);
    const invitation = await a.manage("pairing.create", {});
    await b.manage("pairing.redeem", {
      requestId: randomUUID(),
      code: invitation.code,
    });
    let bd = await daemon(
      join(root, "b-bots"),
      b.socketPath,
      modelOrigin,
      key,
      { listener: true },
    );
    bots.push(bd);
    const ad = await daemon(
      join(root, "a-bots"),
      a.socketPath,
      modelOrigin,
      key,
      { peerPort: bd.peerPort },
    );
    bots.push(ad);
    const ab = (
      await ad.post<{ bot: { id: string } }>("/v1/bots", { title: "Reader" })
    ).bot.id;
    const bb = (
      await bd.post<{ bot: { id: string } }>("/v1/bots", { title: "Publisher" })
    ).bot.id;
    const sharedBotId = randomUUID();
    await ad.post(`/v1/bots/${ab}/replica/bind`, { sharedBotId });
    await bd.post(`/v1/bots/${bb}/replica/bind`, { sharedBotId });
    const resources = JSON.parse(
      readFileSync("fixtures/bots-sync/resources.v1.json", "utf8"),
    );
    const carrier = await bd.post(`/v1/bots/${bb}/replica/export`, {
      kind: "resources",
      resources,
    });
    assert.equal(carrier.kind, "resources");
    const initial = await bd.post<Page>(`/v1/bots/${bb}/replica/pull`, {
      after: 0,
    });
    assert.equal(initial.events.length, resources.length + 1);
    let sourceClient = await botConnection(bd.origin, bd.token, bb);
    clients.push(sourceClient);
    const native = await sourceClient.run(
      "bash",
      model,
      {
        command: "printf source-history",
      },
      { resourceHead: String(carrier.head) },
    );
    assert.equal(native.isError, false);
    const target = (
      await bd.post<{ bot: { id: string } }>("/v1/bots", {
        title: "Local peer",
      })
    ).bot.id;
    const targetResources = await bd.post(`/v1/bots/${target}/replica/export`, {
      kind: "resources",
      resources,
    });
    const targetClient = await botConnection(bd.origin, bd.token, target);
    clients.push(targetClient);
    assert.equal(
      (
        await targetClient.run(
          "bash",
          model,
          { command: "printf target-selected" },
          { resourceHead: String(targetResources.head) },
        )
      ).isError,
      false,
    );
    await bd.post(
      "/v1/settings",
      { toolGroups: ["core", "coding", "peers"] },
      "PUT",
    );
    assert.deepEqual(
      await bd.post(`/v1/bots/${bb}/replica/export`, {
        kind: "resources",
        head: carrier.head,
      }),
      carrier,
    );
    const pull = {
      url: "https://github.com/nocoo/eagle/pull/109",
      title: "combined journal fixture",
      status: "merged",
    };
    const reported = await sourceClient.run("pr_register", model, pull, {
      resourceHead: String(carrier.head),
    });
    assert.equal(reported.isError, false);
    const pullEvent = sourceClient.messages.find(
      (message) => message.type === "pulls",
    );
    assert(
      pullEvent,
      "production main connects the pull publisher to the subscribed client",
    );
    const reportedPulls = pullEvent.pulls;
    assert.match(JSON.stringify(reportedPulls), /combined journal fixture/);
    const peerStart = model.inputs.length;
    const sent = await sourceClient.run(
      "peer_send",
      model,
      { botId: target, message: "combined-local-peer" },
      { resourceHead: String(carrier.head), extraReplies: 1 },
    );
    assert.equal(sent.isError, false);
    const exchanges = (await (
      await fetch(`${bd.origin}/v1/bots/${bb}/exchanges`, {
        headers: { authorization: `Bearer ${bd.token}` },
      })
    ).json()) as { exchanges: { id: string }[] };
    assert.equal(exchanges.exchanges.length, 1);
    const [summary] = exchanges.exchanges;
    assert(summary);
    const exchangeId = summary.id;
    const exchange = await until(async () => {
      const result = (await (
        await fetch(`${bd.origin}/v1/bots/${bb}/exchanges/${exchangeId}`, {
          headers: { authorization: `Bearer ${bd.token}` },
        })
      ).json()) as {
        exchange: {
          turns: { requestId: string; text: string; answer?: string }[];
        };
      };
      return result.exchange.turns[0]?.answer === "done"
        ? result.exchange
        : undefined;
    }, "real peer answer through main HTTP API");
    const [peerTurn] = exchange.turns;
    assert(peerTurn);
    const peerRequestId = peerTurn.requestId;
    const peerInputs = model.inputs
      .slice(peerStart)
      .filter(
        (input) =>
          JSON.stringify(input).includes("combined-local-peer") &&
          !JSON.stringify(input).includes("Integration: peer_send"),
      );
    assert.equal(peerInputs.length, 1);
    const instructions = Buffer.from(resources[0].base64, "base64")
      .toString("utf8")
      .trim();
    assert.equal(
      JSON.stringify(peerInputs[0]).includes(instructions),
      false,
      "new peer invocation never inherits sender or target active resources",
    );
    const sourceInputs = model.inputs
      .slice(peerStart)
      .filter((input) =>
        JSON.stringify(input).includes("Integration: peer_send"),
      );
    assert(
      sourceInputs.some((input) =>
        JSON.stringify(input).includes(instructions),
      ),
      "tool refresh retains the bots-resources extension",
    );
    const targetDb = new DatabaseSync(
      join(root, "b-bots/bots", target, "replica.sqlite"),
      { readOnly: true },
    );
    try {
      const row = targetDb
        .prepare("SELECT value FROM local_runs WHERE request_id=?")
        .get(peerRequestId);
      assert(row);
      const intent = JSON.parse(String(row.value)).intent;
      assert.equal(intent.resourceHead, undefined);
      assert.equal(intent.resourceVersion, undefined);
    } finally {
      targetDb.close();
    }
    const providerBeforeRetry = model.verify();
    const peerRetry = await targetClient.request({
      requestId: peerRequestId,
      text: "combined-local-peer",
    });
    assert.equal(peerRetry.type, "submission");
    assert.equal(peerRetry.status, "done");
    const conflict = await targetClient.request({
      requestId: peerRequestId,
      text: "combined-local-peer",
      resourceHead: targetResources.head,
    });
    assert.equal(conflict.type, "error");
    assert.equal(conflict.disposition, "not_admitted");
    assert.equal(model.verify(), providerBeforeRetry);
    console.log(
      JSON.stringify({
        combinedMain: {
          peerAnswer: peerTurn.answer,
          peerLegacyEmpty: true,
          retryNoNewExecution: true,
          conflictingResourcesRejected: true,
          pullEvent: true,
          refreshedResourcesIntact: true,
        },
      }),
    );
    const journalFile = join(root, "b-bots/bots", bb, "pulls.journal.jsonl");
    const journal = readFileSync(journalFile);
    for (const client of [sourceClient, targetClient])
      await new Promise<void>((done) => {
        client.socket.once("close", () => done());
        client.socket.close();
      });
    const listenerPort = bd.peerPort;
    await bd.stop();
    bd = await daemon(join(root, "b-bots"), b.socketPath, modelOrigin, key, {
      listener: true,
      listenerPort,
    });
    bots.push(bd);
    sourceClient = await botConnection(bd.origin, bd.token, bb);
    clients.push(sourceClient);
    assert.deepEqual(
      (sourceClient.snapshot.value as JSONRecord).pulls,
      reportedPulls,
    );
    assert.deepEqual(readFileSync(journalFile), journal);
    baseline = model.verify();
    assert.equal(baseline, 9);
    const history = await bd.post<History>(`/v1/bots/${bb}/replica/export`, {});
    assert(history.entries.length > 0);
    assert.match(JSON.stringify(history.entries), /pr_register/);
    assert.match(JSON.stringify(history.entries), /peer_send/);
    assert.match(JSON.stringify(history.entries), /combined journal fixture/);
    const sectionOrders = (bundle: History) =>
      bundle.entries.flatMap((entry) =>
        (entry.model ?? []).flatMap((message) =>
          message.sections ? [Object.keys(message.sections)] : [],
        ),
      );
    const originalSections = sectionOrders(history);
    assert(originalSections.some((keys: string[]) => keys.length > 1));
    const page = await bd.post<Page>(`/v1/bots/${bb}/replica/pull`, {
      after: 0,
    });
    assert.equal(page.sharedBotId, sharedBotId);
    assert(page.events.length > initial.events.length);
    await b.manage("sync.share", {
      sharedBotId,
      peerDeviceId: a.deviceId,
      enabled: true,
    });
    const access = (await localCall(a.socketPath, "sync.access", {
      sharedBotId,
      peerDeviceId: b.deviceId,
      purpose: "replica.read",
    })) as Access;
    assert.equal(access.local.deviceId, a.deviceId);
    assert.equal(access.peer.deviceId, b.deviceId);
    const authorized = (await localCall(b.socketPath, "sync.peer.authorize", {
      sharedBotId,
      peerDeviceId: a.deviceId,
      purpose: "replica.read",
    })) as Access;
    assert.equal(authorized.local.deviceId, b.deviceId);
    await assert.rejects(
      localCall(a.socketPath, "sync.peer.authorize", {
        sharedBotId,
        peerDeviceId: b.deviceId,
        purpose: "replica.read",
      }),
      /sync_not_shared/,
    );
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
    assert.equal(model.verify(), baseline);
    console.log(
      JSON.stringify({
        prerequisite:
          "real Swift DeviceFileVault+DeviceIdentity+DeviceServiceHost / owned Node / Registry SQLite / paired independent identities / B->A only / actual Bot bindings and resources page",
        providerDelta: model.verify() - baseline,
        pageEvents: page.events.length,
      }),
    );
    await b.manage("sync.endpoints.publish", { syncPort: bd.peerPort });
    const [pulled, concurrent] = await Promise.all(
      [1, 2].map(() =>
        ad.post(`/v1/bots/${ab}/sync/objects/pull`, {
          peerDeviceId: b.deviceId,
          after: 0,
        }),
      ),
    );
    assert.equal(pulled.objectId, concurrent.objectId);
    assert.equal(pulled.cipherDigest, concurrent.cipherDigest);
    assert.equal(pulled.stored, true);
    assert.equal(pulled.applied, false);
    const objectId = pulled.objectId;
    const aFile = join(root, "a-bots/sync-objects/v1", objectId + ".json");
    const bFile = join(root, "b-bots/sync-objects/v1", objectId + ".json");
    const originalA = readFileSync(aFile),
      originalB = readFileSync(bFile);
    const alternative = await ad.post(`/v1/bots/${ab}/sync/objects/pull`, {
      peerDeviceId: b.deviceId,
      after: 0,
      limit: 1,
    });
    assert.notEqual(alternative.objectId, objectId);
    const alternativeBytes = readFileSync(
      join(root, "a-bots/sync-objects/v1", alternative.objectId + ".json"),
    );
    const wrongWinnerRoot = join(root, "wrong-object-winner");
    mkdirSync(wrongWinnerRoot, { mode: 0o700 });
    const wrongWinners = storeCommand<{ mode: string; accepted: boolean }[]>({
      mode: "wrong-object-winner",
      root: wrongWinnerRoot,
      record: JSON.parse(originalA.toString()),
      other: JSON.parse(alternativeBytes.toString()),
    });
    const beforeWrongWinner = counts(join(root, "a-bots/bots", ab));
    unlinkSync(aFile);
    assert.equal(existsSync(aFile), false);
    await ad.control("holdStage");
    const substitutedPull = fetch(
      ad.origin + `/v1/bots/${ab}/sync/objects/pull`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${ad.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ peerDeviceId: b.deviceId, objectId }),
      },
    );
    await ad.message((m) => m.type === "stageHeld");
    writeFileSync(aFile, alternativeBytes, { flag: "wx", mode: 0o600 });
    await ad.control("releaseStage");
    const substitutedResponse = await substitutedPull;
    const substitutedResult = (await substitutedResponse.json()) as RecordJSON;
    assert.deepEqual(readFileSync(aFile), alternativeBytes);
    unlinkSync(aFile);
    writeFileSync(aFile, originalA, { flag: "wx", mode: 0o600 });
    assert.deepEqual(counts(join(root, "a-bots/bots", ab)), beforeWrongWinner);
    assert.equal(model.verify(), baseline);
    console.log(
      JSON.stringify({
        wrongObjectWinner: {
          requested: objectId,
          substituted: alternative.objectId,
          sameBotBindingPublisher: true,
          legalSignedRecord: true,
          store: wrongWinners,
          routeStatus: substitutedResponse.status,
          routeResult: substitutedResult,
          executionDelta: 0,
        },
      }),
    );
    assert.equal(
      substitutedResponse.status,
      403,
      "no stored ACK for a valid different-objectId winner",
    );
    assert.notEqual(substitutedResult.stored, true);
    for (const result of wrongWinners)
      assert.equal(
        result.accepted,
        false,
        result.mode + " must bind the target objectId",
      );
    const publisherRecord = JSON.parse(originalB.toString());
    const prepared = storeCommand<{
      key: string;
      manifest: unknown;
      ciphertext: string;
    }>({
      mode: "prepare",
      page,
      publisher: publisherRecord.pin.publisher,
      origin: worker.origin,
    });
    const sealed = (await localCall(b.socketPath, "sync.key.seal", {
      version: 1,
      identity: publisherRecord.pin.publisher,
      manifest: prepared.manifest,
      dek: prepared.key,
    })) as RecordJSON;
    const other = storeCommand({
      mode: "record",
      record: publisherRecord,
      carrier: { version: 1, ...sealed, ciphertext: prepared.ciphertext },
    });
    const storeRoot = join(root, "store-invariants");
    mkdirSync(storeRoot, { mode: 0o700 });
    const invariants = storeCommand({
      mode: "invariants",
      root: storeRoot,
      record: publisherRecord,
      other,
    });
    console.log(JSON.stringify({ storeInvariants: invariants }));
    const slotDirectory = join(
      root,
      "b-bots/sync-objects/v1",
      objectId + ".recipients",
    );
    assert.equal(readdirSync(slotDirectory).length, 1);
    const slotPath = join(slotDirectory, readdirSync(slotDirectory)[0]);
    const originalSlot = readFileSync(slotPath);
    const issuedRecord = JSON.parse(originalA.toString());
    const issueRequest = {
      version: 1,
      identity: publisherRecord.pin.publisher,
      manifest: publisherRecord.carrier.manifest,
      envelope: publisherRecord.carrier.envelope,
      recipient: issuedRecord.pin.recipient,
      recipientDescriptor: issuedRecord.carrier.envelope.recipientDescriptor,
    };
    const hold = join(root, "b/hold-helper"),
      held = join(root, "b/helper-held");
    writeFileSync(hold, "sync_key_envelope_result");
    const issuing = localCall(b.socketPath, "sync.key.envelope", issueRequest);
    void issuing.catch(() => {});
    await until(
      async () => (existsSync(held) ? true : undefined),
      "actual helper envelope response held before Node authorization recheck",
    );
    await storage.exec(
      "DELETE FROM sync_grants WHERE grantingDeviceId=? AND sharedBotId=? AND peerDeviceId=?",
      b.deviceId,
      sharedBotId,
      a.deviceId,
    );
    unlinkSync(hold);
    await assert.rejects(issuing, /sync_not_shared/);
    unlinkSync(held);
    await b.manage("sync.share", {
      sharedBotId,
      peerDeviceId: a.deviceId,
      enabled: true,
    });
    assert.deepEqual(readFileSync(slotPath), originalSlot);
    assert.equal(model.verify(), baseline);
    const readerRecord = JSON.parse(originalA.toString());
    const descriptors = [];
    for (let i = 0; i < 2; i++)
      descriptors.push({
        issuer: await localCall(b.socketPath, "sync.key.descriptor", {}),
        recipient: await localCall(a.socketPath, "sync.key.descriptor", {}),
      });
    console.log(
      JSON.stringify({
        descriptorSlots: storeCommand({
          mode: "slots",
          root: join(root, "b-bots"),
          record: publisherRecord,
          issuer: publisherRecord.pin.publisher,
          recipient: readerRecord.pin.recipient,
          descriptors,
        }),
      }),
    );
    assert.equal(readdirSync(slotDirectory).length, 1);
    assert.deepEqual(readFileSync(slotPath), originalSlot);
    const ioBefore = counts(join(root, "a-bots/bots", ab));
    chmodSync(aFile, 0o000);
    const probe = await ad.control("applyProbe", {
      botId: ab,
      objectId,
      trace: "tr_object_storage_owned",
    });
    const denied = await fetch(
      ad.origin + `/v1/bots/${ab}/sync/objects/apply`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${ad.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ objectId }),
      },
    );
    chmodSync(aFile, 0o600);
    assert.equal(denied.status, 503);
    assert.equal(probe.kind, "storage_failed");
    assert.equal(probe.causeCode, "EACCES");
    const logs = readdirSync(join(root, "a-bots/logs")).flatMap((file) =>
      readFileSync(join(root, "a-bots/logs", file), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
    const attributed = logs.filter((log) => log.err?.failure === probe.failure);
    assert.equal(
      attributed.filter(
        (log) => log.level === "error" && log.err.origin === true,
      ).length,
      1,
    );
    assert(
      attributed.every(
        (log) => log.trace === "tr_object_storage_owned" && log.botId === ab,
      ),
    );
    const badCipher = JSON.parse(originalA.toString());
    const originalCiphertext = badCipher.carrier.ciphertext;
    const changedCipher = Buffer.from(
      badCipher.carrier.ciphertext,
      "base64url",
    );
    changedCipher[0] = (changedCipher[0] ?? 0) ^ 1;
    badCipher.carrier.ciphertext = changedCipher.toString("base64url");
    assert.notEqual(badCipher.carrier.ciphertext, originalCiphertext);
    writeFileSync(aFile, JSON.stringify(badCipher));
    const cryptoDenied = await fetch(
      ad.origin + `/v1/bots/${ab}/sync/objects/apply`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${ad.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ objectId }),
      },
    );
    writeFileSync(aFile, originalA);
    assert.equal(cryptoDenied.status, 403);
    assert.deepEqual(counts(join(root, "a-bots/bots", ab)), ioBefore);
    assert.equal(model.verify(), baseline);
    const retry = await ad.post(`/v1/bots/${ab}/sync/objects/pull`, {
      peerDeviceId: b.deviceId,
      objectId,
    });
    assert.equal(retry.objectId, objectId);
    assert.deepEqual(readFileSync(aFile), originalA);
    assert.deepEqual(readFileSync(bFile), originalB);
    assert.equal(readdirSync(slotDirectory).length, 1);
    assert.deepEqual(readFileSync(slotPath), originalSlot);
    await b.stop();
    const reopenedB = await helper(join(root, "b"), worker.origin, true, cli);
    services.push(reopenedB);
    assert.equal(reopenedB.deviceId, b.deviceId);
    await ad.post(`/v1/bots/${ab}/sync/objects/pull`, {
      peerDeviceId: b.deviceId,
      objectId,
    });
    assert.deepEqual(readFileSync(bFile), originalB);
    assert.deepEqual(readFileSync(slotPath), originalSlot);
    for (const boundary of [
      "publisher-epoch",
      "publisher-generation",
      "publisher-expiry",
      "slot-epoch",
      "slot-generation",
      "slot-expiry",
    ]) {
      const targetA = (
        await ad.post<{ bot: { id: string } }>("/v1/bots", {
          title: "Server fence reader " + boundary,
        })
      ).bot.id;
      const targetB = (
        await bd.post<{ bot: { id: string } }>("/v1/bots", {
          title: "Server fence source " + boundary,
        })
      ).bot.id;
      const shared = randomUUID();
      await ad.post(`/v1/bots/${targetA}/replica/bind`, {
        sharedBotId: shared,
      });
      await bd.post(`/v1/bots/${targetB}/replica/bind`, {
        sharedBotId: shared,
      });
      await bd.post(`/v1/bots/${targetB}/replica/export`, {
        kind: "resources",
        resources,
      });
      await reopenedB.manage("sync.share", {
        sharedBotId: shared,
        peerDeviceId: a.deviceId,
        enabled: true,
      });
      const aDirectory = join(root, "a-bots/bots", targetA),
        bDirectory = join(root, "b-bots/bots", targetB);
      const beforeA = counts(aDirectory),
        beforeB = counts(bDirectory);
      const objectDirectory = join(root, "b-bots/sync-objects/v1");
      const beforeFiles = readdirSync(objectDirectory).filter((name) =>
        name.endsWith(".json"),
      );
      await bd.control(boundary.startsWith("slot") ? "holdSlot" : "holdStage");
      const pending = ad.post(`/v1/bots/${targetA}/sync/objects/pull`, {
        peerDeviceId: b.deviceId,
        after: 0,
      });
      void pending.catch(() => {});
      await bd.message((m) => m.type === "stageHeld");
      const restore = boundary.endsWith("epoch")
        ? changeBinding(bDirectory, "epoch", randomUUID())
        : () => {};
      if (boundary.endsWith("generation")) await bd.control("clearReady");
      if (boundary.endsWith("expiry")) await bd.control("advance");
      await bd.control("releaseStage");
      try {
        await assert.rejects(pending, /400|403/);
      } finally {
        restore();
        if (boundary.endsWith("expiry")) await bd.control("resetClock");
      }
      assert.deepEqual(counts(aDirectory), beforeA);
      assert.deepEqual(counts(bDirectory), beforeB);
      const afterFiles = readdirSync(objectDirectory).filter((name) =>
        name.endsWith(".json"),
      );
      assert.equal(
        afterFiles.length - beforeFiles.length,
        boundary.startsWith("slot") ? 1 : 0,
      );
      for (const name of readdirSync(objectDirectory).filter((name) =>
        name.endsWith(".recipients"),
      )) {
        if (!beforeFiles.includes(name.replace(".recipients", ".json")))
          assert.equal(readdirSync(join(objectDirectory, name)).length, 0);
      }
      assert.equal(model.verify(), baseline);
      console.log(
        JSON.stringify({
          actualServerStagedBoundary: boundary,
          readerStored: false,
          executionDelta: 0,
        }),
      );
    }
    for (const boundary of [
      "epoch",
      "replicaId",
      "sharedBotId",
      "localBotId",
      "generation",
      "expiry",
      "grant",
      "delete",
      "close",
    ]) {
      const targetA = (
        await ad.post<{ bot: { id: string } }>("/v1/bots", {
          title: "Fence reader " + boundary,
        })
      ).bot.id;
      const targetB = (
        await bd.post<{ bot: { id: string } }>("/v1/bots", {
          title: "Fence source " + boundary,
        })
      ).bot.id;
      const shared = randomUUID();
      await ad.post(`/v1/bots/${targetA}/replica/bind`, {
        sharedBotId: shared,
      });
      await bd.post(`/v1/bots/${targetB}/replica/bind`, {
        sharedBotId: shared,
      });
      await bd.post(`/v1/bots/${targetB}/replica/export`, {
        kind: "resources",
        resources,
      });
      await reopenedB.manage("sync.share", {
        sharedBotId: shared,
        peerDeviceId: a.deviceId,
        enabled: true,
      });
      const directory = join(root, "a-bots/bots", targetA),
        before = counts(directory);
      const existingFiles = readdirSync(
        join(root, "a-bots/sync-objects/v1"),
      ).filter((name) => name.endsWith(".json"));
      await ad.control("holdStage");
      const pending = ad.post(`/v1/bots/${targetA}/sync/objects/pull`, {
        peerDeviceId: b.deviceId,
        after: 0,
      });
      void pending.catch(() => {});
      await ad.message((m) => m.type === "stageHeld");
      let restore = () => {};
      if (
        ["epoch", "replicaId", "sharedBotId", "localBotId"].includes(boundary)
      )
        restore = changeBinding(directory, boundary, randomUUID());
      if (boundary === "generation") await ad.control("clearReady");
      if (boundary === "expiry") await ad.control("advance");
      if (boundary === "grant")
        await reopenedB.manage("sync.share", {
          sharedBotId: shared,
          peerDeviceId: a.deviceId,
          enabled: false,
        });
      if (boundary === "close") await ad.control("shutdownRegistry");
      if (boundary === "delete") {
        const deleted = await fetch(ad.origin + `/v1/bots/${targetA}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${ad.token}` },
        });
        assert.equal(deleted.ok, true);
      }
      await ad.control("releaseStage");
      try {
        await assert.rejects(
          pending,
          boundary === "localBotId" ? /503/ : /400|403|404/,
        );
      } finally {
        restore();
        if (boundary === "expiry") await ad.control("resetClock");
      }
      assert.deepEqual(
        readdirSync(join(root, "a-bots/sync-objects/v1")).filter((name) =>
          name.endsWith(".json"),
        ),
        existingFiles,
        "no rejected pin publication",
      );
      if (boundary !== "delete")
        assert.deepEqual(
          counts(directory),
          before,
          "no SDK or replica admission",
        );
      assert.equal(model.verify(), baseline);
      console.log(
        JSON.stringify({
          actualStagedBoundary: boundary,
          published: false,
          executionDelta: 0,
        }),
      );
    }
    await reopenedB.manage("member.remove", { deviceId: a.deviceId });
    const revokedRows = await storage.exec(
      "SELECT groupId,membershipEpoch,credentialVersion FROM devices WHERE deviceId=?",
      a.deviceId,
    );
    assert.equal(revokedRows[0]?.groupId, null);
    assert(Number(revokedRows[0]?.credentialVersion) > 1);
    await assert.rejects(
      localCall(reopenedB.socketPath, "sync.key.envelope", {
        version: 1,
        identity: publisherRecord.pin.publisher,
        manifest: publisherRecord.carrier.manifest,
        envelope: publisherRecord.carrier.envelope,
        recipient: readerRecord.pin.recipient,
        recipientDescriptor: readerRecord.carrier.envelope.recipientDescriptor,
      }),
    );
    const record = JSON.parse(originalA.toString());
    assert.equal(record.pin.publisher.deviceId, b.deviceId);
    assert.equal(record.pin.recipient.deviceId, a.deviceId);
    const origin = worker.origin;
    await new Promise<void>((done) => {
      sourceClient.socket.once("close", () => done());
      sourceClient.socket.close();
    });
    await bd.stop();
    await reopenedB.stop();
    await ad.stop();
    await a.stop();
    await worker.mf.dispose();
    worker = undefined;
    // Cold start begins only after both publisher and Registry are gone; localReady alone.
    const offlineA = await helper(join(root, "a"), origin, false);
    services.push(offlineA);
    const bindingFile = join(root, "a-bots/bots", ab, "replica.sqlite");
    chmodSync(bindingFile, 0o000);
    const offlineDaemon = await daemon(
      join(root, "a-bots"),
      offlineA.socketPath,
      modelOrigin,
      key,
    );
    bots.push(offlineDaemon);
    chmodSync(bindingFile, 0o600);
    const opens = () =>
      readdirSync(join(root, "a-bots/logs"))
        .flatMap((file) =>
          readFileSync(join(root, "a-bots/logs", file), "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        )
        .filter((log) => log.evt === "runtime.open.start").length;
    const beforeSync = opens();
    const peerDirectory = join(root, "a-bots/peers");
    const peersBefore = readdirSync(peerDirectory).map((file) => [
      file,
      readFileSync(join(peerDirectory, file)).toString("base64"),
    ]);
    await assert.rejects(
      offlineDaemon.post(`/v1/bots/${ab}/sync/objects/apply`, { objectId }),
      /400|403/,
    );
    assert.equal(
      opens(),
      beforeSync,
      "only-sync cannot reopen the repaired unavailable local Bot",
    );
    assert.equal(model.verify(), baseline);
    const openedClient = await botConnection(
      offlineDaemon.origin,
      offlineDaemon.token,
      ab,
    );
    clients.push(openedClient);
    assert.equal(model.verify(), baseline);
    const executionCounts = () =>
      Object.fromEntries(
        Object.entries(counts(join(root, "a-bots/bots", ab))).filter(([name]) =>
          /submission|task|local_runs/.test(name),
        ),
      );
    const executionBeforePassive = executionCounts();
    assert("replica.sqlite:local_runs" in executionBeforePassive);
    await offlineDaemon.control("holdKey");
    const passive = offlineDaemon.post(`/v1/bots/${ab}/sync/objects/apply`, {
      objectId,
    });
    void passive.catch(() => {});
    await offlineDaemon.message((m) => m.type === "keyHeld");
    await offlineDaemon.control("clearReady");
    await offlineDaemon.control("releaseKey");
    await passive;
    const reapplied = await offlineDaemon.post(`/v1/bots/${ab}/replica/pull`, {
      source: page.source,
      after: 0,
    });
    assert.equal(JSON.stringify(reapplied), JSON.stringify(page));
    const restored = await offlineDaemon.post<History>(
      `/v1/bots/${ab}/replica/export`,
      { head: history.head },
    );
    assert.equal(restored.head, history.head);
    assert.equal(
      JSON.stringify(restored.entries),
      JSON.stringify(history.entries),
    );
    assert.deepEqual(sectionOrders(restored), originalSections);
    assert.deepEqual(
      executionCounts(),
      executionBeforePassive,
      "passive import admits no local submission, invocation or tool task",
    );
    assert.deepEqual(
      readdirSync(peerDirectory).map((file) => [
        file,
        readFileSync(join(peerDirectory, file)).toString("base64"),
      ]),
      peersBefore,
      "passive history import does not create local peer exchanges",
    );
    assert.equal(
      existsSync(join(root, "a-bots/bots", ab, "pulls.journal.jsonl")),
      false,
      "historical PR tool records do not replay the report tool",
    );
    const { manifest, envelope } = record.carrier,
      { pin } = record;
    const keyResult = (await localCall(offlineA.socketPath, "sync.key.open", {
      version: 1,
      manifest,
      envelope,
      publisherPin: pin.publisher,
      issuerPin: pin.issuer,
      recipientPin: pin.recipient,
    })) as RecordJSON;
    const {
      signature: _signature,
      cipherDigest: _cipherDigest,
      ...header
    } = manifest;
    const encrypted = Buffer.from(record.carrier.ciphertext, "base64url");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(String(keyResult.dek), "base64url"),
      Buffer.from(manifest.nonce, "base64url"),
    );
    decipher.setAAD(
      Buffer.from("eagle-bots-page-object-v1\n" + canonicalDeviceJSON(header)),
    );
    decipher.setAuthTag(encrypted.subarray(-16));
    const plaintext = Buffer.concat([
      decipher.update(encrypted.subarray(0, -16)),
      decipher.final(),
    ]);
    assert.deepEqual(plaintext, Buffer.from(JSON.stringify(page)));
    assert.equal(
      manifest.pageDigest,
      createHash("sha256").update(JSON.stringify(page)).digest("hex"),
    );
    assert.deepEqual(readFileSync(aFile), originalA);
    assert.equal(model.verify(), baseline);
    for (const boundary of ["epoch", "close"]) {
      const directory = join(root, "a-bots/bots", ab),
        before = counts(directory);
      await offlineDaemon.control("holdKey");
      const pending = offlineDaemon.post(`/v1/bots/${ab}/sync/objects/apply`, {
        objectId,
      });
      void pending.catch(() => {});
      await offlineDaemon.message((m) => m.type === "keyHeld");
      const restore =
        boundary === "epoch"
          ? changeBinding(directory, "epoch", randomUUID())
          : () => {};
      if (boundary === "close") await offlineDaemon.control("closeSync");
      await offlineDaemon.control("releaseKey");
      try {
        await assert.rejects(pending, boundary === "epoch" ? /400/ : /403/);
      } finally {
        restore();
      }
      assert.deepEqual(counts(directory), before);
      assert.equal(model.verify(), baseline);
    }
    const proof = await openedClient.run("bash", model, {
      command: "printf offline-native",
    });
    assert.equal(proof.isError, false);
    assert.equal(model.verify(), baseline + 2);
    await offlineA.stop();
    const wrappingPath = join(
      root,
      "a/vault",
      createHash("sha256")
        .update("eagle-bots-wrap-v1:encrypted-object-fixture")
        .digest("hex") + ".json",
    );
    assert(existsSync(wrappingPath));
    unlinkSync(wrappingPath);
    const missingA = await helper(join(root, "a"), origin, false);
    services.push(missingA);
    assert.equal(missingA.deviceId, a.deviceId);
    await assert.rejects(
      localCall(missingA.socketPath, "sync.key.open", {
        version: 1,
        manifest,
        envelope,
        publisherPin: pin.publisher,
        issuerPin: pin.issuer,
        recipientPin: pin.recipient,
      }),
    );
    assert.equal(
      existsSync(wrappingPath),
      false,
      "opening an old object must not silently create a replacement wrapping identity",
    );
    console.log(
      JSON.stringify({
        coldOffline: true,
        historyEntries: history.entries.length,
        sectionOrders: originalSections,
        originalPlaintextBytes: plaintext.length,
        passiveProviderDelta: 0,
        explicitSetupProvider: baseline,
        explicitNativeProviderDelta: 2,
      }),
    );
  } catch (error) {
    for (const dir of ["a-bots", "b-bots"]) {
      try {
        console.log(
          JSON.stringify({
            daemon: dir,
            failures: readdirSync(join(root, dir, "logs"))
              .flatMap((file) =>
                readFileSync(join(root, dir, "logs", file), "utf8")
                  .split("\n")
                  .filter(Boolean)
                  .map((line) => JSON.parse(line)),
              )
              .filter((log) => ["warn", "error"].includes(log.level)),
          }),
        );
      } catch {}
    }
    throw error;
  } finally {
    for (const client of clients) {
      if (client.socket.readyState === WebSocket.OPEN)
        await new Promise<void>((done) => {
          client.socket.once("close", () => done());
          client.socket.close();
        });
    }
    for (const service of bots.reverse()) await service.stop();
    for (const service of services.reverse()) await service.stop();
    await worker?.mf.dispose();
    await new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
    rmSync(root, { recursive: true, force: true });
    rmSync(workerRoot, { recursive: true, force: true });
  }
});

test("durable helper descriptor and cache deliver a page created after the recipient closes", {
  timeout: 90000,
}, async () => {
  const root = realpathSync(mkdtempSync("/tmp/eagle-cache-descriptor-"));
  const workerRoot = mkdtempSync(resolve(".local/cache-descriptor-worker-"));
  const key = randomBytes(32).toString("base64url");
  const model = await modelFixture(key);
  const services: { stop(): Promise<void> }[] = [];
  const bots: { stop(): Promise<void> }[] = [];
  const clients: Awaited<ReturnType<typeof botConnection>>[] = [];
  let worker: Awaited<ReturnType<typeof workerFixture>> | undefined;
  try {
    worker = await workerFixture(workerRoot, true);
    const a = await helper(join(root, "a"), worker.origin);
    services.push(a);
    const b = await helper(join(root, "b"), worker.origin);
    services.push(b);
    assert.notEqual(a.deviceId, b.deviceId);
    assert.notEqual(a.publicKey, b.publicKey);
    const invitation = await a.manage("pairing.create", {});
    await b.manage("pairing.redeem", {
      requestId: randomUUID(),
      code: invitation.code,
    });
    const ad = await daemon(
      join(root, "a-bots"),
      a.socketPath,
      model.baseUrl,
      key,
      { cacheOrigin: worker.origin },
    );
    bots.push(ad);
    const bd = await daemon(
      join(root, "b-bots"),
      b.socketPath,
      model.baseUrl,
      key,
      { cacheOrigin: worker.origin },
    );
    bots.push(bd);
    const ab = (
      await ad.post<{ bot: { id: string } }>("/v1/bots", {
        title: "Offline reader",
      })
    ).bot.id;
    const bb = (
      await bd.post<{ bot: { id: string } }>("/v1/bots", {
        title: "Cache publisher",
      })
    ).bot.id;
    const sharedBotId = randomUUID();
    await ad.post(`/v1/bots/${ab}/replica/bind`, { sharedBotId });
    await bd.post(`/v1/bots/${bb}/replica/bind`, { sharedBotId });
    const resources = JSON.parse(
      readFileSync("fixtures/bots-sync/resources.v1.json", "utf8"),
    );
    await bd.post(`/v1/bots/${bb}/replica/export`, {
      kind: "resources",
      resources,
    });
    const page = await bd.post<Page>(`/v1/bots/${bb}/replica/pull`, {
      after: 0,
    });
    assert.equal(page.events.length, resources.length + 1);
    await b.manage("sync.share", {
      sharedBotId,
      peerDeviceId: a.deviceId,
      enabled: true,
    });
    const access = (await localCall(b.socketPath, "sync.peer.authorize", {
      sharedBotId,
      peerDeviceId: a.deviceId,
      purpose: "replica.read",
    })) as Access;
    assert.equal(access.local.deviceId, b.deviceId);
    assert.equal(access.peer.deviceId, a.deviceId);
    const descriptor = (await localCall(
      a.socketPath,
      "sync.key.descriptor",
      {},
    )) as RecordJSON;
    assert.equal(descriptor.deviceId, a.deviceId);
    assert.equal(descriptor.publicKey, a.publicKey);
    assert.match(String(descriptor.keyId), /^[a-f0-9]{64}$/);
    console.log(
      JSON.stringify({
        kind: "cache-descriptor-real-prerequisites",
        independentEd: true,
        registrySQLite: true,
        paired: true,
        currentDirectionalGrant: true,
        boundReadyBots: 2,
        originalPageEvents: page.events.length,
        durableHelperDescriptor: true,
        providerCalls: model.verify(),
      }),
    );
    const identity = SyncIdentityResult.parse(
      await localCall(a.socketPath, "sync.identity", {}),
    ).identity;
    await verifySyncKeyDescriptor(descriptor, identity, worker.origin);
    const descriptorStorage = await worker.mf.unsafeGetDurableObjectStorage(
      "eagle",
      "DeviceRegistry",
      { name: "registry" },
    );
    const marker = join(root, "a/hold-helper"),
      held = join(root, "a/helper-held");
    writeFileSync(marker, "sync_key_descriptor_result");
    const lateDescriptor = localCall(a.socketPath, "sync.key.publish", {});
    void lateDescriptor.catch(() => {});
    await until(
      async () => (existsSync(held) ? true : undefined),
      "real helper descriptor reply before Node identity recheck",
    );
    await descriptorStorage.exec(
      "UPDATE devices SET membershipEpoch=membershipEpoch+1 WHERE deviceId=?",
      a.deviceId,
    );
    unlinkSync(marker);
    await assert.rejects(lateDescriptor, /sync_identity_changed/);
    unlinkSync(held);
    assert.equal(
      (
        await descriptorStorage.exec(
          "SELECT * FROM sync_wrapping_keys WHERE deviceId=?",
          a.deviceId,
        )
      ).length,
      0,
    );
    await descriptorStorage.exec(
      "UPDATE devices SET membershipEpoch=membershipEpoch-1 WHERE deviceId=?",
      a.deviceId,
    );
    const published = (await localCall(
      a.socketPath,
      "sync.key.publish",
      {},
    )) as { version: number; descriptor: RecordJSON };
    assert.equal(published.version, 1);
    await verifySyncKeyDescriptor(
      published.descriptor,
      identity,
      worker.origin,
    );
    const unsigned = (value: RecordJSON) => {
      const { signature: _signature, ...body } = value;
      return body;
    };
    assert.deepEqual(unsigned(published.descriptor), unsigned(descriptor));
    assert.deepEqual(
      await localCall(a.socketPath, "sync.key.publish", {}),
      published,
    );
    await a.stop();
    services.splice(services.indexOf(a), 1);
    const reopened = await helper(join(root, "a"), worker.origin);
    services.push(reopened);
    assert.equal(reopened.deviceId, a.deviceId);
    assert.deepEqual(
      await localCall(reopened.socketPath, "sync.key.publish", {}),
      published,
    );
    await ad.stop();
    bots.splice(bots.indexOf(ad), 1);
    await reopened.stop();
    services.splice(services.indexOf(reopened), 1);
    const found = (await localCall(b.socketPath, "sync.key.lookup", {
      sharedBotId,
      peerDeviceId: a.deviceId,
      purpose: "replica.read",
    })) as { descriptor: unknown };
    assert.deepEqual(found.descriptor, published.descriptor);
    const newInstructions = Buffer.from(
      "# created after reader went offline\n",
    );
    const newResources = await bd.post(`/v1/bots/${bb}/replica/export`, {
      kind: "resources",
      resources: [
        {
          ...resources[0],
          base64: newInstructions.toString("base64"),
          sha256: createHash("sha256").update(newInstructions).digest("hex"),
        },
        ...resources.slice(1),
      ],
    });
    const publisher = await botConnection(bd.origin, bd.token, bb);
    clients.push(publisher);
    assert.equal(
      (
        await publisher.run(
          "bash",
          model,
          { command: "printf cache-new-history" },
          { resourceHead: String(newResources.head) },
        )
      ).isError,
      false,
    );
    const history = await bd.post<History>(`/v1/bots/${bb}/replica/export`, {});
    assert.match(JSON.stringify(history), /cache-new-history/);
    const sections = (bundle: History) =>
      bundle.entries.flatMap((entry) =>
        (entry.model ?? []).flatMap((message) =>
          message.sections ? [Object.keys(message.sections)] : [],
        ),
      );
    const originalSections = sections(history);
    assert(originalSections.some((keys) => keys.includes("bots-resources")));
    const newPage = await bd.post<Page>(`/v1/bots/${bb}/replica/pull`, {
      after: 0,
    });
    assert(newPage.events.length > page.events.length);
    const baseline = model.verify();
    assert.equal(baseline, 2);
    console.log(
      JSON.stringify({
        kind: "cache-publish-real-prerequisites",
        readerOffline: true,
        durableRegistryDescriptor: true,
        currentGrant: true,
        newPageAfterReaderOffline: true,
        providerCalls: model.verify(),
      }),
    );
    for (const boundary of [
      "publisher-epoch",
      "publisher-expiry",
      "slot-epoch",
      "slot-expiry",
    ]) {
      const directory = join(root, "b-bots/bots", bb),
        before = counts(directory);
      await bd.control(boundary.startsWith("slot") ? "holdSlot" : "holdStage");
      const pending = bd.post(`/v1/bots/${bb}/sync/cache/publish`, {
        peerDeviceId: a.deviceId,
        after: 0,
      });
      void pending.catch(() => {});
      await bd.message((m) => m.type === "stageHeld");
      const restore = boundary.endsWith("epoch")
        ? changeBinding(directory, "epoch", randomUUID())
        : () => {};
      if (boundary.endsWith("expiry")) await bd.control("advance");
      await bd.control("releaseStage");
      try {
        await assert.rejects(pending, /400|403/);
      } finally {
        restore();
        if (boundary.endsWith("expiry")) await bd.control("resetClock");
      }
      assert.deepEqual(counts(directory), before);
      assert.equal(model.verify(), baseline);
      const objects = join(root, "b-bots/sync-objects/v1");
      assert.equal(
        readdirSync(objects).filter((name) => name.endsWith(".json")).length,
        boundary.startsWith("slot") ? 1 : 0,
      );
      for (const name of readdirSync(objects).filter((name) =>
        name.endsWith(".recipients"),
      ))
        assert.equal(readdirSync(join(objects, name)).length, 0);
      console.log(
        JSON.stringify({
          kind: "cache-publish-stage-boundary",
          boundary,
          cloudCached: false,
          executionDelta: 0,
        }),
      );
    }
    await bd.control("holdSlot");
    const publishing = bd.post<{
      cloudCached: boolean;
      objectId: string;
      firstCachedAt: number;
      expiresAt: number;
    }>(`/v1/bots/${bb}/sync/cache/publish`, {
      peerDeviceId: a.deviceId,
      after: 0,
    });
    void publishing.catch(() => {});
    await bd.message((m) => m.type === "stageHeld");
    await bd.control("clearReady");
    await bd.control("releaseStage");
    const cached = await publishing;
    assert.equal(cached.cloudCached, true);
    const publisherRecord = JSON.parse(
      readFileSync(
        join(root, "b-bots/sync-objects/v1", cached.objectId + ".json"),
        "utf8",
      ),
    );
    assert.equal(
      publisherRecord.carrier.manifest.pageDigest,
      createHash("sha256").update(JSON.stringify(newPage)).digest("hex"),
    );
    await new Promise<void>((done) => {
      publisher.socket.once("close", () => done());
      publisher.socket.close();
    });
    await bd.stop();
    bots.splice(bots.indexOf(bd), 1);
    await b.stop();
    services.splice(services.indexOf(b), 1);
    const registryStorage = await worker.mf.unsafeGetDurableObjectStorage(
      "eagle",
      "DeviceRegistry",
      { name: "registry" },
    );
    await registryStorage.exec(
      "UPDATE sessions SET expires=0 WHERE deviceId=?",
      b.deviceId,
    );
    await registryStorage.exec(
      "UPDATE sync_cache_authorities SET expires=0 WHERE json_extract(authorization,'$.operation')='publish'",
    );
    const coldA = await helper(join(root, "a"), worker.origin);
    services.push(coldA);
    assert.equal(coldA.deviceId, a.deviceId);
    let reader = await daemon(
      join(root, "a-bots"),
      coldA.socketPath,
      model.baseUrl,
      key,
      { cacheOrigin: worker.origin },
    );
    bots.push(reader);
    let opened = await botConnection(reader.origin, reader.token, ab);
    clients.push(opened);
    const directory = join(root, "a-bots/bots", ab);
    const executionCounts = () =>
      Object.fromEntries(
        Object.entries(counts(directory)).filter(([name]) =>
          /submission|task|local_runs/.test(name),
        ),
      );
    const before = executionCounts();
    assert("replica.sqlite:local_runs" in before);
    const peersBefore = readdirSync(join(root, "a-bots/peers")).map((name) => [
      name,
      readFileSync(join(root, "a-bots/peers", name)).toString("base64"),
    ]);
    const journalPath = join(directory, "pulls.journal.jsonl");
    const prBefore = existsSync(journalPath)
      ? readFileSync(journalPath)
      : undefined;
    const list = await reader.post<{
      objects: { objectId: string }[];
      complete: boolean;
    }>(`/v1/bots/${ab}/sync/cache/list`, {
      peerDeviceId: b.deviceId,
      source: newPage.source,
      after: 0,
    });
    assert(list.objects.some((value) => value.objectId === cached.objectId));
    assert.equal(list.complete, false);
    const objectFile = join(
      root,
      "a-bots/sync-objects/v1",
      cached.objectId + ".json",
    );
    for (const boundary of [
      "epoch",
      "replicaId",
      "localBotId",
      "sharedBotId",
      "expiry",
      "grant",
      "handle",
      "close",
    ]) {
      const dbBefore = counts(directory);
      assert.equal(existsSync(objectFile), false);
      await reader.control("holdStage");
      const pending = reader.post(`/v1/bots/${ab}/sync/cache/receive`, {
        peerDeviceId: b.deviceId,
        objectId: cached.objectId,
      });
      void pending.catch(() => {});
      await reader.message((m) => m.type === "stageHeld");
      let restore = () => {};
      if (
        ["epoch", "replicaId", "localBotId", "sharedBotId"].includes(boundary)
      )
        restore = changeBinding(directory, boundary, randomUUID());
      if (boundary === "expiry") await reader.control("advance");
      if (boundary === "grant") {
        const storage: DurableObjectStorageHandle =
          await worker.mf.unsafeGetDurableObjectStorage(
            "eagle",
            "DeviceRegistry",
            { name: "registry" },
          );
        const grant = (
          await storage.exec(
            "SELECT binding FROM sync_grants WHERE sharedBotId=?",
            sharedBotId,
          )
        )[0]?.binding;
        assert.equal(typeof grant, "string");
        await storage.exec(
          "UPDATE sync_grants SET binding='owned-revoked' WHERE sharedBotId=?",
          sharedBotId,
        );
        restore = () => {};
        await reader.control("releaseStage");
        await assert.rejects(pending, /403/);
        await storage.exec(
          "UPDATE sync_grants SET binding=? WHERE sharedBotId=?",
          grant as string,
          sharedBotId,
        );
      } else {
        if (boundary === "handle") await reader.control("shutdownRegistry");
        if (boundary === "close") await reader.control("closeSync");
        await reader.control("releaseStage");
        try {
          await assert.rejects(
            pending,
            boundary === "localBotId" ? /503/ : /400|403/,
          );
        } finally {
          restore();
          if (boundary === "expiry") await reader.control("resetClock");
        }
      }
      assert.equal(existsSync(objectFile), false);
      assert.deepEqual(counts(directory), dbBefore);
      assert.equal(model.verify(), baseline);
      console.log(
        JSON.stringify({
          kind: "cache-receive-stage-boundary",
          boundary,
          stored: false,
          executionDelta: 0,
        }),
      );
      if (boundary === "handle" || boundary === "close") {
        await new Promise<void>((done) => {
          opened.socket.once("close", () => done());
          opened.socket.close();
        });
        await reader.stop();
        bots.splice(bots.indexOf(reader), 1);
        reader = await daemon(
          join(root, "a-bots"),
          coldA.socketPath,
          model.baseUrl,
          key,
          { cacheOrigin: worker.origin },
        );
        bots.push(reader);
        opened = await botConnection(reader.origin, reader.token, ab);
        clients.push(opened);
      }
    }
    await reader.control("holdStage");
    const receiving = reader.post(`/v1/bots/${ab}/sync/cache/receive`, {
      peerDeviceId: b.deviceId,
      objectId: cached.objectId,
    });
    void receiving.catch(() => {});
    await reader.message((m) => m.type === "stageHeld");
    await reader.control("clearReady");
    await reader.control("releaseStage");
    const received = await receiving;
    assert.equal(received.stored, true);
    assert.equal(received.applied, false);
    const record = JSON.parse(
      readFileSync(
        join(root, "a-bots/sync-objects/v1", cached.objectId + ".json"),
        "utf8",
      ),
    );
    assert.equal(record.carrier.ciphertext, publisherRecord.carrier.ciphertext);
    assert.deepEqual(record.carrier.manifest, publisherRecord.carrier.manifest);
    await reader.post(`/v1/bots/${ab}/sync/objects/apply`, {
      objectId: cached.objectId,
    });
    const restoredPage = await reader.post<Page>(
      `/v1/bots/${ab}/replica/pull`,
      { source: newPage.source, after: 0 },
    );
    assert.equal(JSON.stringify(restoredPage), JSON.stringify(newPage));
    const restored = await reader.post<History>(
      `/v1/bots/${ab}/replica/export`,
      { head: history.head },
    );
    assert.equal(restored.head, history.head);
    assert.equal(
      JSON.stringify(restored.entries),
      JSON.stringify(history.entries),
    );
    assert.deepEqual(sections(restored), originalSections);
    const { manifest, envelope } = record.carrier,
      { pin } = record;
    const keyResult = (await localCall(coldA.socketPath, "sync.key.open", {
      version: 1,
      manifest,
      envelope,
      publisherPin: pin.publisher,
      issuerPin: pin.issuer,
      recipientPin: pin.recipient,
    })) as { dek: string };
    const {
      signature: _signature,
      cipherDigest: _cipherDigest,
      ...header
    } = manifest;
    const cipher = Buffer.from(record.carrier.ciphertext, "base64url");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(keyResult.dek, "base64url"),
      Buffer.from(manifest.nonce, "base64url"),
    );
    decipher.setAAD(
      Buffer.from("eagle-bots-page-object-v1\n" + canonicalDeviceJSON(header)),
    );
    decipher.setAuthTag(cipher.subarray(-16));
    const plaintext = Buffer.concat([
      decipher.update(cipher.subarray(0, -16)),
      decipher.final(),
    ]);
    assert.deepEqual(plaintext, Buffer.from(JSON.stringify(newPage)));
    assert.deepEqual(executionCounts(), before);
    assert.deepEqual(
      readdirSync(join(root, "a-bots/peers")).map((name) => [
        name,
        readFileSync(join(root, "a-bots/peers", name)).toString("base64"),
      ]),
      peersBefore,
    );
    assert.deepEqual(
      existsSync(journalPath) ? readFileSync(journalPath) : undefined,
      prBefore,
    );
    assert.equal(model.verify(), baseline);
    const localLogs = () =>
      readdirSync(join(root, "a-bots/logs")).flatMap((file) =>
        readFileSync(join(root, "a-bots/logs", file), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      );
    const cacheStorage = await worker.mf.unsafeGetDurableObjectStorage(
      "bots-sync",
      "SyncCache",
      { name: sharedBotId },
    );
    for (const [sqlStorage, table, method, failureKind] of [
      [cacheStorage, "objects", "receive", "storage_failed"],
      [cacheStorage, "events", "list", "storage_failed"],
      [cacheStorage, "recipients", "receive", "storage_failed"],
      [cacheStorage, "recipients", "list", "storage_failed"],
      [cacheStorage, "event_objects", "list", "storage_failed"],
      [registryStorage, "sync_cache_authorities", "receive", "internal"],
      [registryStorage, "sync_cache_authorities", "list", "internal"],
    ] as const) {
      const beforeSqlFailure = counts(directory);
      const originalPin = readFileSync(objectFile);
      let originalRows = await sqlStorage.exec(`SELECT * FROM ${table}`);
      const registryGate = table === "sync_cache_authorities";
      if (registryGate)
        await registryStorage.exec(
          "CREATE TABLE test_cache_sql_gate(started INTEGER,released INTEGER); INSERT INTO test_cache_sql_gate VALUES(0,0)",
        );
      else
        await sqlStorage.exec(
          `ALTER TABLE ${table} RENAME TO owned_unavailable_${table}`,
        );
      let renamed = !registryGate;
      try {
        const pending = fetch(
          reader.origin + `/v1/bots/${ab}/sync/cache/${method}`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${reader.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(
              method === "receive"
                ? { peerDeviceId: b.deviceId, objectId: cached.objectId }
                : {
                    peerDeviceId: b.deviceId,
                    source: newPage.source,
                    after: 0,
                    limit: 128,
                  },
            ),
          },
        );
        if (registryGate) {
          await until(
            async () =>
              (
                await registryStorage.exec(
                  "SELECT started FROM test_cache_sql_gate",
                )
              )[0]?.started
                ? true
                : undefined,
            "cache authority minted before actual Registry SQL read",
          );
          originalRows = await sqlStorage.exec(`SELECT * FROM ${table}`);
          assert(originalRows.length > 0);
          await sqlStorage.exec(
            `ALTER TABLE ${table} RENAME TO owned_unavailable_${table}`,
          );
          renamed = true;
          await registryStorage.exec(
            "UPDATE test_cache_sql_gate SET released=1",
          );
        }
        const response = await pending;
        const text = await response.text();
        const result = JSON.parse(text) as {
          error: { kind: string; failure: string };
          trace: string;
        };
        console.log(
          JSON.stringify({
            kind: "real-cache-sql-refusal",
            table,
            method,
            status: response.status,
            failureKind: result.error?.kind,
          }),
        );
        assert.equal(response.status, 503);
        assert.equal(result.error.kind, failureKind);
        assert.equal(text.includes("carrier"), false);
        assert.equal(text.includes("no such table"), false);
        await until(
          async () =>
            worker?.logs.some((row) =>
              row.message.includes(result.error.failure),
            )
              ? true
              : undefined,
          "SQL storage origin",
        );
        const origins: { level: string; message: string }[] =
          worker.logs.filter((row) =>
            row.message.includes(result.error.failure),
          );
        assert.equal(origins.length, 1);
        assert.equal(origins[0]?.level, "error");
        assert(origins[0]?.message.includes(result.trace));
        assert(origins[0]?.message.includes(ab));
        assert.equal(JSON.stringify(origins).includes("no such table"), false);
        assert.equal(
          JSON.stringify(origins).includes(record.carrier.ciphertext),
          false,
        );
        await until(
          async () =>
            localLogs().some(
              (row) =>
                row.err?.failure === result.error.failure &&
                row.level === "warn",
            )
              ? true
              : undefined,
          "SQL storage propagation",
        );
        const propagated = localLogs().filter(
          (row) => row.err?.failure === result.error.failure,
        );
        assert.equal(
          propagated.filter((row) => row.level === "error").length,
          0,
        );
        assert(
          propagated.every(
            (row) =>
              row.trace === result.trace &&
              row.botId === ab &&
              row.err?.kind === failureKind,
          ),
        );
        assert.deepEqual(counts(directory), beforeSqlFailure);
        assert.deepEqual(readFileSync(objectFile), originalPin);
        assert.deepEqual(executionCounts(), before);
        assert.equal(model.verify(), baseline);
      } finally {
        if (renamed) {
          await sqlStorage.exec(
            `ALTER TABLE owned_unavailable_${table} RENAME TO ${table}`,
          );
          assert.deepEqual(
            await sqlStorage.exec(`SELECT * FROM ${table}`),
            originalRows,
          );
        }
        if (registryGate)
          await registryStorage.exec("DROP TABLE test_cache_sql_gate");
      }
      const retry = await reader.post<{ stored: boolean }>(
        `/v1/bots/${ab}/sync/cache/receive`,
        {
          peerDeviceId: b.deviceId,
          objectId: cached.objectId,
        },
      );
      assert.equal(retry.stored, true);
      assert.deepEqual(readFileSync(objectFile), originalPin);
      assert.deepEqual(counts(directory), beforeSqlFailure);
      assert.equal(model.verify(), baseline);
    }
    const bucket = (await worker.mf.getR2Bucket(
      "CIPHERS",
      "bots-sync",
    )) as unknown as {
      head(
        key: string,
      ): Promise<{ customMetadata: Record<string, string> } | null>;
      put(key: string, body: Uint8Array, options: unknown): Promise<unknown>;
    };
    const r2key = `v1/${sharedBotId}/${cached.objectId}`,
      r2head = await bucket.head(r2key);
    assert(r2head);
    const corruptBody = Buffer.from(record.carrier.ciphertext, "base64url");
    corruptBody[0] = (corruptBody[0] ?? 0) ^ 1;
    await bucket.put(r2key, corruptBody, {
      customMetadata: r2head.customMetadata,
    });
    const beforeFailure = counts(directory);
    const refused = await fetch(
      reader.origin + `/v1/bots/${ab}/sync/cache/receive`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${reader.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          peerDeviceId: b.deviceId,
          objectId: cached.objectId,
        }),
      },
    );
    assert.equal(refused.status, 503);
    const refusedBody = (await refused.json()) as {
      error: { kind: string; failure: string };
      trace: string;
    };
    assert.equal(refusedBody.error.kind, "storage_failed");
    const failureId = refusedBody.error.failure;
    await until(
      async () =>
        worker?.logs.some((row) => row.message.includes(failureId))
          ? true
          : undefined,
      "cache originating failure log",
    );
    const origins = worker.logs.filter((row) =>
      row.message.includes(failureId),
    );
    assert.equal(origins.length, 1);
    assert.equal(origins[0]?.level, "error");
    assert(origins[0]?.message.includes(refusedBody.trace));
    assert(origins[0]?.message.includes(ab));
    await until(
      async () =>
        localLogs().some(
          (row) => row.err?.failure === failureId && row.level === "warn",
        )
          ? true
          : undefined,
      "Bots cache propagated failure",
    );
    const propagated = localLogs().filter(
      (row) => row.err?.failure === failureId,
    );
    assert.equal(propagated.filter((row) => row.level === "error").length, 0);
    assert(
      propagated.every(
        (row) => row.trace === refusedBody.trace && row.botId === ab,
      ),
    );
    assert.deepEqual(counts(directory), beforeFailure);
    assert.equal(model.verify(), baseline);
    console.log(
      JSON.stringify({
        kind: "real-cache-origin",
        failureId,
        trace: refusedBody.trace,
        botId: ab,
        workerOrigins: 1,
        botsErrors: 0,
        zeroApply: true,
      }),
    );
    await registryStorage.exec(
      "UPDATE devices SET credentialVersion=credentialVersion+1 WHERE deviceId=?",
      a.deviceId,
    );
    await assert.rejects(
      reader.post(`/v1/bots/${ab}/sync/cache/receive`, {
        peerDeviceId: b.deviceId,
        objectId: cached.objectId,
      }),
      /403/,
    );
    const originalRecord = readFileSync(objectFile),
      origin = worker.origin;
    await new Promise<void>((done) => {
      opened.socket.once("close", () => done());
      opened.socket.close();
    });
    await reader.stop();
    bots.splice(bots.indexOf(reader), 1);
    await coldA.stop();
    services.splice(services.indexOf(coldA), 1);
    await worker.mf.dispose();
    worker = undefined;
    const offline = await helper(join(root, "a"), origin, false);
    services.push(offline);
    reader = await daemon(
      join(root, "a-bots"),
      offline.socketPath,
      model.baseUrl,
      key,
    );
    bots.push(reader);
    opened = await botConnection(reader.origin, reader.token, ab);
    clients.push(opened);
    const offlineBefore = executionCounts();
    await reader.post(`/v1/bots/${ab}/sync/objects/apply`, {
      objectId: cached.objectId,
    });
    assert.deepEqual(readFileSync(objectFile), originalRecord);
    assert.deepEqual(executionCounts(), offlineBefore);
    assert.equal(model.verify(), baseline);
    assert.equal(
      (
        await opened.run("bash", model, {
          command: "printf cache-reader-native",
        })
      ).isError,
      false,
    );
    assert.equal(model.verify(), baseline + 2);
    console.log(
      JSON.stringify({
        kind: "real-cache-staggered-chain",
        readerOffBeforeNewPage: true,
        publisherOffBeforeColdReader: true,
        registrySQLite: true,
        syncDOAndR2: true,
        originalPlaintextBytes: plaintext.length,
        historyEntries: history.entries.length,
        head: history.head,
        sectionOrders: originalSections,
        passiveExecutionDelta: 0,
        nativeProviderDelta: 2,
      }),
    );
  } finally {
    for (const client of clients)
      if (client.socket.readyState === WebSocket.OPEN)
        await new Promise<void>((done) => {
          client.socket.once("close", () => done());
          client.socket.close();
        });
    for (const service of bots.reverse()) await service.stop();
    for (const service of services.reverse()) await service.stop();
    await worker?.mf.dispose();
    await new Promise<void>((done) => model.server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
    rmSync(workerRoot, { recursive: true, force: true });
  }
});

test("automatic direct, CF, stable return and staggered cold receive preserve real history without a manual transfer loop", {
  timeout: 90000,
}, async () => {
  const root = realpathSync(mkdtempSync("/tmp/eagle-auto-transport-"));
  const workerRoot = mkdtempSync(resolve(".local/auto-transport-worker-"));
  const key = randomBytes(32).toString("base64url");
  const model = await modelFixture(key);
  const helpers: Awaited<ReturnType<typeof helper>>[] = [];
  const bots: Awaited<ReturnType<typeof daemon>>[] = [];
  const clients: Awaited<ReturnType<typeof botConnection>>[] = [];
  let worker: Awaited<ReturnType<typeof workerFixture>> | undefined;
  try {
    worker = await workerFixture(workerRoot, true);
    const a = await helper(join(root, "a"), worker.origin);
    helpers.push(a);
    const cli = join(root, "cli");
    mkdirSync(cli);
    writeFileSync(
      join(cli, "tailscale"),
      `#!/bin/sh\nprintf '%s' '{"BackendState":"Running","Self":{"TailscaleIPs":["100.64.1.2"]}}'\n`,
    );
    chmodSync(join(cli, "tailscale"), 0o700);
    const b = await helper(join(root, "b"), worker.origin, true, cli);
    helpers.push(b);
    assert.notEqual(a.deviceId, b.deviceId);
    assert.notEqual(a.publicKey, b.publicKey);
    const invitation = await a.manage("pairing.create", {});
    await b.manage("pairing.redeem", {
      requestId: randomUUID(),
      code: invitation.code,
    });
    const bd = await daemon(
      join(root, "b-bots"),
      b.socketPath,
      model.baseUrl,
      key,
      {
        listener: true,
        cacheOrigin: worker.origin,
      },
    );
    bots.push(bd);
    const ad = await daemon(
      join(root, "a-bots"),
      a.socketPath,
      model.baseUrl,
      key,
      {
        peerPort: bd.peerPort,
        cacheOrigin: worker.origin,
        holdAuto: true,
      },
    );
    bots.push(ad);
    const ab = (
      await ad.post<{ bot: { id: string } }>("/v1/bots", {
        title: "Auto reader",
      })
    ).bot.id;
    const bb = (
      await bd.post<{ bot: { id: string } }>("/v1/bots", {
        title: "Auto publisher",
      })
    ).bot.id;
    const sharedBotId = randomUUID();
    await ad.post(`/v1/bots/${ab}/replica/bind`, { sharedBotId });
    await bd.post(`/v1/bots/${bb}/replica/bind`, { sharedBotId });
    const resources = JSON.parse(
      readFileSync("fixtures/bots-sync/resources.v1.json", "utf8"),
    );
    await bd.post(`/v1/bots/${bb}/replica/export`, {
      kind: "resources",
      resources,
    });
    const page = await bd.post<Page>(`/v1/bots/${bb}/replica/pull`, {
      after: 0,
    });
    await ad.post(`/v1/bots/${ab}/replica/apply`, { page });
    await b.manage("sync.share", {
      sharedBotId,
      peerDeviceId: a.deviceId,
      enabled: true,
    });
    const access = (await localCall(a.socketPath, "sync.access", {
      sharedBotId,
      peerDeviceId: b.deviceId,
      purpose: "replica.read",
    })) as Access;
    assert.equal(access.local.deviceId, a.deviceId);
    assert.equal(access.peer.deviceId, b.deviceId);
    const directory = join(root, "a-bots/bots", ab);
    const executionCounts = () =>
      Object.fromEntries(
        Object.entries(counts(directory)).filter(([name]) =>
          /submission|task|local_run/.test(name),
        ),
      );
    const beforeDB = executionCounts();
    const peers = () =>
      readdirSync(join(root, "a-bots/peers")).map((name) => [
        name,
        readFileSync(join(root, "a-bots/peers", name)).toString("base64"),
      ]);
    const peersBefore = peers(),
      journalPath = join(directory, "pulls.journal.jsonl");
    const prBefore = existsSync(journalPath)
      ? readFileSync(journalPath)
      : undefined;
    const before = model.verify();
    console.log(
      JSON.stringify({
        kind: "auto-real-prerequisites",
        independentEd: true,
        paired: true,
        currentDirectionalGrant: true,
        readyBoundBots: 2,
        baselineEvents: page.events.length,
        providerCalls: before,
      }),
    );
    await b.manage("sync.endpoints.publish", { syncPort: bd.peerPort });
    const configured = await ad.post<{ direction: string }>(
      `/v1/bots/${ab}/sync/connections/${b.deviceId}`,
      { direction: "receive" },
      "PUT",
    );
    assert.equal(configured.direction, "receive");
    assert.equal(model.verify(), before);
    const connectionState = async (target: typeof ad, botId: string) => {
      const response = await fetch(
        target.origin + `/v1/bots/${botId}/sync/connections`,
        { headers: { authorization: `Bearer ${target.token}` } },
      );
      assert.equal(response.status, 200);
      return response.json() as Promise<{
        replica: { heads: { head: string; ready: boolean }[] };
        connections: {
          state: string;
          transport: string;
          cloudCached: { objectId: string; nextAfter: number } | null;
        }[];
      }>;
    };
    // The preference captures the old binding; the first real turn sees an already changed DB.
    const beforeBindingTurn = counts(directory);
    const objectDirectory = join(root, "a-bots/sync-objects/v1");
    const objectFiles = () =>
      existsSync(objectDirectory)
        ? readdirSync(objectDirectory)
            .sort()
            .map((name) => [
              name,
              readFileSync(join(objectDirectory, name)).toString("base64"),
            ])
        : [];
    const beforeObjectFiles = objectFiles();
    const restoreBinding = changeBinding(directory, "epoch", randomUUID());
    try {
      await ad.control("startAuto");
      await until(
        async () =>
          (await connectionState(ad, ab)).connections[0]?.state ===
          "auth_failed"
            ? true
            : undefined,
        "pre-turn actual binding mismatch",
      );
      await ad.post(
        `/v1/bots/${ab}/sync/connections/${b.deviceId}`,
        {},
        "DELETE",
      );
      const origins = () =>
        readdirSync(join(root, "a-bots/logs"))
          .flatMap((file) =>
            readFileSync(join(root, "a-bots/logs", file), "utf8")
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line)),
          )
          .filter(
            (row) =>
              row.trace.startsWith("tr_auto_") &&
              row.botId === ab &&
              row.err?.kind === "auth_failed",
          );
      let rows = origins();
      await until(async () => {
        rows = origins();
        return rows.length ? true : undefined;
      }, "one actual automatic binding origin").catch(() => {
        assert.equal(
          rows.length,
          1,
          "the controller-created real binding refusal needs an origin",
        );
      });
      const origin = rows[0];
      assert(origin);
      assert.equal(origin.evt, "runtime.sync.fail");
      assert.equal(origin.level, "error");
      assert.equal(origin.layer, "runtime");
      assert.equal(origin.err.origin, true);
      assert.match(origin.trace, /^tr_auto_[a-f0-9]{32}$/);
      assert.match(origin.err.failure, /^f_[a-f0-9]{12}$/);
      assert.equal(
        rows.filter(
          (row) =>
            row.trace === origin.trace &&
            row.err.failure === origin.err.failure &&
            row.level === "error",
        ).length,
        1,
      );
      assert.deepEqual(counts(directory), beforeBindingTurn);
      assert.deepEqual(objectFiles(), beforeObjectFiles);
      assert.deepEqual(executionCounts(), beforeDB);
      assert.equal(model.verify(), before);
      console.log(
        JSON.stringify({
          kind: "automatic-pre-turn-binding-origin",
          trace: origin.trace,
          botId: ab,
          failure: origin.err.failure,
          runtimeOrigins: 1,
          noObjectOrApply: true,
          passiveExecutionDelta: 0,
        }),
      );
    } finally {
      restoreBinding();
    }
    await ad.post(
      `/v1/bots/${ab}/sync/connections/${b.deviceId}`,
      { direction: "receive" },
      "PUT",
    );
    await bd.post(
      `/v1/bots/${bb}/sync/connections/${a.deviceId}`,
      { direction: "publish" },
      "PUT",
    );
    await until(
      async () =>
        (await connectionState(bd, bb)).connections[0]?.cloudCached
          ? true
          : undefined,
      "actual independent background cache ACK",
    );
    const publisher = await botConnection(bd.origin, bd.token, bb);
    clients.push(publisher);
    const resourcesHead = await bd.post(`/v1/bots/${bb}/replica/export`, {
      kind: "resources",
      resources,
    });
    await publisher.run(
      "bash",
      model,
      { command: "printf auto-history" },
      { resourceHead: String(resourcesHead.head) },
    );
    const history = await bd.post<History>(`/v1/bots/${bb}/replica/export`, {});
    const actualPage = await bd.post<Page & { nextAfter: number }>(
      `/v1/bots/${bb}/replica/pull`,
      { after: 0 },
    );
    const providerAfterNative = model.verify();
    await until(
      async () =>
        (await connectionState(bd, bb)).connections[0]?.cloudCached
          ?.nextAfter === actualPage.nextAfter
          ? true
          : undefined,
      "new native facts automatically cloud cached",
    );
    await until(async () => {
      const found = await connectionState(ad, ab);
      return found.replica.heads.some(
        (head) => head.head === history.head && head.ready,
      )
        ? true
        : undefined;
    }, "automatic cache fallback applies original history");
    assert.deepEqual(
      await ad.post(`/v1/bots/${ab}/replica/export`, { head: history.head }),
      history,
    );
    const receivedPage = await ad.post(`/v1/bots/${ab}/replica/pull`, {
      source: page.source,
      after: 0,
    });
    assert.deepEqual(
      Buffer.from(JSON.stringify(receivedPage)),
      Buffer.from(JSON.stringify(actualPage)),
    );
    assert.deepEqual(executionCounts(), beforeDB);
    assert.equal(model.verify(), providerAfterNative);
    console.log(
      JSON.stringify({
        kind: "automatic-first-cache-chain",
        baselineEvents: page.events.length,
        actualNextAfter: actualPage.nextAfter,
        historyEntries: history.entries.length,
        head: history.head,
        passiveExecutionDelta: 0,
        manualCacheOrPullAfterBaseline: false,
      }),
    );
    const directStats = await bd.control("networkStats");
    assert(
      Number(directStats.pageSuccess) > 0,
      "server must verify the reader and complete the authenticated page exchange",
    );
    const statusStorage = await worker.mf.unsafeGetDurableObjectStorage(
      "bots-sync",
      "SyncCache",
      { name: sharedBotId },
    );
    await statusStorage.exec(
      "INSERT INTO test_status_fault VALUES('status-report','malformed',1000,0)",
    );
    await statusStorage.exec(
      "INSERT INTO test_status_fault VALUES('status-read','malformed',1000,0)",
    );
    await statusStorage.exec(
      "INSERT INTO test_status_fault VALUES('publish','malformed',1000,0)",
    );
    await ad.post(
      `/v1/bots/${ab}/sync/connections/${b.deviceId}`,
      { direction: "receive" },
      "PUT",
    );
    await bd.post(
      `/v1/bots/${bb}/sync/connections/${a.deviceId}`,
      { direction: "publish" },
      "PUT",
    );
    await publisher.run("bash", model, {
      command: "printf direct-while-metadata-and-cache-fail",
    });
    const directOnly = await bd.post<History>(
      `/v1/bots/${bb}/replica/export`,
      {},
    );
    const directPage = await bd.post<Page & { nextAfter: number }>(
      `/v1/bots/${bb}/replica/pull`,
      { after: 0 },
    );
    await until(
      async () =>
        (await connectionState(ad, ab)).replica.heads.some(
          (h) => h.head === directOnly.head && h.ready,
        )
          ? true
          : undefined,
      "direct receive must finish while both independent cloud channels fail",
    );
    await until(
      async () =>
        (
          await statusStorage.exec(
            "SELECT hits FROM test_status_fault WHERE operation='status-report'",
          )
        )[0]?.hits
          ? true
          : undefined,
      "real malformed metadata response refuses confirmation",
    );
    const blockedState = await bd.post<{
      connections: {
        peerApplied: unknown;
        cloudCached: { nextAfter: number } | null;
      }[];
    }>(`/v1/bots/${bb}/sync/connections`, undefined, "GET");
    assert.equal(blockedState.connections[0]?.peerApplied, "unknown");
    assert(
      Number(blockedState.connections[0]?.cloudCached?.nextAfter ?? 0) <
        directPage.nextAfter,
    );
    const providerAfterDirectOnly = model.verify();
    await statusStorage.exec("DELETE FROM test_status_fault");
    await until(async () => {
      const state = await bd.post<{
        connections: {
          peerApplied:
            | string
            | {
                current: string;
                snapshots: { source: unknown; applied: number }[];
              };
        }[];
      }>(`/v1/bots/${bb}/sync/connections`, undefined, "GET");
      const ack = state.connections[0]?.peerApplied;
      if (!ack || typeof ack === "string") return undefined;
      assert.equal(
        ack.current,
        "unknown",
        "last authenticated full-key snapshots do not infer a current receiver binding",
      );
      return ack.snapshots.some(
        (v) =>
          canonicalDeviceJSON(v.source) === canonicalDeviceJSON(page.source) &&
          v.applied === directPage.nextAfter,
      )
        ? true
        : undefined;
    }, "automatic sender independently learns the receiver's actual persistent direct apply after channel recovery");
    assert.equal(model.verify(), providerAfterDirectOnly);
    assert.deepEqual(executionCounts(), beforeDB);
    console.log(
      JSON.stringify({
        kind: "direct-status-channel-recovery",
        directApplied: true,
        cacheAndReportFault: true,
        senderFirstUnknown: true,
        recoveredFromPersistentStatus: true,
        passiveExecutionDelta: 0,
      }),
    );
    const waitHistory = async (target: typeof ad, wanted: History) => {
      await until(
        async () =>
          (await connectionState(target, ab)).replica.heads.some(
            (head) => head.head === wanted.head && head.ready,
          )
            ? true
            : undefined,
        "automatic history readiness",
      );
      assert.deepEqual(
        await target.post(`/v1/bots/${ab}/replica/export`, {
          head: wanted.head,
        }),
        wanted,
      );
    };
    const newHistory = async (label: string) => {
      assert.equal(
        (await publisher.run("bash", model, { command: `printf ${label}` }))
          .isError,
        false,
      );
      const history = await bd.post<History>(
        `/v1/bots/${bb}/replica/export`,
        {},
      );
      const page = await bd.post<Page & { nextAfter: number }>(
        `/v1/bots/${bb}/replica/pull`,
        { after: 0 },
      );
      await until(
        async () =>
          (await connectionState(bd, bb)).connections[0]?.cloudCached
            ?.nextAfter === page.nextAfter
            ? true
            : undefined,
        "independent automatic cache ACK",
      );
      return { history, page };
    };
    await bd.control("stopListener");
    await until(
      async () =>
        (await connectionState(ad, ab)).connections[0]?.transport === "cache"
          ? true
          : undefined,
      "real TCP refusal selects CF",
    );
    const cacheIO = await worker.mf.unsafeGetDurableObjectStorage(
      "bots-sync",
      "SyncCache",
      { name: sharedBotId },
    );
    const cacheGets = async () =>
      Number(
        (
          await cacheIO.exec(
            "SELECT count(*) AS n FROM test_cache_io WHERE operation='get'",
          )
        )[0]?.n,
      );
    await ad.control("faultReceiveIO");
    const fallback = await newHistory("auto-cf-refusal");
    const committed = await ad.message(
      (message) => message.type === "receiveCommittedIO",
    );
    assert.equal(committed.through, fallback.page.nextAfter);
    const failed = await until(async () => {
      const stats = await ad.control("receiveIOStats");
      return stats.failure as RecordJSON | undefined;
    }, "original actual SQLite apply failure");
    assert.equal(failed.kind, "storage_failed");
    assert.equal(failed.originalCause, true);
    assert.equal(failed.causeCode, "ERR_SQLITE_ERROR");
    const streams = () => {
      const db = new DatabaseSync(join(directory, "replica.sqlite"), {
        readOnly: true,
      });
      try {
        return db
          .prepare("SELECT received,applied FROM streams WHERE source=?")
          .get(JSON.stringify(committed.source));
      } finally {
        db.close();
      }
    };
    const stored = streams();
    assert.equal(stored?.received, fallback.page.nextAfter);
    assert(Number(stored?.applied) < Number(stored?.received));
    const ioProvider = model.verify(),
      ioExecution = executionCounts(),
      gets = await cacheGets();
    const cachedEvents = await cacheIO.exec(
      "SELECT replicaId,epoch,seq,eventDigest FROM events ORDER BY replicaId,epoch,seq",
    );
    console.log(
      JSON.stringify({
        kind: "automatic-received-apply-io-fault",
        received: stored?.received,
        applied: stored?.applied,
        originalCause: failed.originalCause,
        failure: failed.failure,
        trace: failed.trace,
      }),
    );
    const reported = async () => {
      const rows = await cacheIO.exec("SELECT snapshot FROM replica_status");
      return rows
        .map((row) => JSON.parse(String(row.snapshot)))
        .find(
          (row) =>
            canonicalDeviceJSON(row.source) ===
            canonicalDeviceJSON(committed.source),
        );
    };
    await until(async () => {
      const snapshot = await reported();
      return snapshot?.received === stored?.received &&
        snapshot?.applied === stored?.applied
        ? snapshot
        : undefined;
    }, "status report preserves actual received greater than applied during real I/O failure");
    await ad.control("restoreReceiveIO");
    await waitHistory(ad, fallback.history);
    await until(
      async () =>
        (await reported())?.applied === fallback.page.nextAfter
          ? true
          : undefined,
      "local pending apply recovery reports durable completion without another get",
    );
    assert.equal(streams()?.applied, fallback.page.nextAfter);
    assert.equal(
      await cacheGets(),
      gets,
      "restored I/O must reuse the same owned body, with no new page",
    );
    assert.deepEqual(
      await cacheIO.exec(
        "SELECT replicaId,epoch,seq,eventDigest FROM events ORDER BY replicaId,epoch,seq",
      ),
      cachedEvents,
    );
    assert.equal(model.verify(), ioProvider);
    assert.deepEqual(executionCounts(), ioExecution);
    const errorRows = readdirSync(join(root, "a-bots/logs"))
      .flatMap((file) =>
        readFileSync(join(root, "a-bots/logs", file), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      )
      .filter(
        (row) =>
          row.err?.failure === failed.failure &&
          row.trace === failed.trace &&
          row.botId === ab &&
          row.level === "error",
      );
    assert.equal(errorRows.length, 1);
    assert.equal(errorRows[0].err.origin, true);
    console.log(
      JSON.stringify({
        kind: "automatic-received-apply-io-retry",
        receivedCommitted: true,
        originalCause: true,
        failure: failed.failure,
        trace: failed.trace,
        botId: ab,
        origins: errorRows.length,
        additionalGets: 0,
        passiveExecutionDelta: 0,
      }),
    );
    assert.equal(
      (await connectionState(ad, ab)).connections[0]?.transport,
      "cache",
    );
    await bd.control("networkMode", { mode: "hold-challenge" });
    await bd.control("restartListener");
    await ad.control("clock", { offset: 15001 });
    await bd.message((message) => message.type === "networkHeld");
    const held = await newHistory("auto-cf-during-slow-probe");
    await waitHistory(ad, held.history);
    assert.equal(
      (await connectionState(ad, ab)).connections[0]?.transport,
      "cache",
      "pending complete probe must not block CF or count as a success",
    );
    const beforeProbe = Number((await bd.control("networkStats")).pageSuccess);
    await bd.control("releaseNetwork");
    await until(
      async () =>
        Number((await bd.control("networkStats")).pageSuccess) > beforeProbe
          ? true
          : undefined,
      "first full authenticated probe",
    );
    assert.equal(
      (await connectionState(ad, ab)).connections[0]?.transport,
      "cache",
    );
    await ad.control("clock", { offset: 31002 });
    await until(
      async () =>
        Number((await bd.control("networkStats")).pageSuccess) > beforeProbe + 1
          ? true
          : undefined,
      "second spaced full authenticated probe",
    );
    await until(
      async () =>
        (await connectionState(ad, ab)).connections[0]?.transport === "direct"
          ? true
          : undefined,
      "stable switchback after two probes and CF residence",
    );
    await ad.control("resetClock");
    assert.deepEqual(executionCounts(), beforeDB);
    assert.deepEqual(peers(), peersBefore);
    assert.deepEqual(
      existsSync(journalPath) ? readFileSync(journalPath) : undefined,
      prBefore,
    );

    for (const boundary of [
      "direct-wins",
      "cache-wins",
      "disable",
      "rebind",
      "self",
    ]) {
      await ad.post(
        `/v1/bots/${ab}/sync/connections/${b.deviceId}`,
        {},
        "DELETE",
      );
      await bd.control("networkMode", { mode: "hold-challenge" });
      const next = await newHistory(`auto-stage-${boundary}`);
      const ack = (await connectionState(bd, bb)).connections[0]?.cloudCached;
      assert(ack);
      const objectFile = join(
        root,
        "a-bots/sync-objects/v1",
        ack.objectId + ".json",
      );
      assert.equal(existsSync(objectFile), false);
      const snapshot = counts(directory),
        provider = model.verify();
      await ad.control("holdStage");
      await ad.post(
        `/v1/bots/${ab}/sync/connections/${b.deviceId}`,
        { direction: "receive", source: page.source },
        "PUT",
      );
      await bd.message((message) => message.type === "networkHeld");
      await ad.message((message) => message.type === "stageHeld");
      let restore = () => {};
      if (boundary === "disable")
        await ad.post(
          `/v1/bots/${ab}/sync/connections/${b.deviceId}`,
          {},
          "DELETE",
        );
      if (boundary === "rebind")
        restore = changeBinding(directory, "epoch", randomUUID());
      if (boundary === "self") await ad.control("clearReady");
      try {
        if (boundary === "direct-wins") {
          await bd.control("releaseNetwork");
          await waitHistory(ad, next.history);
          assert.equal(
            existsSync(objectFile),
            false,
            "late CF must not publish after direct receive admission",
          );
        }
        await ad.control("releaseStage");
        await until(
          async () =>
            !readdirSync(join(root, "a-bots/sync-objects/v1")).some((name) =>
              name.startsWith(".stage-"),
            )
              ? true
              : undefined,
          "owned automatic stage completed or discarded",
        );
        if (boundary === "cache-wins" || boundary === "self") {
          await waitHistory(ad, next.history);
          assert.equal(existsSync(objectFile), true);
        }
        const beforeLate = counts(directory);
        await bd.control("releaseNetwork");
        if (boundary === "disable" || boundary === "rebind") {
          assert.equal(existsSync(objectFile), false);
          assert.deepEqual(beforeLate, snapshot);
        }
        assert.deepEqual(counts(directory), beforeLate);
        assert.deepEqual(executionCounts(), beforeDB);
        assert.equal(model.verify(), provider);
        console.log(
          JSON.stringify({
            kind: "automatic-owned-stage",
            boundary,
            objectPublished: existsSync(objectFile),
            passiveExecutionDelta: 0,
          }),
        );
      } finally {
        restore();
        await ad.control("releaseStage");
        await bd.control("releaseNetwork");
      }
    }

    await ad.stop();
    bots.splice(bots.indexOf(ad), 1);
    await a.stop();
    helpers.splice(helpers.indexOf(a), 1);
    const offline = await newHistory("auto-page-created-after-reader-offline");
    const acknowledged = (await connectionState(bd, bb)).connections[0]
      ?.cloudCached;
    assert(acknowledged);
    const publisherRecord = JSON.parse(
      readFileSync(
        join(root, "b-bots/sync-objects/v1", acknowledged.objectId + ".json"),
        "utf8",
      ),
    );
    const exactObjectPage = await bd.post(`/v1/bots/${bb}/replica/pull`, {
      source: publisherRecord.carrier.manifest.source,
      after: publisherRecord.carrier.manifest.included[0].seq - 1,
      limit: 128,
    });
    await new Promise<void>((done) => {
      publisher.socket.once("close", () => done());
      publisher.socket.close();
    });
    await bd.stop();
    bots.splice(bots.indexOf(bd), 1);
    await b.stop();
    helpers.splice(helpers.indexOf(b), 1);
    const providerBeforeCold = model.verify();
    const coldA = await helper(join(root, "a"), worker.origin, false);
    helpers.push(coldA);
    assert.equal(coldA.deviceId, a.deviceId);
    const cold = await daemon(
      join(root, "a-bots"),
      coldA.socketPath,
      model.baseUrl,
      key,
      { peerPort: bd.peerPort, cacheOrigin: worker.origin },
    );
    bots.push(cold);
    const opened = await botConnection(cold.origin, cold.token, ab);
    clients.push(opened);
    const beforeCold = executionCounts();
    assert.deepEqual(beforeCold, beforeDB);
    await waitHistory(cold, offline.history);
    assert.deepEqual(
      await cold.post(`/v1/bots/${ab}/replica/pull`, {
        source: page.source,
        after: 0,
      }),
      offline.page,
    );
    const record = JSON.parse(
      readFileSync(
        join(root, "a-bots/sync-objects/v1", acknowledged.objectId + ".json"),
        "utf8",
      ),
    );
    assert.deepEqual(record.carrier.manifest, publisherRecord.carrier.manifest);
    assert.equal(record.carrier.ciphertext, publisherRecord.carrier.ciphertext);
    const { manifest, envelope } = record.carrier,
      { pin } = record;
    const openedKey = (await localCall(coldA.socketPath, "sync.key.open", {
      version: 1,
      manifest,
      envelope,
      publisherPin: pin.publisher,
      issuerPin: pin.issuer,
      recipientPin: pin.recipient,
    })) as { dek: string };
    const {
        signature: _signature,
        cipherDigest: _cipherDigest,
        ...header
      } = manifest,
      cipher = Buffer.from(record.carrier.ciphertext, "base64url");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(openedKey.dek, "base64url"),
      Buffer.from(manifest.nonce, "base64url"),
    );
    decipher.setAAD(
      Buffer.from("eagle-bots-page-object-v1\n" + canonicalDeviceJSON(header)),
    );
    decipher.setAuthTag(cipher.subarray(-16));
    const plaintext = Buffer.concat([
      decipher.update(cipher.subarray(0, -16)),
      decipher.final(),
    ]);
    assert.deepEqual(plaintext, Buffer.from(JSON.stringify(exactObjectPage)));
    const sections = (value: History) =>
      value.entries.flatMap((entry) =>
        (entry.model ?? []).flatMap((message) =>
          message.sections ? [Object.keys(message.sections)] : [],
        ),
      );
    assert.deepEqual(
      sections(
        await cold.post<History>(`/v1/bots/${ab}/replica/export`, {
          head: offline.history.head,
        }),
      ),
      sections(offline.history),
    );
    assert.deepEqual(executionCounts(), beforeCold);
    assert.deepEqual(peers(), peersBefore);
    assert.deepEqual(
      existsSync(journalPath) ? readFileSync(journalPath) : undefined,
      prBefore,
    );
    assert.equal(model.verify(), providerBeforeCold);
    assert.equal(
      (
        await opened.run("bash", model, {
          command: "printf automatic-cold-native",
        })
      ).isError,
      false,
    );
    assert.equal(model.verify() - providerBeforeCold, 2);
    console.log(
      JSON.stringify({
        kind: "automatic-staggered-cf-chain",
        realTCPRefusal: true,
        slowFullProbeDidNotBlockCache: true,
        spacedAuthenticatedProbes: 2,
        stableReturn: true,
        readerOffBeforeNewPage: true,
        publisherOffBeforeColdReader: true,
        localReadyColdStart: true,
        originalPlaintextBytes: plaintext.length,
        historyEntries: offline.history.entries.length,
        head: offline.history.head,
        sectionOrders: sections(offline.history),
        passiveExecutionDelta: 0,
        nativeProviderDelta: 2,
        manualCacheOrPullAfterBaseline: false,
      }),
    );
  } finally {
    for (const client of clients)
      if (client.socket.readyState === WebSocket.OPEN)
        await new Promise<void>((done) => {
          client.socket.once("close", () => done());
          client.socket.close();
        });
    await Promise.all(bots.map((bot) => bot.stop()));
    await Promise.all(helpers.map((service) => service.stop()));
    await worker?.mf.dispose();
    await new Promise<void>((done) => model.server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
    rmSync(workerRoot, { recursive: true, force: true });
  }
});

test("corrupt optional sync preferences preserve their bytes and leave real daemon native execution available", {
  timeout: 90000,
}, async () => {
  const root = realpathSync(mkdtempSync("/tmp/eagle-auto-prefs-")),
    workerRoot = mkdtempSync(resolve(".local/auto-prefs-worker-"));
  const key = randomBytes(32).toString("base64url"),
    model = await modelFixture(key);
  let worker: Awaited<ReturnType<typeof workerFixture>> | undefined;
  let service: Awaited<ReturnType<typeof helper>> | undefined,
    bot: Awaited<ReturnType<typeof daemon>> | undefined,
    client: Awaited<ReturnType<typeof botConnection>> | undefined;
  try {
    worker = await workerFixture(workerRoot);
    service = await helper(join(root, "helper"), worker.origin);
    const directory = join(root, "bots/sync-connections");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "v1.json"),
      broken = Buffer.from("{owned invalid optional sync preferences");
    writeFileSync(path, broken, { mode: 0o600 });
    bot = await daemon(
      join(root, "bots"),
      service.socketPath,
      model.baseUrl,
      key,
    );
    const id = (
      await bot.post<{ bot: { id: string } }>("/v1/bots", {
        title: "Native survives optional sync failure",
      })
    ).bot.id;
    const failure = await fetch(
      bot.origin + `/v1/bots/${id}/sync/connections`,
      { headers: { authorization: `Bearer ${bot.token}` } },
    );
    assert.equal(failure.status, 503);
    assert.equal(
      ((await failure.json()) as { error: { kind: string } }).error.kind,
      "storage_failed",
    );
    client = await botConnection(bot.origin, bot.token, id);
    const before = model.verify();
    assert.equal(
      (
        await client.run("bash", model, {
          command: "printf native-with-corrupt-sync-prefs",
        })
      ).isError,
      false,
    );
    assert.equal(model.verify() - before, 2);
    assert.deepEqual(readFileSync(path), broken);
    await new Promise<void>((done) => {
      client?.socket.once("close", () => done());
      client?.socket.close();
    });
    await bot.stop();
    bot = await daemon(
      join(root, "live-bots"),
      service.socketPath,
      model.baseUrl,
      key,
    );
    const liveId = (
      await bot.post<{ bot: { id: string } }>("/v1/bots", {
        title: "Native survives sync write failure",
      })
    ).bot.id;
    await bot.post(`/v1/bots/${liveId}/replica/bind`, {
      sharedBotId: randomUUID(),
    });
    const obstruction = join(root, "live-bots/sync-connections/v1.json");
    mkdirSync(obstruction, { recursive: true });
    const writeFailure = await fetch(
      bot.origin + `/v1/bots/${liveId}/sync/connections/${randomUUID()}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${bot.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ direction: "publish" }),
      },
    );
    assert.equal(writeFailure.status, 503);
    assert.equal(
      ((await writeFailure.json()) as { error: { kind: string } }).error.kind,
      "storage_failed",
    );
    client = await botConnection(bot.origin, bot.token, liveId);
    const beforeWriteRun = model.verify();
    assert.equal(
      (
        await client.run("bash", model, {
          command: "printf native-with-sync-write-failure",
        })
      ).isError,
      false,
    );
    assert.equal(model.verify() - beforeWriteRun, 2);
    assert.deepEqual(readFileSync(path), broken);
    console.log(
      JSON.stringify({
        kind: "optional-sync-preference-failure",
        localReady: true,
        storageFailed: true,
        originalBytesKept: true,
        nativeProviderDelta: 2,
      }),
    );
  } finally {
    if (client?.socket.readyState === WebSocket.OPEN)
      await new Promise<void>((done) => {
        client?.socket.once("close", () => done());
        client?.socket.close();
      });
    await bot?.stop();
    await service?.stop();
    await worker?.mf.dispose();
    await new Promise<void>((done) => model.server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
    rmSync(workerRoot, { recursive: true, force: true });
  }
});

test("automatic bounded SDK pages revisit a real cache gap without redownloading held bodies or delaying a new tail", {
  timeout: 90000,
}, async () => {
  const root = realpathSync(mkdtempSync("/tmp/eagle-auto-pages-")),
    workerRoot = mkdtempSync(resolve(".local/auto-pages-worker-"));
  const key = randomBytes(32).toString("base64url"),
    model = await modelFixture(key);
  const helpers: Awaited<ReturnType<typeof helper>>[] = [],
    bots: Awaited<ReturnType<typeof daemon>>[] = [];
  let worker: Awaited<ReturnType<typeof workerFixture>> | undefined;
  try {
    worker = await workerFixture(workerRoot, true);
    const a = await helper(join(root, "a"), worker.origin),
      b = await helper(join(root, "b"), worker.origin);
    helpers.push(a, b);
    const invitation = await a.manage("pairing.create", {});
    await b.manage("pairing.redeem", {
      requestId: randomUUID(),
      code: invitation.code,
    });
    const ad = await daemon(
      join(root, "a-bots"),
      a.socketPath,
      model.baseUrl,
      key,
      { cacheOrigin: worker.origin },
    );
    bots.push(ad);
    let bd = await daemon(
      join(root, "b-bots"),
      b.socketPath,
      model.baseUrl,
      key,
      { cacheOrigin: worker.origin },
    );
    bots.push(bd);
    const ab = (
        await ad.post<{ bot: { id: string } }>("/v1/bots", {
          title: "Paged reader",
        })
      ).bot.id,
      bb = (
        await bd.post<{ bot: { id: string } }>("/v1/bots", {
          title: "Paged publisher",
        })
      ).bot.id;
    const sharedBotId = randomUUID();
    await ad.post(`/v1/bots/${ab}/replica/bind`, { sharedBotId });
    await bd.post(`/v1/bots/${bb}/replica/bind`, { sharedBotId });
    await bd.post(`/v1/bots/${bb}/replica/export`, {
      kind: "resources",
      resources: JSON.parse(
        readFileSync("fixtures/bots-sync/resources.v1.json", "utf8"),
      ),
    });
    const baseline = await bd.post<
      Page & { source: { replicaId: string; epoch: string }; nextAfter: number }
    >(`/v1/bots/${bb}/replica/pull`, { after: 0 });
    await ad.post(`/v1/bots/${ab}/replica/apply`, { page: baseline });
    await b.manage("sync.share", {
      sharedBotId,
      peerDeviceId: a.deviceId,
      enabled: true,
    });
    await localCall(a.socketPath, "sync.key.publish", {});
    await bd.stop();
    bots.splice(bots.indexOf(bd), 1);
    bd = await daemon(join(root, "b-bots"), b.socketPath, model.baseUrl, key, {
      cacheOrigin: worker.origin,
      seed: { botId: bb, count: 128, bytes: 100000 },
    });
    bots.push(bd);
    const pages = async (target: typeof bd, botId: string) => {
      const result: (Page & { nextAfter: number; hasMore: boolean })[] = [];
      let after = 0;
      do {
        const page = await target.post<
          Page & { nextAfter: number; hasMore: boolean }
        >(`/v1/bots/${botId}/replica/pull`, {
          source: baseline.source,
          after,
          limit: 128,
        });
        result.push(page);
        assert(page.nextAfter > after || !page.hasMore);
        after = page.nextAfter;
      } while (result.at(-1)?.hasMore);
      return result;
    };
    const original = await pages(bd, bb);
    assert(original.length >= 2);
    const firstPage = original[0],
      lastPage = original.at(-1);
    assert(firstPage && lastPage);
    assert(firstPage.events.length < 128 && firstPage.hasMore);
    assert(
      original.every(
        (page) =>
          Buffer.byteLength(JSON.stringify({ page })) <= 8 * 1024 * 1024,
      ),
    );
    const state = async (target: typeof ad, botId: string) => {
      const response = await fetch(
        target.origin + `/v1/bots/${botId}/sync/connections`,
        { headers: { authorization: `Bearer ${target.token}` } },
      );
      assert.equal(response.status, 200);
      return response.json() as Promise<{
        replica: {
          streams: {
            source: { replicaId: string; epoch: string };
            received: number;
            applied: number;
            available: { from: number; to: number }[];
          }[];
        };
        connections: { cloudCached: { nextAfter: number } | null }[];
      }>;
    };
    const oldTail = lastPage.nextAfter;
    await bd.post(
      `/v1/bots/${bb}/sync/connections/${a.deviceId}`,
      { direction: "publish" },
      "PUT",
    );
    await until(
      async () =>
        (await state(bd, bb)).connections[0]?.cloudCached?.nextAfter === oldTail
          ? true
          : undefined,
      "all actual immutable page ACKs",
    );
    const storage = await worker.mf.unsafeGetDurableObjectStorage(
      "bots-sync",
      "SyncCache",
      { name: sharedBotId },
    );
    const objects = await storage.exec(
      "SELECT objectId,metadata FROM objects ORDER BY json_extract(metadata,'$.manifest.range.from')",
    );
    assert.equal(objects.length, original.length);
    const firstObject = objects[0];
    assert(firstObject);
    const missing = String(firstObject.objectId);
    // Owned metadata barrier preserves the real winner and uploaded clock while withholding availability.
    await storage.exec(
      "UPDATE objects SET state='pending' WHERE objectId=?",
      missing,
    );
    await storage.exec("INSERT INTO test_relay_network VALUES(1)");
    await bd.control("stopRelay", { botId: bb });
    await storage.exec("DELETE FROM test_cache_io");
    const io = async () =>
      await storage.exec("SELECT operation,after FROM test_cache_io");
    const directory = join(root, "a-bots/bots", ab),
      execution = () =>
        Object.fromEntries(
          Object.entries(counts(directory)).filter(([name]) =>
            /submission|task|local_run/.test(name),
          ),
        );
    const before = execution(),
      provider = model.verify();
    await ad.post(
      `/v1/bots/${ab}/sync/connections/${b.deviceId}`,
      { direction: "receive" },
      "PUT",
    );
    await until(async () => {
      const stream = (await state(ad, ab)).replica.streams.find(
        (stream) => stream.source.replicaId === baseline.source.replicaId,
      );
      const requests = await io();
      return stream?.received === baseline.nextAfter &&
        stream.available.some((range) => range.to === oldTail) &&
        requests.filter(
          (row) => row.operation === "list" && row.after === baseline.nextAfter,
        ).length >= 2
        ? true
        : undefined;
    }, "second actual gap revisit with the complete suffix held locally");
    const gapIO = await io();
    assert.equal(
      gapIO.filter((row) => row.operation === "get").length,
      objects.length - 1,
    );
    await bd.stop();
    bots.splice(bots.indexOf(bd), 1);
    bd = await daemon(join(root, "b-bots"), b.socketPath, model.baseUrl, key, {
      cacheOrigin: worker.origin,
      seed: { botId: bb, count: 2, bytes: 1000 },
    });
    bots.push(bd);
    const expected = await pages(bd, bb),
      lastExpected = expected.at(-1);
    assert(lastExpected);
    const tail = lastExpected.nextAfter;
    assert(tail > oldTail);
    await until(
      async () =>
        (await state(bd, bb)).connections[0]?.cloudCached?.nextAfter === tail
          ? true
          : undefined,
      "new tail cache ACK despite early reader gap",
    );
    await until(async () => {
      const stream = (await state(ad, ab)).replica.streams.find(
        (stream) => stream.source.replicaId === baseline.source.replicaId,
      );
      return stream?.received === baseline.nextAfter &&
        stream.available.some((range) => range.to === tail)
        ? true
        : undefined;
    }, "forward scan receives a new tail before the early gap is released");
    assert.equal(
      (await io()).filter((row) => row.operation === "get").length,
      objects.length,
    );
    await storage.exec(
      "UPDATE objects SET state='ready' WHERE objectId=?",
      missing,
    );
    await until(async () => {
      const stream = (await state(ad, ab)).replica.streams.find(
        (stream) => stream.source.replicaId === baseline.source.replicaId,
      );
      return stream?.received === tail && stream.applied === tail
        ? true
        : undefined;
    }, "actual SDK receives and drains the released prefix");
    const actual = await pages(ad, ab);
    assert.deepEqual(actual, expected);
    await ad.post(
      `/v1/bots/${ab}/sync/connections/${b.deviceId}`,
      {},
      "DELETE",
    );
    const totalIO = await io(),
      lists = totalIO.filter((row) => row.operation === "list"),
      gets = totalIO.filter((row) => row.operation === "get"),
      r2 = totalIO.filter((row) => row.operation === "r2");
    assert.equal(gets.length, objects.length + 1);
    assert(lists.length <= 3 * (objects.length + 1) + 3);
    assert(lists.some((row) => Number(row.after) >= oldTail));
    assert(r2.length <= lists.length * (objects.length + 1) + gets.length);
    assert.deepEqual(execution(), before);
    assert.equal(model.verify(), provider);
    console.log(
      JSON.stringify({
        kind: "automatic-real-paging-gap",
        sdkEntries: 130,
        pageCount: expected.length,
        initialObjects: objects.length,
        firstPageBytes: Buffer.byteLength(JSON.stringify(original[0])),
        secondGapVisit: true,
        newTailBeforeGap: true,
        listRequests: lists.length,
        getRequests: gets.length,
        r2Gets: r2.length,
        originalEventBytes: true,
        passiveExecutionDelta: 0,
      }),
    );
  } finally {
    for (const bot of bots.reverse()) await bot.stop();
    for (const service of helpers.reverse()) await service.stop();
    await worker?.mf.dispose();
    await new Promise<void>((done) => model.server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
    rmSync(workerRoot, { recursive: true, force: true });
  }
});

test("online holder registration uses its real session and ready binding without a direct endpoint", {
  timeout: 90000,
}, async () => {
  const root = realpathSync(mkdtempSync("/tmp/eagle-online-relay-"));
  const workerRoot = mkdtempSync(resolve(".local/online-relay-worker-"));
  const key = randomBytes(32).toString("base64url");
  const model = await modelFixture(key);
  const services: { stop(): Promise<void> }[] = [];
  const bots: { stop(): Promise<void> }[] = [];
  let worker: Awaited<ReturnType<typeof workerFixture>> | undefined;
  try {
    worker = await workerFixture(workerRoot, true);
    const a = await helper(join(root, "a"), worker.origin);
    services.push(a);
    const b = await helper(join(root, "b"), worker.origin);
    services.push(b);
    const invitation = await a.manage("pairing.create", {});
    await b.manage("pairing.redeem", {
      requestId: randomUUID(),
      code: invitation.code,
    });
    const bd = await daemon(
      join(root, "b-bots"),
      b.socketPath,
      model.baseUrl,
      key,
      {
        cacheOrigin: worker.origin,
      },
    );
    bots.push(bd);
    const bb = (
      await bd.post<{ bot: { id: string } }>("/v1/bots", {
        title: "Online holder",
      })
    ).bot.id;
    const sharedBotId = randomUUID();
    await bd.post(`/v1/bots/${bb}/replica/bind`, { sharedBotId });
    const resources = JSON.parse(
      readFileSync("fixtures/bots-sync/resources.v1.json", "utf8"),
    );
    await bd.post(`/v1/bots/${bb}/replica/export`, {
      kind: "resources",
      resources,
    });
    await b.manage("sync.share", {
      sharedBotId,
      peerDeviceId: a.deviceId,
      enabled: true,
    });
    const access = (await localCall(a.socketPath, "sync.access", {
      sharedBotId,
      peerDeviceId: b.deviceId,
      purpose: "replica.read",
    })) as Access & { endpoints: unknown };
    assert.equal(access.local.deviceId, a.deviceId);
    assert.equal(access.peer.deviceId, b.deviceId);
    assert.equal(access.endpoints, null);
    const status = await bd.post<RecordJSON>(
      `/v1/bots/${bb}/replica/status`,
      {},
    );
    const binding = {
      localBotId: status.localBotId,
      sharedBotId: status.sharedBotId,
      replicaId: status.replicaId,
      epoch: status.epoch,
    };
    assert.equal(binding.localBotId, bb);
    const metadata = {
      version: 1,
      operation: "register",
      sharedBotId,
      binding,
      generation: randomBytes(32).toString("base64url"),
      streams: status.streams,
    };
    const requestDigest = createHash("sha256")
      .update(canonicalDeviceJSON(metadata))
      .digest("hex");
    const before = counts(join(root, "b-bots/bots", bb));
    console.log(
      JSON.stringify({
        kind: "relay-registration-real-prerequisites",
        registrySQLite: true,
        realSwiftHelper: true,
        independentSession: true,
        paired: true,
        currentDirectionalGrant: true,
        readyBinding: true,
        directEndpoint: false,
        providerCalls: model.verify(),
      }),
    );
    const authority = (await localCall(b.socketPath, "sync.relay.authority", {
      version: 1,
      operation: "register",
      sharedBotId,
      requestDigest,
    })) as RecordJSON;
    assert.equal(authority.purpose, "replica.relay");
    assert.equal(authority.operation, "register");
    assert.equal(authority.sharedBotId, sharedBotId);
    assert.equal(authority.requestDigest, requestDigest);
    assert.equal((authority.requester as RecordJSON).deviceId, b.deviceId);
    assert.match(String(authority.authority), /^[A-Za-z0-9_-]{43}$/);
    const registered = await bd.post<{ registered: boolean }>(
      `/v1/bots/${bb}/sync/relay/register`,
      {},
    );
    assert.equal(registered.registered, true);
    const ad = await daemon(
      join(root, "a-bots"),
      a.socketPath,
      model.baseUrl,
      key,
      { cacheOrigin: worker.origin },
    );
    bots.push(ad);
    const ab = (
      await ad.post<{ bot: { id: string } }>("/v1/bots", {
        title: "Relay reader",
      })
    ).bot.id;
    await ad.post(`/v1/bots/${ab}/replica/bind`, { sharedBotId });
    const directory = await ad.post<{
      holders: { identity: { deviceId: string } }[];
    }>(`/v1/bots/${ab}/sync/relay/discover`, {});
    assert.equal(directory.holders[0]?.identity.deviceId, b.deviceId);
    const received = await ad.post<{
      stored: boolean;
      objectId: string;
      delivery: RecordJSON;
    }>(`/v1/bots/${ab}/sync/relay/pull`, {
      peerDeviceId: b.deviceId,
      source: { replicaId: status.replicaId, epoch: status.epoch },
      after: 0,
      limit: 128,
    });
    assert.equal(received.stored, true);
    const applied = await ad.post<{
      applied: { streams: { applied: number }[] };
    }>(`/v1/bots/${ab}/sync/objects/apply`, { objectId: received.objectId });
    assert(applied.applied.streams.some((stream) => stream.applied > 0));
    const ack = await ad.post<{
      peerApplied: { received: number; applied: number };
    }>(`/v1/bots/${ab}/sync/relay/ack`, {
      peerDeviceId: b.deviceId,
      delivery: received.delivery,
    });
    assert(ack.peerApplied.applied > 0);
    const receipts = await bd.post<{
      receipts: { binding: RecordJSON; received: number; applied: number }[];
    }>(`/v1/bots/${bb}/sync/relay/receipts`, { peerDeviceId: a.deviceId });
    assert.equal(receipts.receipts[0]?.binding.localBotId, ab);
    assert.equal(receipts.receipts[0]?.applied, ack.peerApplied.applied);

    const storage = await worker.mf.unsafeGetDurableObjectStorage(
      "bots-sync",
      "SyncCache",
      { name: sharedBotId },
    );
    const syncNamespace = (await worker.mf.getDurableObjectNamespace(
      "SYNC",
      "bots-sync",
    )) as unknown as {
      idFromName(name: string): string;
      get(id: string): { relaySqlCausePreserved(): Promise<boolean> };
    };
    const syncStub = syncNamespace.get(syncNamespace.idFromName(sharedBotId));
    for (const [table, target, botId, operation, input] of [
      [
        "relay_deliveries",
        ad,
        ab,
        "ack",
        { peerDeviceId: b.deviceId, delivery: received.delivery },
      ],
      ["relay_receipts", bd, bb, "receipts", { peerDeviceId: a.deviceId }],
      ["relay_holders", ad, ab, "discover", {}],
    ] as const) {
      const rows = await storage.exec(`SELECT * FROM ${table}`);
      await storage.exec(
        `ALTER TABLE ${table} RENAME TO owned_failed_${table}`,
      );
      try {
        const response = await fetch(
          target.origin + `/v1/bots/${botId}/sync/relay/${operation}`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${target.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(input),
          },
        );
        const value = (await response.json()) as {
          error: { kind: string; failure: string };
          trace: string;
        };
        console.log(
          JSON.stringify({
            kind: "real-relay-sql-refusal",
            table,
            operation,
            status: response.status,
            failureKind: value.error.kind,
          }),
        );
        assert.equal(response.status, 503);
        assert.equal(value.error.kind, "storage_failed");
        assert.equal(await syncStub.relaySqlCausePreserved(), true);
        const workerLogs = worker.logs;
        await until(
          async () =>
            workerLogs.some((row) => row.message.includes(value.error.failure))
              ? true
              : undefined,
          "relay SQL bounded origin",
        );
        const origins: { level: string; message: string }[] =
          worker.logs.filter((row) =>
            row.message.includes(value.error.failure),
          );
        assert.equal(origins.length, 1);
        assert.equal(origins[0]?.level, "error");
        assert.match(origins[0]?.message ?? "", new RegExp(value.trace));
        assert.match(origins[0]?.message ?? "", new RegExp(botId));
        assert.equal(JSON.stringify(origins).includes("no such table"), false);
        assert.equal(JSON.stringify(value).includes("carrier"), false);
      } finally {
        await storage.exec(
          `ALTER TABLE owned_failed_${table} RENAME TO ${table}`,
        );
        assert.deepEqual(await storage.exec(`SELECT * FROM ${table}`), rows);
      }
      await target.post(`/v1/bots/${botId}/sync/relay/${operation}`, input);
    }
    const holderLogs = () =>
      readdirSync(join(root, "b-bots/logs")).flatMap((file) =>
        readFileSync(join(root, "b-bots/logs", file), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(
            (line) =>
              JSON.parse(line) as {
                level: string;
                trace: string;
                botId: string;
                err?: { origin?: boolean; failure?: string };
              },
          ),
      );
    const registrySql = await worker.mf.unsafeGetDurableObjectStorage(
      "eagle",
      "DeviceRegistry",
      { name: "registry" },
    );
    for (const [index, refusal] of ["grant", "sql"].entries()) {
      const pins = () =>
        readdirSync(join(root, "a-bots/sync-objects/v1"))
          .filter((name) => name.endsWith(".json"))
          .sort();
      const beforePins = pins();
      await bd.control("holdStage");
      const pending = fetch(ad.origin + `/v1/bots/${ab}/sync/relay/pull`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ad.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          peerDeviceId: b.deviceId,
          source: { replicaId: status.replicaId, epoch: status.epoch },
          after: index,
          limit: 1,
        }),
      });
      await bd.message((m) => m.type === "stageHeld");
      if (refusal === "grant")
        await b.manage("sync.share", {
          sharedBotId,
          peerDeviceId: a.deviceId,
          enabled: false,
        });
      else
        await registrySql.exec(
          "ALTER TABLE sync_grants RENAME TO owned_failed_supply_grants",
        );
      let value: { error: { failure: string; kind: string }; trace: string };
      try {
        await bd.control("releaseStage");
        const response = await pending;
        value = (await response.json()) as typeof value;
        assert.equal(response.status, refusal === "grant" ? 403 : 503);
      } finally {
        if (refusal === "grant")
          await b.manage("sync.share", {
            sharedBotId,
            peerDeviceId: a.deviceId,
            enabled: true,
          });
        else
          await registrySql.exec(
            "ALTER TABLE owned_failed_supply_grants RENAME TO sync_grants",
          );
        await bd.control("releaseStage");
      }
      const origins = holderLogs().filter(
        (row) =>
          row.level === "error" && row.trace === value.trace && row.err?.origin,
      );
      assert.equal(
        origins.length,
        1,
        "actual holder refusal has one innermost origin",
      );
      console.log(
        JSON.stringify({
          kind: "relay-held-holder-refusal",
          refusal,
          trace: value.trace,
          holderFailure: origins[0]?.err?.failure,
          returnedFailure: value.error.failure,
          holderBot: origins[0]?.botId,
        }),
      );
      assert.equal(
        value.error.failure,
        origins[0]?.err?.failure,
        "relay must not replace the holder failure after final authorization",
      );
      assert.equal(origins[0]?.botId, bb);
      assert.equal(
        worker.logs.filter(
          (row) => row.level === "error" && row.message.includes(value.trace),
        ).length,
        0,
        "classified no-body refusal needs no second Worker origin",
      );
      assert.deepEqual(pins(), beforePins);
      assert.equal(JSON.stringify(value).includes("carrier"), false);
      assert.equal(JSON.stringify(value).includes("no such table"), false);
    }
    await storage.exec(
      "UPDATE relay_deliveries SET expires=0 WHERE requestId=?",
      String(received.delivery.requestId),
    );
    const expiredInput = { ...(receipts.receipts[0] as unknown as RecordJSON) };
    delete expiredInput.receiver;
    const expiredAuthority = (await localCall(
      a.socketPath,
      "sync.relay.authority",
      {
        version: 1,
        operation: "ack",
        sharedBotId,
        peerDeviceId: b.deviceId,
        requestDigest: createHash("sha256")
          .update(canonicalDeviceJSON(expiredInput))
          .digest("hex"),
      },
    )) as { authority: string };
    const unavailable = await fetch(worker.origin + "/v1/relay/ack", {
      method: "POST",
      headers: {
        authorization: `Bearer ${expiredAuthority.authority}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(expiredInput),
    });
    assert.equal(
      unavailable.status,
      410,
      "only an authorized unavailable delivery ends ACK retry",
    );
    const unavailableBody = (await unavailable.json()) as {
      error: { code: string };
    };
    assert.match(
      JSON.stringify(unavailableBody),
      /sync_relay_delivery_unavailable/,
    );
    assert.deepEqual(
      (
        await bd.post<{ receipts: unknown[] }>(
          `/v1/bots/${bb}/sync/relay/receipts`,
          { peerDeviceId: a.deviceId },
        )
      ).receipts,
      receipts.receipts,
      "expired delivery does not advance or erase confirmed progress",
    );
    const oldGeneration = (
      await bd.post<{ generation: string }>(
        `/v1/bots/${bb}/sync/relay/register`,
        {},
      )
    ).generation;
    const oldPins = readdirSync(join(root, "a-bots/sync-objects/v1"))
      .filter((name) => name.endsWith(".json"))
      .sort();
    await bd.control("holdStage");
    const late = fetch(ad.origin + `/v1/bots/${ab}/sync/relay/pull`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ad.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        peerDeviceId: b.deviceId,
        source: { replicaId: status.replicaId, epoch: status.epoch },
        after: 3,
        limit: 1,
      }),
    });
    await bd.message((m) => m.type === "stageHeld");
    await bd.control("stopRelay", { botId: bb });
    await bd.control("releaseStage");
    assert.equal((await late).status, 503);
    assert.deepEqual(
      readdirSync(join(root, "a-bots/sync-objects/v1"))
        .filter((name) => name.endsWith(".json"))
        .sort(),
      oldPins,
      "late old socket cannot publish a reader pin",
    );
    assert.notEqual(
      (
        await bd.post<{ generation: string }>(
          `/v1/bots/${bb}/sync/relay/register`,
          {},
        )
      ).generation,
      oldGeneration,
    );
    console.log(
      JSON.stringify({
        kind: "real-relay-old-socket",
        latePin: false,
        newGeneration: true,
      }),
    );
    for (const [index, boundary] of ["self", "binding", "close"].entries()) {
      const pins = () =>
        readdirSync(join(root, "a-bots/sync-objects/v1"))
          .filter((name) => name.endsWith(".json"))
          .sort();
      const oldPins = pins();
      await ad.control("holdStage");
      const pending = fetch(ad.origin + `/v1/bots/${ab}/sync/relay/pull`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ad.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          peerDeviceId: b.deviceId,
          source: { replicaId: status.replicaId, epoch: status.epoch },
          after: index,
          limit: 1,
        }),
      });
      await ad.message((m) => m.type === "stageHeld");
      let restore = () => {};
      try {
        if (boundary === "binding")
          restore = changeBinding(
            join(root, "a-bots/bots", ab),
            "epoch",
            randomUUID(),
          );
        else await ad.control(boundary === "self" ? "clearReady" : "closeSync");
        await ad.control("releaseStage");
        const response = await pending;
        const value = (await response.json()) as { error?: { kind: string } };
        assert.equal(
          response.status,
          boundary === "self" ? 200 : boundary === "binding" ? 503 : 403,
        );
        if (boundary === "binding")
          assert.equal(value.error?.kind, "invalid_command");
        if (boundary !== "self") assert.deepEqual(pins(), oldPins);
      } finally {
        restore();
        await ad.control("releaseStage");
      }
      console.log(
        JSON.stringify({
          kind: "real-relay-recipient-stage",
          boundary,
          pinPublished: boundary === "self",
          passiveExecutionDelta: 0,
        }),
      );
    }
    assert.deepEqual(counts(join(root, "b-bots/bots", bb)), before);
    assert.equal(model.verify(), 0);
  } finally {
    for (const bot of bots.reverse()) await bot.stop();
    for (const service of services.reverse()) await service.stop();
    await worker?.mf.dispose();
    await new Promise<void>((done) => model.server.close(() => done()));
    rmSync(workerRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("automatic online holder restores an original offline source into a new replica with actual apply receipts", {
  timeout: 90000,
}, async () => {
  const root = realpathSync(mkdtempSync("/tmp/eagle-online-holder-chain-"));
  const workerRoot = mkdtempSync(resolve(".local/online-holder-chain-worker-"));
  const key = randomBytes(32).toString("base64url"),
    model = await modelFixture(key);
  const services: { stop(): Promise<void> }[] = [],
    bots: { stop(): Promise<void> }[] = [],
    clients: Awaited<ReturnType<typeof botConnection>>[] = [];
  let worker: Awaited<ReturnType<typeof workerFixture>> | undefined;
  try {
    worker = await workerFixture(workerRoot, true);
    const a = await helper(join(root, "a"), worker.origin);
    services.push(a);
    const b = await helper(join(root, "b"), worker.origin);
    services.push(b);
    const c = await helper(join(root, "c"), worker.origin);
    services.push(c);
    for (const peer of [b, c]) {
      const invite = await a.manage("pairing.create", {});
      await peer.manage("pairing.redeem", {
        requestId: randomUUID(),
        code: invite.code,
      });
    }
    let ad = await daemon(
      join(root, "a-bots"),
      a.socketPath,
      model.baseUrl,
      key,
      { cacheOrigin: worker.origin, holdAuto: true },
    );
    bots.push(ad);
    const bd = await daemon(
      join(root, "b-bots"),
      b.socketPath,
      model.baseUrl,
      key,
      { cacheOrigin: worker.origin, holdAuto: true },
    );
    bots.push(bd);
    const sharedBotId = randomUUID();
    const ab = (
      await ad.post<{ bot: { id: string } }>("/v1/bots", {
        title: "Original A",
      })
    ).bot.id;
    const bb = (
      await bd.post<{ bot: { id: string } }>("/v1/bots", { title: "Holder B" })
    ).bot.id;
    await ad.post(`/v1/bots/${ab}/replica/bind`, { sharedBotId });
    await bd.post(`/v1/bots/${bb}/replica/bind`, { sharedBotId });
    const resources = JSON.parse(
      readFileSync("fixtures/bots-sync/resources.v1.json", "utf8"),
    );
    const fixed = await bd.post(`/v1/bots/${bb}/replica/export`, {
      kind: "resources",
      resources,
    });
    const bNative = await botConnection(bd.origin, bd.token, bb);
    clients.push(bNative);
    assert.equal(
      (
        await bNative.run(
          "bash",
          model,
          { command: "printf original-holder-parent" },
          { resourceHead: String(fixed.head) },
        )
      ).isError,
      false,
    );
    const parent = await bd.post<History>(`/v1/bots/${bb}/replica/export`, {
      resources,
    });
    const resourcePage = await bd.post<
      Page & { source: { replicaId: string; epoch: string }; nextAfter: number }
    >(`/v1/bots/${bb}/replica/pull`, { after: 0, limit: 128 });
    await ad.post(`/v1/bots/${ab}/replica/apply`, { page: resourcePage });
    const original = await botConnection(ad.origin, ad.token, ab);
    clients.push(original);
    const branch = `r_${randomUUID()}`,
      run = {
        head: parent.head,
        requestId: branch,
        text: "continue original B head on A",
      };
    model.script("bash", { command: "printf original-online-holder-history" });
    await ad.post(`/v1/bots/${ab}/replica/run`, run);
    await until(async () => {
      const result = await ad.post<{ submission: { status: string } }>(
        `/v1/bots/${ab}/replica/run`,
        run,
      );
      return result.submission.status === "done" ? true : undefined;
    }, "real A branch settles against original B head");
    const history = await ad.post<History>(`/v1/bots/${ab}/replica/export`, {
      branch,
    });
    await new Promise<void>((done) => {
      original.socket.once("close", () => done());
      original.socket.close();
    });
    clients.splice(clients.indexOf(original), 1);
    await ad.stop();
    bots.splice(bots.indexOf(ad), 1);
    ad = await daemon(join(root, "a-bots"), a.socketPath, model.baseUrl, key, {
      cacheOrigin: worker.origin,
      holdAuto: true,
      seed: { botId: ab, count: 128, bytes: 100000, spread: true },
    });
    bots.push(ad);
    const page = await ad.post<
      Page & { source: { replicaId: string; epoch: string }; nextAfter: number }
    >(`/v1/bots/${ab}/replica/pull`, { after: 0, limit: 128 });
    await a.manage("sync.share", {
      sharedBotId,
      peerDeviceId: b.deviceId,
      enabled: true,
    });
    await ad.post(`/v1/bots/${ab}/sync/relay/register`, {});
    const originalPages = [page];
    while ((originalPages.at(-1) as Page & { hasMore?: boolean }).hasMore) {
      const next = await ad.post<typeof page>(`/v1/bots/${ab}/replica/pull`, {
        source: page.source,
        after: originalPages[originalPages.length - 1].nextAfter,
        limit: 128,
      });
      originalPages.push(next);
    }
    assert(originalPages.length >= 2);
    assert(
      Buffer.byteLength(JSON.stringify({ page: originalPages[0] })) <=
        8 * 1024 * 1024,
    );
    for (let i = 0; i < originalPages.length; i++) {
      const held = await bd.post<{ objectId: string }>(
        `/v1/bots/${bb}/sync/relay/pull`,
        {
          peerDeviceId: a.deviceId,
          source: page.source,
          after: i ? originalPages[i - 1].nextAfter : 0,
          limit: 128,
        },
      );
      await bd.post(`/v1/bots/${bb}/sync/objects/apply`, {
        objectId: held.objectId,
      });
    }
    const tail = originalPages[originalPages.length - 1].nextAfter;
    assert.deepEqual(
      await bd.post(`/v1/bots/${bb}/replica/export`, { head: history.head }),
      history,
    );
    await ad.stop();
    bots.splice(bots.indexOf(ad), 1);
    await a.stop();
    services.splice(services.indexOf(a), 1);
    await b.manage("sync.share", {
      sharedBotId,
      peerDeviceId: c.deviceId,
      enabled: true,
    });
    await bd.post(`/v1/bots/${bb}/sync/relay/register`, {});
    const bucket = (await worker.mf.getR2Bucket(
      "CIPHERS",
      "bots-sync",
    )) as unknown as { list(): Promise<{ objects: { key: string }[] }> };
    assert.equal(
      (await bucket.list()).objects.length,
      0,
      "relay has never cached original events in R2",
    );
    let cd = await daemon(
      join(root, "c-bots"),
      c.socketPath,
      model.baseUrl,
      key,
      { cacheOrigin: worker.origin, holdAuto: true },
    );
    bots.push(cd);
    const cb = (
      await cd.post<{ bot: { id: string } }>("/v1/bots", { title: "New C" })
    ).bot.id;
    await cd.post(`/v1/bots/${cb}/replica/bind`, { sharedBotId });
    let native = await botConnection(cd.origin, cd.token, cb);
    clients.push(native);
    const execution = () =>
      Object.fromEntries(
        Object.entries(counts(join(root, "c-bots/bots", cb))).filter(([name]) =>
          /submission|task|local_run/.test(name),
        ),
      );
    const peerBytes = () =>
      readdirSync(join(root, "c-bots/peers")).map((name) => [
        name,
        readFileSync(join(root, "c-bots/peers", name)).toString("base64"),
      ]);
    const journal = join(root, "c-bots/bots", cb, "pulls.journal.jsonl");
    const journalBytes = () =>
      existsSync(journal) ? readFileSync(journal).toString("base64") : null;
    const before = execution(),
      peers = peerBytes(),
      pr = journalBytes(),
      provider = model.verify();
    await cd.post(
      `/v1/bots/${cb}/sync/connections/${b.deviceId}`,
      { direction: "receive", source: page.source },
      "PUT",
    );
    const syncSql = await worker.mf.unsafeGetDurableObjectStorage(
      "bots-sync",
      "SyncCache",
      { name: sharedBotId },
    );
    await syncSql.exec("DELETE FROM test_cache_io");
    const io = async (operation: string) =>
      Number(
        (
          await syncSql.exec(
            "SELECT count(*) AS n FROM test_cache_io WHERE operation=?",
            operation,
          )
        )[0]?.n,
      );
    await cd.control("faultReceiveIO");
    await bd.control("holdStage");
    await cd.control("startAuto");
    await bd.message((m) => m.type === "stageHeld");
    const registryStorage = await worker.mf.unsafeGetDurableObjectStorage(
      "eagle",
      "DeviceRegistry",
      { name: "registry" },
    );
    await registryStorage.exec(
      "CREATE TABLE test_relay_registry_gate(started INTEGER,released INTEGER)",
    );
    await registryStorage.exec(
      "INSERT INTO test_relay_registry_gate VALUES(0,0)",
    );
    const renewal = bd
      .post(`/v1/bots/${bb}/sync/relay/register`, {})
      .catch((error) => error as Error);
    try {
      await until(
        async () =>
          (
            await registryStorage.exec(
              "SELECT started FROM test_relay_registry_gate",
            )
          )[0]?.started
            ? true
            : undefined,
        "real same-generation renewal at final Registry RPC",
      );
      await bd.control("releaseStage");
      await until(async () => {
        const state = await cd.post<{
          replica: {
            streams: { source: unknown; received: number; applied: number }[];
          };
        }>(`/v1/bots/${cb}/sync/connections`, {}, "GET");
        return state.replica.streams.some(
          (s) =>
            JSON.stringify(s.source) === JSON.stringify(page.source) &&
            s.received > 0,
        )
          ? true
          : undefined;
      }, "first authenticated page completes during same-socket renewal");
    } finally {
      await registryStorage.exec(
        "UPDATE test_relay_registry_gate SET released=1",
      );
      await bd.control("releaseStage");
    }
    assert.equal((await renewal) instanceof Error, false);
    await registryStorage.exec("DROP TABLE test_relay_registry_gate");
    const failed = await until(async () => {
      const value = await cd.control("receiveIOStats");
      return value.failure as RecordJSON | undefined;
    }, "relay stored receive commits before actual SQLite materialization I/O failure");
    assert.equal(failed.kind, "storage_failed");
    assert.equal(failed.originalCause, true);
    assert.equal(failed.causeCode, "ERR_SQLITE_ERROR");
    const ioOrigins = readdirSync(join(root, "c-bots/logs"))
      .flatMap((file) =>
        readFileSync(join(root, "c-bots/logs", file), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      )
      .filter(
        (row) =>
          row.level === "error" &&
          row.trace === failed.trace &&
          row.err?.failure === failed.failure,
      );
    assert.equal(ioOrigins.length, 1);
    assert.equal(ioOrigins[0].err.origin, true);
    assert.equal(ioOrigins[0].botId, cb);
    assert.equal(
      (await syncSql.exec("SELECT count(*) AS n FROM relay_receipts"))[0]?.n,
      0,
      "failed apply has not reported completion",
    );
    const preferences = () =>
      JSON.parse(
        readFileSync(join(root, "c-bots/sync-connections/v1.json"), "utf8"),
      );
    assert(preferences().connections[0].pendingApply);
    assert(preferences().connections[0].pendingReceipt);
    const firstObjects = await io("relay-object");
    assert.equal(firstObjects, 1);
    await cd.control("restoreReceiveIO");
    await new Promise<void>((done) => {
      native.socket.once("close", () => done());
      native.socket.close();
    });
    clients.splice(clients.indexOf(native), 1);
    await cd.stop();
    bots.splice(bots.indexOf(cd), 1);
    await syncSql.exec("INSERT INTO test_relay_ack_reply VALUES(1,0)");
    cd = await daemon(join(root, "c-bots"), c.socketPath, model.baseUrl, key, {
      cacheOrigin: worker.origin,
      holdAuto: true,
    });
    bots.push(cd);
    native = await botConnection(cd.origin, cd.token, cb);
    clients.push(native);
    await cd.control("startAuto");
    await until(
      async () =>
        (await syncSql.exec("SELECT lost FROM test_relay_ack_reply"))[0]
          ?.lost === 1
          ? true
          : undefined,
      "ACK persists before its actual response body is lost",
    );
    const pending = preferences().connections[0].pendingReceipt;
    assert(pending);
    assert.equal(
      await io("relay-object"),
      firstObjects,
      "cold local apply and lost ACK use no extra body",
    );
    assert.equal(Number((await cd.control("syncObjectCalls")).applyCalls), 1);
    await syncSql.exec(
      "UPDATE relay_deliveries SET expires=0 WHERE requestId=?",
      pending.delivery.requestId,
    );
    await until(
      async () =>
        !preferences().connections[0].pendingReceipt ||
        preferences().connections[0].pendingReceipt.delivery.requestId !==
          pending.delivery.requestId
          ? true
          : undefined,
      "authorized expired delivery cannot permanently block new receiving",
    );

    await until(async () => {
      const status = await cd.post<{
        streams: { source: unknown; received: number; applied: number }[];
      }>(`/v1/bots/${cb}/replica/status`, {});
      return status.streams.some(
        (s) =>
          JSON.stringify(s.source) === JSON.stringify(resourcePage.source) &&
          s.received === resourcePage.nextAfter &&
          s.applied === resourcePage.nextAfter,
      ) &&
        status.streams.some(
          (s) =>
            JSON.stringify(s.source) === JSON.stringify(page.source) &&
            s.received === tail &&
            s.applied === tail,
        )
        ? true
        : undefined;
    }, "all original sources and cross-source parent dependency actually apply");
    assert.deepEqual(
      await cd.post(`/v1/bots/${cb}/replica/export`, { head: history.head }),
      history,
    );
    assert.deepEqual(
      await cd.post(`/v1/bots/${cb}/replica/export`, {
        kind: "resources",
        head: fixed.head,
      }),
      fixed,
    );
    for (let i = 0; i < originalPages.length; i++)
      assert.deepEqual(
        Buffer.from(
          JSON.stringify(
            await cd.post(`/v1/bots/${cb}/replica/pull`, {
              source: page.source,
              after: i ? originalPages[i - 1].nextAfter : 0,
              limit: 128,
            }),
          ),
        ),
        Buffer.from(JSON.stringify(originalPages[i])),
      );
    assert.deepEqual(
      await cd.post(`/v1/bots/${cb}/replica/pull`, {
        source: resourcePage.source,
        after: 0,
        limit: 128,
      }),
      resourcePage,
    );
    const receivedObjects = await io("relay-object"),
      listCalls = await io("list");
    assert.equal(
      receivedObjects,
      originalPages.length + 1,
      "one relay object per actual page/source, never per event",
    );
    assert.equal(await io("get"), 0);
    assert.equal(await io("r2"), 0);
    await until(
      async () => ((await io("list")) >= listCalls + 2 ? true : undefined),
      "second bounded tail/gap visit after all source dependencies arrive",
    );
    assert.equal(
      await io("relay-object"),
      receivedObjects,
      "held complete objects are not downloaded again at an old gap",
    );
    assert.deepEqual(execution(), before);
    assert.deepEqual(peerBytes(), peers);
    assert.equal(journalBytes(), pr);
    assert.equal(model.verify(), provider);
    await until(async () => {
      const receipts = await bd.post<{
        receipts: {
          binding: { localBotId: string };
          source: unknown;
          applied: number;
          received: number;
        }[];
      }>(`/v1/bots/${bb}/sync/relay/receipts`, { peerDeviceId: c.deviceId });
      return receipts.receipts.find(
        (r) =>
          r.binding.localBotId === cb &&
          JSON.stringify(r.source) === JSON.stringify(page.source) &&
          r.applied <= tail &&
          r.received === tail,
      );
    }, "actual persistent receiver binding/source ACK");
    assert.equal((await bucket.list()).objects.length, 0);
    await bd.stop();
    bots.splice(bots.indexOf(bd), 1);
    assert.equal(
      (
        await cd.post<{ holders: unknown[] }>(
          `/v1/bots/${cb}/sync/relay/discover`,
          {},
        )
      ).holders.length,
      0,
    );
    assert.equal(
      (
        await native.run(
          "bash",
          model,
          { command: "printf cold-holder-native" },
          { resourceHead: String(fixed.head) },
        )
      ).isError,
      false,
    );
    assert.equal(model.verify(), provider + 2);
    console.log(
      JSON.stringify({
        kind: "real-online-holder-chain",
        registrySQLite: true,
        realSwiftHelpers: 3,
        independentNodeBots: 3,
        originalOffline: true,
        cacheAbsent: true,
        originalSource: page.source,
        originalBytes: Buffer.byteLength(JSON.stringify(page)),
        historyEntries: history.entries.length,
        head: history.head,
        passiveExecutionDelta: 0,
        nativeProviderDelta: 2,
        actualReceived: tail,
        relayAckDoesNotInventDependencyCompletion: true,
        coldPendingApplyRecovery: true,
        lostAckPersisted: true,
        expiredDeliveryUnblocks: true,
        relayObjects: receivedObjects,
        additionalR2Gets: 0,
        multiPageCount: originalPages.length,
        crossSourceDependency: true,
      }),
    );
  } finally {
    for (const client of clients.reverse())
      if (client.socket.readyState === WebSocket.OPEN)
        await new Promise<void>((done) => {
          client.socket.once("close", () => done());
          client.socket.close();
        });
    for (const bot of bots.reverse()) await bot.stop();
    for (const service of services.reverse()) await service.stop();
    await worker?.mf.dispose();
    await new Promise<void>((done) => model.server.close(() => done()));
    rmSync(workerRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("automatic holder registration retains configuration ownership across real status and ready awaits", {
  timeout: 90000,
}, async (t) => {
  const root = realpathSync(mkdtempSync("/tmp/eagle-relay-register-owner-"));
  const workerRoot = mkdtempSync(
    resolve(".local/relay-register-owner-worker-"),
  );
  const key = randomBytes(32).toString("base64url");
  const model = await modelFixture(key);
  const services: Awaited<ReturnType<typeof helper>>[] = [];
  let worker: Awaited<ReturnType<typeof workerFixture>> | undefined;
  try {
    worker = await workerFixture(workerRoot, true);
    const a = await helper(join(root, "a"), worker.origin);
    services.push(a);
    const b = await helper(join(root, "b"), worker.origin);
    services.push(b);
    const invitation = await a.manage("pairing.create", {});
    await b.manage("pairing.redeem", {
      requestId: randomUUID(),
      code: invitation.code,
    });
    await localCall(a.socketPath, "sync.key.publish", {});
    const syncWorker = worker;
    for (const stage of ["status", "check"])
      await t.test(
        `DELETE while ${stage} is held cannot resurrect an automatic holder`,
        async () => {
          const botRoot = join(root, stage);
          const bd = await daemon(botRoot, b.socketPath, model.baseUrl, key, {
            cacheOrigin: syncWorker.origin,
            holdAuto: true,
          });
          try {
            const bb = (
              await bd.post<{ bot: { id: string } }>("/v1/bots", {
                title: "Owned registration",
              })
            ).bot.id;
            const sharedBotId = randomUUID();
            await bd.post(`/v1/bots/${bb}/replica/bind`, { sharedBotId });
            const resources = JSON.parse(
              readFileSync("fixtures/bots-sync/resources.v1.json", "utf8"),
            );
            await bd.post(`/v1/bots/${bb}/replica/export`, {
              kind: "resources",
              resources,
            });
            await b.manage("sync.share", {
              sharedBotId,
              peerDeviceId: a.deviceId,
              enabled: true,
            });
            const discover = { version: 1, operation: "discover", sharedBotId };
            const ticket = (await localCall(
              a.socketPath,
              "sync.relay.authority",
              {
                ...discover,
                requestDigest: createHash("sha256")
                  .update(canonicalDeviceJSON(discover))
                  .digest("hex"),
              },
            )) as { authority: string };
            assert.equal(
              (
                await syncWorker.mf.dispatchFetch(
                  syncWorker.origin + "/v1/relay/discover",
                  {
                    method: "POST",
                    headers: {
                      "content-type": "application/json",
                      authorization: `Bearer ${ticket.authority}`,
                    },
                    body: JSON.stringify(discover),
                  },
                )
              ).status,
              200,
              "real authorized directory initializes owning DO before the no-socket assertion",
            );
            await bd.control("holdRegistration", { stage });
            await bd.post(
              `/v1/bots/${bb}/sync/connections/${a.deviceId}`,
              { direction: "publish" },
              "PUT",
            );
            const before = counts(join(botRoot, "bots", bb));
            await bd.control("startAuto");
            await bd.message(
              (m) => m.type === "registrationHeld" && m.stage === stage,
            );
            await bd.post(
              `/v1/bots/${bb}/sync/connections/${a.deviceId}`,
              {},
              "DELETE",
            );
            await bd.control("releaseRegistration");
            await until(
              async () =>
                Number(
                  (await bd.control("registrationStats")).registerPending,
                ) === 0
                  ? true
                  : undefined,
              "owned registration continuation settles",
            );
            const storage = await syncWorker.mf.unsafeGetDurableObjectStorage(
              "bots-sync",
              "SyncCache",
              { name: sharedBotId },
            );
            const connects = await storage.exec(
              "SELECT count(*) AS n FROM test_cache_io WHERE operation='relay-connect'",
            );
            const holders = await storage.exec("SELECT * FROM relay_holders");
            console.log(
              JSON.stringify({
                kind: "automatic-registration-deleted",
                stage,
                connects: connects[0]?.n,
                holders: holders.length,
                stats: await bd.control("registrationStats"),
              }),
            );
            assert.equal(
              connects[0]?.n,
              0,
              "deleted original preference must not admit a fresh WSS socket",
            );
            assert.equal(
              holders.length,
              0,
              "deleted preference must not publish/renew an advertisement",
            );
            assert.deepEqual(counts(join(botRoot, "bots", bb)), before);
            assert.equal(model.verify(), 0);
            // A new explicit preference remains valid after independent upload completes.
            await bd.post(
              `/v1/bots/${bb}/sync/connections/${a.deviceId}`,
              { direction: "publish" },
              "PUT",
            );
            await until(async () => {
              const state = await bd.post<{
                connections: { cloudCached: unknown }[];
              }>(`/v1/bots/${bb}/sync/connections`, undefined, "GET");
              return state.connections[0]?.cloudCached ? true : undefined;
            }, "independent upload receives a real cloud ACK");
            await until(async () => {
              const rows = await storage.exec("SELECT * FROM relay_holders");
              return rows.length ? rows : undefined;
            }, "new valid configuration registers");
            const renewed = await bd.post<{
              registered: boolean;
              generation: string;
            }>(`/v1/bots/${bb}/sync/relay/register`, {});
            assert(renewed.registered);
            const again = await bd.post<{ generation: string }>(
              `/v1/bots/${bb}/sync/relay/register`,
              {},
            );
            assert.equal(
              again.generation,
              renewed.generation,
              "same socket renewal remains valid",
            );
            await bd.post(
              `/v1/bots/${bb}/sync/connections/${a.deviceId}`,
              {},
              "DELETE",
            );
            assert.deepEqual(counts(join(botRoot, "bots", bb)), before);
            assert.equal(model.verify(), 0);
          } finally {
            await bd.control("releaseRegistration");
            await bd.stop();
          }
        },
      );
  } finally {
    for (const service of services.reverse()) await service.stop();
    await worker?.mf.dispose();
    await new Promise<void>((done) => model.server.close(() => done()));
    rmSync(workerRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("authenticated receiver status reports actual persistent cache apply and holder independently reads its full key", {
  timeout: 90000,
}, async () => {
  const root = realpathSync(mkdtempSync("/tmp/eagle-allpath-status-"));
  const workerRoot = mkdtempSync(resolve(".local/allpath-status-worker-"));
  const key = randomBytes(32).toString("base64url");
  const model = await modelFixture(key);
  const services: { stop(): Promise<void> }[] = [];
  const bots: { stop(): Promise<void> }[] = [];
  let worker: Awaited<ReturnType<typeof workerFixture>> | undefined;
  try {
    worker = await workerFixture(workerRoot, true);
    const currentWorker = worker;
    const a = await helper(join(root, "a"), worker.origin);
    services.push(a);
    const b = await helper(join(root, "b"), worker.origin);
    services.push(b);
    const invitation = await a.manage("pairing.create", {});
    await b.manage("pairing.redeem", {
      requestId: randomUUID(),
      code: invitation.code,
    });
    const ad = await daemon(
      join(root, "a-bots"),
      a.socketPath,
      model.baseUrl,
      key,
      {
        cacheOrigin: worker.origin,
        holdAuto: true,
      },
    );
    bots.push(ad);
    const bd = await daemon(
      join(root, "b-bots"),
      b.socketPath,
      model.baseUrl,
      key,
      {
        cacheOrigin: worker.origin,
        holdAuto: true,
      },
    );
    bots.push(bd);
    const ab = (
      await ad.post<{ bot: { id: string } }>("/v1/bots", {
        title: "Status receiver",
      })
    ).bot.id;
    const bb = (
      await bd.post<{ bot: { id: string } }>("/v1/bots", {
        title: "Status holder",
      })
    ).bot.id;
    const sharedBotId = randomUUID();
    await ad.post(`/v1/bots/${ab}/replica/bind`, { sharedBotId });
    await bd.post(`/v1/bots/${bb}/replica/bind`, { sharedBotId });
    await bd.post(`/v1/bots/${bb}/replica/export`, {
      kind: "resources",
      resources: JSON.parse(
        readFileSync("fixtures/bots-sync/resources.v1.json", "utf8"),
      ),
    });
    await b.manage("sync.share", {
      sharedBotId,
      peerDeviceId: a.deviceId,
      enabled: true,
    });
    await localCall(a.socketPath, "sync.key.publish", {});
    const before = counts(join(root, "a-bots/bots", ab));
    const cached = await bd.post(`/v1/bots/${bb}/sync/cache/publish`, {
      peerDeviceId: a.deviceId,
      after: 0,
      limit: 128,
    });
    assert.equal(cached.cloudCached, true);
    const stored = await ad.post(`/v1/bots/${ab}/sync/cache/receive`, {
      peerDeviceId: b.deviceId,
      objectId: cached.objectId,
    });
    await ad.post(`/v1/bots/${ab}/sync/objects/apply`, {
      objectId: stored.objectId,
    });
    const actual = await ad.post<RecordJSON>(
      `/v1/bots/${ab}/replica/status`,
      {},
    );
    const streams = actual.streams as {
      source: object;
      received: number;
      applied: number;
    }[];
    const source = streams.find((stream) => stream.applied > 0);
    assert(source, "actual persistent apply must precede any report");
    const transactionNamespace = (await worker.mf.getDurableObjectNamespace(
      "SYNC",
      "bots-sync",
    )) as unknown as {
      idFromName(name: string): string;
      get(id: string): {
        armStatusTransaction(): Promise<void>;
        statusTransactionResult(): Promise<RecordJSON>;
        restoreStatusTransaction(): Promise<void>;
      };
    };
    const transactionDO = transactionNamespace.get(
      transactionNamespace.idFromName(sharedBotId),
    );
    const transactionStorage = await worker.mf.unsafeGetDurableObjectStorage(
      "bots-sync",
      "SyncCache",
      { name: sharedBotId },
    );
    const transactionBefore = {
      events: await transactionStorage.exec(
        "SELECT * FROM events ORDER BY replicaId,epoch,seq",
      ),
      io: await transactionStorage.exec("SELECT * FROM test_cache_io"),
      applyCalls: Number((await ad.control("syncObjectCalls")).applyCalls),
      local: counts(join(root, "a-bots/bots", ab)),
    };
    let committedStatus: unknown;
    await transactionDO.armStatusTransaction();
    try {
      const failed = await fetch(
        ad.origin + `/v1/bots/${ab}/sync/relay/status-report`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${ad.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ peerDeviceId: b.deviceId }),
        },
      );
      const value = (await failed.json()) as {
        error: { kind: string; failure: string };
        trace: string;
      };
      const evidence = await transactionDO.statusTransactionResult();
      console.log(
        JSON.stringify({
          kind: "owned-status-transaction-boundary",
          status: failed.status,
          value,
          evidence,
        }),
      );
      assert.equal(
        evidence.callbackReturned,
        true,
        "real SQL callback must return before the injected boundary failure",
      );
      assert.equal(evidence.transactionReturned, true);
      assert.equal(evidence.injectedBoundary, true);
      await until(
        async () =>
          currentWorker.logs.some((row) =>
            row.message.includes(value.error.failure),
          )
            ? true
            : undefined,
        "transaction boundary origin",
      );
      const origins = currentWorker.logs.filter((row) =>
        row.message.includes(value.error.failure),
      );
      assert.equal(origins.length, 1);
      assert.equal(origins[0]?.level, "error");
      assert(origins[0]?.message.includes(value.trace));
      assert(origins[0]?.message.includes(ab));
      const propagated = readdirSync(join(root, "a-bots/logs")).flatMap((f) =>
        readFileSync(join(root, "a-bots/logs", f), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      );
      assert(
        propagated.some(
          (row) =>
            row.err?.failure === value.error.failure &&
            row.level === "warn" &&
            row.trace === value.trace &&
            row.botId === ab,
        ),
      );
      assert.equal(
        propagated.filter(
          (row) =>
            row.err?.failure === value.error.failure && row.level === "error",
        ).length,
        0,
      );
      assert(
        !JSON.stringify({ value, origins }).includes(
          "owned status transaction boundary failure",
        ),
      );
      assert.equal(failed.status, 503);
      assert.equal(value.error.kind, "storage_failed");
      assert.equal(evidence.sameCause, true);
      committedStatus = await transactionStorage.exec(
        "SELECT * FROM replica_status ORDER BY key",
      );
      assert((committedStatus as unknown[]).length > 0);
    } finally {
      await transactionDO.restoreStatusTransaction();
    }
    const report = await ad.post(`/v1/bots/${ab}/sync/relay/status-report`, {
      peerDeviceId: b.deviceId,
    });
    assert.equal(report.recorded, true);
    assert.equal(
      Number((await ad.control("syncObjectCalls")).applyCalls),
      transactionBefore.applyCalls,
    );
    assert.deepEqual(
      await transactionStorage.exec(
        "SELECT * FROM replica_status ORDER BY key",
      ),
      committedStatus,
      "the retry preserves the already-written snapshot and original recording time",
    );
    assert.deepEqual(
      counts(join(root, "a-bots/bots", ab)),
      transactionBefore.local,
    );
    assert.deepEqual(
      await transactionStorage.exec("SELECT * FROM test_cache_io"),
      transactionBefore.io,
    );
    assert.deepEqual(
      await transactionStorage.exec(
        "SELECT * FROM events ORDER BY replicaId,epoch,seq",
      ),
      transactionBefore.events,
    );
    assert.equal(model.verify(), 0);
    const read = await bd.post<{ snapshots: RecordJSON[]; hasMore: boolean }>(
      `/v1/bots/${bb}/sync/relay/status-read`,
      { peerDeviceId: a.deviceId },
    );
    const confirmation = read.snapshots.find(
      (snapshot) =>
        canonicalDeviceJSON(snapshot.source) ===
        canonicalDeviceJSON(source.source),
    );
    assert(confirmation);
    assert.equal(confirmation.registryOrigin, worker.origin);
    assert.equal(confirmation.sharedBotId, sharedBotId);
    assert.equal((confirmation.holder as RecordJSON).deviceId, b.deviceId);
    assert.equal((confirmation.receiver as RecordJSON).deviceId, a.deviceId);
    assert.deepEqual(confirmation.binding, {
      localBotId: actual.localBotId,
      sharedBotId,
      replicaId: actual.replicaId,
      epoch: actual.epoch,
    });
    assert.equal(confirmation.received, source.received);
    assert.equal(confirmation.applied, source.applied);
    assert.equal(typeof confirmation.recordedAt, "number");
    assert.equal(read.hasMore, false);
    const metadataStorage = await worker.mf.unsafeGetDurableObjectStorage(
      "bots-sync",
      "SyncCache",
      { name: sharedBotId },
    );
    const eventsBeforeStatus = await metadataStorage.exec(
      "SELECT * FROM events ORDER BY replicaId,epoch,seq",
    );
    const ioBeforeStatus = await metadataStorage.exec(
      "SELECT * FROM test_cache_io",
    );
    const statusRows = await metadataStorage.exec(
      "SELECT * FROM replica_status ORDER BY key",
    );
    await ad.post(`/v1/bots/${ab}/sync/relay/status-report`, {
      peerDeviceId: b.deviceId,
    });
    assert.deepEqual(
      await metadataStorage.exec("SELECT * FROM replica_status ORDER BY key"),
      statusRows,
      "an unchanged durable report is idempotent including its original server recording time",
    );
    const selector = { peerDeviceId: b.deviceId };
    for (const extra of [
      { received: 999999 },
      { binding: confirmation.binding },
      { source: source.source },
    ])
      await assert.rejects(
        ad.post(`/v1/bots/${ab}/sync/relay/status-report`, {
          ...selector,
          ...extra,
        }),
        /403/,
      );
    const binding = confirmation.binding as RecordJSON;
    const body = {
      version: 1,
      operation: "status-report",
      sharedBotId,
      ...selector,
      binding,
      streams: streams.map(({ source, received, applied }) => ({
        source,
        received,
        applied,
      })),
    };
    const mint = async (input: RecordJSON, digestBody: unknown = input) =>
      localCall(a.socketPath, "sync.relay.authority", {
        version: 1,
        operation: input.operation,
        sharedBotId: input.sharedBotId,
        peerDeviceId: input.peerDeviceId,
        requestDigest: createHash("sha256")
          .update(canonicalDeviceJSON(digestBody))
          .digest("hex"),
      }) as Promise<{ authority: string }>;
    const raw = async (input: RecordJSON, ticket: { authority: string }) =>
      fetch(currentWorker.origin + `/v1/relay/${input.operation}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ticket.authority}`,
          "x-bots-sync-trace": `tr_status_${randomUUID().replaceAll("-", "")}`,
          "x-bots-sync-bot": ab,
        },
        body: JSON.stringify(input),
      });
    for (const wrong of [
      {
        ...body,
        sharedBotId: randomUUID(),
        binding: { ...binding, sharedBotId: randomUUID() },
      },
      { ...body, peerDeviceId: randomUUID() },
      {
        version: 1,
        operation: "status-read",
        sharedBotId,
        peerDeviceId: b.deviceId,
      },
    ]) {
      if (
        wrong.operation === "status-report" &&
        wrong.sharedBotId !== sharedBotId
      )
        (wrong as typeof body).binding.sharedBotId = wrong.sharedBotId;
      const denied = await raw(wrong, await mint(body, wrong));
      assert.equal(
        denied.status,
        403,
        "a caller-selected exact digest does not replace namespace, peer and operation binding",
      );
    }
    const namespace = (await worker.mf.getDurableObjectNamespace(
      "SYNC",
      "bots-sync",
    )) as unknown as {
      idFromName(name: string): string;
      get(id: string): { relaySqlCausePreserved(): Promise<boolean> };
    };
    for (const [target, botId, operation, peerDeviceId] of [
      [ad, ab, "status-report", b.deviceId],
      [bd, bb, "status-read", a.deviceId],
    ] as const) {
      await metadataStorage.exec(
        "ALTER TABLE replica_status RENAME TO owned_failed_replica_status",
      );
      try {
        const failed = await fetch(
          target.origin + `/v1/bots/${botId}/sync/relay/${operation}`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${target.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ peerDeviceId }),
          },
        );
        const value = (await failed.json()) as {
          error: { kind: string; failure: string };
          trace: string;
        };
        assert.equal(failed.status, 503);
        assert.equal(value.error.kind, "storage_failed");
        assert.equal(
          await namespace
            .get(namespace.idFromName(sharedBotId))
            .relaySqlCausePreserved(),
          true,
        );
        await until(
          async () =>
            currentWorker.logs.some((row) =>
              row.message.includes(value.error.failure),
            )
              ? true
              : undefined,
          "status SQL one Worker origin",
        );
        const origins: { level: string; message: string }[] =
          worker.logs.filter((row) =>
            row.message.includes(value.error.failure),
          );
        assert.equal(origins.length, 1);
        assert.equal(origins[0]?.level, "error");
        assert(origins[0]?.message.includes(value.trace));
        assert(origins[0]?.message.includes(botId));
        const logs = readdirSync(
          join(root, botId === ab ? "a-bots/logs" : "b-bots/logs"),
        ).flatMap((f) =>
          readFileSync(
            join(root, botId === ab ? "a-bots/logs" : "b-bots/logs", f),
            "utf8",
          )
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l)),
        );
        assert(
          logs.some(
            (l) =>
              l.err?.failure === value.error.failure &&
              l.level === "warn" &&
              l.trace === value.trace &&
              l.botId === botId,
          ),
        );
        assert.equal(
          logs.filter(
            (l) =>
              l.err?.failure === value.error.failure && l.level === "error",
          ).length,
          0,
        );
        assert(!JSON.stringify({ value, origins }).includes("no such table"));
        console.log(
          JSON.stringify({
            kind: "real-status-sql",
            operation,
            status: 503,
            originalCause: true,
            workerOrigins: 1,
            botsErrors: 0,
          }),
        );
      } finally {
        await metadataStorage.exec(
          "ALTER TABLE owned_failed_replica_status RENAME TO replica_status",
        );
      }
      assert.deepEqual(
        await metadataStorage.exec("SELECT * FROM replica_status ORDER BY key"),
        statusRows,
      );
    }
    const registrySql = await worker.mf.unsafeGetDurableObjectStorage(
      "eagle",
      "DeviceRegistry",
      { name: "registry" },
    );
    const rpcTicket = await mint(body);
    await registrySql.exec(
      "ALTER TABLE sync_relay_authorities RENAME TO owned_failed_status_authorities",
    );
    try {
      const denied = await raw(body, rpcTicket);
      assert.equal(denied.status, 503);
      const failure = (await denied.json()) as {
        error: { failure: { id: string; kind: string } };
        trace: string;
      };
      assert.equal(failure.error.failure.kind, "internal");
      await until(
        async () =>
          currentWorker.logs.some((row) =>
            row.message.includes(failure.error.failure.id),
          )
            ? true
            : undefined,
        "status Registry SQL failure origin",
      );
      assert.equal(
        worker.logs.filter((row) =>
          row.message.includes(failure.error.failure.id),
        ).length,
        1,
      );
      const ns = (await worker.mf.getDurableObjectNamespace(
        "DEVICE_REGISTRY",
        "eagle",
      )) as unknown as {
        idFromName(name: string): string;
        get(id: string): { relaySqlFailure(input: unknown): Promise<string> };
      };
      assert.deepEqual(
        JSON.parse(
          await ns.get(ns.idFromName("registry")).relaySqlFailure({
            authority: rpcTicket.authority,
            operation: body.operation,
            sharedBotId,
            requestDigest: createHash("sha256")
              .update(canonicalDeviceJSON(body))
              .digest("hex"),
          }),
        ),
        { message: "sync_relay_registry_unavailable", originalSqlCause: true },
      );
      assert(!JSON.stringify(failure).includes("no such table"));
    } finally {
      await registrySql.exec(
        "ALTER TABLE owned_failed_status_authorities RENAME TO sync_relay_authorities",
      );
    }
    await registrySql.exec(
      "CREATE TABLE test_status_registry_gate(operation TEXT,seen INTEGER,started INTEGER,released INTEGER)",
    );
    await registrySql.exec(
      "INSERT INTO test_status_registry_gate VALUES('status-report',0,0,0)",
    );
    const finalTicket = await mint(body);
    const finalPending = raw(body, finalTicket);
    try {
      await until(
        async () =>
          (
            await registrySql.exec(
              "SELECT started FROM test_status_registry_gate",
            )
          )[0]?.started
            ? true
            : undefined,
        "actual final status Registry await",
      );
      await b.manage("sync.share", {
        sharedBotId,
        peerDeviceId: a.deviceId,
        enabled: false,
      });
      await registrySql.exec("UPDATE test_status_registry_gate SET released=1");
      assert.equal((await finalPending).status, 403);
      assert.deepEqual(
        await metadataStorage.exec("SELECT * FROM replica_status ORDER BY key"),
        statusRows,
      );
    } finally {
      await registrySql.exec("UPDATE test_status_registry_gate SET released=1");
      await registrySql.exec("DROP TABLE test_status_registry_gate");
      await b.manage("sync.share", {
        sharedBotId,
        peerDeviceId: a.deviceId,
        enabled: true,
      });
    }
    const staleTicket = await mint(body);
    await b.manage("sync.share", {
      sharedBotId,
      peerDeviceId: a.deviceId,
      enabled: false,
    });
    assert.equal(
      (await raw(body, staleTicket)).status,
      403,
      "revoked current directional grant refuses an already minted status ticket",
    );
    await b.manage("sync.share", {
      sharedBotId,
      peerDeviceId: a.deviceId,
      enabled: true,
    });
    // These are trusted-device metadata/key-isolation probes, not native apply evidence.
    const newEpoch = { ...body, binding: { ...binding, epoch: randomUUID() } };
    assert.equal((await raw(newEpoch, await mint(newEpoch))).status, 200);
    const previousKeyLate = {
      ...body,
      streams: body.streams.map((s) => ({
        ...s,
        received: Math.max(0, s.received - 1),
        applied: Math.max(0, s.applied - 1),
      })),
    };
    assert.equal(
      (await raw(previousKeyLate, await mint(previousKeyLate))).status,
      200,
    );
    const separated = await bd.post<{ snapshots: RecordJSON[] }>(
      `/v1/bots/${bb}/sync/relay/status-read`,
      { peerDeviceId: a.deviceId },
    );
    assert(
      separated.snapshots.some(
        (s) => (s.binding as RecordJSON).epoch === newEpoch.binding.epoch,
      ),
    );
    assert.deepEqual(
      separated.snapshots.find(
        (s) =>
          canonicalDeviceJSON(s.source) ===
            canonicalDeviceJSON(confirmation.source) &&
          canonicalDeviceJSON(s.binding) ===
            canonicalDeviceJSON(confirmation.binding),
      ),
      confirmation,
    );
    await metadataStorage.exec(
      "DELETE FROM replica_status WHERE key NOT IN (" +
        statusRows.map(() => "?").join(",") +
        ")",
      ...statusRows.map((r) => r.key),
    );
    await ad.control("dropStatusReply");
    const lostResponse = await fetch(
      ad.origin + `/v1/bots/${ab}/sync/relay/status-report`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${ad.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(selector),
      },
    );
    const lostBody = (await lostResponse.json()) as { trace: string };
    const lostCause = await ad.message(
      (m) =>
        m.type === "ownedStatusReportFailure" && m.trace === lostBody.trace,
    );
    console.log(
      JSON.stringify({
        kind: "owned-status-lost-reply",
        status: lostResponse.status,
        causeName: lostCause.causeName,
        causeCode: lostCause.causeCode,
      }),
    );
    assert.equal(lostResponse.status, 503);

    assert.equal(lostCause.causeCode, "sync_network_unreachable");
    const lostStats = await ad.control("statusReplyStats");
    assert.equal(lostStats.lostStatusReplies, 1);
    assert.equal(lostStats.lastStatusReply, 200);
    const callsBeforeRestart = await ad.control("syncObjectCalls");
    await ad.stop();
    bots.splice(bots.indexOf(ad), 1);
    const restarted = await daemon(
      join(root, "a-bots"),
      a.socketPath,
      model.baseUrl,
      key,
      { cacheOrigin: worker.origin, holdAuto: true },
    );
    bots.push(restarted);
    const opened = await botConnection(restarted.origin, restarted.token, ab);
    try {
      await restarted.post(`/v1/bots/${ab}/sync/relay/status-report`, selector);
      assert.deepEqual(
        (
          await bd.post<{ snapshots: RecordJSON[]; hasMore: boolean }>(
            `/v1/bots/${bb}/sync/relay/status-read`,
            { peerDeviceId: a.deviceId },
          )
        ).snapshots,
        read.snapshots,
      );
      assert.equal(
        Number((await restarted.control("syncObjectCalls")).applyCalls),
        0,
      );
      assert.equal(Number(callsBeforeRestart.applyCalls), 1);
      assert.deepEqual(
        await metadataStorage.exec("SELECT * FROM test_cache_io"),
        ioBeforeStatus,
        "status recovery does not reread any R2 or relay body",
      );
      assert.deepEqual(
        await metadataStorage.exec(
          "SELECT * FROM events ORDER BY replicaId,epoch,seq",
        ),
        eventsBeforeStatus,
        "status does not refresh event retention clocks",
      );
    } finally {
      await new Promise<void>((done) => {
        opened.socket.once("close", () => done());
        opened.socket.close();
      });
    }
    console.log(
      JSON.stringify({
        kind: "allpath-persistent-status",
        cacheApply: true,
        independentRead: true,
        completeBinding: true,
        monotonicKeys: true,
        lostReplyRestart: true,
        additionalGetApply: 0,
        passiveExecutionDelta: 0,
      }),
    );
    const after = counts(join(root, "a-bots/bots", ab));
    for (const [name, value] of Object.entries(before))
      if (/submission|task|local_run/.test(name))
        assert.equal(after[name], value, name);
    assert.equal(model.verify(), 0);
  } finally {
    for (const bot of bots.reverse()) await bot.stop();
    for (const service of services.reverse()) await service.stop();
    await worker?.mf.dispose();
    await new Promise<void>((done) => model.server.close(() => done()));
    rmSync(workerRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
