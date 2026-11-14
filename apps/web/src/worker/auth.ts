import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import type { Registration } from "../../../../packages/contracts/src/connect.ts";
import type { Viewer } from "../../../../packages/contracts/src/schema.ts";

const encoder = new TextEncoder();
export async function equalSecret(a: string, b: string): Promise<boolean> {
  const hashes = await Promise.all(
    [a, b].map((s) => crypto.subtle.digest("SHA-256", encoder.encode(s))),
  );
  return timingSafeEqual(new Uint8Array(hashes[0]), new Uint8Array(hashes[1]));
}
export function bearer(request: Request) {
  return (
    request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/)?.[1] ?? ""
  );
}
export function agentTokens(env: Env): Record<string, string> {
  const parsed: unknown = JSON.parse(env.AGENT_TOKENS || "{}");
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Object.values(parsed).every((t) => typeof t === "string" && t.length >= 32)
  )
    throw new Error("Invalid authentication configuration");
  return parsed as Record<string, string>;
}
export async function agentIdentity(request: Request, env: Env) {
  const token = bearer(request);
  if (!token) return null;
  if (token.startsWith("eag1.")) {
    if (!env.AGENT_SIGNING_KEY || env.AGENT_SIGNING_KEY.length < 32)
      return null;
    try {
      const { payload } = await jwtVerify(
        token.slice(5),
        encoder.encode(env.AGENT_SIGNING_KEY),
        {
          issuer: "eagle",
          audience: "eagle-agent",
          algorithms: ["HS256"],
          requiredClaims: ["sub", "jti", "iat", "exp"],
        },
      );
      if (
        !payload.sub ||
        !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(payload.sub) ||
        typeof payload.jti !== "string"
      )
        return null;
      return {
        machineId: payload.sub,
        credentialId: payload.jti,
        expires: Number(payload.exp) * 1000,
      };
    } catch {
      return null;
    }
  }
  for (const [id, value] of Object.entries(agentTokens(env)))
    if (await equalSecret(token, value))
      return { machineId: id, credentialId: null };
  return null;
}
export async function issueToken(machine: Registration, env: Env) {
  if (
    !env.AGENT_SIGNING_KEY ||
    env.AGENT_SIGNING_KEY.length < 32 ||
    !machine.credentialId ||
    !machine.expiresAt
  )
    throw new Error("Missing signing configuration");
  return `eag1.${await new SignJWT()
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("eagle")
    .setAudience("eagle-agent")
    .setSubject(machine.id)
    .setJti(machine.credentialId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.parse(machine.expiresAt) / 1000))
    .sign(encoder.encode(env.AGENT_SIGNING_KEY))}`;
}
// Public key caches contain no user credentials and follow Access key rotation.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function viewerIdentity(
  request: Request,
  env: Env,
): Promise<Viewer | null> {
  const host = new URL(request.url).hostname;
  const devHosts = (env.DEV_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (
    env.LOCAL_DEV === "true" &&
    (["localhost", "127.0.0.1", "[::1]"].includes(host) ||
      devHosts.includes(host))
  )
    return {
      email: env.LOCAL_USER_EMAIL?.trim().toLowerCase() || "",
      name: "本地开发",
      avatar: null,
      local: true,
    };
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || !env.ACCESS_TEAM_URL || !env.ACCESS_AUD) return null;
  try {
    if (!keySets.has(env.ACCESS_TEAM_URL))
      keySets.set(
        env.ACCESS_TEAM_URL,
        createRemoteJWKSet(
          new URL(`${env.ACCESS_TEAM_URL}/cdn-cgi/access/certs`),
        ),
      );
    const keys = keySets.get(env.ACCESS_TEAM_URL);
    if (!keys) return null;
    const { payload } = await jwtVerify(token, keys, {
      issuer: env.ACCESS_TEAM_URL,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub"],
    });
    const email =
      typeof payload.email === "string"
        ? payload.email.trim().toLowerCase()
        : "";
    return {
      email,
      name: email.split("@")[0] || "Access 用户",
      avatar: null,
      local: false,
    };
  } catch {
    return null;
  }
}
export async function viewerAuthorized(request: Request, env: Env) {
  return (await viewerIdentity(request, env)) !== null;
}
