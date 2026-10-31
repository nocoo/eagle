import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  SyncCacheAuthority,
  SyncCacheAuthorityRequest,
} from "../contracts/src/device-cache.ts";
import {
  SyncEnvelopeRequest,
  SyncKeyBytes,
  SyncKeyDescriptor,
  SyncKeyDescriptorRequest,
  SyncKeyEnvelope,
  SyncOpenRequest,
  SyncPublishedDescriptor,
  SyncSealRequest,
  SyncSealResult,
  syncDescriptorPayload,
} from "../contracts/src/device-objects.ts";
import {
  SyncRelayAuthority,
  SyncRelayAuthorityRequest,
} from "../contracts/src/device-relay.ts";
import {
  SyncAccess,
  SyncAccessResult,
  SyncIdentityResult,
  SyncIncomingRequest,
  SyncIncomingResult,
  SyncProofRequest,
  SyncPublish,
  SyncShare,
  syncProofPayload,
} from "../contracts/src/device-sync.ts";
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
import {
  verifyKeyEnvelope,
  verifyObjectManifest,
  verifyWrappingDescriptor,
} from "./device-objects.ts";
import { DeviceRuntime } from "./device-runtime.ts";
import { syncSelf } from "./device-sync.ts";

const configure = DeviceRegistration.extend({
  type: z.literal("configure"),
  version: z.literal(1),
  baseUrl: z.url(),
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
  "sync.share",
  "sync.incoming",
  "sync.endpoints.publish",
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
  kind:
    | "signature"
    | "approval"
    | "sync_signature"
    | "sync_key_descriptor_result"
    | "sync_key_seal_result"
    | "sync_key_envelope_result"
    | "sync_key_open_result";
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
    kind: HelperPending["kind"],
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
  const getDirectory = async () => {
    try {
      return (await cloud?.directory()) ?? ownDirectory();
    } catch {
      return { ...ownDirectory(), cloudStatus: "offline" };
    }
  };
  let endpointTail: Promise<unknown> = Promise.resolve();
  const manage = async (method: string, params: unknown): Promise<unknown> => {
    if (!runtime || !cloud) throw new Error("not_ready");
    switch (method) {
      case "sync.share":
        return cloud.manage("/sync/share", SyncShare.parse(params));
      case "sync.incoming":
        return SyncIncomingResult.parse(
          await cloud.manage(
            "/sync/incoming",
            SyncIncomingRequest.parse(params),
          ),
        );
      case "sync.endpoints.publish": {
        const publicationCloud = cloud;
        const publish = async () => {
          const { syncPort, expectedSelfDigest } = SyncPublish.parse(params);
          const self = syncPort === null ? undefined : await syncSelf();
          if (
            self &&
            expectedSelfDigest !== undefined &&
            expectedSelfDigest !== self.digest
          ) {
            await publicationCloud.manage("/sync/endpoints", {
              candidates: [],
            });
            throw new Error("sync_self_changed");
          }
          return publicationCloud.manage("/sync/endpoints", {
            candidates:
              self?.addresses.map((address) => ({ address, port: syncPort })) ??
              [],
          });
        };
        const next = endpointTail.then(publish);
        endpointTail = next.catch(() => undefined);
        return next;
      }
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
          runtime.journal.preparePolicy(input);
          if (input.deviceId !== runtime.device.deviceId)
            return cloud.setPolicy(input);
        }
        const result =
          "deviceId" in input
            ? runtime.applyPolicy(input, runtime.device.deviceId)
            : runtime.setPolicy(input.mode);
        cloud.publishPolicy();
        return result;
      }
      case "pairing.create":
        return cloud.manage("/pairings", PairingCreate.parse(params ?? {}));
      case "pairing.revoke":
        return cloud.manage(
          "/pairings/revoke",
          z.strictObject({ code: PairingCode }).parse(params),
        );
      case "pairing.redeem":
        return cloud.manage("/pairings/redeem", PairingRedeem.parse(params));
      case "pairing.result": {
        const input = z.strictObject({ requestId: DeviceId }).parse(params);
        return cloud.manage(`/pairings/results/${input.requestId}`);
      }
      case "member.remove":
        return cloud.manage(
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
    if (!runtime || !cloud) throw new Error("not_ready");
    if (managementMethods.has(method))
      throw new Error("management_requires_private_helper");
    switch (method) {
      case "sync.identity":
        z.strictObject({}).parse(params ?? {});
        return SyncIdentityResult.parse(await cloud.manage("/sync/identity"));
      case "sync.access":
        return SyncAccessResult.parse(
          await cloud.manage("/sync/access", SyncAccess.parse(params)),
        );
      case "sync.peer.authorize":
        return {
          ...SyncAccessResult.parse(
            await cloud.manage(
              "/sync/peer/authorize",
              SyncAccess.parse(params),
            ),
          ),
          registryOrigin: new URL(configuration?.baseUrl ?? "").origin,
        };
      case "sync.key.lookup": {
        const input = SyncAccess.parse(params);
        const syncCloud = cloud;
        const result = SyncPublishedDescriptor.parse(
          await syncCloud.manage("/sync/keys/lookup", input),
        );
        const descriptor = verifyWrappingDescriptor(
          result.descriptor,
          result.identity,
          new URL(configuration?.baseUrl ?? "").origin,
        );
        const access = SyncAccessResult.parse(
          await syncCloud.manage("/sync/peer/authorize", input),
        );
        if (
          stopping ||
          session.closed ||
          cloud !== syncCloud ||
          canonicalDeviceJSON(access.peer) !==
            canonicalDeviceJSON(result.identity)
        )
          throw new Error("sync_identity_changed");
        return { ...result, descriptor };
      }
      case "sync.cache.authority": {
        const input = SyncCacheAuthorityRequest.parse(params);
        const syncCloud = cloud;
        const result = SyncCacheAuthority.parse(
          await syncCloud.manage("/sync/cache/authority", input),
        );
        const access = SyncAccessResult.parse(
          await syncCloud.manage(
            input.operation === "publish"
              ? "/sync/peer/authorize"
              : "/sync/access",
            {
              sharedBotId: input.sharedBotId,
              peerDeviceId: input.peerDeviceId,
              purpose: "replica.read",
            },
          ),
        );
        const uploader =
          input.operation === "publish" ? access.local : access.peer;
        const recipient =
          input.operation === "publish" ? access.peer : access.local;
        if (
          stopping ||
          session.closed ||
          cloud !== syncCloud ||
          result.registryOrigin !==
            new URL(configuration?.baseUrl ?? "").origin ||
          result.operation !== input.operation ||
          result.sharedBotId !== input.sharedBotId ||
          result.requestDigest !== input.requestDigest ||
          result.expiresAt <= Date.now() ||
          result.expiresAt > Date.now() + 60000 ||
          canonicalDeviceJSON(result.uploader) !==
            canonicalDeviceJSON(uploader) ||
          canonicalDeviceJSON(result.recipient) !==
            canonicalDeviceJSON(recipient)
        )
          throw new Error("invalid_sync_cache_authority");
        return result;
      }
      case "sync.relay.authority": {
        const input = SyncRelayAuthorityRequest.parse(params);
        const holderReads =
          input.operation === "receipts" || input.operation === "status-read";
        const syncCloud = cloud;
        const result = SyncRelayAuthority.parse(
          await syncCloud.manage("/sync/relay/authority", input),
        );
        const identity = SyncIdentityResult.parse(
          await syncCloud.manage("/sync/identity"),
        ).identity;
        let holder = null,
          reader = null;
        if (input.peerDeviceId) {
          const access = SyncAccessResult.parse(
            await syncCloud.manage(
              holderReads ? "/sync/peer/authorize" : "/sync/access",
              {
                sharedBotId: input.sharedBotId,
                peerDeviceId: input.peerDeviceId,
                purpose: "replica.read",
              },
            ),
          );
          holder = holderReads ? access.local : access.peer;
          reader = holderReads ? access.peer : access.local;
        }
        if (
          stopping ||
          session.closed ||
          cloud !== syncCloud ||
          result.registryOrigin !==
            new URL(configuration?.baseUrl ?? "").origin ||
          result.operation !== input.operation ||
          result.sharedBotId !== input.sharedBotId ||
          result.requestDigest !== input.requestDigest ||
          result.expiresAt <= Date.now() ||
          result.expiresAt > Date.now() + 60000 ||
          canonicalDeviceJSON(result.requester) !==
            canonicalDeviceJSON(identity) ||
          canonicalDeviceJSON(result.holder) !== canonicalDeviceJSON(holder) ||
          canonicalDeviceJSON(result.reader) !== canonicalDeviceJSON(reader)
        )
          throw new Error("invalid_sync_relay_authority");
        return result;
      }
      case "sync.key.publish":
      case "sync.key.descriptor": {
        z.strictObject({}).parse(params ?? {});
        const syncCloud = cloud;
        if (!configuration) throw new Error("not_ready");
        const configured = configuration;
        const current = async () => {
          const { identity } = SyncIdentityResult.parse(
            await syncCloud.manage("/sync/identity"),
          );
          if (
            identity.deviceId !== configured.deviceId ||
            identity.publicKey !== configured.publicKey
          )
            throw new Error("sync_identity_changed");
          return identity;
        };
        const identity = await current();
        const request = SyncKeyDescriptorRequest.parse({
          version: 1,
          registryOrigin: new URL(configured.baseUrl).origin,
          identity,
        });
        const descriptor = SyncKeyDescriptor.parse(
          await helper("sync_key_descriptor_result", {
            type: "sync_key_descriptor",
            request,
          }),
        );
        const { signature: signed, ...body } = descriptor;
        if (
          descriptor.registryOrigin !== request.registryOrigin ||
          descriptor.deviceId !== identity.deviceId ||
          descriptor.publicKey !== identity.publicKey ||
          descriptor.credentialVersion !== identity.credentialVersion ||
          createHash("sha256")
            .update(Buffer.from(descriptor.wrappingPublicKey, "base64url"))
            .digest("hex") !== descriptor.keyId ||
          !verify(
            null,
            Buffer.from(syncDescriptorPayload(body)),
            createPublicKey({
              key: Buffer.from(identity.publicKey, "base64url"),
              format: "der",
              type: "spki",
            }),
            Buffer.from(signed, "base64url"),
          )
        )
          throw new Error("invalid_sync_key_descriptor");
        const after = await current();
        if (
          stopping ||
          session.closed ||
          cloud !== syncCloud ||
          canonicalDeviceJSON(identity) !== canonicalDeviceJSON(after)
        )
          throw new Error("sync_identity_changed");
        if (method === "sync.key.descriptor") return descriptor;
        const result = SyncPublishedDescriptor.parse(
          await syncCloud.manage("/sync/keys/publish", {
            version: 1,
            identity,
            descriptor,
          }),
        );
        verifyWrappingDescriptor(
          result.descriptor,
          identity,
          request.registryOrigin,
        );
        const { signature: _saved, ...savedBody } = result.descriptor;
        if (
          canonicalDeviceJSON(savedBody) !== canonicalDeviceJSON(body) ||
          canonicalDeviceJSON(result.identity) !==
            canonicalDeviceJSON(identity) ||
          canonicalDeviceJSON(await current()) !==
            canonicalDeviceJSON(identity) ||
          stopping ||
          session.closed ||
          cloud !== syncCloud
        )
          throw new Error("sync_identity_changed");
        return result;
      }
      case "sync.key.seal":
      case "sync.key.envelope":
      case "sync.key.open": {
        if (!configuration) throw new Error("not_ready");
        const configured = configuration;
        const syncCloud = cloud;
        const origin = new URL(configured.baseUrl).origin;
        const same = (a: unknown, b: unknown) =>
          canonicalDeviceJSON(a) === canonicalDeviceJSON(b);
        const own = (peer: { deviceId: string; publicKey: string }) => {
          if (
            peer.deviceId !== configured.deviceId ||
            peer.publicKey !== configured.publicKey
          )
            throw new Error("sync_identity_changed");
        };
        const live = () => {
          if (stopping || session.closed || cloud !== syncCloud)
            throw new Error("sync_identity_changed");
        };
        if (method === "sync.key.open") {
          const request = SyncOpenRequest.parse(params);
          const manifest = verifyObjectManifest(request.manifest);
          const envelope = verifyKeyEnvelope(request.envelope, manifest);
          if (
            manifest.registryOrigin !== origin ||
            !same(manifest.publisher, request.publisherPin) ||
            !same(envelope.issuer, request.issuerPin) ||
            !same(envelope.recipient, request.recipientPin)
          )
            throw new Error("invalid_sync_key_pin");
          own(envelope.recipient);
          const result = z
            .strictObject({ version: z.literal(1), dek: SyncKeyBytes })
            .parse(
              await helper("sync_key_open_result", {
                type: "sync_key_open",
                request,
              }),
            );
          live();
          return result;
        }
        if (method === "sync.key.seal") {
          const request = SyncSealRequest.parse(params);
          own(request.identity);
          if (
            request.manifest.registryOrigin !== origin ||
            !same(request.manifest.publisher, request.identity)
          )
            throw new Error("invalid_sync_key_manifest");
          const current = async () => {
            const { identity } = SyncIdentityResult.parse(
              await syncCloud.manage("/sync/identity"),
            );
            if (!same(identity, request.identity))
              throw new Error("sync_identity_changed");
          };
          await current();
          const result = SyncSealResult.parse(
            await helper("sync_key_seal_result", {
              type: "sync_key_seal",
              request,
            }),
          );
          const manifest = verifyObjectManifest(result.manifest);
          const { signature: _signature, ...body } = manifest;
          if (!same(body, request.manifest))
            throw new Error("invalid_sync_key_manifest");
          verifyWrappingDescriptor(result.descriptor, request.identity, origin);
          const envelope = verifyKeyEnvelope(result.envelope, manifest);
          if (
            !same(envelope.issuer, request.identity) ||
            !same(envelope.recipient, request.identity) ||
            envelope.recipientDescriptor.keyId !== result.descriptor.keyId
          )
            throw new Error("invalid_sync_key_envelope");
          await current();
          live();
          return result;
        }
        const request = SyncEnvelopeRequest.parse(params);
        own(request.identity);
        const manifest = verifyObjectManifest(request.manifest);
        if (manifest.registryOrigin !== origin)
          throw new Error("invalid_sync_key_manifest");
        own(manifest.publisher);
        const original = verifyKeyEnvelope(request.envelope, manifest);
        own(original.recipient);
        verifyWrappingDescriptor(
          request.recipientDescriptor,
          request.recipient,
          origin,
        );
        const current = async () => {
          const access = SyncAccessResult.parse(
            await syncCloud.manage("/sync/peer/authorize", {
              sharedBotId: manifest.sharedBotId,
              peerDeviceId: request.recipient.deviceId,
              purpose: "replica.read",
            }),
          );
          if (
            !same(access.local, request.identity) ||
            !same(access.peer, request.recipient)
          )
            throw new Error("sync_identity_changed");
        };
        await current();
        const result = SyncKeyEnvelope.parse(
          await helper("sync_key_envelope_result", {
            type: "sync_key_envelope",
            request,
          }),
        );
        const envelope = verifyKeyEnvelope(result, manifest);
        if (
          !same(envelope.issuer, request.identity) ||
          !same(envelope.recipient, request.recipient) ||
          !same(envelope.recipientDescriptor, request.recipientDescriptor)
        )
          throw new Error("invalid_sync_key_envelope");
        await current();
        live();
        return result;
      }
      case "sync.endpoints.self":
        return syncSelf();
      case "sync.proof": {
        const request = SyncProofRequest.parse(params);
        if (
          !configuration ||
          request.registryOrigin !== new URL(configuration.baseUrl).origin ||
          request.expiresAt <= Date.now() ||
          request.expiresAt > Date.now() + 60000
        )
          throw new Error("invalid_sync_proof");
        const syncCloud = cloud;
        const own = request[request.role];
        const peer = request[request.role === "reader" ? "server" : "reader"];
        if (
          own.deviceId !== configuration.deviceId ||
          own.publicKey !== configuration.publicKey
        )
          throw new Error("invalid_sync_proof");
        const access = async () => {
          const result = SyncAccessResult.parse(
            await syncCloud.manage(
              request.role === "reader"
                ? "/sync/access"
                : "/sync/peer/authorize",
              {
                sharedBotId: request.sharedBotId,
                peerDeviceId: peer.deviceId,
                purpose: request.purpose,
              },
            ),
          );
          if (
            JSON.stringify(result.local) !== JSON.stringify(own) ||
            JSON.stringify(result.peer) !== JSON.stringify(peer)
          )
            throw new Error("sync_identity_changed");
        };
        await access();
        const signed = await helper("sync_signature", {
          type: "sync_proof",
          request,
        });
        if (
          typeof signed !== "string" ||
          !verify(
            null,
            Buffer.from(syncProofPayload(request)),
            createPublicKey({
              key: Buffer.from(own.publicKey, "base64url"),
              format: "der",
              type: "spki",
            }),
            Buffer.from(signed, "base64url"),
          )
        )
          throw new Error("invalid_sync_signature");
        await access();
        if (request.expiresAt <= Date.now())
          throw new Error("sync_proof_expired");
        return { version: 1, signature: signed };
      }
      case "status":
        return {
          deviceId: runtime.device.deviceId,
          localReady: true,
          cloudStatus: cloud.status,
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
            await cloud.directory();
            result = await cloud.execute(request);
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
          const directory = await cloud.directory();
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
    send({ type: "cloud", status: "offline" });
    void cloud.start().catch(() => {
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
      const keyResponse = z
        .strictObject({
          type: z.enum([
            "sync_key_seal_result",
            "sync_key_envelope_result",
            "sync_key_open_result",
          ]),
          requestId: DeviceId,
          result: z.unknown().optional(),
          error: z.string().max(200).optional(),
        })
        .safeParse(value);
      if (keyResponse.success) {
        const response = keyResponse.data;
        const request = pending.get(response.requestId);
        if (!request || request.kind !== response.type) return;
        pending.delete(response.requestId);
        clearTimeout(request.timer);
        if (response.error) request.reject(new Error("helper_request_denied"));
        else if (response.result !== undefined)
          request.resolve(response.result);
        else request.reject(new Error("invalid_helper_response"));
        return;
      }
      const descriptor = z
        .strictObject({
          type: z.literal("sync_key_descriptor_result"),
          requestId: DeviceId,
          result: SyncKeyDescriptor.optional(),
          error: z.string().max(200).optional(),
        })
        .safeParse(value);
      if (descriptor.success) {
        const response = descriptor.data;
        const request = pending.get(response.requestId);
        if (request?.kind !== "sync_key_descriptor_result") return;
        pending.delete(response.requestId);
        clearTimeout(request.timer);
        if (response.error) request.reject(new Error("helper_request_denied"));
        else if (response.result) request.resolve(response.result);
        else request.reject(new Error("invalid_helper_response"));
        return;
      }
      const proof = signature.safeParse(value);
      const syncProof = signature
        .extend({ type: z.literal("sync_signature") })
        .safeParse(value);
      const approved = approval.safeParse(value);
      if (proof.success || approved.success || syncProof.success) {
        const response = proof.success
          ? proof.data
          : approved.success
            ? approved.data
            : syncProof.success
              ? syncProof.data
              : undefined;
        if (!response) return;
        const request = pending.get(response.requestId);
        if (
          !request ||
          (proof.success
            ? "signature"
            : approved.success
              ? "approval"
              : "sync_signature") !== request.kind
        )
          return;
        pending.delete(response.requestId);
        clearTimeout(request.timer);
        if (response.error) request.reject(new Error("helper_request_denied"));
        else if (proof.success && proof.data.signature)
          request.resolve(proof.data.signature);
        else if (approved.success && approved.data.approval)
          request.resolve(approved.data.approval);
        else if (syncProof.success && syncProof.data.signature)
          request.resolve(syncProof.data.signature);
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
