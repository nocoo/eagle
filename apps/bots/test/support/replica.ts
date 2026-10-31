import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { Harness, type Storage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { RuntimeHandle } from "../../src/core/RuntimePort.ts";
import { HistoryReplica } from "../../src/runtime/pi/HistoryReplica.ts";
import { ReplicaSync } from "../../src/runtime/pi/ReplicaSync.ts";
import { type Page, pageSchema, type Source } from "../../src/runtime/pi/syncProtocol.ts";
import { createToolRegistry, selectToolExtensions } from "../../src/tools/registry.ts";
import { openWorkspace } from "../../src/tools/workspace.ts";
import { trace } from "./pi.ts";

export const openReplica = async (
  dir: string,
  botId = "b_replica",
  responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0] = [],
  storage: (path: string) => Promise<Storage> = openNodeSqliteStorage,
) => {
  const workspace = await openWorkspace(join(dir, "workspace"));
  const registry = createToolRegistry(workspace);
  const faux = fauxProvider();
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const database = await storage(join(dir, "session.sqlite"));
  const harness = await Harness.open(
    database,
    {
      models,
      registry,
      settings: { compaction: { enabled: true, keepRecentTokens: 100, backgroundTokens: 0 } },
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? workspace.root }),
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
  const history = new HistoryReplica(
    harness,
    root.id,
    botId,
    workspace.root,
    registry,
    database,
    dir,
  );
  const sync = new ReplicaSync(
    join(dir, "replica.sqlite"),
    botId,
    await history.replicaId(),
    harness,
    root.id,
    history,
    () => undefined,
  );
  await sync.start();
  let closed = false;
  return {
    dir,
    workspace: workspace.root,
    faux,
    harness,
    root,
    history,
    sync,
    command: (
      method: Parameters<NonNullable<RuntimeHandle["replica"]>>[0]["method"],
      params: unknown,
    ) => sync.command({ method, params, trace }),
    close: async () => {
      if (!closed) {
        closed = true;
        try {
          await sync.close();
        } finally {
          await harness.close(ctx);
        }
      }
    },
  };
};
export type Replica = Awaited<ReturnType<typeof openReplica>>;
export const pull = async (a: Replica, after = 0, source?: Source): Promise<Page> =>
  pageSchema.parse(
    await a.command("pull", { after, limit: 128, ...(source === undefined ? {} : { source }) }),
  );
export const transfer = async (
  a: Replica,
  b: Replica,
  source?: Source,
  after = 0,
): Promise<Page[]> => {
  const pages: Page[] = [];
  let page: Page;
  do {
    page = await pull(a, after, source);
    pages.push(page);
    await b.command("apply", { page });
    if (page.nextAfter === after && page.hasMore)
      throw new Error("transfer has an unresolved source gap");
    after = page.nextAfter;
  } while (page.hasMore);
  return pages;
};
