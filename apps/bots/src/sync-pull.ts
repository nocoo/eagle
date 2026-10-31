import { createHash, type KeyObject } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { z } from "zod";
import type { BotRegistry, ReadyReplica } from "./core/BotRegistry.ts";
import {
  cacheGetResult,
  type cacheListInput,
  cacheListResult,
  cachePublishResult,
  type cacheReceiveInput,
  cacheWireRequest,
} from "./core/DeviceSyncCache.ts";
import {
  type KeyEnvelope,
  SyncKeyDescriptor,
  SyncObjectCarrier,
  type SyncObjectManifest,
  type syncObjectPullInput,
} from "./core/DeviceSyncObjects.ts";
import {
  type DeviceSyncPort,
  type deviceSyncPeer,
  deviceSyncProof,
  type SyncApi,
  type SyncStatus,
  syncPullInput,
} from "./core/DeviceSyncPort.ts";
import {
  RelayAck,
  RelayBinding,
  RelayDelivery,
  RelayProgress,
  RelayReceipts,
  RelayStatusRead,
  RelayStatusReport,
  RelayStream,
  relayStatusResult,
} from "./core/DeviceSyncRelay.ts";
import { ClassifiedFailure, type Failure } from "./core/domain.ts";
import { newFailure } from "./core/failures.ts";
import { declareEvent } from "./log/events.ts";
import type { Log } from "./log/log.ts";
import { FAILURE_ID } from "./protocol/limits.ts";
import {
  checkTime,
  ephemeral,
  MAX_SYNC_FRAME,
  nonce,
  type Proof,
  seal,
  unseal,
  verifyProof,
} from "./sync-crypto.ts";
import {
  acceptedPin,
  decodePage,
  MAX_OBJECT_FRAME,
  metadataDigest,
  preparePage,
  type StoredObject,
  SyncObjectStorageError,
  SyncObjectStore,
  verifyCarrier,
  verifyDescriptor,
} from "./sync-objects.ts";
import { type RelayContext, SyncRelay } from "./sync-relay.ts";

const Events = {
  start: declareEvent("runtime.sync.start"),
  ok: declareEvent("runtime.sync.ok"),
  fail: declareEvent("runtime.sync.fail"),
};
const bytes32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const challengeInput = z.strictObject({
  version: z.literal(1),
  sharedBotId: z.uuid().toLowerCase(),
  readerDeviceId: z.uuid().toLowerCase(),
  readerNonce: bytes32,
  readerEphemeral: bytes32,
});
const challengeReply = z.strictObject({
  proof: deviceSyncProof,
  signature: z.string().max(2048),
  trace: z.string().max(160),
});
const pageInput = z.strictObject({
  sessionId: bytes32,
  signature: z.string().max(2048),
  box: z.unknown(),
});
const query = syncPullInput.omit({ peerDeviceId: true });
const objectQuery = z.union([
  query.extend({ recipientDescriptor: SyncKeyDescriptor }),
  z.strictObject({
    objectId: z.string().regex(/^[a-f0-9]{64}$/),
    recipientDescriptor: SyncKeyDescriptor,
  }),
]);
const remoteFailure = z.strictObject({
  id: z.string().regex(FAILURE_ID),
  kind: z.enum([
    "auth_failed",
    "invalid_command",
    "unknown_bot",
    "internal",
    "storage_failed",
    "limit_exceeded",
  ]),
  layer: z.enum(["transport", "protocol", "core", "runtime", "pi"]),
});
type Context = { trace: string; botId: string };
type Pending = { proof: Proof; privateKey: KeyObject; replica: ReadyReplica };

/** Internal only: a captured ready handle and use-point cancellation, never peer input. */
export type SyncAttempt = {
  readonly signal: AbortSignal;
  readonly replica: ReadyReplica;
  guard(): void;
  admit?(): void;
  connecting?(): void;
  authenticated?(): void;
  prepared?(manifest: z.infer<typeof SyncObjectManifest>): void;
};
export class SyncTransportError extends Error {}
export class SyncRemoteError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code: string | undefined) {
    super("sync_peer_refused");
    this.status = status;
    this.code = code;
  }
}
export function syncTransportFailure(error: unknown): boolean {
  return (
    error instanceof SyncTransportError ||
    (error instanceof ClassifiedFailure && error.cause instanceof SyncTransportError)
  );
}
export function syncRemoteFailure(error: unknown): SyncRemoteError | undefined {
  const cause = error instanceof ClassifiedFailure ? error.cause : error;
  return cause instanceof SyncRemoteError ? cause : undefined;
}

