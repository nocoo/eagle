import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
  verify,
} from "node:crypto";
import { z } from "zod";
import { deviceSyncProof } from "./core/DeviceSyncPort.ts";

export const MAX_SYNC_PAGE = 8 * 1024 * 1024;
export const MAX_SYNC_FRAME = Math.ceil((MAX_SYNC_PAGE * 4) / 3) + 16384;
export type Proof = z.infer<typeof deviceSyncProof>;
const canonical = (value: unknown): string => {
  if (value !== null && typeof value === "object" && !Array.isArray(value))
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
};
export const proofPayload = (input: unknown): string =>
  "eagle-bots-sync-proof-v1\n" + canonical(deviceSyncProof.parse(input));
export const nonce = (): string => randomBytes(32).toString("base64url");
export const ephemeral = () => {
  const pair = generateKeyPairSync("x25519");
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("base64url"),
  };
};
export function verifyProof(proof: Proof, signature: string): void {
  const own = proof[proof.role];
  if (
    !/^[A-Za-z0-9_-]{86}$/.test(signature) ||
    !verify(
      null,
      Buffer.from(proofPayload(proof)),
      createPublicKey({
        key: Buffer.from(own.publicKey, "base64url"),
        format: "der",
        type: "spki",
      }),
      Buffer.from(signature, "base64url"),
    )
  )
    throw new Error("sync_signature_invalid");
}
export function checkTime(proof: Proof): void {
  if (proof.expiresAt <= Date.now() || proof.expiresAt > Date.now() + 60000)
    throw new Error("sync_proof_expired");
}
const boxSchema = z.strictObject({
  version: z.literal(1),
  sequence: z.literal(0),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  ciphertext: z
    .string()
    .max(Math.ceil((MAX_SYNC_PAGE * 4) / 3))
    .regex(/^[A-Za-z0-9_-]*$/),
  tag: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
});
type Direction = "reader" | "server";
function material(proof: Proof, privateKey: KeyObject, direction: Direction) {
  const ownRole = proof.role;
  const remote = proof[ownRole === "reader" ? "serverEphemeral" : "readerEphemeral"];
  const bytes = Buffer.from(remote, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== remote)
    throw new Error("sync_key_invalid");
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), bytes]),
    format: "der",
    type: "spki",
  });
  const shared = diffieHellman({ privateKey, publicKey: key });
  const text = proofPayload({ ...proof, role: "server" });
  const aad = Buffer.from(text + "\n" + direction + "\n0");
  return {
    key: Buffer.from(
      hkdfSync(
        "sha256",
        shared,
        createHash("sha256").update(text).digest(),
        createHash("sha256").update(aad).digest(),
        32,
      ),
    ),
    aad,
  };
}
export function seal(proof: Proof, privateKey: KeyObject, direction: Direction, plaintext: Buffer) {
  if (plaintext.length > MAX_SYNC_PAGE) throw new Error("sync_page_too_large");
  const { key, aad } = material(proof, privateKey, direction);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: 1,
    sequence: 0,
    nonce: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}
export function unseal(
  proof: Proof,
  privateKey: KeyObject,
  direction: Direction,
  input: unknown,
): Buffer {
  const box = boxSchema.parse(input);
  const { key, aad } = material(proof, privateKey, direction);
  const ciphertext = Buffer.from(box.ciphertext, "base64url");
  const tag = Buffer.from(box.tag, "base64url");
  if (
    ciphertext.length > MAX_SYNC_PAGE ||
    ciphertext.toString("base64url") !== box.ciphertext ||
    tag.toString("base64url") !== box.tag
  )
    throw new Error("sync_box_invalid");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(box.nonce, "base64url"));
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
