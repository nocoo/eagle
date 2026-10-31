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
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
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
          `${JSON.stringify({ requestId: randomUUID(), method, params })}\n`,
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
      command: `printf x >> '${lostFile}'; while [ ! -f '${releaseFile}' ]; do sleep 0.01; done; cat '${lostFile}'`,
    };
    const lostRequest = {
      ...input,
      requestId: randomUUID(),
      operationId: randomUUID(),
      operation: lostOperation,
      digest: await deviceDigest(canonicalDeviceJSON(lostOperation)),
    };
    const lostSocket = connect(socketPath);
    let lostReply = "";
    lostSocket.on("data", (data) => {
      lostReply += data.toString();
    });
    try {
      lostSocket.write(
        `${JSON.stringify({ requestId: randomUUID(), method: "execute", params: lostRequest })}\n`,
      );
      let droppedAfterAdmission = false;
      let recoveredCommand: { status: string; output?: string } = {
        status: "running",
      };
      const recoveredBy = Date.now() + 10_000;
      for (;;) {
        if (
          !droppedAfterAdmission &&
          existsSync(lostFile) &&
          readFileSync(lostFile, "utf8") === "x"
        ) {
          assert.equal(lostReply, "", "admitted command has not replied");
          const closed = new Promise<void>((resolveClosed) =>
            lostSocket.once("close", () => resolveClosed()),
          );
          lostSocket.destroy();
          await closed;
          droppedAfterAdmission = true;
          writeFileSync(releaseFile, "release");
        }
        if (droppedAfterAdmission)
          recoveredCommand = (
            await request("operation.get", { ...lostRequest, action: "get" })
          ).result as { status: string; output?: string };
        if (recoveredCommand.status === "completed" || Date.now() > recoveredBy)
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(
        droppedAfterAdmission,
        true,
        "drop follows actual execution",
      );
      assert.equal(lostReply, "", "the original response was never received");
      assert.equal(
        recoveredCommand.status,
        "completed",
        `the lost admission was still ${recoveredCommand.status}`,
      );
      assert.equal(
        (
          (
            await request("execute", {
              ...lostRequest,
              requestId: randomUUID(),
            })
          ).result as { output: string }
        ).output,
        "x",
      );
      assert.equal(readFileSync(lostFile, "utf8"), "x");
    } finally {
      lostSocket.destroy();
      writeFileSync(releaseFile, "release");
    }
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
    message(type: string): Promise<Record<string, unknown>> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`service ${type} timeout: ${stderr}`));
        }, 5000);
        const check = () => {
          const message = messages.find((value) => value.type === type);
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
        `${JSON.stringify({ requestId: randomUUID(), method, params })}\n`,
      );
    });
  } finally {
    lines.close();
    socket.destroy();
  }
}

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
