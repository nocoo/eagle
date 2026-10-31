import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  createModels,
  getCurrentSystemMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { type ConversationId, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BotDirectory, nodeDirectoryFs } from "../../src/core/BotDirectory.ts";
import { BotRegistry } from "../../src/core/BotRegistry.ts";
import { ClassifiedFailure } from "../../src/core/domain.ts";
import { captureLog } from "../../src/log/log.ts";
import { type HistoryBundle, HistoryReplica } from "../../src/runtime/pi/HistoryReplica.ts";
import { ResourcePin } from "../../src/runtime/pi/HistoryResources.ts";
import { readReplicaBinding } from "../../src/runtime/pi/ReplicaStore.ts";
import { pageSchema, type ResourceCarrier } from "../../src/runtime/pi/syncProtocol.ts";
import { createToolRegistry } from "../../src/tools/registry.ts";
import { openWorkspace } from "../../src/tools/workspace.ts";
import { assistant, createBench, text, toolCall, waitFor } from "../support/pi.ts";
import { openReplica, pull } from "../support/replica.ts";

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
    [new URL("./support/replica-child.ts", import.meta.url).pathname],
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
      return output.includes("durable-replica-barrier\n");
    }, "actual owned child commit barrier");
  } finally {
    child.kill("SIGKILL");
    await closed;
  }
  assert.equal(child.signalCode, "SIGKILL");
};

test("SIGKILL after incoming resource-only log commit replays complete refs without a foreign admission", async () => {
  const bench = await createBench();
  const source = await openReplica(join(bench.dir, "fresh-source"));
  let target: Awaited<ReturnType<typeof openReplica>> | undefined;
  try {
    const resources = JSON.parse(
      await readFile(
        new URL("../../../../fixtures/bots-sync/resources.v1.json", import.meta.url),
        "utf8",
      ),
    ) as HistoryBundle["resources"];
    const carrier = (await source.command("export", {
      kind: "resources",
      resources,
    })) as ResourceCarrier;
    const page = await pull(source);
    await killAtCommit({
      dir: join(bench.dir, "fresh-target"),
      mode: "incoming",
      sharedBotId: page.sharedBotId,
      page,
    });
    await source.close();
    target = await openReplica(join(bench.dir, "fresh-target"));
    assert.equal(target.sync.store.stream(page.source).applied, page.range.to);
    assert.deepEqual(
      await target.command("export", { kind: "resources", head: carrier.head }),
      carrier,
    );
    assert.deepEqual((await target.root.entries({}, 128, undefined, ctx)).items, []);
    assert.deepEqual(target.sync.store.pending(), []);
    assert.equal(target.faux.state.callCount, 0);
    target.faux.setResponses([
      (request) => {
        const section =
          getCurrentSystemMessage(request.messages)?.sections?.["bots-resources"] ?? "";
        assert.match(section, /resource-version-one instructions/);
        return text("first real input after resource-only replay");
      },
    ]);
    const local = target;
    await (
      await local.sync.root(
        {
          requestId: "fresh-after-incoming",
          text: "first local input",
          resourceHead: carrier.head,
          whenBusy: "followUp",
          trace: "tr_fresh_crash",
        },
        (entry) =>
          local.root.submit(
            {
              type: "input",
              requestId: "fresh-after-incoming",
              content: "first local input",
              ...(entry === undefined ? {} : { entry }),
            },
            ctx,
          ),
      )
    ).wait(ctx);
    assert.equal(local.faux.state.callCount, 1);
  } finally {
    await source.close();
    await target?.close();
    await bench.cleanup();
  }
});

