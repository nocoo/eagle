import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { after, before, beforeEach, test } from "node:test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import NativeWebSocket from "ws";
import type { OperationRequest } from "../packages/contracts/src/devices.ts";

type ApiBody = {
  challengeId: string;
  payload: string;
  sessionToken: string;
  code: string;
  groupId: string | null;
  revision: number;
  devices: { deviceId: string; online: boolean | null; policy: unknown }[];
  directory: { devices: { deviceId: string }[] };
};
let mf: Miniflare;
mkdirSync(".local", { recursive: true });
const root = mkdtempSync(resolve(".local/device-api-"));
const base = "https://devices.test/api/devices/v1";
before(async () => {
  const entry = join(root, "entry.ts");
  writeFileSync(
    entry,
    `import worker,{DeviceRegistry as Registry,DeviceExecution as Execution} from "../../apps/web/src/worker/device-service.ts";
export class DeviceExecution extends Execution {
 fetch(request){const url=new URL(request.url);if(url.pathname==='/test-close'){this.agent?.socket.close(Number(url.searchParams.get('code')),url.searchParams.get('reason'));return new Response('closed');}if(url.pathname==='/test-agent-state')return Response.json({hasToken:typeof this.agent?.token==='string',hasReference:typeof this.agent?.reference?.sessionHash==='string'});return super.fetch(request);}
 observation(){const observation=super.observation();
  if(this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='test_observation_delay'").toArray().length){this.ctx.storage.sql.exec("UPDATE test_observation_delay SET started=1");return new Promise(resolve=>setTimeout(()=>resolve(observation),500));}
  return observation;
 }
}
export class DeviceRegistry extends Registry {
 async operationGate(sourceId,targetId){
  if(!this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='test_operation_confirmation'").toArray().length)return false;
  const row=this.ctx.storage.sql.exec("SELECT sourceId FROM test_operation_confirmation WHERE sourceId=? AND targetId=?",sourceId,targetId??'').toArray()[0];
  if(!row)return false;
  this.ctx.storage.sql.exec("UPDATE test_operation_confirmation SET started=1 WHERE sourceId=?",sourceId);
  const deadline=Date.now()+5000;
  while(!this.ctx.storage.sql.exec("SELECT released FROM test_operation_confirmation WHERE sourceId=?",sourceId).toArray()[0]?.released){if(Date.now()>deadline)throw new Error('test operation gate timeout');await new Promise(resolve=>setTimeout(resolve,10));}
  return true;
 }
 async bindTargetSession(token,targetId,previous){
  const result=await super.bindTargetSession(token,targetId,previous);
  if(result.ok&&this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='test_check_delay'").toArray().length){
   const delayed=this.ctx.storage.sql.exec("SELECT deviceId FROM test_check_delay WHERE deviceId=?",result.reference.deviceId).toArray()[0];
   if(delayed){this.ctx.storage.sql.exec("UPDATE test_check_delay SET started=1 WHERE deviceId=?",delayed.deviceId);await new Promise(resolve=>setTimeout(resolve,500));}
  }
  return result;
 }
 async checkSessionReference(reference,token){
  const result=await super.checkSessionReference(reference,token);
  if(result.ok&&token===undefined&&this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='test_reference_precheck'").toArray().length){
   const row=this.ctx.storage.sql.exec("SELECT targetId FROM test_reference_precheck WHERE targetId=?",result.target.deviceId).toArray()[0];
   if(row){this.ctx.storage.sql.exec("UPDATE test_reference_precheck SET started=1 WHERE targetId=?",row.targetId);
    const deadline=Date.now()+5000;
    while(!this.ctx.storage.sql.exec("SELECT released FROM test_reference_precheck WHERE targetId=?",row.targetId).toArray()[0]?.released){if(Date.now()>deadline)throw new Error('test precheck gate timeout');await new Promise(resolve=>setTimeout(resolve,10));}
   }
  }
  if(result.ok&&token&&await this.operationGate(result.source.deviceId,result.target.deviceId))return super.checkSessionReference(reference,token);
  if(result.ok&&token&&this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='test_policy_confirmation'").toArray().length){
   const delayed=this.ctx.storage.sql.exec("SELECT sourceId FROM test_policy_confirmation WHERE sourceId=? AND targetId=?",result.source.deviceId,result.target.deviceId).toArray()[0];
   if(delayed){this.ctx.storage.sql.exec("UPDATE test_policy_confirmation SET started=1 WHERE sourceId=?",delayed.sourceId);
    const deadline=Date.now()+5000;
    while(!this.ctx.storage.sql.exec("SELECT released FROM test_policy_confirmation WHERE sourceId=?",delayed.sourceId).toArray()[0]?.released){if(Date.now()>deadline)throw new Error('test confirmation gate timeout');await new Promise(resolve=>setTimeout(resolve,10));}
    return super.checkSessionReference(reference,token);
   }
  }
  return result;
 }
 async sessionDigest(token){
  const hash=await super.sessionDigest(token);
  if(this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='test_digest_failure'").toArray().length&&this.ctx.storage.sql.exec("SELECT hash FROM test_digest_failure WHERE hash=?",hash).toArray().length)throw new Error('test digest failure');
  if(this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='test_reference_digest'").toArray().length){
   const row=this.ctx.storage.sql.exec("SELECT hash FROM test_reference_digest WHERE hash=?",hash).toArray()[0];
   if(row){this.ctx.storage.sql.exec("UPDATE test_reference_digest SET started=1 WHERE hash=?",hash);
    const deadline=Date.now()+5000;
    while(!this.ctx.storage.sql.exec("SELECT released FROM test_reference_digest WHERE hash=?",hash).toArray()[0]?.released){if(Date.now()>deadline)throw new Error('test digest gate timeout');await new Promise(resolve=>setTimeout(resolve,10));}
   }
  }
  return hash;
 }
 async check(token,targetId){const result=await super.check(token,targetId);
  if(result.ok&&targetId&&await this.operationGate(result.source.deviceId,targetId))return super.check(token,targetId);
  if(result.ok&&targetId&&result.source.deviceId!==targetId&&this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='test_revoke_after_check'").toArray().length){
   const row=this.ctx.storage.sql.exec("SELECT deviceId FROM test_revoke_after_check WHERE deviceId=?",result.source.deviceId).toArray()[0];
   if(row)this.ctx.storage.transactionSync(()=>{this.ctx.storage.sql.exec("DELETE FROM test_revoke_after_check WHERE deviceId=?",row.deviceId);this.ctx.storage.sql.exec("UPDATE devices SET groupId=NULL,membershipEpoch=membershipEpoch+1,credentialVersion=credentialVersion+1 WHERE deviceId=?",row.deviceId);});
  }
  if(result.ok&&this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='test_check_delay'").toArray().length){
   const delayed=this.ctx.storage.sql.exec("SELECT deviceId FROM test_check_delay WHERE deviceId=?",result.source.deviceId).toArray()[0];
   if(delayed){this.ctx.storage.sql.exec("UPDATE test_check_delay SET started=1 WHERE deviceId=?",delayed.deviceId);await new Promise(resolve=>setTimeout(resolve,500));}
  }
  if(result.ok&&this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='test_policy_confirmation'").toArray().length){
   const delayed=this.ctx.storage.sql.exec("SELECT sourceId FROM test_policy_confirmation WHERE sourceId=? AND targetId=?",result.source.deviceId,targetId??'').toArray()[0];
   if(delayed){this.ctx.storage.sql.exec("UPDATE test_policy_confirmation SET started=1 WHERE sourceId=?",delayed.sourceId);
    const deadline=Date.now()+5000;
    while(!this.ctx.storage.sql.exec("SELECT released FROM test_policy_confirmation WHERE sourceId=?",delayed.sourceId).toArray()[0]?.released){if(Date.now()>deadline)throw new Error('test confirmation gate timeout');await new Promise(resolve=>setTimeout(resolve,10));}
    return super.check(token,targetId);
   }
  }return result;
 }
}
export default worker;
`,
  );
  execFileSync(
    "node_modules/.bin/wrangler",
    [
      "deploy",
      entry,
      "--dry-run",
      "--config",
      "apps/web/wrangler.devices.example.jsonc",
      "--outdir",
      join(root, "worker"),
    ],
    { stdio: "pipe" },
  );
  mf = new Miniflare({
    ...convertV4MiniflareOptions({
      workers: [
        {
          name: "eagle",
          modules: true,
          scriptPath: join(root, "worker/entry.js"),
          compatibilityDate: "2026-09-19",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: {
            DEVICE_REGISTRY: { className: "DeviceRegistry", useSQLite: true },
            DEVICE_EXECUTION: { className: "DeviceExecution", useSQLite: true },
          },
          bindings: { BUILD_REVISION: "local-device-api" },
        },
      ],
    }),
    unsafeInspectDurableObjects: true,
  });
  await mf.ready;
  await mf.dispatchFetch(`${base}/directory`);
});
beforeEach(async () => {
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "DeviceRegistry",
    { name: "registry" },
  );
  await storage.exec("DELETE FROM rates WHERE key LIKE 'registration:%'");
});
after(async () => {
  await mf?.dispose();
  rmSync(root, { recursive: true, force: true });
});

async function policyService(
  owner: Awaited<ReturnType<typeof identity>>,
  stateDirectory: string,
) {
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const socketPath = join(stateDirectory, "port.sock");
  const child = spawn(process.execPath, ["packages/agent/device-service.ts"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = createInterface({ input: child.stdout });
  const waiters = new Map<string, (message: Record<string, unknown>) => void>();
  let online!: () => void;
  const connected = new Promise<void>((resolve) => {
    online = resolve;
  });
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });
  reader.on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    if (message.type === "sign") {
      child.stdin.write(
        `${JSON.stringify({
          type: "signature",
          requestId: message.requestId,
          signature: sign(
            null,
            Buffer.from(String(message.payload)),
            owner.keys.privateKey,
          ).toString("base64url"),
        })}\n`,
      );
    }
    if (message.type === "cloud" && message.status === "online") online();
    if (message.type === "managed" && typeof message.requestId === "string") {
      waiters.get(message.requestId)?.(message);
      waiters.delete(message.requestId);
    }
  });
  const relayOrigin = (await mf.ready).origin;
  child.stdin.write(
    `${JSON.stringify({
      type: "configure",
      version: 1,
      deviceId: owner.deviceId,
      publicKey: owner.publicKey,
      name: "policy-process",
      platform: "darwin",
      arch: "arm64",
      stateDirectory,
      socketPath,
      baseUrl: relayOrigin,
    })}\n`,
  );
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill("SIGTERM");
    await exited;
    reader.close();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      connected,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`policy service connection timeout: ${stderr}`)),
          10000,
        );
      }),
    ]);
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return {
    stop,
    call(method: string, params?: unknown) {
      const requestId = randomUUID();
      const response = new Promise<Record<string, unknown>>((resolve) =>
        waiters.set(requestId, resolve),
      );
      const remote =
        method === "policy.set" &&
        params &&
        typeof params === "object" &&
        "deviceId" in params &&
        params.deviceId !== owner.deviceId;
      const routed = remote ? { ...(params as object), relayOrigin } : params;
      child.stdin.write(
        `${JSON.stringify({ type: "manage", requestId, method, params: routed })}\n`,
      );
      return response;
    },
    port(method: string, params?: unknown) {
      const socket = connect(socketPath);
      const lines = createInterface({ input: socket });
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        socket.on("error", reject);
        lines.once("line", (line) => {
          lines.close();
          socket.end();
          resolve(JSON.parse(line));
        });
        socket.write(
          `${JSON.stringify({ version: 2, requestId: randomUUID(), method, params })}\n`,
        );
      });
    },
  };
}

