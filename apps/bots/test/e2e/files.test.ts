import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { text } from "../support/pi.ts";
import { frameQueue, hello, send, startStack } from "../support/server.ts";

const uploadId = "u_e2e_file_012345678";

const digest = (body: Uint8Array): string => createHash("sha256").update(body).digest("hex");

const declareAndUpload = async (
  stack: { readonly port: number; readonly token: string },
  botId: string,
  body: Uint8Array,
) => {
  const manifest = await fetch(
    `http://127.0.0.1:${stack.port}/v1/bots/${botId}/files/${uploadId}/manifest`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${stack.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "payload.bin",
        mimeType: "application/octet-stream",
        size: body.length,
        sha256: digest(body),
      }),
    },
  );
  assert.equal(manifest.status, 201);
  const content = await fetch(
    `http://127.0.0.1:${stack.port}/v1/bots/${botId}/files/${uploadId}/content`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${stack.token}`,
        "content-type": "application/octet-stream",
      },
      body: body as unknown as never,
    },
  );
  assert.equal(content.status, 201);
  const { file } = (await content.json()) as {
    file: { id: string; name: string; mimeType: string; size: number; sha256: string };
  };
  return file;
};

test("real SQLite file sends project paths into model context and replay files without bytes or paths in the wire", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-file-e2e-"));
  let botId = "";
  let fileId = "";
  let modelRequest = "";
  let first: Awaited<ReturnType<typeof startStack>> | undefined;
  try {
    first = await startStack({ real: true, root });
    botId = await first.createBot("附件回复");
    const body = Buffer.from([0, 1, 2, 255, 128]);
    const file = await declareAndUpload(first, botId, body);
    fileId = file.id;

    first.faux?.setResponses([
      (context) => {
        modelRequest = JSON.stringify(context.messages);
        return text("附件已收到，我会按需读取。");
      },
    ]);

    const socket = first.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: "tr_e2e_file_001" });
    await frames.next();
    await send(socket, {
      type: "send",
      requestId: "r_e2e_file_0001",
      text: "请按需读取 payload.bin 并总结",
      fileIds: [fileId],
      whenBusy: "followUp",
      trace: "tr_e2e_file_002",
    });

    let liveUser: Record<string, unknown> | undefined;
    let liveAssistantId: string | undefined;
    for (;;) {
      const frame = await frames.next(10_000);
      if (frame.type === "append" && (frame.message as { role?: string }).role === "user") {
        liveUser = frame.message as unknown as Record<string, unknown>;
      }
      if (
        frame.type === "append" &&
        (frame.message as { role?: string }).role === "assistant" &&
        (frame.message as { state?: string }).state === "complete"
      ) {
        liveAssistantId = (frame.message as { id?: string }).id;
        if (liveUser !== undefined) break;
      }
    }
    assert.deepEqual(
      (liveUser?.files as { id: string }[] | undefined)?.map((ref) => ref.id),
      [fileId],
    );
    assert.equal(
      JSON.stringify(liveUser).includes(root),
      false,
      "wire metadata never carries a path",
    );

    assert.match(modelRequest, /payload\.bin/);
    assert.match(modelRequest, /\/files\/f_/);
    assert.match(modelRequest, /read tool/i);
    assert.doesNotMatch(modelRequest, /\[0,1,2,255,128\]/);

    await send(socket, { type: "resync", trace: "tr_e2e_file_003" });
    for (;;) {
      const frame = await frames.next(10_000);
      if (frame.type === "snapshot") {
        const snapshotUser = (
          frame.value as { messages: { role: string; files?: { id: string }[] }[] }
        ).messages.find((message) => message.role === "user");
        assert.equal(snapshotUser?.files?.[0]?.id, fileId);
        break;
      }
    }

    await send(socket, {
      type: "history",
      before: liveAssistantId ?? "e_7",
      limit: 100,
      trace: "tr_e2e_file_004",
    });
    for (;;) {
      const frame = await frames.next(10_000);
      if (frame.type === "history") {
        const historyUser = (
          frame as unknown as { messages: { role: string; files?: { id: string }[] }[] }
        ).messages.find((message) => message.role === "user");
        assert.equal(historyUser?.files?.[0]?.id, fileId);
        break;
      }
    }
    socket.close();
  } finally {
    await first?.close();
  }

  const second = await startStack({ real: true, root });
  try {
    const socket = second.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: "tr_e2e_file_005" });
    for (;;) {
      const frame = await frames.next(10_000);
      if (frame.type === "snapshot") {
        const user = (
          frame.value as { messages: { role: string; files?: { id: string }[] }[] }
        ).messages.find((message) => message.role === "user");
        assert.equal(user?.files?.[0]?.id, fileId);
        assert.equal(JSON.stringify(frame).includes("/files/"), false);
        break;
      }
    }
    socket.close();
  } finally {
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});
