import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { serialize } from "node:v8";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import NativeWebSocket from "ws";
import {
  type DailyReport,
  dailyCutoff,
  dailyStart,
  dueDate,
} from "../src/shared/daily.ts";
import type { MachineView, Report } from "../src/shared/schema.ts";
import { viewerAuthorized } from "../src/worker/auth.ts";
import { report, telemetry } from "./fixtures.ts";

let mf: Miniflare;
const testStorage = mkdtempSync(join(tmpdir(), "eagle-api-"));
let options: ReturnType<typeof convertV4MiniflareOptions>;
const token = "test-agent-token-with-at-least-32-characters";
let viewer: string;
let signingKey: CryptoKey;
let profileAvailable = true;
let aiCalls = 0;
let aiHold: Promise<void> | undefined;
let aiHoldMatch: string | undefined;
let aiInvalid = false;
let aiRequests: string[] | undefined;
const issuer = "https://nocoo.cloudflareaccess.com";
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
const currentReport = (id: string, offset = 0) =>
  report(id, new Date(Date.now() + offset).toISOString());

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
      "--dry-run",
      "--outdir",
      ".local/test-worker",
      "--assets",
      ".local/test-assets",
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
        d1Databases: ["DB"],
        durableObjects: {
          MACHINES: { className: "MachineState", useSQLite: true },
          DIRECTORY: { className: "MachineDirectory", useSQLite: true },
        },
        outboundService: async (request) => {
          const url = new URL(request.url);
          if (url.origin === "https://api.ai.example") {
            aiCalls++;
            assert.equal(url.pathname, "/v1/chat/completions");
            assert.equal(
              request.headers.get("authorization"),
              "Bearer isolated-ai-test-secret",
            );
            assert.equal(request.headers.get("x-api-key"), null);
            const body = (await request.json()) as {
              messages: { content: string }[];
            };
            const prompt = body.messages.map((m) => m.content).join("\n");
            assert(!prompt.includes("isolated-ai-test-secret"));
            aiRequests?.push(prompt);
            if (!aiHoldMatch || prompt.includes(aiHoldMatch)) await aiHold;
            const hours = prompt.includes("DATA_JSON:")
              ? (JSON.parse(
                  prompt
                    .split("DATA_JSON:")[1]
                    .split("\n校验反馈")[0]
                    .split("\n上次")[0],
                ) as { hour: number; records: { id: string }[] }[])
              : [];
            const content = hours.length
              ? JSON.stringify({
                  overview: aiInvalid
                    ? "长".repeat(161)
                    : "今日任务持续推进，生产部署尚无验证证据。",
                  hours: hours.map((h) => ({
                    hour: h.hour,
                    summary: h.records.length
                      ? "任务推进，部署仍待核实。"
                      : "无采集数据。",
                    evidenceIds: h.records.slice(0, 1).map((r) => r.id),
                  })),
                  nextSteps: ["核对生产部署。"],
                })
              : "连接成功。";
            return Response.json({
              id: "completion",
              object: "chat.completion",
              created: 1,
              model: "test-model",
              choices: [
                {
                  index: 0,
                  finish_reason: "stop",
                  message: {
                    role: "assistant",
                    content,
                  },
                },
              ],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 20,
                total_tokens: 30,
              },
            });
          }
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
          AI_ENCRYPTION_KEY: "test-encryption-key-at-least-32-characters-long",
          AGENT_SIGNING_KEY: "test-signing-key-at-least-32-characters-long",
          AGENT_TOKENS: JSON.stringify({
            "mac-one": token,
            "mac-two": "different-test-token-with-at-least-32-characters",
          }),
          ACCESS_TEAM_URL: issuer,
          ACCESS_AUD: audience,
          LOCAL_DEV: "false",
          BUILD_REVISION: "test-build-sha",
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
  const db = await mf.getD1Database("DB");
  await db.exec(
    readFileSync("migrations/0001_initial.sql", "utf8").replace(/\n/g, " "),
  );
  await db.exec(
    readFileSync("migrations/0002_pane_summaries.sql", "utf8").replace(
      /\n/g,
      " ",
    ),
  );
  await db.exec(
    readFileSync("migrations/0003_hourly_reports.sql", "utf8").replace(
      /\n/g,
      " ",
    ),
  );
  await db.exec(
    readFileSync("migrations/0004_daily_reports.sql", "utf8").replace(
      /\n/g,
      " ",
    ),
  );
  const legacy = report("legacy-import");
  legacy.machine.id = "retired";
  await db
    .prepare(
      "INSERT INTO reports(machine_id, report_id, captured_at, received_at, digest, payload) VALUES(?, ?, ?, ?, ?, ?)",
    )
    .bind(
      "retired",
      legacy.reportId,
      legacy.capturedAt,
      legacy.capturedAt,
      "legacy-digest",
      JSON.stringify(legacy),
    )
    .run();
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
      await mf.dispatchFetch("https://eagle-ingest.hexly.ai/api/v1/me", {
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
  const value = currentReport("do-only", -20000);
  assert.equal((await request("/api/v1/reports", value)).status, 201);
  const db = await mf.getD1Database("DB");
  assert.equal(
    await db.prepare("SELECT COUNT(*) AS n FROM reports").first("n"),
    1,
  );
  const view = (await (
    await request("/api/v1/overview", undefined, viewer)
  ).json()) as { machines: { report: typeof value }[] };
  assert.equal(view.machines[0].report.reportId, value.reportId);
});

