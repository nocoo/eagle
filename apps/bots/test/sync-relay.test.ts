import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { type WebSocket, WebSocketServer } from "ws";
import type { BotRegistry, ReadyReplica } from "../src/core/BotRegistry.ts";
import type { DeviceSyncPort } from "../src/core/DeviceSyncPort.ts";
import { metadataDigest } from "../src/sync-objects.ts";
import { type RelayContext, SyncRelay } from "../src/sync-relay.ts";
import { objectFixture } from "./support/sync-object.ts";

test("owned outbound websocket retains a generation on renewal, dispatches bounded requests and cancels late supply", async () => {
  const f = objectFixture(),
    server = createServer(),
    wss = new WebSocketServer({ server });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  let socket: WebSocket | undefined,
    registrations = 0,
    connections = 0;
  const responses: unknown[] = [];
  wss.on("connection", (ws) => {
    socket = ws;
    connections++;
    ws.on("message", (raw) => {
      const value = JSON.parse(String(raw));
      if (value.operation === "register") {
        registrations++;
        ws.send(
          JSON.stringify({
            version: 1,
            type: "registered",
            generation: value.generation,
            onlineUntil: Date.now() + 45000,
          }),
        );
      } else responses.push(value);
    });
  });
  const claims: unknown[] = [],
    wire: unknown[] = [];
  const device = {
    relayAuthority: async (input: unknown) => {
      claims.push(input);
      return { authority: "a".repeat(43) };
    },
  } as unknown as DeviceSyncPort;
  const replica: ReadyReplica = {
    botId: f.record.botId,
    sharedBotId: f.manifest.sharedBotId,
    binding: f.record.binding,
    check: async () => {},
    publish: async (action, guard) => {
      guard();
      action();
    },
    command: async () => ({ streams: [] }),
  };
  let held: RelayContext | undefined, release: (() => void) | undefined;
  const relay = new SyncRelay(
    `http://127.0.0.1:${address.port}`,
    device,
    async (path, input, _fields, authority) => {
      assert.equal(authority, "a".repeat(43));
      wire.push({ path, input });
      return path.endsWith("discover") ? { version: 1, holders: [] } : { value: true };
    },
    async (_method, _input, _fields, context) => {
      held = context;
      await new Promise<void>((done) => {
        release = done;
      });
      context.guard();
      return { status: 200, body: { value: true } };
    },
    () => new Error("owned refused"),
  );
  const fields = { trace: "tr_relay_component", botId: f.record.botId };
  try {
    const first = relay.register(replica, fields);
    assert.equal(relay.register(replica, fields), first);
    const registration = (await first) as { generation: string };
    assert(relay.live(registration.generation));
    const renewed = (await relay.register(replica, fields)) as { generation: string };
    assert.equal(renewed.generation, registration.generation);
    assert.equal(connections, 1);
    assert.equal(registrations, 2);
    await relay.directory(replica.sharedBotId, fields);
    const metadata = {
      version: 1 as const,
      operation: "receipts" as const,
      sharedBotId: replica.sharedBotId,
      peerDeviceId: f.publisher.deviceId,
    };
    await relay.metadata(metadata, fields);
    await relay.exchange(
      replica.binding,
      replica.sharedBotId,
      f.publisher.deviceId,
      registration.generation,
      "object",
      { owned: true },
      fields,
    );
    assert(
      claims.some(
        (value) => (value as { requestDigest: string }).requestDigest === metadataDigest(metadata),
      ),
    );
    assert.equal(wire.length, 3);
    assert(socket);
    const requestId = randomUUID();
    socket.send(
      JSON.stringify({
        type: "request",
        requestId,
        generation: registration.generation,
        method: "object",
        payload: {},
        ...fields,
      }),
    );
    while (!release) await setImmediate();
    const closed = once(socket, "close");
    relay.stop(replica.botId);
    release();
    await closed;
    assert(held);
    const stopped = held;
    assert.throws(() => stopped.guard(), /sync_generation_changed/);
    assert.equal(responses.length, 0);
    relay.stop(replica.botId);
    assert.equal(relay.live(registration.generation), false);
  } finally {
    release?.();
    relay.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((done) => wss.close(() => done()));
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("stop during asynchronous registration never opens a late holder socket", async () => {
  const f = objectFixture();
  let release: (() => void) | undefined;
  const replica = {
    botId: f.record.botId,
    sharedBotId: f.manifest.sharedBotId,
    binding: f.record.binding,
    check: async () => {},
    command: async () => ({ streams: [] }),
  } as unknown as ReadyReplica;
  const device = {
    relayAuthority: async () => {
      await new Promise<void>((done) => {
        release = done;
      });
      return { authority: "a".repeat(43) };
    },
  } as unknown as DeviceSyncPort;
  const relay = new SyncRelay(
    "http://127.0.0.1:1",
    device,
    async () => ({}),
    async () => ({ status: 200, body: {} }),
    () => new Error("refused"),
  );
  try {
    const pending = relay.register(replica, { trace: "tr_opening_stop", botId: replica.botId });
    while (!release) await setImmediate();
    relay.stop(replica.botId);
    release();
    await assert.rejects(pending, /sync_generation_changed/);
    relay.close();
    await assert.rejects(
      relay.register(replica, { trace: "tr_after_close", botId: replica.botId }),
      /sync_generation_changed/,
    );
  } finally {
    release?.();
    relay.close();
  }
});

test("Bots relay metadata projects the real ready status and preserves the actual websocket refusal origin", async () => {
  // Only ready/helper metadata are doubles; HTTP, websocket I/O and failure propagation are real.
  const { AuthenticatedSync } = await import("../src/sync-pull.ts");
  const { captureLog } = await import("../src/log/log.ts");
  const f = objectFixture(),
    { log, records } = captureLog(),
    server = createServer();
  const posted: {
    operation: string;
    binding?: unknown;
    streams?: unknown;
    received?: number;
    applied?: number;
  }[] = [];
  let statusSnapshots: unknown[] = [];
  server.on("request", async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const value = JSON.parse(Buffer.concat(chunks).toString());
    posted.push(value);
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        value.operation === "status-report"
          ? { version: 1, recorded: true }
          : value.operation === "status-read"
            ? { version: 1, snapshots: statusSnapshots, hasMore: false }
            : value.operation === "discover"
              ? { version: 1, holders: [] }
              : value.operation === "receipts"
                ? { version: 1, receipts: [], peerApplied: "unknown" }
                : { version: 1, peerApplied: value },
      ),
    );
  });
  const wss = new WebSocketServer({ server });
  let socket: WebSocket | undefined;
  wss.on("connection", (ws) => {
    socket = ws;
    ws.on("message", (raw) => {
      const value = JSON.parse(String(raw));
      if (value.operation === "register")
        ws.send(
          JSON.stringify({
            version: 1,
            type: "registered",
            generation: value.generation,
            onlineUntil: Date.now() + 45000,
          }),
        );
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  const peerDeviceId = randomUUID(),
    replica: ReadyReplica = {
      botId: f.record.botId,
      sharedBotId: f.manifest.sharedBotId,
      binding: f.record.binding,
      check: async () => {},
      publish: async (action, guard) => {
        guard();
        action();
      },
      command: async () => ({
        ...f.record.binding,
        streams: [
          { source: f.manifest.source, received: 6, applied: 2, available: [{ from: 1, to: 6 }] },
        ],
      }),
    };
  const device = {
    relayAuthority: async () => ({ authority: "a".repeat(43) }),
    access: async () => ({
      version: 1,
      purpose: "replica.read",
      sharedBotId: replica.sharedBotId,
      local: f.publisher,
      peer: { ...f.publisher, deviceId: peerDeviceId },
      endpoints: null,
    }),
  } as unknown as DeviceSyncPort;
  const registry = { readyReplica: async () => replica } as unknown as BotRegistry;
  const sync = new AuthenticatedSync({
    registry,
    device,
    log,
    cacheOrigin: `http://127.0.0.1:${address.port}`,
  });
  try {
    assert(sync.canRelay());
    const registered = (await sync.relayRegister(replica.botId, "tr_relay_port")) as {
      generation: string;
    };
    assert.deepEqual(await sync.relayDiscover(replica.botId, "tr_directory"), {
      version: 1,
      holders: [],
    });
    await sync.relayReceipts(replica.botId, { peerDeviceId }, "tr_receipts");
    await sync.relayAck(
      replica.botId,
      {
        peerDeviceId,
        delivery: {
          requestId: randomUUID(),
          sessionId: "a".repeat(43),
          objectId: f.manifest.objectId,
          source: f.manifest.source,
        },
      },
      "tr_actual_ack",
    );
    const ack = posted.find((v) => v.operation === "ack");
    assert(ack);
    assert.deepEqual(ack.binding, f.record.binding);
    assert.equal(ack.received, 6);
    assert.equal(ack.applied, 2);
    await sync.statusReport(replica.botId, { peerDeviceId }, "tr_actual_status");
    const report = posted.find((v) => v.operation === "status-report");
    assert.deepEqual(report?.binding, f.record.binding);
    assert.deepEqual(report?.streams, [{ source: f.manifest.source, received: 6, applied: 2 }]);
    assert.deepEqual(await sync.statusRead(replica.botId, { peerDeviceId }, "tr_read_status"), {
      version: 1,
      snapshots: [],
      hasMore: false,
    });
    statusSnapshots = [
      {
        registryOrigin: "http://127.0.0.1:17053",
        sharedBotId: replica.sharedBotId,
        holder: f.publisher,
        receiver: { ...f.publisher, deviceId: peerDeviceId },
        binding: f.record.binding,
        source: f.manifest.source,
        received: 6,
        applied: 2,
        recordedAt: Date.now(),
      },
    ];
    assert.equal(
      (await sync.statusRead(replica.botId, { peerDeviceId }, "tr_partial_status")).snapshots[0]
        ?.applied,
      2,
    );
    const beforeInvalid = posted.length;
    await assert.rejects(
      sync.statusReport(replica.botId, { peerDeviceId, received: 99 }, "tr_no_supplied_status"),
    );
    await assert.rejects(
      sync.statusRead(
        replica.botId,
        { peerDeviceId, binding: f.record.binding },
        "tr_no_supplied_binding",
      ),
    );
    assert.equal(posted.length, beforeInvalid);
    const authority = device.relayAuthority;
    assert(authority);
    let releaseMetadata: (() => void) | undefined,
      active = true;
    device.relayAuthority = async (...args) => {
      await new Promise<void>((done) => {
        releaseMetadata = done;
      });
      assert(authority);
      return authority(...args);
    };
    const pendingMetadata = sync.statusReport(replica.botId, { peerDeviceId }, "tr_metadata_late", {
      replica,
      signal: new AbortController().signal,
      guard: () => {
        if (!active) throw new Error("sync_attempt_cancelled");
      },
    });
    while (!releaseMetadata) await setImmediate();
    active = false;
    releaseMetadata();
    await assert.rejects(pendingMetadata);
    assert.equal(
      posted.length,
      beforeInvalid,
      "authority await cannot revive a disabled metadata attempt",
    );
    device.relayAuthority = authority;

    await assert.rejects(
      sync.relayPull(replica.botId, { peerDeviceId, after: 0, limit: 128 }, "tr_offline_holder"),
      (error) =>
        error instanceof Error &&
        error.cause instanceof Error &&
        error.cause.message === "sync_unconfigured",
    );
    assert(socket);
    const response = once(socket, "message");
    socket.send(
      JSON.stringify({
        type: "request",
        requestId: randomUUID(),
        generation: registered.generation,
        method: "object",
        payload: { sessionId: "a".repeat(43), signature: "a".repeat(86), box: {} },
        trace: "tr_ws_reject",
        botId: replica.botId,
      }),
    );
    const result = JSON.parse(String((await response)[0]));
    assert.equal(result.status, 403);
    assert.equal(result.body.trace, "tr_ws_reject");
    const origin = records.filter((row) => row.trace === "tr_ws_reject" && row.err?.origin);
    assert.equal(origin.length, 1);
    assert.equal(origin[0]?.botId, replica.botId);
    assert.equal(origin[0]?.err?.failure, result.body.error.failure.id);
    sync.relayStop(replica.botId);
  } finally {
    sync.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((done) => wss.close(() => done()));
    await new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
  }
});
