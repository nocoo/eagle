import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BotRegistry, ReadyReplica } from "../src/core/BotRegistry.ts";
import {
  cacheListInput,
  cachePublishInput,
  cacheReceiveInput,
} from "../src/core/DeviceSyncCache.ts";
import type { DeviceSyncPort } from "../src/core/DeviceSyncPort.ts";
import { ClassifiedFailure } from "../src/core/domain.ts";
import { captureLog } from "../src/log/log.ts";
import {
  bytesDigest,
  metadataDigest,
  objectCanonical,
  SyncObjectStore,
} from "../src/sync-objects.ts";
import { AuthenticatedSync } from "../src/sync-pull.ts";
import { objectFixture } from "./support/sync-object.ts";

test("cache selectors are strict additive unions and never accept caller endpoints, authority or pins", () => {
  const peerDeviceId = randomUUID(),
    objectId = "a".repeat(64),
    source = { replicaId: randomUUID(), epoch: randomUUID() };
  assert(cachePublishInput.safeParse({ peerDeviceId, objectId }).success);
  assert(cachePublishInput.safeParse({ peerDeviceId, after: 0 }).success);
  assert.equal(cachePublishInput.safeParse({ peerDeviceId, objectId, after: 0 }).success, false);
  for (const body of [
    { peerDeviceId, objectId, url: "https://caller" },
    { peerDeviceId, objectId, authority: "caller" },
    { peerDeviceId, objectId, pin: {} },
  ])
    assert.equal(cacheReceiveInput.safeParse(body).success, false);
  assert.equal(cacheListInput.safeParse({ peerDeviceId, after: 0 }).success, false);
  assert.equal(
    cacheListInput.safeParse({ peerDeviceId, source, after: 0, limit: 129 }).success,
    false,
  );
});

