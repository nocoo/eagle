import { createHash, randomUUID } from "node:crypto";
import { type Context, withAbortSignal } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  section,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { declareEvent } from "../../log/events.ts";
import type { Log } from "../../log/log.ts";
import {
  captureNativeOutput,
  deviceOutputLimits,
  deviceReceiptSchema,
  deviceReceipt as receipt,
} from "./output.ts";
import {
  type DeviceDirectory,
  type DeviceLocalStatus,
  type DeviceOperation,
  type DeviceRequest,
  type JSONValue,
  operationDigest,
  type SharedDevicePort,
} from "./port.ts";

export const DEVICE_EXTENSION = "bots-shared-devices-v1";
export type DeviceToolsOptions = { botId: string; port: SharedDevicePort; log?: Log };
const Events = {
  start: declareEvent("runtime.device.start"),
  ok: declareEvent("runtime.device.ok"),
  fail: declareEvent("runtime.device.fail"),
};
export const observeDeviceTool = <T extends ToolRegistration>(
  tool: T,
  options: DeviceToolsOptions,
): T => ({
  ...tool,
  execute: async (args, api, context) => {
    const fields = { trace: deviceTrace(options.botId, api.callId), botId: options.botId };
    options.log?.emit("info", "runtime", Events.start, fields);
    const result = await tool.execute(args, api, context);
    if (result.isError) {
      options.log?.emit("error", "runtime", Events.fail, {
        ...fields,
        origin: true,
        failure: { id: `f_${randomUUID()}`, kind: "extension_error", layer: "runtime" },
      });
    } else {
      options.log?.emit("info", "runtime", Events.ok, fields);
    }
    return result;
  },
});
const textResult = (value: unknown, isError = false): ToolExecutionResult => ({
  output: [{ type: "text", text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});
const safeError = (error: unknown) =>
  error instanceof Error && /^[a-z][a-z0-9_]{0,80}$/.test(error.message)
    ? error.message
    : "device_request_failed";

/** Durable memo precedes every side effect, including the transmission itself. */
export async function bindDeviceOperation(
  options: DeviceToolsOptions,
  target: string,
  operation: DeviceOperation,
  api: ToolExecutionApi,
  context: Context,
  relayOrigin?: string,
): Promise<DeviceRequest> {
  const digest = operationDigest(operation);
  const candidate = {
    requestId: randomUUID(),
    operationId: randomUUID(),
    targetDeviceId: target,
    sourceBotId: options.botId,
    ...(relayOrigin === undefined ? {} : { relayOrigin }),
    action: "run" as const,
    operation,
    digest,
  };
  const stored = (await api.memo(
    "device.operation.v1",
    candidate,
    context,
  )) as unknown as DeviceRequest;
  if (
    stored.targetDeviceId !== target ||
    stored.digest !== digest ||
    stored.sourceBotId !== options.botId ||
    stored.relayOrigin !== relayOrigin ||
    stored.operation === undefined ||
    operationDigest(stored.operation) !== digest
  ) {
    throw new Error("operation_binding_changed");
  }
  return stored;
}

async function requireRemote(options: DeviceToolsOptions, signal?: AbortSignal): Promise<void> {
  const status = await options.port.status(signal);
  if (!status.localReady) throw new Error("device_service_unavailable");
  if (status.cloudStatus === "unconfigured") throw new Error("remote_not_configured");
}

async function authorizePolicy(
  options: DeviceToolsOptions,
  policy: DeviceLocalStatus["policy"],
  request: DeviceRequest,
  context: Context,
): Promise<DeviceRequest> {
  if (policy.mode === "paused") throw new Error("device_access_paused");
  if (policy.mode === "always-ask") {
    return {
      ...request,
      approval: await options.port.approve(request, policy.version, context.abortSignal),
    };
  }
  return request;
}

async function authorize(
  options: DeviceToolsOptions,
  directory: DeviceDirectory,
  request: DeviceRequest,
  context: Context,
): Promise<DeviceRequest> {
  const target = directory.devices.find((device) => device.deviceId === request.targetDeviceId);
  if (target === undefined) throw new Error("target_not_in_directory");
  if (target.deviceId === directory.localDeviceId) throw new Error("local_target_use_native_tools");
  if (target.online !== true) throw new Error("target_offline_or_unknown");
  if (
    request.operation?.kind !== "native" &&
    !target.capabilities?.includes(request.operation?.kind ?? "")
  )
    throw new Error("target_capability_unavailable");
  if (target.policy === null) throw new Error("target_policy_unknown");
  return authorizePolicy(options, target.policy, request, context);
}

const operationParameters = Type.Union([
  Type.Object({
    kind: Type.Literal("command"),
    command: Type.String({ minLength: 1, maxLength: 65536 }),
    cwd: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 300000 })),
  }),
  Type.Object({ kind: Type.Literal("file.read"), path: Type.String({ minLength: 1 }) }),
  Type.Object({ kind: Type.Literal("file.list"), path: Type.String({ minLength: 1 }) }),
  Type.Object({
    kind: Type.Literal("file.write"),
    path: Type.String({ minLength: 1 }),
    content: Type.String({ maxLength: 262144 }),
  }),
]);

