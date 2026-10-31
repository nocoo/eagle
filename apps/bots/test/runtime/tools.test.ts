import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { RuntimeEvent, RuntimeHandle } from "../../src/core/RuntimePort.ts";
import {
  assistant,
  type Bench,
  createBench,
  requestId,
  text,
  toolCall,
  trace,
  waitFor,
} from "../support/pi.ts";

const workspaceOf = (bench: { dir: string }) => join(bench.dir, "b_runtime", "workspace");

const settle = async (handle: RuntimeHandle, bench: Bench, responses: FauxResponseStep[]) => {
  bench.faux.setResponses(responses);
  const events: RuntimeEvent[] = [];
  await handle.subscribe(trace, (event) => events.push(event));
  const submitted = await handle.submit({
    requestId,
    text: "请用工具完成任务",
    whenBusy: "followUp",
    trace,
  });
  void submitted;
  await waitFor(
    () => events.some((event) => event.type === "submission" && event.record.status === "done"),
    "the run to settle",
  );
  const final = events
    .filter((event) => event.type === "append")
    .map((event) => event.message)
    .filter((message) => message.role === "assistant" && message.state === "complete")
    .at(-1);
  return { events, final };
};

test("a read call runs and its result reaches the model", async () => {
  const bench = await createBench();
  try {
    const handle = await bench.runtime.open(bench.spec());
    const workspace = workspaceOf(bench);
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "notes.txt"), "工作区里的内容\n", { mode: 0o600 });

    const { final } = await settle(handle, bench, [
      assistant([toolCall("read", { path: "notes.txt" })], { stopReason: "toolUse" }),
      (context: { messages: { role: string; content: unknown }[] }) => {
        const seen = JSON.stringify(context.messages);
        return assistant(seen.includes("工作区里的内容") ? "saw the file" : "missing");
      },
    ]);
    assert.equal(final?.blocks[0]?.type === "text" ? final.blocks[0].text : "", "saw the file");
  } finally {
    await bench.cleanup();
  }
});

test("a write call runs without approval and the file exists", async () => {
  const bench = await createBench();
  try {
    const handle = await bench.runtime.open(bench.spec());
    const { final } = await settle(handle, bench, [
      assistant([toolCall("write", { path: "notes/out.txt", content: "from the model" })], {
        stopReason: "toolUse",
      }),
      text("written"),
    ]);
    assert.equal(
      await readFile(join(workspaceOf(bench), "notes/out.txt"), "utf8"),
      "from the model",
    );
    assert.equal(final?.blocks[0]?.type === "text" ? final.blocks[0].text : "", "written");
  } finally {
    await bench.cleanup();
  }
});

test("a bash call runs in the workspace and reports its exit", async () => {
  const bench = await createBench();
  try {
    const handle = await bench.runtime.open(bench.spec());
    const { final } = await settle(handle, bench, [
      assistant([toolCall("bash", { command: "printf hi > ran.txt" })], {
        stopReason: "toolUse",
      }),
      text("ran"),
    ]);
    assert.equal(await readFile(join(workspaceOf(bench), "ran.txt"), "utf8"), "hi");
    assert.equal(final?.blocks[0]?.type === "text" ? final.blocks[0].text : "", "ran");
  } finally {
    await bench.cleanup();
  }
});

test("a tool refusal is a result the model can read, not a failed run", async () => {
  const bench = await createBench();
  try {
    const handle = await bench.runtime.open(bench.spec());
    const { final } = await settle(handle, bench, [
      assistant([toolCall("read", { path: "missing-file.txt" })], {
        stopReason: "toolUse",
      }),
      (context: { messages: { role: string; content: unknown }[] }) => {
        const seen = JSON.stringify(context.messages);
        return assistant(seen.includes("ENOENT") ? "refused" : "missing error");
      },
    ]);
    assert.equal(final?.blocks[0]?.type === "text" ? final.blocks[0].text : "", "refused");
  } finally {
    await bench.cleanup();
  }
});