test("private remote policy management confirms the real target, persists IDs and stays separate from execution", async () => {
  const [a, b, outsider] = await Promise.all([
    identity("policy-a"),
    identity("policy-b"),
    identity("policy-outsider"),
  ]);
  await pair(a.token, await code(b.token));
  const stateA = join(root, "policy-a");
  const stateB = join(root, "policy-b");
  let source = await policyService(a, stateA);
  let target = await policyService(b, stateB);
  let legacy: NativeWebSocket | undefined;
  try {
    assert.deepEqual(
      (await target.call("policy.set", { mode: "paused" })).result,
      { mode: "paused", version: 2 },
    );
    const input = {
      deviceId: b.deviceId,
      mode: "always-ask",
      requestId: randomUUID(),
    };
    assert.deepEqual(
      (await source.call("policy.set", input)).result,
      { mode: "always-ask", version: 3 },
      "a private remote write must confirm target persistence even when paused",
    );
    assert.deepEqual((await source.call("policy.get")).result, {
      mode: "always-ask",
      version: 1,
    });
    assert.equal(
      (await source.port("policy.set", input)).error,
      "management_requires_private_helper",
    );
    const invalidExecute = await source.port("execute", {
      requestId: randomUUID(),
      operationId: randomUUID(),
      targetDeviceId: b.deviceId,
      action: "run",
      operation: { kind: "policy.set", mode: "all-approve" },
      digest: "0".repeat(64),
    });
    assert.equal(invalidExecute.result, undefined);
    assert.equal(
      (await source.call("policy.set", { ...input, mode: "paused" })).error,
      "policy_request_conflict",
    );
    assert.equal(
      (await source.call("policy.set", { ...input, deviceId: a.deviceId }))
        .error,
      "policy_request_conflict",
    );
    assert.equal(
      (await source.call("policy.set", input)).error,
      "policy_request_already_sent_refresh_target",
    );
    assert.deepEqual(
      (
        await source.call("policy.set", {
          ...input,
          mode: "paused",
          requestId: randomUUID(),
        })
      ).result,
      { mode: "paused", version: 4 },
    );
    assert.deepEqual(
      (await target.call("policy.set", { mode: "all-approve" })).result,
      { mode: "all-approve", version: 5 },
    );
    await target.stop();
    target = await policyService(b, stateB);
    const replay = await call("/policy", a.token, input);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, { mode: "always-ask", version: 3 });
    assert.deepEqual((await target.call("policy.get")).result, {
      mode: "all-approve",
      version: 5,
    });
    assert.equal(
      (await call("/policy", a.token, { ...input, mode: "paused" })).status,
      409,
    );
    assert.equal(
      (
        await call("/policy", outsider.token, {
          ...input,
          requestId: randomUUID(),
        })
      ).status,
      403,
    );
    await source.stop();
    source = await policyService(a, stateA);
    assert.equal(
      (await source.call("policy.set", input)).error,
      "policy_request_already_sent_refresh_target",
    );
    const next = { ...input, mode: "paused", requestId: randomUUID() };
    assert.deepEqual((await source.call("policy.set", next)).result, {
      mode: "paused",
      version: 6,
    });
    await target.stop();
    const offline = await source.call("policy.set", {
      ...next,
      requestId: randomUUID(),
    });
    assert.equal(offline.error, "target_offline");
    legacy = new NativeWebSocket(
      `${(await mf.ready).origin.replace("http:", "ws:")}/api/devices/v1/execution/${b.deviceId}/agent`,
    );
    await new Promise<void>((resolve) => legacy?.once("open", resolve));
    legacy.send(
      JSON.stringify({
        type: "authenticate",
        sessionToken: b.token,
        capabilities: [],
        policy: { mode: "paused", version: 6 },
      }),
    );
    await new Promise<void>((resolve) =>
      legacy?.once("message", () => resolve()),
    );
    assert.equal(
      (await source.call("policy.set", { ...next, requestId: randomUUID() }))
        .error,
      "target_management_unsupported",
    );
    let forwarded = 0;
    legacy.on("message", () => {
      forwarded++;
    });
    legacy.send(
      JSON.stringify({
        type: "heartbeat",
        capabilities: ["policy.manage"],
        policy: { mode: "paused", version: 6 },
      }),
    );
    // The following live directory read is ordered after the heartbeat on the same target DO.
    await call("/directory", a.token);
    const uncertain = { ...next, requestId: randomUUID() };
    assert.equal(
      (await source.call("policy.set", uncertain)).error,
      "policy_result_unknown_refresh_target",
    );
    assert.equal(forwarded, 1);
    await source.stop();
    source = await policyService(a, stateA);
    assert.equal(
      (await source.call("policy.set", uncertain)).error,
      "policy_request_already_sent_refresh_target",
    );
    assert.equal(forwarded, 1);
    await call("/members/remove", b.token, { deviceId: a.deviceId });
    const revoked = await source.call("policy.set", {
      ...next,
      requestId: randomUUID(),
    });
    assert.equal(revoked.result, undefined);
    assert.match(
      String(revoked.error),
      /invalid_session|revoked_session|different_group/,
    );
    assert.equal(
      forwarded,
      1,
      "revoked sources cannot forward management writes",
    );
  } finally {
    legacy?.terminate();
    await source.stop();
    await target.stop();
  }
});
async function call(path: string, token?: string, value?: unknown) {
  const response = await mf.dispatchFetch(`${base}${path}`, {
    method: value === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  return {
    status: response.status,
    body: (await response.json()) as ApiBody,
  };
}

test("remote policy authorization is rechecked immediately before target side effects", async () => {
  const [a, b] = await Promise.all([
    identity("policy-race-a"),
    identity("policy-race-b"),
  ]);
  await pair(a.token, await code(b.token));
  const target = await policyService(b, join(root, "policy-race-b"));
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "DeviceRegistry",
    { name: "registry" },
  );
  try {
    await storage.exec(
      "CREATE TABLE test_revoke_after_check(deviceId TEXT PRIMARY KEY)",
    );
    await storage.exec(
      "INSERT INTO test_revoke_after_check VALUES(?)",
      a.deviceId,
    );
    const response = await call("/policy", a.token, {
      deviceId: b.deviceId,
      requestId: randomUUID(),
      mode: "paused",
    });
    assert.equal(response.status, 401);
    assert.equal(
      (response.body as unknown as { error: string }).error,
      "revoked_session",
    );
    assert.deepEqual((await target.call("policy.get")).result, {
      mode: "always-ask",
      version: 1,
    });
  } finally {
    await storage.exec("DROP TABLE IF EXISTS test_revoke_after_check");
    await target.stop();
  }
});

test("remote policy confirmation rejects a target removed and rejoined during source authorization without resending", async () => {
  const [a, b] = await Promise.all([
    identity("policy-confirm-a"),
    identity("policy-confirm-b"),
  ]);
  await pair(a.token, await code(b.token));
  const source = await policyService(a, join(root, "policy-confirm-a"));
  const target = await rawSocket(b.deviceId, "agent");
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "DeviceRegistry",
    { name: "registry" },
  );
  try {
    const ready = frame<{ type: string }>(target);
    target.send(
      JSON.stringify({
        ...authentication(b.token),
        capabilities: ["policy.manage"],
      }),
    );
    assert.equal((await ready).type, "ready");
    let forwarded = 0;
    target.on("message", (data) => {
      if (JSON.parse(data.toString()).type === "policy.set") forwarded++;
    });
    const input = {
      deviceId: b.deviceId,
      requestId: randomUUID(),
      mode: "paused",
    };
    const forwardedRequest = frame<{ relayId: string }>(target);
    const response = source.call("policy.set", input);
    const request = await forwardedRequest;
    await storage.exec(
      "CREATE TABLE test_policy_confirmation(sourceId TEXT PRIMARY KEY,targetId TEXT,started INTEGER DEFAULT 0,released INTEGER DEFAULT 0)",
    );
    await storage.exec(
      "INSERT INTO test_policy_confirmation(sourceId,targetId) VALUES(?,?)",
      a.deviceId,
      b.deviceId,
    );
    target.send(
      JSON.stringify({
        type: "policy.result",
        relayId: request.relayId,
        requestId: input.requestId,
        deviceId: b.deviceId,
        policy: { mode: "paused", version: 2 },
      }),
    );
    let started = false;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const rows = await storage.exec(
        "SELECT started FROM test_policy_confirmation",
      );
      if (rows[0].started === 1) {
        started = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(started, true, "source authorization must reach the gate");
    assert.equal(
      (await call("/members/remove", a.token, { deviceId: b.deviceId })).status,
      200,
    );
    const challenge = await call("/register/challenge", undefined, {
      deviceId: b.deviceId,
      publicKey: b.publicKey,
      name: "policy-confirm-b",
      platform: "darwin",
      arch: "arm64",
    });
    assert.equal(challenge.status, 200);
    const refreshed = await call("/register/complete", undefined, {
      challengeId: challenge.body.challengeId,
      signature: sign(
        null,
        Buffer.from(challenge.body.payload),
        b.keys.privateKey,
      ).toString("base64url"),
    });
    assert.equal(refreshed.status, 200);
    assert.equal(
      (await pair(refreshed.body.sessionToken, await code(a.token))).status,
      200,
    );
    await storage.exec("UPDATE test_policy_confirmation SET released=1");
    const result = await response;
    assert.equal(result.result, undefined, "revoked target cannot confirm");
    assert.equal(result.error, "policy_result_unknown_refresh_target");
    assert.equal(
      (await source.call("policy.set", input)).error,
      "policy_request_already_sent_refresh_target",
    );
    assert.equal(forwarded, 1, "uncertain policy writes must not be resent");
  } finally {
    await storage.exec("DROP TABLE IF EXISTS test_policy_confirmation");
    target.terminate();
    await source.stop();
  }
});
async function identity(name: string) {
  const keys = generateKeyPairSync("ed25519");
  const deviceId = randomUUID();
  const publicKey = keys.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64url");
  const challenge = await call("/register/challenge", undefined, {
    deviceId,
    publicKey,
    name,
    platform: "darwin",
    arch: "arm64",
  });
  assert.equal(challenge.status, 200, JSON.stringify(challenge.body));
  const proof = {
    challengeId: challenge.body.challengeId,
    signature: sign(
      null,
      Buffer.from(challenge.body.payload),
      keys.privateKey,
    ).toString("base64url"),
  };
  const response = await call("/register/complete", undefined, proof);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return {
    deviceId,
    publicKey,
    token: response.body.sessionToken as string,
    keys,
    proof,
  };
}
async function code(token: string, ttlSeconds = 3600) {
  const response = await call("/pairings", token, { ttlSeconds });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(Buffer.from(response.body.code, "base64url").length, 32);
  return response.body.code as string;
}
async function pair(
  token: string,
  invitation: string,
  requestId = randomUUID(),
) {
  return call("/pairings/redeem", token, { requestId, code: invitation });
}

test("internal session references bind expiry, generation and live membership without becoming credentials", async () => {
  type Reference = {
    sessionHash: string;
    deviceId: string;
    credentialVersion: number;
    expiresAt: number;
  };
  type Bound =
    | { ok: true; reference: Reference }
    | { ok: false; status: number; error: string };
  type Checked =
    | { ok: true; source: { deviceId: string }; target: { deviceId: string } }
    | { ok: false; status: number; error: string };
  const namespace = (await mf.getDurableObjectNamespace(
    "DEVICE_REGISTRY",
    "eagle",
  )) as unknown as DurableObjectNamespace;
  const registry = namespace.get(
    namespace.idFromName("registry"),
  ) as unknown as {
    bindTargetSession(
      token: string,
      target: string,
      previous?: Reference,
    ): Promise<Bound>;
    checkSessionReference(
      reference: Reference,
      sourceToken?: string,
    ): Promise<Checked>;
  };
  const [a, b, outsider] = await Promise.all([
    identity("ref-a"),
    identity("ref-b"),
    identity("ref-outsider"),
  ]);
  await pair(a.token, await code(b.token));
  const renew = async (device: typeof a): Promise<string> => {
    const challenge = await call("/register/challenge", undefined, {
      deviceId: device.deviceId,
      publicKey: device.publicKey,
      name: "ref-renewed",
      platform: "darwin",
      arch: "arm64",
    });
    assert.equal(challenge.status, 200);
    const result = await call("/register/complete", undefined, {
      challengeId: challenge.body.challengeId,
      signature: sign(
        null,
        Buffer.from(challenge.body.payload),
        device.keys.privateKey,
      ).toString("base64url"),
    });
    assert.equal(result.status, 200);
    return result.body.sessionToken;
  };
  const first = await registry.bindTargetSession(b.token, b.deviceId);
  assert.equal(first.ok, true);
  if (!first.ok) throw new Error("target session binding failed");
  const reference = first.reference;
  assert.deepEqual(Object.keys(reference).sort(), [
    "credentialVersion",
    "deviceId",
    "expiresAt",
    "sessionHash",
  ]);
  assert.equal(reference.deviceId, b.deviceId);
  assert.equal(/^[a-f0-9]{64}$/.test(reference.sessionHash), true);
  assert.equal(reference.sessionHash === b.token, false);
  assert.equal(reference.expiresAt > Date.now(), true);
  const self = await registry.checkSessionReference(reference);
  assert.equal(self.ok, true);
  if (self.ok) assert.equal(self.source.deviceId, b.deviceId);
  const authorized = await registry.checkSessionReference(reference, a.token);
  assert.equal(authorized.ok, true);
  if (authorized.ok) {
    assert.equal(authorized.source.deviceId, a.deviceId);
    assert.equal(authorized.target.deviceId, b.deviceId);
  }
  assert.equal(
    (await registry.checkSessionReference(reference, outsider.token)).ok,
    false,
  );
  assert.equal(
    (
      await registry.checkSessionReference(
        { ...reference, deviceId: a.deviceId },
        a.token,
      )
    ).ok,
    false,
  );
  assert.equal(
    (
      await registry.checkSessionReference(
        { ...reference, expiresAt: reference.expiresAt + 1 },
        a.token,
      )
    ).ok,
    false,
  );
  assert.equal(
    (
      await registry.checkSessionReference(
        { ...reference, sessionHash: "0".repeat(64) },
        a.token,
      )
    ).ok,
    false,
  );
  assert.equal(
    (await registry.bindTargetSession(b.token, a.deviceId)).ok,
    false,
  );
  assert.equal(
    (await registry.bindTargetSession(reference.sessionHash, b.deviceId)).ok,
    false,
  );
  assert.equal(
    (await registry.checkSessionReference(reference, reference.sessionHash)).ok,
    false,
  );
  assert.equal(
    (
      await registry.checkSessionReference(
        { ...reference, credentialVersion: reference.credentialVersion + 1 },
        a.token,
      )
    ).ok,
    false,
  );
  assert.equal((await call("/directory", reference.sessionHash)).status, 401);
  assert.equal(
    (await call("/sessions/check-reference", a.token, { reference })).status,
    404,
  );
  const tokenB = await renew(b);
  const renewed = await registry.bindTargetSession(
    tokenB,
    b.deviceId,
    reference,
  );
  assert.equal(renewed.ok, true);
  if (!renewed.ok) throw new Error("target session renewal failed");
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "DeviceRegistry",
    { name: "registry" },
  );
  const expiredAt = Date.now() - 1;
  await storage.exec(
    "UPDATE sessions SET expires=? WHERE hash=?",
    expiredAt,
    reference.sessionHash,
  );
  const expired = { ...reference, expiresAt: expiredAt };
  assert.equal(
    (await registry.checkSessionReference(expired, a.token)).ok,
    false,
  );
  assert.equal(
    (await registry.bindTargetSession(tokenB, b.deviceId, expired)).ok,
    false,
  );
  const tokenA = await renew(a);
  const sourceHash = createHash("sha256").update(a.token).digest("hex");
  await storage.exec(
    "UPDATE sessions SET expires=? WHERE hash=?",
    Date.now() - 1,
    sourceHash,
  );
  assert.equal(
    (await registry.checkSessionReference(renewed.reference, a.token)).ok,
    false,
  );
  assert.equal(
    (await registry.checkSessionReference(renewed.reference, tokenA)).ok,
    true,
  );
  assert.equal(
    (await call("/members/remove", tokenA, { deviceId: b.deviceId })).status,
    200,
  );
  assert.equal(
    (await registry.checkSessionReference(renewed.reference, tokenA)).ok,
    false,
  );
  const newGeneration = await renew(b);
  assert.equal(
    (
      await registry.bindTargetSession(
        newGeneration,
        b.deviceId,
        renewed.reference,
      )
    ).ok,
    false,
  );
  const rebound = await registry.bindTargetSession(newGeneration, b.deviceId);
  assert.equal(rebound.ok, true);
  if (rebound.ok)
    assert.equal(
      (await registry.checkSessionReference(rebound.reference, tokenA)).ok,
      false,
    );
});

