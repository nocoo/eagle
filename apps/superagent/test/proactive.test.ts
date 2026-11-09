// SG-004 (docs/bots/specs/SUPERAGENT-004-PROACTIVE.md): the watcher notices a worker that
// needs attention, and the management layer writes to that worker through the person's own
// surface. Both are values in, values out — no worker runtime is touched here.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AttentionStore } from "../src/attention.ts";
import { createManage, manageArgs } from "../src/manage.ts";
import { ObservationClient } from "../src/observation.ts";
import { classifyTail, Watcher, type WatchPorts } from "../src/watch.ts";

const PROVIDER = {
  reachable: true,
  state: "ready" as const,
  lastReadAt: null,
  unavailable: 0,
  detail: null,
};

type Script = {
  changes: unknown;
  history?: Record<string, unknown>;
  providerState?: "ready" | "unconfigured" | "unreachable";
};

const bench = async (initial: () => Script) => {
  let script = initial;
  const root = await mkdtemp(join(tmpdir(), "superagent-watch-"));
  const store = new AttentionStore(root);
  let clock = Date.parse("2026-11-09T20:00:00.000Z");
  const reports: string[] = [];
  const nudges: { botId: string; verb: string; text: string }[] = [];
  const scope = {
    mode: "notify" as "off" | "notify" | "act",
    manageResult: { result: "sent" as const },
  };
  const observation = {
    snapshot: async () => ({
      provider: PROVIDER,
      snapshot: { kind: "snapshot", bots: [], cursor: "c_1" },
    }),
    changes: async () => {
      const current = script();
      if (current.providerState !== undefined) {
        return {
          provider: { ...PROVIDER, reachable: false, state: current.providerState },
          changes: null,
        };
      }
      return { provider: PROVIDER, changes: current.changes };
    },
    history: async (request: { botId: string }) => {
      const current = script();
      return {
        provider: PROVIDER,
        history: current.history?.[request.botId] ?? { messages: [] },
      };
    },
  };
  const ports: WatchPorts = {
    observation,
    store,
    now: () => new Date(clock),
    intervalMs: 60_000,
    stallAfterMs: 600_000,
    reopenAfterMs: 900_000,
    reportBudgetMs: 1_800_000,
    actionCooldownMs: 900_000,
    maxActionsPerHour: 6,
    get mode() {
      return scope.mode;
    },
    report: async (prompt) => {
      if ((scope as unknown as { reportThrows?: boolean }).reportThrows === true) {
        throw new Error("report_failed");
      }
      reports.push(prompt);
    },
    manage: async (call) => {
      if ((scope as unknown as { manageThrows?: boolean }).manageThrows === true) {
        throw new Error("manage_failed");
      }
      nudges.push(call);
      return scope.manageResult;
    },
  };
  const watcher = new Watcher(ports);
  return {
    root,
    store,
    watcher,
    reports,
    nudges,
    scope,
    setScript: (next: () => Script) => {
      script = next;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    at: (ms: number) => new Date(clock + ms).toISOString(),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

const change = (body: Record<string, unknown>) => ({ kind: "changes", changes: [body] });

test("SG004-A1: a bot whose store is missing becomes one high item", async () => {
  const bench_ = await bench(() => ({
    changes: change({ kind: "store_state_changed", botId: "b_1", state: "session_missing" }),
  }));
  try {
    await bench_.watcher.tick();
    const items = await bench_.store.list();
    assert.equal(items.length, 1);
    assert.equal(items[0]?.kind, "worker_unavailable");
    assert.equal(items[0]?.severity, "high");
    assert.equal(items[0]?.evidence, "store:session_missing");
    assert.equal(items[0]?.botId, "b_1");
  } finally {
    await bench_.cleanup();
  }
});

test("SG004-A2: an error answer raises worker_error once and counts the repeats", async () => {
  const tail = {
    messages: [
      { role: "user", state: "complete" },
      { role: "assistant", state: "error" },
    ],
  };
  const bench_ = await bench(() => ({
    changes: change({ kind: "history_appended", botId: "b_2", scopeId: "c_1" }),
    history: { b_2: tail },
  }));
  try {
    await bench_.watcher.tick();
    await bench_.watcher.tick();
    const items = await bench_.store.list();
    assert.equal(items.length, 1, "a second sighting is not a second item");
    assert.equal(items[0]?.kind, "worker_error");
    assert.equal(items[0]?.count, 2);
    // A healthy answer after the error closes the item.
    bench_.scope.mode = "off";
    const healthy = await bench(() => ({
      changes: change({ kind: "history_appended", botId: "b_2", scopeId: "c_1" }),
      history: { b_2: { messages: [{ role: "assistant", state: "complete" }] } },
    }));
    try {
      await healthy.watcher.tick();
      assert.equal(
        classifyTail({ messages: [{ role: "assistant", state: "complete" }] }),
        undefined,
      );
      assert.equal(classifyTail(tail), "worker_error");
    } finally {
      await healthy.cleanup();
    }
  } finally {
    await bench_.cleanup();
  }
});

test("SG004-A3: a running bot past the stall window is reported, and stops when it finishes", async () => {
  let activity = "running";
  const bench_ = await bench(() => ({
    changes: change({ kind: "activity_changed", botId: "b_3", activity }),
  }));
  try {
    await bench_.watcher.tick();
    assert.deepEqual(await bench_.store.list(), [], "a fresh run is not late yet");
    bench_.advance(11 * 60_000);
    await bench_.watcher.tick();
    const stalled = await bench_.store.list();
    assert.equal(stalled.length, 1);
    assert.equal(stalled[0]?.kind, "worker_stalled");
    assert.equal(stalled[0]?.evidence, "activity:running");

    activity = "idle";
    bench_.advance(60_000);
    await bench_.watcher.tick();
    const after = await bench_.store.list();
    assert.deepEqual(after, [], "the item closes once the bot stops running");
  } finally {
    await bench_.cleanup();
  }
});

test("SG004-A4: notify spends one model turn inside its budget, off spends none", async () => {
  let state = "session_missing";
  const bench_ = await bench(() => ({
    changes: change({ kind: "store_state_changed", botId: "b_4", state }),
  }));
  try {
    bench_.scope.mode = "off";
    await bench_.watcher.tick();
    assert.deepEqual(bench_.reports, [], "off stores the item and asks nothing");

    bench_.scope.mode = "notify";
    bench_.advance(60_000);
    await bench_.watcher.tick();
    assert.equal(bench_.reports.length, 1, "one report for the first item");
    assert.match(bench_.reports[0] ?? "", /内部巡检/);
    assert.match(bench_.reports[0] ?? "", /不要声称你执行过任何命令/);

    // A second Bot inside the report budget is stored but not reported again.
    state = "session_missing";
    bench_.setScript(() => ({
      changes: change({ kind: "store_state_changed", botId: "b_5", state: "session_missing" }),
    }));
    bench_.advance(60_000);
    await bench_.watcher.tick();
    assert.equal(bench_.reports.length, 1, "the budget covers every Bot, not one");
    assert.equal((await bench_.store.list()).length, 2, "both items are readable");
  } finally {
    await bench_.cleanup();
  }
});

test("SG004-A5: act nudges once per item and records who, what and with what result", async () => {
  const bench_ = await bench(() => ({
    changes: change({ kind: "store_state_changed", botId: "b_6", state: "session_missing" }),
  }));
  try {
    bench_.scope.mode = "act";
    await bench_.watcher.tick();
    assert.deepEqual(bench_.nudges, [], "an unavailable store is never nudged");

    const erroring = await bench(() => ({
      changes: change({ kind: "history_appended", botId: "b_7", scopeId: "c_1" }),
      history: { b_7: { messages: [{ role: "assistant", state: "error" }] } },
    }));
    try {
      erroring.scope.mode = "act";
      await erroring.watcher.tick();
      assert.equal(erroring.nudges.length, 1);
      assert.equal(erroring.nudges[0]?.verb, "nudge");
      assert.match(erroring.nudges[0]?.text ?? "", /内部巡检/);
      const audit = (await erroring.store.snapshot()).audit;
      assert.deepEqual(
        audit.map((record) => record.verb).sort(),
        ["nudge", "report"],
        "one report for the person, one write for the bot",
      );
      const nudge = audit.find((record) => record.verb === "nudge");
      assert.equal(nudge?.result, "sent");
      assert.equal(nudge?.botId, "b_7");

      erroring.advance(60_000);
      await erroring.watcher.tick();
      assert.equal(erroring.nudges.length, 1, "the same item is not nudged twice");
    } finally {
      await erroring.cleanup();
    }
  } finally {
    await bench_.cleanup();
  }
});

test("SG004-A6: a refused credential is an audit row, never a thrown tick", async () => {
  const bench_ = await bench(() => ({
    changes: change({ kind: "history_appended", botId: "b_8", scopeId: "c_1" }),
    history: { b_8: { messages: [{ role: "assistant", state: "aborted" }] } },
  }));
  try {
    bench_.scope.mode = "act";
    bench_.scope.manageResult = { result: "refused" as never };
    await bench_.watcher.tick();
    const audit = (await bench_.store.snapshot()).audit;
    const nudge = audit.find((record) => record.verb === "nudge");
    assert.equal(nudge?.result, "refused");
    assert.equal(
      (await bench_.store.snapshot()).budgets.actions.length,
      0,
      "a refusal spends no budget",
    );
  } finally {
    await bench_.cleanup();
  }
});

test("SG004-A7: an unreachable provider produces nothing and keeps what was noticed", async () => {
  let unreachable = false;
  const bench_ = await bench(() =>
    unreachable
      ? { changes: null, providerState: "unreachable" }
      : {
          changes: change({ kind: "store_state_changed", botId: "b_9", state: "session_missing" }),
        },
  );
  try {
    await bench_.watcher.tick();
    unreachable = true;
    bench_.scope.mode = "act";
    const result = await bench_.watcher.tick();
    assert.equal(result.provider?.state, "unreachable");
    assert.equal((await bench_.store.list()).length, 1, "the earlier item is still readable");
    assert.deepEqual(bench_.nudges, []);
    assert.equal((await bench_.store.snapshot()).lastError, "unreachable");
  } finally {
    await bench_.cleanup();
  }
});

test("SG004-A8: the watcher's baseline is a file of its own", async () => {
  const root = await mkdtemp(join(tmpdir(), "superagent-baseline-"));
  try {
    const app = new ObservationClient({ root, endpoint: "", tokenFile: "" });
    const watch = new ObservationClient({
      root,
      endpoint: "",
      tokenFile: "",
      stateFile: "watch-state.json",
    });
    assert.notEqual(app.path(), watch.path());
    await writeFile(join(root, "watch-state.json"), "{}", { mode: 0o600 });
    await writeFile(join(root, "observation-state.json"), "{}", { mode: 0o600 });
    assert.equal((await readFile(join(root, "watch-state.json"), "utf8")).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the management call is one CLI argv with the text as its own argument", async () => {
  assert.deepEqual(manageArgs({ botId: "b_1", verb: "nudge", text: "还在吗" }), [
    "chat",
    "send",
    "b_1",
    "--text",
    "还在吗",
    "--json",
  ]);
  assert.deepEqual(manageArgs({ botId: "b_1", verb: "abort", text: "" }), [
    "chat",
    "abort",
    "b_1",
    "--json",
  ]);

  const root = await mkdtemp(join(tmpdir(), "superagent-manage-"));
  try {
    const tokenFile = join(root, "write-token");
    await writeFile(tokenFile, `${"w".repeat(40)}\n`, { mode: 0o600 });
    const seen: { bin: string; args: readonly string[]; env: Readonly<Record<string, string>> }[] =
      [];
    let code = 0;
    const manage = createManage({
      bin: "/bundle/eagle",
      port: "43119",
      tokenFile,
      run: async (input) => {
        seen.push({ bin: input.bin, args: input.args, env: input.env });
        return { code };
      },
    });
    assert.deepEqual(await manage({ botId: "b_1", verb: "nudge", text: "hi" }), { result: "sent" });
    assert.equal(seen[0]?.bin, "/bundle/eagle");
    assert.equal(seen[0]?.env.EAGLE_PORT, "43119");
    assert.equal(seen[0]?.env.EAGLE_TOKEN, "w".repeat(40));
    code = 3;
    assert.deepEqual(await manage({ botId: "b_1", verb: "nudge", text: "hi" }), {
      result: "refused",
      detail: "scope_refused",
    });
    code = 4;
    assert.deepEqual(await manage({ botId: "b_1", verb: "abort", text: "" }), {
      result: "failed",
      detail: "daemon_unreachable",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SG004-A10: the service answers the attention commands and the one switch", async () => {
  const { createServer } = await import("node:http");
  const { readFile } = await import("node:fs/promises");
  const { startService } = await import("../src/server.ts");
  const socketModule = await import("ws");
  const { createHmac, randomBytes } = await import("node:crypto");
  const root = await mkdtemp(join(tmpdir(), "superagent-attention-socket-"));
  let provider: Awaited<ReturnType<typeof createServer>> | undefined;
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let socket: InstanceType<typeof socketModule.WebSocket> | undefined;
  try {
    // The provider answers one unavailable-store change and nothing else.
    provider = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          request.url === "/v1/observe/changes"
            ? {
                kind: "changes",
                changes: [
                  { kind: "store_state_changed", botId: "b_socket", state: "session_missing" },
                ],
                next: { cursor: "c_2" },
              }
            : {
                kind: "snapshot",
                source: { id: "src_1", epoch: "epoch_1" },
                cursor: "c_1",
                catalog: { revision: "r_1" },
                bots: [],
              },
        ),
      );
    });
    await new Promise<void>((resolve) => provider?.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    const providerPort = typeof address === "object" && address !== null ? address.port : 0;
    const observation = new ObservationClient({
      root,
      endpoint: `http://127.0.0.1:${providerPort}`,
      tokenFile: join(root, "observation-token"),
      stateFile: "watch-state.json",
    });
    service = await startService({
      root,
      port: 0,
      proactive: {
        mode: "act",
        intervalMs: 60_000,
        observation,
        manage: { bin: "/bin/echo", port: "1", tokenFile: join(root, "write-token") },
      },
    });
    await writeFile(join(root, "observation-token"), `${"t".repeat(40)}\n`, { mode: 0o600 });
    await writeFile(join(root, "write-token"), `${"w".repeat(40)}\n`, { mode: 0o600 });
    const token = (await readFile(join(root, "token"), "utf8")).trim();
    socket = new socketModule.WebSocket(`ws://127.0.0.1:${service.port}/v1/chat`);
    const frames: { type: string; id?: string; value?: unknown; code?: string }[] = [];
    socket.on("message", (bytes: Buffer) => frames.push(JSON.parse(bytes.toString())));
    const waitFor = async (predicate: (frame: (typeof frames)[number]) => boolean) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const index = frames.findIndex(predicate);
        if (index >= 0) {
          const frame = frames.splice(index, 1)[0];
          assert.ok(frame);
          return frame;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("frame_timeout");
    };
    await new Promise<void>((resolve) => socket?.once("open", () => resolve()));
    const nonce = randomBytes(16).toString("hex");
    socket.send(JSON.stringify({ type: "hello", nonce }));
    const challenge = (await waitFor((frame) => frame.type === "challenge")) as unknown as {
      serverNonce: string;
      identity: { instance: string };
    };
    const proof = createHmac("sha256", token)
      .update(`client\n${nonce}\n${challenge.serverNonce}\n${challenge.identity.instance}`)
      .digest("hex");
    socket.send(JSON.stringify({ type: "authenticate", proof }));
    await waitFor((frame) => frame.type === "ready");

    const call = async (type: string, fields: Record<string, unknown> = {}) => {
      const id = `cmd_${randomBytes(8).toString("hex")}`;
      socket?.send(JSON.stringify({ type, id, ...fields }));
      return waitFor((frame) => frame.id === id);
    };
    // Before any tick: no cursor, no error, and an empty list with a limit.
    const empty = await call("attention", { limit: 5 });
    assert.equal(empty.type, "result");
    assert.deepEqual((empty.value as { items: unknown[] }).items, []);
    assert.deepEqual((empty.value as { provider: unknown }).provider, {
      state: "ready",
      lastTickAt: null,
    });

    const mode = await call("manage-mode", {});
    assert.deepEqual(mode.value, { mode: "act" });
    const changed = await call("manage-mode", { mode: "notify" });
    assert.deepEqual(changed.value, { mode: "notify" });

    // The switch is set; the first tick primes the baseline and the second compares.
    await service.watcher?.tick();
    await service.watcher?.tick();
    const items = await call("attention", {});
    assert.equal(items.type, "result");
    const value = items.value as { items: { kind: string }[]; provider: { state: string } };
    assert.equal(value.items.length, 1);
    assert.equal(value.items[0]?.kind, "worker_unavailable");
    assert.equal(value.provider.state, "ready");

    const itemId = (value.items[0] as unknown as { id: string }).id;
    const acked = await call("attention-ack", { itemId });
    assert.equal(acked.type, "result");
    assert.equal(
      (acked.value as { item: { closedAt?: string } }).item.closedAt === undefined,
      false,
      "acknowledging closes the item",
    );
    const unknown = await call("attention-ack", { itemId: "a_unknown1" });
    assert.equal(unknown.type, "error");
    assert.equal(unknown.code, "invalid_command");

    // A provider that stops answering leaves an error state on the report, not an empty one.
    await new Promise<void>((resolve) => provider?.close(() => resolve()));
    await service.watcher?.tick();
    const degraded = await call("attention", {});
    assert.equal((degraded.value as { provider: { state: string } }).provider.state, "unreachable");
  } finally {
    socket?.close();
    await service?.close();
    await new Promise<void>((resolve) => {
      if (provider === undefined) resolve();
      else provider.close(() => resolve());
    });
    await rm(root, { recursive: true, force: true });
  }
});

test("the management call can really spawn the CLI, and a missing binary is a value", async () => {
  const root = await mkdtemp(join(tmpdir(), "superagent-manage-spawn-"));
  try {
    const tokenFile = join(root, "write-token");
    await writeFile(tokenFile, `${"w".repeat(40)}\n`, { mode: 0o600 });
    const ok = createManage({ bin: "/bin/echo", port: "1", tokenFile });
    assert.deepEqual(await ok({ botId: "b_1", verb: "nudge", text: "hi" }), { result: "sent" });
    const missing = createManage({ bin: join(root, "no-such-eagle"), port: "1", tokenFile });
    assert.deepEqual(await missing({ botId: "b_1", verb: "nudge", text: "hi" }), {
      result: "failed",
      detail: "cli_failed",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the watcher's timer follows the mode it was started with", async () => {
  const bench_ = await bench(() => ({ changes: { kind: "changes", changes: [] } }));
  try {
    bench_.scope.mode = "off";
    bench_.watcher.start();
    bench_.watcher.stop();
    assert.equal(bench_.watcher.mode, "off");
    bench_.scope.mode = "act";
    bench_.watcher.start();
    bench_.watcher.stop();
  } finally {
    await bench_.cleanup();
  }
});

test("a history read that returns nothing heals the item instead of raising another", async () => {
  let historyNull = true;
  const bench_ = await bench(
    (): Script => ({
      changes: change({ kind: "history_appended", botId: "b_11", scopeId: "c_1" }),
      ...(historyNull
        ? {}
        : { history: { b_11: { messages: [{ role: "assistant", state: "error" }] } } }),
    }),
  );
  try {
    bench_.scope.mode = "off";
    await bench_.watcher.tick();
    assert.deepEqual(await bench_.store.list(), []);
    historyNull = false;
    await bench_.watcher.tick();
    assert.equal((await bench_.store.list()).length, 1);
  } finally {
    await bench_.cleanup();
  }
});

test("only an assistant answer decides the tail, and nothing else is a failure", () => {
  assert.equal(classifyTail(undefined), undefined);
  assert.equal(classifyTail({}), undefined);
  assert.equal(classifyTail({ messages: "no" }), undefined);
  assert.equal(classifyTail({ messages: [{ role: "user", state: "error" }] }), undefined);
  assert.equal(classifyTail({ messages: [{ role: "tool", state: "complete" }] }), undefined);
  assert.equal(
    classifyTail({ messages: [{ role: "assistant", state: "aborted" }] }),
    "worker_error",
  );
});

test("a report that cannot be written is an audit row, not a thrown tick", async () => {
  const bench_ = await bench(() => ({
    changes: change({ kind: "store_state_changed", botId: "b_12", state: "session_missing" }),
  }));
  try {
    bench_.scope.mode = "notify";
    (bench_.scope as unknown as { reportThrows?: boolean }).reportThrows = true;
    await bench_.watcher.tick();
    assert.deepEqual(bench_.reports, [], "the prompt never reached the conversation");
    const audit = (await bench_.store.snapshot()).audit;
    assert.equal(
      audit.some((record) => record.verb === "report" && record.result === "failed"),
      true,
    );
    (bench_.scope as unknown as { reportThrows?: boolean }).reportThrows = false;
    await bench_.watcher.tick();
    assert.equal(bench_.reports.length, 1, "the next tick tries again and succeeds");
  } finally {
    await bench_.cleanup();
  }
});

test("a management call that throws is recorded, and the tick survives", async () => {
  const bench_ = await bench(() => ({
    changes: change({ kind: "history_appended", botId: "b_13", scopeId: "c_1" }),
    history: { b_13: { messages: [{ role: "assistant", state: "error" }] } },
  }));
  try {
    bench_.scope.mode = "act";
    (bench_.scope as unknown as { manageThrows?: boolean }).manageThrows = true;
    await bench_.watcher.tick();
    const audit = (await bench_.store.snapshot()).audit;
    assert.equal(
      audit.some((record) => record.verb === "nudge" && record.result === "failed"),
      true,
    );
  } finally {
    await bench_.cleanup();
  }
});

test("the attention commands are unavailable when the service runs without a watcher", async () => {
  const { readFile } = await import("node:fs/promises");
  const { startService } = await import("../src/server.ts");
  const socketModule = await import("ws");
  const { createHmac, randomBytes } = await import("node:crypto");
  const root = await mkdtemp(join(tmpdir(), "superagent-no-watch-"));
  const service = await startService({ root, port: 0 });
  const socket = new socketModule.WebSocket(`ws://127.0.0.1:${service.port}/v1/chat`);
  const frames: { type: string; id?: string; code?: string; value?: unknown }[] = [];
  socket.on("message", (bytes: Buffer) => frames.push(JSON.parse(bytes.toString())));
  const waitFor = async (predicate: (frame: (typeof frames)[number]) => boolean) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const index = frames.findIndex(predicate);
      if (index >= 0) {
        const frame = frames.splice(index, 1)[0];
        assert.ok(frame);
        return frame;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("frame_timeout");
  };
  try {
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
    const token = (await readFile(join(root, "token"), "utf8")).trim();
    const nonce = randomBytes(16).toString("hex");
    socket.send(JSON.stringify({ type: "hello", nonce }));
    const challenge = (await waitFor((frame) => frame.type === "challenge")) as unknown as {
      serverNonce: string;
      identity: { instance: string };
    };
    const proof = createHmac("sha256", token)
      .update(`client\n${nonce}\n${challenge.serverNonce}\n${challenge.identity.instance}`)
      .digest("hex");
    socket.send(JSON.stringify({ type: "authenticate", proof }));
    await waitFor((frame) => frame.type === "ready");
    for (const type of ["attention", "manage-mode"]) {
      const id = `cmd_${randomBytes(8).toString("hex")}`;
      socket.send(JSON.stringify({ type, id }));
      const answer = await waitFor((frame) => frame.id === id);
      assert.equal(answer.type, "error");
      assert.equal(answer.code, "invalid_command");
    }
  } finally {
    socket.close();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the attention store reads a damaged file as empty and a partial one as defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "superagent-attention-store-"));
  try {
    const store = new AttentionStore(root);
    // Absent: an empty store, no error.
    assert.deepEqual((await store.snapshot()).items, []);
    // Corrupt JSON: still empty, never a throw.
    await writeFile(store.path, "{ half", { mode: 0o600 });
    const corrupt = new AttentionStore(root);
    assert.deepEqual((await corrupt.snapshot()).items, []);
    // A partial file keeps what it has and defaults the rest.
    await writeFile(
      store.path,
      JSON.stringify({
        items: [{ id: "a_x", botId: "b", kind: "worker_error", evidence: "e" }],
        budgets: {},
      }),
      { mode: 0o600 },
    );
    const partial = new AttentionStore(root);
    const state = await partial.snapshot();
    assert.equal(state.items.length, 1);
    assert.deepEqual(state.activities, {});
    assert.deepEqual(state.budgets.actions, []);
    assert.equal(state.lastTickAt, undefined);
    assert.equal(state.lastError, undefined);
    // A file whose fields have the wrong types is read as the empty shape.
    await writeFile(
      store.path,
      JSON.stringify({ items: "no", audit: 4, activities: [], budgets: { actions: "no" } }),
      { mode: 0o600 },
    );
    const wrong = new AttentionStore(root);
    const wrongState = await wrong.snapshot();
    assert.deepEqual(wrongState.items, []);
    assert.deepEqual(wrongState.audit, []);
    assert.deepEqual(wrongState.activities, {});
    assert.deepEqual(wrongState.budgets.actions, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("items raise in place, reopen after the window, and are acknowledged once", async () => {
  const root = await mkdtemp(join(tmpdir(), "superagent-attention-raise-"));
  try {
    const store = new AttentionStore(root);
    const candidate = {
      botId: "b_1",
      kind: "worker_error" as const,
      severity: "medium" as const,
      evidence: "answer:error",
    };
    const first = await store.observe({
      candidates: [candidate],
      healed: new Set(),
      at: "2026-11-09T20:00:00.000Z",
      reopenAfterMs: 900_000,
    });
    assert.equal(first.length, 1);
    const second = await store.observe({
      candidates: [candidate],
      healed: new Set(),
      at: "2026-11-09T20:01:00.000Z",
      reopenAfterMs: 900_000,
    });
    assert.equal(second[0]?.count, 2);
    // Inside the reopen window a closed item is not raised again...
    await store.ack(second[0]?.id ?? "", "2026-11-09T20:02:00.000Z");
    const inside = await store.observe({
      candidates: [candidate],
      healed: new Set(),
      at: "2026-11-09T20:03:00.000Z",
      reopenAfterMs: 900_000,
    });
    assert.deepEqual(inside, []);
    // ...and past it, a new item is created.
    const later = await store.observe({
      candidates: [candidate],
      healed: new Set(),
      at: "2026-11-09T21:00:00.000Z",
      reopenAfterMs: 900_000,
    });
    assert.equal(later.length, 1);
    assert.equal(later[0]?.id === second[0]?.id, false);
    // Healing closes what the evidence no longer supports.
    await store.observe({
      candidates: [],
      healed: new Set(["b_1\u0000worker_error"]),
      at: "2026-11-09T21:01:00.000Z",
      reopenAfterMs: 900_000,
    });
    assert.deepEqual(await store.list(), []);
    assert.equal((await store.list({ includeClosed: true, limit: 100 })).length >= 1, true);
    // Unknown ids are not errors.
    assert.equal(await store.ack("a_unknown", "2026-11-09T21:02:00.000Z"), undefined);
    await store.markReportedItem("a_unknown", "2026-11-09T21:02:00.000Z");
    await store.markActed("a_unknown", "2026-11-09T21:02:00.000Z");
    await store.setActivity(
      "b_1",
      { activity: "running", since: "2026-11-09T21:00:00.000Z" },
      "2026-11-09T21:03:00.000Z",
    );
    await store.setActivity("b_1", undefined, "2026-11-09T21:04:00.000Z");
    assert.deepEqual((await store.snapshot()).activities, {});
    await store.markReported("2026-11-09T21:05:00.000Z");
    await store.markAction("2026-11-09T21:05:00.000Z");
    await store.finishTick("2026-11-09T21:06:00.000Z", "unreachable");
    assert.equal((await store.snapshot()).lastError, "unreachable");
    await store.finishTick("2026-11-09T21:07:00.000Z");
    assert.equal((await store.snapshot()).lastError, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a malformed change list is ignored instead of classified", async () => {
  for (const changes of [null, {}, { changes: "no" }, { changes: [null, 4, { noKind: true }] }]) {
    const bench_ = await bench(() => ({ changes }));
    try {
      bench_.scope.mode = "notify";
      const result = await bench_.watcher.tick();
      assert.deepEqual(result.raised, []);
      assert.deepEqual(await bench_.store.list(), []);
    } finally {
      await bench_.cleanup();
    }
  }
  // A change without a bot is not about a bot: `catalog_changed` asks for a snapshot read
  // before anything else can be said about the bot it carries.
  const bench_ = await bench(() => ({
    changes: { changes: [{ kind: "catalog_changed", bots: 4 }] },
  }));
  try {
    let reads = 0;
    const counting = {
      snapshot: async () => {
        reads += 1;
        return { provider: PROVIDER, snapshot: { kind: "snapshot", bots: [] } };
      },
      changes: async () => ({
        provider: PROVIDER,
        changes: { changes: [{ kind: "catalog_changed", bots: 4 }] },
      }),
      history: async () => ({ provider: PROVIDER, history: { messages: [] } }),
    };
    const watcher = new Watcher({
      observation: counting,
      store: new AttentionStore(bench_.root),
      now: () => new Date("2026-11-09T20:00:00.000Z"),
      intervalMs: 60_000,
      stallAfterMs: 600_000,
      reopenAfterMs: 900_000,
      reportBudgetMs: 1_800_000,
      actionCooldownMs: 900_000,
      maxActionsPerHour: 6,
      mode: "notify",
    });
    await watcher.tick();
    assert.equal(reads, 1, "the catalogue change is answered with one snapshot read");
    assert.deepEqual(await bench_.store.list(), []);
  } finally {
    await bench_.cleanup();
  }
});

test("a state or activity change without its value is not a fact", async () => {
  const bench_ = await bench(() => ({
    changes: {
      changes: [
        { kind: "store_state_changed", botId: "b_20" },
        { kind: "activity_changed", botId: "b_21" },
      ],
    },
  }));
  try {
    await bench_.watcher.tick();
    assert.deepEqual(await bench_.store.list(), []);
    assert.deepEqual((await bench_.store.snapshot()).activities, {});
  } finally {
    await bench_.cleanup();
  }
});

test("a run that stays in the same activity keeps the first timestamp", async () => {
  const bench_ = await bench(() => ({
    changes: change({ kind: "activity_changed", botId: "b_22", activity: "queued" }),
  }));
  try {
    bench_.scope.mode = "off";
    await bench_.watcher.tick();
    const first = (await bench_.store.snapshot()).activities.b_22?.since;
    bench_.advance(30_000);
    await bench_.watcher.tick();
    const second = (await bench_.store.snapshot()).activities.b_22?.since;
    assert.equal(first, second, "a repeated reading is not a new start");
  } finally {
    await bench_.cleanup();
  }
});

test("an overlapping tick shares the pass instead of reading twice", async () => {
  let reads = 0;
  const root = await mkdtemp(join(tmpdir(), "superagent-overlap-"));
  try {
    const watcher = new Watcher({
      observation: {
        snapshot: async () => ({ provider: PROVIDER, snapshot: { kind: "snapshot", bots: [] } }),
        changes: async () => {
          reads += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { provider: PROVIDER, changes: { kind: "changes", changes: [] } };
        },
        history: async () => ({ provider: PROVIDER, history: { messages: [] } }),
      },
      store: new AttentionStore(root),
      now: () => new Date(),
      intervalMs: 60_000,
      stallAfterMs: 600_000,
      reopenAfterMs: 900_000,
      reportBudgetMs: 1_800_000,
      actionCooldownMs: 900_000,
      maxActionsPerHour: 6,
      mode: "off",
    });
    const [first, second] = await Promise.all([watcher.tick(), watcher.tick()]);
    assert.equal(reads, 1, "one pass serves both callers");
    assert.equal(first, second);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("heals what a later reading no longer supports, and reads an odd activity", async () => {
  let state = "session_missing";
  const bench_ = await bench(() => ({
    changes: change({ kind: "store_state_changed", botId: "b_30", state }),
  }));
  try {
    await bench_.watcher.tick();
    assert.equal((await bench_.store.list()).length, 1);
    state = "available";
    bench_.advance(30_000);
    await bench_.watcher.tick();
    assert.deepEqual(await bench_.store.list(), [], "an available store closes the item");
    // A stored activity this daemon does not recognise is not a stall.
    await bench_.store.setActivity(
      "b_31",
      { activity: "unknown_value", since: "2026-11-09T19:00:00.000Z" },
      "2026-11-09T20:00:00.000Z",
    );
    await bench_.watcher.tick();
    assert.equal((await bench_.store.list()).length, 0);
  } finally {
    await bench_.cleanup();
  }
});

test("a stalled bot is nudged, and a second item on the same bot waits for the cooldown", async () => {
  const activity = "running";
  const bench_ = await bench(() => ({
    changes: change({ kind: "activity_changed", botId: "b_40", activity }),
  }));
  try {
    bench_.scope.mode = "act";
    await bench_.watcher.tick();
    bench_.advance(11 * 60_000);
    await bench_.watcher.tick();
    assert.equal(bench_.nudges.length, 1);
    assert.match(bench_.nudges[0]?.text ?? "", /执行任务已经很久/);

    // The same bot raises a second kind inside the cooldown: stored, not written to again.
    bench_.setScript(() => ({
      changes: change({ kind: "history_appended", botId: "b_40", scopeId: "c_1" }),
      history: { b_40: { messages: [{ role: "assistant", state: "error" }] } },
    }));
    bench_.advance(60_000);
    await bench_.watcher.tick();
    assert.equal(bench_.nudges.length, 1, "one bot is not pestered twice inside the cooldown");
    assert.equal((await bench_.store.list()).length, 2);
  } finally {
    await bench_.cleanup();
  }
});

test("the action budget stops a third write, and a detail is kept as a code", async () => {
  const bench_ = await bench(() => ({
    changes: {
      changes: [
        { kind: "store_state_changed", botId: "b_50", state: "session_missing" },
        { kind: "store_state_changed", botId: "b_51", state: "session_missing" },
      ],
    },
  }));
  try {
    bench_.scope.mode = "act";
    bench_.scope.manageResult = { result: "sent", detail: "cli_said_ok" } as never;
    await bench_.watcher.tick();
    const audit = (await bench_.store.snapshot()).audit;
    assert.deepEqual(
      audit.filter((row) => row.verb === "nudge"),
      [],
      "unavailable stores are reported, never written to",
    );
    assert.equal(
      audit.some((row) => row.verb === "report"),
      true,
    );

    const budget = await bench(() => ({
      changes: {
        changes: [
          { kind: "history_appended", botId: "b_52", scopeId: "c_1" },
          { kind: "history_appended", botId: "b_53", scopeId: "c_1" },
        ],
      },
      history: {
        b_52: { messages: [{ role: "assistant", state: "error" }] },
        b_53: { messages: [{ role: "assistant", state: "error" }] },
      },
    }));
    try {
      budget.scope.mode = "act";
      await budget.watcher.tick();
      const rows = (await budget.store.snapshot()).audit.filter((row) => row.verb === "nudge");
      assert.equal(rows.length, 2, "two bots, two writes");
      // The same detail a management call reported is stored as a code.
      assert.equal((await budget.store.snapshot()).budgets.actions.length, 2);
    } finally {
      await budget.cleanup();
    }
  } finally {
    await bench_.cleanup();
  }
});

test("a run that ends badly is a fact only after it settles", async () => {
  let activity = "running";
  let tail = "complete";
  const bench_ = await bench(() => ({
    changes: change({ kind: "activity_changed", botId: "b_60", activity }),
    history: { b_60: { messages: [{ role: "assistant", state: tail }] } },
  }));
  try {
    bench_.scope.mode = "notify";
    await bench_.watcher.tick();
    assert.deepEqual(await bench_.store.list(), [], "a streaming answer is not a failure yet");
    // The entry was appended while the run was live; the abort lands after it.
    tail = "aborted";
    activity = "idle";
    bench_.advance(20_000);
    await bench_.watcher.tick();
    const items = await bench_.store.list();
    assert.equal(items.length, 1);
    assert.equal(items[0]?.kind, "worker_error");
    assert.equal(items[0]?.evidence, "answer:error");
  } finally {
    await bench_.cleanup();
  }
});