test("telemetry and current state survive DO eviction without a D1 write", async () => {
  const value = currentReport("telemetry", -10000);
  const snapshot = telemetry(value.capturedAt);
  const payload = {
    ...value,
    machine: { ...value.machine, telemetry: snapshot },
  };
  assert.equal(
    (await request("/api/v1/reports", payload, "wrong")).status,
    401,
  );
  assert.equal((await request("/api/v1/reports", payload)).status, 201);
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
  const db = await mf.getD1Database("DB");
  assert.equal(
    await db
      .prepare("SELECT COUNT(*) AS n FROM reports WHERE machine_id = 'mac-one'")
      .first("n"),
    0,
  );
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
test("AI settings require viewer auth, reject invalid keys, and unconfigured daily runs skip", async () => {
  assert.equal((await request("/api/v1/settings")).status, 401);
  const initial = await request("/api/v1/settings", undefined, viewer);
  assert.equal(initial.status, 200);
  const settings = (await initial.json()) as {
    schedule: string;
    hasApiKey: boolean;
  };
  assert.equal(settings.schedule, "23:59");
  assert.equal(settings.hasApiKey, false);
  assert.equal(
    (await request("/api/v1/settings", { apiKey: { invalid: true } }, viewer))
      .status,
    400,
  );
  const skipped = await request("/api/v1/daily-reports/run", {}, viewer);
  assert.equal(skipped.status, 200);
  assert.deepEqual(await skipped.json(), {
    skipped: "ai_not_configured",
    results: [],
  });
  const scheduled = await mf.dispatchFetch(
    `http://eagle.test/cdn-cgi/local/scheduled?cron=5+*+*+*+*&time=${Date.now()}`,
  );
  assert.equal(scheduled.status, 200, await scheduled.text());
  assert.equal(
    (await request("/api/v1/settings", { intervalHours: 0 }, viewer)).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/api/v1/settings",
        {
          provider: "custom",
          model: "test",
          baseURL: "http://127.0.0.1",
          sdkType: "openai",
        },
        viewer,
      )
    ).status,
    400,
  );
});

