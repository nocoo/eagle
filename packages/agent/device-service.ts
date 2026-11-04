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
import { OperationAdmissionError } from "./device-journal.ts";
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
  "pairing.revoke",
  "pairing.redeem",
  "pairing.result",
  "member.remove",
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
  const getDirectory = async () => {
    if (!cloud) return { ...ownDirectory(), cloudStatus: "unconfigured" };
    try {
      return await cloud.directory();
    } catch {
      return { ...ownDirectory(), cloudStatus: "offline" };
    }
  };
  const manage = async (method: string, params: unknown): Promise<unknown> => {
    if (!runtime) throw new Error("not_ready");
    switch (method) {
      case "policy.get":
        return runtime.policy;
      case "policy.set": {
        const input = z
          .union([
            z.strictObject({ mode: DevicePolicy.shape.mode }),
            PolicySetRequest,
          ])
          .parse(params);
        if ("deviceId" in input) {
          if (input.deviceId !== runtime.device.deviceId) {
            const remote = requireCloud();
            runtime.journal.preparePolicy(input);
            return remote.setPolicy(input);
          }
          runtime.journal.preparePolicy(input);
        }
        const result =
          "deviceId" in input
            ? runtime.applyPolicy(input, runtime.device.deviceId)
            : runtime.setPolicy(input.mode);
        cloud?.publishPolicy();
        return result;
      }
      case "pairing.create":
        return requireCloud().manage(
          "/pairings",
          PairingCreate.parse(params ?? {}),
        );
      case "pairing.revoke":
        return requireCloud().manage(
          "/pairings/revoke",
          z.strictObject({ code: PairingCode }).parse(params),
        );
      case "pairing.redeem":
        return requireCloud().manage(
          "/pairings/redeem",
          PairingRedeem.parse(params),
        );
      case "pairing.result": {
        const input = z.strictObject({ requestId: DeviceId }).parse(params);
        return requireCloud().manage(`/pairings/results/${input.requestId}`);
      }
      case "member.remove":
        return requireCloud().manage(
          "/members/remove",
          z.strictObject({ deviceId: DeviceId }).parse(params),
        );
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
          const prepared = runtime.journal.prepareOutgoing(input);
          if (prepared.action !== "run")
            return {
              accepted: false,
              result: await runtime.handle(prepared, runtime.device),
            };
          const admitted = await nativeLeases?.begin(prepared, session);
          if (!admitted) throw new Error("native_service_unavailable");
          runtime.journal.completeOutgoing(prepared, admitted.result);
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
        const input = OperationRequest.parse(params);
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
        if (input.targetDeviceId !== runtime.device.deviceId && !cloud) {
          try {
            return runtime.journal.outgoingState(input) === "sent"
              ? {
                  status: "unknown",
                  error: "remote_not_configured_query_original_id",
                }
              : { status: "denied", error: "remote_not_configured" };
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
        }
        let request: OperationRequest;
        try {
          request = runtime.journal.prepareOutgoing(input);
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
        let result: OperationResult;
        if (request.targetDeviceId === runtime.device.deviceId)
          result = await runtime.handle(request, runtime.device);
        else {
          try {
            const remote = requireCloud();
            await remote.directory();
            result = await remote.execute(request);
          } catch {
            result = {
              status: "unknown",
              error: "cloud_unavailable_query_original_id",
            };
          }
        }
        try {
          runtime.journal.completeOutgoing(request, result);
        } catch {
          return { status: "unknown", error: "caller_storage_unavailable" };
        }
        return result;
      }
      case "approval.request": {
        const input = z
          .strictObject({
            request: OperationRequest,
            policyVersion: z.number().int().positive(),
            expiresAt: z.number().int().positive(),
          })
          .parse(params);
        const request = input.request;
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
        if (request.targetDeviceId !== runtime.device.deviceId) {
          const directory = await requireCloud().directory();
          const target = directory.devices.find(
            (device) => device.deviceId === request.targetDeviceId,
          );
          if (!target?.policy) throw new Error("target_policy_unknown");
          policy = target.policy;
        }
        if (
          policy.mode !== "always-ask" ||
          policy.version !== input.policyVersion
        )
          throw new Error("approval_policy_changed");
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
      () => cloud?.secrets() ?? [],
      config.bootSessionId,
    );
    nativeLeases = new NativeDeviceLeases(runtime, 30000, () =>
      send({ type: "failed", error: "native_lease_storage_failed" }),
    );
    if (config.baseUrl)
      cloud = new DeviceCloud(
        config.baseUrl,
        device,
        runtime,
        async (payload) => {
          const lines = payload.split("\n");
          if (
            lines.length !== 7 ||
            lines[0] !== "eagle-device-register-v1" ||
            lines[1] !== new URL(config.baseUrl).origin ||
            lines[2] !== device.deviceId ||
            lines[3] !== device.publicKey
          )
            throw new Error("invalid_registration_purpose");
          return z
            .string()
            .max(2048)
            .parse(await helper("signature", { type: "sign", payload }));
        },
        (status) => send({ type: "cloud", status }),
      );
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
          const request = portRequest.safeParse(value);
          if (!request.success) {
            socket.end(`${JSON.stringify({ error: "invalid_request" })}\n`);
            return;
          }
          if (inFlight >= 16) {
            socket.write(
              `${JSON.stringify({ requestId: request.data.requestId, error: "local_port_busy" })}\n`,
            );
            return;
          }
          inFlight++;
          void local(request.data.method, request.data.params, session)
            .then(
              (result) => {
                if (!socket.destroyed)
                  socket.write(
                    `${JSON.stringify({ requestId: request.data.requestId, result })}\n`,
                  );
              },
              (error) => {
                if (!socket.destroyed)
                  socket.write(
                    `${JSON.stringify({ requestId: request.data.requestId, error: code(error) })}\n`,
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
    send({ type: "cloud", status: cloud ? "offline" : "unconfigured" });
    void cloud?.start().catch(() => {
      if (!stopping) send({ type: "cloud", status: "offline" });
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
