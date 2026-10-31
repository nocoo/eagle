import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClassifiedFailure } from "../src/core/domain.ts";
import { SocketDeviceSyncPort } from "../src/device-sync.ts";
import { captureLog } from "../src/log/log.ts";

test("the private sync adapter preserves refusal cause/trace and rejects mismatched metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-sync-port-"));
  await chmod(root, 0o700);
  const path = join(root, "access.sock");
  const fixture = JSON.parse(
    await readFile(
      new URL("../../../fixtures/bots-protocol/sync-access.http.json", import.meta.url),
      "utf8",
    ),
  );
  let reply: unknown = { error: "sync_not_shared" };
  const calls: string[] = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (part) => {
      buffer += part;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.trim());
      calls.push(request.method);
      socket.end(`${JSON.stringify({ requestId: request.requestId, ...(reply as object) })}\n`);
    });
  });
  await new Promise<void>((done) => server.listen(path, done));
  await chmod(path, 0o600);
  const { log, records } = captureLog();
  const port = new SocketDeviceSyncPort(path, log);
  const context = { trace: "tr_sync_adapter", botId: "b_sync" };
  const input = { ...fixture.request, sharedBotId: fixture.response.sharedBotId };
  try {
    await assert.rejects(port.access(input, context), (error: unknown) => {
      assert(error instanceof ClassifiedFailure);
      assert.equal(error.failure.kind, "auth_failed");
      assert.equal((error.cause as Error).message, "sync_not_shared");
      assert.equal(records.find((r) => r.err?.origin)?.err?.failure, error.failure.id);
      assert.equal(records.find((r) => r.err?.origin)?.trace, context.trace);
      return true;
    });
    reply = { result: fixture.response };
    assert.deepEqual(await port.access(input, context), fixture.response);
    reply = { result: { version: 1, identity: fixture.response.local } };
    assert.deepEqual(await port.identity(context), (reply as { result: unknown }).result);
    for (const result of [
      { ...fixture.response, sharedBotId: "55555555-5555-4555-8555-555555555555" },
      { ...fixture.response, local: fixture.response.peer },
      {
        ...fixture.response,
        endpoints: { ...fixture.response.endpoints, identity: fixture.response.local },
      },
      { version: 99 },
    ]) {
      reply = { result };
      await assert.rejects(port.access(input, context), (error: unknown) => {
        assert(error instanceof ClassifiedFailure);
        assert.ok(error.cause);
        return true;
      });
    }
    assert.equal(calls.length, 7);
    assert.equal(records.filter((r) => r.level === "error").length, 5);
    assert.equal(JSON.stringify(records).includes(path), false);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});

test("dedicated cache metadata denials retain auth attribution and the original private-port cause", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-cache-denials-"));
  await chmod(root, 0o700);
  const path = join(root, "cache.sock");
  let reason = "sync_wrapping_key_unavailable";
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (part) => {
      buffer += part;
      if (!buffer.includes("\n")) return;
      const input = JSON.parse(buffer);
      socket.end(JSON.stringify({ requestId: input.requestId, error: reason }) + "\n");
    });
  });
  await new Promise<void>((done) => server.listen(path, done));
  await chmod(path, 0o600);
  const { log, records } = captureLog(),
    port = new SocketDeviceSyncPort(path, log),
    context = { trace: "tr_cache_denied", botId: "b_cache_denied" };
  const input = {
    sharedBotId: "11111111-1111-4111-8111-111111111111",
    peerDeviceId: "22222222-2222-4222-8222-222222222222",
    purpose: "replica.read" as const,
  };
  try {
    for (const denial of [
      "sync_wrapping_key_unavailable",
      "invalid_sync_key_descriptor",
      "sync_identity_changed",
      "invalid_sync_cache_authority",
      "sync_cache_authority_expired",
    ]) {
      reason = denial;
      const pending = denial.includes("authority")
        ? port.cacheAuthority(
            {
              version: 1,
              operation: "get",
              sharedBotId: input.sharedBotId,
              peerDeviceId: input.peerDeviceId,
              requestDigest: "a".repeat(64),
            },
            context,
          )
        : port.lookup(input, context);
      await assert.rejects(pending, (error: unknown) => {
        assert(error instanceof ClassifiedFailure);
        assert.equal(error.failure.kind, "auth_failed");
        assert.equal((error.cause as Error).message, denial);
        assert.equal(
          records.filter((row) => row.err?.failure === error.failure.id && row.err.origin).length,
          1,
        );
        return true;
      });
    }
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
