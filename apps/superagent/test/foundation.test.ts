import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { Identity } from "../src/identity.ts";
import { closeServer, listen } from "../src/identity.ts";
import { startService as startServer } from "../src/server.ts";

const owned = new Map<string, Awaited<ReturnType<typeof startServer>>[]>();
async function startService(options: Parameters<typeof startServer>[0]) {
  const service = await startServer(options);
  const services = owned.get(options.root) ?? [];
  services.push(service);
  owned.set(options.root, services);
  return service;
}
async function temporary(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "eagle-superagent-test-"));
  t.after(async () => {
    for (const service of owned.get(root) ?? []) await service.close();
    owned.delete(root);
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("SG001-A01: standalone service is ready without workers or model configuration", async (t) => {
  const root = await temporary(t);
  const service = await startService({ root, port: 0 });
  t.after(() => service.close());
  const response = await fetch(`http://127.0.0.1:${service.port}/v1/health`);
  const health = (await response.json()) as Identity & { modelReady: boolean };
  assert.equal(health.service, "eagle-superagent");
  assert.equal(health.protocolVersion, 1);
  assert.equal(health.modelReady, false);
  assert.equal(health.pid, process.pid);
  assert.match(health.instance, /^[0-9a-f-]{36}$/);
  assert.match(health.rootBinding, /^[0-9a-f]{64}$/);
  assert.equal((await stat(join(root, "token"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, "identity.json"))).mode & 0o777, 0o600);
});

test("SG001-A02: root ownership is exclusive across different service ports", async (t) => {
  const root = await temporary(t);
  const first = await startService({ root, port: 0 });
  t.after(() => first.close());
  await assert.rejects(async () => {
    await (await startService({ root, port: 0 })).close();
  }, /root_locked/);
});

test("SG001-A07: restart retains identity and credentials but changes instance", async (t) => {
  const root = await temporary(t);
  const first = await startService({ root, port: 0 });
  t.after(() => first.close());
  const before = (await (
    await fetch(`http://127.0.0.1:${first.port}/v1/health`)
  ).json()) as Identity;
  const token = await readFile(join(root, "token"), "utf8");
  await first.close();
  const second = await startService({ root, port: 0 });
  t.after(() => second.close());
  const after = (await (
    await fetch(`http://127.0.0.1:${second.port}/v1/health`)
  ).json()) as Identity;
  assert.equal(before.storeId, after.storeId);
  assert.equal(before.rootBinding, after.rootBinding);
  assert.notEqual(before.instance, after.instance);
  assert.equal(token, await readFile(join(root, "token"), "utf8"));
});

test("health proves possession of this root credential without disclosing it", async (t) => {
  const root = await temporary(t);
  const service = await startService({ root, port: 0 });
  t.after(() => service.close());
  const nonce = "a".repeat(32);
  const response = await fetch(`http://127.0.0.1:${service.port}/v1/health`, {
    headers: { "x-eagle-challenge": nonce },
  });
  const body = await response.text();
  const health = JSON.parse(body);
  const token = (await readFile(join(root, "token"), "utf8")).trim();
  assert.equal(
    health.proof,
    createHmac("sha256", token)
      .update(`${nonce}\n127.0.0.1:${service.port}\n${health.rootBinding}\n${health.instance}`)
      .digest("hex"),
  );
  assert.equal(body.includes(token), false);
  assert.equal(body.includes(root), false);
});

test("two different roots are never refused for sharing a port", async (t) => {
  // The lock names the owner's port, so the kernel decides: two roots cannot collide.
  const roots = await Promise.all([
    mkdtemp(join(tmpdir(), "superagent-a-")),
    mkdtemp(join(tmpdir(), "superagent-b-")),
  ]);
  t.after(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });
  const services = await Promise.all(roots.map((root) => startService({ root, port: 0 })));
  t.after(async () => {
    for (const service of services) await service.close();
  });
  assert.deepEqual(
    services.map((service) => service.port > 0),
    [true, true],
  );
});

test("two concurrent owners of one root: exactly one keeps it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "superagent-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const results = await Promise.allSettled([
    startServer({ root, port: 0 }),
    startServer({ root, port: 0 }),
  ]);
  const owned = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  t.after(async () => {
    for (const service of owned) await service.close();
  });
  assert.equal(owned.length, 1, "one start owns the root");
  const refused = results.find((result) => result.status === "rejected");
  assert.match(String(refused?.status === "rejected" ? refused.reason : ""), /root_locked/);
});

test("a lock file another account can read is refused, never trusted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "superagent-loose-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "lock.json"), JSON.stringify({ port: 1, pid: 1 }), { mode: 0o644 });
  await assert.rejects(() => startServer({ root, port: 0 }), /unsafe_private_file/);
});

test("a lock left by a crashed owner is replaced", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "superagent-stale-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Bind and release a port so the file names one that nobody answers any more.
  const probe = createServer((socket) => socket.destroy());
  const port = await listen(probe, 0);
  await closeServer(probe);
  await writeFile(join(root, "lock.json"), JSON.stringify({ port, pid: 1 }), { mode: 0o600 });
  const service = await startService({ root, port: 0 });
  t.after(() => service.close());
  assert.ok(service.port > 0);
});

test("foreign or corrupt storage is refused without replacing its files", async (t) => {
  const root = await temporary(t);
  await writeFile(join(root, "catalog.json"), "foreign");
  await assert.rejects(async () => {
    await (await startService({ root, port: 0 })).close();
  }, /foreign_root/);
  // The rejected start released its own lock: nothing but the foreign file is left.
  assert.deepEqual(await readdir(root), ["catalog.json"]);
  await rm(join(root, "catalog.json"));
  await writeFile(join(root, "identity.json"), "broken", { mode: 0o600 });
  await assert.rejects(async () => {
    await (await startService({ root, port: 0 })).close();
  }, /invalid_identity/);
  assert.equal(await readFile(join(root, "identity.json"), "utf8"), "broken");
});

test("unsafe existing token is refused, not repaired", async (t) => {
  const root = await temporary(t);
  const first = await startService({ root, port: 0 });
  await first.close();
  await chmod(join(root, "token"), 0o644);
  await assert.rejects(async () => {
    await (await startService({ root, port: 0 })).close();
  }, /unsafe_token/);
  assert.equal((await stat(join(root, "token"))).mode & 0o777, 0o644);
});

test("browser origins, foreign hosts, malformed challenges and unknown routes are refused", async (t) => {
  const root = await temporary(t);
  const service = await startService({ root, port: 0 });
  t.after(() => service.close());
  const url = `http://127.0.0.1:${service.port}`;
  assert.equal(
    (await fetch(`${url}/v1/health`, { headers: { origin: "https://example.com" } })).status,
    403,
  );
  const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(
      `${url}/v1/health`,
      { headers: { host: "example.com" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on("error", reject);
    request.end();
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal(
    (await fetch(`${url}/v1/health`, { headers: { "x-eagle-challenge": "bad" } })).status,
    400,
  );
  assert.equal((await fetch(`${url}/v1/bots`, { method: "DELETE" })).status, 404);
});
