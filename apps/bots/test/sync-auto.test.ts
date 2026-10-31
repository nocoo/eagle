import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { BotRegistry, ReadyReplica } from "../src/core/BotRegistry.ts";
import { ClassifiedFailure } from "../src/core/domain.ts";
import { newFailure } from "../src/core/failures.ts";
import { declareEvent } from "../src/log/events.ts";
import { captureLog } from "../src/log/log.ts";
import { AutomaticSync } from "../src/sync-auto.ts";
import {
  type AuthenticatedSync,
  type SyncAttempt,
  SyncRemoteError,
  SyncTransportError,
} from "../src/sync-pull.ts";
import { objectFixture } from "./support/sync-object.ts";

async function settle() {
  await setImmediate();
  await setImmediate();
}
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000000 });
  const f = objectFixture(),
    root = mkdtempSync(join(tmpdir(), "bots-auto-")),
    { log, records } = captureLog();
  let received = 0,
    applied = 0,
    known = f.manifest.nextAfter;
  const remote = { replicaId: f.manifest.source.replicaId, epoch: f.manifest.source.epoch };
  const local = { replicaId: f.record.binding.replicaId, epoch: f.record.binding.epoch };
  const replica: ReadyReplica = {
    botId: f.record.botId,
    sharedBotId: f.manifest.sharedBotId,
    binding: f.record.binding,
    check: async () => {},
    publish: async (action, guard) => {
      guard();
      action();
    },
    command: async (method, _params, guard) => {
      guard?.();
      assert.equal(method, "status");
      return {
        streams: [
          { source: local, known, received: known, applied: known },
          { source: remote, known: f.manifest.nextAfter, received, applied },
        ],
      };
    },
  };
  const page = {
    objectId: f.manifest.objectId,
    source: remote,
    included: f.manifest.included,
    nextAfter: f.manifest.nextAfter,
    hasMore: false,
  };
  const calls = { upload: 0, list: 0, receive: 0, apply: 0, pull: 0, probe: 0 };
  const api = {
    publishDescriptor: async () => ({}),
    cachePublish: async (_bot: string, _input: unknown, _trace: string, attempt: SyncAttempt) => {
      calls.upload++;
      attempt.guard();
      attempt.prepared?.(f.manifest);
      return {
        cloudCached: true,
        firstCachedAt: Date.now(),
        expiresAt: Date.now() + 72 * 3600000,
        page,
      };
    },
    cacheList: async (..._args: unknown[]): Promise<unknown> => {
      calls.list++;
      return {
        version: 1,
        objects: [
          { objectId: page.objectId, expiresAt: Date.now() + 60000, included: page.included },
        ],
        gaps: [],
        nextAfter: page.nextAfter,
        hasMore: false,
        complete: false,
      };
    },
    cacheReceive: async (_bot: string, _input: unknown, _trace: string, attempt: SyncAttempt) => {
      attempt.guard();
      attempt.admit?.();
      calls.receive++;
    },
    storedObject: async () => false,
    applyObject: async (
      _bot: string,
      _id: string,
      _trace: string,
      attempt: SyncAttempt,
    ): Promise<unknown> => {
      attempt.guard();
      attempt.admit?.();
      calls.apply++;
      received = page.nextAfter;
      applied = page.nextAfter;
      return { applied: await replica.command("status", {}) };
    },
    pull: async (
      _bot: string,
      _input: unknown,
      _trace: string,
      attempt: SyncAttempt,
      probe?: boolean,
    ): Promise<unknown> => {
      attempt.guard();
      if (probe) calls.probe++;
      else {
        attempt.admit?.();
        calls.pull++;
        received = page.nextAfter;
        applied = page.nextAfter;
      }
      return { page: { source: remote } };
    },
  };
  const registry = { readyReplica: async () => replica } as unknown as BotRegistry;
  const auto = new AutomaticSync(root, registry, api as unknown as AuthenticatedSync, log);
  t.after(() => {
    auto.close();
    rmSync(root, { force: true, recursive: true });
  });
  return {
    f,
    root,
    records,
    replica,
    api,
    auto,
    calls,
    remote,
    page,
    setKnown: (value: number) => {
      known = value;
    },
    registry,
    log,
    configure: (direction: "publish" | "receive" | "both" = "both") =>
      auto.put(
        f.record.botId,
        f.descriptor.deviceId,
        { direction, source: remote },
        "tr_auto_config",
      ),
    tick: async (ms = 1000) => {
      t.mock.timers.tick(ms);
      await settle();
    },
    state: () =>
      auto.list(f.record.botId, "tr_auto_status") as Promise<{
        connections: {
          state: string;
          transport: string;
          peerApplied: string;
          cloudCached: unknown;
        }[];
      }>,
    preferences: () => JSON.parse(readFileSync(join(root, "sync-connections/v1.json"), "utf8")),
  };
}

