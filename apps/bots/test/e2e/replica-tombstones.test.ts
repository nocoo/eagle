import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MAX_REPLICA_BODY_BYTES } from "../../src/core/RuntimePort.ts";
import { FakeRuntime } from "../../src/testing/FakeRuntime.ts";
import { assistant, text, toolCall, trace, waitFor } from "../support/pi.ts";
import { frameQueue, hello, type Stack, send, startStack } from "../support/server.ts";

const post = (s: Stack, path: string, body: unknown) =>
  fetch(`http://127.0.0.1:${s.port}/v1/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const replica = (s: Stack, id: string, method: string, body: unknown) =>
  post(s, `bots/${id}/replica/${method}`, body);

const savedHistory = (dir: string) => {
  const sdk = new DatabaseSync(join(dir, "session.sqlite"), { readOnly: true });
  const facts = new DatabaseSync(join(dir, "replica.sqlite"), { readOnly: true });
  try {
    return {
      entries: sdk.prepare("SELECT * FROM entries ORDER BY id").all(),
      streams: facts
        .prepare("SELECT source,seq,event FROM source_events ORDER BY source,seq")
        .all(),
    };
  } finally {
    sdk.close();
    facts.close();
  }
};

test("an already subscribed socket cannot recover work after a tombstone lease timeout", async () => {
  const sharedBotId = randomUUID();
  const fake = new FakeRuntime();
  let recoverCalls = 0;
  const stack = await startStack({
    closeDeadlineMs: 10,
    runtime: {
      readReplicaBinding: async () => ({ sharedBotId }),
      open: async (spec) => {
        const handle = await fake.open(spec);
        const recover = handle.recover.bind(handle);
        handle.recover = async (input) => {
          recoverCalls++;
          await recover(input);
        };
        return handle;
      },
    },
  });
  const socket = stack.connect();
  try {
    const botId = await stack.createBot("subscribed before deletion");
    const frames = frameQueue(socket);
    await send(socket, hello);
    assert.equal((await frames.next()).type, "welcome");
    await send(socket, { type: "subscribe", botId, trace: "tr_before_deleted" });
    assert.equal((await frames.next()).type, "snapshot");
    assert.equal(
      (await post(stack, "replica/tombstones/apply", { items: [{ sharedBotId }] })).status,
      409,
    );
    assert.equal(stack.registry.state(botId), "quarantined");
    assert.equal(await stack.directory.isDeleted(sharedBotId), true);
    await access(stack.directory.botDir(botId));
    let ended = false;
    socket.on("message", (data) => {
      if (JSON.parse(data.toString()).trace === "tr_deleted_recover") ended = true;
    });
    socket.on("close", () => {
      ended = true;
    });
    await send(socket, { type: "recover", trace: "tr_deleted_recover" });
    await waitFor(() => ended, "the recover command was handled");
    assert.equal(recoverCalls, 0, "a cached subscription cannot bypass the deleted owner gate");
    const records = stack.records.filter((record) => record.trace === "tr_deleted_recover");
    const origin = records.filter((record) => record.level === "error");
    assert.equal(origin.length, 1);
    assert.equal(origin[0]?.layer, "core");
    const propagated = records.find((record) => record.evt === "protocol.command.fail");
    assert.equal(propagated?.level, "warn");
    assert.equal(propagated?.err?.failure, origin[0]?.err?.failure);
  } finally {
    socket.terminate();
    await stack.close();
  }
});

for (const legacy of [false, true])
  test(`HTTP delete of ${legacy ? "an unbound legacy Bot" : "a different shared Bot and its alias"} is independent of another identity's quarantine`, async () => {
    const sharedA = randomUUID();
    const fake = new FakeRuntime();
    let firstId: string | undefined;
    const stack = await startStack({
      ...(legacy
        ? {
            runtime: {
              readReplicaBinding: async ({ id }: { id: string }) =>
                id === firstId ? { sharedBotId: sharedA } : undefined,
              open: async (spec: Parameters<typeof fake.open>[0]) => {
                firstId ??= spec.id;
                return fake.open(spec);
              },
            },
          }
        : { real: true }),
    });
    const observer = stack.connect();
    try {
      const a = await stack.createBot("A retains its lease");
      await stack.registry.open(a, trace);
      const aBinding = legacy
        ? { sharedBotId: sharedA }
        : ((await (await replica(stack, a, "status", {})).json()) as { sharedBotId: string });
      const b = await stack.createBot("unrelated B");
      const handleB = await stack.registry.open(b, trace);
      let alias: string | undefined;
      let historyB: ReturnType<typeof savedHistory> | undefined;
      const bytes = Buffer.from("B original tool/history bytes 原文");
      if (legacy) {
        await writeFile(join(stack.directory.botDir(b), "legacy.txt"), bytes);
        await assert.rejects(access(join(stack.directory.botDir(b), "replica.sqlite")), {
          code: "ENOENT",
        });
      } else {
        stack.faux?.setResponses([
          assistant([toolCall("write", { path: "original.txt", content: bytes.toString() })], {
            stopReason: "toolUse",
          }),
          text("B saved"),
        ]);
        await handleB.submit({
          requestId: "unrelated-delete-B",
          text: "write B",
          whenBusy: "followUp",
          trace,
        });
        await waitFor(
          async () =>
            (await handleB.submission({ requestId: "unrelated-delete-B" }))?.status === "done",
          "B's original tool run",
        );
        const bindingB = (await (await replica(stack, b, "status", {})).json()) as {
          sharedBotId: string;
        };
        assert.notEqual(bindingB.sharedBotId, aBinding.sharedBotId);
        alias = await stack.createBot("B same-identity alias");
        assert.equal(
          (await replica(stack, alias, "bind", { sharedBotId: bindingB.sharedBotId })).status,
          200,
        );
        assert.equal((await replica(stack, b, "pull", { after: 0 })).status, 200);
        assert.deepEqual(
          await readFile(join(stack.directory.botDir(b), "workspace/original.txt")),
          bytes,
        );
        historyB = savedHistory(stack.directory.botDir(b));
        assert.ok(JSON.stringify(historyB.entries).includes("pi.tool-result"));
        assert.ok(historyB.streams.length > 0);
      }
      const frames = frameQueue(observer);
      await send(observer, hello);
      assert.equal((await frames.next()).type, "welcome");
      await send(observer, { type: "subscribe", botId: a, trace: "tr_unrelated_owner" });
      assert.equal((await frames.next()).type, "snapshot");
      const historyA = legacy ? undefined : savedHistory(stack.directory.botDir(a));
      const calls = stack.faux?.state.callCount;
      const items = [{ sharedBotId: aBinding.sharedBotId }];
      const beforeDelete = stack.records.length;
      const retained = await post(stack, "replica/tombstones/apply", { items });
      assert.equal(retained.status, 409, "the subscribed A really reaches lease quarantine");
      assert.equal(stack.registry.state(a), "quarantined");
      assert.equal(await stack.directory.isDeleted(aBinding.sharedBotId), true);
      assert.equal(stack.registry.touch(a), false);
      const deleteB = await fetch(`http://127.0.0.1:${stack.port}/v1/bots/${b}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${stack.token}` },
      });
      // These assertions precede the response check: the regression happens after B moved.
      assert.deepEqual(
        await readFile(
          join(stack.directory.trashDir(b), legacy ? "legacy.txt" : "workspace/original.txt"),
        ),
        bytes,
      );
      if (historyB !== undefined)
        assert.deepEqual(savedHistory(stack.directory.trashDir(b)), historyB);
      assert.equal(stack.registry.state(a), "quarantined");
      await access(stack.directory.botDir(a));
      await assert.rejects(access(stack.directory.trashDir(a)), { code: "ENOENT" });
      assert.equal(await stack.directory.isDeleted(aBinding.sharedBotId), true);
      if (historyA !== undefined)
        assert.deepEqual(savedHistory(stack.directory.botDir(a)), historyA);
      assert.equal(
        stack.faux?.state.callCount,
        calls,
        "deletes and metadata execute no new model/tool work",
      );
      assert.equal(
        deleteB.status,
        204,
        "B already moved; unrelated A quarantine cannot change its HTTP outcome",
      );
      if (alias !== undefined) {
        await access(stack.directory.trashDir(alias));
        assert.equal(
          stack.registry.state(alias),
          undefined,
          "B's same-identity alias is still cleaned",
        );
      }
      const broadcast = await frames.next();
      assert.equal(broadcast.type, "bots");
      assert.deepEqual(broadcast.bots, [], "the successful DELETE broadcasts the updated catalog");
      const origins = stack.records
        .slice(beforeDelete)
        .filter((record) => record.level === "error");
      assert.equal(origins.length, 1, "only A's failed apply has an originating failure");
      assert.equal(origins[0]?.evt, "core.replica.fail");
      assert.equal(origins[0]?.err?.origin, true);
    } finally {
      observer.terminate();
      await stack.close();
    }
  });

