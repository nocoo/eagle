import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { OperationJournal } from "../packages/agent/device-journal.ts";
import {
  approvalPayload,
  canonicalDeviceJSON,
  type DeviceApproval,
  deviceDigest,
} from "../packages/contracts/src/devices.ts";

test("private helper config boots offline local tools; Bot port cannot change policy or pairing", async () => {
  const root = mkdtempSync(join(tmpdir(), "device-port-"));
  const deviceId = randomUUID();
  const socketPath = join(root, "service.sock");
  const key = generateKeyPairSync("ed25519");
  const child = spawn(process.execPath, ["packages/agent/device-service.ts"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const messages: Record<string, unknown>[] = [];
  const waiters = new Map<string, (value: Record<string, unknown>) => void>();
  let approvalHandler:
    | ((message: Record<string, unknown>) => Promise<void>)
    | undefined;
  const approvalErrors: unknown[] = [];
  let stderr = "";
  child.stderr.on("data", (data) => (stderr += data.toString()));
  let readyResolve: () => void;
  let readyReject: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  lines.on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    messages.push(message);
    if (message.type === "ready") readyResolve();
    if (message.type === "approve")
      void approvalHandler?.(message).catch((error) =>
        approvalErrors.push(error),
      );
    if (typeof message.requestId === "string")
      waiters.get(message.requestId)?.(message);
  });
  child.once("exit", () => readyReject(new Error(`service exited: ${stderr}`)));
  writeFileSync(
    join(root, "policy.json"),
    JSON.stringify({ mode: "all-approve", version: 1 }),
    { mode: 0o600 },
  );
  child.stdin.write(
    `${JSON.stringify({ type: "configure", version: 1, baseUrl: "http://127.0.0.1:1", deviceId, publicKey: key.publicKey.export({ type: "spki", format: "der" }).toString("base64url"), name: "offline-test", platform: "darwin", arch: "arm64", stateDirectory: root, socketPath })}\n`,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`local readiness timeout ${stderr}`)),
          5000,
        );
      }),
    ]);
    clearTimeout(timer);
    assert.equal(statSync(socketPath).mode & 0o777, 0o600);
    async function request(
      method: string,
      params?: unknown,
    ): Promise<Record<string, unknown>> {
      const socket = connect(socketPath);
      const reader = createInterface({ input: socket });
      return new Promise((resolve, reject) => {
        socket.on("error", reject);
        reader.once("line", (line) => {
          socket.end();
          reader.close();
          resolve(JSON.parse(line));
        });
        socket.write(
          `${JSON.stringify({ version: 2, requestId: randomUUID(), method, params })}\n`,
        );
      });
    }
    async function trusted(
      method: string,
      params?: unknown,
    ): Promise<Record<string, unknown>> {
      const requestId = randomUUID();
      const response = new Promise<Record<string, unknown>>((resolve) =>
        waiters.set(requestId, resolve),
      );
      child.stdin.write(
        `${JSON.stringify({ type: "manage", requestId, method, params })}\n`,
      );
      return response;
    }
    const status = await request("status");
    assert.equal((status.result as { localReady: boolean }).localReady, true);
    for (const method of [
      "policy.set",
      "pairing.create",
      "pairing.revoke",
      "pairing.redeem",
      "member.remove",
      "remote.configure",
    ]) {
      assert.equal(
        (await request(method, { mode: "all-approve", deviceId })).error,
        "management_requires_private_helper",
      );
    }
    const operation = { kind: "command", command: "printf offline" };
    const input = {
      requestId: randomUUID(),
      operationId: randomUUID(),
      targetDeviceId: deviceId,
      action: "run",
      operation,
      digest: await deviceDigest(canonicalDeviceJSON(operation)),
    };
    assert.equal(
      ((await request("execute", input)).result as { output: string }).output,
      "offline",
    );
    const changedTarget = await request("execute", {
      ...input,
      targetDeviceId: randomUUID(),
    });
    assert.equal((changedTarget.result as { status: string }).status, "denied");
    const lost = {
      ...input,
      requestId: randomUUID(),
      operationId: randomUUID(),
      targetDeviceId: randomUUID(),
      relayOrigin: "http://127.0.0.1:1",
    };
    assert.equal(
      ((await request("execute", lost)).result as { status: string }).status,
      "unknown",
    );
    assert.equal(
      (
        (await request("execute", { ...lost, targetDeviceId: deviceId }))
          .result as { status: string }
      ).status,
      "denied",
      "an uncertain remote operation cannot become a local retry",
    );
    const lostFile = join(root, "lost-response-count");
    const releaseFile = join(root, "lost-response-release");
    const lostOperation = {
      kind: "command",
      command: `printf x >> '${lostFile}'; while [ ! -f '${releaseFile}' ]; do sleep 0.05; done; cat '${lostFile}'`,
    };
    const lostRequest = {
      ...input,
      requestId: randomUUID(),
      operationId: randomUUID(),
      operation: lostOperation,
      digest: await deviceDigest(canonicalDeviceJSON(lostOperation)),
    };
    const lostSocket = connect(socketPath);
    const lostClosed = new Promise<void>((resolveClosed) => {
      lostSocket.once("close", () => resolveClosed());
    });
    let lostError: Error | undefined;
    lostSocket.once("error", (error) => {
      lostError = error;
    });
    let receivedResponse = false;
    lostSocket.on("data", () => {
      receivedResponse = true;
    });
    lostSocket.write(
      `${JSON.stringify({ version: 2, requestId: randomUUID(), method: "execute", params: lostRequest })}\n`,
    );
    const admissionDeadline = Date.now() + 5_000;
    for (;;) {
      if (lostError) throw lostError;
      if (lostSocket.destroyed)
        throw new Error("the request socket closed before admission");
      if (Date.now() >= admissionDeadline)
        throw new Error("the original operation was not admitted");
      if (existsSync(lostFile)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      receivedResponse,
      false,
      "the operation must still be in flight",
    );
    lostSocket.destroy();
    await Promise.race([
      lostClosed,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("request socket did not close")),
          2_000,
        );
        timer.unref();
      }),
    ]);
    if (lostError) throw lostError;
    assert.equal(receivedResponse, false, "the reply must be lost");
    writeFileSync(releaseFile, "", { mode: 0o600 });
    // Recovery is asynchronous on the service's own schedule, so wait on a wall-clock
    // deadline rather than a fixed attempt count; a slow runner must not read as a lost
    // operation, and the assertion stays exactly the same.
    let recoveredCommand: { status: string; output?: string } = {
      status: "running",
    };
    const recoveredBy = Date.now() + 10_000;
    for (;;) {
      recoveredCommand = (
        await request("operation.get", { ...lostRequest, action: "get" })
      ).result as { status: string; output?: string };
      if (recoveredCommand.status === "completed" || Date.now() > recoveredBy)
        break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      recoveredCommand.status,
      "completed",
      `the lost admission was still ${recoveredCommand.status}`,
    );
    assert.equal(
      (
        (await request("execute", { ...lostRequest, requestId: randomUUID() }))
          .result as { output: string }
      ).output,
      "x",
    );
    assert.equal(readFileSync(lostFile, "utf8"), "x");
    const asking = await trusted("policy.set", { mode: "always-ask" });
    const policyVersion = (asking.result as { version: number }).version;
    const askingOperation = {
      kind: "command",
      command: "printf approved-helper",
    };
    const askingInput = {
      ...input,
      requestId: randomUUID(),
      operationId: randomUUID(),
      operation: askingOperation,
      digest: await deviceDigest(canonicalDeviceJSON(askingOperation)),
    };
    assert.equal(
      ((await request("execute", askingInput)).result as { status: string })
        .status,
      "denied",
    );
    approvalHandler = async (message) => {
      assert.equal(message.sourceDeviceId, deviceId);
      assert.equal(message.targetDeviceId, deviceId);
      assert.equal(
        message.digest,
        await deviceDigest(canonicalDeviceJSON(message.operation)),
      );
      assert.deepEqual(message.operation, askingOperation);
      const envelope = {
        operationId: message.operationId as string,
        sourceDeviceId: deviceId,
        targetDeviceId: deviceId,
        digest: message.digest as string,
        policyVersion: message.policyVersion as number,
        expiresAt: message.expiresAt as number,
      };
      const signed = {
        ...envelope,
        signature: sign(
          null,
          Buffer.from(approvalPayload(envelope)),
          key.privateKey,
        ).toString("base64url"),
      };
      child.stdin.write(
        `${JSON.stringify({ type: "approval", requestId: message.requestId, approval: signed })}\n`,
      );
    };
    const proposed = await request("approval.request", {
      request: askingInput,
      policyVersion,
      expiresAt: Date.now() + 60000,
    });
    assert.equal(proposed.error, undefined);
    const signed = (proposed.result as { approval: DeviceApproval }).approval;
    assert.equal(
      (
        (
          await request("execute", {
            ...askingInput,
            approval: { ...signed, digest: "0".repeat(64) },
          })
        ).result as { status: string }
      ).status,
      "denied",
    );
    assert.equal(
      (
        (await request("execute", { ...askingInput, approval: signed }))
          .result as { output: string }
      ).output,
      "approved-helper",
    );
    approvalHandler = async (message) => {
      child.stdin.write(
        `${JSON.stringify({ type: "approval", requestId: message.requestId, error: "user_denied" })}\n`,
      );
    };
    const rejected = await request("approval.request", {
      request: { ...askingInput, operationId: randomUUID() },
      policyVersion,
      expiresAt: Date.now() + 60000,
    });
    assert.equal(rejected.error, "helper_request_denied");
    const expired = await request("approval.request", {
      request: askingInput,
      policyVersion,
      expiresAt: Date.now() - 1,
    });
    assert.equal(expired.error, "invalid_approval_request");
    assert.deepEqual(approvalErrors, []);
    assert.equal(
      messages.filter((message) => message.type === "sign").length,
      0,
      "approvals must never use raw signing bridge",
    );
    const managementId = randomUUID();
    const managed = new Promise<Record<string, unknown>>((resolve) =>
      waiters.set(managementId, resolve),
    );
    child.stdin.write(
      `${JSON.stringify({ type: "manage", requestId: managementId, method: "policy.set", params: { mode: "paused" } })}\n`,
    );
    const response = await managed;
    assert.equal((response.result as { mode: string }).mode, "paused");
    const denied = await request("execute", {
      ...input,
      requestId: randomUUID(),
      operationId: randomUUID(),
    });
    assert.equal((denied.result as { status: string }).status, "denied");
    assert(
      messages.some(
        (message) => message.type === "cloud" && message.status === "offline",
      ),
    );
    await trusted("policy.set", { mode: "all-approve" });
    const nativeOperation = {
      kind: "native",
      tool: "bash",
      args: { command: "sleep 20" },
    };
    const native = {
      ...input,
      requestId: randomUUID(),
      operationId: randomUUID(),
      operation: nativeOperation,
      digest: await deviceDigest(canonicalDeviceJSON(nativeOperation)),
    };
    const admission = (await request("local.begin", native)).result as {
      accepted: boolean;
      leaseId: string;
    };
    assert.equal(admission.accepted, true);
    assert.equal(typeof admission.leaseId, "string");
    let recovered = "running";
    for (let attempt = 0; attempt < 30 && recovered === "running"; attempt++) {
      recovered = (
        (await request("operation.get", { ...native, action: "get" }))
          .result as { status: string }
      ).status;
      if (recovered === "running")
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(recovered, "unknown");
    const stale = await request("local.complete", {
      operationId: native.operationId,
      leaseId: admission.leaseId,
      result: { status: "completed" },
    });
    assert.equal(stale.error, "native_lease_mismatch");
    assert.equal(
      (
        (await request("execute", { ...input, operationId: randomUUID() }))
          .result as { status: string }
      ).status,
      "busy",
    );
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    lines.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function serviceConfiguration(root: string) {
  // These cases are about the transport and the journal, not about the decision that must come
  // first: a fresh device asks, so the fixture states the allow it expects.
  writeFileSync(
    join(root, "policy.json"),
    JSON.stringify({ mode: "all-approve", version: 1 }),
    { mode: 0o600 },
  );
  return {
    type: "configure",
    version: 1,
    baseUrl: "http://127.0.0.1:1",
    deviceId: randomUUID(),
    publicKey: generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "der" })
      .toString("base64url"),
    name: "socket-owner",
    platform: "darwin",
    arch: "arm64",
    stateDirectory: root,
    socketPath: join(root, "service.sock"),
  };
}

