import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { boundOutput, OutputBuffer } from "@earendil-works/chord/output";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { Log, type LogRecord } from "../../src/log/log.ts";
import { captureNativeOutput } from "../../src/tools/devices/output.ts";
import {
  canonicalJSON,
  type DeviceDirectory,
  type DeviceRequest,
  type DeviceResult,
  operationDigest,
  type SharedDevicePort,
} from "../../src/tools/devices/port.ts";
import { deviceExtension, guardNativeTool } from "../../src/tools/devices/tools.ts";

const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const directory = (): DeviceDirectory => ({
  localDeviceId: required(ids[0]),
  groupId: "group-test",
  revision: 1,
  relayOrigin: "https://devices.example",
  devices: ids.map((deviceId, index) => ({
    deviceId,
    name: `Mac ${index}`,
    platform: "darwin",
    arch: "arm64",
    online: true,
    lastSeenAt: 1000,
    capabilities: ["command", "file.read", "file.write", "file.list"],
    policy: { mode: "all-approve", version: 1 },
  })),
});
const memoApi = () => {
  const memos = new Map<string, unknown>();
  const api = {
    callId: randomUUID(),
    conversationId: 1,
    agent: async () => ({ cwd: "/tmp" }),
    memo: async (name: string, candidate: unknown, context?: unknown) => {
      if (context === undefined) return memos.get(name);
      if (!memos.has(name)) memos.set(name, structuredClone(candidate));
      return memos.get(name);
    },
  } as unknown as ToolExecutionApi;
  return { api, memos };
};
const fixture = () => {
  const view = directory();
  const calls: DeviceRequest[] = [];
  const approvals: DeviceRequest[] = [];
  const finishes: DeviceResult[] = [];
  const port: SharedDevicePort = {
    version: 2,
    status: async () => ({
      deviceId: view.localDeviceId,
      localReady: true,
      cloudStatus: "online",
      policy: required(required(view.devices[0]).policy),
    }),
    directory: async () => view,
    request: async (request) => {
      calls.push(structuredClone(request));
      return { status: "completed", output: "from target" };
    },
    approve: async (request, policyVersion) => {
      approvals.push(request);
      return {
        operationId: request.operationId,
        sourceDeviceId: view.localDeviceId,
        targetDeviceId: request.targetDeviceId,
        digest: required(request.digest),
        policyVersion,
        expiresAt: Date.now() + 60000,
        signature: "signed-by-test-helper",
      };
    },
    begin: async (request) => {
      calls.push(request);
      return {
        accepted: true,
        result: { status: "running" },
        signal: new AbortController().signal,
        complete: async (result) => {
          finishes.push(result);
          return result;
        },
        close: () => {},
      };
    },
  };
  const tools = deviceExtension({ botId: "bot-existing", port }).tools ?? [];
  const invoke = (name: string, args: object, api = memoApi().api) =>
    (required(tools.find((tool) => tool.name === name)) as ToolRegistration).execute(
      args,
      api,
      BACKGROUND_CONTEXT,
    );
  return { port, view, calls, approvals, finishes, invoke };
};
const body = (value: ToolExecutionResult) =>
  JSON.parse(value.output?.find((part) => part.type === "text")?.text ?? "null");

test("incomplete raw capture segments cannot carry a credential prefix past host sanitation", () => {
  const secret = "p".repeat(32);
  const capture = captureNativeOutput(memoApi().api);
  capture.api.output("x".repeat(59969) + secret);
  capture.api.diagnostic({ severity: "info", message: "x".repeat(3960) + secret.repeat(2) });
  const output = capture.finish().output ?? "";
  assert.equal(output.includes(secret.slice(0, 31)), false);
  assert.match(output, /omitted|truncated/);
  const preTruncated = captureNativeOutput(memoApi().api).finish({
    output: [{ type: "text", text: secret.slice(0, 31) }],
    diagnostics: [
      { severity: "info", code: "truncated", message: "Showing partial native output" },
    ],
  });
  assert.equal(preTruncated.output?.includes(secret.slice(0, 31)), false);
});

