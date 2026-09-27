import { resolveAiConfig } from "@nocoo/next-ai/server";
import type { DailySettings } from "../shared/daily.ts";

const encoder = new TextEncoder();
export function aiEndpoint(settings: DailySettings): string {
  if (!settings.provider) return "";
  const config = resolveAiConfig({ ...settings, apiKey: "validation-only" });
  return `${config.provider}:${config.baseURL.replace(/\/$/, "")}:${config.sdkType}:${config.authType}`;
}
async function encryptionKey(secret: string | undefined) {
  if (!secret || secret.length < 32)
    throw new Error("AI credential encryption is not configured");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function sealAiKey(
  plain: string,
  secret: string | undefined,
  endpoint: string,
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encoder.encode(`eagle:ai:v1:${endpoint}`),
    },
    await encryptionKey(secret),
    encoder.encode(plain),
  );
  return {
    version: 1 as const,
    endpoint,
    data: Buffer.concat([iv, new Uint8Array(encrypted)]).toString("base64"),
  };
}
export async function unsealAiKey(
  value: Awaited<ReturnType<typeof sealAiKey>>,
  secret: string | undefined,
  endpoint: string,
) {
  if (value.endpoint !== endpoint)
    throw Object.assign(new Error("AI credential endpoint does not match"), {
      name: "AIEndpointMismatchError",
    });
  if (value.version !== 1) throw new Error("Unknown credential version");
  const data = Buffer.from(value.data, "base64");
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: data.subarray(0, 12),
      additionalData: encoder.encode(`eagle:ai:v1:${value.endpoint}`),
    },
    await encryptionKey(secret),
    data.subarray(12),
  );
  return new TextDecoder().decode(plain);
}
export async function withAiKey(
  env: Env,
  settings?: DailySettings,
): Promise<Env> {
  return {
    ...env,
    AI_API_KEY: await env.DIRECTORY.getByName("fleet").aiKey(settings),
  };
}
