import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  getCurrentSystemMessage,
  getCurrentTools,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { AgentDoc, type ConversationId, ProviderDoc } from "@earendil-works/pi-durable";
import { MAX_REPLICA_BODY_BYTES } from "../../src/core/RuntimePort.ts";
import type { HistoryBundle } from "../../src/runtime/pi/HistoryReplica.ts";
import { factSchema, keyOf } from "../../src/runtime/pi/syncProtocol.ts";
import { assistant, createBench, text, toolCall, trace, waitFor } from "../support/pi.ts";
import { openReplica, pull, transfer } from "../support/replica.ts";

test("bounded head metadata discovers incremental ready heads and a passive two-parent merge without carrier bodies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-head-directory-"));
  const a = await openReplica(join(dir, "a"));
  const b = await openReplica(join(dir, "b"));
  try {
    await b.command("bind", { sharedBotId: a.sync.store.binding.sharedBotId });
    a.faux.setResponses([text("seed response")]);
    await (
      await a.root.submit({ type: "input", content: "head seed", requestId: "head_seed_01" }, ctx)
    ).wait(ctx);
    await a.harness.waitForIdle(ctx);
    await transfer(a, b);
    const first = (await b.command("heads", { after: 0, limit: 1 })) as {
      items: {
        head: string;
        ready: boolean;
        parents: string[];
        source: unknown;
        resources: unknown[];
      }[];
      nextAfter: number;
      hasMore: boolean;
    };
    assert.equal(first.items.length, 1);
    const seed = first.items[0];
    assert.ok(seed?.ready);
    assert.ok(seed.source);
    assert.doesNotMatch(JSON.stringify(first), /head seed|seed response|base64|"model"/);
    const detail = (await b.command("head", { head: seed.head })) as {
      head: string;
      entries: number;
      resources: unknown[];
    };
    assert.equal(detail.head, seed.head);
    assert.ok(detail.entries > 0);
    for (const [replica, requestId, response] of [
      [a, "head_left_01", "left history"],
      [b, "head_right_01", "right history"],
    ] as const) {
      replica.faux.setResponses([text(response)]);
      await replica.command("run", { head: seed.head, requestId, text: "continue shared seed" });
      await replica.harness.waitForIdle(ctx);
    }
    const left = (await a.command("export", { branch: "head_left_01" })) as HistoryBundle;
    const right = (await b.command("export", { branch: "head_right_01" })) as HistoryBundle;
    await transfer(a, b);
    let after = first.nextAfter;
    const heads = new Set([seed.head]);
    let more = true;
    while (more) {
      const page = (await b.command("heads", { after, limit: 1 })) as typeof first;
      for (const item of page.items) heads.add(item.head);
      assert.ok(page.nextAfter >= after);
      after = page.nextAfter;
      more = page.hasMore;
    }
    assert.ok(heads.has(left.head) && heads.has(right.head));
    const calls = b.faux.state.callCount;
    const merged = (await b.command("merge", {
      heads: [left.head, right.head],
      requestId: "head_merge_01",
    })) as { head: string };
    const metadata = (await b.command("head", { head: merged.head })) as {
      parents: string[];
      ready: boolean;
    };
    assert.deepEqual(metadata.parents, [left.head, right.head]);
    assert.equal(metadata.ready, true);
    assert.equal(b.faux.state.callCount, calls);
    const tail = (await b.command("heads", { after, limit: 128 })) as typeof first;
    assert.ok(tail.items.some((item) => item.head === merged.head));
    assert.equal(JSON.stringify(tail).includes("left history"), false);
    const resource: HistoryBundle["resources"][number] = {
      name: "AGENTS.md",
      kind: "instructions",
      base64: Buffer.from("native selector resource bytes 中文").toString("base64"),
      sha256: createHash("sha256").update("native selector resource bytes 中文").digest("hex"),
    };
    const withResources = (await b.command("export", {
      head: merged.head,
      resources: [resource],
    })) as HistoryBundle;
    const beforeSelectionCalls = a.faux.state.callCount;
    await transfer(b, a);
    const selected = (await a.command("head", { head: withResources.head })) as {
      ready: boolean;
      resourceHead: string;
    };
    assert.equal(selected.ready, true);
    assert.deepEqual(withResources.parents, [merged.head]);
    const resourceManifest = keyOf({
      kind: "resource_manifest",
      resources: [keyOf({ kind: "resource", resource })],
    });
    assert.equal(
      a.sync.store.fact(resourceManifest),
      undefined,
      "existing head has no standalone manifest",
    );
    const context = (await a.command("context", {
      contextId: "native_metadata_resource_context",
      head: withResources.head,
      resourceHead: selected.resourceHead,
    })) as { contextId: string; resourceHead: string };
    assert.equal(context.contextId, "native_metadata_resource_context");
    assert.equal(context.resourceHead, selected.resourceHead);
    assert.equal(selected.resourceHead, withResources.head);
    assert.equal(
      a.sync.store.fact(resourceManifest),
      undefined,
      "selection does not backfill a fact",
    );
    assert.deepEqual(
      ((await b.command("export", { head: withResources.head })) as HistoryBundle).resources,
      [resource],
    );
    assert.equal(b.faux.state.callCount, calls, "native context selection remains passive");
    assert.equal(a.faux.state.callCount, beforeSelectionCalls, "imported selection stays passive");
  } finally {
    await Promise.all([a.close(), b.close()]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("incremental source history stays original through paging, passive forwarding, forks and restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-incremental-"));
  let a = await openReplica(join(dir, "a"));
  let b = await openReplica(join(dir, "b"));
  const c = await openReplica(join(dir, "c"));
  try {
    await b.command("bind", { sharedBotId: a.sync.store.binding.sharedBotId });
    await c.command("bind", { sharedBotId: a.sync.store.binding.sharedBotId });
    await a.root.reset("explicit original reset", ctx);
    await a.root.configure({ instructions: "P1 exact instructions 原始" }, ctx);
    a.faux.setResponses([
      assistant([toolCall("write", { path: "original.txt", content: "增量工具原字节" })], {
        stopReason: "toolUse",
      }),
      text("saved original"),
    ]);
    await (
      await a.sync.root(
        { requestId: "source-1", text: "write once", whenBusy: "followUp", trace: "tr_sync" },
        () => a.root.submit({ type: "input", requestId: "source-1", content: "write once" }, ctx),
      )
    ).wait(ctx);
    await a.harness.waitForIdle(ctx);
    assert.equal(await readFile(join(a.workspace, "original.txt"), "utf8"), "增量工具原字节");
    await a.root.commit(async (tx) => {
      for (let index = 0; index < 225; index += 1)
        await tx.appendEntry(a.root.id, {
          kind: "pi.user",
          model: [{ role: "user", content: `original page ${index}`, timestamp: index }],
          data: { index },
        });
    }, ctx);
    const tail = (await a.root.entries({ order: "descending" }, 1, undefined, ctx)).items[0];
    assert.ok(tail);
    await a.root.commit(async (tx) => {
      await tx.appendEntry(a.root.id, {
        kind: "fixture.edit",
        edits: [
          {
            target: tail.id,
            action: "replace",
            messages: [{ role: "user", content: "edited original", timestamp: 0 }],
          },
        ],
      });
    }, ctx);
    a.faux.setResponses([text("compact original sources")]);
    const compaction = await a.root.compact(undefined, ctx);
    await a.harness.waitForTask(compaction, ctx);
    await a.harness.waitForIdle(ctx);
    const expected = await a.root.context(ctx);
    const pages = await transfer(a, b);
    assert.ok(pages.length >= 2);
    const events = pages.flatMap((page) => page.events);
    assert.ok(events.filter((event) => event.body.kind === "entry").length > 225);
    assert.ok(
      events.some(
        (event) => event.body.kind === "entry" && event.body.content.kind === "pi.tool-result",
      ),
    );
    assert.ok(
      pages.every(
        (page) =>
          page.events.length <= 128 &&
          Buffer.byteLength(JSON.stringify({ page })) <= MAX_REPLICA_BODY_BYTES,
      ),
    );
    const last = pages.at(-1);
    assert.ok(last);
    const manifest = events.filter((event) => event.body.kind === "head").at(-1)?.body;
    assert.ok(manifest?.kind === "head");
    assert.ok(
      events.some(
        (event) => event.body.kind === "entry" && event.body.content.kind === "pi.compaction",
      ),
    );
    const bundle = (await b.command("export", { head: manifest.head })) as HistoryBundle;
    const receipt = await b.history.receipt(bundle.head);
    assert.ok(receipt);
    const imported = await b.harness.conversation(receipt.conversationId as ConversationId, ctx);
    assert.ok(imported);
    assert.deepEqual((await imported.context(ctx)).messages, expected.messages);
    assert.equal(b.faux.state.callCount, 0);
    assert.equal(
      b.sync.store.pending().length,
      0,
      "foreign run facts cannot become local recovery intents",
    );
    await assert.rejects(readFile(join(b.workspace, "original.txt")), { code: "ENOENT" });
    await transfer(b, c, last.source);
    assert.deepEqual(await c.command("export", { head: bundle.head }), bundle);
    assert.equal(c.faux.state.callCount, 0);
    assert.equal(
      (await pull(b)).events.length,
      0,
      "forwarded facts never acquire a new local origin",
    );
    const before = last.nextAfter;
    await a.root.commit(async (tx) => {
      await tx.appendEntry(a.root.id, {
        kind: "fixture.new",
        model: [{ role: "user", content: "only new fact", timestamp: 1 }],
      });
    }, ctx);
    const increment = await transfer(a, b, undefined, before);
    assert.equal(
      increment.flatMap((page) => page.events).filter((event) => event.body.kind === "entry")
        .length,
      1,
      "subsequent pull contains no old entry bodies",
    );
    const aRequests: TranscriptContext[] = [];
    const bRequests: TranscriptContext[] = [];
    a.faux.setResponses([
      (request) => {
        aRequests.push(request);
        return text("A concurrent output");
      },
    ]);
    b.faux.setResponses([
      (request) => {
        bRequests.push(request);
        return text("B concurrent output");
      },
    ]);
    await Promise.all([
      a.command("run", { head: bundle.head, requestId: "branch-A", text: "continue shared head" }),
      b.command("run", { head: bundle.head, requestId: "branch-B", text: "continue shared head" }),
    ]);
    await Promise.all([a.harness.waitForIdle(ctx), b.harness.waitForIdle(ctx)]);
    const aRequest = aRequests[0];
    const bRequest = bRequests[0];
    assert.ok(aRequest && bRequest);
    assert.equal(
      JSON.stringify(getCurrentSystemMessage(bRequest.messages)?.sections),
      JSON.stringify(getCurrentSystemMessage(aRequest.messages)?.sections).replaceAll(
        a.workspace,
        b.workspace,
      ),
    );
    assert.deepEqual(getCurrentTools(bRequest.messages), getCurrentTools(aRequest.messages));
    const normalize = (value: unknown) =>
      JSON.stringify(value)
        .replaceAll(a.workspace, "<local-workspace>")
        .replaceAll(b.workspace, "<local-workspace>");
    const inputs = (request: TranscriptContext) =>
      request.messages
        .filter((message) => message.role !== "system")
        .map((message, index, messages) =>
          index === messages.length - 1 ? { ...message, timestamp: 0 } : message,
        );
    assert.equal(
      normalize(inputs(bRequest)),
      normalize(inputs(aRequest)),
      "every non-system message matches the same-head real source control",
    );
    const changes = (request: TranscriptContext) =>
      request.messages.flatMap((message) =>
        message.role === "system"
          ? [
              {
                content: message.content,
                sections: message.sections,
                added: message.toolsAdded ?? [],
                removed: message.toolsRemoved ?? [],
              },
            ]
          : [],
      );
    const sourceChanges = changes(aRequest);
    const targetChanges = changes(bRequest);
    assert.equal(
      normalize(targetChanges.slice(0, sourceChanges.length)),
      normalize(sourceChanges),
      "original ordered system content, sections and full tool declarations survive provider preparation",
    );
    for (const update of targetChanges.slice(sourceChanges.length)) {
      assert.deepEqual(
        Object.keys(update.sections ?? {}),
        ["bots-tools"],
        "only the SDK's local cwd update is additional",
      );
      assert.deepEqual(update.added, []);
      assert.deepEqual(update.removed, []);
      assert.equal(update.content, "");
    }
    await transfer(a, b, undefined, increment.at(-1)?.nextAfter);
    await transfer(b, a);
    const branches = [
      a.sync.store.latestHead((await a.history.branch("branch-A"))?.conversationId ?? 0),
      b.sync.store.latestHead((await b.history.branch("branch-B"))?.conversationId ?? 0),
    ];
    assert.ok(branches.every((head) => head !== null));
    assert.notEqual(branches[0], branches[1]);
    for (const head of branches) {
      assert.ok(head && a.sync.store.ready(head) && b.sync.store.ready(head));
      const branchBundle = (await b.command("export", { head })) as HistoryBundle;
      assert.deepEqual(branchBundle.parents, [bundle.head]);
      for (const origin of Object.values(bundle.origins))
        assert.ok(
          Object.values(branchBundle.origins).some(
            (candidate) => JSON.stringify(candidate) === JSON.stringify(origin),
          ),
        );
    }
    await Promise.all([a.close(), b.close()]);
    a = await openReplica(join(dir, "a"));
    b = await openReplica(join(dir, "b"));
    assert.equal(
      a.faux.state.callCount + b.faux.state.callCount,
      0,
      "reopen never executes received or already admitted runs",
    );
    for (const head of branches)
      assert.ok(head && a.sync.store.ready(head) && b.sync.store.ready(head));
    await a.close();
    b.faux.setResponses([text("B runs with A offline")]);
    await b.command("run", {
      head: branches[0],
      requestId: "offline-B",
      text: "new local continuation",
    });
    await b.harness.waitForIdle(ctx);
    assert.equal(b.faux.state.callCount, 1);
  } finally {
    await Promise.allSettled([a.close(), b.close(), c.close()]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("durable source gaps, duplicate/conflict detection and Bot/epoch bindings never certify missing history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-gaps-"));
  const a = await openReplica(join(dir, "a"));
  const b = await openReplica(join(dir, "b"));
  try {
    await b.command("bind", { sharedBotId: a.sync.store.binding.sharedBotId });
    await a.root.commit(async (tx) => {
      for (let i = 0; i < 3; i += 1)
        await tx.appendEntry(a.root.id, { kind: "fixture", data: { i } });
    }, ctx);
    const original = await pull(a);
    assert.ok(original.events.length >= 4);
    const single = (seq: number) => ({
      ...original,
      events: original.events.filter((event) => event.seq === seq),
      nextAfter: seq,
      hasMore: seq < original.range.to,
    });
    await b.command("apply", { page: single(3) });
    assert.deepEqual(b.sync.store.stream(original.source), {
      known: original.range.to,
      received: 0,
      applied: 0,
    });
    await b.command("apply", { page: single(1) });
    assert.equal(b.sync.store.stream(original.source).applied, 1);
    await b.command("apply", { page: single(2) });
    assert.equal(b.sync.store.stream(original.source).applied, 3);
    await b.command("apply", { page: original });
    const state = b.sync.store.status();
    await b.command("apply", { page: original });
    assert.deepEqual(b.sync.store.status(), state);
    const conflict = structuredClone(single(1));
    const first = conflict.events[0];
    assert.ok(first?.body.kind === "entry");
    first.body.content.data = { different: true };
    await assert.rejects(b.command("apply", { page: conflict }), /different content/);
    await assert.rejects(
      b.command("apply", { page: { ...original, sharedBotId: randomUUID() } }),
      /binding mismatch/,
    );
    await assert.rejects(
      b.command("apply", {
        page: { ...original, source: { ...original.source, epoch: randomUUID() } },
      }),
      /epoch mismatch/,
    );
    assert.deepEqual(b.sync.store.status(), state, "rejections do not consume the original stream");
    assert.equal(b.faux.state.callCount, 0);
  } finally {
    await Promise.all([a.close(), b.close()]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a complete head waits for cross-stream facts and never acknowledges an absent dependency", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-dependencies-"));
  const a = await openReplica(join(dir, "a"));
  const b = await openReplica(join(dir, "b"));
  const c = await openReplica(join(dir, "c"));
  try {
    await b.command("bind", { sharedBotId: a.sync.store.binding.sharedBotId });
    await c.command("bind", { sharedBotId: a.sync.store.binding.sharedBotId });
    await a.root.commit(async (tx) => {
      await tx.appendEntry(a.root.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "ancestor", timestamp: 0 }],
      });
    }, ctx);
    const sourcePages = await transfer(a, b);
    const parent = sourcePages
      .flatMap((page) => page.events)
      .filter((event) => event.body.kind === "head")
      .at(-1)?.body;
    assert.ok(parent?.kind === "head");
    b.faux.setResponses([text("branch output")]);
    await b.command("run", { head: parent.head, requestId: "dep-branch", text: "continue" });
    await b.harness.waitForIdle(ctx);
    const branchPage = await pull(b);
    await c.command("apply", { page: branchPage });
    const branchHead = branchPage.events.filter((event) => event.body.kind === "head").at(-1)?.body;
    assert.ok(branchHead?.kind === "head");
    assert.equal(c.sync.store.ready(branchHead.head), false);
    assert.ok(c.sync.store.stream(branchPage.source).applied < branchPage.nextAfter);
    for (const page of sourcePages) await c.command("apply", { page });
    assert.equal(c.sync.store.ready(branchHead.head), true);
    assert.equal(c.sync.store.stream(branchPage.source).applied, branchPage.nextAfter);
    assert.equal(c.faux.state.callCount, 0);
  } finally {
    await Promise.all([a.close(), b.close(), c.close()]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("one oversized committed entry stays in its source log and prevents skipping to later small records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-oversized-"));
  const a = await openReplica(join(dir, "a"));
  try {
    await a.root.commit(async (tx) => {
      await tx.appendEntry(a.root.id, {
        kind: "fixture.oversize",
        data: "x".repeat(MAX_REPLICA_BODY_BYTES),
      });
      await tx.appendEntry(a.root.id, { kind: "fixture.small", data: "must not skip" });
    }, ctx);
    await assert.rejects(pull(a), /single source event exceeds/);
    const source = a.sync.store.sources()[0];
    assert.ok(source);
    assert.equal(a.sync.store.event(source, 1)?.kind, "entry");
    assert.ok(a.sync.store.event(source, 2));
    await assert.rejects(pull(a), /single source event exceeds/);
    assert.equal(a.faux.state.callCount, 0);
  } finally {
    await a.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("incremental heads retain explicit resource versions and install them before continuation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-resource-log-"));
  const a = await openReplica(join(dir, "a"));
  const b = await openReplica(join(dir, "b"));
  try {
    await b.command("bind", { sharedBotId: a.sync.store.binding.sharedBotId });
    await a.root.commit(async (tx) => {
      await tx.appendEntry(a.root.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "resource source", timestamp: 0 }],
      });
    }, ctx);
    const bytes = Buffer.from("original instructions bytes");
    const resource = {
      name: "AGENTS.md",
      kind: "instructions",
      base64: bytes.toString("base64"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    await a.command("export", { resources: [resource] });
    const initial = await transfer(a, b);
    await a.root.commit(async (tx) => {
      await tx.appendEntry(a.root.id, { kind: "fixture.next", data: "new source" });
    }, ctx);
    const pages = await transfer(a, b, undefined, initial.at(-1)?.nextAfter);
    assert.equal(
      pages.flatMap((page) => page.events).filter((event) => event.body.kind === "resource").length,
      0,
      "unchanged resource bytes are not sent twice",
    );
    const head = pages
      .flatMap((page) => page.events)
      .filter((event) => event.body.kind === "head")
      .at(-1)?.body;
    assert.ok(head?.kind === "head");
    assert.deepEqual(
      ((await b.command("export", { head: head.head })) as HistoryBundle).resources,
      [resource],
    );
    assert.equal(b.faux.state.callCount, 0, "incremental resource application stays passive");
    b.faux.setResponses([
      (request) => {
        assert.match(
          getCurrentSystemMessage(request.messages)?.sections?.["bots-resources"] ?? "",
          /original instructions bytes/,
        );
        return text("installed resources continued");
      },
    ]);
    await b.command("run", {
      head: head.head,
      requestId: "resource-run",
      text: "execute the installed selected version",
    });
    await b.harness.waitForIdle(ctx);
    assert.equal(b.sync.store.pending().length, 0);
    assert.equal(b.sync.store.run("resource-run")?.admitted, true);
    assert.equal(b.faux.state.callCount, 1);
  } finally {
    await Promise.all([a.close(), b.close()]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("an invalid received head cannot block restart or a different complete local head", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-bad-head-"));
  const a = await openReplica(join(dir, "a"));
  let b = await openReplica(join(dir, "b"));
  try {
    await b.command("bind", { sharedBotId: a.sync.store.binding.sharedBotId });
    for (const replica of [a, b])
      await replica.root.commit(async (tx) => {
        await tx.appendEntry(replica.root.id, {
          kind: "pi.user",
          model: [{ role: "user", content: "existing local context", timestamp: 0 }],
        });
      }, ctx);
    const localPage = await pull(b);
    const local = localPage.events.filter((event) => event.body.kind === "head").at(-1)?.body;
    assert.ok(local?.kind === "head");
    const bad = await pull(a);
    const head = bad.events.find((event) => event.body.kind === "head");
    assert.ok(head?.body.kind === "head");
    head.body.head = "f".repeat(64);
    await assert.rejects(b.command("apply", { page: bad }), /digest mismatch/);
    assert.ok(b.sync.store.stream(bad.source).applied < head.seq);
    await b.close();
    b = await openReplica(join(dir, "b"));
    assert.equal(b.sync.store.ready(local.head), true);
    assert.equal(b.sync.store.ready(head.body.head), false);
    assert.ok(b.sync.store.stream(bad.source).applied < head.seq);
    b.faux.setResponses([text("still runs locally")]);
    await b.command("run", {
      head: local.head,
      requestId: "healthy-run",
      text: "continue existing local context",
    });
    await b.harness.waitForIdle(ctx);
    assert.equal(b.faux.state.callCount, 1);
  } finally {
    await Promise.allSettled([a.close(), b.close()]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("the page byte budget stops SQLite body reads after the first event that will not fit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-page-budget-"));
  const a = await openReplica(dir);
  try {
    await a.root.commit(async (tx) => {
      for (let i = 0; i < 128; i += 1)
        await tx.appendEntry(a.root.id, {
          kind: "fixture.large",
          data: { i, body: "x".repeat(100_000) },
        });
    }, ctx);
    await a.command("status", {});
    let read = 0;
    const prepare = a.sync.store.db.prepare.bind(a.sync.store.db);
    a.sync.store.db.prepare = (sql) => {
      const statement = prepare(sql);
      if (
        !statement.columns().some((column) => column.name === "event") ||
        !statement.columns().some((column) => column.name === "seq")
      )
        return statement;
      return new Proxy(statement, {
        get(target, key) {
          if (key === "all")
            return (...args: Parameters<typeof statement.all>) => {
              const rows = target.all(...args);
              read += rows.length;
              return rows;
            };
          if (key === "iterate")
            return function* (...args: Parameters<typeof statement.iterate>) {
              for (const row of target.iterate(...args)) {
                read += 1;
                yield row;
              }
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    const page = await pull(a);
    assert.ok(page.events.length < 128 && page.hasMore);
    assert.ok(Buffer.byteLength(JSON.stringify({ page })) <= MAX_REPLICA_BODY_BYTES);
    assert.ok(
      read <= page.events.length + 1,
      `read ${read} bodies for ${page.events.length} delivered events`,
    );
  } finally {
    await a.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("schema-valid edit facts with absent or mismatched target aliases cannot poison a head or stop local recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-bad-aliases-"));
  try {
    for (const variant of ["absent", "mismatch", "extra"]) {
      const a = await openReplica(join(dir, variant, "a"));
      let b = await openReplica(join(dir, variant, "b"));
      try {
        await b.command("bind", { sharedBotId: a.sync.store.binding.sharedBotId });
        await b.root.commit(async (tx) => {
          await tx.appendEntry(b.root.id, {
            kind: "pi.user",
            model: [{ role: "user", content: "healthy previous head", timestamp: 0 }],
          });
        }, ctx);
        const local = (await pull(b)).events
          .filter((event) => event.body.kind === "head")
          .at(-1)?.body;
        assert.ok(local?.kind === "head");
        await a.root.commit(async (tx) => {
          const entry = await tx.appendEntry(a.root.id, {
            kind: "pi.user",
            model: [{ role: "user", content: "original before edit", timestamp: 0 }],
          });
          await tx.appendEntry(a.root.id, {
            kind: "fixture.edit",
            edits: [{ target: entry.id, action: "omit" }],
          });
        }, ctx);
        const page = await pull(a);
        const head = page.events.filter((event) => event.body.kind === "head").at(-1);
        assert.ok(head?.body.kind === "head");
        const alias = head.body.entries.at(-1);
        assert.ok(alias);
        if (variant === "absent") delete alias.targets;
        else alias.targets = variant === "mismatch" ? [] : [...(alias.targets ?? []), 999];
        await assert.rejects(b.command("apply", { page }), {
          name: "ClassifiedFailure",
          disposition: "not_admitted",
        });
        assert.ok(b.sync.store.stream(page.source).applied < head.seq);
        assert.equal(
          b.sync.store.head(head.body.head),
          undefined,
          "unverified values never occupy a global head key",
        );
        await b.close();
        b = await openReplica(join(dir, variant, "b"));
        b.faux.setResponses([text("healthy local answer")]);
        await b.command("run", {
          head: local.head,
          requestId: "healthy-alias-run",
          text: "continue locally",
        });
        await b.harness.waitForIdle(ctx);
        assert.equal(b.faux.state.callCount, 1);
      } finally {
        await Promise.allSettled([a.close(), b.close()]);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the normative incremental page materializes the exact P0 baseline without passive execution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-page-fixture-"));
  const b = await openReplica(dir);
  try {
    const page = JSON.parse(
      await readFile(
        new URL("../../../../fixtures/bots-sync/page.v1.json", import.meta.url),
        "utf8",
      ),
    );
    const bundle = JSON.parse(
      await readFile(
        new URL("../../../../fixtures/bots-sync/history.v1.json", import.meta.url),
        "utf8",
      ),
    ) as HistoryBundle;
    await b.command("bind", { sharedBotId: page.sharedBotId });
    assert.deepEqual(
      await b.command("bind", { sharedBotId: page.sharedBotId }),
      b.sync.store.binding,
    );
    await b.command("apply", { page });
    assert.deepEqual(await b.command("export", { head: bundle.head }), bundle);
    assert.equal(b.faux.state.callCount, 0);
    await assert.rejects(
      b.command("bind", { sharedBotId: randomUUID() }),
      /populated replica binding/,
    );
    await assert.rejects(
      b.command("pull", { after: 0, limit: 129 }),
      /invalid replica sync request/,
    );
    await assert.rejects(
      b.command("pull", { after: 0, source: { replicaId: randomUUID(), epoch: randomUUID() } }),
      /unknown source/,
    );
    await assert.rejects(
      b.command("apply", { page: { ...page, source: b.sync.store.binding } }),
      /invalid replica sync request/,
    );
    await assert.rejects(
      b.command("apply", {
        page: {
          ...page,
          source: { replicaId: b.sync.store.binding.replicaId, epoch: b.sync.store.binding.epoch },
        },
      }),
      /local source stream/,
    );
  } finally {
    await b.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("background scan failure uses the runtime trace and one redacted failure episode without stopping local input", async () => {
  const bench = await createBench();
  const spec = bench.spec();
  const handle = await bench.runtime.open(spec);
  try {
    bench.faux.setResponses([text("first real output")]);
    await handle.submit({
      requestId: "before-fault",
      text: "private source text",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      async () => (await handle.submission({ requestId: "before-fault" }))?.status === "done",
      "first output",
    );
    await handle.replica?.({ method: "status", params: {}, trace });
    const db = new DatabaseSync(join(spec.dir, "replica.sqlite"));
    db.exec("ALTER TABLE local_entries RENAME TO fault_preserved_local_entries");
    db.close();
    bench.faux.setResponses([text("second real output")]);
    await handle.submit({
      requestId: "after-fault",
      text: "private newer text",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      () => bench.records.some((record) => record.evt === "runtime.replica.fail"),
      "background classified failure",
    );
    await waitFor(
      async () => (await handle.submission({ requestId: "after-fault" }))?.status === "done",
      "local input despite broken sync facts",
    );
    bench.faux.setResponses([text("third real output")]);
    await handle.submit({
      requestId: "repeat-fault",
      text: "private repeat text",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      async () => (await handle.submission({ requestId: "repeat-fault" }))?.status === "done",
      "repeat local input",
    );
    const fixed = new DatabaseSync(join(spec.dir, "replica.sqlite"));
    fixed.exec("ALTER TABLE fault_preserved_local_entries RENAME TO local_entries");
    fixed.close();
    await handle.replica?.({ method: "status", params: {}, trace });
    const again = new DatabaseSync(join(spec.dir, "replica.sqlite"));
    again.exec("ALTER TABLE local_entries RENAME TO fault_preserved_local_entries");
    again.close();
    bench.faux.setResponses([text("fourth real output")]);
    await handle.submit({
      requestId: "new-fault",
      text: "private last text",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      () => bench.records.filter((record) => record.evt === "runtime.replica.fail").length >= 2,
      "new scan failure episode after recovery",
    );
    await waitFor(
      async () => (await handle.submission({ requestId: "new-fault" }))?.status === "done",
      "final local input",
    );
    await handle.close(trace, 5000);
    const failures = bench.records.filter((record) => record.evt === "runtime.replica.fail");
    assert.equal(
      failures.length,
      2,
      "consecutive failures dedupe; successful recovery starts a new episode",
    );
    assert.ok(failures[0]?.err?.failure && failures[1]?.err?.failure);
    assert.notEqual(failures[0]?.err?.failure, failures[1]?.err?.failure);
    assert.equal(failures[0]?.trace, spec.trace);
    assert.equal(failures[0]?.botId, spec.id);
    assert.equal(failures[0]?.level, "error");
    assert.doesNotMatch(
      JSON.stringify(bench.records),
      /private source text|private newer text|private repeat text|private last text|first real output|second real output/,
    );
    assert.equal(bench.faux.state.callCount, 4);
  } finally {
    await handle.close(trace, 5000);
    await bench.cleanup();
  }
});

test("a standalone invalid resource SRI remains received but never applied or shared, and local heads survive restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-resource-sri-"));
  let b = await openReplica(dir);
  try {
    await b.root.commit(async (tx) => {
      await tx.appendEntry(b.root.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "existing local resource-safe head", timestamp: 0 }],
      });
    }, ctx);
    const head = (await pull(b)).events.filter((event) => event.body.kind === "head").at(-1)?.body;
    assert.ok(head?.kind === "head");
    const page = {
      version: 1,
      sharedBotId: b.sync.store.binding.sharedBotId,
      source: { replicaId: randomUUID(), epoch: randomUUID() },
      range: { from: 1, to: 1 },
      events: [
        {
          seq: 1,
          body: {
            kind: "resource",
            resource: {
              name: "bad.txt",
              kind: "attachment",
              base64: "YQ==",
              sha256: "0".repeat(64),
            },
          },
        },
      ],
      nextAfter: 1,
      hasMore: false,
    };
    await assert.rejects(b.command("apply", { page }), /invalid resource bytes/);
    assert.deepEqual(b.sync.store.stream(page.source), { known: 1, received: 1, applied: 0 });
    assert.equal(b.sync.store.blocked(page.source), 1);
    assert.equal(
      b.sync.store.fact(keyOf(factSchema.parse(page.events[0]?.body))),
      undefined,
      "bad SRI cannot enter shared facts before an ACK",
    );
    await b.close();
    b = await openReplica(dir);
    assert.equal(b.sync.store.stream(page.source).applied, 0);
    b.faux.setResponses([text("healthy despite bad SRI")]);
    await b.command("run", {
      head: head.head,
      requestId: "sri-local-run",
      text: "continue existing head",
    });
    await b.harness.waitForIdle(ctx);
    assert.equal(b.faux.state.callCount, 1);
  } finally {
    await b.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a commit between paged entries and head publication cannot mix an old tail with new agent state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-head-cutoff-"));
  const a = await openReplica(dir);
  let release = () => {};
  try {
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let paused = false;
    const commit = a.harness.commit.bind(a.harness);
    a.harness.commit = async (change, context) => {
      const result = await commit(change, context);
      if (
        !paused &&
        result !== null &&
        typeof result === "object" &&
        "items" in result &&
        Array.isArray(result.items) &&
        result.items.some((entry) => entry.kind === "fixture.cutoff.first")
      ) {
        paused = true;
        await gate;
      }
      return result;
    };
    await a.root.commit(async (tx) => {
      await tx.appendEntry(a.root.id, { kind: "fixture.cutoff.first", data: "first cutoff" });
    }, ctx);
    await waitFor(() => paused, "real first SDK scan page");
    const newest = await a.root.commit(async (tx) => {
      const entry = await tx.appendEntry(a.root.id, {
        kind: "fixture.cutoff.new",
        data: "new cutoff",
      });
      (await tx.doc(AgentDoc, a.root.id)).instructions = "new cutoff instructions";
      return entry.id;
    }, ctx);
    release();
    await a.command("status", {});
    const source = a.sync.store.sources()[0];
    assert.ok(source);
    const page = await pull(a);
    const heads = page.events.filter((event) => event.body.kind === "head");
    assert.ok(heads.length > 0);
    for (const event of heads)
      if (
        event.body.kind === "head" &&
        event.body.meta.agent.instructions === "new cutoff instructions"
      )
        assert.equal(event.body.entries.at(-1)?.id, newest);
  } finally {
    release();
    await a.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a native head pins original entries without copies and still runs its exact old context after source changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-native-head-"));
  const a = await openReplica(dir);
  try {
    await a.root.configure({ instructions: "old pinned instructions" }, ctx);
    a.faux.setResponses([text("old pinned output")]);
    await (
      await a.sync.root(
        { requestId: "old-native-run", text: "old native input", whenBusy: "followUp", trace },
        () =>
          a.root.submit(
            { type: "input", requestId: "old-native-run", content: "old native input" },
            ctx,
          ),
      )
    ).wait(ctx);
    await a.harness.waitForIdle(ctx);
    const expected = await a.root.context(ctx);
    const sourceSession = await a.harness.snapshot(ProviderDoc, a.root.id, ctx);
    await a.root.configure({ instructions: "v2 pinned after tail" }, ctx);
    const old = (await pull(a)).events.filter((event) => event.body.kind === "head").at(-1)?.body;
    assert.ok(old?.kind === "head");
    const receipt = await a.history.receipt(old.head);
    assert.ok(receipt);
    assert.notEqual(receipt.conversationId, a.root.id);
    assert.deepEqual(
      Object.entries(receipt.entries).map(([original, local]) => [Number(original), local]),
      old.entries.map((entry) => [entry.id, entry.id]),
      "local pin maps to committed native entry IDs, never appends copies",
    );
    const db = new DatabaseSync(join(dir, "session.sqlite"), { readOnly: true });
    const nativeCount = db.prepare("SELECT COUNT(*) AS count FROM entries").get()?.count;
    await a.command("status", {});
    await a.command("status", {});
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM entries").get()?.count, nativeCount);
    db.close();
    await a.root.configure({ instructions: "v3 instructions never-old-head", tools: [] }, ctx);
    await a.root.commit(async (tx) => {
      for (let i = 0; i < 140; i += 1)
        await tx.appendEntry(a.root.id, {
          kind: "pi.user",
          model: [{ role: "user", content: `new records never-old-head ${i}`, timestamp: i }],
        });
    }, ctx);
    a.faux.setResponses([text("new source compaction never-old-head")]);
    const task = await a.root.compact(undefined, ctx);
    await a.harness.waitForTask(task, ctx);
    await a.harness.waitForIdle(ctx);
    await a.command("status", {});
    const pinned = await a.harness.conversation(receipt.conversationId as ConversationId, ctx);
    assert.ok(pinned);
    assert.deepEqual(
      (await pinned.context(ctx)).messages,
      expected.messages,
      "later entries, edits/compaction and settings cannot mutate the bounded old head",
    );
    const requests: TranscriptContext[] = [];
    a.faux.setResponses([
      (request) => {
        requests.push(request);
        return text("continued old head");
      },
    ]);
    await a.command("run", {
      head: old.head,
      requestId: "old-head-new-run",
      text: "continue the old head",
    });
    await a.harness.waitForIdle(ctx);
    const request = requests[0];
    assert.ok(request);
    assert.deepEqual(getCurrentTools(request.messages), getCurrentTools(expected.messages));
    assert.match(
      getCurrentSystemMessage(request.messages)?.sections?.instructions ?? "",
      /v2 pinned after tail/,
    );
    assert.doesNotMatch(JSON.stringify(request.messages), /never-old-head/);
    const run = await a.history.branch("old-head-new-run");
    assert.ok(run);
    const runSession = await a.harness.snapshot(
      ProviderDoc,
      run.conversationId as ConversationId,
      ctx,
    );
    assert.ok(sourceSession?.sessionId && runSession?.sessionId);
    assert.notEqual(
      sourceSession.sessionId,
      runSession.sessionId,
      "run fork starts a fresh provider identity",
    );
    const replay = request.messages.filter((message) => message.role !== "system").slice(0, -1);
    assert.deepEqual(
      replay,
      expected.messages.filter((message) => message.role !== "system"),
    );
  } finally {
    await a.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("successive native and incoming heads never rewrite old entry or resource bodies into SDK receipts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-head-growth-"));
  const markers = {
    data: "p1-original-data-marker-".repeat(1000),
    tool: "p1-original-tool-result-marker-".repeat(1000),
    resource: Buffer.from("p1-resource-original-marker-".repeat(1000)).toString("base64"),
  };
  const track = () => {
    const docs = new Set<number>();
    const metrics = Object.fromEntries(
      Object.keys(markers).map((key) => [key, { entries: 0, entryBytes: 0, docs: 0, docBytes: 0 }]),
    );
    const storage = async (path: string) => {
      const inner = await (
        await import("@earendil-works/pi-durable/storage/sqlite/node")
      ).openNodeSqliteStorage(path);
      return new Proxy(inner, {
        get(target, key) {
          if (key === "commit") {
            const commit: typeof inner.commit = async (writes, context) => {
              const seq = await target.commit(writes, context);
              for (const write of writes) {
                if (
                  (write.type === "document.create" || write.type === "document.copy") &&
                  write.record.kind === "bots.replica.import"
                )
                  docs.add(write.record.id);
                const isDoc =
                  write.type === "document.create" || write.type === "document.copy"
                    ? docs.has(write.record.id)
                    : write.type === "document.change" && docs.has(write.id);
                if (write.type !== "entry" && !isDoc) continue;
                const encoded = JSON.stringify(write);
                for (const [label, marker] of Object.entries(markers)) {
                  const metric = metrics[label];
                  assert.ok(metric);
                  const count = encoded.split(marker).length - 1;
                  if (write.type === "entry") {
                    metric.entries += count;
                    if (count > 0) metric.entryBytes += Buffer.byteLength(encoded);
                  } else {
                    metric.docs += count;
                    if (count > 0) metric.docBytes += Buffer.byteLength(encoded);
                  }
                }
              }
              return seq;
            };
            return commit;
          }
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    return { storage, metrics };
  };
  const source = track();
  const target = track();
  const a = await openReplica(join(dir, "a"), "b_replica", [], source.storage);
  const b = await openReplica(join(dir, "b"), "b_replica", [], target.storage);
  try {
    await b.command("bind", { sharedBotId: a.sync.store.binding.sharedBotId });
    await a.root.commit(async (tx) => {
      await tx.appendEntry(a.root.id, { kind: "fixture.raw-data", data: markers.data });
    }, ctx);
    await writeFile(join(a.workspace, "original.txt"), markers.tool);
    a.faux.setResponses([
      assistant([toolCall("read", { path: "original.txt" })], { stopReason: "toolUse" }),
      text("source read complete"),
    ]);
    await (
      await a.sync.root(
        { requestId: "growth-source", text: "read original once", whenBusy: "followUp", trace },
        () =>
          a.root.submit(
            { type: "input", requestId: "growth-source", content: "read original once" },
            ctx,
          ),
      )
    ).wait(ctx);
    await a.harness.waitForIdle(ctx);
    const bytes = Buffer.from(markers.resource, "base64");
    await a.command("export", {
      resources: [
        {
          name: "original.bin",
          kind: "attachment",
          base64: markers.resource,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ],
    });
    let pages = await transfer(a, b);
    const baselineA = structuredClone(source.metrics);
    const baselineB = structuredClone(target.metrics);
    for (const label of ["data", "tool"])
      assert.equal(
        baselineB[label]?.entries,
        baselineA[label]?.entries,
        "passive heads append each original entry only once",
      );
    assert.ok((baselineA.data?.entries ?? 0) > 0 && (baselineA.tool?.entries ?? 0) > 0);
    for (const label of Object.keys(markers))
      assert.equal(baselineB[label]?.docs, 0, "automatic incoming receipt has no raw body");
    for (let i = 0; i < 3; i += 1) {
      await a.root.commit(async (tx) => {
        await tx.appendEntry(a.root.id, { kind: "fixture.increment", data: { i } });
      }, ctx);
      pages = await transfer(a, b, undefined, pages.at(-1)?.nextAfter);
      assert.deepEqual(
        source.metrics,
        baselineA,
        "native incremental head does not rewrite old bodies or resource bytes",
      );
      assert.deepEqual(
        target.metrics,
        baselineB,
        "complete passive prefix is reused; only new entries append",
      );
    }
    console.log(
      JSON.stringify({
        measure: "p1-sdk-old-body-writes",
        source: source.metrics,
        target: target.metrics,
      }),
    );
  } finally {
    await Promise.all([a.close(), b.close()]);
    await rm(dir, { recursive: true, force: true });
  }
});
