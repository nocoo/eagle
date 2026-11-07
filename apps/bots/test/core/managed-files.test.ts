import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import {
  fileIdFor,
  MAX_MANAGED_FILE_BYTES,
  ManagedFileError,
  ManagedFileStore,
} from "../../src/core/ManagedFileStore.ts";

const run = promisify(execFile);
const botId = "b_0190a1b0-0000-7000-8000-000000000001";
const uploadId = "u_0123456789abcdef";

const digest = (body: Uint8Array): string => createHash("sha256").update(body).digest("hex");

const open = async (syncDirectory?: (path: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "bots-files-store-"));
  const botDir = join(root, "bots", botId);
  await mkdir(botDir, { recursive: true, mode: 0o700 });
  const store = new ManagedFileStore({
    botDir: () => botDir,
    ...(syncDirectory === undefined ? {} : { syncDirectory }),
  });
  return { root, botDir, store };
};

const declare = async (
  store: ManagedFileStore,
  input: { readonly body?: Uint8Array; readonly name?: string; readonly mimeType?: string } = {},
) => {
  const body = input.body ?? new Uint8Array();
  const base = {
    botId,
    uploadId,
    name: input.name ?? "../../display-only.bin",
    size: body.byteLength,
    sha256: digest(body),
  };
  return input.mimeType === undefined
    ? store.declare(base)
    : store.declare({ ...base, mimeType: input.mimeType });
};

const upload = async (store: ManagedFileStore, body: Uint8Array) =>
  store.upload({ botId, uploadId, source: Readable.from([body]) });

const completedNames = async (botDir: string): Promise<string[]> =>
  (await readdir(join(botDir, "files"))).filter(
    (name) => name.endsWith(".json") && !name.endsWith(".upload.json"),
  );

const all = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

