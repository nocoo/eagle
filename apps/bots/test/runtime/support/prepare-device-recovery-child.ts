import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { retainInterruptedDeviceReceipts } from "../../../src/runtime/pi/device-recovery.ts";

const dir = process.argv[2];
if (dir === undefined) throw new Error("usage: prepare-device-recovery-child.ts <dir>");
const models = createModels();
models.setProvider(fauxProvider().provider);
const harness = await Harness.open(
  await openNodeSqliteStorage(join(dir, "session.sqlite")),
  { models, registry: createRegistry() },
  context,
);
const root = await harness.root(context);
await retainInterruptedDeviceReceipts(harness, root.id, "b_runtime", "unavailable");
process.stdout.write("prepared\n");
setInterval(() => undefined, 1000);
