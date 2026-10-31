import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type DeviceSyncPort, deviceSyncSelf } from "./core/DeviceSyncPort.ts";
import { ClassifiedFailure } from "./core/domain.ts";
import { newFailure } from "./core/failures.ts";
import { declareEvent } from "./log/events.ts";
import type { Log } from "./log/log.ts";
import type { AuthenticatedSync } from "./sync-pull.ts";

const fail = declareEvent("runtime.sync.fail");
/** Only this process's current trusted Self set can create listening sockets. */
export class SyncListener {
  readonly #sync: AuthenticatedSync;
  readonly #device: DeviceSyncPort;
  readonly #log: Log;
  readonly #port: number | undefined;
  #servers: Server[] = [];
  #digest: string | undefined;
  #closed = false;
  #refreshing: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  constructor(sync: AuthenticatedSync, device: DeviceSyncPort, port: number | undefined, log: Log) {
    this.#sync = sync;
    this.#device = device;
    this.#port = port;
    this.#log = log;
  }
  start(): void {
    if (this.#port === undefined) return;
    void this.refresh();
    this.#timer = setInterval(() => {
      void this.refresh();
    }, 5000);
    this.#timer.unref();
  }
  refresh(): Promise<void> {
    if (this.#closed || this.#port === undefined) return Promise.resolve();
    if (this.#refreshing) return this.#refreshing;
    const next = this.#refresh();
    this.#refreshing = next.finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }
  async #clear(): Promise<void> {
    this.#sync.setReady(undefined);
    this.#digest = undefined;
    const servers = this.#servers;
    this.#servers = [];
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
  }
  async #refresh(): Promise<void> {
    const fields = { trace: `tr_sync_self_${process.pid}`, botId: "b_sync" };
    try {
      if (!this.#device.self) throw new Error("sync_unconfigured");
      const self = deviceSyncSelf.parse(await this.#device.self(fields));
      if (this.#closed) return;
      const addresses = [...new Set(self.addresses)].sort();
      const digest = createHash("sha256").update(JSON.stringify(addresses)).digest("hex");
      if (digest !== self.digest || JSON.stringify(addresses) !== JSON.stringify(self.addresses))
        throw new Error("sync_self_invalid");
      if (this.#digest === digest) return;
      await this.#clear();
      if (this.#closed || addresses.length === 0) return;
      let port = this.#port as number;
      for (const address of addresses) {
        if (this.#closed) return;
        const server = createServer(this.#sync.handler);
        server.requestTimeout = 10000;
        server.headersTimeout = 10000;
        server.maxRequestsPerSocket = 2;
        this.#servers.push(server);
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(
            { host: address, port, ...(address.includes(":") ? { ipv6Only: true } : {}) },
            () => {
              server.removeListener("error", reject);
              resolve();
            },
          );
        });
        server.on("error", () => {
          void this.#clear();
        });
        port = (server.address() as AddressInfo).port;
      }
      if (this.#closed) {
        await this.#clear();
        return;
      }
      // A second discovery fences address changes while sockets were binding.
      const current = deviceSyncSelf.parse(await this.#device.self(fields));
      if (current.digest !== digest || this.#closed) {
        await this.#clear();
        return;
      }
      this.#digest = digest;
      this.#sync.setReady({ port, digest });
    } catch (error) {
      await this.#clear();
      // The private port already attributes its own failures.
      if (!(error instanceof ClassifiedFailure))
        this.#log.emit("error", "runtime", fail, {
          ...fields,
          failure: newFailure("internal", "runtime"),
          origin: true,
          detail: { reason: "listener_error", providerCode: "sync_bind_failed" },
        });
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#sync.close();
    await this.#clear();
    await this.#refreshing;
    await this.#clear();
  }
}
