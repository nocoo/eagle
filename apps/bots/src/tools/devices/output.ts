import { OutputBuffer } from "@earendil-works/chord/output";
import { Type } from "@earendil-works/pi-ai";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import type { DeviceRequest, DeviceResult } from "./port.ts";

export const deviceOutputLimits = { maxBytes: 65536, maxLines: 2000, retain: "head" as const };
export const deviceReceiptSchema = Type.Object({
  type: Type.Literal("device-operation"),
  version: Type.Literal(1),
  targetDeviceId: Type.String(),
  operationId: Type.String(),
  digest: Type.Optional(Type.String()),
  status: Type.String(),
  output: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  exitCode: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  truncated: Type.Boolean(),
  diagnostics: Type.Optional(Type.Array(Type.String())),
});

/** Bound only the payload: the full receipt must survive the SDK's final text budget. */
export function deviceReceipt(request: DeviceRequest, result: DeviceResult): ToolExecutionResult {
  const value = {
    type: "device-operation",
    version: 1,
    targetDeviceId: request.targetDeviceId,
    operationId: request.operationId,
    ...(request.digest === undefined ? {} : { digest: request.digest }),
    status: result.status,
    ...(result.output === undefined ? {} : { output: result.output }),
    ...(result.error === undefined ? {} : { error: result.error }),
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    truncated: false,
  };
  let text = JSON.stringify(value);
  if (Buffer.byteLength(text) > deviceOutputLimits.maxBytes) {
    value.truncated = true;
    const output = result.output ?? "";
    let low = 0;
    let high = output.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      value.output = prefix(output, middle);
      if (Buffer.byteLength(JSON.stringify(value)) <= deviceOutputLimits.maxBytes) low = middle;
      else high = middle - 1;
    }
    value.output = prefix(output, low);
    text = JSON.stringify(value);
  }
  return {
    output: [{ type: "text", text }],
    structuredOutput: value,
    ...(["failed", "denied", "busy", "unknown", "cancelled"].includes(result.status)
      ? { isError: true }
      : {}),
  };
}
function prefix(text: string, end: number): string {
  const previous = text.charCodeAt(end - 1);
  return text.slice(0, previous >= 0xd800 && previous <= 0xdbff ? end - 1 : end);
}

/** Raw progress stays in bounded memory until the device service sanitizes and journals it. */
export function captureNativeOutput(api: ToolExecutionApi) {
  const output = new OutputBuffer({ ...deviceOutputLimits, maxBytes: 60000 });
  const metadata = new OutputBuffer({ ...deviceOutputLimits, maxBytes: 4000 });
  const env = api.env;
  const privateEnv =
    env === undefined
      ? undefined
      : new Proxy(env, {
          get(target, property) {
            if (property === "exec")
              return (
                command: Parameters<typeof target.exec>[0],
                options: Parameters<typeof target.exec>[1],
                context: Parameters<typeof target.exec>[2],
              ) => {
                const { spill: _spill, window: _window, ...bounded } = options ?? {};
                return target.exec(command, bounded, context);
              };
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
  const wrapped: ToolExecutionApi = {
    ...api,
    env: privateEnv,
    outputWindow: undefined,
    output: (chunk) => {
      output.push(chunk);
    },
    retainedOutput: () => ({
      text: output.snapshot().text,
      truncated: output.snapshot().droppedBytes > 0,
    }),
    diagnostic: (value) => {
      metadata.push(`\n[${value.severity}] ${value.message}`);
    },
    details: async (value) => {
      metadata.push(`\n[details] ${JSON.stringify(value)}`);
    },
  };
  return {
    api: wrapped,
    finish(result: ToolExecutionResult = {}): Pick<DeviceResult, "output" | "exitCode"> {
      output.end();
      let outputText: string;
      let outputTruncated = output.snapshot().droppedBytes > 0;
      if (result.output !== undefined) {
        // SDK semantics: an explicit result replaces streaming text.
        const explicit = new OutputBuffer({ ...deviceOutputLimits, maxBytes: 60000 });
        for (const part of result.output) {
          if (part.type === "text") explicit.push(part.text);
          else metadata.push("\n[non-text native content omitted from device journal]");
        }
        outputText = explicit.snapshot().text;
        outputTruncated = explicit.snapshot().droppedBytes > 0;
      } else outputText = output.snapshot().text;
      for (const diagnostic of result.diagnostics ?? []) wrapped.diagnostic(diagnostic);
      if (result.details !== undefined)
        metadata.push(`\n[details] ${JSON.stringify(result.details)}`);
      const structure = result.structuredOutput;
      outputTruncated ||=
        result.diagnostics?.some((value) => value.code === "truncated") === true ||
        (typeof structure === "object" &&
          structure !== null &&
          !Array.isArray(structure) &&
          structure.truncated === true);
      const exitCode =
        typeof structure === "object" &&
        structure !== null &&
        !Array.isArray(structure) &&
        typeof structure.exitCode === "number"
          ? structure.exitCode
          : undefined;
      return {
        output:
          (outputTruncated ? "[native output omitted: incomplete capture]" : outputText) +
          (metadata.snapshot().droppedBytes > 0
            ? "\n[native metadata omitted: incomplete capture]"
            : metadata.snapshot().text),
        ...(exitCode === undefined ? {} : { exitCode }),
      };
    },
  };
}
