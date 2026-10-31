import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  type ObjectCarrier,
  SyncDigest,
  SyncKeyDescriptor,
  SyncKeyEnvelope,
  SyncObjectCarrier,
  SyncObjectHeader,
  SyncObjectManifest,
} from "./core/DeviceSyncObjects.ts";
import { deviceSyncPeer } from "./core/DeviceSyncPort.ts";
import { pageSchema } from "./runtime/pi/syncProtocol.ts";
import { MAX_SYNC_PAGE } from "./sync-crypto.ts";

// Only controlled metadata is canonicalized. Page/SDK model/data bytes retain insertion order.
export const objectCanonical = (value: unknown): string => {
  if (value !== null && typeof value === "object" && !Array.isArray(value))
    return (
      "{" +
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ":" + objectCanonical(v))
        .join(",") +
      "}"
    );
  if (Array.isArray(value)) return "[" + value.map(objectCanonical).join(",") + "]";
  return JSON.stringify(value);
};
export const bytesDigest = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
export const metadataDigest = (value: unknown) => bytesDigest(objectCanonical(value));
const same = (a: unknown, b: unknown) => objectCanonical(a) === objectCanonical(b);
export const unsignedDescriptor = (descriptor: z.infer<typeof SyncKeyDescriptor>) => {
  const { signature: _signature, ...body } = descriptor;
  return body;
};
function signature(value: string, text: string, key: string) {
  if (
    !verify(
      null,
      Buffer.from(text),
      createPublicKey({ key: Buffer.from(key, "base64url"), type: "spki", format: "der" }),
      Buffer.from(value, "base64url"),
    )
  )
    throw new Error("sync_object_signature_invalid");
}
export function verifyDescriptor(
  input: unknown,
  peer: z.infer<typeof deviceSyncPeer>,
  origin: string,
) {
  const value = SyncKeyDescriptor.parse(input);
  if (
    value.registryOrigin !== origin ||
    value.deviceId !== peer.deviceId ||
    value.publicKey !== peer.publicKey ||
    value.credentialVersion !== peer.credentialVersion ||
    bytesDigest(Buffer.from(value.wrappingPublicKey, "base64url")) !== value.keyId
  )
    throw new Error("sync_object_descriptor_invalid");
  signature(
    value.signature,
    "eagle-bots-wrap-descriptor-v1\n" + objectCanonical(unsignedDescriptor(value)),
    peer.publicKey,
  );
  return value;
}
export function verifyManifest(input: unknown) {
  const value = SyncObjectManifest.parse(input);
  const { signature: signed, ...body } = value;
  if (
    !value.publisher.groupId ||
    value.objectId !==
      metadataDigest({
        version: 1,
        purpose: "replica.page",
        publisherDeviceId: value.publisher.deviceId,
        sharedBotId: value.sharedBotId,
        keyEpoch: value.keyEpoch,
        source: value.source,
        pageDigest: value.pageDigest,
      }) ||
    value.range.from > value.range.to + 1 ||
    value.nextAfter > value.range.to ||
    value.included.some(
      (event, i) =>
        event.seq < value.range.from ||
        event.seq > value.range.to ||
        (i > 0 && event.seq !== (value.included[i - 1]?.seq ?? 0) + 1),
    ) ||
    (value.included.length > 0 && value.included.at(-1)?.seq !== value.nextAfter)
  )
    throw new Error("sync_object_manifest_invalid");
  signature(
    signed,
    "eagle-bots-page-manifest-v1\n" + objectCanonical(body),
    value.publisher.publicKey,
  );
  return value;
}
export function verifyEnvelope(input: unknown, manifestInput: unknown) {
  const manifest = verifyManifest(manifestInput),
    value = SyncKeyEnvelope.parse(input);
  const { signature: signed, ...body } = value;
  if (
    value.registryOrigin !== manifest.registryOrigin ||
    !same(value.publisher, manifest.publisher) ||
    value.issuer.deviceId !== manifest.publisher.deviceId ||
    value.issuer.publicKey !== manifest.publisher.publicKey ||
    !value.issuer.groupId ||
    value.issuer.groupId !== value.recipient.groupId ||
    value.sharedBotId !== manifest.sharedBotId ||
    value.keyEpoch !== manifest.keyEpoch ||
    value.keyId !== manifest.keyId ||
    value.objectId !== manifest.objectId ||
    value.manifestDigest !== metadataDigest(manifest)
  )
    throw new Error("sync_object_envelope_invalid");
  verifyDescriptor(value.issuerDescriptor, value.issuer, value.registryOrigin);
  verifyDescriptor(value.recipientDescriptor, value.recipient, value.registryOrigin);
  signature(
    signed,
    "eagle-bots-key-envelope-signature-v1\n" + objectCanonical(body),
    value.issuer.publicKey,
  );
  return value;
}
export function verifyCarrier(input: unknown) {
  const value = SyncObjectCarrier.parse(input),
    manifest = verifyManifest(value.manifest);
  verifyDescriptor(value.descriptor, manifest.publisher, manifest.registryOrigin);
  verifyEnvelope(value.envelope, manifest);
  const cipher = Buffer.from(value.ciphertext, "base64url");
  if (
    cipher.length < 16 ||
    cipher.length > MAX_SYNC_PAGE + 16 ||
    cipher.toString("base64url") !== value.ciphertext ||
    bytesDigest(cipher) !== manifest.cipherDigest
  )
    throw new Error("sync_object_cipher_invalid");
  return value;
}
export function preparePage(
  input: unknown,
  publisher: z.infer<typeof deviceSyncPeer>,
  registryOrigin: string,
) {
  // Validate without replacing original nested JSON objects/order with a parsed copy.
  pageSchema.parse(input);
  const page = input as z.infer<typeof pageSchema>,
    bytes = Buffer.from(JSON.stringify(input));
  if (bytes.length > MAX_SYNC_PAGE) throw new Error("sync_page_too_large");
  const pageDigest = bytesDigest(bytes);
  const objectId = metadataDigest({
    version: 1,
    purpose: "replica.page",
    publisherDeviceId: publisher.deviceId,
    sharedBotId: page.sharedBotId,
    keyEpoch: 1,
    source: page.source,
    pageDigest,
  });
  return {
    objectId,
    encrypt: () => {
      const key = randomBytes(32);
      const header = SyncObjectHeader.parse({
        version: 1,
        purpose: "replica.page",
        registryOrigin,
        publisher,
        sharedBotId: page.sharedBotId,
        keyEpoch: 1,
        keyId: randomBytes(32).toString("hex"),
        objectId,
        source: page.source,
        range: page.range,
        included: page.events.map((event) => ({
          seq: event.seq,
          eventDigest: bytesDigest(JSON.stringify(event.body)),
        })),
        nextAfter: page.nextAfter,
        hasMore: page.hasMore,
        pageDigest,
        nonce: randomBytes(12).toString("base64url"),
      });
      const cipher = createCipheriv("aes-256-gcm", key, Buffer.from(header.nonce, "base64url"));
      cipher.setAAD(Buffer.from("eagle-bots-page-object-v1\n" + objectCanonical(header)));
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
      return {
        key,
        manifest: { ...header, cipherDigest: bytesDigest(ciphertext) },
        ciphertext: ciphertext.toString("base64url"),
      };
    },
  };
}

