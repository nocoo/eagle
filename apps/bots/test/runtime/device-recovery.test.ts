import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import type { RuntimeHandle } from "../../src/core/RuntimePort.ts";
import { type ScriptProcess, spawnScript } from "../support/daemon.ts";
import { type Bench, createBench, text, trace, waitFor } from "../support/pi.ts";

async function verifyRecovery(
  state: "unavailable" | "unconfigured",
  crashAfterPrepare = false,
  mode: "execute" | "coerced" | "extra" | "get" | "get-extra" | "cancel" = "execute",
) {
  const socketRoot = await mkdtemp(join(tmpdir(), "eagle-device-recovery-"));
  const path = join(socketRoot, "access.sock");
  const sockets = new Set<Socket>();
  const methods: string[] = [];
  let server: Server | undefined;
  let bench: Bench | undefined;
  let child: ScriptProcess | undefined;
  let repair: ScriptProcess | undefined;
  let handle: RuntimeHandle | undefined;
  let failure: unknown;
  try {
    if (state === "unconfigured") {
      server = createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        let pending = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
          pending += chunk;
          const end = pending.indexOf("\n");
          if (end < 0) return;
          const request = JSON.parse(pending.slice(0, end)) as {
            requestId: string;
            method: string;
          };
          pending = pending.slice(end + 1);
          methods.push(request.method);
          const response =
            request.method === "status"
              ? {
                  result: {
                    deviceId: randomUUID(),
                    localReady: true,
                    cloudStatus: "unconfigured",
                    policy: { mode: "all-approve", version: 1 },
                  },
                }
              : { error: "unexpected_cloud_request" };
          socket.write(
            `${JSON.stringify({ version: 2, requestId: request.requestId, ...response })}\n`,
          );
        });
      });
      await new Promise<void>((resolve, reject) => {
        server?.once("error", reject);
        server?.listen(path, resolve);
      });
      await chmod(path, 0o600);
    }
    bench = await createBench({ deviceSocket: path });
    const dir = join(bench.dir, "b_runtime");
    await mkdir(dir, { recursive: true });
    child = spawnScript({
      script: "test/runtime/support/interrupt-device-child.ts",
      args: [dir, mode],
    });
    const marker = await child.waitForMarker("sent:", 20_000);
    const match = /sent:([0-9a-f-]{36}):([0-9a-f-]{36}):([0-9a-f]{64}|none)/.exec(marker);
    assert.ok(match);
    const [, operationId, target, digest] = match;
    const toolName = ["get", "get-extra", "cancel"].includes(mode)
      ? "remote_operation"
      : "remote_execute";
    await child.stop();
    if (crashAfterPrepare) {
      repair = spawnScript({
        script: "test/runtime/support/prepare-device-recovery-child.ts",
        args: [dir],
      });
      await repair.waitForMarker("prepared", 20_000);
      await repair.stop();
    }
    let offered: string[] | undefined;
    bench.faux.setResponses([
      (context) => {
        offered = getCurrentTools(context.messages).map((tool) => tool.name);
        return text("recovered");
      },
    ]);
    handle = await bench.runtime.open(bench.spec());
    let result = "";
    await waitFor(
      async () => {
        const history = await handle?.history({ limit: 20 });
        const block = history?.messages
          .flatMap((message) => message.blocks)
          .find((item) => item.type === "toolResult" && item.name === toolName);
        if (block?.type !== "toolResult") return false;
        assert.equal(block.callId, "call_recovery_fixture");
        assert.equal(block.isError, true);
        result = block.text;
        return true;
      },
      "remote recovery result",
      10_000,
    );
    const receipt = JSON.parse(result) as {
      status: string;
      error: string;
      operationId: string;
      targetDeviceId: string;
      digest?: string;
      diagnostics: string[];
    };
    assert.ok(receipt.diagnostics.some((entry) => entry.includes("interrupted")));
    assert.equal(receipt.status, "unknown");
    assert.equal(
      receipt.error,
      state === "unconfigured" ? "remote_not_configured" : "device_service_unavailable",
    );
    assert.equal(receipt.operationId, operationId);
    assert.equal(receipt.targetDeviceId, target);
    assert.equal(receipt.digest, digest === "none" ? undefined : digest);
    await waitFor(() => offered !== undefined, "model after recovery");
    assert.equal(
      offered?.some((name) => name.startsWith("remote_")),
      false,
    );
    const history = await handle.history({ limit: 20 });
    assert.equal(
      history.messages
        .flatMap((message) => message.blocks)
        .filter((block) => block.type === "toolResult" && block.name === toolName).length,
      1,
    );
    assert.deepEqual((await readFile(join(dir, "side-effects"), "utf8")).trim().split("\n"), [
      operationId,
    ]);
    assert.equal(
      methods.every((method) => method === "status"),
      true,
    );
    if (state === "unconfigured") assert.ok(methods.includes("status"));
  } catch (error) {
    failure = error;
  }
  for (const socket of sockets) socket.destroy();
  const cleaned = await Promise.allSettled([
    handle?.close(trace, 10_000),
    child?.stop(),
    repair?.stop(),
    server === undefined
      ? undefined
      : new Promise<void>((resolve) => server?.close(() => resolve())),
  ]);
  const errors = cleaned.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  for (const action of [
    () => bench?.cleanup(),
    () => rm(socketRoot, { recursive: true, force: true }),
  ]) {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  }
  if (failure !== undefined) errors.unshift(failure);
  if (errors.length) throw new AggregateError(errors, "device recovery test failed");
}

test("reopening without the device service retains the interrupted remote receipt", () =>
  verifyRecovery("unavailable"));
test("reopening with remote disabled retains the interrupted remote receipt", () =>
  verifyRecovery("unconfigured"));
test("a second crash after receipt preparation does not duplicate or lose the operation", () =>
  verifyRecovery("unavailable", true));
test("an interrupted remote query keeps its original target and operation ID", () =>
  verifyRecovery("unconfigured", false, "get"));
test("an interrupted remote cancellation keeps its original target and operation ID", () =>
  verifyRecovery("unconfigured", false, "cancel"));
test("recovery keeps the original ID after SDK argument coercion", () =>
  verifyRecovery("unconfigured", false, "coerced"));
test("recovery keeps the original ID when accepted arguments contain extra fields", () =>
  verifyRecovery("unconfigured", false, "extra"));
test("recovery preserves a query with accepted extra fields", () =>
  verifyRecovery("unconfigured", false, "get-extra"));
