import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  canonicalDeviceJSON,
  DEVICE_PREFIX,
  type Device,
  type DeviceDirectory,
  DeviceId,
  DeviceProof,
  DeviceRegistration,
  deviceBase64,
  deviceDigest,
  PairingCode,
  PairingCreate,
  PairingRedeem,
  PolicySetRequest,
  verifyDeviceSignature,
} from "../../../../packages/contracts/src/devices.ts";
import type { DeviceServiceEnv } from "./device-service.ts";

export class DeviceHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const deviceJSON = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
export function deviceFailure(error: unknown): Response {
  if (error instanceof DeviceHttpError)
    return deviceJSON({ error: error.message }, error.status);
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return deviceJSON({ error: "invalid_request" }, 400);
  return deviceJSON({ error: "internal_error" }, 500);
}
export async function deviceBody(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new DeviceHttpError(415, "expected_json");
  const reader = request.body?.getReader();
  if (!reader) throw new DeviceHttpError(400, "missing_body");
  let content = "";
  let bytes = 0;
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > 524288) {
      await reader.cancel();
      throw new DeviceHttpError(413, "body_too_large");
    }
    content += decoder.decode(value, { stream: true });
  }
  content += decoder.decode();
  return JSON.parse(content);
}
type DeviceRow = {
  deviceId: string;
  publicKey: string;
  name: string;
  platform: string;
  arch: string;
  groupId: string | null;
  membershipEpoch: number;
  credentialVersion: number;
  localRevision: number;
};
type Challenge = {
  id: string;
  payload: string;
  registration: string;
  expires: number;
};
export type DeviceSessionReference = {
  sessionHash: string;
  deviceId: string;
  credentialVersion: number;
  expiresAt: number;
};
type ReferenceFailure = {
  ok: false;
  status: number;
  error: string;
  subject: "source" | "target" | "membership" | "internal";
};
const sessionReferenceSchema = z.strictObject({
  sessionHash: z.string().regex(/^[a-f0-9]{64}$/),
  deviceId: DeviceId,
  credentialVersion: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
});
function sessionFailure(error: unknown): {
  ok: false;
  status: number;
  error: string;
} {
  return {
    ok: false,
    status: error instanceof DeviceHttpError ? error.status : 401,
    error: error instanceof DeviceHttpError ? error.message : "invalid_session",
  };
}

function referenceFailure(
  error: unknown,
  subject: "source" | "target",
): ReferenceFailure {
  if (error instanceof DeviceHttpError || error instanceof z.ZodError)
    return { ...sessionFailure(error), subject };
  return {
    ok: false,
    status: 503,
    error: "device_authorization_unavailable",
    subject: "internal",
  };
}

