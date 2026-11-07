// SG-002 consumer (docs/bots/specs/SUPERAGENT-002-PROTOCOL.md §10): the Superagent reads
// the daemon's observation routes over HTTP with its own credential, and keeps the
// baseline it is allowed to continue from.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ObservationClient, readObservationToken } from "../src/observation.ts";

type Call = { readonly path: string; readonly body: unknown };

const PROVIDER_SOURCE = { id: "8f2a1c0d9be4f7a1", epoch: "6f1c2a90-1c1b-4a55-9a13-0d1e2f3a4b5c" };

const provider = async (options: {
  readonly status?: number;
  readonly code?: string;
  readonly body?: unknown;
}): Promise<{ port: number; calls: Call[]; close: () => Promise<void> }> => {
  const calls: Call[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      calls.push({
        path: request.url ?? "",
        body: chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      response.setHeader("content-type", "application/json");
      response.statusCode = options.status ?? 200;
      response.end(JSON.stringify(options.body ?? { ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const bench = async (): Promise<{
  root: string;
  tokenFile: string;
  close: () => Promise<void>;
}> => {
  const root = await mkdtemp(join(tmpdir(), "superagent-observe-"));
  const tokenFile = join(root, "observation-token");
  await writeFile(tokenFile, `${"t".repeat(40)}\n`, { mode: 0o600 });
  return {
    root,
    tokenFile,
    close: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
};

test("without a credential every command answers unconfigured and calls nothing", async () => {
  const opened = await bench();
  const remote = await provider({});
  try {
    const client = new ObservationClient({
      root: opened.root,
      endpoint: `http://127.0.0.1:${remote.port}`,
      tokenFile: join(opened.root, "absent-token"),
    });
    const result = await client.snapshot();
    assert.equal(result.provider.state, "unconfigured");
    assert.equal(result.snapshot, null);
    assert.equal(remote.calls.length, 0, "no credential means no request");
  } finally {
    await remote.close();
    await opened.close();
  }
});

test("a snapshot stores the baseline it may continue from", async () => {
  const opened = await bench();
  const remote = await provider({
    body: {
      protocolVersion: 1,
      kind: "snapshot",
      source: PROVIDER_SOURCE,
      catalog: { revision: "a1b2c3d4e5f60718", bots: 1 },
      consistent: true,
      bots: [{ botId: "b_3f1a", store: { state: "available" }, coverage: { entries: 28 } }],
      botsTotal: 1,
      truncated: false,
      cursor: "eyJ2IjoxfQ",
      lag: 0,
    },
  });
  try {
    const client = new ObservationClient({
      root: opened.root,
      endpoint: `http://127.0.0.1:${remote.port}`,
      tokenFile: opened.tokenFile,
    });
    const result = await client.snapshot();
    assert.equal(result.provider.state, "ready");
    assert.equal(result.provider.unavailable, 0);
    const stored = JSON.parse(
      await readFile(join(opened.root, "observation-state.json"), "utf8"),
    ) as {
      baseline: { cursor: string; catalog: string };
    };
    assert.equal(stored.baseline.cursor, "eyJ2IjoxfQ");
    assert.equal(stored.baseline.catalog, "a1b2c3d4e5f60718");
  } finally {
    await remote.close();
    await opened.close();
  }
});

test("changes sends the stored baseline as its body and commits the next one", async () => {
  const opened = await bench();
  const remote = await provider({
    body: {
      protocolVersion: 1,
      kind: "changes",
      source: PROVIDER_SOURCE,
      changes: [
        {
          kind: "history_appended",
          botId: "b_3f1a",
          scopeId: "c_1",
          from: "e_71",
          to: "e_91",
          entries: 21,
        },
      ],
      next: { cursor: "eyJuZXh0IjoxfQ" },
      coverage: { complete: true, reasons: [] },
    },
  });
  try {
    await writeFile(
      join(opened.root, "observation-state.json"),
      JSON.stringify({
        baseline: {
          source: PROVIDER_SOURCE,
          catalog: "a1b2c3d4e5f60718",
          positions: {},
          cursor: "eyJvbGQiOjF9",
        },
        state: "ready",
        unavailable: 0,
      }),
    );
    const client = new ObservationClient({
      root: opened.root,
      endpoint: `http://127.0.0.1:${remote.port}`,
      tokenFile: opened.tokenFile,
    });
    const result = await client.changes(10);
    assert.equal(result.provider.state, "ready");
    assert.deepEqual(remote.calls[0]?.body, { cursor: "eyJvbGQiOjF9", limit: 10 });
    const stored = JSON.parse(
      await readFile(join(opened.root, "observation-state.json"), "utf8"),
    ) as {
      baseline: { cursor: string };
      lastReadAt?: string;
    };
    assert.equal(stored.baseline.cursor, "eyJuZXh0IjoxfQ", "the next baseline is committed");
    assert.ok(stored.lastReadAt !== null);
  } finally {
    await remote.close();
    await opened.close();
  }
});

test("a provider reset drops the stale baseline instead of continuing it", async () => {
  const opened = await bench();
  const remote = await provider({
    status: 409,
    body: { protocolVersion: 1, error: { code: "cursor_reset", detail: "epoch changed" } },
  });
  try {
    await writeFile(
      join(opened.root, "observation-state.json"),
      JSON.stringify({
        baseline: { source: PROVIDER_SOURCE, catalog: "c", positions: {}, cursor: "eyJvbGQiOjF9" },
        state: "ready",
        unavailable: 0,
      }),
    );
    const client = new ObservationClient({
      root: opened.root,
      endpoint: `http://127.0.0.1:${remote.port}`,
      tokenFile: opened.tokenFile,
    });
    const result = await client.changes();
    assert.equal(result.provider.state, "reset");
    assert.equal(result.changes, null);
    const stored = JSON.parse(
      await readFile(join(opened.root, "observation-state.json"), "utf8"),
    ) as {
      baseline: unknown;
      state: string;
    };
    assert.equal(stored.baseline, null, "the stale baseline is gone");
    assert.equal(stored.state, "reset");
  } finally {
    await remote.close();
    await opened.close();
  }
});

test("a refused credential and an unreachable endpoint are distinct states", async () => {
  const opened = await bench();
  const refused = await provider({
    status: 403,
    body: { protocolVersion: 1, error: { code: "credential_kind", detail: "wrong route" } },
  });
  try {
    const client = new ObservationClient({
      root: opened.root,
      endpoint: `http://127.0.0.1:${refused.port}`,
      tokenFile: opened.tokenFile,
    });
    assert.equal((await client.snapshot()).provider.state, "refused");
    const gone = new ObservationClient({
      root: opened.root,
      endpoint: "http://127.0.0.1:1",
      tokenFile: opened.tokenFile,
    });
    assert.equal((await gone.snapshot()).provider.state, "unreachable");
  } finally {
    await refused.close();
    await opened.close();
  }
});

test("an unsafe credential file is not a credential", async () => {
  const opened = await bench();
  try {
    const loose = join(opened.root, "loose-token");
    await writeFile(loose, `${"t".repeat(40)}\n`, { mode: 0o644 });
    assert.equal(await readObservationToken(loose), undefined);
    assert.equal(await readObservationToken(join(opened.root, "absent")), undefined);
    assert.equal(await readObservationToken(opened.tokenFile), "t".repeat(40));
  } finally {
    await opened.close();
  }
});

test("history asks for one page and reports readiness", async () => {
  const opened = await bench();
  const remote = await provider({
    body: {
      protocolVersion: 1,
      kind: "history",
      source: PROVIDER_SOURCE,
      botId: "b_3f1a",
      scopes: [{ id: "c_1", kind: "root", entries: 23 }],
      messages: [],
      coverage: { scopes: "complete", page: "complete", content: "complete", reasons: [] },
    },
  });
  try {
    const client = new ObservationClient({
      root: opened.root,
      endpoint: `http://127.0.0.1:${remote.port}`,
      tokenFile: opened.tokenFile,
    });
    const result = await client.history({
      botId: "b_3f1a",
      scope: "c_1",
      before: "e_91",
      limit: 5,
    });
    assert.equal(result.provider.state, "ready");
    assert.match(remote.calls[0]?.path ?? "", /botId=b_3f1a/);
    assert.match(remote.calls[0]?.path ?? "", /limit=5/);
  } finally {
    await remote.close();
    await opened.close();
  }
});

test("changes without a baseline asks for a snapshot instead of guessing", async () => {
  const opened = await bench();
  const remote = await provider({});
  try {
    const client = new ObservationClient({
      root: opened.root,
      endpoint: `http://127.0.0.1:${remote.port}`,
      tokenFile: opened.tokenFile,
    });
    const result = await client.changes();
    assert.equal(result.provider.state, "reset");
    assert.equal(result.provider.detail, "no_baseline");
    assert.equal(remote.calls.length, 0, "a reset needs no provider call");
  } finally {
    await remote.close();
    await opened.close();
  }
});

test("a snapshot without a usable baseline keeps no cursor", async () => {
  const opened = await bench();
  const remote = await provider({
    body: { protocolVersion: 1, kind: "snapshot", source: PROVIDER_SOURCE, bots: [], botsTotal: 0 },
  });
  try {
    const client = new ObservationClient({
      root: opened.root,
      endpoint: `http://127.0.0.1:${remote.port}`,
      tokenFile: opened.tokenFile,
    });
    const result = await client.snapshot();
    assert.equal(result.provider.state, "ready");
    const stored = JSON.parse(
      await readFile(join(opened.root, "observation-state.json"), "utf8"),
    ) as {
      baseline: unknown;
    };
    assert.equal(stored.baseline, null, "a response without a cursor never becomes a baseline");
  } finally {
    await remote.close();
    await opened.close();
  }
});

test("a corrupt state file starts clean rather than trusting it", async () => {
  const opened = await bench();
  const remote = await provider({});
  try {
    await writeFile(join(opened.root, "observation-state.json"), "{ this is not json");
    const client = new ObservationClient({
      root: opened.root,
      endpoint: `http://127.0.0.1:${remote.port}`,
      tokenFile: opened.tokenFile,
    });
    const result = await client.changes();
    assert.equal(result.provider.state, "reset");
    assert.equal(result.provider.detail, "no_baseline");
  } finally {
    await remote.close();
    await opened.close();
  }
});

test("unavailable bots are counted, and an unknown failure stays internal", async () => {
  const opened = await bench();
  const remote = await provider({
    body: {
      protocolVersion: 1,
      kind: "snapshot",
      source: PROVIDER_SOURCE,
      catalog: { revision: "a1b2c3d4e5f60718", bots: 2 },
      bots: [
        { botId: "b_a", store: { state: "available" } },
        { botId: "b_b", store: { state: "session_missing" } },
      ],
      cursor: "eyJ2IjoxfQ",
    },
  });
  const failing = await provider({
    status: 500,
    body: { protocolVersion: 1, error: { code: "unexpected", detail: "noise" } },
  });
  const relay = await provider({
    status: 403,
    body: { protocolVersion: 1, error: { code: "host_refused", detail: "relay" } },
  });
  try {
    const client = new ObservationClient({
      root: opened.root,
      endpoint: `http://127.0.0.1:${remote.port}`,
      tokenFile: opened.tokenFile,
    });
    const result = await client.snapshot();
    assert.equal(result.provider.unavailable, 1, "a missing store counts as unavailable");
    assert.ok(result.provider.lastReadAt !== null);
    assert.equal(
      (
        await new ObservationClient({
          root: opened.root,
          endpoint: `http://127.0.0.1:${failing.port}`,
          tokenFile: opened.tokenFile,
        }).snapshot()
      ).provider.state,
      "internal",
    );
    assert.equal(
      (
        await new ObservationClient({
          root: opened.root,
          endpoint: `http://127.0.0.1:${relay.port}`,
          tokenFile: opened.tokenFile,
        }).snapshot()
      ).provider.state,
      "unreachable",
    );
  } finally {
    await remote.close();
    await failing.close();
    await relay.close();
    await opened.close();
  }
});

test("the smallest request shapes still work, and a changes page without a cursor clears the baseline", async () => {
  const opened = await bench();
  const history = await provider({
    body: {
      protocolVersion: 1,
      kind: "history",
      source: PROVIDER_SOURCE,
      messages: [],
      coverage: {},
    },
  });
  const changes = await provider({
    body: {
      protocolVersion: 1,
      kind: "changes",
      source: PROVIDER_SOURCE,
      changes: [],
      coverage: { complete: false },
    },
  });
  try {
    await writeFile(
      join(opened.root, "observation-state.json"),
      JSON.stringify({
        baseline: { source: PROVIDER_SOURCE, catalog: "c", positions: {}, cursor: "eyJvbGQiOjF9" },
        state: "ready",
        unavailable: 0,
      }),
    );
    const reading = new ObservationClient({
      root: opened.root,
      endpoint: `http://127.0.0.1:${history.port}`,
      tokenFile: opened.tokenFile,
    });
    assert.equal((await reading.history({ botId: "b_3f1a" })).provider.state, "ready");
    assert.equal(history.calls[0]?.path, "/v1/observe/history?botId=b_3f1a");

    const writing = new ObservationClient({
      root: opened.root,
      endpoint: `http://127.0.0.1:${changes.port}`,
      tokenFile: opened.tokenFile,
    });
    assert.equal((await writing.changes()).provider.state, "ready");
    assert.deepEqual(changes.calls[0]?.body, { cursor: "eyJvbGQiOjF9" });
    const stored = JSON.parse(
      await readFile(join(opened.root, "observation-state.json"), "utf8"),
    ) as {
      baseline: unknown;
    };
    assert.equal(stored.baseline, null, "a page without a next cursor leaves no baseline");
  } finally {
    await history.close();
    await changes.close();
    await opened.close();
  }
});

test("a directory is not a token, null state is ignored, and a non-JSON reply is typed", async () => {
  const opened = await bench();
  const broken = createServer((_request, response) => {
    response.statusCode = 200;
    response.end("not json");
  });
  await new Promise<void>((resolve) => broken.listen(0, "127.0.0.1", resolve));
  const address = broken.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    assert.equal(await readObservationToken(opened.root), undefined, "a directory is not a file");
    await writeFile(join(opened.root, "observation-state.json"), "null");
    const client = new ObservationClient({
      root: opened.root,
      endpoint: `http://127.0.0.1:${port}`,
      tokenFile: opened.tokenFile,
    });
    const result = await client.snapshot();
    assert.equal(result.provider.state, "internal", "a body that is not a snapshot is refused");
    assert.equal(result.snapshot, null);
  } finally {
    await new Promise<void>((resolve) => broken.close(() => resolve()));
    await opened.close();
  }
});

test("a short token, an empty state object and an error body without a code are all handled", async () => {
  const opened = await bench();
  const empty = await provider({ status: 403, body: { protocolVersion: 1, error: {} } });
  try {
    const short = join(opened.root, "short-token");
    await writeFile(short, "too-short\n", { mode: 0o600 });
    assert.equal(
      await readObservationToken(short),
      undefined,
      "a short bearer is not a credential",
    );
    await writeFile(join(opened.root, "observation-state.json"), "{}");
    const client = new ObservationClient({
      root: opened.root,
      endpoint: `http://127.0.0.1:${empty.port}`,
      tokenFile: opened.tokenFile,
    });
    const result = await client.snapshot();
    assert.equal(result.provider.state, "internal", "an error without a code is internal");
    assert.equal(result.provider.detail, "internal");
    assert.equal(result.provider.unavailable, 0);
  } finally {
    await empty.close();
    await opened.close();
  }
});

test("a reply with the wrong kind is refused instead of trusted", async () => {
  const opened = await bench();
  const wrong = await provider({ body: { protocolVersion: 1, kind: "something-else" } });
  try {
    await writeFile(
      join(opened.root, "observation-state.json"),
      JSON.stringify({
        baseline: { source: PROVIDER_SOURCE, catalog: "c", positions: {}, cursor: "eyJvbGQiOjF9" },
        state: "ready",
        unavailable: 0,
        lastReadAt: null,
      }),
    );
    const client = new ObservationClient({
      root: opened.root,
      endpoint: `http://127.0.0.1:${wrong.port}`,
      tokenFile: opened.tokenFile,
    });
    assert.equal((await client.history({ botId: "b_3f1a" })).provider.state, "internal");
    assert.equal((await client.changes()).provider.state, "internal");
  } finally {
    await wrong.close();
    await opened.close();
  }
});
