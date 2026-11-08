import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import test from "node:test";
import { MAX_MANAGED_FILE_BYTES } from "../../src/core/ManagedFileStore.ts";
import { frameQueue, hello, send, startStack } from "../support/server.ts";

const uploadId = "u_0123456789abcdef";
const hash = (body: Uint8Array): string => createHash("sha256").update(body).digest("hex");
const base = (stack: { port: number }) => `http://127.0.0.1:${stack.port}`;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const jsonCall = async (
  stack: { port: number; token: string },
  path: string,
  method: string,
  body: unknown,
  token = stack.token,
) =>
  fetch(`${base(stack)}${path}`, {
    method,
    headers: { ...bearer(token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const declare = async (
  stack: { port: number; token: string },
  botId: string,
  body: Uint8Array,
  options: {
    readonly uploadId?: string;
    readonly name?: string;
    readonly mimeType?: string;
    readonly token?: string;
  } = {},
) => {
  const id = options.uploadId ?? uploadId;
  const response = await jsonCall(
    stack,
    `/v1/bots/${botId}/files/${id}/manifest`,
    "PUT",
    {
      name: options.name ?? "report.bin",
      ...(options.mimeType === undefined ? {} : { mimeType: options.mimeType }),
      size: body.byteLength,
      sha256: hash(body),
    },
    options.token,
  );
  return { response, id };
};

const upload = async (
  stack: { port: number; token: string },
  botId: string,
  id: string,
  body: Uint8Array,
  token = stack.token,
) =>
  fetch(`${base(stack)}/v1/bots/${botId}/files/${id}/content`, {
    method: "PUT",
    headers: { ...bearer(token), "content-type": "application/octet-stream" },
    body: body as unknown as never,
  });

const metadata = async (
  stack: { port: number; token: string },
  botId: string,
  fileId: string,
  token = stack.token,
) =>
  fetch(`${base(stack)}/v1/bots/${botId}/files/${fileId}/manifest`, {
    headers: bearer(token),
  });

const download = async (
  stack: { port: number; token: string },
  botId: string,
  fileId: string,
  token = stack.token,
) =>
  fetch(`${base(stack)}/v1/bots/${botId}/files/${fileId}/content`, {
    headers: bearer(token),
  });

const requestWithoutBody = async (options: http.RequestOptions): Promise<http.IncomingMessage> =>
  new Promise((resolve, reject) => {
    const request = http.request(options);
    const timer = setTimeout(() => {
      request.destroy();
      reject(new Error("the server waited to read an unauthorized body"));
    }, 1_000);
    request.on("response", (response) => {
      clearTimeout(timer);
      resolve(response);
    });
    request.on("error", reject);
    request.flushHeaders();
  });

const waitFor = async (condition: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met");
};

test("managed file HTTP upload and download are streamed, scoped and Bot-bound", async () => {
  const stack = await startStack();
  try {
    const botId = await stack.createBot("files");
    const reader = await jsonCall(stack, "/v1/clients", "POST", {
      name: "reader",
      scopes: ["read"],
    });
    const readerToken = ((await reader.json()) as { token: string }).token;
    const writer = await jsonCall(stack, "/v1/clients", "POST", {
      name: "writer",
      scopes: ["write"],
    });
    const writerToken = ((await writer.json()) as { token: string }).token;

    const bytes = Buffer.from([0, 1, 2, 3, 254, 255]);
    const forbidden = await declare(stack, botId, bytes, { token: readerToken });
    assert.equal(forbidden.response.status, 403);
    const first = await declare(stack, botId, bytes, {
      token: writerToken,
      name: "../../name-is-display-only.bin",
      mimeType: "application/x-test",
    });
    assert.equal(first.response.status, 201);
    const pending = (await first.response.json()) as {
      file: { id: string; status: string; name: string; mimeType: string };
    };
    assert.equal(pending.file.status, "uploading");
    const stored = await upload(stack, botId, first.id, bytes, writerToken);
    assert.equal(stored.status, 201);
    const complete = (await stored.json()) as {
      file: { id: string; status: string; size: number; sha256: string; name: string };
    };
    assert.equal(complete.file.id, pending.file.id);
    assert.equal(complete.file.status, "complete");
    assert.equal(complete.file.size, bytes.length);
    assert.equal(complete.file.sha256, hash(bytes));
    assert.equal(complete.file.name, "../../name-is-display-only.bin");

    const downloaded = await download(stack, botId, complete.file.id, readerToken);
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get("content-type"), "application/x-test");
    assert.equal(downloaded.headers.get("content-length"), String(bytes.length));
    assert.equal(downloaded.headers.get("etag"), `"${hash(bytes)}"`);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
    const info = await metadata(stack, botId, complete.file.id, readerToken);
    assert.equal(info.status, 200);
    const infoBody = (await info.json()) as { file: unknown };
    assert.deepEqual(infoBody.file, complete.file);

    const other = await stack.createBot("other");
    assert.equal((await download(stack, other, complete.file.id, readerToken)).status, 404);
    assert.equal((await metadata(stack, "b_missing", complete.file.id, readerToken)).status, 404);
    assert.equal((await download(stack, botId, `../${complete.file.id}`, readerToken)).status, 404);
  } finally {
    await stack.close();
  }
});

test("authentication is settled before raw upload body bytes are read", async () => {
  const stack = await startStack();
  try {
    const botId = await stack.createBot("auth-first");
    const response = await requestWithoutBody({
      host: "127.0.0.1",
      port: stack.port,
      method: "PUT",
      path: `/v1/bots/${botId}/files/${uploadId}/content`,
      headers: { authorization: "Bearer wrong", "content-length": "4096" },
    });
    assert.equal(response.statusCode, 401);
    response.destroy();
  } finally {
    await stack.close();
  }
});

test("manifest and content retries are exact and conflicting bytes never overwrite", async () => {
  const stack = await startStack();
  try {
    const botId = await stack.createBot("idempotent");
    const body = Buffer.from("durable bytes");
    const declared = await declare(stack, botId, body, { mimeType: "text/plain" });
    assert.equal(declared.response.status, 201);
    const samePending = await declare(stack, botId, body, { mimeType: "text/plain" });
    assert.equal(samePending.response.status, 200);
    assert.deepEqual(await samePending.response.json(), await declared.response.json());

    const wrongMetadata = await declare(stack, botId, Buffer.from("different"), {
      mimeType: "text/plain",
    });
    assert.equal(wrongMetadata.response.status, 409);
    const completed = await upload(stack, botId, declared.id, body);
    assert.equal(completed.status, 201);
    const snapshot = (await completed.json()) as unknown;
    const repeated = await upload(stack, botId, declared.id, body);
    assert.equal(repeated.status, 200);
    assert.deepEqual(await repeated.json(), snapshot);

    const conflict = await upload(stack, botId, declared.id, Buffer.from("other content"));
    assert.equal(conflict.status, 409);
    const fileId = (snapshot as { file: { id: string } }).file.id;
    const read = await download(stack, botId, fileId);
    assert.deepEqual(Buffer.from(await read.arrayBuffer()), body);
  } finally {
    await stack.close();
  }
});

test("an interrupted request leaves no completed reference and the same upload id retries", async () => {
  const stack = await startStack();
  try {
    const botId = await stack.createBot("interrupted");
    const body = Buffer.from("finish after reconnect");
    const declared = await declare(stack, botId, body);
    const pending = (await declared.response.json()) as { file: { id: string } };
    await new Promise<void>((resolve) => {
      const request = http.request({
        host: "127.0.0.1",
        port: stack.port,
        method: "PUT",
        path: `/v1/bots/${botId}/files/${uploadId}/content`,
        headers: {
          authorization: `Bearer ${stack.token}`,
          "content-length": String(body.length),
        },
      });
      request.on("error", () => resolve());
      request.write(body.subarray(0, 3));
      setTimeout(() => {
        request.destroy();
        resolve();
      }, 20);
    });
    assert.equal((await metadata(stack, botId, pending.file.id)).status, 404);

    const retried = await upload(stack, botId, uploadId, body);
    assert.equal(retried.status, 201);
    const retriedFile = ((await retried.json()) as { file: { id: string } }).file;
    assert.equal(retriedFile.id, pending.file.id);
  } finally {
    await stack.close();
  }
});

test("file upload takes a Bot lease so delete waits and moves completed storage with the Bot", async () => {
  const stack = await startStack();
  try {
    const botId = await stack.createBot("lease");
    const body = Buffer.from("wait for this body");
    await declare(stack, botId, body);

    let uploadResponse!: http.IncomingMessage;
    let slowRequest: http.ClientRequest | undefined;
    const uploadDone = new Promise<void>((resolve, reject) => {
      const request = http.request({
        host: "127.0.0.1",
        port: stack.port,
        method: "PUT",
        path: `/v1/bots/${botId}/files/${uploadId}/content`,
        headers: {
          authorization: `Bearer ${stack.token}`,
          "content-length": String(body.length),
        },
      });
      request.on("response", (response) => {
        uploadResponse = response;
        response.resume();
        response.on("end", resolve);
      });
      request.on("error", reject);
      slowRequest = request;
      request.write(body.subarray(0, 2));
      void waitFor(async () => {
        const names = await readdir(join(stack.root, "bots", botId, "files")).catch(() => []);
        return names.some((name) => name.endsWith(".part"));
      });
    });

    await waitFor(async () => {
      const names = await readdir(join(stack.root, "bots", botId, "files")).catch(() => []);
      return names.some((name) => name.endsWith(".part"));
    });
    let deleteFinished = false;
    const deleting = fetch(`${base(stack)}/v1/bots/${botId}`, {
      method: "DELETE",
      headers: bearer(stack.token),
    }).then((response) => {
      deleteFinished = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(deleteFinished, false, "delete drains the upload lease");
    slowRequest?.end(body.subarray(2));
    await uploadDone;
    assert.equal(uploadResponse.statusCode, 201);
    assert.equal((await deleting).status, 204);
    assert.ok(
      (await readdir(join(stack.root, "trash", botId, "files"))).some((name) =>
        name.endsWith(".json"),
      ),
    );
    assert.equal((await metadata(stack, botId, `f_${"0".repeat(64)}`)).status, 404);
  } finally {
    await stack.close();
  }
});

test("one byte over 50 MiB and malformed declarations are refused as files, not buffered JSON", async () => {
  const stack = await startStack();
  try {
    const botId = await stack.createBot("limits");
    const empty = new Uint8Array();
    const first = await declare(stack, botId, empty, { uploadId: "u_empty_0123456789" });
    assert.equal(first.response.status, 201);
    assert.equal((await upload(stack, botId, first.id, empty)).status, 201);

    const digest = createHash("sha256").digest("hex");
    const over = await jsonCall(
      stack,
      `/v1/bots/${botId}/files/u_over_01234567890/manifest`,
      "PUT",
      {
        name: "over.bin",
        size: MAX_MANAGED_FILE_BYTES + 1,
        sha256: digest,
      },
    );
    assert.equal(over.status, 413);

    for (const body of [
      { name: "", size: 0, sha256: digest },
      { name: "x", size: -1, sha256: digest },
      { name: "x", size: 0, sha256: "bad" },
      { name: "x\u0000y", size: 0, sha256: digest },
    ]) {
      assert.equal(
        (await jsonCall(stack, `/v1/bots/${botId}/files/u_bad__01234567890/manifest`, "PUT", body))
          .status,
        400,
      );
    }
  } finally {
    await stack.close();
  }
});

test("chunked content one byte over 50 MiB receives 413 and publishes nothing", async () => {
  const stack = await startStack();
  try {
    const botId = await stack.createBot("chunked-limit");
    const digest = createHash("sha256").update(Buffer.alloc(MAX_MANAGED_FILE_BYTES)).digest("hex");
    const declared = await jsonCall(
      stack,
      `/v1/bots/${botId}/files/u_chunked_012345678/manifest`,
      "PUT",
      { name: "chunked.bin", size: MAX_MANAGED_FILE_BYTES, sha256: digest },
    );
    assert.equal(declared.status, 201);

    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = http.request({
        host: "127.0.0.1",
        port: stack.port,
        method: "PUT",
        path: `/v1/bots/${botId}/files/u_chunked_012345678/content`,
        headers: {
          authorization: `Bearer ${stack.token}`,
          "transfer-encoding": "chunked",
        },
      });
      request.on("response", resolve);
      request.on("error", reject);
      const chunk = Buffer.alloc(64 * 1024, 0x5a);
      let remaining = MAX_MANAGED_FILE_BYTES + 1;
      const write = () => {
        while (remaining > 0) {
          const amount = Math.min(chunk.length, remaining);
          remaining -= amount;
          if (!request.write(chunk.subarray(0, amount))) {
            request.once("drain", write);
            return;
          }
        }
        request.end();
      };
      write();
    });
    assert.equal(response.statusCode, 413);
    const body = await new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve(Buffer.concat(chunks)));
    });
    assert.equal(
      (JSON.parse(body.toString("utf8")) as { error: { kind: string } }).error.kind,
      "invalid_command",
    );

    const pendingId = `f_${createHash("sha256").update(botId).update("\0").update("u_chunked_012345678").digest("hex")}`;
    assert.equal((await metadata(stack, botId, pendingId)).status, 404);
  } finally {
    await stack.close();
  }
});

