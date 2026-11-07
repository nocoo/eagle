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

const declare = async (
  stack: { readonly port: number; readonly token: string },
  botId: string,
  body: Uint8Array,
  id = uploadId,
) =>
  fetch(`http://127.0.0.1:${stack.port}/v1/bots/${botId}/files/${id}/manifest`, {
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
  });

const declareAndUpload = async (
  stack: { readonly port: number; readonly token: string },
  botId: string,
  body: Uint8Array,
  id = uploadId,
) => {
  const manifest = await declare(stack, botId, body, id);
  assert.equal(manifest.status, 201);
  const content = await fetch(
    `http://127.0.0.1:${stack.port}/v1/bots/${botId}/files/${id}/content`,
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

test("a durable requestId wins before queued, terminal and reopened attachment validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-file-retry-"));
  let botId = "";
  let firstFileId = "";
  let terminalEntryId = "";
  const terminalRequestId = "r_file_terminal_0001";
  const queuedRequestId = "r_file_queued_0001";
  let first: Awaited<ReturnType<typeof startStack>> | undefined;

  const nextSubmission = async (
    frames: ReturnType<typeof frameQueue>,
    requestId: string,
    status?: "queued" | "placed" | "done" | "unanswered",
  ) => {
    for (;;) {
      const frame = await frames.next(10_000);
      if (frame.type === "error") assert.fail(`unexpected ${String(frame.kind)} for ${requestId}`);
      if (frame.type === "submission" && frame.requestId === requestId) {
        if (status === undefined || frame.status === status) return frame;
      }
    }
  };

  try {
    first = await startStack({ real: true, root });
    botId = await first.createBot("附件重试");
    const otherBotId = await first.createBot("其他 Bot");
    const firstFile = await declareAndUpload(first, botId, Buffer.from("first"));
    firstFileId = firstFile.id;
    const alternateFile = await declareAndUpload(
      first,
      botId,
      Buffer.from("alternate"),
      "u_e2e_file_alternate",
    );
    const pending = await declare(first, botId, Buffer.from("pending"), "u_e2e_file_pending");
    assert.equal(pending.status, 201);
    const pendingFile = (await pending.json()) as { file: { id: string } };
    const crossBotFile = await declareAndUpload(
      first,
      otherBotId,
      Buffer.from("cross"),
      "u_e2e_file_crossbot",
    );

    first.faux?.setResponses([text("已完成")]);
    const socket = first.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: "tr_file_retry_sub_01" });
    await frames.next();
    await send(socket, {
      type: "send",
      requestId: terminalRequestId,
      text: "终态附件",
      fileIds: [firstFileId],
      whenBusy: "followUp",
      trace: "tr_file_retry_send_01",
    });
    const terminal = await nextSubmission(frames, terminalRequestId, "done");
    terminalEntryId = String(terminal.entryId);

    for (const [index, fileIds] of [
      [2, [alternateFile.id]],
      [3, [pendingFile.file.id]],
      [4, [crossBotFile.id]],
      [5, [`f_${"0".repeat(64)}`]],
      [6, undefined],
    ] as const) {
      await send(socket, {
        type: "send",
        requestId: terminalRequestId,
        text: `终态重试 ${index}`,
        ...(fileIds === undefined ? {} : { fileIds }),
        whenBusy: "followUp",
        trace: `tr_file_retry_send_0${index}`,
      });
      const retry = await nextSubmission(frames, terminalRequestId);
      assert.equal(retry.submissionId, terminal.submissionId);
      assert.equal(retry.entryId, terminalEntryId);
      assert.equal(retry.status, "done");
    }

    let releaseBlocker: (() => void) | undefined;
    const blockerGate = new Promise<ReturnType<typeof text>>((resolve) => {
      releaseBlocker = () => resolve(text("占用结束"));
    });
    first.faux?.setResponses([() => blockerGate, text("排队已完成")]);
    await send(socket, {
      type: "send",
      requestId: "r_file_blocker_0001",
      text: "占住运行",
      whenBusy: "followUp",
      trace: "tr_file_retry_blocker_1",
    });
    await nextSubmission(frames, "r_file_blocker_0001");
    await send(socket, {
      type: "send",
      requestId: queuedRequestId,
      text: "排队附件",
      fileIds: [firstFileId],
      whenBusy: "followUp",
      trace: "tr_file_retry_queued_1",
    });
    const queued = await nextSubmission(frames, queuedRequestId, "queued");
    await send(socket, {
      type: "send",
      requestId: queuedRequestId,
      text: "排队重试",
      fileIds: [pendingFile.file.id],
      whenBusy: "followUp",
      trace: "tr_file_retry_queued_2",
    });
    const queuedRetry = await nextSubmission(frames, queuedRequestId);
    assert.equal(queuedRetry.submissionId, queued.submissionId);
    assert.equal(queuedRetry.status, "queued");

    await send(socket, { type: "resync", trace: "tr_file_retry_snap_01" });
    for (;;) {
      const frame = await frames.next(10_000);
      if (frame.type !== "snapshot") continue;
      const value = frame.value as {
        messages: { id: string; requestId?: string; files?: { id: string }[] }[];
        pending: { requestId: string; submissionId: string }[];
      };
      const terminalEntries = value.messages.filter(
        (message) => message.requestId === terminalRequestId,
      );
      assert.equal(terminalEntries.length, 1);
      assert.equal(terminalEntries[0]?.id, terminalEntryId);
      assert.equal(terminalEntries[0]?.files?.[0]?.id, firstFileId);
      assert.deepEqual(
        value.pending.find((record) => record.requestId === queuedRequestId)?.submissionId,
        queued.submissionId,
      );
      break;
    }

    releaseBlocker?.();
    await nextSubmission(frames, queuedRequestId, "done");
    await send(socket, { type: "resync", trace: "tr_file_retry_snap_queued" });
    for (;;) {
      const frame = await frames.next(10_000);
      if (frame.type !== "snapshot") continue;
      const queuedEntries = (
        frame.value as {
          messages: { requestId?: string; files?: { id: string }[] }[];
        }
      ).messages.filter((message) => message.requestId === queuedRequestId);
      assert.equal(queuedEntries.length, 1);
      assert.equal(queuedEntries[0]?.files?.[0]?.id, firstFileId);
      break;
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
    await send(socket, { type: "subscribe", botId, trace: "tr_file_retry_sub_02" });
    const baseline = await frames.next();
    assert.equal(baseline.type, "snapshot");
    for (const [index, fileIds] of [
      [1, [`f_${"f".repeat(64)}`]],
      [2, undefined],
    ] as const) {
      await send(socket, {
        type: "send",
        requestId: terminalRequestId,
        text: `重启后重试 ${index}`,
        ...(fileIds === undefined ? {} : { fileIds }),
        whenBusy: "followUp",
        trace: `tr_file_retry_reopen_${index}`,
      });
      const retry = await nextSubmission(frames, terminalRequestId);
      assert.equal(retry.status, "done");
      assert.equal(retry.entryId, terminalEntryId);
    }
    await send(socket, { type: "resync", trace: "tr_file_retry_snap_02" });
    for (;;) {
      const frame = await frames.next(10_000);
      if (frame.type !== "snapshot") continue;
      const messages = (
        frame.value as {
          messages: { id: string; requestId?: string; files?: { id: string }[] }[];
        }
      ).messages;
      const matches = messages.filter((message) => message.id === terminalEntryId);
      assert.equal(matches.length, 1);
      assert.equal(matches[0]?.files?.[0]?.id, firstFileId);
      break;
    }
    socket.close();
  } finally {
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});