test("a long bash output keeps its exit diagnostic through the SDK", async () => {
  const bench = await createBench();
  try {
    const handle = await bench.runtime.open(bench.spec());
    const { final } = await settle(handle, bench, [
      assistant([toolCall("bash", { command: "seq 1 3000; exit 7" })], { stopReason: "toolUse" }),
      (context: { messages: { role: string; content: unknown }[] }) => {
        const seen = JSON.stringify(context.messages);
        return assistant(seen.includes("Command exited with code 7") ? "exit seen" : "exit lost");
      },
    ]);
    assert.equal(final?.blocks[0]?.type === "text" ? final.blocks[0].text : "", "exit seen");
  } finally {
    await bench.cleanup();
  }
});

test("a full read page keeps its total note through the SDK", async () => {
  const bench = await createBench();
  try {
    const handle = await bench.runtime.open(bench.spec());
    const workspace = workspaceOf(bench);
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, "long.txt"),
      Array.from({ length: 2_500 }, (_, index) => `row ${index + 1}`).join("\n"),
    );
    const { final } = await settle(handle, bench, [
      assistant([toolCall("read", { path: "long.txt" })], { stopReason: "toolUse" }),
      (context: { messages: { role: string; content: unknown }[] }) => {
        const seen = JSON.stringify(context.messages);
        return assistant(seen.includes("Showing lines 1-2000 of 2500") ? "note seen" : "note lost");
      },
    ]);
    assert.equal(final?.blocks[0]?.type === "text" ? final.blocks[0].text : "", "note seen");
  } finally {
    await bench.cleanup();
  }
});

test("a tool call and its result are live transcript rows and survive a late join", async () => {
  const bench = await createBench();
  try {
    const handle = await bench.runtime.open(bench.spec());
    const workspace = workspaceOf(bench);
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "notes.txt"), "工作区里的内容\n", { mode: 0o600 });
    const { events } = await settle(handle, bench, [
      assistant([toolCall("read", { path: "notes.txt" })], { stopReason: "toolUse" }),
      text("看完了"),
    ]);
    const appends = events.filter((event) => event.type === "append");
    const call = appends.find((event) =>
      event.message.blocks.some((block) => block.type === "toolCall"),
    );
    assert.equal(call?.message.role, "assistant", "the call rides in the assistant entry");
    const tool = appends.find((event) => event.message.role === "tool");
    assert.ok(tool !== undefined, "the durable tool result is an append of its own");
    const block = tool.message.blocks[0];
    assert.equal(block?.type, "toolResult");
    assert.equal(block?.type === "toolResult" ? block.name : "", "read");
    assert.match(block?.type === "toolResult" ? block.text : "", /工作区里的内容/);
    assert.equal(block?.type === "toolResult" ? block.isError : true, false);

    // A late join sees the same rows from the subscription's baseline, in order.
    const { snapshot } = await handle.subscribe(trace, () => undefined);
    assert.deepEqual(
      snapshot.messages.map((message) => message.role),
      ["user", "assistant", "tool", "assistant"],
    );
    assert.equal(snapshot.messages[2]?.blocks[0]?.type, "toolResult");
  } finally {
    await bench.cleanup();
  }
});

test("native edit changes the real file and list returns its path to the model", async () => {
  const bench = await createBench();
  try {
    const handle = await bench.runtime.open({ ...bench.spec(), toolGroups: [] });
    await writeFile(join(workspaceOf(bench), "edit.txt"), "before\nunchanged\n");
    const { final } = await settle(handle, bench, [
      assistant(
        [toolCall("edit", { path: "edit.txt", edits: [{ oldText: "before", newText: "after" }] })],
        { stopReason: "toolUse" },
      ),
      assistant([toolCall("list", {})], { stopReason: "toolUse" }),
      (context) =>
        assistant(JSON.stringify(context.messages).includes("edit.txt") ? "listed" : "missing"),
    ]);
    assert.equal(
      await readFile(join(workspaceOf(bench), "edit.txt"), "utf8"),
      "after\nunchanged\n",
    );
    assert.equal(final?.blocks[0]?.type === "text" ? final.blocks[0].text : "", "listed");
    await handle.close(trace, 1_000);
  } finally {
    await bench.cleanup();
  }
});