test("chunked content over limit closes the connection after a bounded structured response", async () => {
  const stack = await startStack();
  try {
    const botId = await stack.createBot("chunked-no-eof");
    const digest = createHash("sha256").update(Buffer.alloc(MAX_MANAGED_FILE_BYTES)).digest("hex");
    const declared = await jsonCall(
      stack,
      `/v1/bots/${botId}/files/u_noeof_01234567890/manifest`,
      "PUT",
      { name: "no-eof.bin", size: MAX_MANAGED_FILE_BYTES, sha256: digest },
    );
    assert.equal(declared.status, 201);

    const response = await new Promise<{
      readonly status: number;
      readonly socketDestroyed: () => boolean;
    }>((resolve, reject) => {
      const request = http.request({
        host: "127.0.0.1",
        port: stack.port,
        method: "PUT",
        path: `/v1/bots/${botId}/files/u_noeof_01234567890/content`,
        headers: {
          authorization: `Bearer ${stack.token}`,
          "transfer-encoding": "chunked",
        },
      });
      let remaining = MAX_MANAGED_FILE_BYTES + 1;
      const timer = setTimeout(() => {
        request.destroy();
        reject(new Error(`no bounded 413 response; ${remaining} bytes not yet queued`));
      }, 1_000);
      request.on("response", (incoming) => {
        clearTimeout(timer);
        incoming.resume();
        resolve({
          status: incoming.statusCode ?? 0,
          socketDestroyed: () => request.socket?.destroyed === true,
        });
      });
      request.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      const chunk = Buffer.alloc(64 * 1024, 0x6b);
      const write = () => {
        while (remaining > 0) {
          const amount = Math.min(chunk.length, remaining);
          remaining -= amount;
          if (!request.write(chunk.subarray(0, amount))) {
            request.once("drain", write);
            return;
          }
        }
        // Deliberately keep the chunked request open: no request.end(), so the server
        // has to close it after a bounded 413, not wait for EOF.
      };
      write();
    });
    assert.equal(response.status, 413);

    const deadline = Date.now() + 500;
    while (!response.socketDestroyed() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(response.socketDestroyed(), true, "the oversized no-EOF stream is bounded closed");

    const botDir = join(stack.root, "bots", botId);
    const names = await readdir(join(botDir, "files")).catch(() => []);
    assert.deepEqual(
      names.filter((name) => name.endsWith(".json") && name.includes(".upload.") === false),
      [],
    );
  } finally {
    await stack.close();
  }
});

test("send rejects pending, cross-Bot, duplicate and malformed fileIds before admission", async () => {
  const stack = await startStack();
  try {
    const botId = await stack.createBot("attachments");
    const otherId = await stack.createBot("other");
    const body = Buffer.from("attachment bytes");

    const declared = await declare(stack, botId, body, {
      name: "brief.txt",
      mimeType: "text/plain",
    });
    assert.equal(declared.response.status, 201);
    const completed = await upload(stack, botId, declared.id, body);
    assert.equal(completed.status, 201);
    const file = ((await completed.json()) as { file: { id: string } }).file;

    const socket = stack.connect();
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: "tr_attach_probe_0001" });
    await frames.next();

    for (const fileIds of [[file.id, file.id], ["f_bad"]]) {
      await send(socket, {
        type: "send",
        requestId: `r_attach_${fileIds[0]?.length}_${fileIds.length}`,
        text: "请读取附件",
        fileIds,
        whenBusy: "followUp",
        trace: "tr_attach_probe_0002",
      });
      const frame = await frames.next(1_000);
      assert.equal(frame.type, "error", "invalid or cross-Bot file IDs never admit a send");
    }

    const pendingId = "u_pending_01234567890";
    const pending = await declare(stack, botId, Buffer.from("pending"), {
      uploadId: pendingId,
      name: "pending.bin",
    });
    assert.equal(pending.response.status, 201);
    const pendingFile = ((await pending.response.json()) as { file: { id: string } }).file;
    await send(socket, {
      type: "send",
      requestId: "r_attach_pending_1",
      text: "pending",
      fileIds: [pendingFile.id],
      whenBusy: "followUp",
      trace: "tr_attach_probe_0003",
    });
    const pendingError = await frames.next(1_000);
    assert.equal(pendingError.type, "error");

    const otherBody = Buffer.from("other");
    const other = await declare(stack, otherId, otherBody, { name: "other.txt" });
    await upload(stack, otherId, other.id, otherBody);
    const otherFile = (
      (await (await upload(stack, otherId, other.id, otherBody)).json()) as {
        file: { id: string };
      }
    ).file;
    await send(socket, {
      type: "send",
      requestId: "r_attach_crossbot_1",
      text: "cross bot",
      fileIds: [otherFile.id],
      whenBusy: "followUp",
      trace: "tr_attach_probe_0004",
    });
    const crossError = await frames.next(1_000);
    assert.equal(crossError.type, "error");
    socket.close();
  } finally {
    await stack.close();
  }
});

