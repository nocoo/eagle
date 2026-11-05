import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  canonicalDeviceJSON,
  DeviceApproval,
  type DeviceDirectory,
  DeviceId,
  DevicePolicy,
  DeviceRegistration,
  deviceDigest,
  OperationRequest,
  OperationResult,
  PairingCode,
  PairingCreate,
  PairingRedeem,
  PolicySetRequest,
  verifyApproval,
} from "../contracts/src/devices.ts";
import { DeviceCloud } from "./device-cloud.ts";
import {
  OperationAdmissionError,
  OperationOriginError,
  type OutgoingScope,
} from "./device-journal.ts";
import { NativeDeviceLeases } from "./device-native-leases.ts";
import { DeviceRuntime } from "./device-runtime.ts";

const configure = DeviceRegistration.extend({
  type: z.literal("configure"),
  version: z.literal(1),
  baseUrl: z.union([z.literal(""), z.url()]),
  stateDirectory: z.string().min(1),
  socketPath: z.string().min(1),
  bootSessionId: DeviceId.optional(),
});
const portRequest = z.strictObject({
  version: z.literal(2),
  requestId: DeviceId,
  method: z.string().min(1).max(80),
  params: z.unknown().optional(),
});
const management = z.strictObject({
  type: z.literal("manage"),
  requestId: DeviceId,
  method: z.string().max(80),
  params: z.unknown().optional(),
});
const signature = z.strictObject({
  type: z.literal("signature"),
  requestId: DeviceId,
  signature: z.string().max(2048).optional(),
  error: z.string().max(200).optional(),
});
const approval = z.strictObject({
  type: z.literal("approval"),
  requestId: DeviceId,
  approval: DeviceApproval.optional(),
  error: z.string().max(200).optional(),
});
const managementMethods = new Set([
  "policy.get",
  "policy.set",
  "pairing.create",
  "pairing.prepare",
  "pairing.revoke",
  "pairing.redeem",
  "pairing.result",
  "member.remove",
  "remote.configure",
]);
const capabilities = [
  "command",
  "file.read",
  "file.write",
  "file.list",
  "policy.manage",
];
function code(error: unknown): string {
  return error instanceof Error && /^[a-z][a-z0-9_]{0,80}$/.test(error.message)
    ? error.message
    : "device_service_failed";
}
function privateDirectory(path: string): void {
  if (!isAbsolute(path)) throw new Error("absolute_private_path_required");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error("invalid_private_directory");
}
function jsonLines(
  input: NodeJS.ReadableStream,
  onValue: (value: unknown) => void,
  onError: () => void,
): void {
  let pending = "";
  const decoder = new StringDecoder("utf8");
  input.on("data", (chunk: Buffer | string) => {
    pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
    if (Buffer.byteLength(pending) > 1048576) {
      onError();
      return;
    }
    for (;;) {
      const end = pending.indexOf("\n");
      if (end < 0) break;
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (Buffer.byteLength(line) > 524288) {
        onError();
        return;
      }
      try {
        onValue(JSON.parse(line));
      } catch {
        onError();
        return;
      }
    }
  });
}
async function clearStaleSocket(path: string): Promise<void> {
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (!existing) return;
  if (!existing.isSocket() || existing.uid !== process.getuid?.())
    throw new Error("socket_path_occupied");
  const stale = await new Promise<boolean>((resolveStale, reject) => {
    const probe = connect(path);
    const timeout = setTimeout(() => {
      probe.destroy();
      reject(new Error("socket_probe_timeout"));
    }, 500);
    probe.once("connect", () => {
      clearTimeout(timeout);
      probe.destroy();
      resolveStale(false);
    });
    probe.once("error", (error) => {
      clearTimeout(timeout);
      if (
        ["ECONNREFUSED", "ENOENT"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        resolveStale(true);
      else reject(error);
    });
  });
  if (!stale) throw new Error("device_service_already_running");
  unlinkSync(path);
}

function remoteOrigin(value: string): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      value.includes("?") ||
      value.includes("#") ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        ))
    )
      throw new Error("invalid_service_address");
    return url.origin;
  } catch {
    throw new Error("invalid_service_address");
  }
}

