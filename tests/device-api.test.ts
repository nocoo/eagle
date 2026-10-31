import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
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
 fetch(request){const url=new URL(request.url);if(url.pathname==='/test-close'){this.agent?.socket.close(Number(url.searchParams.get('code')),url.searchParams.get('reason'));return new Response('closed');}return super.fetch(request);}
 observation(){const observation=super.observation();
  if(this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='test_observation_delay'").toArray().length){this.ctx.storage.sql.exec("UPDATE test_observation_delay SET started=1");return new Promise(resolve=>setTimeout(()=>resolve(observation),500));}
  return observation;
 }
}
export class DeviceRegistry extends Registry {
 async check(token,targetId){const result=await super.check(token,targetId);
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
});
after(async () => {
  await mf?.dispose();
  rmSync(root, { recursive: true, force: true });
});

async function policyService(
  owner: Awaited<ReturnType<typeof identity>>,
  stateDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const socketPath = join(stateDirectory, "port.sock");
  const child = spawn(process.execPath, ["packages/agent/device-service.ts"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: environment,
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
      baseUrl: (await mf.ready).origin,
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
      child.stdin.write(
        `${JSON.stringify({ type: "manage", requestId, method, params })}\n`,
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
          `${JSON.stringify({ requestId: randomUUID(), method, params })}\n`,
        );
      });
    },
  };
}

