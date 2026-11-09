// Tool groups at the runtime boundary (docs/bots/RUNTIME.md, "Tools"): the conversation's
// stored agent selects exactly the extensions its groups installed.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { RuntimeEvent } from "../../src/core/RuntimePort.ts";
import { HC_TOOLS_EXTENSION } from "../../src/tools/hc/tools.ts";
import { BOTS_TOOLS_EXTENSION } from "../../src/tools/registry.ts";
import { assistant, createBench, requestId, trace, waitFor } from "../support/pi.ts";

/** One turn, so the conversation writes its agent document. */
const runOnce = async (handle: {
  subscribe: (trace: string, sink: (event: RuntimeEvent) => void) => Promise<unknown>;
  submit: (input: {
    requestId: string;
    text: string;
    whenBusy: "followUp";
    trace: string;
  }) => Promise<unknown>;
}) => {
  const events: RuntimeEvent[] = [];
  await handle.subscribe(trace, (event) => events.push(event));
  await handle.submit({ requestId, text: "在吗", whenBusy: "followUp", trace });
  await waitFor(
    () => events.some((event) => event.type === "submission" && event.record.status === "done"),
    "the run to settle",
  );
};

const agentRecord = (bench: { dir: string }): string => {
  const db = new DatabaseSync(join(bench.dir, "b_runtime", "session.sqlite"), { readOnly: true });
  try {
    // The agent document keeps its state in revisions; the newest base holds the selection.
    return db
      .prepare(
        "select r.content as content from document_revisions r join documents d on d.id = r.document_id where d.kind like '%pi.agent%'",
      )
      .all()
      .map((row) => String((row as { content: string }).content))
      .join("\n");
  } finally {
    db.close();
  }
};

test("a bot given only the core group does not select the hc extension", async () => {
  const bench = await createBench();
  try {
    bench.faux.setResponses([assistant("ok")]);
    const handle = await bench.runtime.open({ ...bench.spec(), toolGroups: ["core"] });
    await runOnce(handle);
    const record = agentRecord(bench);
    assert.match(record, new RegExp(BOTS_TOOLS_EXTENSION));
    assert.equal(
      record.includes(HC_TOOLS_EXTENSION),
      false,
      `the stored agent keeps only the core extension (${record.slice(0, 200)})`,
    );
    await handle.close("tr_groups_close", 1_000);
  } finally {
    await bench.cleanup();
  }
});

test("a bot with the hc group selects both extensions", async () => {
  const bench = await createBench();
  try {
    bench.faux.setResponses([assistant("ok")]);
    const handle = await bench.runtime.open({ ...bench.spec(), toolGroups: ["core", "hc"] });
    await runOnce(handle);
    const record = agentRecord(bench);
    assert.match(record, new RegExp(BOTS_TOOLS_EXTENSION));
    assert.match(record, new RegExp(HC_TOOLS_EXTENSION));
    await handle.close("tr_groups_close", 1_000);
  } finally {
    await bench.cleanup();
  }
});
