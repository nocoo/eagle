import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { DeviceCloud } from "../packages/agent/device-cloud.ts";
import { DeviceRuntime } from "../packages/agent/device-runtime.ts";
import {
  canonicalDeviceJSON,
  deviceDigest,
} from "../packages/contracts/src/devices.ts";

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

export async function deadline<T>(
  value: Promise<T>,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        timer = realSetTimeout(
          () => reject(new Error(`${label} timeout`)),
          4000,
        );
      }),
    ]);
  } finally {
    realClearTimeout(timer);
  }
}

export async function verifyRenewal(
  mode:
    | "success"
    | "rejected"
    | "reconnect"
    | "mismatched"
    | "lost"
    | "stale-http"
    | "success-clock"
    | "no-ready",
  advance?: (milliseconds: number) => void,
) {
  const root = mkdtempSync(join(tmpdir(), "device-cloud-renewal-"));
  const keys = generateKeyPairSync("ed25519");
  const device = {
    deviceId: randomUUID(),
    publicKey: keys.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64url"),
    name: "renewal-fixture",
    platform: "darwin",
    arch: "arm64",
    groupId: null,
    membershipEpoch: 0,
    credentialVersion: 1,
  };
  const sourceId = randomUUID();
  const runtime = new DeviceRuntime(device, join(root, "journal.sqlite"));
  runtime.setPolicy("all-approve");
  let entered!: () => void;
  let release!: () => void;
  let finished!: () => void;
  let executions = 0;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const completedHandle = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const handle = runtime.handle.bind(runtime);
  runtime.handle = async (...args) => {
    executions++;
    const result = await handle(...args);
    entered();
    await hold;
    finished();
    return result;
  };
  let origin = "";
  let payload = "";
  let challengeId = "";
  let registrations = 0;
  let proofs = 0;
  let connections = 0;
  let reconnected!: () => void;
  const connectedAgain = new Promise<void>((resolve) => {
    reconnected = resolve;
  });
  let directoryRequests = 0;
  let staleStarted!: () => void;
  let releaseStale!: () => void;
  const staleRequestStarted = new Promise<void>((resolve) => {
    staleStarted = resolve;
  });
  const staleGate = new Promise<void>((resolve) => {
    releaseStale = resolve;
  });
  let firstToken = "";
  let secondToken = "";
  let firstExpiry = 0;
  let secondExpiry = 0;
  const failures: unknown[] = [];
  let renewAccepted!: () => void;
  let renewalAgain!: () => void;
  let ackProcessed!: () => void;
  let ackAgain!: () => void;
  let renewals = 0;
  let acknowledgements = 0;
  let socketClosed!: () => void;
  let resultReceived!: (value: Record<string, unknown>) => void;
  const renewed = new Promise<void>((resolve) => {
    renewAccepted = resolve;
  });
  const renewedAgain = new Promise<void>((resolve) => {
    renewalAgain = resolve;
  });
  const processed = new Promise<void>((resolve) => {
    ackProcessed = resolve;
  });
  const processedAgain = new Promise<void>((resolve) => {
    ackAgain = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    socketClosed = resolve;
  });
  const result = new Promise<Record<string, unknown>>((resolve) => {
    resultReceived = resolve;
  });
  const operation = {
    kind: "file.write" as const,
    path: join(root, "proof"),
    content: "once",
  };
  const request = {
    requestId: randomUUID(),
    operationId: randomUUID(),
    targetDeviceId: device.deviceId,
    action: "run" as const,
    operation,
    digest: await deviceDigest(canonicalDeviceJSON(operation)),
  };
  const server = createServer(async (incoming, response) => {
    try {
      response.setHeader("content-type", "application/json");
      if (incoming.url?.endsWith("/directory")) {
        directoryRequests++;
        if (directoryRequests === 1 && mode === "stale-http") {
          assert.equal(
            incoming.headers.authorization === `Bearer ${firstToken}`,
            true,
          );
          staleStarted();
          await staleGate;
          response
            .writeHead(401)
            .end(JSON.stringify({ error: "invalid_session" }));
        } else {
          assert.equal(
            incoming.headers.authorization === `Bearer ${secondToken}`,
            true,
          );
          response.end(
            JSON.stringify({
              localDeviceId: device.deviceId,
              groupId: null,
              revision: 0,
              devices: [],
            }),
          );
        }
        return;
      }
      let body = "";
      for await (const chunk of incoming) body += chunk;
      const value = JSON.parse(body) as Record<string, unknown>;
      if (incoming.url?.endsWith("/register/challenge")) {
        challengeId = randomUUID();
        const expiresAt = Date.now() + 60000;
        payload = [
          "eagle-device-register-v1",
          origin,
          device.deviceId,
          device.publicKey,
          challengeId,
          randomBytes(32).toString("base64url"),
          String(expiresAt),
        ].join("\n");
        response.end(JSON.stringify({ challengeId, payload, expiresAt }));
      } else if (incoming.url?.endsWith("/register/complete")) {
        assert.equal(value.challengeId, challengeId);
        assert.equal(typeof value.signature, "string");
        assert.equal(
          verify(
            null,
            Buffer.from(payload),
            keys.publicKey,
            Buffer.from(String(value.signature), "base64url"),
          ),
          true,
        );
        registrations++;
        const token = randomBytes(32).toString("base64url");
        const expiresAt =
          Date.now() +
          (registrations === 1 &&
          mode !== "stale-http" &&
          mode !== "success-clock"
            ? 1500
            : 900000);
        if (registrations === 1) {
          firstToken = token;
          firstExpiry = expiresAt;
        } else {
          secondToken = token;
          secondExpiry = expiresAt;
        }
        response.end(JSON.stringify({ sessionToken: token, expiresAt }));
      } else {
        response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
      }
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end(JSON.stringify({ error: "fixture_failed" }));
    }
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (incoming, socket, head) => {
    sockets.handleUpgrade(incoming, socket, head, (ws) =>
      sockets.emit("connection", ws, incoming),
    );
  });
  sockets.on("connection", (ws) => {
    connections++;
    ws.once("close", socketClosed);
    ws.on("message", (data) => {
      try {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.type === "authenticate") {
          if (connections === 1) {
            assert.equal(frame.sessionToken === firstToken, true);
            if (mode === "no-ready") return;
            ws.send(JSON.stringify({ type: "ready", expiresAt: firstExpiry }));
            ws.send(
              JSON.stringify({
                type: "operation",
                sourceDeviceId: sourceId,
                sourcePublicKey: device.publicKey,
                request,
              }),
            );
          } else {
            assert.equal(mode, "reconnect");
            assert.equal(frame.sessionToken === secondToken, true);
            ws.send(JSON.stringify({ type: "ready", expiresAt: secondExpiry }));
            reconnected();
          }
        } else if (frame.type === "session.renew") {
          renewals++;
          assert.equal(frame.sessionToken === secondToken, true);
          if (mode !== "lost") {
            ws.send(
              JSON.stringify({
                type: "session.renewed",
                requestId:
                  mode === "mismatched" ? randomUUID() : frame.requestId,
                ...(mode === "rejected" || mode === "reconnect"
                  ? { error: "session_renewal_failed" }
                  : { expiresAt: secondExpiry }),
              }),
            );
          }
          if (
            mode === "success" ||
            mode === "stale-http" ||
            mode === "success-clock"
          ) {
            ws.send(
              JSON.stringify({
                type: "policy.set",
                relayId: randomUUID(),
                sourceDeviceId: sourceId,
                request: {
                  requestId: randomUUID(),
                  deviceId: device.deviceId,
                  mode: "all-approve",
                },
              }),
            );
          }
          if (renewals === 1) renewAccepted();
          else if (renewals === 2) renewalAgain();
        } else if (frame.type === "policy.result") {
          acknowledgements++;
          if (acknowledgements === 1) ackProcessed();
          else if (acknowledgements === 2) ackAgain();
        } else if (frame.type === "result") {
          resultReceived(frame);
        }
      } catch (error) {
        failures.push(error);
        ws.terminate();
      }
    });
  });
  let cloud: DeviceCloud | undefined;
  let failure: unknown;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    assert(address && typeof address !== "string");
    origin = `http://127.0.0.1:${address.port}`;
    cloud = new DeviceCloud(origin, device, runtime, async (value) => {
      proofs++;
      if (mode === "reconnect" && proofs > 2)
        throw new Error("fixture_signer_unavailable");
      return sign(null, Buffer.from(value), keys.privateKey).toString(
        "base64url",
      );
    });
    await deadline(cloud.start(), "cloud startup");
    await deadline(started, "target operation");
    let stale: Promise<unknown> | undefined;
    if (mode === "stale-http") {
      stale = cloud.directory().then(
        () => undefined,
        (error: unknown) => error,
      );
      await deadline(staleRequestStarted, "old directory request");
      advance?.(840000);
    } else if (mode === "success-clock") {
      advance?.(840000);
    }
    await deadline(renewed, "session renewal");
    assert.equal(connections, 1);
    assert.equal(registrations, 2);
    assert.equal(readFileSync(operation.path, "utf8"), "once");
    if (mode === "success" || mode === "stale-http" || mode === "success-clock")
      await deadline(processed, "renewal acknowledgement");
    else await deadline(closed, "failed renewal close");
    if (mode === "reconnect") {
      await deadline(connectedAgain, "reconnection with new credential");
      assert.equal(connections, 2);
      assert.equal(proofs, 2);
      assert.equal(registrations, 2);
    }
    if (mode === "success-clock") {
      advance?.(60001);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(cloud.status, "online");
      assert.equal(connections, 1);
      advance?.(779999);
      await deadline(renewedAgain, "second session renewal");
      await deadline(processedAgain, "second renewal acknowledgement");
      assert.equal(registrations, 3);
      assert.equal(connections, 1);
    }
    if (mode === "stale-http") {
      releaseStale();
      assert.ok((await stale) instanceof Error);
      await cloud.directory();
      assert.equal(
        registrations,
        2,
        "an old 401 must not invalidate the newer session",
      );
    }
    release();
    await deadline(completedHandle, "target settlement");
    if (
      mode === "success" ||
      mode === "stale-http" ||
      mode === "success-clock"
    ) {
      const completed = await deadline(result, "operation result");
      assert.equal(completed.operationId, request.operationId);
      assert.equal(
        (completed.result as { status: string }).status,
        "completed",
      );
    }
    assert.equal(executions, 1);
    assert.equal(readFileSync(operation.path, "utf8"), "once");
    assert.deepEqual(failures, []);
  } catch (error) {
    failure = error;
  }
  release();
  releaseStale();
  for (const socket of sockets.clients) socket.terminate();
  server.closeAllConnections();
  const cleaned = await Promise.allSettled([
    cloud?.close(),
    runtime.close(),
    new Promise<void>((resolve) => sockets.close(() => resolve())),
    new Promise<void>((resolve) => server.close(() => resolve())),
  ]);
  const errors = cleaned.flatMap((item) =>
    item.status === "rejected" ? [item.reason] : [],
  );
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    errors.push(error);
  }
  if (failure !== undefined) errors.unshift(failure);
  if (errors.length)
    throw new AggregateError(errors, "device renewal fixture failed");
}
