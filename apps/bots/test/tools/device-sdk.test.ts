import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Type,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  type NestedToolExecutionResult,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import type { SharedDevicePort } from "../../src/tools/devices/port.ts";
import { guardNativeTool } from "../../src/tools/devices/tools.ts";

test("a real SDK nested native bash call validates the sanitized structured device result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "device-sdk-"));
  const env = new NodeExecutionEnv({ cwd: directory });
  const deviceId = randomUUID();
  const port: SharedDevicePort = {
    version: 2,
    status: async () => ({
      deviceId,
      localReady: true,
      cloudStatus: "offline",
      policy: { mode: "all-approve", version: 1 },
    }),
    directory: async () => ({
      localDeviceId: deviceId,
      groupId: null,
      revision: 0,
      devices: [
        {
          deviceId,
          name: "Local",
          platform: "darwin",
          arch: "arm64",
          online: true,
          lastSeenAt: null,
          capabilities: ["command"],
          policy: { mode: "all-approve", version: 1 },
        },
      ],
    }),
    request: async () => {
      throw new Error("unexpected_request");
    },
    approve: async () => {
      throw new Error("unexpected_approval");
    },
    begin: async () => ({
      accepted: true,
      result: { status: "running" },
      signal: new AbortController().signal,
      complete: async (value) => ({
        ...value,
        output: value.output?.replaceAll("synthetic-credential", "[redacted]") ?? "",
      }),
      close: () => {},
    }),
  };
  let nested: NestedToolExecutionResult | undefined;
  const probe = defineTool({
    name: "probe",
    description: "Nested integration",
    parameters: Type.Object({}),
    async execute(_args, api, ctx) {
      nested = await api.executeTool("bash", { command: "printf synthetic-credential" }, ctx);
      return { output: [{ type: "text", text: JSON.stringify(nested) }] };
    },
  });
  const extension = defineExtension({
    name: "device-native-test",
    tools: [guardNativeTool(createBashTool(), { botId: "test", port }), probe],
  });
  const registry = createRegistry();
  registry.install(extension);
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(directory, "session.sqlite")),
    { registry, models, env: () => env },
    context,
  );
  try {
    const root = await harness.root(context, {
      agent: {
        model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
        cwd: directory,
        extensions: [extension],
      },
    });
    const submission = await root.submit(
      { type: "input", content: "test", requestId: "device-native-test", whenBusy: "followUp" },
      context,
    );
    await submission.wait(context);
    assert.ok(nested);
    assert.equal(nested.isError, false, JSON.stringify(nested.diagnostics));
    assert.equal((nested.structuredOutput as { output: string }).output, "[redacted]");
    assert.equal((nested.structuredOutput as { targetDeviceId: string }).targetDeviceId, deviceId);
    assert.equal(JSON.stringify(nested).includes("synthetic-credential"), false);
  } finally {
    await harness.close(context);
    await env.cleanup(context);
    await rm(directory, { recursive: true, force: true });
  }
});
