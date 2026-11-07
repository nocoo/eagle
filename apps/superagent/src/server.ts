import { createServer } from "node:http";
import { closeServer, listen, ownRoot, serverProof } from "./identity.ts";
import { ChatRuntime, markInitialized } from "./runtime.ts";
import { allowedRequest, attachSockets } from "./socket.ts";

export async function startService(options: {
  root: string;
  port: number;
  openRuntime?: (root: string) => Promise<ChatRuntime>;
}) {
  const owner = await ownRoot(options.root);
  let runtime: ChatRuntime | undefined;
  try {
    runtime = await (options.openRuntime ?? ChatRuntime.open)(owner.root);
    await markInitialized(owner.root, owner.identity.storeId);
  } catch (error) {
    await runtime?.close().catch(() => undefined);
    await owner.release();
    throw error;
  }
  if (runtime === undefined) throw new Error("runtime_missing");
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
    if (!allowedRequest(request)) {
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
      modelReady: runtime.snapshot().modelReady,
      ...(runtime.snapshot().failure === undefined ? {} : { failure: runtime.snapshot().failure }),
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
    await runtime.close();
    await owner.release();
    throw error;
  }
  const closeSockets = attachSockets(server, {
    token: owner.token,
    identity: owner.identity,
    port,
    runtime,
  });
  let closing: Promise<void> | undefined;
  return {
    port,
    identity: owner.identity,
    close() {
      closing ??= (async () => {
        const httpClosed = closeServer(server);
        server.closeAllConnections();
        await closeSockets();
        await httpClosed;
        await runtime.close();
        await owner.release();
      })();
      return closing;
    },
  };
}
