// Ladder row 41: create, rename and delete over HTTP keep the catalog absolute, and every
// change reaches a connected client as one `bots` event.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BotSummary } from "../../src/core/domain.ts";
import { MAX_HTTP_BODY_BYTES } from "../../src/protocol/limits.ts";
import { frameQueue, hello, send, startStack } from "../support/server.ts";

const api = (stack: { port: number; token: string }) => {
  const headers = { authorization: `Bearer ${stack.token}`, "content-type": "application/json" };
  return {
    list: () => fetch(`http://127.0.0.1:${stack.port}/v1/bots`, { headers }),
    create: (title: string) =>
      fetch(`http://127.0.0.1:${stack.port}/v1/bots`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title }),
      }),
    rename: (id: string, title: string) =>
      fetch(`http://127.0.0.1:${stack.port}/v1/bots/${id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ title }),
      }),
    remove: (id: string) =>
      fetch(`http://127.0.0.1:${stack.port}/v1/bots/${id}`, { method: "DELETE", headers }),
    patch: (id: string, body: unknown) =>
      fetch(`http://127.0.0.1:${stack.port}/v1/bots/${id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(body),
      }),
  };
};

test("create, rename and delete keep the catalog absolute", async () => {
  const stack = await startStack();
  try {
    const client = api(stack);
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();

    const created = await client.create("研究员");
    assert.equal(created.status, 201);
    const body = (await created.json()) as { bot: { id: string; title: string; state: string } };
    assert.equal(body.bot.title, "研究员");
    assert.match(body.bot.id, /^b_[A-Za-z0-9_-]{1,64}$/);
    const announced = await frames.next();
    assert.equal(announced.type, "bots", "the catalog reaches the client as one event");
    assert.deepEqual(
      (announced.bots as { id: string }[]).map((bot) => bot.id),
      [body.bot.id],
      "and it is absolute, not a delta",
    );

    const renamed = await client.rename(body.bot.id, "助理");
    assert.equal(renamed.status, 200);
    assert.equal(((await renamed.json()) as { bot: { title: string } }).bot.title, "助理");
    assert.deepEqual(
      ((await frames.next()).bots as { title: string }[]).map((bot) => bot.title),
      ["助理"],
    );

    const listed = await client.list();
    const listedBody = (await listed.json()) as { bots: { title: string }[] };
    assert.deepEqual(
      listedBody.bots.map((bot) => bot.title),
      ["助理"],
      "the catalog is the authority",
    );

    const deleted = await client.remove(body.bot.id);
    assert.equal(deleted.status, 204);
    assert.deepEqual((await frames.next()).bots, []);
    assert.deepEqual(((await (await client.list()).json()) as { bots: unknown[] }).bots, []);
    socket.close();
  } finally {
    await stack.close();
  }
});

const untilBots = async (
  frames: ReturnType<typeof frameQueue>,
  match: (bot: BotSummary | undefined) => boolean,
): Promise<void> => {
  for (;;) {
    const frame = await frames.next();
    if (frame.type === "bots" && (frame.bots as BotSummary[]).some(match)) return;
  }
};

test("a bot's own note rides the catalog, clears with null and refuses a long one", async () => {
  const stack = await startStack();
  try {
    const client = api(stack);
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();

    const created = await client.create("研究员");
    const bot = ((await created.json()) as { bot: { id: string } }).bot;
    await frames.next();

    const set = await client.patch(bot.id, { note: "  在核对   10-24 的报告 " });
    assert.equal(set.status, 200);
    const noted = ((await set.json()) as { bot: BotSummary }).bot;
    assert.equal(noted.note, "在核对 10-24 的报告", "the response carries the normalized note");
    await untilBots(
      frames,
      (candidate) => candidate?.updatedAt === noted.updatedAt && candidate.note === noted.note,
    );

    const tooLong = await client.patch(bot.id, { note: "字".repeat(121) });
    assert.equal(tooLong.status, 400);
    assert.equal(
      ((await tooLong.json()) as { error: { kind: string } }).error.kind,
      "invalid_command",
    );
    const unchanged = (await (await client.list()).json()) as { bots: BotSummary[] };
    assert.equal(unchanged.bots[0]?.note, "在核对 10-24 的报告", "a refused note writes nothing");

    const cleared = await client.patch(bot.id, { note: null });
    assert.equal(cleared.status, 200);
    const clean = ((await cleared.json()) as { bot: BotSummary }).bot;
    assert.equal(clean.note, undefined);
    await untilBots(
      frames,
      (candidate) => candidate?.updatedAt === clean.updatedAt && candidate.note === undefined,
    );

    const blank = await client.patch(bot.id, { note: "   " });
    assert.equal(blank.status, 200);
    assert.equal(((await blank.json()) as { bot: BotSummary }).bot.note, undefined);
    socket.close();
  } finally {
    await stack.close();
  }
});

test("a title over the limit and an unknown bot are refused", async () => {
  const stack = await startStack();
  try {
    const client = api(stack);
    const long = await client.create("x".repeat(81));
    assert.equal(long.status, 400);
    assert.equal(
      ((await long.json()) as { error: { kind: string } }).error.kind,
      "invalid_command",
    );
    assert.equal((await client.rename("b_missing", "ok")).status, 404);
  } finally {
    await stack.close();
  }
});

test("an unknown endpoint and an oversized body are refused", async () => {
  const stack = await startStack();
  try {
    const headers = { authorization: `Bearer ${stack.token}`, "content-type": "application/json" };
    const missing = await fetch(`http://127.0.0.1:${stack.port}/v1/unknown`, { headers });
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { error: { kind: string } }).error.kind, "unknown_bot");
    const huge = await fetch(`http://127.0.0.1:${stack.port}/v1/bots`, {
      method: "POST",
      headers,
      // One byte over the shared frame cap: the whole body is refused before it is parsed.
      body: JSON.stringify({ title: "x".repeat(MAX_HTTP_BODY_BYTES) }),
    });
    assert.equal(huge.status, 500, "a body over the cap is refused");
  } finally {
    await stack.close();
  }
});

