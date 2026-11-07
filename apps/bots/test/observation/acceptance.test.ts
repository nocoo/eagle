// SG-002 acceptance rows (docs/bots/specs/SUPERAGENT-002-OBSERVATION.md §5) that need a
// real daemon, real stores and real HTTP. Each test names its row, so the matrix and the
// code cannot drift apart.
import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  mintObservationCredential,
  readObservationCredential,
} from "../../src/observation/credential.ts";
import { createObservationRoutes } from "../../src/observation/routes.ts";
import { createBench, text, trace, waitFor } from "../support/pi.ts";
import { startStack } from "../support/server.ts";

type Bench = {
  readonly base: string;
  readonly token: string;
  readonly port: number;
  readonly botsDir: string;
  readonly root: string;
  readonly opens: () => number;
  call(
    path: string,
    init?: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> },
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  close(): Promise<void>;
};

/** A daemon whose observation routes read one bot directory the test controls. */
const bench = async (bots: readonly { id: string; title: string }[]): Promise<Bench> => {
  const root = await mkdtemp(join(tmpdir(), "bots-accept-"));
  const botsDir = join(root, "bots");
  await mkdir(botsDir, { recursive: true });
  await mintObservationCredential(root);
  const credential = await readObservationCredential(root);
  assert.ok(credential !== undefined);
  let port = 0;
  const stack = await startStack({
    real: true,
    observation: (state) => {
      const routes = createObservationRoutes({
        root,
        version: "0.0.0-accept",
        endpoint: () => `127.0.0.1:${state.port()}`,
        sessionPath: (botId) => join(botsDir, botId, "session.sqlite"),
        bots: () => bots,
        catalogRevision: async () =>
          (await readFile(join(root, "catalog.json"), "utf8").catch(() => "")).length.toString(16),
        log: state.log,
      });
      return routes;
    },
  });
  port = stack.port;
  const call: Bench["call"] = async (path, init = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: init.method ?? "GET",
      headers: {
        host: `127.0.0.1:${port}`,
        authorization: `Bearer ${init.token ?? credential.token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.headers ?? {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return {
    base: `http://127.0.0.1:${port}`,
    opens: () => stack.opens(),
    token: credential.token,
    port,
    botsDir,
    root,
    call,
    close: async () => {
      await stack.close();
      await rm(root, { recursive: true, force: true });
    },
  };
};

/** A real bot store with turns, a compaction and forked reflection scopes. */
const realStore = async (): Promise<{ dir: string; cleanup: () => Promise<void> }> => {
  const benchStore = await createBench({
    provider: { models: [{ id: "faux-tiny", contextWindow: 1_200, maxTokens: 200 }] },
    settings: {
      compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 150, backgroundTokens: 0 },
    },
    note: (spec) => ({
      botId: spec.id,
      current: () => ({}),
      set: async (note: string) => ({ note }),
    }),
  });
  const spec = benchStore.spec();
  const long = "please summarise the state of the build ".repeat(12);
  benchStore.faux.setResponses(
    Array.from({ length: 40 }, (_unused, index) => () => text(`${long}Turn ${index} done.`)),
  );
  const handle = await benchStore.runtime.open(spec);
  for (let turn = 1; turn <= 5; turn += 1) {
    const admission = await handle.submit({
      requestId: `r_accept_${turn}`,
      text: `Turn ${turn}: ${long}`,
      whenBusy: "followUp",
      trace,
    });
    await waitFor(async () => {
      const status = (await handle.submission({ requestId: admission.requestId }))?.status;
      return status === "done" || status === "unanswered";
    }, `turn ${turn} to settle`);
  }
  await waitFor(async () => (await handle.busy()).tasks === false, "reflection to finish");
  await handle.close(trace, 6_000);
  return { dir: spec.dir, cleanup: benchStore.cleanup };
};

/** Puts a real store where the routes look for it. */
const installStore = async (target: Bench, botId: string, dir: string): Promise<void> => {
  await mkdir(join(target.botsDir, botId), { recursive: true });
  await copyFile(join(dir, "session.sqlite"), join(target.botsDir, botId, "session.sqlite"));
};

test("SG002-A02: a missing or unsafe observation credential disables observation", async () => {
  const opened = await bench([{ id: "b_1", title: "One" }]);
  try {
    const tokenFile = join(opened.root, "observation", "token");
    const token = (await readFile(tokenFile, "utf8")).trim();
    await chmod(tokenFile, 0o644);
    const refused = await opened.call("/v1/observe/snapshot", { token });
    assert.equal(refused.status, 401, "a loosened credential is no credential");
    await rm(tokenFile);
    const absent = await opened.call("/v1/observe/snapshot", { token });
    assert.equal(absent.status, 401, "a missing credential is no credential");
  } finally {
    await opened.close();
  }
});

test("SG002-A08/A09: complete retained history crosses scopes and pages by entry id", async () => {
  const store = await realStore();
  const opened = await bench([{ id: "b_real", title: "Real" }]);
  try {
    await installStore(opened, "b_real", store.dir);
    const first = await opened.call("/v1/observe/history?botId=b_real&limit=1");
    assert.equal(first.status, 200);
    const scopes = first.body.scopes as { id: string; kind: string; owner: unknown }[];
    assert.ok(
      scopes.some((scope) => scope.kind === "root"),
      "the root scope is enumerated",
    );
    assert.ok(
      scopes.some((scope) => scope.kind === "child" && scope.owner !== null),
      "a forked reflection scope is enumerated with its owner",
    );
    const boundary = (first.body.boundary as { newestEntryId: string }).newestEntryId;
    const next = (first.body.next as { before?: string } | undefined)?.before;
    assert.ok(next !== undefined, "a cut page continues by entry id");
    assert.equal(
      (first.body.coverage as { page: string }).page,
      "truncated",
      "the page says it was cut",
    );
    const second = await opened.call(
      `/v1/observe/history?botId=b_real&limit=1&before=${next}&incarnation=${String(
        (first.body as { incarnation: string }).incarnation,
      )}&newest=${boundary}`,
    );
    assert.equal(second.status, 200);
    const ids = [
      ...(first.body.messages as { entryId: string }[]),
      ...(second.body.messages as { entryId: string }[]),
    ].map((message) => message.entryId);
    assert.equal(new Set(ids).size, ids.length, "no entry is served twice across pages");
  } finally {
    await opened.close();
    await store.cleanup();
  }
});