export function decodePage(carrierInput: unknown, key: Buffer) {
  const carrier = verifyCarrier(carrierInput),
    { signature: _signature, cipherDigest: _digest, ...header } = carrier.manifest;
  const cipher = Buffer.from(carrier.ciphertext, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(header.nonce, "base64url"));
  decipher.setAAD(Buffer.from("eagle-bots-page-object-v1\n" + objectCanonical(header)));
  decipher.setAuthTag(cipher.subarray(-16));
  const bytes = Buffer.concat([decipher.update(cipher.subarray(0, -16)), decipher.final()]);
  if (bytes.length > MAX_SYNC_PAGE || bytesDigest(bytes) !== header.pageDigest)
    throw new Error("sync_object_page_invalid");
  const page: unknown = JSON.parse(bytes.toString("utf8"));
  pageSchema.parse(page);
  const value = page as z.infer<typeof pageSchema>;
  if (
    JSON.stringify(value) !== bytes.toString("utf8") ||
    value.sharedBotId !== header.sharedBotId ||
    !same(value.source, header.source) ||
    !same(value.range, header.range) ||
    value.nextAfter !== header.nextAfter ||
    value.hasMore !== header.hasMore ||
    !same(
      value.events.map((event) => ({
        seq: event.seq,
        eventDigest: bytesDigest(JSON.stringify(event.body)),
      })),
      header.included,
    )
  )
    throw new Error("sync_object_page_invalid");
  return { page, bytes };
}
const binding = z.strictObject({
  localBotId: z.string().min(1).max(80),
  sharedBotId: z.uuid(),
  replicaId: z.uuid(),
  epoch: z.uuid(),
});
const pin = z.strictObject({
  publisher: deviceSyncPeer,
  issuer: deviceSyncPeer,
  recipient: deviceSyncPeer,
  manifestDigest: SyncDigest,
  envelopeDigest: SyncDigest,
  descriptorDigest: SyncDigest,
  cipherDigest: SyncDigest,
});
export const storedObject = z.strictObject({
  version: z.literal(1),
  kind: z.enum(["publisher", "recipient"]),
  botId: z.string().min(1).max(80),
  binding,
  carrier: SyncObjectCarrier,
  pin,
});
export type StoredObject = z.infer<typeof storedObject>;
export const acceptedPin = (carrier: ObjectCarrier) => ({
  publisher: carrier.manifest.publisher,
  issuer: carrier.envelope.issuer,
  recipient: carrier.envelope.recipient,
  manifestDigest: metadataDigest(carrier.manifest),
  envelopeDigest: metadataDigest(carrier.envelope),
  descriptorDigest: metadataDigest(carrier.descriptor),
  cipherDigest: carrier.manifest.cipherDigest,
});
function verifiedRecord(input: unknown): StoredObject {
  const value = storedObject.parse(input),
    carrier = verifyCarrier(value.carrier);
  if (
    value.binding.localBotId !== value.botId ||
    !same(value.pin, acceptedPin(carrier)) ||
    value.binding.sharedBotId !== carrier.manifest.sharedBotId ||
    (value.kind === "publisher" &&
      (!same(carrier.envelope.recipient, carrier.manifest.publisher) ||
        !same(carrier.envelope.issuer, carrier.manifest.publisher)))
  )
    throw new Error("sync_object_pin_invalid");
  return value;
}
function recordAt(objectId: string) {
  return (input: unknown) => {
    const value = verifiedRecord(input);
    if (value.carrier.manifest.objectId !== objectId) throw new Error("sync_object_id_invalid");
    return value;
  };
}
export const MAX_OBJECT_FRAME = Math.ceil(((MAX_SYNC_PAGE + 16) * 4) / 3) + 65536;