test("a title the catalog budget cannot hold is refused before it is stored", async () => {
  const stack = await startStack({ model: { provider: "faux", modelId: `m${"x".repeat(1_400)}` } });
  try {
    const client = api(stack);
    const refused = await client.create("太长");
    assert.equal(refused.status, 400);
    assert.equal(
      ((await refused.json()) as { error: { kind: string } }).error.kind,
      "limit_exceeded",
    );
    assert.deepEqual(stack.registry.summaries(), [], "nothing was written");
  } finally {
    await stack.close();
  }
});

test("every catalog broadcast is a measured frame", async () => {
  const stack = await startStack();
  try {
    const client = api(stack);
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    const before = stack.records.length;
    await client.create("度量");
    assert.equal((await frames.next()).type, "bots");
    const sent = stack.records
      .slice(before)
      .filter(
        (record) => record.evt === "transport.frame.send.ok" && record.detail?.evt === "bots",
      );
    assert.equal(sent.length, 1, "the broadcast goes through the frame writer");
    assert.ok(Number(sent[0]?.detail?.bytes) > 0, "and its size is recorded");
    socket.close();
  } finally {
    await stack.close();
  }
});

test("a catalog change before hello waits for the handshake", async () => {
  const stack = await startStack();
  try {
    const socket = stack.connect();
    const frames = frameQueue(socket);
    // No hello yet: the daemon-side change must not produce a frame.
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
    await api(stack).create("先建后握手");
    await send(socket, hello);
    const first = await frames.next();
    assert.equal(first.type, "welcome", "nothing precedes the welcome");
    assert.deepEqual(
      (first.bots as { title: string }[]).map((bot) => bot.title),
      ["先建后握手"],
      "and the welcome already carries the change",
    );
    socket.close();
  } finally {
    await stack.close();
  }
});

test("the catalog follows the run state and pushes it to clients", async () => {
  const stack = await startStack();
  try {
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    const created = await api(stack).create("跟随");
    const botId = ((await created.json()) as { bot: { id: string } }).bot.id;
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: "tr_follow_0001" });
    await frames.next();
    const handle = stack.fake?.handle(botId);
    assert.ok(handle !== undefined);
    handle.emit({
      type: "status",
      trace: "tr_follow_0002",
      running: true,
      streaming: null,
      inbox: [],
    });
    const running = await (async () => {
      for (;;) {
        const frame = await frames.next();
        if (frame.type === "bots") return frame;
      }
    })();
    assert.equal(running.type, "bots");
    assert.equal(
      (running.bots as { state: string }[])[0]?.state,
      "running",
      "a run makes the bot running in the catalog",
    );
    handle.emit({
      type: "status",
      trace: "tr_follow_0003",
      running: false,
      streaming: null,
      inbox: [],
    });
    const idle = await (async () => {
      for (;;) {
        const frame = await frames.next();
        if (frame.type === "bots") return frame;
      }
    })();
    assert.equal(idle.type, "bots");
    assert.equal((idle.bots as { state: string }[])[0]?.state, "idle");
    socket.close();
  } finally {
    await stack.close();
  }
});