test("AI keys save encrypted from the UI, survive eviction, stay private, and bind to their endpoint", async () => {
  const configuration = {
    provider: "custom",
    model: "test-model",
    baseURL: "https://api.ai.example/v1",
    sdkType: "openai",
    authType: "bearer",
  };
  const key = "isolated-ai-test-secret";
  assert("workers" in options);
  await mf.setOptions({
    ...options,
    workers: options.workers.map((worker) => ({
      ...worker,
      config: {
        ...worker.config,
        env: { ...worker.config.env, AI_API_KEY: { type: "text", value: key } },
      },
    })),
  });
  const saved = await request(
    "/api/v1/settings",
    { ...configuration, apiKey: key },
    viewer,
  );
  assert.equal(saved.status, 200);
  const value = await saved.text();
  assert(!value.includes(key));
  assert(!Object.hasOwn(JSON.parse(value), "apiKey"));
  assert.equal(JSON.parse(value).hasApiKey, true);
  assert.equal(JSON.parse(value).configured, true);
  await mf.setOptions(options);
  const raw = readdirSync(testStorage, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".sqlite"))
    .flatMap((file) => {
      const database = new DatabaseSync(join(testStorage, file), {
        readOnly: true,
      });
      try {
        return database
          .prepare("SELECT name FROM sqlite_master WHERE name='_cf_KV'")
          .get()
          ? database.prepare("SELECT key,hex(value) value FROM _cf_KV").all()
          : [];
      } finally {
        database.close();
      }
    });
  assert(
    !JSON.stringify(raw)
      .toLowerCase()
      .includes(Buffer.from(key).toString("hex")),
    "No plaintext key in DO storage",
  );
  assert(
    raw.some(
      (row) =>
        String(row.key) === "ai-credential" ||
        (row.key instanceof Uint8Array &&
          Buffer.from(row.key).toString() === "ai-credential"),
    ),
    "Encrypted credential is separate from public settings",
  );
  assert.equal(
    (await request("/api/v1/settings", undefined, viewer)).status,
    200,
  );
  await mf.unsafeEvictDurableObject("eagle", "MachineDirectory", {
    name: "fleet",
  });
  const tested = await request("/api/v1/settings/test", configuration, viewer);
  assert.equal(((await tested.json()) as { success: boolean }).success, true);
  const calls = aiCalls;
  const other = { ...configuration, baseURL: "https://another.ai.example/v1" };
  const unbound = await request("/api/v1/settings/test", other, viewer);
  assert.equal(((await unbound.json()) as { success: boolean }).success, false);
  assert.equal(
    aiCalls,
    calls,
    "Saved key must never be sent to a draft endpoint",
  );
  const leaked = currentReport("saved-key-leak");
  leaked.warnings = [key];
  assert.equal((await request("/api/v1/reports", leaked)).status, 400);
  assert.equal(
    (await request("/api/v1/settings", { model: key }, viewer)).status,
    400,
  );
  const retained = await request(
    "/api/v1/settings",
    { enabled: true, apiKey: "" },
    viewer,
  );
  assert.equal(
    ((await retained.json()) as { hasApiKey: boolean }).hasApiKey,
    true,
  );
  const changed = await request("/api/v1/settings", other, viewer);
  assert.equal(
    ((await changed.json()) as { hasApiKey: boolean }).hasApiKey,
    false,
  );
  const draft = await request(
    "/api/v1/settings/test",
    { ...configuration, apiKey: key },
    viewer,
  );
  assert.equal(((await draft.json()) as { success: boolean }).success, true);
  assert.equal(
    (
      (await (await request("/api/v1/settings", undefined, viewer)).json()) as {
        hasApiKey: boolean;
      }
    ).hasApiKey,
    false,
    "Testing never saves a draft key",
  );
  await request("/api/v1/settings", { ...configuration, apiKey: key }, viewer);
  const protocolChanged = await request(
    "/api/v1/settings",
    { sdkType: "anthropic" },
    viewer,
  );
  assert.equal(
    ((await protocolChanged.json()) as { hasApiKey: boolean }).hasApiKey,
    false,
    "Changing protocol must not reuse an existing credential",
  );
  await request("/api/v1/settings", { ...configuration, apiKey: key }, viewer);
  const cleared = await request("/api/v1/settings", { apiKey: null }, viewer);
  assert.equal(
    ((await cleared.json()) as { hasApiKey: boolean }).hasApiKey,
    false,
  );
  await request("/api/v1/settings", { provider: "", model: "" }, viewer);
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
    (await request("/api/v1/reports", currentReport("future", 600_000))).status,
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
    (await request("/api/v1/reports", currentReport("older", -60_000))).status,
    201,
  );
  const overview = (await (
    await request("/api/v1/overview", undefined, viewer)
  ).json()) as { machines: { report: { reportId: string } }[] };
  assert.equal(overview.machines[0].report.reportId, "newest");
  const db = await mf.getD1Database("DB");
  const stored = await db.prepare("SELECT * FROM reports").all();
  assert.equal(stored.results.length, 1);
  assert.equal(stored.results[0].machine_id, "retired");
  assert(!JSON.stringify(stored).includes(token));
});
test("heartbeats keep known machines alive without rewriting inventory; legacy history stays queryable", async () => {
  const beat = {
    schemaVersion: 1,
    machineId: "mac-one",
    sentAt: new Date().toISOString(),
    warning: "collector retry",
  };
  assert.equal((await request("/api/v1/heartbeat", beat)).status, 200);
  const response = await request(
    "/api/v1/history?machine=retired&limit=1",
    undefined,
    viewer,
  );
  const page = (await response.json()) as {
    entries: { report: { reportId: string } }[];
    nextCursor: number | null;
  };
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].report.reportId, "legacy-import");
  assert.equal(page.nextCursor, null);
  assert.equal(
    (await request("/api/v1/history?limit=-1", undefined, viewer)).status,
    400,
  );
  assert.equal(
    (await request("/api/v1/history?before=oops", undefined, viewer)).status,
    400,
  );
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
    LOCAL_DEV: "true",
  } as Env;
  assert.equal(
    await viewerAuthorized(
      new Request("https://eagle.dev.hexly.ai/api/v1/overview"),
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
      new Request("https://eagle.hexly.ai/api/v1/overview"),
      env,
    ),
    false,
  );
  assert.equal(
    await viewerAuthorized(
      new Request("https://eagle.dev.hexly.ai/api/v1/overview"),
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

test("two machines may share Herdr IDs without inventory or history collisions", async () => {
  const second = currentReport("second-machine");
  second.machine.id = "mac-two";
  second.machine.name = "Mac Two";
  assert.equal(
    (
      await request(
        "/api/v1/reports",
        second,
        "different-test-token-with-at-least-32-characters",
      )
    ).status,
    201,
  );
  const overview = (await (
    await request("/api/v1/overview", undefined, viewer)
  ).json()) as {
    machines: { id: string; report: ReturnType<typeof report> }[];
  };
  assert.deepEqual(
    overview.machines.map((m) => m.id),
    ["mac-one", "mac-two"],
  );
  assert.equal(
    overview.machines[0].report.spaces[0].id,
    overview.machines[1].report.spaces[0].id,
  );
  const history = (await (
    await request("/api/v1/history?machine=mac-two", undefined, viewer)
  ).json()) as { entries: { report: ReturnType<typeof report> }[] };
  assert.equal(history.entries.length, 0);
});

test("the machine ingress exposes only Bearer-protected ingestion and public health", async () => {
  for (const path of [
    "/",
    "/assets/app.js",
    "/api/v1/overview",
    "/api/v1/history",
  ]) {
    const response = await mf.dispatchFetch(
      `https://eagle-ingest.hexly.ai${path}`,
      { headers: { "Cf-Access-Jwt-Assertion": viewer } },
    );
    assert.equal(response.status, 404);
  }
  assert.equal(
    (await mf.dispatchFetch("https://eagle-ingest.hexly.ai/api/live")).status,
    200,
  );
  assert.equal(
    (
      await mf.dispatchFetch("https://eagle-ingest.hexly.ai/api/v1/reports", {
        method: "POST",
      })
    ).status,
    401,
  );
  const response = await mf.dispatchFetch(
    "https://eagle-ingest.hexly.ai/api/v1/reports",
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
  const value = currentReport("replace-current", 2000);
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
    capturedAt: new Date(Date.parse(value.capturedAt) + 1000).toISOString(),
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
  const leaked = structuredClone(value);
  leaked.reportId = "credential-leak";
  leaked.warnings = [first.token];
  assert.equal(
    (await request("/api/v1/reports", leaked, first.token)).status,
    400,
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
  const db = await mf.getD1Database("DB");
  assert.equal(
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM reports WHERE machine_id = 'connected'",
      )
      .first("n"),
    0,
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

test("credentials embedded in reports are rejected; missing legacy tables cannot break live ingestion or viewing", async () => {
  const value = currentReport("secret-in-evidence");
  value.warnings = [token];
  assert.equal((await request("/api/v1/reports", value)).status, 400);
  const db = await mf.getD1Database("DB");
  await db.exec("DROP TABLE machines; DROP TABLE reports;");
  assert.equal(
    (await request("/api/v1/reports", currentReport("archive-outage", 1000)))
      .status,
    201,
  );
  assert.equal(
    (await request("/api/v1/overview", undefined, viewer)).status,
    200,
  );
  assert.equal((await request("/api/live", undefined, "")).status, 200);
  assert.equal(
    (await request("/api/v1/history", undefined, viewer)).status,
    503,
  );
});

test("semantic summaries bind current tasks and facts, dedupe changes, preserve history, and reject fabricated evidence", async () => {
  const { evidenceKeys } = await import("../src/shared/summaries.ts");
  const current = currentReport("semantic-base", 10000);
  const pane = current.spaces[0].tabs[0].panes[0];
  pane.evidence = [
    {
      kind: "git",
      status: "success",
      source: "git:HEAD+status",
      observedAt: current.capturedAt,
      taskId: pane.task.id,
      revision: "a".repeat(40),
      summary: "main clean",
    },
  ];
  assert.equal((await request("/api/v1/reports", current)).status, 201);
  const basis = Object.keys(await evidenceKeys(pane.evidence));
  const entry = {
    spaceId: current.spaces[0].id,
    paneId: pane.id,
    taskId: pane.task.id,
    basis,
    observedAt: new Date().toISOString(),
    summary: {
      task: "实现实时总结",
      phase: "verify",
      progress: "正在核对实际数据",
      outcomes: [{ kind: "commit", text: "main 已提交", evidenceRefs: basis }],
      blocker: null,
      nextStep: "生产验收",
      rationale: "Git 可见，测试与部署待核对",
      evidenceRefs: basis,
    },
  };
  const batch = {
    protocolVersion: 1,
    machineId: current.machine.id,
    managerId: "cherry",
    sequence: 1,
    sentAt: new Date().toISOString(),
    updates: [entry],
    checks: [],
  };
  assert.equal(
    (await request("/api/v1/summaries", batch, "wrong")).status,
    401,
  );
  assert.equal((await request("/api/v1/summaries", batch)).status, 201);
  assert.equal((await request("/api/v1/summaries", batch)).status, 200);
  const db = await mf.getD1Database("DB");
  assert.equal(
    await db.prepare("SELECT count(*) n FROM pane_summaries").first("n"),
    1,
  );
  assert.equal(
    (
      await request("/api/v1/summaries", {
        ...batch,
        updates: [
          { ...entry, summary: { ...entry.summary, progress: "conflict" } },
        ],
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request("/api/v1/summaries", {
        ...batch,
        sequence: 2,
        updates: [{ ...entry, observedAt: new Date().toISOString() }],
      })
    ).status,
    201,
  );
  assert.equal(
    await db.prepare("SELECT count(*) n FROM pane_summaries").first("n"),
    1,
  );
  assert.equal(
    (
      await request("/api/v1/summaries", {
        ...batch,
        sequence: 3,
        updates: [
          {
            ...entry,
            summary: { ...entry.summary, evidenceRefs: ["b".repeat(64)] },
          },
        ],
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request("/api/v1/summaries", {
        ...batch,
        sequence: 3,
        updates: [{ ...entry, taskId: "wrong-task" }],
      })
    ).status,
    409,
  );
  const changed = {
    ...entry,
    observedAt: new Date().toISOString(),
    summary: { ...entry.summary, progress: "完成核对，等待发布" },
  };
  assert.equal(
    (
      await request("/api/v1/summaries", {
        ...batch,
        sequence: 3,
        updates: [changed],
      })
    ).status,
    201,
  );
  assert.equal(
    await db.prepare("SELECT count(*) n FROM pane_summaries").first("n"),
    2,
  );
  const { summary, ...check } = {
    ...entry,
    observedAt: new Date().toISOString(),
  };
  assert.equal(
    (
      await request("/api/v1/summaries", {
        ...batch,
        sequence: 4,
        updates: [],
        checks: [check],
      })
    ).status,
    201,
  );
  assert.equal(
    await db.prepare("SELECT count(*) n FROM pane_summaries").first("n"),
    2,
  );
  assert.equal(
    (
      await request("/api/v1/summaries", {
        ...batch,
        managerId: "other",
        sequence: 5,
      })
    ).status,
    409,
  );
  const own = await request("/api/v1/agent-state");
  assert.equal(own.status, 200);
  const self = (await own.json()) as {
    manager: { sequence: number };
    summaries: { summary: { progress: string } }[];
  };
  assert.equal(self.manager.sequence, 4);
  assert.equal(self.summaries[0].summary.progress, changed.summary.progress);
  const history = await request(
    "/api/v1/summary-history?machine=mac-one&space=default:w1&pane=w1:p1",
    undefined,
    viewer,
  );
  assert.equal(history.status, 200);
  assert.equal(
    ((await history.json()) as { entries: unknown[] }).entries.length,
    2,
  );
  await mf.unsafeEvictDurableObject("eagle", "MachineState", {
    name: "mac-one",
  });
  assert.equal(
    (
      await request("/api/v1/summaries", {
        ...batch,
        sequence: 4,
        updates: [],
        checks: [check],
      })
    ).status,
    200,
  );
});

test("summaries accept recent acknowledged evidence during active work, while checks cannot refresh old facts; outbox survives D1 outage", async () => {
  const { evidenceKeys } = await import("../src/shared/summaries.ts");
  const base = currentReport("semantic-moving", 20000);
  const pane = base.spaces[0].tabs[0].panes[0];
  pane.evidence = [
    {
      kind: "git",
      status: "success",
      source: "git:HEAD+status",
      observedAt: base.capturedAt,
      taskId: pane.task.id,
      revision: "a".repeat(40),
      summary: "main clean",
    },
  ];
  assert.equal((await request("/api/v1/reports", base)).status, 201);
  const entry = {
    spaceId: base.spaces[0].id,
    paneId: pane.id,
    taskId: pane.task.id,
    basis: Object.keys(await evidenceKeys(pane.evidence)),
    observedAt: new Date().toISOString(),
    summary: {
      task: "持续变化任务",
      phase: "implement",
      progress: "已完成第一步，后续仍在进行",
      outcomes: [],
      blocker: null,
      nextStep: "继续验证",
      rationale: "基于分析开始时的实际证据",
      evidenceRefs: [],
    },
  };
  const next = structuredClone(base);
  next.reportId = "semantic-moving-next";
  next.capturedAt = new Date(Date.parse(base.capturedAt) + 1).toISOString();
  next.spaces[0].tabs[0].panes[0].evidence[0].revision = "b".repeat(40);
  assert.equal((await request("/api/v1/reports", next)).status, 201);
  const batch = {
    protocolVersion: 1,
    machineId: "mac-one",
    managerId: "cherry",
    sequence: 5,
    sentAt: new Date().toISOString(),
    updates: [entry],
    checks: [],
  };
  const db = await mf.getD1Database("DB");
  await db.exec("ALTER TABLE pane_summaries RENAME TO archive_unavailable");
  const response = await request("/api/v1/summaries", batch);
  assert.equal(response.status, 201);
  assert.equal(
    ((await response.json()) as { archivePending: number }).archivePending,
    1,
  );
  const { summary, ...check } = {
    ...entry,
    observedAt: new Date().toISOString(),
  };
  assert.equal(
    (
      await request("/api/v1/summaries", {
        ...batch,
        sequence: 6,
        updates: [],
        checks: [check],
      })
    ).status,
    409,
  );
  await db.exec("ALTER TABLE archive_unavailable RENAME TO pane_summaries");
  await mf.unsafeEvictDurableObject("eagle", "MachineState", {
    name: "mac-one",
  });
  assert.equal((await request("/api/v1/summaries", batch)).status, 200);
  assert.equal(
    await db
      .prepare(
        "SELECT count(*) n FROM pane_summaries WHERE task_id=? AND payload LIKE ?",
      )
      .bind("task-1", "%已完成第一步%")
      .first("n"),
    1,
  );
});

test("DO independently retains semantic records in UTC hours with latest/all queries, source and hashes", async () => {
  const now = new Date();
  const previousHour = new Date(now.getTime() - 3600000).toISOString();
  const entry = {
    spaceId: "default:w1",
    paneId: "w1:p1",
    taskId: "older-task",
    basis: [],
    observedAt: previousHour,
    summary: {
      task: "过去的任务",
      phase: "verify",
      progress: "小时内首次核对",
      outcomes: [],
      blocker: null,
      nextStep: "继续",
      rationale: "仅语义描述，无事实凭据",
      evidenceRefs: [],
    },
  };
  const batch = {
    protocolVersion: 1,
    machineId: "mac-one",
    managerId: "cherry",
    sequence: 6,
    sentAt: now.toISOString(),
    updates: [entry],
    checks: [],
  };
  assert.equal(
    (await request("/api/v1/summaries", batch)).status,
    201,
    "Delayed independent semantic report must not require an aligned current snapshot",
  );
  const second = {
    ...batch,
    sequence: 7,
    updates: [
      {
        ...entry,
        observedAt: new Date(Date.parse(previousHour) + 1).toISOString(),
        summary: { ...entry.summary, progress: "同一小时第二次实质变化" },
      },
    ],
  };
  assert.equal((await request("/api/v1/summaries", second)).status, 201);
  assert.equal((await request("/api/v1/summaries", second)).status, 200);
  const hour = `${previousHour.slice(0, 13)}:00:00.000Z`;
  const query =
    "/api/v1/semantic-hours?machine=mac-one&space=default:w1&pane=w1:p1";
  const get = async (path: string) =>
    (await request(path, undefined, viewer)).json() as Promise<{
      hours: {
        hour: string;
        count: number;
        latest: {
          contentHash: string;
          source: { managerId: string };
          value: { sequence: number; taskId: string };
        };
      }[];
      entries: {
        contentHash: string;
        hour: string;
        value: { sequence: number };
      }[];
    }>;
  const grouped = await get(query);
  const bucket = grouped.hours.find((h) => h.hour === hour);
  assert(bucket);
  assert.equal(bucket.count, 2);
  assert.equal(bucket.latest.value.sequence, 7);
  assert.equal(bucket.latest.source.managerId, "cherry");
  assert.match(bucket.latest.contentHash, /^[a-f0-9]{64}$/);
  const all = await get(`${query}&hour=${encodeURIComponent(hour)}&mode=all`);
  assert.equal(all.entries.length, 2);
  assert(all.entries.every((e) => e.hour === hour));
  const latest = await get(
    `${query}&hour=${encodeURIComponent(hour)}&mode=latest`,
  );
  assert.equal(latest.entries.length, 1);
  assert.equal(latest.entries[0].value.sequence, 7);
  const own = (await (await request("/api/v1/agent-state")).json()) as {
    summaries: { taskId: string }[];
  };
  assert(
    own.summaries.every((s) => s.taskId !== "older-task"),
    "Delayed task cannot replace current interpretation",
  );
  await mf.unsafeEvictDurableObject("eagle", "MachineState", {
    name: "mac-one",
  });
  assert.equal(
    (await get(`${query}&hour=${encodeURIComponent(hour)}&mode=all`)).entries
      .length,
    2,
  );
  assert.equal((await request(query, undefined, "wrong")).status, 401);
  assert.equal(
    (
      await request(
        `${query}&hour=${encodeURIComponent(hour)}&mode=latest&before=2`,
        undefined,
        viewer,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/api/v1/summaries", {
        ...batch,
        sequence: 8,
        updates: [
          {
            ...entry,
            observedAt: new Date(Date.now() - 31 * 86400000).toISOString(),
          },
        ],
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request("/api/v1/summaries", {
        ...batch,
        sequence: 8,
        updates: [
          {
            ...entry,
            observedAt: new Date(Date.parse(previousHour) - 1).toISOString(),
            summary: { ...entry.summary, progress: "迟到的更早观察" },
          },
        ],
      })
    ).status,
    201,
  );
  const active = currentReport("activate-historical-task", 30000);
  active.spaces[0].tabs[0].panes[0].task.id = "older-task";
  assert.equal((await request("/api/v1/reports", active)).status, 201);
  const restored = (await (await request("/api/v1/agent-state")).json()) as {
    summaries: { sequence: number }[];
  };
  assert.equal(
    restored.summaries[0].sequence,
    7,
    "A later upload of an older observation must never roll back the per-task latest pointer",
  );
});

test("retention cannot evict a live task interpretation in favor of delayed historical tasks", async () => {
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "MachineState",
    { name: "mac-one" },
  );
  await storage.exec(
    "UPDATE semantic_current SET received_at='2000-01-01T00:00:00.000Z' WHERE task_id='older-task'",
  );
  await request("/api/v1/semantic-hours?machine=mac-one", undefined, viewer);
  const own = (await (await request("/api/v1/agent-state")).json()) as {
    summaries: { taskId: string; sequence: number }[];
  };
  assert.equal(own.summaries[0]?.taskId, "older-task");
  assert.equal(own.summaries[0].sequence, 7);
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

async function dailyMachine(id: string) {
  await request(
    "/api/v1/settings",
    {
      provider: "custom",
      model: "test-model",
      baseURL: "https://api.ai.example/v1",
      sdkType: "openai",
      authType: "bearer",
      enabled: true,
      apiKey: "isolated-ai-test-secret",
    },
    viewer,
  );
  const created = await request("/api/v1/machines", { id, name: id }, viewer);
  assert.equal(created.status, 201);
  return ((await created.json()) as { token: string }).token;
}
const reportDate = () => dueDate(Date.now());
function dailySnapshot(id: string, machine: string, hour = 9) {
  const value = report(
    id,
    new Date(
      Date.parse(dailyStart(reportDate())) + hour * 3600000 + 60000,
    ).toISOString(),
  );
  value.machine.id = machine;
  return value;
}
async function dailyResult(machine: string, date = reportDate()) {
  const response = await request(
    "/api/v1/daily-reports/run",
    { machine, date },
    viewer,
  );
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as {
    results: {
      generated?: boolean;
      skipped?: string;
      error?: string;
      category?: string;
    }[];
  };
}
async function dailyHistory(machine: string) {
  const response = await request(
    `/api/v1/daily-reports?machine=${machine}`,
    undefined,
    viewer,
  );
  assert.equal(response.status, 200);
  const text = await response.text();
  assert(!text.includes("isolated-ai-test-secret"));
  return JSON.parse(text) as {
    entries: { report: DailyReport }[];
    jobs: { status: string; error: string; date: string; attempts: number }[];
    nextCursor: string | null;
  };
}
async function waitForAi(calls: number) {
  const deadline = Date.now() + 5000;
  while (aiCalls === calls && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(aiCalls, calls + 1);
}

test("daily reports preserve hour groups, exclude the final minute, lease and archive idempotently", async () => {
  const machine = "daily-idempotent";
  const credential = await dailyMachine(machine);
  for (const hour of [0, 9, 23]) {
    const value = dailySnapshot(`daily-${hour}`, machine, hour);
    assert.equal(
      (await request("/api/v1/reports", value, credential)).status,
      201,
    );
    assert.equal(
      (await request("/api/v1/reports", value, credential)).status,
      200,
    );
  }
  const outside = dailySnapshot("daily-outside", machine);
  outside.capturedAt = new Date(
    Date.parse(dailyCutoff(reportDate())) + 30000,
  ).toISOString();
  await request("/api/v1/reports", outside, credential);
  assert.equal(
    (await request("/api/v1/daily-reports/run", { machine }, credential))
      .status,
    401,
  );
  assert.equal(
    (await request("/api/v1/daily-reports", undefined, credential)).status,
    401,
  );
  assert.equal(
    (await request("/api/v1/hourly-reports", undefined, viewer)).status,
    404,
  );
  for (const date of ["2026-02-30", "2099-01-01", "invalid"])
    assert.equal(
      (await request("/api/v1/daily-reports/run", { machine, date }, viewer))
        .status,
      400,
    );
  assert.equal(
    (await request("/api/v1/daily-reports/run", [], viewer)).status,
    400,
  );
  let release = () => {};
  aiHold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls = aiCalls;
  const running = dailyResult(machine);
  try {
    await waitForAi(calls);
    assert.equal(
      (await dailyResult(machine)).results[0].skipped,
      "in_progress",
    );
  } finally {
    release();
    aiHold = undefined;
  }
  assert.equal((await running).results[0].generated, true);
  assert.equal((await dailyResult(machine)).results[0].skipped, "unchanged");
  assert.equal(aiCalls, calls + 1);
  await mf.unsafeEvictDurableObject("eagle", "MachineState", { name: machine });
  const history = await dailyHistory(machine);
  assert.equal(history.entries.length, 1);
  const value = history.entries[0].report;
  assert.equal(value.date, reportDate());
  assert.equal(value.timezone, "Asia/Shanghai");
  assert.equal(value.cutoff, dailyCutoff(reportDate()));
  assert.equal(value.snapshots, 3);
  assert.equal(value.content.hours.length, 24);
  assert.deepEqual(
    value.coverage.filter((h) => h.snapshots).map((h) => h.hour),
    [0, 9, 23],
  );
  assert.equal(value.content.hours[1].summary, "无采集数据。");
  assert.equal(history.jobs[0].status, "complete");
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "MachineState",
    { name: machine },
  );
  const tables = await storage.exec(
    "SELECT name FROM sqlite_master WHERE type='table'",
  );
  assert(!JSON.stringify(tables).includes('"hourly_jobs"'));
  assert(!JSON.stringify(tables).includes('"hourly_steps"'));
  const raw = await storage.exec("SELECT count(*) n FROM hourly_facts");
  assert.equal(raw[0].n, 4);
});

test("daily archive failures reuse the saved final after eviction and raw expiry", async () => {
  const machine = "daily-archive";
  const credential = await dailyMachine(machine);
  await request(
    "/api/v1/reports",
    dailySnapshot("archive-input", machine),
    credential,
  );
  const db = await mf.getD1Database("DB");
  await db.exec(
    "ALTER TABLE machine_daily_reports RENAME TO saved_daily_reports",
  );
  try {
    assert.equal(
      (await dailyResult(machine)).results[0].category,
      "archive_unavailable",
    );
  } finally {
    await db.exec(
      "ALTER TABLE saved_daily_reports RENAME TO machine_daily_reports",
    );
  }
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "MachineState",
    { name: machine },
  );
  await storage.exec("DELETE FROM hourly_facts");
  await mf.unsafeEvictDurableObject("eagle", "MachineState", { name: machine });
  const calls = aiCalls;
  assert.equal((await dailyResult(machine)).results[0].generated, true);
  assert.equal(aiCalls, calls);
  assert.equal((await dailyHistory(machine)).entries[0].report.snapshots, 1);
});

test("invalid daily output is bounded to two calls and duplicates never poll a failed day", async () => {
  const machine = "daily-failed";
  const credential = await dailyMachine(machine);
  await request(
    "/api/v1/reports",
    dailySnapshot("failed-input", machine),
    credential,
  );
  const calls = aiCalls;
  aiInvalid = true;
  try {
    assert.equal(
      (await dailyResult(machine)).results[0].category,
      "invalid_output",
    );
  } finally {
    aiInvalid = false;
  }
  assert.equal(aiCalls, calls + 2);
  const history = await dailyHistory(machine);
  assert.equal(history.entries.length, 0);
  assert.equal(history.jobs[0].status, "failed");
  assert.equal(history.jobs[0].error, "invalid_output");
  const cron = await mf.dispatchFetch(
    `http://eagle.test/cdn-cgi/local/scheduled?cron=59+15+*+*+*&time=${Date.parse(dailyCutoff(reportDate()))}`,
  );
  assert.equal(cron.status, 200, await cron.text());
  assert.equal((await dailyHistory(machine)).jobs[0].attempts, 1);
  const retryCalls = aiCalls;
  assert.equal((await dailyResult(machine)).results[0].generated, true);
  assert.equal(aiCalls, retryCalls + 1);
  assert.equal((await dailyHistory(machine)).jobs[0].attempts, 2);
});

test("daily large input uses one bounded prompt and exposes per-hour sampling", async () => {
  const machine = "daily-large";
  const credential = await dailyMachine(machine);
  for (let hour = 0; hour < 24; hour++) {
    const value = dailySnapshot(`large-${hour}`, machine, hour);
    value.spaces[0].tabs[0].panes[0].evidence = Array.from(
      { length: 30 },
      (_, i) => ({
        kind: "summary",
        status: "unknown",
        source: `native:${i}`,
        observedAt: value.capturedAt,
        taskId: "task-1",
        summary: "未经验证的原始材料。".repeat(180),
      }),
    );
    assert.equal(
      (await request("/api/v1/reports", value, credential)).status,
      201,
    );
  }
  aiRequests = [];
  try {
    assert.equal((await dailyResult(machine)).results[0].generated, true);
    assert.equal(aiRequests.length, 1);
    assert(aiRequests[0].length < 110000);
    const saved = (await dailyHistory(machine)).entries[0].report;
    assert.equal(saved.snapshots, 24);
    assert(
      saved.coverage.every(
        (h) => h.omittedRecords > 0 && h.excerptedRecords > 0,
      ),
    );
  } finally {
    aiRequests = undefined;
  }
});

test("daily generation freezes its input and manual regeneration includes late arrivals", async () => {
  const machine = "daily-changing";
  const credential = await dailyMachine(machine);
  await request(
    "/api/v1/reports",
    dailySnapshot("changing-first", machine),
    credential,
  );
  let release = () => {};
  aiHold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls = aiCalls;
  const running = dailyResult(machine);
  try {
    await waitForAi(calls);
    await request(
      "/api/v1/reports",
      dailySnapshot("changing-second", machine, 10),
      credential,
    );
  } finally {
    release();
    aiHold = undefined;
  }
  assert.equal((await running).results[0].generated, true);
  assert.equal((await dailyHistory(machine)).entries[0].report.snapshots, 1);
  assert.equal((await dailyResult(machine)).results[0].generated, true);
  assert.equal((await dailyHistory(machine)).entries[0].report.snapshots, 2);
});

test("daily obsolete leases cannot archive or clear a replacement lease", async () => {
  const machine = "daily-lease";
  const credential = await dailyMachine(machine);
  await request(
    "/api/v1/reports",
    dailySnapshot("lease-input", machine),
    credential,
  );
  let release = () => {};
  aiHold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls = aiCalls;
  const running = dailyResult(machine);
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "MachineState",
    { name: machine },
  );
  try {
    await waitForAi(calls);
    await storage.exec(
      "UPDATE daily_jobs SET payload=json_set(payload,'$.lease','replacement')",
    );
  } finally {
    release();
    aiHold = undefined;
  }
  assert.equal((await running).results[0].skipped, "lease_lost");
  assert.equal((await dailyHistory(machine)).entries.length, 0);
  assert.match(
    JSON.stringify(await storage.exec("SELECT payload FROM daily_jobs")),
    /replacement/,
  );
});

test("daily archives paginate by date and reject invalid cursors and methods", async () => {
  const db = await mf.getD1Database("DB");
  const report = (await dailyHistory("daily-idempotent")).entries[0].report;
  for (const date of ["2026-09-01", "2026-09-03", "2026-09-02"])
    await db
      .prepare(
        "INSERT INTO machine_daily_reports(machine_id,date,generated_at,input_hash,payload) VALUES(?,?,?,?,?)",
      )
      .bind(
        "pagination",
        date,
        report.generatedAt,
        "test",
        JSON.stringify({ ...report, date }),
      )
      .run();
  const first = await request(
    "/api/v1/daily-reports?machine=pagination&limit=1",
    undefined,
    viewer,
  );
  const page = (await first.json()) as {
    entries: { report: DailyReport }[];
    nextCursor: string;
  };
  assert.equal(page.entries[0].report.date, "2026-09-03");
  const second = await request(
    `/api/v1/daily-reports?machine=pagination&limit=1&before=${encodeURIComponent(page.nextCursor)}`,
    undefined,
    viewer,
  );
  assert.equal(
    ((await second.json()) as typeof page).entries[0].report.date,
    "2026-09-02",
  );
  for (const query of [
    "date=2026-02-30",
    "before=garbage",
    "before=2026-09-02%7C0",
  ])
    assert.equal(
      (await request(`/api/v1/daily-reports?${query}`, undefined, viewer))
        .status,
      400,
    );
  assert.equal(
    (await request("/api/v1/daily-reports", {}, viewer)).status,
    405,
  );
  assert.equal(
    (await request("/api/v1/daily-reports/run", undefined, viewer)).status,
    405,
  );
});

test("daily cutover preserves the configured provider and encrypted key while removing cadence", async () => {
  const settings = {
    provider: "custom",
    model: "test-model",
    baseURL: "https://api.ai.example/v1",
    sdkType: "openai",
    authType: "bearer",
    enabled: true,
  };
  await request(
    "/api/v1/settings",
    { ...settings, apiKey: "isolated-ai-test-secret" },
    viewer,
  );
  await mf.dispose();
  let edited = 0;
  try {
    for (const file of readdirSync(testStorage, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith(".sqlite"))) {
      const db = new DatabaseSync(join(testStorage, file));
      try {
        if (
          !db
            .prepare("SELECT name FROM sqlite_master WHERE name='_cf_KV'")
            .get()
        )
          continue;
        if (
          !db.prepare("SELECT key FROM _cf_KV WHERE key='daily-settings'").get()
        )
          continue;
        db.prepare(
          "UPDATE _cf_KV SET key='hourly-settings',value=? WHERE key='daily-settings'",
        ).run(serialize({ ...settings, intervalHours: 2 }));
        edited++;
      } finally {
        db.close();
      }
    }
  } finally {
    mf = new Miniflare(options);
  }
  assert.equal(edited, 1);
  const response = await request("/api/v1/settings", undefined, viewer);
  assert.equal(response.status, 200);
  const value = (await response.json()) as Record<string, unknown>;
  assert.equal(value.hasApiKey, true);
  assert.equal(value.model, "test-model");
  assert.equal(value.intervalHours, undefined);
  assert.equal(value.schedule, "23:59");
  assert.equal(
    (
      (await (await request("/api/v1/settings/test", {}, viewer)).json()) as {
        success: boolean;
      }
    ).success,
    true,
  );
});

test("daily reports include semantic-only hours with their original observation time", async () => {
  const machine = "daily-semantic";
  const credential = await dailyMachine(machine);
  const value = dailySnapshot("semantic-input", machine, 3);
  await request("/api/v1/reports", value, credential);
  const response = await request(
    "/api/v1/summaries",
    {
      protocolVersion: 1,
      machineId: machine,
      managerId: "daily-manager",
      sequence: 1,
      sentAt: new Date().toISOString(),
      checks: [],
      updates: [
        {
          spaceId: "default:w1",
          paneId: "w1:p1",
          taskId: "semantic-task",
          basis: [],
          observedAt: value.capturedAt,
          summary: {
            task: "日报验证",
            phase: "verify",
            progress: "接口已验证，部署待确认",
            outcomes: [],
            blocker: null,
            nextStep: "验证部署",
            rationale: "管理器报告",
            evidenceRefs: [],
          },
        },
      ],
    },
    credential,
  );
  assert.equal(response.status, 201, await response.clone().text());
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "MachineState",
    { name: machine },
  );
  await storage.exec("DELETE FROM hourly_facts");
  assert.equal((await dailyResult(machine)).results[0].generated, true);
  const saved = (await dailyHistory(machine)).entries[0].report;
  assert.equal(saved.snapshots, 0);
  assert.equal(saved.semanticRecords, 1);
  assert.equal(saved.coverage[3].firstObservedAt, value.capturedAt);
  assert.equal(saved.coverage[3].semanticRecords, 1);
  assert.match(saved.content.hours[3].evidenceIds[0], /^H03-S\d+$/);
});

test("one daily cron serves separate machines without a slow model blocking the fleet or duplicate generation", async () => {
  const machines = ["daily-cron-slow", "daily-cron-fast", "daily-cron-next"];
  for (const machine of machines) {
    const credential = await dailyMachine(machine);
    await request(
      "/api/v1/reports",
      dailySnapshot(`${machine}-input`, machine),
      credential,
    );
  }
  let release = () => {};
  aiHold = new Promise<void>((resolve) => {
    release = resolve;
  });
  aiHoldMatch = "daily-cron-slow";
  const cronUrl = `http://eagle.test/cdn-cgi/local/scheduled?cron=59+15+*+*+*&time=${Date.parse(dailyCutoff(reportDate()))}`;
  const running = mf.dispatchFetch(cronUrl);
  try {
    const deadline = Date.now() + 5000;
    while (
      (await dailyHistory("daily-cron-next")).entries.length === 0 &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await dailyHistory("daily-cron-next")).entries.length, 1);
    assert.equal((await dailyHistory("daily-cron-slow")).entries.length, 0);
  } finally {
    release();
    aiHold = undefined;
    aiHoldMatch = undefined;
  }
  const response = await running;
  assert.equal(response.status, 200, await response.text());
  for (const machine of machines)
    assert.equal(
      (await dailyHistory(machine)).entries[0].report.date,
      reportDate(),
    );
  const calls = aiCalls;
  const duplicate = await mf.dispatchFetch(cronUrl);
  assert.equal(duplicate.status, 200, await duplicate.text());
  assert.equal(aiCalls, calls);
});

test("resource history is authenticated, isolated, idempotent, time ordered and retained independently of current state", async () => {
  const machine = "synthetic-resource-history";
  const created = await request(
    "/api/v1/machines",
    { id: machine, name: "Synthetic resource history" },
    viewer,
  );
  assert.equal(created.status, 201);
  const credentials = (await created.json()) as { token: string };
  const endpoint = `/api/v1/resources?machine=${machine}`;
  assert.equal((await request(endpoint)).status, 401);
  assert.equal((await request(endpoint, {}, viewer)).status, 405);
  assert.equal(
    (await request("/api/v1/resources", undefined, viewer)).status,
    400,
  );
  assert.equal(
    (await request("/api/v1/resources?machine=unknown", undefined, viewer))
      .status,
    404,
  );
  const base = Date.now() - 60000;
  const make = (id: string, offset: number) => {
    const at = new Date(base + offset).toISOString();
    const value = report(id, at);
    value.machine.id = machine;
    value.machine.telemetry = {
      ...telemetry(at),
      sampleIntervalSeconds: 30,
    } as NonNullable<Report["machine"]["telemetry"]>;
    return value;
  };
  const latest = make("resource-new", 30000);
  assert.equal(
    (await request("/api/v1/reports", latest, credentials.token)).status,
    201,
  );
  assert.equal(
    (await request("/api/v1/reports", latest, credentials.token)).status,
    200,
  );
  assert.equal(
    (
      await request(
        "/api/v1/reports",
        { ...latest, spaces: [] },
        credentials.token,
      )
    ).status,
    409,
  );
  const older = make("resource-old", 0);
  assert.equal(
    (await request("/api/v1/reports", older, credentials.token)).status,
    201,
  );
  await request(
    "/api/v1/reports",
    make("resource-expired", -86400000),
    credentials.token,
  );
  const sameSample = { ...latest, reportId: "resource-same-observation" };
  await request("/api/v1/reports", sameSample, credentials.token);
  const missing = make("resource-missing", 40000);
  assert(missing.machine.telemetry);
  missing.machine.telemetry.resources = null;
  await request("/api/v1/reports", missing, credentials.token);
  const future = make("resource-future", 600000);
  future.capturedAt = latest.capturedAt;
  assert.equal(
    (await request("/api/v1/reports", future, credentials.token)).status,
    400,
  );
  const history = (await (
    await request(endpoint, undefined, viewer)
  ).json()) as {
    retentionSeconds: number;
    samples: {
      observedAt: string;
      cpu: number | null;
      memory: number | null;
      load: number[] | null;
    }[];
  };
  assert.equal(history.retentionSeconds, 86400);
  assert.deepEqual(
    history.samples.map((s) => s.observedAt),
    [older, latest, missing].map((v) => v.machine.telemetry?.observedAt),
  );
  assert.equal(history.samples[0].memory, 75);
  assert.deepEqual(history.samples[0].load, [1, 2, 3]);
  assert.equal(history.samples[2].cpu, null);
  const state = (await (
    await request("/api/v1/agent-state", undefined, credentials.token)
  ).json()) as MachineView;
  assert.equal(state.report.reportId, missing.reportId);
  const legacy = make("resource-legacy", 50000);
  delete legacy.machine.telemetry;
  await request("/api/v1/reports", legacy, credentials.token);
  const preserved = (await (
    await request(endpoint, undefined, viewer)
  ).json()) as typeof history;
  assert.equal(preserved.samples.length, 3);
  const storage = await mf.unsafeGetDurableObjectStorage(
    "eagle",
    "MachineState",
    { name: machine },
  );
  const seed = new Date(Date.now() - 7200000).toISOString();
  await storage.exec(
    `WITH RECURSIVE samples(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM samples WHERE n<2885)
    INSERT INTO resource_samples SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+' || n || ' seconds'), json_set(?, '$.observedAt', strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+' || n || ' seconds')) FROM samples`,
    seed,
    JSON.stringify(history.samples[0]),
    seed,
  );
  await storage.exec(
    "INSERT INTO resource_samples VALUES (?,?)",
    "2000-01-01T00:00:00.000Z",
    JSON.stringify(history.samples[0]),
  );
  await mf.unsafeEvictDurableObject("eagle", "MachineState", { name: machine });
  const retained = (await (
    await request(endpoint, undefined, viewer)
  ).json()) as typeof history;
  assert.equal(retained.samples.length, 2880);
  assert(
    retained.samples.every(
      (sample) => Date.parse(sample.observedAt) >= Date.now() - 86400000,
    ),
  );
  await request(`/api/v1/machines/${machine}/revoke`, {}, viewer);
  assert.equal((await request(endpoint, undefined, viewer)).status, 404);
});