test("real native bash output waits for host sanitation and preserves a replayable structured receipt", async () => {
  const bench = fixture();
  const root = await mkdtemp(join(tmpdir(), "native-stream-"));
  const env = new NodeExecutionEnv({ cwd: root });
  const live: unknown[] = [];
  const buffer = new OutputBuffer({ maxBytes: 65536, maxLines: 2000, retain: "tail" });
  const { api: base } = memoApi();
  const api: ToolExecutionApi = {
    ...base,
    env,
    outputWindow: undefined,
    output: (chunk, skip) => {
      live.push(chunk);
      buffer.push(chunk, skip);
    },
    retainedOutput: () => ({ text: buffer.snapshot().text, truncated: false }),
    diagnostic: (value) => live.push(value),
    details: async (value) => {
      live.push(value);
    },
  };
  let saved: DeviceResult = { status: "unknown" };
  bench.port.begin = async (request) => {
    bench.calls.push(request);
    return {
      accepted: true,
      result: { status: "running" },
      signal: new AbortController().signal,
      complete: async (value) => {
        bench.finishes.push(value);
        saved = {
          ...value,
          output: value.output?.replaceAll("synthetic-secret", "[redacted]") ?? "",
        };
        return saved;
      },
      close: () => {},
    };
  };
  bench.port.request = async (request) => {
    bench.calls.push(request);
    return saved;
  };
  const tool = guardNativeTool(createBashTool(), { botId: "native-bash", port: bench.port });
  try {
    const result = await tool.execute(
      { command: "printf x >> count; printf 'synthetic-secret 中文'; exit 7" },
      api,
      BACKGROUND_CONTEXT,
    );
    assert.equal(live.length, 0, "raw SDK progress/diagnostics must not enter pi.live");
    assert.match(bench.finishes[0]?.output ?? "", /synthetic-secret 中文/);
    const receipt = body(result);
    assert.equal(receipt.exitCode, 7);
    assert.equal(result.isError, true);
    assert.match(receipt.output, /\[redacted\] 中文/);
    assert.match(receipt.output, /Command exited with code 7/);
    assert.deepEqual(result.structuredOutput, receipt);
    const repeated = body(
      await tool.execute(
        { command: "printf x >> count; printf 'synthetic-secret 中文'; exit 7" },
        api,
        BACKGROUND_CONTEXT,
      ),
    );
    assert.equal(repeated.operationId, receipt.operationId);
    assert.equal(repeated.targetDeviceId, receipt.targetDeviceId);
    assert.equal(await readFile(join(root, "count"), "utf8"), "x");
  } finally {
    await env.cleanup(BACKGROUND_CONTEXT);
    await rm(root, { recursive: true, force: true });
  }
});

test("a maximal escaped output keeps a complete original-ID receipt after the SDK byte budget", async () => {
  const bench = fixture();
  bench.port.request = async () => ({ status: "completed", output: '"\\\u0001'.repeat(21000) });
  const result = await bench.invoke("remote_execute", {
    deviceId: ids[1],
    operation: { kind: "command", command: "pwd" },
  });
  const text = required(result.output?.find((part) => part.type === "text")).text;
  const bounded = boundOutput(text, { maxBytes: 65536, maxLines: 2000, retain: "tail" });
  const receipt = JSON.parse(bounded.text);
  assert.equal(bounded.droppedBytes, 0);
  assert.equal(receipt.targetDeviceId, ids[1]);
  assert.ok(receipt.operationId);
  assert.equal(receipt.truncated, true);
  assert.equal(text.includes("\uFFFD"), false);
});

test("existing and new Bot adapters read the same changing four-member directory", async () => {
  const bench = fixture();
  const initial = body(await bench.invoke("remote_status", {}));
  assert.equal(initial.devices.length, 4);
  assert.equal(initial.relayOrigin, undefined);
  required(bench.view.devices[1]).name = "Renamed B";
  bench.view.revision++;
  const tools = required(deviceExtension({ botId: "new-bot", port: bench.port }).tools);
  const status = required(tools.find((tool) => tool.name === "remote_status"));
  assert.equal(
    body(await status.execute({}, memoApi().api, BACKGROUND_CONTEXT)).devices[1].name,
    "Renamed B",
  );
  bench.port.directory = async () => {
    throw new Error("cloud_unavailable");
  };
  assert.equal(body(await bench.invoke("remote_status", {})).error, "cloud_unavailable");
});

test("transmission is memoed first; lost replies and replay query the original target and ID", async () => {
  const bench = fixture();
  const { api, memos } = memoApi();
  bench.port.request = async (request) => {
    assert.equal(memos.get("device.transmitted.v1"), true);
    bench.calls.push(structuredClone(request));
    if (request.action === "run") throw new Error("device_disconnected");
    return { status: "completed", output: "original result" };
  };
  const args = { deviceId: ids[1], operation: { kind: "command", command: "pwd" } };
  const first = body(await bench.invoke("remote_execute", args, api));
  assert.equal(first.status, "unknown");
  bench.view.relayOrigin = "https://other.example";
  required(bench.view.devices[1]).online = false;
  const replay = body(await bench.invoke("remote_execute", args, api));
  assert.equal(replay.operationId, first.operationId);
  assert.equal(replay.targetDeviceId, ids[1]);
  assert.deepEqual(
    bench.calls.map((call) => call.action),
    ["run", "get"],
  );
  assert.equal(
    bench.calls.every((call) => call.sourceBotId === "bot-existing"),
    true,
  );
  assert.equal(
    bench.calls.every((call) => call.relayOrigin === "https://devices.example"),
    true,
  );
  assert.equal(
    body(await bench.invoke("remote_execute", { ...args, deviceId: ids[2] }, api)).error,
    "operation_binding_changed",
  );
  assert.equal(bench.calls.length, 2);
});