async function body(request: IncomingMessage, limit: number): Promise<unknown> {
  if (Number(request.headers["content-length"] ?? 0) > limit) {
    request.resume();
    throw new Error("sync_frame_too_large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new Error("sync_frame_too_large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function reply(
  response: ServerResponse,
  status: number,
  value: unknown,
  maximum = MAX_SYNC_FRAME,
): void {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > maximum) throw new Error("sync_frame_too_large");
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(text);
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** One authenticated ephemeral exchange; no queue, recovery, cache key or remote execution. */
export class AuthenticatedSync implements SyncApi {
  readonly #registry: BotRegistry;
  readonly #device: DeviceSyncPort;
  readonly #log: Log;
  readonly #binding: string | null;
  readonly #instance: string;
  readonly #objects: SyncObjectStore | undefined;
  readonly #cacheOrigin: string | undefined;
  readonly #relay: SyncRelay | undefined;
  readonly #relayClientGeneration = nonce();
  readonly #relayAbort = new AbortController();
  readonly #relayPending = new Map<string, Pending>();
  #generation = nonce();
  #directAbort = new AbortController();
  #closed = false;
  readonly #pending = new Map<string, Pending>();
  #ready: { port: number; digest: string } | undefined;
  constructor(options: {
    registry: BotRegistry;
    device: DeviceSyncPort;
    log: Log;
    deviceSocket?: string;
    instance?: string;
    root?: string;
    cacheOrigin?: string;
  }) {
    this.#registry = options.registry;
    this.#cacheOrigin = options.cacheOrigin;
    this.#objects = options.root === undefined ? undefined : new SyncObjectStore(options.root);
    this.#device = options.device;
    this.#log = options.log;
    this.#binding =
      options.deviceSocket === undefined
        ? null
        : createHash("sha256").update(options.deviceSocket).digest("hex");
    this.#instance = options.instance ?? `i_${nonce()}`;
    if (options.cacheOrigin)
      this.#relay = new SyncRelay(
        options.cacheOrigin,
        options.device,
        (path, input, fields, authority, signal) =>
          this.#exchange(
            options.cacheOrigin as string,
            path,
            input,
            fields,
            MAX_OBJECT_FRAME + 8192,
            authority,
            signal,
          ),
        async (method, input, fields, transport) => {
          try {
            const result =
              method === "challenge"
                ? await this.#challenge(challengeInput.parse(input), fields, transport)
                : await this.#object(pageInput.parse(input), fields, transport);
            return { status: 200, body: result };
          } catch (error) {
            const failure = this.#failure(error, fields);
            return {
              status: failure.failure.kind === "auth_failed" ? 403 : 503,
              body: { trace: fields.trace, error: { failure: failure.failure } },
            };
          }
        },
        (status, body) => this.#remoteError(status, body),
      );
  }
  async publishDescriptor(botId: string, trace: string) {
    if (!this.#device.publishDescriptor) throw new Error("sync_unconfigured");
    return this.#device.publishDescriptor({ botId, trace });
  }
  status(): SyncStatus {
    return {
      version: 1,
      instance: this.#instance,
      pid: process.pid,
      binding: this.#binding,
      ready: this.#ready !== undefined && !this.#closed,
      actualPort: this.#ready?.port ?? null,
      selfDigest: this.#ready?.digest ?? null,
    };
  }
  setReady(value: { port: number; digest: string } | undefined): void {
    this.#ready = value;
    if (value === undefined) {
      this.#directAbort.abort();
      this.#directAbort = new AbortController();
      this.#generation = nonce();
      this.#pending.clear();
    }
  }
  close(): void {
    this.#closed = true;
    this.#relayAbort.abort();
    this.#relay?.close();
    this.#relayPending.clear();
    this.setReady(undefined);
  }
  #live(generation: string): void {
    if (
      this.#closed ||
      (generation !== this.#generation &&
        generation !== this.#relayClientGeneration &&
        !this.#relay?.live(generation))
    )
      throw new Error("sync_generation_changed");
  }
  #use(proof: Proof, generation: string, attempt?: SyncAttempt): void {
    attempt?.guard();
    this.#live(generation);
    checkTime(proof);
  }
  async #replica(botId: string, trace: string, attempt?: Pick<SyncAttempt, "replica" | "guard">) {
    attempt?.guard();
    const replica = attempt?.replica ?? (await this.#registry.readyReplica(botId, trace));
    if (replica.botId !== botId) throw new Error("sync_identity_changed");
    await replica.check();
    attempt?.guard();
    return replica;
  }
  #failure(error: unknown, fields: Context): ClassifiedFailure {
    if (error instanceof ClassifiedFailure) {
      this.#log.emit("warn", "runtime", Events.fail, {
        ...fields,
        failure: error.failure,
        detail: { propagated: true, reason: "upstream", providerCode: error.failure.kind },
      });
      return error;
    }
    const reason =
      error instanceof Error && /^[a-z][a-z0-9_]{0,80}$/.test(error.message)
        ? error.message
        : "sync_protocol_invalid";
    const failure = newFailure(
      error instanceof SyncObjectStorageError
        ? "storage_failed"
        : reason === "sync_network_unreachable"
          ? "internal"
          : "auth_failed",
      "runtime",
    );
    this.#log.emit("error", "runtime", Events.fail, {
      ...fields,
      failure,
      origin: true,
      detail: { reason: "upstream", providerCode: reason.slice(0, 40) },
    });
    return new ClassifiedFailure(failure, "not_admitted", "authenticated synchronization failed", {
      cause: error instanceof SyncObjectStorageError ? error.cause : error,
    });
  }
  async #authorize(proof: Proof, fields: Context): Promise<void> {
    checkTime(proof);
    const role = proof.role;
    const own = proof[role];
    const peer = proof[role === "reader" ? "server" : "reader"];
    const input = {
      sharedBotId: proof.sharedBotId,
      peerDeviceId: peer.deviceId,
      purpose: "replica.read" as const,
    };
    const result =
      role === "reader"
        ? await this.#device.access(input, fields)
        : await this.#device.authorize?.(input, fields);
    if (
      !result ||
      !same(result.local, own) ||
      !same(result.peer, peer) ||
      ("registryOrigin" in result && result.registryOrigin !== proof.registryOrigin)
    )
      throw new Error("sync_identity_changed");
  }
  readonly handler: RequestListener = (request, response) => {
    const requested = request.headers["x-bots-sync-trace"];
    const trace =
      typeof requested === "string" && /^tr_[A-Za-z0-9_-]{1,128}$/.test(requested)
        ? requested
        : `tr_sync_${nonce().slice(0, 16)}`;
    const fields = { trace, botId: "b_sync" };
    void (async () => {
      this.#live(this.#generation);
      if (request.method !== "POST" || request.headers.origin !== undefined)
        throw new Error("sync_route_refused");
      if (request.url === "/v1/sync/challenge")
        return this.#challenge(challengeInput.parse(await body(request, 8192)), fields);
      if (request.url === "/v1/sync/object")
        return this.#object(pageInput.parse(await body(request, 16384)), fields);
      if (request.url === "/v1/sync/page")
        return this.#page(pageInput.parse(await body(request, MAX_SYNC_FRAME)), fields);
      throw new Error("sync_route_refused");
    })().then(
      (value) => {
        try {
          reply(
            response,
            200,
            value,
            request.url === "/v1/sync/object" ? MAX_OBJECT_FRAME : MAX_SYNC_FRAME,
          );
        } catch (error) {
          const failure = this.#failure(error, fields);
          response.destroy(failure);
        }
      },
      (error) => {
        const failure = this.#failure(error, fields);
        if (!response.destroyed && !response.headersSent)
          reply(response, failure.failure.kind === "auth_failed" ? 403 : 409, {
            trace,
            error: { failure: failure.failure },
          });
      },
    );
  };
  async #challenge(
    input: z.infer<typeof challengeInput>,
    fields: Context,
    transport?: RelayContext,
  ) {
    const generation = transport?.generation ?? this.#generation;
    const pendingMap = transport ? this.#relayPending : this.#pending;
    transport?.guard();
    for (const [id, pending] of pendingMap)
      if (pending.proof.expiresAt <= Date.now()) pendingMap.delete(id);
    if (pendingMap.size >= 128) throw new Error("sync_challenge_capacity");
    const access = await this.#device.authorize?.(
      {
        sharedBotId: input.sharedBotId,
        peerDeviceId: input.readerDeviceId,
        purpose: "replica.read",
      },
      fields,
    );
    if (!access || !this.#device.proof) throw new Error("sync_unconfigured");
    const replica = await this.#registry.readySharedReplica(input.sharedBotId, fields.trace);
    fields.botId = replica.botId;
    if (transport && !same(replica.binding, transport.replica.binding))
      throw new Error("sync_identity_changed");
    const pair = ephemeral();
    const proof = deviceSyncProof.parse({
      version: 1,
      registryOrigin: access.registryOrigin,
      role: "server",
      purpose: "replica.read",
      sharedBotId: input.sharedBotId,
      reader: access.peer,
      server: access.local,
      readerNonce: input.readerNonce,
      readerEphemeral: input.readerEphemeral,
      serverNonce: nonce(),
      serverEphemeral: pair.publicKey,
      generation,
      sessionId: nonce(),
      expiresAt: Date.now() + 60000,
    });
    const signature = (await this.#device.proof(proof, fields)).signature;
    verifyProof(proof, signature);
    await this.#authorize(proof, fields);
    await replica.check();
    transport?.guard();
    this.#use(proof, generation);
    if (pendingMap.size >= 128) throw new Error("sync_challenge_capacity");
    pendingMap.set(proof.sessionId, { proof, privateKey: pair.privateKey, replica });
    return { proof, signature, trace: fields.trace };
  }
  async #page(input: z.infer<typeof pageInput>, fields: Context) {
    const pending = this.#pending.get(input.sessionId);
    this.#pending.delete(input.sessionId);
    if (!pending) throw new Error("sync_challenge_unknown");
    const { proof, privateKey, replica } = pending;
    fields.botId = replica.botId;
    this.#use(proof, proof.generation);
    verifyProof({ ...proof, role: "reader" }, input.signature);
    const params = query.parse(
      JSON.parse(unseal(proof, privateKey, "reader", input.box).toString("utf8")),
    );
    await this.#authorize(proof, fields);
    await replica.check();
    const page = await replica.command("pull", params, () => this.#use(proof, proof.generation));
    await this.#authorize(proof, fields);
    await replica.check();
    this.#use(proof, proof.generation);
    return {
      box: seal(proof, privateKey, "server", Buffer.from(JSON.stringify(page))),
      trace: fields.trace,
    };
  }
  #objectBinding(replica: ReadyReplica) {
    const binding = z
      .strictObject({
        localBotId: z.string(),
        sharedBotId: z.uuid(),
        replicaId: z.uuid(),
        epoch: z.uuid(),
      })
      .parse(replica.binding);
    if (binding.localBotId !== replica.botId) throw new Error("sync_object_binding_invalid");
    return binding;
  }
  #ownedRecord(record: StoredObject, replica: ReadyReplica): void {
    if (record.botId !== replica.botId || !same(record.binding, this.#objectBinding(replica)))
      throw new Error("sync_object_binding_invalid");
  }
  async #publish(
    replica: ReadyReplica,
    staged: Awaited<ReturnType<SyncObjectStore["stage"]>>,
    use: () => void,
    fields: Context,
    attempt?: SyncAttempt,
  ) {
    try {
      await replica.publish(
        () => {
          try {
            staged.publish();
          } catch (cause) {
            throw this.#failure(cause, fields);
          }
          return undefined;
        },
        () => {
          try {
            use();
            attempt?.admit?.();
          } catch (cause) {
            throw this.#failure(cause, fields);
          }
        },
      );
    } finally {
      staged.discard();
    }
    const result = staged.complete();
    this.#ownedRecord(result, replica);
    return result;
  }
  async #objectCarrier(
    replica: ReadyReplica,
    params: z.infer<typeof objectQuery>,
    server: z.infer<typeof deviceSyncPeer>,
    reader: z.infer<typeof deviceSyncPeer>,
    registryOrigin: string,
    current: () => Promise<void>,
    use: () => void,
    fields: Context,
  ) {
    if (!this.#objects) throw new Error("sync_unconfigured");
    verifyDescriptor(params.recipientDescriptor, reader, registryOrigin);
    let record: StoredObject;
    if ("objectId" in params) {
      const existing = this.#objects.read(params.objectId);
      if (existing?.kind !== "publisher") throw new Error("sync_object_unknown");
      this.#ownedRecord(existing, replica);
      record = existing;
    } else {
      const page = await replica.command(
        "pull",
        { source: params.source, after: params.after, limit: params.limit },
        use,
      );
      const selected = preparePage(page, server, registryOrigin);
      const existing = this.#objects.read(selected.objectId);
      if (existing) {
        this.#ownedRecord(existing, replica);
        record = existing;
      } else {
        if (!this.#device.sealKey) throw new Error("sync_unconfigured");
        const prepared = selected.encrypt();
        let sealed: Awaited<ReturnType<NonNullable<DeviceSyncPort["sealKey"]>>>;
        try {
          sealed = await this.#device.sealKey(
            {
              version: 1,
              identity: server,
              manifest: prepared.manifest,
              dek: prepared.key.toString("base64url"),
            },
            fields,
          );
        } finally {
          prepared.key.fill(0);
        }
        const carrier = verifyCarrier({
          version: 1,
          manifest: sealed.manifest,
          descriptor: sealed.descriptor,
          ciphertext: prepared.ciphertext,
          envelope: sealed.envelope,
        });
        const staged = await this.#objects.stage({
          version: 1,
          kind: "publisher",
          botId: replica.botId,
          binding: this.#objectBinding(replica),
          carrier,
          pin: acceptedPin(carrier),
        });
        try {
          await current();
          record = await this.#publish(replica, staged, use, fields);
        } finally {
          staged.discard();
        }
      }
    }
    if (
      record.kind !== "publisher" ||
      record.carrier.manifest.publisher.deviceId !== server.deviceId ||
      record.carrier.manifest.publisher.publicKey !== server.publicKey
    )
      throw new Error("sync_object_publisher_invalid");
    if (!this.#device.descriptor || !this.#device.envelope) throw new Error("sync_unconfigured");
    const descriptor = verifyDescriptor(
      await this.#device.descriptor(fields),
      server,
      registryOrigin,
    );
    const slot = this.#objects.recipient(
      record,
      server,
      reader,
      descriptor,
      params.recipientDescriptor,
    );
    let envelope: KeyEnvelope | undefined = slot.read();
    if (!envelope) {
      const issued = await this.#device.envelope(
        {
          version: 1,
          identity: server,
          manifest: record.carrier.manifest,
          envelope: record.carrier.envelope,
          recipient: reader,
          recipientDescriptor: params.recipientDescriptor,
        },
        fields,
      );
      const staged = await slot.stage(issued);
      try {
        await current();
        await replica.publish(
          () => {
            try {
              staged.publish();
            } catch (cause) {
              throw this.#failure(cause, fields);
            }
            return undefined;
          },
          () => {
            try {
              use();
            } catch (cause) {
              throw this.#failure(cause, fields);
            }
          },
        );
        envelope = staged.complete();
      } finally {
        staged.discard();
      }
    }
    if (!envelope) throw new Error("sync_object_envelope_invalid");
    const carrier = verifyCarrier({ ...record.carrier, envelope });
    return carrier;
  }
  async #object(input: z.infer<typeof pageInput>, fields: Context, transport?: RelayContext) {
    const pendingMap = transport ? this.#relayPending : this.#pending;
    const pending = pendingMap.get(input.sessionId);
    pendingMap.delete(input.sessionId);
    if (!pending || !this.#objects) throw new Error("sync_challenge_unknown");
    const { proof, privateKey, replica } = pending;
    fields.botId = replica.botId;
    const use = () => {
      transport?.guard();
      if (transport && proof.generation !== transport.generation)
        throw new Error("sync_generation_changed");
      this.#use(proof, proof.generation);
    };
    use();
    verifyProof({ ...proof, role: "reader" }, input.signature);
    const params = objectQuery.parse(
      JSON.parse(unseal(proof, privateKey, "reader", input.box).toString("utf8")),
    );
    verifyDescriptor(params.recipientDescriptor, proof.reader, proof.registryOrigin);
    await this.#authorize(proof, fields);
    await replica.check();
    use();
    const carrier = await this.#objectCarrier(
      replica,
      params,
      proof.server,
      proof.reader,
      proof.registryOrigin,
      () => this.#authorize(proof, fields),
      use,
      fields,
    );
    await this.#authorize(proof, fields);
    await replica.check();
    use();
    const receipt = {
      version: 1,
      purpose: "replica.object.delivery",
      sessionId: proof.sessionId,
      requestDigest: metadataDigest(params),
      objectId: carrier.manifest.objectId,
      ...acceptedPin(carrier),
    };
    return {
      carrier,
      receipt: seal(proof, privateKey, "server", Buffer.from(JSON.stringify(receipt))),
      trace: fields.trace,
    };
  }
  async pullObject(
    botId: string,
    input: z.infer<typeof syncObjectPullInput>,
    trace: string,
    attempt?: SyncAttempt,
    relay = false,
  ): Promise<unknown> {
    const fields = { trace, botId },
      generation = relay ? this.#relayClientGeneration : this.#generation;
    this.#log.emit("info", "runtime", Events.start, fields);
    try {
      this.#live(generation);
      if (!this.#objects || !this.#device.descriptor || !this.#device.openKey)
        throw new Error("sync_unconfigured");
      const replica = await this.#replica(botId, trace, attempt);
      this.#objectBinding(replica);
      const { origin, pair, proof, signature } = await this.#connect(
        replica,
        input.peerDeviceId,
        fields,
        generation,
        attempt,
        relay,
      );
      const descriptor = verifyDescriptor(
        await this.#device.descriptor(fields),
        proof.reader,
        proof.registryOrigin,
      );
      const params = objectQuery.parse(
        "objectId" in input
          ? { objectId: input.objectId, recipientDescriptor: descriptor }
          : {
              source: input.source,
              after: input.after,
              limit: input.limit,
              recipientDescriptor: descriptor,
            },
      );
      await this.#authorize(proof, fields);
      await replica.check();
      this.#use(proof, generation, attempt);
      const response = z
        .strictObject({
          carrier: SyncObjectCarrier,
          receipt: z.unknown(),
          trace: z.literal(trace),
          relayRequestId: z.uuid().optional(),
        })
        .parse(
          await this.#transportExchange(
            replica.binding,
            replica.sharedBotId,
            input.peerDeviceId,
            relay,
            origin,
            "/v1/sync/object",
            {
              sessionId: proof.sessionId,
              signature,
              box: seal(proof, pair.privateKey, "reader", Buffer.from(JSON.stringify(params))),
            },
            fields,
            MAX_OBJECT_FRAME,
            undefined,
            AbortSignal.any([
              relay ? this.#relayAbort.signal : this.#directAbort.signal,
              ...(attempt ? [attempt.signal] : []),
            ]),
          ),
        );
      const carrier = verifyCarrier(response.carrier),
        manifest = carrier.manifest,
        envelope = carrier.envelope;
      if (
        manifest.registryOrigin !== proof.registryOrigin ||
        manifest.sharedBotId !== replica.sharedBotId ||
        manifest.publisher.deviceId !== proof.server.deviceId ||
        manifest.publisher.publicKey !== proof.server.publicKey ||
        !same(envelope.issuer, proof.server) ||
        !same(envelope.recipient, proof.reader) ||
        ("objectId" in input && manifest.objectId !== input.objectId)
      )
        throw new Error("sync_object_exchange_invalid");
      const receipt: unknown = JSON.parse(
        unseal(proof, pair.privateKey, "server", response.receipt).toString("utf8"),
      );
      if (
        !same(receipt, {
          version: 1,
          purpose: "replica.object.delivery",
          sessionId: proof.sessionId,
          requestDigest: metadataDigest(params),
          objectId: manifest.objectId,
          ...acceptedPin(carrier),
        })
      )
        throw new Error("sync_object_delivery_invalid");
      // Fixed pins originate here, only after this current authenticated exchange.
      const pin = acceptedPin(carrier);
      const opened = await this.#device.openKey(
        {
          version: 1,
          manifest,
          envelope,
          publisherPin: pin.publisher,
          issuerPin: pin.issuer,
          recipientPin: pin.recipient,
        },
        fields,
      );
      const key = Buffer.from(opened.dek, "base64url");
      try {
        decodePage(carrier, key);
      } finally {
        key.fill(0);
      }
      const staged = await this.#objects.stage({
        version: 1,
        kind: "recipient",
        botId,
        binding: this.#objectBinding(replica),
        carrier,
        pin,
      });
      let record: StoredObject;
      try {
        await this.#authorize(proof, fields);
        record = await this.#publish(
          replica,
          staged,
          () => this.#use(proof, generation, attempt),
          fields,
          attempt,
        );
      } finally {
        staged.discard();
      }
      this.#log.emit("info", "runtime", Events.ok, fields);
      return {
        version: 1,
        objectId: record.carrier.manifest.objectId,
        stored: true,
        applied: false,
        cipherDigest: record.carrier.manifest.cipherDigest,
        ...(relay
          ? {
              page: {
                objectId: manifest.objectId,
                source: manifest.source,
                included: manifest.included,
                nextAfter: manifest.nextAfter,
                hasMore: manifest.hasMore,
              },
              delivery: {
                requestId: response.relayRequestId,
                sessionId: proof.sessionId,
                objectId: manifest.objectId,
                source: manifest.source,
              },
            }
          : {}),
      };
    } catch (cause) {
      throw this.#failure(cause, fields);
    }
  }
  async storedObject(
    botId: string,
    object: { objectId: string; included: { seq: number; eventDigest: string }[] },
    source: { replicaId: string; epoch: string },
    trace: string,
    attempt: SyncAttempt,
  ): Promise<boolean> {
    try {
      const replica = await this.#replica(botId, trace, attempt);
      const record = this.#objects?.read(object.objectId);
      if (!record) return false;
      this.#ownedRecord(record, replica);
      if (
        !same(record.carrier.manifest.source, source) ||
        !same(record.carrier.manifest.included, object.included)
      )
        throw new Error("sync_cache_invalid");
      attempt.guard();
      return true;
    } catch (cause) {
      throw this.#failure(cause, { trace, botId });
    }
  }
  async applyObject(
    botId: string,
    objectId: string,
    trace: string,
    attempt?: SyncAttempt,
  ): Promise<unknown> {
    const fields = { trace, botId };
    const use = () => {
      attempt?.guard();
      if (this.#closed) throw new Error("sync_closed");
    };
    this.#log.emit("info", "runtime", Events.start, fields);
    try {
      use();
      if (!this.#objects || !this.#device.openKey) throw new Error("sync_unconfigured");
      const replica = await this.#replica(botId, trace, attempt),
        record = this.#objects.read(objectId);
      if (!record) throw new Error("sync_object_unknown");
      this.#ownedRecord(record, replica);
      const { carrier, pin } = record;
      const opened = await this.#device.openKey(
        {
          version: 1,
          manifest: carrier.manifest,
          envelope: carrier.envelope,
          publisherPin: pin.publisher,
          issuerPin: pin.issuer,
          recipientPin: pin.recipient,
        },
        fields,
      );
      const key = Buffer.from(opened.dek, "base64url");
      let page: unknown;
      try {
        page = decodePage(carrier, key).page;
      } finally {
        key.fill(0);
      }
      const applied = await replica.command("apply", { page }, () => {
        use();
        attempt?.admit?.();
      });
      this.#log.emit("info", "runtime", Events.ok, fields);
      return { version: 1, objectId, applied };
    } catch (cause) {
      throw this.#failure(cause, fields);
    }
  }
  async #cacheSession(
    replica: ReadyReplica,
    peerDeviceId: string,
    role: "uploader" | "reader",
    fields: Context,
    attempt?: SyncAttempt,
  ) {
    if (!this.#cacheOrigin || !this.#device.cacheAuthority)
      throw new Error("sync_cache_unconfigured");
    let expiresAt = Date.now() + 60000;
    let registryOrigin: string | undefined;
    const use = (objectExpiry?: number) => {
      attempt?.guard();
      if (this.#closed) throw new Error("sync_closed");
      if (Date.now() >= expiresAt || (objectExpiry !== undefined && Date.now() >= objectExpiry))
        throw new Error("sync_cache_expired");
    };
    use();
    const input = {
      sharedBotId: replica.sharedBotId,
      peerDeviceId,
      purpose: "replica.read" as const,
    };
    const read = async () =>
      role === "uploader"
        ? this.#device.authorize?.(input, fields)
        : this.#device.access(input, fields);
    const before = await read();
    if (
      !before ||
      before.sharedBotId !== replica.sharedBotId ||
      before.purpose !== input.purpose ||
      before.peer.deviceId !== peerDeviceId ||
      before.peer.deviceId === before.local.deviceId ||
      !before.local.groupId ||
      before.local.groupId !== before.peer.groupId
    )
      throw new Error("sync_identity_changed");
    if ("registryOrigin" in before && typeof before.registryOrigin === "string")
      registryOrigin = before.registryOrigin;
    const current = async () => {
      const after = await read();
      if (
        !after ||
        after.sharedBotId !== before.sharedBotId ||
        !same(after.local, before.local) ||
        !same(after.peer, before.peer) ||
        ("registryOrigin" in after && registryOrigin !== after.registryOrigin)
      )
        throw new Error("sync_identity_changed");
      use();
    };
    const ticket = async (value: z.infer<typeof cacheWireRequest>) => {
      if (!this.#device.cacheAuthority) throw new Error("sync_cache_unconfigured");
      let requestDigest = metadataDigest(value);
      if (value.operation === "publish") {
        const { ciphertext, ...metadata } = value.carrier;
        const bytes = Buffer.from(ciphertext, "base64url");
        requestDigest = metadataDigest({
          ...value,
          carrier: {
            ...metadata,
            cipherDigest: createHash("sha256").update(bytes).digest("hex"),
            cipherLength: bytes.length,
          },
        });
      }
      const result = await this.#device.cacheAuthority(
        {
          version: 1,
          operation: value.operation,
          sharedBotId: replica.sharedBotId,
          peerDeviceId,
          requestDigest,
        },
        fields,
      );
      const uploader = role === "uploader" ? before.local : before.peer;
      const recipient = role === "uploader" ? before.peer : before.local;
      if (
        result.sharedBotId !== replica.sharedBotId ||
        result.operation !== value.operation ||
        result.requestDigest !== requestDigest ||
        !same(result.uploader, uploader) ||
        !same(result.recipient, recipient) ||
        (registryOrigin !== undefined && result.registryOrigin !== registryOrigin)
      )
        throw new Error("sync_cache_authority_mismatch");
      registryOrigin = result.registryOrigin;
      expiresAt = Math.min(expiresAt, result.expiresAt);
      use();
      return result;
    };
    use();
    return { before, current, use, ticket };
  }
  async cachePublish(
    botId: string,
    input: z.infer<typeof syncObjectPullInput>,
    trace: string,
    attempt?: SyncAttempt,
  ): Promise<unknown> {
    const fields = { trace, botId };
    this.#log.emit("info", "runtime", Events.start, fields);
    try {
      attempt?.guard();
      if (this.#closed) throw new Error("sync_closed");
      const replica = await this.#replica(botId, trace, attempt);
      this.#objectBinding(replica);
      const session = await this.#cacheSession(
        replica,
        input.peerDeviceId,
        "uploader",
        fields,
        attempt,
      );
      if (
        !this.#device.lookup ||
        !("registryOrigin" in session.before) ||
        typeof session.before.registryOrigin !== "string"
      )
        throw new Error("sync_cache_unconfigured");
      const published = await this.#device.lookup(
        {
          sharedBotId: replica.sharedBotId,
          peerDeviceId: input.peerDeviceId,
          purpose: "replica.read",
        },
        fields,
      );
      if (!same(published.identity, session.before.peer)) throw new Error("sync_identity_changed");
      const params = objectQuery.parse(
        "objectId" in input
          ? { objectId: input.objectId, recipientDescriptor: published.descriptor }
          : {
              source: input.source,
              after: input.after,
              limit: input.limit,
              recipientDescriptor: published.descriptor,
            },
      );
      await session.current();
      await replica.check();
      session.use();
      const carrier = await this.#objectCarrier(
        replica,
        params,
        session.before.local,
        session.before.peer,
        session.before.registryOrigin,
        session.current,
        session.use,
        fields,
      );
      attempt?.prepared?.(carrier.manifest);
      const wire = cacheWireRequest.parse({
        version: 1,
        operation: "publish",
        sharedBotId: replica.sharedBotId,
        peerDeviceId: input.peerDeviceId,
        carrier,
      });
      const authority = await session.ticket(wire);
      await session.current();
      await replica.check();
      session.use();
      const result = cachePublishResult.parse(
        await this.#exchange(
          this.#cacheOrigin as string,
          "/v1/cache/publish",
          wire,
          fields,
          MAX_OBJECT_FRAME,
          authority.authority,
          attempt?.signal,
        ),
      );
      await session.current();
      await replica.check();
      session.use();
      if (
        result.cloudCached &&
        (result.objectId !== carrier.manifest.objectId ||
          result.expiresAt > result.firstCachedAt + 72 * 60 * 60 * 1000)
      )
        throw new Error("sync_cache_invalid");
      this.#log.emit("info", "runtime", Events.ok, fields);
      return {
        ...result,
        page: {
          objectId: carrier.manifest.objectId,
          source: carrier.manifest.source,
          included: carrier.manifest.included,
          nextAfter: carrier.manifest.nextAfter,
          hasMore: carrier.manifest.hasMore,
        },
      };
    } catch (cause) {
      throw this.#failure(cause, fields);
    }
  }
  async cacheList(
    botId: string,
    input: z.infer<typeof cacheListInput>,
    trace: string,
    attempt?: SyncAttempt,
  ): Promise<unknown> {
    const fields = { trace, botId };
    this.#log.emit("info", "runtime", Events.start, fields);
    try {
      attempt?.guard();
      if (this.#closed) throw new Error("sync_closed");
      const replica = await this.#replica(botId, trace, attempt);
      this.#objectBinding(replica);
      const session = await this.#cacheSession(
        replica,
        input.peerDeviceId,
        "reader",
        fields,
        attempt,
      );
      const wire = cacheWireRequest.parse({
        version: 1,
        operation: "list",
        sharedBotId: replica.sharedBotId,
        ...input,
      });
      const authority = await session.ticket(wire);
      await replica.check();
      session.use();
      const result = cacheListResult.parse(
        await this.#exchange(
          this.#cacheOrigin as string,
          "/v1/cache/list",
          wire,
          fields,
          MAX_OBJECT_FRAME,
          authority.authority,
          attempt?.signal,
        ),
      );
      await session.current();
      await replica.check();
      session.use();
      for (const object of result.objects) session.use(object.expiresAt);
      this.#log.emit("info", "runtime", Events.ok, fields);
      return result;
    } catch (cause) {
      throw this.#failure(cause, fields);
    }
  }
  async cacheReceive(
    botId: string,
    input: z.infer<typeof cacheReceiveInput>,
    trace: string,
    attempt?: SyncAttempt,
  ): Promise<unknown> {
    const fields = { trace, botId };
    this.#log.emit("info", "runtime", Events.start, fields);
    try {
      attempt?.guard();
      if (this.#closed) throw new Error("sync_closed");
      if (!this.#objects || !this.#device.openKey) throw new Error("sync_unconfigured");
      const replica = await this.#replica(botId, trace, attempt);
      this.#objectBinding(replica);
      const session = await this.#cacheSession(
        replica,
        input.peerDeviceId,
        "reader",
        fields,
        attempt,
      );
      const wire = cacheWireRequest.parse({
        version: 1,
        operation: "get",
        sharedBotId: replica.sharedBotId,
        ...input,
      });
      const authority = await session.ticket(wire);
      await replica.check();
      session.use();
      const result = cacheGetResult.parse(
        await this.#exchange(
          this.#cacheOrigin as string,
          "/v1/cache/get",
          wire,
          fields,
          MAX_OBJECT_FRAME,
          authority.authority,
          attempt?.signal,
        ),
      );
      const carrier = verifyCarrier(result.carrier),
        manifest = carrier.manifest,
        envelope = carrier.envelope;
      if (
        manifest.objectId !== input.objectId ||
        manifest.sharedBotId !== replica.sharedBotId ||
        manifest.registryOrigin !== authority.registryOrigin ||
        manifest.publisher.deviceId !== authority.uploader.deviceId ||
        manifest.publisher.publicKey !== authority.uploader.publicKey ||
        !same(envelope.issuer, authority.uploader) ||
        !same(envelope.recipient, authority.recipient) ||
        result.expiresAt > result.firstCachedAt + 72 * 60 * 60 * 1000
      )
        throw new Error("sync_cache_identity_mismatch");
      const use = () => session.use(result.expiresAt);
      use();
      const pin = acceptedPin(carrier);
      const opened = await this.#device.openKey(
        {
          version: 1,
          manifest,
          envelope,
          publisherPin: pin.publisher,
          issuerPin: pin.issuer,
          recipientPin: pin.recipient,
        },
        fields,
      );
      const key = Buffer.from(opened.dek, "base64url");
      try {
        decodePage(carrier, key);
      } finally {
        key.fill(0);
      }
      const staged = await this.#objects.stage({
        version: 1,
        kind: "recipient",
        botId,
        binding: this.#objectBinding(replica),
        carrier,
        pin,
      });
      let record: StoredObject;
      try {
        await session.current();
        record = await this.#publish(replica, staged, use, fields, attempt);
      } finally {
        staged.discard();
      }
      this.#log.emit("info", "runtime", Events.ok, fields);
      return {
        version: 1,
        objectId: record.carrier.manifest.objectId,
        stored: true,
        applied: false,
        cipherDigest: record.carrier.manifest.cipherDigest,
      };
    } catch (cause) {
      throw this.#failure(cause, fields);
    }
  }
  async #exchange(
    origin: string,
    path: string,
    value: unknown,
    fields: Context,
    maximum = MAX_SYNC_FRAME,
    cacheAuthority?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > maximum) throw new Error("sync_frame_too_large");
    let response: Response;
    try {
      response = await fetch(origin + path, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]),
        headers: {
          "content-type": "application/json",
          "x-bots-sync-trace": fields.trace,
          "x-bots-sync-bot": fields.botId,
          ...(cacheAuthority === undefined ? {} : { authorization: `Bearer ${cacheAuthority}` }),
        },
        body: text,
      });
    } catch (error) {
      if (signal?.aborted) throw new Error("sync_attempt_cancelled", { cause: error });
      throw new SyncTransportError("sync_network_unreachable", { cause: error });
    }
    if (Number(response.headers.get("content-length") ?? 0) > maximum) {
      await response.body?.cancel();
      throw new Error("sync_frame_too_large");
    }
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const part = await reader.read().catch((cause: unknown) => {
            if (signal?.aborted) throw new Error("sync_attempt_cancelled", { cause });
            throw new SyncTransportError("sync_network_unreachable", { cause });
          });
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > maximum) {
            await reader.cancel().catch(() => undefined);
            throw new Error("sync_frame_too_large");
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const decoded: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!response.ok) {
      throw this.#remoteError(response.status, decoded);
    }
    return decoded;
  }
  #remoteError(status: number, decoded: unknown): Error {
    const failure = remoteFailure.safeParse(
      (decoded as { error?: { failure?: unknown } })?.error?.failure,
    );
    const codeValue = (decoded as { error?: { code?: unknown } })?.error?.code;
    const code =
      typeof codeValue === "string" && /^sync_[a-z_]{1,72}$/.test(codeValue)
        ? codeValue
        : undefined;
    const cause = new SyncRemoteError(status, code);
    if (failure.success)
      return new ClassifiedFailure(
        failure.data as Failure,
        "not_admitted",
        "peer refused synchronization",
        { cause },
      );
    return cause;
  }
  canRelay() {
    return this.#relay !== undefined && this.#device.relayAuthority !== undefined;
  }
  relayStop(botId: string) {
    this.#relay?.stop(botId);
  }
  async relayAck(botId: string, input: unknown, trace: string, attempt?: SyncAttempt) {
    const fields = { trace, botId };
    try {
      if (!this.#relay) throw new Error("sync_unconfigured");
      const selector = z
        .strictObject({ peerDeviceId: z.uuid(), delivery: RelayDelivery })
        .parse(input);
      const replica = await this.#replica(botId, trace, attempt);
      const status = z.object({
        streams: z.array(z.object({ ...RelayStream.shape })),
        localBotId: z.string(),
        sharedBotId: z.uuid(),
        replicaId: z.uuid(),
        epoch: z.uuid(),
      });
      const actual = status.parse(await replica.command("status", {}, () => attempt?.guard()));
      const stream = actual.streams.find((v) => same(v.source, selector.delivery.source));
      if (!stream) throw new Error("sync_relay_source_missing");
      const body = RelayAck.parse({
        version: 1,
        operation: "ack",
        sharedBotId: replica.sharedBotId,
        peerDeviceId: selector.peerDeviceId,
        delivery: selector.delivery,
        binding: RelayBinding.parse({
          localBotId: actual.localBotId,
          sharedBotId: actual.sharedBotId,
          replicaId: actual.replicaId,
          epoch: actual.epoch,
        }),
        ...stream,
      });
      await replica.check();
      attempt?.guard();
      const result = await this.#relay.metadata(body, fields, attempt?.signal);
      await replica.check();
      attempt?.guard();
      return result;
    } catch (error) {
      throw this.#failure(error, fields);
    }
  }
  async relayReceipts(botId: string, input: unknown, trace: string) {
    const fields = { trace, botId };
    try {
      if (!this.#relay) throw new Error("sync_unconfigured");
      const peer = z.strictObject({ peerDeviceId: z.uuid() }).parse(input);
      const replica = await this.#replica(botId, trace);
      const result = await this.#relay.metadata(
        RelayReceipts.parse({
          version: 1,
          operation: "receipts",
          sharedBotId: replica.sharedBotId,
          ...peer,
        }),
        fields,
      );
      await replica.check();
      return result;
    } catch (error) {
      throw this.#failure(error, fields);
    }
  }
  async statusReport(botId: string, input: unknown, trace: string, attempt?: SyncAttempt) {
    const fields = { trace, botId };
    try {
      if (!this.#relay) throw new Error("sync_unconfigured");
      const peer = z.strictObject({ peerDeviceId: z.uuid() }).parse(input);
      const replica = await this.#replica(botId, trace, attempt);
      const actual = z
        .object({
          ...RelayBinding.shape,
          streams: z.array(z.object({ ...RelayProgress.shape })).max(128),
        })
        .parse(await replica.command("status", {}, () => attempt?.guard()));
      const binding = RelayBinding.parse({
        localBotId: actual.localBotId,
        sharedBotId: actual.sharedBotId,
        replicaId: actual.replicaId,
        epoch: actual.epoch,
      });
      if (!same(binding, RelayBinding.parse(replica.binding)))
        throw new Error("sync_identity_changed");
      const body = RelayStatusReport.parse({
        version: 1,
        operation: "status-report",
        sharedBotId: replica.sharedBotId,
        ...peer,
        binding,
        streams: actual.streams.map(({ source, received, applied }) => ({
          source,
          received,
          applied,
        })),
      });
      await replica.check();
      attempt?.guard();
      const result = z.strictObject({ version: z.literal(1), recorded: z.literal(true) }).parse(
        await this.#relay.metadata(body, fields, attempt?.signal, async () => {
          await replica.check();
          attempt?.guard();
          this.#live(this.#relayClientGeneration);
        }),
      );
      await replica.check();
      attempt?.guard();
      this.#live(this.#relayClientGeneration);
      return result;
    } catch (error) {
      throw this.#failure(error, fields);
    }
  }
  async statusRead(botId: string, input: unknown, trace: string, attempt?: SyncAttempt) {
    const fields = { trace, botId };
    try {
      if (!this.#relay) throw new Error("sync_unconfigured");
      const peer = z.strictObject({ peerDeviceId: z.uuid() }).parse(input);
      const replica = await this.#replica(botId, trace, attempt);
      const result = relayStatusResult.parse(
        await this.#relay.metadata(
          RelayStatusRead.parse({
            version: 1,
            operation: "status-read",
            sharedBotId: replica.sharedBotId,
            ...peer,
          }),
          fields,
          attempt?.signal,
          async () => {
            await replica.check();
            attempt?.guard();
            this.#live(this.#relayClientGeneration);
          },
        ),
      );
      if (
        result.snapshots.some(
          (s) =>
            s.sharedBotId !== replica.sharedBotId ||
            s.binding.sharedBotId !== replica.sharedBotId ||
            s.receiver.deviceId !== peer.peerDeviceId,
        )
      )
        throw new Error("sync_relay_status_mismatch");
      await replica.check();
      attempt?.guard();
      this.#live(this.#relayClientGeneration);
      return result;
    } catch (error) {
      throw this.#failure(error, fields);
    }
  }
  async relayRegister(
    botId: string,
    trace: string,
    ownership?: Pick<SyncAttempt, "replica" | "guard">,
  ) {
    const fields = { trace, botId };
    try {
      if (!this.#relay) throw new Error("sync_unconfigured");
      const replica = await this.#replica(botId, trace, ownership);
      return await this.#relay.register(replica, fields, () => ownership?.guard());
    } catch (error) {
      throw this.#failure(error, fields);
    }
  }
  async relayDiscover(botId: string, trace: string, attempt?: SyncAttempt) {
    const fields = { trace, botId };
    try {
      if (!this.#relay) throw new Error("sync_unconfigured");
      const replica = await this.#replica(botId, trace, attempt);
      const result = await this.#relay.directory(replica.sharedBotId, fields, attempt?.signal);
      await replica.check();
      attempt?.guard();
      return result;
    } catch (error) {
      throw this.#failure(error, fields);
    }
  }
  relayPull(
    botId: string,
    input: z.infer<typeof syncPullInput>,
    trace: string,
    attempt?: SyncAttempt,
  ) {
    return this.pullObject(botId, input, trace, attempt, true);
  }
  async #transportExchange(
    receiverBinding: ReadyReplica["binding"],
    sharedBotId: string,
    peerDeviceId: string,
    relay: boolean,
    origin: string,
    path: string,
    value: unknown,
    fields: Context,
    maximum: number,
    authority?: string,
    signal?: AbortSignal,
  ) {
    if (!relay) return this.#exchange(origin, path, value, fields, maximum, authority, signal);
    if (!this.#relay) throw new Error("sync_unconfigured");
    const directory = await this.#relay.directory(sharedBotId, fields, signal);
    const holder = directory.holders.find((h) => h.identity.deviceId === peerDeviceId);
    if (!holder) throw new SyncRemoteError(503, "sync_relay_offline");
    return this.#relay.exchange(
      receiverBinding,
      sharedBotId,
      peerDeviceId,
      holder.generation,
      path.endsWith("challenge") ? "challenge" : "object",
      value,
      fields,
      signal,
    );
  }
  async #connect(
    replica: ReadyReplica,
    peerDeviceId: string,
    fields: Context,
    generation: string,
    attempt?: SyncAttempt,
    relay = false,
  ) {
    const { trace } = fields;
    const selected = await this.#device.access(
      {
        sharedBotId: replica.sharedBotId,
        peerDeviceId,
        purpose: "replica.read",
      },
      fields,
    );
    this.#live(generation);
    attempt?.guard();
    const endpoint = selected.endpoints?.candidates[0];
    let origin = "";
    if (!relay) {
      if (!endpoint) throw new SyncTransportError("sync_network_unreachable");
      origin = `http://${endpoint.address.includes(":") ? `[${endpoint.address}]` : endpoint.address}:${endpoint.port}`;
    }
    attempt?.connecting?.();
    const pair = ephemeral();
    const readerNonce = nonce();
    const challenge = challengeReply.parse(
      await this.#transportExchange(
        replica.binding,
        replica.sharedBotId,
        peerDeviceId,
        relay,
        origin,
        "/v1/sync/challenge",
        {
          version: 1,
          sharedBotId: replica.sharedBotId,
          readerDeviceId: selected.local.deviceId,
          readerNonce,
          readerEphemeral: pair.publicKey,
        },
        fields,
        MAX_SYNC_FRAME,
        undefined,
        AbortSignal.any([
          relay ? this.#relayAbort.signal : this.#directAbort.signal,
          ...(attempt ? [attempt.signal] : []),
        ]),
      ),
    );
    const server = challenge.proof;
    if (
      challenge.trace !== trace ||
      server.role !== "server" ||
      server.sharedBotId !== replica.sharedBotId ||
      server.readerNonce !== readerNonce ||
      server.readerEphemeral !== pair.publicKey ||
      !same(server.reader, selected.local) ||
      !same(server.server, selected.peer)
    )
      throw new Error("sync_challenge_mismatch");
    checkTime(server);
    verifyProof(server, challenge.signature);
    const proof: Proof = { ...server, role: "reader" };
    await this.#authorize(proof, fields);
    await replica.check();
    this.#use(proof, generation, attempt);
    if (!this.#device.proof) throw new Error("sync_unconfigured");
    const signature = (await this.#device.proof(proof, fields)).signature;
    verifyProof(proof, signature);
    await this.#authorize(proof, fields);
    await replica.check();
    this.#use(proof, generation, attempt);
    return { origin, pair, proof, signature };
  }
  async pull(
    botId: string,
    input: z.infer<typeof syncPullInput>,
    trace: string,
    attempt?: SyncAttempt,
    probe = false,
  ): Promise<unknown> {
    const fields = { trace, botId };
    const generation = this.#generation;
    this.#log.emit("info", "runtime", Events.start, fields);
    try {
      this.#live(generation);
      const replica = await this.#replica(botId, trace, attempt);
      const { origin, pair, proof, signature } = await this.#connect(
        replica,
        input.peerDeviceId,
        fields,
        generation,
        attempt,
      );
      const params = query.parse({ source: input.source, after: input.after, limit: input.limit });
      const response = z.strictObject({ box: z.unknown(), trace: z.literal(trace) }).parse(
        await this.#exchange(
          origin,
          "/v1/sync/page",
          {
            sessionId: proof.sessionId,
            signature,
            box: seal(proof, pair.privateKey, "reader", Buffer.from(JSON.stringify(params))),
          },
          fields,
          MAX_SYNC_FRAME,
          undefined,
          AbortSignal.any([this.#directAbort.signal, ...(attempt ? [attempt.signal] : [])]),
        ),
      );
      const page: unknown = JSON.parse(
        unseal(proof, pair.privateKey, "server", response.box).toString("utf8"),
      );
      await this.#authorize(proof, fields);
      await replica.check();
      this.#use(proof, generation, attempt);
      attempt?.authenticated?.();
      const applied = probe
        ? undefined
        : await replica.command("apply", { page }, () => {
            this.#use(proof, generation, attempt);
            attempt?.admit?.();
          });
      this.#log.emit("info", "runtime", Events.ok, fields);
      return { page, applied };
    } catch (error) {
      throw this.#failure(error, fields);
    }
  }
}
