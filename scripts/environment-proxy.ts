import { execFile } from "node:child_process";
import type { IncomingMessage } from "node:http";
import { promisify } from "node:util";
import type { ProxyOptions } from "vite";

const production = "https://eagle.hexly.ai";
const prefix = "/__local/prod";
const execute = promisify(execFile);

async function accessToken() {
  const { stdout } = await execute(
    "cloudflared",
    ["access", "token", "--app", production],
    { timeout: 5000, maxBuffer: 16384 },
  );
  return stdout.trim();
}

function allowed(request: IncomingMessage) {
  const host = request.headers.host ?? "";
  const origin =
    host === "eagle.dev.hexly.ai"
      ? `https://${host}`
      : /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)
        ? `http://${host}`
        : null;
  if (!origin) return false;
  if (request.headers.origin !== undefined) {
    if (request.headers.origin !== origin) return false;
  } else if (
    request.method !== "GET" ||
    request.headers.upgrade ||
    request.headers["sec-fetch-site"] !== "same-origin"
  ) {
    return false;
  }
  const path = (request.url ?? "").split("?")[0].slice(prefix.length);
  if (request.headers.upgrade)
    return request.method === "GET" && path === "/api/v1/realtime";
  return (
    ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(request.method ?? "") &&
    /^\/api\/v1\/(me|overview|resources|history|semantic-hours|summary-history|daily-reports(?:\/run)?|settings(?:\/test)?|machines(?:\/[a-z0-9][a-z0-9_-]{0,79}\/(?:rotate|revoke|rename))?)$/.test(
      path,
    )
  );
}

function sanitize(response: IncomingMessage) {
  for (const name of Object.keys(response.headers)) {
    if (
      name === "set-cookie" ||
      name === "location" ||
      name === "authorization" ||
      name.startsWith("cf-access-") ||
      name.startsWith("access-control-")
    )
      delete response.headers[name];
  }
  response.headers["cache-control"] = "no-store";
  if (
    (response.statusCode &&
      response.statusCode >= 300 &&
      response.statusCode < 400) ||
    response.headers["content-type"]?.includes("text/html")
  ) {
    response.statusCode = 401;
    response.statusMessage = "Unauthorized";
  }
}

export function productionProxy(
  target = production,
  token: () => Promise<string> = accessToken,
): ProxyOptions {
  return {
    target,
    ws: true,
    changeOrigin: true,
    secure: true,
    followRedirects: false,
    proxyTimeout: 800_000,
    rewrite: (path) => path.slice(prefix.length),
    async bypass(request, response) {
      let status = 403;
      if (allowed(request)) {
        try {
          const credential = await token();
          if (!/^[A-Za-z0-9._-]+$/.test(credential))
            throw new Error("No token");
          request.headers = Object.fromEntries(
            Object.entries(request.headers).filter(([name]) =>
              [
                "accept",
                "content-type",
                "content-length",
                "upgrade",
                "sec-websocket-key",
                "sec-websocket-version",
                "sec-websocket-extensions",
              ].includes(name),
            ),
          );
          if (request.headers.upgrade) request.headers.connection = "Upgrade";
          request.headers.origin = new URL(target).origin;
          request.headers.cookie = `CF_Authorization=${credential}`;
          return;
        } catch {
          status = 401;
        }
      }
      if (response) {
        response.writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        response.end(
          JSON.stringify({
            error:
              status === 401
                ? "Local production authentication required"
                : "Origin or endpoint not allowed",
          }),
        );
      } else {
        request.socket.end(
          `HTTP/1.1 ${status} Denied\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
      }
      return request.url ?? "/";
    },
    configure(proxy) {
      proxy.on("proxyRes", (upstream, _request, response) => {
        sanitize(upstream);
        if (upstream.statusCode === 401 || upstream.statusCode === 403) {
          response.writeHead(upstream.statusCode, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          response.end('{"error":"Production authentication required"}');
          upstream.resume();
        }
      });
      proxy.on("proxyReqWs", (request) => {
        request.on("upgrade", sanitize);
        request.on("response", sanitize);
      });
    },
  };
}
