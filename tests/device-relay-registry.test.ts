import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import { canonicalDeviceJSON } from "../packages/contracts/src/devices.ts";
import { workerFixture } from "./device-integration/device-fixtures.ts";

mkdirSync(".local", { recursive: true });

test("Registry relay metadata authority keeps current directional roles, scope and real SQL attribution", {
  timeout: 30000,
}, async () => {
  const root = mkdtempSync(resolve(".local/relay-registry-"));
  const worker = await workerFixture(root, true);
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
  let socket: WebSocket | undefined;
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
    const sharedBotId = randomUUID();
    const request = (operation: string, peerDeviceId?: string) => ({
      version: 1,
      operation,
      sharedBotId,
      ...(peerDeviceId ? { peerDeviceId } : {}),
      requestDigest: createHash("sha256")
        .update(
          canonicalDeviceJSON({
            operation,
            sharedBotId,
            peerDeviceId: peerDeviceId ?? null,
          }),
        )
        .digest("hex"),
    });
    const registration = request("register");
    const first = await call("/sync/relay/authority", b.token, registration);
    assert.equal(
      first.status,
      200,
      "actual dedicated holder metadata endpoint",
    );
    const registered = (await first.json()) as Record<string, unknown>;
    assert.equal(registered.purpose, "replica.relay");
    assert.equal(registered.operation, "register");
    assert.equal(registered.requestDigest, registration.requestDigest);
    assert.equal(
      (registered.requester as { deviceId: string }).deviceId,
      b.deviceId,
    );
    const ns = (await worker.mf.getDurableObjectNamespace(
      "DEVICE_REGISTRY",
      "eagle",
    )) as unknown as {
      idFromName(name: string): string;
      get(id: string): unknown;
    };
    const registry = ns.get(ns.idFromName("registry")) as {
      checkRelayAuthority(
        input: unknown,
      ): Promise<{ ok: boolean; holders?: { deviceId: string }[] }>;
      relaySqlFailure(input: unknown): Promise<string>;
    };
    const check = (
      ticket: Record<string, unknown>,
      input: ReturnType<typeof request>,
      change = {},
    ) =>
      registry.checkRelayAuthority({
        authority: ticket.authority,
        operation: input.operation,
        sharedBotId,
        requestDigest: input.requestDigest,
        ...change,
      });
    assert.equal((await check(registered, registration)).ok, true);
    for (const change of [
      { operation: "discover" },
      { sharedBotId: randomUUID() },
      { requestDigest: "0".repeat(64) },
    ])
      assert.equal((await check(registered, registration, change)).ok, false);
    const mint = async (
      operation: string,
      token: string,
      peerDeviceId?: string,
    ) => {
      const input = request(operation, peerDeviceId),
        response = await call("/sync/relay/authority", token, input);
      assert.equal(response.status, 200, await response.clone().text());
      return {
        input,
        ticket: (await response.json()) as Record<string, unknown>,
      };
    };
    assert.equal(
      (
        await call(
          "/sync/relay/authority",
          a.token,
          request("exchange", b.deviceId),
        )
      ).status,
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
    const discovered = await mint("discover", a.token);
    assert.deepEqual(
      (await check(discovered.ticket, discovered.input)).holders?.map(
        (v) => v.deviceId,
      ),
      [b.deviceId],
    );
    for (const operation of ["exchange", "ack", "status-report"]) {
      const x = await mint(operation, a.token, b.deviceId);
      assert.equal((await check(x.ticket, x.input)).ok, true);
      assert.equal(
        (x.ticket.holder as { deviceId: string }).deviceId,
        b.deviceId,
      );
      assert.equal(
        (x.ticket.reader as { deviceId: string }).deviceId,
        a.deviceId,
      );
    }
    const statusRead = await mint("status-read", b.token, a.deviceId);
    assert.equal((await check(statusRead.ticket, statusRead.input)).ok, true);
    for (const operation of ["ack", "receipts", "status-report", "exchange"])
      assert.equal(
        (await check(statusRead.ticket, statusRead.input, { operation })).ok,
        false,
      );
    assert.equal(
      (
        await call(
          "/sync/relay/authority",
          b.token,
          request("status-report", a.deviceId),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          "/sync/relay/authority",
          a.token,
          request("status-read", b.deviceId),
        )
      ).status,
      403,
    );
    const query = await mint("receipts", b.token, a.deviceId);
    assert.equal((await check(query.ticket, query.input)).ok, true);
    assert.equal(
      (await call("/sync/relay/authority", b.token, request("ack", a.deviceId)))
        .status,
      403,
      "ACK does not require/create reverse read grant",
    );
    const storage = await worker.mf.unsafeGetDurableObjectStorage(
      "eagle",
      "DeviceRegistry",
      { name: "registry" },
    );
    const rows = await storage.exec("SELECT * FROM sync_relay_authorities");
    assert(rows.length > 0);
    await storage.exec(
      "ALTER TABLE sync_relay_authorities RENAME TO owned_failed_relay_authorities",
    );
    try {
      assert.deepEqual(
        JSON.parse(
          await registry.relaySqlFailure({
            authority: query.ticket.authority,
            operation: query.input.operation,
            sharedBotId,
            requestDigest: query.input.requestDigest,
          }),
        ),
        { message: "sync_relay_registry_unavailable", originalSqlCause: true },
      );
      const failure = await call(
        "/sync/relay/authority",
        b.token,
        registration,
      );
      assert.equal(failure.status, 503);
      assert.equal((await failure.text()).includes("no such table"), false);
    } finally {
      await storage.exec(
        "ALTER TABLE owned_failed_relay_authorities RENAME TO sync_relay_authorities",
      );
    }
    assert.equal((await check(query.ticket, query.input)).ok, true);
    assert.deepEqual(
      await storage.exec("SELECT * FROM sync_relay_authorities"),
      rows,
    );
    await storage.exec(
      "ALTER TABLE sync_grants RENAME TO owned_failed_relay_grants",
    );
    try {
      assert.deepEqual(
        JSON.parse(
          await registry.relaySqlFailure({
            authority: discovered.ticket.authority,
            operation: discovered.input.operation,
            sharedBotId,
            requestDigest: discovered.input.requestDigest,
          }),
        ),
        { message: "sync_relay_registry_unavailable", originalSqlCause: true },
      );
    } finally {
      await storage.exec(
        "ALTER TABLE owned_failed_relay_grants RENAME TO sync_grants",
      );
    }
    await call("/sync/share", b.token, {
      sharedBotId,
      peerDeviceId: a.deviceId,
      enabled: false,
    });
    assert.equal((await check(query.ticket, query.input)).ok, false);
    assert.deepEqual(
      (await check(discovered.ticket, discovered.input)).holders,
      [],
    );
    await call("/sync/share", b.token, {
      sharedBotId,
      peerDeviceId: a.deviceId,
      enabled: true,
    });
    const metadata = {
      version: 1,
      operation: "register",
      sharedBotId,
      binding: {
        localBotId: "b_relay_fixture",
        sharedBotId,
        replicaId: randomUUID(),
        epoch: randomUUID(),
      },
      generation: Buffer.alloc(32, 3).toString("base64url"),
      streams: [],
    };
    const registrationDigest = createHash("sha256")
      .update(canonicalDeviceJSON(metadata))
      .digest("hex");
    const registrationTicket = await call("/sync/relay/authority", b.token, {
      version: 1,
      operation: "register",
      sharedBotId,
      requestDigest: registrationDigest,
    });
    assert.equal(registrationTicket.status, 200);
    const ticket = (await registrationTicket.json()) as { authority: string };
    socket = new WebSocket(
      origin.replace(/^http/, "ws") +
        "/v1/relay/connect?sharedBotId=" +
        sharedBotId,
    );
    const holderSocket = socket;
    await new Promise<void>((resolve, reject) => {
      holderSocket.once("open", resolve);
      holderSocket.once("error", reject);
    });
    const registeredReply = new Promise<string>((resolve, reject) => {
      holderSocket.once("message", (v) => resolve(v.toString()));
      holderSocket.once("error", reject);
    });
    socket.send(JSON.stringify({ ...metadata, authority: ticket.authority }));
    assert.equal(
      JSON.parse(await registeredReply).type,
      "registered",
      "real outbound holder socket is authorized",
    );
    const discoverInput = { version: 1, operation: "discover", sharedBotId };
    const discoverDigest = createHash("sha256")
      .update(canonicalDeviceJSON(discoverInput))
      .digest("hex");
    const discoverTicket = (await (
      await call("/sync/relay/authority", a.token, {
        ...discoverInput,
        requestDigest: discoverDigest,
      })
    ).json()) as { authority: string };
    const discoveredResponse = await worker.mf.dispatchFetch(
      origin + "/v1/relay/discover",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${discoverTicket.authority}`,
        },
        body: JSON.stringify(discoverInput),
      },
    );
    assert.equal(
      discoveredResponse.status,
      200,
      await discoveredResponse.clone().text(),
    );
    const directory = (await discoveredResponse.json()) as {
      holders: {
        identity: { deviceId: string };
        binding: unknown;
        generation: string;
      }[];
    };
    assert.equal(directory.holders.length, 1);
    assert.equal(directory.holders[0]?.identity.deviceId, b.deviceId);
    assert.deepEqual(directory.holders[0]?.binding, metadata.binding);
    assert.equal(directory.holders[0]?.generation, metadata.generation);
    for (const payload of [
      {
        version: 1,
        sharedBotId: randomUUID(),
        readerDeviceId: a.deviceId,
        readerNonce: Buffer.alloc(32, 4).toString("base64url"),
        readerEphemeral: Buffer.alloc(32, 5).toString("base64url"),
      },
      {
        version: 1,
        sharedBotId,
        readerDeviceId: randomUUID(),
        readerNonce: Buffer.alloc(32, 4).toString("base64url"),
        readerEphemeral: Buffer.alloc(32, 5).toString("base64url"),
      },
    ]) {
      const input = {
        version: 1,
        operation: "exchange",
        sharedBotId,
        peerDeviceId: b.deviceId,
        generation: metadata.generation,
        receiverBinding: {
          ...metadata.binding,
          localBotId: "b_actual_reader",
          replicaId: randomUUID(),
          epoch: randomUUID(),
        },
        requestId: randomUUID(),
        method: "challenge",
        payload,
      };
      const requestDigest = createHash("sha256")
        .update(canonicalDeviceJSON(input))
        .digest("hex");
      const minted = (await (
        await call("/sync/relay/authority", a.token, {
          version: 1,
          operation: "exchange",
          sharedBotId,
          peerDeviceId: b.deviceId,
          requestDigest,
        })
      ).json()) as { authority: string };
      const response = await worker.mf.dispatchFetch(
        origin + "/v1/relay/exchange",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${minted.authority}`,
          },
          body: JSON.stringify(input),
        },
      );
      assert.equal(
        response.status,
        403,
        "caller digest cannot substitute actual inner namespace/reader",
      );
    }
    const malformed = {
      version: 1,
      operation: "exchange",
      sharedBotId,
      peerDeviceId: b.deviceId,
      generation: metadata.generation,
      receiverBinding: {
        ...metadata.binding,
        localBotId: "b_actual_reader",
        replicaId: randomUUID(),
        epoch: randomUUID(),
      },
      requestId: randomUUID(),
      method: "challenge",
      payload: {
        version: 1,
        sharedBotId,
        readerDeviceId: a.deviceId,
        readerNonce: Buffer.alloc(32, 4).toString("base64url"),
        readerEphemeral: Buffer.alloc(32, 5).toString("base64url"),
      },
    };
    const malformedDigest = createHash("sha256")
      .update(canonicalDeviceJSON(malformed))
      .digest("hex");
    const malformedTicket = (await (
      await call("/sync/relay/authority", a.token, {
        version: 1,
        operation: "exchange",
        sharedBotId,
        peerDeviceId: b.deviceId,
        requestDigest: malformedDigest,
      })
    ).json()) as { authority: string };
    const answered = new Promise<void>((done, reject) =>
      holderSocket.once("message", (raw) => {
        try {
          const input = JSON.parse(String(raw));
          holderSocket.send(
            JSON.stringify({
              type: "response",
              requestId: input.requestId,
              generation: metadata.generation,
              status: 403,
              body: {
                trace: "wrong_trace",
                error: {
                  failure: {
                    id: "unbounded invalid identity",
                    kind: "auth_failed",
                    layer: "runtime",
                  },
                },
              },
            }),
          );
          done();
        } catch (error) {
          reject(error);
        }
      }),
    );
    const invalid = await worker.mf.dispatchFetch(
      origin + "/v1/relay/exchange",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${malformedTicket.authority}`,
          "x-bots-sync-trace": "tr_invalid_holder_error",
        },
        body: JSON.stringify(malformed),
      },
    );
    await answered;
    assert.equal(invalid.status, 403);
    assert.equal(
      ((await invalid.json()) as { error: { code: string } }).error.code,
      "sync_relay_failure_invalid",
      "untrusted error payload is not a classified failure",
    );
  } finally {
    socket?.terminate();
    await worker.mf.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
