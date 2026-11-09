import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import WebSocket from "ws";
import { command, hello } from "../src/protocol.ts";
import { ChatRuntime } from "../src/runtime.ts";
import { startService } from "../src/server.ts";

type Frame = {
  type: string;
  id?: string;
  value?: unknown;
  code?: string;
  proof?: string;
  serverNonce?: string;
  identity?: { rootBinding: string; instance: string };
};
async function client(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/chat`, {
    maxPayload: 256 * 1024,
    followRedirects: false,
    handshakeTimeout: 1000,
  });
  const frames: Frame[] = [];
  socket.on("message", (bytes) => frames.push(JSON.parse(bytes.toString())));
  await once(socket, "open");
  async function wait(predicate: (frame: Frame) => boolean) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const index = frames.findIndex(predicate);
      if (index >= 0) {
        const frame = frames.splice(index, 1)[0];
        assert.ok(frame);
        return frame;
      }
      if (socket.readyState === WebSocket.CLOSED) throw new Error("socket_closed");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("frame_timeout");
  }
  return {
    socket,
    frames,
    wait,
    async authenticate(token: string) {
      const nonce = randomBytes(16).toString("hex");
      socket.send(JSON.stringify({ type: "hello", nonce }));
      const challenge = await wait((f) => f.type === "challenge");
      const identity = challenge.identity;
      assert.ok(identity);
      assert.match(challenge.serverNonce ?? "", /^[0-9a-f]{32}$/);
      assert.equal(
        challenge.proof,
        createHmac("sha256", token)
          .update(
            `${nonce}\n${challenge.serverNonce}\n127.0.0.1:${port}\n${identity.rootBinding}\n${identity.instance}`,
          )
          .digest("hex"),
      );
      const proof = createHmac("sha256", token)
        .update(`client\n${nonce}\n${challenge.serverNonce}\n${identity.instance}`)
        .digest("hex");
      socket.send(JSON.stringify({ type: "authenticate", proof }));
      await wait((f) => f.type === "ready");
      await wait((f) => f.type === "snapshot");
      return { nonce, proof, serverNonce: challenge.serverNonce };
    },
    async call(type: string, fields: Record<string, unknown> = {}) {
      const id = `cmd_${randomBytes(8).toString("hex")}`;
      socket.send(JSON.stringify({ type, id, ...fields }));
      return wait((f) => f.id === id);
    },
  };
}

test("SG001-B fixtures and schemas reject unknown command authority", async () => {
  const base = new URL("../../../fixtures/superagent-protocol/", import.meta.url);
  assert.ok(
    hello.safeParse(JSON.parse(await readFile(new URL("hello.client.json", base), "utf8"))).success,
  );
  assert.ok(
    command.safeParse(JSON.parse(await readFile(new URL("send.client.json", base), "utf8")))
      .success,
  );
  assert.equal(command.safeParse({ type: "delete", id: "cmd_00001" }).success, false);
  assert.equal(
    command.safeParse({ type: "state", id: "cmd_00001", workerId: "b_abc" }).success,
    false,
  );
});

test("SG001-B: verified socket configures, streams and acknowledges durable independent chat", {
  timeout: 10000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "superagent-socket-"));
  const faux = fauxProvider({
    provider: "superagent",
    models: [{ id: "test-model" }],
    tokensPerSecond: 10000,
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const options = { root, port: 0, openRuntime: (dir: string) => ChatRuntime.open(dir, models) };
  const service = await startService(options);
  let peer: Awaited<ReturnType<typeof client>> | undefined;
  try {
    peer = await client(service.port);
    await peer.authenticate((await readFile(join(root, "token"), "utf8")).trim());
    const config = await peer.call("configure", {
      configuration: {
        baseUrl: "http://127.0.0.1:1/v1",
        model: "test-model",
        thinkingLevel: "medium",
        apiKey: "fixture-key",
      },
    });
    assert.equal(config.type, "result");
    assert.equal(JSON.stringify(config).includes("fixture-key"), false);
    faux.setResponses([fauxAssistantMessage("A real durable answer")]);
    assert.equal(
      (await peer.call("send", { requestId: "request_0001", text: "hello" })).type,
      "result",
    );
    await peer.wait(
      (f) => f.type === "snapshot" && JSON.stringify(f.value).includes("A real durable answer"),
    );
    let answer: Frame;
    do {
      answer = await peer.call("submission", { requestId: "request_0001" });
    } while ((answer.value as { status: string }).status !== "done");
    assert.equal((answer.value as { answer: string }).answer, "A real durable answer");
    assert.equal(
      (await peer.call("send", { requestId: "request_0001", text: "hello" })).type,
      "result",
    );
    assert.equal(faux.state.callCount, 1);
    assert.equal((await peer.call("delete")).code, "invalid_command");
    const page = await peer.call("history", { limit: 100 });
    assert.equal((page.value as { messages: unknown[] }).messages.length, 2);
  } finally {
    peer?.socket.terminate();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("unauthenticated commands and a wrong challenge response never configure a model", {
  timeout: 10000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "superagent-auth-"));
  const service = await startService({ root, port: 0 });
  let peer: Awaited<ReturnType<typeof client>> | undefined;
  try {
    peer = await client(service.port);
    const closed = once(peer.socket, "close");
    peer.socket.send(
      JSON.stringify({ type: "send", id: "cmd_00001", requestId: "request_0001", text: "no" }),
    );
    assert.equal((await closed)[0], 1008);
    peer = await client(service.port);
    peer.socket.send(JSON.stringify({ type: "hello", nonce: "a".repeat(32) }));
    await peer.wait((f) => f.type === "challenge");
    const rejected = once(peer.socket, "close");
    peer.socket.send(JSON.stringify({ type: "authenticate", proof: "0".repeat(64) }));
    assert.equal((await rejected)[0], 4001);
  } finally {
    peer?.socket.terminate();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an old authentication proof cannot be replayed on another socket with the same client nonce", async () => {
  const root = await mkdtemp(join(tmpdir(), "superagent-replay-"));
  const service = await startService({ root, port: 0 });
  const peers: Awaited<ReturnType<typeof client>>[] = [];
  try {
    const first = await client(service.port);
    peers.push(first);
    const old = await first.authenticate((await readFile(join(root, "token"), "utf8")).trim());
    const second = await client(service.port);
    peers.push(second);
    second.socket.send(JSON.stringify({ type: "hello", nonce: old.nonce }));
    const fresh = await second.wait((f) => f.type === "challenge");
    assert.notEqual(fresh.serverNonce, old.serverNonce);
    const closed = once(second.socket, "close");
    second.socket.send(JSON.stringify({ type: "authenticate", proof: old.proof }));
    assert.equal((await closed)[0], 4001);
  } finally {
    for (const peer of peers) peer.socket.terminate();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("verified command errors, versioned state and idle abort are explicit", async () => {
  const root = await mkdtemp(join(tmpdir(), "superagent-commands-"));
  const service = await startService({ root, port: 0 });
  const peer = await client(service.port);
  try {
    await peer.authenticate((await readFile(join(root, "token"), "utf8")).trim());
    assert.equal(
      (await peer.call("send", { requestId: "request_0001", text: "hello" })).code,
      "unconfigured",
    );
    const state = await peer.call("state");
    assert.equal((state.value as { type: string }).type, "snapshot");
    assert.equal((state.value as { instance: string }).instance, service.identity.instance);
    assert.deepEqual((await peer.call("abort")).value, { stopped: true });
    assert.equal((await peer.call("submission", { requestId: "missing_request01" })).value, null);
    assert.equal(
      (
        await peer.call("configure", {
          configuration: {
            baseUrl: "http://127.0.0.1:1/v1",
            model: "test-model",
            thinkingLevel: "off",
          },
        })
      ).type,
      "result",
    );
    assert.equal(
      (await peer.call("send", { requestId: "request_0002", text: "x".repeat(8001) })).code,
      "limit_exceeded",
    );
    peer.socket.send(JSON.stringify({ type: "state", id: 2 }));
    assert.equal((await peer.wait((f) => f.type === "error")).code, "invalid_command");
  } finally {
    peer.socket.terminate();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed JSON, binary frames and invalid authentication are closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "superagent-frames-"));
  const service = await startService({ root, port: 0 });
  try {
    for (const payload of ["{", Buffer.from("binary")]) {
      const peer = await client(service.port);
      const closed = once(peer.socket, "close");
      peer.socket.send(payload);
      assert.equal((await closed)[0], 1008);
    }
    const peer = await client(service.port);
    peer.socket.send(JSON.stringify({ type: "hello", nonce: "a".repeat(32) }));
    await peer.wait((f) => f.type === "challenge");
    const closed = once(peer.socket, "close");
    peer.socket.send(JSON.stringify({ type: "authenticate", proof: "bad" }));
    assert.equal((await closed)[0], 4001);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown websocket path and browser origin are refused before authentication", async () => {
  const root = await mkdtemp(join(tmpdir(), "superagent-upgrade-"));
  const service = await startService({ root, port: 0 });
  try {
    for (const [path, origin] of [
      ["/other", undefined],
      ["/v1/chat", "https://example.invalid"],
    ] as const) {
      const socket = new WebSocket(
        `ws://127.0.0.1:${service.port}${path}`,
        origin ? { origin } : {},
      );
      await assert.rejects(once(socket, "open"), /403/);
    }
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("observation commands answer a provider value, never a socket error, when unconfigured", async () => {
  const root = await mkdtemp(join(tmpdir(), "superagent-observe-socket-"));
  const service = await startService({ root, port: 0 });
  let peer: Awaited<ReturnType<typeof client>> | undefined;
  try {
    peer = await client(service.port);
    await peer.authenticate((await readFile(join(root, "token"), "utf8")).trim());
    const snapshot = await peer.call("observe-snapshot", {});
    assert.equal(snapshot.type, "result", "an unavailable provider is a value, not a socket error");
    const value = snapshot.value as { provider: { state: string }; snapshot: unknown };
    assert.equal(value.provider.state, "unconfigured");
    assert.equal(value.snapshot, null);
    const history = await peer.call("observe-history", { botId: "b_3f1a" });
    assert.equal(history.type, "result");
    assert.equal((history.value as { provider: { state: string } }).provider.state, "unconfigured");
    const changes = await peer.call("observe-changes", { limit: 5 });
    assert.equal(changes.type, "result");
    assert.equal((changes.value as { provider: { state: string } }).provider.state, "reset");
  } finally {
    peer?.socket.close();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a binary frame is refused and a burst past the queue limit closes the socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "superagent-limits-"));
  const service = await startService({ root, port: 0 });
  const token = (await readFile(join(root, "token"), "utf8")).trim();
  let peer: Awaited<ReturnType<typeof client>> | undefined;
  try {
    peer = await client(service.port);
    await peer.authenticate(token);
    const closed = once(peer.socket, "close");
    peer.socket.send(Buffer.from("binary"));
    assert.equal((await closed)[0], 1008);
    peer = await client(service.port);
    await peer.authenticate(token);
    const burst = once(peer.socket, "close");
    for (let index = 0; index < 40; index += 1) {
      peer.socket.send(
        JSON.stringify({ type: "state", id: `cmd_burst_${String(index).padStart(4, "0")}` }),
      );
    }
    assert.equal((await burst)[0], 1008);
  } finally {
    peer?.socket.close();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