test("creating a bot stores its label and face, and a bad face is refused", async () => {
  const stack = await startStack();
  try {
    const headers = {
      authorization: `Bearer ${stack.token}`,
      "content-type": "application/json",
    };
    const created = await fetch(`http://127.0.0.1:${stack.port}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "研究员",
        label: "研究",
        appearance: { shape: "star", tint: "violet" },
      }),
    });
    assert.equal(created.status, 201);
    const body = (await created.json()) as {
      bot: { label?: string; appearance?: { shape: string; tint: string } };
    };
    assert.equal(body.bot.label, "研究");
    assert.deepEqual(body.bot.appearance, { shape: "star", tint: "violet" });

    // The catalog is the authority: the same fields come back on every connection.
    const listed = await fetch(`http://127.0.0.1:${stack.port}/v1/bots`, { headers });
    const bots = (
      (await listed.json()) as {
        bots: { label?: string; appearance?: { shape: string; tint: string } }[];
      }
    ).bots;
    assert.equal(bots[0]?.label, "研究");
    assert.deepEqual(bots[0]?.appearance, { shape: "star", tint: "violet" });

    const refused = await fetch(`http://127.0.0.1:${stack.port}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "坏的", appearance: { shape: "triangle", tint: "red" } }),
    });
    assert.equal(refused.status, 400);
    assert.equal(
      ((await refused.json()) as { error: { kind: string } }).error.kind,
      "invalid_command",
    );

    const longLabel = await fetch(`http://127.0.0.1:${stack.port}/v1/bots`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "长的", label: "x".repeat(25) }),
    });
    assert.equal(longLabel.status, 400);
    assert.deepEqual(
      stack.registry.summaries().map((bot) => bot.title),
      ["研究员"],
      "nothing was written for a refused create",
    );
  } finally {
    await stack.close();
  }
});

test("a label and face survive a restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-catalog-persist-"));
  const first = await startStack({ root });
  try {
    await fetch(`http://127.0.0.1:${first.port}/v1/bots`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${first.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "持久",
        label: "存下来",
        appearance: { shape: "cloud", tint: "pink" },
      }),
    });
  } finally {
    await first.close();
  }
  const second = await startStack({ root });
  try {
    const bot = second.registry.summaries()[0];
    assert.equal(bot?.label, "存下来");
    assert.deepEqual(bot?.appearance, { shape: "cloud", tint: "pink" });
  } finally {
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("groups are created, renamed, reordered and deleted only when empty", async () => {
  const stack = await startStack();
  const headers = { authorization: `Bearer ${stack.token}`, "content-type": "application/json" };
  const call = (path: string, method: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${stack.port}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();

    const created = await call("/v1/groups", "POST", { title: " 工作 " });
    assert.equal(created.status, 201);
    const work = ((await created.json()) as { group: { id: string; title: string } }).group;
    assert.equal(work.title, "工作", "the title is trimmed");
    assert.deepEqual(
      ((await frames.next()).groups as { id: string }[]).map((group) => group.id),
      [work.id],
      "an empty catalog still carries the new group",
    );

    const life = (
      (await (await call("/v1/groups", "POST", { title: "生活" })).json()) as {
        group: { id: string };
      }
    ).group;
    await frames.next();

    const renamed = await call(`/v1/groups/${work.id}`, "PATCH", { title: "项目" });
    assert.equal(renamed.status, 200);
    assert.equal(((await renamed.json()) as { group: { title: string } }).group.title, "项目");
    await frames.next();

    const reordered = await call("/v1/groups/order", "PUT", { ids: [life.id, work.id] });
    assert.equal(reordered.status, 200);
    assert.deepEqual(
      ((await reordered.json()) as { groups: { id: string }[] }).groups.map((group) => group.id),
      [life.id, work.id],
    );
    await frames.next();

    const bot = (
      (await (await call("/v1/bots", "POST", { title: "研究员" })).json()) as {
        bot: { id: string };
      }
    ).bot;
    await frames.next();
    const moved = await call(`/v1/bots/${bot.id}`, "PATCH", { groupId: life.id });
    assert.equal(moved.status, 200);
    assert.equal(
      ((await moved.json()) as { bot: { groupId: string } }).bot.groupId,
      life.id,
      "the summary carries the group",
    );
    await frames.next();

    const refused = await call(`/v1/groups/${life.id}`, "DELETE");
    assert.equal(refused.status, 409, "a group that still holds a bot cannot be deleted");
    assert.match(
      ((await refused.json()) as { error: { message: string } }).error.message,
      /holds bots|still holds/,
    );

    const removed = await call(`/v1/groups/${work.id}`, "DELETE");
    assert.equal(removed.status, 204, "an empty group can be deleted");
    await frames.next();

    const listed = (await (await call("/v1/bots", "GET")).json()) as {
      groups: { id: string }[];
      bots: { groupId?: string }[];
    };
    assert.deepEqual(
      listed.groups.map((group) => group.id),
      [life.id],
    );
    assert.equal(listed.bots[0]?.groupId, life.id, "the catalog keeps the membership");

    assert.equal((await call("/v1/groups/order", "PUT", { ids: [] })).status, 400);
    assert.equal((await call("/v1/groups", "POST", { title: "  " })).status, 400);
    socket.close();
  } finally {
    await stack.close();
  }
});

test("task actions answer 404 for an unknown bot and refuse a bot that cannot stop tasks", async () => {
  const stack = await startStack();
  const headers = { authorization: `Bearer ${stack.token}`, "content-type": "application/json" };
  try {
    const unknown = await fetch(
      `http://127.0.0.1:${stack.port}/v1/bots/b_missing/tasks/t_1/abort`,
      { method: "POST", headers },
    );
    assert.equal(unknown.status, 404, "an unknown bot is not a task action");
  } finally {
    await stack.close();
  }
});
