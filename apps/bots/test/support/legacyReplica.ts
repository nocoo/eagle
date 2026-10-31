import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  defineDocFamily,
  type EntryDraft,
  type EntryId,
  Harness,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { HistoryBundle } from "../../src/runtime/pi/HistoryReplica.ts";
import { createToolRegistry } from "../../src/tools/registry.ts";
import { openWorkspace } from "../../src/tools/workspace.ts";
import { type createBench, text } from "./pi.ts";
import { openReplica } from "./replica.ts";

// c073ea19 P0 receipt shape/import commit, without creating a replica.sqlite or P1 index.
export const legacyImports = defineDocFamily({
  kind: "bots.replica.import",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ bundle: "", conversationId: 0, entries: {} as Record<string, number> }),
  checkpointWhen: () => true,
});
export const seedP0 = async (
  bench: Awaited<ReturnType<typeof createBench>>,
  bundle: HistoryBundle,
  corrupt = false,
) => {
  const spec = bench.spec();
  const workspace = await openWorkspace(join(spec.dir, "workspace"));
  const models = createModels();
  models.setProvider(bench.faux.provider);
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(spec.dir, "session.sqlite")),
    { models, registry: createToolRegistry(workspace) },
    ctx,
  );
  try {
    await harness.root(ctx, { agent: { model: spec.model, cwd: workspace.root } });
    await harness.commit(async (tx) => {
      const receipt = await tx.doc(legacyImports, bundle.head, null);
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      Object.assign(await tx.doc(AgentDoc, conversation.id), bundle.agent);
      for (const original of bundle.entries) {
        const { id, head, edits } = original;
        const draft: EntryDraft = {
          kind: original.kind,
          ...(original.model === undefined ? {} : { model: original.model }),
          ...(original.data === undefined ? {} : { data: original.data }),
          ...(head === undefined
            ? {}
            : { head: head === id ? "self" : (receipt.entries[String(head)] as EntryId) }),
          ...(edits === undefined
            ? {}
            : {
                edits: edits.map((edit) => ({
                  ...edit,
                  target: receipt.entries[String(edit.target)] as EntryId,
                })),
              }),
        };
        receipt.entries[String(id)] = (await tx.appendEntry(conversation.id, draft)).id;
      }
      receipt.conversationId = conversation.id;
      receipt.bundle = corrupt
        ? JSON.stringify({ ...bundle, head: "0".repeat(64) })
        : JSON.stringify(bundle);
    }, ctx);
    const saved = await harness.snapshot(legacyImports, bundle.head, ctx);
    assert.ok(saved && !Object.hasOwn(saved, "manifest"));
    assert.equal(bench.faux.state.callCount, 0);
    await assert.rejects(access(join(spec.dir, "replica.sqlite")), { code: "ENOENT" });
    return { harness, saved };
  } catch (error) {
    await harness.close(ctx);
    throw error;
  }
};

export const sourceCarriers = async (dir: string) => {
  const a = await openReplica(dir);
  try {
    a.faux.setResponses([text("original P0 source")]);
    await (
      await a.root.submit(
        { type: "input", requestId: "p0-source", content: "original P0 input" },
        ctx,
      )
    ).wait(ctx);
    const h0 = (await a.command("export", {})) as HistoryBundle;
    a.faux.setResponses([text("original P0 branch")]);
    await a.command("run", {
      head: h0.head,
      requestId: "p0-branch",
      text: "original branch input",
    });
    await a.harness.waitForIdle(ctx);
    const h1 = (await a.command("export", { branch: "p0-branch" })) as HistoryBundle;
    assert.deepEqual(h1.parents, [h0.head]);
    return [h0, h1];
  } finally {
    await a.close();
  }
};