function serviceProcess(inputReady = false) {
  const child = spawn(
    process.execPath,
    inputReady
      ? [
          "--input-type=module",
          "--eval",
          'const {runDeviceService}=await import("./packages/agent/device-service.ts"); await runDeviceService(); process.stdout.write(JSON.stringify({type:"input-ready"})+"\\n");',
        ]
      : ["packages/agent/device-service.ts"],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const lines = createInterface({ input: child.stdout });
  const messages: Record<string, unknown>[] = [];
  const listeners = new Set<() => void>();
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (text) => (stderr += text));
  lines.on("line", (line) => {
    messages.push(JSON.parse(line));
    for (const listener of listeners) listener();
  });
  child.on("exit", () => {
    for (const listener of listeners) listener();
  });
  return {
    child,
    message(
      type: string,
      requestId?: string,
    ): Promise<Record<string, unknown>> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`service ${type} timeout: ${stderr}`));
        }, 5000);
        const check = () => {
          const message = messages.find(
            (value) =>
              value.type === type &&
              (!requestId || value.requestId === requestId),
          );
          if (message || child.exitCode !== null) {
            clearTimeout(timer);
            listeners.delete(check);
            if (message) resolve(message);
            else reject(new Error(`service exited: ${stderr}`));
          }
        };
        listeners.add(check);
        check();
      });
    },
    async stop() {
      child.stdin.end();
      if (child.exitCode === null)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("service shutdown timeout"));
          }, 5000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      lines.close();
    },
  };
}

