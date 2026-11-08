// The Herdr tools (docs/bots/RUNTIME.md, "Herdr tools"): a bot starts agents in its own
// herdr-core terminals through a client the tests fake, so this file is about the tools'
// own rules — roles, ownership, targets, and what a refusal says — not about the CLI.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type HcClient,
  HcCommandError,
  type HcTerminal,
  type HcWaitResult,
} from "../../src/tools/hc/client.ts";
import { createHcTools, type HcRoles, hcNamePrefix, hcSection } from "../../src/tools/hc/tools.ts";
import { openWorkspace } from "../../src/tools/workspace.ts";

const BOT = "b_a1b2c3d4";
const PREFIX = hcNamePrefix(BOT);

const roles = () => ({
  provider: "magpie",
  roles: {
    steering: { model: "group/steering", thinkingLevel: "high" as const },
    coding: { model: "group/coding", thinkingLevel: "high" as const },
    reviewing: { model: "group/reviewing", thinkingLevel: "xhigh" as const },
  },
});

type Call = { readonly name: string; readonly args: readonly unknown[] };

const bench = async (options: { readonly roles?: () => HcRoles } = {}) => {
  const root = await mkdtemp(join(tmpdir(), "bots-hc-tools-"));
  const workspace = await openWorkspace(join(root, "workspace"));
  const calls: Call[] = [];
  const terminals: HcTerminal[] = [];
  let next = 0;
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
    };
  const added = (terminal: Partial<HcTerminal>): HcTerminal => {
    next += 1;
    const full: HcTerminal = {
      address: terminal.address ?? `t${next}`,
      name: terminal.name ?? `${PREFIX}-steering`,
      state: terminal.state ?? "live",
      status: terminal.status ?? "idle",
      agent: terminal.agent ?? "pi",
      cwd: terminal.cwd ?? workspace.root,
      labels: terminal.labels ?? { bots: BOT },
      exitCode: terminal.exitCode ?? null,
    };
    terminals.push(full);
    return full;
  };
  let removeError: Error | undefined;
  const client: HcClient = {
    list: async (labels) => {
      record("list")(labels);
      return terminals.filter((terminal) => terminal.labels.bots === labels.bots);
    },
    get: async (address) => {
      record("get")(address);
      return terminals.find((terminal) => terminal.address === address);
    },
    run: async (input) => {
      record("run")(input);
      return added({
        name: input.name,
        cwd: input.cwd,
        labels: input.labels,
        status: "working",
      }).address;
    },
    send: async (input) => {
      record("send")(input);
      return input.wait === false ? undefined : "done";
    },
    wait: async (input): Promise<HcWaitResult> => {
      record("wait")(input);
      return { status: "done", reason: "status", ended: true, exitCode: 0 };
    },
    read: async (input) => {
      record("read")(input);
      return "the answer\n";
    },
    keys: async (input) => {
      record("keys")(input);
    },
    kill: async (address) => {
      record("kill")(address);
    },
    remove: async (address) => {
      record("remove")(address);
      if (removeError !== undefined) throw removeError;
      const index = terminals.findIndex((terminal) => terminal.address === address);
      if (index >= 0) terminals.splice(index, 1);
    },
  };
  const tools = createHcTools({
    client,
    workspace,
    botId: BOT,
    roles: options.roles ?? roles,
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find((entry) => entry.name === name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    const outcome = await tool.execute(
      args,
      {} as never,
      {
        abortSignal: new AbortController().signal,
      } as never,
    );
    const text = (outcome.output as { text: string }[]).map((part) => part.text).join("\n");
    return { text, isError: outcome.isError === true };
  };
  return {
    workspace,
    calls,
    terminals,
    added,
    client,
    tools,
    call,
    setRemoveError: (error: Error) => {
      removeError = error;
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

test("hc_start runs pi with the role's model, provider and thinking level", async () => {
  const fixture = await bench();
  try {
    const started = await fixture.call("hc_start", {
      role: "coding",
      task: "fix the failing test",
    });
    assert.equal(started.isError, false);
    assert.ok(started.text.includes(`started coding as ${PREFIX}-coding`));
    assert.match(started.text, /group\/coding · high/);
    const run = fixture.calls.find((entry) => entry.name === "run")?.args[0] as {
      name: string;
      cwd: string;
      labels: Record<string, string>;
      argv: string[];
    };
    assert.deepEqual(run.argv, [
      "pi",
      "--provider",
      "magpie",
      "--model",
      "group/coding",
      "--thinking",
      "high",
      "fix the failing test",
    ]);
    assert.equal(run.name, `${PREFIX}-coding`);
    assert.deepEqual(run.labels, { bots: BOT });
    assert.equal(run.cwd, fixture.workspace.root);
  } finally {
    await fixture.cleanup();
  }
});

test("hc_start refuses what it cannot launch", async () => {
  const fixture = await bench({
    roles: () => ({
      ...roles(),
      roles: { ...roles().roles, reviewing: { model: "", thinkingLevel: "high" } },
    }),
  });
  try {
    assert.match(
      (await fixture.call("hc_start", { role: "nope", task: "x" })).text,
      /unknown role/,
    );
    assert.match(
      (await fixture.call("hc_start", { role: "coding", task: "   " })).text,
      /a task is required/,
    );
    assert.match(
      (await fixture.call("hc_start", { role: "reviewing", task: "x" })).text,
      /no model for reviewing/,
    );
    assert.match(
      (await fixture.call("hc_start", { role: "coding", task: "x", name: "Bad Name" })).text,
      /the name must match/,
    );
    assert.match(
      (await fixture.call("hc_start", { role: "coding", task: "x", cwd: "../outside" })).text,
      /outside the workspace/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("hc_start reuses a live terminal of the same name instead of spending another model", async () => {
  const fixture = await bench();
  try {
    fixture.added({ name: `${PREFIX}-steering`, status: "working" });
    const started = await fixture.call("hc_start", { role: "steering", task: "do it" });
    assert.match(started.text, /already running \(working\)/);
    assert.equal(
      fixture.calls.some((entry) => entry.name === "run"),
      false,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a terminal another bot or a person started is never listed or touched", async () => {
  const fixture = await bench();
  try {
    const mine = fixture.added({});
    fixture.added({ name: "someone-else" });
    fixture.added({ name: `${PREFIX}-coding`, labels: { bots: "b_other" } });
    const listed = await fixture.call("hc_list");
    assert.equal(listed.text.includes(mine.address), true);
    assert.equal(listed.text.includes("someone-else"), false);

    const refused = await fixture.call("hc_read", { target: "someone-else" });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /no terminal someone-else is yours/);
  } finally {
    await fixture.cleanup();
  }
});

test("the default target is the steering agent; several others are named instead of guessed", async () => {
  const fixture = await bench();
  try {
    const steering = fixture.added({ status: "working" });
    fixture.added({ address: "t9", name: `${PREFIX}-coding` });
    const sent = await fixture.call("hc_send", { text: "status?" });
    assert.equal(sent.isError, false);
    const sends = fixture.calls.filter((entry) => entry.name === "send");
    const last = sends[sends.length - 1];
    assert.ok(last !== undefined);
    assert.equal((last.args[0] as { address: string }).address, steering.address);

    const ambiguous = await bench();
    try {
      ambiguous.added({ name: `${PREFIX}-coding` });
      ambiguous.added({ address: "t9", name: `${PREFIX}-reviewing` });
      const refused = await ambiguous.call("hc_send", { text: "hi" });
      assert.match(refused.text, /name a target/);
      assert.equal((await ambiguous.call("hc_send", { target: "t99", text: "hi" })).isError, true);
    } finally {
      await ambiguous.cleanup();
    }
  } finally {
    await fixture.cleanup();
  }
});

test("send, wait, read and keys report what the client answered", async () => {
  const fixture = await bench();
  try {
    fixture.added({});
    assert.ok(
      (await fixture.call("hc_send", { text: "look" })).text.includes(
        `sent to ${PREFIX}-steering (done)`,
      ),
    );
    assert.match((await fixture.call("hc_wait", { timeoutSeconds: 5 })).text, /done \(ended\)/);
    assert.equal((await fixture.call("hc_read", { lines: 10 })).text, "the answer\n");
    assert.match(
      (await fixture.call("hc_keys", { keys: ["esc", "enter"] })).text,
      /sent esc enter/,
    );
    assert.match((await fixture.call("hc_keys", { keys: ["not a key"] })).text, /not a key name/);
    assert.match((await fixture.call("hc_read", { lines: -1 })).text, /lines must be an integer/);
  } finally {
    await fixture.cleanup();
  }
});

test("hc_close kills and removes one terminal, or everything the bot owns", async () => {
  const fixture = await bench();
  try {
    fixture.added({});
    fixture.added({ address: "t9", name: `${PREFIX}-coding` });
    const closed = await fixture.call("hc_close");
    assert.ok(closed.text.includes(`closed ${PREFIX}-steering, ${PREFIX}-coding`));
    const order = fixture.calls.map((entry) => entry.name);
    assert.deepEqual(order.slice(-4), ["kill", "remove", "kill", "remove"]);
    assert.match((await fixture.call("hc_close")).text, /no terminal is yours to close/);
  } finally {
    await fixture.cleanup();
  }
});

test("a terminal that is still live after kill is retried once, then reported", async () => {
  const fixture = await bench();
  try {
    fixture.added({});
    fixture.setRemoveError(new HcCommandError("live", "t7 is still running"));
    const failed = await fixture.call("hc_close");
    assert.equal(failed.isError, true);
    assert.match(failed.text, /still running/);
    assert.equal(fixture.calls.filter((entry) => entry.name === "remove").length, 2);
  } finally {
    await fixture.cleanup();
  }
});

test("the deferred set and the section name the three roles", () => {
  const fixture = toolsOf();
  assert.deepEqual(fixture.map((tool) => tool.name).sort(), [
    "hc_close",
    "hc_keys",
    "hc_list",
    "hc_read",
    "hc_send",
    "hc_start",
    "hc_wait",
  ]);
  assert.equal(
    fixture.every((tool) => tool.deferred === true),
    true,
  );
  const safe = fixture
    .filter((tool) => tool.replay === "safe")
    .map((tool) => tool.name)
    .sort();
  assert.deepEqual(safe, ["hc_list", "hc_read", "hc_wait"]);
  const section = hcSection(BOT);
  for (const role of ["steering", "coding", "reviewing"]) {
    assert.ok(section.includes(role), `${role} is named`);
  }
  assert.ok(section.includes("tool_search"), "the section says the tools are loaded on demand");
});

const toolsOf = () => {
  const root = join(tmpdir(), "bots-hc-section");
  const tools = createHcTools({
    client: {} as HcClient,
    workspace: { root },
    botId: BOT,
    roles,
  });
  return [...tools];
};