test("an operation memo without its relay origin is never sent or recreated", async () => {
  const bench = fixture();
  const { api, memos } = memoApi();
  const operation = { kind: "command", command: "pwd" };
  const original = {
    requestId: randomUUID(),
    operationId: randomUUID(),
    targetDeviceId: ids[1],
    sourceBotId: "bot-existing",
    action: "run",
    operation,
    digest: operationDigest(operation),
  };
  memos.set("device.operation.v1", original);
  memos.set("device.transmitted.v1", true);
  const result = await bench.invoke("remote_execute", { deviceId: ids[1], operation }, api);
  assert.equal(result.isError, true);
  assert.equal(body(result).error, "relay_origin_unknown");
  assert.equal(body(result).operationId, original.operationId);
  assert.equal(body(result).targetDeviceId, original.targetDeviceId);
  assert.equal(body(result).digest, original.digest);
  assert.deepEqual(result.structuredOutput, body(result));
  assert.equal(bench.calls.length, 0);
});

test("offline, unknown, unsupported, paused and refused approval never execute or choose another device", async () => {
  for (const state of ["offline", "unknown", "unsupported", "paused", "ask", "missing", "policy"]) {
    const bench = fixture();
    const target = required(bench.view.devices[1]);
    if (state === "offline") target.online = false;
    if (state === "unknown") target.online = null;
    if (state === "unsupported") target.capabilities = null;
    if (state === "paused") required(target.policy).mode = "paused";
    if (state === "policy") target.policy = null;
    if (state === "missing") bench.view.devices.splice(1, 1);
    if (state === "ask") {
      required(target.policy).mode = "always-ask";
      bench.port.approve = async () => {
        throw new Error("approval_denied");
      };
    }
    const result = await bench.invoke("remote_execute", {
      deviceId: ids[1],
      operation: { kind: "command", command: "pwd" },
    });
    assert.equal(result.isError, true, state);
    assert.equal(bench.calls.length, 0, state);
  }
});

test("approval receives full immutable parameters and get/cancel never requests a new approval", async () => {
  const bench = fixture();
  required(bench.view.devices[2]).policy = { mode: "always-ask", version: 12 };
  const operation = { kind: "file.write", path: "/tmp/a", content: "hello" };
  const first = body(await bench.invoke("remote_execute", { deviceId: ids[2], operation }));
  assert.equal(first.status, "completed");
  assert.deepEqual(required(bench.approvals[0]).operation, operation);
  assert.equal(required(required(bench.calls[0]).approval).policyVersion, 12);
  assert.equal(required(bench.calls[0]).digest, operationDigest(operation));
  for (const action of ["get", "cancel"])
    await bench.invoke("remote_operation", {
      deviceId: ids[2],
      operationId: first.operationId,
      action,
    });
  assert.equal(bench.approvals.length, 1);
  assert.equal(
    bench.calls.every((call) => call.targetDeviceId === ids[2]),
    true,
  );
  bench.port.request = async () => {
    throw new Error("not a safe message with secret");
  };
  assert.equal(
    body(
      await bench.invoke("remote_operation", {
        deviceId: ids[2],
        operationId: first.operationId,
        action: "get",
      }),
    ).error,
    "device_request_failed",
  );
});