test("send fileIds require write scope and never admit a read-only credential", async () => {
  const stack = await startStack();
  try {
    const botId = await stack.createBot("attachment-scope");
    const body = Buffer.from("scope");
    const declared = await declare(stack, botId, body);
    assert.equal(declared.response.status, 201);
    const completed = await upload(stack, botId, declared.id, body);
    assert.equal(completed.status, 201);
    const file = ((await completed.json()) as { file: { id: string } }).file;

    const readClient = await jsonCall(stack, "/v1/clients", "POST", {
      name: "reader-only",
      scopes: ["read"],
    });
    assert.equal(readClient.status, 201);
    const readerToken = ((await readClient.json()) as { token: string }).token;
    const socket = stack.connect({ token: readerToken });
    const frames = frameQueue(socket);
    await send(socket, hello);
    await frames.next();
    await send(socket, { type: "subscribe", botId, trace: "tr_attach_scope_001" });
    await frames.next();
    await send(socket, {
      type: "send",
      requestId: "r_attach_scope_0001",
      text: "attachment",
      fileIds: [file.id],
      whenBusy: "followUp",
      trace: "tr_attach_scope_002",
    });
    const refused = await frames.next(1_000);
    assert.equal(refused.type, "error");
    assert.equal(refused.kind, "auth_scope");
    socket.close();
  } finally {
    await stack.close();
  }
});