test("explicit preferences survive reopen, capture binding, bound32 and never store a credential or peer ACK", async (t) => {
  const h = fixture(t);
  await h.configure();
  const saved = h.preferences();
  assert.deepEqual(saved.connections[0].binding, h.f.record.binding);
  assert.equal(JSON.stringify(saved).includes("authority"), false);
  const reopened = new AutomaticSync(
    h.root,
    h.registry,
    h.api as unknown as AuthenticatedSync,
    h.log,
  );
  try {
    assert.equal(
      ((await reopened.list(h.f.record.botId, "tr_reopen")) as { connections: unknown[] })
        .connections.length,
      1,
    );
  } finally {
    reopened.close();
  }
  for (let i = 1; i < 32; i++)
    await h.auto.put(
      h.f.record.botId,
      `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      { direction: "publish" },
      "tr_limit",
    );
  await assert.rejects(
    h.auto.put(
      h.f.record.botId,
      "00000000-0000-4000-8000-999999999999",
      { direction: "publish" },
      "tr_limit",
    ),
    (e) => e instanceof ClassifiedFailure && e.failure.kind === "limit_exceeded",
  );
  await h.auto.remove(h.f.record.botId, h.f.descriptor.deviceId, "tr_disable");
  assert.equal(h.preferences().connections.length, 31);
  writeFileSync(join(h.root, "sync-connections/v1.json"), "broken");
  const broken = new AutomaticSync(
    h.root,
    h.registry,
    h.api as unknown as AuthenticatedSync,
    h.log,
  );
  try {
    await assert.rejects(
      broken.list(h.f.record.botId, "tr_broken"),
      (e) =>
        e instanceof ClassifiedFailure &&
        e.failure.kind === "storage_failed" &&
        e.cause instanceof SyntaxError,
    );
    await assert.rejects(
      broken.remove(h.f.record.botId, h.f.descriptor.deviceId, "tr_broken"),
      (e) => e instanceof ClassifiedFailure && e.failure.kind === "storage_failed",
    );
    broken.start();
    await h.tick();
    assert.equal(h.calls.pull, 0);
    assert.equal(h.calls.upload, 0);
    assert.equal(readFileSync(join(h.root, "sync-connections/v1.json"), "utf8"), "broken");
  } finally {
    broken.close();
  }
});

test("a saved binding mismatch before the first turn has one runtime origin without any transfer", async (t) => {
  const h = fixture(t);
  await h.configure("receive");
  const current = {
    ...h.replica,
    binding: { ...h.replica.binding, epoch: "00000000-0000-4000-8000-000000000001" },
  };
  let trace = "";
  h.registry.readyReplica = async (_botId, turnTrace) => {
    trace = turnTrace;
    return current;
  };
  h.auto.start();
  await h.tick();
  assert.deepEqual(h.calls, { upload: 0, list: 0, receive: 0, apply: 0, pull: 0, probe: 0 });
  const origins = h.records.filter((row) => row.level === "error");
  assert.equal(origins.length, 1, "the controller-created refusal needs its own origin");
  const origin = origins[0];
  assert(origin);
  assert.equal(origin.evt, "runtime.sync.fail");
  assert.equal(origin.layer, "runtime");
  assert.equal(origin.trace, trace);
  assert.equal(origin.botId, h.f.record.botId);
  assert(origin.err);
  assert.equal(origin.err.kind, "auth_failed");
  assert.equal(origin.err.origin, true);
  assert.match(origin.err.failure, /^f_[a-f0-9]{12}$/);
  assert.equal(h.records.filter((row) => row.err?.failure === origin.err?.failure).length, 1);
});

test("a lower classified ready failure retains its exact origin, trace, Bot and failure ID", async (t) => {
  const h = fixture(t);
  await h.configure("receive");
  const failure = newFailure("storage_failed", "core");
  const classified = new ClassifiedFailure(failure, "not_admitted", "owned lower storage refusal");
  let trace = "";
  h.registry.readyReplica = async (_botId, turnTrace) => {
    trace = turnTrace;
    h.log.emit("error", "core", declareEvent("core.sync.fail"), {
      trace,
      botId: h.f.record.botId,
      failure,
      origin: true,
    });
    throw classified;
  };
  h.auto.start();
  await h.tick();
  const origins = h.records.filter((row) => row.level === "error");
  assert.equal(origins.length, 1);
  assert.deepEqual(origins[0]?.err, { kind: "storage_failed", failure: failure.id, origin: true });
  assert.equal(origins[0]?.trace, trace);
  assert.equal(origins[0]?.botId, h.f.record.botId);
  assert.equal(
    h.records.some((row) => row.evt === "runtime.sync.fail"),
    false,
  );
  assert.deepEqual(h.calls, { upload: 0, list: 0, receive: 0, apply: 0, pull: 0, probe: 0 });
});

test("a committed receive with failed apply survives reopen and retries only the owned local object", async (t) => {
  const h = fixture(t);
  let received = 0,
    applied = 0,
    healthy = false;
  h.replica.command = async () => ({
    streams: [
      {
        source: h.remote,
        known: h.page.nextAfter,
        received,
        applied,
        available: received ? [{ from: 1, to: received }] : [],
      },
    ],
  });
  h.api.pull = async () => {
    throw new SyncTransportError("sync_network_unreachable");
  };
  h.api.applyObject = async (_bot, _id, _trace, attempt) => {
    attempt.guard();
    attempt.admit?.();
    h.calls.apply++;
    received = h.page.nextAfter;
    if (!healthy)
      throw new ClassifiedFailure(
        newFailure("storage_failed", "runtime"),
        "unknown",
        "owned apply I/O",
      );
    applied = received;
    return { applied: await h.replica.command("status", {}) };
  };
  await h.configure("receive");
  h.auto.start();
  await h.tick();
  assert.equal(received, h.page.nextAfter);
  assert.equal(applied, 0);
  assert.equal(h.preferences().connections[0].pendingApply, h.page.objectId);
  await h.configure("receive");
  assert.equal(h.preferences().connections[0].pendingApply, h.page.objectId);
  h.auto.close();
  const network = { list: h.calls.list, receive: h.calls.receive };
  healthy = true;
  h.api.pull = async () => {
    assert.fail("pending local apply cannot require a peer");
  };
  h.api.cacheList = async () => {
    assert.fail("pending local apply cannot require CF");
  };
  const reopened = new AutomaticSync(
    h.root,
    h.registry,
    h.api as unknown as AuthenticatedSync,
    h.log,
  );
  try {
    reopened.start();
    await h.tick();
    assert.equal(applied, received);
    assert.equal(h.calls.apply, 2);
    assert.deepEqual({ list: h.calls.list, receive: h.calls.receive }, network);
    assert.equal(h.preferences().connections[0].pendingApply, undefined);
  } finally {
    reopened.close();
  }
});

test("pending local apply cannot revive a disabled, rebound or closed preference", async (t) => {
  for (const boundary of ["disable", "rebind", "close"])
    await t.test(boundary, async (sub) => {
      const h = fixture(sub);
      h.api.pull = async () => {
        throw new SyncTransportError("sync_network_unreachable");
      };
      h.api.applyObject = async (_bot, _id, _trace, attempt) => {
        attempt.guard();
        h.calls.apply++;
        throw new ClassifiedFailure(
          newFailure("storage_failed", "runtime"),
          "unknown",
          "owned apply I/O",
        );
      };
      await h.configure("receive");
      h.auto.start();
      await h.tick();
      assert.equal(h.preferences().connections[0].pendingApply, h.page.objectId);
      if (boundary === "disable")
        await h.auto.remove(h.f.record.botId, h.f.descriptor.deviceId, "tr_disable_pending");
      if (boundary === "close") h.auto.close();
      if (boundary === "rebind")
        h.registry.readyReplica = async () => ({
          ...h.replica,
          binding: { ...h.replica.binding, epoch: "00000000-0000-4000-8000-000000000001" },
        });
      await h.tick();
      assert.equal(h.calls.apply, 1);
      assert.equal(h.calls.receive, 1);
    });
});

test("direct receive and independent cache upload progress in separate slots; actual received/applied stays separate from peerApplied", async (t) => {
  const h = fixture(t);
  await h.configure();
  h.auto.start();
  await h.tick();
  assert.equal(h.calls.pull, 1);
  assert.equal(h.calls.upload, 1);
  assert.equal(h.calls.list, 0);
  const state = await h.state();
  assert.equal(state.connections[0]?.peerApplied, "unknown");
  assert(state.connections[0]?.cloudCached);
});

test("an actual preference permission failure keeps the original bytes and one storage origin without starting sync", async (t) => {
  const h = fixture(t);
  await h.configure();
  const path = join(h.root, "sync-connections/v1.json"),
    original = readFileSync(path);
  chmodSync(path, 0);
  const unreadable = new AutomaticSync(
    h.root,
    h.registry,
    h.api as unknown as AuthenticatedSync,
    h.log,
  );
  try {
    await assert.rejects(
      unreadable.list(h.f.record.botId, "tr_permission"),
      (error) =>
        error instanceof ClassifiedFailure &&
        error.failure.kind === "storage_failed" &&
        (error.cause as NodeJS.ErrnoException).code === "EACCES",
    );
    await assert.rejects(
      unreadable.put(
        h.f.record.botId,
        h.f.descriptor.deviceId,
        { direction: "publish" },
        "tr_permission",
      ),
      (error) => error instanceof ClassifiedFailure && error.failure.kind === "storage_failed",
    );
    unreadable.start();
    await h.tick();
    assert.equal(h.calls.pull, 0);
    assert.equal(h.calls.upload, 0);
    assert.equal(h.records.filter((row) => row.level === "error" && row.err?.origin).length, 1);
  } finally {
    unreadable.close();
    chmodSync(path, 0o600);
  }
  assert.deepEqual(readFileSync(path), original);
});

test("close synchronously invalidates a late attempt before its receive admission", async (t) => {
  const h = fixture(t);
  let release: () => void = () => {};
  h.api.pull = async (_bot, _input, _trace, attempt) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    attempt.guard();
    attempt.admit?.();
    h.calls.pull++;
    return { page: { source: h.remote } };
  };
  await h.configure("receive");
  h.auto.start();
  await h.tick();
  h.auto.close();
  release();
  await settle();
  await h.tick(3000);
  assert.equal(h.calls.pull, 0);
  assert.equal(h.calls.list, 0);
  assert.equal(h.calls.apply, 0);
});

test("transport refusal falls back immediately but upstream storage/auth/protocol refusal cannot select cache", async (t) => {
  const h = fixture(t);
  let failure: Error = new ClassifiedFailure(
    newFailure("storage_failed"),
    "not_admitted",
    "SQL unavailable",
  );
  h.api.pull = async () => {
    throw failure;
  };
  await h.configure("receive");
  h.auto.start();
  await h.tick();
  assert.equal(h.calls.list, 0);
  failure = new SyntaxError("bad JSON");
  await h.tick();
  assert.equal(h.calls.list, 0);
  failure = new ClassifiedFailure(newFailure("auth_failed"), "not_admitted", "grant revoked");
  await h.tick();
  assert.equal(h.calls.list, 0);
  failure = new ClassifiedFailure(newFailure("internal"), "not_admitted", "network", {
    cause: new SyncTransportError("sync_network_unreachable"),
  });
  await h.tick();
  assert.equal(h.calls.list, 1);
  assert.equal(h.calls.apply, 1);
  assert.equal((await h.state()).connections[0]?.transport, "cache");
});

test("soft deadline races at most two and disable invalidates a late candidate at its actual admission", async (t) => {
  const h = fixture(t);
  let releaseDirect: (() => void) | undefined, releaseCache: (() => void) | undefined;
  h.api.pull = async (_bot, _input, _trace, attempt) => {
    attempt.connecting?.();
    await new Promise<void>((resolve) => {
      releaseDirect = resolve;
    });
    attempt.guard();
    attempt.admit?.();
    h.calls.pull++;
    return { page: { source: h.remote } };
  };
  h.api.cacheReceive = async (_bot, _input, _trace, attempt) => {
    await new Promise<void>((resolve) => {
      releaseCache = resolve;
    });
    attempt.guard();
    attempt.admit?.();
    h.calls.receive++;
  };
  await h.configure();
  h.auto.start();
  await h.tick();
  assert.equal(h.calls.upload, 1);
  assert.equal(h.calls.list, 0);
  await h.tick(2500);
  assert.equal(h.calls.list, 1);
  await h.auto.remove(h.f.record.botId, h.f.descriptor.deviceId, "tr_disable");
  releaseCache?.();
  releaseDirect?.();
  await settle();
  assert.equal(h.calls.receive, 0);
  assert.equal(h.calls.pull, 0);
  assert.equal(h.calls.apply, 0);
});

test("private authorization waiting cannot start the network handshake fallback deadline", async (t) => {
  const h = fixture(t);
  let release: () => void = () => {};
  h.api.pull = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    throw new ClassifiedFailure(
      newFailure("storage_failed"),
      "not_admitted",
      "private SQL unavailable",
    );
  };
  try {
    await h.configure("receive");
    h.auto.start();
    await h.tick();
    await h.tick(2500);
    assert.equal(h.calls.list, 0, "private-channel wait is not a network timeout");
  } finally {
    release();
    await settle();
  }
});

test("cache residence requires spaced full probes and resets the consecutive streak on a failed exchange", async (t) => {
  const h = fixture(t);
  const normal = h.api.pull;
  let available = false;
  h.api.pull = async (...args) => {
    if (!available) throw new SyncTransportError("sync_network_unreachable");
    return normal(...args);
  };
  await h.configure("receive");
  h.auto.start();
  await h.tick();
  available = true;
  await h.tick(15000);
  assert.equal(h.calls.probe, 1);
  await h.tick(14000);
  assert.equal(h.calls.probe, 1);
  available = false;
  await h.tick(1000);
  available = true;
  await h.tick(15000);
  assert.equal(h.calls.probe, 2);
  assert.equal((await h.state()).connections[0]?.transport, "cache");
  await h.tick(15000);
  assert.equal(h.calls.probe, 3);
  assert.equal((await h.state()).connections[0]?.transport, "cache");
  await h.tick();
  assert.equal((await h.state()).connections[0]?.transport, "direct");
});

test("successful full probes are spaced from completion even when the first handshake was slow", async (t) => {
  const h = fixture(t),
    normal = h.api.pull;
  let calls = 0,
    release: () => void = () => {};
  h.api.pull = async (_bot, _input, _trace, attempt, probe) => {
    if (!probe) {
      if (!calls) throw new SyncTransportError("sync_network_unreachable");
      return normal(_bot, _input, _trace, attempt);
    }
    calls++;
    if (calls === 1)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    attempt.guard();
    return { page: { source: h.remote } };
  };
  await h.configure("receive");
  h.auto.start();
  await h.tick();
  await h.tick(15000);
  assert.equal(calls, 1);
  await h.tick(14000);
  release();
  await settle();
  await h.tick(1000);
  assert.equal(calls, 1, "two completed successes cannot be one second apart");
  await h.tick(14000);
  assert.equal(calls, 2);
  await h.tick();
  assert.equal((await h.state()).connections[0]?.transport, "direct");
});

test("unknown upload ACK reopens at the same objectId; only exact event TTL refusal skips, and bounded split returns to page batching", async (t) => {
  const h = fixture(t);
  let mode = "io";
  const selectors: unknown[] = [];
  h.api.cachePublish = async (_bot, input, _trace, attempt) => {
    selectors.push(input);
    attempt.guard();
    attempt.prepared?.(h.f.manifest);
    if (mode === "io") throw new SyncTransportError("sync_network_unreachable");
    throw new ClassifiedFailure(newFailure("auth_failed"), "not_admitted", "expired", {
      cause: new SyncRemoteError(410, mode),
    });
  };
  await h.configure("publish");
  h.auto.start();
  await h.tick();
  assert.equal(h.preferences().connections[0].upload.pending.objectId, h.page.objectId);
  mode = "sync_cache_expired";
  await h.tick();
  assert.deepEqual(selectors[1], {
    peerDeviceId: h.f.descriptor.deviceId,
    objectId: h.page.objectId,
  });
  assert.equal(h.preferences().connections[0].upload.after, 0);
  assert(h.preferences().connections[0].upload.pending);
  mode = "sync_cache_event_expired";
  await h.tick();
  const recovery = h.preferences().connections[0].upload;
  if (h.page.included.length === 1) assert.equal(recovery.after, h.page.included[0]?.seq);
  else {
    assert.equal(recovery.after, 0);
    assert.equal(recovery.single, true);
    assert.equal(recovery.splitThrough, h.page.nextAfter);
  }
});

test("a slow full probe cannot hold up an available cache page", async (t) => {
  const h = fixture(t);
  let first = true;
  h.api.pull = async (_bot, _input, _trace, _attempt, probe) => {
    if (first) {
      first = false;
      throw new SyncTransportError("sync_network_unreachable");
    }
    assert(probe);
    return new Promise(() => {});
  };
  await h.configure("receive");
  h.auto.start();
  await h.tick();
  const before = h.calls.list;
  await h.tick(15000);
  assert.equal(
    h.calls.list,
    before + 1,
    "CF must start while the authenticated probe is still pending",
  );
});

test("a source already in the durable ready status is usable without a source preference", async (t) => {
  const h = fixture(t);
  const remote = {
    replicaId: "00000000-0000-4000-8000-000000000022",
    epoch: "00000000-0000-4000-8000-000000000023",
  };
  const command = h.replica.command;
  h.replica.command = async (method, params, guard) => {
    const result = (await command(method, params, guard)) as { streams: unknown[] };
    return {
      ...result,
      streams: [...result.streams, { source: remote, known: 1, received: 0, applied: 0 }],
    };
  };
  h.api.pull = async () => {
    throw new SyncTransportError("sync_network_unreachable");
  };
  await h.auto.put(
    h.f.record.botId,
    h.f.descriptor.deviceId,
    { direction: "receive" },
    "tr_without_source",
  );
  h.auto.start();
  await h.tick();
  assert.equal(h.calls.list, 1);
});

test("real preference I/O failure cannot activate an unpersisted PUT and concurrent PUTs cannot exceed32", async (t) => {
  const h = fixture(t);
  writeFileSync(join(h.root, "sync-connections"), "owned path obstruction");
  await assert.rejects(
    h.configure(),
    (e) =>
      e instanceof ClassifiedFailure &&
      e.failure.kind === "storage_failed" &&
      (e.cause as NodeJS.ErrnoException).code === "EEXIST",
  );
  await assert.rejects(
    h.state(),
    (e) => e instanceof ClassifiedFailure && e.failure.kind === "storage_failed",
  );
  h.auto.start();
  await h.tick();
  assert.equal(h.calls.pull, 0);
  assert.equal(h.calls.upload, 0);
  rmSync(join(h.root, "sync-connections"));
  await assert.rejects(
    h.configure(),
    (e) => e instanceof ClassifiedFailure && e.failure.kind === "storage_failed",
  );
  const reopened = new AutomaticSync(
    h.root,
    h.registry,
    h.api as unknown as AuthenticatedSync,
    h.log,
  );
  try {
    const outcomes = await Promise.allSettled(
      Array.from({ length: 33 }, (_, i) =>
        reopened.put(
          h.f.record.botId,
          `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          { direction: "receive" },
          "tr_concurrent",
        ),
      ),
    );
    assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 32);
    assert.equal((await reopened.list(h.f.record.botId, "tr_concurrent")).connections.length, 32);
    assert.equal(h.preferences().connections.length, 32);
  } finally {
    reopened.close();
  }
});