test("managed files accept ordinary and zero-byte uploads without trusting the display name", async () => {
  const { root, botDir, store } = await open();
  try {
    const body = Buffer.from([0, 1, 2, 3, 255]);
    const declared = await declare(store, { body });
    assert.equal(declared.status, "uploading");
    const complete = await upload(store, body);
    assert.equal(complete.status, "complete");
    assert.equal(complete.id, fileIdFor(botId, uploadId));
    assert.equal(complete.name, "../../display-only.bin");
    assert.equal(complete.mimeType, "application/octet-stream");
    assert.equal(complete.size, body.length);

    const metadata = await store.metadata({ botId, fileId: complete.id });
    assert.deepEqual(metadata, complete);
    const downloaded = await store.download({ botId, fileId: complete.id });
    assert.deepEqual(await all(downloaded.stream), body);

    const filesDir = join(botDir, "files");
    assert.equal((await lstat(filesDir)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(filesDir, `${complete.id}.bin`))).mode & 0o777, 0o600);
    assert.equal((await lstat(join(filesDir, `${complete.id}.json`))).mode & 0o777, 0o600);

    const emptyId = "u_1234567890fedcba";
    const empty = await store.declare({
      botId,
      uploadId: emptyId,
      name: "empty",
      size: 0,
      sha256: digest(new Uint8Array()),
    });
    assert.equal(empty.status, "uploading");
    const finished = await store.upload({
      botId,
      uploadId: emptyId,
      source: Readable.from([]),
    });
    assert.equal(finished.size, 0);
    const emptyDownload = await store.download({ botId, fileId: finished.id });
    assert.equal(emptyDownload.file.size, 0);
    assert.deepEqual(await all(emptyDownload.stream), Buffer.alloc(0));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("first files directory creation fsyncs the Bot parent before ACK and serializes concurrent winners", async () => {
  const syncCalls: string[] = [];
  const { root, botDir } = await open();
  try {
    const store = new ManagedFileStore({
      botDir: () => botDir,
      syncDirectory: async (path) => {
        syncCalls.push(path);
        if (path === botDir) throw new Error("ENOSPC");
      },
    });
    await assert.rejects(
      store.declare({
        botId,
        uploadId,
        name: "unsynced.bin",
        size: 0,
        sha256: digest(new Uint8Array()),
      }),
      (error) => error instanceof ManagedFileError && error.reason === "storage_failed",
    );
    assert.equal(syncCalls.includes(botDir), true, "the Bot parent was the fsync boundary");
    assert.deepEqual(await completedNames(botDir), [], "a failed parent fsync admits no manifest");

    let fsyncs = 0;
    const concurrent = new ManagedFileStore({
      botDir: () => botDir,
      syncDirectory: async (path) => {
        if (path === botDir) fsyncs += 1;
      },
    });
    await rm(join(botDir, "files"), { recursive: true, force: true });
    const left = await concurrent.declare({
      botId,
      uploadId,
      name: "left.bin",
      size: 0,
      sha256: digest(new Uint8Array()),
    });
    const right = await concurrent.declare({
      botId,
      uploadId: "u_concurrent_012345678",
      name: "right.bin",
      size: 0,
      sha256: digest(new Uint8Array()),
    });
    assert.equal(left.status, "uploading");
    assert.equal(right.status, "uploading");
    assert.ok(fsyncs >= 1, "every fresh files directory is acknowledged only after parent sync");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same upload metadata and bytes are idempotent while conflicts never overwrite", async () => {
  const { root, store } = await open();
  try {
    const first = Buffer.from("first bytes");
    await declare(store, { body: first, mimeType: "text/plain" });
    const complete = await upload(store, first);
    const redeclared = await declare(store, { body: first, mimeType: "text/plain" });
    assert.deepEqual(redeclared, complete);
    const retried = await upload(store, first);
    assert.deepEqual(retried, complete);
    assert.deepEqual(await store.metadata({ botId, fileId: complete.id }), complete);

    await assert.rejects(
      declare(store, { body: Buffer.from("changed"), mimeType: "text/plain" }),
      (error) => error instanceof ManagedFileError && error.reason === "upload_conflict",
    );
    await assert.rejects(
      store.upload({ botId, uploadId, source: Readable.from([Buffer.from("wrong bytes")]) }),
      (error) =>
        error instanceof ManagedFileError &&
        (error.reason === "content_conflict" || error.reason === "size_mismatch"),
    );
    assert.deepEqual(await store.metadata({ botId, fileId: complete.id }), complete);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an interrupted upload publishes nothing and the original id can be retried", async () => {
  const { root, botDir, store } = await open();
  const body = Buffer.from("retry after interruption");
  try {
    await declare(store, { body });
    const interrupted = Readable.from(
      (async function* () {
        yield body.subarray(0, 4);
        throw new Error("client disappeared");
      })(),
    );
    await assert.rejects(store.upload({ botId, uploadId, source: interrupted }));
    assert.deepEqual(await completedNames(botDir), [], "a part and a declaration are not complete");
    await assert.rejects(store.metadata({ botId, fileId: fileIdFor(botId, uploadId) }), (error) =>
      error instanceof ManagedFileError ? error.reason === "unknown_file" : false,
    );
    const complete = await upload(store, body);
    assert.equal(complete.id, fileIdFor(botId, uploadId));
    assert.deepEqual(await readFile(join(botDir, "files", `${complete.id}.bin`)), body);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a limit refusal does not call return or close the original byte source", async () => {
  const { root, store } = await open();
  try {
    const declaredSize = MAX_MANAGED_FILE_BYTES;
    await store.declare({
      botId,
      uploadId,
      name: "limited.bin",
      size: declaredSize,
      sha256: digest(Buffer.alloc(declaredSize)),
    });
    let returned = false;
    const source = {
      [Symbol.asyncIterator]() {
        let sent = 0;
        return {
          async next() {
            sent += 1;
            if (sent === 1) {
              return {
                done: false as const,
                value: Buffer.alloc(declaredSize, 1),
              };
            }
            if (sent === 2) {
              return { done: false as const, value: Buffer.from([2]) };
            }
            return { done: true as const, value: undefined };
          },
          async return() {
            returned = true;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    await assert.rejects(store.upload({ botId, uploadId, source }), (error) =>
      error instanceof ManagedFileError ? error.reason === "limit_exceeded" : false,
    );
    assert.equal(
      returned,
      false,
      "the source is drained or closed by the HTTP owner, never by iterator cleanup",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the 50 MiB boundary is inclusive and the next byte is refused without completion", async () => {
  const { root, store } = await open();
  try {
    assert.equal(MAX_MANAGED_FILE_BYTES, 50 * 1024 * 1024);
    const chunk = Buffer.alloc(64 * 1024, 0xa5);
    const hash = createHash("sha256");
    for (let left = MAX_MANAGED_FILE_BYTES; left > 0; left -= chunk.length) {
      hash.update(chunk);
    }
    const sha256 = hash.digest("hex");
    await store.declare({
      botId,
      uploadId,
      name: "limit.bin",
      size: MAX_MANAGED_FILE_BYTES,
      sha256,
    });
    const source = Readable.from(
      (async function* () {
        for (let left = MAX_MANAGED_FILE_BYTES; left > 0; left -= chunk.length) yield chunk;
      })(),
    );
    const complete = await store.upload({ botId, uploadId, source });
    assert.equal(complete.size, MAX_MANAGED_FILE_BYTES);

    const tooLargeId = "u_too_large_123456";
    const acceptedDeclaration = await store.declare({
      botId,
      uploadId: tooLargeId,
      name: "too-large.bin",
      size: MAX_MANAGED_FILE_BYTES,
      sha256,
    });
    assert.equal(acceptedDeclaration.status, "uploading");
    await assert.rejects(
      store.upload({
        botId,
        uploadId: tooLargeId,
        source: Readable.from(
          (async function* () {
            for (let left = MAX_MANAGED_FILE_BYTES + 1; left > 0; left -= chunk.length) {
              yield left < chunk.length ? chunk.subarray(0, left) : chunk;
            }
          })(),
        ),
      }),
      (error) => error instanceof ManagedFileError && error.reason === "limit_exceeded",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("IDs, paths and unsafe filesystem entries are refused without following them", async () => {
  const { root, botDir, store } = await open();
  try {
    for (const unsafe of ["../outside", "u_short", "u_bad/name", `u_${"x".repeat(65)}`]) {
      await assert.rejects(
        store.declare({
          botId,
          uploadId: unsafe,
          name: "x",
          size: 0,
          sha256: digest(new Uint8Array()),
        }),
        (error) => error instanceof ManagedFileError && error.reason === "invalid_request",
      );
    }
    for (const unsafe of ["../f_x", "f_short", "f_bad/name", `f_${"g".repeat(64)}`]) {
      await assert.rejects(
        store.metadata({ botId, fileId: unsafe }),
        (error) => error instanceof ManagedFileError && error.reason === "invalid_request",
      );
    }

    const body = Buffer.from("private");
    await declare(store, { body });
    const fileId = fileIdFor(botId, uploadId);
    await upload(store, body);
    const filesDir = join(botDir, "files");
    const target = join(filesDir, `${fileId}.bin`);
    await rm(target);
    await symlink(join(root, "outside"), target);
    await assert.rejects(
      store.download({ botId, fileId }),
      (error) => error instanceof ManagedFileError && error.reason === "storage_failed",
    );

    const fifoId = "u_fifo_01234567890";
    const fifo = fileIdFor(botId, fifoId);
    await store.declare({
      botId,
      uploadId: fifoId,
      name: "fifo",
      size: 0,
      sha256: digest(new Uint8Array()),
    });
    await store.upload({ botId, uploadId: fifoId, source: Readable.from([]) });
    await rm(join(filesDir, `${fifo}.bin`));
    const fifoPath = join(filesDir, `${fifo}.bin`);
    await run("mkfifo", [fifoPath]);
    await assert.rejects(
      store.download({ botId, fileId: fifo }),
      (error) => error instanceof ManagedFileError && error.reason === "storage_failed",
    );
    assert.equal((await stat(filesDir)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a publish failure and a concurrent winner never expose partial metadata", async () => {
  const { root, botDir, store } = await open();
  try {
    const body = Buffer.from("same bytes");
    await declare(store, { body });
    const fileId = fileIdFor(botId, uploadId);
    await mkdir(join(botDir, "files", `${fileId}.bin`), { recursive: false });
    await assert.rejects(upload(store, body), (error) =>
      error instanceof ManagedFileError ? error.reason === "storage_failed" : false,
    );
    assert.deepEqual(await completedNames(botDir), []);

    await rm(join(botDir, "files", `${fileId}.bin`), { recursive: true });
    const [left, right] = await Promise.all([upload(store, body), upload(store, body)]);
    assert.deepEqual(left, right);
    assert.equal((await completedNames(botDir)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
