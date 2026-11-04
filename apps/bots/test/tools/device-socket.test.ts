import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type DeviceRequest,
  operationDigest,
  SocketDevicePort,
} from "../../src/tools/devices/port.ts";
import { DeviceChannel } from "../../src/tools/devices/socket.ts";

const fixture = async (handle: (socket: Socket, request: Record<string, unknown>) => void) => {
  const root = await mkdtemp(join(tmpdir(), "device-port-"));
  const path = join(root, "access-v1.sock");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let pending = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      pending += chunk;
      for (;;) {
        const end = pending.indexOf("\n");
        if (end < 0) break;
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        handle(socket, JSON.parse(line));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  await chmod(path, 0o600);
  return {
    path,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
};

test("local status validates the policy without querying the directory", async () => {
  const status = {
    deviceId: randomUUID(),
    localReady: true,
    cloudStatus: "unconfigured",
    policy: { mode: "always-ask", version: 1 },
  };
  let invalid = false;
  const bench = await fixture((socket, frame) => {
    assert.equal(frame.method, "status");
    socket.write(
      `${JSON.stringify({ requestId: frame.requestId, result: invalid ? { ...status, policy: null } : status })}\n`,
    );
  });
  try {
    const port = new SocketDevicePort(bench.path);
    assert.deepEqual(await port.status(), status);
    invalid = true;
    await assert.rejects(port.status());
  } finally {
    await bench.close();
  }
});

test("typed approval decodes the host envelope and preserves its operation bindings", async () => {
  const operation = { kind: "command", command: "pwd" };
  const request: DeviceRequest = {
    requestId: randomUUID(),
    operationId: randomUUID(),
    targetDeviceId: randomUUID(),
    sourceBotId: "bot-one",
    action: "run",
    operation,
    digest: operationDigest(operation),
  };
  const approval = {
    operationId: request.operationId,
    sourceDeviceId: randomUUID(),
    targetDeviceId: request.targetDeviceId,
    digest: request.digest,
    policyVersion: 2,
    expiresAt: Date.now() + 60000,
    signature: "test-signature",
  };
  const bench = await fixture((socket, frame) => {
    assert.equal(frame.method, "approval.request");
    assert.deepEqual((frame.params as { request: unknown }).request, request);
    socket.write(`${JSON.stringify({ requestId: frame.requestId, result: { approval } })}\n`);
  });
  try {
    assert.deepEqual(await new SocketDevicePort(bench.path).approve(request, 2), approval);
  } finally {
    await bench.close();
  }
});

test("device v1 JSONL keeps split Unicode and correlates out-of-order replies", async () => {
  const requests: Record<string, unknown>[] = [];
  const bench = await fixture((socket, request) => {
    requests.push(request);
    if (requests.length === 2) {
      for (const value of [...requests].reverse()) {
        const frame = Buffer.from(
          `${JSON.stringify({ requestId: value.requestId, result: { name: "书房 Mac", method: value.method } })}\n`,
        );
        const split = frame.indexOf(Buffer.from("书")) + 1;
        socket.write(frame.subarray(0, split));
        socket.write(frame.subarray(split));
      }
    }
  });
  const channel = new DeviceChannel(bench.path);
  try {
    const result = await Promise.all([channel.call("status"), channel.call("directory")]);
    assert.deepEqual(result, [
      { name: "书房 Mac", method: "status" },
      { name: "书房 Mac", method: "directory" },
    ]);
    assert.equal(
      requests.every((request) => typeof request.requestId === "string"),
      true,
    );
  } finally {
    channel.close();
    await bench.close();
  }
});

test("device channel refuses wrong IDs, oversized frames and management methods", async () => {
  for (const response of [
    `${JSON.stringify({ requestId: randomUUID(), result: {} })}\n`,
    "x".repeat(524289),
    "not-json\n",
  ]) {
    const bench = await fixture((socket) => socket.write(response));
    const channel = new DeviceChannel(bench.path);
    try {
      await assert.rejects(
        channel.call("status"),
        /invalid_device_response|device_frame_too_large/,
      );
      await assert.rejects(
        channel.call("policy.set", { mode: "all-approve" }),
        /device_method_forbidden/,
      );
    } finally {
      channel.close();
      await bench.close();
    }
  }
});

test("device port fails closed on cancellation, EOF, timeout and broad socket permissions", async () => {
  const bench = await fixture(() => {});
  try {
    const channel = new DeviceChannel(bench.path, 25);
    await assert.rejects(channel.call("status"), /device_timeout/);
    channel.close();
    const controller = new AbortController();
    controller.abort();
    const cancelled = new DeviceChannel(bench.path);
    await assert.rejects(
      cancelled.call("directory", undefined, controller.signal),
      /device_cancelled/,
    );
    cancelled.close();
    await chmod(bench.path, 0o666);
    const insecure = new DeviceChannel(bench.path);
    await assert.rejects(insecure.call("status"), /insecure_device_socket/);
    insecure.close();
  } finally {
    await bench.close();
  }
  const eof = await fixture((socket) => socket.end());
  const channel = new DeviceChannel(eof.path);
  try {
    await assert.rejects(channel.call("status"), /device_disconnected/);
  } finally {
    channel.close();
    await eof.close();
  }
});

test("device errors are stable codes without copying arbitrary server content", async () => {
  const bench = await fixture((socket, request) =>
    socket.write(
      `${JSON.stringify({ requestId: request.requestId, error: "private command or secret" })}\n`,
    ),
  );
  const channel = new DeviceChannel(bench.path);
  try {
    await assert.rejects(channel.call("status"), /^Error: device_request_failed$/);
  } finally {
    channel.close();
    await bench.close();
  }
});
