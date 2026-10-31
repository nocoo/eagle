import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getCurrentSystemMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { ClassifiedFailure, type Message } from "../../src/core/domain.ts";
import type { HistoryBundle } from "../../src/runtime/pi/HistoryReplica.ts";
import { assistant, text, toolCall, trace, waitFor } from "../support/pi.ts";
import { type Frame, frameQueue, hello, type Stack, send, startStack } from "../support/server.ts";

const post = (stack: Stack, bot: string, method: string, params: unknown) =>
  fetch(`http://127.0.0.1:${stack.port}/v1/bots/${bot}/replica/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${stack.token}`, "content-type": "application/json" },
    body: JSON.stringify(params),
  });

test("ordinary root send selects a ready complete package without replacing local history or workspace", async (t) => {
  const a = await startStack({ real: true });
  const b = await startStack({ real: true });
  try {
    const source = await a.createBot("root source");
    const target = await b.createBot("root target");
    const resources = JSON.parse(
      await readFile(
        new URL("../../../../fixtures/bots-sync/resources.v1.json", import.meta.url),
        "utf8",
      ),
    ) as HistoryBundle["resources"];
    const rootA = await a.registry.open(source, trace);
    const rootB = await b.registry.open(target, trace);
    for (const [stack, handle, label] of [
      [a, rootA, "source"],
      [b, rootB, "target"],
    ] as const) {
      stack.faux?.setResponses([text(`${label} original answer`)]);
      await handle.submit({
        requestId: `root-seed-${label}`,
        text: `${label} local history`,
        whenBusy: "followUp",
        trace,
      });
      await waitFor(
        async () =>
          (await handle.submission({ requestId: `root-seed-${label}` }))?.status === "done",
        "the original root to settle",
      );
    }
    for (const resource of resources) {
      const path = join(a.directory.botDir(source), "workspace", resource.name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(resource.base64, "base64"));
      assert.deepEqual(await readFile(path), Buffer.from(resource.base64, "base64"));
    }
    const selected = (await (
      await post(a, source, "export", { resources })
    ).json()) as HistoryBundle;
    const before = b.faux?.state.callCount;
    assert.equal((await post(b, target, "import", { bundle: selected })).status, 200);
    assert.deepEqual(
      await (await post(b, target, "export", { head: selected.head })).json(),
      selected,
      "the real HTTP ready-head precondition precedes ordinary send",
    );
    assert.equal(b.faux?.state.callCount, before, "passive import admits no work");
    const socket = b.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId: target, trace });
    await frames.next();
    const requests: TranscriptContext[] = [];
    b.faux?.setResponses([
      (request) => {
        requests.push(request);
        const section =
          getCurrentSystemMessage(request.messages)?.sections?.["bots-resources"] ?? "";
        const skill = /^Skill directory: (.+)$/m.exec(section)?.[1];
        const directory = /^Resource directory: (.+)$/m.exec(section)?.[1];
        if (skill === undefined || directory === undefined)
          return text("ordinary root did not load selected resources");
        return assistant(
          [
            toolCall("read", { path: `${skill}/references/nested/input.txt` }),
            toolCall("read", { path: `${directory}/attachments/raw.bin` }),
            toolCall("bash", { command: `bash '${skill}/scripts/nested/run.sh'` }),
          ],
          { stopReason: "toolUse" },
        );
      },
      (request) => {
        requests.push(request);
        return text("ordinary root package completed");
      },
    ]);
    await send(socket, {
      type: "send",
      requestId: "root-resource-first",
      text: "use the selected package on my root",
      resourceHead: selected.head,
      whenBusy: "followUp",
      trace,
    });
    const liveUsers: Message[] = [];
    let done = false;
    while (!done) {
      const frame = await frames.next(5_000);
      assert.notEqual(frame.type, "error", JSON.stringify(frame));
      if (frame.type === "append" && (frame.message as Message).role === "user")
        liveUsers.push(frame.message as Message);
      done =
        frame.type === "submission" &&
        frame.requestId === "root-resource-first" &&
        frame.status === "done";
    }
    assert.equal(liveUsers.length, 1);
    assert.deepEqual(liveUsers[0]?.blocks, [
      { type: "text", text: "use the selected package on my root" },
    ]);
    assert.ok(!JSON.stringify(liveUsers).includes("resourceHead"));
    await send(socket, { type: "resync", trace });
    for (;;) {
      const frame = await frames.next();
      if (frame.type !== "snapshot") continue;
      const view = frame.value as { messages: Message[] };
      assert.equal(
        view.messages.filter(
          (message) => message.role === "user" && message.requestId === "root-resource-first",
        ).length,
        1,
      );
      assert.ok(!JSON.stringify(view.messages).includes("resourceHead"));
      break;
    }
    const section = getCurrentSystemMessage(requests[0]?.messages ?? [])?.sections?.[
      "bots-resources"
    ];
    assert.match(
      section ?? "",
      /Keep resource-version-one instructions/,
      "ordinary send must consume the ready head's selected AGENTS and complete skill",
    );
    assert.equal(
      requests.length,
      2,
      "native tools are followed by the same selected-version request",
    );
    const expected = Buffer.concat(
      resources
        .filter(
          (file) =>
            file.name.endsWith("/input.txt") || file.name === "skills/fixture/assets/raw.bin",
        )
        .map((file) => Buffer.from(file.base64, "base64")),
    );
    assert.deepEqual(
      await readFile(join(b.directory.botDir(target), "workspace/result.bin")),
      expected,
    );
    const local = (await (await post(b, target, "export", {})).json()) as HistoryBundle;
    assert.ok(
      local.entries.some((entry) => JSON.stringify(entry.model).includes("target local history")),
    );
    assert.ok(
      !local.entries.some((entry) => JSON.stringify(entry.model).includes("source local history")),
    );
    assert.ok(local.entries.some((entry) => entry.kind === "pi.tool-result"));
    assert.equal(
      local.entries.filter(
        (entry) =>
          entry.model?.[0]?.role === "user" &&
          JSON.stringify(entry.model).includes("use the selected package on my root"),
      ).length,
      1,
    );
    const calls = b.faux?.state.callCount;
    await send(socket, {
      type: "send",
      requestId: "root-resource-first",
      text: "use the selected package on my root",
      resourceHead: "0".repeat(64),
      whenBusy: "followUp",
      trace,
    });
    for (;;) {
      const frame = await frames.next();
      if (frame.type === "error") {
        assert.equal(frame.disposition, "not_admitted");
        break;
      }
    }
    assert.equal(
      b.faux?.state.callCount,
      calls,
      "the core stored-record shortcut cannot bypass an explicit selector conflict",
    );
    await t.test("WS stored selected ID validates omitted-selector mode", async () => {
      for (const whenBusy of ["reject", "steer"] as const) {
        const retryTrace = `tr_mode_ws_${whenBusy}`;
        await send(socket, {
          type: "send",
          requestId: "root-resource-first",
          text: "use the selected package on my root",
          whenBusy,
          trace: retryTrace,
        });
        for (;;) {
          const frame = await frames.next();
          if (
            frame.type !== "error" &&
            !(frame.type === "submission" && frame.requestId === "root-resource-first")
          )
            continue;
          assert.equal(
            frame.type,
            "error",
            "omitted selector must not bypass the persisted whenBusy binding",
          );
          assert.equal(frame.disposition, "not_admitted");
          const errors = b.records.filter(
            (record) => record.level === "error" && record.trace === retryTrace,
          );
          assert.equal(errors.length, 1);
          assert.equal(errors[0]?.evt, "runtime.submit.fail");
          assert.equal(errors[0]?.botId, target);
          assert.deepEqual(errors[0]?.err, {
            kind: "invalid_command",
            failure: frame.failure,
            origin: true,
          });
          break;
        }
      }
    });
    await send(socket, {
      type: "send",
      requestId: "root-resource-first",
      text: "use the selected package on my root",
      whenBusy: "followUp",
      trace,
    });
    for (;;) {
      const frame = await frames.next();
      if (frame.type === "submission" && frame.requestId === "root-resource-first") {
        assert.equal(frame.status, "done");
        break;
      }
    }
    assert.equal(b.faux?.state.callCount, calls);
    a.faux?.setResponses([
      (request) => {
        const selectedSection =
          getCurrentSystemMessage(request.messages)?.sections?.["bots-resources"] ?? "";
        assert.match(selectedSection, /version-one/);
        const skill = /^Skill directory: (.+)$/m.exec(selectedSection)?.[1];
        assert.ok(skill);
        assert.ok(skill.startsWith(a.directory.botDir(source)));
        assert.ok(!skill.startsWith(b.directory.botDir(target)));
        return assistant([toolCall("bash", { command: `bash '${skill}/scripts/nested/run.sh'` })], {
          stopReason: "toolUse",
        });
      },
      text("source ordinary invocation complete"),
    ]);
    await a.service.invoke({
      botId: source,
      requestId: "root-invocation-A",
      text: "same selected version at source",
      resourceHead: selected.head,
      origin: { kind: "human" },
      trace,
    });
    await waitFor(
      async () => (await rootA.submission({ requestId: "root-invocation-A" }))?.status === "done",
      "the ordinary invocation using the A package",
    );
    assert.deepEqual(
      await readFile(join(a.directory.botDir(source), "workspace/result.bin")),
      expected,
    );
    const callsA = a.faux?.state.callCount;
    for (const [requestId, inputText] of [
      ["root-invocation-A", "same selected version at source"],
      ["root-seed-source", "source local history"],
    ] as const) {
      await t.test(`Invocation stored ${requestId} validates omitted-selector mode`, async () => {
        for (const whenBusy of ["reject", "steer"] as const) {
          const retryTrace = `tr_mode_${requestId}_${whenBusy}`;
          await assert.rejects(
            a.service.invoke({
              botId: source,
              requestId,
              text: inputText,
              whenBusy,
              origin: { kind: "human" },
              trace: retryTrace,
            }),
            (cause) => {
              assert.ok(cause instanceof ClassifiedFailure);
              assert.match(cause.message, /binding conflict/);
              const errors = a.records.filter(
                (record) => record.level === "error" && record.trace === retryTrace,
              );
              assert.equal(errors.length, 1);
              assert.equal(errors[0]?.evt, "runtime.submit.fail");
              assert.equal(errors[0]?.botId, source);
              assert.deepEqual(errors[0]?.err, {
                kind: "invalid_command",
                failure: cause.failure.id,
                origin: true,
              });
              return true;
            },
          );
        }
        assert.equal(
          (
            await a.service.invoke({
              botId: source,
              requestId,
              text: inputText,
              origin: { kind: "human" },
              trace,
            })
          ).status,
          "done",
        );
      });
    }
    assert.equal(a.faux?.state.callCount, callsA);
    socket.close();
  } finally {
    await Promise.allSettled([a.close(), b.close()]);
  }
});

