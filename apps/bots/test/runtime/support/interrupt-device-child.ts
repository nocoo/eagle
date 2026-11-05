import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { SharedDevicePort } from "../../../src/tools/devices/port.ts";
import { deviceExtension } from "../../../src/tools/devices/tools.ts";

const dir = process.argv[2];
if (dir === undefined) throw new Error("usage: interrupt-device-child.ts <dir>");
const local = randomUUID();
const target = randomUUID();
const mode = process.argv[3] ?? "execute";
if (!["execute", "coerced", "extra", "get", "get-extra", "cancel"].includes(mode))
  throw new Error("invalid test mode");
const operationId = randomUUID();
const action = mode === "get-extra" ? "get" : mode;
const port: SharedDevicePort = {
  version: 2,
  status: async () => ({
    deviceId: local,
    localReady: true,
    cloudStatus: "online",
    policy: { mode: "all-approve", version: 1 },
  }),
  directory: async () => ({
    localDeviceId: local,
    groupId: "test",
    revision: 1,
    relayOrigin: "https://devices.example",
    devices: [local, target].map((deviceId) => ({
      deviceId,
      name: "Fixture",
      platform: "darwin",
      arch: "arm64",
      online: true,
      lastSeenAt: 1,
      capabilities: ["command"],
      policy: { mode: "all-approve", version: 1 },
    })),
  }),
  request: async (request) => {
    if (request.action !== (["execute", "coerced", "extra"].includes(mode) ? "run" : action))
      throw new Error("unexpected_request");
    await appendFile(join(dir, "side-effects"), `${request.operationId}\n`);
    process.stdout.write(
      `sent:${request.operationId}:${request.targetDeviceId}:${request.digest ?? "none"}\n`,
    );
    return new Promise(() => {});
  },
  approve: async () => {
    throw new Error("unexpected_approval");
  },
  begin: async () => {
    throw new Error("unexpected_native");
  },
};
const extension = deviceExtension({ botId: "b_runtime", port });
const registry = createRegistry();
registry.install(extension);
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
  fauxAssistantMessage(
    [
      ["execute", "coerced", "extra"].includes(mode)
        ? fauxToolCall(
            "remote_execute",
            {
              deviceId: target,
              operation: {
                kind: "command",
                command: "fixture",
                ...(mode === "coerced" ? { timeoutMs: "1000" } : {}),
              },
              ...(mode === "extra" ? { note: "fixture" } : {}),
            },
            { id: "call_recovery_fixture" },
          )
        : fauxToolCall(
            "remote_operation",
            {
              deviceId: target,
              operationId,
              action,
              ...(mode === "get-extra" ? { note: "fixture" } : {}),
            },
            { id: "call_recovery_fixture" },
          ),
    ],
    { stopReason: "toolUse" },
  ),
]);
const harness = await Harness.open(
  await openNodeSqliteStorage(join(dir, "session.sqlite")),
  { models, registry, settings: { compaction: { enabled: false } } as never },
  context,
);
const root = await harness.root(context, {
  agent: {
    model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
    extensions: [extension],
  },
});
await root.submit(
  { type: "input", content: "use the peer", requestId: "r_device_recovery", whenBusy: "followUp" },
  context,
);
setInterval(() => undefined, 1000);
