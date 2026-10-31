import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  createCipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { canonical, digest, metadataDigest, requestDigest } from "../src/crypto.ts";
import {
  type AuthorizationValue,
  type CarrierValue,
  type RequestValue,
  SyncIdentity,
} from "../src/wire.ts";

export const origin = "https://registry.fixture";
export const ttl = 72 * 60 * 60 * 1000;
export function identity(groupId: string) {
  const ed = generateKeyPairSync("ed25519"),
    wrap = generateKeyPairSync("x25519");
  const peer = SyncIdentity.parse({
    deviceId: randomUUID(),
    publicKey: ed.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    groupId,
    membershipEpoch: 1,
    credentialVersion: 1,
  });
  const raw = wrap.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const body = {
    version: 1 as const,
    purpose: "replica.wrap" as const,
    registryOrigin: origin,
    deviceId: peer.deviceId,
    publicKey: peer.publicKey,
    credentialVersion: 1,
    keyId: digest(raw),
    wrappingPublicKey: raw.toString("base64url"),
  };
  const descriptor = {
    ...body,
    signature: sign(
      null,
      Buffer.from("eagle-bots-wrap-descriptor-v1\n" + canonical(body)),
      ed.privateKey,
    ).toString("base64url"),
  };
  return { peer, ed, wrap, descriptor };
}
export function pageFixture(
  options: {
    sharedBotId?: string;
    source?: { replicaId: string; epoch: string };
    seq?: number;
    eventDigest?: string;
    eventValue?: string;
    hasMore?: boolean;
    empty?: boolean;
    count?: number;
    publisher?: ReturnType<typeof identity>;
    recipient?: ReturnType<typeof identity>;
  } = {},
) {
  const group = randomUUID(),
    publisher = options.publisher ?? identity(group),
    recipient = options.recipient ?? identity(publisher.peer.groupId as string);
  const sharedBotId = options.sharedBotId ?? randomUUID(),
    source = options.source ?? { replicaId: randomUUID(), epoch: randomUUID() };
  const seq = options.seq ?? 1,
    events = options.empty
      ? []
      : Array.from({ length: options.count ?? 1 }, (_, i) => ({
          seq: seq + i,
          data: { fixture: "ciphertext-only Worker", value: options.eventValue ?? randomUUID() },
        }));
  const page = Buffer.from(
      JSON.stringify({ sharedBotId, source, events, hasMore: options.hasMore ?? false }),
    ),
    key = randomBytes(32),
    nonce = randomBytes(12);
  const header = {
    version: 1 as const,
    purpose: "replica.page" as const,
    registryOrigin: origin,
    publisher: publisher.peer,
    sharedBotId,
    keyEpoch: 1 as const,
    keyId: digest(key),
    objectId: metadataDigest({
      version: 1,
      purpose: "replica.page",
      publisherDeviceId: publisher.peer.deviceId,
      sharedBotId,
      keyEpoch: 1,
      source,
      pageDigest: digest(page),
    }),
    source,
    range: { from: seq, to: seq + events.length - 1 },
    included: events.map((event) => ({
      seq: event.seq,
      eventDigest: options.eventDigest ?? digest(JSON.stringify(event)),
    })),
    nextAfter: seq + events.length - 1,
    hasMore: options.hasMore ?? false,
    pageDigest: digest(page),
    nonce: nonce.toString("base64url"),
  };
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from("eagle-bots-page-object-v1\n" + canonical(header)));
  const bytes = Buffer.concat([cipher.update(page), cipher.final(), cipher.getAuthTag()]);
  const body = { ...header, cipherDigest: digest(bytes) },
    manifest = {
      ...body,
      signature: sign(
        null,
        Buffer.from("eagle-bots-page-manifest-v1\n" + canonical(body)),
        publisher.ed.privateKey,
      ).toString("base64url"),
    };
  const ephemeral = generateKeyPairSync("x25519"),
    wrapNonce = randomBytes(12);
  const eh = {
    version: 1 as const,
    purpose: "replica.key" as const,
    registryOrigin: origin,
    publisher: publisher.peer,
    issuer: publisher.peer,
    recipient: recipient.peer,
    issuerDescriptor: publisher.descriptor,
    recipientDescriptor: recipient.descriptor,
    sharedBotId,
    keyEpoch: 1 as const,
    keyId: header.keyId,
    objectId: header.objectId,
    manifestDigest: metadataDigest(manifest),
    ephemeral: ephemeral.publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("base64url"),
    nonce: wrapNonce.toString("base64url"),
  };
  const aad = Buffer.from("eagle-bots-key-envelope-v1\n" + canonical(eh));
  const wrapKey = hkdfSync(
    "sha256",
    diffieHellman({
      privateKey: ephemeral.privateKey,
      publicKey: createPublicKey(recipient.wrap.privateKey),
    }),
    Buffer.from(digest("eagle-bots-key-envelope-v1"), "hex"),
    Buffer.from(digest(aad), "hex"),
    32,
  );
  const box = createCipheriv("aes-256-gcm", Buffer.from(wrapKey), wrapNonce);
  box.setAAD(aad);
  const eb = {
    ...eh,
    ciphertext: Buffer.concat([box.update(key), box.final()]).toString("base64url"),
    tag: box.getAuthTag().toString("base64url"),
  };
  const envelope = {
    ...eb,
    signature: sign(
      null,
      Buffer.from("eagle-bots-key-envelope-signature-v1\n" + canonical(eb)),
      publisher.ed.privateKey,
    ).toString("base64url"),
  };
  const carrier: CarrierValue = {
    version: 1,
    manifest,
    descriptor: publisher.descriptor,
    envelope,
    ciphertext: bytes.toString("base64url"),
  };
  key.fill(0);
  return {
    carrier,
    publisher,
    recipient,
    source,
    sharedBotId,
    publish: {
      version: 1 as const,
      operation: "publish" as const,
      sharedBotId,
      peerDeviceId: recipient.peer.deviceId,
      carrier,
    },
  };
}
export async function until<T>(probe: () => Promise<T | undefined>) {
  const end = Date.now() + 12000;
  do {
    const value = await probe();
    if (value !== undefined) return value;
    await delay(25);
  } while (Date.now() < end);
  throw new Error("owned cache barrier timeout");
}
export async function runtime() {
  mkdirSync(".local", { recursive: true });
  const root = mkdtempSync(resolve(".local/cache-test-"));
  const logs: { level: string; message: string }[] = [];
  writeFileSync(
    join(root, "entry.ts"),
    `
import worker,{SyncCache as Production} from '../../src/index.ts';
const realNow=Date.now;let clock,uploadAt;Date.now=()=>clock??realNow();
export class SyncCache extends Production {
 constructor(ctx,env){
  ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS test_control(mode TEXT,started INTEGER,released INTEGER)");
  ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS test_boots(count INTEGER)");
  ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS test_io(gets INTEGER)");
  if(!ctx.storage.sql.exec('SELECT * FROM test_io').toArray().length)ctx.storage.sql.exec('INSERT INTO test_io VALUES(0)');
  if(!ctx.storage.sql.exec('SELECT * FROM test_boots').toArray().length)ctx.storage.sql.exec('INSERT INTO test_boots VALUES(0)');
  ctx.storage.sql.exec('UPDATE test_boots SET count=count+1');
  if(!ctx.storage.sql.exec('SELECT * FROM test_control').toArray().length)ctx.storage.sql.exec("INSERT INTO test_control VALUES('',0,0)");
  const exec=ctx.storage.sql.exec.bind(ctx.storage.sql);
  let actualSqlCause;
  const control=()=>exec('SELECT * FROM test_control').toArray()[0];
  ctx.storage.sql.exec=(query,...args)=>{if(control().mode==='reference-throw'&&query.startsWith("UPDATE objects SET state='ready'"))throw new Error('owned metadata reference commit I/O');try{return exec(query,...args);}catch(error){actualSqlCause=error;throw error;}};
  const gate=async(mode)=>{if(control().mode!==mode || control().started)return;ctx.storage.sql.exec('UPDATE test_control SET started=1');const end=realNow()+12000;while(!control().released){if(realNow()>end)throw new Error('owned R2 barrier timeout');await new Promise(r=>setTimeout(r,10));}};
  const bucket=env.CIPHERS;
  ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS test_uploaded(key TEXT PRIMARY KEY,uploaded INTEGER)");
  const uploaded=(key,result)=>{const row=exec('SELECT uploaded FROM test_uploaded WHERE key=?',key).toArray()[0];return result&&row?new Proxy(result,{get(target,key){if(key==='uploaded')return new Date(row.uploaded);const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}}):result;};
  super(ctx,{...env,CIPHERS:{
   put:async(...args)=>{await gate('put-before');const result=await bucket.put(...args);if(result&&uploadAt!==undefined)exec('INSERT OR IGNORE INTO test_uploaded VALUES(?,?)',args[0],uploadAt);await gate('put-after');if(control().mode==='put-after-throw')throw new Error('owned put committed, reply lost');return uploaded(args[0],result);},
   get:async(...args)=>{ctx.storage.sql.exec('UPDATE test_io SET gets=gets+1');const result=uploaded(args[0],await bucket.get(...args));await gate('get-after');if(control().mode==='body-throw'&&result)return {...result,body:new ReadableStream({start(c){c.error(new Error('owned R2 body I/O'));}})};if(control().mode==='body-missing'&&result)return {...result,body:undefined};return result;},
   head:async(...args)=>control().mode==='negative-head'?null:uploaded(args[0],await bucket.head(...args)),
   delete:async(...args)=>{if(control().mode==='delete-throw')throw new Error('owned delete I/O');return bucket.delete(...args);},
  }});
  this.actualSqlCause=()=>actualSqlCause;
 }
 rows(...args){try{return super.rows(...args);}catch(error){this.sqlCausePreserved=error.cause===this.actualSqlCause();throw error;}}
 async fetch(request){
  if(new URL(request.url).pathname==='/__test/control'){const input=await request.json();if('now' in input)clock=input.now??undefined;if('uploadAt' in input)uploadAt=input.uploadAt??undefined;if('mode' in input)this.ctx.storage.sql.exec('UPDATE test_control SET mode=?,started=0,released=0',input.mode);if(input.release)this.ctx.storage.sql.exec('UPDATE test_control SET released=1');if(input.alarm)await super.alarm();return Response.json({...this.ctx.storage.sql.exec('SELECT * FROM test_control').toArray()[0],sqlCausePreserved:this.sqlCausePreserved??false});}
  return super.fetch(request);
 }
}
export default worker;
`,
  );
  writeFileSync(
    join(root, "registry.mjs"),
    `
import {WorkerEntrypoint} from 'cloudflare:workers';
const rows=new Map();let reject=false,holdAt=0,seen=0,started=false,released=false;
export class Registry extends WorkerEntrypoint {
 async checkCacheAuthority(input){seen++;if(seen===holdAt){started=true;const end=Date.now()+12000;while(!released){if(Date.now()>end)throw new Error("owned RPC barrier timeout");await new Promise(r=>setTimeout(r,10));}}if(reject)return {ok:false,status:403,error:'sync_not_shared'};const authorization=rows.get(input.authority);return authorization?{ok:true,authorization}:{ok:false,status:403,error:'invalid_sync_cache_authority'};}
 async fetch(request){const value=await request.json();if(value.claims)rows.set(value.token,value.claims);if('reject' in value)reject=value.reject;if(value.holdAt){holdAt=value.holdAt;seen=0;started=false;released=false;}if(value.release)released=true;return Response.json({ok:true,seen,started});}
}
export default Registry;
`,
  );
  execFileSync(
    resolve("node_modules/.bin/wrangler"),
    [
      "deploy",
      join(root, "entry.ts"),
      "--dry-run",
      "--config",
      "wrangler.jsonc",
      "--outdir",
      join(root, "bundle"),
    ],
    { stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
  const mf = new Miniflare({
    ...convertV4MiniflareOptions({
      handleStructuredLogs: (entry) => logs.push(entry),
      workers: [
        {
          name: "sync",
          modules: true,
          scriptPath: join(root, "bundle/entry.js"),
          compatibilityDate: "2026-09-19",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: { SYNC: { className: "SyncCache", useSQLite: true } },
          r2Buckets: { CIPHERS: "owned-ciphers" },
          bindings: { REGISTRY_ORIGIN: origin },
          serviceBindings: { REGISTRY: { name: "registry", entrypoint: "Registry" } },
        },
        {
          name: "registry",
          modules: true,
          scriptPath: join(root, "registry.mjs"),
          compatibilityDate: "2026-09-19",
        },
      ],
    }),
    unsafeInspectDurableObjects: true,
  });
  await mf.ready;
  const registry = (await mf.getWorker("registry")) as unknown as Fetcher;
  const registryControl = (value: unknown) =>
    registry.fetch("https://owned/control", { method: "POST", body: JSON.stringify(value) });
  const ns = (await mf.getDurableObjectNamespace(
    "SYNC",
    "sync",
  )) as unknown as DurableObjectNamespace;
  const control = async (sharedBotId: string, value: unknown) => {
    const response = await ns
      .get(ns.idFromName(sharedBotId))
      .fetch("https://owned/__test/control", { method: "POST", body: JSON.stringify(value) });
    return response.json() as Promise<{ started: number; sqlCausePreserved: boolean }>;
  };
  const authorize = async (
    input: RequestValue,
    fixture: ReturnType<typeof pageFixture>,
    now = Date.now(),
    changes: Partial<AuthorizationValue> = {},
  ) => {
    const token = randomBytes(32).toString("base64url");
    const claims: AuthorizationValue = {
      version: 1,
      purpose: "replica.cache",
      operation: input.operation,
      registryOrigin: origin,
      sharedBotId: input.sharedBotId,
      requestDigest: requestDigest(input),
      uploader: fixture.publisher.peer,
      recipient: fixture.recipient.peer,
      expiresAt: now + 60000,
      ...changes,
    };
    await registryControl({ token, claims });
    return token;
  };
  const call = (input: RequestValue, token: string) =>
    mf.dispatchFetch("https://sync/v1/cache/" + input.operation, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-bots-sync-trace": "tr_cache_fixture",
        "x-bots-sync-bot": "b_cache_fixture",
      },
      body: JSON.stringify(input),
    });
  const storage = (sharedBotId: string) =>
    mf.unsafeGetDurableObjectStorage("sync", "SyncCache", { name: sharedBotId });
  return {
    mf,
    control,
    authorize,
    call,
    storage,
    registryControl,
    logs,
    async evict(sharedBotId: string) {
      await mf.unsafeEvictDurableObject("sync", "SyncCache", { name: sharedBotId });
    },
    bucket: (await mf.getR2Bucket("CIPHERS", "sync")) as unknown as R2Bucket,
    async close() {
      await mf.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
export function getInput(f: ReturnType<typeof pageFixture>): RequestValue {
  return {
    version: 1,
    operation: "get",
    sharedBotId: f.sharedBotId,
    peerDeviceId: f.publisher.peer.deviceId,
    objectId: f.carrier.manifest.objectId,
  };
}
export async function cached(
  rt: Awaited<ReturnType<typeof runtime>>,
  f: ReturnType<typeof pageFixture>,
) {
  const response = await rt.call(f.publish, await rt.authorize(f.publish, f));
  assert.equal(response.status, 200, await response.clone().text());
  return response.json() as Promise<{
    firstCachedAt: number;
    expiresAt: number;
    cloudCached: boolean;
  }>;
}