for (const [mode, fresh] of [
  ["root-resource-intent", false],
  ["root-resource-queued", false],
  ["root-resource-intent", true],
  ["root-resource-queued", true],
] as const) {
  test(`SIGKILL at ${mode} ${fresh ? "fresh resources" : "history resources"} keeps original root IDs/versions and resumes only local work`, async () => {
    const bench = await createBench();
    const source = await openReplica(join(bench.dir, "root-source"));
    const spec = { ...bench.spec(), id: "b_replica" };
    let handle: Awaited<ReturnType<typeof bench.runtime.open>> | undefined;
    try {
      if (!fresh)
        await source.root.commit(async (tx) => {
          await tx.appendEntry(source.root.id, {
            kind: "pi.user",
            model: [{ role: "user", content: "passive source history", timestamp: 0 }],
          });
        }, ctx);
      const resources = JSON.parse(
        await readFile(
          new URL("../../../../fixtures/bots-sync/resources.v1.json", import.meta.url),
          "utf8",
        ),
      ) as HistoryBundle["resources"];
      const one = (await source.command("export", {
        resources,
        ...(fresh ? { kind: "resources" } : {}),
      })) as HistoryBundle | ResourceCarrier;
      const second = resources.map((file) => {
        const bytes =
          file.kind === "instructions" || file.name.endsWith("/input.txt")
            ? Buffer.from(
                Buffer.from(file.base64, "base64").toString("utf8").replaceAll("one", "two"),
              )
            : Buffer.from(file.base64, "base64");
        return {
          ...file,
          base64: bytes.toString("base64"),
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      });
      const two = (await source.command("export", {
        resources: second,
        ...(fresh ? { kind: "resources" } : {}),
      })) as HistoryBundle | ResourceCarrier;
      await source.close();
      await killAtCommit({
        dir: spec.dir,
        mode,
        bundle: one,
        secondBundle: two,
        ...(fresh ? { sharedBotId: source.sync.store.binding.sharedBotId } : {}),
      });
      const secondVersion = createHash("sha256").update(JSON.stringify(second)).digest("hex");
      if (mode === "root-resource-queued") {
        const path = join(spec.dir, "resources", secondVersion, "AGENTS.md");
        await chmod(path, 0o600);
        await writeFile(path, "bad queued version before startup");
        await assert.rejects(bench.runtime.open(spec));
        assert.equal(
          bench.faux.state.callCount,
          0,
          "queued preflight runs before any pending submit/global resume",
        );
        const original = second.find((file) => file.name === "AGENTS.md");
        assert.ok(original);
        await writeFile(path, Buffer.from(original.base64, "base64"));
      }
      const rounds = new Map<string, number>();
      const seen: string[] = [];
      const providerErrors: unknown[] = [];
      const reply = (request: TranscriptContext) => {
        try {
          const user = [...request.messages].reverse().find((message) => message.role === "user");
          const label = String(user?.content);
          assert.ok(label === "root-resource-active" || label === "root-resource-queued");
          const wanted = label === "root-resource-active" ? one : two;
          const version = createHash("sha256")
            .update(JSON.stringify(wanted.resources))
            .digest("hex");
          const section =
            getCurrentSystemMessage(request.messages)?.sections?.["bots-resources"] ?? "";
          assert.match(section, new RegExp(`Resource version: ${version}`));
          const skill = /^Skill directory: (.+)$/m.exec(section)?.[1];
          assert.ok(skill);
          seen.push(label);
          const round = (rounds.get(label) ?? 0) + 1;
          rounds.set(label, round);
          return round === 1
            ? assistant(
                [
                  toolCall("bash", {
                    command: `bash '${skill}/scripts/nested/run.sh' && mv result.bin '${label}.bin'`,
                  }),
                ],
                { stopReason: "toolUse" },
              )
            : text(`${label} done once`);
        } catch (cause) {
          providerErrors.push(
            cause instanceof Error ? { message: cause.message, stack: cause.stack } : cause,
          );
          throw cause;
        }
      };
      bench.faux.setResponses(Array.from({ length: 4 }, () => reply));
      handle = await bench.runtime.open(spec);
      try {
        await waitFor(
          async () =>
            (await handle?.submission({ requestId: "root-resource-queued" }))?.status === "done",
          "the original queued input to recover",
        );
      } catch (cause) {
        console.error(
          JSON.stringify({
            mode,
            seen,
            providerErrors,
            calls: bench.faux.state.callCount,
            active: await handle.submission({ requestId: "root-resource-active" }),
            queued: await handle.submission({ requestId: "root-resource-queued" }),
            records: bench.records.slice(-20),
          }),
        );
        throw cause;
      }
      assert.deepEqual(
        seen,
        mode === "root-resource-queued"
          ? [
              "root-resource-active",
              "root-resource-active",
              "root-resource-queued",
              "root-resource-queued",
            ]
          : ["root-resource-queued", "root-resource-queued"],
      );
      for (const [label, bundle] of [
        ["root-resource-active", one],
        ["root-resource-queued", two],
      ] as const) {
        if (mode === "root-resource-intent" && label === "root-resource-active") continue;
        assert.deepEqual(
          await readFile(join(spec.dir, "workspace", `${label}.bin`)),
          Buffer.concat(
            bundle.resources
              .filter(
                (file) =>
                  file.name.endsWith("/input.txt") || file.name === "skills/fixture/assets/raw.bin",
              )
              .map((file) => Buffer.from(file.base64, "base64")),
          ),
        );
        assert.equal((await handle.submission({ requestId: label }))?.status, "done");
      }
      const before = bench.faux.state.callCount;
      await handle.submit({
        requestId: "root-resource-queued",
        text: "root-resource-queued",
        whenBusy: "followUp",
        trace: "tr_root_crash",
      });
      assert.equal(bench.faux.state.callCount, before);
      const raw = (await handle.replica?.({
        method: "export",
        params: {},
        trace: "tr_root_crash",
      })) as HistoryBundle;
      assert.equal(
        raw.entries.filter(
          (entry) => entry.kind === "bots.user.resources" && entry.model?.[0]?.role === "user",
        ).length,
        mode === "root-resource-queued" ? 2 : 1,
      );
      const passive = await openReplica(join(bench.dir, "foreign-after-root-crash"));
      try {
        let after = 0;
        let page = pageSchema.parse(
          await handle.replica?.({ method: "pull", params: { after }, trace: "tr_root_crash" }),
        );
        await passive.command("bind", { sharedBotId: page.sharedBotId });
        await passive.command("import", { bundle: one });
        await passive.command("import", { bundle: two });
        for (;;) {
          await passive.command("apply", { page });
          after = page.nextAfter;
          if (!page.hasMore) break;
          page = pageSchema.parse(
            await handle.replica?.({ method: "pull", params: { after }, trace: "tr_root_crash" }),
          );
        }
        assert.equal(passive.sync.store.run("root-resource-active"), undefined);
        assert.equal(passive.sync.store.run("root-resource-queued"), undefined);
        assert.equal(
          passive.faux.state.callCount,
          0,
          "foreign root intent/admission facts never resume tools or queued work",
        );
      } finally {
        await passive.close();
      }
    } finally {
      await source.close();
      await handle?.close("tr_root_crash", 5_000);
      await bench.cleanup();
    }
  });
}

test("SIGKILL across local intent/admission/output commits restores original IDs and fills the durable outbox", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-outbox-crash-"));
  try {
    for (const mode of ["intent", "admission", "output"]) {
      const target = join(dir, mode);
      await killAtCommit({ dir: target, mode });
      const replica = await openReplica(target, "b_replica", [
        text("one committed original output"),
      ]);
      try {
        await replica.harness.waitForIdle(ctx);
        const page = await pull(replica);
        const records = page.events.filter((event) => event.body.kind === "entry");
        assert.equal(
          records.filter(
            (event) => event.body.kind === "entry" && event.body.content.kind === "pi.user",
          ).length,
          1,
          mode,
        );
        assert.equal(
          records.filter(
            (event) => event.body.kind === "entry" && event.body.content.kind === "pi.assistant",
          ).length,
          1,
          mode,
        );
        assert.equal(replica.sync.store.run("crash-local")?.admitted, true);
        assert.equal(
          replica.faux.state.callCount,
          mode === "output" ? 0 : 1,
          "committed output is not regenerated",
        );
        const count = replica.faux.state.callCount;
        await replica.sync.root(
          {
            requestId: "crash-local",
            text: "one local input",
            whenBusy: "followUp",
            trace: "tr_sync_crash",
          },
          () =>
            replica.root.submit(
              { type: "input", requestId: "crash-local", content: "one local input" },
              ctx,
            ),
        );
        assert.equal(replica.faux.state.callCount, count);
        assert.equal(
          (await pull(replica, page.nextAfter)).events.filter(
            (event) => event.body.kind === "entry",
          ).length,
          0,
        );
      } finally {
        await replica.close();
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a committed resource branch pin without an SDK submission still fails closed before recovery admission", async () => {
  const bench = await createBench();
  const spec = { ...bench.spec(), id: "b_replica" };
  const source = await openReplica(join(bench.dir, "source"));
  try {
    await source.root.commit(async (tx) => {
      await tx.appendEntry(source.root.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "resource source", timestamp: 0 }],
      });
    }, ctx);
    const resources = JSON.parse(
      await readFile(
        new URL("../../../../fixtures/bots-sync/resources.v1.json", import.meta.url),
        "utf8",
      ),
    ) as HistoryBundle["resources"];
    const bundle = (await source.command("export", { resources })) as HistoryBundle;
    await source.close();
    await killAtCommit({ dir: spec.dir, mode: "resource-pin", bundle });
    const storage = await openNodeSqliteStorage(join(spec.dir, "session.sqlite"));
    const workspace = await openWorkspace(join(spec.dir, "workspace"));
    const registry = createToolRegistry(workspace);
    const harness = await Harness.open(storage, { models: createModels(), registry }, ctx);
    try {
      const root = await harness.root(ctx);
      const history = new HistoryReplica(
        harness,
        root.id,
        spec.id,
        workspace.root,
        registry,
        storage,
        spec.dir,
      );
      const branch = await history.branch("crash-resource-run");
      assert.ok(branch?.conversationId);
      const conversationId = branch.conversationId as ConversationId;
      assert.equal(
        await harness.commit(
          (tx) => tx.submissionByRequest(conversationId, "crash-resource-run"),
          ctx,
        ),
        undefined,
        "the real pin commit precedes SDK admission",
      );
      const pin = await harness.snapshot(ResourcePin, conversationId, ctx);
      assert.ok(pin?.version);
      const agents = join(spec.dir, "resources", pin.version, "AGENTS.md");
      await chmod(agents, 0o600);
      await writeFile(agents, "damaged before any SDK admission");
      await assert.rejects(
        history.runFrom(bundle, {
          head: bundle.head,
          requestId: "crash-resource-run",
          text: "continue the selected package",
        }),
        /installed resource digest mismatch/,
      );
      assert.equal(
        await harness.commit(
          (tx) => tx.submissionByRequest(conversationId, "crash-resource-run"),
          ctx,
        ),
        undefined,
      );
      assert.equal((await harness.inspect(ctx)).scheduling, "paused");
    } finally {
      await harness.close(ctx);
    }
    await assert.rejects(bench.runtime.open(spec), (cause: unknown) => {
      assert.ok(cause instanceof ClassifiedFailure);
      assert.ok(cause.cause instanceof ClassifiedFailure);
      assert.match(cause.cause.message, /installed resource digest mismatch/);
      return true;
    });
    assert.equal(bench.faux.state.callCount, 0);
    await assert.rejects(readFile(join(spec.dir, "workspace/result.bin")), { code: "ENOENT" });
  } finally {
    await source.close();
    await bench.cleanup();
  }
});