test("persisted unknown mixed upload retries the exact ID after restart, probes both original digests and resumes128 at the window end", async (t) => {
  const h = fixture(t);
  const original = {
    ...h.f.manifest,
    included: [
      { seq: 1, eventDigest: "a".repeat(64) },
      { seq: 2, eventDigest: "b".repeat(64) },
    ],
    nextAfter: 2,
    hasMore: true,
  };
  h.setKnown(3);
  h.api.cachePublish = async (_bot, _input, _trace, attempt) => {
    attempt.prepared?.(original);
    throw new SyncTransportError("sync_network_unreachable");
  };
  await h.configure("publish");
  h.auto.start();
  await h.tick();
  h.auto.close();
  const selectors: { objectId?: string; after?: number; limit?: number }[] = [];
  h.api.cachePublish = async (_bot, input, _trace, attempt) => {
    const selector = input as { objectId?: string; after?: number; limit?: number };
    selectors.push(selector);
    const seq = selector.after === undefined ? undefined : selector.after + 1;
    const manifest = selector.objectId
      ? original
      : {
          ...original,
          objectId: (seq === 1 ? "c" : "d").repeat(64),
          included: original.included.filter((event) => event.seq === seq),
          nextAfter: seq as number,
          hasMore: true,
        };
    attempt.prepared?.(manifest);
    if (selector.objectId || seq === 1)
      throw new ClassifiedFailure(newFailure("auth_failed"), "not_admitted", "expired", {
        cause: new SyncRemoteError(410, "sync_cache_event_expired"),
      });
    return {
      cloudCached: true,
      firstCachedAt: Date.now(),
      expiresAt: Date.now() + 72 * 3600000,
      page: {
        objectId: manifest.objectId,
        source: manifest.source,
        included: manifest.included,
        nextAfter: manifest.nextAfter,
        hasMore: manifest.hasMore,
      },
    };
  };
  const reopened = new AutomaticSync(
    h.root,
    h.registry,
    h.api as unknown as AuthenticatedSync,
    h.log,
  );
  try {
    reopened.start();
    await h.tick();
    assert.equal(selectors[0]?.objectId, original.objectId);
    assert.equal(h.preferences().connections[0].upload.after, 0);
    await h.tick();
    assert.equal(selectors[1]?.limit, 1);
    assert.equal(selectors[1]?.after, 0);
    await h.tick();
    assert.equal(selectors[2]?.limit, 1);
    assert.equal(selectors[2]?.after, 1);
    const progress = h.preferences().connections[0].upload;
    assert.equal(progress.after, 2);
    assert.equal(progress.expiredThrough, 1);
    assert.equal(progress.single, false);
    assert.equal(progress.cloudCached.nextAfter, 2);
    await h.tick();
    assert.equal(selectors[3]?.limit, 128);
    assert.equal(selectors[3]?.after, 2);
  } finally {
    reopened.close();
  }
});

