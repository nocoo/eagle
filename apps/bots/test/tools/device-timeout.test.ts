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

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
async function deadline<T>(value: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        timer = realSetTimeout(() => reject(new Error("fixture timeout")), 4000);
      }),
    ]);
  } finally {
    realClearTimeout(timer);
  }
}

test("remote command socket respects the requested duration and a bounded outer deadline", {
  timeout: 10000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "device-long-command-"));
  const path = join(root, "access.sock");
  const sockets = new Set<Socket>();
  const requests: { socket: Socket; requestId: string }[] = [];
  let notify: (() => void) | undefined;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const frame = JSON.parse(buffer.slice(0, end)) as { requestId: string };
      buffer = buffer.slice(end + 1);
      requests.push({ socket, requestId: frame.requestId });
      notify?.();
      notify = undefined;
    });
  });
  let failure: unknown;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    await chmod(path, 0o600);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const operation = { kind: "command", command: "fixture", timeoutMs: 300000 };
    const request: DeviceRequest = {
      requestId: randomUUID(),
      operationId: randomUUID(),
      targetDeviceId: randomUUID(),
      sourceBotId: "fixture",
      action: "run",
      operation,
      digest: operationDigest(operation),
      relayOrigin: "https://devices.example",
    };
    const waitForRequest = async (count: number) => {
      if (requests.length >= count) return;
      await deadline(
        new Promise<void>((resolve) => {
          notify = resolve;
        }),
      );
    };
    const port = new SocketDevicePort(path);
    let settled: unknown = "pending";
    const first = port.request(request).then(
      (value) => {
        settled = value;
      },
      (error: unknown) => {
        settled = error;
      },
    );
    await waitForRequest(1);
    t.mock.timers.tick(65001);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, "pending", "a valid long command must not time out at 65 seconds");
    const firstFrame = requests[0];
    assert.ok(firstFrame);
    firstFrame.socket.write(
      `${JSON.stringify({ version: 2, requestId: firstFrame.requestId, result: { status: "completed" } })}\n`,
    );
    await deadline(first);
    assert.deepEqual(settled, { status: "completed" });
    let second: unknown = "pending";
    const bounded = port
      .request({ ...request, requestId: randomUUID(), operationId: randomUUID() })
      .then(
        (value) => {
          second = value;
        },
        (error: unknown) => {
          second = error;
        },
      );
    await waitForRequest(2);
    t.mock.timers.tick(394999);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(second, "pending");
    t.mock.timers.tick(1);
    await deadline(bounded);
    const timedOut: unknown = second as unknown;
    assert.ok(timedOut instanceof Error);
    assert.equal(timedOut.message, "device_timeout");
    const variants: {
      action: DeviceRequest["action"];
      operation: NonNullable<DeviceRequest["operation"]>;
      budget: number;
    }[] = [
      { action: "run", operation: { kind: "command", command: "fixture" }, budget: 125000 },
      {
        action: "run",
        operation: { kind: "command", command: "fixture", timeoutMs: 1000 },
        budget: 96000,
      },
      {
        action: "run",
        operation: { kind: "command", command: "fixture", timeoutMs: 300001 },
        budget: 125000,
      },
      { action: "run", operation: { kind: "file.read", path: "/fixture" }, budget: 65000 },
      { action: "get", operation, budget: 65000 },
      { action: "cancel", operation, budget: 65000 },
    ];
    for (const [index, variant] of variants.entries()) {
      let outcome: unknown = "pending";
      const call = port
        .request({
          ...request,
          requestId: randomUUID(),
          operationId: randomUUID(),
          action: variant.action,
          operation: variant.operation,
          digest: operationDigest(variant.operation),
        })
        .then(
          (value) => {
            outcome = value;
          },
          (error: unknown) => {
            outcome = error;
          },
        );
      await waitForRequest(index + 3);
      t.mock.timers.tick(variant.budget - 1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(outcome, "pending");
      t.mock.timers.tick(1);
      await deadline(call);
      const error: unknown = outcome as unknown;
      assert.ok(error instanceof Error);
      assert.equal(error.message, "device_timeout");
    }
  } catch (error) {
    failure = error;
  }
  t.mock.timers.reset();
  for (const socket of sockets) socket.destroy();
  const cleaned = await Promise.allSettled([
    new Promise<void>((resolve) => server.close(() => resolve())),
    rm(root, { recursive: true, force: true }),
  ]);
  const errors = cleaned.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (failure !== undefined) errors.unshift(failure);
  if (errors.length) throw new AggregateError(errors, "device timeout test failed");
});
