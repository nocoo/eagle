import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { getCurrentSystemMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import type { Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { HistoryBundle } from "../../src/runtime/pi/HistoryReplica.ts";
import { type Page, pageSchema, type ResourceCarrier } from "../../src/runtime/pi/syncProtocol.ts";
import { assistant, createBench, text, toolCall, trace, waitFor } from "../support/pi.ts";
import { frameQueue, hello, type Stack, send, startStack } from "../support/server.ts";

const post = (stack: Stack, bot: string, method: string, params: unknown) =>
  fetch(`http://127.0.0.1:${stack.port}/v1/bots/${bot}/replica/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${stack.token}`, "content-type": "application/json" },
    body: JSON.stringify(params),
  });

test("fresh empty Bots capture/import full resources without manufacturing history or admission", async () => {
  const stores: Storage[] = [];
  const bench = await createBench({
    storage: async (path) => {
      const storage = await openNodeSqliteStorage(path);
      stores.push(storage);
      return storage;
    },
  });
  const peer = await createBench({
    storage: async (path) => {
      const storage = await openNodeSqliteStorage(path);
      stores.push(storage);
      return storage;
    },
  });
  const a = await startStack({ root: bench.dir, runtime: bench.runtime });
  let b = await startStack({ root: peer.dir, runtime: peer.runtime });
  try {
    const source = await a.createBot("fresh source");
    const target = await b.createBot("fresh target");
    const sharedBotId = randomUUID();
    for (const [stack, bot] of [
      [a, source],
      [b, target],
    ] as const) {
      assert.equal((await post(stack, bot, "bind", { sharedBotId })).status, 200);
      const handle = await stack.registry.open(bot, trace);
      assert.deepEqual((await handle.history({ limit: 128 })).messages, []);
      assert.deepEqual(await handle.busy(), { run: false, tasks: false });
      const db = new DatabaseSync(join(stack.directory.botDir(bot), "replica.sqlite"));
      try {
        for (const table of ["facts", "heads", "source_events", "local_runs", "materializations"])
          assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get()?.n, 0);
      } finally {
        db.close();
      }
    }
    const empty = async () => {
      for (const storage of stores) {
        const conversations = await storage.scanConversations({}, 128, undefined, ctx);
        for (const conversation of conversations.items)
          assert.deepEqual(
            (await storage.scanEntries({ conversationId: conversation.id }, 128, undefined, ctx))
              .items,
            [],
          );
        assert.deepEqual((await storage.scanSubmissions({}, 128, undefined, ctx)).items, []);
        assert.deepEqual((await storage.scanTasks({}, 128, undefined, ctx)).items, []);
        assert.deepEqual(
          (
            await storage.scanDocuments(
              { scope: { kind: "session" }, at: "current", kind: "bots.replica.import" },
              128,
              undefined,
              ctx,
            )
          ).items,
          [],
        );
      }
      assert.equal(bench.faux.state.callCount, 0);
      assert.equal(peer.faux.state.callCount, 0);
    };
    await empty();
    const resources = JSON.parse(
      await readFile(
        new URL("../../../../fixtures/bots-sync/resources.v1.json", import.meta.url),
        "utf8",
      ),
    ) as HistoryBundle["resources"];
    for (const file of resources) {
      const path = join(a.directory.botDir(source), "workspace", file.name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(file.base64, "base64"));
      assert.deepEqual(await readFile(path), Buffer.from(file.base64, "base64"));
    }
    const response = await post(a, source, "export", { kind: "resources", resources });
    assert.equal(response.status, 200, await response.clone().text());
    const carrier = (await response.json()) as ResourceCarrier;
    assert.equal(carrier.kind, "resources");
    assert.deepEqual(Object.keys(carrier), ["version", "kind", "head", "resources"]);
    assert.deepEqual(carrier.resources, resources);
    assert.deepEqual(
      await (await post(a, source, "export", { kind: "resources", head: carrier.head })).json(),
      carrier,
    );
    const pages: Page[] = [];
    let after = 0;
    do {
      const page = pageSchema.parse(
        await (await post(a, source, "pull", { after, limit: 2 })).json(),
      );
      pages.push(page);
      after = page.nextAfter;
    } while (pages.at(-1)?.hasMore);
    assert.equal(pages.flatMap((p) => p.events).length, resources.length + 1);
    assert.ok(
      pages.every((p) =>
        p.events.every((e) => e.body.kind === "resource" || e.body.kind === "resource_manifest"),
      ),
    );
    for (const page of [...pages].reverse()) {
      assert.equal((await post(b, target, "apply", { page })).status, 200);
      if (page !== pages[0])
        assert.equal(
          (await post(b, target, "export", { kind: "resources", head: carrier.head })).status,
          400,
        );
    }
    for (const page of pages) assert.equal((await post(b, target, "apply", { page })).status, 200);
    assert.equal((await post(b, target, "import", { bundle: carrier })).status, 200);
    assert.deepEqual(
      await (await post(b, target, "export", { kind: "resources", head: carrier.head })).json(),
      carrier,
    );
    await empty();
    const expected = (selected: ResourceCarrier) =>
      Buffer.concat(
        selected.resources
          .filter(
            (f) => f.name.endsWith("/input.txt") || f.name === "skills/fixture/assets/raw.bin",
          )
          .map((f) => Buffer.from(f.base64, "base64")),
      );
    const paths = new Map<string, string>();
    const requests: { label: string; version: string; section: string }[] = [];
    const rounds = new Map<string, number>();
    const release = Promise.withResolvers<void>();
    let entered = false;
    let second: ResourceCarrier | undefined;
    const respond = async (request: TranscriptContext) => {
      const label = String([...request.messages].reverse().find((m) => m.role === "user")?.content);
      assert.ok(
        ["fresh-first-A", "fresh-first-B", "fresh-queued-one", "fresh-queued-two"].includes(label),
      );
      const selected = label === "fresh-queued-two" ? second : carrier;
      assert.ok(selected);
      const version = createHash("sha256").update(JSON.stringify(selected.resources)).digest("hex");
      const section = getCurrentSystemMessage(request.messages)?.sections?.["bots-resources"] ?? "";
      assert.match(section, new RegExp(`Resource version: ${version}`));
      assert.match(
        section,
        new RegExp(
          `Keep resource-version-${label === "fresh-queued-two" ? "two" : "one"} instructions`,
        ),
      );
      const descriptor = selected.resources.find((f) => f.name.endsWith("/SKILL.md"));
      assert.ok(descriptor);
      assert.ok(section.includes(Buffer.from(descriptor.base64, "base64").toString("utf8")));
      const skill = /^Skill directory: (.+)$/m.exec(section)?.[1];
      const directory = /^Resource directory: (.+)$/m.exec(section)?.[1];
      assert.ok(skill && directory);
      paths.set(label, directory);
      requests.push({ label, version, section });
      const round = (rounds.get(label) ?? 0) + 1;
      rounds.set(label, round);
      if (label === "fresh-first-B" && round === 1) {
        entered = true;
        await release.promise;
      }
      if (round !== 1) return text(`${label} complete`);
      return assistant(
        [
          toolCall("read", { path: `${skill}/references/nested/input.txt` }),
          toolCall("read", { path: `${directory}/attachments/raw.bin` }),
          toolCall("bash", {
            command: `bash '${skill}/scripts/nested/run.sh' && mv result.bin '${label}.bin'`,
          }),
        ],
        { stopReason: "toolUse" },
      );
    };
    bench.faux.setResponses([respond, respond]);
    await a.service.invoke({
      botId: source,
      requestId: "fresh-first-A",
      text: "fresh-first-A",
      resourceHead: carrier.head,
      whenBusy: "followUp",
      origin: { kind: "human" },
      trace,
    });
    const aHandle = await a.registry.open(source, trace);
    await waitFor(
      async () => (await aHandle.submission({ requestId: "fresh-first-A" }))?.status === "done",
      "A first real Invocation",
    );
    assert.equal(bench.faux.state.callCount, 2);
    assert.deepEqual(
      await readFile(join(a.directory.botDir(source), "workspace/fresh-first-A.bin")),
      expected(carrier),
    );
    await a.close();
    peer.faux.setResponses(Array.from({ length: 6 }, () => respond));
    const socket = b.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId: target, trace });
    const initial = await frames.next();
    assert.equal(initial.type, "snapshot");
    assert.deepEqual((initial.value as { messages: unknown[] }).messages, []);
    try {
      await send(socket, {
        type: "send",
        requestId: "fresh-first-B",
        text: "fresh-first-B",
        resourceHead: carrier.head,
        whenBusy: "followUp",
        trace,
      });
      await waitFor(() => entered, "B actual first provider resource barrier");
      const edited = [];
      for (const file of resources) {
        const bytes =
          file.kind === "instructions" || file.name.endsWith("/input.txt")
            ? Buffer.from(
                Buffer.from(file.base64, "base64").toString("utf8").replaceAll("one", "two"),
              )
            : Buffer.from(file.base64, "base64");
        const path = join(b.directory.botDir(target), "workspace", file.name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes);
        const original = await readFile(path);
        edited.push({
          ...file,
          base64: original.toString("base64"),
          sha256: createHash("sha256").update(original).digest("hex"),
        });
      }
      const editedResponse = await post(b, target, "export", {
        kind: "resources",
        resources: edited,
      });
      assert.equal(editedResponse.status, 200, await editedResponse.clone().text());
      second = (await editedResponse.json()) as ResourceCarrier;
      assert.notEqual(second.head, carrier.head);
      for (const [requestId, head] of [
        ["fresh-queued-one", carrier.head],
        ["fresh-queued-two", second.head],
      ])
        await send(socket, {
          type: "send",
          requestId,
          text: requestId,
          resourceHead: head,
          whenBusy: "followUp",
          trace,
        });
      const users: string[] = [];
      const queued = new Set<string>();
      while (queued.size < 2) {
        const f = await frames.next();
        assert.notEqual(f.type, "error", JSON.stringify(f));
        if (f.type === "submission" && f.status === "queued") queued.add(String(f.requestId));
        if (f.type === "append" && (f.message as { role: string }).role === "user")
          users.push((f.message as { requestId: string }).requestId);
      }
      release.resolve();
      const done: string[] = [];
      while (done.length < 3) {
        const f = await frames.next();
        assert.notEqual(f.type, "error", JSON.stringify(f));
        if (f.type === "submission" && f.status === "done") done.push(String(f.requestId));
        if (f.type === "append" && (f.message as { role: string }).role === "user")
          users.push((f.message as { requestId: string }).requestId);
      }
      assert.deepEqual(done, ["fresh-first-B", "fresh-queued-one", "fresh-queued-two"]);
      assert.deepEqual(users, done);
      assert.equal(peer.faux.state.callCount, 6);
    } finally {
      release.resolve();
      socket.close();
    }
    assert.deepEqual(
      [...rounds.entries()],
      [
        ["fresh-first-A", 2],
        ["fresh-first-B", 2],
        ["fresh-queued-one", 2],
        ["fresh-queued-two", 2],
      ],
    );
    assert.notEqual(paths.get("fresh-first-A"), paths.get("fresh-first-B"));
    assert.equal(paths.get("fresh-first-B"), paths.get("fresh-queued-one"));
    assert.notEqual(paths.get("fresh-first-B"), paths.get("fresh-queued-two"));
    for (const label of ["fresh-first-B", "fresh-queued-one", "fresh-queued-two"]) {
      assert.ok(second);
      assert.deepEqual(
        await readFile(join(b.directory.botDir(target), `workspace/${label}.bin`)),
        expected(label === "fresh-queued-two" ? second : carrier),
      );
      for (const file of (label === "fresh-queued-two" ? second : carrier).resources)
        assert.deepEqual(
          await readFile(join(paths.get(label) ?? "", file.name)),
          Buffer.from(file.base64, "base64"),
        );
    }
    const local = (await (await post(b, target, "export", {})).json()) as HistoryBundle;
    assert.equal(local.entries.filter((e) => e.model?.[0]?.role === "user").length, 3);
    assert.ok(local.entries.some((e) => e.kind === "pi.tool-result"));
    assert.ok(!JSON.stringify(local.entries).includes('"isError":true'));
    await b.close();
    b = await startStack({ root: peer.dir, runtime: peer.runtime });
    const before = peer.faux.state.callCount;
    await b.service.invoke({
      botId: target,
      requestId: "fresh-first-B",
      text: "fresh-first-B",
      whenBusy: "followUp",
      origin: { kind: "human" },
      trace,
    });
    for (const whenBusy of ["steer", "reject"] as const)
      await assert.rejects(
        b.service.invoke({
          botId: target,
          requestId: "fresh-first-B",
          text: "fresh-first-B",
          whenBusy,
          origin: { kind: "human" },
          trace,
        }),
      );
    assert.equal(peer.faux.state.callCount, before);
    const db = new DatabaseSync(join(b.directory.botDir(target), "replica.sqlite"));
    try {
      const runs = db
        .prepare("SELECT value FROM local_runs ORDER BY rowid")
        .all()
        .map(
          (row) =>
            JSON.parse(String(row.value)) as {
              intent: { resourceHead: string; whenBusy: string; resourceVersion: string };
              admitted: boolean;
              rejected: boolean;
            },
        );
      assert.deepEqual(
        runs.map((r) => r.intent.resourceHead),
        [carrier.head, carrier.head, second?.head],
      );
      assert.ok(runs.every((r) => r.admitted && !r.rejected && r.intent.whenBusy === "followUp"));
      const facts = db
        .prepare("SELECT value FROM facts")
        .all()
        .map((row) => JSON.parse(String(row.value)) as { kind: string });
      assert.equal(facts.filter((f) => f.kind === "resource").length, 8);
      assert.equal(facts.filter((f) => f.kind === "resource_manifest").length, 2);
      assert.ok(!JSON.stringify(runs).includes("base64"));
    } finally {
      db.close();
    }
  } finally {
    await Promise.allSettled([a.close(), b.close()]);
    await Promise.all([bench.cleanup(), peer.cleanup()]);
  }
});
