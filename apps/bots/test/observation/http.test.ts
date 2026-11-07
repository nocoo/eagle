// The observation routes over a real loopback daemon (SG-002 protocol §2–§6): one
// credential, one direction each way, and readings that leave the stores alone.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  mintObservationCredential,
  readObservationCredential,
} from "../../src/observation/credential.ts";
import { decodeBaseline } from "../../src/observation/cursor.ts";
import {
  catalogDigest,
  createObservationRoutes,
  type ObservationRoutes,
} from "../../src/observation/routes.ts";
import { type Stack, startStack } from "../support/server.ts";

type ObservationBench = {
  readonly stack: Stack;
  readonly observationRoot: string;
  readonly token: string;
  readonly catalog: () => Promise<string>;
  get(
    path: string,
    options?: { token?: string; host?: string; origin?: string },
  ): Promise<{
    status: number;
    body: Record<string, unknown>;
  }>;
  post(
    path: string,
    body: unknown,
    token?: string,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  close(): Promise<void>;
};

const bench = async (storeDir?: string): Promise<ObservationBench> => {
  const observationRoot = await mkdtemp(join(tmpdir(), "bots-observe-"));
  const botsDir = storeDir ?? (await mkdtemp(join(tmpdir(), "bots-observe-bots-")));
  await mintObservationCredential(observationRoot);
  const credential = await readObservationCredential(observationRoot);
  assert.ok(credential !== undefined, "the observation credential was minted");

  let routes: ObservationRoutes | undefined;
  const stack = await startStack({
    real: true,
    observation: (state) => {
      const built = createObservationRoutes({
        root: observationRoot,
        version: "0.0.0-test",
        endpoint: () => `127.0.0.1:${state.port()}`,
        sessionPath: (botId) => join(botsDir, botId, "session.sqlite"),
        bots: () => [{ id: "b_probe", title: "Probe" }],
        catalogRevision: async () =>
          catalogDigest(await readFile(state.directory.catalogPath, "utf8").catch(() => "")),
        log: state.log,
      });
      routes = built;
      return built;
    },
  });
  assert.ok(routes !== undefined, "the routes were mounted");
  const call = async (
    path: string,
    init: { method?: string; body?: unknown; token?: string; host?: string; origin?: string } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await fetch(`http://127.0.0.1:${stack.port}${path}`, {
      method: init.method ?? "GET",
      headers: {
        host: init.host ?? `127.0.0.1:${stack.port}`,
        authorization: `Bearer ${init.token ?? credential.token}`,
        ...(init.origin === undefined ? {} : { origin: init.origin }),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return {
    stack,
    observationRoot,
    token: credential.token,
    catalog: async () => catalogDigest(await readFile(stack.directory.catalogPath, "utf8")),
    get: (path, options = {}) => call(path, options),
    post: (path, body, token) =>
      call(path, {
        method: "POST",
        body,
        ...(token === undefined ? {} : { token }),
      }),
    close: async () => {
      await stack.close();
      await rm(observationRoot, { recursive: true, force: true });
      await rm(botsDir, { recursive: true, force: true });
    },
  };
};

test("the observation credential works only on the observation routes, and the worker token not there", async () => {
  const opened = await bench();
  try {
    const wrongWay = await opened.get("/v1/bots", { token: opened.token });
    assert.equal(wrongWay.status, 403);
    const workerWay = await opened.get("/v1/observe/snapshot", { token: opened.stack.token });
    assert.equal(workerWay.status, 403);
    assert.equal((workerWay.body.error as Record<string, string>).code, "credential_kind");
    const missing = await fetch(`http://127.0.0.1:${opened.stack.port}/v1/observe/snapshot`, {
      headers: { host: `127.0.0.1:${opened.stack.port}` },
    });
    assert.equal(missing.status, 401);
    const unknown = await opened.get("/v1/observe/snapshot", {
      token: "not-the-observation-token",
    });
    assert.equal(
      unknown.status,
      403,
      "a valid-looking but wrong bearer is a credential-kind refusal",
    );
  } finally {
    await opened.close();
  }
});

test("a relay host and a browser origin are refused", async () => {
  const opened = await bench();
  try {
    const raw = await new Promise<number>((resolve, reject) => {
      const call = httpRequest(
        {
          host: "127.0.0.1",
          port: opened.stack.port,
          path: "/v1/observe/snapshot",
          headers: { host: "127.0.0.1:1", authorization: `Bearer ${opened.token}` },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      call.on("error", reject);
      call.end();
    });
    assert.equal(raw, 403, "a relay at another port cannot pass the Host check");
    const origin = await opened.get("/v1/observe/snapshot", { origin: "https://example.com" });
    assert.equal(origin.status, 403);
    assert.equal((origin.body.error as Record<string, string>).code, "origin_refused");
  } finally {
    await opened.close();
  }
});

test("a snapshot names every bot, its store state and a usable baseline", async () => {
  const opened = await bench();
  try {
    const snap = await opened.get("/v1/observe/snapshot");
    assert.equal(snap.status, 200);
    const bots = snap.body.bots as { botId: string; store: { state: string } }[];
    assert.deepEqual(
      bots.map((bot) => [bot.botId, bot.store.state]),
      [["b_probe", "session_missing"]],
      "a bot whose store was never opened is missing, not empty",
    );
    assert.equal(snap.body.truncated, false);
    assert.equal(snap.body.consistent, true);
    const source = snap.body.source as { id: string; epoch: string };
    const baseline = decodeBaseline(String(snap.body.cursor), {
      source: source.id,
      epoch: source.epoch,
    });
    assert.deepEqual(baseline.positions, {}, "an unreadable store has no position");
    assert.equal((snap.body.catalog as Record<string, unknown>).bots, 1);
  } finally {
    await opened.close();
  }
});

test("reads on a bot with no store still create nothing on disk", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "bots-observe-empty-"));
  const opened = await bench(storeDir);
  try {
    await opened.get("/v1/observe/snapshot");
    await opened.get("/v1/observe/history?botId=b_probe");
    assert.deepEqual(await readdir(storeDir), [], "a read never creates a store");
  } finally {
    await opened.close();
  }
});

test("history rejects an unknown bot, an unreadable store and an unknown parameter", async () => {
  const opened = await bench();
  try {
    const noBot = await opened.get("/v1/observe/history?botId=b_nope");
    assert.equal(noBot.status, 404);
    assert.equal((noBot.body.error as Record<string, string>).code, "unknown_bot");
    const missing = await opened.get("/v1/observe/history?botId=b_probe");
    assert.equal(missing.status, 503, "a bot without a store is unavailable, not empty");
    assert.equal((missing.body.store as Record<string, string>).state, "session_missing");
    const unknownParam = await opened.get("/v1/observe/history?botId=b_probe&nope=1");
    assert.equal(unknownParam.status, 422);
    assert.equal((unknownParam.body.error as Record<string, string>).code, "query_invalid");
  } finally {
    await opened.close();
  }
});

test("changes refuses a foreign baseline and a body that is not a baseline", async () => {
  const opened = await bench();
  try {
    await opened.stack.createBot("One");
    const snap = await opened.get("/v1/observe/snapshot");
    const baseline = String(snap.body.cursor);
    const foreign = await opened.post("/v1/observe/changes", { cursor: "eyJ2IjoxfQ" });
    assert.equal(foreign.status, 409);
    assert.equal((foreign.body.error as Record<string, string>).code, "cursor_invalid");
    const badLimit = await opened.post("/v1/observe/changes", { cursor: baseline, limit: 501 });
    assert.equal(badLimit.status, 422);
    const ok = await opened.post("/v1/observe/changes", { cursor: baseline, limit: 10 });
    assert.equal(ok.status, 200);
    const next = decodeBaseline(String((ok.body.next as Record<string, unknown>).cursor));
    assert.equal(next.catalog.length, 16, "the next baseline keeps a catalog revision");
  } finally {
    await opened.close();
  }
});