type Pairing = {
  hash: string;
  issuer: string;
  epoch: number;
  expires: number;
  revoked: number;
  redeemer: string | null;
  result: string | null;
  committed: number | null;
};
export class DeviceRegistry extends DurableObject<DeviceServiceEnv> {
  constructor(ctx: DurableObjectState, env: DeviceServiceEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS devices(deviceId TEXT PRIMARY KEY,publicKey TEXT NOT NULL,name TEXT NOT NULL,platform TEXT NOT NULL,arch TEXT NOT NULL,groupId TEXT,membershipEpoch INTEGER NOT NULL DEFAULT 0,credentialVersion INTEGER NOT NULL DEFAULT 1,localRevision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS groups(groupId TEXT PRIMARY KEY,revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY,payload TEXT NOT NULL,registration TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,deviceId TEXT NOT NULL,version INTEGER NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS pairings(hash TEXT PRIMARY KEY,issuer TEXT NOT NULL,epoch INTEGER NOT NULL,expires INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,redeemer TEXT,result TEXT,committed INTEGER);
    CREATE TABLE IF NOT EXISTS pairing_results(deviceId TEXT NOT NULL,requestId TEXT NOT NULL,hash TEXT NOT NULL,result TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(deviceId,requestId));
    CREATE TABLE IF NOT EXISTS rates(key TEXT PRIMARY KEY,count INTEGER NOT NULL,until INTEGER NOT NULL);
  `);
    for (const [table, column, definition] of [
      ["devices", "localRevision", "INTEGER NOT NULL DEFAULT 0"],
      ["pairings", "committed", "INTEGER"],
    ]) {
      if (
        !ctx.storage.sql
          .exec(`PRAGMA table_info(${table})`)
          .toArray()
          .some((row) => row.name === column)
      )
        ctx.storage.sql.exec(
          `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`,
        );
    }
  }
  private one<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...values: SqlStorageValue[]
  ): T | undefined {
    return this.ctx.storage.sql.exec<T>(query, ...values).toArray()[0];
  }
  private device(id: string): DeviceRow {
    const row = this.one<DeviceRow>(
      "SELECT * FROM devices WHERE deviceId=?",
      id,
    );
    if (!row) throw new DeviceHttpError(401, "unknown_device");
    return row;
  }
  private limit(key: string, max: number): void {
    const now = Date.now();
    const previous = this.one<{ count: number; until: number }>(
      "SELECT count,until FROM rates WHERE key=?",
      key,
    );
    if (previous && previous.until > now && previous.count >= max)
      throw new DeviceHttpError(429, "rate_limited");
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO rates VALUES(?,?,?)",
      key,
      previous && previous.until > now ? previous.count + 1 : 1,
      previous && previous.until > now ? previous.until : now + 60000,
    );
  }
  async authenticate(token: string): Promise<Device> {
    if (token.length > 200) throw new DeviceHttpError(401, "invalid_session");
    return this.sessionDevice(await deviceDigest(token));
  }
  private sessionRecord(hash: string): {
    device: DeviceRow;
    expiresAt: number;
  } {
    const session = this.one<{
      deviceId: string;
      version: number;
      expires: number;
    }>("SELECT deviceId,version,expires FROM sessions WHERE hash=?", hash);
    if (!session || session.expires <= Date.now())
      throw new DeviceHttpError(401, "invalid_session");
    const device = this.device(session.deviceId);
    if (device.credentialVersion !== session.version)
      throw new DeviceHttpError(401, "revoked_session");
    return { device, expiresAt: session.expires };
  }
  private sessionDevice(hash: string): DeviceRow {
    return this.sessionRecord(hash).device;
  }
  protected sessionDigest(token: string): Promise<string> {
    return deviceDigest(token);
  }
  private sessionReference(reference: DeviceSessionReference): DeviceRow {
    const value = sessionReferenceSchema.parse(reference);
    const session = this.sessionRecord(value.sessionHash);
    if (
      session.device.deviceId !== value.deviceId ||
      session.device.credentialVersion !== value.credentialVersion ||
      session.expiresAt !== value.expiresAt
    )
      throw new DeviceHttpError(401, "invalid_session");
    return session.device;
  }
  async bindTargetSession(
    token: string,
    targetId: string,
    previous?: DeviceSessionReference,
  ): Promise<
    | { ok: true; reference: DeviceSessionReference }
    | { ok: false; status: number; error: string }
  > {
    try {
      if (typeof token !== "string" || token.length === 0 || token.length > 200)
        throw new DeviceHttpError(401, "invalid_session");
      const target = DeviceId.parse(targetId);
      const hash = await this.sessionDigest(token);
      const current = this.sessionRecord(hash);
      if (current.device.deviceId !== target)
        throw new DeviceHttpError(401, "invalid_session");
      if (previous !== undefined) {
        const old = this.sessionReference(previous);
        if (
          old.deviceId !== target ||
          old.credentialVersion !== current.device.credentialVersion
        )
          throw new DeviceHttpError(401, "invalid_session");
      }
      return {
        ok: true,
        reference: {
          sessionHash: hash,
          deviceId: target,
          credentialVersion: current.device.credentialVersion,
          expiresAt: current.expiresAt,
        },
      };
    } catch (error) {
      const failure = referenceFailure(error, "target");
      return { ok: false, status: failure.status, error: failure.error };
    }
  }
  async checkSessionReference(
    reference: DeviceSessionReference,
    sourceToken?: string,
  ): Promise<{ ok: true; source: Device; target: Device } | ReferenceFailure> {
    if (
      sourceToken !== undefined &&
      (typeof sourceToken !== "string" ||
        sourceToken.length === 0 ||
        sourceToken.length > 200)
    )
      return {
        ok: false,
        status: 401,
        error: "invalid_session",
        subject: "source",
      };
    let sourceHash: string | undefined;
    try {
      sourceHash =
        sourceToken === undefined
          ? undefined
          : await this.sessionDigest(sourceToken);
    } catch (error) {
      return referenceFailure(error, "source");
    }
    let target: DeviceRow;
    try {
      target = this.sessionReference(reference);
    } catch (error) {
      return referenceFailure(error, "target");
    }
    let source: DeviceRow;
    try {
      source =
        sourceHash === undefined ? target : this.sessionDevice(sourceHash);
    } catch (error) {
      return referenceFailure(error, "source");
    }
    if (
      source.deviceId !== target.deviceId &&
      (!source.groupId || source.groupId !== target.groupId)
    )
      return {
        ok: false,
        status: 403,
        error: "different_group",
        subject: "membership",
      };
    return { ok: true, source, target };
  }
  private sweep(): void {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "DELETE FROM pairing_results WHERE created<=?",
      now - 604800000,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM pairings WHERE (redeemer IS NULL AND expires<=?) OR (redeemer IS NOT NULL AND (committed IS NULL OR committed<=?))",
      now,
      now - 604800000,
    );
    this.ctx.storage.sql.exec("DELETE FROM rates WHERE until<=?", now);
    this.ctx.storage.sql.exec("DELETE FROM sessions WHERE expires<=?", now);
    this.ctx.storage.sql.exec("DELETE FROM challenges WHERE expires<=?", now);
  }
  async authorize(
    token: string,
    targetId: string,
  ): Promise<{ source: Device; target: Device }> {
    const source = await this.authenticate(token);
    const target = this.device(targetId);
    if (
      source.deviceId !== target.deviceId &&
      (!source.groupId || source.groupId !== target.groupId)
    )
      throw new DeviceHttpError(403, "different_group");
    return { source, target };
  }
  async check(
    token: string,
    targetId?: string,
  ): Promise<
    | { ok: true; source: Device; target: Device }
    | { ok: false; status: number; error: string }
  > {
    try {
      const source = await this.authenticate(token);
      if (!targetId) return { ok: true, source, target: source };
      return { ok: true, ...(await this.authorize(token, targetId)) };
    } catch (error) {
      return sessionFailure(error);
    }
  }
  private async observedDirectory(id: string): Promise<DeviceDirectory> {
    const directory = this.directory(id);
    if (this.env.DEVICE_EXECUTION)
      directory.devices = await Promise.all(
        directory.devices.map(async (device) => {
          try {
            return {
              ...device,
              ...(await this.env.DEVICE_EXECUTION.getByName(
                device.deviceId,
              ).observation()),
            };
          } catch {
            return device;
          }
        }),
      );
    directory.observationRevision = await deviceDigest(
      canonicalDeviceJSON(
        directory.devices.map(
          ({ deviceId, online, lastSeenAt, capabilities, policy }) => ({
            deviceId,
            online,
            lastSeenAt,
            capabilities,
            policy,
          }),
        ),
      ),
    );
    return directory;
  }
  directory(id: string): DeviceDirectory {
    const self = this.device(id);
    const devices = self.groupId
      ? this.ctx.storage.sql
          .exec<DeviceRow>(
            "SELECT * FROM devices WHERE groupId=? ORDER BY deviceId",
            self.groupId,
          )
          .toArray()
      : [self];
    const revision = self.groupId
      ? (this.one<{ revision: number }>(
          "SELECT revision FROM groups WHERE groupId=?",
          self.groupId,
        )?.revision ?? 0)
      : self.localRevision;
    return {
      localDeviceId: id,
      groupId: self.groupId,
      revision,
      observationRevision: "unknown",
      devices: devices.map(({ localRevision: _revision, ...device }) => ({
        ...device,
        online: null,
        lastSeenAt: null,
        capabilities: null,
        policy: null,
      })),
    };
  }
  private result(id: string, result: string): unknown {
    return { ...JSON.parse(result), directory: this.directory(id) };
  }
  async fetch(request: Request): Promise<Response> {
    try {
      return await this.route(request);
    } catch (error) {
      return deviceFailure(error);
    }
  }
  private async route(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname.slice(DEVICE_PREFIX.length);
    const post = request.method === "POST";
    if (path === "/register/challenge" && post) {
      const input = DeviceRegistration.parse(await deviceBody(request));
      try {
        await crypto.subtle.importKey(
          "spki",
          Uint8Array.from(
            atob(input.publicKey.replaceAll("-", "+").replaceAll("_", "/")),
            (c) => c.charCodeAt(0),
          ),
          { name: "Ed25519" },
          false,
          ["verify"],
        );
      } catch {
        throw new DeviceHttpError(400, "invalid_public_key");
      }
      this.limit(
        `registration:${request.headers.get("CF-Connecting-IP") ?? "local"}`,
        120,
      );
      const existing = this.one<DeviceRow>(
        "SELECT * FROM devices WHERE deviceId=?",
        input.deviceId,
      );
      if (existing && existing.publicKey !== input.publicKey)
        throw new DeviceHttpError(409, "identity_conflict");
      if (
        !existing &&
        (this.one<{ count: number }>("SELECT count(*) AS count FROM devices")
          ?.count ?? 0) >= 10000
      )
        throw new DeviceHttpError(429, "device_quota");
      this.ctx.storage.sql.exec(
        "DELETE FROM challenges WHERE expires<=?",
        Date.now(),
      );
      const challengeId = crypto.randomUUID();
      const expiresAt = Date.now() + 60000;
      const payload = `eagle-device-register-v1\n${new URL(request.url).origin}\n${input.deviceId}\n${input.publicKey}\n${challengeId}\n${deviceBase64(crypto.getRandomValues(new Uint8Array(32)))}\n${expiresAt}`;
      this.ctx.storage.sql.exec(
        "INSERT INTO challenges VALUES(?,?,?,?)",
        challengeId,
        payload,
        JSON.stringify(input),
        expiresAt,
      );
      return deviceJSON({ challengeId, payload, expiresAt });
    }
    if (path === "/register/complete" && post) {
      const input = DeviceProof.parse(await deviceBody(request));
      const challenge = this.one<Challenge>(
        "SELECT * FROM challenges WHERE id=?",
        input.challengeId,
      );
      if (!challenge || challenge.expires <= Date.now())
        throw new DeviceHttpError(401, "invalid_challenge");
      const registration = DeviceRegistration.parse(
        JSON.parse(challenge.registration),
      );
      if (
        !(await verifyDeviceSignature(
          registration.publicKey,
          challenge.payload,
          input.signature,
        ))
      )
        throw new DeviceHttpError(401, "invalid_proof");
      const sessionToken = deviceBase64(
        crypto.getRandomValues(new Uint8Array(32)),
      );
      const hash = await deviceDigest(sessionToken);
      const expiresAt = Date.now() + 900000;
      const device = this.ctx.storage.transactionSync(() => {
        const active = this.one<Challenge>(
          "SELECT * FROM challenges WHERE id=?",
          input.challengeId,
        );
        if (!active || active.expires <= Date.now())
          throw new DeviceHttpError(401, "invalid_challenge");
        const previous = this.one<DeviceRow>(
          "SELECT * FROM devices WHERE deviceId=?",
          registration.deviceId,
        );
        if (previous && previous.publicKey !== registration.publicKey)
          throw new DeviceHttpError(409, "identity_conflict");
        if (
          !previous &&
          (this.one<{ count: number }>("SELECT count(*) AS count FROM devices")
            ?.count ?? 0) >= 10000
        )
          throw new DeviceHttpError(429, "device_quota");
        this.ctx.storage.sql.exec(
          "INSERT INTO devices(deviceId,publicKey,name,platform,arch) VALUES(?,?,?,?,?) ON CONFLICT(deviceId) DO UPDATE SET name=excluded.name,platform=excluded.platform,arch=excluded.arch",
          registration.deviceId,
          registration.publicKey,
          registration.name,
          registration.platform,
          registration.arch,
        );
        if (
          previous &&
          (previous.name !== registration.name ||
            previous.platform !== registration.platform ||
            previous.arch !== registration.arch)
        ) {
          this.ctx.storage.sql.exec(
            "UPDATE devices SET localRevision=localRevision+1 WHERE deviceId=?",
            registration.deviceId,
          );
          if (previous.groupId)
            this.ctx.storage.sql.exec(
              "UPDATE groups SET revision=revision+1 WHERE groupId=?",
              previous.groupId,
            );
        }
        this.ctx.storage.sql.exec(
          "DELETE FROM challenges WHERE id=?",
          input.challengeId,
        );
        const device = this.device(registration.deviceId);
        this.ctx.storage.sql.exec(
          "DELETE FROM sessions WHERE expires<=?",
          Date.now(),
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO sessions VALUES(?,?,?,?)",
          hash,
          device.deviceId,
          device.credentialVersion,
          expiresAt,
        );
        return device;
      });
      const { localRevision: _revision, ...identity } = device;
      return deviceJSON({ device: identity, sessionToken, expiresAt });
    }
    const token = request.headers
      .get("authorization")
      ?.match(/^Bearer (.+)$/)?.[1];
    if (!token) throw new DeviceHttpError(401, "session_required");
    if (token.length > 200) throw new DeviceHttpError(401, "invalid_session");
    const sessionHash = await deviceDigest(token);
    const self = this.sessionDevice(sessionHash);
    if (path === "/policy" && post) {
      const input = PolicySetRequest.parse(await deviceBody(request));
      if (!this.env.DEVICE_EXECUTION)
        throw new DeviceHttpError(503, "device_service_unavailable");
      const result = await this.env.DEVICE_EXECUTION.getByName(
        input.deviceId,
      ).setPolicy(token, input);
      return "policy" in result
        ? deviceJSON(result.policy)
        : deviceJSON({ error: result.error }, result.status);
    }
    const write = <T>(action: (current: DeviceRow) => T): T =>
      this.ctx.storage.transactionSync(() => {
        const current = this.sessionDevice(sessionHash);
        this.sweep();
        return action(current);
      });
    if (path === "/directory" && request.method === "GET") {
      const directory = await this.observedDirectory(self.deviceId);
      const current = this.sessionDevice(sessionHash);
      if (current.membershipEpoch !== self.membershipEpoch)
        throw new DeviceHttpError(409, "directory_changed_retry");
      return deviceJSON(directory);
    }
    if (path === "/pairings" && post) {
      const { ttlSeconds } = PairingCreate.parse(await deviceBody(request));
      const code = deviceBase64(crypto.getRandomValues(new Uint8Array(32)));
      const hash = await deviceDigest(code);
      const expiresAt = Date.now() + ttlSeconds * 1000;
      write((current) => {
        this.limit(`invite:${current.deviceId}`, 20);
        this.ctx.storage.sql.exec(
          "INSERT INTO pairings(hash,issuer,epoch,expires) VALUES(?,?,?,?)",
          hash,
          self.deviceId,
          current.membershipEpoch,
          expiresAt,
        );
      });
      return deviceJSON({ code, expiresAt });
    }
    if (path === "/pairings/revoke" && post) {
      const { code } = z
        .strictObject({ code: PairingCode })
        .parse(await deviceBody(request));
      const hash = await deviceDigest(code);
      write(() => {
        const pairing = this.one<Pairing>(
          "SELECT * FROM pairings WHERE hash=?",
          hash,
        );
        if (!pairing || pairing.issuer !== self.deviceId)
          throw new DeviceHttpError(404, "pairing_not_found");
        this.ctx.storage.sql.exec(
          "UPDATE pairings SET revoked=1 WHERE hash=?",
          hash,
        );
      });
      return deviceJSON({ revoked: true });
    }
    if (path === "/pairings/redeem" && post) {
      const { requestId, code } = PairingRedeem.parse(
        await deviceBody(request),
      );
      const hash = await deviceDigest(code);
      // Authentication and rate accounting commit independently of business
      // rollback, so invalid/consumed codes cannot bypass the attempt budget.
      write(() => this.limit(`redeem:${self.deviceId}`, 30));
      const result = write(() => {
        const previous = this.one<{ hash: string; result: string }>(
          "SELECT hash,result FROM pairing_results WHERE deviceId=? AND requestId=?",
          self.deviceId,
          requestId,
        );
        if (previous) {
          if (previous.hash !== hash)
            throw new DeviceHttpError(409, "request_conflict");
          return previous.result;
        }
        const pairing = this.one<Pairing>(
          "SELECT * FROM pairings WHERE hash=?",
          hash,
        );
        if (!pairing) throw new DeviceHttpError(410, "pairing_unavailable");
        if (pairing.redeemer) {
          if (pairing.redeemer !== self.deviceId || !pairing.result)
            throw new DeviceHttpError(409, "pairing_consumed");
          if (!pairing.committed || pairing.committed <= Date.now() - 604800000)
            throw new DeviceHttpError(410, "pairing_result_expired");
          const recovered = JSON.stringify({
            ...JSON.parse(pairing.result),
            requestId,
          });
          this.ctx.storage.sql.exec(
            "INSERT INTO pairing_results VALUES(?,?,?,?,?)",
            self.deviceId,
            requestId,
            hash,
            recovered,
            pairing.committed,
          );
          return recovered;
        }
        const issuer = this.device(pairing.issuer);
        const redeemer = this.device(self.deviceId);
        if (
          pairing.revoked ||
          pairing.expires <= Date.now() ||
          issuer.membershipEpoch !== pairing.epoch
        )
          throw new DeviceHttpError(410, "pairing_unavailable");
        if (issuer.deviceId === redeemer.deviceId)
          throw new DeviceHttpError(400, "self_pairing");
        if (
          issuer.groupId &&
          redeemer.groupId &&
          issuer.groupId !== redeemer.groupId
        )
          throw new DeviceHttpError(409, "group_conflict");
        const groupId =
          issuer.groupId ?? redeemer.groupId ?? crypto.randomUUID();
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO groups VALUES(?,0)",
          groupId,
        );
        let changed = false;
        for (const device of [issuer, redeemer])
          if (device.groupId !== groupId) {
            this.ctx.storage.sql.exec(
              "UPDATE devices SET groupId=?,membershipEpoch=membershipEpoch+1,localRevision=localRevision+1 WHERE deviceId=?",
              groupId,
              device.deviceId,
            );
            changed = true;
          }
        if (changed)
          this.ctx.storage.sql.exec(
            "UPDATE groups SET revision=revision+1 WHERE groupId=?",
            groupId,
          );
        const committed = Date.now();
        const result = JSON.stringify({ requestId, groupId });
        this.ctx.storage.sql.exec(
          "UPDATE pairings SET redeemer=?,result=?,committed=? WHERE hash=?",
          self.deviceId,
          result,
          committed,
          hash,
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO pairing_results VALUES(?,?,?,?,?)",
          self.deviceId,
          requestId,
          hash,
          result,
          committed,
        );
        return result;
      });
      return deviceJSON(this.result(self.deviceId, result));
    }
    if (path.startsWith("/pairings/results/") && request.method === "GET") {
      const requestId = DeviceId.parse(path.slice("/pairings/results/".length));
      const result = this.one<{ result: string; created: number }>(
        "SELECT result,created FROM pairing_results WHERE deviceId=? AND requestId=?",
        self.deviceId,
        requestId,
      );
      if (!result || result.created <= Date.now() - 604800000)
        throw new DeviceHttpError(404, "result_not_found");
      return deviceJSON(this.result(self.deviceId, result.result));
    }
    if (path === "/members/remove" && post) {
      const { deviceId } = z
        .strictObject({ deviceId: DeviceId })
        .parse(await deviceBody(request));
      write((source) => {
        const target = this.device(deviceId);
        if (!source.groupId || source.groupId !== target.groupId)
          throw new DeviceHttpError(403, "different_group");
        this.ctx.storage.sql.exec(
          "UPDATE groups SET revision=revision+1 WHERE groupId=?",
          target.groupId,
        );
        this.ctx.storage.sql.exec(
          "UPDATE devices SET groupId=NULL,membershipEpoch=membershipEpoch+1,credentialVersion=credentialVersion+1,localRevision=localRevision+1 WHERE deviceId=?",
          deviceId,
        );
      });
      return deviceJSON(await this.observedDirectory(self.deviceId));
    }
    throw new DeviceHttpError(404, "not_found");
  }
}
