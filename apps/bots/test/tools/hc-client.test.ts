// The hc CLI client (docs/bots/RUNTIME.md, "Herdr tools"): one argv, JSON in, JSON out,
// a deadline that ends a hung call, and an abort that is not waited out. The binary is a
// script here, so the test is about this client, not about a live herdr-core server.
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHcClient, HcCommandError } from "../../src/tools/hc/client.ts";

const FAKE = `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const log = process.env.FAKE_HC_LOG;
if (log) appendFileSync(log, args.join(" ") + "\\n");
const out = (value) => { writeFileSync(1, JSON.stringify(value)); };
const first = args[0];
const mode = process.env.FAKE_HC_MODE;
const terminal = {
  address: "t7",
  name: "bots-abcd-steering",
  state: "live",
  agent: "pi",
  cwd: "/tmp",
  labels: { bots: "b_a" },
  status: { app: "pi", state: "idle" },
  exit_code: null,
};
if (first === "ls") {
  if (mode === "foreign") {
    out({ hidden_finished: 0, terminals: [
      { address: "t7", name: "bots-abcd-steering", state: "live", agent: "pi", cwd: "/tmp" },
      { address: "t8", name: "someone-else", state: "live", agent: "pi", cwd: "/tmp" },
    ] });
  } else {
    out({ hidden_finished: 0, terminals: [
      { address: "t7", name: "bots-abcd-steering", state: "live", agent: "pi", cwd: "/tmp" },
      { name: "no address" },
    ] });
  }
} else if (first === "get") {
  if (args[1] === "nope") {
    out({ error: { hint: "see hc ls --all", kind: "not_found", message: 'no terminal "nope"' } });
  } else {
    out(terminal);
  }
} else if (first === "run") {
  out({ address: "t7", agent: "pi", cwd: "/tmp", name: "bots-abcd-steering", state: "live", turn: 0 });
} else if (first === "send") {
  if (process.env.FAKE_HC_ERROR === "1") {
    out({ error: { kind: "blocked", message: "the agent is blocked" } });
  } else {
    out({ started: null, status: "done", turn: 1 });
  }
} else if (first === "wait") {
  setTimeout(() => out({ children: [], ended: true, exit_code: 0, reason: "status", status: "done", terminal: "t7", turn: 1 }), 40);
} else if (first === "read") {
  if (mode === "big") {
    for (let index = 0; index < 5; index += 1) writeFileSync(1, Buffer.alloc(1024 * 1024, 0x61));
    writeFileSync(1, "ACTUAL_SCREEN_END");
  } else if (mode === "split") {
    const body = Buffer.from("你\\n");
    writeFileSync(1, body.subarray(0, body.length - 2));
    setTimeout(() => writeFileSync(1, body.subarray(body.length - 2)), 60);
  } else if (mode === "hang") {
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { detached: true, stdio: ["ignore", 1, 2] }).unref();
    setTimeout(() => {}, 5000);
  } else {
    writeFileSync(1, "screen\\ntext\\n");
  }
} else if (first === "keys") {
  out({ status: null, turn: 1 });
} else if (first === "kill") {
  out({ ...terminal, exit_code: 0 });
} else if (first === "rm") {
  if (args[1] === "nope") {
    out({ error: { hint: "see hc ls --all", kind: "not_found", message: 'no terminal "nope"' } });
  } else if (mode === "live") {
    out({ error: { hint: "kill it first: hc kill t7", kind: "live", message: "t7 is still running" } });
  } else {
    out({ removed: "t7" });
  }
} else {
  writeFileSync(2, "unexpected " + args.join(" "));
  process.exitCode = 2;
}
`;

