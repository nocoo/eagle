import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DeviceRuntime } from "../packages/agent/device-runtime.ts";
import {
  approvalPayload,
  canonicalDeviceJSON,
  type Device,
  deviceDigest,
  type OperationRequest,
} from "../packages/contracts/src/devices.ts";

function local() {
  const keys = generateKeyPairSync("ed25519");
  const device: Device = {
    deviceId: randomUUID(),
    publicKey: keys.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64url"),
    name: "test",
    platform: "darwin",
    arch: "arm64",
    groupId: null,
    membershipEpoch: 0,
    credentialVersion: 1,
  };
  return { device, keys };
}
async function request(
  deviceId: string,
  operation: OperationRequest["operation"],
): Promise<OperationRequest> {
  return {
    requestId: randomUUID(),
    operationId: randomUUID(),
    targetDeviceId: deviceId,
    action: "run",
    operation,
    digest: await deviceDigest(canonicalDeviceJSON(operation)),
  };
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "device-runtime-"));
  const { device, keys } = local();
  const runtime = new DeviceRuntime(device, join(directory, "journal.sqlite"));
  // A fresh device asks by default; these cases are about everything after that decision.
  runtime.setPolicy("all-approve");
  return {
    directory,
    device,
    keys,
    runtime,
    close: async () => {
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("policy upgrades import legacy state once and preserve target-bound request results across restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "device-policy-"));
  const { device } = local();
  const path = join(directory, "journal.sqlite");
  const legacy = join(directory, "policy.json");
  writeFileSync(legacy, JSON.stringify({ mode: "paused", version: 9 }), {
    mode: 0o600,
  });
  let runtime = new DeviceRuntime(device, path);
  const source = randomUUID();
  const input = {
    deviceId: device.deviceId,
    requestId: randomUUID(),
    mode: "always-ask" as const,
  };
  try {
    assert.deepEqual(runtime.policy, { mode: "paused", version: 9 });
    assert.deepEqual(runtime.applyPolicy(input, source), {
      mode: "always-ask",
      version: 10,
    });
    await runtime.close();
    writeFileSync(legacy, JSON.stringify({ mode: "all-approve", version: 1 }));
    runtime = new DeviceRuntime(device, path);
    assert.deepEqual(runtime.policy, { mode: "always-ask", version: 10 });
    runtime.setPolicy("paused");
    assert.deepEqual(runtime.applyPolicy(input, source), {
      mode: "always-ask",
      version: 10,
    });
    assert.deepEqual(runtime.policy, { mode: "paused", version: 11 });
    assert.throws(
      () => runtime.applyPolicy({ ...input, mode: "paused" }, source),
      /policy_request_conflict/,
    );
    await runtime.close();
    const next = { ...device, deviceId: randomUUID() };
    runtime = new DeviceRuntime(next, path);
    assert.throws(
      () => runtime.applyPolicy({ ...input, deviceId: next.deviceId }, source),
      /policy_request_conflict/,
    );
    assert.deepEqual(runtime.policy, { mode: "paused", version: 11 });
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a real SQLite request-record failure rolls policy and version back together", async () => {
  const f = fixture();
  const input = {
    deviceId: f.device.deviceId,
    requestId: randomUUID(),
    mode: "paused" as const,
  };
  const source = randomUUID();
  let recovered: DeviceRuntime | undefined;
  try {
    const database = (
      f.runtime.journal as unknown as { database: DatabaseSync }
    ).database;
    database.exec(
      "CREATE TRIGGER policy_failure BEFORE INSERT ON device_policy_requests BEGIN SELECT RAISE(ABORT,'test storage failure'); END",
    );
    assert.throws(
      () => f.runtime.applyPolicy(input, source),
      /policy_result_unknown_refresh_target/,
    );
    database.exec("DROP TRIGGER policy_failure");
    await f.runtime.close();
    recovered = new DeviceRuntime(
      f.device,
      join(f.directory, "journal.sqlite"),
    );
    assert.deepEqual(recovered.policy, { mode: "all-approve", version: 2 });
    assert.deepEqual(recovered.applyPolicy(input, source), {
      mode: "paused",
      version: 3,
    });
  } finally {
    await recovered?.close();
    await f.close();
  }
});

test("journal admits before command side effects and original ID never reruns", async () => {
  const f = fixture();
  try {
    const file = join(f.directory, "count");
    const input = await request(f.device.deviceId, {
      kind: "command",
      command: `printf x >> '${file}'; cat '${file}'`,
    });
    const first = await f.runtime.handle(input, f.device);
    assert.equal(first.status, "completed");
    assert.equal(first.output, "x");
    assert.deepEqual(
      await f.runtime.handle({ ...input, requestId: randomUUID() }, f.device),
      first,
    );
    assert.equal(readFileSync(file, "utf8"), "x");
    assert.equal(
      (
        await f.runtime.handle(
          { ...input, operation: { kind: "command", command: "echo changed" } },
          f.device,
        )
      ).status,
      "denied",
    );
  } finally {
    await f.close();
  }
});

test("an identity change preserves the journal without exposing the previous target's results", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "device-target-identity-"));
  const path = join(directory, "operations.sqlite");
  const previous = local().device;
  const current = local().device;
  const source = local().device;
  const marker = join(directory, "count");
  const input = await request(previous.deviceId, {
    kind: "command",
    command: `printf x >> '${marker}'; cat '${marker}'`,
  });
  const before = new DeviceRuntime(previous, path);
  before.setPolicy("all-approve");
  try {
    assert.equal((await before.handle(input, source)).output, "x");
  } finally {
    await before.close();
  }
  const after = new DeviceRuntime(current, path);
  try {
    for (const action of ["get", "cancel", "run"] as const) {
      await t.test(action, async () => {
        const value = await after.handle(
          { ...input, action, targetDeviceId: current.deviceId },
          source,
        );
        assert.equal(value.status, "denied");
        assert.equal(value.output, undefined);
        assert.equal(readFileSync(marker, "utf8"), "x");
      });
    }
    assert.equal(after.journal.get(input.operationId)?.stdout, "x");
    assert.equal(
      after.journal.getScope(input.operationId)?.targetDeviceId,
      previous.deviceId,
    );
    const fresh = await request(current.deviceId, {
      kind: "command",
      command: "printf new-identity",
    });
    assert.equal((await after.handle(fresh, source)).output, "new-identity");
  } finally {
    await after.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("one target is busy while get/cancel remain available and an unknown ID cannot execute", async () => {
  const f = fixture();
  try {
    const input = await request(f.device.deviceId, {
      kind: "command",
      command: "sleep 20",
      timeoutMs: 30000,
    });
    const pending = f.runtime.handle(input, f.device);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      (await f.runtime.handle({ ...input, action: "get" }, f.device)).status,
      "running",
    );
    const second = await request(f.device.deviceId, {
      kind: "command",
      command: "echo second",
    });
    assert.equal((await f.runtime.handle(second, f.device)).status, "busy");
    await f.runtime.handle({ ...input, action: "cancel" }, f.device);
    assert.equal((await pending).status, "unknown");
    assert.equal(
      (await f.runtime.handle({ ...second, action: "get" }, f.device)).status,
      "unknown",
    );
  } finally {
    await f.close();
  }
});
test("native tools share policy/journal admission and duplicate begin cannot invoke tool again", async () => {
  const f = fixture();
  try {
    const input = await request(f.device.deviceId, {
      kind: "native",
      tool: "bash",
      args: { command: "echo native" },
    });
    assert.equal((await f.runtime.beginNative(input, f.device)).accepted, true);
    assert.equal(
      (await f.runtime.beginNative(input, f.device)).accepted,
      false,
    );
    const command = await request(f.device.deviceId, {
      kind: "command",
      command: "echo overlap",
    });
    assert.equal((await f.runtime.handle(command, f.device)).status, "busy");
    assert.equal(
      f.runtime.completeNative(input.operationId, {
        status: "completed",
        output: "native",
      }).status,
      "completed",
    );
    assert.equal(
      (await f.runtime.beginNative(input, f.device)).accepted,
      false,
    );
    assert.equal((await f.runtime.handle(input, f.device)).status, "denied");
  } finally {
    await f.close();
  }
});
test("persisted native running operations recover unknown and another journal owner is rejected", async () => {
  const f = fixture();
  const input = await request(f.device.deviceId, {
    kind: "native",
    tool: "write",
    args: { path: "example" },
  });
  try {
    await f.runtime.beginNative(input, f.device);
    assert.throws(
      () => new DeviceRuntime(f.device, join(f.directory, "journal.sqlite")),
    );
    await f.runtime.close();
    const recovered = new DeviceRuntime(
      f.device,
      join(f.directory, "journal.sqlite"),
    );
    try {
      assert.equal(
        (await recovered.handle({ ...input, action: "get" }, f.device)).status,
        "unknown",
      );
      assert.equal(
        (await recovered.beginNative(input, f.device)).accepted,
        false,
      );
    } finally {
      await recovered.close();
    }
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});
test("always ask verifies operation-bound signature and paused blocks new operations", async () => {
  const f = fixture();
  try {
    const input = await request(f.device.deviceId, {
      kind: "command",
      command: "printf approved",
    });
    f.runtime.setPolicy("always-ask");
    assert.equal((await f.runtime.handle(input, f.device)).status, "denied");
    const envelope = {
      operationId: input.operationId,
      sourceDeviceId: f.device.deviceId,
      targetDeviceId: f.device.deviceId,
      digest: input.digest as string,
      policyVersion: f.runtime.policy.version,
      expiresAt: Date.now() + 60000,
    };
    const approved = {
      ...input,
      approval: {
        ...envelope,
        signature: sign(
          null,
          Buffer.from(approvalPayload(envelope)),
          f.keys.privateKey,
        ).toString("base64url"),
      },
    };
    assert.equal(
      (
        await f.runtime.handle(
          {
            ...approved,
            approval: { ...approved.approval, digest: "0".repeat(64) },
          },
          f.device,
        )
      ).status,
      "denied",
    );
    assert.equal(
      (await f.runtime.handle(approved, f.device)).output,
      "approved",
    );
    f.runtime.setPolicy("paused");
    const next = await request(f.device.deviceId, {
      kind: "command",
      command: "echo forbidden",
    });
    assert.equal((await f.runtime.handle(next, f.device)).status, "denied");
    assert.equal(
      (await f.runtime.handle({ ...input, action: "get" }, f.device)).status,
      "completed",
    );
  } finally {
    await f.close();
  }
});

test("lost native ownership remains blocked across timeout/restart until original completion evidence", async () => {
  const { NativeDeviceLeases } = await import(
    "../packages/agent/device-native-leases.ts"
  );
  const f = fixture();
  try {
    const leases = new NativeDeviceLeases(f.runtime, 30);
    const session = { id: randomUUID(), closed: false };
    const input = await request(f.device.deviceId, {
      kind: "native",
      tool: "bash",
      args: { command: "sleep 20" },
    });
    const first = await leases.begin(input, session);
    assert.equal(first.accepted, true);
    assert(first.leaseId);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(
      (await f.runtime.handle({ ...input, action: "get" }, f.device)).status,
      "unknown",
    );
    const other = await request(f.device.deviceId, {
      kind: "command",
      command: "printf overlap",
    });
    assert.equal((await f.runtime.handle(other, f.device)).status, "busy");
    assert.throws(() =>
      leases.complete(input.operationId, randomUUID(), session.id, {
        status: "completed",
      }),
    );
    assert.throws(() =>
      leases.complete(
        input.operationId,
        first.leaseId as string,
        randomUUID(),
        { status: "completed" },
      ),
    );
    assert.equal(
      leases.complete(input.operationId, first.leaseId as string, session.id, {
        status: "completed",
        output: "owner finished",
      }).status,
      "completed",
    );
    assert.equal((await f.runtime.handle(other, f.device)).output, "overlap");
    const second = {
      ...input,
      requestId: randomUUID(),
      operationId: randomUUID(),
    };
    const accepted = await leases.begin(second, session);
    assert.equal(accepted.accepted, true);
    session.closed = true;
    leases.disconnect(session.id);
    assert.equal(
      (
        await f.runtime.handle(
          { ...other, operationId: randomUUID() },
          f.device,
        )
      ).status,
      "busy",
    );
    leases.close();
    await f.runtime.close();
    const recovered = new DeviceRuntime(
      f.device,
      join(f.directory, "journal.sqlite"),
    );
    try {
      assert.equal(
        (await recovered.handle({ ...second, action: "get" }, f.device)).status,
        "unknown",
      );
      assert.equal(
        (
          await recovered.handle(
            { ...other, operationId: randomUUID() },
            f.device,
          )
        ).status,
        "busy",
      );
    } finally {
      await recovered.close();
    }
  } finally {
    await f.close();
  }
});

test("policy changed while a real approval signature verifies cannot admit side effects", async () => {
  const f = fixture();
  const original = crypto.subtle.verify.bind(crypto.subtle);
  let enter: () => void;
  let release: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    f.runtime.setPolicy("always-ask");
    const input = await request(f.device.deviceId, {
      kind: "command",
      command: "printf must-not-run",
    });
    const envelope = {
      operationId: input.operationId,
      sourceDeviceId: f.device.deviceId,
      targetDeviceId: f.device.deviceId,
      digest: input.digest as string,
      policyVersion: f.runtime.policy.version,
      expiresAt: Date.now() + 60000,
    };
    input.approval = {
      ...envelope,
      signature: sign(
        null,
        Buffer.from(approvalPayload(envelope)),
        f.keys.privateKey,
      ).toString("base64url"),
    };
    crypto.subtle.verify = async (
      ...args: Parameters<SubtleCrypto["verify"]>
    ) => {
      const verified = await original(...args);
      enter();
      await blocked;
      return verified;
    };
    const running = f.runtime.handle(input, f.device);
    await entered;
    f.runtime.setPolicy("paused");
    release?.();
    assert.equal((await running).status, "denied");
    assert.equal(
      (await f.runtime.handle({ ...input, action: "get" }, f.device)).status,
      "unknown",
    );
  } finally {
    crypto.subtle.verify = original;
    release?.();
    await f.close();
  }
});

for (const mode of ["aborted", "closing"] as const) {
  test(`a remote connection ${mode} before admission cannot execute`, async () => {
    const f = fixture();
    const original = crypto.subtle.verify.bind(crypto.subtle);
    let enter: () => void;
    let release: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      f.runtime.setPolicy("always-ask");
      const path = join(f.directory, "must-not-exist");
      const input = await request(f.device.deviceId, {
        kind: "file.write",
        path,
        content: "forbidden",
      });
      const envelope = {
        operationId: input.operationId,
        sourceDeviceId: f.device.deviceId,
        targetDeviceId: f.device.deviceId,
        digest: input.digest as string,
        policyVersion: f.runtime.policy.version,
        expiresAt: Date.now() + 60000,
      };
      input.approval = {
        ...envelope,
        signature: sign(
          null,
          Buffer.from(approvalPayload(envelope)),
          f.keys.privateKey,
        ).toString("base64url"),
      };
      crypto.subtle.verify = async (
        ...args: Parameters<SubtleCrypto["verify"]>
      ) => {
        const verified = await original(...args);
        enter();
        await blocked;
        return verified;
      };
      const controller = new AbortController();
      let live = true;
      const running = f.runtime.handle(input, f.device, {
        signal: controller.signal,
        isLive: () => live,
      });
      await entered;
      if (mode === "aborted") controller.abort();
      else live = false;
      release?.();
      assert.equal((await running).status, "denied");
      assert.equal(existsSync(path), false);
      assert.equal(
        (await f.runtime.handle({ ...input, action: "get" }, f.device)).status,
        "unknown",
      );
    } finally {
      crypto.subtle.verify = original;
      release?.();
      await f.close();
    }
  });
}

