import { decodeJwt } from "jose";
import pkg from "../../../../package.json" with { type: "json" };
import {
  MachineInput,
  MachineName,
} from "../../../../packages/contracts/src/connect.ts";
import {
  MachineGroupInput,
  type MachineGroupState,
} from "../../../../packages/contracts/src/machine-groups.ts";
import {
  HeartbeatSchema,
  ReportSchema,
} from "../../../../packages/contracts/src/schema.ts";
import {
  agentIdentity,
  agentTokens,
  issueToken,
  viewerIdentity,
} from "./auth.ts";

export { MachineDirectory } from "./directory.ts";
export { MachineState } from "./machine.ts";

import { withProfile } from "./profile.ts";

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const json = (data: unknown, status = 200, extra: HeadersInit = {}) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extra,
    },
  });
async function body(request: Request) {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new HttpError(415, "Expected application/json");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "Missing JSON body");
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 1_048_576) {
      await reader.cancel();
      throw new HttpError(413, "Report exceeds 1 MiB");
    }
    chunks.push(value);
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function timely(value: string) {
  if (Date.parse(value) > Date.now() + 300_000)
    throw new HttpError(400, "Timestamp too far in future");
}
async function ingest(
  request: Request,
  env: Env,
  machineId: string,
  credentialId: string | null,
) {
  const parsed = ReportSchema.safeParse(await body(request));
  if (!parsed.success) throw new HttpError(400, "Invalid v1 report");
  const report = parsed.data;
  if (report.machine.id !== machineId)
    throw new HttpError(403, "Token does not authorize this machine");
  timely(report.capturedAt);
  const telemetry = report.machine.telemetry;
  if (telemetry) {
    for (const at of [
      telemetry.observedAt,
      telemetry.diskObservedAt,
      telemetry.temperature?.observedAt,
      telemetry.network?.observedAt,
      telemetry.vpn?.observedAt,
      telemetry.hardware?.observedAt,
      telemetry.traffic?.observedAt,
    ])
      if (at) timely(at);
    if (
      [
        telemetry.diskObservedAt,
        telemetry.temperature?.observedAt,
        telemetry.network?.observedAt,
        telemetry.vpn?.observedAt,
        telemetry.hardware?.observedAt,
        telemetry.traffic?.observedAt,
      ].some((at) => at && at > telemetry.observedAt)
    )
      throw new HttpError(400, "Resource timestamp exceeds sample time");
  }
  const payload = canonical(report);
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  const result = await env.MACHINES.getByName(machineId).ingest(
    report,
    digest,
    credentialId,
  );
  if ("unauthorized" in result) throw new HttpError(401, "Invalid agent token");
  if ("conflict" in result)
    throw new HttpError(409, "reportId already used for different content");
  return json(result, result.duplicate ? 200 : 201);
}
async function fleetIds(env: Env) {
  const directory = env.DIRECTORY.getByName("fleet");
  const deleted = new Set(await directory.deletedIds());
  const ids = [
    ...new Set([...Object.keys(agentTokens(env)), ...(await directory.ids())]),
  ]
    .filter((id) => !deleted.has(id))
    .sort();
  return { directory, ids };
}
async function registrations(env: Env) {
  const { ids } = await fleetIds(env);
  const machines = await Promise.all(
    ids.map((id) => env.MACHINES.getByName(id).registration(id)),
  );
  return machines.filter((m) => m !== null);
}
async function machineGroupState(
  env: Env,
  ids: string[],
): Promise<MachineGroupState> {
  return env.DIRECTORY.getByName("fleet").machineGroups(ids);
}
function _positive(
  value: string | null,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
) {
  if (value === null) return fallback;
  if (
    !/^\d+$/.test(value) ||
    Number(value) < 1 ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) > max
  )
    throw new HttpError(400, "Invalid pagination parameter");
  return Number(value);
}
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/api/v1/realtime" || path === "/api/v1/realtime-agent") {
    if (
      request.method !== "GET" ||
      request.headers.get("upgrade")?.toLowerCase() !== "websocket"
    )
      throw new HttpError(426, "WebSocket required");
    const expires = Date.now() + 15 * 60000;
    if (path.endsWith("-agent")) {
      if (url.search) throw new HttpError(400, "Unexpected query");
      const identity = await agentIdentity(request, env);
      if (!identity) throw new HttpError(401, "Invalid agent token");
      if (request.headers.get("X-Eagle-Machine") !== identity.machineId)
        throw new HttpError(403, "Machine identity mismatch");
      return env.MACHINES.getByName(identity.machineId).fetch(
        new Request("https://internal/realtime", {
          headers: {
            Upgrade: "websocket",
            "x-live-role": "agent",
            "x-live-format":
              request.headers.get("X-Eagle-Realtime-Format") ===
              "styled-text-v1"
                ? "styled-text-v1"
                : "text",
            "x-live-expires": String(
              Math.min(expires, identity.expires ?? expires),
            ),
            ...(identity.credentialId
              ? { "x-live-credential": identity.credentialId }
              : {}),
          },
        }),
      );
    }
    const viewer = await viewerIdentity(request, env);
    if (!viewer) throw new HttpError(401, "Sign in required");
    if (request.headers.get("origin") !== url.origin)
      throw new HttpError(403, "Origin not allowed");
    const machine = url.searchParams.get("machine");
    const space = url.searchParams.get("space");
    const format = url.searchParams.get("format");
    if (
      !machine ||
      !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(machine) ||
      !space ||
      space.length > 160 ||
      (format !== null && format !== "styled-text-v1") ||
      [...url.searchParams.keys()].some(
        (k) => !["machine", "space", "format"].includes(k),
      )
    )
      throw new HttpError(400, "Invalid subscription");
    const expiry = viewer.local
      ? expires
      : Number(
          decodeJwt(request.headers.get("cf-access-jwt-assertion") ?? "").exp,
        ) * 1000;
    return env.MACHINES.getByName(machine).fetch(
      new Request("https://internal/realtime", {
        headers: {
          Upgrade: "websocket",
          "x-live-role": "viewer",
          "x-live-expires": String(Math.min(expires, expiry)),
          "x-live-space": space,
          "x-live-format": format ?? "text",
        },
      }),
    );
  }
  if (
    request.method !== "GET" &&
    request.headers.has("origin") &&
    request.headers.get("origin") !== url.origin
  )
    throw new HttpError(403, "Origin not allowed");
  if (path === "/api/live" && request.method === "GET") {
    return json({
      status: "ok",
      service: "eagle",
      version: pkg.version,
      schemaVersion: 1,
      revision: env.BUILD_REVISION,
      stateStore: "durable-objects",
      historyWrites: false,
      // The macOS app ships on its own cadence, so it asks which app version is published.
      ...(env.MACOS_VERSION === undefined
        ? {}
        : {
            macos: {
              latest: env.MACOS_VERSION,
              ...(env.MACOS_RELEASE_URL === undefined
                ? {}
                : { releaseUrl: env.MACOS_RELEASE_URL }),
            },
          }),
    });
  }
  if (path === "/api/v1/reports" || path === "/api/v1/heartbeat") {
    if (request.method !== "POST")
      throw new HttpError(405, "Method not allowed");
    const identity = await agentIdentity(request, env);
    if (!identity) throw new HttpError(401, "Invalid agent token");
    if (path.endsWith("reports"))
      return ingest(request, env, identity.machineId, identity.credentialId);
    const parsed = HeartbeatSchema.safeParse(await body(request));
    if (!parsed.success) throw new HttpError(400, "Invalid v1 heartbeat");
    if (parsed.data.machineId !== identity.machineId)
      throw new HttpError(403, "Token does not authorize this machine");
    timely(parsed.data.sentAt);
    const alive = await env.MACHINES.getByName(identity.machineId).heartbeat(
      parsed.data.warning,
      identity.credentialId,
    );
    if (typeof alive === "object")
      throw new HttpError(401, "Invalid agent token");
    if (!alive) throw new HttpError(409, "Upload initial report first");
    return json({ alive: true });
  }
  const viewer = await viewerIdentity(request, env);
  if (!viewer) throw new HttpError(401, "Sign in required");
  if (path === "/api/v1/machines" && request.method === "GET") {
    const { ids } = await fleetIds(env);
    return json({
      machines: await registrations(env),
      canIssue: !!env.AGENT_SIGNING_KEY && env.AGENT_SIGNING_KEY.length >= 32,
      machineGroups: await machineGroupState(env, ids),
    });
  }
  if (path === "/api/v1/machines" && request.method === "POST") {
    if (!env.AGENT_SIGNING_KEY || env.AGENT_SIGNING_KEY.length < 32)
      throw new HttpError(503, "Token signing is not configured");
    const parsed = MachineInput.safeParse(await body(request));
    if (!parsed.success) throw new HttpError(400, "Invalid machine name or ID");
    const { id, name, watchPorts } = parsed.data;
    if (!(await env.DIRECTORY.getByName("fleet").add(id)))
      throw new HttpError(409, "Machine limit reached");
    const machine = await env.MACHINES.getByName(id).configure(
      id,
      "create",
      name,
      watchPorts,
    );
    if (!machine) throw new HttpError(409, "Machine already exists");
    return json({ machine, token: await issueToken(machine, env) }, 201);
  }
  const management = path.match(
    /^\/api\/v1\/machines\/([a-z0-9][a-z0-9_-]{0,79})\/(rotate|revoke|rename|delete)$/,
  );
  if (management && request.method === "POST") {
    const [, id, operation] = management;
    const action = operation as "rotate" | "revoke" | "rename" | "delete";
    if (action === "delete") {
      const registration = await env.MACHINES.getByName(id).registration(id);
      if (!registration || registration.enabled)
        throw new HttpError(400, "Only disabled machines can be deleted");
      if (!(await env.MACHINES.getByName(id).forget()))
        throw new HttpError(404, "Machine not found");
      const directory = env.DIRECTORY.getByName("fleet");
      await directory.remove(id);
      await directory.markDeleted(id);
      return json({ deleted: true });
    }
    if (
      action === "rotate" &&
      (!env.AGENT_SIGNING_KEY || env.AGENT_SIGNING_KEY.length < 32)
    )
      throw new HttpError(503, "Token signing is not configured");
    const input = await body(request);
    const parsed = MachineName.safeParse(input);
    if (action === "rename" && !parsed.success)
      throw new HttpError(400, "Invalid machine name");
    if (!(await env.MACHINES.getByName(id).registration(id)))
      throw new HttpError(404, "Machine not found");
    // Index legacy machines before migrating, so removing their old secret is safe.
    if (!(await env.DIRECTORY.getByName("fleet").add(id)))
      throw new HttpError(409, "Machine limit reached");
    const machine = await env.MACHINES.getByName(id).configure(
      id,
      action,
      action === "rename" && parsed.success ? parsed.data.name : undefined,
    );
    if (!machine) throw new HttpError(404, "Machine not found");
    return json({
      machine,
      ...(action === "rotate" ? { token: await issueToken(machine, env) } : {}),
    });
  }
  if (path === "/api/v1/machine-groups") {
    const { ids } = await fleetIds(env);
    const directory = env.DIRECTORY.getByName("fleet");
    if (request.method === "GET")
      return json(await machineGroupState(env, ids));
    if (request.method === "POST") {
      const parsed = MachineGroupInput.safeParse(await body(request));
      if (!parsed.success) throw new HttpError(400, "Invalid group name");
      return json(
        { group: await directory.createGroup(parsed.data.name) },
        201,
      );
    }
    throw new HttpError(405, "Method not allowed");
  }
  if (
    path === "/api/v1/machine-groups/assignments" &&
    request.method === "POST"
  ) {
    const input = await body(request);
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      typeof input.machineId !== "string" ||
      !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(input.machineId) ||
      !(
        input.groupId === null ||
        (typeof input.groupId === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            input.groupId,
          ))
      )
    )
      throw new HttpError(400, "Invalid machine group assignment");
    if (
      !(await env.MACHINES.getByName(input.machineId).registration(
        input.machineId,
      ))
    )
      throw new HttpError(404, "Machine not found");
    const directory = env.DIRECTORY.getByName("fleet");
    if (!(await directory.setAssignment(input.machineId, input.groupId)))
      throw new HttpError(404, "Group not found");
    return json({
      assignment: {
        machineId: input.machineId,
        groupId: input.groupId,
      },
    });
  }
  const groupPath = path.match(
    /^\/api\/v1\/machine-groups\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/,
  );
  if (groupPath) {
    const [, groupId] = groupPath;
    const directory = env.DIRECTORY.getByName("fleet");
    if (request.method === "PATCH") {
      const parsed = MachineGroupInput.safeParse(await body(request));
      if (!parsed.success) throw new HttpError(400, "Invalid group name");
      const group = await directory.renameGroup(groupId, parsed.data.name);
      if (!group) throw new HttpError(404, "Group not found");
      return json({ group });
    }
    if (request.method === "DELETE") {
      if (!(await directory.deleteGroup(groupId)))
        throw new HttpError(404, "Group not found");
      return json({ deleted: true });
    }
    throw new HttpError(405, "Method not allowed");
  }
  if (request.method !== "GET") throw new HttpError(405, "Method not allowed");
  if (path === "/api/v1/me") return json(await withProfile(viewer));
  if (path === "/api/v1/overview") {
    const { ids } = await fleetIds(env);
    const enabled = (await registrations(env)).filter((m) => m.enabled);
    const enabledIds = enabled.map((m) => m.id);
    const states = await Promise.all(
      enabledIds.map((id) => env.MACHINES.getByName(id).current()),
    );
    return json({
      now: new Date().toISOString(),
      machines: states.filter((state) => state !== null),
      pendingMachines: enabledIds.filter((_, index) => states[index] === null),
      machineGroups: await machineGroupState(env, ids),
    });
  }
  throw new HttpError(404, "Not found");
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (
      env.INGEST_HOST !== undefined &&
      url.hostname === env.INGEST_HOST &&
      ![
        "/api/v1/reports",
        "/api/v1/heartbeat",
        "/api/v1/realtime-agent",
        "/api/live",
      ].includes(url.pathname)
    )
      return json({ error: "Not found" }, 404);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof HttpError)
        return json({ error: error.message }, error.status);
      console.error(
        JSON.stringify({
          event: "request_failed",
          category: error instanceof Error ? error.name : "unknown",
          path: new URL(request.url).pathname,
        }),
      );
      return json({ error: "Service unavailable" }, 503);
    }
  },
} satisfies ExportedHandler<Env>;