test("native edit refuses ambiguous replacements without changing the file", async () => {
  const bench = await createBench();
  try {
    const handle = await bench.runtime.open(bench.spec());
    await writeFile(join(workspaceOf(bench), "edit.txt"), "same\nsame\n");
    const { events } = await settle(handle, bench, [
      assistant(
        [toolCall("edit", { path: "edit.txt", edits: [{ oldText: "same", newText: "after" }] })],
        { stopReason: "toolUse" },
      ),
      text("edit refused"),
    ]);
    const result = events
      .flatMap((event) => (event.type === "append" ? event.message.blocks : []))
      .find((block) => block.type === "toolResult");
    assert.equal(result?.type === "toolResult" && result.isError, true);
    assert.equal(await readFile(join(workspaceOf(bench), "edit.txt"), "utf8"), "same\nsame\n");
    await handle.close(trace, 1_000);
  } finally {
    await bench.cleanup();
  }
});

test("native read accepts a local absolute path outside the default working directory", async () => {
  const bench = await createBench();
  try {
    const path = join(bench.dir, "outside-workspace.txt");
    await writeFile(path, "local file access");
    const handle = await bench.runtime.open(bench.spec());
    const { final } = await settle(handle, bench, [
      assistant([toolCall("read", { path })], { stopReason: "toolUse" }),
      (context) =>
        assistant(
          JSON.stringify(context.messages).includes("local file access") ? "read" : "missing",
        ),
    ]);
    assert.equal(final?.blocks[0]?.type === "text" ? final.blocks[0].text : "", "read");
    await handle.close(trace, 1_000);
  } finally {
    await bench.cleanup();
  }
});

test("native bash timeout keeps collected output and returns a model-visible failure", async (t) => {
  const bench = await createBench();
  const exec = NodeExecutionEnv.prototype.exec;
  const wallTimeout = globalThis.setTimeout;
  const wallClearTimeout = globalThis.clearTimeout;
  let received = "";
  t.mock.method(
    NodeExecutionEnv.prototype,
    "exec",
    async function (
      this: NodeExecutionEnv,
      ...[command, options, context]: Parameters<typeof exec>
    ) {
      assert.equal(options?.timeout, 0.05);
      // Shell startup is not bounded by 50ms; advance the real SDK's timer after real output.
      t.mock.timers.enable({ apis: ["setTimeout"] });
      let advanced = false;
      const advance = () => {
        if (advanced) return;
        advanced = true;
        t.mock.timers.tick(50);
        t.mock.timers.reset();
      };
      const guard = wallTimeout(advance, 5_000);
      try {
        return await exec.call(
          this,
          command,
          {
            ...options,
            onOutput: (...args) => {
              options?.onOutput?.(...args);
              received += args[0];
              if (received.includes("before-timeout")) advance();
            },
          },
          context,
        );
      } finally {
        wallClearTimeout(guard);
        t.mock.timers.reset();
      }
    },
  );
  try {
    const handle = await bench.runtime.open(bench.spec());
    const { events } = await settle(handle, bench, [
      assistant(
        [toolCall("bash", { command: "printf before-timeout >&2; exec sleep 2", timeout: 0.05 })],
        { stopReason: "toolUse" },
      ),
      text("timed out"),
    ]);
    const result = events
      .flatMap((event) => (event.type === "append" ? event.message.blocks : []))
      .find((block) => block.type === "toolResult");
    assert.ok(result?.type === "toolResult");
    assert.equal(received, "before-timeout", "the real onOutput callback received stderr");
    assert.equal(result.isError, true);
    assert.match(result.text, /before-timeout/);
    assert.match(result.text, /timed out/i);
    await handle.close(trace, 1_000);
  } finally {
    await bench.cleanup();
  }
});

