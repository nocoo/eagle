import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { getCurrentSystemMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { ClassifiedFailure } from "../../src/core/domain.ts";
import type { HistoryBundle } from "../../src/runtime/pi/HistoryReplica.ts";
import { assistant, createBench, text, toolCall, trace, waitFor } from "../support/pi.ts";
import { type Stack, startStack } from "../support/server.ts";

const post = (stack: Stack, bot: string, method: string, params: unknown) =>
  fetch(`http://127.0.0.1:${stack.port}/v1/bots/${bot}/replica/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${stack.token}`, "content-type": "application/json" },
    body: JSON.stringify(params),
  });

test("selected complete resources load on independent local runs, including source-offline native package tools", async () => {
  const a = await startStack({ real: true });
  const b = await startStack({ real: true });
  try {
    const source = await a.createBot("resource source");
    const target = await b.createBot("resource target");
    const resources = JSON.parse(
      await readFile(
        new URL("../../../../fixtures/bots-sync/resources.v1.json", import.meta.url),
        "utf8",
      ),
    ) as HistoryBundle["resources"];
    const sourceWorkspace = join(a.directory.botDir(source), "workspace");
    for (const resource of resources) {
      const path = join(sourceWorkspace, resource.name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(resource.base64, "base64"));
      assert.deepEqual(
        await readFile(path),
        Buffer.from(resource.base64, "base64"),
        "source original file bytes precede export",
      );
    }
    const original = await a.registry.open(source, trace);
    a.faux?.setResponses([text("source original context")]);
    await original.submit({
      requestId: "resource-seed",
      text: "preserve the original context",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      async () => (await original.submission({ requestId: "resource-seed" }))?.status === "done",
      "original source settlement",
    );
    const selected = (await (
      await post(a, source, "export", { resources })
    ).json()) as HistoryBundle;
    assert.deepEqual(selected.resources, resources);
    assert.equal((await post(b, target, "import", { bundle: selected })).status, 200);
    assert.equal(b.faux?.state.callCount, 0, "passive resources never invoke a provider");
    const passive = await b.registry.open(target, trace);
    assert.deepEqual(await passive.busy(), { run: false, tasks: false });
    assert.equal(await passive.submission({ requestId: "resource-seed" }), undefined);
    await assert.rejects(readFile(join(b.directory.botDir(target), "workspace/result.bin")), {
      code: "ENOENT",
    });
    const requests: TranscriptContext[] = [];
    const packagePaths: string[] = [];
    const run = async (stack: Stack, bot: string, requestId: string) => {
      stack.faux?.setResponses([
        (request) => {
          requests.push(request);
          const section =
            getCurrentSystemMessage(request.messages)?.sections?.["bots-resources"] ?? "";
          assert.match(section, /Keep resource-version-one instructions/);
          assert.match(section, /scripts\/nested\/run.sh/);
          const skill = /^Skill directory: (.+)$/m.exec(section)?.[1];
          const root = /^Resource directory: (.+)$/m.exec(section)?.[1];
          assert.ok(skill && root, "the production section supplies this runtime's actual paths");
          packagePaths.push(skill);
          return assistant(
            [
              toolCall("read", { path: `${skill}/references/nested/input.txt` }),
              toolCall("read", { path: `${root}/attachments/raw.bin` }),
              toolCall("bash", { command: `bash '${skill}/scripts/nested/run.sh'` }),
            ],
            { stopReason: "toolUse" },
          );
        },
        text("selected native tools completed"),
      ]);
      const response = await post(stack, bot, "run", {
        head: selected.head,
        requestId,
        text: "use the selected complete package",
      });
      assert.equal(response.status, 200, await response.clone().text());
      await waitFor(async () => {
        const status = (await (await post(stack, bot, "status", { requestId })).json()) as {
          submission?: { status: string };
        };
        return status.submission?.status === "done";
      }, "resource tool run settlement");
      const expected = Buffer.concat(
        resources
          .filter((file) =>
            [
              "skills/fixture/references/nested/input.txt",
              "skills/fixture/assets/raw.bin",
            ].includes(file.name),
          )
          .map((file) => Buffer.from(file.base64, "base64")),
      );
      assert.deepEqual(
        await readFile(join(stack.directory.botDir(bot), "workspace/result.bin")),
        expected,
      );
      const branch = (await (
        await post(stack, bot, "export", { branch: requestId })
      ).json()) as HistoryBundle;
      assert.deepEqual(branch.resources, resources);
      assert.ok(branch.entries.some((entry) => entry.kind === "pi.tool-result"));
      assert.ok(!JSON.stringify(branch.entries).includes('"isError":true'));
      for (const file of resources) {
        const root = /^Resource directory: (.+)$/m.exec(
          getCurrentSystemMessage(requests.at(-1)?.messages ?? [])?.sections?.["bots-resources"] ??
            "",
        )?.[1];
        assert.ok(root);
        assert.deepEqual(await readFile(join(root, file.name)), Buffer.from(file.base64, "base64"));
      }
    };
    await run(b, target, "resource-first-B");
    await run(a, source, "resource-source-A");
    await a.close();
    await run(b, target, "resource-offline-B");
    assert.notEqual(
      packagePaths[0],
      packagePaths[1],
      "each runtime binds its own package directory",
    );
    assert.equal(packagePaths[0], packagePaths[2], "same version is reused across local branches");
  } finally {
    await Promise.allSettled([a.close(), b.close()]);
  }
});

for (const damage of ["bytes", "manifest", "EACCES"] as const) {
  test(`warm HTTP task retry attributes resource ${damage} preflight failure once`, async (t) => {
    const bench = await createBench();
    const observed: { trace: string; cause: unknown }[] = [];
    const stack = await startStack({
      real: true,
      model: bench.spec().model,
      runtime: {
        readReplicaBinding: (spec) => bench.runtime.readReplicaBinding(spec),
        open: async (spec) => {
          const handle = await bench.runtime.open(spec);
          return new Proxy(handle, {
            get(target, property) {
              if (property === "retryTask")
                return async (taskId: string, commandTrace: string) => {
                  try {
                    // Observe the real boundary error; never replace the production retry.
                    await target.retryTask?.(taskId, commandTrace);
                  } catch (cause) {
                    observed.push({ trace: commandTrace, cause });
                    throw cause;
                  }
                };
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      },
    });
    let resourceRoot: string | undefined;
    try {
      const botId = await stack.createBot("warm resource retry");
      const handle = await stack.registry.open(botId, trace);
      bench.faux.setResponses([text("source for task retry")]);
      await handle.submit({
        requestId: "task-resource-seed",
        text: "source",
        whenBusy: "followUp",
        trace,
      });
      await waitFor(async () => !(await handle.busy()).tasks, "the warm source to settle");
      const resources = JSON.parse(
        await readFile(
          new URL("../../../../fixtures/bots-sync/resources.v1.json", import.meta.url),
          "utf8",
        ),
      ) as HistoryBundle["resources"];
      const bundle = (await (
        await post(stack, botId, "export", { resources })
      ).json()) as HistoryBundle;
      bench.faux.setResponses([
        (request) => {
          const section =
            getCurrentSystemMessage(request.messages)?.sections?.["bots-resources"] ?? "";
          const skill = /^Skill directory: (.+)$/m.exec(section)?.[1];
          assert.ok(skill);
          return assistant(
            [toolCall("bash", { command: `bash '${skill}/scripts/nested/run.sh'` })],
            { stopReason: "toolUse" },
          );
        },
        text("actual task finished"),
      ]);
      assert.equal(
        (
          await post(stack, botId, "run", {
            head: bundle.head,
            requestId: "task-resource-run",
            text: "use the actual selected script",
          })
        ).status,
        200,
      );
      await waitFor(async () => !(await handle.busy()).tasks, "the actual resource task to settle");
      const branch = (await (
        await post(stack, botId, "export", { branch: "task-resource-run" })
      ).json()) as HistoryBundle;
      const taskId = branch.entries.find((entry) => entry.kind === "pi.tool-result")?.byTaskId;
      assert.ok(taskId, "a real committed tool task precedes the HTTP retry");
      const result = join(stack.directory.botDir(botId), "workspace/result.bin");
      const output = await readFile(result);
      assert.deepEqual(
        output,
        Buffer.concat(
          resources
            .filter(
              (file) =>
                file.name.endsWith("/input.txt") || file.name === "skills/fixture/assets/raw.bin",
            )
            .map((file) => Buffer.from(file.base64, "base64")),
        ),
      );
      resourceRoot = join(stack.directory.botDir(botId), "resources");
      const version = createHash("sha256").update(JSON.stringify(resources)).digest("hex");
      if (damage === "EACCES") await chmod(resourceRoot, 0);
      else {
        const path =
          damage === "manifest"
            ? join(resourceRoot, `${version}.json`)
            : join(resourceRoot, version, "AGENTS.md");
        await chmod(path, 0o600);
        await writeFile(path, "private damaged manifest/body must never appear in logs");
      }
      const before = {
        opens: stack.opens(),
        provider: bench.faux.state.callCount,
        records: bench.records.length,
      };
      const response = await fetch(
        `http://127.0.0.1:${stack.port}/v1/bots/${botId}/tasks/t_${taskId}/retry`,
        { method: "POST", headers: { authorization: `Bearer ${stack.token}` } },
      );
      assert.equal(response.status, damage === "EACCES" ? 500 : 400);
      assert.equal(observed.length, 1, "the warm HTTP request reached the real retry preflight");
      assert.deepEqual(
        { opens: stack.opens(), provider: bench.faux.state.callCount },
        { opens: before.opens, provider: before.provider },
      );
      assert.equal(stack.registry.handleOf(botId), handle);
      assert.deepEqual(await readFile(result), output);
      const recent = bench.records.slice(before.records);
      await t.test("exactly one runtime error origin carries the HTTP trace and Bot", () => {
        const errors = recent.filter((record) => record.level === "error");
        assert.equal(errors.length, 1);
        assert.equal(errors[0]?.evt, "runtime.task.retry.fail");
        assert.equal(errors[0]?.layer, "runtime");
        assert.equal(errors[0]?.trace, observed[0]?.trace);
        assert.match(errors[0]?.trace ?? "", /^tr_http_/);
        assert.equal(errors[0]?.botId, botId);
        assert.equal(errors[0]?.err?.origin, true);
      });
      await t.test(
        "the classified failure and original cause cross unchanged without content logs",
        () => {
          const cause = observed[0]?.cause;
          assert.ok(cause instanceof ClassifiedFailure);
          assert.equal(
            cause.failure.kind,
            damage === "EACCES" ? "storage_failed" : "invalid_command",
          );
          assert.equal(
            recent.find((record) => record.level === "error")?.err?.failure,
            cause.failure.id,
          );
          if (damage === "EACCES")
            assert.equal((cause.cause as NodeJS.ErrnoException).code, "EACCES");
          assert.equal(recent.filter((record) => record.evt === "runtime.task.retry.ok").length, 0);
          const logs = JSON.stringify([...recent, ...stack.records]);
          assert.ok(!logs.includes(resourceRoot ?? ""));
          assert.ok(!logs.includes("private damaged manifest/body"));
          assert.ok(!logs.includes("Keep resource-version-one instructions"));
        },
      );
    } finally {
      if (resourceRoot !== undefined) await chmod(resourceRoot, 0o700);
      await stack.close();
      await bench.cleanup();
    }
  });
}
