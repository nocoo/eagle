// Named CLI credentials and their scopes (docs/bots/PROTOCOL.md "CLI clients and scopes"):
// one revocable bearer per client, only a salted hash on disk, and a scope per route so a
// handed-out credential can read the catalog without being able to delete a bot.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BotSummary } from "../../src/core/domain.ts";
import { frameQueue, hello, type Stack, send, startStack } from "../support/server.ts";

const tr = (name: string) => `tr_${name}_0123456`;

type ClientBody = {
  readonly id: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly lastUsedAt?: string;
  readonly revokedAt?: string;
};

type Issued = { readonly client: ClientBody; readonly token: string };

const request =
  (stack: Stack, bearer: string) => async (method: string, path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${stack.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

const issue = async (
  stack: Stack,
  input: { name: string; scopes: string[] },
): Promise<{ status: number; body: Partial<Issued> & { error?: { kind?: string } } }> => {
  const response = await request(stack, stack.token)("POST", "/v1/clients", input);
  return { status: response.status, body: (await response.json()) as Partial<Issued> };
};

const issued = async (stack: Stack, name: string, scopes: string[]): Promise<Issued> => {
  const { status, body } = await issue(stack, { name, scopes });
  assert.equal(status, 201, `issuing ${name}`);
  return body as Issued;
};

const storedClients = async (stack: Stack): Promise<ClientBody[]> => {
  const body = JSON.parse(await readFile(join(stack.root, "clients.json"), "utf8")) as {
    version: number;
    clients: ClientBody[];
  };
  return body.clients;
};

test("issues a named client, lists it and answers who it is", async () => {
  const stack = await startStack();
  try {
    const response = await request(stack, stack.token)("POST", "/v1/clients", {
      name: "this-mac",
      scopes: ["read", "write"],
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as Issued;
    assert.match(body.client.id, /^c_[0-9a-f-]{36}$/);
    assert.equal(body.client.name, "this-mac");
    assert.deepEqual(body.client.scopes, ["read", "write"]);
    assert.match(body.client.createdAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal((body.client as { salt?: string }).salt, undefined, "the salt stays on disk");
    assert.equal((body.client as { hash?: string }).hash, undefined, "the hash stays on disk");

    const secret = body.token.slice(body.client.id.length + 1);
    assert.match(body.token, new RegExp(`^${body.client.id}\\.[A-Za-z0-9_-]{43}$`));

    const file = join(stack.root, "clients.json");
    assert.equal((await stat(file)).mode & 0o777, 0o600, "clients.json is 0600");
    const raw = await readFile(file, "utf8");
    const stored = JSON.parse(raw) as { version: number; clients: ClientBody[] };
    assert.equal(stored.version, 1);
    assert.equal(stored.clients.length, 1);
    assert.equal((stored.clients[0] as { salt?: string }).salt?.length, 22);
    assert.equal(
      (stored.clients[0] as { hash?: string }).hash?.length,
      64,
      "the hash is spent alone",
    );
    assert.ok(!raw.includes(secret), "the secret is never written");

    const listed = await request(stack, stack.token)("GET", "/v1/clients");
    assert.equal(listed.status, 200);
    const clients = ((await listed.json()) as { clients: ClientBody[] }).clients;
    assert.deepEqual(clients, [body.client], "the list answers the record without its secret");

    const me = await request(stack, body.token)("GET", "/v1/clients/me");
    assert.equal(me.status, 200);
    assert.deepEqual(((await me.json()) as { client: ClientBody }).client.name, "this-mac");

    const rootMe = await request(stack, stack.token)("GET", "/v1/clients/me");
    assert.equal(
      ((await rootMe.json()) as { client: unknown }).client,
      null,
      "the App's own token is no named client",
    );
  } finally {
    await stack.close();
  }
});

test("rotate replaces the secret and only the new one works", async () => {
  const stack = await startStack();
  try {
    const first = await issued(stack, "rotating", ["read"]);
    const rotated = await request(stack, stack.token)(
      "POST",
      `/v1/clients/${first.client.id}/rotate`,
    );
    assert.equal(rotated.status, 200);
    const second = (await rotated.json()) as Issued;
    assert.equal(second.client.id, first.client.id);
    assert.equal(second.client.name, "rotating");
    assert.deepEqual(second.client.scopes, ["read"]);
    assert.notEqual(second.token, first.token);

    assert.equal((await request(stack, first.token)("GET", "/v1/bots")).status, 401);
    assert.equal((await request(stack, second.token)("GET", "/v1/bots")).status, 200);
    assert.equal((await storedClients(stack)).length, 1, "rotation rewrites one record");
  } finally {
    await stack.close();
  }
});

test("revoke cuts the credential off and delete needs the revoke first", async () => {
  const stack = await startStack();
  try {
    const client = await issued(stack, "handed-out", ["read"]);
    const path = `/v1/clients/${client.client.id}`;

    const active = await request(stack, stack.token)("DELETE", path);
    assert.equal(active.status, 409);
    assert.equal(
      ((await active.json()) as { error: { kind: string } }).error.kind,
      "client_active",
    );
    assert.equal((await storedClients(stack)).length, 1, "a refused delete changes nothing");

    const revoked = await request(stack, stack.token)("POST", `${path}/revoke`);
    assert.equal(revoked.status, 200);
    const record = ((await revoked.json()) as { client: ClientBody }).client;
    assert.match(record.revokedAt ?? "", /^\d{4}-\d\d-\d\dT/);

    const again = await request(stack, stack.token)("POST", `${path}/revoke`);
    assert.equal(again.status, 200);
    assert.equal(
      ((await again.json()) as { client: ClientBody }).client.revokedAt,
      record.revokedAt,
      "revoking twice is a no-op that returns the record",
    );

    const refused = await request(stack, client.token)("GET", "/v1/bots");
    assert.equal(refused.status, 401);
    assert.equal(((await refused.json()) as { error: { kind: string } }).error.kind, "auth_failed");
    const unknown = await request(
      stack,
      `c_00000000-0000-4000-8000-000000000000.${"a".repeat(43)}`,
    )("GET", "/v1/bots");
    assert.equal(unknown.status, 401);
    assert.equal(
      ((await unknown.json()) as { error: { kind: string } }).error.kind,
      "auth_failed",
      "a revoked credential and an unknown one answer alike",
    );

    const removed = await request(stack, stack.token)("DELETE", path);
    assert.equal(removed.status, 204);
    assert.deepEqual(await storedClients(stack), []);
    assert.equal((await request(stack, stack.token)("DELETE", path)).status, 404);
  } finally {
    await stack.close();
  }
});

test("a name or a scope outside the rules is refused", async () => {
  const stack = await startStack();
  try {
    for (const body of [
      {},
      { name: "", scopes: ["read"] },
      { name: "   ", scopes: ["read"] },
      { name: "x".repeat(33), scopes: ["read"] },
      { name: "Upper Case", scopes: ["read"] },
      { name: "-leading", scopes: ["read"] },
      { name: "bad name", scopes: ["read"] },
      { name: "no scopes", scopes: [] },
      { name: "unknown scope", scopes: ["read", "root"] },
      { name: "not a list", scopes: "read" },
    ]) {
      assert.equal(
        (await issue(stack, body as { name: string; scopes: string[] })).status,
        400,
        JSON.stringify(body),
      );
    }
    assert.deepEqual(
      await storedClients(stack).catch(() => []),
      [],
      "a refused issue writes nothing",
    );

    const first = await issued(stack, "taken", ["read"]);
    assert.equal(first.client.name, "taken");
    const duplicate = await issue(stack, { name: "taken", scopes: ["read"] });
    assert.equal(duplicate.status, 400);
    assert.equal(duplicate.body.error?.kind, "invalid_command");

    const deduplicated = await issued(stack, "dedup", ["write", "write", "read"]);
    assert.deepEqual(deduplicated.client.scopes, ["write", "read"], "scopes are deduplicated");
  } finally {
    await stack.close();
  }
});

test("read, write and admin each allow exactly their routes", async () => {
  const stack = await startStack();
  try {
    const reader = await issued(stack, "reader", ["read"]);
    const writer = await issued(stack, "writer", ["write"]);
    const admin = await issued(stack, "admin", ["admin"]);
    const bot = await stack.createBot("scoped");
    const group = await stack.registry.createGroup("scoped group", tr("group"));

    const readOnly = request(stack, reader.token);
    assert.equal((await readOnly("GET", "/v1/bots")).status, 200);
    assert.equal((await readOnly("GET", "/v1/clients/me")).status, 200);

    const before = stack.registry.summaries().length;
    for (const [method, path, body] of [
      ["POST", "/v1/bots", { title: "refused" }],
      ["PATCH", `/v1/bots/${bot}`, { title: "refused" }],
      ["DELETE", `/v1/bots/${bot}`, undefined],
      ["POST", "/v1/groups", { title: "refused" }],
      ["PATCH", `/v1/groups/${group.id}`, { title: "refused" }],
      ["PUT", "/v1/groups/order", { ids: [group.id] }],
      ["DELETE", `/v1/groups/${group.id}`, undefined],
      ["PUT", "/v1/settings", { model: "x" }],
      ["POST", "/v1/settings/test", {}],
      ["PUT", "/v1/providers/search", { enabled: false }],
      ["GET", "/v1/clients", undefined],
      ["POST", "/v1/clients", { name: "sneaky", scopes: ["read"] }],
      ["DELETE", `/v1/clients/${admin.client.id}`, undefined],
    ] as const) {
      const response = await readOnly(method, path, body);
      assert.equal(response.status, 403, `${method} ${path} needs more than read`);
      assert.equal(
        ((await response.json()) as { error: { kind: string } }).error.kind,
        "auth_scope",
        `${method} ${path}`,
      );
    }
    assert.equal(stack.registry.summaries().length, before, "a refused route mutates nothing");
    assert.equal(stack.registry.summaries()[0]?.title, "scoped");
    assert.equal(stack.registry.groups()[0]?.title, "scoped group");

    const writeOnly = request(stack, writer.token);
    const created = await writeOnly("POST", "/v1/bots", { title: "written" });
    assert.equal(created.status, 201);
    const written = ((await created.json()) as { bot: BotSummary }).bot;
    assert.equal((await writeOnly("PATCH", `/v1/bots/${written.id}`, { label: "w" })).status, 200);
    const groupCreated = await writeOnly("POST", "/v1/groups", { title: "written group" });
    assert.equal(groupCreated.status, 201);
    const writtenGroup = ((await groupCreated.json()) as { group: { id: string } }).group;
    assert.equal(
      (await writeOnly("PATCH", `/v1/groups/${writtenGroup.id}`, { title: "renamed" })).status,
      200,
    );
    assert.equal(
      (await writeOnly("PUT", "/v1/groups/order", { ids: [writtenGroup.id, group.id] })).status,
      200,
    );
    assert.equal((await writeOnly("GET", "/v1/clients/me")).status, 200);
    for (const [method, path, body] of [
      ["DELETE", `/v1/bots/${written.id}`, undefined],
      ["DELETE", `/v1/groups/${writtenGroup.id}`, undefined],
      ["PUT", "/v1/settings", { model: "x" }],
      ["GET", "/v1/clients", undefined],
    ] as const) {
      const response = await writeOnly(method, path, body);
      assert.equal(response.status, 403, `${method} ${path} needs admin`);
      assert.equal(
        ((await response.json()) as { error: { kind: string } }).error.kind,
        "auth_scope",
      );
    }

    const adminOnly = request(stack, admin.token);
    assert.equal((await adminOnly("GET", "/v1/clients")).status, 200);
    assert.equal((await adminOnly("DELETE", `/v1/bots/${written.id}`)).status, 204);
    assert.equal((await adminOnly("DELETE", `/v1/groups/${writtenGroup.id}`)).status, 204);
    const issuedByAdmin = await adminOnly("POST", "/v1/clients", {
      name: "by-admin",
      scopes: ["read"],
    });
    assert.equal(issuedByAdmin.status, 201, "admin covers /v1/clients");
  } finally {
    await stack.close();
  }
});

test("a socket without write may subscribe and read but not send or abort", async () => {
  const stack = await startStack();
  try {
    const reader = await issued(stack, "watching", ["read"]);
    const botId = await stack.createBot("watched");
    const socket = stack.connect({ token: reader.token });
    const frames = frameQueue(socket);
    await send(socket, hello);
    assert.equal((await frames.next()).type, "welcome");
    await send(socket, { type: "subscribe", botId, trace: tr("subscribe") });
    assert.equal((await frames.next()).type, "snapshot");

    await send(socket, {
      type: "send",
      requestId: "r_scoped_0001",
      text: "not allowed",
      trace: tr("send"),
    });
    const refused = await frames.next();
    assert.equal(refused.type, "error");
    assert.equal(refused.kind, "auth_scope");
    assert.equal(refused.requestId, "r_scoped_0001");

    await send(socket, { type: "abort", trace: tr("abort") });
    const aborted = await frames.next();
    assert.equal(aborted.type, "error");
    assert.equal(aborted.kind, "auth_scope");

    await send(socket, { type: "ping" });
    assert.equal((await frames.next()).type, "pong", "the connection stays usable");
    await send(socket, { type: "resync", trace: tr("resync") });
    const resynced = await frames.next();
    assert.equal(resynced.type, "snapshot");
    assert.deepEqual(
      (resynced.value as { messages: unknown[] }).messages,
      [],
      "the refused send admitted nothing",
    );
    socket.close();
  } finally {
    await stack.close();
  }
});

test("a CLI send is attributed to the client name and the App's own token is not", async () => {
  const stack = await startStack({
    script: {
      onSubmit: (input) => [
        {
          type: "append",
          trace: input.trace,
          message: {
            id: `e_${input.requestId}`,
            role: "user",
            state: "complete",
            createdAt: "2026-11-01T00:00:00.000Z",
            requestId: input.requestId,
            blocks: [{ type: "text", text: input.text }],
          },
        },
      ],
    },
  });
  try {
    const writer = await issued(stack, "research-agent", ["write"]);
    const botId = await stack.createBot("attributed");
    const appendOrigin = async (token: string, requestId: string) => {
      const socket = stack.connect({ token });
      const frames = frameQueue(socket);
      await send(socket, hello);
      await frames.next();
      await send(socket, { type: "subscribe", botId, trace: tr("subscribe") });
      await frames.next();
      await send(socket, { type: "send", requestId, text: "hello", trace: tr("send") });
      for (;;) {
        const frame = await frames.next();
        if (frame.type !== "append") continue;
        socket.close();
        return (frame.message as { origin?: unknown }).origin;
      }
    };
    assert.deepEqual(await appendOrigin(writer.token, "r_named_0001"), {
      kind: "human",
      label: "research-agent",
    });
    assert.deepEqual(
      await appendOrigin(stack.token, "r_unnamed_001"),
      { kind: "human" },
      "the App's own token invents no label",
    );
  } finally {
    await stack.close();
  }
});

test("lastUsedAt moves at most once a minute", async () => {
  let now = Date.parse("2026-11-01T00:00:00.000Z");
  const stack = await startStack({ now: () => new Date(now) });
  try {
    const client = await issued(stack, "chatty", ["read"]);
    const lastUsedAt = async () => (await storedClients(stack))[0]?.lastUsedAt;
    assert.equal(await lastUsedAt(), undefined, "issuing is not a use");

    await request(stack, client.token)("GET", "/v1/bots");
    assert.equal(await lastUsedAt(), "2026-11-01T00:00:00.000Z");

    now += 30_000;
    await request(stack, client.token)("GET", "/v1/bots");
    assert.equal(await lastUsedAt(), "2026-11-01T00:00:00.000Z", "a second write waits its turn");

    now += 31_000;
    await request(stack, client.token)("GET", "/v1/bots");
    assert.equal(await lastUsedAt(), "2026-11-01T00:01:01.000Z");
  } finally {
    await stack.close();
  }
});

test("the App's own token keeps every right and the token file is untouched", async () => {
  const stack = await startStack();
  try {
    const botId = await stack.createBot("root");
    const root = request(stack, stack.token);
    assert.equal((await root("GET", "/v1/clients")).status, 200);
    assert.equal(
      (await root("PUT", "/v1/settings", {})).status,
      404,
      "admin crosses the scope gate into the route itself",
    );
    assert.equal((await root("DELETE", `/v1/bots/${botId}`)).status, 204);
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    assert.equal((await frames.next()).type, "welcome");
    socket.close();
  } finally {
    await stack.close();
  }
});

test("a restarted daemon keeps a credential and drops a record it cannot read", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-clients-"));
  try {
    const first = await startStack({ root });
    let client: Issued;
    try {
      client = await issued(first, "survivor", ["read"]);
    } finally {
      await first.close();
    }

    const second = await startStack({ root });
    try {
      const me = await request(second, client.token)("GET", "/v1/clients/me");
      assert.equal(me.status, 200, "the secret still authenticates after a restart");
      assert.equal(((await me.json()) as { client: ClientBody }).client.name, "survivor");
    } finally {
      await second.close();
    }

    const body = JSON.parse(await readFile(join(root, "clients.json"), "utf8")) as {
      version: number;
      clients: unknown[];
    };
    await writeFile(
      join(root, "clients.json"),
      JSON.stringify({
        version: body.version,
        clients: [...body.clients, { id: "not-a-client", name: "junk" }, "junk"],
      }),
      { mode: 0o600 },
    );
    const third = await startStack({ root });
    try {
      const listed = await request(third, third.token)("GET", "/v1/clients");
      assert.deepEqual(
        ((await listed.json()) as { clients: ClientBody[] }).clients.map((one) => one.name),
        ["survivor"],
        "a record the daemon cannot read is dropped, not served",
      );
    } finally {
      await third.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
