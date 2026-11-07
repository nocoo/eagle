import { createServer } from "node:http";
import { closeServer, listen, ownRoot, serverProof } from "./identity.ts";

export async function startService(options: { root: string; port: number }) {
  const owner = await ownRoot(options.root);
  let port = 0;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    const reply = (status: number, body: unknown) => {
      response.writeHead(status);
      response.end(JSON.stringify(body));
    };
    if (
      request.headers["transfer-encoding"] !== undefined ||
      (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0")
    ) {
      response.setHeader("connection", "close");
      reply(413, { error: "body_refused" });
      return;
    }
    if (
      request.headers.origin !== undefined ||
      !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(request.headers.host ?? "")
    ) {
      reply(403, { error: "origin_refused" });
      return;
    }
    if (request.method !== "GET" || request.url !== "/v1/health") {
      reply(404, { error: "not_found" });
      return;
    }
    const nonce = request.headers["x-eagle-challenge"];
    if (nonce !== undefined && (typeof nonce !== "string" || !/^[0-9a-f]{32,64}$/.test(nonce))) {
      reply(400, { error: "invalid_challenge" });
      return;
    }
    reply(200, {
      ...owner.identity,
      modelReady: false,
      ...(nonce === undefined
        ? {}
        : { proof: serverProof(owner.token, nonce, port, owner.identity) }),
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  try {
    port = await listen(server, options.port);
  } catch (error) {
    await owner.release();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    port,
    identity: owner.identity,
    close() {
      closing ??= (async () => {
        server.closeAllConnections();
        await closeServer(server);
        await owner.release();
      })();
      return closing;
    },
  };
}
