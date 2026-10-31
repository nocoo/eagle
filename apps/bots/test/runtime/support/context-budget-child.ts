// Owned crash fixture: actual SDK/SQLite admissions, killed only by its parent test.
import assert from "node:assert/strict";
import type { HistoryBundle } from "../../../src/runtime/pi/HistoryReplica.ts";
import { createBench, text, trace, waitFor } from "../../support/pi.ts";

const bench = await createBench();
const dir = process.argv[2];
assert.ok(dir);
const handle = await bench.runtime.open({ ...bench.spec(), dir });
bench.faux.setResponses([text("seed answer")]);
await handle.submit({ requestId: "budget_seed", text: "seed", whenBusy: "followUp", trace });
await waitFor(
  async () => (await handle.submission({ requestId: "budget_seed" }))?.status === "done",
  "seed settles",
);
const seed = (await handle.replica?.({ method: "export", params: {}, trace })) as HistoryBundle;
for (const contextId of ["budget_unopened", "budget_selected"])
  await handle.replica?.({ method: "context", params: { contextId, head: seed.head }, trace });
let entered = false;
bench.faux.setResponses([
  async () => {
    entered = true;
    return new Promise<never>(() => {});
  },
]);
const inputs = Array.from({ length: 32 }, (_, i) => ({
  requestId: `budget_persisted_${i}`,
  contextId: "budget_unopened",
  text: `pending ${i}`,
  whenBusy: "followUp" as const,
  trace,
}));
const initial = inputs[0];
assert.ok(initial);
const first = await handle.submit(initial);
await waitFor(() => entered, "old context provider barrier");
for (const input of inputs.slice(1)) assert.equal((await handle.submit(input)).status, "queued");
process.stdout.write(
  `${JSON.stringify({ fixtureRoot: bench.dir, first, pending: inputs.length })}\n`,
);
setInterval(() => {}, 1000);