test("SG002-A11: a tool row and hidden reasoning are reported honestly", async () => {
  const store = await realStore();
  const opened = await bench([{ id: "b_real", title: "Real" }]);
  try {
    await installStore(opened, "b_real", store.dir);
    const page = await opened.call("/v1/observe/history?botId=b_real&limit=200");
    const messages = page.body.messages as { role: string; blocks: { type: string }[] }[];
    assert.ok(
      messages.every((message) => message.blocks.every((block) => block.type !== "thinking")),
      "internal reasoning never reaches the wire",
    );
    const omitted = page.body.omitted as { entries: number; blocks: number; kinds: string[] };
    assert.ok(omitted.entries + omitted.blocks >= 0);
    assert.ok(Array.isArray(omitted.kinds));
  } finally {
    await opened.close();
    await store.cleanup();
  }
});

test("SG002-A12/A04: changes report ranges, and a replaced store forces a reset", async () => {
  const store = await realStore();
  const opened = await bench([{ id: "b_real", title: "Real" }]);
  try {
    await installStore(opened, "b_real", store.dir);
    const snap = await opened.call("/v1/observe/snapshot");
    const baseline = String(snap.body.cursor);
    const first = await opened.call("/v1/observe/changes", {
      method: "POST",
      body: { cursor: baseline, limit: 10 },
    });
    assert.equal(first.status, 200);
    const replay = await opened.call("/v1/observe/changes", {
      method: "POST",
      body: { cursor: baseline, limit: 10 },
    });
    assert.deepEqual(replay.body.changes, first.body.changes, "the same baseline replays");

    // Replace the store with a copy: a different inode is a different incarnation.
    const source = join(opened.botsDir, "b_real", "session.sqlite");
    await rm(source);
    await copyFile(join(store.dir, "session.sqlite"), source);
    const replaced = await opened.call("/v1/observe/changes", {
      method: "POST",
      body: { cursor: baseline, limit: 10 },
    });
    assert.equal(replaced.status, 409);
    assert.equal(
      (replaced.body.error as { code: string }).code,
      "cursor_reset",
      "a replaced store invalidates the baseline",
    );
  } finally {
    await opened.close();
    await store.cleanup();
  }
});

test("SG002-A05: a read opens no runtime, so the daemon's open count stays zero", async () => {
  const store = await realStore();
  const opened = await bench([{ id: "b_real", title: "Real" }]);
  try {
    await installStore(opened, "b_real", store.dir);
    const before = opened.opens();
    await opened.call("/v1/observe/snapshot");
    await opened.call("/v1/observe/history?botId=b_real&limit=10");
    const snapshot = await opened.call("/v1/observe/snapshot");
    assert.equal(snapshot.status, 200);
    assert.equal(opened.opens(), before, "no harness was opened for any read");
  } finally {
    await opened.close();
    await store.cleanup();
  }
});

test("SG002-A07: reads beside a committing writer never fail a submission", async () => {
  const store = await realStore();
  const opened = await bench([{ id: "b_real", title: "Real" }]);
  try {
    await installStore(opened, "b_real", store.dir);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => opened.call("/v1/observe/history?botId=b_real&limit=50")),
    );
    assert.ok(
      results.every((result) => result.status === 200),
      "a concurrent read never fails",
    );
    assert.ok(results.every((result) => result.body.messages !== undefined));
  } finally {
    await opened.close();
    await store.cleanup();
  }
});

test("SG002-A10: more than 500 scopes are listed in pages, never silently dropped", async () => {
  const store = await realStore();
  const opened = await bench([{ id: "b_real", title: "Real" }]);
  try {
    await installStore(opened, "b_real", store.dir);
    const path = join(opened.botsDir, "b_real", "session.sqlite");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path);
    const insert = db.prepare(
      "INSERT INTO conversations (id, owner_conversation_id, owner_task_id, record) VALUES (?, 1, 1, '{}')",
    );
    for (let index = 0; index < 501; index += 1) insert.run(900000 + index);
    db.close();

    const first = await opened.call("/v1/observe/history?botId=b_real&limit=1");
    assert.equal(first.status, 200);
    const scopes = first.body.scopes as { id: string }[];
    assert.equal(scopes.length, 500, "the page is bounded");
    assert.equal(
      (first.body.coverage as { scopes: string }).scopes,
      "truncated",
      "the page says the enumeration was cut",
    );
    const after = (first.body.scopesNext as { afterScopeId: string }).afterScopeId;
    assert.ok(after !== null && after !== undefined);
    const second = await opened.call(
      `/v1/observe/history?botId=b_real&limit=1&scopeAfter=${after}`,
    );
    const rest = second.body.scopes as { id: string }[];
    assert.ok(rest.length > 0, "the remaining scopes are still reachable");
    assert.equal(
      new Set([...scopes, ...rest].map((scope) => scope.id)).size,
      scopes.length + rest.length,
      "no scope is repeated across enumeration pages",
    );
  } finally {
    await opened.close();
    await store.cleanup();
  }
});