test("shared deletion survives local removal and passively fences the other daemon", async (t) => {
  const roots = await Promise.all([
    mkdtemp(join(tmpdir(), "bots-tombstone-A-")),
    mkdtemp(join(tmpdir(), "bots-tombstone-B-")),
  ]);
  const a = await startStack({ real: true, root: roots[0] });
  let b = await startStack({ real: true, root: roots[1] });
  try {
    const source = await a.createBot("original");
    const target = await b.createBot("independent replica");
    const handle = await a.registry.open(source, trace);
    a.faux?.setResponses([
      assistant(
        [toolCall("write", { path: "original.txt", content: "original trash bytes 原文" })],
        {
          stopReason: "toolUse",
        },
      ),
      text("saved"),
    ]);
    await handle.submit({
      requestId: "source-tombstone",
      text: "write",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      async () => (await handle.submission({ requestId: "source-tombstone" }))?.status === "done",
      "original real tool",
    );
    const status = (await (await replica(a, source, "status", {})).json()) as {
      sharedBotId: string;
    };
    const items = [{ sharedBotId: status.sharedBotId }];
    assert.equal((await replica(b, target, "bind", items[0])).status, 200);
    const bundle = (await (await replica(a, source, "export", {})).json()) as { head: string };
    assert.equal((await replica(b, target, "import", { bundle })).status, 200);
    const alias = await b.createBot("second local alias");
    assert.equal((await replica(b, alias, "bind", items[0])).status, 200);
    const oldPage = await (await replica(a, source, "pull", { after: 0 })).json();
    b.faux?.setResponses([
      assistant(
        [toolCall("write", { path: "unsent.txt", content: "unuploaded B branch 原字节" })],
        { stopReason: "toolUse" },
      ),
      text("unsent branch"),
    ]);
    assert.equal(
      (
        await replica(b, target, "run", {
          head: bundle.head,
          requestId: "unsent-branch",
          text: "local only",
        })
      ).status,
      200,
    );
    await waitFor(async () => {
      const state = (await (
        await replica(b, target, "status", { requestId: "unsent-branch" })
      ).json()) as { submission?: { status: string } };
      return state.submission?.status === "done";
    }, "unuploaded branch");
    assert.deepEqual(
      await readFile(join(a.directory.botDir(source), "workspace/original.txt")),
      Buffer.from("original trash bytes 原文"),
    );
    assert.deepEqual(
      await readFile(join(b.directory.botDir(target), "workspace/unsent.txt")),
      Buffer.from("unuploaded B branch 原字节"),
    );
    const originalA = savedHistory(a.directory.botDir(source));
    const originalB = savedHistory(b.directory.botDir(target));
    for (const original of [originalA, originalB]) {
      assert.ok(JSON.stringify(original.entries).includes("pi.tool-result"));
      assert.ok(original.streams.length > 0);
    }
    const calls = [a.faux?.state.callCount, b.faux?.state.callCount];
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${a.port}/v1/bots/${source}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${a.token}` },
        })
      ).status,
      204,
    );
    await t.test("local delete retains the immutable root fact", async () => {
      const catalog = JSON.parse(await readFile(join(a.root, "catalog.json"), "utf8"));
      assert.deepEqual(catalog.tombstones, items);
      assert.equal(
        await readFile(join(a.directory.trashDir(source), "workspace/original.txt"), "utf8"),
        "original trash bytes 原文",
      );
      assert.deepEqual(savedHistory(a.directory.trashDir(source)), originalA);
    });
    await t.test("root pull remains callable after the local Bot is gone", async () => {
      const response = await post(a, "replica/tombstones/pull", { after: 0 });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { items, nextAfter: 1, hasMore: false });
    });
    await t.test("passive apply seals the other bound runtime", async () => {
      assert.equal((await post(b, "replica/tombstones/apply", { items })).status, 200);
      for (const [method, body] of [
        ["import", { bundle }],
        ["run", { head: bundle.head, requestId: "deleted-new-run", text: "must refuse" }],
        ["bind", items[0]],
        ["apply", { page: oldPage }],
      ] as const)
        assert.equal((await replica(b, target, method, body)).status, 404);
      assert.equal(
        (await replica(b, alias, "status", {})).status,
        404,
        "all already-bound aliases are fenced",
      );
      assert.equal(
        await readFile(join(b.directory.trashDir(target), "workspace/unsent.txt"), "utf8"),
        "unuploaded B branch 原字节",
      );
      assert.deepEqual(savedHistory(b.directory.trashDir(target)), originalB);
    });
    assert.deepEqual(
      [a.faux?.state.callCount, b.faux?.state.callCount],
      calls,
      "deletion/metadata never execute models or tools",
    );
    assert.equal((await post(b, "replica/tombstones/apply", { items })).status, 200);
    const forwarded = await (await post(b, "replica/tombstones/pull", { after: 0 })).json();
    assert.deepEqual(forwarded, { items, nextAfter: 1, hasMore: false });
    assert.equal((await post(a, "replica/tombstones/apply", { items })).status, 200);
    await b.close();
    b = await startStack({ real: true, root: roots[1] });
    assert.equal(b.opens(), 0, "restart never opens the deleted SDK queues");
    assert.equal((await replica(b, target, "import", { bundle })).status, 404);
    const fresh = await b.createBot("new shared identity");
    assert.equal((await replica(b, fresh, "bind", items[0])).status, 400);
    const freshStatus = (await (await replica(b, fresh, "status", {})).json()) as {
      sharedBotId: string;
    };
    assert.notEqual(freshStatus.sharedBotId, status.sharedBotId);
    assert.equal(b.faux?.state.callCount, 0);
  } finally {
    await Promise.allSettled([a.close(), b.close()]);
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});

test("root tombstones enforce auth/Origin/strict bounded pages and survive all group writes", async () => {
  const a = await startStack({ real: true });
  try {
    const url = `http://127.0.0.1:${a.port}/v1/replica/tombstones/`;
    for (const method of ["pull", "apply"]) {
      assert.equal((await fetch(url + method, { method: "POST", body: "{}" })).status, 401);
      assert.equal(
        (
          await fetch(url + method, {
            method: "POST",
            headers: { authorization: `Bearer ${a.token}`, origin: "https://untrusted.invalid" },
            body: "{}",
          })
        ).status,
        403,
      );
      assert.equal(
        (await fetch(url + method, { headers: { authorization: `Bearer ${a.token}` } })).status,
        404,
      );
    }
    for (const body of [
      { after: -1 },
      { after: Number.MAX_SAFE_INTEGER + 1 },
      { after: "0" },
      { after: 0, limit: 0 },
      { after: 0, limit: 129 },
      { after: 0, extra: true },
    ])
      assert.equal((await post(a, "replica/tombstones/pull", body)).status, 400);
    const items = Array.from({ length: 130 }, () => ({ sharedBotId: randomUUID() }));
    for (const body of [
      { items: [] },
      { items: items.slice(0, 129) },
      { items: [items[0], { sharedBotId: "bad" }] },
      { items: [{ ...items[0], botId: "b_forbidden" }] },
      { items: [items[0]], extra: true },
    ])
      assert.equal((await post(a, "replica/tombstones/apply", body)).status, 400);
    assert.deepEqual(await (await post(a, "replica/tombstones/pull", { after: 0 })).json(), {
      items: [],
      nextAfter: 0,
      hasMore: false,
    });
    assert.equal(
      (await post(a, "replica/tombstones/apply", { items: items.slice(0, 128) })).status,
      200,
    );
    assert.equal(
      (await post(a, "replica/tombstones/apply", { items: items.slice(127) })).status,
      200,
    );
    assert.equal(
      (await post(a, "replica/tombstones/apply", { items: [items[0], items[0]] })).status,
      200,
    );
    const first = await (await post(a, "replica/tombstones/pull", { after: 0 })).json();
    assert.deepEqual(first, { items: items.slice(0, 128), nextAfter: 128, hasMore: true });
    assert.deepEqual(await (await post(a, "replica/tombstones/pull", { after: 128 })).json(), {
      items: items.slice(128),
      nextAfter: 130,
      hasMore: false,
    });
    assert.deepEqual(await (await post(a, "replica/tombstones/pull", { after: 130 })).json(), {
      items: [],
      nextAfter: 130,
      hasMore: false,
    });
    const group = await a.directory.createGroup("one");
    const other = await a.directory.createGroup("two");
    await a.directory.renameGroup(group.id, "renamed");
    await a.directory.reorderGroups([other.id, group.id]);
    const bot = await a.createBot("new identity");
    await a.directory.setBotGroup(bot, group.id, new Date().toISOString());
    await a.directory.setBotGroup(bot, null, new Date().toISOString());
    await a.directory.deleteGroup(group.id);
    assert.deepEqual(await (await post(a, "replica/tombstones/pull", { after: 128 })).json(), {
      items: items.slice(128),
      nextAfter: 130,
      hasMore: false,
    });
    assert.equal(
      (
        await post(a, "replica/tombstones/apply", {
          items: [items[0]],
          padding: "x".repeat(MAX_REPLICA_BODY_BYTES),
        })
      ).status,
      400,
    );
    assert.ok(
      a.records.every(
        (record) => !JSON.stringify(record).includes(items[0]?.sharedBotId ?? "missing"),
      ),
      "root logs contain counts/trace only",
    );
    assert.equal(a.faux?.state.callCount, 0);
  } finally {
    await a.close();
  }
});