test("native bash preserves split UTF-8 output and both streams", async () => {
  const bench = await createBench();
  try {
    const handle = await bench.runtime.open(bench.spec());
    const script =
      "process.stdout.write(Buffer.from([0xe4])); setTimeout(() => { process.stdout.write(Buffer.from([0xbd, 0xa0])); process.stderr.write('stderr'); }, 5)";
    const { events } = await settle(handle, bench, [
      assistant(
        [
          toolCall("bash", {
            command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
          }),
        ],
        { stopReason: "toolUse" },
      ),
      text("decoded"),
    ]);
    const result = events
      .flatMap((event) => (event.type === "append" ? event.message.blocks : []))
      .find((block) => block.type === "toolResult");
    assert.ok(result?.type === "toolResult");
    assert.equal(result.isError, false);
    assert.match(result.text, /你/);
    assert.match(result.text, /stderr/);
    assert.equal(result.text.includes("\uFFFD"), false);
    await handle.close(trace, 1_000);
  } finally {
    await bench.cleanup();
  }
});

test("aborting a native bash call stops its owned process", async (t) => {
  const bench = await createBench();
  let pid: number | undefined;
  t.after(async () => {
    if (pid !== undefined && pid > 0) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await bench.cleanup();
  });
  const handle = await bench.runtime.open(bench.spec());
  bench.faux.setResponses([
    assistant([toolCall("bash", { command: "echo $$ > command.pid; sleep 20" })], {
      stopReason: "toolUse",
    }),
  ]);
  await handle.subscribe(trace, () => undefined);
  await handle.submit({ requestId, text: "run until aborted", whenBusy: "followUp", trace });
  await waitFor(async () => {
    const value = await readFile(join(workspaceOf(bench), "command.pid"), "utf8").catch(() => "");
    pid = Number(value.trim());
    return Number.isInteger(pid) && pid > 0;
  }, "the owned command to start");
  await handle.abort(trace);
  await waitFor(() => {
    try {
      process.kill(pid as number, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      return true;
    }
  }, "the native environment to stop its command");
  pid = undefined;
  await handle.close(trace, 1_000);
});

test("the native shell preparation hook prevents daemon secret inheritance", async () => {
  const bench = await createBench();
  const previous = process.env.BOTS_TEST_SECRET;
  process.env.BOTS_TEST_SECRET = "synthetic-credential-for-test";
  try {
    const handle = await bench.runtime.open(bench.spec());
    const { final } = await settle(handle, bench, [
      assistant([toolCall("bash", { command: "printenv BOTS_TEST_SECRET || printf unset" })], {
        stopReason: "toolUse",
      }),
      (context) => {
        const results = context.messages.filter((message) => message.role === "toolResult");
        const seen = JSON.stringify(results);
        return assistant(
          seen.includes("unset") && !seen.includes("synthetic-credential-for-test")
            ? "not inherited"
            : "leaked",
        );
      },
    ]);
    assert.equal(final?.blocks[0]?.type === "text" ? final.blocks[0].text : "", "not inherited");
    await handle.close(trace, 1_000);
  } finally {
    if (previous === undefined) delete process.env.BOTS_TEST_SECRET;
    else process.env.BOTS_TEST_SECRET = previous;
    await bench.cleanup();
  }
});

test("reopening an existing conversation applies the mandatory coding extension", async () => {
  const bench = await createBench();
  try {
    const spec = bench.spec();
    const workspace = workspaceOf(bench);
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "existing.txt"), "existing conversation");
    const registry = createRegistry();
    const core = defineExtension({ name: "bots-tools" });
    registry.install(core);
    const harness = await Harness.open(
      await openNodeSqliteStorage(join(spec.dir, "session.sqlite")),
      { models: createModels(), registry },
      BACKGROUND_CONTEXT,
    );
    await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: spec.model, cwd: workspace, extensions: [core] },
    });
    await harness.close(BACKGROUND_CONTEXT);
    const handle = await bench.runtime.open(spec);
    const { final } = await settle(handle, bench, [
      assistant([toolCall("read", { path: "existing.txt" })], { stopReason: "toolUse" }),
      (context) => {
        const results = context.messages.filter((message) => message.role === "toolResult");
        return assistant(
          JSON.stringify(results).includes("existing conversation")
            ? "coding restored"
            : "coding missing",
        );
      },
    ]);
    assert.equal(final?.blocks[0]?.type === "text" ? final.blocks[0].text : "", "coding restored");
    await handle.close(trace, 1_000);
  } finally {
    await bench.cleanup();
  }
});
