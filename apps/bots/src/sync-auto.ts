import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { BotRegistry, ReadyReplica } from "./core/BotRegistry.ts";
import { cacheListResult } from "./core/DeviceSyncCache.ts";
import {
  type SyncConnectionsApi,
  type SyncPreference,
  syncBinding,
  syncConnectionInput,
  syncPreferences,
  syncSource,
  syncUploadPage,
} from "./core/DeviceSyncConnections.ts";
import { RelayDelivery, relayDirectory, relayStatusResult } from "./core/DeviceSyncRelay.ts";
import { ClassifiedFailure } from "./core/domain.ts";
import { newFailure } from "./core/failures.ts";
import { declareEvent } from "./log/events.ts";
import type { Log } from "./log/log.ts";
import {
  type AuthenticatedSync,
  type SyncAttempt,
  syncRemoteFailure,
  syncTransportFailure,
} from "./sync-pull.ts";

const failEvent = declareEvent("runtime.sync.fail");
const streamStatus = z.object({
  source: syncSource,
  known: z.number().int().nonnegative(),
  received: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
  available: z
    .array(z.object({ from: z.number().int().positive(), to: z.number().int().positive() }))
    .default([]),
});
const replicaStatus = z.object({ streams: z.array(streamStatus) });
type Source = z.infer<typeof syncSource>;
type State = {
  route: "direct" | "cache";
  since: number;
  probeAt: number;
  streak: number;
  status: string;
  scan: Map<string, { after: number; gap: number | undefined; revisit: boolean }>;
  sourceIndex: number;
  switchPending: boolean;
  peerApplied?: z.infer<typeof relayStatusResult> & { current: "unknown"; authenticatedAt: number };
};
const sourceKey = (source: Source) => `${source.replicaId}/${source.epoch}`;

