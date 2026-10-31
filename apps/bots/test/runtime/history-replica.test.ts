import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  createModels,
  fauxProvider,
  getCurrentSystemMessage,
  getCurrentTools,
  getSystemMessageText,
  renderSystemMessageUpdate,
  type TranscriptContext,
  Type,
} from "@earendil-works/pi-ai";
import {
  type Conversation,
  type ConversationId,
  type Cursor,
  defineExtension,
  defineTool,
  type EntryRecord,
  Harness,
  ProviderDoc,
  type Storage,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type HistoryBundle, HistoryReplica } from "../../src/runtime/pi/HistoryReplica.ts";
import { EventMapper } from "../../src/runtime/pi/mapEvents.ts";
import { createHerdrClient } from "../../src/tools/herdr/client.ts";
import {
  createToolRegistry,
  selectToolExtensions,
  type ToolRegistryOptions,
} from "../../src/tools/registry.ts";
import { openWorkspace } from "../../src/tools/workspace.ts";
import { assistant, text, toolCall, trace } from "../support/pi.ts";
import { frameQueue, hello, send, startStack } from "../support/server.ts";

const open = async (
  dir: string,
  storage?: (path: string) => Promise<Storage>,
  tools: ToolRegistryOptions = {},
) => {
  const workspace = await openWorkspace(join(dir, "workspace"));
  const registry = createToolRegistry(workspace, tools);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const database = await (storage ?? openNodeSqliteStorage)(join(dir, "session.sqlite"));
  const harness = await Harness.open(
    database,
    {
      models,
      registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? workspace.root }),
      settings: { compaction: { enabled: true, keepRecentTokens: 100, backgroundTokens: 0 } },
    },
    ctx,
  );
  const root = await harness.root(ctx, {
    agent: {
      model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
      cwd: workspace.root,
      extensions: selectToolExtensions(registry, ["core", "coding"]),
    },
  });
  const replica = new HistoryReplica(
    harness,
    root.id,
    "b_shared",
    workspace.root,
    registry,
    database,
    dir,
  );
  await replica.prepareResources();
  return {
    harness,
    storage: database,
    registry,
    root,
    faux,
    workspace: workspace.root,
    replica,
    command: (method: "export" | "import" | "run" | "status" | "merge", params: unknown) =>
      replica.command({ method, params, trace }),
  };
};
const all = async (conversation: Conversation) => {
  const entries: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({ order: "ascending" }, 29, cursor, ctx);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return entries;
};
const resource = (name: string, kind: "attachment" | "instructions" | "skill", value: string) => ({
  name,
  kind,
  sha256: createHash("sha256").update(value).digest("hex"),
  base64: Buffer.from(value).toString("base64"),
});

