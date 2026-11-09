import { createServer } from "node:http";
import { AnalysisStore } from "./analysis.ts";
import { Analyzer } from "./analyze.ts";
import { AttentionStore } from "./attention.ts";
import { closeServer, listen, ownRoot, serverProof } from "./identity.ts";
import { createManage, type ManageOptions } from "./manage.ts";
import { ObservationClient } from "./observation.ts";
import { ChatRuntime, markInitialized } from "./runtime.ts";
import { allowedRequest, attachSockets } from "./socket.ts";
import { Watcher, type WatchMode } from "./watch.ts";

export type ProactiveOptions = {
  readonly mode: WatchMode;
  readonly intervalMs: number;
  /** SG-003: how long one Bot waits between suggestions. */
  readonly analysisCooldownMs?: number;
  /** The watcher keeps its own baseline; the App's `observe-changes` keeps another. */
  readonly observation?: ObservationClient;
  readonly manage?: ManageOptions;
};

export async function startService(options: {
  root: string;
  port: number;
  openRuntime?: (root: string) => Promise<ChatRuntime>;
  /** SG-002: the daemon observation client; absent leaves the commands unconfigured. */
  observation?: ObservationClient;
  /** SG-004: the proactive watcher; absent leaves the attention commands unconfigured. */
  proactive?: ProactiveOptions;
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
  // SG-002: an unconfigured consumer answers "unconfigured" without touching the network.
  const observation =
    options.observation ?? new ObservationClient({ root: owner.root, endpoint: "", tokenFile: "" });
  const mode: { current: WatchMode } = { current: options.proactive?.mode ?? "off" };
  const store = options.proactive === undefined ? undefined : new AttentionStore(owner.root);
  const analysis =
    options.proactive === undefined ||
    store === undefined ||
    options.proactive.observation === undefined
      ? undefined
      : new Analyzer({
          store: new AnalysisStore(owner.root),
          attention: store,
          history: async (botId) => {
            const read = await options.proactive?.observation?.history({ botId, limit: 10 });
            return read?.history ?? null;
          },
          generate: (prompt) => runtime.generateText(prompt),
          now: () => new Date(),
          cooldownMs: options.proactive.analysisCooldownMs ?? 900_000,
        });

  const watcher =
    options.proactive === undefined ||
    store === undefined ||
    options.proactive.observation === undefined
      ? undefined
      : new Watcher({
          observation: options.proactive.observation,
          store,
          now: () => new Date(),
          intervalMs: Math.max(options.proactive.intervalMs, 15_000),
          stallAfterMs: 600_000,
          reopenAfterMs: 900_000,
          reportBudgetMs: 1_800_000,
          actionCooldownMs: 900_000,
          maxActionsPerHour: 6,
          get mode() {
            return mode.current;
          },
          report: (prompt) => runtime.report(prompt),
          afterTick: async () => {
            if (mode.current === "off") return;
            await analysis?.analyzeOne();
          },
          ...(options.proactive.manage === undefined
            ? {}
            : { manage: createManage(options.proactive.manage) }),
        });
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
    observation,
    ...(store === undefined
      ? {}
      : {
          proactive: {
            store,
            mode: () => mode.current,
            setMode: (next: WatchMode) => {
              mode.current = next;
            },
          },
        }),
    ...(analysis === undefined ? {} : { analysis }),
  });
  watcher?.start();
  let closing: Promise<void> | undefined;
  return {
    port,
    identity: owner.identity,
    /** SG-004: exposed so a test or an operator can drive one pass without waiting. */
    watcher,
    close() {
      closing ??= (async () => {
        watcher?.stop();
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