test("a missing early event keeps received honest while tail scanning and a second gap visit reuse full local objects", async (t) => {
  const h = fixture(t),
    remote = {
      replicaId: "00000000-0000-4000-8000-000000000033",
      epoch: "00000000-0000-4000-8000-000000000034",
    };
  const ids = ["a".repeat(64), "b".repeat(64)],
    held = new Set<string>(),
    queries: number[] = [];
  let available: { from: number; to: number }[] = [];
  h.replica.command = async () => ({
    streams: [{ source: remote, known: 300, received: 0, applied: 0, available }],
  });
  h.api.pull = async () => {
    throw new SyncTransportError("sync_network_unreachable");
  };
  Object.assign(h.api, {
    storedObject: async (_bot: string, object: { objectId: string }) => held.has(object.objectId),
  });
  h.api.cacheList = async (_bot?: unknown, input?: unknown) => {
    h.calls.list++;
    const after = (input as { after: number }).after;
    queries.push(after);
    const index = after < 128 ? 0 : 1,
      objectId = ids[index] as string;
    return {
      version: 1,
      objects:
        after >= 256
          ? []
          : [
              {
                objectId,
                expiresAt: Date.now() + 60000,
                included: Array.from({ length: 127 }, (_, i) => ({
                  seq: (index === 0 ? 2 : 129) + i,
                  eventDigest: "e".repeat(64),
                })),
              },
            ],
      gaps: after < 128 ? [{ seq: 1, reason: "pending" }] : [],
      nextAfter: after >= 256 ? after : index === 0 ? 128 : 256,
      hasMore: after < 128,
      complete: false,
    };
  };
  h.api.cacheReceive = async (_bot, input, _trace, attempt) => {
    attempt.guard();
    attempt.admit?.();
    h.calls.receive++;
    held.add((input as { objectId: string }).objectId);
  };
  h.api.applyObject = async (_bot, id, _trace, attempt) => {
    attempt.guard();
    attempt.admit?.();
    h.calls.apply++;
    available = [{ from: 2, to: id === ids[0] ? 128 : 256 }];
    return { applied: await h.replica.command("status", {}) };
  };
  await h.auto.put(
    h.f.record.botId,
    h.f.descriptor.deviceId,
    { direction: "receive", source: remote },
    "tr_gaps",
  );
  h.auto.start();
  for (let i = 0; i < 5; i++) await h.tick();
  assert.equal(held.size, 2);
  assert.equal(
    h.calls.receive,
    2,
    "already complete local objects must not be downloaded on each gap visit",
  );
  assert.equal(h.calls.apply, 2, "no new facts must not repeatedly apply identical stored pages");
  assert(
    queries.filter((after) => after === 0).length >= 2,
    "second missing-event visit is required",
  );
  assert(
    queries.some((after) => after >= 256),
    "tail scanning remains independent of the missing early event",
  );
});

