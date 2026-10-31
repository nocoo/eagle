import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { getCurrentSystemMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ClassifiedFailure } from "../../src/core/domain.ts";
import type { RuntimeHandle } from "../../src/core/RuntimePort.ts";
import type { HistoryBundle } from "../../src/runtime/pi/HistoryReplica.ts";
import {
  HistoryResources,
  RESOURCE_EXTENSION,
  ResourcePin,
} from "../../src/runtime/pi/HistoryResources.ts";
import { assistant, createBench, text, toolCall, trace, waitFor } from "../support/pi.ts";
import { openReplica, transfer } from "../support/replica.ts";

const file = (
  name: string,
  kind: HistoryBundle["resources"][number]["kind"],
  content: string | Buffer,
) => {
  const bytes = Buffer.from(content);
  return {
    name,
    kind,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    base64: bytes.toString("base64"),
  };
};
const seed = async (replica: Awaited<ReturnType<typeof openReplica>>) => {
  await replica.root.configure({ instructions: "original agent instructions stay effective" }, ctx);
  await replica.root.commit(async (tx) => {
    await tx.appendEntry(replica.root.id, {
      kind: "pi.user",
      model: [{ role: "user", content: "original full context", timestamp: 0 }],
    });
  }, ctx);
};

test("concurrent same-version installers accept only a fully verified rename winner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-resource-rename-"));
  try {
    const root = join(dir, "resources");
    await mkdir(root);
    const resources = JSON.parse(
      await readFile(
        new URL("../../../../fixtures/bots-sync/resources.v1.json", import.meta.url),
        "utf8",
      ),
    ) as HistoryBundle["resources"];
    const first = new HistoryResources(root, createRegistry());
    const second = new HistoryResources(root, createRegistry());
    const completed = await Promise.allSettled([
      first.install(resources),
      second.install(resources),
    ]);
    const versions = completed.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    assert.equal(versions[0], versions[1]);
    const version = versions[0];
    assert.ok(version);
    for (const resource of resources)
      assert.deepEqual(
        await readFile(join(root, version, resource.name)),
        Buffer.from(resource.base64, "base64"),
      );
    assert.equal((await readdir(root)).filter((name) => /^[a-f0-9]{64}$/.test(name)).length, 1);
    assert.equal((await readdir(root)).filter((name) => name.startsWith(".install-")).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("interleaved fixed-head branches load independent complete versions and preserve pins across reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-resource-versions-"));
  const a = await openReplica(join(dir, "a"));
  let b = await openReplica(join(dir, "b"));
  const release = Promise.withResolvers<void>();
  let entered = false;
  try {
    await seed(a);
    const original = JSON.parse(
      await readFile(
        new URL("../../../../fixtures/bots-sync/resources.v1.json", import.meta.url),
        "utf8",
      ),
    ) as HistoryBundle["resources"];
    const second = original.map((item) => {
      const bytes = Buffer.from(item.base64, "base64");
      return item.name === "AGENTS.md"
        ? file(item.name, item.kind, "resource-version-two instructions")
        : item.name.endsWith("/input.txt")
          ? file(item.name, item.kind, "nested reference two\n")
          : item.name.endsWith("/run.sh")
            ? file(
                item.name,
                item.kind,
                bytes.toString().replaceAll("result.bin", "result-two.bin"),
              )
            : item;
    });
    const h1 = (await a.command("export", { resources: original })) as HistoryBundle;
    const h2 = (await a.command("export", { resources: second })) as HistoryBundle;
    assert.notEqual(h1.head, h2.head);
    await b.command("bind", { sharedBotId: a.sync.store.binding.sharedBotId });
    await transfer(a, b);
    assert.equal(b.faux.state.callCount, 0);
    const seen: {
      input: string;
      version: string;
      path: string;
      messages: TranscriptContext["messages"];
    }[] = [];
    const expectedVersions = new Map([
      ["pause first version", "one"],
      ["use second version independently", "two"],
      ["still first version", "one"],
    ]);
    const pinnedPaths = new Map<string, string>();
    const respond = async (request: TranscriptContext) => {
      const system = getCurrentSystemMessage(request.messages);
      assert.equal(
        system?.sections?.instructions,
        "<instructions>\noriginal agent instructions stay effective\n</instructions>",
      );
      const content = system?.sections?.[RESOURCE_EXTENSION] ?? "";
      const path = /^Skill directory: (.+)$/m.exec(content)?.[1];
      assert.ok(path);
      const user = request.messages.findLast((message) => message.role === "user");
      assert.ok(user?.role === "user" && typeof user.content === "string");
      const input = user.content;
      const version = expectedVersions.get(input);
      assert.ok(version, "the independent local user request identifies its expected version");
      assert.match(content, new RegExp(`resource-version-${version} instructions`));
      const pinned = pinnedPaths.get(version);
      if (pinned === undefined) pinnedPaths.set(version, path);
      else
        assert.equal(
          path,
          pinned,
          "every request, including after tools, retains its selected version path",
        );
      seen.push({ input, version, path, messages: structuredClone(request.messages) });
      if (request.messages.at(-1)?.role === "toolResult") return text(`completed ${version}`);
      if (version === "one" && !entered) {
        entered = true;
        await release.promise;
      }
      return assistant([toolCall("bash", { command: `bash '${path}/scripts/nested/run.sh'` })], {
        stopReason: "toolUse",
      });
    };
    b.faux.setResponses(Array.from({ length: 8 }, () => respond));
    await b.command("run", {
      head: h1.head,
      requestId: "version-one-run",
      text: "pause first version",
    });
    await waitFor(() => entered, "the first-version provider barrier");
    await b.command("run", {
      head: h2.head,
      requestId: "version-two-run",
      text: "use second version independently",
    });
    await waitFor(
      async () =>
        (
          (await b.command("status", { requestId: "version-two-run" })) as {
            submission?: { status: string };
          }
        ).submission?.status === "done",
      "the second version to finish while first is paused",
    );
    release.resolve();
    await b.harness.waitForIdle(ctx);
    assert.equal(
      (
        (await b.command("status", { requestId: "version-one-run" })) as {
          submission?: { status: string };
        }
      ).submission?.status,
      "done",
    );
    for (const input of ["pause first version", "use second version independently"])
      assert.ok(
        seen.filter((item) => item.input === input).length >= 2,
        "both runs have initial and post-tool provider evidence",
      );
    for (const [requestId, expected] of [
      ["version-one-run", original],
      ["version-two-run", second],
    ] as const) {
      const branch = await b.history.branch(requestId);
      assert.ok(branch);
      const pin = await b.harness.snapshot(
        ResourcePin,
        branch.conversationId as import("@earendil-works/pi-durable").ConversationId,
        ctx,
      );
      assert.deepEqual(
        Object.keys(pin ?? {}),
        ["version"],
        "branch docs contain no package bodies",
      );
      const bundle = (await b.command("export", { branch: requestId })) as HistoryBundle;
      assert.deepEqual(bundle.resources, expected);
      assert.ok(bundle.entries.some((entry) => entry.kind === "pi.tool-result"));
    }
    const first = seen.filter((item) => item.version === "one");
    const latest = seen.filter((item) => item.version === "two");
    assert.equal(new Set(first.map((item) => item.path)).size, 1);
    assert.equal(new Set(latest.map((item) => item.path)).size, 1);
    assert.notEqual(first[0]?.path, latest[0]?.path);
    assert.deepEqual(
      await readFile(join(b.workspace, "result.bin")),
      Buffer.concat(
        original
          .filter(
            (item) =>
              item.name.endsWith("/input.txt") || item.name === "skills/fixture/assets/raw.bin",
          )
          .map((item) => Buffer.from(item.base64, "base64")),
      ),
    );
    assert.deepEqual(
      await readFile(join(b.workspace, "result-two.bin")),
      Buffer.concat(
        second
          .filter(
            (item) =>
              item.name.endsWith("/input.txt") || item.name === "skills/fixture/assets/raw.bin",
          )
          .map((item) => Buffer.from(item.base64, "base64")),
      ),
    );
    const before = await b.command("export", { head: h1.head });
    await b.close();
    b = await openReplica(join(dir, "b"));
    assert.equal(b.faux.state.callCount, 0);
    assert.deepEqual(await b.command("export", { head: h1.head }), before);
    b.faux.setResponses([respond, respond]);
    await b.command("run", {
      head: h1.head,
      requestId: "version-reopen-run",
      text: "still first version",
    });
    await b.harness.waitForIdle(ctx);
    assert.equal(seen.at(-1)?.path, first[0]?.path);
    assert.equal(
      (await readdir(join(dir, "b/resources"))).filter((name) => /^[a-f0-9]{64}$/.test(name))
        .length,
      2,
      "same files are installed once per version, not per head/run",
    );
  } finally {
    release.resolve();
    await Promise.allSettled([a.close(), b.close()]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("unsafe, conflicting, incomplete and invalid-text manifests remain retainable but admit zero execution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-resource-reject-"));
  const replica = await openReplica(dir);
  try {
    await seed(replica);
    const cases = [
      [file("../outside", "attachment", "escape")],
      [file("/absolute", "attachment", "escape")],
      [file("bad\\path", "attachment", "escape")],
      [file("same", "attachment", "one"), file("same", "attachment", "two")],
      [file("prefix", "attachment", "one"), file("prefix/nested", "attachment", "two")],
      [file("skills/incomplete/script.sh", "skill", "echo missing descriptor")],
      [file("AGENTS.md", "instructions", Buffer.from([255]))],
      [file("skills/invalid/SKILL.md", "skill", Buffer.from([255]))],
    ];
    for (const [index, resources] of cases.entries()) {
      const bundle = (await replica.command("export", { resources })) as HistoryBundle;
      await assert.rejects(
        replica.command("run", {
          head: bundle.head,
          requestId: `invalid-resource-${index}`,
          text: "must reject",
        }),
        /resource|skill|UTF-8/,
      );
      assert.deepEqual(
        await replica.command("export", { head: bundle.head }),
        bundle,
        "original invalid-for-execution carrier stays preserved",
      );
      assert.equal(replica.faux.state.callCount, 0);
      assert.equal(replica.sync.store.pending().length, 0);
      assert.deepEqual((await replica.harness.inspect(ctx)).tasks, []);
    }
    await assert.rejects(readFile(join(dir, "outside")), { code: "ENOENT" });
    const resourceRoot = join(dir, "resources");
    const outside = join(dir, "outside-directory");
    await mkdir(outside);
    await symlink(outside, resourceRoot);
    const bundle = (await replica.command("export", {
      resources: [file("AGENTS.md", "instructions", "safe")],
    })) as HistoryBundle;
    await assert.rejects(
      replica.command("run", {
        head: bundle.head,
        requestId: "symlink-resource",
        text: "no escape",
      }),
      /unsafe resource directory/,
    );
    assert.deepEqual(await readdir(outside), []);
    assert.equal(replica.faux.state.callCount, 0);
    await rm(resourceRoot);
    await mkdir(resourceRoot, { mode: 0o700 });
    await chmod(resourceRoot, 0);
    try {
      await assert.rejects(
        replica.command("run", {
          head: bundle.head,
          requestId: "io-resource-fail",
          text: "no admission on I/O",
        }),
        (cause: unknown) => {
          assert.ok(cause instanceof ClassifiedFailure);
          assert.equal(cause.failure.kind, "storage_failed");
          assert.equal(cause.disposition, "not_admitted");
          assert.equal((cause.cause as NodeJS.ErrnoException).code, "EACCES");
          return true;
        },
      );
    } finally {
      await chmod(resourceRoot, 0o700);
    }
    assert.equal(replica.faux.state.callCount, 0);
    assert.deepEqual((await replica.harness.inspect(ctx)).tasks, []);
  } finally {
    await replica.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("partial packages and an installed symlink are never consumed as a ready version", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-resource-partial-"));
  const replica = await openReplica(dir);
  try {
    await seed(replica);
    const resources = [
      file("AGENTS.md", "instructions", "complete selected instructions"),
      file("attachment.txt", "attachment", "complete selected attachment"),
    ];
    const bundle = (await replica.command("export", { resources })) as HistoryBundle;
    const version = createHash("sha256").update(JSON.stringify(resources)).digest("hex");
    const path = join(dir, "resources", version);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "AGENTS.md"), "complete selected instructions");
    await assert.rejects(
      replica.command("run", {
        head: bundle.head,
        requestId: "partial-package-run",
        text: "cannot run a half package",
      }),
      /incomplete installed resource/,
    );
    assert.equal(replica.faux.state.callCount, 0);
    assert.equal(replica.sync.store.pending().length, 0);
    await assert.rejects(readFile(join(dir, "resources", `${version}.json`)), { code: "ENOENT" });
    await rm(path, { recursive: true });
    replica.faux.setResponses([text("complete selected package")]);
    await replica.command("run", {
      head: bundle.head,
      requestId: "complete-package-run",
      text: "complete only",
    });
    await replica.harness.waitForIdle(ctx);
    const before = replica.faux.state.callCount;
    const outside = join(dir, "outside-secret.txt");
    await writeFile(outside, "never follow outside text");
    await rm(join(path, "attachment.txt"));
    await symlink(outside, join(path, "attachment.txt"));
    await assert.rejects(
      replica.command("run", {
        head: bundle.head,
        requestId: "installed-symlink-run",
        text: "cannot follow it",
      }),
      /unsafe installed resource symlink/,
    );
    assert.equal(replica.faux.state.callCount, before);
    assert.equal(replica.sync.store.pending().length, 0);
    assert.equal(await readFile(outside, "utf8"), "never follow outside text");
    assert.deepEqual(await replica.command("export", { head: bundle.head }), bundle);
  } finally {
    await replica.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("known installation I/O failure rejects its durable intent and cannot execute after disk repair", async (t) => {
  const bench = await createBench();
  let handle: RuntimeHandle | undefined;
  const spec = bench.spec();
  const root = join(spec.dir, "resources");
  try {
    handle = await bench.runtime.open(spec);
    bench.faux.setResponses([text("source")]);
    await handle.submit({
      requestId: "install-io-seed",
      text: "source",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      async () => (await handle?.submission({ requestId: "install-io-seed" }))?.status === "done",
      "the source before I/O refusal",
    );
    assert.ok(handle.replica);
    const bundle = (await handle.replica({
      method: "export",
      params: { resources: [file("AGENTS.md", "instructions", "known install I/O version")] },
      trace,
    })) as HistoryBundle;
    await mkdir(root, { mode: 0o700 });
    await chmod(root, 0);
    let failure: ClassifiedFailure | undefined;
    try {
      await handle.replica({
        method: "run",
        params: { head: bundle.head, requestId: "install-io-reject", text: "must not be admitted" },
        trace,
      });
    } catch (cause) {
      assert.ok(cause instanceof ClassifiedFailure);
      failure = cause;
    } finally {
      await chmod(root, 0o700);
    }
    assert.ok(failure);
    assert.equal(failure.failure.kind, "storage_failed");
    assert.equal((failure.cause as NodeJS.ErrnoException).code, "EACCES");
    const db = new DatabaseSync(join(spec.dir, "replica.sqlite"), { readOnly: true });
    const row = db
      .prepare("SELECT value FROM local_runs WHERE request_id=?")
      .get("install-io-reject");
    db.close();
    const record = JSON.parse(String(row?.value)) as { admitted: boolean; rejected?: boolean };
    await t.test("the known preflight failure is not admitted", () =>
      assert.equal(failure.disposition, "not_admitted"),
    );
    await t.test("the intent is durably rejected", () =>
      assert.deepEqual(
        { admitted: record.admitted, rejected: record.rejected },
        { admitted: false, rejected: true },
      ),
    );
    assert.equal(bench.records.filter((record) => record.level === "error").length, 1);
    assert.equal(
      bench.records.find((record) => record.level === "error")?.err?.failure,
      failure.failure.id,
    );
    await handle.close(trace, 500);
    const before = bench.faux.state.callCount;
    bench.faux.setResponses([
      assistant(
        [toolCall("write", { path: "wrong-auto-run.txt", content: "must never execute" })],
        { stopReason: "toolUse" },
      ),
      text("unexpected replay"),
    ]);
    handle = await bench.runtime.open(spec);
    await waitFor(
      async () => !(await handle?.busy())?.tasks,
      "reopen to reach its real scheduler boundary",
    );
    await t.test("repair and reopen executes neither provider nor tool", async () => {
      assert.equal(bench.faux.state.callCount, before);
      await assert.rejects(readFile(join(spec.dir, "workspace/wrong-auto-run.txt")), {
        code: "ENOENT",
      });
    });
  } finally {
    await chmod(root, 0o700).catch(() => undefined);
    await handle?.close(trace, 500);
    await bench.cleanup();
  }
});

test("bad pinned install fails before any pending root resume and closes the opened SDK storage owner", async (t) => {
  let opened = 0;
  let closed = 0;
  const bench = await createBench({
    storage: async (path) => {
      const storage = await openNodeSqliteStorage(path);
      opened += 1;
      return new Proxy(storage, {
        get(target, property) {
          if (property === "close")
            return async (...args: Parameters<typeof storage.close>) => {
              closed += 1;
              await storage.close(...args);
            };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  });
  let handle: RuntimeHandle | undefined;
  const spec = bench.spec();
  try {
    handle = await bench.runtime.open(spec);
    bench.faux.setResponses([text("original")]);
    await handle.submit({
      requestId: "pin-owner-seed",
      text: "original",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      async () => (await handle?.submission({ requestId: "pin-owner-seed" }))?.status === "done",
      "original owner seed",
    );
    const resources = [file("AGENTS.md", "instructions", "pinned original bytes")];
    assert.ok(handle.replica);
    const bundle = (await handle.replica({
      method: "export",
      params: { resources },
      trace,
    })) as HistoryBundle;
    bench.faux.setResponses([text("completed pinned branch")]);
    await handle.replica({
      method: "run",
      params: { head: bundle.head, requestId: "pin-owner-run", text: "pin the version" },
      trace,
    });
    await waitFor(async () => !(await handle?.busy())?.tasks, "the pinned run to settle");
    await handle.close(trace, 500);
    handle = undefined;
    const path = join(
      spec.dir,
      "resources",
      createHash("sha256").update(JSON.stringify(resources)).digest("hex"),
      "AGENTS.md",
    );
    await chmod(path, 0o600);
    await writeFile(path, "damaged original bytes");
    const database = new DatabaseSync(join(spec.dir, "replica.sqlite"));
    database.prepare("INSERT INTO local_runs VALUES(?,?)").run(
      "pending-root-before-guard",
      JSON.stringify({
        intent: {
          kind: "run",
          mode: "root",
          requestId: "pending-root-before-guard",
          head: null,
          text: "must not wake scheduler",
        },
        admitted: false,
      }),
    );
    database.close();
    const before = bench.faux.state.callCount;
    await assert.rejects(bench.runtime.open(spec));
    await t.test("the failed open closes its real storage owner", () =>
      assert.equal(closed, opened),
    );
    assert.equal(
      bench.faux.state.callCount,
      before,
      "no pending submit may resume before every pin passes",
    );
    await writeFile(path, "pinned original bytes");
    bench.faux.setResponses([text("the deliberately local pending root may now recover")]);
    handle = await bench.runtime.open(spec);
    await waitFor(
      async () => !(await handle?.busy())?.tasks,
      "the repaired instance to reopen normally",
    );
    await handle.close(trace, 500);
    handle = undefined;
    await t.test("the repaired reopen leaves no owner behind", () => assert.equal(closed, opened));
  } finally {
    await handle?.close(trace, 500);
    await bench.cleanup();
  }
});

for (const scenario of [
  { state: "done", damage: "bytes", lostReceipt: false },
  { state: "done", damage: "EACCES", lostReceipt: false },
  { state: "active", damage: "bytes", lostReceipt: false },
  { state: "active", damage: "EACCES", lostReceipt: false },
  { state: "done", damage: "bytes", lostReceipt: true },
] as const) {
  test(`admitted resource retry: ${scenario.state}, ${scenario.damage}, lost receipt=${scenario.lostReceipt}`, async (t) => {
    let taskWrites = 0;
    let submissionWrites = 0;
    const bench = await createBench({
      storage: async (path) => {
        const storage = await openNodeSqliteStorage(path);
        return new Proxy(storage, {
          get(target, property) {
            if (property === "commit")
              return async (...args: Parameters<typeof storage.commit>) => {
                const seq = await storage.commit(...args);
                taskWrites += args[0].filter((write) => write.type === "task").length;
                submissionWrites += args[0].filter((write) => write.type === "submission").length;
                return seq;
              };
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    });
    const spec = bench.spec();
    const release = Promise.withResolvers<void>();
    let entered = false;
    let handle: RuntimeHandle | undefined;
    const resourceRoot = join(spec.dir, "resources");
    try {
      handle = await bench.runtime.open(spec);
      assert.ok(handle.replica);
      const replica = handle.replica.bind(handle);
      const call = (method: Parameters<typeof replica>[0]["method"], params: unknown) =>
        replica({ method, params, trace });
      bench.faux.setResponses([text("source for retry")]);
      await handle.submit({
        requestId: "retry-source-seed",
        text: "source for retry",
        whenBusy: "followUp",
        trace,
      });
      await waitFor(async () => !(await handle?.busy())?.tasks, "the retry source to settle");
      const resources = JSON.parse(
        await readFile(
          new URL("../../../../fixtures/bots-sync/resources.v1.json", import.meta.url),
          "utf8",
        ),
      ) as HistoryBundle["resources"];
      const bundle = (await call("export", { resources })) as HistoryBundle;
      const other = (await call("export", { resources: [] })) as HistoryBundle;
      const input = { head: bundle.head, requestId: "resource-retry-run", text: "run once" };
      const db = new DatabaseSync(join(spec.dir, "replica.sqlite"));
      const ledger = (requestId = input.requestId) => {
        const row = db.prepare("SELECT value FROM local_runs WHERE request_id=?").get(requestId);
        return JSON.parse(String(row?.value)) as { admitted: boolean; rejected?: boolean };
      };
      try {
        if (scenario.lostReceipt)
          db.exec(`CREATE TRIGGER lose_admitted_receipt BEFORE UPDATE ON local_runs
            WHEN OLD.request_id='resource-retry-run' AND json_extract(NEW.value,'$.admitted')=1
            BEGIN SELECT RAISE(FAIL,'owned replica receipt write failure'); END`);
        bench.faux.setResponses([
          (request) => {
            const section =
              getCurrentSystemMessage(request.messages)?.sections?.[RESOURCE_EXTENSION] ?? "";
            const skill = /^Skill directory: (.+)$/m.exec(section)?.[1];
            assert.ok(skill);
            return assistant(
              [toolCall("bash", { command: `bash '${skill}/scripts/nested/run.sh'` })],
              { stopReason: "toolUse" },
            );
          },
          async () => {
            entered = true;
            if (scenario.state === "active") await release.promise;
            return text("one original resource result");
          },
        ]);
        if (scenario.lostReceipt) {
          await assert.rejects(call("run", input), (cause: unknown) => {
            assert.ok(cause instanceof ClassifiedFailure);
            assert.equal(cause.failure.kind, "storage_failed");
            assert.equal(cause.disposition, "unknown");
            assert.match(String(cause.cause), /owned replica receipt write failure/);
            return true;
          });
          db.exec("DROP TRIGGER lose_admitted_receipt");
          assert.equal(
            ledger().admitted,
            false,
            "actual SDK admission precedes the failed replica receipt",
          );
        } else await call("run", input);
        await waitFor(() => entered, "real package tool output and the post-tool provider");
        if (scenario.state === "done")
          await waitFor(
            async () => !(await handle?.busy())?.tasks,
            "the admitted branch to settle",
          );
        const expected = await call("status", { requestId: input.requestId });
        assert.ok(
          (expected as { submission?: unknown }).submission,
          "the SDK has a real admission",
        );
        const output = join(spec.dir, "workspace/result.bin");
        const expectedBytes = Buffer.concat(
          resources
            .filter(
              (file) =>
                file.name.endsWith("/input.txt") || file.name === "skills/fixture/assets/raw.bin",
            )
            .map((file) => Buffer.from(file.base64, "base64")),
        );
        assert.deepEqual(await readFile(output), expectedBytes);
        if (scenario.damage === "EACCES") await chmod(resourceRoot, 0);
        else {
          const agents = join(
            resourceRoot,
            createHash("sha256").update(JSON.stringify(resources)).digest("hex"),
            "AGENTS.md",
          );
          await chmod(agents, 0o600);
          await writeFile(agents, "damaged after actual admission");
        }
        const before = {
          provider: bench.faux.state.callCount,
          taskWrites,
          submissionWrites,
          errors: bench.records.filter((record) => record.level === "error").length,
        };
        const retried = await Promise.allSettled([call("run", input)]);
        await t.test("same ID returns the actual existing SDK branch/status", () =>
          assert.deepEqual(retried, [{ status: "fulfilled", value: expected }]),
        );
        await t.test("durable admission is not reclassified as rejected", () =>
          assert.deepEqual(
            { admitted: ledger().admitted, rejected: ledger().rejected ?? false },
            { admitted: true, rejected: false },
          ),
        );
        await t.test(
          "retry produces no model/tool/task/submission work or error origin",
          async () => {
            assert.deepEqual(
              {
                provider: bench.faux.state.callCount,
                taskWrites,
                submissionWrites,
                errors: bench.records.filter((record) => record.level === "error").length,
              },
              before,
            );
            assert.deepEqual(await readFile(output), expectedBytes);
          },
        );
        await assert.rejects(call("run", { ...input, text: "conflicting text" }), /conflict/);
        await assert.rejects(call("run", { ...input, head: other.head }), /conflict/);
        await assert.rejects(call("run", { ...input, requestId: "resource-new-bad" }));
        assert.deepEqual(
          {
            admitted: ledger("resource-new-bad").admitted,
            rejected: ledger("resource-new-bad").rejected,
          },
          { admitted: false, rejected: true },
        );
        assert.equal(bench.faux.state.callCount, before.provider);
      } finally {
        db.close();
      }
    } finally {
      await chmod(resourceRoot, 0o700).catch(() => undefined);
      release.resolve();
      await handle?.close(trace, 500);
      await bench.cleanup();
    }
  });
}