test("Bots cache port preserves immutable objects and current authorization while receive/apply stay distinct and passive", async () => {
  // Typed helper/Registry and ready handle doubles isolate the Bots port contract.
  // Real Swift, Registry, DO/R2 and SDK behavior belongs to the device process suite.
  const f = objectFixture(),
    root = realpathSync(mkdtempSync(join(tmpdir(), "bots-cache-port-")));
  const readerKeys = generateKeyPairSync("ed25519"),
    reader = {
      ...f.publisher,
      deviceId: randomUUID(),
      publicKey: readerKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    };
  const readerWrap = randomBytes(32),
    body = {
      ...f.descriptor,
      deviceId: reader.deviceId,
      publicKey: reader.publicKey,
      keyId: bytesDigest(readerWrap),
      wrappingPublicKey: readerWrap.toString("base64url"),
    };
  const { signature: ignored, ...unsigned } = body;
  const readerDescriptor = {
    ...unsigned,
    signature: sign(
      null,
      Buffer.from("eagle-bots-wrap-descriptor-v1\n" + objectCanonical(unsigned)),
      readerKeys.privateKey,
    ).toString("base64url"),
  };
  let carrier = f.record.carrier,
    local = f.publisher,
    peer = reader,
    allowed = true,
    mode = "",
    applies = 0,
    pulls = 0;
  const requested: { operation: string; digest: string }[] = [];
  const now = Date.now(),
    expiresAt = now + 72 * 60 * 60 * 1000;
  const { log, records } = captureLog();
  const access = () => {
    if (!allowed) throw new Error("sync_not_shared");
    return {
      version: 1 as const,
      sharedBotId: f.manifest.sharedBotId,
      purpose: "replica.read" as const,
      local,
      peer,
      endpoints: null,
    };
  };
  const device: DeviceSyncPort = {
    version: 1,
    identity: async () => ({ version: 1, identity: local }),
    access: async () => access(),
    authorize: async () => ({ ...access(), registryOrigin: f.manifest.registryOrigin }),
    lookup: async () => ({
      version: 1,
      identity: reader,
      descriptor: readerDescriptor,
      publishedAt: now,
    }),
    descriptor: async () => f.descriptor,
    envelope: async (input) => {
      const { signature: _signature, ...original } = f.envelope;
      return f.signed("eagle-bots-key-envelope-signature-v1", {
        ...original,
        recipient: input.recipient,
        recipientDescriptor: input.recipientDescriptor,
        manifestDigest: metadataDigest(input.manifest),
        objectId: input.manifest.objectId,
        keyId: input.manifest.keyId,
      });
    },
    cacheAuthority: async (input) => {
      requested.push({ operation: input.operation, digest: input.requestDigest });
      return {
        version: 1,
        purpose: "replica.cache",
        operation: input.operation,
        registryOrigin: f.manifest.registryOrigin,
        sharedBotId: f.manifest.sharedBotId,
        requestDigest: mode === "wrong-ticket" ? "0".repeat(64) : input.requestDigest,
        uploader: f.publisher,
        recipient: reader,
        authority: randomBytes(32).toString("base64url"),
        expiresAt: Date.now() + 60000,
      };
    },
    openKey: async () => ({ version: 1, dek: f.prepared.key.toString("base64url") }),
  };
  const replica: ReadyReplica = {
    botId: f.record.botId,
    sharedBotId: f.manifest.sharedBotId,
    binding: f.record.binding,
    check: async () => {},
    publish: async (action, guard) => {
      guard();
      action();
    },
    command: async (method, _params, guard) => {
      guard?.();
      if (method === "pull") {
        pulls++;
        return f.page;
      }
      applies++;
      return { applied: 1 };
    },
  };
  const registry = { readyReplica: async () => replica } as unknown as BotRegistry;
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const value = JSON.parse(text);
    assert.match(String(request.headers.authorization), /^Bearer [A-Za-z0-9_-]{43}$/);
    if (mode === "remote-failure") {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { failure: { id: "f_cache_owned", kind: "storage_failed", layer: "runtime" } },
        }),
      );
      return;
    }
    if (value.operation === "publish") {
      carrier = value.carrier;
      response.end(
        JSON.stringify({
          version: 1,
          cloudCached: true,
          objectId: carrier.manifest.objectId,
          firstCachedAt: now,
          expiresAt,
        }),
      );
    } else if (value.operation === "list")
      response.end(
        JSON.stringify({
          version: 1,
          objects: [
            { objectId: carrier.manifest.objectId, expiresAt, included: carrier.manifest.included },
          ],
          gaps: [],
          hasMore: false,
          nextAfter: carrier.manifest.nextAfter,
          complete: false,
        }),
      );
    else
      response.end(
        JSON.stringify({ version: 1, cloudCached: true, carrier, firstCachedAt: now, expiresAt }),
      );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const publisherRoot = join(root, "publisher"),
      readerRoot = join(root, "reader");
    mkdirSync(publisherRoot, { mode: 0o700 });
    mkdirSync(readerRoot, { mode: 0o700 });
    const store = new SyncObjectStore(publisherRoot),
      staged = await store.stage(f.record);
    staged.publish();
    staged.complete();
    const publisher = new AuthenticatedSync({
      registry,
      device,
      log,
      root: publisherRoot,
      cacheOrigin: origin,
    });
    assert.equal(publisher.status().ready, false);
    const published = (await publisher.cachePublish(
      replica.botId,
      { peerDeviceId: reader.deviceId, objectId: f.manifest.objectId },
      "tr_cache_publish",
    )) as { cloudCached: boolean };
    assert(published.cloudCached);
    const { ciphertext, ...metadata } = carrier;
    assert.equal(
      requested[0]?.digest,
      metadataDigest({
        version: 1,
        operation: "publish",
        sharedBotId: f.manifest.sharedBotId,
        peerDeviceId: reader.deviceId,
        carrier: {
          ...metadata,
          cipherDigest: bytesDigest(Buffer.from(ciphertext, "base64url")),
          cipherLength: Buffer.from(ciphertext, "base64url").length,
        },
      }),
    );
    local = reader;
    peer = f.publisher;
    const receiver = new AuthenticatedSync({
      registry,
      device,
      log,
      root: readerRoot,
      cacheOrigin: origin,
    });
    const list = cacheListInput.parse({
      peerDeviceId: peer.deviceId,
      source: f.page.source,
      after: 0,
    });
    assert.equal(
      ((await receiver.cacheList(replica.botId, list, "tr_cache_list")) as { complete: boolean })
        .complete,
      false,
    );
    const received = (await receiver.cacheReceive(
      replica.botId,
      { peerDeviceId: peer.deviceId, objectId: f.manifest.objectId },
      "tr_cache_receive",
    )) as { stored: boolean; applied: boolean };
    assert.equal(received.stored, true);
    assert.equal(received.applied, false);
    assert.equal(applies, 0);
    assert.equal(pulls, 0);
    const stored = new SyncObjectStore(readerRoot).read(f.manifest.objectId);
    assert(stored);
    assert.equal(stored.carrier.ciphertext, carrier.ciphertext);
    receiver.setReady(undefined);
    await receiver.applyObject(replica.botId, f.manifest.objectId, "tr_cache_apply");
    assert.equal(applies, 1);
    mode = "remote-failure";
    await assert.rejects(
      receiver.cacheReceive(
        replica.botId,
        { peerDeviceId: peer.deviceId, objectId: f.manifest.objectId },
        "tr_cache_remote",
      ),
      (error: unknown) =>
        error instanceof ClassifiedFailure && error.failure.id === "f_cache_owned",
    );
    assert.equal(
      records.filter((row) => row.err?.failure === "f_cache_owned" && row.level === "error").length,
      0,
    );
    assert(
      records.some(
        (row) =>
          row.trace === "tr_cache_remote" &&
          row.botId === replica.botId &&
          row.level === "warn" &&
          row.err?.failure === "f_cache_owned",
      ),
    );
    mode = "wrong-ticket";
    await assert.rejects(receiver.cacheList(replica.botId, list, "tr_cache_wrong"));
    mode = "";
    allowed = false;
    await assert.rejects(
      receiver.cacheReceive(
        replica.botId,
        { peerDeviceId: peer.deviceId, objectId: f.manifest.objectId },
        "tr_cache_revoke",
      ),
    );
    receiver.close();
    await assert.rejects(receiver.cacheList(replica.botId, list, "tr_cache_closed"));
    assert.equal(applies, 1);
  } finally {
    await new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
    rmSync(root, { recursive: true, force: true });
    f.prepared.key.fill(0);
  }
});