test("retiring a connection after admission does not rerun or cancel the operation", async () => {
  const f = fixture();
  const release = join(f.directory, "release");
  try {
    const path = join(f.directory, "side-effect");
    const input = await request(f.device.deviceId, {
      kind: "command",
      command: `printf x >> '${path}'; while [ ! -f '${release}' ]; do sleep 0.05; done; printf done`,
    });
    const controller = new AbortController();
    const running = f.runtime.handle(input, f.device, {
      signal: controller.signal,
      isLive: () => !controller.signal.aborted,
    });
    const deadline = Date.now() + 5000;
    while (!existsSync(path) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      existsSync(path),
      true,
      "the operation must be admitted first",
    );
    controller.abort();
    writeFileSync(release, "");
    assert.equal((await running).status, "completed");
    const next = new AbortController();
    const recovered = await f.runtime.handle(input, f.device, {
      signal: next.signal,
      isLive: () => true,
    });
    assert.equal(recovered.status, "completed");
    assert.equal(readFileSync(path, "utf8"), "x");
  } finally {
    await f.close();
  }
});

test("native and file output use bounded UTF-8 bytes and the command credential redactor before journaling", async () => {
  const directory = mkdtempSync(join(tmpdir(), "device-output-"));
  const { device } = local();
  const secret = "private-session-secret-for-output-test";
  const runtime = new DeviceRuntime(
    device,
    join(directory, "journal.sqlite"),
    () => [secret],
  );
  runtime.setPolicy("all-approve");
  try {
    const native = await request(device.deviceId, {
      kind: "native",
      tool: "bash",
      args: { command: "output" },
    });
    assert.equal((await runtime.beginNative(native, device)).accepted, true);
    const large = `${secret}\n-----BEGIN PRIVATE KEY-----\nnever-store-key-material\n-----END PRIVATE KEY-----\n${"界".repeat(30000)}`;
    const completed = runtime.completeNative(native.operationId, {
      status: "completed",
      output: large,
      error: "界".repeat(3000),
      exitCode: 0,
    });
    assert.equal(completed.status, "completed");
    assert(
      Buffer.byteLength(completed.output ?? "") +
        Buffer.byteLength(completed.error ?? "") <=
        65536,
    );
    assert(!JSON.stringify(completed).includes(secret));
    assert(!JSON.stringify(completed).includes("never-store-key-material"));
    assert(!(completed.output ?? "").includes("�"));
    const file = join(directory, "output.txt");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      file,
      `${secret}\n-----BEGIN PRIVATE KEY-----\nfile-key-material`,
    );
    const input = await request(device.deviceId, {
      kind: "file.read",
      path: file,
    });
    const read = await runtime.handle(input, device);
    assert.equal(read.status, "completed");
    assert(!JSON.stringify(read).includes(secret));
    assert(!JSON.stringify(read).includes("file-key-material"));
    const edge = await request(device.deviceId, {
      kind: "native",
      tool: "bash",
      args: { command: "edge" },
    });
    await runtime.beginNative(edge, device);
    const truncated = runtime.completeNative(edge.operationId, {
      status: "completed",
      output: "x".repeat(61430) + secret,
    });
    assert(!truncated.output?.endsWith(secret.slice(0, 10)));
    assert(truncated.output?.includes("[REDACTED]"));
    const newRun = await request(device.deviceId, {
      kind: "command",
      command: "printf free",
    });
    assert.equal((await runtime.handle(newRun, device)).output, "free");
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("real SQLite completion failure returns unknown while preserving device admission", async () => {
  const f = fixture();
  try {
    const input = await request(f.device.deviceId, {
      kind: "native",
      tool: "write",
      args: { path: "example" },
    });
    await f.runtime.beginNative(input, f.device);
    const database = Reflect.get(
      f.runtime.journal,
      "database",
    ) as import("node:sqlite").DatabaseSync;
    database.exec(
      "CREATE TRIGGER refuse_completion BEFORE UPDATE ON operations BEGIN SELECT RAISE(ABORT,'storage fixture failure'); END",
    );
    const completed = f.runtime.completeNative(input.operationId, {
      status: "completed",
      output: "side effect done",
    });
    assert.equal(completed.status, "unknown");
    const other = await request(f.device.deviceId, {
      kind: "command",
      command: "printf must-not-run",
    });
    assert.equal((await f.runtime.handle(other, f.device)).status, "unknown");
    database.exec("DROP TRIGGER refuse_completion");
  } finally {
    await f.close();
  }
});

test("an approval that expires during signature verification cannot admit an operation", async () => {
  const f = fixture();
  const original = crypto.subtle.verify.bind(crypto.subtle);
  try {
    f.runtime.setPolicy("always-ask");
    const input = await request(f.device.deviceId, {
      kind: "command",
      command: "printf expired",
    });
    const envelope = {
      operationId: input.operationId,
      sourceDeviceId: f.device.deviceId,
      targetDeviceId: f.device.deviceId,
      digest: input.digest as string,
      policyVersion: f.runtime.policy.version,
      expiresAt: Date.now() + 80,
    };
    input.approval = {
      ...envelope,
      signature: sign(
        null,
        Buffer.from(approvalPayload(envelope)),
        f.keys.privateKey,
      ).toString("base64url"),
    };
    crypto.subtle.verify = async (
      ...args: Parameters<SubtleCrypto["verify"]>
    ) => {
      const verified = await original(...args);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return verified;
    };
    assert.equal((await f.runtime.handle(input, f.device)).status, "denied");
    assert.equal(
      (await f.runtime.handle({ ...input, action: "get" }, f.device)).status,
      "unknown",
    );
  } finally {
    crypto.subtle.verify = original;
    await f.close();
  }
});

test("same ID completing concurrent approval verification returns its original state before busy", async () => {
  const f = fixture();
  const original = crypto.subtle.verify.bind(crypto.subtle);
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const both = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let count = 0;
  try {
    f.runtime.setPolicy("always-ask");
    const input = await request(f.device.deviceId, {
      kind: "native",
      tool: "bash",
      args: { command: "sleep 20" },
    });
    const envelope = {
      operationId: input.operationId,
      sourceDeviceId: f.device.deviceId,
      targetDeviceId: f.device.deviceId,
      digest: input.digest as string,
      policyVersion: f.runtime.policy.version,
      expiresAt: Date.now() + 60000,
    };
    input.approval = {
      ...envelope,
      signature: sign(
        null,
        Buffer.from(approvalPayload(envelope)),
        f.keys.privateKey,
      ).toString("base64url"),
    };
    crypto.subtle.verify = async (
      ...args: Parameters<SubtleCrypto["verify"]>
    ) => {
      const verified = await original(...args);
      if (++count === 2) entered?.();
      await blocked;
      return verified;
    };
    const first = f.runtime.beginNative(input, f.device);
    const second = f.runtime.beginNative(
      { ...input, requestId: randomUUID() },
      f.device,
    );
    await both;
    release?.();
    const responses = await Promise.all([first, second]);
    assert.deepEqual(responses.map((value) => value.accepted).sort(), [
      false,
      true,
    ]);
    assert.deepEqual(
      responses.map((value) => value.result.status),
      ["running", "running"],
    );
    f.runtime.completeNative(input.operationId, { status: "completed" });
  } finally {
    release?.();
    crypto.subtle.verify = original;
    await f.close();
  }
});

test("caller pins survive restart and uncertain re-submission becomes a query of the original target", async () => {
  const f = fixture();
  try {
    const input = await request(randomUUID(), {
      kind: "command",
      command: "printf original-target",
    });
    const scope = {
      kind: "remote",
      origin: "https://devices.example",
    } as const;
    assert.equal(f.runtime.journal.prepareOutgoing(input, scope).action, "run");
    assert.equal(
      f.runtime.journal.prepareOutgoing(
        { ...input, requestId: randomUUID() },
        scope,
      ).action,
      "get",
    );
    assert.throws(() =>
      f.runtime.journal.prepareOutgoing(
        { ...input, targetDeviceId: f.device.deviceId },
        scope,
      ),
    );
    await f.runtime.close();
    const recovered = new DeviceRuntime(
      f.device,
      join(f.directory, "journal.sqlite"),
    );
    try {
      assert.equal(
        recovered.journal.prepareOutgoing(input, scope).action,
        "get",
      );
      const busy = {
        ...input,
        requestId: randomUUID(),
        operationId: randomUUID(),
      };
      assert.equal(
        recovered.journal.prepareOutgoing(busy, scope).action,
        "run",
      );
      recovered.journal.completeOutgoing(busy, { status: "busy" }, scope);
      assert.equal(
        recovered.journal.prepareOutgoing(busy, scope).action,
        "run",
      );
      recovered.journal.completeOutgoing(
        { ...busy, action: "get" },
        { status: "denied" },
        scope,
      );
      assert.equal(
        recovered.journal.prepareOutgoing(busy, scope).action,
        "get",
      );
    } finally {
      await recovered.close();
    }
  } finally {
    await f.close();
  }
});

for (const scenario of [
  "same",
  "changed",
  "missing-current",
  "missing-admission",
] as const) {
  test(`native reboot recovery stays unknown and respects ${scenario} trusted boot identity`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "device-boot-"));
    const { device } = local();
    const path = join(directory, "journal.sqlite");
    const originalBoot = randomUUID();
    const currentBoot =
      scenario === "missing-current"
        ? undefined
        : scenario === "same"
          ? originalBoot.toUpperCase()
          : randomUUID();
    let runtime = new DeviceRuntime(
      device,
      path,
      () => [],
      scenario === "missing-admission" ? undefined : originalBoot,
    );
    runtime.setPolicy("all-approve");
    try {
      const native = await request(device.deviceId, {
        kind: "native",
        tool: "bash",
        args: { command: "never-rerun" },
      });
      assert.equal((await runtime.beginNative(native, device)).accepted, true);
      runtime.abandonNative(native.operationId);
      await runtime.close();
      runtime = new DeviceRuntime(device, path, () => [], currentBoot);
      assert.equal(
        (await runtime.handle({ ...native, action: "get" }, device)).status,
        "unknown",
      );
      const duplicate = await runtime.beginNative(
        { ...native, requestId: randomUUID() },
        device,
      );
      assert.equal(
        duplicate.accepted,
        false,
        "reboot never permits rerunning the old native ID",
      );
      assert.equal(duplicate.result.status, "unknown");
      const file = join(directory, "new-operation-count");
      const fresh = await request(device.deviceId, {
        kind: "command",
        command: `printf x >> '${file}'; cat '${file}'`,
      });
      const result = await runtime.handle(fresh, device);
      assert.equal(
        result.status,
        scenario === "changed" ? "completed" : "busy",
      );
      if (scenario === "changed") {
        assert.equal(result.output, "x");
        const nextNative = {
          ...native,
          operationId: randomUUID(),
          requestId: randomUUID(),
        };
        assert.equal(
          (await runtime.beginNative(nextNative, device)).accepted,
          true,
        );
        assert.equal(
          runtime.completeNative(native.operationId, { status: "completed" })
            .status,
          "denied",
          "old completion cannot release or overwrite anything after reboot recovery",
        );
        assert.equal(
          (
            await runtime.handle(
              { ...fresh, operationId: randomUUID() },
              device,
            )
          ).status,
          "busy",
          "the new native owner keeps its admission",
        );
        runtime.completeNative(nextNative.operationId, { status: "completed" });
        assert.equal(
          (await runtime.handle({ ...native, action: "get" }, device)).status,
          "unknown",
        );
      }
    } finally {
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