test("paired private services expose current sync identity without treating execution policy as Bot sharing", async () => {
  const [a, b] = await Promise.all([identity("sync-a"), identity("sync-b")]);
  assert.notEqual(a.publicKey, b.publicKey);
  const source = await policyService(a, join(root, "sync-a"));
  const cli = join(root, "sync-cli");
  mkdirSync(cli, { mode: 0o700 });
  const binary = join(cli, "tailscale");
  writeFileSync(
    binary,
    `#!/bin/sh\n[ "$1" = status ] && [ "$2" = --json ] || exit 2\nprintf '%s' '{"BackendState":"Running","Self":{"TailscaleIPs":["100.64.1.2","fd7a:115c:a1e0::12","100.64.1.2"]},"Peer":{"other":{"TailscaleIPs":["100.64.9.9"]}}}'\n`,
  );
  chmodSync(binary, 0o700);
  const target = await policyService(b, join(root, "sync-b"), {
    ...process.env,
    PATH: `${cli}:${process.env.PATH}`,
  });
  try {
    const invitation = await source.call("pairing.create", {});
    assert.equal(invitation.error, undefined);
    const joined = await target.call("pairing.redeem", {
      requestId: randomUUID(),
      code: (invitation.result as { code: string }).code,
    });
    assert.equal(joined.error, undefined);
    const groupId = (joined.result as { groupId: string }).groupId;
    assert.equal(typeof groupId, "string");
    for (const [service, owner] of [
      [source, a],
      [target, b],
    ] as const) {
      const directory = (await service.port("directory")).result as {
        localDeviceId: string;
        groupId: string;
        devices: {
          deviceId: string;
          publicKey: string;
          membershipEpoch: number;
          credentialVersion: number;
        }[];
      };
      assert.equal(directory.localDeviceId, owner.deviceId);
      assert.equal(directory.groupId, groupId);
      assert.deepEqual(
        directory.devices.map((d) => d.deviceId).sort(),
        [a.deviceId, b.deviceId].sort(),
      );
      const current = directory.devices.find(
        (d) => d.deviceId === owner.deviceId,
      );
      assert.equal(current?.publicKey, owner.publicKey);
      assert.ok(
        current && current.membershipEpoch > 0 && current.credentialVersion > 0,
      );
      assert.equal(
        ((await service.port("status")).result as { localReady: boolean })
          .localReady,
        true,
      );
    }
    const storage = await mf.unsafeGetDurableObjectStorage(
      "eagle",
      "DeviceRegistry",
      { name: "registry" },
    );
    const sql = await storage.exec(
      "SELECT deviceId,groupId,membershipEpoch,credentialVersion FROM devices WHERE deviceId IN (?,?) ORDER BY deviceId",
      a.deviceId,
      b.deviceId,
    );
    assert.equal(
      JSON.stringify(sql).includes(groupId),
      true,
      "actual Registry SQLite retains the paired group",
    );
    const response = await source.port("sync.identity");
    assert.equal(
      (response.result as { version?: number } | undefined)?.version,
      1,
      JSON.stringify(response),
    );
    const sharedBotId = randomUUID();
    const access = {
      sharedBotId,
      peerDeviceId: b.deviceId,
      purpose: "replica.read",
    };
    const share = { sharedBotId, peerDeviceId: a.deviceId, enabled: true };
    assert.equal(
      (response.result as { identity: { deviceId: string } }).identity.deviceId,
      a.deviceId,
    );
    assert.equal(
      (await source.port("sync.access", access)).error,
      "sync_not_shared",
      "same-group all-approve never shares Bot history",
    );
    assert.equal(
      (await source.port("sync.incoming", {})).error,
      "management_requires_private_helper",
    );
    const emptyIncoming = await source.call("sync.incoming", {});
    assert.equal(
      emptyIncoming.error,
      undefined,
      "trusted incoming discovery reaches the actual Registry",
    );
    assert.deepEqual((emptyIncoming.result as { items: unknown[] }).items, []);
    assert.equal(
      (await target.port("sync.share", share)).error,
      "management_requires_private_helper",
    );
    assert.equal(
      (await target.port("sync.endpoints.publish", { syncPort: null })).error,
      "management_requires_private_helper",
    );
    assert.equal((await target.call("sync.share", share)).error, undefined);
    const grantsBefore = await storage.exec(
      "SELECT * FROM sync_grants WHERE sharedBotId=?",
      sharedBotId,
    );
    assert.equal((await target.call("sync.share", share)).error, undefined);
    assert.deepEqual(
      await storage.exec(
        "SELECT * FROM sync_grants WHERE sharedBotId=?",
        sharedBotId,
      ),
      grantsBefore,
      "same explicit grant is idempotent",
    );
    const allowed = await source.port("sync.access", access);
    assert.equal(allowed.error, undefined, JSON.stringify(allowed));
    const metadata = allowed.result as {
      local: { deviceId: string };
      peer: { deviceId: string };
      endpoints: unknown;
    };
    assert.equal(metadata.local.deviceId, a.deviceId);
    assert.equal(metadata.peer.deviceId, b.deviceId);
    assert.equal(metadata.endpoints, null);
    const incoming = (await source.call("sync.incoming", {})).result as {
      version: number;
      local: unknown;
      items: { sharedBotId: string; holder: unknown }[];
      nextAfter: number;
      hasMore: boolean;
    };
    assert.equal(incoming.version, 1);
    assert.deepEqual(incoming.local, metadata.local);
    assert.deepEqual(incoming.items, [{ sharedBotId, holder: metadata.peer }]);
    assert.ok(incoming.nextAfter > 0);
    assert.equal(incoming.hasMore, false);
    const staleShare = randomUUID(),
      laterShare = randomUUID();
    await storage.exec(
      "INSERT INTO sync_grants VALUES(?,?,?,?)",
      b.deviceId,
      staleShare,
      a.deviceId,
      "stale full identity",
    );
    await storage.exec(
      "INSERT INTO sync_grants VALUES(?,?,?,?)",
      b.deviceId,
      laterShare,
      a.deviceId,
      JSON.stringify([metadata.peer, metadata.local]),
    );
    const staleWindow = (
      await source.call("sync.incoming", {
        after: incoming.nextAfter,
        limit: 1,
      })
    ).result as typeof incoming;
    assert.deepEqual(staleWindow.items, []);
    assert.equal(staleWindow.hasMore, true);
    assert.ok(
      staleWindow.nextAfter > incoming.nextAfter,
      "cursor advances over the actual inspected stale row",
    );
    const tailWindow = (
      await source.call("sync.incoming", {
        after: staleWindow.nextAfter,
        limit: 1,
      })
    ).result as typeof incoming;
    assert.deepEqual(tailWindow.items, [
      { sharedBotId: laterShare, holder: metadata.peer },
    ]);
    assert.equal(tailWindow.hasMore, false);
    await storage.exec(
      "DELETE FROM sync_grants WHERE sharedBotId IN (?,?)",
      staleShare,
      laterShare,
    );
    await storage.exec(
      "ALTER TABLE sync_grants RENAME TO owned_unavailable_sync_grants",
    );
    try {
      const unavailable = await call("/sync/incoming", a.token, {});
      assert.equal(unavailable.status, 503);
      assert.deepEqual(unavailable.body, {
        error: "sync_directory_storage_failed",
      });
      assert.equal(
        (await source.call("sync.incoming", {})).error,
        "sync_directory_storage_failed",
        "real SQL failure is never an empty directory",
      );
    } finally {
      await storage.exec(
        "ALTER TABLE owned_unavailable_sync_grants RENAME TO sync_grants",
      );
    }
    assert.deepEqual(
      ((await source.call("sync.incoming", {})).result as typeof incoming)
        .items,
      incoming.items,
    );
    const beforePublish = Date.now();
    assert.equal(
      (await target.call("sync.endpoints.publish", { syncPort: 7015 })).error,
      undefined,
    );
    const published = (await source.port("sync.access", access)).result as {
      peer: unknown;
      endpoints: {
        identity: unknown;
        publishedAt: number;
        candidates: unknown[];
      };
    };
    assert.deepEqual(published.endpoints.identity, published.peer);
    assert.ok(
      published.endpoints.publishedAt >= beforePublish &&
        published.endpoints.publishedAt <= Date.now(),
    );
    assert.deepEqual(published.endpoints.candidates, [
      { address: "100.64.1.2", port: 7015 },
      { address: "fd7a:115c:a1e0::12", port: 7015 },
    ]);
    assert.equal(
      (
        await target.port("sync.access", {
          ...access,
          peerDeviceId: a.deviceId,
        })
      ).error,
      "sync_not_shared",
      "grant is directional",
    );
    assert.equal(
      (
        await source.port("sync.access", {
          ...access,
          sharedBotId: randomUUID(),
        })
      ).error,
      "sync_not_shared",
    );
    const outsider = await identity("sync-outsider");
    assert.equal(
      (
        await source.port("sync.access", {
          ...access,
          peerDeviceId: outsider.deviceId,
        })
      ).error,
      "different_group",
    );
    for (const extra of [
      { deviceId: b.deviceId },
      { groupId },
      { targetDeviceId: a.deviceId },
      { purpose: "execute" },
    ])
      assert.equal(
        (await call("/sync/access", a.token, { ...access, ...extra })).status,
        400,
      );
    assert.equal((await call("/sync/access", "forged", access)).status, 401);
    assert.equal(
      (await target.call("sync.endpoints.publish", { syncPort: null })).error,
      undefined,
    );
    const withdrawn = (await source.port("sync.access", access)).result as {
      endpoints: {
        publishedAt: number;
        candidates: unknown[];
        identity: { deviceId: string };
      };
    };
    assert.deepEqual(withdrawn.endpoints.candidates, []);
    assert.equal(withdrawn.endpoints.identity.deviceId, b.deviceId);
    assert.ok(withdrawn.endpoints.publishedAt > 0);
    assert.equal(
      (
        await target.call("sync.endpoints.publish", {
          syncPort: 7015,
          address: "100.64.0.1",
        })
      ).error,
      "device_service_failed",
    );
    assert.equal(
      (
        await call("/sync/endpoints", a.token, {
          deviceId: b.deviceId,
          candidates: [],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call("/sync/endpoints", b.token, {
          candidates: [{ address: "192.168.1.1", port: 7015 }],
        })
      ).status,
      400,
    );
    assert.equal(
      (await target.call("sync.share", { ...share, enabled: false })).error,
      undefined,
    );
    assert.equal(
      (await source.port("sync.access", access)).error,
      "sync_not_shared",
    );
    await target.call("sync.share", share);
    await storage.exec(
      "UPDATE devices SET membershipEpoch=membershipEpoch+1 WHERE deviceId=?",
      b.deviceId,
    );
    assert.equal(
      (await source.port("sync.access", access)).error,
      "sync_not_shared",
      "current peer epoch invalidates grant and publication",
    );
    assert.deepEqual(
      ((await source.call("sync.incoming", {})).result as typeof incoming)
        .items,
      [],
      "old full-identity grants cannot be advertised as current",
    );
    await target.call("sync.share", share);
    assert.equal(
      (
        (await source.port("sync.access", access)).result as {
          endpoints: unknown;
        }
      ).endpoints,
      null,
    );
    await storage.exec(
      "UPDATE devices SET credentialVersion=credentialVersion+1 WHERE deviceId=?",
      b.deviceId,
    );
    assert.equal(
      (await source.port("sync.access", access)).error,
      "sync_not_shared",
      "peer credentials are rechecked on every access",
    );
    assert.equal(
      (await target.call("sync.share", share)).error,
      "revoked_session",
    );
    assert.equal((await target.call("sync.share", share)).error, undefined);
    assert.equal((await source.port("sync.access", access)).error, undefined);
    assert.equal(
      (await source.call("member.remove", { deviceId: b.deviceId })).error,
      undefined,
    );
    assert.equal(
      (await source.port("sync.access", access)).error,
      "different_group",
    );
    const rejoin = await source.call("pairing.create", {});
    assert.equal(
      (
        await target.call("pairing.redeem", {
          requestId: randomUUID(),
          code: (rejoin.result as { code: string }).code,
        })
      ).error,
      "revoked_session",
    );
    assert.equal(
      (
        await target.call("pairing.redeem", {
          requestId: randomUUID(),
          code: (rejoin.result as { code: string }).code,
        })
      ).error,
      undefined,
    );
    assert.equal(
      (await source.port("sync.access", access)).error,
      "sync_not_shared",
      "re-pair never resurrects old grant",
    );
    assert.equal((await target.call("sync.share", share)).error, undefined);
    assert.equal((await source.port("sync.access", access)).error, undefined);
  } finally {
    await source.stop();
    await target.stop();
  }
});

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
    assert.equal(result.error, "revoked_agent");
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
    assert.equal((await cloud.execute(request)).status, "denied");
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

test("sync decisions recheck current sessions, grant revocation and both peer bindings after a slow body", async () => {
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "DeviceRegistry",
    { name: "registry" },
  );
  for (const change of [
    "session",
    "expiry",
    "epoch",
    "credential",
    "grant",
  ] as const) {
    const [a, b] = await Promise.all([
      identity(`sync-race-a-${change}`),
      identity(`sync-race-b-${change}`),
    ]);
    await pair(a.token, await code(b.token));
    const sharedBotId = randomUUID();
    const share = { sharedBotId, peerDeviceId: a.deviceId, enabled: true };
    assert.equal((await call("/sync/share", b.token, share)).status, 200);
    const input = JSON.stringify({
      sharedBotId,
      peerDeviceId: b.deviceId,
      purpose: "replica.read",
    });
    assert.equal(
      (await call("/sync/access", a.token, JSON.parse(input))).status,
      200,
    );
    const response = new Promise<{ status: number; body: string }>(
      (done, reject) => {
        const req = httpRequest(
          new URL("/api/devices/v1/sync/access", awaitOrigin),
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${a.token}`,
              "content-type": "application/json",
            },
          },
          (res) => {
            let body = "";
            res.on("data", (part) => (body += part));
            res.on("end", () => done({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on("error", reject);
        req.write(input.slice(0, -1));
        void (async () => {
          await new Promise((resolve) => setTimeout(resolve, 70));
          if (change === "session")
            assert.equal(
              (await call("/members/remove", b.token, { deviceId: a.deviceId }))
                .status,
              200,
            );
          if (change === "expiry")
            await storage.exec(
              "UPDATE sessions SET expires=0 WHERE deviceId=?",
              a.deviceId,
            );
          if (change === "epoch")
            await storage.exec(
              "UPDATE devices SET membershipEpoch=membershipEpoch+1 WHERE deviceId=?",
              b.deviceId,
            );
          if (change === "credential")
            await storage.exec(
              "UPDATE devices SET credentialVersion=credentialVersion+1 WHERE deviceId=?",
              b.deviceId,
            );
          if (change === "grant")
            assert.equal(
              (await call("/sync/share", b.token, { ...share, enabled: false }))
                .status,
              200,
            );
          req.end("}");
        })().catch((error) => {
          req.destroy();
          reject(error);
        });
      },
    );
    const result = await response;
    assert.equal(
      result.status,
      change === "session" || change === "expiry" ? 401 : 403,
      result.body,
    );
  }
});