function withOrigin(value: unknown) {
  const { relayOrigin, ...input } = z
    .record(z.string(), z.unknown())
    .parse(value);
  return {
    input,
    relayOrigin: z.string().min(1).max(2048).optional().parse(relayOrigin),
  };
}
function operationWithOrigin(value: unknown) {
  const { input, relayOrigin } = withOrigin(value);
  return { request: OperationRequest.parse(input), relayOrigin };
}

type HelperPending = {
  kind: "signature" | "approval";
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
export async function runDeviceService(): Promise<void> {
  const send = (value: unknown) =>
    process.stdout.write(`${JSON.stringify(value)}\n`);
  const pending = new Map<string, HelperPending>();
  let runtime: DeviceRuntime | undefined;
  let nativeLeases: NativeDeviceLeases | undefined;
  let cloud: DeviceCloud | undefined;
  let cloudOrigin = "";
  let cloudUpdates = Promise.resolve();
  const issuedSecrets = new Set<string>();
  let server: ReturnType<typeof createServer> | undefined;
  let socketOwner: { dev: number; ino: number } | undefined;
  let configuration: z.infer<typeof configure> | undefined;
  let initializing: Promise<void> | undefined;
  let stopping = false;
  const sockets = new Set<Socket>();
  const helper = (
    kind: "signature" | "approval",
    value: Record<string, unknown>,
  ): Promise<unknown> =>
    new Promise((resolveHelper, reject) => {
      if (stopping || pending.size >= 32) {
        reject(new Error("helper_unavailable"));
        return;
      }
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("helper_confirmation_timeout"));
      }, 60000);
      pending.set(requestId, { kind, resolve: resolveHelper, reject, timer });
      send({ ...value, requestId });
    });
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("helper_disconnected"));
    }
    pending.clear();
    for (const socket of sockets) socket.destroy();
    nativeLeases?.close();
    await cloud?.close();
    await cloudUpdates;
    await runtime?.close();
    if (server?.listening)
      await new Promise<void>((resolveClosed) =>
        server?.close(() => resolveClosed()),
      );
    if (configuration && socketOwner) {
      const stat = lstatSync(configuration.socketPath, {
        throwIfNoEntry: false,
      });
      if (
        stat?.isSocket() &&
        stat.dev === socketOwner.dev &&
        stat.ino === socketOwner.ino
      )
        unlinkSync(configuration.socketPath);
    }
    process.stdin.destroy();
  };
  const ownDirectory = (): DeviceDirectory => {
    if (!runtime) throw new Error("not_ready");
    const device = runtime.device;
    return {
      localDeviceId: device.deviceId,
      groupId: device.groupId,
      revision: device.membershipEpoch,
      observationRevision: `local:${Date.now()}:${runtime.policy.version}`,
      devices: [
        {
          ...device,
          online: true,
          lastSeenAt: Date.now(),
          capabilities,
          policy: runtime.policy,
        },
      ],
    };
  };
  const requireCloud = () => {
    if (!cloud) throw new Error("remote_not_configured");
    return cloud;
  };
  const selectCloud = (origin: string | undefined) => {
    const selected = requireCloud();
    if (!origin || selected.origin !== origin)
      throw new Error("remote_configuration_changed");
    return selected;
  };
  const makeCloud = (origin: string) => {
    if (!runtime) throw new Error("not_ready");
    const localRuntime = runtime;
    const device = localRuntime.device;
    let next: DeviceCloud;
    next = new DeviceCloud(
      origin,
      device,
      localRuntime,
      async (payload) => {
        const lines = payload.split("\n");
        if (
          stopping ||
          cloud !== next ||
          lines.length !== 7 ||
          lines[0] !== "eagle-device-register-v1" ||
          lines[1] !== origin ||
          lines[2] !== device.deviceId ||
          lines[3] !== device.publicKey
        )
          throw new Error("invalid_registration_purpose");
        const signature = await helper("signature", { type: "sign", payload });
        if (stopping || cloud !== next)
          throw new Error("remote_configuration_changed");
        return z.string().max(2048).parse(signature);
      },
      (status) => {
        if (!stopping && cloud === next) send({ type: "cloud", status });
      },
      (credential) => issuedSecrets.add(credential),
    );
    return next;
  };
  const configureCloud = (value: string) => {
    const origin = remoteOrigin(value);
    const change = cloudUpdates.then(async () => {
      if (stopping) throw new Error("service_stopped");
      if (origin === cloudOrigin)
        return {
          baseUrl: origin,
          cloudStatus: cloud?.status ?? "unconfigured",
        };
      const next = origin ? makeCloud(origin) : undefined;
      const previous = cloud;
      cloud = undefined;
      cloudOrigin = "";
      await previous?.close();
      if (stopping) {
        await next?.close();
        throw new Error("service_stopped");
      }
      cloud = next;
      cloudOrigin = origin;
      send({ type: "cloud", status: next ? "offline" : "unconfigured" });
      void next?.start().catch(() => {
        if (!stopping && cloud === next)
          send({ type: "cloud", status: "offline" });
      });
      return { baseUrl: origin, cloudStatus: next?.status ?? "unconfigured" };
    });
    cloudUpdates = change.then(
      () => {},
      () => {},
    );
    return change;
  };
  const getDirectory = async () => {
    const selected = cloud;
    if (!selected) return { ...ownDirectory(), cloudStatus: "unconfigured" };
    try {
      const directory = await selected.directory();
      if (cloud !== selected) throw new Error("remote_configuration_changed");
      return { ...directory, relayOrigin: selected.origin };
    } catch {
      if (cloud !== selected) throw new Error("remote_configuration_changed");
      return { ...ownDirectory(), cloudStatus: "offline" };
    }
  };
  const pairingResult = (value: unknown, origin: string) => {
    const result = z.record(z.string(), z.unknown()).parse(value);
    const directory = z.record(z.string(), z.unknown()).parse(result.directory);
    return { ...result, directory: { ...directory, relayOrigin: origin } };
  };
  const manage = async (method: string, params: unknown): Promise<unknown> => {
    if (!runtime) throw new Error("not_ready");
    switch (method) {
      case "remote.configure": {
        const input = z
          .strictObject({ baseUrl: z.string().max(2048) })
          .parse(params);
        return configureCloud(input.baseUrl);
      }
      case "policy.get":
        return runtime.policy;
      case "policy.set": {
        const { input: fields, relayOrigin } = withOrigin(params);
        const input = z
          .union([
            z.strictObject({ mode: DevicePolicy.shape.mode }),
            PolicySetRequest,
          ])
          .parse(fields);
        if (
          relayOrigin &&
          (!("deviceId" in input) || input.deviceId === runtime.device.deviceId)
        )
          throw new Error("invalid_local_origin");
        if ("deviceId" in input) {
          if (input.deviceId !== runtime.device.deviceId) {
            const remote = selectCloud(relayOrigin);
            runtime.journal.preparePolicy(input, {
              kind: "remote",
              origin: remote.origin,
            });
            const result = await remote.setPolicy(input);
            if (cloud !== remote)
              throw new Error("policy_result_unknown_refresh_target");
            return result;
          }
          runtime.journal.preparePolicy(input, { kind: "local" });
        }
        const result =
          "deviceId" in input
            ? runtime.applyPolicy(input, runtime.device.deviceId)
            : runtime.setPolicy(input.mode);
        cloud?.publishPolicy();
        return result;
      }
      case "pairing.create": {
        const { input, relayOrigin } = withOrigin(params ?? {});
        const remote = selectCloud(relayOrigin);
        const result = await remote.manage(
          "/pairings",
          PairingCreate.parse(input),
        );
        if (cloud !== remote) throw new Error("remote_configuration_changed");
        return result;
      }
      case "pairing.prepare": {
        const { input: fields, relayOrigin } = withOrigin(params);
        const input = z
          .strictObject({
            requestId: DeviceId,
            codeHash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .parse(fields);
        const remote = selectCloud(relayOrigin);
        runtime.journal.bindPairing(input.requestId, input.codeHash, {
          kind: "remote",
          origin: remote.origin,
        });
        return { prepared: true };
      }
      case "pairing.revoke": {
        const { input, relayOrigin } = withOrigin(params);
        const remote = selectCloud(relayOrigin);
        const result = await remote.manage(
          "/pairings/revoke",
          z.strictObject({ code: PairingCode }).parse(input),
        );
        if (cloud !== remote) throw new Error("remote_configuration_changed");
        return result;
      }
      case "pairing.redeem": {
        const { input: fields, relayOrigin } = withOrigin(params);
        const input = PairingRedeem.parse(fields);
        const remote = selectCloud(relayOrigin);
        const digest = await deviceDigest(input.code);
        if (cloud !== remote) throw new Error("remote_configuration_changed");
        runtime.journal.bindPairing(input.requestId, digest, {
          kind: "remote",
          origin: remote.origin,
        });
        const result = await remote.manage("/pairings/redeem", input);
        if (cloud !== remote)
          throw new Error("pairing_result_unknown_query_original_id");
        return pairingResult(result, remote.origin);
      }
      case "pairing.result": {
        const { input: fields, relayOrigin } = withOrigin(params);
        const input = z.strictObject({ requestId: DeviceId }).parse(fields);
        const bound = runtime.journal.pairingOrigin(input.requestId);
        if (relayOrigin !== bound) throw new Error("relay_origin_mismatch");
        const remote = selectCloud(bound);
        const result = await remote.manage(
          `/pairings/results/${input.requestId}`,
        );
        if (cloud !== remote)
          throw new Error("pairing_result_unknown_query_original_id");
        return pairingResult(result, bound);
      }
      case "member.remove": {
        const { input, relayOrigin } = withOrigin(params);
        const remote = selectCloud(relayOrigin);
        const result = await remote.manage(
          "/members/remove",
          z.strictObject({ deviceId: DeviceId }).parse(input),
        );
        if (cloud !== remote)
          throw new Error("member_removal_unknown_refresh_directory");
        return result;
      }
      default:
        throw new Error("unknown_management_method");
    }
  };
  const local = async (
    method: string,
    params: unknown,
    session: { id: string; closed: boolean },
  ): Promise<unknown> => {
    if (!runtime) throw new Error("not_ready");
    if (managementMethods.has(method))
      throw new Error("management_requires_private_helper");
    switch (method) {
      case "status":
        return {
          deviceId: runtime.device.deviceId,
          localReady: true,
          cloudStatus: cloud?.status ?? "unconfigured",
          ...(cloudOrigin ? { relayOrigin: cloudOrigin } : {}),
          policy: runtime.policy,
        };
      case "directory":
        return getDirectory();
      case "local.begin": {
        const input = OperationRequest.parse(params);
        if (
          input.targetDeviceId !== runtime.device.deviceId ||
          input.operation?.kind !== "native" ||
          input.action !== "run" ||
          (await deviceDigest(canonicalDeviceJSON(input.operation))) !==
            input.digest
        )
          return {
            accepted: false,
            result: { status: "denied", error: "invalid_native_request" },
          };
        try {
          const prepared = runtime.journal.prepareOutgoing(input, {
            kind: "local",
          });
          if (prepared.action !== "run")
            return {
              accepted: false,
              result: await runtime.handle(prepared, runtime.device),
            };
          const admitted = await nativeLeases?.begin(prepared, session);
          if (!admitted) throw new Error("native_service_unavailable");
          runtime.journal.completeOutgoing(prepared, admitted.result, {
            kind: "local",
          });
          return admitted;
        } catch (error) {
          return {
            accepted: false,
            result: {
              status:
                error instanceof OperationAdmissionError ? "denied" : "unknown",
              error:
                error instanceof OperationAdmissionError
                  ? "operation_binding_conflict"
                  : "caller_storage_unavailable",
            },
          };
        }
      }
      case "local.complete": {
        const input = z
          .strictObject({
            operationId: DeviceId,
            leaseId: DeviceId,
            result: OperationResult,
          })
          .parse(params);
        return nativeLeases?.complete(
          input.operationId,
          input.leaseId,
          session.id,
          input.result,
        );
      }
      case "local.heartbeat": {
        const input = z
          .strictObject({ operationId: DeviceId, leaseId: DeviceId })
          .parse(params);
        return nativeLeases?.heartbeat(
          input.operationId,
          input.leaseId,
          session.id,
        );
      }
      case "execute":
      case "operation.get":
      case "operation.cancel": {
        const { request: input, relayOrigin } = operationWithOrigin(params);
        if (
          (method === "operation.get" && input.action !== "get") ||
          (method === "operation.cancel" && input.action !== "cancel")
        )
          throw new Error("action_mismatch");
        if (
          input.action === "run" &&
          (await deviceDigest(canonicalDeviceJSON(input.operation))) !==
            input.digest
        )
          return { status: "denied", error: "digest_mismatch" };
        if (
          input.operation?.kind === "native" &&
          input.targetDeviceId !== runtime.device.deviceId
        )
          return { status: "denied", error: "native_is_local_only" };
        const targetIsLocal = input.targetDeviceId === runtime.device.deviceId;
        const remote = cloud;
        let scope: OutgoingScope = { kind: "local" };
        try {
          if (targetIsLocal && relayOrigin)
            return { status: "denied", error: "invalid_local_origin" };
          if (!targetIsLocal) {
            const state = runtime.journal.outgoingState(input);
            const bound = runtime.journal.relayOrigin(input);
            if (state && !bound)
              return { status: "unknown", error: "relay_origin_unknown" };
            if (bound && relayOrigin && bound !== relayOrigin)
              return { status: "unknown", error: "relay_origin_mismatch" };
            if (!remote)
              return state === "sent"
                ? {
                    status: "unknown",
                    error: "remote_not_configured_query_original_id",
                  }
                : { status: "denied", error: "remote_not_configured" };
            const expected =
              relayOrigin ?? (input.action === "run" ? undefined : bound);
            if (!expected)
              return {
                status: state ? "unknown" : "denied",
                error: "relay_origin_unknown",
              };
            if (remote.origin !== expected)
              return {
                status: state ? "unknown" : "denied",
                error: "remote_configuration_changed",
              };
            scope = { kind: "remote", origin: expected };
          }
        } catch (error) {
          return {
            status:
              error instanceof OperationAdmissionError ? "denied" : "unknown",
            error:
              error instanceof OperationAdmissionError
                ? "operation_binding_conflict"
                : "caller_storage_unavailable",
          };
        }
        let request: OperationRequest;
        try {
          request = runtime.journal.prepareOutgoing(input, scope);
        } catch (error) {
          return {
            status:
              error instanceof OperationAdmissionError ? "denied" : "unknown",
            error:
              error instanceof OperationOriginError
                ? error.message
                : error instanceof OperationAdmissionError
                  ? "operation_binding_conflict"
                  : "caller_storage_unavailable",
          };
        }
        let result: OperationResult;
        if (request.targetDeviceId === runtime.device.deviceId)
          result = await runtime.handle(request, runtime.device);
        else {
          try {
            if (!remote) throw new Error("remote_not_configured");
            if (cloud !== remote)
              throw new Error("remote_configuration_changed");
            result = await remote.execute(request);
          } catch {
            result = {
              status: "unknown",
              error: "cloud_unavailable_query_original_id",
            };
          }
          if (cloud !== remote)
            result = {
              status: "unknown",
              error: "remote_configuration_changed_query_original_id",
            };
        }
        try {
          runtime.journal.completeOutgoing(request, result, scope);
        } catch {
          return { status: "unknown", error: "caller_storage_unavailable" };
        }
        return result;
      }
      case "approval.request": {
        const input = z
          .strictObject({
            request: z.record(z.string(), z.unknown()),
            policyVersion: z.number().int().positive(),
            expiresAt: z.number().int().positive(),
          })
          .parse(params);
        const { request, relayOrigin } = operationWithOrigin(input.request);
        if (
          request.action !== "run" ||
          !request.operation ||
          (await deviceDigest(canonicalDeviceJSON(request.operation))) !==
            request.digest ||
          input.expiresAt <= Date.now() ||
          input.expiresAt > Date.now() + 300000
        )
          throw new Error("invalid_approval_request");
        let policy = runtime.policy;
        let remote: DeviceCloud | undefined;
        if (request.targetDeviceId !== runtime.device.deviceId) {
          remote = requireCloud();
          if (!relayOrigin || remote.origin !== relayOrigin)
            throw new Error("remote_configuration_changed");
          const directory = await remote.directory();
          if (cloud !== remote) throw new Error("remote_configuration_changed");
          const target = directory.devices.find(
            (device) => device.deviceId === request.targetDeviceId,
          );
          if (!target?.policy) throw new Error("target_policy_unknown");
          policy = target.policy;
        } else if (relayOrigin) throw new Error("invalid_local_origin");
        if (
          policy.mode !== "always-ask" ||
          policy.version !== input.policyVersion
        )
          throw new Error("approval_policy_changed");
        if (remote) {
          if (!relayOrigin) throw new Error("relay_origin_unknown");
          runtime.journal.bindOperationOrigin(request, {
            kind: "remote",
            origin: relayOrigin,
          });
        }
        const response = DeviceApproval.parse(
          await helper("approval", {
            type: "approve",
            operationId: request.operationId,
            sourceDeviceId: runtime.device.deviceId,
            targetDeviceId: request.targetDeviceId,
            operation: request.operation,
            digest: request.digest,
            policyVersion: input.policyVersion,
            expiresAt: input.expiresAt,
          }),
        );
        if (!(await verifyApproval(response, request, runtime.device, policy)))
          throw new Error("invalid_helper_approval");
        if (remote && cloud !== remote)
          throw new Error("remote_configuration_changed");
        return { approval: response };
      }
      default:
        throw new Error("unknown_local_method");
    }
  };
  const initialize = async (value: unknown) => {
    configuration = configure.parse(value);
    const config = configuration;
    privateDirectory(config.stateDirectory);
    privateDirectory(dirname(config.socketPath));
    if (resolve(dirname(config.socketPath)) !== resolve(config.stateDirectory))
      throw new Error("socket_must_be_in_private_state_directory");
    const device = {
      deviceId: config.deviceId,
      publicKey: config.publicKey,
      name: config.name,
      platform: config.platform,
      arch: config.arch,
      groupId: null,
      membershipEpoch: 0,
      credentialVersion: 1,
    };
    runtime = new DeviceRuntime(
      device,
      join(config.stateDirectory, "operations.sqlite"),
      () => [...issuedSecrets],
      config.bootSessionId,
    );
    nativeLeases = new NativeDeviceLeases(runtime, 30000, () =>
      send({ type: "failed", error: "native_lease_storage_failed" }),
    );
    cloudOrigin = remoteOrigin(config.baseUrl);
    if (cloudOrigin) cloud = makeCloud(cloudOrigin);
    await clearStaleSocket(config.socketPath);
    server = createServer((socket) => {
      sockets.add(socket);
      const session = { id: randomUUID(), closed: false };
      let inFlight = 0;
      socket.on("error", () => socket.destroy());
      socket.once("close", () => {
        session.closed = true;
        sockets.delete(socket);
        try {
          nativeLeases?.disconnect(session.id);
        } catch {
          send({ type: "failed", error: "native_lease_storage_failed" });
        }
      });
      jsonLines(
        socket,
        (value) => {
          const envelope = z
            .object({ requestId: DeviceId, version: z.number().optional() })
            .safeParse(value);
          if (envelope.success && envelope.data.version !== 2) {
            socket.end(
              `${JSON.stringify({ version: 2, requestId: envelope.data.requestId, error: "device_port_version_mismatch" })}\n`,
            );
            return;
          }
          const request = portRequest.safeParse(value);
          if (!request.success) {
            socket.end(
              `${JSON.stringify({ version: 2, error: "invalid_request" })}\n`,
            );
            return;
          }
          if (inFlight >= 16) {
            socket.write(
              `${JSON.stringify({ version: 2, requestId: request.data.requestId, error: "local_port_busy" })}\n`,
            );
            return;
          }
          inFlight++;
          void local(request.data.method, request.data.params, session)
            .then(
              (result) => {
                if (!socket.destroyed)
                  socket.write(
                    `${JSON.stringify({ version: 2, requestId: request.data.requestId, result })}\n`,
                  );
              },
              (error) => {
                if (!socket.destroyed)
                  socket.write(
                    `${JSON.stringify({ version: 2, requestId: request.data.requestId, error: code(error) })}\n`,
                  );
              },
            )
            .finally(() => inFlight--);
        },
        () => socket.destroy(),
      );
    });
    await new Promise<void>((resolveListening, reject) => {
      server?.once("error", reject);
      server?.listen(config.socketPath, () => {
        const stat = lstatSync(config.socketPath);
        socketOwner = { dev: stat.dev, ino: stat.ino };
        resolveListening();
      });
    });
    chmodSync(config.socketPath, 0o600);
    send({
      type: "ready",
      socketPath: config.socketPath,
      deviceId: device.deviceId,
    });
    const initialCloud = cloud;
    send({ type: "cloud", status: initialCloud ? "offline" : "unconfigured" });
    void initialCloud?.start().catch(() => {
      if (!stopping && cloud === initialCloud)
        send({ type: "cloud", status: "offline" });
    });
  };
  jsonLines(
    process.stdin,
    (value) => {
      if (!configuration && !initializing) {
        initializing = initialize(value);
        void initializing.catch(async () => {
          send({ type: "failed", error: "device_initialization_failed" });
          process.exitCode = 1;
          await shutdown();
        });
        return;
      }
      const proof = signature.safeParse(value);
      const approved = approval.safeParse(value);
      if (proof.success || approved.success) {
        const response = proof.success
          ? proof.data
          : approved.success
            ? approved.data
            : undefined;
        if (!response) return;
        const request = pending.get(response.requestId);
        if (
          !request ||
          (proof.success ? "signature" : "approval") !== request.kind
        )
          return;
        pending.delete(response.requestId);
        clearTimeout(request.timer);
        if (response.error) request.reject(new Error("helper_request_denied"));
        else if (proof.success && proof.data.signature)
          request.resolve(proof.data.signature);
        else if (approved.success && approved.data.approval)
          request.resolve(approved.data.approval);
        else request.reject(new Error("invalid_helper_response"));
        return;
      }
      const command = management.safeParse(value);
      if (!command.success) {
        send({ type: "failed", error: "invalid_helper_frame" });
        return;
      }
      void (async () => {
        await initializing;
        if (stopping) throw new Error("service_stopped");
        return manage(command.data.method, command.data.params);
      })().then(
        (result) =>
          send({ type: "managed", requestId: command.data.requestId, result }),
        (error) =>
          send({
            type: "managed",
            requestId: command.data.requestId,
            error: code(error),
          }),
      );
    },
    () => {
      process.exitCode = 1;
      void shutdown();
    },
  );
  process.stdin.once("end", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  void runDeviceService().catch(() => {
    process.stderr.write("device_service_failed\n");
    process.exitCode = 1;
  });
}
