import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

const configuration = "apps/web/wrangler.devices.example.jsonc";
const config = JSON.parse(readFileSync(configuration, "utf8")) as {
  name: string;
  main: string;
  compatibility_date: string;
  compatibility_flags: string[];
  durable_objects: { bindings: { name: string; class_name: string }[] };
  migrations: { tag: string; new_sqlite_classes: string[] }[];
  vars: Record<string, string>;
};
const origin = "https://eagle-devices.mxhan.workers.dev";
const revision = "local-device-worker-revision";
mkdirSync(".local", { recursive: true });
const root = mkdtempSync(resolve(".local/device-worker-"));
let mf: Miniflare;
let metadata: {
  inputs: Record<string, unknown>;
  outputs: Record<string, { exports: string[] }>;
};

before(async () => {
  const childEnvironment: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(childEnvironment))
    if (name !== "PATH") delete childEnvironment[name];
  mkdirSync(join(root, "tmp"));
  Object.assign(childEnvironment, {
    CI: "true",
    TMPDIR: join(root, "tmp"),
    XDG_CONFIG_HOME: join(root, "config"),
    WRANGLER_LOG_PATH: join(root, "wrangler.log"),
    WRANGLER_SEND_METRICS: "false",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
  });
  const output = execFileSync(
    process.execPath,
    [
      "node_modules/wrangler/bin/wrangler.js",
      "deploy",
      "--dry-run",
      "--config",
      configuration,
      "--outdir",
      join(root, "bundle"),
      "--metafile",
      join(root, "metadata.json"),
      "--var",
      `BUILD_REVISION:${revision}`,
    ],
    { encoding: "utf8", env: childEnvironment, timeout: 30000 },
  );
  process.stdout.write(output);
  metadata = JSON.parse(readFileSync(join(root, "metadata.json"), "utf8"));
  const sqlite = new Set(
    config.migrations.flatMap((m) => m.new_sqlite_classes),
  );
  mf = new Miniflare({
    ...convertV4MiniflareOptions({
      workers: [
        {
          name: config.name,
          modules: true,
          scriptPath: join(root, "bundle/device-service.js"),
          compatibilityDate: config.compatibility_date,
          compatibilityFlags: config.compatibility_flags,
          durableObjects: Object.fromEntries(
            config.durable_objects.bindings.map((binding) => [
              binding.name,
              {
                className: binding.class_name,
                useSQLite: sqlite.has(binding.class_name),
              },
            ]),
          ),
          bindings: { ...config.vars, BUILD_REVISION: revision },
        },
      ],
    }),
    resourcePersistencePath: join(root, "state"),
    resourceTmpPath: join(root, "tmp"),
  });
  await mf.ready;
});
after(async () => {
  await mf?.dispose();
  rmSync(root, { recursive: true, force: true });
});

test("the standalone deployment builds only device code and binds only its two SQLite DOs", async () => {
  assert.deepEqual(JSON.parse(readFileSync(configuration, "utf8")), {
    $schema: "node_modules/wrangler/config-schema.json",
    name: "eagle-devices",
    // The deployment is the owner's account (whatever wrangler is logged into) on its own
    // custom domain, never a `workers.dev` hostname and never a committed account id.
    main: "src/worker/device-service.ts",
    compatibility_date: "2026-09-19",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: "devices.example.com", custom_domain: true }],
    durable_objects: {
      bindings: [
        { name: "DEVICE_REGISTRY", class_name: "DeviceRegistry" },
        { name: "DEVICE_EXECUTION", class_name: "DeviceExecution" },
      ],
    },
    migrations: [
      { tag: "v1", new_sqlite_classes: ["DeviceRegistry", "DeviceExecution"] },
    ],
    vars: { BUILD_REVISION: "development" },
  });
  assert.deepEqual(
    Object.keys(metadata.inputs)
      .filter((path) => path.includes("src/worker/"))
      .map((path) => basename(path))
      .sort(),
    ["device-execution.ts", "device-registry.ts", "device-service.ts"],
  );
  const bundle = Object.entries(metadata.outputs).find(([path]) =>
    path.endsWith("/device-service.js"),
  );
  assert(bundle);
  assert.deepEqual(bundle[1].exports.sort(), [
    "DeviceExecution",
    "DeviceRegistry",
    "SyncCacheRegistry",
    "default",
  ]);
  assert.deepEqual(Object.keys(await mf.getBindings()).sort(), [
    "BUILD_REVISION",
    "DEVICE_EXECUTION",
    "DEVICE_REGISTRY",
  ]);
});

test("standalone health reports the product version and exact supplied revision without legacy bindings", async () => {
  const response = await mf.dispatchFetch(`${origin}/api/live`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "eagle-devices",
    version: JSON.parse(readFileSync("package.json", "utf8")).version,
    revision,
  });
});

test("standalone health rejects every method except GET", async () => {
  for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await mf.dispatchFetch(`${origin}/api/live`, { method });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "GET");
  }
});