// Filesystem failures are classified here; signature, JSON and AEAD validation stay protocol failures.
export class SyncObjectStorageError extends Error {
  constructor(cause: unknown) {
    super("sync_object_storage_failed", { cause });
  }
}
function io<T>(action: () => T): T {
  try {
    return action();
  } catch (cause) {
    throw new SyncObjectStorageError(cause);
  }
}

/** Complete immutable records only: first winner survives concurrent writes and lost replies. */
export class SyncObjectStore {
  readonly #directory: string;
  constructor(root: string) {
    this.#directory = join(root, "sync-objects", "v1");
  }
  #prepareDirectory(): void {
    for (const dir of [join(this.#directory, ".."), this.#directory]) this.#privateDirectory(dir);
  }
  #syncDirectory(directory: string): void {
    const fd = io(() =>
      openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
    );
    try {
      io(() => fsyncSync(fd));
    } finally {
      io(() => closeSync(fd));
    }
  }
  #privateDirectory(dir: string): void {
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new SyncObjectStorageError(error);
    }
    const st = io(() => lstatSync(dir));
    if (
      !st.isDirectory() ||
      st.isSymbolicLink() ||
      st.uid !== process.getuid?.() ||
      (st.mode & 0o7777) !== 0o700
    )
      throw new SyncObjectStorageError(new Error("sync_object_storage_insecure"));
    this.#syncDirectory(join(dir, ".."));
  }
  #read<T>(path: string, decode: (value: unknown) => T): T | undefined {
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new SyncObjectStorageError(error);
    }
    try {
      const stat = io(() => fstatSync(fd));
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o7777) !== 0o600 ||
        stat.nlink < 1 ||
        stat.nlink > 2 ||
        stat.size <= 0 ||
        stat.size > MAX_OBJECT_FRAME
      )
        throw new SyncObjectStorageError(new Error("sync_object_storage_insecure"));
      const value = decode(JSON.parse(io(() => readFileSync(fd, "utf8"))));
      if (stat.nlink === 2) {
        const directory = dirname(path);
        const stages = io(() => readdirSync(directory))
          .filter((name) =>
            /^\.stage-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(name),
          )
          .filter((name) => {
            const stage = io(() => lstatSync(join(directory, name), { throwIfNoEntry: false }));
            return (
              stage?.isFile() &&
              stage.dev === stat.dev &&
              stage.ino === stat.ino &&
              stage.uid === stat.uid &&
              (stage.mode & 0o7777) === 0o600
            );
          });
        if (stages.length === 1) {
          try {
            unlinkSync(join(directory, stages[0] as string));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT")
              throw new SyncObjectStorageError(error);
          }
          this.#syncDirectory(directory);
        }
        if (io(() => fstatSync(fd)).nlink !== 1)
          throw new SyncObjectStorageError(new Error("sync_object_storage_insecure"));
      }
      return value;
    } finally {
      io(() => closeSync(fd));
    }
  }
  read(objectId: string): StoredObject | undefined {
    SyncDigest.parse(objectId);
    this.#prepareDirectory();
    this.#syncDirectory(this.#directory);
    return this.#read(join(this.#directory, objectId + ".json"), recordAt(objectId));
  }
  async stage(value: StoredObject) {
    const record = verifiedRecord(value);
    this.#prepareDirectory();
    return this.#stage(
      this.#directory,
      record.carrier.manifest.objectId + ".json",
      record,
      recordAt(record.carrier.manifest.objectId),
    );
  }
  #slot(
    issuer: z.infer<typeof deviceSyncPeer>,
    recipient: z.infer<typeof deviceSyncPeer>,
    issuerDescriptor: z.infer<typeof SyncKeyDescriptor>,
    recipientDescriptor: z.infer<typeof SyncKeyDescriptor>,
    manifest: z.infer<typeof SyncObjectManifest>,
  ) {
    verifyDescriptor(issuerDescriptor, issuer, manifest.registryOrigin);
    verifyDescriptor(recipientDescriptor, recipient, manifest.registryOrigin);
    return metadataDigest({
      issuer,
      recipient,
      issuerDescriptor: unsignedDescriptor(issuerDescriptor),
      recipientDescriptor: unsignedDescriptor(recipientDescriptor),
      objectId: manifest.objectId,
      manifestDigest: metadataDigest(manifest),
    });
  }
  recipient(
    record: StoredObject,
    issuer: z.infer<typeof deviceSyncPeer>,
    recipient: z.infer<typeof deviceSyncPeer>,
    issuerDescriptor: z.infer<typeof SyncKeyDescriptor>,
    recipientDescriptor: z.infer<typeof SyncKeyDescriptor>,
  ) {
    const manifest = verifyManifest(record.carrier.manifest),
      slot = this.#slot(issuer, recipient, issuerDescriptor, recipientDescriptor, manifest);
    this.#prepareDirectory();
    const directory = join(this.#directory, manifest.objectId + ".recipients");
    this.#privateDirectory(directory);
    const decode = (input: unknown) => {
      const envelope = verifyEnvelope(input, manifest);
      if (
        this.#slot(
          envelope.issuer,
          envelope.recipient,
          envelope.issuerDescriptor,
          envelope.recipientDescriptor,
          manifest,
        ) !== slot
      )
        throw new Error("sync_object_slot_invalid");
      return envelope;
    };
    return {
      read: () => this.#read(join(directory, slot + ".json"), decode),
      stage: (envelope: z.infer<typeof SyncKeyEnvelope>) =>
        this.#stage(directory, slot + ".json", decode(envelope), decode),
    };
  }
  async #stage<T>(directory: string, name: string, value: T, decode: (input: unknown) => T) {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > MAX_OBJECT_FRAME) throw new Error("sync_frame_too_large");
    const path = join(directory, ".stage-" + randomUUID()),
      destination = join(directory, name);
    const file = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    ).catch((cause) => {
      throw new SyncObjectStorageError(cause);
    });
    try {
      await file.writeFile(text);
      await file.sync();
      await file.close();
    } catch (cause) {
      try {
        await file.close();
      } catch {}
      try {
        unlinkSync(path);
      } catch {}
      throw new SyncObjectStorageError(cause);
    }
    let published = false;
    return {
      publish: () => {
        try {
          try {
            linkSync(path, destination);
            published = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST")
              throw new SyncObjectStorageError(error);
          }
          try {
            unlinkSync(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT")
              throw new SyncObjectStorageError(error);
          }
          this.#syncDirectory(directory);
        } finally {
          try {
            unlinkSync(path);
          } catch {}
        }
        return undefined;
      },
      complete: () => {
        if (published) return value;
        const winner = this.#read(destination, decode);
        if (winner === undefined)
          throw new SyncObjectStorageError(new Error("sync_object_publish_missing"));
        return winner;
      },
      discard: () => {
        try {
          unlinkSync(path);
        } catch {}
      },
      get published() {
        return published;
      },
    };
  }
}