async function portCall(socketPath: string, method: string, params?: unknown) {
  const socket = connect(socketPath);
  const lines = createInterface({ input: socket });
  try {
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("port timeout")), 3000);
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      lines.once("line", (line) => {
        clearTimeout(timer);
        resolve(JSON.parse(line));
      });
      socket.write(
        `${JSON.stringify({ version: 2, requestId: randomUUID(), method, params })}\n`,
      );
    });
  } finally {
    lines.close();
    socket.destroy();
  }
}

function deviceSession(socketPath: string) {
  const socket = connect(socketPath);
  const lines = createInterface({ input: socket });
  const reader = lines[Symbol.asyncIterator]();
  return {
    async call(method: string, params: unknown) {
      const requestId = randomUUID();
      socket.write(
        `${JSON.stringify({ version: 2, requestId, method, params })}\n`,
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const response = await Promise.race([
        reader.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("native port timeout")),
            3000,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      assert.equal(response.done, false);
      const value = JSON.parse(response.value) as Record<string, unknown>;
      assert.equal(value.requestId, requestId);
      return value;
    },
    close() {
      lines.close();
      socket.destroy();
    },
  };
}

test("the local device port rejects an older protocol version", async () => {
  const root = mkdtempSync(join(tmpdir(), "device-port-version-"));
  const configuration = { ...serviceConfiguration(root), baseUrl: "" };
  const service = serviceProcess();
  try {
    service.child.stdin.write(`${JSON.stringify(configuration)}\n`);
    await service.message("ready");
    const socket = connect(configuration.socketPath);
    const lines = createInterface({ input: socket });
    try {
      const requestId = randomUUID();
      const response = new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("version response timeout")),
            3000,
          );
          socket.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          lines.once("line", (line) => {
            clearTimeout(timer);
            resolve(JSON.parse(line));
          });
        },
      );
      socket.write(
        `${JSON.stringify({ version: 1, requestId, method: "status" })}\n`,
      );
      assert.deepEqual(await response, {
        version: 2,
        requestId,
        error: "device_port_version_mismatch",
      });
    } finally {
      lines.close();
      socket.destroy();
    }
    const status = (await portCall(configuration.socketPath, "status"))
      .result as { localReady: boolean };
    assert.equal(status.localReady, true);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unconfigured relay starts local tools without changing policy", async () => {
  const root = mkdtempSync(join(tmpdir(), "device-local-only-"));
  const configuration = { ...serviceConfiguration(root), baseUrl: "" };
  const service = serviceProcess();
  try {
    service.child.stdin.write(`${JSON.stringify(configuration)}\n`);
    await service.message("ready");
    assert.equal((await service.message("cloud")).status, "unconfigured");
    const status = (await portCall(configuration.socketPath, "status"))
      .result as {
      localReady: boolean;
      cloudStatus: string;
      policy: { mode: string };
    };
    assert.equal(status.localReady, true);
    assert.equal(status.cloudStatus, "unconfigured");
    assert.equal(status.policy.mode, "all-approve");
    const directory = (await portCall(configuration.socketPath, "directory"))
      .result as { cloudStatus: string; devices: { deviceId: string }[] };
    assert.equal(directory.cloudStatus, "unconfigured");
    assert.deepEqual(
      directory.devices.map((device) => device.deviceId),
      [configuration.deviceId],
    );
    const operation = { kind: "command", command: "printf local-only" };
    const request = {
      requestId: randomUUID(),
      operationId: randomUUID(),
      targetDeviceId: configuration.deviceId,
      action: "run",
      operation,
      digest: await deviceDigest(canonicalDeviceJSON(operation)),
    };
    const result = (
      await portCall(configuration.socketPath, "execute", request)
    ).result as { status: string; output?: string };
    assert.equal(result.status, "completed");
    assert.equal(result.output, "local-only");
    const remoteId = randomUUID();
    const remote = (
      await portCall(configuration.socketPath, "execute", {
        ...request,
        operationId: remoteId,
        targetDeviceId: randomUUID(),
      })
    ).result as { status: string; error: string };
    assert.equal(remote.status, "denied");
    assert.equal(remote.error, "remote_not_configured");
    const policyRequest = randomUUID();
    service.child.stdin.write(
      `${JSON.stringify({ type: "manage", requestId: policyRequest, method: "policy.set", params: { mode: "paused" } })}\n`,
    );
    const managed = await service.message("managed");
    assert.equal(managed.requestId, policyRequest);
    assert.equal((managed.result as { mode: string }).mode, "paused");
    const paused = (
      await portCall(configuration.socketPath, "execute", {
        ...request,
        operationId: randomUUID(),
      })
    ).result as { status: string; error: string };
    assert.equal(paused.status, "denied");
    assert.equal(paused.error, "policy_confirmation_required");
    await service.stop();
    const database = new DatabaseSync(join(root, "operations.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(
        (
          database
            .prepare("SELECT count(*) AS n FROM outgoing_requests WHERE id=?")
            .get(remoteId) as { n: number }
        ).n,
        0,
      );
    } finally {
      database.close();
    }
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unconfigured relay does not bypass a fresh local approval policy", async () => {
  const root = mkdtempSync(join(tmpdir(), "device-local-policy-"));
  const configuration = { ...serviceConfiguration(root), baseUrl: "" };
  rmSync(join(root, "policy.json"));
  const service = serviceProcess();
  try {
    service.child.stdin.write(`${JSON.stringify(configuration)}\n`);
    await service.message("ready");
    const status = (await portCall(configuration.socketPath, "status"))
      .result as { policy: { mode: string } };
    assert.equal(status.policy.mode, "always-ask");
    const operation = { kind: "command", command: "printf must-not-run" };
    const result = (
      await portCall(configuration.socketPath, "execute", {
        requestId: randomUUID(),
        operationId: randomUUID(),
        targetDeviceId: configuration.deviceId,
        action: "run",
        operation,
        digest: await deviceDigest(canonicalDeviceJSON(operation)),
      })
    ).result as { status: string; error: string };
    assert.equal(result.status, "denied");
    assert.equal(result.error, "policy_confirmation_required");
    const pairingRequest = randomUUID();
    service.child.stdin.write(
      `${JSON.stringify({ type: "manage", requestId: pairingRequest, method: "pairing.create", params: {} })}\n`,
    );
    const pairing = await service.message("managed");
    assert.equal(pairing.requestId, pairingRequest);
    assert.equal(pairing.error, "remote_not_configured");
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unconfigured relay retains socket-bound native admission", async () => {
  const root = mkdtempSync(join(tmpdir(), "device-local-native-"));
  const configuration = { ...serviceConfiguration(root), baseUrl: "" };
  const service = serviceProcess();
  try {
    service.child.stdin.write(`${JSON.stringify(configuration)}\n`);
    await service.message("ready");
    const session = deviceSession(configuration.socketPath);
    const operation = {
      kind: "native",
      tool: "bash",
      args: { command: "printf local" },
    };
    const request = {
      requestId: randomUUID(),
      operationId: randomUUID(),
      targetDeviceId: configuration.deviceId,
      action: "run",
      operation,
      digest: await deviceDigest(canonicalDeviceJSON(operation)),
    };
    try {
      const first = (await session.call("local.begin", request)).result as {
        accepted: boolean;
        leaseId: string;
      };
      assert.equal(first.accepted, true);
      assert.equal(
        (
          (await session.call("local.begin", request)).result as {
            accepted: boolean;
          }
        ).accepted,
        false,
      );
      const heartbeat = await session.call("local.heartbeat", {
        operationId: request.operationId,
        leaseId: first.leaseId,
      });
      assert.equal(
        typeof (heartbeat.result as { expiresAt: number }).expiresAt,
        "number",
      );
      const completion = {
        operationId: request.operationId,
        leaseId: first.leaseId,
        result: { status: "completed", output: "local" },
      };
      assert.equal(
        (await portCall(configuration.socketPath, "local.complete", completion))
          .error,
        "native_lease_mismatch",
      );
      assert.equal(
        (
          (await session.call("local.complete", completion)).result as {
            status: string;
          }
        ).status,
        "completed",
      );
      assert.equal(
        (
          (
            await portCall(configuration.socketPath, "operation.get", {
              ...request,
              action: "get",
            })
          ).result as { output: string }
        ).output,
        "local",
      );
    } finally {
      session.close();
    }
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale remote origin cannot claim a new operation", async () => {
  const root = mkdtempSync(join(tmpdir(), "device-stale-origin-"));
  const configuration = serviceConfiguration(root);
  const service = serviceProcess();
  const operation = { kind: "command", command: "printf forbidden" };
  const request = {
    requestId: randomUUID(),
    operationId: randomUUID(),
    targetDeviceId: randomUUID(),
    relayOrigin: "https://other.example",
    action: "run",
    operation,
    digest: await deviceDigest(canonicalDeviceJSON(operation)),
  };
  try {
    service.child.stdin.write(`${JSON.stringify(configuration)}\n`);
    await service.message("ready");
    const result = (
      await portCall(configuration.socketPath, "execute", request)
    ).result as {
      status: string;
      error: string;
    };
    assert.equal(result.status, "denied");
    assert.equal(result.error, "remote_configuration_changed");
    await service.stop();
    const database = new DatabaseSync(join(root, "operations.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(
        (
          database
            .prepare("SELECT count(*) n FROM outgoing_requests WHERE id=?")
            .get(request.operationId) as { n: number }
        ).n,
        0,
      );
    } finally {
      database.close();
    }
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote configuration changes leave local native leases intact", async () => {
  const root = mkdtempSync(join(tmpdir(), "device-remote-change-"));
  const configuration = { ...serviceConfiguration(root), baseUrl: "" };
  const service = serviceProcess();
  try {
    service.child.stdin.write(`${JSON.stringify(configuration)}\n`);
    await service.message("ready");
    const inode = statSync(configuration.socketPath).ino;
    const session = deviceSession(configuration.socketPath);
    const operation = {
      kind: "native",
      tool: "write",
      args: { content: "local" },
    };
    const request = {
      requestId: randomUUID(),
      operationId: randomUUID(),
      targetDeviceId: configuration.deviceId,
      action: "run",
      operation,
      digest: await deviceDigest(canonicalDeviceJSON(operation)),
    };
    const change = async (baseUrl: string) => {
      const requestId = randomUUID();
      service.child.stdin.write(
        `${JSON.stringify({ type: "manage", requestId, method: "remote.configure", params: { baseUrl } })}\n`,
      );
      return service.message("managed", requestId);
    };
    try {
      const admission = (await session.call("local.begin", request)).result as {
        accepted: boolean;
        leaseId: string;
      };
      assert.equal(admission.accepted, true);
      const invalid = await change("http://example.com");
      assert.equal(invalid.error, "invalid_service_address");
      const initial = (await portCall(configuration.socketPath, "status"))
        .result as {
        localReady: boolean;
        cloudStatus: string;
      };
      assert.equal(initial.cloudStatus, "unconfigured");
      const enabled = await change("http://127.0.0.1:1");
      assert.equal(enabled.error, undefined);
      assert.equal(
        (enabled.result as { cloudStatus: string }).cloudStatus,
        "offline",
      );
      assert.equal(statSync(configuration.socketPath).ino, inode);
      const heartbeat = await session.call("local.heartbeat", {
        operationId: request.operationId,
        leaseId: admission.leaseId,
      });
      assert.equal(
        typeof (heartbeat.result as { expiresAt: number }).expiresAt,
        "number",
      );
      const disabled = await change("");
      assert.equal(disabled.error, undefined);
      assert.equal(
        (disabled.result as { cloudStatus: string }).cloudStatus,
        "unconfigured",
      );
      const completed = await session.call("local.complete", {
        operationId: request.operationId,
        leaseId: admission.leaseId,
        result: { status: "completed", output: "local" },
      });
      assert.equal(
        (completed.result as { status: string }).status,
        "completed",
      );
      assert.equal(statSync(configuration.socketPath).ino, inode);
    } finally {
      session.close();
    }
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("retired remote credentials remain redacted from a live local lease", async () => {
  const root = mkdtempSync(join(tmpdir(), "device-retired-secret-"));
  const key = generateKeyPairSync("ed25519");
  const configuration = {
    ...serviceConfiguration(root),
    baseUrl: "",
    publicKey: key.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64url"),
  };
  const token = "fixtureOpaqueCredential0123456789abcdef";
  let origin = "";
  let upgraded: () => void;
  const upgrade = new Promise<void>((resolve) => {
    upgraded = resolve;
  });
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/register/challenge")) {
      const challengeId = randomUUID();
      const expiresAt = Date.now() + 60000;
      const payload = [
        "eagle-device-register-v1",
        origin,
        configuration.deviceId,
        configuration.publicKey,
        challengeId,
        "fixture-nonce",
        String(expiresAt),
      ].join("\n");
      response.end(JSON.stringify({ challengeId, payload, expiresAt }));
    } else if (request.url?.endsWith("/register/complete")) {
      response.end(
        JSON.stringify({ sessionToken: token, expiresAt: Date.now() + 900000 }),
      );
    } else {
      response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
    }
  });
  server.on("upgrade", (_request, socket) => {
    socket.destroy();
    upgraded();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  const service = serviceProcess();
  let failure: unknown;
  try {
    service.child.stdin.write(`${JSON.stringify(configuration)}\n`);
    await service.message("ready");
    const session = deviceSession(configuration.socketPath);
    try {
      const operation = {
        kind: "native",
        tool: "write",
        args: { content: "local" },
      };
      const request = {
        requestId: randomUUID(),
        operationId: randomUUID(),
        targetDeviceId: configuration.deviceId,
        action: "run",
        operation,
        digest: await deviceDigest(canonicalDeviceJSON(operation)),
      };
      const admission = (await session.call("local.begin", request)).result as {
        accepted: boolean;
        leaseId: string;
      };
      assert.equal(admission.accepted, true);
      const enableId = randomUUID();
      service.child.stdin.write(
        `${JSON.stringify({ type: "manage", requestId: enableId, method: "remote.configure", params: { baseUrl: origin } })}\n`,
      );
      assert.equal(
        (await service.message("managed", enableId)).error,
        undefined,
      );
      const prompt = await service.message("sign");
      const signature = sign(
        null,
        Buffer.from(String(prompt.payload)),
        key.privateKey,
      ).toString("base64url");
      service.child.stdin.write(
        `${JSON.stringify({ type: "signature", requestId: prompt.requestId, signature })}\n`,
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        upgrade,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("upgrade timeout")), 5000);
        }),
      ]).finally(() => clearTimeout(timer));
      const disableId = randomUUID();
      service.child.stdin.write(
        `${JSON.stringify({ type: "manage", requestId: disableId, method: "remote.configure", params: { baseUrl: "" } })}\n`,
      );
      assert.equal(
        (await service.message("managed", disableId)).error,
        undefined,
      );
      const completed = (
        await session.call("local.complete", {
          operationId: request.operationId,
          leaseId: admission.leaseId,
          result: { status: "completed", output: `output ${token}` },
        })
      ).result as { status: string; output: string };
      assert.equal(completed.status, "completed");
      assert.equal(completed.output.includes(token), false);
      assert.match(completed.output, /\[REDACTED\]/);
      session.close();
      await service.stop();
      const database = new DatabaseSync(join(root, "operations.sqlite"), {
        readOnly: true,
      });
      try {
        const row = database
          .prepare("SELECT stdout FROM operations WHERE id=?")
          .get(request.operationId) as { stdout: string };
        assert.equal(row.stdout.includes(token), false);
      } finally {
        database.close();
      }
    } finally {
      session.close();
    }
  } catch (error) {
    failure = error;
  }
  server.closeAllConnections();
  const cleaned = await Promise.allSettled([
    service.stop(),
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
  ]);
  const errors = cleaned.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    errors.push(error);
  }
  if (failure !== undefined) errors.unshift(failure);
  if (errors.length)
    throw new AggregateError(errors, "remote credential test failed");
});

