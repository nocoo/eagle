import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { test } from "node:test";
import { createServer as createViteServer } from "vite";
import { WebSocket, WebSocketServer } from "ws";
import { productionProxy } from "../scripts/environment-proxy.ts";

test("production proxy scopes HTTP writes and websocket traffic to authenticated same-origin viewers", async (context) => {
  const requests: {
    path?: string;
    cookie?: string;
    origin?: string;
    authorization?: string;
    assertion?: string;
    body: string;
  }[] = [];
  const upstream = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({
      path: request.url,
      cookie: request.headers.cookie,
      origin: request.headers.origin,
      authorization: request.headers.authorization,
      assertion: request.headers["cf-access-jwt-assertion"] as
        | string
        | undefined,
      body,
    });
    if (request.url === "/api/v1/me?redirect=1") {
      response
        .writeHead(302, {
          Location: "https://login.invalid/",
          "Set-Cookie": "private=upstream",
        })
        .end();
      return;
    }
    response
      .writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": "private=upstream",
      })
      .end(JSON.stringify({ ok: true }));
  });
  const websockets = new WebSocketServer({ server: upstream });
  websockets.on("headers", (headers) =>
    headers.push("Set-Cookie: private=socket"),
  );
  websockets.on("connection", (socket, request) => {
    assert.equal(
      request.headers.cookie,
      "CF_Authorization=synthetic-access-token",
    );
    assert.equal(request.url, "/api/v1/realtime?machine=test");
    socket.on("message", (message) => socket.send(message));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert(address && typeof address !== "string");
  const target = `http://127.0.0.1:${address.port}`;
  let authenticated = true;
  const vite = await createViteServer({
    configFile: false,
    logLevel: "silent",
    server: {
      host: "127.0.0.1",
      port: 0,
      proxy: {
        "/__local/prod/": productionProxy(target, async () => {
          if (!authenticated) throw new Error("credential unavailable");
          return "synthetic-access-token";
        }),
      },
    },
  });
  context.after(async () => {
    await vite.close();
    for (const socket of websockets.clients) socket.terminate();
    websockets.close();
    upstream.closeAllConnections();
    upstream.close();
  });
  await vite.listen();
  const localAddress = vite.httpServer?.address();
  assert(localAddress && typeof localAddress !== "string");
  const origin = `http://127.0.0.1:${localAddress.port}`;
  const endpoint = `${origin}/__local/prod/api/v1/settings`;
  const sent = await fetch(endpoint, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      Cookie: "local=must-not-leak",
      Authorization: "Bearer must-not-leak",
      "Cf-Access-Jwt-Assertion": "must-not-leak",
    },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(sent.status, 200);
  assert.equal(sent.headers.get("set-cookie"), null);
  assert.deepEqual(requests[0], {
    path: "/api/v1/settings",
    cookie: "CF_Authorization=synthetic-access-token",
    origin: target,
    authorization: undefined,
    assertion: undefined,
    body: '{"enabled":true}',
  });
  assert.equal(
    (
      await fetch(endpoint, {
        method: "POST",
        headers: { Origin: "https://attacker.invalid" },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(endpoint)).status, 403);
  assert.equal(
    (
      await fetch(`${origin}/__local/prod/api/v1/reports`, {
        headers: { Origin: origin },
      })
    ).status,
    403,
  );
  assert.equal(requests.length, 1);
  assert.equal(
    (await fetch(endpoint, { headers: { "Sec-Fetch-Site": "same-origin" } }))
      .status,
    200,
  );
  const invalidHost = await new Promise<number>((resolve, reject) => {
    const probe = request(
      endpoint,
      { headers: { Origin: origin, Host: "attacker.invalid" } },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    probe.on("error", reject);
    probe.end();
  });
  assert.equal(invalidHost, 403);
  assert.equal(
    (await fetch(endpoint, { headers: { "Sec-Fetch-Site": "cross-site" } }))
      .status,
    403,
  );
  assert.equal(
    (
      await fetch(endpoint, {
        method: "POST",
        headers: { "Sec-Fetch-Site": "same-origin" },
      })
    ).status,
    403,
  );
  for (const operation of ["rotate", "revoke", "rename"]) {
    assert.equal(
      (
        await fetch(
          `${origin}/__local/prod/api/v1/machines/test/${operation}`,
          { method: "POST", headers: { Origin: origin } },
        )
      ).status,
      200,
    );
  }
  const denied = new WebSocket(endpoint.replace("http:", "ws:"), {
    origin: "https://attacker.invalid",
  });
  const deniedStatus = new Promise<number>((resolve) =>
    denied.once("unexpected-response", (_request, response) => {
      response.resume();
      denied.terminate();
      resolve(response.statusCode ?? 0);
    }),
  );
  denied.on("error", () => {});
  assert.equal(await deniedStatus, 403);
  const socket = new WebSocket(
    `${origin.replace("http:", "ws:")}/__local/prod/api/v1/realtime?machine=test`,
    { origin },
  );
  socket.on("upgrade", (response) =>
    assert.equal(response.headers["set-cookie"], undefined),
  );
  await once(socket, "open");
  const message = once(socket, "message");
  socket.send("synthetic terminal input");
  assert.equal(String((await message)[0]), "synthetic terminal input");
  socket.close();
  await once(socket, "close");
  const redirect = await fetch(`${origin}/__local/prod/api/v1/me?redirect=1`, {
    headers: { Origin: origin },
    redirect: "manual",
  });
  assert.equal(redirect.status, 401);
  assert.equal(redirect.headers.get("location"), null);
  authenticated = false;
  assert.equal(
    (await fetch(endpoint, { headers: { Origin: origin } })).status,
    401,
  );
  assert.equal(requests.length, 6);
});