test("another source drains the held dependency through existing SDK semantics without another body or ineffective apply", async (t) => {
  const h = fixture(t),
    first = h.remote,
    second = {
      replicaId: "00000000-0000-4000-8000-000000000043",
      epoch: "00000000-0000-4000-8000-000000000044",
    };
  const held = new Set<string>(),
    ids = ["a".repeat(64), "b".repeat(64)],
    received = [0, 0],
    applied = [0, 0];
  h.replica.command = async () => ({
    streams: [first, second].map((source, i) => ({
      source,
      known: 1,
      received: received[i],
      applied: applied[i],
      available: received[i] ? [{ from: 1, to: 1 }] : [],
    })),
  });
  h.api.pull = async () => {
    throw new SyncTransportError("sync_network_unreachable");
  };
  Object.assign(h.api, {
    storedObject: async (_bot: string, object: { objectId: string }) => held.has(object.objectId),
  });
  h.api.cacheList = async (_bot?: unknown, input?: unknown) => {
    h.calls.list++;
    const source = (input as { source: typeof first }).source,
      index = source.replicaId === first.replicaId ? 0 : 1;
    return {
      version: 1,
      objects: [
        {
          objectId: ids[index],
          expiresAt: Date.now() + 60000,
          included: [{ seq: 1, eventDigest: "e".repeat(64) }],
        },
      ],
      gaps: [],
      nextAfter: 1,
      hasMore: false,
      complete: false,
    };
  };
  h.api.cacheReceive = async (_bot, input, _trace, attempt) => {
    attempt.guard();
    attempt.admit?.();
    h.calls.receive++;
    held.add((input as { objectId: string }).objectId);
  };
  h.api.applyObject = async (_bot, id, _trace, attempt) => {
    attempt.guard();
    attempt.admit?.();
    h.calls.apply++;
    received[id === ids[0] ? 0 : 1] = 1;
    // ReplicaSync.#drain loops every source until no progress; the real SDK case asserts that behavior.
    if (received.every((value) => value === 1)) {
      applied[0] = 1;
      applied[1] = 1;
    }
    return { applied: await h.replica.command("status", {}) };
  };
  await h.configure("receive");
  h.auto.start();
  for (let i = 0; i < 5; i++) await h.tick();
  assert.deepEqual(applied, [1, 1]);
  assert.equal(h.calls.receive, 2);
  assert.equal(h.calls.apply, 2);
});

