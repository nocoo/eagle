import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  getCurrentSystemMessage,
  getCurrentTools,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ClassifiedFailure } from "../../src/core/domain.ts";
import type { HistoryBundle } from "../../src/runtime/pi/HistoryReplica.ts";
import { pageSchema } from "../../src/runtime/pi/syncProtocol.ts";
import { seedP0, sourceCarriers } from "../support/legacyReplica.ts";
import {
  assistant,
  createBench,
  providerError,
  text,
  toolCall,
  trace,
  waitFor,
} from "../support/pi.ts";

const setup = async (seedAnswer = "local root baseline") => {
  const bench = await createBench();
  const spec = bench.spec();
  const handle = await bench.runtime.open(spec);
  const replica = handle.replica?.bind(handle);
  assert.ok(replica);
  const call = (method: Parameters<typeof replica>[0]["method"], params: unknown) =>
    replica({ method, params, trace });
  let baseline: TranscriptContext | undefined;
  bench.faux.setResponses([
    (request) => {
      baseline = request;
      return text(seedAnswer);
    },
  ]);
  await handle.submit({
    requestId: "root-resource-seed",
    text: "original local root",
    whenBusy: "followUp",
    trace,
  });
  await waitFor(
    async () => (await handle.submission({ requestId: "root-resource-seed" }))?.status === "done",
    "the local root seed",
  );
  const original = JSON.parse(
    await readFile(
      new URL("../../../../fixtures/bots-sync/resources.v1.json", import.meta.url),
      "utf8",
    ),
  ) as HistoryBundle["resources"];
  const capture = async (version: "one" | "two", head?: string) => {
    const resources = original.map((file) => {
      const bytes =
        file.kind === "instructions" || file.name.endsWith("/input.txt")
          ? Buffer.from(
              Buffer.from(file.base64, "base64").toString("utf8").replaceAll("one", version),
            )
          : Buffer.from(file.base64, "base64");
      return {
        ...file,
        base64: bytes.toString("base64"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    });
    for (const resource of resources) {
      const path = join(spec.dir, "workspace", resource.name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(resource.base64, "base64"));
    }
    return (await call("export", {
      resources,
      ...(head === undefined ? {} : { head }),
    })) as HistoryBundle;
  };
  return { bench, spec, handle, call, baseline, capture };
};
const expectedBytes = (bundle: HistoryBundle) =>
  Buffer.concat(
    bundle.resources
      .filter(
        (file) => file.name.endsWith("/input.txt") || file.name === "skills/fixture/assets/raw.bin",
      )
      .map((file) => Buffer.from(file.base64, "base64")),
  );

test("ordinary root FIFO fixes active/queued versions through native tool rounds and local edits", async () => {
  const env = await setup();
  const { bench, spec, handle, call, baseline } = env;
  const release = Promise.withResolvers<void>();
  let entered = false;
  const seen: { label: string; version: string; system: unknown }[] = [];
  try {
    const one = await env.capture("one");
    let two: HistoryBundle;
    const versions = {
      one: createHash("sha256").update(JSON.stringify(one.resources)).digest("hex"),
      two: "",
    };
    const rounds = new Map<string, number>();
    const respond = async (request: TranscriptContext) => {
      const user = [...request.messages].reverse().find((message) => message.role === "user");
      assert.equal(typeof user?.content, "string");
      const label = String(user?.content);
      const wanted = label === "queued-two" ? "two" : "one";
      const system = getCurrentSystemMessage(request.messages);
      const section = system?.sections?.["bots-resources"] ?? "";
      assert.match(section, new RegExp(`Resource version: ${versions[wanted]}`));
      assert.match(section, new RegExp(`Keep resource-version-${wanted} instructions`));
      for (const [key, value] of Object.entries(
        getCurrentSystemMessage(baseline?.messages ?? [])?.sections ?? {},
      ))
        assert.equal(system?.sections?.[key], value);
      assert.deepEqual(
        getCurrentTools(request.messages),
        getCurrentTools(baseline?.messages ?? []),
      );
      const keys = Object.keys(system?.sections ?? {});
      assert.deepEqual(
        keys.filter((key) => key !== "bots-resources"),
        Object.keys(getCurrentSystemMessage(baseline?.messages ?? [])?.sections ?? {}),
      );
      const skill = /^Skill directory: (.+)$/m.exec(section)?.[1];
      assert.ok(skill);
      assert.equal(skill, join(spec.dir, "resources", versions[wanted], "skills/fixture"));
      seen.push({ label, version: versions[wanted], system });
      const round = (rounds.get(label) ?? 0) + 1;
      rounds.set(label, round);
      if (label === "active-one" && round === 1) {
        entered = true;
        await release.promise;
      }
      if (round === 1)
        return assistant(
          [
            toolCall("bash", {
              command: `bash '${skill}/scripts/nested/run.sh' && mv result.bin '${label}.bin'`,
            }),
          ],
          { stopReason: "toolUse" },
        );
      return text(`${label} done`);
    };
    bench.faux.setResponses(Array.from({ length: 6 }, () => respond));
    const admit = (id: string, head?: string) =>
      handle.submit({
        requestId: id,
        text: id,
        whenBusy: "followUp",
        trace,
        ...(head === undefined ? {} : { resourceHead: head }),
      });
    await admit("active-one", one.head);
    await waitFor(() => entered, "active v1 provider barrier");
    assert.equal((await admit("queued-one", one.head)).status, "queued");
    two = await env.capture("two", one.head);
    assert.deepEqual(
      await call("export", { head: one.head, resources: two.resources }),
      two,
      "fixed base and ordered files re-export deterministically while root is busy",
    );
    assert.deepEqual(two.parents, [one.head]);
    assert.deepEqual(two.agent, one.agent);
    assert.deepEqual(
      two.entries.map((entry) => entry.model),
      one.entries.map((entry) => entry.model),
    );
    assert.deepEqual(Object.values(two.origins), Object.values(one.origins));
    versions.two = createHash("sha256").update(JSON.stringify(two.resources)).digest("hex");
    assert.equal((await admit("queued-two", two.head)).status, "queued");
    assert.equal(seen.length, 1, "queue admission cannot start another model request");
    release.resolve();
    await waitFor(
      async () => (await handle.submission({ requestId: "queued-two" }))?.status === "done",
      "all FIFO versioned inputs to settle",
    );
    assert.deepEqual(
      seen.map((item) => item.label),
      ["active-one", "active-one", "queued-one", "queued-one", "queued-two", "queued-two"],
    );
    for (const label of ["active-one", "queued-one", "queued-two"])
      assert.deepEqual(
        await readFile(join(spec.dir, "workspace", `${label}.bin`)),
        expectedBytes(label === "queued-two" ? two : one),
      );
    const history = await handle.history({ limit: 128, trace });
    for (const label of ["active-one", "queued-one", "queued-two"])
      assert.equal(
        history.messages.filter(
          (message) =>
            message.role === "user" &&
            message.blocks.some((block) => block.type === "text" && block.text === label),
        ).length,
        1,
      );
    const raw = (await call("export", {})) as HistoryBundle;
    assert.equal(raw.entries.filter((entry) => entry.kind === "bots.user.resources").length, 3);
    assert.equal(raw.entries.filter((entry) => entry.kind === "pi.tool-result").length, 3);
    for (const entry of raw.entries.filter((entry) => entry.kind === "bots.user.resources")) {
      assert.deepEqual(Object.keys(entry.data ?? {}).sort(), ["resourceHead", "resourceVersion"]);
      assert.ok(!JSON.stringify(entry.data).includes("Keep resource-version"));
    }
    const db = new DatabaseSync(join(spec.dir, "replica.sqlite"), { readOnly: true });
    try {
      const facts = db
        .prepare("SELECT value FROM facts")
        .all()
        .map((row) => JSON.parse(String(row.value)))
        .filter((fact) => fact.kind === "resource");
      const uniqueFiles = new Map(
        [...one.resources, ...two.resources].map((file) => [JSON.stringify(file), file]),
      );
      assert.equal(
        facts.length,
        uniqueFiles.size,
        "resource bodies are shared immutable facts, not copied per root input",
      );
      assert.equal(
        facts.reduce((sum, fact) => sum + Buffer.from(fact.resource.base64, "base64").length, 0),
        [...uniqueFiles.values()].reduce(
          (sum, file) => sum + Buffer.from(file.base64, "base64").length,
          0,
        ),
      );
    } finally {
      db.close();
    }

    await handle.close(trace, 5_000);
    const reopened = await bench.runtime.open(spec);
    assert.equal((await reopened.submission({ requestId: "queued-two" }))?.status, "done");
    await reopened.close(trace, 5_000);
  } finally {
    release.resolve();
    await handle.close(trace, 5_000);
    await bench.cleanup();
  }
});

for (const versions of ["one-two", "one-legacy", "legacy-one"] as const)
  for (const boundary of ["final", "postTools"] as const)
    for (const firstMode of ["steer", "followUp"] as const) {
      test(`root ${boundary} rejects ${versions} queue mixtures after ${firstMode} without changing mode`, async () => {
        const env = await setup();
        const { bench, handle } = env;
        const release = Promise.withResolvers<void>();
        let entered = false;
        try {
          const one = await env.capture("one");
          const two = await env.capture("two");
          const active = versions === "legacy-one" ? undefined : one.head;
          const other =
            versions === "one-legacy" ? undefined : versions === "legacy-one" ? one.head : two.head;
          bench.faux.setResponses([
            async () => {
              entered = true;
              await release.promise;
              return boundary === "final"
                ? text("active ended")
                : assistant([toolCall("read", { path: "AGENTS.md" })], { stopReason: "toolUse" });
            },
            text("queued inputs finished"),
            text("last input finished"),
          ]);
          await handle.submit({
            requestId: "mixture-active",
            text: "active-one",
            ...(active === undefined ? {} : { resourceHead: active }),
            whenBusy: "followUp",
            trace,
          });
          await waitFor(() => entered, "the active version barrier");
          const initial = firstMode === "steer" ? active : other;
          assert.equal(
            (
              await handle.submit({
                requestId: "mixture-first",
                text: "first queued",
                ...(initial === undefined ? {} : { resourceHead: initial }),
                whenBusy: firstMode,
                trace,
              })
            ).status,
            "queued",
          );
          const before = bench.faux.state.callCount;
          const refused = firstMode === "steer" ? other : active;
          await assert.rejects(
            handle.submit({
              requestId: "mixture-refused",
              text: "refused mixture",
              ...(refused === undefined ? {} : { resourceHead: refused }),
              whenBusy: firstMode === "steer" ? "followUp" : "steer",
              trace,
            }),
            (cause: unknown) =>
              cause instanceof ClassifiedFailure && cause.disposition === "not_admitted",
          );
          assert.equal(await handle.submission({ requestId: "mixture-refused" }), undefined);
          assert.equal(bench.faux.state.callCount, before);
          const db = new DatabaseSync(join(env.spec.dir, "replica.sqlite"));
          try {
            assert.equal(
              JSON.parse(
                String(
                  db
                    .prepare("SELECT value FROM local_runs WHERE request_id=?")
                    .get("mixture-refused")?.value,
                ),
              ).rejected,
              true,
            );
          } finally {
            db.close();
          }
          release.resolve();
          await waitFor(
            async () => !(await handle.busy()).tasks,
            "remaining same-version work to settle",
          );
          assert.equal((await handle.submission({ requestId: "mixture-first" }))?.status, "done");
        } finally {
          release.resolve();
          await handle.close(trace, 5_000);
          await bench.cleanup();
        }
      });
    }

for (const selected of [false, true]) {
  for (const changedMode of ["followUp", "steer"] as const) {
    test(`a ${selected ? "selected" : "legacy"} refused root ID cannot change reject to ${changedMode}`, async () => {
      const env = await setup();
      const { bench, handle, spec } = env;
      const release = Promise.withResolvers<void>();
      let entered = false;
      try {
        const bundle = selected ? await env.capture("one") : undefined;
        const selection = bundle === undefined ? {} : { resourceHead: bundle.head };
        bench.faux.setResponses([
          async () => {
            entered = true;
            await release.promise;
            return text("original active result");
          },
          text("original reject mode retried once idle"),
        ]);
        await handle.submit({
          requestId: "mode-active-original",
          text: "hold the original active run",
          ...selection,
          whenBusy: "followUp",
          trace,
        });
        await waitFor(() => entered, "real mode-binding provider barrier");
        const input = {
          requestId: "mode-refused-original",
          text: "retry this refused input",
          ...selection,
          whenBusy: "reject" as const,
          trace,
        };
        await assert.rejects(
          handle.submit(input),
          (cause) =>
            cause instanceof ClassifiedFailure &&
            cause.failure.kind === "limit_exceeded" &&
            cause.cause instanceof Error &&
            cause.cause.name === "ConversationBusy" &&
            cause.disposition === "not_admitted",
        );
        const replica = new DatabaseSync(join(spec.dir, "replica.sqlite"), { readOnly: true });
        const sdk = new DatabaseSync(join(spec.dir, "session.sqlite"), { readOnly: true });
        const snapshot = () => ({
          run: replica
            .prepare("SELECT value FROM local_runs WHERE request_id=?")
            .get(input.requestId),
          outbox: replica
            .prepare(
              "SELECT * FROM source_events WHERE json_extract(event,'$.requestId')=? ORDER BY seq",
            )
            .all(input.requestId),
          sdk: ["entries", "tasks", "submissions"].map((table) =>
            sdk.prepare(`SELECT count(*) AS n FROM ${table}`).get(),
          ),
          provider: bench.faux.state.callCount,
        });
        try {
          const before = snapshot();
          const ledger = JSON.parse(String(before.run?.value));
          assert.equal(ledger.intent.whenBusy, "reject");
          assert.equal(ledger.admitted, false);
          assert.equal(ledger.rejected, true);
          assert.equal(before.outbox.length, 1);
          const { resourceHead: _head, ...omitted } = input;
          await assert.rejects(
            handle.submit({ ...omitted, whenBusy: changedMode }),
            /binding conflict/,
          );
          assert.equal(await handle.submission({ requestId: input.requestId }), undefined);
          assert.deepEqual(
            snapshot(),
            before,
            "a conflict cannot mutate the intent/outbox or admit SDK work",
          );
          const active = await handle.submission({ requestId: "mode-active-original" });
          assert.ok(active);
          await assert.rejects(
            handle.submit({
              requestId: "mode-active-original",
              text: "hold the original active run",
              whenBusy: "reject",
              trace,
            }),
            /binding conflict/,
          );
          const errors = bench.records.filter((record) => record.level === "error").length;
          assert.equal(
            (
              await handle.submit({
                requestId: "mode-active-original",
                text: "hold the original active run",
                whenBusy: "followUp",
                trace,
              })
            ).id,
            active.id,
          );
          assert.equal(bench.records.filter((record) => record.level === "error").length, errors);
          assert.deepEqual(snapshot(), before);
        } finally {
          sdk.close();
          replica.close();
        }
        release.resolve();
        await waitFor(async () => !(await handle.busy()).tasks, "original active work to finish");
        await handle.submit(input);
        await waitFor(
          async () => (await handle.submission({ requestId: input.requestId }))?.status === "done",
          "the original reject mode to admit once idle",
        );
        assert.equal(
          bench.faux.state.callCount,
          3,
          "seed, original active and one matching retry only",
        );
      } finally {
        release.resolve();
        await handle.close(trace, 5_000);
        await bench.cleanup();
      }
    });
  }
}

test("checked retry lookup attributes a real replica SQLite read failure once with its original cause", async (t) => {
  const env = await setup();
  const { bench, handle, spec } = env;
  const db = new DatabaseSync(join(spec.dir, "replica.sqlite"));
  const sdk = new DatabaseSync(join(spec.dir, "session.sqlite"), { readOnly: true });
  let renamed = false;
  try {
    const requestId = "root-resource-seed";
    const original = await handle.submission({ requestId });
    assert.equal(original?.status, "done");
    await waitFor(async () => !(await handle.busy()).tasks, "the original lookup seed to finish");
    const counts = () =>
      ["tasks", "submissions", "entries"].map((table) =>
        sdk.prepare(`SELECT count(*) AS n FROM ${table}`).get(),
      );
    const before = {
      sdk: counts(),
      provider: bench.faux.state.callCount,
      records: bench.records.length,
    };
    const rows = db.prepare("SELECT * FROM local_runs ORDER BY request_id").all();
    db.exec("ALTER TABLE local_runs RENAME TO owned_lookup_runs");
    renamed = true;
    const failures: unknown[] = [];
    for (const retryTrace of ["tr_lookup_sqlite_first", "tr_lookup_sqlite_again"]) {
      await assert.rejects(
        handle.submission({ requestId, retry: { whenBusy: "followUp", trace: retryTrace } }),
        (cause) => {
          failures.push(cause);
          return true;
        },
      );
    }
    const recent = bench.records.slice(before.records);
    await t.test(
      "raw SQLite errors become unknown classified failures with the original read cause",
      () => {
        for (const cause of failures) {
          assert.ok(cause instanceof ClassifiedFailure);
          assert.equal(cause.failure.kind, "internal");
          assert.equal(cause.failure.layer, "runtime");
          assert.equal(cause.disposition, "unknown");
          assert.ok(cause.cause instanceof Error);
          assert.equal((cause.cause as NodeJS.ErrnoException).code, "ERR_SQLITE_ERROR");
          assert.match(cause.cause.message, /no such table: local_runs/);
          assert.match(cause.cause.stack ?? "", /ReplicaStore.run/);
        }
      },
    );
    await t.test(
      "one runtime origin and a repeated warn retain trace Bot and failure identity",
      () => {
        const first = failures[0];
        const again = failures[1];
        assert.ok(first instanceof ClassifiedFailure && again instanceof ClassifiedFailure);
        assert.equal(first.failure, again.failure);
        const errors = recent.filter((record) => record.level === "error");
        assert.equal(errors.length, 1);
        assert.equal(errors[0]?.evt, "runtime.submit.fail");
        assert.equal(errors[0]?.trace, "tr_lookup_sqlite_first");
        assert.equal(errors[0]?.botId, spec.id);
        assert.deepEqual(errors[0]?.err, {
          kind: "internal",
          failure: first.failure.id,
          origin: true,
        });
        const repeated = recent.filter(
          (record) =>
            record.evt === "runtime.submit.fail" && record.trace === "tr_lookup_sqlite_again",
        );
        assert.equal(repeated.length, 1);
        assert.equal(repeated[0]?.level, "warn");
        assert.equal(repeated[0]?.err?.failure, first.failure.id);
        assert.equal(repeated[0]?.detail?.propagated, true);
        assert.ok(!JSON.stringify(recent).includes("local_runs"));
        assert.ok(!JSON.stringify(recent).includes(spec.dir));
      },
    );
    assert.deepEqual(
      await handle.submission({ requestId }),
      original,
      "pure status does not take the new retry-binding read",
    );
    assert.deepEqual(counts(), before.sdk);
    assert.equal(bench.faux.state.callCount, before.provider);
    db.exec("ALTER TABLE owned_lookup_runs RENAME TO local_runs");
    renamed = false;
    assert.deepEqual(db.prepare("SELECT * FROM local_runs ORDER BY request_id").all(), rows);
    assert.deepEqual(
      await handle.submission({ requestId, retry: { whenBusy: "followUp", trace } }),
      original,
    );
  } finally {
    if (renamed) db.exec("ALTER TABLE owned_lookup_runs RENAME TO local_runs");
    sdk.close();
    db.close();
    await handle.close(trace, 5_000);
    await bench.cleanup();
  }
});

test("legacy omitted intent mode normalizes only to followUp and pure status stays unchecked", async () => {
  const env = await setup();
  const { bench, handle, spec } = env;
  try {
    const db = new DatabaseSync(join(spec.dir, "replica.sqlite"));
    try {
      db.prepare(
        "UPDATE local_runs SET value=json_remove(value,'$.intent.whenBusy') WHERE request_id=?",
      ).run("root-resource-seed");
      const original = db
        .prepare("SELECT value FROM local_runs WHERE request_id=?")
        .get("root-resource-seed");
      const before = bench.faux.state.callCount;
      const status = await handle.submission({ requestId: "root-resource-seed" });
      for (const whenBusy of ["reject", "steer"] as const)
        await assert.rejects(
          handle.submission({ requestId: "root-resource-seed", retry: { whenBusy, trace } }),
          /binding conflict/,
        );
      assert.deepEqual(
        await handle.submission({
          requestId: "root-resource-seed",
          retry: { whenBusy: "followUp", trace },
        }),
        status,
      );
      assert.deepEqual(
        await handle.submit({
          requestId: "root-resource-seed",
          text: "original local root",
          whenBusy: "followUp",
          trace,
        }),
        status,
      );
      assert.deepEqual(
        db.prepare("SELECT value FROM local_runs WHERE request_id=?").get("root-resource-seed"),
        original,
      );
      db.prepare("DELETE FROM local_runs WHERE request_id=?").run("root-resource-seed");
      assert.deepEqual(
        await handle.submission({
          requestId: "root-resource-seed",
          retry: { whenBusy: "reject", trace },
        }),
        status,
        "an older SDK record with no local intent keeps its legacy lookup",
      );
      assert.equal(bench.faux.state.callCount, before);
    } finally {
      db.close();
    }
  } finally {
    await handle.close(trace, 5_000);
    await bench.cleanup();
  }
});

for (const damage of ["bytes", "EACCES"] as const) {
  test(`root accepted retry bypasses ${damage}, but new input is rejected without later execution`, async () => {
    const env = await setup();
    const { bench, handle, spec } = env;
    const root = join(spec.dir, "resources");
    try {
      const bundle = await env.capture("one");
      const other = await env.capture("two");
      bench.faux.setResponses([text("accepted once")]);
      const input = {
        requestId: "root-accepted-once",
        text: "one original input",
        resourceHead: bundle.head,
        whenBusy: "followUp" as const,
        trace,
      };
      await handle.submit(input);
      await waitFor(
        async () => (await handle.submission({ requestId: input.requestId }))?.status === "done",
        "selected root settlement",
      );
      const version = createHash("sha256").update(JSON.stringify(bundle.resources)).digest("hex");
      const agents = join(root, version, "AGENTS.md");
      if (damage === "EACCES") await chmod(root, 0);
      else {
        await chmod(agents, 0o600);
        await writeFile(agents, "damaged selected root bytes");
      }
      const before = {
        provider: bench.faux.state.callCount,
        errors: bench.records.filter((record) => record.level === "error").length,
      };
      const db = new DatabaseSync(join(spec.dir, "replica.sqlite"), { readOnly: true });
      try {
        const persisted = () => ({
          run: db.prepare("SELECT value FROM local_runs WHERE request_id=?").get(input.requestId),
          outbox: db
            .prepare("SELECT * FROM source_events WHERE json_extract(event,'$.requestId')=?")
            .all(input.requestId),
        });
        const original = persisted();
        for (const whenBusy of ["reject", "steer"] as const)
          await assert.rejects(handle.submit({ ...input, whenBusy }), /binding conflict/);
        assert.deepEqual(persisted(), original);
      } finally {
        db.close();
      }
      before.errors = bench.records.filter((record) => record.level === "error").length;
      assert.equal((await handle.submit(input)).status, "done");
      const { resourceHead: _head, ...omitted } = input;
      assert.equal((await handle.submit(omitted)).status, "done");
      assert.deepEqual(
        {
          provider: bench.faux.state.callCount,
          errors: bench.records.filter((record) => record.level === "error").length,
        },
        before,
      );
      await assert.rejects(
        handle.submit({ ...input, resourceHead: other.head }),
        /binding conflict/,
      );
      await assert.rejects(
        handle.submit({ ...input, text: "changed original text" }),
        /binding conflict/,
      );
      await assert.rejects(
        handle.submit({ ...input, requestId: "root-new-refused" }),
        (cause: unknown) =>
          cause instanceof ClassifiedFailure && cause.disposition === "not_admitted",
      );
      assert.equal(await handle.submission({ requestId: "root-new-refused" }), undefined);
      await chmod(root, 0o700);
      await chmod(agents, 0o600);
      const originalAgents = bundle.resources.find((file) => file.name === "AGENTS.md");
      assert.ok(originalAgents);
      await writeFile(agents, Buffer.from(originalAgents.base64, "base64"));
      await handle.close(trace, 5_000);
      const reopened = await bench.runtime.open(spec);
      assert.equal(bench.faux.state.callCount, before.provider);
      await reopened.close(trace, 5_000);
    } finally {
      await chmod(root, 0o700).catch(() => undefined);
      await handle.close(trace, 5_000);
      await bench.cleanup();
    }
  });
}

test("omitted steer inherits the active version and a new unselected root round clears it", async () => {
  const env = await setup();
  const { bench, handle, spec } = env;
  const release = Promise.withResolvers<void>();
  let entered = false;
  const seen: string[] = [];
  try {
    const one = await env.capture("one");
    const two = await env.capture("two");
    bench.faux.setResponses([
      async (request) => {
        const section =
          getCurrentSystemMessage(request.messages)?.sections?.["bots-resources"] ?? "";
        assert.match(section, /version-one/);
        seen.push("active");
        entered = true;
        await release.promise;
        return assistant([toolCall("read", { path: "AGENTS.md" })], { stopReason: "toolUse" });
      },
      (request) => {
        assert.match(
          getCurrentSystemMessage(request.messages)?.sections?.["bots-resources"] ?? "",
          /version-one/,
        );
        seen.push("steered");
        return text("active and inherited steer done");
      },
      (request) => {
        assert.equal(
          getCurrentSystemMessage(request.messages)?.sections?.["bots-resources"],
          undefined,
        );
        seen.push("legacy");
        return text("legacy new round");
      },
    ]);
    await handle.submit({
      requestId: "root-active-steer",
      text: "active-one",
      resourceHead: one.head,
      whenBusy: "followUp",
      trace,
    });
    await waitFor(() => entered, "active steer provider barrier");
    await assert.rejects(
      handle.submit({
        requestId: "root-different-steer",
        text: "different steer",
        resourceHead: two.head,
        whenBusy: "steer",
        trace,
      }),
      /differs from active/,
    );
    await handle.submit({
      requestId: "root-inherited-steer",
      text: "inherit current version",
      whenBusy: "steer",
      trace,
    });
    const db = new DatabaseSync(join(spec.dir, "replica.sqlite"));
    try {
      assert.equal(
        JSON.parse(
          String(
            db
              .prepare("SELECT value FROM local_runs WHERE request_id=?")
              .get("root-inherited-steer")?.value,
          ),
        ).intent.resourceHead,
        one.head,
      );
    } finally {
      db.close();
    }
    release.resolve();
    await waitFor(async () => !(await handle.busy()).tasks, "inherited steer to settle");
    await handle.submit({
      requestId: "root-legacy-again",
      text: "no resource selection",
      whenBusy: "followUp",
      trace,
    });
    await waitFor(
      async () => (await handle.submission({ requestId: "root-legacy-again" }))?.status === "done",
      "the unselected round",
    );
    assert.deepEqual(seen, ["active", "steered", "legacy"]);
  } finally {
    release.resolve();
    await handle.close(trace, 5_000);
    await bench.cleanup();
  }
});

test("a lost root admission receipt is resolved by the real SDK record after installed bytes break", async () => {
  const env = await setup();
  const { bench, handle, spec } = env;
  try {
    const one = await env.capture("one");
    const db = new DatabaseSync(join(spec.dir, "replica.sqlite"));
    const run = () =>
      JSON.parse(
        String(
          db.prepare("SELECT value FROM local_runs WHERE request_id=?").get("root-lost-receipt")
            ?.value,
        ),
      );
    const input = {
      requestId: "root-lost-receipt",
      text: "known SDK admission",
      resourceHead: one.head,
      whenBusy: "followUp" as const,
      trace,
    };
    try {
      db.exec(
        `CREATE TRIGGER lose_root_receipt BEFORE UPDATE ON local_runs WHEN OLD.request_id='root-lost-receipt' AND json_extract(NEW.value,'$.admitted')=1 BEGIN SELECT RAISE(FAIL,'owned root receipt failure'); END`,
      );
      bench.faux.setResponses([text("actual original SDK execution")]);
      await assert.rejects(
        handle.submit(input),
        (cause) => cause instanceof ClassifiedFailure && cause.disposition === "unknown",
      );
      await waitFor(
        async () => (await handle.submission({ requestId: input.requestId }))?.status === "done",
        "the actual SDK admission to settle",
      );
      assert.equal(run().admitted, false);
      db.exec("DROP TRIGGER lose_root_receipt");
      const version = createHash("sha256").update(JSON.stringify(one.resources)).digest("hex");
      const path = join(spec.dir, "resources", version, "AGENTS.md");
      await chmod(path, 0o600);
      await writeFile(path, "broken after real admission");
      const before = bench.faux.state.callCount;
      const original = run();
      for (const whenBusy of ["reject", "steer"] as const)
        await assert.rejects(handle.submit({ ...input, whenBusy }), /binding conflict/);
      assert.deepEqual(
        run(),
        original,
        "a real SDK receipt cannot allow a changed mode or rewrite the lost local receipt",
      );
      const errors = bench.records.filter((record) => record.level === "error").length;
      assert.equal((await handle.submit(input)).status, "done");
      assert.equal(bench.records.filter((record) => record.level === "error").length, errors);
      assert.equal(run().admitted, true);
      assert.equal(run().rejected, false);
      assert.equal(bench.faux.state.callCount, before);
    } finally {
      db.close();
    }
  } finally {
    await handle.close(trace, 5_000);
    await bench.cleanup();
  }
});

for (const damage of ["bytes", "EACCES"] as const) {
  test(`startup reconciles a done SDK root receipt before ${damage} preflight of its lost local admission`, async () => {
    const env = await setup();
    const { bench, handle, spec } = env;
    const resourceRoot = join(spec.dir, "resources");
    let reopened: typeof handle | undefined;
    try {
      const one = await env.capture("one");
      const input = {
        requestId: "root-lost-done-reopen",
        text: "original done result survives reopen",
        resourceHead: one.head,
        whenBusy: "followUp" as const,
        trace,
      };
      const db = new DatabaseSync(join(spec.dir, "replica.sqlite"));
      const readRun = () =>
        JSON.parse(
          String(
            db.prepare("SELECT value FROM local_runs WHERE request_id=?").get(input.requestId)
              ?.value,
          ),
        );
      try {
        db.exec(
          `CREATE TRIGGER lose_done_receipt BEFORE UPDATE ON local_runs WHEN OLD.request_id='root-lost-done-reopen' AND json_extract(NEW.value,'$.admitted')=1 BEGIN SELECT RAISE(FAIL,'owned done receipt failure'); END`,
        );
        bench.faux.setResponses([text("actual original SDK result before reopen")]);
        await assert.rejects(
          handle.submit(input),
          (cause) => cause instanceof ClassifiedFailure && cause.disposition === "unknown",
        );
        await waitFor(
          async () => (await handle.submission({ requestId: input.requestId }))?.status === "done",
          "the real lost-receipt SDK input to finish",
        );
        await waitFor(
          async () => !(await handle.busy()).tasks && !(await handle.busy()).run,
          "no active run or Inbox work before reopen",
        );
        const original = readRun();
        assert.equal(original.admitted, false);
        const submission = await handle.submission({ requestId: input.requestId });
        assert.ok(submission?.answerEntryId);
        db.exec("DROP TRIGGER lose_done_receipt");
        const version = createHash("sha256").update(JSON.stringify(one.resources)).digest("hex");
        const path = join(resourceRoot, version, "AGENTS.md");
        if (damage === "EACCES") await chmod(resourceRoot, 0);
        else {
          await chmod(path, 0o600);
          await writeFile(path, "damaged after done before reopen");
        }
        await handle.close(trace, 5_000);
        const sdk = new DatabaseSync(join(spec.dir, "session.sqlite"), { readOnly: true });
        const counts = () =>
          ["tasks", "submissions", "entries"].map((table) =>
            sdk.prepare(`SELECT count(*) AS n FROM ${table}`).get(),
          );
        try {
          const before = counts();
          const providers = bench.faux.state.callCount;
          const errors = bench.records.filter((record) => record.level === "error").length;
          reopened = await bench.runtime.open(spec);
          assert.deepEqual(await reopened.submission({ requestId: input.requestId }), submission);
          assert.deepEqual(readRun().intent, original.intent);
          assert.equal(readRun().admitted, true);
          assert.equal(readRun().rejected, false);
          assert.deepEqual(counts(), before);
          assert.equal(bench.faux.state.callCount, providers);
          assert.equal(bench.records.filter((record) => record.level === "error").length, errors);
          const history = await reopened.history({ limit: 50 });
          assert.match(JSON.stringify(history), /actual original SDK result before reopen/);
          const { resourceHead: _head, ...omitted } = input;
          assert.deepEqual(await reopened.submit(omitted), submission);
          assert.equal(bench.faux.state.callCount, providers);
        } finally {
          sdk.close();
        }
      } finally {
        db.close();
      }
    } finally {
      await chmod(resourceRoot, 0o700).catch(() => undefined);
      await reopened?.close(trace, 5_000);
      await handle.close(trace, 5_000);
      await bench.cleanup();
    }
  });
}

test("resource edits from an unindexed complete P0 branch publish a local head without copying foreign history", async () => {
  const bench = await createBench();
  const peer = await createBench();
  let handle: Awaited<ReturnType<typeof bench.runtime.open>> | undefined;
  let target: typeof handle;
  try {
    const carriers = await sourceCarriers(join(bench.dir, "foreign-source"));
    const base = carriers[1];
    assert.ok(base && base.parents.length === 1);
    const legacy = await seedP0(bench, base);
    await legacy.harness.close(ctx);
    handle = await bench.runtime.open(bench.spec());
    const replica = handle.replica?.bind(handle);
    assert.ok(replica);
    const call = (method: Parameters<typeof replica>[0]["method"], params: unknown) =>
      replica({ method, params, trace });
    const db = new DatabaseSync(join(bench.spec().dir, "session.sqlite"), { readOnly: true });
    const count = () => Number(db.prepare("SELECT count(*) AS n FROM entries").get()?.n);
    const before = count();
    const resources = JSON.parse(
      await readFile(
        new URL("../../../../fixtures/bots-sync/resources.v1.json", import.meta.url),
        "utf8",
      ),
    ) as HistoryBundle["resources"];
    const edited = (await call("export", { head: base.head, resources })) as HistoryBundle;
    assert.deepEqual(edited.parents, [base.head]);
    assert.notEqual(edited.source.replicaId, base.source.replicaId);
    assert.deepEqual(edited.agent, base.agent);
    assert.deepEqual(Object.values(edited.origins), Object.values(base.origins));
    assert.deepEqual(
      edited.entries.map((entry) => ({ kind: entry.kind, model: entry.model, data: entry.data })),
      base.entries.map((entry) => ({ kind: entry.kind, model: entry.model, data: entry.data })),
    );
    assert.equal(
      count(),
      before,
      "only bounded forks and receipts are written, no duplicate SDK history entries",
    );
    assert.deepEqual(await call("export", { head: base.head, resources }), edited);
    assert.equal(count(), before);
    db.close();
    const page = pageSchema.parse(await call("pull", { after: 0 }));
    assert.equal(page.source.replicaId, edited.source.replicaId);
    assert.ok(
      page.events.some(
        (event) =>
          event.body.kind === "head" &&
          event.body.head === edited.head &&
          event.body.meta.source.replicaId === page.source.replicaId,
      ),
    );
    assert.equal(
      page.events.filter(
        (event) =>
          event.body.kind === "entry" && event.body.origin.replicaId === base.source.replicaId,
      ).length,
      0,
      "foreign source facts are not republished as new local entries",
    );
    assert.equal(bench.faux.state.callCount, 0);
    target = await peer.runtime.open(peer.spec());
    assert.ok(target.replica);
    await target.replica({ method: "bind", params: { sharedBotId: page.sharedBotId }, trace });
    await target.replica({ method: "import", params: { bundle: base }, trace });
    await target.replica({ method: "apply", params: { page }, trace });
    const exported = await target.replica({
      method: "export",
      params: { head: edited.head },
      trace,
    });
    assert.deepEqual(exported, edited);
    assert.equal(peer.faux.state.callCount, 0);
    await assert.rejects(call("export", { head: "0".repeat(64), resources }), /unknown/);
    await assert.rejects(
      call("export", { head: base.head, branch: "bad-combination", resources }),
      /select one/,
    );
    await assert.rejects(
      call("export", { head: base.head, resources: [{ ...resources[0], sha256: "0".repeat(64) }] }),
      /resource bytes/,
    );
  } finally {
    await handle?.close(trace, 5_000);
    await target?.close(trace, 5_000);
    await Promise.all([bench.cleanup(), peer.cleanup()]);
  }
});

test("tool-group reconfiguration keeps the active root resource version after native tools", async () => {
  const env = await setup();
  const { bench, handle, spec } = env;
  const release = Promise.withResolvers<void>();
  let entered = false;
  const sections: string[] = [];
  try {
    const one = await env.capture("one");
    bench.faux.setResponses([
      async (request) => {
        const section =
          getCurrentSystemMessage(request.messages)?.sections?.["bots-resources"] ?? "";
        sections.push(section);
        const skill = /^Skill directory: (.+)$/m.exec(section)?.[1];
        assert.ok(skill);
        entered = true;
        await release.promise;
        return assistant([toolCall("bash", { command: `bash '${skill}/scripts/nested/run.sh'` })], {
          stopReason: "toolUse",
        });
      },
      (request) => {
        sections.push(
          getCurrentSystemMessage(request.messages)?.sections?.["bots-resources"] ?? "",
        );
        return text("resource-preserving tool refresh completed");
      },
    ]);
    await handle.submit({
      requestId: "root-refresh-active",
      text: "keep my selected resources during refresh",
      resourceHead: one.head,
      whenBusy: "followUp",
      trace,
    });
    await waitFor(() => entered, "real provider before tool-group reconfiguration");
    assert.ok(handle.configureToolGroups);
    await handle.configureToolGroups(["core", "coding"], trace);
    release.resolve();
    await waitFor(
      async () =>
        (await handle.submission({ requestId: "root-refresh-active" }))?.status === "done",
      "the refreshed root round",
    );
    assert.equal(sections.length, 2);
    assert.match(sections[0] ?? "", /version-one/);
    assert.equal(
      sections[1],
      sections[0],
      "changing tool groups cannot drop the resource section after tools",
    );
    assert.deepEqual(await readFile(join(spec.dir, "workspace/result.bin")), expectedBytes(one));
  } finally {
    release.resolve();
    await handle.close(trace, 5_000);
    await bench.cleanup();
  }
});

test("root compaction child and tool handOver retain the first placed v1 before queued v2", async () => {
  // Exceed the SDK's unchanged 20k recent-token retention with actual old history.
  const env = await setup(`old immutable context ${"retained original bytes ".repeat(5_000)}`);
  const { bench, handle, spec, call, baseline } = env;
  const release = Promise.withResolvers<void>();
  let entered = false;
  const rounds = new Map<string, number>();
  const seen: string[] = [];
  let summaries = 0;
  try {
    const one = await env.capture("one");
    const two = await env.capture("two");
    const respond = async (request: TranscriptContext) => {
      if (
        request.messages.some(
          (message) =>
            message.role === "system" &&
            typeof message.content === "string" &&
            message.content.includes("context summarization assistant"),
        )
      ) {
        summaries += 1;
        return text("Real compaction summary of the original root history.");
      }
      const marker = [...request.messages]
        .reverse()
        .find(
          (message) =>
            message.role === "user" &&
            (message.content === "compact-active-one" || message.content === "compact-queued-two"),
        );
      assert.ok(marker);
      const label = String(marker.content);
      const bundle = label === "compact-active-one" ? one : two;
      const version = createHash("sha256").update(JSON.stringify(bundle.resources)).digest("hex");
      const system = getCurrentSystemMessage(request.messages);
      const section = system?.sections?.["bots-resources"] ?? "";
      assert.match(section, new RegExp(`Resource version: ${version}`));
      assert.deepEqual(
        getCurrentTools(request.messages),
        getCurrentTools(baseline?.messages ?? []),
      );
      const skill = /^Skill directory: (.+)$/m.exec(section)?.[1];
      assert.ok(skill);
      seen.push(label);
      const round = (rounds.get(label) ?? 0) + 1;
      rounds.set(label, round);
      if (label === "compact-active-one" && round === 1) {
        entered = true;
        await release.promise;
      }
      if (label === "compact-active-one" && round === 2)
        return providerError("maximum context length exceeded");
      if (round === 1 || (label === "compact-active-one" && round === 3))
        return assistant(
          [
            toolCall("bash", {
              command: `bash '${skill}/scripts/nested/run.sh' && mv result.bin '${label}.bin'`,
            }),
          ],
          { stopReason: "toolUse" },
        );
      return text(`${label} done after original input`);
    };
    bench.faux.setResponses(Array.from({ length: 7 }, () => respond));
    const active = await handle.submit({
      requestId: "compact-active-one",
      text: "compact-active-one",
      resourceHead: one.head,
      whenBusy: "followUp",
      trace,
    });
    await waitFor(() => entered, "real resource run before compaction/tool child");
    const queued = await handle.submit({
      requestId: "compact-queued-two",
      text: "compact-queued-two",
      resourceHead: two.head,
      whenBusy: "followUp",
      trace,
    });
    assert.equal(queued.status, "queued");
    release.resolve();
    await waitFor(
      async () => (await handle.submission({ requestId: queued.requestId }))?.status === "done",
      "the post-compaction queued version",
    );
    assert.equal(summaries, 1);
    assert.deepEqual(seen, [
      "compact-active-one",
      "compact-active-one",
      "compact-active-one",
      "compact-active-one",
      "compact-queued-two",
      "compact-queued-two",
    ]);
    const settled = await handle.submission({ requestId: active.requestId });
    assert.equal(settled?.id, active.id);
    assert.equal(settled?.entryId, active.entryId);
    assert.equal(settled?.status, "done");
    for (const [label, bundle] of [
      ["compact-active-one", one],
      ["compact-queued-two", two],
    ] as const)
      assert.deepEqual(
        await readFile(join(spec.dir, "workspace", `${label}.bin`)),
        expectedBytes(bundle),
      );
    const raw = (await call("export", {})) as HistoryBundle;
    assert.ok(
      raw.entries.some(
        (entry) =>
          entry.kind === "pi.compaction" &&
          entry.head !== undefined &&
          entry.byTaskId !== undefined,
      ),
    );
    const tools = raw.entries.filter((entry) => entry.kind === "pi.tool-result");
    assert.equal(tools.length, 3);
    assert.ok(
      new Set(
        raw.entries.filter((entry) => entry.kind === "pi.assistant").map((entry) => entry.byTaskId),
      ).size >= 3,
      "real generation handOver creates distinct task owners",
    );
    for (const entry of one.entries)
      assert.deepEqual(
        raw.entries.find((item) => item.id === entry.id),
        entry,
      );
    for (const [id, origin] of Object.entries(one.origins))
      assert.deepEqual(raw.origins[id], origin);
  } finally {
    release.resolve();
    await handle.close(trace, 5_000);
    await bench.cleanup();
  }
});