test("two busy daemons retain active v1 and queue locally edited v2 on their original roots", async () => {
  const a = await startStack({ real: true });
  const b = await startStack({ real: true });
  const release = Promise.withResolvers<void>();
  let enteredA = false;
  let enteredB = false;
  try {
    const source = await a.createBot("busy source");
    const target = await b.createBot("busy target");
    const rootA = await a.registry.open(source, trace);
    const rootB = await b.registry.open(target, trace);
    a.faux?.setResponses([text("source fixed history")]);
    await rootA.submit({
      requestId: "busy-source-seed",
      text: "source fixed input",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      async () => (await rootA.submission({ requestId: "busy-source-seed" }))?.status === "done",
      "the fixed resource base",
    );
    const resources = JSON.parse(
      await readFile(
        new URL("../../../../fixtures/bots-sync/resources.v1.json", import.meta.url),
        "utf8",
      ),
    ) as HistoryBundle["resources"];
    const capture = async (files: HistoryBundle["resources"], head?: string) => {
      for (const file of files) {
        const path = join(a.directory.botDir(source), "workspace", file.name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, Buffer.from(file.base64, "base64"));
        assert.deepEqual(await readFile(path), Buffer.from(file.base64, "base64"));
      }
      const response = await post(a, source, "export", {
        resources: files,
        ...(head === undefined ? {} : { head }),
      });
      assert.equal(response.status, 200);
      return (await response.json()) as HistoryBundle;
    };
    const one = await capture(resources);
    let two: HistoryBundle | undefined;
    assert.equal((await post(b, target, "import", { bundle: one })).status, 200);
    const expected = (bundle: HistoryBundle) =>
      Buffer.concat(
        bundle.resources
          .filter(
            (file) =>
              file.name.endsWith("/input.txt") || file.name === "skills/fixture/assets/raw.bin",
          )
          .map((file) => Buffer.from(file.base64, "base64")),
      );
    const seenA: string[] = [];
    const seenB: string[] = [];
    const provider = (stack: Stack, bot: string, side: "source" | "target", seen: string[]) => {
      const rounds = new Map<string, number>();
      return async (request: TranscriptContext) => {
        const user = [...request.messages].reverse().find((message) => message.role === "user");
        assert.ok(user?.content === `${side}-v1` || user?.content === `${side}-v2`);
        const label = String(user.content);
        const bundle = label.endsWith("-v1") ? one : two;
        assert.ok(bundle);
        const section =
          getCurrentSystemMessage(request.messages)?.sections?.["bots-resources"] ?? "";
        assert.match(
          section,
          new RegExp(
            `Resource version: ${createHash("sha256").update(JSON.stringify(bundle.resources)).digest("hex")}`,
          ),
        );
        assert.match(section, label.endsWith("-v1") ? /version-one/ : /version-two/);
        const skill = /^Skill directory: (.+)$/m.exec(section)?.[1];
        const directory = /^Resource directory: (.+)$/m.exec(section)?.[1];
        assert.ok(skill && directory);
        assert.ok(skill.startsWith(stack.directory.botDir(bot)));
        seen.push(label);
        const round = (rounds.get(label) ?? 0) + 1;
        rounds.set(label, round);
        if (label.endsWith("-v1") && round === 1) {
          if (side === "source") enteredA = true;
          else enteredB = true;
          await release.promise;
        }
        if (round === 1)
          return assistant(
            [
              toolCall("read", { path: `${skill}/references/nested/input.txt` }),
              toolCall("read", { path: `${directory}/attachments/raw.bin` }),
              toolCall("bash", {
                command: `bash '${skill}/scripts/nested/run.sh' && mv result.bin '${label}.bin'`,
              }),
            ],
            { stopReason: "toolUse" },
          );
        return text(`${label} done`);
      };
    };
    const respondA = provider(a, source, "source", seenA);
    const respondB = provider(b, target, "target", seenB);
    a.faux?.setResponses(Array.from({ length: 4 }, () => respondA));
    b.faux?.setResponses(Array.from({ length: 4 }, () => respondB));
    const invoke = (requestId: string, resourceHead?: string) =>
      a.service.invoke({
        botId: source,
        requestId,
        text: requestId,
        ...(resourceHead === undefined ? {} : { resourceHead }),
        origin: { kind: "human" },
        trace,
      });
    await invoke("source-v1", one.head);
    const socket = b.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId: target, trace });
    await frames.next();
    await send(socket, {
      type: "send",
      requestId: "target-v1",
      text: "target-v1",
      resourceHead: one.head,
      whenBusy: "followUp",
      trace,
    });
    await waitFor(() => enteredA && enteredB, "both actual v1 provider barriers");
    const changed = resources.map((file) => {
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
    two = await capture(changed, one.head);
    assert.deepEqual(
      await (await post(a, source, "export", { head: one.head, resources: changed })).json(),
      two,
    );
    assert.deepEqual(two.entries, one.entries);
    assert.deepEqual(two.agent, one.agent);
    assert.deepEqual(two.origins, one.origins);
    assert.deepEqual(two.parents, [one.head]);
    const counts = [a.faux?.state.callCount, b.faux?.state.callCount];
    assert.equal((await post(b, target, "import", { bundle: two })).status, 200);
    assert.equal((await invoke("source-v2", two.head)).status, "queued");
    await send(socket, {
      type: "send",
      requestId: "target-v2",
      text: "target-v2",
      resourceHead: two.head,
      whenBusy: "followUp",
      trace,
    });
    for (;;) {
      const frame = await frames.next();
      assert.notEqual(frame.type, "error", JSON.stringify(frame));
      if (frame.type === "submission" && frame.requestId === "target-v2") {
        assert.equal(frame.status, "queued");
        break;
      }
    }
    assert.deepEqual(
      [a.faux?.state.callCount, b.faux?.state.callCount],
      counts,
      "passive import and queued admission cannot execute another input",
    );
    release.resolve();
    await waitFor(
      async () =>
        (await rootA.submission({ requestId: "source-v2" }))?.status === "done" &&
        (await rootB.submission({ requestId: "target-v2" }))?.status === "done",
      "both original roots to finish their versions",
    );
    assert.deepEqual(seenA, ["source-v1", "source-v1", "source-v2", "source-v2"]);
    assert.deepEqual(seenB, ["target-v1", "target-v1", "target-v2", "target-v2"]);
    for (const [stack, bot, side] of [
      [a, source, "source"],
      [b, target, "target"],
    ] as const) {
      for (const [suffix, bundle] of [
        ["v1", one],
        ["v2", two],
      ] as const)
        assert.deepEqual(
          await readFile(join(stack.directory.botDir(bot), "workspace", `${side}-${suffix}.bin`)),
          expected(bundle),
        );
      const raw = (await (await post(stack, bot, "export", {})).json()) as HistoryBundle;
      assert.equal(raw.entries.filter((entry) => entry.kind === "bots.user.resources").length, 2);
      assert.equal(raw.entries.filter((entry) => entry.kind === "pi.tool-result").length, 6);
    }
    const before = a.faux?.state.callCount;
    await assert.rejects(invoke("source-v1", two.head), /binding conflict/);
    assert.equal((await invoke("source-v1")).status, "done");
    assert.equal(a.faux?.state.callCount, before);
    socket.close();
  } finally {
    release.resolve();
    await Promise.allSettled([a.close(), b.close()]);
  }
});

test("warm WS and Invocation retry-binding SQLite failures keep one runtime origin without SDK admission", async (t) => {
  const stack = await startStack({ real: true });
  const socket = stack.connect();
  const frames = frameQueue(socket);
  let db: DatabaseSync | undefined;
  let sdk: DatabaseSync | undefined;
  let renamed = false;
  try {
    const botId = await stack.createBot("owned retry read failure");
    const handle = await stack.registry.open(botId, trace);
    const requestId = "lookup-read-original";
    const inputText = "the original SDK result";
    stack.faux?.setResponses([text("actual original lookup result")]);
    await stack.service.invoke({
      botId,
      requestId,
      text: inputText,
      origin: { kind: "human" },
      trace,
    });
    await waitFor(
      async () => (await handle.submission({ requestId }))?.status === "done",
      "the warm actual SDK record",
    );
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace });
    await frames.next();
    db = new DatabaseSync(join(stack.directory.botDir(botId), "replica.sqlite"));
    sdk = new DatabaseSync(join(stack.directory.botDir(botId), "session.sqlite"), {
      readOnly: true,
    });
    const counts = () =>
      ["tasks", "submissions", "entries"].map((table) =>
        sdk?.prepare(`SELECT count(*) AS n FROM ${table}`).get(),
      );
    const before = {
      sdk: counts(),
      provider: stack.faux?.state.callCount,
      records: stack.records.length,
      opens: stack.opens(),
    };
    const rows = db.prepare("SELECT * FROM local_runs ORDER BY request_id").all();
    db.exec("ALTER TABLE local_runs RENAME TO owned_lookup_runs");
    renamed = true;
    const replies: Frame[] = [];
    for (const retryTrace of ["tr_read_ws_first", "tr_read_ws_again"]) {
      await send(socket, {
        type: "send",
        requestId,
        text: inputText,
        whenBusy: "followUp",
        trace: retryTrace,
      });
      for (;;) {
        const frame = await frames.next();
        if (frame.trace !== retryTrace) continue;
        assert.equal(frame.type, "error");
        assert.equal(frame.disposition, "unknown");
        assert.equal(frame.kind, "internal");
        replies.push(frame);
        break;
      }
    }
    let invocationFailure: unknown;
    await assert.rejects(
      stack.service.invoke({
        botId,
        requestId,
        text: inputText,
        origin: { kind: "human" },
        trace: "tr_read_invocation",
      }),
      (cause) => {
        invocationFailure = cause;
        return true;
      },
    );
    const recent = stack.records.slice(before.records);
    await t.test("WS failures share one runtime error origin and preserve command traces", () => {
      const errors = recent.filter((record) => record.level === "error");
      assert.equal(errors.length, 1);
      assert.equal(errors[0]?.evt, "runtime.submit.fail");
      assert.equal(errors[0]?.layer, "runtime");
      assert.equal(errors[0]?.trace, "tr_read_ws_first");
      assert.equal(errors[0]?.botId, botId);
      assert.deepEqual(errors[0]?.err, {
        kind: "internal",
        failure: replies[0]?.failure,
        origin: true,
      });
      assert.equal(replies[1]?.failure, replies[0]?.failure);
      for (const reply of replies) {
        const runtime = recent.find(
          (record) => record.evt === "runtime.submit.fail" && record.trace === reply.trace,
        );
        assert.equal(runtime?.err?.failure, reply.failure);
        const propagation = recent.find(
          (record) => record.evt === "protocol.command.fail" && record.trace === reply.trace,
        );
        assert.equal(propagation?.level, "warn");
        assert.equal(propagation?.err?.failure, reply.failure);
      }
    });
    await t.test("Invocation retains the raw cause and repeated runtime episode", () => {
      assert.ok(invocationFailure instanceof ClassifiedFailure);
      assert.equal(invocationFailure.failure.id, replies[0]?.failure);
      assert.equal(invocationFailure.disposition, "unknown");
      assert.ok(invocationFailure.cause instanceof Error);
      assert.equal((invocationFailure.cause as NodeJS.ErrnoException).code, "ERR_SQLITE_ERROR");
      assert.match(invocationFailure.cause.message, /no such table: local_runs/);
      const record = recent.find(
        (item) => item.evt === "runtime.submit.fail" && item.trace === "tr_read_invocation",
      );
      assert.equal(record?.level, "warn");
      assert.equal(record?.botId, botId);
      assert.equal(record?.err?.failure, invocationFailure.failure.id);
      assert.equal(record?.detail?.propagated, true);
    });
    assert.deepEqual(counts(), before.sdk);
    assert.equal(stack.faux?.state.callCount, before.provider);
    assert.equal(stack.opens(), before.opens);
    assert.ok(!JSON.stringify(recent).includes("local_runs"));
    assert.ok(!JSON.stringify(recent).includes(stack.directory.botDir(botId)));
    db.exec("ALTER TABLE owned_lookup_runs RENAME TO local_runs");
    renamed = false;
    assert.deepEqual(db.prepare("SELECT * FROM local_runs ORDER BY request_id").all(), rows);
    assert.equal(
      (
        await stack.service.invoke({
          botId,
          requestId,
          text: inputText,
          origin: { kind: "human" },
          trace,
        })
      ).status,
      "done",
    );
    assert.equal(stack.faux?.state.callCount, before.provider);
  } finally {
    if (renamed) db?.exec("ALTER TABLE owned_lookup_runs RENAME TO local_runs");
    sdk?.close();
    db?.close();
    socket.close();
    await stack.close();
  }
});