test("local native tools use local policy without reading the remote directory", async () => {
  const bench = fixture();
  const root = await mkdtemp(join(tmpdir(), "native-local-only-"));
  let directoryReads = 0;
  bench.port.directory = async () => {
    directoryReads++;
    throw new Error("cloud_unavailable");
  };
  const port = bench.port;
  port.status = async () => ({
    deviceId: bench.view.localDeviceId,
    localReady: true,
    cloudStatus: "unconfigured",
    policy: { mode: "all-approve", version: 1 },
  });
  const native = defineTool({
    name: "write",
    parameters: Type.Object({ content: Type.String() }),
    description: "test native implementation",
    async execute(args) {
      await writeFile(join(root, "out"), args.content);
      return { output: [{ type: "text" as const, text: "written" }] };
    },
  });
  try {
    const result = await guardNativeTool(native, { botId: "local-bot", port }).execute(
      { content: "local-only" },
      memoApi().api,
      BACKGROUND_CONTEXT,
    );
    assert.equal(body(result).status, "completed");
    assert.equal(await readFile(join(root, "out"), "utf8"), "local-only");
    assert.equal(directoryReads, 0);
    assert.equal(bench.calls[0]?.targetDeviceId, bench.view.localDeviceId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local always-ask policy still requires a bound approval", async () => {
  const bench = fixture();
  required(bench.view.devices[0]).policy = { mode: "always-ask", version: 3 };
  const native = defineTool({
    name: "write",
    description: "test native implementation",
    parameters: Type.Object({}),
    async execute() {
      return { output: [{ type: "text" as const, text: "written" }] };
    },
  });
  const result = await guardNativeTool(native, { botId: "local-bot", port: bench.port }).execute(
    {},
    memoApi().api,
    BACKGROUND_CONTEXT,
  );
  assert.equal(body(result).status, "completed");
  assert.equal(bench.approvals.length, 1);
  assert.equal(bench.approvals[0]?.targetDeviceId, bench.view.localDeviceId);
  assert.equal(bench.calls[0]?.approval?.policyVersion, 3);
});

test("a refused local approval never begins the native tool", async () => {
  const bench = fixture();
  required(bench.view.devices[0]).policy = { mode: "always-ask", version: 3 };
  bench.port.approve = async () => {
    throw new Error("approval_denied");
  };
  let runs = 0;
  const native = defineTool({
    name: "write",
    description: "test native implementation",
    parameters: Type.Object({}),
    async execute() {
      runs++;
      return { output: [{ type: "text" as const, text: "written" }] };
    },
  });
  const result = await guardNativeTool(native, { botId: "local-bot", port: bench.port }).execute(
    {},
    memoApi().api,
    BACKGROUND_CONTEXT,
  );
  assert.equal(result.isError, true);
  assert.equal(body(result).error, "approval_denied");
  assert.equal(runs, 0);
  assert.equal(bench.calls.length, 0);
});

test("a paused local policy permits original-ID recovery without another execution", async () => {
  const bench = fixture();
  let runs = 0;
  const native = defineTool({
    name: "write",
    description: "test native implementation",
    parameters: Type.Object({}),
    async execute() {
      runs++;
      return { output: [{ type: "text" as const, text: "written" }] };
    },
  });
  const guarded = guardNativeTool(native, { botId: "local-bot", port: bench.port });
  const { api } = memoApi();
  const first = body(await guarded.execute({}, api, BACKGROUND_CONTEXT));
  required(bench.view.devices[0]).policy = { mode: "paused", version: 2 };
  const recovered = body(await guarded.execute({}, api, BACKGROUND_CONTEXT));
  assert.equal(first.status, "completed");
  assert.equal(runs, 1);
  assert.equal(bench.approvals.length, 0);
  assert.equal(bench.calls.length, 2);
  assert.equal(bench.calls[1]?.action, "get");
  assert.equal(bench.calls[1]?.operationId, first.operationId);
  assert.equal(bench.calls[1]?.targetDeviceId, bench.view.localDeviceId);
  assert.equal(recovered.operationId, first.operationId);
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.output, "from target");
});

test("local status and policy failures never bypass native admission", async () => {
  for (const state of ["unavailable", "paused", "disconnected"]) {
    const bench = fixture();
    let runs = 0;
    const native = defineTool({
      name: "write",
      description: "test native implementation",
      parameters: Type.Object({}),
      async execute() {
        runs++;
        return { output: [{ type: "text" as const, text: "written" }] };
      },
    });
    bench.port.status = async () => {
      if (state === "disconnected") throw new Error("device_unavailable");
      return {
        deviceId: bench.view.localDeviceId,
        localReady: state !== "unavailable",
        cloudStatus: "unconfigured",
        policy: { mode: state === "paused" ? "paused" : "all-approve", version: 1 },
      };
    };
    const result = await guardNativeTool(native, { botId: "local-bot", port: bench.port }).execute(
      {},
      memoApi().api,
      BACKGROUND_CONTEXT,
    );
    assert.equal(result.isError, true, state);
    assert.equal(runs, 0, state);
    assert.equal(bench.calls.length, 0, state);
  }
});

test("native tools require admission before touching real files and replay never invokes them twice", async () => {
  const bench = fixture();
  const root = await mkdtemp(join(tmpdir(), "native-policy-"));
  let runs = 0;
  const native = defineTool({
    name: "write",
    parameters: Type.Object({ content: Type.String() }),
    description: "test native implementation",
    async execute(args) {
      runs++;
      await writeFile(join(root, "out"), args.content);
      return { output: [{ type: "text" as const, text: "native result" }] };
    },
  });
  const guarded = guardNativeTool(native, { botId: "native-bot", port: bench.port });
  try {
    const realBegin = bench.port.begin;
    bench.port.begin = async () => ({ accepted: false, result: { status: "busy" } });
    assert.equal(
      body(await guarded.execute({ content: "denied" }, memoApi().api, BACKGROUND_CONTEXT)).status,
      "busy",
    );
    await assert.rejects(readFile(join(root, "out")), { code: "ENOENT" });
    bench.port.begin = realBegin;
    const { api } = memoApi();
    await guarded.execute({ content: "accepted" }, api, BACKGROUND_CONTEXT);
    await guarded.execute({ content: "accepted" }, api, BACKGROUND_CONTEXT);
    assert.equal(runs, 1);
    assert.equal(await readFile(join(root, "out"), "utf8"), "accepted");
    assert.equal(required(bench.finishes[0]).status, "completed");
    assert.equal(required(bench.calls[0]).targetDeviceId, bench.view.localDeviceId);
    assert.equal(required(required(bench.calls[0]).operation).kind, "native");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native completion returns host-sanitized output and storage failure is unknown without a second settlement", async () => {
  const bench = fixture();
  let finishes = 0;
  let fail = false;
  bench.port.begin = async () => ({
    accepted: true,
    result: { status: "running" },
    signal: new AbortController().signal,
    complete: async () => {
      finishes++;
      if (fail) throw new Error("storage_failed");
      return { status: "completed", output: "[redacted]" };
    },
    close: () => {},
  });
  const original = defineTool({
    name: "read",
    description: "fixture",
    parameters: Type.Object({}),
    async execute() {
      return { output: [{ type: "text" as const, text: "private synthetic value" }] };
    },
  });
  const tool = guardNativeTool(original, { botId: "bot", port: bench.port });
  assert.equal(
    body(await tool.execute({}, memoApi().api, BACKGROUND_CONTEXT)).output,
    "[redacted]",
  );
  assert.equal(finishes, 1);
  fail = true;
  const result = body(await tool.execute({}, memoApi().api, BACKGROUND_CONTEXT));
  assert.equal(result.status, "unknown");
  assert.equal(finishes, 2);
  original.execute = async () => {
    throw new Error("native_failed");
  };
  fail = false;
  await guardNativeTool(original, { botId: "bot", port: bench.port }).execute(
    {},
    memoApi().api,
    BACKGROUND_CONTEXT,
  );
  assert.equal(finishes, 3);
});

test("v1 canonical parameters use ordered keys and preserve Unicode/slashes/control characters", () => {
  assert.equal(
    canonicalJSON({ z: "书/房\n", a: [1, true, null] }),
    '{"a":[1,true,null],"z":"书/房\\n"}',
  );
  assert.equal(
    operationDigest({ kind: "command", command: "pwd" }),
    operationDigest({ command: "pwd", kind: "command" }),
  );
});

test("the independent adapter uses the same canonical wire vectors as the App helper", async () => {
  const vector = JSON.parse(
    await readFile(
      new URL(
        "../../../../fixtures/bots-protocol/device-access-v1/canonical.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(canonicalJSON(vector.operation), vector.canonical);
  assert.equal(operationDigest(vector.operation), vector.digest);
});

test("device crossings record one trace and origin without arguments, receipts or secrets", async () => {
  const bench = fixture();
  const records: LogRecord[] = [];
  const tools = required(
    deviceExtension({
      botId: "bot",
      port: bench.port,
      log: new Log((record) => records.push(record)),
    }).tools,
  );
  const status = required(tools.find((tool) => tool.name === "remote_status"));
  await status.execute({}, memoApi().api, BACKGROUND_CONTEXT);
  bench.port.directory = async () => {
    throw new Error("secret command and credentials");
  };
  await status.execute({}, memoApi().api, BACKGROUND_CONTEXT);
  assert.deepEqual(
    records.map((record) => record.evt),
    ["runtime.device.start", "runtime.device.ok", "runtime.device.start", "runtime.device.fail"],
  );
  assert.equal(required(records[0]).trace, required(records[1]).trace);
  assert.equal(required(records[2]).trace, required(records[3]).trace);
  assert.equal(required(required(records[3]).err).origin, true);
  assert.equal(records.filter((record) => record.level === "error").length, 1);
  assert.equal(JSON.stringify(records).includes("secret"), false);
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Required fixture value is absent");
  return value;
}
