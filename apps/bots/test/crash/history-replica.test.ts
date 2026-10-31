import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeHandle } from "../../src/core/RuntimePort.ts";
import type { HistoryBundle } from "../../src/runtime/pi/HistoryReplica.ts";
import { createBench, text, trace, waitFor } from "../support/pi.ts";

const childEnvironment = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (!["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "DEVELOPER_DIR"].includes(key))
      delete env[key];
  return env;
};
const killAtCommit = async (input: unknown) => {
  const child = spawn(
    process.execPath,
    [new URL("./support/history-child.ts", import.meta.url).pathname],
    { env: childEnvironment(), stdio: ["pipe", "pipe", "pipe"] },
  );
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let output = "";
  let error = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (value: string) => {
    output += value;
  });
  child.stderr.on("data", (value: string) => {
    error = (error + value).slice(-10_000);
  });
  child.stdin.end(`${JSON.stringify(input)}\n`);
  try {
    await waitFor(() => {
      if (child.exitCode !== null) throw new Error(`child exited before durable barrier: ${error}`);
      return output.includes("durable-barrier\n");
    }, "child's actual SQLite commit barrier");
  } finally {
    child.kill("SIGKILL");
    await closed;
  }
  assert.equal(child.signalCode, "SIGKILL");
};
const replica = (
  handle: RuntimeHandle,
  method: "export" | "import" | "run" | "status",
  params: unknown,
) => {
  assert.ok(handle.replica);
  return handle.replica({ method, params, trace });
};

test("SIGKILL after output commit, import commit and fork intent loses no history or admission binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-history-kill-"));
  const bench = await createBench();
  const handles: RuntimeHandle[] = [];
  try {
    const aDir = join(root, "a");
    await killAtCommit({ dir: aDir, mode: "output" });
    const a = await bench.runtime.open({ ...bench.spec(), id: "b_crash", dir: aDir });
    handles.push(a);
    const bundle = (await replica(a, "export", {})) as HistoryBundle;
    assert.ok(JSON.stringify(bundle.entries).includes("output committed before any export"));
    assert.equal(
      bench.faux.state.callCount,
      0,
      "recovering/exporting committed output needs no regeneration",
    );
    await a.close(trace, 5000);

    const bDir = join(root, "b");
    await killAtCommit({ dir: bDir, mode: "import", bundle });
    const b = await bench.runtime.open({ ...bench.spec(), id: "b_crash", dir: bDir });
    handles.push(b);
    assert.deepEqual(await replica(b, "import", { bundle }), { head: bundle.head });
    assert.deepEqual(await replica(b, "export", { head: bundle.head }), bundle);
    assert.deepEqual(await b.busy(), { run: false, tasks: false });
    assert.equal(bench.faux.state.callCount, 0);
    await b.close(trace, 5000);

    await killAtCommit({ dir: bDir, mode: "intent", bundle });
    bench.faux.setResponses([text("exactly one continuation after intent recovery")]);
    const resumed = await bench.runtime.open({ ...bench.spec(), id: "b_crash", dir: bDir });
    handles.push(resumed);
    await waitFor(
      async () =>
        (
          (await replica(resumed, "status", { requestId: "crash-intent" })) as {
            submission: { status: string } | null;
          }
        ).submission?.status === "done",
      "the durable local intent to recover",
    );
    assert.equal(
      bench.faux.state.callCount,
      1,
      "only the new local ledger recovers execution; the preceding foreign import stayed passive",
    );
    const params = { head: bundle.head, requestId: "crash-intent", text: "one local continuation" };
    await replica(resumed, "run", params);
    await waitFor(
      async () =>
        (
          (await replica(resumed, "status", { requestId: params.requestId })) as {
            submission: { status: string };
          }
        ).submission.status === "done" && !(await resumed.busy()).tasks,
      "recovered continuation output",
    );
    await replica(resumed, "run", params);
    assert.equal(bench.faux.state.callCount, 1);
    const branch = (await replica(resumed, "export", {
      branch: params.requestId,
    })) as HistoryBundle;
    assert.deepEqual(branch.parents, [bundle.head]);
    assert.equal(
      branch.entries.filter(
        (entry) => entry.kind === "pi.user" && JSON.stringify(entry.model).includes(params.text),
      ).length,
      1,
    );
    await resumed.close(trace, 5000);
    await killAtCommit({ dir: bDir, mode: "admission", bundle });
    bench.faux.setResponses([text("one answer after committed admission")]);
    const admitted = await bench.runtime.open({ ...bench.spec(), id: "b_crash", dir: bDir });
    handles.push(admitted);
    const admissionParams = {
      head: bundle.head,
      requestId: "crash-admission",
      text: "one local continuation",
    };
    await replica(admitted, "run", admissionParams);
    await waitFor(
      async () =>
        (
          (await replica(admitted, "status", { requestId: admissionParams.requestId })) as {
            submission: { status: string };
          }
        ).submission.status === "done" && !(await admitted.busy()).tasks,
      "admitted input recovery to settle",
    );
    const admittedBranch = (await replica(admitted, "export", {
      branch: admissionParams.requestId,
    })) as HistoryBundle;
    assert.equal(
      admittedBranch.entries.filter(
        (entry) =>
          entry.kind === "pi.user" && JSON.stringify(entry.model).includes(admissionParams.text),
      ).length,
      1,
      "a lost response after actual input admission cannot duplicate the input",
    );
    assert.equal(
      bench.faux.state.callCount,
      2,
      "one provider run per distinct local admission, including restart recovery",
    );
  } finally {
    await Promise.all(handles.map((handle) => handle.close(trace, 5000)));
    await bench.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
