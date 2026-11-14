import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import NativeWebSocket from "ws";
import { viewerAuthorized } from "../apps/web/src/worker/auth.ts";
import { report, telemetry } from "./fixtures.ts";

let mf: Miniflare;
const testStorage = mkdtempSync(join(tmpdir(), "eagle-api-"));
let options: ReturnType<typeof convertV4MiniflareOptions>;
const token = "test-agent-token-with-at-least-32-characters";
let viewer: string;
let signingKey: CryptoKey;
let profileAvailable = true;
const issuer = "https://team.cloudflareaccess.com";
const audience =
  "d1ffdb7fe2787e2a9e8f957a68ed5feec2b944c44c6fdbfd54341887eab6f873";
async function accessToken(aud = audience, iss = issuer, expires = "1h") {
  return new SignJWT({ email: "viewer@example.test" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(iss)
    .setAudience(aud)
    .setSubject("test-user")
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(signingKey);
}
// Monotonic collection time keeps current-state ordering deterministic and
// independent of how fast the suite runs.
let clock = Date.now();
const tick = () => {
  clock += 1;
  return new Date(clock).toISOString();
};
const currentReport = (id: string) => report(id, tick());
const skewedReport = (id: string, offsetMs: number) =>
  report(id, new Date(Date.now() + offsetMs).toISOString());

before(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  signingKey = keys.privateKey;
  const jwk = {
    ...(await exportJWK(keys.publicKey)),
    kid: "test-key",
    alg: "RS256",
  };
  viewer = await accessToken();
  mkdirSync(".local/test-assets", { recursive: true });
  writeFileSync(
    ".local/test-assets/index.html",
    "<!doctype html><title>API test</title>",
  );
  execFileSync(
    "node_modules/.bin/wrangler",
    [
      "deploy",
      "--config",
      "apps/web/wrangler.example.jsonc",
      "--dry-run",
      "--outdir",
      resolve(".local/test-worker"),
      "--assets",
      resolve(".local/test-assets"),
    ],
    { stdio: "pipe" },
  );
  options = convertV4MiniflareOptions({
    workers: [
      {
        name: "eagle",
        modules: true,
        scriptPath: ".local/test-worker/index.js",
        compatibilityDate: "2026-09-19",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          MACHINES: { className: "MachineState", useSQLite: true },
          DIRECTORY: { className: "MachineDirectory", useSQLite: true },
        },
        outboundService: async (request) => {
          const url = new URL(request.url);
          if (url.origin === "https://lizheng.blog") {
            assert.equal(url.pathname, "/api/authors/profile");
            assert.equal(
              url.searchParams.get("hash"),
              createHash("sha256").update("viewer@example.test").digest("hex"),
            );
            assert.equal(request.headers.get("authorization"), null);
            assert.equal(request.headers.get("cf-access-jwt-assertion"), null);
            return profileAvailable
              ? Response.json({
                  name: "Li Zheng",
                  avatar: "https://images.example.test/avatar.png",
                })
              : new Response("Unavailable", { status: 503 });
          }
          assert.equal(request.url, `${issuer}/cdn-cgi/access/certs`);
          return Response.json({ keys: [jwk] });
        },
        bindings: {
          AGENT_SIGNING_KEY: "test-signing-key-at-least-32-characters-long",
          AGENT_TOKENS: JSON.stringify({
            "mac-one": token,
            "mac-two": "different-test-token-with-at-least-32-characters",
          }),
          ACCESS_TEAM_URL: issuer,
          ACCESS_AUD: audience,
          DEV_HOSTS: "dev.example.com",
          INGEST_HOST: "ingest.example.com",
          LOCAL_DEV: "false",
          BUILD_REVISION: "test-build-sha",
          MACOS_VERSION: "1.2.3",
          MACOS_RELEASE_URL: "https://github.com/example/eagle/releases/latest",
        },
      },
    ],
  });
  options = {
    ...options,
    resourcePersistencePath: testStorage,
    isolatedResourcePersistencePath: testStorage,
    unsafeInspectDurableObjects: true,
    unsafeTriggerHandlers: true,
  };
  mf = new Miniflare(options);
});