test("session reference authorization observes revocation while source hashing is in flight", async () => {
  type Reference = {
    sessionHash: string;
    deviceId: string;
    credentialVersion: number;
    expiresAt: number;
  };
  type Bound = { ok: true; reference: Reference } | { ok: false };
  type Checked = { ok: true } | { ok: false; status: number; error: string };
  const namespace = (await mf.getDurableObjectNamespace(
    "DEVICE_REGISTRY",
    "eagle",
  )) as unknown as DurableObjectNamespace;
  const registry = namespace.get(
    namespace.idFromName("registry"),
  ) as unknown as {
    bindTargetSession(token: string, target: string): Promise<Bound>;
    checkSessionReference(
      reference: Reference,
      sourceToken: string,
    ): Promise<Checked>;
  };
  const [a, b] = await Promise.all([
    identity("ref-race-a"),
    identity("ref-race-b"),
  ]);
  await pair(a.token, await code(b.token));
  const bound = await registry.bindTargetSession(b.token, b.deviceId);
  assert.equal(bound.ok, true);
  if (!bound.ok) throw new Error("target session binding failed");
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "DeviceRegistry",
    { name: "registry" },
  );
  const hash = createHash("sha256").update(a.token).digest("hex");
  await storage.exec(
    "CREATE TABLE test_reference_digest(hash TEXT PRIMARY KEY,started INTEGER NOT NULL DEFAULT 0,released INTEGER NOT NULL DEFAULT 0)",
  );
  let pending: Promise<Checked> | undefined;
  try {
    await storage.exec(
      "INSERT INTO test_reference_digest(hash) VALUES(?)",
      hash,
    );
    pending = registry.checkSessionReference(bound.reference, a.token);
    const deadline = Date.now() + 2000;
    let started = false;
    while (Date.now() < deadline) {
      const rows = await storage.exec(
        "SELECT started FROM test_reference_digest WHERE hash=?",
        hash,
      );
      if (rows[0]?.started === 1) {
        started = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(started, true, "reference digest barrier was not reached");
    assert.equal(
      (await call("/members/remove", a.token, { deviceId: b.deviceId })).status,
      200,
    );
    await storage.exec(
      "UPDATE test_reference_digest SET released=1 WHERE hash=?",
      hash,
    );
    const result = await pending;
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 401);
      assert.equal(result.error, "revoked_session");
    }
  } finally {
    await storage.exec(
      "UPDATE test_reference_digest SET released=1 WHERE hash=?",
      hash,
    );
    await pending?.catch(() => undefined);
    await storage.exec("DROP TABLE test_reference_digest");
  }
});

test("registration rate budget remains enforced within each isolated test", async () => {
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "DeviceRegistry",
    { name: "registry" },
  );
  const rates = await storage.exec(
    "SELECT key,count FROM rates WHERE key LIKE 'registration:%'",
  );
  assert.deepEqual(
    rates,
    [],
    "registration budget must be isolated before the case",
  );
  const keys = generateKeyPairSync("ed25519");
  const registration = {
    deviceId: randomUUID(),
    publicKey: keys.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64url"),
    name: "registration-budget",
    platform: "darwin",
    arch: "arm64",
  };
  for (let index = 0; index < 120; index++) {
    assert.equal(
      (await call("/register/challenge", undefined, registration)).status,
      200,
    );
  }
  assert.equal(
    (await call("/register/challenge", undefined, registration)).status,
    429,
  );
});

test("registration proves the key, consumes challenges and rejects identity replacement", async () => {
  const a = await identity("identity");
  assert.equal(
    (await call("/register/complete", undefined, a.proof)).status,
    401,
  );
  const other = generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "der" })
    .toString("base64url");
  assert.equal(
    (
      await call("/register/challenge", undefined, {
        deviceId: a.deviceId,
        publicKey: other,
        name: "replacement",
        platform: "darwin",
        arch: "arm64",
      })
    ).status,
    409,
  );
  assert.equal((await call("/directory", "forged")).status, 401);
  assert.equal((await call("/directory", a.token)).body.devices.length, 1);
});

test("four members join in either direction and conflicting groups do not consume invitations", async () => {
  const [a, b, c, d, e, f] = await Promise.all(
    ["a", "b", "c", "d", "e", "f"].map(identity),
  );
  const first = await pair(a.token, await code(c.token));
  assert.equal(first.status, 200);
  assert.equal((await pair(a.token, await code(b.token))).status, 200);
  assert.equal((await pair(d.token, await code(b.token))).status, 200);
  for (const member of [a, b, c, d]) {
    const directory = (await call("/directory", member.token)).body;
    assert.equal(directory.groupId, first.body.groupId);
    assert.deepEqual(
      directory.devices.map((x: { deviceId: string }) => x.deviceId).sort(),
      [a, b, c, d].map((x) => x.deviceId).sort(),
    );
  }
  assert.equal((await pair(e.token, await code(f.token))).status, 200);
  const conflict = await code(e.token);
  assert.equal((await pair(a.token, conflict)).status, 409);
  assert.equal((await pair(f.token, conflict)).status, 200);
});

test("lost pairing response recovers by original request and code without reviving removed membership", async () => {
  const [a, b, c] = await Promise.all(
    ["recover-a", "recover-b", "recover-c"].map(identity),
  );
  const invitation = await code(b.token);
  const requestId = randomUUID();
  const first = await pair(a.token, invitation, requestId);
  assert.equal(first.status, 200);
  assert.equal(
    (await pair(a.token, invitation, requestId)).body.groupId,
    first.body.groupId,
  );
  assert.equal(
    (await pair(a.token, invitation)).body.groupId,
    first.body.groupId,
  );
  assert.equal((await pair(c.token, invitation)).status, 409);
  assert.equal(
    (await pair(a.token, await code(c.token), requestId)).status,
    409,
  );
  assert.equal(
    (await call(`/pairings/results/${requestId}`, a.token)).body.groupId,
    first.body.groupId,
  );
  assert.equal(
    (await call("/members/remove", a.token, { deviceId: b.deviceId })).status,
    200,
  );
  assert.equal((await call("/directory", b.token)).status, 401);
  const restored = await call(`/pairings/results/${requestId}`, a.token);
  assert.equal(restored.body.directory.devices.length, 1);
});

test("revoked invitations, stale issuance epochs and invalid TTL fail closed", async () => {
  const [a, b, c] = await Promise.all(
    ["invite-a", "invite-b", "invite-c"].map(identity),
  );
  const old = await code(a.token);
  assert.equal(
    (await call("/pairings/revoke", a.token, { code: old })).status,
    200,
  );
  assert.equal((await pair(b.token, old)).status, 410);
  const stale = await code(a.token);
  assert.equal((await pair(a.token, await code(c.token))).status, 200);
  assert.equal((await pair(b.token, stale)).status, 410);
  assert.equal(
    (await call("/pairings", a.token, { ttlSeconds: 86401 })).status,
    400,
  );
  const expired = await code(a.token, 1);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal((await pair(b.token, expired)).status, 410);
});

test("registration challenge binds configured service and directory preserves unknown observations", async () => {
  const a = await identity("bound-service");
  const challenge = await call("/register/challenge", undefined, {
    deviceId: a.deviceId,
    publicKey: a.publicKey,
    name: "bound-service",
    platform: "darwin",
    arch: "arm64",
  });
  const lines = challenge.body.payload.split("\n");
  assert.equal(lines.length, 7);
  assert.equal(lines[0], "eagle-device-register-v1");
  assert.equal(lines[1], "https://devices.test");
  assert.equal(lines[2], a.deviceId);
  const directory = await call("/directory", a.token);
  assert.equal(directory.body.devices[0].online, null);
  assert.equal(directory.body.devices[0].policy, null);
});