test("a valid download request returns 503 for a malformed disk metadata id", async () => {
  const stack = await startStack();
  try {
    const botId = await stack.createBot("malformed-metadata");
    const body = Buffer.from("malformed manifest");
    const declared = await declare(stack, botId, body);
    assert.equal(declared.response.status, 201);
    const completed = await upload(stack, botId, declared.id, body);
    assert.equal(completed.status, 201);
    const snapshot = (await completed.json()) as { file: { id: string } };
    const manifestPath = join(stack.root, "bots", botId, "files", `${snapshot.file.id}.json`);
    const stored = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const corrupt of [{ id: "f_bad" }, { botId: "b_bad" }, { uploadId: "u_bad" }]) {
      await writeFile(manifestPath, `${JSON.stringify({ ...stored, ...corrupt })}\n`, {
        mode: 0o600,
      });
      const response = await metadata(stack, botId, snapshot.file.id);
      assert.equal(response.status, 503);
    }
  } finally {
    await stack.close();
  }
});

test("the welcome advertises managed files without sending bytes on the socket", async () => {
  const stack = await startStack();
  const socket = stack.connect();
  try {
    const frames = frameQueue(socket);
    await send(socket, hello);
    const welcome = await frames.next();
    assert.equal((welcome.capabilities as Record<string, boolean> | undefined)?.files, true);
    assert.equal((welcome.capabilities as Record<string, boolean> | undefined)?.sendFiles, true);
  } finally {
    socket.close();
    await stack.close();
  }
});