test("viewer profile uses verified Access email and hashed avatar service with a safe fallback", async () => {
  assert.equal((await request("/api/v1/me", undefined, "")).status, 401);
  const response = await mf.dispatchFetch("https://eagle.test/api/v1/me", {
    headers: {
      "Cf-Access-Jwt-Assertion": viewer,
      "Cf-Access-Authenticated-User-Email": "forged@example.test",
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    email: "viewer@example.test",
    name: "Li Zheng",
    avatar: "https://images.example.test/avatar.png",
    local: false,
  });
  profileAvailable = false;
  try {
    const fallback = await request("/api/v1/me", undefined, viewer);
    assert.equal(fallback.status, 200);
    assert.deepEqual(await fallback.json(), {
      email: "viewer@example.test",
      name: "viewer",
      avatar: null,
      local: false,
    });
  } finally {
    profileAvailable = true;
  }
  assert.equal(
    (
      await mf.dispatchFetch("https://ingest.example.com/api/v1/me", {
        headers: { "Cf-Access-Jwt-Assertion": viewer },
      })
    ).status,
    404,
  );
});
after(async () => {
  await mf?.dispose();
  rmSync(testStorage, { recursive: true, force: true });
});

test("uploads update current state without writing a D1 report", async () => {
  assert.equal(
    (
      await request(
        "/api/v1/heartbeat",
        {
          schemaVersion: 1,
          machineId: "mac-two",
          sentAt: new Date().toISOString(),
        },
        "different-test-token-with-at-least-32-characters",
      )
    ).status,
    409,
  );
  const value = skewedReport("do-only", -20000);
  assert.equal((await request("/api/v1/reports", value)).status, 201);
  const view = (await (
    await request("/api/v1/overview", undefined, viewer)
  ).json()) as { machines: { report: typeof value }[] };
  assert.equal(view.machines[0].report.reportId, value.reportId);
});

test("telemetry and current state survive DO eviction without a D1 write", async () => {
  const value = skewedReport("telemetry", -10000);
  const snapshot = {
    ...telemetry(value.capturedAt),
    hardware: {
      observedAt: value.capturedAt,
      source: "macmon",
      gpuUsagePercent: 25,
      gpuTemperatureCelsius: 60,
      fans: [{ rpm: 1200, maxRpm: 5000 }],
      memory: null,
      swapUsedBytes: 0,
    },
    traffic: {
      observedAt: value.capturedAt,
      source: "netstat-physical",
      sampleMs: 500,
      downloadBytesPerSecond: 1000,
      uploadBytesPerSecond: 2000,
    },
  };
  const payload = {
    ...value,
    machine: { ...value.machine, telemetry: snapshot },
  };
  assert.equal(
    (await request("/api/v1/reports", payload, "wrong")).status,
    401,
  );
  assert.equal((await request("/api/v1/reports", payload)).status, 201);
  for (const key of ["hardware", "traffic"] as const) {
    const future = structuredClone(payload);
    future.reportId += `-${key}-future`;
    future.machine.telemetry[key].observedAt = new Date(
      Date.parse(value.capturedAt) + 1000,
    ).toISOString();
    assert.equal((await request("/api/v1/reports", future)).status, 400);
  }
  const duplicate = await request("/api/v1/reports", payload);
  assert.equal(duplicate.status, 200);
  assert.equal(
    ((await duplicate.json()) as { duplicate: boolean }).duplicate,
    true,
  );
  await mf.unsafeEvictDurableObject("eagle", "MachineState", {
    name: "mac-one",
  });
  const view = (await (
    await request("/api/v1/overview", undefined, viewer)
  ).json()) as {
    machines: { report: typeof payload; revision: number }[];
    pendingMachines: string[];
  };
  assert.deepEqual(view.machines[0].report.machine.telemetry, snapshot);
  assert(view.machines[0].revision > 0);
  assert.deepEqual(view.pendingMachines, ["mac-two"]);
  assert.equal((await request("/api/v1/reports", payload)).status, 200);
  assert.equal(
    (await request("/api/v1/reports", { ...payload, spaces: [] })).status,
    409,
  );
});

function request(path: string, body?: unknown, bearer = token) {
  return mf.dispatchFetch(`https://eagle.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(bearer === viewer
        ? { "Cf-Access-Jwt-Assertion": viewer }
        : { Authorization: `Bearer ${bearer}` }),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
test("the dashboard does not expose or provision the independent device service", async () => {
  for (const path of ["/api/devices/v1", "/api/devices/v1/directory"]) {
    const response = await request(path, undefined, viewer);
    assert.equal(response.status, 404);
  }
  const config = JSON.parse(
    readFileSync("apps/web/wrangler.example.jsonc", "utf8"),
  );
  assert.equal(
    config.durable_objects.bindings.some((binding: { name: string }) =>
      binding.name.startsWith("DEVICE_"),
    ),
    false,
  );
});
test("fail-closed auth, machine scoping, versions, body limits and no token persistence", async () => {
  assert.equal(
    (await request("/api/v1/reports", currentReport("bad-auth"), "wrong"))
      .status,
    401,
  );
  assert.equal(
    (
      await request("/api/v1/reports", {
        ...currentReport("bad-machine"),
        machine: { ...report().machine, id: "mac-two" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/v1/reports", {
        ...currentReport("bad-version"),
        schemaVersion: 2,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/api/v1/reports", {
        ...currentReport("bad-secret"),
        token,
      })
    ).status,
    400,
  );
  assert.equal(
    (await request("/api/v1/reports", skewedReport("future", 600_000))).status,
    400,
  );
  assert.equal(
    (await request("/api/v1/reports", "a".repeat(1_100_000))).status,
    413,
  );
  assert.equal((await request("/api/v1/overview")).status, 401);
  assert.equal((await request("/api/live", undefined, "")).status, 200);
});
test("atomic dedup, content conflicts, concurrent retries and out-of-order current state", async () => {
  const value = currentReport("newest");
  assert.equal((await request("/api/v1/reports", value)).status, 201);
  const retries = await Promise.all(
    Array.from({ length: 4 }, () => request("/api/v1/reports", value)),
  );
  assert(retries.every((r) => r.status === 200));
  assert.equal(
    (await request("/api/v1/reports", { ...value, spaces: [] })).status,
    409,
  );
  assert.equal(
    (await request("/api/v1/reports", skewedReport("older", -60_000))).status,
    201,
  );
  const overview = (await (
    await request("/api/v1/overview", undefined, viewer)
  ).json()) as { machines: { report: { reportId: string } }[] };
  assert.equal(overview.machines[0].report.reportId, "newest");
});
test("equal capture times fall back to report ID ordering", async () => {
  const at = tick();
  assert.equal(
    (await request("/api/v1/reports", report("tie-alpha", at))).status,
    201,
  );
  assert.equal(
    (await request("/api/v1/reports", report("tie-zulu", at))).status,
    201,
  );
  const current = async () =>
    (
      (await (await request("/api/v1/overview", undefined, viewer)).json()) as {
        machines: { report: { reportId: string } }[];
      }
    ).machines[0].report.reportId;
  assert.equal(await current(), "tie-zulu");
  assert.equal(
    (await request("/api/v1/reports", report("tie-mike", at))).status,
    201,
  );
  assert.equal(await current(), "tie-zulu");
});

test("Access validates signature, issuer, audience and expiry and rejects legacy credentials", async () => {
  const access = (jwt: string, headers: Record<string, string> = {}) =>
    mf.dispatchFetch("https://eagle.test/api/v1/overview", {
      headers: { "Cf-Access-Jwt-Assertion": jwt, ...headers },
    });
  assert.equal((await access(viewer)).status, 200);
  for (const jwt of [
    await accessToken("wrong"),
    await accessToken(audience, "https://attacker.test"),
    await accessToken(audience, issuer, "-1h"),
    `${viewer.slice(0, -8)}tampered`,
    "unsigned",
  ]) {
    assert.equal((await access(jwt)).status, 401);
  }
  assert.equal(
    (
      await mf.dispatchFetch("https://eagle.test/api/v1/overview", {
        headers: {
          Authorization: `Bearer ${viewer}`,
          Cookie: "eagle_session=old-session",
          "Cf-Access-Authenticated-User-Email": "viewer@example.test",
        },
      })
    ).status,
    401,
  );
  assert.equal((await request("/api/session", undefined, viewer)).status, 404);
  const crossOrigin = await mf.dispatchFetch(
    "https://eagle.test/api/v1/reports",
    {
      method: "POST",
      headers: {
        Origin: "https://attacker.test",
        Authorization: `Bearer ${token}`,
      },
    },
  );
  assert.equal(crossOrigin.status, 403);
});

test("local viewing needs no token but a local hostname never bypasses production authentication", async () => {
  const env = {
    ACCESS_TEAM_URL: issuer,
    ACCESS_AUD: audience,
    DEV_HOSTS: "dev.example.com",
    INGEST_HOST: "ingest.example.com",
    LOCAL_DEV: "true",
  } as unknown as Env;
  assert.equal(
    await viewerAuthorized(
      new Request("https://dev.example.com/api/v1/overview"),
      env,
    ),
    true,
  );
  assert.equal(
    await viewerAuthorized(
      new Request("http://127.0.0.1:37053/api/v1/overview"),
      env,
    ),
    true,
  );
  assert.equal(
    await viewerAuthorized(
      new Request("https://app.example.com/api/v1/overview"),
      env,
    ),
    false,
  );
  assert.equal(
    await viewerAuthorized(
      new Request("https://dev.example.com/api/v1/overview"),
      { ...env, LOCAL_DEV: "false" },
    ),
    false,
  );
});

test("public health identifies the deployed revision without exposing inventory", async () => {
  const response = await request("/api/live", undefined, "");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const result = (await response.json()) as Record<string, unknown>;
  assert.equal(result.status, "ok");
  assert.equal(result.stateStore, "durable-objects");
  assert.equal(result.historyWrites, false);
  assert.equal(
    result.version,
    JSON.parse(readFileSync("package.json", "utf8")).version,
  );
  assert.equal(result.revision, "test-build-sha");
  assert(!("machines" in result));
  // The app has its own release line; the check reads it from here.
  assert.deepEqual(result.macos, {
    latest: "1.2.3",
    releaseUrl: "https://github.com/example/eagle/releases/latest",
  });
});

test("an ordinary heartbeat and old retry cannot clear a collector failure warning", async () => {
  const beat = {
    schemaVersion: 1,
    machineId: "mac-one",
    sentAt: new Date().toISOString(),
  };
  await request("/api/v1/heartbeat", {
    ...beat,
    warning: "Collection incomplete",
  });
  await request("/api/v1/heartbeat", beat);
  const view = (await (
    await request("/api/v1/overview", undefined, viewer)
  ).json()) as {
    machines: { warning: string; report: ReturnType<typeof report> }[];
  };
  assert.equal(view.machines[0].warning, "Collection incomplete");
  await request("/api/v1/reports", view.machines[0].report);
  const after = (await (
    await request("/api/v1/overview", undefined, viewer)
  ).json()) as typeof view;
  assert.equal(after.machines[0].warning, "Collection incomplete");
});

test("the machine ingress exposes only Bearer-protected ingestion and public health", async () => {
  for (const path of [
    "/",
    "/assets/app.js",
    "/api/v1/overview",
    "/api/v1/machines",
  ]) {
    const response = await mf.dispatchFetch(
      `https://ingest.example.com${path}`,
      { headers: { "Cf-Access-Jwt-Assertion": viewer } },
    );
    assert.equal(response.status, 404);
  }
  assert.equal(
    (await mf.dispatchFetch("https://ingest.example.com/api/live")).status,
    200,
  );
  assert.equal(
    (
      await mf.dispatchFetch("https://ingest.example.com/api/v1/reports", {
        method: "POST",
      })
    ).status,
    401,
  );
  const response = await mf.dispatchFetch(
    "https://ingest.example.com/api/v1/reports",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(currentReport("ingress-test")),
    },
  );
  assert.equal(response.status, 201);
});

