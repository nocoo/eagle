import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { dirname, isAbsolute } from "node:path";

const METHODS = new Set([
  "sync.identity",
  "sync.access",
  "sync.peer.authorize",
  "sync.proof",
  "sync.key.descriptor",
  "sync.key.publish",
  "sync.key.lookup",
  "sync.cache.authority",
  "sync.relay.authority",
  "sync.key.seal",
  "sync.key.envelope",
  "sync.key.open",
  "sync.endpoints.self",
  "status",
  "directory",
  "execute",
  "operation.get",
  "operation.cancel",
  "approval.request",
  "local.begin",
  "local.complete",
  "local.heartbeat",
]);
const MAX_FRAME = 524288;
type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
};

/** Version-1 private host port. One channel can hold a native admission until settlement. */
export class DeviceChannel {
  readonly version = 1;
  readonly #path: string;
  readonly #timeoutMs: number;
  readonly #pending = new Map<string, Pending>();
  #socket?: Socket;
  #opening?: Promise<Socket>;
  #closed = false;
  #buffer = "";

  constructor(path: string, timeoutMs = 65000) {
    this.#path = path;
    this.#timeoutMs = timeoutMs;
  }

  async #open(): Promise<Socket> {
    if (this.#closed) throw new Error("device_disconnected");
    if (this.#opening !== undefined) return this.#opening;
    this.#opening = (async () => {
      if (!isAbsolute(this.#path)) throw new Error("insecure_device_socket");
      const [socketInfo, parent] = await Promise.all([
        lstat(this.#path),
        lstat(dirname(this.#path)),
      ]);
      if (
        !socketInfo.isSocket() ||
        socketInfo.uid !== process.getuid?.() ||
        (socketInfo.mode & 0o077) !== 0 ||
        !parent.isDirectory() ||
        parent.uid !== process.getuid?.() ||
        (parent.mode & 0o077) !== 0
      ) {
        throw new Error("insecure_device_socket");
      }
      if (this.#closed) throw new Error("device_disconnected");
      return new Promise<Socket>((resolve, reject) => {
        const socket = connect(this.#path);
        this.#socket = socket;
        socket.setEncoding("utf8");
        socket.once("connect", () => resolve(socket));
        socket.on("data", (chunk: string) => this.#read(chunk));
        socket.once("error", () => {
          reject(new Error("device_unavailable"));
          this.#fail("device_unavailable");
        });
        socket.once("close", () => {
          reject(new Error("device_disconnected"));
          this.#fail("device_disconnected");
        });
      });
    })();
    return this.#opening;
  }

  async call(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!METHODS.has(method)) throw new Error("device_method_forbidden");
    if (signal?.aborted) throw new Error("device_cancelled");
    const requestId = randomUUID();
    const frame = JSON.stringify({
      requestId,
      method,
      ...(params === undefined ? {} : { params }),
    });
    if (Buffer.byteLength(frame) > MAX_FRAME) throw new Error("device_frame_too_large");
    return new Promise<unknown>((resolve, reject) => {
      const abort = () => this.#fail("device_cancelled");
      const timer = setTimeout(() => this.#fail("device_timeout"), this.#timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      this.#pending.set(requestId, { resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      this.#open().then(
        (socket) => {
          if (this.#pending.has(requestId)) socket.write(`${frame}\n`);
        },
        (error: unknown) => {
          const entry = this.#pending.get(requestId);
          this.#pending.delete(requestId);
          entry?.cleanup();
          entry?.reject(
            error instanceof Error && error.message === "insecure_device_socket"
              ? error
              : new Error("device_unavailable"),
          );
        },
      );
    });
  }

  #read(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const end = this.#buffer.indexOf("\n");
      const line = end < 0 ? this.#buffer : this.#buffer.slice(0, end);
      if (Buffer.byteLength(line) > MAX_FRAME) {
        this.#fail("device_frame_too_large");
        return;
      }
      if (end < 0) return;
      this.#buffer = this.#buffer.slice(end + 1);
      let value: { requestId?: unknown; result?: unknown; error?: unknown };
      try {
        value = JSON.parse(line);
      } catch {
        this.#fail("invalid_device_response");
        return;
      }
      if (
        value === null ||
        typeof value !== "object" ||
        typeof value.requestId !== "string" ||
        !this.#pending.has(value.requestId) ||
        Object.hasOwn(value, "result") === Object.hasOwn(value, "error")
      ) {
        this.#fail("invalid_device_response");
        return;
      }
      const entry = this.#pending.get(value.requestId);
      this.#pending.delete(value.requestId);
      entry?.cleanup();
      if (Object.hasOwn(value, "error")) {
        const code =
          typeof value.error === "string" && /^[a-z][a-z0-9_]{0,80}$/.test(value.error)
            ? value.error
            : "device_request_failed";
        entry?.reject(new Error(code));
      } else {
        entry?.resolve(value.result);
      }
    }
  }

  #fail(code: string): void {
    this.#closed = true;
    this.#socket?.destroy();
    for (const entry of this.#pending.values()) {
      entry.cleanup();
      entry.reject(new Error(code));
    }
    this.#pending.clear();
  }

  close(): void {
    this.#fail("device_disconnected");
  }
}
