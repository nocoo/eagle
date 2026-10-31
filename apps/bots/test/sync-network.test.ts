import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import type { BotRegistry, ReadyReplica } from "../src/core/BotRegistry.ts";
import type { DeviceSyncPort } from "../src/core/DeviceSyncPort.ts";
import { ClassifiedFailure } from "../src/core/domain.ts";
import { captureLog } from "../src/log/log.ts";
import { AuthenticatedSync, syncRemoteFailure, syncTransportFailure } from "../src/sync-pull.ts";
import { objectFixture } from "./support/sync-object.ts";

test("real TCP refusal and truncated response are transport; remote SQL/auth and bad JSON preserve refusal and one failure origin", async () => {
  const f = objectFixture(),
    { log, records } = captureLog();
  let mode = "sql",
    port = 0;
  const server = createServer((_request, response) => {
    if (mode === "truncated") {
      response.writeHead(200, { "content-type": "application/json", "content-length": "2000" });
      response.write('{"proof":');
      response.socket?.end();
      return;
    }
    if (mode === "json") {
      response.end("{");
      return;
    }
    response.writeHead(mode === "sql" ? 503 : 403, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: {
          code: mode === "sql" ? "sync_storage_failed" : "sync_not_shared",
          failure: {
            id: "f_owned_remote",
            kind: mode === "sql" ? "storage_failed" : "auth_failed",
            layer: "runtime",
          },
        },
      }),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  port = address.port;
  const replica: ReadyReplica = {
    botId: f.record.botId,
    sharedBotId: f.manifest.sharedBotId,
    binding: f.record.binding,
    check: async () => {},
    publish: async (action, guard) => {
      guard();
      action();
    },
    command: async () => {
      throw new Error("must not reach SDK");
    },
  };
  // Only the typed device port is a double; every HTTP/body/TCP operation is real owned loopback I/O.
  const device = {
    version: 1,
    access: async () => ({
      version: 1,
      sharedBotId: f.manifest.sharedBotId,
      purpose: "replica.read",
      local: f.publisher,
      peer: f.publisher,
      endpoints: {
        identity: f.publisher,
        publishedAt: Date.now(),
        candidates: [{ address: "127.0.0.1", port }],
      },
    }),
  } as unknown as DeviceSyncPort;
  const sync = new AuthenticatedSync({
    registry: { readyReplica: async () => replica } as unknown as BotRegistry,
    device,
    log,
  });
  const call = (trace: string) =>
    sync.pull(f.record.botId, { peerDeviceId: f.publisher.deviceId, after: 0, limit: 128 }, trace);
  try {
    for (mode of ["sql", "auth", "json", "truncated"]) {
      const trace = `tr_network_${mode}`;
      await assert.rejects(call(trace), (error) => {
        assert(error instanceof ClassifiedFailure);
        assert.equal(syncTransportFailure(error), mode === "truncated");
        if (mode === "sql" || mode === "auth") {
          assert.equal(error.failure.id, "f_owned_remote");
          assert.equal(syncRemoteFailure(error)?.status, mode === "sql" ? 503 : 403);
          assert.equal(records.filter((row) => row.trace === trace && row.err?.origin).length, 0);
        } else {
          assert(error.cause instanceof Error);
          assert.equal(records.filter((row) => row.trace === trace && row.err?.origin).length, 1);
        }
        return true;
      });
    }
    await new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
    await assert.rejects(
      call("tr_network_refused"),
      (error) =>
        error instanceof ClassifiedFailure &&
        syncTransportFailure(error) &&
        error.cause instanceof Error &&
        error.cause.cause instanceof Error,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      sync.pull(
        f.record.botId,
        { peerDeviceId: f.publisher.deviceId, after: 0, limit: 128 },
        "tr_active_abort",
        {
          replica,
          signal: controller.signal,
          guard() {
            if (controller.signal.aborted) throw new Error("sync_attempt_cancelled");
          },
        },
      ),
      (error) => error instanceof ClassifiedFailure && !syncTransportFailure(error),
    );
    assert.equal(JSON.stringify(records).includes("127.0.0.1"), false);
  } finally {
    sync.close();
    if (server.listening)
      await new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
  }
});
