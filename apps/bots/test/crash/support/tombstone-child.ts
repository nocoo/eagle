// Stops the production registry delete after its catalog mark, before moving a closed DB.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { BotDirectory, nodeDirectoryFs } from "../../../src/core/BotDirectory.ts";
import { BotRegistry } from "../../../src/core/BotRegistry.ts";
import { captureLog } from "../../../src/log/log.ts";
import { PiDurableRuntime } from "../../../src/runtime/pi/PiDurableRuntime.ts";

const root = process.argv[2];
if (root === undefined) throw new Error("usage: tombstone-child.ts <root>");
const fs = await nodeDirectoryFs();
const directory = new BotDirectory(root, {
  ...fs,
  rename: async (from, to) => {
    if (from.includes("/bots/")) {
      process.stdout.write("marked-before-move\n");
      // Keep this owned child alive until the parent delivers SIGKILL.
      await new Promise<void>(() => {
        setInterval(() => undefined, 1_000);
      });
    }
    await fs.rename(from, to);
  },
});
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const { log } = captureLog();
const runtime = new PiDurableRuntime({ models, log });
await directory.create({
  id: "b_marked",
  title: "delete crash",
  model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
  createdAt: "2026-10-30T00:00:00Z",
  updatedAt: "2026-10-30T00:00:00Z",
});
const registry = new BotRegistry({
  directory,
  log,
  model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
  openRuntime: (spec) => runtime.open(spec),
  readReplicaBinding: (spec) => runtime.readReplicaBinding(spec),
  idleCloseMs: 600_000,
  quarantineRetryMs: 30_000,
  closeDeadlineMs: 500,
});
await registry.start();
await writeFile(
  join(directory.botDir("b_marked"), "workspace/original.txt"),
  "preserved before move 原字节",
);
await registry.remove("b_marked", "tr_delete_crash");