for (const [status, code, cleared] of [
  [410, "sync_relay_delivery_unavailable", true],
  [410, "sync_relay_expired", false],
  [403, "sync_relay_delivery_mismatch", false],
  [503, "sync_relay_storage_failed", false],
] as const)
  test(`persisted relay ACK ${code} clears only an explicitly unavailable current-authorized delivery`, async (t) => {
    const h = fixture(t);
    await h.configure("receive");
    h.auto.close();
    const saved = h.preferences();
    saved.connections[0].pendingReceipt = {
      peerDeviceId: h.f.descriptor.deviceId,
      delivery: {
        requestId: "00000000-0000-4000-8000-000000000001",
        sessionId: "a".repeat(43),
        objectId: h.page.objectId,
        source: h.remote,
      },
    };
    writeFileSync(join(h.root, "sync-connections/v1.json"), JSON.stringify(saved));
    let acknowledgements = 0;
    Object.assign(h.api, {
      relayAck: async () => {
        acknowledgements++;
        throw new SyncRemoteError(status, code);
      },
    });
    const reopened = new AutomaticSync(
      h.root,
      h.registry,
      h.api as unknown as AuthenticatedSync,
      h.log,
    );
    try {
      reopened.start();
      await h.tick();
      assert.equal(acknowledgements, 1);
      assert.equal(h.preferences().connections[0].pendingReceipt === undefined, cleared);
      assert.equal(h.calls.apply, 0);
      assert.equal(h.calls.receive, 0);
      assert.equal(h.calls.list, 0);
    } finally {
      reopened.close();
    }
  });