test("SDK section order and rendered prompts survive export, pinned receipt and B/C passive import", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bots-section-history-"));
  const openWithHerdr = (name: string) =>
    open(join(dir, name), undefined, {
      herdr: {
        client: createHerdrClient({ binary: join(dir, "must-not-execute-herdr") }),
        stateDir: join(dir, name, "herdr"),
        botId: "b_shared",
      },
    });
  const a = await openWithHerdr("a");
  const b = await openWithHerdr("b");
  const c = await openWithHerdr("c");
  try {
    await a.root.configure(
      { extensions: selectToolExtensions(a.registry, ["core", "herdr"]) },
      ctx,
    );
    a.faux.setResponses([text("source complete")]);
    await (
      await a.root.submit(
        { type: "input", content: "keep prompt order", requestId: "sections" },
        ctx,
      )
    ).wait(ctx);
    await a.harness.waitForIdle(ctx);
    const source = (await a.root.context(ctx)).messages;
    const system = getCurrentSystemMessage(source);
    assert.ok(system);
    const order = Object.keys(system.sections ?? {});
    assert.ok(order.includes("bots-tools") && order.includes("bots-herdr"));
    assert.ok(order.indexOf("bots-tools") < order.indexOf("bots-herdr"));
    const views = (messages: Readonly<TranscriptContext["messages"]>) =>
      messages.flatMap((message) =>
        message.role !== "system"
          ? []
          : [
              {
                sections: Object.entries(message.sections ?? {}),
                prompt: getSystemMessageText(message),
                update: renderSystemMessageUpdate(message),
              },
            ],
      );
    const bundle = (await a.command("export", {})) as HistoryBundle;
    const receipt = (await a.command("export", { head: bundle.head })) as HistoryBundle;
    const cases: { name: string; messages: Readonly<TranscriptContext["messages"]> }[] = [
      { name: "initial export", messages: bundle.entries.flatMap((entry) => entry.model ?? []) },
      { name: "pinned receipt", messages: receipt.entries.flatMap((entry) => entry.model ?? []) },
    ];
    let transfer = receipt;
    for (const [name, target] of [
      ["B", b],
      ["C", c],
    ] as const) {
      await target.command("import", { bundle: transfer });
      const conversations = await target.harness.commit((tx) => tx.scanConversations({}, 20), ctx);
      const importedId = conversations.items.find((item) => item.id !== target.root.id)?.id;
      assert.ok(importedId);
      const imported = await target.harness.conversation(importedId, ctx);
      assert.ok(imported);
      cases.push({
        name: `${name} imported context`,
        messages: (await imported.context(ctx)).messages,
      });
      transfer = (await target.command("export", { head: bundle.head })) as HistoryBundle;
      cases.push({
        name: `${name} receipt`,
        messages: transfer.entries.flatMap((entry) => entry.model ?? []),
      });
      assert.equal(target.faux.state.callCount, 0);
      assert.deepEqual((await target.harness.inspect(ctx)).tasks, []);
    }
    for (const item of cases) {
      await t.test(item.name, () => assert.deepEqual(views(item.messages), views(source)));
    }
  } finally {
    await Promise.all([a.harness.close(ctx), b.harness.close(ctx), c.harness.close(ctx)]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("full raw history, compaction references and resource versions survive passive import, restart and local branches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-replica-"));
  let a = await open(join(dir, "a"));
  let b = await open(join(dir, "b"));
  try {
    await a.root.reset("explicit handoff", ctx);
    await a.root.configure({ instructions: "first instruction 原始" }, ctx);
    a.faux.setResponses([
      assistant([toolCall("write", { path: "original.txt", content: "工具原字节\n原始 UTF-8" })], {
        stopReason: "toolUse",
      }),
      text("tool complete"),
    ]);
    const submission = await a.root.submit(
      { type: "input", content: "write exact bytes", requestId: "source-tool" },
      ctx,
    );
    await submission.wait(ctx);
    await a.root.waitForIdle(ctx);
    assert.equal(
      await readFile(join(a.workspace, "original.txt"), "utf8"),
      "工具原字节\n原始 UTF-8",
    );
    await a.root.configure({ instructions: "second instruction 保留变化", tools: [] }, ctx);
    a.faux.setResponses([text("new instructions"), text("compact original history")]);
    await (
      await a.root.submit({ type: "input", content: "second turn", requestId: "second" }, ctx)
    ).wait(ctx);
    await a.root.commit(async (tx) => {
      for (let index = 0; index < 220; index += 1) {
        await tx.appendEntry(a.root.id, {
          kind: "pi.user",
          model: [{ role: "user", content: `original ${index}`, timestamp: index }],
          data: { index, opaque: ["原文", { unchanged: true }] },
        });
      }
    }, ctx);
    const prior = (await all(a.root)).at(-1);
    assert.ok(prior);
    await a.root.commit(async (tx) => {
      await tx.appendEntry(a.root.id, {
        kind: "fixture.edit",
        edits: [
          {
            target: prior.id,
            action: "replace",
            messages: [{ role: "user", content: "edited contribution", timestamp: 0 }],
          },
        ],
        data: { original: "kept" },
      });
      await tx.appendEntry(a.root.id, {
        kind: "fixture.attachment",
        model: [
          {
            role: "user",
            content: [
              {
                type: "image",
                mimeType: "image/png",
                data: Buffer.from("original image bytes").toString("base64"),
              },
            ],
            timestamp: 1,
          },
        ],
      });
    }, ctx);
    const compact = await a.root.compact(undefined, ctx);
    await a.harness.waitForTask(compact, ctx);
    await a.root.waitForIdle(ctx);
    const original = await all(a.root);
    assert.ok(original.length > 220);
    assert.ok(
      original.some((entry) => entry.kind === "pi.tool-result"),
      "a tool refusal cannot masquerade as fidelity evidence",
    );
    assert.ok(original.some((entry) => entry.kind === "pi.compaction" && entry.head !== undefined));
    assert.ok(original.some((entry) => entry.kind === "pi.reset" && entry.head === entry.id));
    assert.ok(original.some((entry) => entry.byTaskId !== undefined));
    assert.ok(
      original.some((entry) =>
        entry.model?.some(
          (message) => message.role === "system" && (message.toolsRemoved?.length ?? 0) > 0,
        ),
      ),
    );
    const expected = await a.root.context(ctx);
    const resources = [
      resource("AGENTS.md", "instructions", "first version"),
      resource("AGENTS.md", "instructions", "second version"),
      resource("skills/example/SKILL.md", "skill", "complete skill"),
      resource("skills/example/scripts/run.py", "skill", "print('source')"),
      resource("image.png", "attachment", "original image bytes"),
    ];
    const bundle = (await a.command("export", { resources })) as HistoryBundle;
    assert.deepEqual(
      bundle.entries,
      original,
      "export is independently checked against all SDK pages",
    );
    const received = await b.command("import", { bundle });
    assert.deepEqual(
      await b.command("import", { bundle: JSON.parse(JSON.stringify(bundle)) }),
      received,
    );
    assert.equal(b.faux.state.callCount, 0);
    assert.deepEqual((await b.harness.inspect(ctx)).tasks, []);
    await assert.rejects(readFile(join(b.workspace, "original.txt")), { code: "ENOENT" });
    const conversations = await b.harness.commit((tx) => tx.scanConversations({}, 20), ctx);
    const importedId = conversations.items.find(
      (conversation) => conversation.id !== b.root.id,
    )?.id;
    assert.ok(importedId);
    const imported = await b.harness.conversation(importedId, ctx);
    assert.ok(imported);
    const localEntries = await all(imported);
    const mapping = new Map(original.map((entry, index) => [entry.id, localEntries[index]?.id]));
    assert.deepEqual(
      localEntries,
      original.map((entry) => {
        const { byTaskId: _sourceTask, ...record } = entry;
        return {
          ...record,
          id: mapping.get(entry.id),
          conversationId: importedId,
          ...(entry.head === undefined ? {} : { head: mapping.get(entry.head) }),
          ...(entry.edits === undefined
            ? {}
            : {
                edits: entry.edits.map((edit) => ({ ...edit, target: mapping.get(edit.target) })),
              }),
        };
      }),
      "raw model/data/edits remain exact; source task IDs never become local task ownership",
    );
    assert.deepEqual(
      (await imported.context(ctx)).messages,
      expected.messages,
      "SDK context reconstruction is checked separately from re-export",
    );
    assert.deepEqual(await b.command("export", { head: bundle.head }), bundle);
    await assert.rejects(
      b.command("run", { head: bundle.head, requestId: "unloaded-resource", text: "must not run" }),
      /conflicting resource path/,
    );
    const runnable = (await a.command("export", {
      resources: resources.filter((item) => item.kind === "attachment"),
    })) as HistoryBundle;
    await b.command("import", { bundle: runnable });
    const referenceRequests: TranscriptContext[] = [];
    a.faux.setResponses([
      (context) => {
        referenceRequests.push(context);
        return text("source reference continuation");
      },
    ]);
    await a.command("run", {
      head: runnable.head,
      requestId: "source-reference",
      text: "source reference input",
    });
    await a.harness.waitForIdle(ctx);
    const reference = referenceRequests[0];
    assert.ok(reference);
    const sourceSession = await a.harness.snapshot(ProviderDoc, a.root.id, ctx);
    const importedSession = await b.harness.snapshot(ProviderDoc, importedId, ctx);
    assert.notEqual(sourceSession?.sessionId, importedSession?.sessionId);

    await a.harness.close(ctx);
    await b.harness.close(ctx);
    b = await open(join(dir, "b"));
    assert.deepEqual(await b.command("import", { bundle }), received);
    assert.equal(b.faux.state.callCount, 0, "reopen plus duplicate import stays passive");
    const requests: TranscriptContext[] = [];
    const respond = (request: TranscriptContext) => {
      requests.push(request);
      const input = request.messages.findLast((message) => message.role === "user");
      assert.ok(input?.role === "user" && typeof input.content === "string");
      assert.ok(["continue first", "continue sibling"].includes(input.content));
      return text(input.content === "continue first" ? "B first branch" : "B concurrent sibling");
    };
    b.faux.setResponses([respond, respond]);
    await Promise.all([
      b.command("run", { head: runnable.head, requestId: "branch-1", text: "continue first" }),
      b.command("run", { head: runnable.head, requestId: "branch-2", text: "continue sibling" }),
    ]);
    await b.harness.waitForIdle(ctx);
    assert.equal(requests.length, 2);
    const expectedText = JSON.stringify(expected.messages).replaceAll(a.workspace, b.workspace);
    for (const request of requests) {
      const originalMessages = JSON.parse(expectedText) as TranscriptContext["messages"];
      let originalIndex = 0;
      for (const message of request.messages.slice(0, -1)) {
        if (JSON.stringify(message) === JSON.stringify(originalMessages[originalIndex]))
          originalIndex += 1;
        else
          assert.equal(
            message.role,
            "system",
            "only a new local system baseline can be inserted around the exact original context",
          );
      }
      assert.equal(
        originalIndex,
        originalMessages.length,
        "every original message category stays in order",
      );
      const sourceSystem = getCurrentSystemMessage(reference.messages);
      const targetSystem = getCurrentSystemMessage(request.messages);
      assert.ok(runnable.resources.every((file) => file.kind === "attachment"));
      const version = createHash("sha256").update(JSON.stringify(runnable.resources)).digest("hex");
      const resourceSection = (directory: string) =>
        `<bots-resources>\n${[
          `Resource version: ${version}`,
          `Resource directory: ${directory}`,
          ...runnable.resources.map((file) => `Attachment: ${join(directory, file.name)}`),
        ].join("\n\n")}\n</bots-resources>`;
      assert.equal(
        sourceSystem?.sections?.["bots-resources"],
        resourceSection(join(dir, "a/resources", version)),
      );
      const expectedSections = Object.fromEntries(
        Object.entries(sourceSystem?.sections ?? {}).map(([key, value]) => [
          key,
          key === "bots-resources"
            ? resourceSection(join(dir, "b/resources", version))
            : value === null
              ? null
              : value.replaceAll(a.workspace, b.workspace),
        ]),
      );
      assert.equal(
        JSON.stringify({ content: targetSystem?.content, sections: targetSystem?.sections }),
        JSON.stringify({ content: sourceSystem?.content, sections: expectedSections }),
        "all ordered sections match, with only explicit cwd and manifest metadata paths bound locally",
      );
      assert.match(targetSystem?.sections?.instructions ?? "", /second instruction 保留变化/);
      assert.deepEqual(
        getCurrentTools(request.messages),
        getCurrentTools(reference.messages),
        "full ordered effective tool declarations survive replay",
      );
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
        "all ordered toolsAdded/toolsRemoved declarations match the same-head source continuation",
      );
    }

    const branch1 = (await b.command("export", { branch: "branch-1" })) as HistoryBundle;
    const branch2 = (await b.command("export", { branch: "branch-2" })) as HistoryBundle;
    assert.notEqual(branch1.head, branch2.head);
    assert.deepEqual(branch1.parents, [runnable.head]);
    assert.deepEqual(branch2.parents, [runnable.head]);
    for (const branch of [branch1, branch2]) {
      for (const [index, original] of runnable.entries.entries()) {
        const inherited = branch.entries[index];
        assert.ok(inherited);
        assert.deepEqual(
          branch.origins[String(inherited.id)],
          runnable.origins[String(original.id)],
          "fork ancestors retain original source entry/task provenance through the reverse map",
        );
      }
    }
    assert.ok(JSON.stringify(branch1).includes("B first branch"));
    assert.ok(JSON.stringify(branch2).includes("B concurrent sibling"));
    const c = await open(join(dir, "c"));
    try {
      for (const branch of [branch2, branch1]) {
        await c.command("import", { bundle: branch });
        const receipt = (await c.command("export", { head: branch.head })) as HistoryBundle;
        assert.deepEqual(receipt.origins, branch.origins);
        const view = await c.harness.commit((tx) => tx.scanConversations({}, 20), ctx);
        const matching: Conversation[] = [];
        for (const record of view.items) {
          const conversation = await c.harness.conversation(record.id, ctx);
          if (
            conversation !== undefined &&
            (await all(conversation)).length === branch.entries.length
          )
            matching.push(conversation);
        }
        const source = await b.harness.conversation(
          branch.source.conversationId as ConversationId,
          ctx,
        );
        assert.ok(source);
        assert.ok(matching.length > 0);
        const expectedBranch = (await source.context(ctx)).messages;
        assert.ok(
          (await Promise.all(matching.map((conversation) => conversation.context(ctx)))).some(
            (context) => JSON.stringify(context.messages) === JSON.stringify(expectedBranch),
          ),
          "a clean third SQLite reconstructs fork ancestors, head and edits from branch export",
        );
      }
      assert.equal(c.faux.state.callCount, 0);
    } finally {
      await c.harness.close(ctx);
    }
    a = await open(join(dir, "a"));
    a.faux.setResponses([text("A independently continued")]);
    b.faux.setResponses([text("B independently continued")]);
    await Promise.all([
      a.command("run", {
        head: runnable.head,
        requestId: "A-concurrent",
        text: "A from same head",
      }),
      b.command("run", {
        head: runnable.head,
        requestId: "B-concurrent",
        text: "B from same head",
      }),
    ]);
    await Promise.all([a.harness.waitForIdle(ctx), b.harness.waitForIdle(ctx)]);
    const aBranch = (await a.command("export", { branch: "A-concurrent" })) as HistoryBundle;
    const bBranch = (await b.command("export", { branch: "B-concurrent" })) as HistoryBundle;
    assert.notEqual(aBranch.source.replicaId, bBranch.source.replicaId);
    assert.deepEqual(aBranch.parents, [runnable.head]);
    assert.deepEqual(bBranch.parents, [runnable.head]);
    const beforeExchange = [a.faux.state.callCount, b.faux.state.callCount];
    await Promise.all([
      a.command("import", { bundle: bBranch }),
      b.command("import", { bundle: aBranch }),
    ]);
    assert.deepEqual([a.faux.state.callCount, b.faux.state.callCount], beforeExchange);
    assert.deepEqual(await a.command("export", { head: bBranch.head }), bBranch);
    assert.deepEqual(await b.command("export", { head: aBranch.head }), aBranch);
    const count = b.faux.state.callCount;
    await b.command("run", { head: runnable.head, requestId: "branch-1", text: "continue first" });
    assert.equal(b.faux.state.callCount, count, "duplicate acceptance does not regenerate");
    await assert.rejects(
      b.command("run", { head: runnable.head, requestId: "branch-1", text: "changed binding" }),
      /conflict/,
    );
    await b.harness.close(ctx);
    b = await open(join(dir, "b"));
    assert.equal(
      ((await b.command("status", { requestId: "branch-1" })) as { submission: { status: string } })
        .submission.status,
      "done",
    );
    assert.deepEqual(
      await b.command("export", { branch: "branch-1" }),
      branch1,
      "output committed before export remains reconstructible after restart",
    );
    assert.deepEqual(await b.command("export", { branch: "branch-2" }), branch2);
  } finally {
    await Promise.all([a.harness.close(ctx), b.harness.close(ctx)]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("two immutable SDK heads merge effective origins once, retain raw parents and remain editable after reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-merge-history-"));
  let local = await open(dir);
  try {
    local.faux.setResponses([
      assistant([toolCall("write", { path: "before-merge.txt", content: "original tool bytes" })], {
        stopReason: "toolUse",
      }),
      text("tool completed before branching"),
      text("real compacted context"),
    ]);
    await (
      await local.root.submit(
        { type: "input", content: "use tool", requestId: "merge_source" },
        ctx,
      )
    ).wait(ctx);
    const compact = await local.root.compact(undefined, ctx);
    await local.harness.waitForTask(compact, ctx);
    await local.harness.waitForIdle(ctx);
    const target = await local.harness.commit(
      (tx) =>
        tx.appendEntry(local.root.id, {
          kind: "fixture.shared",
          model: [{ role: "user", content: "shared editable origin", timestamp: 17 }],
        }),
      ctx,
    );
    const seed = (await local.command("export", {})) as HistoryBundle;
    assert.ok(seed.entries.some((entry) => entry.kind === "pi.tool-result"));
    assert.ok(
      seed.entries.some((entry) => entry.kind === "pi.compaction" && entry.head !== undefined),
    );
    const origin = seed.origins[String(target.id)];
    assert.ok(origin);
    const branches: HistoryBundle[] = [];
    for (const side of ["left", "right"]) {
      const requestId = `merge_branch_${side}`;
      local.faux.setResponses([
        assistant(
          [
            toolCall(
              "write",
              { path: `${side}.txt`, content: `${side} tool result` },
              { id: "same-branch-call" },
            ),
          ],
          { stopReason: "toolUse" },
        ),
        text(`independent ${side} answer`),
      ]);
      await local.command("run", { head: seed.head, requestId, text: `continue ${side}` });
      await local.harness.waitForIdle(ctx);
      const branch = (await local.command("export", { branch: requestId })) as HistoryBundle;
      const inherited: HistoryBundle["entries"][number] | undefined = branch.entries.find(
        (entry) => JSON.stringify(branch.origins[String(entry.id)]) === JSON.stringify(origin),
      );
      assert.ok(inherited);
      await local.harness.commit(
        (tx) =>
          tx.appendEntry(branch.source.conversationId as ConversationId, {
            kind: "fixture.branch.edit",
            edits:
              side === "left"
                ? [
                    {
                      target: inherited.id as never,
                      action: "replace",
                      messages: [
                        { role: "user", content: "left explicit replacement", timestamp: 17 },
                        { role: "user", content: "left second replacement", timestamp: 18 },
                      ],
                    },
                  ]
                : [{ target: inherited.id as never, action: "omit" }],
          }),
        ctx,
      );
      branches.push(
        (await local.command("export", {
          branch: requestId,
          resources: [resource("AGENTS.md", "instructions", `${side} instructions`)],
        })) as HistoryBundle,
      );
    }
    const [left, right] = branches;
    assert.ok(left && right);
    const originalParents = JSON.stringify(branches);
    const providerBefore = local.faux.state.callCount;
    const tasksBefore = (await local.harness.inspect(ctx)).tasks;
    const input = {
      requestId: "merge_context_001",
      heads: [left.head, right.head],
      choices: [{ origin, head: left.head }],
      resources: [{ name: "AGENTS.md", sha256: left.resources[0]?.sha256 }],
    };
    const preview = (await local.command("merge", { preview: true, heads: input.heads })) as {
      conflicts: {
        origin: unknown;
        options: { head: string; action: string; messageCount: number; digest: string }[];
      }[];
      resources: { name: string; versions: { sha256: string; kind: string; heads: string[] }[] }[];
    };
    assert.deepEqual(
      preview.conflicts
        .find((item) => JSON.stringify(item.origin) === JSON.stringify(origin))
        ?.options.map(({ head, action, messageCount }) => ({ head, action, messageCount })),
      [
        { head: left.head, action: "replace", messageCount: 2 },
        { head: right.head, action: "omit", messageCount: 0 },
      ],
    );
    assert.deepEqual(preview.resources, [
      {
        name: "AGENTS.md",
        versions: branches.map((bundle) => ({
          sha256: bundle.resources[0]?.sha256,
          kind: "instructions",
          heads: [bundle.head],
        })),
      },
    ]);
    assert.doesNotMatch(JSON.stringify(preview), /left explicit replacement|left instructions/);
    assert.equal(local.faux.state.callCount, providerBefore);
    assert.deepEqual((await local.harness.inspect(ctx)).tasks, tasksBefore);
    const result = (await local.command("merge", input)) as { head: string };
    assert.ok(result?.head, "merge returns a durable immutable head rather than invoking a run");
    assert.deepEqual(await local.command("merge", input), result);
    const merged = (await local.command("export", { head: result.head })) as HistoryBundle;
    assert.deepEqual(merged.parents, [left.head, right.head]);
    assert.deepEqual(merged.resources, left.resources);
    assert.equal(local.faux.state.callCount, providerBefore, "merge is passive");
    assert.deepEqual((await local.harness.inspect(ctx)).tasks, tasksBefore);
    assert.equal(
      await readFile(join(local.workspace, "before-merge.txt"), "utf8"),
      "original tool bytes",
    );
    assert.equal(JSON.stringify(branches), originalParents);
    assert.deepEqual(await local.command("export", { head: left.head }), left);
    assert.deepEqual(await local.command("export", { head: right.head }), right);
    const contribution = merged.entries.filter(
      (entry) =>
        entry.kind === "bots.merge.contribution" &&
        JSON.stringify((entry.data as { origin?: unknown })?.origin) === JSON.stringify(origin),
    );
    assert.equal(
      contribution.length,
      2,
      "each effective message has an entry while the common origin is selected once",
    );
    const mapper = new EventMapper({ botId: "b_shared" });
    const storedMerged = await local.replica.checkedEntries(
      merged,
      await local.replica.receipt(merged.head),
    );
    const storedConversation = await local.harness.conversation(
      storedMerged.conversationId as ConversationId,
      ctx,
    );
    assert.ok(storedConversation);
    const visible = (await all(storedConversation)).flatMap(
      (entry) => mapper.entryMessage(entry) ?? [],
    );
    assert.match(JSON.stringify(visible), /left explicit replacement/);
    assert.match(JSON.stringify(visible), /left second replacement/);
    assert.match(JSON.stringify(visible), /independent left answer/);
    assert.match(JSON.stringify(visible), /independent right answer/);
    const selected = contribution[0];
    assert.ok(selected);
    assert.deepEqual(selected.model, [
      { role: "user", content: "left explicit replacement", timestamp: 17 },
    ]);
    assert.equal((selected.data as { effect: { action: string } }).effect.action, "replace");
    const omitted = (await local.command("merge", {
      ...input,
      requestId: "merge_omit_001",
      choices: [{ origin, head: right.head }],
    })) as { head: string };
    const omittedBundle = (await local.command("export", { head: omitted.head })) as HistoryBundle;
    const omittedEntry = omittedBundle.entries.find(
      (entry) =>
        JSON.stringify((entry.data as { origin?: unknown })?.origin) === JSON.stringify(origin),
    );
    assert.ok(omittedEntry);
    assert.deepEqual(omittedEntry.model, []);
    assert.equal(
      (omittedEntry.data as { effect: { action: string } }).effect.action,
      "omit",
      "explicit omission keeps an addressable origin/effect record",
    );
    await assert.rejects(
      local.command("merge", { ...input, requestId: "merge_no_choice", choices: [] }),
      /conflict/,
    );
    await assert.rejects(
      local.command("merge", { ...input, requestId: "merge_no_resource", resources: [] }),
      /conflict/,
    );
    await assert.rejects(
      local.command("merge", { ...input, choices: [{ origin, head: right.head }] }),
      /conflict/,
    );
    await local.harness.close(ctx);
    local = await open(dir);
    assert.deepEqual(await local.command("merge", input), result);
    const receipt = await local.replica.receipt(merged.head);
    assert.ok(receipt);
    const conversation = await local.harness.conversation(
      receipt.conversationId as ConversationId,
      ctx,
    );
    assert.ok(conversation);
    const before = await conversation.context(ctx);
    assert.equal(before.messages[0]?.role, "system");
    assert.equal(JSON.stringify(before.messages).match(/left explicit replacement/g)?.length, 1);
    assert.match(JSON.stringify(before.messages), /independent left answer/);
    assert.match(JSON.stringify(before.messages), /independent right answer/);
    const preservedSystemOrder = before.messages
      .filter((message) => message.role === "system")
      .map((message) => Object.keys(message.sections ?? {}));
    assert.ok(preservedSystemOrder.length > 0);
    const calls = before.messages.flatMap((message) =>
      message.role !== "assistant"
        ? []
        : message.content.filter((part) => part.type === "toolCall"),
    );
    const results = before.messages.filter((message) => message.role === "toolResult");
    assert.equal(calls.length, 3, "the shared original call and both branch calls are retained");
    assert.equal(
      new Set(calls.map((call) => call.id)).size,
      3,
      "colliding original tool IDs are explicitly mapped",
    );
    assert.equal(results.length, 3, "neither branch result is dropped");
    assert.ok(
      results.every(
        (result) => JSON.stringify(result.details ?? null).includes('"missing_result"') === false,
      ),
    );
    assert.deepEqual(
      results.map((result) => result.toolCallId),
      calls.map((call) => call.id),
    );
    const rebuild = async (
      seed: HistoryBundle,
      label: string,
      messages: NonNullable<HistoryBundle["entries"][number]["model"]>,
    ) => {
      await local.replica.createContext(
        seed,
        { contextId: label, head: seed.head },
        () => undefined,
      );
      const info = await local.replica.contextInfo(label);
      const fork = await local.harness.conversation(info.conversationId as ConversationId, ctx);
      assert.ok(fork);
      const inherited = seed.entries.filter(
        (entry) =>
          JSON.stringify((entry.data as { origin?: unknown })?.origin) === JSON.stringify(origin),
      );
      assert.ok(inherited.length > 0);
      await fork.commit(
        (tx) =>
          tx.appendEntry(fork.id, {
            kind: "fixture.edit.old-origin",
            // These are SDK edits in a passive fork. The public immutable result below is
            // rebuilt per effective message, so no multi-message target reaches the mapper.
            edits: inherited.map((entry, index) =>
              index === 0
                ? { target: entry.id as never, action: "replace" as const, messages }
                : { target: entry.id as never, action: "omit" as const },
            ),
          }),
        ctx,
      );
      const edited = await fork.context(ctx);
      const raw = (await local.command("export", { contextId: label })) as HistoryBundle;
      const result = (await local.command("merge", {
        requestId: `${label}_rebuild`,
        heads: [raw.head, seed.head],
        choices: [{ origin, head: raw.head }],
      })) as { head: string };
      const rebuilt = (await local.command("export", { head: result.head })) as HistoryBundle;
      assert.deepEqual(rebuilt.parents, [raw.head, seed.head]);
      const group = rebuilt.entries.filter(
        (entry) =>
          JSON.stringify((entry.data as { origin?: unknown })?.origin) === JSON.stringify(origin),
      );
      assert.equal(group.length, messages.length);
      assert.deepEqual(
        group.map((entry) => entry.model?.[0]),
        messages,
      );
      assert.ok(rebuilt.entries.every((entry) => (entry.model?.length ?? 0) <= 1));
      const actual = await local.harness.conversation(
        (await local.replica.receipt(rebuilt.head))?.conversationId as ConversationId,
        ctx,
      );
      assert.ok(actual);
      assert.deepEqual(
        (await actual.context(ctx)).messages,
        edited.messages,
        "rebuilding changes representation, not SDK context or message positions",
      );
      return rebuilt;
    };
    const expandedMessages = [
      { role: "user" as const, content: "expanded first old origin", timestamp: 17 },
      text("expanded middle old origin"),
      { role: "user" as const, content: "expanded last old origin", timestamp: 19 },
    ];
    const expanded = await rebuild(merged, "edit_origin_expand", expandedMessages);
    await local.harness.close(ctx);
    local = await open(dir);
    const shrunk = await rebuild(expanded, "edit_origin_shrink", [
      { role: "user", content: "edited old origin after reopen", timestamp: 17 },
    ]);
    for (const [head, expected, absent] of [
      [
        expanded,
        ["expanded first old origin", "expanded middle old origin", "expanded last old origin"],
        "left second replacement",
      ],
      [shrunk, ["edited old origin after reopen"], "expanded middle old origin"],
    ] as const) {
      const stack = await startStack({ real: true });
      const socket = stack.connect();
      try {
        const bot = await stack.createBot("rebuilt native context");
        const handle = await stack.registry.open(bot, trace);
        await handle.replica?.({ method: "import", params: { bundle: head }, trace });
        await handle.replica?.({
          method: "context",
          params: { contextId: "derived_wire_context", head: head.head },
          trace,
        });
        const frames = frameQueue(socket);
        await send(socket, hello);
        await frames.next();
        await send(socket, {
          type: "subscribe",
          botId: bot,
          contextId: "derived_wire_context",
          trace,
        });
        const snapshot = await frames.next();
        const encoded = JSON.stringify(snapshot);
        let position = -1;
        for (const value of expected) {
          const next = encoded.indexOf(value);
          assert.ok(next > position);
          position = next;
        }
        assert.equal(encoded.includes(absent), false);
        assert.ok(position < encoded.indexOf("independent left answer"));
        assert.ok(
          encoded.indexOf("independent left answer") < encoded.indexOf("independent right answer"),
        );
        assert.equal(stack.faux?.state.callCount, 0, "passive import/subscribe executes nothing");
        const inputs: TranscriptContext[] = [];
        stack.faux?.setResponses([
          (request) => {
            inputs.push(request);
            return text("continued rebuilt head");
          },
        ]);
        await send(socket, {
          type: "send",
          requestId: "derived_wire_run",
          contextId: "derived_wire_context",
          text: "continue rebuilt",
          whenBusy: "followUp",
          trace,
        });
        for (;;) {
          const frame = await frames.next();
          if (
            frame.type === "submission" &&
            frame.requestId === "derived_wire_run" &&
            frame.status === "done"
          )
            break;
        }
        assert.equal(inputs.length, 1);
        const provider = JSON.stringify(inputs[0]?.messages);
        let providerPosition = -1;
        for (const value of expected) {
          const next = provider.indexOf(value);
          assert.ok(next > providerPosition);
          providerPosition = next;
        }
        assert.equal(provider.includes(absent), false);
        assert.ok(providerPosition < provider.indexOf("independent left answer"));
        const adapter = await handle.context?.("derived_wire_context", trace);
        const page = await adapter?.history({ limit: 50 });
        for (const value of expected) assert.ok(JSON.stringify(page).includes(value));
      } finally {
        socket.terminate();
        await stack.close();
      }
    }
    const currentReceipt = await local.replica.receipt(shrunk.head);
    const current = await local.harness.conversation(
      currentReceipt?.conversationId as ConversationId,
      ctx,
    );
    assert.ok(current);
    const seen: TranscriptContext[] = [];
    local.faux.setResponses([
      (request) => {
        seen.push(request);
        return text("first actual merged continuation");
      },
    ]);
    await (
      await current.submit(
        { type: "input", content: "continue merged context", requestId: "merge_first_run" },
        ctx,
      )
    ).wait(ctx);
    assert.equal(seen.length, 1);
    assert.match(JSON.stringify(seen[0]?.messages), /edited old origin after reopen/);
    assert.doesNotMatch(
      JSON.stringify(seen[0]?.messages),
      /shared editable origin|left explicit replacement|left second replacement|expanded middle old origin/,
    );
    assert.match(
      getCurrentSystemMessage(seen[0]?.messages ?? [])?.sections?.["bots-resources"] ?? "",
      /left instructions/,
    );
    const providerSections = Object.keys(
      getCurrentSystemMessage(seen[0]?.messages ?? [])?.sections ?? {},
    );
    assert.ok(providerSections.indexOf("bots-tools") < providerSections.indexOf("bots-resources"));
    const sequence = JSON.stringify(seen[0]?.messages);
    assert.ok(
      sequence.indexOf("edited old origin after reopen") <
        sequence.indexOf("independent left answer"),
    );
    assert.ok(
      sequence.indexOf("independent left answer") < sequence.indexOf("independent right answer"),
    );
    assert.equal(
      local.faux.state.callCount,
      1,
      "reopen/merge/edit never replays old model/tool work",
    );
    assert.deepEqual(await local.command("export", { head: left.head }), left);
    assert.deepEqual(await local.command("export", { head: right.head }), right);
  } finally {
    await local.harness.close(ctx);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a real SDK nested tool call cannot be exported as a complete P0 head, including through fork ancestry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-nested-history-"));
  const source = await open(dir);
  try {
    const extension = defineExtension({
      name: "nested-fixture",
      tools: [
        defineTool({
          name: "nested_fixture",
          description: "Calls another real SDK tool",
          parameters: Type.Object({}),
          async execute(_args, api, context) {
            const result = await api.executeTool(
              "write",
              { path: "nested.txt", content: "nested original output" },
              context,
              { key: "nested-write" },
            );
            return { output: [{ type: "text", text: JSON.stringify(result) }] };
          },
        }),
      ],
    });
    source.registry.install(extension);
    await source.root.configure({ extensions: { add: [extension] } }, ctx);
    source.faux.setResponses([
      assistant([toolCall("nested_fixture", {})], { stopReason: "toolUse" }),
      text("nested done"),
    ]);
    await (
      await source.root.submit(
        { type: "input", content: "nested call", requestId: "nested-input" },
        ctx,
      )
    ).wait(ctx);
    await source.harness.waitForIdle(ctx);
    assert.equal(
      await readFile(join(source.workspace, "nested.txt"), "utf8"),
      "nested original output",
    );
    const original = await all(source.root);
    assert.ok(
      original.some((entry) => entry.kind === "pi.tool-result" && entry.byTaskId !== undefined),
    );
    await assert.rejects(source.command("export", {}), /nested.*unsupported/);
    const tail = original.at(-1);
    assert.ok(tail);
    const fork = await source.root.fork(tail.id, { ownership: { kind: "ownerless" } }, ctx);
    const replica = new HistoryReplica(
      source.harness,
      fork.id,
      "b_shared",
      source.workspace,
      source.registry,
      source.storage,
      join(source.workspace, ".."),
    );
    await assert.rejects(
      replica.command({ method: "export", params: {}, trace }),
      /nested.*unsupported/,
    );
    assert.deepEqual(
      await all(source.root),
      original,
      "rejection preserves all original entries and source task provenance",
    );
  } finally {
    await source.harness.close(ctx);
    await rm(dir, { recursive: true, force: true });
  }
});
