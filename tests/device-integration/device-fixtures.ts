import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import {
  SyncProofRequest,
  syncProofPayload,
} from "../../packages/contracts/src/device-sync.ts";

type JSONRecord = Record<string, unknown>;

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

export async function until<T>(
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

export function processPort(
  file: string,
  root: string,
  extra: Readonly<Record<string, string | undefined>> = {},
) {
  const child = spawn(process.execPath, [file], {
    cwd: resolve("."),
    env: { ...childEnv(root), ...extra },
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

export function deviceProcess(
  root: string,
  baseUrl: string,
  cliDirectory?: string,
) {
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
    cliDirectory === undefined
      ? {}
      : { PATH: cliDirectory + ":/usr/bin:/bin:/usr/sbin:/sbin" },
  );
  let pauseProof = false;
  let proofRequests = 0;
  const heldProofs: (() => void)[] = [];
  process.handle((message) => {
    if (message.type === "sync_proof") {
      proofRequests++;
      const request = SyncProofRequest.parse(message.request);
      assert.equal(request.registryOrigin, baseUrl);
      assert.equal(request[request.role].deviceId, deviceId);
      assert.equal(request[request.role].publicKey, publicKey);
      const respond = () =>
        process.send({
          type: "sync_signature",
          requestId: message.requestId,
          signature: sign(
            null,
            Buffer.from(syncProofPayload(request)),
            keys.privateKey,
          ).toString("base64url"),
        });
      if (pauseProof) heldProofs.push(respond);
      else respond();
      return;
    }
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
    publicKey,
    socketPath,
    proofRequests() {
      return proofRequests;
    },
    heldProofs() {
      return heldProofs.length;
    },
    holdProof() {
      pauseProof = true;
    },
    releaseProof() {
      pauseProof = false;
      for (const respond of heldProofs.splice(0)) respond();
    },
    async ready({ approveTools = true } = {}) {
      await process.message((message) => message.type === "ready");
      await process.message(
        (message) => message.type === "cloud" && message.status === "online",
      );
      // Tool fixtures supply approval; fresh-policy cases make their own explicit decision.
      if (approveTools)
        await this.manage("policy.set", { mode: "all-approve" });
    },
    async manage(method: string, params?: unknown) {
      const requestId = randomUUID();
      process.send({ type: "manage", requestId, method, params });
      const reply = await process.message(
        (message) =>
          message.type === "managed" && message.requestId === requestId,
      );
      assert.equal(reply.error, undefined, "trusted management request failed");
      return reply.result as JSONRecord;
    },
  };
}

export async function localCall(
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
        if (reply.error) reject(new Error(String(reply.error)));
        else done(reply.result);
      });
      socket.write(
        `${JSON.stringify({ requestId: randomUUID(), method, params })}\n`,
      );
    });
  } finally {
    reader.close();
    socket.destroy();
  }
}