test("real outbound WebSockets execute bidirectionally with original-ID dedup and live revocation", async () => {
  const { DeviceCloud } = await import("../packages/agent/device-cloud.ts");
  const { DeviceRuntime } = await import("../packages/agent/device-runtime.ts");
  const { canonicalDeviceJSON, deviceDigest } = await import(
    "../packages/contracts/src/devices.ts"
  );
  const [a, b] = await Promise.all([identity("ws-a"), identity("ws-b")]);
  await pair(a.token, await code(b.token));
  const stateA = join(root, "agent-a");
  const stateB = join(root, "agent-b");
  mkdirSync(stateA, { mode: 0o700 });
  mkdirSync(stateB, { mode: 0o700 });
  const deviceA = {
    deviceId: a.deviceId,
    publicKey: a.publicKey,
    name: "ws-a",
    platform: "darwin",
    arch: "arm64",
    groupId: null,
    membershipEpoch: 0,
    credentialVersion: 1,
  };
  const deviceB = {
    ...deviceA,
    deviceId: b.deviceId,
    publicKey: b.publicKey,
    name: "ws-b",
  };
  const runtimeA = new DeviceRuntime(deviceA, join(stateA, "journal.sqlite"));
  const runtimeB = new DeviceRuntime(deviceB, join(stateB, "journal.sqlite"));
  // Fresh devices ask first; these cases are about everything after that decision.
  runtimeA.setPolicy("all-approve");
  runtimeB.setPolicy("all-approve");
  const localBase = (await mf.ready).origin;
  const cloudA = new DeviceCloud(
    localBase,
    deviceA,
    runtimeA,
    async (payload) =>
      sign(null, Buffer.from(payload), a.keys.privateKey).toString("base64url"),
  );
  let signaturesB = 0;
  const statesB: string[] = [];
  const cloudB = new DeviceCloud(
    localBase,
    deviceB,
    runtimeB,
    async (payload) => {
      signaturesB++;
      return sign(null, Buffer.from(payload), b.keys.privateKey).toString(
        "base64url",
      );
    },
    (status) => statesB.push(status),
  );
  try {
    await Promise.all([cloudA.start(), cloudB.start()]);
    const directory = await cloudA.directory();
    assert.equal(
      directory.devices.find((d) => d.deviceId === b.deviceId)?.online,
      true,
    );
    assert(
      directory.devices
        .find((d) => d.deviceId === b.deviceId)
        ?.capabilities?.includes("command"),
    );
    const operation = { kind: "command" as const, command: "printf from-b" };
    const input = {
      requestId: randomUUID(),
      operationId: randomUUID(),
      targetDeviceId: b.deviceId,
      action: "run" as const,
      operation,
      digest: await deviceDigest(canonicalDeviceJSON(operation)),
      sourceBotId: "bot-one",
    };
    assert.equal((await cloudA.execute(input)).output, "from-b");
    assert.equal(
      (
        await cloudA.execute({
          ...input,
          requestId: randomUUID(),
          action: "get",
        })
      ).output,
      "from-b",
    );
    const back = {
      ...input,
      requestId: randomUUID(),
      operationId: randomUUID(),
      targetDeviceId: a.deviceId,
    };
    assert.equal((await cloudB.execute(back)).output, "from-b");
    assert.equal(
      (await cloudA.execute({ ...input, requestId: randomUUID() })).output,
      "from-b",
    );
    const beforePolicy = await cloudA.directory();
    runtimeB.setPolicy("always-ask");
    cloudB.publishPolicy();
    let changed = await cloudA.directory();
    const observationDeadline = Date.now() + 1000;
    while (
      changed.devices.find((d) => d.deviceId === b.deviceId)?.policy
        ?.version !== runtimeB.policy.version &&
      Date.now() < observationDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      changed = await cloudA.directory();
    }
    assert.equal(changed.revision, beforePolicy.revision);
    assert.notEqual(
      changed.observationRevision,
      beforePolicy.observationRevision,
    );
    const asking = {
      ...input,
      requestId: randomUUID(),
      operationId: randomUUID(),
    };
    assert.equal((await cloudA.execute(asking)).status, "denied");
    const { approvalPayload } = await import(
      "../packages/contracts/src/devices.ts"
    );
    const envelope = {
      operationId: asking.operationId,
      sourceDeviceId: a.deviceId,
      targetDeviceId: b.deviceId,
      digest: asking.digest,
      policyVersion: runtimeB.policy.version,
      expiresAt: Date.now() + 60000,
    };
    const approved = {
      ...asking,
      approval: {
        ...envelope,
        signature: sign(
          null,
          Buffer.from(approvalPayload(envelope)),
          a.keys.privateKey,
        ).toString("base64url"),
      },
    };
    assert.equal((await cloudA.execute(approved)).output, "from-b");
    runtimeB.setPolicy("all-approve");
    cloudB.publishPolicy();
    const namespace = (await mf.getDurableObjectNamespace(
      "DEVICE_EXECUTION",
      "eagle",
    )) as unknown as DurableObjectNamespace;
    const agent = namespace.get(namespace.idFromName(b.deviceId));
    for (const [closeCode, reason] of [
      [1012, "transport_restart"],
      [1008, "agent_replaced"],
    ] as const) {
      const onlineCount = statesB.filter(
        (status) => status === "online",
      ).length;
      await agent.fetch(
        `https://test/test-close?code=${closeCode}&reason=${reason}`,
      );
      const deadline = Date.now() + 3000;
      while (
        statesB.filter((status) => status === "online").length ===
          onlineCount &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        statesB.filter((status) => status === "online").length,
        onlineCount + 1,
      );
      assert.equal(
        signaturesB,
        1,
        "transport and non-auth policy closure must retain a valid session",
      );
    }
    const registry = await mf.unsafeGetDurableObjectStorage(
      "eagle",
      "DeviceRegistry",
      { name: "registry" },
    );
    await registry.exec(
      "UPDATE sessions SET expires=0 WHERE deviceId=?",
      b.deviceId,
    );
    await registry.exec(
      `CREATE TRIGGER transient_registration_failure BEFORE INSERT ON challenges WHEN json_extract(NEW.registration,'$.deviceId')='${b.deviceId}' BEGIN SELECT RAISE(ABORT,'transient fixture failure'); END`,
    );
    try {
      cloudB.publishPolicy();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.equal(cloudB.status, "offline");
    } finally {
      await registry.exec("DROP TRIGGER transient_registration_failure");
    }
    const reconnectDeadline = Date.now() + 5000;
    while (String(cloudB.status) !== "online" && Date.now() < reconnectDeadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      cloudB.status,
      "online",
      "agent must continue retrying after refresh temporarily fails",
    );
    assert.equal(
      signaturesB,
      2,
      "authentication closure must refresh without a directory HTTP 401",
    );
    assert.equal(
      (
        await cloudA.execute({
          ...input,
          requestId: randomUUID(),
          action: "get",
        })
      ).output,
      "from-b",
    );
    const removal = await cloudA.manage("/members/remove", {
      deviceId: b.deviceId,
    });
    assert(removal);
    assert.equal(
      (
        await cloudA.execute({
          ...input,
          requestId: randomUUID(),
          action: "get",
        })
      ).status,
      "denied",
    );
  } finally {
    await Promise.all([cloudA.close(), cloudB.close()]);
    await Promise.all([runtimeA.close(), runtimeB.close()]);
  }
});

for (const mode of ["shutdown", "closing"] as const) {
  test(`a ${mode} target connection cannot start a gated remote operation`, {
    timeout: 60000,
  }, async () => {
    const { DeviceCloud } = await import("../packages/agent/device-cloud.ts");
    const { DeviceRuntime } = await import(
      "../packages/agent/device-runtime.ts"
    );
    const { canonicalDeviceJSON, deviceDigest } = await import(
      "../packages/contracts/src/devices.ts"
    );
    const [a, b] = await Promise.all([
      identity("retire-a"),
      identity("retire-b"),
    ]);
    await pair(a.token, await code(b.token));
    const stateA = join(root, `retire-a-${randomUUID()}`);
    const stateB = join(root, `retire-b-${randomUUID()}`);
    mkdirSync(stateA, { mode: 0o700 });
    mkdirSync(stateB, { mode: 0o700 });
    const deviceA = {
      deviceId: a.deviceId,
      publicKey: a.publicKey,
      name: "retire-a",
      platform: "darwin",
      arch: "arm64",
      groupId: null,
      membershipEpoch: 0,
      credentialVersion: 1,
    };
    const deviceB = {
      ...deviceA,
      deviceId: b.deviceId,
      publicKey: b.publicKey,
      name: "retire-b",
    };
    const runtimeA = new DeviceRuntime(deviceA, join(stateA, "journal.sqlite"));
    const runtimeB = new DeviceRuntime(deviceB, join(stateB, "journal.sqlite"));
    runtimeA.setPolicy("all-approve");
    runtimeB.setPolicy("all-approve");
    let enter: () => void;
    let release: (() => void) | undefined;
    let finish: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const handle = runtimeB.handle.bind(runtimeB);
    runtimeB.handle = async (...args) => {
      enter();
      await blocked;
      try {
        return await handle(...args);
      } finally {
        finish();
      }
    };
    const origin = (await mf.ready).origin;
    const cloudA = new DeviceCloud(origin, deviceA, runtimeA, async (payload) =>
      sign(null, Buffer.from(payload), a.keys.privateKey).toString("base64url"),
    );
    const cloudB = new DeviceCloud(origin, deviceB, runtimeB, async (payload) =>
      sign(null, Buffer.from(payload), b.keys.privateKey).toString("base64url"),
    );
    try {
      await Promise.all([cloudA.start(), cloudB.start()]);
      const path = join(stateB, "must-not-exist");
      const operation = {
        kind: "file.write" as const,
        path,
        content: "forbidden",
      };
      const pending = cloudA.execute({
        requestId: randomUUID(),
        operationId: randomUUID(),
        targetDeviceId: b.deviceId,
        action: "run",
        operation,
        digest: await deviceDigest(canonicalDeviceJSON(operation)),
      });
      const reached = await Promise.race([
        entered.then(() => true),
        pending.then(() => false),
      ]);
      assert.equal(reached, true, "the target must receive the operation");
      if (mode === "shutdown") {
        await cloudB.close();
        release?.();
        await finished;
      } else {
        const socket = (cloudB as unknown as { agent: NativeWebSocket }).agent;
        const sender = (
          socket as unknown as {
            _sender: { close: (...args: unknown[]) => void };
          }
        )._sender;
        const close = sender.close;
        sender.close = () => {};
        socket.close(1000, "test_retirement");
        assert.equal(socket.readyState, NativeWebSocket.CLOSING);
        release?.();
        await finished;
        assert.equal(socket.readyState, NativeWebSocket.CLOSING);
        sender.close = close;
        socket.terminate();
      }
      const answer = await pending;
      assert.equal(answer.status, "unknown");
      assert.equal(existsSync(path), false);
    } finally {
      release?.();
      await Promise.all([cloudA.close(), cloudB.close()]);
      await Promise.all([runtimeA.close(), runtimeB.close()]);
      rmSync(stateA, { recursive: true, force: true });
      rmSync(stateB, { recursive: true, force: true });
    }
  });
}

test("revocation after a target side effect returns unknown without exposing output", {
  timeout: 60000,
}, async () => {
  const { DeviceCloud } = await import("../packages/agent/device-cloud.ts");
  const { DeviceRuntime } = await import("../packages/agent/device-runtime.ts");
  const { canonicalDeviceJSON, deviceDigest } = await import(
    "../packages/contracts/src/devices.ts"
  );
  const [a, b] = await Promise.all([
    identity("result-a"),
    identity("result-b"),
  ]);
  await pair(a.token, await code(b.token));
  const stateA = join(root, `result-a-${randomUUID()}`);
  const stateB = join(root, `result-b-${randomUUID()}`);
  mkdirSync(stateA, { mode: 0o700 });
  mkdirSync(stateB, { mode: 0o700 });
  const deviceA = {
    deviceId: a.deviceId,
    publicKey: a.publicKey,
    name: "result-a",
    platform: "darwin",
    arch: "arm64",
    groupId: null,
    membershipEpoch: 0,
    credentialVersion: 1,
  };
  const deviceB = {
    ...deviceA,
    deviceId: b.deviceId,
    publicKey: b.publicKey,
    name: "result-b",
  };
  const runtimeA = new DeviceRuntime(deviceA, join(stateA, "journal.sqlite"));
  const runtimeB = new DeviceRuntime(deviceB, join(stateB, "journal.sqlite"));
  runtimeA.setPolicy("all-approve");
  runtimeB.setPolicy("all-approve");
  let enter: () => void;
  let release: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handle = runtimeB.handle.bind(runtimeB);
  runtimeB.handle = async (...args) => {
    const result = await handle(...args);
    enter();
    await blocked;
    return result;
  };
  const origin = (await mf.ready).origin;
  const cloudA = new DeviceCloud(origin, deviceA, runtimeA, async (payload) =>
    sign(null, Buffer.from(payload), a.keys.privateKey).toString("base64url"),
  );
  const cloudB = new DeviceCloud(origin, deviceB, runtimeB, async (payload) =>
    sign(null, Buffer.from(payload), b.keys.privateKey).toString("base64url"),
  );
  try {
    await Promise.all([cloudA.start(), cloudB.start()]);
    const path = join(stateB, "side-effect");
    const operation = {
      kind: "command" as const,
      command: `printf x >> '${path}'; printf private-output`,
    };
    const pending = cloudA.execute({
      requestId: randomUUID(),
      operationId: randomUUID(),
      targetDeviceId: b.deviceId,
      action: "run",
      operation,
      digest: await deviceDigest(canonicalDeviceJSON(operation)),
    });
    const reached = await Promise.race([
      entered.then(() => true),
      pending.then(() => false),
    ]);
    assert.equal(reached, true, "the target must complete before revocation");
    assert.equal(readFileSync(path, "utf8"), "x");
    assert.equal(
      (await call("/members/remove", b.token, { deviceId: a.deviceId })).status,
      200,
    );
    release?.();
    const result = await pending;
    assert.equal(result.status, "unknown");
    assert.equal(result.error, "membership_changed_query_original_id");
    assert.equal(result.output, undefined);
    assert.equal(readFileSync(path, "utf8"), "x");
  } finally {
    release?.();
    await Promise.all([cloudA.close(), cloudB.close()]);
    await Promise.all([runtimeA.close(), runtimeB.close()]);
    rmSync(stateA, { recursive: true, force: true });
    rmSync(stateB, { recursive: true, force: true });
  }
});

