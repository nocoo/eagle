import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { test } from "node:test";
import { promisify } from "node:util";

test("CLI networking defaults to direct and supports an explicit environment proxy", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "eagle-network-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let reports = 0;
  const origin = createServer((request, response) => {
    assert.equal(request.url, "/api/v1/heartbeat");
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    reports++;
    request.resume();
    response.end("{}");
  });
  let proxied = 0;
  const tunnels = new Set<Duplex>();
  const proxy = createServer((request, response) => {
    assert.equal(
      request.url,
      tunnels.has(request.socket)
        ? "/api/v1/heartbeat"
        : `http://127.0.0.1:${port}/api/v1/heartbeat`,
    );
    assert.equal(request.headers.host, `127.0.0.1:${port}`);
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    proxied++;
    request.resume();
    response.end("{}");
  });
  proxy.on("connect", (request, socket, head) => {
    assert.equal(request.url, `127.0.0.1:${port}`);
    tunnels.add(socket);
    socket.on("close", () => tunnels.delete(socket));
    socket.pause();
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    proxy.emit("connection", socket);
    if (head.length) socket.unshift(head);
    socket.resume();
  });
  t.after(() => {
    for (const socket of tunnels) socket.destroy();
    origin.closeAllConnections();
    proxy.closeAllConnections();
    origin.close();
    proxy.close();
  });
  await new Promise<void>((done) => origin.listen(0, "127.0.0.1", done));
  await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
  const address = origin.address();
  const proxyAddress = proxy.address();
  assert(address && typeof address !== "string");
  assert(proxyAddress && typeof proxyAddress !== "string");
  const port = address.port;
  const token = "test-network-secret-at-least-32-characters";
  const config = join(directory, "agent.json");
  await writeFile(
    config,
    JSON.stringify({
      url: `http://127.0.0.1:${port}`,
      token,
      machineId: "network-test",
      machineName: "Network test",
    }),
    { mode: 0o600 },
  );
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/proxy/i.test(key) || key === "NODE_OPTIONS") delete env[key];
  const run = (proxyEnv: Record<string, string>) =>
    promisify(execFile)(
      process.execPath,
      [resolve("agent/cli.ts"), "heartbeat"],
      { env: { ...env, EAGLE_CONFIG: config, ...proxyEnv }, timeout: 5000 },
    );
  await run({});
  assert.equal(reports, 1);
  assert.equal(proxied, 0);
  const proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;
  await run({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: proxyUrl });
  assert.equal(reports, 1);
  assert.equal(proxied, 1);
  await run({ NODE_USE_ENV_PROXY: "0", HTTP_PROXY: proxyUrl });
  assert.equal(reports, 2);
  assert.equal(proxied, 1);
});