export const deviceExtension = (options: DeviceToolsOptions) =>
  defineExtension({
    name: DEVICE_EXTENSION,
    tools: [
      defineTool({
        name: "remote_status",
        description:
          "Read the shared device directory for another computer: localDeviceId, online targets, capabilities and policy.",
        parameters: Type.Object({}),
        replay: "safe",
        async execute(_args, _api, context) {
          try {
            await requireRemote(options, context.abortSignal);
            const { relayOrigin: _origin, ...directory } = await options.port.directory(
              context.abortSignal,
            );
            if (directory.cloudStatus === "unconfigured") throw new Error("remote_not_configured");
            return textResult(directory);
          } catch (error) {
            return textResult({ error: safeError(error) }, true);
          }
        },
      }),
      defineTool({
        name: "remote_execute",
        description:
          "Run a command or file operation on the deviceId from remote_status; that deviceId stays bound to the operation.",
        parameters: Type.Object({
          deviceId: Type.String({ format: "uuid" }),
          operation: operationParameters,
        }),
        replay: "safe",
        outputLimits: deviceOutputLimits,
        structuredOutputSchema: deviceReceiptSchema,
        async execute(args, api, context) {
          let request: DeviceRequest | undefined;
          try {
            const previous = (await api.memo("device.operation.v1", context)) as
              | DeviceRequest
              | undefined;
            let directory: DeviceDirectory | undefined;
            if (previous) {
              if (
                previous.targetDeviceId !== args.deviceId ||
                previous.sourceBotId !== options.botId ||
                previous.digest !== operationDigest(args.operation) ||
                previous.operation === undefined ||
                operationDigest(previous.operation) !== previous.digest
              )
                throw new Error("operation_binding_changed");
              request = previous;
              if (!previous.relayOrigin) throw new Error("relay_origin_unknown");
            }
            await requireRemote(options, context.abortSignal);
            if (!previous) directory = await options.port.directory(context.abortSignal);
            const origin = previous?.relayOrigin ?? directory?.relayOrigin;
            if (!origin) throw new Error("remote_directory_unavailable");
            request = await bindDeviceOperation(
              options,
              args.deviceId,
              args.operation,
              api,
              context,
              origin,
            );
            if (await api.memo("device.transmitted.v1", context)) {
              return receipt(
                request,
                await options.port.request({ ...request, action: "get" }, context.abortSignal),
              );
            }
            directory ??= await options.port.directory(context.abortSignal);
            if (directory.relayOrigin !== origin) throw new Error("remote_configuration_changed");
            request = await authorize(options, directory, request, context);
            await api.memo("device.transmitted.v1", true, context);
            return receipt(request, await options.port.request(request, context.abortSignal));
          } catch (error) {
            const failure = { status: "unknown" as const, error: safeError(error) };
            return request === undefined ? textResult(failure, true) : receipt(request, failure);
          }
        },
      }),
      defineTool({
        name: "remote_operation",
        description:
          "Query or cancel an existing operation on its original deviceId and operationId.",
        parameters: Type.Object({
          deviceId: Type.String({ format: "uuid" }),
          operationId: Type.String({ format: "uuid" }),
          action: Type.Union([Type.Literal("get"), Type.Literal("cancel")]),
        }),
        replay: "safe",
        outputLimits: deviceOutputLimits,
        structuredOutputSchema: deviceReceiptSchema,
        async execute(args, _api, context) {
          const request: DeviceRequest = {
            requestId: randomUUID(),
            sourceBotId: options.botId,
            targetDeviceId: args.deviceId,
            operationId: args.operationId,
            action: args.action,
          };
          try {
            await requireRemote(options, context.abortSignal);
            return receipt(request, await options.port.request(request, context.abortSignal));
          } catch (error) {
            return receipt(request, { status: "unknown", error: safeError(error) });
          }
        },
      }),
    ].map((tool) => observeDeviceTool(tool, options)),
    sections: [
      section("shared-devices-v1", () =>
        [
          "These tools control other computers. Use bash for this computer.",
          "remote_status reads the shared device directory; remote_execute runs one operation on a deviceId from that directory; remote_operation queries or cancels it by the original deviceId and operationId.",
          "An uncertain result keeps its original IDs. A busy response is a completed refusal. Device policy applies to every request; always-ask completes after the App confirms it.",
        ].join("\n"),
      ),
    ],
  });