test("local-only native approval remains bound to the operation and socket", async () => {
  const root = mkdtempSync(join(tmpdir(), "device-local-approval-"));
  const key = generateKeyPairSync("ed25519");
  const configuration = {
    ...serviceConfiguration(root),
    baseUrl: "",
    publicKey: key.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64url"),
  };
  rmSync(join(root, "policy.json"));
  const service = serviceProcess();
  try {
    service.child.stdin.write(`${JSON.stringify(configuration)}\n`);
    await service.message("ready");
    const operation = {
      kind: "native",
      tool: "write",
      args: { content: "local" },
    };
    const request = {
      requestId: randomUUID(),
      operationId: randomUUID(),
      targetDeviceId: configuration.deviceId,
      action: "run",
      operation,
      digest: await deviceDigest(canonicalDeviceJSON(operation)),
    };
    const pending = portCall(configuration.socketPath, "approval.request", {
      request,
      policyVersion: 1,
      expiresAt: Date.now() + 60000,
    });
    const prompt = await service.message("approve");
    assert.deepEqual(prompt.operation, operation);
    const envelope = {
      operationId: request.operationId,
      sourceDeviceId: configuration.deviceId,
      targetDeviceId: configuration.deviceId,
      digest: request.digest,
      policyVersion: 1,
      expiresAt: prompt.expiresAt as number,
    };
    const approval = {
      ...envelope,
      signature: sign(
        null,
        Buffer.from(approvalPayload(envelope)),
        key.privateKey,
      ).toString("base64url"),
    };
    service.child.stdin.write(
      `${JSON.stringify({ type: "approval", requestId: prompt.requestId, approval })}\n`,
    );
    assert.deepEqual((await pending).result, { approval });
    const invalid = (
      await portCall(configuration.socketPath, "local.begin", {
        ...request,
        approval: { ...approval, signature: "AAAA" },
      })
    ).result as { accepted: boolean; result: { status: string } };
    assert.equal(invalid.accepted, false);
    assert.equal(invalid.result.status, "denied");
    const session = deviceSession(configuration.socketPath);
    try {
      const accepted = (
        await session.call("local.begin", { ...request, approval })
      ).result as {
        accepted: boolean;
        leaseId: string;
      };
      assert.equal(accepted.accepted, true);
      const completed = (
        await session.call("local.complete", {
          operationId: request.operationId,
          leaseId: accepted.leaseId,
          result: { status: "completed", output: "local" },
        })
      ).result as { status: string; output: string };
      assert.equal(completed.status, "completed");
      assert.equal(completed.output, "local");
    } finally {
      session.close();
    }
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("removing remote configuration preserves uncertain original operations", async () => {
  const root = mkdtempSync(join(tmpdir(), "device-local-recovery-"));
  const configuration = serviceConfiguration(root);
  const configured = serviceProcess();
  const local = serviceProcess();
  const operation = { kind: "command" as const, command: "printf original" };
  const request = {
    requestId: randomUUID(),
    operationId: randomUUID(),
    targetDeviceId: randomUUID(),
    sourceBotId: "bot-one",
    relayOrigin: configuration.baseUrl,
    action: "run" as const,
    operation,
    digest: await deviceDigest(canonicalDeviceJSON(operation)),
  };
  try {
    configured.child.stdin.write(`${JSON.stringify(configuration)}\n`);
    await configured.message("ready");
    const first = (await portCall(configuration.socketPath, "execute", request))
      .result as { status: string };
    assert.equal(first.status, "unknown");
    await configured.stop();
    local.child.stdin.write(
      `${JSON.stringify({ ...configuration, baseUrl: "" })}\n`,
    );
    await local.message("ready");
    for (const [method, action] of [
      ["execute", "run"],
      ["operation.get", "get"],
      ["operation.cancel", "cancel"],
    ] as const) {
      const answer = (
        await portCall(configuration.socketPath, method, {
          ...request,
          requestId: randomUUID(),
          action,
        })
      ).result as { status: string; error: string };
      assert.equal(answer.status, "unknown", action);
      assert.equal(
        answer.error,
        "remote_not_configured_query_original_id",
        action,
      );
    }
    const conflict = (
      await portCall(configuration.socketPath, "execute", {
        ...request,
        targetDeviceId: randomUUID(),
      })
    ).result as { status: string; error: string };
    assert.equal(conflict.status, "denied");
    assert.equal(conflict.error, "operation_binding_conflict");
    await local.stop();
    const journal = new OperationJournal(join(root, "operations.sqlite"));
    try {
      assert.equal(
        journal.prepareOutgoing(request, {
          kind: "remote",
          origin: configuration.baseUrl,
        }).action,
        "get",
      );
    } finally {
      journal.close();
    }
  } finally {
    await Promise.all([configured.stop(), local.stop()]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unconfigured relay retains a known unaccepted remote operation", async () => {
  const root = mkdtempSync(join(tmpdir(), "device-local-retryable-"));
  const configuration = { ...serviceConfiguration(root), baseUrl: "" };
  const operation = { kind: "command" as const, command: "printf original" };
  const request = {
    requestId: randomUUID(),
    operationId: randomUUID(),
    targetDeviceId: randomUUID(),
    action: "run" as const,
    operation,
    digest: await deviceDigest(canonicalDeviceJSON(operation)),
  };
  const journal = new OperationJournal(join(root, "operations.sqlite"));
  const scope = { kind: "remote", origin: "https://devices.example" } as const;
  journal.prepareOutgoing(request, scope);
  journal.completeOutgoing(request, { status: "denied" }, scope);
  journal.close();
  const service = serviceProcess();
  try {
    service.child.stdin.write(`${JSON.stringify(configuration)}\n`);
    await service.message("ready");
    const result = (
      await portCall(configuration.socketPath, "execute", request)
    ).result as { status: string; error: string };
    assert.equal(result.status, "denied");
    assert.equal(result.error, "remote_not_configured");
    await service.stop();
    const database = new DatabaseSync(join(root, "operations.sqlite"), {
      readOnly: true,
    });
    try {
      const row = database
        .prepare("SELECT state FROM outgoing_requests WHERE id=?")
        .get(request.operationId) as { state: string };
      assert.equal(row.state, "retryable");
    } finally {
      database.close();
    }
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed second service never unlinks the first process's live socket", async () => {
  const root = mkdtempSync(join(tmpdir(), "device-owner-"));
  const configuration = serviceConfiguration(root);
  const first = serviceProcess();
  const second = serviceProcess();
  try {
    first.child.stdin.write(`${JSON.stringify(configuration)}\n`);
    await first.message("ready");
    const owner = statSync(configuration.socketPath);
    second.child.stdin.write(`${JSON.stringify(configuration)}\n`);
    assert.equal(
      (await second.message("failed")).error,
      "device_initialization_failed",
    );
    await second.stop();
    assert.equal(
      existsSync(configuration.socketPath),
      true,
      "failed initialization must preserve the live owner's path",
    );
    assert.equal(statSync(configuration.socketPath).ino, owner.ino);
    assert.equal(
      (
        (await portCall(configuration.socketPath, "status")).result as {
          localReady: boolean;
        }
      ).localReady,
      true,
    );
  } finally {
    await Promise.all([first.stop(), second.stop()]);
    rmSync(root, { recursive: true, force: true });
  }
});

async function fragmentedLine(
  stream: NodeJS.WritableStream,
  value: unknown,
  splitCharacter: string,
) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  const boundary = bytes.indexOf(Buffer.from(splitCharacter)) + 1;
  assert(boundary > 0);
  await new Promise<void>((resolve, reject) => {
    stream.write(bytes.subarray(0, boundary), (error) =>
      error ? reject(error) : resolve(),
    );
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  stream.write(bytes.subarray(boundary));
}

for (const transport of ["stdin", "socket"]) {
  test(`${transport} preserves UTF-8 characters split across chunks`, async () => {
    const root = mkdtempSync(join(tmpdir(), "device-utf8-"));
    const configuration = { ...serviceConfiguration(root), name: "中文设备🦅" };
    const service = serviceProcess(true);
    try {
      await service.message("input-ready");
      if (transport === "stdin")
        await fragmentedLine(service.child.stdin, configuration, "中");
      else service.child.stdin.write(`${JSON.stringify(configuration)}\n`);
      await service.message("ready");
      const directory = (await portCall(configuration.socketPath, "directory"))
        .result as { devices: { name: string }[] };
      assert.equal(
        directory.devices[0].name,
        configuration.name,
        "stdin must preserve a fragmented device name",
      );
      if (transport === "stdin") return;
      const socket = connect(configuration.socketPath);
      const lines = createInterface({ input: socket });
      const path = join(root, "中文文件.txt");
      const content = "中文内容🦅";
      const operation = { kind: "file.write", path, content };
      try {
        const response = new Promise<Record<string, unknown>>(
          (resolve, reject) => {
            socket.once("error", reject);
            lines.once("line", (line) => resolve(JSON.parse(line)));
          },
        );
        await fragmentedLine(
          socket,
          {
            version: 2,
            requestId: randomUUID(),
            method: "execute",
            params: {
              requestId: randomUUID(),
              operationId: randomUUID(),
              targetDeviceId: configuration.deviceId,
              action: "run",
              operation,
              digest: await deviceDigest(canonicalDeviceJSON(operation)),
            },
          },
          "中",
        );
        assert.equal(
          ((await response).result as { status: string }).status,
          "completed",
          "socket must preserve path/content and their operation digest",
        );
        assert.equal(readFileSync(path, "utf8"), content);
      } finally {
        lines.close();
        socket.destroy();
      }
    } finally {
      await service.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("trusted configure boot identity alone recovers admission after a Mac reboot", async () => {
  const root = mkdtempSync(join(tmpdir(), "device-service-boot-"));
  const configuration = serviceConfiguration(root);
  const boot = randomUUID();
  const nextBoot = randomUUID();
  const operation = {
    kind: "native",
    tool: "bash",
    args: { command: "never-rerun" },
  };
  const native = {
    requestId: randomUUID(),
    operationId: randomUUID(),
    targetDeviceId: configuration.deviceId,
    action: "run",
    operation,
    digest: await deviceDigest(canonicalDeviceJSON(operation)),
  };
  try {
    for (const [index, bootSessionId] of [
      boot,
      boot.toUpperCase(),
      nextBoot,
    ].entries()) {
      const service = serviceProcess();
      try {
        service.child.stdin.write(
          `${JSON.stringify({ ...configuration, bootSessionId })}\n`,
        );
        await service.message("ready");
        const admission = (
          await portCall(configuration.socketPath, "local.begin", native)
        ).result as { accepted: boolean; result: { status: string } };
        assert.equal(admission.accepted, index === 0);
        if (index > 0) assert.equal(admission.result.status, "unknown");
        if (index === 1) {
          assert.equal(
            (
              await portCall(configuration.socketPath, "configure", {
                bootSessionId: nextBoot,
              })
            ).error,
            "unknown_local_method",
          );
          assert.equal(
            typeof (
              await portCall(configuration.socketPath, "local.begin", {
                ...native,
                bootSessionId: nextBoot,
              })
            ).error,
            "string",
          );
        }
        const command = { kind: "command", command: "printf after-reboot" };
        const result = (
          await portCall(configuration.socketPath, "execute", {
            ...native,
            requestId: randomUUID(),
            operationId: randomUUID(),
            operation: command,
            digest: await deviceDigest(canonicalDeviceJSON(command)),
          })
        ).result as { status: string; output?: string };
        assert.equal(result.status, index === 2 ? "completed" : "busy");
        if (index === 2) {
          assert.equal(result.output, "after-reboot");
          assert.equal(
            (
              (
                await portCall(configuration.socketPath, "operation.get", {
                  ...native,
                  action: "get",
                })
              ).result as { status: string }
            ).status,
            "unknown",
          );
        }
      } finally {
        await service.stop();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const pendingNative of [false, true]) {
  test(`a new helper identity keeps the original journal, operation bindings and native block=${pendingNative}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "device-service-identity-"));
    const bootSessionId = randomUUID();
    const previous = { ...serviceConfiguration(root), bootSessionId };
    const current = { ...serviceConfiguration(root), bootSessionId };
    const marker = join(root, "count");
    const operation = {
      kind: "command",
      command: `printf x >> '${marker}'; cat '${marker}'`,
    };
    const request = {
      requestId: randomUUID(),
      operationId: randomUUID(),
      targetDeviceId: previous.deviceId,
      action: "run",
      operation,
      digest: await deviceDigest(canonicalDeviceJSON(operation)),
    };
    const outgoing = {
      ...request,
      operationId: randomUUID(),
      targetDeviceId: randomUUID(),
      relayOrigin: previous.baseUrl,
    };
    const nativeOperation = {
      kind: "native",
      tool: "bash",
      args: { command: "an-unconfirmed-native-owner" },
    };
    const native = {
      ...request,
      operationId: randomUUID(),
      operation: nativeOperation,
      digest: await deviceDigest(canonicalDeviceJSON(nativeOperation)),
    };
    const ids = [request.operationId, outgoing.operationId, native.operationId];
    const snapshot = () => {
      const database = new DatabaseSync(join(root, "operations.sqlite"), {
        readOnly: true,
      });
      try {
        return Object.fromEntries(
          ["operations", "outgoing_requests"].map((table) => [
            table,
            database
              .prepare(`SELECT * FROM ${table} WHERE id IN (?,?,?) ORDER BY id`)
              .all(...ids),
          ]),
        );
      } finally {
        database.close();
      }
    };
    try {
      const oldService = serviceProcess();
      try {
        oldService.child.stdin.write(`${JSON.stringify(previous)}\n`);
        await oldService.message("ready");
        assert.equal(
          (
            (await portCall(previous.socketPath, "execute", request))
              .result as { output: string }
          ).output,
          "x",
        );
        assert.equal(
          (
            (await portCall(previous.socketPath, "execute", outgoing))
              .result as { status: string }
          ).status,
          "unknown",
        );
        if (pendingNative) {
          assert.equal(
            (
              (await portCall(previous.socketPath, "local.begin", native))
                .result as { accepted: boolean }
            ).accepted,
            true,
          );
        }
      } finally {
        await oldService.stop();
      }
      const originalRows = snapshot();
      const nextService = serviceProcess();
      try {
        nextService.child.stdin.write(`${JSON.stringify(current)}\n`);
        const ready = await nextService.message("ready");
        assert.equal(ready.deviceId, current.deviceId);
        assert.equal(ready.socketPath, previous.socketPath);
        for (const old of [request, outgoing]) {
          for (const action of ["run", "get"]) {
            const value = (
              await portCall(current.socketPath, "execute", {
                ...old,
                action,
                targetDeviceId: current.deviceId,
              })
            ).result as { status: string; output?: string };
            assert.equal(value.status, "denied");
            assert.equal(value.output, undefined);
          }
        }
        if (pendingNative) {
          assert.equal(
            (
              (
                await portCall(current.socketPath, "local.begin", {
                  ...native,
                  targetDeviceId: current.deviceId,
                })
              ).result as { accepted: boolean }
            ).accepted,
            false,
          );
        }
        const newOperation = {
          kind: "command",
          command: "printf new-identity",
        };
        const value = (
          await portCall(current.socketPath, "execute", {
            ...request,
            requestId: randomUUID(),
            operationId: randomUUID(),
            targetDeviceId: current.deviceId,
            operation: newOperation,
            digest: await deviceDigest(canonicalDeviceJSON(newOperation)),
          })
        ).result as { status: string; output?: string };
        assert.equal(value.status, pendingNative ? "busy" : "completed");
        if (!pendingNative) assert.equal(value.output, "new-identity");
        assert.equal(readFileSync(marker, "utf8"), "x");
      } finally {
        await nextService.stop();
      }
      assert.deepEqual(
        snapshot(),
        originalRows,
        "old rows stay under their original identity and target",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
