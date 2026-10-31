// Owned crash fixture: a real persisted child run, killed only by the parent test.
import assert from "node:assert/strict";
import type { HistoryBundle } from "../../../src/runtime/pi/HistoryReplica.ts";
import { createBench, text, trace, waitFor } from "../../support/pi.ts";

const bench = await createBench();
const dir = process.argv[2];
assert.ok(dir);
const handle = await bench.runtime.open({ ...bench.spec(), dir });
bench.faux.setResponses([text("root seed")]);
await handle.submit({ requestId: "report_cold_seed", text: "seed", whenBusy: "followUp", trace });
await waitFor(
  async () => (await handle.submission({ requestId: "report_cold_seed" }))?.status === "done",
  "root seed settles",
);
const seed = (await handle.replica?.({ method: "export", params: {}, trace })) as HistoryBundle;
const contextId = "report_cold_child";
await handle.replica?.({ method: "context", params: { contextId, head: seed.head }, trace });
const bundle = (await handle.replica?.({
  method: "export",
  params: { contextId },
  trace,
})) as HistoryBundle;
let entered = false;
bench.faux.setResponses([
  async () => {
    entered = true;
    return new Promise<never>(() => {});
  },
]);
const requestId = "report_cold_running";
const submission = await handle.submit({
  contextId,
  requestId,
  text: "child running",
  whenBusy: "followUp",
  trace,
});
await waitFor(() => entered, "real child provider barrier");
process.stdout.write(
  `${JSON.stringify({ fixtureRoot: bench.dir, contextId, conversationId: bundle.source.conversationId, requestId, submissionId: submission.id })}\n`,
);
setInterval(() => {}, 1000);