/** One inbound competition plus an independent upload. It never opens a local replica. */
export class AutomaticSync implements SyncConnectionsApi {
  readonly #registry: BotRegistry;
  readonly #sync: AuthenticatedSync;
  readonly #log: Log;
  readonly #directory: string;
  readonly #states = new Map<SyncPreference, State>();
  readonly #attempts = new Map<SyncPreference, Set<AbortController>>();
  #connections: SyncPreference[] = [];
  #closed = false;
  #storageUncertain = false;
  #storageFailure: ClassifiedFailure | undefined;
  #probe: { pref: SyncPreference; cancel(): void } | undefined;
  #inboundTimer: ReturnType<typeof setTimeout> | undefined;
  #uploadTimer: ReturnType<typeof setTimeout> | undefined;
  #metadataTimer: ReturnType<typeof setTimeout> | undefined;
  #receiveIndex = 0;
  #uploadIndex = 0;
  #metadataIndex = 0;
  constructor(root: string, registry: BotRegistry, sync: AuthenticatedSync, log: Log) {
    this.#directory = join(root, "sync-connections");
    this.#registry = registry;
    this.#sync = sync;
    this.#log = log;
    try {
      const directory = lstatSync(this.#directory);
      if (!directory.isDirectory() || directory.isSymbolicLink())
        throw new Error("invalid sync preference directory");
      const path = join(this.#directory, "v1.json");
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024)
        throw new Error("invalid sync preferences");
      this.#connections = syncPreferences.parse(JSON.parse(readFileSync(path, "utf8"))).connections;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        this.#storageUncertain = true;
        this.#storageFailure = this.#failure(cause, "tr_sync_preferences");
      }
    }
  }
  #failure(cause: unknown, trace: string, botId?: string): ClassifiedFailure {
    if (cause instanceof ClassifiedFailure) return cause;
    const failure = newFailure("storage_failed", "runtime");
    this.#log.emit("error", "runtime", failEvent, {
      trace,
      ...(botId ? { botId } : {}),
      failure,
      origin: true,
    });
    return new ClassifiedFailure(failure, "not_admitted", "sync preferences could not be stored", {
      cause,
    });
  }
  #save(trace: string, botId?: string, connections = this.#connections) {
    if (this.#storageFailure) throw this.#storageFailure;
    let stage: string | undefined;
    try {
      mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
      if (!lstatSync(this.#directory).isDirectory() || lstatSync(this.#directory).isSymbolicLink())
        throw new Error("invalid sync preference directory");
      stage = join(this.#directory, `.stage-${randomUUID()}`);
      const data = JSON.stringify(syncPreferences.parse({ version: 1, connections }));
      const fd = openSync(
        stage,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(fd, data);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(stage, join(this.#directory, "v1.json"));
      stage = undefined;
      const dir = openSync(this.#directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
      this.#storageUncertain = false;
    } catch (cause) {
      this.#storageUncertain = true;
      for (const pref of this.#connections) this.#cancel(pref);
      this.#storageFailure = this.#failure(cause, trace, botId);
      throw this.#storageFailure;
    } finally {
      if (stage) {
        try {
          unlinkSync(stage);
        } catch {
          /* Failed owned stage is never a preference. */
        }
      }
    }
  }
  #state(pref: SyncPreference): State {
    let state = this.#states.get(pref);
    if (!state) {
      state = {
        route: "direct",
        since: Date.now(),
        probeAt: 0,
        streak: 0,
        status: "pending",
        scan: new Map(),
        sourceIndex: 0,
        switchPending: false,
      };
      this.#states.set(pref, state);
    }
    return state;
  }
  #cancel(pref: SyncPreference) {
    for (const controller of this.#attempts.get(pref) ?? []) controller.abort();
    this.#attempts.delete(pref);
    this.#sync.relayStop?.(pref.botId);
  }
  async #ready(pref: SyncPreference, trace: string) {
    const replica = await this.#registry.readyReplica(pref.botId, trace);
    if (JSON.stringify(syncBinding.parse(replica.binding)) !== JSON.stringify(pref.binding)) {
      const failure = newFailure("auth_failed", "runtime");
      this.#log.emit("error", "runtime", failEvent, {
        trace,
        botId: pref.botId,
        failure,
        origin: true,
      });
      throw new ClassifiedFailure(failure, "not_admitted", "sync binding changed");
    }
    return replica;
  }
  async list(botId: string, trace: string) {
    if (this.#storageFailure) throw this.#storageFailure;
    let actual: unknown = null;
    try {
      actual = await (await this.#registry.readyReplica(botId, trace)).command("status", {});
    } catch (error) {
      if (!(error instanceof ClassifiedFailure)) throw error;
    }
    return {
      version: 1,
      replica: actual,
      connections: this.#connections
        .filter((p) => p.botId === botId)
        .map((p) => ({
          peerDeviceId: p.peerDeviceId,
          direction: p.direction,
          source: p.source ?? null,
          binding: p.binding,
          transport: this.#state(p).route,
          state: this.#storageUncertain ? "storage_failed" : this.#state(p).status,
          cloudCached:
            p.upload.cloudCached && p.upload.cloudCached.expiresAt > Date.now()
              ? p.upload.cloudCached
              : null,
          expiredThrough: p.upload.expiredThrough,
          peerApplied: this.#state(p).peerApplied ?? "unknown",
        })),
    };
  }
  async put(
    botId: string,
    peerDeviceId: string,
    value: z.infer<typeof syncConnectionInput>,
    trace: string,
  ) {
    if (this.#storageFailure) throw this.#storageFailure;
    const replica = await this.#registry.readyReplica(botId, trace);
    const binding = syncBinding.parse(replica.binding);
    if (binding.localBotId !== botId)
      throw new ClassifiedFailure(
        newFailure("auth_failed"),
        "not_admitted",
        "sync requires local binding",
      );
    if (value.direction !== "publish") await this.#sync.publishDescriptor(botId, trace);
    await replica.check();
    if (this.#storageFailure) throw this.#storageFailure;
    if (this.#closed)
      throw new ClassifiedFailure(newFailure("auth_failed"), "not_admitted", "sync closed");
    const previous = this.#connections.find(
      (p) => p.botId === botId && p.peerDeviceId === peerDeviceId,
    );
    if (!previous && this.#connections.length >= 32)
      throw new ClassifiedFailure(
        newFailure("limit_exceeded"),
        "not_admitted",
        "at most32 sync connections",
      );
    const sameBinding = previous && JSON.stringify(previous.binding) === JSON.stringify(binding);
    const pref: SyncPreference = {
      ...syncConnectionInput.parse(value),
      botId,
      peerDeviceId,
      binding,
      ...(sameBinding && previous.pendingReceipt
        ? { pendingReceipt: previous.pendingReceipt }
        : {}),
      ...(sameBinding && previous.pendingApply ? { pendingApply: previous.pendingApply } : {}),
      upload: sameBinding
        ? previous.upload
        : { after: 0, single: false, splitThrough: 0, expiredThrough: 0 },
    };
    const candidate = this.#connections.filter((p) => p !== previous).concat(pref);
    this.#save(trace, botId, candidate);
    if (previous) {
      this.#cancel(previous);
      this.#states.delete(previous);
    }
    this.#connections = candidate;
    return { version: 1, ...value, peerDeviceId, binding };
  }
  async remove(botId: string, peerDeviceId: string, trace: string) {
    if (this.#storageFailure) throw this.#storageFailure;
    const previous = this.#connections.find(
      (p) => p.botId === botId && p.peerDeviceId === peerDeviceId,
    );
    if (previous) {
      this.#cancel(previous);
      this.#states.delete(previous);
    }
    const candidate = this.#connections.filter((p) => p !== previous);
    this.#save(trace, botId, candidate);
    this.#connections = candidate;
    return { version: 1, disabled: true };
  }
  #owner(pref: SyncPreference) {
    if (this.#closed || this.#storageUncertain || !this.#connections.includes(pref))
      throw new Error("sync_attempt_cancelled");
  }
  #attempt(
    pref: SyncPreference,
    replica: ReadyReplica,
  ): { context: SyncAttempt; cancel(): void; release(): void } {
    const controller = new AbortController();
    const set = this.#attempts.get(pref) ?? new Set<AbortController>();
    this.#attempts.set(pref, set);
    set.add(controller);
    return {
      context: {
        signal: controller.signal,
        replica,
        guard: () => {
          this.#owner(pref);
          if (controller.signal.aborted) throw new Error("sync_attempt_cancelled");
        },
      },
      cancel: () => controller.abort(),
      release: () => {
        set.delete(controller);
        if (!set.size) this.#attempts.delete(pref);
      },
    };
  }
  start() {
    const loop = (upload: boolean) => {
      const timer = setTimeout(() => {
        void this.#turn(upload).finally(() => {
          if (!this.#closed) loop(upload);
        });
      }, 1000);
      timer.unref();
      if (upload) this.#uploadTimer = timer;
      else this.#inboundTimer = timer;
    };
    loop(false);
    loop(true);
    const metadata = () => {
      this.#metadataTimer = setTimeout(() => {
        void this.#metadataTurn().finally(() => {
          if (!this.#closed) metadata();
        });
      }, 1000);
      this.#metadataTimer.unref();
    };
    metadata();
  }
  close() {
    this.#closed = true;
    clearTimeout(this.#inboundTimer);
    clearTimeout(this.#uploadTimer);
    clearTimeout(this.#metadataTimer);
    for (const pref of this.#connections) this.#cancel(pref);
    this.#probe?.cancel();
  }
  async #metadataTurn() {
    if (this.#closed || this.#storageUncertain || !this.#sync.canRelay?.()) return;
    const actions = this.#connections.flatMap((pref) => [
      ...(pref.direction !== "publish" ? [{ pref, report: true }] : []),
      ...(pref.direction !== "receive" ? [{ pref, report: false }] : []),
    ]);
    if (!actions.length) return;
    const action = actions[this.#metadataIndex++ % actions.length];
    if (!action) return;
    const { pref, report } = action,
      trace = `tr_metadata_${randomUUID().replaceAll("-", "")}`;
    try {
      const replica = await this.#ready(pref, trace);
      this.#owner(pref);
      const attempt = this.#attempt(pref, replica);
      try {
        if (report)
          await this.#sync.statusReport(
            pref.botId,
            { peerDeviceId: pref.peerDeviceId },
            trace,
            attempt.context,
          );
        else {
          const result = relayStatusResult.parse(
            await this.#sync.statusRead(
              pref.botId,
              { peerDeviceId: pref.peerDeviceId },
              trace,
              attempt.context,
            ),
          );
          attempt.context.guard();
          if (result.snapshots.length)
            this.#state(pref).peerApplied = {
              ...result,
              current: "unknown",
              authenticatedAt: Date.now(),
            };
          else delete this.#state(pref).peerApplied;
        }
      } finally {
        attempt.cancel();
        attempt.release();
      }
    } catch {
      // Metadata failures retain their own origin; applied data and the other slots continue.
    }
  }
  async #turn(upload: boolean) {
    if (this.#closed || this.#storageUncertain) return;
    const prefs = this.#connections.filter(
      (p) =>
        (p.direction === "both" || p.direction === (upload ? "publish" : "receive")) &&
        (upload ||
          p.pendingApply !== undefined ||
          !this.#probe ||
          this.#state(p).route === "cache"),
    );
    if (!prefs.length) return;
    const pref = prefs[(upload ? this.#uploadIndex++ : this.#receiveIndex++) % prefs.length];
    if (!pref) return;
    const trace = `tr_auto_${randomUUID().replaceAll("-", "")}`;
    try {
      const replica = await this.#ready(pref, trace);
      if (this.#closed || !this.#connections.includes(pref)) return;
      if (!upload && pref.pendingApply !== undefined) {
        const attempt = this.#attempt(pref, replica);
        try {
          await this.#sync.applyObject(pref.botId, pref.pendingApply, trace, attempt.context);
          delete pref.pendingApply;
          this.#save(trace, pref.botId);
          this.#state(pref).status = "pending";
        } finally {
          attempt.cancel();
          attempt.release();
        }
        return;
      }
      if (!upload && pref.pendingReceipt) {
        const attempt = this.#attempt(pref, replica);
        try {
          await this.#ackReceipt(pref, trace, attempt.context);
        } finally {
          attempt.cancel();
          attempt.release();
        }
        return;
      }
      const status = replicaStatus.parse(await replica.command("status", {}));
      this.#owner(pref);
      if (upload) {
        if (this.#sync.canRelay?.())
          void this.#sync
            .relayRegister(pref.botId, trace, { replica, guard: () => this.#owner(pref) })
            .catch(() => undefined);
        const local = status.streams.find(
          (stream) =>
            stream.source.replicaId === pref.binding.replicaId &&
            stream.source.epoch === pref.binding.epoch,
        );
        if (pref.upload.pending || (local && local.known > pref.upload.after))
          await this.#upload(pref, replica, trace);
      } else await this.#receive(pref, replica, status, trace);
    } catch (error) {
      const state = this.#state(pref);
      state.status = error instanceof ClassifiedFailure ? error.failure.kind : "unavailable";
      // Actual sync/registry crossings own their origin and propagated failure logs.
    }
  }
  async #ackReceipt(pref: SyncPreference, trace: string, attempt: SyncAttempt) {
    if (!pref.pendingReceipt) return;
    try {
      await this.#sync.relayAck(pref.botId, pref.pendingReceipt, trace, attempt);
    } catch (error) {
      const remote = syncRemoteFailure(error);
      if (remote?.status !== 410 || remote.code !== "sync_relay_delivery_unavailable") throw error;
    }
    attempt.guard();
    delete pref.pendingReceipt;
    this.#save(trace, pref.botId);
  }
  async #upload(pref: SyncPreference, replica: ReadyReplica, trace: string) {
    const attempt = this.#attempt(pref, replica);
    try {
      const result = (await this.#sync.cachePublish(
        pref.botId,
        pref.upload.pending
          ? { peerDeviceId: pref.peerDeviceId, objectId: pref.upload.pending.objectId }
          : {
              peerDeviceId: pref.peerDeviceId,
              source: { replicaId: pref.binding.replicaId, epoch: pref.binding.epoch },
              after: pref.upload.after,
              limit: pref.upload.single ? 1 : 128,
            },
        trace,
        {
          ...attempt.context,
          prepared: (manifest) => {
            attempt.context.guard();
            if (
              pref.upload.split &&
              manifest.included.some(
                (event) =>
                  !pref.upload.split?.included.some(
                    (original) =>
                      original.seq === event.seq && original.eventDigest === event.eventDigest,
                  ),
              )
            )
              throw new Error("sync_cache_event_conflict");
            pref.upload.pending = syncUploadPage.parse({
              objectId: manifest.objectId,
              source: manifest.source,
              included: manifest.included,
              nextAfter: manifest.nextAfter,
              hasMore: manifest.hasMore,
            });
            this.#save(trace, pref.botId);
          },
        },
      )) as (
        | { cloudCached: true; firstCachedAt: number; expiresAt: number }
        | { cloudCached: false }
      ) & { page: z.infer<typeof syncUploadPage> };
      attempt.context.guard();
      if (result.cloudCached) {
        pref.upload.after = result.page.nextAfter;
        pref.upload.cloudCached = {
          ...syncUploadPage.parse(result.page),
          firstCachedAt: result.firstCachedAt,
          expiresAt: result.expiresAt,
        };
        pref.upload.single = pref.upload.after < pref.upload.splitThrough;
        if (!pref.upload.single) delete pref.upload.split;
      }
      delete pref.upload.pending;
      this.#save(trace, pref.botId);
    } catch (error) {
      const remote = syncRemoteFailure(error);
      if (
        remote?.status === 410 &&
        pref.upload.pending &&
        remote.code === "sync_cache_event_expired"
      ) {
        attempt.context.guard();
        const pending = pref.upload.pending;
        if (pending.included.length > 1) {
          pref.upload.splitThrough = Math.max(pref.upload.splitThrough, pending.nextAfter);
          pref.upload.split = pending;
          pref.upload.single = true;
          delete pref.upload.pending;
          this.#save(trace, pref.botId);
        } else if (pending.included.length === 1 && remote.code === "sync_cache_event_expired") {
          const first = pending.included[0] as { seq: number };
          pref.upload.after = first.seq;
          pref.upload.expiredThrough = Math.max(pref.upload.expiredThrough, first.seq);
          delete pref.upload.pending;
          pref.upload.single = pref.upload.after < pref.upload.splitThrough;
          if (!pref.upload.single) delete pref.upload.split;
          this.#save(trace, pref.botId);
        }
      }
      throw error;
    } finally {
      attempt.release();
    }
  }
  async #cache(
    pref: SyncPreference,
    source: Source,
    status: z.infer<typeof replicaStatus>,
    trace: string,
    attempt: SyncAttempt,
  ) {
    const state = this.#state(pref);
    const key = sourceKey(source);
    const stream = (value: z.infer<typeof replicaStatus>) =>
      value.streams.find((stream) => sourceKey(stream.source) === key);
    let actual = status;
    const initial = stream(actual);
    const after = initial?.received ?? 0;
    const tail = Math.max(after, ...(initial?.available.map((range) => range.to) ?? []));
    const scan = state.scan.get(key) ?? {
      after: tail,
      gap: after < tail ? after + 1 : undefined,
      revisit: false,
    };
    state.scan.set(key, scan);
    if (scan.gap !== undefined && scan.gap <= (stream(actual)?.received ?? 0)) scan.gap = undefined;
    const repair = scan.gap !== undefined && scan.revisit;
    const cursor = repair ? (scan.gap as number) - 1 : Math.max(after, scan.after);
    const result = cacheListResult.parse(
      await this.#sync.cacheList(
        pref.botId,
        { peerDeviceId: pref.peerDeviceId, source, after: cursor, limit: 128 },
        trace,
        attempt,
      ),
    );
    const seen = new Set<string>();
    for (const object of result.objects) {
      if (seen.has(object.objectId)) continue;
      seen.add(object.objectId);
      attempt.guard();
      const stored = await this.#sync.storedObject(pref.botId, object, source, trace, attempt);
      const current = stream(actual);
      const available = object.included.every((event) =>
        current?.available.some((range) => range.from <= event.seq && event.seq <= range.to),
      );
      if (stored && available) continue;
      if (!stored)
        await this.#sync.cacheReceive(
          pref.botId,
          { peerDeviceId: pref.peerDeviceId, objectId: object.objectId },
          trace,
          attempt,
        );
      attempt.guard();
      pref.pendingApply = object.objectId;
      this.#save(trace, pref.botId);
      // Missing received facts retry from the local object; #drain handles cross-source dependencies.
      const applied = (await this.#sync.applyObject(
        pref.botId,
        object.objectId,
        trace,
        attempt,
      )) as { applied: unknown };
      actual = replicaStatus.parse(applied.applied);
      delete pref.pendingApply;
      this.#save(trace, pref.botId);
    }
    if (result.nextAfter < cursor) throw new Error("sync_cache_invalid");
    if (!repair) scan.after = result.nextAfter;
    const received = stream(actual)?.received ?? 0;
    const gaps = result.gaps.filter((gap) => gap.seq > received);
    const firstGap = gaps[0]?.seq;
    if (firstGap !== undefined) scan.gap = Math.min(scan.gap ?? firstGap, firstGap);
    if (received < scan.after) scan.gap = Math.min(scan.gap ?? received + 1, received + 1);
    else if (!gaps.length) scan.gap = undefined;
    scan.revisit = !repair;
    state.status = scan.gap !== undefined ? "gap" : "cache_incomplete";
    return { actual, cursor, needed: scan.gap !== undefined || result.objects.length === 0 };
  }
  async #cloud(
    pref: SyncPreference,
    source: Source | undefined,
    status: z.infer<typeof replicaStatus>,
    trace: string,
    attempt: SyncAttempt,
  ) {
    const cached = source ? await this.#cache(pref, source, status, trace, attempt) : undefined;
    if (cached && !cached.needed) return;
    if (!this.#sync.canRelay?.()) {
      if (!source) this.#state(pref).status = "needs_baseline";
      return;
    }
    attempt.guard();
    const directory = relayDirectory.parse(
      await this.#sync.relayDiscover(pref.botId, trace, attempt),
    );
    const actual = cached?.actual ?? status;
    const options = directory.holders.flatMap((holder) =>
      holder.streams
        .filter((s) => s.source.replicaId !== pref.binding.replicaId && s.available.length)
        .map((stream) => ({ holder, stream })),
    );
    options.sort(
      (a, b) =>
        Number(source !== undefined && sourceKey(b.stream.source) === sourceKey(source)) -
          Number(source !== undefined && sourceKey(a.stream.source) === sourceKey(source)) ||
        Number(b.holder.identity.deviceId === pref.peerDeviceId) -
          Number(a.holder.identity.deviceId === pref.peerDeviceId),
    );
    const cursorFor = (streamSource: Source) =>
      source && sourceKey(source) === sourceKey(streamSource) && cached
        ? cached.cursor
        : (actual.streams.find((s) => sourceKey(s.source) === sourceKey(streamSource))?.received ??
          0);
    const selected = options.find(({ stream }) => {
      const local = actual.streams.find((s) => sourceKey(s.source) === sourceKey(stream.source));
      const cursor = cursorFor(stream.source);
      return (
        stream.available.some((r) => r.from <= cursor + 1 && r.to > cursor) &&
        !local?.available.some(
          (r) =>
            r.from <= cursor + 1 &&
            r.to >= Math.min(cursor + 128, stream.available.at(-1)?.to ?? cursor),
        )
      );
    });
    if (!selected) {
      if (!source) this.#state(pref).status = "needs_baseline";
      return;
    }
    const selectedSource = selected.stream.source;
    const cursor = cursorFor(selectedSource);
    const received = z
      .object({ objectId: z.string(), delivery: RelayDelivery, page: syncUploadPage })
      .parse(
        await this.#sync.relayPull(
          pref.botId,
          {
            peerDeviceId: selected.holder.identity.deviceId,
            source: selectedSource,
            after: cursor,
            limit: 128,
          },
          trace,
          attempt,
        ),
      );
    attempt.guard();
    if (
      sourceKey(received.page.source) !== sourceKey(selectedSource) ||
      received.page.nextAfter < cursor
    )
      throw new Error("sync_relay_delivery_invalid");
    pref.pendingApply = received.objectId;
    pref.pendingReceipt = {
      peerDeviceId: selected.holder.identity.deviceId,
      delivery: received.delivery,
    };
    this.#save(trace, pref.botId);
    await this.#sync.applyObject(pref.botId, received.objectId, trace, attempt);
    attempt.guard();
    delete pref.pendingApply;
    this.#save(trace, pref.botId);
    await this.#ackReceipt(pref, trace, attempt);
    const state = this.#state(pref),
      key = sourceKey(selectedSource);
    const scan = state.scan.get(key) ?? { after: cursor, gap: undefined, revisit: false };
    scan.after = Math.max(scan.after, received.page.nextAfter);
    state.scan.set(key, scan);
    state.status = "relay_incomplete";
  }
  async #receive(
    pref: SyncPreference,
    replica: ReadyReplica,
    status: z.infer<typeof replicaStatus>,
    trace: string,
  ) {
    const state = this.#state(pref);
    const sources = status.streams
      .map((s) => s.source)
      .filter((s) => s.replicaId !== pref.binding.replicaId);
    if (pref.source && !sources.some((s) => sourceKey(s) === sourceKey(pref.source as Source)))
      sources.unshift(pref.source);
    const source = sources[state.sourceIndex++ % sources.length];
    const after =
      status.streams.find((s) => sourceKey(s.source) === (source ? sourceKey(source) : ""))
        ?.received ?? 0;
    if (state.switchPending && !this.#probe) {
      state.route = "direct";
      state.switchPending = false;
    }
    if (state.route === "cache") {
      if (!this.#probe && Date.now() - state.probeAt >= 15000) {
        state.probeAt = Date.now();
        const probe = this.#attempt(pref, replica);
        const active = { pref, cancel: probe.cancel };
        this.#probe = active;
        void this.#sync
          .pull(
            pref.botId,
            { peerDeviceId: pref.peerDeviceId, ...(source ? { source } : {}), after, limit: 128 },
            trace,
            probe.context,
            true,
          )
          .then(() => {
            probe.context.guard();
            state.probeAt = Date.now();
            state.streak++;
            if (state.streak >= 2 && Date.now() - state.since >= 30000) state.switchPending = true;
          })
          .catch(() => {
            state.streak = 0;
          })
          .finally(() => {
            probe.cancel();
            probe.release();
            if (this.#probe === active) this.#probe = undefined;
          });
      }
      const cache = this.#attempt(pref, replica);
      try {
        await this.#cloud(pref, source, status, trace, cache.context);
      } finally {
        cache.cancel();
        cache.release();
      }
      return;
    }
    const direct = this.#attempt(pref, replica),
      cache = this.#attempt(pref, replica);
    let winner: "direct" | "cache" | undefined;
    const admit = (route: "direct" | "cache") => {
      if (winner && winner !== route) throw new Error("sync_attempt_cancelled");
      winner = route;
      (route === "direct" ? cache : direct).cancel();
    };
    let soft: ReturnType<typeof setTimeout> | undefined;
    let cacheWork: Promise<void> | undefined;
    const startCache = () => {
      if (cacheWork || winner) return cacheWork;
      if (state.route !== "cache") {
        state.route = "cache";
        state.since = Date.now();
        state.probeAt = Date.now();
        state.streak = 0;
      }
      cacheWork = this.#cloud(pref, source, status, trace, {
        ...cache.context,
        admit: () => admit("cache"),
      });
      // The competition observes both candidates; late failures must not become unhandled.
      void cacheWork.catch(() => undefined);
      return cacheWork;
    };
    try {
      try {
        const result = (await this.#sync.pull(
          pref.botId,
          { peerDeviceId: pref.peerDeviceId, ...(source ? { source } : {}), after, limit: 128 },
          trace,
          {
            ...direct.context,
            admit: () => admit("direct"),
            connecting: () => {
              direct.context.guard();
              soft = setTimeout(() => {
                void startCache();
              }, 2500);
            },
            authenticated: () => {
              clearTimeout(soft);
            },
          },
        )) as { page: { source: Source } };
        if (!pref.source) {
          pref.source = syncSource.parse(result.page.source);
          this.#save(trace, pref.botId);
        }
        state.route = "direct";
        state.status = "direct";
      } catch (error) {
        if (syncTransportFailure(error)) await startCache();
        else if (!winner) {
          cache.cancel();
          throw error;
        }
      }
      if (cacheWork)
        await cacheWork.catch((error) => {
          if (winner !== "direct") throw error;
        });
    } finally {
      clearTimeout(soft);
      direct.cancel();
      cache.cancel();
      direct.release();
      cache.release();
    }
  }
}