/** Wrap the native implementation; the host only authorizes, never reimplements its work. */
export const guardNativeTool = <T extends ToolRegistration>(
  tool: T,
  options: DeviceToolsOptions,
): T => ({
  ...tool,
  replay: "safe",
  outputLimits: deviceOutputLimits,
  structuredOutputSchema: deviceReceiptSchema,
  execute: async (args, api, context) => {
    let request: DeviceRequest | undefined;
    let admission: Awaited<ReturnType<SharedDevicePort["begin"]>> | undefined;
    try {
      const status = await options.port.status(context.abortSignal);
      if (!status.localReady) throw new Error("device_service_unavailable");
      const agent = await api.agent(context);
      const operation: DeviceOperation = {
        kind: "native",
        tool: tool.name,
        args: args as JSONValue,
        ...(agent.cwd === undefined ? {} : { cwd: agent.cwd }),
      };
      request = await bindDeviceOperation(options, status.deviceId, operation, api, context);
      if (await api.memo("device.transmitted.v1", context)) {
        return receipt(
          request,
          await options.port.request({ ...request, action: "get" }, context.abortSignal),
        );
      }
      request = await authorizePolicy(options, status.policy, request, context);
      await api.memo("device.transmitted.v1", true, context);
      admission = await options.port.begin(request, context.abortSignal);
      if (!admission.accepted) return receipt(request, admission.result);
      const captured = captureNativeOutput(api);
      let result: ToolExecutionResult;
      try {
        result = await tool.execute(args, captured.api, withAbortSignal(admission.signal, context));
      } catch (error) {
        const settled = await admission.complete({
          status: context.abortSignal?.aborted || admission.signal.aborted ? "cancelled" : "failed",
          error: safeError(error),
          ...captured.finish(),
        });
        return receipt(request, settled);
      }
      const settled = await admission.complete({
        status: result.isError ? "failed" : "completed",
        ...captured.finish(result),
      });
      return receipt(request, settled);
    } catch (error) {
      const failure = { status: "unknown" as const, error: safeError(error) };
      return request === undefined ? textResult(failure, true) : receipt(request, failure);
    } finally {
      if (admission?.accepted) admission.close();
    }
  },
});

export const deviceTrace = (botId: string, callId: string): string =>
  `tr_device_${createHash("sha256").update(`${botId}\0${callId}`).digest("hex").slice(0, 24)}`;