test("a target rejoining during result authorization cannot expose the old result", {
  timeout: 60000,
}, async () => {
  const { canonicalDeviceJSON, deviceDigest } = await import(
    "../packages/contracts/src/devices.ts"
  );
  const [a, b] = await Promise.all([
    identity("result-rejoin-a"),
    identity("result-rejoin-b"),
  ]);
  await pair(a.token, await code(b.token));
  const agent = await rawSocket(b.deviceId, "agent");
  let caller: NativeWebSocket | undefined;
  let response:
    | Promise<{ result: { status: string; error?: string; output?: string } }>
    | undefined;
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "DeviceRegistry",
    { name: "registry" },
  );
  const marker = join(root, `result-rejoin-${randomUUID()}`);
  try {
    const ready = frame<{ type: string }>(agent);
    agent.send(JSON.stringify(authentication(b.token)));
    assert.equal((await ready).type, "ready");
    caller = await rawSocket(b.deviceId, "request");
    const operation = { kind: "command" as const, command: "fixture" };
    const request = {
      requestId: randomUUID(),
      operationId: randomUUID(),
      targetDeviceId: b.deviceId,
      action: "run" as const,
      operation,
      digest: await deviceDigest(canonicalDeviceJSON(operation)),
    };
    const forwarded = frame<{ request: OperationRequest }>(agent);
    response = frame<{
      result: { status: string; error?: string; output?: string };
    }>(caller);
    caller.send(
      JSON.stringify({ type: "request", sessionToken: a.token, request }),
    );
    const accepted = await forwarded;
    writeFileSync(marker, "one side effect");
    await storage.exec(
      "CREATE TABLE test_operation_confirmation(sourceId TEXT PRIMARY KEY,targetId TEXT,started INTEGER DEFAULT 0,released INTEGER DEFAULT 0)",
    );
    await storage.exec(
      "INSERT INTO test_operation_confirmation(sourceId,targetId) VALUES(?,?)",
      a.deviceId,
      b.deviceId,
    );
    agent.send(
      JSON.stringify({
        type: "result",
        requestId: accepted.request.requestId,
        operationId: request.operationId,
        targetDeviceId: b.deviceId,
        result: { status: "completed", output: "fixture-private" },
      }),
    );
    const deadline = Date.now() + 2000;
    let started = false;
    while (Date.now() < deadline) {
      const rows = await storage.exec(
        "SELECT started FROM test_operation_confirmation WHERE sourceId=?",
        a.deviceId,
      );
      if (rows[0]?.started === 1) {
        started = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(started, true, "result authorization must reach the gate");
    assert.equal(
      (await call("/members/remove", a.token, { deviceId: b.deviceId })).status,
      200,
    );
    const challenge = await call("/register/challenge", undefined, {
      deviceId: b.deviceId,
      publicKey: b.publicKey,
      name: "result-rejoin-b",
      platform: "darwin",
      arch: "arm64",
    });
    assert.equal(challenge.status, 200);
    const refreshed = await call("/register/complete", undefined, {
      challengeId: challenge.body.challengeId,
      signature: sign(
        null,
        Buffer.from(challenge.body.payload),
        b.keys.privateKey,
      ).toString("base64url"),
    });
    assert.equal(refreshed.status, 200);
    assert.equal(
      (await pair(refreshed.body.sessionToken, await code(a.token))).status,
      200,
    );
    await storage.exec(
      "UPDATE test_operation_confirmation SET released=1 WHERE sourceId=?",
      a.deviceId,
    );
    const result = await response;
    assert.equal(result.result.status, "unknown");
    assert.equal(result.result.error, "membership_changed_query_original_id");
    assert.equal(result.result.output, undefined);
    assert.equal(readFileSync(marker, "utf8"), "one side effect");
  } finally {
    await storage
      .exec(
        "UPDATE test_operation_confirmation SET released=1 WHERE sourceId=?",
        a.deviceId,
      )
      .catch(() => undefined);
    await response?.catch(() => undefined);
    await storage.exec("DROP TABLE IF EXISTS test_operation_confirmation");
    caller?.terminate();
    agent.terminate();
    rmSync(marker, { force: true });
  }
});

test("slow management body cannot outlive session revocation or expiry", async () => {
  for (const expire of [false, true]) {
    const [a, b] = await Promise.all([
      identity(`slow-a-${expire}`),
      identity(`slow-b-${expire}`),
    ]);
    await pair(a.token, await code(b.token));
    const storage = await mf.unsafeGetDurableObjectStorage(
      "eagle",
      "DeviceRegistry",
      { name: "registry" },
    );
    const before = await storage.exec("SELECT count(*) n FROM pairings");
    const response = new Promise<{ status: number; body: string }>(
      (resolveResponse, reject) => {
        const req = httpRequest(
          new URL("/api/devices/v1/pairings", awaitOrigin),
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${a.token}`,
              "content-type": "application/json",
            },
          },
          (res) => {
            let body = "";
            res.on("data", (data) => (body += data.toString()));
            res.on("end", () =>
              resolveResponse({ status: res.statusCode ?? 0, body }),
            );
          },
        );
        req.on("error", reject);
        req.write('{"ttlSeconds":');
        void (async () => {
          await new Promise((resolve) => setTimeout(resolve, 70));
          if (expire)
            await storage.exec(
              "UPDATE sessions SET expires=0 WHERE deviceId=?",
              a.deviceId,
            );
          else
            assert.equal(
              (await call("/members/remove", b.token, { deviceId: a.deviceId }))
                .status,
              200,
            );
          req.end("3600}");
        })().catch(reject);
      },
    );
    const result = await response;
    assert.equal(result.status, 401, result.body);
    const after = await storage.exec("SELECT count(*) n FROM pairings");
    assert.equal(after[0].n, before[0].n);
  }
});
let awaitOrigin: string;
before(async () => {
  awaitOrigin = (await mf.ready).origin;
});

test("registration metadata changes advance grouped and ungrouped directory revision", async () => {
  const [a, b] = await Promise.all([
    identity("metadata-a"),
    identity("metadata-b"),
  ]);
  async function rename(name: string) {
    const challenge = await call("/register/challenge", undefined, {
      deviceId: a.deviceId,
      publicKey: a.publicKey,
      name,
      platform: "darwin",
      arch: "arm64",
    });
    return call("/register/complete", undefined, {
      challengeId: challenge.body.challengeId,
      signature: sign(
        null,
        Buffer.from(challenge.body.payload),
        a.keys.privateKey,
      ).toString("base64url"),
    });
  }
  const ungrouped = (await call("/directory", a.token)).body.revision;
  assert.equal((await rename("renamed-alone")).status, 200);
  assert((await call("/directory", a.token)).body.revision > ungrouped);
  await pair(a.token, await code(b.token));
  const grouped = (await call("/directory", b.token)).body.revision;
  assert.equal((await rename("renamed-grouped")).status, 200);
  assert((await call("/directory", b.token)).body.revision > grouped);
});

test("registration complete rechecks deployment quota after a challenge was issued", async () => {
  const keys = generateKeyPairSync("ed25519");
  const deviceId = randomUUID();
  const publicKey = keys.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64url");
  const challenge = await call("/register/challenge", undefined, {
    deviceId,
    publicKey,
    name: "quota-new",
    platform: "darwin",
    arch: "arm64",
  });
  assert.equal(challenge.status, 200);
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "DeviceRegistry",
    { name: "registry" },
  );
  await storage.exec(
    "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<10000-(SELECT count(*) FROM devices)) INSERT INTO devices(deviceId,publicKey,name,platform,arch) SELECT 'quota-fixture-'||n,'unused','quota-fixture','test','test' FROM seq",
  );
  try {
    const response = await call("/register/complete", undefined, {
      challengeId: challenge.body.challengeId,
      signature: sign(
        null,
        Buffer.from(challenge.body.payload),
        keys.privateKey,
      ).toString("base64url"),
    });
    assert.equal(response.status, 429);
    assert.equal(
      (
        await storage.exec(
          "SELECT count(*) n FROM devices WHERE deviceId=?",
          deviceId,
        )
      )[0].n,
      0,
    );
  } finally {
    await storage.exec("DELETE FROM devices WHERE name='quota-fixture'");
  }
});

test("pairing aliases retain original commit deadline and expired unused invitations are swept", async () => {
  const [a, b] = await Promise.all([
    identity("retention-a"),
    identity("retention-b"),
  ]);
  const invitation = await code(b.token);
  const firstId = randomUUID();
  assert.equal((await pair(a.token, invitation, firstId)).status, 200);
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "DeviceRegistry",
    { name: "registry" },
  );
  const old = Date.now() - 604800001;
  const columns = await storage.exec("PRAGMA table_info(pairings)");
  assert(
    columns.some((column) => column.name === "committed"),
    "consumed invitations need original commit timestamp",
  );
  await storage.exec(
    "UPDATE pairings SET committed=? WHERE redeemer=?",
    old,
    a.deviceId,
  );
  await storage.exec(
    "UPDATE pairing_results SET created=? WHERE deviceId=?",
    old,
    a.deviceId,
  );
  assert.equal((await pair(a.token, invitation)).status, 410);
  assert.equal(
    (await call(`/pairings/results/${firstId}`, a.token)).status,
    404,
  );
  const expired = await code(a.token);
  const { deviceDigest } = await import("../packages/contracts/src/devices.ts");
  const hash = await deviceDigest(expired);
  await storage.exec("UPDATE pairings SET expires=0 WHERE hash=?", hash);
  await code(a.token);
  assert.equal(
    (
      await storage.exec("SELECT count(*) n FROM pairings WHERE hash=?", hash)
    )[0].n,
    0,
  );
});

test("pairing transaction rollback preserves invitation and every membership/result", async () => {
  const [a, b] = await Promise.all([
    identity("rollback-a"),
    identity("rollback-b"),
  ]);
  const invitation = await code(b.token);
  const requestId = randomUUID();
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "DeviceRegistry",
    { name: "registry" },
  );
  await storage.exec(
    `CREATE TRIGGER pairing_commit_failure BEFORE INSERT ON pairing_results WHEN NEW.deviceId='${a.deviceId}' BEGIN SELECT RAISE(ABORT,'transaction fixture failure'); END`,
  );
  try {
    assert.equal((await pair(a.token, invitation, requestId)).status, 500);
    assert.equal((await call("/directory", a.token)).body.groupId, null);
    assert.equal((await call("/directory", b.token)).body.groupId, null);
    assert.equal(
      (await call(`/pairings/results/${requestId}`, a.token)).status,
      404,
    );
  } finally {
    await storage.exec("DROP TRIGGER pairing_commit_failure");
  }
  assert.equal((await pair(a.token, invitation, requestId)).status, 200);
});

test("different invitation groups racing one device commit exactly one membership", async () => {
  const [a, b, c, d, e] = await Promise.all(
    ["race-a", "race-b", "race-c", "race-d", "race-e"].map(identity),
  );
  await pair(b.token, await code(c.token));
  await pair(d.token, await code(e.token));
  const first = await code(b.token);
  const second = await code(d.token);
  const results = await Promise.all([
    pair(a.token, first),
    pair(a.token, second),
  ]);
  assert.deepEqual(results.map((x) => x.status).sort(), [200, 409]);
  const directory = (await call("/directory", a.token)).body;
  assert.equal(directory.devices.length, 3);
  const lost =
    results[0].status === 409
      ? { token: c.token, code: first }
      : { token: e.token, code: second };
  assert.equal((await pair(lost.token, lost.code)).status, 200);
});

test("a removed original redeemer can recover history after key proof without rejoining", async () => {
  const [a, b] = await Promise.all([
    identity("removed-a"),
    identity("removed-b"),
  ]);
  const invitation = await code(b.token);
  const requestId = randomUUID();
  const original = await pair(a.token, invitation, requestId);
  assert.equal(original.status, 200);
  assert.equal(
    (await call("/members/remove", b.token, { deviceId: a.deviceId })).status,
    200,
  );
  assert.equal(
    (await call(`/pairings/results/${requestId}`, a.token)).status,
    401,
  );
  const challenge = await call("/register/challenge", undefined, {
    deviceId: a.deviceId,
    publicKey: a.publicKey,
    name: "removed-a",
    platform: "darwin",
    arch: "arm64",
  });
  const refreshed = await call("/register/complete", undefined, {
    challengeId: challenge.body.challengeId,
    signature: sign(
      null,
      Buffer.from(challenge.body.payload),
      a.keys.privateKey,
    ).toString("base64url"),
  });
  assert.equal(refreshed.status, 200);
  const recovered = await pair(
    refreshed.body.sessionToken,
    invitation,
    requestId,
  );
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.groupId, original.body.groupId);
  assert.equal(recovered.body.directory.devices.length, 1);
  assert.equal(
    (await call("/directory", refreshed.body.sessionToken)).body.groupId,
    null,
  );
  assert.equal(
    (await call(`/pairings/results/${requestId}`, b.token)).status,
    404,
  );
});

test("relay rechecks Registry at forwarding after a membership change during authorization", async () => {
  const { DeviceCloud } = await import("../packages/agent/device-cloud.ts");
  const { DeviceRuntime } = await import("../packages/agent/device-runtime.ts");
  const { canonicalDeviceJSON, deviceDigest } = await import(
    "../packages/contracts/src/devices.ts"
  );
  const [a, b] = await Promise.all([
    identity("relay-race-a"),
    identity("relay-race-b"),
  ]);
  await pair(a.token, await code(b.token));
  const state = join(root, "relay-race");
  mkdirSync(state, { mode: 0o700 });
  const da = {
    deviceId: a.deviceId,
    publicKey: a.publicKey,
    name: "relay-race-a",
    platform: "darwin",
    arch: "arm64",
    groupId: null,
    membershipEpoch: 0,
    credentialVersion: 1,
  };
  const db = {
    ...da,
    deviceId: b.deviceId,
    publicKey: b.publicKey,
    name: "relay-race-b",
  };
  const ra = new DeviceRuntime(da, join(state, "a.sqlite"));
  const rb = new DeviceRuntime(db, join(state, "b.sqlite"));
  ra.setPolicy("all-approve");
  rb.setPolicy("all-approve");
  const ca = new DeviceCloud((await mf.ready).origin, da, ra, async (payload) =>
    sign(null, Buffer.from(payload), a.keys.privateKey).toString("base64url"),
  );
  const cb = new DeviceCloud((await mf.ready).origin, db, rb, async (payload) =>
    sign(null, Buffer.from(payload), b.keys.privateKey).toString("base64url"),
  );
  try {
    await Promise.all([ca.start(), cb.start()]);
    const storage = await mf.unsafeGetDurableObjectStorage(
      "eagle",
      "DeviceRegistry",
      { name: "registry" },
    );
    await storage.exec(
      "CREATE TABLE test_revoke_after_check(deviceId TEXT PRIMARY KEY)",
    );
    await storage.exec(
      "INSERT INTO test_revoke_after_check VALUES(?)",
      a.deviceId,
    );
    const path = join(state, "forbidden.txt");
    const operation = {
      kind: "file.write" as const,
      path,
      content: "unauthorized side effect",
    };
    const input = {
      requestId: randomUUID(),
      operationId: randomUUID(),
      targetDeviceId: b.deviceId,
      action: "run" as const,
      operation,
      digest: await deviceDigest(canonicalDeviceJSON(operation)),
    };
    assert.equal((await ca.execute(input)).status, "denied");
    assert.equal(
      existsSync(path),
      false,
      "revocation before forwarding must prevent target side effects",
    );
    await storage.exec("DROP TABLE test_revoke_after_check");
  } finally {
    await Promise.all([ca.close(), cb.close()]);
    await Promise.all([ra.close(), rb.close()]);
  }
});

test("failed redemption attempts persist their rate budget without changing membership or invitations", async () => {
  const a = await identity("failed-redemption-rate");
  const invitation = await code(a.token);
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "DeviceRegistry",
    { name: "registry" },
  );
  const { deviceDigest } = await import("../packages/contracts/src/devices.ts");
  const hash = await deviceDigest(invitation);
  const before = (
    await storage.exec("SELECT * FROM pairings WHERE hash=?", hash)
  )[0];
  const directory = (await call("/directory", a.token)).body;
  for (let attempt = 0; attempt < 30; attempt++)
    assert.equal((await pair(a.token, "z".repeat(43))).status, 410);
  assert.equal((await pair(a.token, "z".repeat(43))).status, 429);
  assert.deepEqual(
    (await storage.exec("SELECT * FROM pairings WHERE hash=?", hash))[0],
    before,
  );
  assert.deepEqual((await call("/directory", a.token)).body, directory);
  assert.equal(
    (
      await storage.exec(
        "SELECT count(*) n FROM pairing_results WHERE deviceId=?",
        a.deviceId,
      )
    )[0].n,
    0,
  );
});

test("target expiry during final authorization does not invalidate the source session", async () => {
  const { canonicalDeviceJSON, deviceDigest } = await import(
    "../packages/contracts/src/devices.ts"
  );
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "DeviceRegistry",
    { name: "registry" },
  );
  for (const mode of ["operation", "policy"] as const) {
    const [a, b] = await Promise.all([
      identity(`target-expiry-a-${mode}`),
      identity(`target-expiry-b-${mode}`),
    ]);
    await pair(a.token, await code(b.token));
    const agent = await rawSocket(b.deviceId, "agent");
    let caller: NativeWebSocket | undefined;
    let pending: Promise<unknown> | undefined;
    let closed: Promise<{ code: number; reason: string }> | undefined;
    try {
      const ready = frame<{ type: string }>(agent);
      agent.send(
        JSON.stringify({
          ...authentication(b.token),
          capabilities: ["command", "policy.manage"],
        }),
      );
      assert.equal((await ready).type, "ready");
      await storage.exec(
        "CREATE TABLE test_reference_precheck(targetId TEXT PRIMARY KEY,started INTEGER DEFAULT 0,released INTEGER DEFAULT 0)",
      );
      await storage.exec(
        "INSERT INTO test_reference_precheck(targetId) VALUES(?)",
        b.deviceId,
      );
      if (mode === "operation") {
        caller = await rawSocket(b.deviceId, "request");
        closed = new Promise((resolve) =>
          caller?.once("close", (code, reason) =>
            resolve({ code, reason: reason.toString() }),
          ),
        );
        const operation = { kind: "command" as const, command: "fixture" };
        pending = frame(caller);
        caller.send(
          JSON.stringify({
            type: "request",
            sessionToken: a.token,
            request: {
              requestId: randomUUID(),
              operationId: randomUUID(),
              targetDeviceId: b.deviceId,
              action: "run",
              operation,
              digest: await deviceDigest(canonicalDeviceJSON(operation)),
            },
          }),
        );
      } else {
        pending = call("/policy", a.token, {
          deviceId: b.deviceId,
          mode: "paused",
          requestId: randomUUID(),
        });
      }
      const deadline = Date.now() + 2000;
      let started = false;
      while (Date.now() < deadline) {
        const rows = await storage.exec(
          "SELECT started FROM test_reference_precheck WHERE targetId=?",
          b.deviceId,
        );
        if (rows[0]?.started === 1) {
          started = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(started, true, "target precheck barrier was not reached");
      const targetHash = createHash("sha256").update(b.token).digest("hex");
      await storage.exec(
        "UPDATE sessions SET expires=? WHERE hash=?",
        Date.now() - 1,
        targetHash,
      );
      await storage.exec(
        "UPDATE test_reference_precheck SET released=1 WHERE targetId=?",
        b.deviceId,
      );
      const outcome = await pending;
      if (mode === "operation") {
        assert.equal(
          (outcome as { result: { status: string } }).result.status,
          "denied",
        );
        const closure = await closed;
        assert.equal(closure?.code, 1000);
        assert.notEqual(closure?.reason, "unauthorized_caller");
      } else {
        assert.equal((outcome as { status: number }).status, 403);
      }
      assert.equal((await call("/directory", a.token)).status, 200);
    } finally {
      await storage
        .exec(
          "UPDATE test_reference_precheck SET released=1 WHERE targetId=?",
          b.deviceId,
        )
        .catch(() => undefined);
      await pending?.catch(() => undefined);
      await storage.exec("DROP TABLE IF EXISTS test_reference_precheck");
      caller?.terminate();
      agent.terminate();
    }
  }
});

test("reference authorization failure does not invalidate either valid credential", async () => {
  const { canonicalDeviceJSON, deviceDigest } = await import(
    "../packages/contracts/src/devices.ts"
  );
  const [a, b] = await Promise.all([
    identity("ref-failure-a"),
    identity("ref-failure-b"),
  ]);
  await pair(a.token, await code(b.token));
  const agent = await rawSocket(b.deviceId, "agent");
  let caller: NativeWebSocket | undefined;
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "DeviceRegistry",
    { name: "registry" },
  );
  try {
    const ready = frame<{ type: string }>(agent);
    agent.send(
      JSON.stringify({
        ...authentication(b.token),
        capabilities: ["command", "policy.manage"],
      }),
    );
    assert.equal((await ready).type, "ready");
    await storage.exec(
      "CREATE TABLE test_digest_failure(hash TEXT PRIMARY KEY)",
    );
    await storage.exec(
      "INSERT INTO test_digest_failure(hash) VALUES(?)",
      createHash("sha256").update(a.token).digest("hex"),
    );
    caller = await rawSocket(b.deviceId, "request");
    const closed = new Promise<{ code: number }>((resolve) =>
      caller?.once("close", (code) => resolve({ code })),
    );
    const response = frame<{ result: { status: string } }>(caller);
    const operation = { kind: "command" as const, command: "fixture" };
    caller.send(
      JSON.stringify({
        type: "request",
        sessionToken: a.token,
        request: {
          requestId: randomUUID(),
          operationId: randomUUID(),
          targetDeviceId: b.deviceId,
          action: "run",
          operation,
          digest: await deviceDigest(canonicalDeviceJSON(operation)),
        },
      }),
    );
    assert.equal((await response).result.status, "denied");
    assert.equal((await closed).code, 1000);
    assert.equal(
      (
        await call("/policy", a.token, {
          deviceId: b.deviceId,
          mode: "paused",
          requestId: randomUUID(),
        })
      ).status,
      503,
    );
    assert.equal((await call("/directory", a.token)).status, 200);
    assert.equal((await call("/directory", b.token)).status, 200);
  } finally {
    await storage.exec("DROP TABLE IF EXISTS test_digest_failure");
    caller?.terminate();
    agent.terminate();
  }
});

test("target session renews in place without interrupting an in-flight operation", async () => {
  const { canonicalDeviceJSON, deviceDigest } = await import(
    "../packages/contracts/src/devices.ts"
  );
  const [a, b] = await Promise.all([identity("renew-a"), identity("renew-b")]);
  await pair(a.token, await code(b.token));
  const challenge = await call("/register/challenge", undefined, {
    deviceId: b.deviceId,
    publicKey: b.publicKey,
    name: "renew-b",
    platform: "darwin",
    arch: "arm64",
  });
  assert.equal(challenge.status, 200);
  const refreshed = await call("/register/complete", undefined, {
    challengeId: challenge.body.challengeId,
    signature: sign(
      null,
      Buffer.from(challenge.body.payload),
      b.keys.privateKey,
    ).toString("base64url"),
  });
  assert.equal(refreshed.status, 200);
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "DeviceRegistry",
    { name: "registry" },
  );
  const oldHash = createHash("sha256").update(b.token).digest("hex");
  const newHash = createHash("sha256")
    .update(refreshed.body.sessionToken)
    .digest("hex");
  const rows = await storage.exec(
    "SELECT expires FROM sessions WHERE hash=?",
    newHash,
  );
  const newExpiry = Number(rows[0]?.expires);
  const oldExpiry = newExpiry - 1000;
  assert.equal(oldExpiry > Date.now(), true);
  await storage.exec(
    "UPDATE sessions SET expires=? WHERE hash=?",
    oldExpiry,
    oldHash,
  );
  const agent = await rawSocket(b.deviceId, "agent");
  let caller: NativeWebSocket | undefined;
  let secondCaller: NativeWebSocket | undefined;
  let response:
    | Promise<{ result: { status: string; output?: string } }>
    | undefined;
  let secondResponse: Promise<{ result: { status: string } }> | undefined;
  try {
    const ready = frame<{ type: string; expiresAt: number }>(agent);
    agent.send(JSON.stringify(authentication(b.token)));
    const initial = await ready;
    assert.equal(initial.type, "ready");
    assert.equal(initial.expiresAt, oldExpiry);
    const rejectedId = randomUUID();
    const rejected = frame<{ type: string; requestId: string; error: string }>(
      agent,
    );
    agent.send(
      JSON.stringify({
        type: "session.renew",
        requestId: rejectedId,
        sessionToken: "not-a-session",
      }),
    );
    assert.deepEqual(await rejected, {
      type: "session.renewed",
      requestId: rejectedId,
      error: "session_renewal_failed",
    });
    caller = await rawSocket(b.deviceId, "request");
    const operation = { kind: "command" as const, command: "fixture" };
    const request = {
      requestId: randomUUID(),
      operationId: randomUUID(),
      targetDeviceId: b.deviceId,
      action: "run" as const,
      operation,
      digest: await deviceDigest(canonicalDeviceJSON(operation)),
    };
    const forwarded = frame<{ request: OperationRequest }>(agent);
    response = frame<{ result: { status: string; output?: string } }>(caller);
    caller.send(
      JSON.stringify({ type: "request", sessionToken: a.token, request }),
    );
    const accepted = await forwarded;
    const renewalId = randomUUID();
    const acknowledged = frame<{
      type: string;
      requestId: string;
      expiresAt: number;
    }>(agent);
    agent.send(
      JSON.stringify({
        type: "session.renew",
        requestId: renewalId,
        sessionToken: refreshed.body.sessionToken,
      }),
    );
    const renewed = await acknowledged;
    assert.equal(renewed.type, "session.renewed");
    assert.equal(renewed.requestId, renewalId);
    assert.equal(renewed.expiresAt, newExpiry);
    assert.deepEqual(Object.keys(renewed).sort(), [
      "expiresAt",
      "requestId",
      "type",
    ]);
    const olderId = randomUUID();
    const older = frame<{ type: string; requestId: string; error: string }>(
      agent,
    );
    agent.send(
      JSON.stringify({
        type: "session.renew",
        requestId: olderId,
        sessionToken: b.token,
      }),
    );
    assert.deepEqual(await older, {
      type: "session.renewed",
      requestId: olderId,
      error: "session_renewal_failed",
    });
    await storage.exec(
      "UPDATE sessions SET expires=? WHERE hash=?",
      Date.now() - 1,
      oldHash,
    );
    agent.send(
      JSON.stringify({
        type: "result",
        requestId: accepted.request.requestId,
        operationId: request.operationId,
        targetDeviceId: b.deviceId,
        result: { status: "completed", output: "fixture-result" },
      }),
    );
    const result = await response;
    assert.equal(result.result.status, "completed");
    assert.equal(result.result.output, "fixture-result");
    assert.equal(agent.readyState, NativeWebSocket.OPEN);
    secondCaller = await rawSocket(b.deviceId, "request");
    const second = {
      ...request,
      requestId: randomUUID(),
      operationId: randomUUID(),
    };
    const secondForwarded = frame<{ request: OperationRequest }>(agent);
    secondResponse = frame<{ result: { status: string } }>(secondCaller);
    secondCaller.send(
      JSON.stringify({
        type: "request",
        sessionToken: a.token,
        request: second,
      }),
    );
    const acceptedAgain = await secondForwarded;
    agent.send(
      JSON.stringify({
        type: "result",
        requestId: acceptedAgain.request.requestId,
        operationId: second.operationId,
        targetDeviceId: b.deviceId,
        result: { status: "completed" },
      }),
    );
    assert.equal((await secondResponse).result.status, "completed");
  } finally {
    caller?.terminate();
    secondCaller?.terminate();
    agent.terminate();
    await Promise.allSettled([response, secondResponse]);
  }
});

test("dispatch and policy authorization follow a concurrent target renewal", async () => {
  const { canonicalDeviceJSON, deviceDigest } = await import(
    "../packages/contracts/src/devices.ts"
  );
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "DeviceRegistry",
    { name: "registry" },
  );
  for (const mode of ["operation", "policy"] as const) {
    const [a, b] = await Promise.all([
      identity(`renew-race-a-${mode}`),
      identity(`renew-race-b-${mode}`),
    ]);
    await pair(a.token, await code(b.token));
    const challenge = await call("/register/challenge", undefined, {
      deviceId: b.deviceId,
      publicKey: b.publicKey,
      name: `renew-race-b-${mode}`,
      platform: "darwin",
      arch: "arm64",
    });
    assert.equal(challenge.status, 200);
    const renewedToken = await call("/register/complete", undefined, {
      challengeId: challenge.body.challengeId,
      signature: sign(
        null,
        Buffer.from(challenge.body.payload),
        b.keys.privateKey,
      ).toString("base64url"),
    });
    assert.equal(renewedToken.status, 200);
    const oldHash = createHash("sha256").update(b.token).digest("hex");
    const newHash = createHash("sha256")
      .update(renewedToken.body.sessionToken)
      .digest("hex");
    const rows = await storage.exec(
      "SELECT expires FROM sessions WHERE hash=?",
      newHash,
    );
    await storage.exec(
      "UPDATE sessions SET expires=? WHERE hash=?",
      Number(rows[0]?.expires) - 1000,
      oldHash,
    );
    const agent = await rawSocket(b.deviceId, "agent");
    let caller: NativeWebSocket | undefined;
    let pending: Promise<unknown> | undefined;
    try {
      const ready = frame<{ type: string }>(agent);
      agent.send(
        JSON.stringify({
          ...authentication(b.token),
          capabilities: ["command", "policy.manage"],
        }),
      );
      assert.equal((await ready).type, "ready");
      await storage.exec(
        "CREATE TABLE test_reference_digest(hash TEXT PRIMARY KEY,started INTEGER NOT NULL DEFAULT 0,released INTEGER NOT NULL DEFAULT 0)",
      );
      const sourceHash = createHash("sha256").update(a.token).digest("hex");
      await storage.exec(
        "INSERT INTO test_reference_digest(hash) VALUES(?)",
        sourceHash,
      );
      const operation = { kind: "command" as const, command: "fixture" };
      const operationRequest = {
        requestId: randomUUID(),
        operationId: randomUUID(),
        targetDeviceId: b.deviceId,
        action: "run" as const,
        operation,
        digest: await deviceDigest(canonicalDeviceJSON(operation)),
      };
      const policyRequest = {
        requestId: randomUUID(),
        deviceId: b.deviceId,
        mode: "paused",
      };
      if (mode === "operation") {
        caller = await rawSocket(b.deviceId, "request");
        pending = frame(caller);
        caller.send(
          JSON.stringify({
            type: "request",
            sessionToken: a.token,
            request: operationRequest,
          }),
        );
      } else {
        pending = call("/policy", a.token, policyRequest);
      }
      const deadline = Date.now() + 2000;
      let started = false;
      while (Date.now() < deadline) {
        const gate = await storage.exec(
          "SELECT started FROM test_reference_digest WHERE hash=?",
          sourceHash,
        );
        if (gate[0]?.started === 1) {
          started = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(
        started,
        true,
        "source digest gate must be reached before renewal",
      );
      const renewalId = randomUUID();
      const ack = frame<{ type: string; requestId: string; expiresAt: number }>(
        agent,
      );
      agent.send(
        JSON.stringify({
          type: "session.renew",
          requestId: renewalId,
          sessionToken: renewedToken.body.sessionToken,
        }),
      );
      const renewal = await ack;
      assert.equal(renewal.type, "session.renewed");
      assert.equal(renewal.requestId, renewalId);
      assert.equal(renewal.expiresAt > Date.now(), true);
      await storage.exec(
        "UPDATE sessions SET expires=? WHERE hash=?",
        Date.now() - 1,
        oldHash,
      );
      const forwarded = frame<{
        type: string;
        relayId?: string;
        request: OperationRequest | { requestId: string };
      }>(agent);
      await storage.exec(
        "UPDATE test_reference_digest SET released=1 WHERE hash=?",
        sourceHash,
      );
      const decision = await Promise.race([
        forwarded.then((value) => ({ kind: "forwarded" as const, value })),
        pending.then((value) => ({ kind: "settled" as const, value })),
      ]);
      assert.equal(
        decision.kind,
        "forwarded",
        "a successful renewal must not deny the request",
      );
      if (decision.kind !== "forwarded")
        throw new Error("request settled before forwarding");
      const dispatched = decision.value;
      if (mode === "operation") {
        assert.equal(dispatched.type, "operation");
        agent.send(
          JSON.stringify({
            type: "result",
            requestId: dispatched.request.requestId,
            operationId: operationRequest.operationId,
            targetDeviceId: b.deviceId,
            result: { status: "completed" },
          }),
        );
        assert.equal(
          ((await pending) as { result: { status: string } }).result.status,
          "completed",
        );
      } else {
        assert.equal(dispatched.type, "policy.set");
        agent.send(
          JSON.stringify({
            type: "policy.result",
            relayId: dispatched.relayId,
            requestId: policyRequest.requestId,
            deviceId: b.deviceId,
            policy: { mode: "paused", version: 2 },
          }),
        );
        assert.equal(((await pending) as { status: number }).status, 200);
      }
    } finally {
      await storage
        .exec("UPDATE test_reference_digest SET released=1")
        .catch(() => undefined);
      caller?.terminate();
      agent.terminate();
      await pending?.catch(() => undefined);
      await storage.exec("DROP TABLE IF EXISTS test_reference_digest");
    }
  }
});

test("renewal cannot extend a session that expires during its proof check", async () => {
  const b = await identity("renew-digest-race");
  const challenge = await call("/register/challenge", undefined, {
    deviceId: b.deviceId,
    publicKey: b.publicKey,
    name: "renew-digest-race",
    platform: "darwin",
    arch: "arm64",
  });
  assert.equal(challenge.status, 200);
  const refreshed = await call("/register/complete", undefined, {
    challengeId: challenge.body.challengeId,
    signature: sign(
      null,
      Buffer.from(challenge.body.payload),
      b.keys.privateKey,
    ).toString("base64url"),
  });
  assert.equal(refreshed.status, 200);
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "DeviceRegistry",
    { name: "registry" },
  );
  const oldHash = createHash("sha256").update(b.token).digest("hex");
  const newHash = createHash("sha256")
    .update(refreshed.body.sessionToken)
    .digest("hex");
  const expiry = await storage.exec(
    "SELECT expires FROM sessions WHERE hash=?",
    newHash,
  );
  const oldExpiry = Number(expiry[0]?.expires) - 1000;
  assert.equal(oldExpiry > Date.now(), true);
  await storage.exec(
    "UPDATE sessions SET expires=? WHERE hash=?",
    oldExpiry,
    oldHash,
  );
  const agent = await rawSocket(b.deviceId, "agent");
  let response:
    | Promise<{ type: string; requestId: string; error: string }>
    | undefined;
  try {
    const ready = frame<{ type: string }>(agent);
    agent.send(JSON.stringify(authentication(b.token)));
    assert.equal((await ready).type, "ready");
    await storage.exec(
      "CREATE TABLE test_reference_digest(hash TEXT PRIMARY KEY,started INTEGER NOT NULL DEFAULT 0,released INTEGER NOT NULL DEFAULT 0)",
    );
    await storage.exec(
      "INSERT INTO test_reference_digest(hash) VALUES(?)",
      newHash,
    );
    const requestId = randomUUID();
    response = frame(agent);
    agent.send(
      JSON.stringify({
        type: "session.renew",
        requestId,
        sessionToken: refreshed.body.sessionToken,
      }),
    );
    const deadline = Date.now() + 2000;
    let started = false;
    while (Date.now() < deadline) {
      const rows = await storage.exec(
        "SELECT started FROM test_reference_digest WHERE hash=?",
        newHash,
      );
      if (rows[0]?.started === 1) {
        started = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(started, true, "renewal digest barrier was not reached");
    await storage.exec(
      "UPDATE sessions SET expires=? WHERE hash=?",
      Date.now() - 1,
      oldHash,
    );
    await storage.exec(
      "UPDATE test_reference_digest SET released=1 WHERE hash=?",
      newHash,
    );
    assert.deepEqual(await response, {
      type: "session.renewed",
      requestId,
      error: "session_renewal_failed",
    });
    const namespace = (await mf.getDurableObjectNamespace(
      "DEVICE_REGISTRY",
      "eagle",
    )) as unknown as DurableObjectNamespace;
    const registry = namespace.get(
      namespace.idFromName("registry"),
    ) as unknown as {
      bindTargetSession(
        token: string,
        target: string,
      ): Promise<{ ok: boolean }>;
    };
    assert.equal(
      (
        await registry.bindTargetSession(
          refreshed.body.sessionToken,
          b.deviceId,
        )
      ).ok,
      true,
    );
  } finally {
    await storage
      .exec("UPDATE test_reference_digest SET released=1 WHERE hash=?", newHash)
      .catch(() => undefined);
    agent.terminate();
    await response?.catch(() => undefined);
    await storage.exec("DROP TABLE IF EXISTS test_reference_digest");
  }
});

test("renewal cannot revive an expired or revoked target connection", async () => {
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "DeviceRegistry",
    { name: "registry" },
  );
  for (const kind of ["expired", "rejoined"] as const) {
    const [a, b] = await Promise.all([
      identity(`renew-invalid-a-${kind}`),
      identity(`renew-invalid-b-${kind}`),
    ]);
    await pair(a.token, await code(b.token));
    const freshToken = async () => {
      const challenge = await call("/register/challenge", undefined, {
        deviceId: b.deviceId,
        publicKey: b.publicKey,
        name: `renew-invalid-b-${kind}`,
        platform: "darwin",
        arch: "arm64",
      });
      assert.equal(challenge.status, 200);
      const result = await call("/register/complete", undefined, {
        challengeId: challenge.body.challengeId,
        signature: sign(
          null,
          Buffer.from(challenge.body.payload),
          b.keys.privateKey,
        ).toString("base64url"),
      });
      assert.equal(result.status, 200);
      return result.body.sessionToken;
    };
    const agent = await rawSocket(b.deviceId, "agent");
    try {
      const ready = frame<{ type: string }>(agent);
      agent.send(JSON.stringify(authentication(b.token)));
      assert.equal((await ready).type, "ready");
      let replacement: string;
      if (kind === "expired") {
        replacement = await freshToken();
        await storage.exec(
          "UPDATE sessions SET expires=? WHERE hash=?",
          Date.now() - 1,
          createHash("sha256").update(b.token).digest("hex"),
        );
      } else {
        assert.equal(
          (await call("/members/remove", a.token, { deviceId: b.deviceId }))
            .status,
          200,
        );
        replacement = await freshToken();
        assert.equal(
          (await pair(replacement, await code(a.token))).status,
          200,
        );
      }
      const closed = new Promise<{ code: number; reason: string }>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("renewal close timeout")),
            2000,
          );
          agent.once("close", (code, reason) => {
            clearTimeout(timer);
            resolve({ code, reason: reason.toString() });
          });
        },
      );
      agent.send(
        JSON.stringify({
          type: "session.renew",
          requestId: randomUUID(),
          sessionToken: replacement,
        }),
      );
      const result = await closed;
      assert.equal(result.code, 1008);
      assert.equal(result.reason, "revoked_agent");
    } finally {
      agent.terminate();
    }
  }
});

test("target relay retains an internal session reference instead of the bearer", async () => {
  const target = await identity("reference-target");
  const socket = await rawSocket(target.deviceId, "agent");
  try {
    const ready = frame<{ type: string }>(socket);
    socket.send(JSON.stringify(authentication(target.token)));
    assert.equal((await ready).type, "ready");
    const namespace = (await mf.getDurableObjectNamespace(
      "DEVICE_EXECUTION",
      "eagle",
    )) as unknown as DurableObjectNamespace;
    const execution = namespace.get(namespace.idFromName(target.deviceId));
    const response = await execution.fetch("https://test/test-agent-state");
    assert.deepEqual(await response.json(), {
      hasToken: false,
      hasReference: true,
    });
  } finally {
    socket.terminate();
  }
});

test("accepted uppercase UUIDs use canonical identity and the execution route", async () => {
  const { DeviceId } = await import("../packages/contracts/src/devices.ts");
  const a = await identity("case-device");
  assert.equal(DeviceId.parse(a.deviceId.toUpperCase()), a.deviceId);
  const response = await mf.dispatchFetch(
    `${base}/execution/${a.deviceId.toUpperCase()}/agent`,
  );
  assert.equal(response.status, 426);
});

async function rawSocket(
  deviceId: string,
  role: "agent" | "request",
): Promise<NativeWebSocket> {
  const url = new URL(
    `${DEVICE_PREFIX}/execution/${deviceId}/${role}`,
    (await mf.ready).origin,
  );
  url.protocol = "ws:";
  const socket = new NativeWebSocket(url);
  await new Promise<void>((resolveOpen, reject) => {
    socket.once("open", () => resolveOpen());
    socket.once("error", reject);
  });
  return socket;
}
const DEVICE_PREFIX = "/api/devices/v1";
function frame<T>(socket: NativeWebSocket): Promise<T> {
  return new Promise((resolveFrame, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", received);
      reject(new Error("test frame timeout"));
    }, 2000);
    const received = (data: NativeWebSocket.RawData) => {
      clearTimeout(timeout);
      resolveFrame(JSON.parse(data.toString()) as T);
    };
    socket.once("message", received);
  });
}
const authentication = (token: string) => ({
  type: "authenticate",
  sessionToken: token,
  capabilities: ["command"],
  policy: { mode: "all-approve", version: 1 },
});

test("relay correlation is generated per forwarding and cannot leak an old result to reused caller IDs", async () => {
  const [a, b, c] = await Promise.all(
    ["correlation-a", "correlation-b", "correlation-c"].map(identity),
  );
  await pair(a.token, await code(b.token));
  await pair(c.token, await code(b.token));
  const agent = await rawSocket(b.deviceId, "agent");
  const ready = frame<{ type: string }>(agent);
  agent.send(JSON.stringify(authentication(b.token)));
  assert.equal((await ready).type, "ready");
  let callerA: NativeWebSocket | undefined;
  let callerC: NativeWebSocket | undefined;
  try {
    const requestId = randomUUID();
    const operationId = randomUUID();
    const { deviceDigest, canonicalDeviceJSON } = await import(
      "../packages/contracts/src/devices.ts"
    );
    const operation = {
      kind: "command" as const,
      command: "printf source-a-private-result",
    };
    const request = {
      requestId,
      operationId,
      targetDeviceId: b.deviceId,
      action: "run" as const,
      operation,
      digest: await deviceDigest(canonicalDeviceJSON(operation)),
    };
    callerA = await rawSocket(b.deviceId, "request");
    const firstFrame = frame<{ request: OperationRequest }>(agent);
    callerA.send(
      JSON.stringify({ type: "request", sessionToken: a.token, request }),
    );
    const first = await firstFrame;
    const closed = new Promise<void>((resolveClosed) =>
      callerA?.once("close", () => resolveClosed()),
    );
    callerA.close();
    await closed;
    callerC = await rawSocket(b.deviceId, "request");
    const response = frame<{
      requestId: string;
      result: { status: string; output?: string };
    }>(callerC);
    const secondFrame = frame<{ request: OperationRequest }>(agent);
    callerC.send(
      JSON.stringify({
        type: "request",
        sessionToken: c.token,
        request: { ...request, action: "get" },
      }),
    );
    const second = await secondFrame;
    agent.send(
      JSON.stringify({
        type: "result",
        requestId: first.request.requestId,
        operationId,
        targetDeviceId: b.deviceId,
        result: { status: "completed", output: "source-a-private-result" },
      }),
    );
    agent.send(
      JSON.stringify({
        type: "result",
        requestId: second.request.requestId,
        operationId,
        targetDeviceId: b.deviceId,
        result: { status: "denied", error: "operation_source_mismatch" },
      }),
    );
    const answer = await response;
    assert.equal(answer.result.status, "denied");
    assert.equal(answer.requestId, requestId);
    assert.notEqual(first.request.requestId, second.request.requestId);
    assert.notEqual(first.request.requestId, requestId);
  } finally {
    callerA?.terminate();
    callerC?.terminate();
    agent.terminate();
  }
});

test("closed sockets cannot revive after Registry RPC and Agent queue admission is bounded", async () => {
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "DeviceRegistry",
    { name: "registry" },
  );
  await storage.exec(
    "CREATE TABLE test_check_delay(deviceId TEXT PRIMARY KEY,started INTEGER NOT NULL DEFAULT 0)",
  );
  try {
    for (const flood of ["none", "frames", "bytes"]) {
      const a = await identity(`closed-auth-${flood}`);
      await storage.exec(
        "INSERT INTO test_check_delay(deviceId) VALUES(?)",
        a.deviceId,
      );
      const socket = await rawSocket(a.deviceId, "agent");
      let remoteClosed = false;
      socket.once("close", () => {
        remoteClosed = true;
      });
      socket.send(JSON.stringify(authentication(a.token)));
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        const started = await storage.exec(
          "SELECT started FROM test_check_delay WHERE deviceId=?",
          a.deviceId,
        );
        if (started[0].started === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (flood !== "none") {
        for (let i = 0; i < (flood === "frames" ? 32 : 3); i++)
          socket.send(
            JSON.stringify({
              type: "heartbeat",
              ...(flood === "bytes" ? { padding: "x".repeat(500000) } : {}),
              capabilities: ["command"],
              policy: { mode: "all-approve", version: 1 },
            }),
          );
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(
          remoteClosed,
          true,
          "queued frame count must be bounded before Registry RPC resolves",
        );
      } else {
        socket.close();
        await new Promise<void>((resolveClosed) =>
          socket.once("close", () => resolveClosed()),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 550));
      assert.notEqual(
        (await call("/directory", a.token)).body.devices[0].online,
        true,
        "closed authentication must never create a live agent",
      );
      socket.terminate();
      await storage.exec(
        "DELETE FROM test_check_delay WHERE deviceId=?",
        a.deviceId,
      );
    }
  } finally {
    await storage.exec("DROP TABLE test_check_delay");
  }
});

test("directory revalidates the original session after awaited device observations", async () => {
  const [a, b] = await Promise.all([
    identity("directory-race-a"),
    identity("directory-race-b"),
  ]);
  await pair(a.token, await code(b.token));
  const execution = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "DeviceExecution",
    { name: a.deviceId },
  );
  await execution.exec("CREATE TABLE test_observation_delay(started INTEGER)");
  await execution.exec("INSERT INTO test_observation_delay VALUES(0)");
  try {
    const reading = call("/directory", a.token);
    const deadline = Date.now() + 1000;
    let started = false;
    while (Date.now() < deadline) {
      if (
        (await execution.exec("SELECT started FROM test_observation_delay"))[0]
          .started === 1
      ) {
        started = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(started, true);
    assert.equal(
      (await call("/members/remove", b.token, { deviceId: a.deviceId })).status,
      200,
    );
    assert.equal(
      (await reading).status,
      401,
      "a revoked caller must not receive the old group after observation awaits",
    );
  } finally {
    await execution.exec("DROP TABLE test_observation_delay");
  }
});

test("caller authentication closure refreshes the cached session without an HTTP probe", async () => {
  const { DeviceCloud } = await import("../packages/agent/device-cloud.ts");
  const { DeviceRuntime } = await import("../packages/agent/device-runtime.ts");
  const { canonicalDeviceJSON, deviceDigest } = await import(
    "../packages/contracts/src/devices.ts"
  );
  const identityA = await identity("caller-refresh");
  const device = {
    deviceId: identityA.deviceId,
    publicKey: identityA.publicKey,
    name: "caller-refresh",
    platform: "darwin",
    arch: "arm64",
    groupId: null,
    membershipEpoch: 0,
    credentialVersion: 1,
  };
  const runtime = new DeviceRuntime(
    device,
    join(root, "caller-refresh.sqlite"),
  );
  runtime.setPolicy("all-approve");
  let signatures = 0;
  const cloud = new DeviceCloud(
    (await mf.ready).origin,
    device,
    runtime,
    async (payload) => {
      signatures++;
      return sign(
        null,
        Buffer.from(payload),
        identityA.keys.privateKey,
      ).toString("base64url");
    },
  );
  try {
    const operation = {
      kind: "command" as const,
      command: "printf fresh-session",
    };
    const request = {
      requestId: randomUUID(),
      operationId: randomUUID(),
      targetDeviceId: device.deviceId,
      action: "run" as const,
      operation,
      digest: await deviceDigest(canonicalDeviceJSON(operation)),
    };
    assert.equal((await cloud.execute(request)).status, "unknown");
    const registry = await mf.unsafeGetDurableObjectStorage(
      "eagle",
      "DeviceRegistry",
      { name: "registry" },
    );
    await registry.exec(
      "UPDATE sessions SET expires=0 WHERE deviceId=?",
      device.deviceId,
    );
    const expired = await cloud.execute(request);
    assert.equal(
      expired.status,
      "denied",
      `expired caller result: ${expired.error ?? "none"}`,
    );
    // Let the received close frame finish; a denied result never retries the run.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const refreshed = await cloud.execute({
      ...request,
      requestId: randomUUID(),
    });
    assert.equal(refreshed.status, "unknown");
    assert.equal(refreshed.error, "target_offline");
    assert.equal(signatures, 2);
  } finally {
    await cloud.close();
    await runtime.close();
  }
});
