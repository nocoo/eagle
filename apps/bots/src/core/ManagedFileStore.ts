import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, type FileHandle, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { BOT_ID_PATTERN } from "./domain.ts";

export const MAX_MANAGED_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_MANAGED_FILE_NAME_BYTES = 255;
export const MAX_MANAGED_FILE_MIME_BYTES = 255;

const UPLOAD_ID = /^u_[A-Za-z0-9_-]{16,64}$/;
const FILE_ID = /^f_[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MIME = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;
const CHUNK_BYTES = 64 * 1024;
const OPEN_READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const OPEN_PART =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK;

export type ManagedFile = {
  readonly id: string;
  readonly botId: string;
  readonly uploadId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly sha256: string;
  readonly status: "uploading" | "complete";
  readonly createdAt: string;
};

export type ManagedFileDeclaration = {
  readonly botId: string;
  readonly uploadId: string;
  readonly name: string;
  readonly mimeType?: string;
  readonly size: number;
  readonly sha256: string;
};

export type ManagedFileErrorReason =
  | "invalid_request"
  | "unknown_file"
  | "upload_conflict"
  | "content_conflict"
  | "size_mismatch"
  | "limit_exceeded"
  | "lease_conflict"
  | "storage_failed";

export class ManagedFileError extends Error {
  readonly reason: ManagedFileErrorReason;

  constructor(reason: ManagedFileErrorReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ManagedFileError";
    this.reason = reason;
  }
}

const invalid = (message: string): ManagedFileError =>
  new ManagedFileError("invalid_request", message);

const storage = (cause?: unknown): ManagedFileError =>
  new ManagedFileError("storage_failed", "managed file storage is unavailable", { cause });

const assertBotId = (botId: string): void => {
  if (!BOT_ID_PATTERN.test(botId)) throw invalid("bot id is malformed");
};

const assertUploadId = (uploadId: string): void => {
  if (!UPLOAD_ID.test(uploadId)) throw invalid("upload id is malformed");
};

const assertFileId = (fileId: string): void => {
  if (!FILE_ID.test(fileId)) throw invalid("file id is malformed");
};

export const fileIdFor = (botId: string, uploadId: string): string => {
  assertBotId(botId);
  assertUploadId(uploadId);
  return `f_${createHash("sha256").update(botId).update("\0").update(uploadId).digest("hex")}`;
};

const normalizedDeclaration = (input: ManagedFileDeclaration) => {
  assertBotId(input.botId);
  assertUploadId(input.uploadId);
  if (typeof input.name !== "string") throw invalid("a display name is required");
  const nameBytes = Buffer.byteLength(input.name, "utf8");
  if (nameBytes === 0 || nameBytes > MAX_MANAGED_FILE_NAME_BYTES || input.name.includes("\0")) {
    throw invalid("a display name is 1-255 UTF-8 bytes and contains no NUL");
  }
  const mimeType = input.mimeType ?? "application/octet-stream";
  if (Buffer.byteLength(mimeType, "utf8") > MAX_MANAGED_FILE_MIME_BYTES || !MIME.test(mimeType)) {
    throw invalid("mimeType is malformed");
  }
  if (!Number.isSafeInteger(input.size) || input.size < 0) {
    throw invalid("size is a non-negative integer");
  }
  if (input.size > MAX_MANAGED_FILE_BYTES) {
    throw new ManagedFileError("limit_exceeded", "file is larger than 50 MiB");
  }
  if (!SHA256.test(input.sha256)) throw invalid("sha256 is 64 lowercase hex characters");
  return { ...input, mimeType } as ManagedFileDeclaration & { readonly mimeType: string };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseStored = (body: string): ManagedFile => {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw storage(error);
  }
  if (!isRecord(value)) throw storage();
  const allowed = new Set([
    "id",
    "botId",
    "uploadId",
    "name",
    "mimeType",
    "size",
    "sha256",
    "status",
    "createdAt",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw storage();
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.botId !== "string" ||
    typeof candidate.uploadId !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.mimeType !== "string" ||
    typeof candidate.size !== "number" ||
    typeof candidate.sha256 !== "string" ||
    (candidate.status !== "uploading" && candidate.status !== "complete") ||
    typeof candidate.createdAt !== "string"
  ) {
    throw storage();
  }
  const result = candidate as ManagedFile;
  try {
    assertFileId(result.id);
    assertBotId(result.botId);
    assertUploadId(result.uploadId);
    if (result.id !== fileIdFor(result.botId, result.uploadId)) throw storage();
    if (
      typeof result.name !== "string" ||
      result.name.length === 0 ||
      Buffer.byteLength(result.name, "utf8") > MAX_MANAGED_FILE_NAME_BYTES ||
      result.name.includes("\0")
    ) {
      throw storage();
    }
    if (
      typeof result.mimeType !== "string" ||
      Buffer.byteLength(result.mimeType, "utf8") > MAX_MANAGED_FILE_MIME_BYTES ||
      !MIME.test(result.mimeType)
    ) {
      throw storage();
    }
    if (
      !Number.isSafeInteger(result.size) ||
      result.size < 0 ||
      result.size > MAX_MANAGED_FILE_BYTES
    ) {
      throw storage();
    }
    if (!SHA256.test(result.sha256)) throw storage();
  } catch (error) {
    if (error instanceof ManagedFileError) throw error;
    throw storage(error);
  }
  return result;
};

const sameDeclaration = (
  stored: ManagedFile,
  input: ManagedFileDeclaration & { readonly mimeType: string },
): boolean =>
  stored.botId === input.botId &&
  stored.uploadId === input.uploadId &&
  stored.name === input.name &&
  stored.mimeType === input.mimeType &&
  stored.size === input.size &&
  stored.sha256 === input.sha256;

const close = async (handle: FileHandle | undefined): Promise<void> => {
  await handle?.close().catch(() => undefined);
};

export class ManagedFileStore {
  readonly #botDir: (botId: string) => string;
  readonly #now: () => Date;
  readonly #syncDirectory: (path: string) => Promise<void>;
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #directoryQueues = new Map<string, Promise<unknown>>();
  readonly #syncedDirectories = new Set<string>();

  constructor(options: {
    readonly botDir: (botId: string) => string;
    readonly now?: () => Date;
    readonly syncDirectory?: (path: string) => Promise<void>;
  }) {
    this.#botDir = options.botDir;
    this.#now = options.now ?? (() => new Date());
    this.#syncDirectory = options.syncDirectory ?? ((path) => this.#syncDirectoryReal(path));
  }

  async declare(input: ManagedFileDeclaration): Promise<ManagedFile> {
    return (await this.declareStatus(input)).file;
  }

  async declareStatus(input: ManagedFileDeclaration): Promise<{
    readonly file: ManagedFile;
    readonly created: boolean;
  }> {
    const declaration = normalizedDeclaration(input);
    const id = fileIdFor(declaration.botId, declaration.uploadId);
    return this.#serial(id, async () => {
      const files = await this.#filesDirectory(declaration.botId);
      const complete = await this.#readMetadata(join(files, `${id}.json`));
      if (complete !== undefined) {
        if (!sameDeclaration(complete, declaration) || complete.status !== "complete") {
          throw new ManagedFileError(
            "upload_conflict",
            "upload id is already declared differently",
          );
        }
        return { file: complete, created: false };
      }
      const pendingPath = join(files, `${id}.upload.json`);
      const pending = await this.#readMetadata(pendingPath);
      if (pending !== undefined) {
        if (!sameDeclaration(pending, declaration) || pending.status !== "uploading") {
          throw new ManagedFileError(
            "upload_conflict",
            "upload id is already declared differently",
          );
        }
        return { file: pending, created: false };
      }
      const record: ManagedFile = {
        id,
        botId: declaration.botId,
        uploadId: declaration.uploadId,
        name: declaration.name,
        mimeType: declaration.mimeType,
        size: declaration.size,
        sha256: declaration.sha256,
        status: "uploading",
        createdAt: this.#now().toISOString(),
      };
      await this.#atomicJson(files, pendingPath, record);
      return { file: record, created: true };
    });
  }

  async upload(input: {
    readonly botId: string;
    readonly uploadId: string;
    readonly source: AsyncIterable<Uint8Array>;
  }): Promise<ManagedFile> {
    return (await this.uploadStatus(input)).file;
  }

  async uploadStatus(input: {
    readonly botId: string;
    readonly uploadId: string;
    readonly source: AsyncIterable<Uint8Array>;
  }): Promise<{ readonly file: ManagedFile; readonly created: boolean }> {
    assertBotId(input.botId);
    assertUploadId(input.uploadId);
    const id = fileIdFor(input.botId, input.uploadId);
    return this.#serial(id, async () => {
      const files = await this.#filesDirectory(input.botId);
      const completedPath = join(files, `${id}.json`);
      const existing = await this.#readMetadata(completedPath);
      const pendingPath = join(files, `${id}.upload.json`);
      const pending = existing ?? (await this.#readMetadata(pendingPath));
      if (pending === undefined) {
        throw new ManagedFileError("unknown_file", "declare the upload manifest first");
      }
      if (
        pending.id !== id ||
        pending.botId !== input.botId ||
        pending.uploadId !== input.uploadId
      ) {
        throw storage();
      }
      const partPath = join(files, `.${id}.${randomUUID()}.part`);
      let part: FileHandle | undefined;
      let bytes = 0;
      const digest = createHash("sha256");
      try {
        part = await open(partPath, OPEN_PART, 0o600);
        const sourceWithIterator = input.source as AsyncIterable<Uint8Array> & {
          [Symbol.asyncIterator](options?: {
            readonly destroyOnReturn?: boolean;
          }): AsyncIterator<Uint8Array>;
        };
        const iterator =
          input.source instanceof Readable
            ? sourceWithIterator[Symbol.asyncIterator]({ destroyOnReturn: false })
            : sourceWithIterator[Symbol.asyncIterator]();
        while (true) {
          const next = await iterator.next();
          if (next.done) break;
          const value = next.value;
          const chunk = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
          bytes += chunk.byteLength;
          if (bytes > MAX_MANAGED_FILE_BYTES) {
            throw new ManagedFileError("limit_exceeded", "file is larger than 50 MiB");
          }
          digest.update(chunk);
          let offset = 0;
          while (offset < chunk.byteLength) {
            const written = await part.write(chunk, offset, chunk.byteLength - offset, null);
            if (written.bytesWritten === 0) throw storage();
            offset += written.bytesWritten;
          }
        }
        if (bytes !== pending.size) {
          throw new ManagedFileError("size_mismatch", "uploaded size does not match the manifest");
        }
        if (digest.digest("hex") !== pending.sha256) {
          throw new ManagedFileError(
            "content_conflict",
            "uploaded hash does not match the manifest",
          );
        }
        await chmod(partPath, 0o600);
        await part.sync();
        await part.close();
        part = undefined;

        if (existing !== undefined) {
          await this.#verifyContent(join(files, `${id}.bin`), existing);
          return { file: existing, created: false };
        }

        const complete: ManagedFile = { ...pending, status: "complete" };
        await rename(partPath, join(files, `${id}.bin`));
        await this.#syncDirectory(files);
        await this.#atomicJson(files, completedPath, complete);
        await unlink(pendingPath).catch(() => undefined);
        await this.#syncDirectory(files);
        return { file: complete, created: true };
      } catch (error) {
        if (error instanceof ManagedFileError) throw error;
        throw storage(error);
      } finally {
        await close(part);
        await unlink(partPath).catch(() => undefined);
      }
    });
  }

  async metadata(input: { readonly botId: string; readonly fileId: string }): Promise<ManagedFile> {
    assertBotId(input.botId);
    assertFileId(input.fileId);
    const files = await this.#filesDirectory(input.botId);
    const file = await this.#readMetadata(join(files, `${input.fileId}.json`));
    if (file === undefined) {
      throw new ManagedFileError("unknown_file", "no such managed file");
    }
    if (file.status !== "complete" || file.id !== input.fileId || file.botId !== input.botId) {
      throw storage();
    }
    await this.#verifyContent(join(files, `${file.id}.bin`), file);
    return file;
  }

  async download(input: {
    readonly botId: string;
    readonly fileId: string;
  }): Promise<{ readonly file: ManagedFile; readonly stream: Readable }> {
    const file = await this.metadata(input);
    const files = await this.#filesDirectory(input.botId);
    const path = join(files, `${file.id}.bin`);
    const handle = await this.#openRegular(path).catch((error) => {
      throw storage(error);
    });
    try {
      await this.#verifyHandle(handle, file);
      return {
        file,
        stream: handle.createReadStream({ autoClose: true, start: 0 }),
      };
    } catch (error) {
      await close(handle);
      if (error instanceof ManagedFileError) throw error;
      throw storage(error);
    }
  }

  #serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(key, settled);
    void settled.then(() => {
      if (this.#queues.get(key) === settled) this.#queues.delete(key);
    });
    return run;
  }

  async #filesDirectory(botId: string): Promise<string> {
    const previous = this.#directoryQueues.get(botId) ?? Promise.resolve();
    const work = previous.then(
      async () => {
        const bot = this.#botDir(botId);
        try {
          const botStats = await lstat(bot);
          if (!botStats.isDirectory() || botStats.isSymbolicLink()) throw storage();
          const files = join(bot, "files");
          try {
            await mkdir(files, { mode: 0o700 });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
          const stats = await lstat(files);
          if (!stats.isDirectory() || stats.isSymbolicLink()) throw storage();
          await chmod(files, 0o700);
          if (!this.#syncedDirectories.has(bot)) {
            await this.#syncDirectory(bot);
            this.#syncedDirectories.add(bot);
          }
          return files;
        } catch (error) {
          if (error instanceof ManagedFileError) throw error;
          throw storage(error);
        }
      },
      () => Promise.resolve(),
    );
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    this.#directoryQueues.set(botId, settled);
    void settled.then(() => {
      if (this.#directoryQueues.get(botId) === settled) this.#directoryQueues.delete(botId);
    });
    return work;
  }

  async #readMetadata(path: string): Promise<ManagedFile | undefined> {
    let handle: FileHandle;
    try {
      handle = await open(path, OPEN_READ);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw storage(error);
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > 8 * 1024) throw storage();
      return parseStored(await handle.readFile("utf8"));
    } finally {
      await close(handle);
    }
  }

  async #atomicJson(files: string, target: string, value: ManagedFile): Promise<void> {
    const temporary = `${target}.${randomUUID()}.tmp`;
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporary, OPEN_PART, 0o600);
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await chmod(temporary, 0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
      await this.#syncDirectory(files);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      if (error instanceof ManagedFileError) throw error;
      throw storage(error);
    } finally {
      await close(handle);
    }
  }

  async #verifyContent(path: string, file: ManagedFile): Promise<void> {
    const handle = await this.#openRegular(path).catch((error) => {
      throw storage(error);
    });
    try {
      await this.#verifyHandle(handle, file);
    } finally {
      await close(handle);
    }
  }

  async #verifyHandle(handle: FileHandle, file: ManagedFile): Promise<void> {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size !== file.size) throw storage();
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let position = 0;
    while (position < file.size) {
      const length = Math.min(buffer.byteLength, file.size - position);
      const read = await handle.read(buffer, 0, length, position);
      if (read.bytesRead === 0) throw storage();
      digest.update(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
    if (digest.digest("hex") !== file.sha256) throw storage();
  }

  async #openRegular(path: string): Promise<FileHandle> {
    const handle = await open(path, OPEN_READ);
    const stats = await handle.stat();
    if (!stats.isFile()) {
      await close(handle);
      throw storage();
    }
    return handle;
  }

  async #syncDirectoryReal(path: string): Promise<void> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await handle.sync();
    } catch (error) {
      throw storage(error);
    } finally {
      await close(handle);
    }
  }
}