export async function workerFixture(directory: string, cache = false) {
  const logs: { level: string; message: string }[] = [];
  // Only a test transport fault: the real target finishes and the real relay
  // authorizes its result, then the caller loses that one response. No executor,
  // registry, SDK or device-port implementation is replaced.
  writeFileSync(
    join(directory, "entry.ts"),
    `
import worker,{DeviceRegistry as Registry,DeviceExecution as Execution} from "../../apps/web/src/worker/device-service.ts";
export {SyncCacheRegistry} from "../../apps/web/src/worker/device-service.ts";
let registryContext;
const verify=crypto.subtle.verify.bind(crypto.subtle);
crypto.subtle.verify=async(...args)=>{
 const result=await verify(...args);
 if(result&&new TextDecoder().decode(args[3]).startsWith('eagle-bots-wrap-descriptor-v1\\n')&&registryContext?.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='test_descriptor_gate'").toArray().length){
  const gate=()=>registryContext.storage.sql.exec('SELECT * FROM test_descriptor_gate').toArray()[0];
  if(!gate().started){registryContext.storage.sql.exec('UPDATE test_descriptor_gate SET started=1');const end=Date.now()+12000;while(!gate().released){if(Date.now()>end)throw new Error('owned descriptor verify gate timeout');await new Promise(r=>setTimeout(r,10));}}
 }
 return result;
};
export class DeviceRegistry extends Registry {
 constructor(ctx,env){super(ctx,env);registryContext=ctx;}
 one(...args) {
  try {return super.one(...args);} catch(error) {this.lastSqlCause=error;throw error;}
 }
 cacheSqlCausePreserved(){return this.sqlCausePreserved===true&&this.safeCacheError===true;}
 async relaySqlFailure(value) {
  try {await super.checkRelayAuthority(value);return null;}
  catch(error) {return JSON.stringify({message:error.message,originalSqlCause:error.cause instanceof Error&&/no such table/.test(error.cause.message)});}
 }
 async checkRelayAuthority(value) {
  if(value.operation==='register'&&this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='test_relay_registry_gate'").toArray().length) {
   const gate=()=>this.ctx.storage.sql.exec('SELECT * FROM test_relay_registry_gate').toArray()[0];
   if(!gate().released){this.ctx.storage.sql.exec('UPDATE test_relay_registry_gate SET started=1');const end=Date.now()+5000;while(!gate().released){if(Date.now()>end)throw new Error('owned relay renewal gate timeout');await new Promise(r=>setTimeout(r,10));}}
  }
  if(value.operation.startsWith('status-')&&this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='test_status_registry_gate'").toArray().length) {
   const gate=()=>this.ctx.storage.sql.exec('SELECT * FROM test_status_registry_gate').toArray()[0];
   if(gate().operation===value.operation){this.ctx.storage.sql.exec('UPDATE test_status_registry_gate SET seen=seen+1');if(gate().seen===2){this.ctx.storage.sql.exec('UPDATE test_status_registry_gate SET started=1');const end=Date.now()+5000;while(!gate().released){if(Date.now()>end)throw new Error('owned status final authorization gate timeout');await new Promise(r=>setTimeout(r,10));}}}
  }
  return super.checkRelayAuthority(value);
 }
 async checkCacheAuthority(value) {
  if(this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='test_cache_sql_gate'").toArray().length) {
   this.ctx.storage.sql.exec('UPDATE test_cache_sql_gate SET started=1');
   const deadline=Date.now()+5000;
   while(!this.ctx.storage.sql.exec('SELECT released FROM test_cache_sql_gate').toArray()[0].released) {
    if(Date.now()>deadline)throw new Error('test cache SQL gate timeout');
    await new Promise(resolve=>setTimeout(resolve,10));
   }
  }
  try {return await super.checkCacheAuthority(value);} catch(error) {this.sqlCausePreserved=!!this.lastSqlCause&&error.cause===this.lastSqlCause;this.safeCacheError=error.message==='sync_cache_registry_unavailable';throw error;}
 }
 async fetch(request) {
  if(request.url.endsWith('/sync/endpoints')&&this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='test_endpoint_gate'").toArray().length&&(await request.clone().json()).candidates.length) {
   this.ctx.storage.sql.exec("UPDATE test_endpoint_gate SET started=1");
   const deadline=Date.now()+5000;
   while(!this.ctx.storage.sql.exec("SELECT released FROM test_endpoint_gate").toArray()[0].released) {
    if(Date.now()>deadline)throw new Error('test endpoint write gate timeout');
    await new Promise(resolve=>setTimeout(resolve,10));
   }
  }
  const response=await super.fetch(request);
  if(response.ok&&this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='test_sync_expiry_gate'").toArray().length) {
   const gate=this.ctx.storage.sql.exec("SELECT * FROM test_sync_expiry_gate").toArray()[0];
   if(request.url.endsWith(gate.route)) {
    this.ctx.storage.sql.exec("UPDATE test_sync_expiry_gate SET seen=seen+1");
    if(gate.seen+1===gate.target) {
     this.ctx.storage.sql.exec("UPDATE test_sync_expiry_gate SET started=1");
     const deadline=Date.now()+5000;
     while(!this.ctx.storage.sql.exec("SELECT released FROM test_sync_expiry_gate").toArray()[0].released) {
      if(Date.now()>deadline)throw new Error('test expiry reply gate timeout');
      await new Promise(resolve=>setTimeout(resolve,10));
     }
    }
   }
  }
  if(request.url.endsWith('/sync/access')&&response.ok&&this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='test_sync_reply'").toArray().length) {
   this.ctx.storage.sql.exec("UPDATE test_sync_reply SET started=1");
   const deadline=Date.now()+5000;
   while(!this.ctx.storage.sql.exec("SELECT released FROM test_sync_reply").toArray()[0].released) {
    if(Date.now()>deadline)throw new Error('test sync reply gate timeout');
    await new Promise(resolve=>setTimeout(resolve,10));
   }
  }
  return response;
 }
}
export class DeviceExecution extends Execution {
 respond(socket,request,result,unauthorized=false) {
  if(request.action==='run'&&request.operation?.command?.includes('device-integration-drop-response')&&result.status==='completed') {
   socket.close(1011,'test_response_lost');return;
  }
  return super.respond(socket,request,result,unauthorized);
 }
}
export default {fetch(request,env,ctx){
 if(${cache}&&(new URL(request.url).pathname.startsWith('/v1/cache/')||new URL(request.url).pathname.startsWith('/v1/relay/')))return env.CACHE.fetch(request);
 return worker.fetch(request,env,ctx);
}};
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
  if (cache)
    writeFileSync(
      join(directory, "sync-entry.ts"),
      `
import worker,{SyncCache as Production} from '../../apps/bots-sync/src/index.ts';
import {CacheError} from '../../apps/bots-sync/src/errors.ts';
// Observe exact cause identity locally without changing instanceof semantics.
const transactionErrors=new WeakMap();
Object.defineProperty(CacheError,Symbol.hasInstance,{value(error){
 const evidence=error&&transactionErrors.get(error.cause);
 if(evidence)evidence.sameCause=true;
 return Function.prototype[Symbol.hasInstance].call(this,error);
}});
export class SyncCache extends Production {
 constructor(ctx,env){
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_cache_io(operation TEXT,after INTEGER)');
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_relay_network(blocked INTEGER)');
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_relay_ack_reply(remaining INTEGER,lost INTEGER)');
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_status_fault(operation TEXT,mode TEXT,remaining INTEGER,hits INTEGER)');
  const bucket=env.CIPHERS;
  const evidence={callbackReturned:false,transactionReturned:false,injectedBoundary:false,sameCause:false};
  super(ctx,{...env,CIPHERS:new Proxy(bucket,{get(target,key){
   if(key==='get')return(...args)=>{ctx.storage.sql.exec("INSERT INTO test_cache_io VALUES('r2',NULL)");return target.get(...args);};
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }})});
  this.statusTransactionEvidence=evidence;
  const relayRows=this.relay.rows.bind(this.relay);
  this.relay.rows=(...args)=>{try{return relayRows(...args);}catch(error){this.relaySqlCause=error.cause instanceof Error&&/no such table/.test(error.cause.message);throw error;}};
 }
 relaySqlCausePreserved(){return this.relaySqlCause===true;}
 // Native deferred FK fails at the output gate; inject only after the actual transaction returns.
 armStatusTransaction(){
  const storage=this.ctx.storage;
  const transaction=storage.transactionSync;
  const cause=new Error('owned status transaction boundary failure');
  this.restoreTransaction=()=>{storage.transactionSync=transaction;};
  storage.transactionSync=callback=>{
   transaction.call(storage,()=>{const result=callback();this.statusTransactionEvidence.callbackReturned=true;return result;});
   this.statusTransactionEvidence.transactionReturned=true;
   this.statusTransactionEvidence.injectedBoundary=true;
   transactionErrors.set(cause,this.statusTransactionEvidence);
   throw cause;
  };
 }
 statusTransactionResult(){return this.statusTransactionEvidence;}
 restoreStatusTransaction(){this.restoreTransaction();}
 async fetch(request){
  if(new URL(request.url).pathname==='/v1/relay/connect'&&this.ctx.storage.sql.exec('SELECT blocked FROM test_relay_network').toArray()[0]?.blocked)return Response.json({error:'owned_relay_network_unavailable'},{status:503});
  const operation=new URL(request.url).pathname.split('/').pop();
  if(operation==='connect')this.ctx.storage.sql.exec("INSERT INTO test_cache_io VALUES('relay-connect',NULL)");
  if(operation==='exchange'){const value=await request.clone().json();this.ctx.storage.sql.exec('INSERT INTO test_cache_io VALUES(?,NULL)','relay-'+value.method);}
  if(operation==='list'||operation==='get'){
   const value=await request.clone().json();this.ctx.storage.sql.exec('INSERT INTO test_cache_io VALUES(?,?)',operation,value.after??null);
  }
  const fault=this.ctx.storage.sql.exec('SELECT mode,remaining FROM test_status_fault WHERE operation=?',operation).toArray()[0];
  const lose=()=>{this.ctx.storage.sql.exec('UPDATE test_status_fault SET hits=hits+1,remaining=remaining-1 WHERE operation=?',operation);return new Response('{"version":',{status:200,headers:{'content-type':'application/json'}});};
  if(fault?.mode==='malformed'&&fault.remaining>0)return lose();
  const response=await super.fetch(request);
  if(operation==='ack'&&response.ok&&this.ctx.storage.sql.exec('SELECT remaining FROM test_relay_ack_reply').toArray()[0]?.remaining>0){
   this.ctx.storage.sql.exec('UPDATE test_relay_ack_reply SET remaining=remaining-1,lost=lost+1');
   return new Response(new ReadableStream({start(controller){controller.error(new Error('owned relay ACK reply lost after commit'));}}),{status:200});
  }
  return response;
 }
}
export default worker;
`,
    );
  if (cache)
    execFileSync(
      resolve("node_modules/.bin/wrangler"),
      [
        "deploy",
        join(directory, "sync-entry.ts"),
        "--dry-run",
        "--config",
        "apps/bots-sync/wrangler.jsonc",
        "--outdir",
        join(directory, "sync-worker"),
      ],
      { stdio: "pipe" },
    );
  const options = (registryOrigin: string, port?: number) => ({
    ...convertV4MiniflareOptions({
      port,
      handleStructuredLogs: (entry) => logs.push(entry),
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
          ...(cache ? { serviceBindings: { CACHE: "bots-sync" } } : {}),
        },
        ...(cache
          ? [
              {
                name: "bots-sync",
                modules: true,
                scriptPath: join(directory, "sync-worker/sync-entry.js"),
                compatibilityDate: "2026-09-19",
                compatibilityFlags: ["nodejs_compat"],
                durableObjects: {
                  SYNC: { className: "SyncCache", useSQLite: true },
                },
                r2Buckets: { CIPHERS: "owned-sync-ciphers" },
                bindings: { REGISTRY_ORIGIN: registryOrigin },
                serviceBindings: {
                  REGISTRY: { name: "eagle", entrypoint: "SyncCacheRegistry" },
                },
              },
            ]
          : []),
      ],
    }),
    unsafeInspectDurableObjects: true,
  });
  const mf = new Miniflare(options("https://not-yet-configured.invalid"));
  try {
    const ready = await mf.ready;
    if (cache) await mf.setOptions(options(ready.origin, Number(ready.port)));
    assert.equal((await mf.ready).origin, ready.origin);
    return { mf, origin: ready.origin, logs };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