const bench = async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-hc-cli-"));
  const binary = join(dir, "fake-hc");
  await writeFile(binary, FAKE, { mode: 0o700 });
  await chmod(binary, 0o700);
  const log = join(dir, "calls.log");
  const client = createHcClient({ binary, env: { FAKE_HC_LOG: log } });
  const failing = createHcClient({ binary, env: { FAKE_HC_LOG: log, FAKE_HC_ERROR: "1" } });
  const withMode = (mode: string) =>
    createHcClient({ binary, env: { FAKE_HC_LOG: log, FAKE_HC_MODE: mode } });
  const calls = async (): Promise<string[]> =>
    (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  return {
    client,
    failing,
    withMode,
    calls,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
};

test("list and get map the CLI's own fields", async () => {
  const fixture = await bench();
  try {
    const terminals = await fixture.client.list({ bots: "b_a" });
    assert.deepEqual(terminals, [
      {
        address: "t7",
        name: "bots-abcd-steering",
        state: "live",
        status: undefined,
        agent: "pi",
        cwd: "/tmp",
        labels: {},
        exitCode: null,
      },
    ]);
    const one = await fixture.client.get("t7");
    assert.deepEqual(one?.labels, { bots: "b_a" });
    assert.equal(one?.status, "idle");
    assert.equal((await fixture.calls())[0], "ls --json --label bots=b_a");
    assert.equal((await fixture.calls())[1], "get t7 --json");
  } finally {
    await fixture.cleanup();
  }
});

test("a missing terminal is its error kind, not an empty answer", async () => {
  const fixture = await bench();
  try {
    await assert.rejects(
      () => fixture.client.get("nope"),
      (error: unknown) =>
        error instanceof HcCommandError &&
        error.code === "not_found" &&
        error.message.includes("no terminal"),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("run passes the argv after --, and the labels as flags", async () => {
  const fixture = await bench();
  try {
    const address = await fixture.client.run({
      name: "bots-abcd-steering",
      cwd: "/tmp/repo",
      labels: { bots: "b_a" },
      argv: ["pi", "--model", "group/steering", "do it"],
    });
    assert.equal(address, "t7");
    assert.equal(
      (await fixture.calls())[0],
      "run --bg --json --name bots-abcd-steering --cwd /tmp/repo --label bots=b_a -- pi --model group/steering do it",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("send, wait, keys, kill and rm report the states hc reports", async () => {
  const fixture = await bench();
  try {
    assert.equal(await fixture.client.send({ address: "t7", text: "hi", wait: true }), "done");
    const waited = await fixture.client.wait({ address: "t7" });
    assert.deepEqual(waited, { status: "done", reason: "status", ended: true, exitCode: 0 });
    await fixture.client.keys({ address: "t7", keys: ["esc", "enter"] });
    await fixture.client.kill("t7");
    await fixture.client.remove("t7");
    const calls = await fixture.calls();
    assert.equal(calls[0], "send t7 hi --json --wait");
    assert.equal(calls[1], "wait t7 --json");
    assert.equal(calls[2], "keys t7 esc enter --json");
    assert.equal(calls[3], "kill t7 --json");
    assert.equal(calls[4], "rm t7 --json");
  } finally {
    await fixture.cleanup();
  }
});

test("read returns the text out of the JSON answer", async () => {
  const fixture = await bench();
  try {
    assert.equal(await fixture.client.read({ address: "t7", lines: 40 }), "screen\ntext");
    assert.equal((await fixture.calls())[0], "read t7 --lines 40");
  } finally {
    await fixture.cleanup();
  }
});

test("an error answer is the error, whatever the exit code says", async () => {
  const fixture = await bench();
  try {
    await assert.rejects(
      () => fixture.failing.send({ address: "t7", text: "hi" }),
      (error: unknown) =>
        error instanceof HcCommandError &&
        error.code === "blocked" &&
        error.message === "the agent is blocked",
    );
    await assert.rejects(
      () => fixture.withMode("live").remove("t7"),
      (error: unknown) => error instanceof HcCommandError && error.code === "live",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a large answer keeps its newest bytes and a split character still decodes", async () => {
  const fixture = await bench();
  try {
    const text = await fixture.withMode("big").read({ address: "t7" });
    assert.ok(text.endsWith("ACTUAL_SCREEN_END"));
    assert.ok(Buffer.byteLength(text) <= 4 * 1024 * 1024);
    assert.equal(await fixture.withMode("split").read({ address: "t7" }), "你");
  } finally {
    await fixture.cleanup();
  }
});

test("a hung call ends at its deadline, and an abort is not waited out", async () => {
  const fixture = await bench();
  try {
    const hung = fixture.withMode("hang");
    const started = Date.now();
    await assert.rejects(
      () => hung.read({ address: "t7" }, { timeoutMs: 300 }),
      (error: unknown) => error instanceof HcCommandError && error.code === "timeout",
    );
    assert.ok(Date.now() - started < 3_000);
    const controller = new AbortController();
    const pending = hung.read({ address: "t7" }, { signal: controller.signal, timeoutMs: 5_000 });
    controller.abort();
    await assert.rejects(
      () => pending,
      (error: unknown) => error instanceof HcCommandError && error.code === "aborted",
    );
    const queued = new AbortController();
    queued.abort();
    await assert.rejects(
      () => hung.read({ address: "t7" }, { signal: queued.signal }),
      (error: unknown) => error instanceof HcCommandError && error.code === "aborted",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a binary that cannot start says so", async () => {
  const client = createHcClient({ binary: join(tmpdir(), "no-such-hc-binary") });
  await assert.rejects(
    () => client.list({ bots: "b_a" }),
    (error: unknown) => error instanceof HcCommandError && error.code === "spawn_failed",
  );
});
