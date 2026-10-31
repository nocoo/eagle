import { createInterface } from "node:readline";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { captureLog } from "../../../src/log/log.ts";
import { PiDurableRuntime } from "../../../src/runtime/pi/PiDurableRuntime.ts";
import { text, waitFor } from "../../support/pi.ts";

const lines = createInterface({ input: process.stdin });
const line = (await lines[Symbol.asyncIterator]().next()).value as string;
lines.close();
const input = JSON.parse(line) as {
  dir: string;
  mode: "output" | "import" | "intent" | "admission";
  bundle?: { head: string };
};
setInterval(() => undefined, 1000);
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const runtime = new PiDurableRuntime({
  models,
  log: captureLog().log,
  storage: async (path) => {
    const storage = await openNodeSqliteStorage(path);
    return new Proxy(storage, {
      get(target, key) {
        if (key === "commit") {
          const commit: Storage["commit"] = async (writes, context) => {
            const seq = await target.commit(writes, context);
            const kind =
              input.mode === "import"
                ? "bots.replica.import"
                : input.mode === "intent"
                  ? "bots.replica.run"
                  : "none";
            if (
              writes.some(
                (write) =>
                  (write.type === "document.create" && write.record.kind === kind) ||
                  (input.mode === "admission" &&
                    write.type === "submission" &&
                    write.value.requestId === "crash-admission" &&
                    write.value.status === "placed"),
              )
            ) {
              process.stdout.write("durable-barrier\n");
              await new Promise<never>(() => undefined);
            }
            return seq;
          };
          return commit;
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  },
});
const handle = await runtime.open({
  id: "b_crash",
  dir: input.dir,
  model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
  trace: "tr_history_crash",
});
if (input.mode === "output") {
  faux.setResponses([text("output committed before any export")]);
  await handle.submit({
    requestId: "source-crash",
    text: "source input",
    whenBusy: "followUp",
    trace: "tr_history_crash",
  });
  await waitFor(
    async () =>
      (await handle.submission({ requestId: "source-crash" }))?.status === "done" &&
      !(await handle.busy()).tasks,
    "source output and task settlement",
  );
  process.stdout.write("durable-barrier\n");
} else {
  await handle.replica?.({
    method: "import",
    params: { bundle: input.bundle },
    trace: "tr_history_crash",
  });
  if (input.mode === "intent" || input.mode === "admission")
    await handle.replica?.({
      method: "run",
      params: {
        head: input.bundle?.head,
        requestId: input.mode === "intent" ? "crash-intent" : "crash-admission",
        text: "one local continuation",
      },
      trace: "tr_history_crash",
    });
}
// Keep the child alive until the parent kills it at the committed-storage barrier.
await new Promise<void>(() => undefined);