test("standalone entry rejects unknown, legacy and near-prefix routes without assets or owner auth", async () => {
  for (const path of [
    "/",
    "/api/v1/machines",
    "/api/v1/reports",
    "/api/v1/realtime-agent",
    "/api/devices/v10/directory",
    "/api/live/",
  ])
    for (const method of ["GET", "POST"]) {
      const response = await mf.dispatchFetch(`${origin}${path}`, { method });
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.deepEqual(await response.json(), { error: "not_found" });
    }
});

async function call(path: string, token?: string, value?: unknown) {
  return mf.dispatchFetch(`${origin}/api/devices/v1${path}`, {
    method: value === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
}
async function identity(name: string) {
  const keys = generateKeyPairSync("ed25519");
  const deviceId = randomUUID();
  const publicKey = keys.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64url");
  const response = await call("/register/challenge", undefined, {
    deviceId,
    publicKey,
    name,
    platform: "darwin",
    arch: "arm64",
  });
  assert.equal(response.status, 200);
  const challenge = (await response.json()) as {
    challengeId: string;
    payload: string;
  };
  assert.equal(challenge.payload.split("\n")[1], origin);
  const registered = await call("/register/complete", undefined, {
    challengeId: challenge.challengeId,
    signature: sign(
      null,
      Buffer.from(challenge.payload),
      keys.privateKey,
    ).toString("base64url"),
  });
  assert.equal(registered.status, 200);
  const session = (await registered.json()) as { sessionToken: string };
  return { deviceId, token: session.sessionToken };
}

test("standalone routes reach the existing Registry and canonical per-device relay", {
  timeout: 10000,
}, async () => {
  const [a, b] = await Promise.all([identity("local-a"), identity("local-b")]);
  assert.equal((await call("/directory")).status, 401);
  const invitation = await call("/pairings", a.token, {});
  assert.equal(invitation.status, 200);
  const { code } = (await invitation.json()) as { code: string };
  const paired = await call("/pairings/redeem", b.token, {
    requestId: randomUUID(),
    code,
  });
  assert.equal(paired.status, 200);
  const path = `/execution/${b.deviceId.toUpperCase()}`;
  assert.equal((await call(`${path}/agent`)).status, 426);
  const agentResponse = await mf.dispatchFetch(
    `${origin}/api/devices/v1${path}/agent`,
    { headers: { Upgrade: "websocket" } },
  );
  assert.equal(agentResponse.status, 101);
  const agent = agentResponse.webSocket;
  assert(agent);
  agent.accept();
  const ready = new Promise<string>((resolve) => {
    agent.addEventListener("message", (event) => resolve(String(event.data)), {
      once: true,
    });
  });
  agent.send(
    JSON.stringify({
      type: "authenticate",
      sessionToken: b.token,
      capabilities: ["command"],
      policy: { mode: "all-approve", version: 1 },
    }),
  );
  assert.deepEqual(JSON.parse(await ready), { type: "ready" });
  const directory = await call("/directory", a.token);
  const devices = (await directory.json()) as {
    devices: { deviceId: string; online: boolean | null }[];
  };
  assert.deepEqual(
    devices.devices.map((d) => d.deviceId).sort(),
    [a.deviceId, b.deviceId].sort(),
  );
  assert.equal(
    devices.devices.find((d) => d.deviceId === b.deviceId)?.online,
    true,
  );
  const callerResponse = await mf.dispatchFetch(
    `${origin}/api/devices/v1${path}/request`,
    { headers: { Upgrade: "websocket" } },
  );
  assert.equal(callerResponse.status, 101);
  const caller = callerResponse.webSocket;
  assert(caller);
  caller.accept();
  const request = {
    requestId: randomUUID(),
    operationId: randomUUID(),
    targetDeviceId: b.deviceId,
    action: "get",
  };
  const result = { status: "unknown", error: "operation_not_found" };
  const response = new Promise<string>((resolve) => {
    caller.addEventListener("message", (event) => resolve(String(event.data)), {
      once: true,
    });
  });
  agent.addEventListener(
    "message",
    (event) => {
      const frame = JSON.parse(String(event.data)) as {
        type: string;
        sourceDeviceId: string;
        request: typeof request;
      };
      assert.equal(frame.type, "operation");
      assert.equal(frame.sourceDeviceId, a.deviceId);
      assert.notEqual(frame.request.requestId, request.requestId);
      agent.send(
        JSON.stringify({
          type: "result",
          requestId: frame.request.requestId,
          operationId: request.operationId,
          targetDeviceId: b.deviceId,
          result,
        }),
      );
    },
    { once: true },
  );
  caller.send(
    JSON.stringify({ type: "request", sessionToken: a.token, request }),
  );
  assert.deepEqual(JSON.parse(await response), {
    type: "response",
    requestId: request.requestId,
    operationId: request.operationId,
    targetDeviceId: b.deviceId,
    result,
  });
  caller.close();
  agent.close();
});
