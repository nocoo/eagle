import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  getCurrentSystemMessage,
  getCurrentTools,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { MAX_REPLICA_BODY_BYTES } from "../../src/core/RuntimePort.ts";
import type { HistoryBundle } from "../../src/runtime/pi/HistoryReplica.ts";
import type { ReplicaStore } from "../../src/runtime/pi/ReplicaStore.ts";
import { pageSchema } from "../../src/runtime/pi/syncProtocol.ts";
import { seedP0, sourceCarriers } from "../support/legacyReplica.ts";
import { assistant, createBench, text, toolCall, trace, waitFor } from "../support/pi.ts";
import { openReplica, pull } from "../support/replica.ts";
import { type Stack, startStack } from "../support/server.ts";

const post = (stack: Stack, bot: string, method: string, body: unknown) =>
  fetch(`http://127.0.0.1:${stack.port}/v1/bots/${bot}/replica/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${stack.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("saved-record recovery discovers a complete legacy SDK carrier missing from all source pages", async () => {
  const bench = await createBench();
  const carriers = await sourceCarriers(join(bench.dir, "source"));
  const bundle = carriers[1];
  const preflight = carriers[0];
  assert.ok(preflight);
  assert.ok(bundle && bundle.parents.length === 1);
  let stack: Stack | undefined;
  let recovered: Stack | undefined;
  try {
    const id = bench.spec().id;
    stack = await startStack({
      real: true,
      root: bench.dir,
      prepare: async ({ directory }) => {
        for (const carrier of carriers) {
          const legacy = await seedP0(
            { ...bench, spec: () => ({ ...bench.spec(), dir: directory.botDir(id) }) },
            carrier,
          );
          await legacy.harness.close(ctx);
        }
        await directory.create({
          id,
          title: "legacy saved history",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          model: bench.spec().model,
        });
      },
    });
    const current = await post(stack, id, "status", {});
    assert.equal(current.status, 200);
    const status = (await current.json()) as { heads: { head: string }[] };
    assert.ok(
      !status.heads.some((head) => head.head === bundle.head),
      "this receipt really has no P1 index",
    );
    const page = await post(stack, id, "pull", { after: 0 });
    assert.equal(page.status, 200);
    assert.deepEqual(
      ((await page.json()) as { events: unknown[] }).events,
      [],
      "source pages cannot back up this complete SDK receipt",
    );
    const prechecked = await post(stack, id, "export", { head: preflight.head });
    assert.equal(prechecked.status, 200);
    assert.deepEqual(
      await prechecked.json(),
      preflight,
      "the daemon really reads the seeded legacy SQLite",
    );
    const afterPreflight = (await (await post(stack, id, "status", {})).json()) as ReturnType<
      ReplicaStore["status"]
    >;
    assert.ok(
      !afterPreflight.heads.some((entry) => entry.head === bundle.head),
      "the second legacy carrier is still not indexed after the export precheck",
    );
    const inventory = await post(stack, id, "receipts", { after: 0, limit: 128 });
    assert.equal(
      inventory.status,
      200,
      "saved-record recovery must enumerate retained complete carriers without already knowing their heads",
    );
    const result = (await inventory.json()) as { items: { id: number; head: string }[] };
    assert.ok(result.items.some((receipt) => receipt.head === bundle.head));
    const known = await post(stack, id, "export", { head: bundle.head });
    assert.equal(known.status, 200);
    assert.deepEqual(
      await known.json(),
      bundle,
      "the carrier exists but currently needs an out-of-band family key",
    );
    assert.equal(stack.faux?.state.callCount, 0);
    const backup = join(bench.dir, "saved-standalone-p0.json");
    await writeFile(backup, JSON.stringify(bundle), { mode: 0o600 });
    const savedBytes = await readFile(backup);
    await stack.close();
    stack = undefined;
    const oldDatabase = await readFile(join(bench.dir, "bots", id, "session.sqlite"));
    recovered = await startStack({ real: true, root: join(bench.dir, "fresh") });
    const target = await recovered.createBot("recovered P0-only branch");
    const saved = JSON.parse(savedBytes.toString()) as HistoryBundle;
    assert.equal((await post(recovered, target, "import", { bundle: saved })).status, 200);
    assert.equal((await post(recovered, target, "import", { bundle: saved })).status, 200);
    assert.equal(recovered.faux?.state.callCount, 0);
    const heads = (await (await post(recovered, target, "status", {})).json()) as ReturnType<
      ReplicaStore["status"]
    >;
    assert.ok(heads.heads.some((entry) => entry.head === bundle.head && entry.ready));
    assert.ok(
      !heads.heads.some((entry) => entry.head === bundle.parents[0]),
      "a complete standalone carrier needs no separate parent receipt",
    );
    assert.deepEqual(
      await (await post(recovered, target, "export", { head: bundle.head })).json(),
      bundle,
    );
    assert.equal(
      (await post(recovered, target, "import", { bundle: { ...saved, head: "0".repeat(64) } }))
        .status,
      400,
    );
    assert.deepEqual(
      await (await post(recovered, target, "export", { head: bundle.head })).json(),
      bundle,
      "a bad backup does not poison an already runnable head",
    );
    recovered.faux?.setResponses([text("restored standalone branch continuation")]);
    assert.equal(
      (
        await post(recovered, target, "run", {
          head: bundle.head,
          requestId: "restored-p0-run",
          text: "continue without parent receipt",
        })
      ).status,
      200,
    );
    await waitFor(
      async () =>
        (
          (await (
            await post(recovered as Stack, target, "status", { requestId: "restored-p0-run" })
          ).json()) as { submission?: { status: string } }
        ).submission?.status === "done",
      "the standalone saved P0 branch run",
    );
    assert.equal(recovered.faux?.state.callCount, 1);
    assert.deepEqual(await readFile(backup), savedBytes);
    assert.deepEqual(await readFile(join(bench.dir, "bots", id, "session.sqlite")), oldDatabase);
  } finally {
    await stack?.close();
    await recovered?.close();
    await bench.cleanup();
  }
});

test("existing bounded source pages restore a fresh incarnation without old pending execution, even above 8 MiB", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-saved-recovery-"));
  const a = await openReplica(join(dir, "a"));
  let b = await startStack({ real: true, root: join(dir, "b") });
  const holder = await openReplica(join(dir, "holder"));
  const activeRelease = Promise.withResolvers<void>();
  try {
    a.faux.setResponses([
      assistant([toolCall("write", { path: "original.txt", content: "保存的工具原字节" })], {
        stopReason: "toolUse",
      }),
      text("source original result"),
    ]);
    await (
      await a.sync.root(
        { requestId: "saved-source", text: "write once", whenBusy: "followUp", trace },
        () =>
          a.root.submit({ type: "input", requestId: "saved-source", content: "write once" }, ctx),
      )
    ).wait(ctx);
    const resourceBytes = Buffer.from("saved attachment 原字节");
    const initial = await a.command("export", {
      resources: [
        {
          name: "saved.bin",
          kind: "attachment",
          base64: resourceBytes.toString("base64"),
          sha256: createHash("sha256").update(resourceBytes).digest("hex"),
        },
      ],
    });
    const parent = initial as HistoryBundle;
    a.faux.setResponses([text("pre-backup unuploaded branch result")]);
    await a.command("run", {
      head: parent.head,
      requestId: "saved-unuploaded-branch",
      text: "branch already exists before backup",
    });
    await a.harness.waitForIdle(ctx);
    const savedBranch = (await a.command("export", {
      branch: "saved-unuploaded-branch",
    })) as HistoryBundle;
    assert.deepEqual(savedBranch.parents, [parent.head]);
    assert.ok(JSON.stringify(savedBranch).includes("pre-backup unuploaded branch result"));
    const opaque = "原".repeat(1_000_000);
    await a.root.commit(async (tx) => {
      for (let i = 0; i < 3; i++)
        await tx.appendEntry(a.root.id, { kind: "saved.raw", data: { i, opaque } });
    }, ctx);
    await a.root.configure({ instructions: "Saved recovery instructions 按顺序保留" }, ctx);
    const expected = await a.root.context(ctx);
    await a.command("status", {});
    const head = a.sync.store.latestHead(a.root.id);
    assert.ok(head);
    const referenceRequests: TranscriptContext[] = [];
    a.faux.setResponses([
      (request) => {
        referenceRequests.push(request);
        return text("source same-head control");
      },
    ]);
    await a.command("run", { head, requestId: "saved-reference-run", text: "continue saved head" });
    await a.harness.waitForIdle(ctx);
    const reference = referenceRequests[0];
    assert.ok(reference);
    a.sync.store.intent({
      kind: "run",
      mode: "root",
      head,
      requestId: "saved-unadmitted",
      text: "old pending must stay passive",
      whenBusy: "followUp",
    });
    assert.equal(a.sync.store.pending().length, 1);
    assert.equal(
      await a.harness.commit((tx) => tx.submissionByRequest(a.root.id, "saved-unadmitted"), ctx),
      undefined,
    );
    let activeEntered = false;
    a.faux.setResponses([
      async () => {
        activeEntered = true;
        await activeRelease.promise;
        return text("active output after backup cutoff");
      },
    ]);
    const active = await a.sync.root(
      {
        requestId: "saved-active-run",
        text: "active at backup cutoff",
        whenBusy: "followUp",
        trace,
      },
      () =>
        a.root.submit(
          { type: "input", requestId: "saved-active-run", content: "active at backup cutoff" },
          ctx,
        ),
    );
    await waitFor(() => activeEntered, "the real source provider to be active at backup cutoff");
    const pages = [];
    let after = 0;
    for (;;) {
      const page = await pull(a, after);
      assert.ok(Buffer.byteLength(JSON.stringify({ page })) <= MAX_REPLICA_BODY_BYTES);
      pages.push(page);
      after = page.nextAfter;
      if (!page.hasMore) break;
    }
    assert.ok(pages.length >= 2);
    const events = pages.flatMap((page) => page.events);
    assert.ok(
      Buffer.byteLength(JSON.stringify(events.filter((event) => event.body.kind === "entry"))) >
        MAX_REPLICA_BODY_BYTES,
    );
    assert.ok(
      events.some(
        (event) => event.body.kind === "run" && event.body.requestId === "saved-unadmitted",
      ),
    );
    assert.ok(
      events.some(
        (event) => event.body.kind === "run" && event.body.requestId === "saved-active-run",
      ),
      "the saved log includes a genuinely active source run",
    );
    const source = pages[0]?.source;
    assert.ok(source);
    const binding = { ...a.sync.store.binding };
    const backup = join(dir, "saved-pages.json");
    await writeFile(backup, JSON.stringify(pages), { mode: 0o600 });
    const savedBytes = await readFile(backup);
    activeRelease.resolve();
    await active.wait(ctx);
    await a.close();
    const originalDatabase = await readFile(join(dir, "a/session.sqlite"));
    const originalReplica = await readFile(join(dir, "a/replica.sqlite"));
    const id = await b.createBot("recovered local incarnation");
    const before = (await (await post(b, id, "status", {})).json()) as ReturnType<
      ReplicaStore["status"]
    >;
    assert.notEqual(before.replicaId, binding.replicaId);
    assert.notEqual(before.epoch, binding.epoch);
    assert.equal((await post(b, id, "bind", { sharedBotId: binding.sharedBotId })).status, 200);
    const targetWorkspace = await realpath(join(b.directory.botDir(id), "workspace"));
    const savedPages = pageSchema.array().parse(JSON.parse(savedBytes.toString()));
    const late = savedPages.at(-1);
    assert.ok(late);
    assert.equal((await post(b, id, "apply", { page: late })).status, 200);
    const gap = (await (await post(b, id, "status", {})).json()) as ReturnType<
      ReplicaStore["status"]
    >;
    assert.equal(
      gap.streams.find((stream) => stream.source.replicaId === source.replicaId)?.applied,
      0,
    );
    assert.ok(!gap.heads.some((entry) => entry.head === head));
    assert.equal(b.faux?.state.callCount, 0);
    await b.close();
    b = await startStack({ real: true, root: join(dir, "b") });
    for (const page of savedPages) {
      assert.equal((await post(b, id, "apply", { page })).status, 200);
      assert.equal((await post(b, id, "apply", { page })).status, 200);
    }
    const restored = (await (await post(b, id, "status", {})).json()) as ReturnType<
      ReplicaStore["status"]
    >;
    assert.equal(restored.replicaId, before.replicaId);
    assert.equal(restored.epoch, before.epoch);
    assert.equal(restored.sharedBotId, binding.sharedBotId);
    assert.equal(
      restored.streams.find((stream) => stream.source.replicaId === source.replicaId)?.applied,
      after,
    );
    assert.ok(restored.heads.some((entry) => entry.head === head && entry.ready));
    assert.ok(
      restored.heads.some((entry) => entry.head === savedBranch.head && entry.ready),
      "backup contains the branch created before saving, without any peer upload",
    );
    assert.deepEqual(
      await (await post(b, id, "export", { head: savedBranch.head })).json(),
      savedBranch,
    );
    assert.equal(b.faux?.state.callCount, 0);
    const forwarded = [];
    let cursor = 0;
    for (;;) {
      const response = await post(b, id, "pull", { after: cursor, source });
      assert.equal(response.status, 200);
      const page = pageSchema.parse(await response.json());
      forwarded.push(...page.events);
      cursor = page.nextAfter;
      if (!page.hasMore) break;
    }
    assert.deepEqual(
      forwarded,
      events,
      "original stream/epoch/seq and all fact bytes are retained",
    );
    await assert.rejects(readFile(join(b.directory.botDir(id), "workspace/original.txt")), {
      code: "ENOENT",
    });
    await b.close();
    const passive = await openReplica(join(dir, "b/bots", id), id);
    try {
      assert.equal(passive.sync.store.pending().length, 0);
      const receipt = await passive.history.receipt(head);
      assert.ok(receipt);
      const conversation = await passive.harness.conversation(
        receipt.conversationId as ConversationId,
        ctx,
      );
      assert.ok(conversation);
      assert.deepEqual((await conversation.context(ctx)).messages, expected.messages);
      const raw = await passive.harness.commit(
        (tx) => tx.scanEntries({ conversationId: conversation.id, order: "ascending" }, 128),
        ctx,
      );
      assert.equal(raw.items.filter((entry) => entry.kind === "saved.raw").length, 3);
      assert.ok(
        raw.items
          .filter((entry) => entry.kind === "saved.raw")
          .every((entry) => JSON.stringify(entry.data).includes(opaque)),
      );
      assert.equal(passive.faux.state.callCount, 0);
    } finally {
      await passive.close();
    }
    b = await startStack({ real: true, root: join(dir, "b") });
    const requests: TranscriptContext[] = [];
    b.faux?.setResponses([
      (request) => {
        requests.push(request);
        return text("new recovered branch");
      },
    ]);
    const run = { head, requestId: "recovery-new-run", text: "continue saved head" };
    assert.equal((await post(b, id, "run", run)).status, 200);
    await waitFor(
      async () =>
        (
          (await (await post(b, id, "status", { requestId: run.requestId })).json()) as {
            submission?: { status: string };
          }
        ).submission?.status === "done",
      "the recovered incarnation's new run",
    );
    assert.equal((await post(b, id, "run", run)).status, 200);
    assert.equal(b.faux?.state.callCount, 1);
    assert.ok(requests[0]);
    const request = requests[0];
    const originalMessages = JSON.parse(
      JSON.stringify(expected.messages),
    ) as TranscriptContext["messages"];
    let originalIndex = 0;
    let newInput = false;
    for (const message of request.messages) {
      if (JSON.stringify(message) === JSON.stringify(originalMessages[originalIndex]))
        originalIndex += 1;
      else if (message.role !== "system") {
        assert.equal(
          originalIndex,
          originalMessages.length,
          "the new input follows all original messages",
        );
        assert.equal(message.role, "user");
        assert.equal(message.content, run.text);
        assert.equal(newInput, false, "exactly one new local user message is accepted");
        newInput = true;
      }
    }
    assert.equal(newInput, true);
    assert.equal(
      originalIndex,
      originalMessages.length,
      "all original message categories stay in order after recovery; only new local system messages can be inserted",
    );
    const sourceSystem = getCurrentSystemMessage(reference.messages);
    const targetSystem = getCurrentSystemMessage(request.messages);
    assert.ok(parent.resources.every((file) => file.kind === "attachment"));
    const resourceVersion = createHash("sha256")
      .update(JSON.stringify(parent.resources))
      .digest("hex");
    const resourceSection = (directory: string) =>
      `<bots-resources>\n${[
        `Resource version: ${resourceVersion}`,
        `Resource directory: ${directory}`,
        ...parent.resources.map((file) => `Attachment: ${join(directory, file.name)}`),
      ].join("\n\n")}\n</bots-resources>`;
    assert.equal(
      sourceSystem?.sections?.["bots-resources"],
      resourceSection(join(a.dir, "resources", resourceVersion)),
    );
    const expectedSections = Object.fromEntries(
      Object.entries(sourceSystem?.sections ?? {}).map(([key, value]) => [
        key,
        key === "bots-resources"
          ? resourceSection(join(b.directory.botDir(id), "resources", resourceVersion))
          : value === null
            ? null
            : value.replaceAll(a.workspace, targetWorkspace),
      ]),
    );
    assert.equal(
      JSON.stringify({ content: targetSystem?.content, sections: targetSystem?.sections }),
      JSON.stringify({ content: sourceSystem?.content, sections: expectedSections }),
      "all system fields and section order remain exact; only cwd and explicit local attachment metadata paths differ",
    );
    assert.match(
      targetSystem?.sections?.instructions ?? "",
      /Saved recovery instructions 按顺序保留/,
    );
    assert.deepEqual(getCurrentTools(request.messages), getCurrentTools(reference.messages));
    const changes = (messages: TranscriptContext["messages"]) =>
      messages
        .flatMap((message) =>
          message.role !== "system"
            ? []
            : [{ added: message.toolsAdded ?? [], removed: message.toolsRemoved ?? [] }],
        )
        .filter((change) => change.added.length > 0 || change.removed.length > 0);
    assert.deepEqual(
      changes(request.messages),
      changes(reference.messages),
      "all ordered tool additions/removals match the same-head source control",
    );
    assert.equal(
      (
        (await (await post(b, id, "status", { requestId: "saved-unadmitted" })).json()) as {
          submission: unknown;
        }
      ).submission,
      null,
    );
    assert.equal(
      (
        (await (await post(b, id, "status", { requestId: "saved-active-run" })).json()) as {
          submission: unknown;
        }
      ).submission,
      null,
      "a backed-up active run is never admitted on the recovered instance",
    );
    const own = pageSchema.parse(await (await post(b, id, "pull", { after: 0 })).json());
    assert.deepEqual(own.source, { replicaId: before.replicaId, epoch: before.epoch });
    assert.equal(own.events[0]?.seq, 1);
    assert.ok(
      own.events.every(
        (event) => event.body.kind !== "entry" || event.body.origin.replicaId === before.replicaId,
      ),
    );
    await holder.command("bind", { sharedBotId: binding.sharedBotId });
    for (const page of savedPages) await holder.command("apply", { page });
    assert.equal(holder.faux.state.callCount, 0);
    holder.faux.setResponses([text("holder concurrent branch")]);
    await holder.command("run", { head, requestId: "holder-new-run", text: "continue saved head" });
    await holder.harness.waitForIdle(ctx);
    const holderPage = await pull(holder);
    assert.equal((await post(b, id, "apply", { page: holderPage })).status, 200);
    await holder.command("apply", { page: own });
    const bHead = own.events.filter((event) => event.body.kind === "head").at(-1)?.body;
    const holderHead = holderPage.events.filter((event) => event.body.kind === "head").at(-1)?.body;
    assert.ok(bHead?.kind === "head" && holderHead?.kind === "head");
    assert.notEqual(bHead.head, holderHead.head);
    assert.ok(holder.sync.store.ready(bHead.head) && holder.sync.store.ready(holderHead.head));
    const both = (await (await post(b, id, "status", {})).json()) as ReturnType<
      ReplicaStore["status"]
    >;
    assert.ok(both.heads.some((entry) => entry.head === bHead.head && entry.ready));
    assert.ok(both.heads.some((entry) => entry.head === holderHead.head && entry.ready));
    await b.close();
    b = await startStack({ real: true, root: join(dir, "b") });
    const reopened = (await (await post(b, id, "status", {})).json()) as ReturnType<
      ReplicaStore["status"]
    >;
    assert.equal(reopened.replicaId, before.replicaId);
    assert.equal(reopened.epoch, before.epoch);
    for (const savedHead of [head, savedBranch.head, bHead.head, holderHead.head])
      assert.ok(
        reopened.heads.some((entry) => entry.head === savedHead && entry.ready),
        "all saved and concurrent branches survive reopen",
      );
    assert.equal(
      b.faux?.state.callCount,
      0,
      "reopening the recovered branch set replays no old runs",
    );
    assert.deepEqual(await readFile(backup), savedBytes);
    assert.deepEqual(await readFile(join(dir, "a/session.sqlite")), originalDatabase);
    assert.deepEqual(await readFile(join(dir, "a/replica.sqlite")), originalReplica);
    assert.equal(await readFile(join(dir, "a/workspace/original.txt"), "utf8"), "保存的工具原字节");
  } finally {
    activeRelease.resolve();
    await a.close();
    await b.close();
    await holder.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("receipt inventory keeps Bearer auth, Bot isolation, strict bounds and summary-only output", async () => {
  const stack = await startStack({ real: true });
  try {
    const bot = await stack.createBot("receipt boundary source");
    const other = await stack.createBot("separate receipt inventory");
    const url = `http://127.0.0.1:${stack.port}/v1/bots/${bot}/replica/receipts`;
    assert.equal((await fetch(url, { method: "POST", body: '{"after":0}' })).status, 401);
    assert.equal(
      (await fetch(url, { headers: { authorization: `Bearer ${stack.token}` } })).status,
      404,
    );
    assert.equal((await post(stack, "b_absent", "receipts", { after: 0 })).status, 404);
    for (const body of [
      {},
      { after: -1 },
      { after: 0.5 },
      { after: Number.MAX_SAFE_INTEGER + 1 },
      { after: 0, limit: 0 },
      { after: 0, limit: 129 },
      { after: 0, unexpected: true },
    ])
      assert.equal((await post(stack, bot, "receipts", body)).status, 400);
    const source = await stack.registry.open(bot, trace);
    stack.faux?.setResponses([text("inventory secret body stays out of summaries")]);
    await source.submit({
      requestId: "receipt-http-source",
      text: "original inventory body",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      async () =>
        (await source.submission({ requestId: "receipt-http-source" }))?.status === "done",
      "the source receipt to settle",
    );
    const carrier = (await (await post(stack, bot, "export", {})).json()) as HistoryBundle;
    const response = await post(stack, bot, "receipts", { after: 0, limit: 128 });
    assert.equal(response.status, 200);
    const inventory = (await response.json()) as {
      items: { id: number; head: string }[];
      nextAfter: number;
      hasMore: boolean;
    };
    assert.deepEqual(
      inventory.items.map((item) => item.head),
      [carrier.head],
    );
    assert.deepEqual(Object.keys(inventory).sort(), ["hasMore", "items", "nextAfter"]);
    assert.ok(
      inventory.items.every(
        (item) =>
          Number.isSafeInteger(item.id) &&
          item.id > 0 &&
          Object.keys(item).sort().join() === "head,id",
      ),
    );
    assert.ok(Buffer.byteLength(JSON.stringify(inventory)) <= MAX_REPLICA_BODY_BYTES);
    assert.deepEqual(await (await post(stack, other, "receipts", { after: 0 })).json(), {
      items: [],
      nextAfter: 0,
      hasMore: false,
    });
    assert.ok(!JSON.stringify(stack.records).includes("inventory secret body"));
    const fixture = JSON.parse(
      await readFile(
        new URL("../../../../fixtures/bots-sync/receipts.v1.json", import.meta.url),
        "utf8",
      ),
    ) as typeof inventory;
    assert.deepEqual(Object.keys(fixture), Object.keys(inventory));
    assert.ok(
      fixture.items.every(
        (item) => Object.keys(item).join() === "id,head" && /^[a-f0-9]{64}$/.test(item.head),
      ),
    );
  } finally {
    await stack.close();
  }
});