test("concurrent first delivery shares one receipt; complete replacement removes closed Spaces and clears warnings", async () => {
  const value = currentReport("replace-current");
  value.spaces = [];
  const receipts = await Promise.all(
    Array.from({ length: 4 }, () => request("/api/v1/reports", value)),
  );
  assert.deepEqual(receipts.map((r) => r.status).sort(), [200, 200, 200, 201]);
  const acks = (await Promise.all(receipts.map((r) => r.json()))) as {
    seq: number;
  }[];
  assert.equal(new Set(acks.map((a) => a.seq)).size, 1);
  const read = async () =>
    (await (await request("/api/v1/overview", undefined, viewer)).json()) as {
      machines: {
        id: string;
        report: typeof value;
        warning: string | null;
        changedAt: string;
        changes: string[];
        revision: number;
      }[];
    };
  const current = (await read()).machines[0];
  assert.equal(current.warning, null);
  assert.deepEqual(current.report.spaces, []);
  assert(current.changes.some((change) => change.includes("已关闭")));
  const reordered = {
    ...value,
    machine: Object.fromEntries(Object.entries(value.machine).reverse()),
  };
  const duplicate = await request("/api/v1/reports", reordered);
  assert.equal(duplicate.status, 200);
  assert.equal(((await duplicate.json()) as { seq: number }).seq, acks[0].seq);
  const beforeConflict = (await read()).machines[0];
  assert.equal(
    (await request("/api/v1/reports", { ...value, warnings: ["changed body"] }))
      .status,
    409,
  );
  assert.deepEqual((await read()).machines[0], beforeConflict);
  await request("/api/v1/reports", {
    ...value,
    reportId: "same-inventory",
    capturedAt: tick(),
  });
  const after = (await read()).machines[0];
  assert.equal(after.changedAt, current.changedAt);
  assert.deepEqual(after.changes, current.changes);
  assert(after.revision > current.revision);
});

