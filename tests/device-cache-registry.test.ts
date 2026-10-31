import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { syncDescriptorPayload } from "../packages/contracts/src/device-objects.ts";
import { canonicalDeviceJSON } from "../packages/contracts/src/devices.ts";
import { workerFixture } from "./device-integration/device-fixtures.ts";

mkdirSync(".local", { recursive: true });

test("Registry descriptor winner, current grant and cache authority bind actual metadata operations", {
  timeout: 30000,
}, async () => {
  const root = mkdtempSync(resolve(".local/cache-registry-"));
  const worker = await workerFixture(root);
  const origin = worker.origin;
  const call = (path: string, token?: string, value?: unknown) =>
    worker.mf.dispatchFetch(origin + "/api/devices/v1" + path, {
      method: value === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
  const register = async () => {
    const keys = generateKeyPairSync("ed25519");
    const deviceId = randomUUID();
    const publicKey = keys.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64url");
    const challenge = (await (
      await call("/register/challenge", undefined, {
        deviceId,
        publicKey,
        name: "cache-fixture",
        platform: "darwin",
        arch: "arm64",
      })
    ).json()) as { challengeId: string; payload: string };
    const result = await call("/register/complete", undefined, {
      challengeId: challenge.challengeId,
      signature: sign(
        null,
        Buffer.from(challenge.payload),
        keys.privateKey,
      ).toString("base64url"),
    });
    assert.equal(result.status, 200);
    const { sessionToken } = (await result.json()) as { sessionToken: string };
    return { keys, deviceId, publicKey, token: sessionToken };
  };
  try {
    const a = await register(),
      b = await register();
    const invitation = (await (
      await call("/pairings", a.token, {})
    ).json()) as { code: string };
    assert.equal(
      (
        await call("/pairings/redeem", b.token, {
          requestId: randomUUID(),
          code: invitation.code,
        })
      ).status,
      200,
    );
    const identity = (
      (await (await call("/sync/identity", a.token)).json()) as {
        identity: Record<string, unknown>;
      }
    ).identity;
    const sharedBotId = randomUUID();
    const access = {
      sharedBotId,
      peerDeviceId: a.deviceId,
      purpose: "replica.read",
    };
    const wrapping = generateKeyPairSync("x25519")
      .publicKey.export({ type: "spki", format: "der" })
      .subarray(-32);
    const body = {
      version: 1,
      purpose: "replica.wrap",
      registryOrigin: origin,
      deviceId: a.deviceId,
      publicKey: a.publicKey,
      credentialVersion: 1,
      keyId: createHash("sha256").update(wrapping).digest("hex"),
      wrappingPublicKey: wrapping.toString("base64url"),
    };
    const descriptor = {
      ...body,
      signature: sign(
        null,
        Buffer.from(syncDescriptorPayload(body)),
        a.keys.privateKey,
      ).toString("base64url"),
    };
    const publish = { version: 1, identity, descriptor };
    const initial = await call("/sync/keys/publish", a.token, publish);
    assert.equal(initial.status, 200);
    const winner = await initial.json();
    const retries = await Promise.all([
      call("/sync/keys/publish", a.token, publish),
      call("/sync/keys/publish", a.token, publish),
    ]);
    for (const response of retries) {
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), winner);
    }
    const damaged = {
      ...publish,
      descriptor: { ...descriptor, signature: "A".repeat(86) },
    };
    assert.equal(
      (await call("/sync/keys/publish", a.token, damaged)).status,
      403,
    );
    const differentWrap = generateKeyPairSync("x25519")
      .publicKey.export({ type: "spki", format: "der" })
      .subarray(-32);
    const differentBody = {
      ...body,
      wrappingPublicKey: differentWrap.toString("base64url"),
      keyId: createHash("sha256").update(differentWrap).digest("hex"),
    };
    assert.equal(
      (
        await call("/sync/keys/publish", a.token, {
          ...publish,
          descriptor: {
            ...differentBody,
            signature: sign(
              null,
              Buffer.from(syncDescriptorPayload(differentBody)),
              a.keys.privateKey,
            ).toString("base64url"),
          },
        })
      ).status,
      409,
    );
    assert.equal(
      (await call("/sync/keys/lookup", b.token, access)).status,
      403,
    );
    assert.equal(
      (
        await call("/sync/share", b.token, {
          sharedBotId,
          peerDeviceId: a.deviceId,
          enabled: true,
        })
      ).status,
      200,
    );
    const lookup = await call("/sync/keys/lookup", b.token, access);
    assert.equal(lookup.status, 200);
    assert.deepEqual(await lookup.json(), winner);
    const storage = await worker.mf.unsafeGetDurableObjectStorage(
      "eagle",
      "DeviceRegistry",
      { name: "registry" },
    );
    const stored = await storage.exec(
      "SELECT * FROM sync_wrapping_keys WHERE deviceId=?",
      a.deviceId,
    );
    await storage.exec(
      "UPDATE sync_wrapping_keys SET descriptor=? WHERE deviceId=?",
      JSON.stringify(damaged.descriptor),
      a.deviceId,
    );
    assert.equal(
      (await call("/sync/keys/lookup", b.token, access)).status,
      403,
    );
    assert.equal(
      (await call("/sync/keys/publish", a.token, publish)).status,
      403,
    );
    await storage.exec(
      "UPDATE sync_wrapping_keys SET descriptor=? WHERE deviceId=?",
      String(stored[0]?.descriptor),
      a.deviceId,
    );
    await storage.exec(
      "UPDATE devices SET membershipEpoch=membershipEpoch+1 WHERE deviceId=?",
      a.deviceId,
    );
    assert.equal(
      (await call("/sync/keys/lookup", b.token, access)).status,
      403,
    );
    await storage.exec(
      "UPDATE devices SET membershipEpoch=membershipEpoch-1 WHERE deviceId=?",
      a.deviceId,
    );
    await storage.exec(
      "CREATE TABLE test_descriptor_gate(started INTEGER,released INTEGER)",
    );
    for (const field of [
      "membershipEpoch",
      "credentialVersion",
      "groupId",
    ] as const) {
      await storage.exec("DELETE FROM test_descriptor_gate");
      await storage.exec("INSERT INTO test_descriptor_gate VALUES(0,0)");
      const before = await storage.exec(
        "SELECT * FROM sync_wrapping_keys WHERE deviceId=?",
        a.deviceId,
      );
      const device = (
        await storage.exec("SELECT * FROM devices WHERE deviceId=?", a.deviceId)
      )[0];
      assert(device);
      const pending = call("/sync/keys/publish", a.token, publish);
      const end = Date.now() + 12000;
      while (
        !(await storage.exec("SELECT started FROM test_descriptor_gate"))[0]
          ?.started
      ) {
        assert(Date.now() < end);
        await new Promise((r) => setTimeout(r, 10));
      }
      await storage.exec(
        `UPDATE devices SET ${field}=? WHERE deviceId=?`,
        field === "groupId" ? randomUUID() : Number(device[field]) + 1,
        a.deviceId,
      );
      await storage.exec("UPDATE test_descriptor_gate SET released=1");
      const rejected = await pending;
      assert.equal(rejected.status, field === "credentialVersion" ? 401 : 403);
      assert.deepEqual(
        await storage.exec(
          "SELECT * FROM sync_wrapping_keys WHERE deviceId=?",
          a.deviceId,
        ),
        before,
      );
      await storage.exec(
        `UPDATE devices SET ${field}=? WHERE deviceId=?`,
        device[field] as string | number,
        a.deviceId,
      );
    }
    await storage.exec("DROP TABLE test_descriptor_gate");
    console.log(
      JSON.stringify({
        kind: "cache-authority-real-prerequisites",
        independentEd: true,
        sqlite: true,
        paired: true,
        descriptorWinner: true,
        corruptRejected: true,
        groupEpochBound: true,
        grant: "B->A",
      }),
    );
    const request = {
      version: 1,
      operation: "publish",
      sharedBotId,
      peerDeviceId: a.deviceId,
      requestDigest: createHash("sha256")
        .update(
          canonicalDeviceJSON({
            operation: "publish",
            sharedBotId,
            objectId: "fixture",
          }),
        )
        .digest("hex"),
    };
    const minted = await call("/sync/cache/authority", b.token, request);
    assert.equal(
      minted.status,
      200,
      "current uploader session mints dedicated exact-operation authority",
    );
    const authority = (await minted.json()) as {
      authority: string;
      uploader: { deviceId: string };
      recipient: { deviceId: string };
      expiresAt: number;
    };
    assert.equal(authority.uploader.deviceId, b.deviceId);
    assert.equal(authority.recipient.deviceId, a.deviceId);
    assert.match(authority.authority, /^[A-Za-z0-9_-]{43}$/);
    assert(
      authority.expiresAt > Date.now() &&
        authority.expiresAt <= Date.now() + 60000,
    );
    const namespace = (await worker.mf.getDurableObjectNamespace(
      "DEVICE_REGISTRY",
      "eagle",
    )) as unknown as {
      idFromName(name: string): string;
      get(id: string): unknown;
    };
    const registry = namespace.get(
      namespace.idFromName("registry"),
    ) as unknown as {
      checkCacheAuthority(
        input: unknown,
      ): Promise<{ ok: boolean; status?: number }>;
      cacheSqlCausePreserved(): Promise<boolean>;
    };
    const scope = {
      authority: authority.authority,
      operation: request.operation,
      sharedBotId,
      requestDigest: request.requestDigest,
    };
    assert.equal((await registry.checkCacheAuthority(scope)).ok, true);
    const authorityRows = await storage.exec(
      "SELECT * FROM sync_cache_authorities",
    );
    assert(authorityRows.length > 0);
    await storage.exec(
      "ALTER TABLE sync_cache_authorities RENAME TO owned_unavailable_authorities",
    );
    try {
      let rpcError: unknown;
      const observed = await registry
        .checkCacheAuthority(scope)
        .catch((error: unknown) => {
          rpcError = error;
          return undefined;
        });
      console.log(
        JSON.stringify({
          kind: "real-registry-cache-sql-refusal",
          reply: observed,
        }),
      );
      assert.equal(
        observed,
        undefined,
        "actual SQL fault must reject RPC, not deny authority",
      );
      assert(rpcError instanceof Error);
      assert.equal(rpcError.message.includes("no such table"), false);
      assert.equal(await registry.cacheSqlCausePreserved(), true);
    } finally {
      await storage.exec(
        "ALTER TABLE owned_unavailable_authorities RENAME TO sync_cache_authorities",
      );
      assert.deepEqual(
        await storage.exec("SELECT * FROM sync_cache_authorities"),
        authorityRows,
      );
    }
    assert.equal((await registry.checkCacheAuthority(scope)).ok, true);
    assert.equal((await registry.checkCacheAuthority({})).status, 403);
    const authorityHash = createHash("sha256")
      .update(authority.authority)
      .digest("hex");
    const authorityRow = (
      await storage.exec(
        "SELECT * FROM sync_cache_authorities WHERE hash=?",
        authorityHash,
      )
    )[0];
    assert(authorityRow);
    for (const corrupt of ["{", "{}"])
      try {
        await storage.exec(
          "UPDATE sync_cache_authorities SET authorization=? WHERE hash=?",
          corrupt,
          authorityHash,
        );
        assert.equal((await registry.checkCacheAuthority(scope)).status, 403);
      } finally {
        await storage.exec(
          "UPDATE sync_cache_authorities SET authorization=? WHERE hash=?",
          authorityRow.authorization as string,
          authorityHash,
        );
      }
    assert.equal((await registry.checkCacheAuthority(scope)).ok, true);
    for (const change of [
      { operation: "get" },
      { sharedBotId: randomUUID() },
      { requestDigest: "f".repeat(64) },
    ])
      assert.equal(
        (await registry.checkCacheAuthority({ ...scope, ...change })).ok,
        false,
      );
    assert.equal(
      (
        await call("/sync/cache/authority", a.token, {
          ...request,
          peerDeviceId: b.deviceId,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call("/sync/share", b.token, {
          sharedBotId,
          peerDeviceId: a.deviceId,
          enabled: false,
        })
      ).status,
      200,
    );
    assert.equal((await registry.checkCacheAuthority(scope)).ok, false);
  } finally {
    await worker.mf.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
