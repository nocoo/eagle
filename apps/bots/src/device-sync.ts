import { z } from "zod";
import {
  cacheAuthority,
  cacheAuthorityRequest,
  publishedDescriptor,
} from "./core/DeviceSyncCache.ts";
import {
  SyncEnvelopeRequest,
  SyncKeyBytes,
  SyncKeyDescriptor,
  SyncKeyEnvelope,
  SyncOpenRequest,
  SyncSealRequest,
  SyncSealResult,
} from "./core/DeviceSyncObjects.ts";
import {
  type DeviceSyncPort,
  deviceSyncAccess,
  deviceSyncIdentity,
  deviceSyncPeerAccess,
  deviceSyncProof,
  deviceSyncSelf,
} from "./core/DeviceSyncPort.ts";
import { relayAuthority, relayAuthorityRequest } from "./core/DeviceSyncRelay.ts";
import { ClassifiedFailure } from "./core/domain.ts";
import { newFailure } from "./core/failures.ts";
import { declareEvent } from "./log/events.ts";
import type { Log } from "./log/log.ts";
import { DeviceChannel } from "./tools/devices/socket.ts";

const Events = {
  start: declareEvent("runtime.sync.start"),
  ok: declareEvent("runtime.sync.ok"),
  fail: declareEvent("runtime.sync.fail"),
};

/** Composition adapter: Bots owns its codec; the host owns credentials and authorization. */
export class SocketDeviceSyncPort implements DeviceSyncPort {
  readonly version = 1;
  readonly path: string;
  readonly log: Log;
  constructor(path: string, log: Log) {
    this.path = path;
    this.log = log;
  }

  async #call<T>(
    method: string,
    input: unknown,
    context: { trace: string; botId: string },
    decode: (value: unknown) => T,
  ): Promise<T> {
    const channel = new DeviceChannel(this.path, 15000);
    this.log.emit("info", "runtime", Events.start, context);
    try {
      const result = decode(await channel.call(method, input));
      this.log.emit("info", "runtime", Events.ok, context);
      return result;
    } catch (error) {
      const reason =
        error instanceof Error && /^[a-z][a-z0-9_]{0,80}$/.test(error.message)
          ? error.message
          : "invalid_device_sync_response";
      const failure = newFailure(
        [
          "different_group",
          "sync_not_shared",
          "invalid_session",
          "revoked_session",
          "session_required",
          "unknown_device",
          "sync_wrapping_key_unavailable",
          "sync_wrapping_key_conflict",
          "invalid_sync_key_descriptor",
          "invalid_sync_cache_authority",
          "invalid_sync_relay_authority",
          "sync_relay_authority_expired",
          "sync_cache_authority_expired",
          "sync_identity_changed",
        ].includes(reason)
          ? "auth_failed"
          : "internal",
        "runtime",
      );
      this.log.emit("error", "runtime", Events.fail, {
        ...context,
        failure,
        origin: true,
        detail: { reason: "upstream", providerCode: reason.slice(0, 40) },
      });
      throw new ClassifiedFailure(failure, "not_admitted", "device sync access failed", {
        cause: error,
      });
    } finally {
      channel.close();
    }
  }

  publishDescriptor(context: { trace: string; botId: string }) {
    return this.#call("sync.key.publish", {}, context, (value) => publishedDescriptor.parse(value));
  }
  descriptor(context: { trace: string; botId: string }) {
    return this.#call("sync.key.descriptor", {}, context, (value) =>
      SyncKeyDescriptor.parse(value),
    );
  }
  lookup(
    input: Parameters<DeviceSyncPort["access"]>[0],
    context: { trace: string; botId: string },
  ) {
    return this.#call("sync.key.lookup", input, context, (value) => {
      const result = publishedDescriptor.parse(value);
      if (result.identity.deviceId !== input.peerDeviceId)
        throw new Error("invalid_device_sync_response");
      return result;
    });
  }
  relayAuthority(
    input: z.infer<typeof relayAuthorityRequest>,
    context: { trace: string; botId: string },
  ) {
    return this.#call(
      "sync.relay.authority",
      relayAuthorityRequest.parse(input),
      context,
      (value) => relayAuthority.parse(value),
    );
  }
  cacheAuthority(
    input: z.infer<typeof cacheAuthorityRequest>,
    context: { trace: string; botId: string },
  ) {
    return this.#call(
      "sync.cache.authority",
      cacheAuthorityRequest.parse(input),
      context,
      (value) => cacheAuthority.parse(value),
    );
  }
  sealKey(input: z.infer<typeof SyncSealRequest>, context: { trace: string; botId: string }) {
    return this.#call("sync.key.seal", SyncSealRequest.parse(input), context, (value) =>
      SyncSealResult.parse(value),
    );
  }
  envelope(input: z.infer<typeof SyncEnvelopeRequest>, context: { trace: string; botId: string }) {
    return this.#call("sync.key.envelope", SyncEnvelopeRequest.parse(input), context, (value) =>
      SyncKeyEnvelope.parse(value),
    );
  }
  openKey(input: z.infer<typeof SyncOpenRequest>, context: { trace: string; botId: string }) {
    return this.#call("sync.key.open", SyncOpenRequest.parse(input), context, (value) =>
      z.strictObject({ version: z.literal(1), dek: SyncKeyBytes }).parse(value),
    );
  }

  identity(context: { trace: string; botId: string }) {
    return this.#call("sync.identity", undefined, context, (value) =>
      deviceSyncIdentity.parse(value),
    );
  }

  self(context: { trace: string; botId: string }) {
    return this.#call("sync.endpoints.self", undefined, context, (value) =>
      deviceSyncSelf.parse(value),
    );
  }
  proof(input: z.infer<typeof deviceSyncProof>, context: { trace: string; botId: string }) {
    return this.#call("sync.proof", deviceSyncProof.parse(input), context, (value) =>
      z
        .strictObject({ version: z.literal(1), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) })
        .parse(value),
    );
  }
  authorize(
    input: Parameters<DeviceSyncPort["access"]>[0],
    context: { trace: string; botId: string },
  ) {
    return this.#access("sync.peer.authorize", input, context, (value) =>
      deviceSyncPeerAccess.parse(value),
    );
  }
  access(
    input: Parameters<DeviceSyncPort["access"]>[0],
    context: { trace: string; botId: string },
  ) {
    return this.#access("sync.access", input, context, (value) => deviceSyncAccess.parse(value));
  }
  #access<T extends z.infer<typeof deviceSyncAccess>>(
    method: string,
    input: Parameters<DeviceSyncPort["access"]>[0],
    context: { trace: string; botId: string },
    decode: (value: unknown) => T,
  ) {
    const request = {
      ...input,
      sharedBotId: input.sharedBotId.toLowerCase(),
      peerDeviceId: input.peerDeviceId.toLowerCase(),
    };
    return this.#call(method, request, context, (value) => {
      const result = decode(value);
      if (
        result.sharedBotId !== request.sharedBotId ||
        result.purpose !== request.purpose ||
        result.peer.deviceId !== request.peerDeviceId ||
        !result.local.groupId ||
        result.local.groupId !== result.peer.groupId ||
        result.local.deviceId === result.peer.deviceId ||
        (result.endpoints !== null &&
          JSON.stringify(result.endpoints.identity) !== JSON.stringify(result.peer))
      )
        throw new Error("invalid_device_sync_response");
      return result;
    });
  }
}