test("durable status metadata has one independent slot and never waits for a direct or upload attempt", async (t) => {
  const h = fixture(t);
  let reports = 0,
    reads = 0,
    release: (() => void) | undefined;
  const api = h.api as typeof h.api & {
    canRelay(): boolean;
    relayRegister(): Promise<unknown>;
    statusReport(
      bot: string,
      input: unknown,
      trace: string,
      attempt: SyncAttempt,
    ): Promise<unknown>;
    statusRead(bot: string, input: unknown, trace: string, attempt: SyncAttempt): Promise<unknown>;
  };
  api.canRelay = () => true;
  api.relayRegister = async () => ({});
  api.statusReport = async (_bot, _input, _trace, attempt) => {
    reports++;
    await new Promise<void>((done) => {
      release = done;
    });
    attempt.guard();
    return { version: 1, recorded: true };
  };
  api.statusRead = async (_bot, _input, _trace, attempt) => {
    reads++;
    attempt.guard();
    return {
      version: 1,
      snapshots: [
        {
          registryOrigin: h.f.manifest.registryOrigin,
          sharedBotId: h.f.manifest.sharedBotId,
          holder: h.f.publisher,
          receiver: h.f.publisher,
          binding: h.f.record.binding,
          source: h.remote,
          received: 6,
          applied: 2,
          recordedAt: Date.now(),
        },
      ],
      hasMore: false,
    };
  };
  await h.configure();
  h.auto.start();
  await h.tick();
  assert.equal(reports, 1, "receive direction automatically reports persistent status");
  await h.tick(3000);
  assert.equal(reports, 1, "a held metadata action consumes the sole slot");
  assert(h.calls.pull > 0);
  assert(h.calls.upload > 0, "metadata is independent of upload");
  release?.();
  await settle();
  await h.tick();
  assert.equal(reads, 1, "publish direction independently reads peer progress");
  const learned = await h.auto.list(h.f.record.botId, "tr_metadata_snapshot");
  const snapshot = learned.connections[0]?.peerApplied;
  assert(snapshot && typeof snapshot !== "string");
  assert.equal(snapshot.current, "unknown");
  assert.equal(snapshot.snapshots[0]?.applied, 2);
  assert.equal(snapshot.snapshots[0]?.received, 6);

  await h.auto.remove(h.f.record.botId, h.f.descriptor.deviceId, "tr_metadata_delete");
  await h.tick(5000);
  assert.equal(reports, 1);
  assert.equal(reads, 1);
});
