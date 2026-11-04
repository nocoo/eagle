import { createHash } from "node:crypto";
import { z } from "zod";
import { DeviceChannel } from "./socket.ts";

export type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONValue[]
  | { [key: string]: JSONValue };
export const policySchema = z.object({
  mode: z.enum(["all-approve", "always-ask", "paused"]),
  version: z.number().int().positive(),
});
export const localStatusSchema = z.object({
  deviceId: z.uuid(),
  localReady: z.boolean(),
  cloudStatus: z.enum(["online", "offline", "unconfigured"]),
  policy: policySchema,
});
export const deviceSchema = z.object({
  deviceId: z.uuid(),
  name: z.string(),
  platform: z.string(),
  arch: z.string(),
  online: z.boolean().nullable(),
  lastSeenAt: z.number().nullable(),
  capabilities: z.array(z.string()).nullable(),
  policy: policySchema.nullable(),
});
export const directorySchema = z.object({
  localDeviceId: z.uuid(),
  groupId: z.string().nullable(),
  revision: z.number(),
  observationRevision: z.string().optional(),
  cloudStatus: z.enum(["online", "offline", "unconfigured"]).optional(),
  relayOrigin: z.url().optional(),
  devices: z.array(deviceSchema),
});
export const resultSchema = z.object({
  status: z.enum(["running", "completed", "failed", "cancelled", "unknown", "busy", "denied"]),
  output: z.string().optional(),
  error: z.string().optional(),
  exitCode: z.number().nullable().optional(),
});
export const approvalSchema = z.object({
  operationId: z.uuid(),
  sourceDeviceId: z.uuid(),
  targetDeviceId: z.uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  policyVersion: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  signature: z.string(),
});
export type DeviceLocalStatus = z.infer<typeof localStatusSchema>;
export type DeviceDirectory = z.infer<typeof directorySchema>;
export type DeviceResult = z.infer<typeof resultSchema>;
export type DeviceApproval = z.infer<typeof approvalSchema>;
export type DeviceOperation = { [key: string]: JSONValue } & { kind: string };
export type DeviceRequest = {
  requestId: string;
  operationId: string;
  targetDeviceId: string;
  sourceBotId: string;
  relayOrigin?: string;
  action: "run" | "get" | "cancel";
  operation?: DeviceOperation;
  digest?: string;
  approval?: DeviceApproval;
};
export type NativeAdmission =
  | { accepted: false; result: DeviceResult }
  | {
      accepted: true;
      result: DeviceResult;
      signal: AbortSignal;
      complete(result: DeviceResult): Promise<DeviceResult>;
      close(): void;
    };
export interface SharedDevicePort {
  readonly version: 2;
  status(signal?: AbortSignal): Promise<DeviceLocalStatus>;
  directory(signal?: AbortSignal): Promise<DeviceDirectory>;
  request(request: DeviceRequest, signal?: AbortSignal): Promise<DeviceResult>;
  approve(
    request: DeviceRequest,
    policyVersion: number,
    signal?: AbortSignal,
  ): Promise<DeviceApproval>;
  begin(request: DeviceRequest, signal?: AbortSignal): Promise<NativeAdmission>;
}

/** Canonical v1 wire bytes, independent from any host's source or build. */
export const canonicalJSON = (value: JSONValue): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key] ?? null)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};
export const operationDigest = (operation: DeviceOperation): string =>
  createHash("sha256").update(canonicalJSON(operation)).digest("hex");

export class SocketDevicePort implements SharedDevicePort {
  readonly version = 2;
  readonly #path: string;
  constructor(path: string) {
    this.#path = path;
  }

  async #call(
    method: string,
    params?: unknown,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<unknown> {
    const channel = new DeviceChannel(this.#path, timeoutMs);
    try {
      return await channel.call(method, params, signal);
    } finally {
      channel.close();
    }
  }

  async status(signal?: AbortSignal): Promise<DeviceLocalStatus> {
    return localStatusSchema.parse(await this.#call("status", undefined, signal, 2000));
  }
  async directory(signal?: AbortSignal): Promise<DeviceDirectory> {
    return directorySchema.parse(await this.#call("directory", undefined, signal));
  }
  async request(request: DeviceRequest, signal?: AbortSignal): Promise<DeviceResult> {
    const method = request.action === "run" ? "execute" : `operation.${request.action}`;
    const operation = request.operation;
    const command = request.action === "run" && operation?.kind === "command";
    const duration = operation?.timeoutMs;
    const timeoutMs = command
      ? (typeof duration === "number" &&
        Number.isInteger(duration) &&
        duration >= 1 &&
        duration <= 300000
          ? duration
          : 30000) + 95000
      : undefined;
    return resultSchema.parse(await this.#call(method, request, signal, timeoutMs));
  }
  async approve(
    request: DeviceRequest,
    policyVersion: number,
    signal?: AbortSignal,
  ): Promise<DeviceApproval> {
    return z.object({ approval: approvalSchema }).parse(
      await this.#call(
        "approval.request",
        {
          request,
          policyVersion,
          expiresAt: Date.now() + 60000,
        },
        signal,
      ),
    ).approval;
  }
  async begin(request: DeviceRequest, signal?: AbortSignal): Promise<NativeAdmission> {
    const channel = new DeviceChannel(this.#path);
    try {
      const value = z
        .object({
          accepted: z.boolean(),
          result: resultSchema,
          leaseId: z.uuid().optional(),
          expiresAt: z.number().optional(),
        })
        .parse(await channel.call("local.begin", request, signal));
      if (!value.accepted) {
        channel.close();
        return { accepted: false, result: value.result };
      }
      if (value.leaseId === undefined) throw new Error("invalid_native_lease");
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      let heartbeating = false;
      let closed = false;
      const heartbeat = setInterval(() => {
        if (heartbeating || closed) return;
        heartbeating = true;
        void channel
          .call("local.heartbeat", { operationId: request.operationId, leaseId: value.leaseId })
          .then(
            () => {
              heartbeating = false;
            },
            () => {
              heartbeating = false;
              controller.abort();
            },
          );
      }, 10000);
      heartbeat.unref();
      const close = () => {
        closed = true;
        clearInterval(heartbeat);
        signal?.removeEventListener("abort", abort);
        controller.abort();
        channel.close();
      };
      return {
        accepted: true,
        result: value.result,
        signal: controller.signal,
        complete: async (result) => {
          try {
            return resultSchema.parse(
              await channel.call("local.complete", {
                operationId: request.operationId,
                leaseId: value.leaseId,
                result,
              }),
            );
          } finally {
            close();
          }
        },
        close,
      };
    } catch (error) {
      channel.close();
      throw error;
    }
  }
}