test("Connect creates scoped credentials, rotates and revokes them without persisting tokens", async () => {
  assert.equal((await request("/api/v1/machines", undefined, "")).status, 401);
  assert.equal(
    (
      await request(
        "/api/v1/machines",
        { id: "connected", name: "New Mac" },
        token,
      )
    ).status,
    401,
  );
  const created = await request(
    "/api/v1/machines",
    {
      id: "connected",
      name: "New Mac",
      watchPorts: [{ name: "Raven", port: 7024 }],
    },
    viewer,
  );
  assert.equal(created.status, 201);
  const first = (await created.json()) as {
    token: string;
    machine: { id: string; credentialId: string };
  };
  assert(first.token.startsWith("eag1."));
  assert.equal(
    (
      await request(
        "/api/v1/machines",
        { id: "connected", name: "Duplicate" },
        viewer,
      )
    ).status,
    409,
  );
  const value = currentReport("connect-first");
  value.machine.id = "connected";
  assert.equal(
    (await request("/api/v1/reports", value, first.token)).status,
    201,
  );
  assert.equal(
    (
      await request(
        "/api/v1/reports",
        currentReport("cross-machine"),
        first.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (await request("/api/v1/reports", value, `${first.token}x`)).status,
    401,
  );
  const list = await (
    await request("/api/v1/machines", undefined, viewer)
  ).text();
  assert(!list.includes(first.token));
  assert(list.includes('"name":"New Mac"'));
  const rotated = await request(
    "/api/v1/machines/connected/rotate",
    {},
    viewer,
  );
  assert.equal(rotated.status, 200);
  const second = (await rotated.json()) as { token: string };
  assert.notEqual(second.token, first.token);
  assert.equal(
    (await request("/api/v1/reports", value, first.token)).status,
    401,
  );
  assert.equal(
    (await request("/api/v1/reports", value, second.token)).status,
    200,
  );
  assert.equal(
    (
      await request(
        "/api/v1/machines/connected/rename",
        { name: "Renamed Mac" },
        viewer,
      )
    ).status,
    200,
  );
  const overview = (await (
    await request("/api/v1/overview", undefined, viewer)
  ).json()) as { machines: { id: string; name: string }[] };
  assert.equal(
    overview.machines.find((m) => m.id === "connected")?.name,
    "Renamed Mac",
  );
  assert.equal(
    (await request("/api/v1/machines/connected/delete", {}, viewer)).status,
    400,
  );
  assert.equal(
    (await request("/api/v1/machines/connected/revoke", {}, viewer)).status,
    200,
  );
  assert.equal(
    (await request("/api/v1/reports", value, second.token)).status,
    401,
  );
  const after = (await (
    await request("/api/v1/machines", undefined, viewer)
  ).json()) as { machines: { id: string; enabled: boolean }[] };
  assert.equal(
    after.machines.find((m) => m.id === "connected")?.enabled,
    false,
  );
  const createdGroup = await request(
    "/api/v1/machine-groups",
    { name: "Studio" },
    viewer,
  );
  assert.equal(createdGroup.status, 201);
  const group = (await createdGroup.json()) as { group: { id: string } };
  assert.equal(
    (
      await request(
        "/api/v1/machine-groups/assignments",
        { machineId: "connected", groupId: group.group.id },
        viewer,
      )
    ).status,
    200,
  );
  const overviewGroups = (await (
    await request("/api/v1/overview", undefined, viewer)
  ).json()) as {
    machineGroups: { assignments: Record<string, string | null> };
  };
  assert.equal(
    overviewGroups.machineGroups.assignments.connected,
    group.group.id,
  );
  assert.equal(
    (await request("/api/v1/machines/connected/delete", {}, viewer)).status,
    200,
  );
  const gone = (await (
    await request("/api/v1/machines", undefined, viewer)
  ).json()) as { machines: { id: string }[] };
  assert.equal(
    gone.machines.some((machine) => machine.id === "connected"),
    false,
  );
});

test("Connect mutations reject cross-origin requests and can revoke legacy machine tokens", async () => {
  assert.equal(
    (await request("/api/v1/machines/mac-two/rotate", {}, viewer)).status,
    200,
  );
  assert("workers" in options);
  await mf.setOptions({
    ...options,
    workers: options.workers.map((worker) => ({
      ...worker,
      config: {
        ...worker.config,
        env: {
          ...worker.config.env,
          AGENT_TOKENS: {
            type: "text",
            value: JSON.stringify({ "mac-one": token }),
          },
        },
      },
    })),
  });
  const listing = (await (
    await request("/api/v1/machines", undefined, viewer)
  ).json()) as { machines: { id: string }[] };
  assert(
    listing.machines.some((machine) => machine.id === "mac-two"),
    "Migrated legacy identity must remain discoverable after removing its legacy secret",
  );
  const csrf = await mf.dispatchFetch("https://eagle.test/api/v1/machines", {
    method: "POST",
    headers: {
      "Cf-Access-Jwt-Assertion": viewer,
      Origin: "https://evil.test",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: "csrf", name: "CSRF" }),
  });
  assert.equal(csrf.status, 403);
  assert.equal(
    (await request("/api/v1/machines", { id: "bad/id", name: "Bad" }, viewer))
      .status,
    400,
  );
  assert.equal(
    (await request("/api/v1/machines/mac-two/revoke", {}, viewer)).status,
    200,
  );
  const value = currentReport("revoked-legacy");
  value.machine.id = "mac-two";
  assert.equal(
    (
      await request(
        "/api/v1/reports",
        value,
        "different-test-token-with-at-least-32-characters",
      )
    ).status,
    401,
  );
});

test("realtime bridge rejects missing or mismatched configured machine identity", async () => {
  const statuses: number[] = [];
  for (const machine of [undefined, "mac-two"]) {
    const response = await mf.dispatchFetch(
      "https://eagle.test/api/v1/realtime-agent",
      {
        headers: {
          Upgrade: "websocket",
          Authorization: `Bearer ${token}`,
          ...(machine ? { "X-Eagle-Machine": machine } : {}),
        },
      },
    );
    statuses.push(response.status);
    response.webSocket?.accept();
    response.webSocket?.close(1000);
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.deepEqual(statuses, [403, 403]);
});

test("realtime requires Access and same origin, scopes subscriptions, and releases the last viewer", async () => {
  await request("/api/v1/reports", currentReport("realtime-base"));
  const connect = (path: string, headers: Record<string, string>) =>
    mf.dispatchFetch(`https://eagle.test${path}`, {
      headers: { Upgrade: "websocket", ...headers },
    });
  const path = "/api/v1/realtime?machine=mac-one&space=default%3Aw1";
  assert.equal(
    (await connect(path, { Origin: "https://eagle.test" })).status,
    401,
  );
  assert.equal(
    (
      await connect(path, {
        "Cf-Access-Jwt-Assertion": viewer,
        Origin: "https://evil.test",
      })
    ).status,
    403,
  );
  const agentResponse = await connect("/api/v1/realtime-agent", {
    Authorization: `Bearer ${token}`,
    "X-Eagle-Machine": "mac-one",
  });
  assert.equal(agentResponse.status, 101);
  const agent = agentResponse.webSocket;
  assert(agent);
  const messages: {
    type: string;
    spaces?: { spaceId: string; subscriptionId: string }[];
  }[] = [];
  agent.addEventListener("message", (e) =>
    messages.push(JSON.parse(String(e.data))),
  );
  agent.accept();
  const response = await connect(path, {
    "Cf-Access-Jwt-Assertion": viewer,
    Origin: "https://eagle.test",
  });
  assert.equal(response.status, 101);
  const client = response.webSocket;
  assert(client);
  client.accept();
  await new Promise((r) => setTimeout(r, 50));
  const subscription = messages.at(-1)?.spaces?.[0];
  assert(subscription);
  assert.equal(subscription.spaceId, "default:w1");
  assert(subscription.subscriptionId);
  const second = (
    await connect(path, {
      "Cf-Access-Jwt-Assertion": viewer,
      Origin: "https://eagle.test",
    })
  ).webSocket;
  assert(second);
  second.accept();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(messages.at(-1)?.spaces, [subscription]);
  const closed = new Promise<void>((r) =>
    client.addEventListener("close", () => r()),
  );
  client.close(1000);
  await closed;
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(messages.at(-1)?.spaces, [subscription]);
  second.close(1000);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(messages.at(-1)?.spaces, []);
  agent.close(1000);
});

test("realtime has one controller, rejects stale identities and sequences, and closes on credential revocation", async () => {
  const created = await request(
    "/api/v1/machines",
    { id: "realtime-security", name: "Live security" },
    viewer,
  );
  const credential = (await created.json()) as { token: string };
  const value = currentReport("live-security");
  value.machine.id = "realtime-security";
  await request("/api/v1/reports", value, credential.token);
  const open = async (path: string, headers: Record<string, string>) => {
    const result = await mf.dispatchFetch(`https://eagle.test${path}`, {
      headers: { Upgrade: "websocket", ...headers },
    });
    assert.equal(result.status, 101);
    const ws = result.webSocket;
    assert(ws);
    const messages: Record<string, unknown>[] = [];
    ws.addEventListener("message", (event) =>
      messages.push(JSON.parse(String(event.data))),
    );
    ws.accept();
    return { ws, messages };
  };
  const agent = await open("/api/v1/realtime-agent", {
    Authorization: `Bearer ${credential.token}`,
    "X-Eagle-Machine": "realtime-security",
  });
  const headers = {
    "Cf-Access-Jwt-Assertion": viewer,
    Origin: "https://eagle.test",
  };
  const a = await open(
    "/api/v1/realtime?machine=realtime-security&space=default:w1",
    headers,
  );
  const b = await open(
    "/api/v1/realtime?machine=realtime-security&space=default:w1",
    headers,
  );
  const settle = () => new Promise((r) => setTimeout(r, 30));
  await settle();
  const spaces = agent.messages.at(-1)?.spaces as {
    spaceId: string;
    subscriptionId: string;
  }[];
  assert.equal(spaces.length, 1);
  const binding = spaces[0];
  agent.ws.send(
    JSON.stringify({
      type: "topology",
      ...binding,
      tabs: [
        {
          id: "t",
          name: "T",
          panes: [
            {
              id: "p",
              terminalId: "terminal",
              title: "P",
              rect: { x: 0, y: 0, width: 1, height: 1 },
            },
          ],
        },
      ],
    }),
  );
  a.ws.send(JSON.stringify({ type: "control" }));
  await settle();
  b.ws.send(JSON.stringify({ type: "control" }));
  await settle();
  assert.equal(a.messages.at(-1)?.control, true);
  assert.equal(b.messages.at(-1)?.control, false);
  const input = {
    type: "input",
    seq: 1,
    paneId: "p",
    terminalId: "terminal",
    text: "hello",
    keys: [],
  };
  b.ws.send(JSON.stringify(input));
  a.ws.send(JSON.stringify({ ...input, terminalId: "old" }));
  await settle();
  assert.equal(agent.messages.filter((m) => m.type === "input").length, 0);
  a.ws.send(JSON.stringify(input));
  const inputDeadline = Date.now() + 2000;
  while (
    !agent.messages.some((message) => message.type === "input") &&
    Date.now() < inputDeadline
  )
    await settle();
  const command = agent.messages.find((m) => m.type === "input");
  assert(command);
  agent.ws.send(
    JSON.stringify({
      type: "ack",
      clientId: command.clientId,
      seq: 1,
      status: "submitted",
    }),
  );
  await settle();
  a.ws.send(JSON.stringify(input));
  await settle();
  assert.equal(agent.messages.filter((m) => m.type === "input").length, 1);
  const close = Promise.all(
    [a.ws, b.ws, agent.ws].map(
      (ws) => new Promise<void>((r) => ws.addEventListener("close", () => r())),
    ),
  );
  await request("/api/v1/machines/realtime-security/revoke", {}, viewer);
  await close;
});

test("styled realtime is negotiated independently for agents and viewers", async () => {
  await request("/api/v1/reports", currentReport("styled-realtime"));
  const sockets: WebSocket[] = [];
  type Message = {
    type: string;
    format?: string;
    spaces?: { spaceId: string; subscriptionId: string }[];
    text?: string;
    runs?: unknown[];
  };
  const open = async (path: string, headers: Record<string, string>) => {
    const response = await mf.dispatchFetch(`https://eagle.test${path}`, {
      headers: { Upgrade: "websocket", ...headers },
    });
    assert.equal(response.status, 101);
    const ws = response.webSocket;
    assert(ws);
    sockets.push(ws as unknown as WebSocket);
    const messages: Message[] = [];
    ws.addEventListener("message", (event) =>
      messages.push(JSON.parse(String(event.data))),
    );
    ws.accept();
    ws.send(JSON.stringify({ type: "ping" }));
    return { ws, messages };
  };
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 2000;
    while (!condition() && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    assert(condition(), "Expected realtime message was not received");
  };
  try {
    const agent = await open("/api/v1/realtime-agent", {
      Authorization: `Bearer ${token}`,
      "X-Eagle-Machine": "mac-one",
      "X-Eagle-Realtime-Format": "styled-text-v1",
    });
    const headers = {
      "Cf-Access-Jwt-Assertion": viewer,
      Origin: "https://eagle.test",
    };
    const path = "/api/v1/realtime?machine=mac-one&space=default%3Aw1";
    const legacy = await open(path, headers);
    const styled = await open(`${path}&format=styled-text-v1`, headers);
    await until(() => !!agent.messages.find((m) => m.spaces?.length));
    const subscriptionMessage = agent.messages.find((m) => m.spaces?.length);
    assert.equal(subscriptionMessage?.format, "styled-text-v1");
    const subscription = subscriptionMessage?.spaces?.[0];
    assert(subscription);
    agent.ws.send(
      JSON.stringify({
        type: "topology",
        ...subscription,
        tabs: [
          {
            id: "tab",
            name: "Test",
            panes: [
              {
                id: "pane",
                terminalId: "terminal",
                title: "Test",
                rect: { x: 0, y: 0, width: 1, height: 1 },
              },
            ],
          },
        ],
      }),
    );
    const runs = [{ text: "PASS", fg: 2, bold: true }];
    agent.ws.send(
      JSON.stringify({
        type: "frame",
        ...subscription,
        paneId: "pane",
        terminalId: "terminal",
        text: "PASS",
        runs,
        revision: 1,
        observedAt: new Date().toISOString(),
      }),
    );
    await until(
      () =>
        !!styled.messages.find((m) => m.type === "frame") &&
        !!legacy.messages.find((m) => m.type === "frame"),
    );
    assert.deepEqual(
      styled.messages.find((m) => m.type === "frame")?.runs,
      runs,
    );
    assert.equal(
      legacy.messages.find((m) => m.type === "frame")?.runs,
      undefined,
    );
    assert.equal(legacy.messages.find((m) => m.type === "frame")?.text, "PASS");
  } finally {
    for (const socket of sockets) socket.close(1000);
    await new Promise((r) => setTimeout(r, 100));
  }
});

async function liveSocket(path: string, headers: Record<string, string>) {
  const url = new URL(path, await mf.ready);
  const origin = url.origin;
  url.protocol = "ws:";
  const socket = new NativeWebSocket(url, {
    headers: { Origin: origin, ...headers },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ type: "ping" }));
  return socket;
}
test("realtime alarm expires an idle viewer without another request", async () => {
  await request("/api/v1/reports", currentReport("idle-live"));
  const access = await accessToken(audience, issuer, "2s");
  const ws = await liveSocket(
    "/api/v1/realtime?machine=mac-one&space=default:w1",
    { "Cf-Access-Jwt-Assertion": access },
  );
  const closed = new Promise<number>((resolve) => ws.once("close", resolve));
  const timeout = AbortSignal.timeout(5000);
  try {
    assert.equal(
      await Promise.race([
        closed,
        new Promise((resolve) =>
          timeout.addEventListener("abort", () => resolve("not reclaimed")),
        ),
      ]),
      4002,
    );
  } finally {
    ws.terminate();
  }
});

test("realtime bounds slow viewer output while acknowledged viewers keep receiving", async () => {
  await request("/api/v1/reports", currentReport("slow-live"));
  const open = liveSocket;
  const agent = await open("/api/v1/realtime-agent", {
    Authorization: `Bearer ${token}`,
    "X-Eagle-Machine": "mac-one",
  });
  let binding: { spaceId: string; subscriptionId: string } | undefined;
  agent.addEventListener("message", (event) => {
    const m = JSON.parse(String(event.data));
    if (m.spaces?.length) binding = m.spaces[0];
  });
  const headers = {
    "Cf-Access-Jwt-Assertion": viewer,
  };
  const slow = await open(
    "/api/v1/realtime?machine=mac-one&space=default:w1",
    headers,
  );
  const fast = await open(
    "/api/v1/realtime?machine=mac-one&space=default:w1",
    headers,
  );
  let received = 0,
    slowCode = 0;
  fast.addEventListener("message", (event) => {
    const m = JSON.parse(String(event.data));
    if (m.type === "frame") {
      received++;
      fast.send(
        JSON.stringify({
          type: "rendered",
          deliveryId: m.deliveryId,
          deliveryBytes: m.deliveryBytes,
        }),
      );
    }
  });
  slow.addEventListener("close", (event) => {
    slowCode = event.code;
  });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  await settle();
  assert(binding);
  // Maximum topology with long IDs must fit the 2 KiB hibernation attachment limit.
  const panes = Array.from({ length: 32 }, (_, i) => ({
    id: `p${i}${"x".repeat(150)}`,
    terminalId: `t${i}${"y".repeat(150)}`,
    title: "P",
    rect: { x: 0, y: 0, width: 1, height: 1 },
  }));
  agent.send(
    JSON.stringify({
      type: "topology",
      ...binding,
      tabs: [{ id: "t", name: "T", panes }],
    }),
  );
  await settle();
  try {
    for (let revision = 1; revision <= 80; revision++) {
      agent.send(
        JSON.stringify({
          type: "frame",
          ...binding,
          paneId: panes[0].id,
          terminalId: panes[0].terminalId,
          revision,
          text: "x".repeat(32000),
          observedAt: new Date().toISOString(),
        }),
      );
      await settle();
    }
    const deadline = Date.now() + 5000;
    while ((received < 80 || !slowCode) && Date.now() < deadline)
      await settle();
    assert.equal(received, 80);
    assert.equal(slowCode, 1013);
  } finally {
    slow.close();
    fast.close();
    agent.close();
  }
});

test("abrupt viewer termination promptly removes its last subscription", async () => {
  await request("/api/v1/reports", currentReport("abrupt-live"));
  const agent = await liveSocket("/api/v1/realtime-agent", {
    Authorization: `Bearer ${token}`,
    "X-Eagle-Machine": "mac-one",
  });
  const subscriptions: unknown[][] = [];
  agent.on("message", (bytes) => {
    const message = JSON.parse(String(bytes));
    if (message.type === "subscriptions") subscriptions.push(message.spaces);
  });
  const client = await liveSocket(
    "/api/v1/realtime?machine=mac-one&space=default:w1",
    {
      "Cf-Access-Jwt-Assertion": viewer,
    },
  );
  try {
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(subscriptions.at(-1)?.length, 1);
    subscriptions.length = 0;
    client.terminate();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(
      subscriptions.at(-1)?.length,
      0,
      "Cleanup must not wait for the next bridge heartbeat",
    );
  } finally {
    client.terminate();
    agent.terminate();
  }
});