test("SIGKILL after incoming log save or SDK passive commit confirms only durable materialization and never executes foreign input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-incoming-crash-"));
  const source = await openReplica(join(dir, "source"));
  try {
    source.faux.setResponses([text("source output")]);
    await (
      await source.sync.root(
        {
          requestId: "source-id",
          text: "foreign input",
          whenBusy: "followUp",
          trace: "tr_sync_crash",
        },
        () =>
          source.root.submit(
            { type: "input", requestId: "source-id", content: "foreign input" },
            ctx,
          ),
      )
    ).wait(ctx);
    await source.harness.waitForIdle(ctx);
    const page = await pull(source);
    const head = page.events.filter((event) => event.body.kind === "head").at(-1)?.body;
    assert.ok(head?.kind === "head");
    const expected = await source.root.context(ctx);
    for (const mode of ["incoming", "materialized"]) {
      const target = join(dir, mode);
      await killAtCommit({ dir: target, mode, sharedBotId: page.sharedBotId, page });
      const replica = await openReplica(target);
      try {
        assert.equal(replica.sync.store.stream(page.source).applied, page.nextAfter);
        assert.equal(replica.sync.store.ready(head.head), true);
        const receipt = await replica.history.receipt(head.head);
        assert.ok(receipt);
        const conversation = await replica.harness.conversation(
          receipt.conversationId as import("@earendil-works/pi-durable").ConversationId,
          ctx,
        );
        assert.ok(conversation);
        assert.deepEqual((await conversation.context(ctx)).messages, expected.messages);
        const before = replica.sync.store.status();
        await replica.command("apply", { page });
        assert.deepEqual(replica.sync.store.status(), before);
        assert.equal(replica.sync.store.pending().length, 0);
        assert.equal(replica.faux.state.callCount, 0);
        assert.equal((await pull(replica)).events.length, 0);
      } finally {
        await replica.close();
      }
    }
  } finally {
    await source.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SIGKILL after complete resource installation before branch pin/admission recovers the same local intent exactly once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-resource-crash-"));
  const source = await openReplica(join(dir, "source"));
  try {
    await source.root.commit(async (tx) => {
      await tx.appendEntry(source.root.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "resource source", timestamp: 0 }],
      });
    }, ctx);
    const resources = JSON.parse(
      await readFile(
        new URL("../../../../fixtures/bots-sync/resources.v1.json", import.meta.url),
        "utf8",
      ),
    ) as HistoryBundle["resources"];
    const bundle = (await source.command("export", { resources })) as HistoryBundle;
    await source.close();
    const target = join(dir, "target");
    await killAtCommit({ dir: target, mode: "resources", bundle });
    assert.equal(
      (await readdir(join(target, "resources"))).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
        .length,
      1,
    );
    const replica = await openReplica(target, "b_replica", [
      (request) => {
        const section =
          getCurrentSystemMessage(request.messages)?.sections?.["bots-resources"] ?? "";
        assert.match(section, /resource-version-one/);
        const path = /^Skill directory: (.+)$/m.exec(section)?.[1];
        assert.ok(path);
        return assistant([toolCall("bash", { command: `bash '${path}/scripts/nested/run.sh'` })], {
          stopReason: "toolUse",
        });
      },
      text("recovered complete selected resource version"),
    ]);
    try {
      await replica.harness.waitForIdle(ctx);
      assert.equal(replica.faux.state.callCount, 2);
      assert.equal(replica.sync.store.run("crash-resource-run")?.admitted, true);
      const branch = (await replica.command("export", {
        branch: "crash-resource-run",
      })) as HistoryBundle;
      assert.equal(
        branch.entries.filter(
          (entry) =>
            entry.kind === "pi.user" &&
            JSON.stringify(entry.model).includes("continue the selected package"),
        ).length,
        1,
      );
      assert.ok(branch.entries.some((entry) => entry.kind === "pi.tool-result"));
      assert.deepEqual(branch.resources, resources);
      assert.deepEqual(
        await readFile(join(replica.workspace, "result.bin")),
        Buffer.concat(
          resources
            .filter(
              (file) =>
                file.name.endsWith("/input.txt") || file.name === "skills/fixture/assets/raw.bin",
            )
            .map((file) => Buffer.from(file.base64, "base64")),
        ),
      );
      await replica.command("run", {
        head: bundle.head,
        requestId: "crash-resource-run",
        text: "continue the selected package",
      });
      assert.equal(
        replica.faux.state.callCount,
        2,
        "retry does not regenerate committed tool work",
      );
    } finally {
      await replica.close();
    }
  } finally {
    await source.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("network ready-only leases never recover durable local pending work, including after repair", async () => {
  const bench = await createBench();
  const source = await openReplica(join(bench.dir, "ready-source"));
  const directory = new BotDirectory(join(bench.dir, "ready-target"), await nodeDirectoryFs());
  const { log } = captureLog();
  let opens = 0;
  const registry = new BotRegistry({
    directory,
    log,
    readReplicaBinding: (spec) => readReplicaBinding(join(spec.dir, "replica.sqlite"), spec.id),
    openRuntime: (spec) => {
      opens++;
      return bench.runtime.open(spec);
    },
    model: { provider: "faux", modelId: "faux-1" },
    idleCloseMs: 40,
    quarantineRetryMs: 60000,
    closeDeadlineMs: 1000,
    bootTrace: () => "tr_ready_boot",
  });
  try {
    await directory.create({
      id: "b_replica",
      title: "ready-only pending",
      model: { provider: "faux", modelId: "faux-1" },
      createdAt: "2026-10-30T00:00:00.000Z",
      updatedAt: "2026-10-30T00:00:00.000Z",
    });
    const resources = JSON.parse(
      await readFile(
        new URL("../../../../fixtures/bots-sync/resources.v1.json", import.meta.url),
        "utf8",
      ),
    );
    const carrier = (await source.command("export", {
      kind: "resources",
      resources,
    })) as ResourceCarrier;
    await killAtCommit({
      dir: directory.botDir("b_replica"),
      mode: "root-resource-intent",
      bundle: carrier,
      secondBundle: carrier,
      sharedBotId: source.sync.store.binding.sharedBotId,
      installBeforeIntent: true,
    });
    const version = createHash("sha256").update(JSON.stringify(resources)).digest("hex");
    const path = join(directory.botDir("b_replica"), "resources", version, "AGENTS.md");
    const original = await readFile(path);
    await chmod(path, 0o600);
    await writeFile(path, "damaged before startup");
    await registry.start();
    assert.equal(registry.state("b_replica"), "unavailable");
    const failedOpens = opens;
    assert.equal(bench.faux.state.callCount, 0);
    await writeFile(path, original);
    for (const get of [
      () => registry.readyReplica("b_replica", "tr_ready_repaired"),
      () => registry.readySharedReplica(source.sync.store.binding.sharedBotId, "tr_ready_peer"),
    ])
      await assert.rejects(get, /ready local Bot/);
    assert.equal(opens, failedOpens, "sync alone does not reopen after disk repair");
    assert.equal(bench.faux.state.callCount, 0);
    const db = new (await import("node:sqlite")).DatabaseSync(
      join(directory.botDir("b_replica"), "replica.sqlite"),
      { readOnly: true },
    );
    try {
      const value = JSON.parse(
        String(
          db.prepare("SELECT value FROM local_runs WHERE request_id='root-resource-queued'").get()
            ?.value,
        ),
      );
      assert.equal(value.admitted, false);
      assert.notEqual(value.rejected, true);
    } finally {
      db.close();
    }
    bench.faux.setResponses([text("explicit local recovery only")]);
    await registry.recover("b_replica", "tr_explicit_local_recover");
    await waitFor(
      () => bench.faux.state.callCount === 1,
      "explicit local recovery resumes original pending ID",
    );
    const ready = await registry.readyReplica("b_replica", "tr_ready_after_recover");
    await ready.command("pull", { after: 0 });
    assert.equal(bench.faux.state.callCount, 1);
    registry.touch("b_replica");
    const fault = new (await import("node:sqlite")).DatabaseSync(
      join(directory.botDir("b_replica"), "replica.sqlite"),
    );
    try {
      fault.exec("ALTER TABLE binding RENAME TO owned_failed_binding");
      await assert.rejects(
        () => ready.check(),
        (error: unknown) =>
          error instanceof ClassifiedFailure && error.failure.kind === "storage_failed",
      );
    } finally {
      fault.exec("ALTER TABLE owned_failed_binding RENAME TO binding");
      fault.close();
      registry.release("b_replica");
    }
    await waitFor(() => registry.state("b_replica") === "catalogued", "real idle close");
    const closedOpens = opens;
    await assert.rejects(() => ready.check(), /ready local Bot/);
    await assert.rejects(
      () => registry.readyReplica("b_replica", "tr_ready_cold"),
      /ready local Bot/,
    );
    assert.equal(opens, closedOpens, "stale and fresh sync leases cannot reopen cold runtime");
    assert.equal(bench.faux.state.callCount, 1);
  } finally {
    await registry.shutdown();
    await source.close();
    await bench.cleanup();
  }
});
