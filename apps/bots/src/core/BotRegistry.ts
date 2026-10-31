// Bot lifecycle (docs/bots/ARCHITECTURE.md "Bot lifecycle"): the catalog, the one in-flight
// open per bot, idle close, quarantine with its retry, the startup recovery scan and
// delete. The registry owns state; the service owns routing; the adapter owns the Harness.
import { randomUUID } from "node:crypto";
import { declareEvent } from "../log/events.ts";
import type { Log } from "../log/log.ts";
import type { BotConfig, BotDirectory } from "./BotDirectory.ts";
import type { DeviceSyncPort } from "./DeviceSyncPort.ts";
import {
  type BotAppearance,
  type BotGroup,
  type BotState,
  type BotSummary,
  ClassifiedFailure,
  DEFAULT_APPEARANCE,
  DEFAULT_THINKING_LEVEL,
  DEFAULT_TOOL_GROUPS,
  type ErrorKind,
  type Failure,
  resolveToolGroups,
  type ToolGroup,
} from "./domain.ts";
import { newFailure } from "./failures.ts";
import type { RuntimeBotSpec, RuntimeHandle, RuntimePort } from "./RuntimePort.ts";
import {
  parseTombstones,
  type Tombstone,
  tombstoneApplySchema,
  tombstonePullSchema,
  tombstoneSchema,
} from "./Tombstones.ts";

const Events = {
  syncStart: declareEvent("core.sync.start"),
  syncOk: declareEvent("core.sync.ok"),
  syncFail: declareEvent("core.sync.fail"),
  catalogLoadOk: declareEvent("core.catalog.load.ok"),
  catalogWriteOk: declareEvent("core.catalog.write.ok"),
  catalogWriteFail: declareEvent("core.catalog.write.fail"),
  resolveFail: declareEvent("core.bot.resolve.fail"),
  catalogLoadFail: declareEvent("core.catalog.load.fail"),
  openStart: declareEvent("core.bot.open.start"),
  openOk: declareEvent("core.bot.open.ok"),
  openFail: declareEvent("core.bot.open.fail"),
  closeOk: declareEvent("core.bot.close.ok"),
  closeFail: declareEvent("core.bot.close.fail"),
  closeDegrade: declareEvent("core.bot.close.degrade"),
  deleteStart: declareEvent("core.delete.start"),
  deleteOk: declareEvent("core.delete.ok"),
  deleteFail: declareEvent("core.delete.fail"),
  reconcileOk: declareEvent("core.reconcile.ok"),
  groupWriteOk: declareEvent("core.group.write.ok"),
  recoveryStart: declareEvent("core.recovery.start"),
  recoveryBotOk: declareEvent("core.recovery.bot.ok"),
  recoveryBotFail: declareEvent("core.recovery.bot.fail"),
  recoveryOk: declareEvent("core.recovery.ok"),
  replicaStart: declareEvent("core.replica.start"),
  replicaOk: declareEvent("core.replica.ok"),
  replicaFail: declareEvent("core.replica.fail"),
} as const;

type Entry = {
  config: BotConfig;
  sharedBotId: string | undefined;
  deleted: boolean;
  /** The wire state; `closing` is internal and never leaves the registry. */
  state: BotState;
  closing: boolean;
  handle: RuntimeHandle | undefined;
  opening: Promise<RuntimeHandle> | undefined;
  subscribers: number;
  /**
   * Bumped by every lease. An idle-close decision that spans `await busy()` is stale when
   * this moved, because a run may have started after the port answered (TRIGGERS.md §3.3).
   */
  activity: number;
  /** A delete owns the bot: no new lease, no new open, and no close until leases drain. */
  deleting: boolean;
  /** Waiters for "no lease is held", so a delete drains instead of polling. */
  readonly leaseWaiters: (() => void)[];
  unavailable: { readonly reason: ErrorKind; readonly message: string } | undefined;
  cancelIdle: (() => void) | undefined;
  cancelRetry: (() => void) | undefined;
  /** Resolves when an in-flight close or delete settles; an open waits on it. */
  settling: Promise<void> | undefined;
};

export type RegistryOptions = {
  readonly deviceSync?: DeviceSyncPort;
  readonly directory: BotDirectory;
  readonly openRuntime: (spec: RuntimeBotSpec) => Promise<RuntimeHandle>;
  readonly readReplicaBinding?: RuntimePort["readReplicaBinding"];
  readonly model: { readonly provider: string; readonly modelId: string };
  /** The reasoning level a newly created bot records; settings can change it at runtime. */
  readonly thinkingLevel?: string;
  /** The tool groups a newly created bot records; settings can change it at runtime. */
  readonly toolGroups?: readonly ToolGroup[];
  readonly log: Log;
  readonly idleCloseMs: number;
  readonly quarantineRetryMs: number;
  readonly closeDeadlineMs: number;
  /** Timers, so idle close and the quarantine retry are testable without sleeping. */
  readonly setTimer?: (run: () => void, delayMs: number) => () => void;
  readonly now?: () => Date;
  readonly newBotId?: () => string;
  /** Trace for daemon-created work: idle closes, retries, the recovery scan. */
  readonly bootTrace?: () => string;
  /** Encoded size of one `BotSummary`: the catalog event has to fit the frame cap. */
  readonly measureSummary?: (summary: BotSummary) => number;
  /** PROTOCOL.md, "Limits": one `BotSummary` is at most 1 200 encoded bytes. */
  readonly maxSummaryBytes?: number;
};

export const MAX_SUMMARY_BYTES = 1_200;
/** PROTOCOL.md, "Limits": the catalog holds at most this many bots. */
export const MAX_CATALOG_BOTS = 200;

const jsonBytes = (summary: BotSummary): number =>
  Buffer.byteLength(JSON.stringify(summary), "utf8");

/** UUIDv7: the timestamp prefix keeps catalog and directory order stable. */
export const newBotId = (now: number = Date.now()): string => {
  const bytes = Buffer.from(randomUUID().replaceAll("-", ""), "hex");
  const random = Buffer.from(randomUUID().replaceAll("-", ""), "hex");
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = 0x70 | ((random[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((random[8] ?? 0) & 0x3f);
  for (let index = 9; index < 16; index += 1) bytes[index] = random[index] ?? 0;
  const hex = bytes.toString("hex");
  return `b_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const unavailable = (reason: ErrorKind, message: string) => ({ reason, message });

const TASK_ID = /^t_\d+$/;

/** A task id crosses as `t_<n>`; anything else never reaches the runtime. */
const assertTaskId = (taskId: string): void => {
  if (TASK_ID.test(taskId)) return;
  throw new ClassifiedFailure(
    newFailure("invalid_command"),
    "not_admitted",
    "task ids look like t_12",
  );
};

type ReplicaBinding = NonNullable<
  Awaited<ReturnType<NonNullable<RuntimePort["readReplicaBinding"]>>>
>;
export type ReadyReplica = {
  readonly botId: string;
  readonly sharedBotId: string;
  readonly binding: Readonly<ReplicaBinding>;
  /** Final synchronous object/slot publication only; all staging happens before this lease. */
  publish(action: () => undefined, guard: () => void): Promise<void>;
  check(): Promise<void>;
  command(
    method: "pull" | "apply" | "status" | "heads" | "head" | "context" | "merge",
    params: unknown,
    guard?: () => void,
  ): Promise<unknown>;
};

export class BotRegistry {
  /** A sync request may lease an existing healthy handle, never open or recover one. */
  async readyReplica(botId: string, trace: string, uniqueShared?: string): Promise<ReadyReplica> {
    const first = await this.#syncLease(botId, trace, uniqueShared);
    const use = (
      method?: Parameters<ReadyReplica["command"]>[0],
      params?: unknown,
      guard?: () => void,
    ) => this.#syncLease(botId, trace, uniqueShared, first, method, params, guard);
    return {
      botId,
      sharedBotId: first.sharedBotId,
      binding: first.binding,
      publish: async (action, guard) => {
        await this.#syncLease(
          botId,
          trace,
          uniqueShared,
          first,
          undefined,
          undefined,
          guard,
          action,
        );
      },
      check: async () => {
        await use();
      },
      command: async (method, params, guard) => (await use(method, params, guard)).result,
    };
  }

  async readySharedReplica(sharedBotId: string, trace: string): Promise<ReadyReplica> {
    const matches = await this.#directorySerial(() => this.#syncAliases(sharedBotId)).catch(
      (error) => this.#syncStorageFailure(error, trace),
    );
    if (matches.length !== 1)
      throw this.#syncRefused(trace, undefined, "shared Bot binding is absent or ambiguous");
    return this.readyReplica(matches[0] as string, trace, sharedBotId);
  }

  async #syncAliases(sharedBotId: string): Promise<string[]> {
    const matches: string[] = [];
    for (const [botId, entry] of this.#entries) {
      if (entry.deleted) continue;
      const binding = await this.#options.readReplicaBinding?.({
        id: botId,
        dir: this.#options.directory.botDir(botId),
      });
      if (binding?.sharedBotId === sharedBotId) matches.push(botId);
    }
    return matches;
  }

  #syncRefused(trace: string, botId: string | undefined, message: string): ClassifiedFailure {
    const failure = newFailure("invalid_command");
    this.#options.log.emit("error", "core", Events.syncFail, {
      trace,
      ...(botId === undefined ? {} : { botId }),
      failure,
      origin: true,
    });
    return new ClassifiedFailure(failure, "not_admitted", message);
  }

  #syncStorageFailure(error: unknown, trace: string, botId?: string): never {
    if (error instanceof ClassifiedFailure) throw error;
    const failure = newFailure("storage_failed");
    this.#options.log.emit("error", "core", Events.syncFail, {
      trace,
      ...(botId === undefined ? {} : { botId }),
      failure,
      origin: true,
    });
    throw new ClassifiedFailure(failure, "not_admitted", "sync binding could not be read", {
      cause: error,
    });
  }

  #syncLease(
    botId: string,
    trace: string,
    uniqueShared?: string,
    expected?: {
      entry: Entry;
      handle: RuntimeHandle;
      sharedBotId: string;
      binding: ReplicaBinding;
    },
    method?: Parameters<ReadyReplica["command"]>[0],
    params?: unknown,
    guard?: () => void,
    publish?: () => undefined,
  ): Promise<{
    entry: Entry;
    handle: RuntimeHandle;
    sharedBotId: string;
    binding: ReplicaBinding;
    result: unknown;
  }> {
    return this.#directorySerial(async () => {
      const entry = this.#entry(botId, trace);
      const handle = entry.handle;
      const healthy = () =>
        this.#entries.get(botId) === entry &&
        entry.handle === handle &&
        handle !== undefined &&
        handle.replica !== undefined &&
        !entry.deleted &&
        !entry.closing &&
        !entry.deleting &&
        entry.settling === undefined &&
        ["idle", "running"].includes(entry.state) &&
        entry.unavailable === undefined;
      if (!healthy() || (expected && (expected.entry !== entry || expected.handle !== handle)))
        throw this.#syncRefused(
          trace,
          botId,
          "sync requires the same ready local Bot; recover it locally first",
        );
      this.#touch(entry);
      try {
        const binding = await this.#options.readReplicaBinding?.({
          id: botId,
          dir: this.#options.directory.botDir(botId),
        });
        if (
          !binding ||
          (expected &&
            (["localBotId", "sharedBotId", "replicaId", "epoch"] as const).some(
              (key) => expected.binding[key] !== binding[key],
            )) ||
          (uniqueShared !== undefined &&
            (uniqueShared !== binding.sharedBotId ||
              (await this.#syncAliases(uniqueShared)).length !== 1)) ||
          (await this.#options.directory.isDeleted(binding.sharedBotId)) ||
          !healthy()
        )
          throw this.#syncRefused(trace, botId, "sync Bot identity or lifecycle changed");
        if (publish) {
          guard?.();
          publish();
        }
        const completeBinding =
          binding.localBotId !== undefined &&
          binding.replicaId !== undefined &&
          binding.epoch !== undefined
            ? {
                localBotId: binding.localBotId,
                sharedBotId: binding.sharedBotId,
                replicaId: binding.replicaId,
                epoch: binding.epoch,
              }
            : undefined;
        const result =
          method === undefined
            ? undefined
            : await (handle as RuntimeHandle).replica?.({
                method,
                params,
                trace,
                ...(guard === undefined ? {} : { guard }),
                ...(completeBinding === undefined ? {} : { expectedBinding: completeBinding }),
              });
        if (!healthy()) throw this.#syncRefused(trace, botId, "sync Bot lifecycle changed");
        return {
          entry,
          handle: handle as RuntimeHandle,
          sharedBotId: binding.sharedBotId,
          binding: { ...binding },
          result,
        };
      } finally {
        this.release(botId);
      }
    }).catch((error) => this.#syncStorageFailure(error, trace, botId));
  }

  async syncAccess(
    botId: string,
    input: Omit<Parameters<DeviceSyncPort["access"]>[0], "sharedBotId">,
    trace: string,
  ): Promise<unknown> {
    const fields = { botId, trace };
    this.#options.log.emit("info", "core", Events.syncStart, fields);
    try {
      const binding = async () => {
        const entry = this.#entry(botId, trace);
        const result = await this.#options.readReplicaBinding?.({
          id: botId,
          dir: this.#options.directory.botDir(botId),
        });
        if (result === undefined)
          throw new ClassifiedFailure(
            newFailure("invalid_command"),
            "not_admitted",
            "Bot has no shared identity binding",
          );
        if (await this.#options.directory.isDeleted(result.sharedBotId))
          throw this.#unresolved(botId, trace);
        if (this.#entry(botId, trace) !== entry) throw this.#unresolved(botId, trace);
        return result.sharedBotId;
      };
      const sharedBotId = await this.#directorySerial(binding);
      const port = this.#options.deviceSync;
      if (port === undefined)
        throw new ClassifiedFailure(
          newFailure("invalid_command"),
          "not_admitted",
          "device synchronization is not configured",
        );
      const result = await port.access({ ...input, sharedBotId }, fields);
      await this.#directorySerial(async () => {
        if ((await binding()) !== sharedBotId)
          throw new ClassifiedFailure(
            newFailure("invalid_command"),
            "not_admitted",
            "Bot shared identity changed",
          );
      });
      this.#options.log.emit("info", "core", Events.syncOk, fields);
      return result;
    } catch (error) {
      const classified =
        error instanceof ClassifiedFailure
          ? error
          : new ClassifiedFailure(
              newFailure("storage_failed"),
              "not_admitted",
              "sync binding could not be read",
              { cause: error },
            );
      const own = classified.failure.layer === "core" && classified.failure.kind !== "unknown_bot";
      this.#options.log.emit(own ? "error" : "warn", "core", Events.syncFail, {
        ...fields,
        failure: classified.failure,
        ...(own ? { origin: true } : { detail: { propagated: true } }),
      });
      throw classified;
    }
  }
  async replica(
    botId: string,
    command: Parameters<NonNullable<RuntimeHandle["replica"]>>[0],
  ): Promise<unknown> {
    if (command.method === "bind")
      return this.#directorySerial(() => this.#replica(botId, command));
    return this.#replica(botId, command);
  }

  async #replica(
    botId: string,
    command: Parameters<NonNullable<RuntimeHandle["replica"]>>[0],
  ): Promise<unknown> {
    const fields = { botId, trace: command.trace };
    this.#options.log.emit("info", "core", Events.replicaStart, fields);
    let leased = false;
    try {
      leased = this.touch(botId);
      if (!leased)
        throw new ClassifiedFailure(
          newFailure("unknown_bot"),
          "not_admitted",
          "bot is unavailable",
        );
      const binding =
        command.method === "bind" ? parseTombstones(tombstoneSchema, command.params) : undefined;
      if (binding !== undefined && (await this.#options.directory.isDeleted(binding.sharedBotId)))
        throw new ClassifiedFailure(
          newFailure("invalid_command"),
          "not_admitted",
          "shared Bot is permanently deleted",
        );
      const handle = await this.open(botId, command.trace);
      if (handle.replica === undefined)
        throw new ClassifiedFailure(
          newFailure("invalid_command"),
          "not_admitted",
          "runtime has no history handoff",
        );
      const result = await handle.replica(command);
      if (binding !== undefined)
        this.#entry(botId, command.trace).sharedBotId = binding.sharedBotId;
      this.#options.log.emit("info", "core", Events.replicaOk, fields);
      return result;
    } catch (error) {
      const failure =
        error instanceof ClassifiedFailure ? error.failure : newFailure("storage_failed");
      this.#options.log.emit(
        failure.layer === "core" ? "error" : "warn",
        "core",
        Events.replicaFail,
        { ...fields, failure, ...(failure.layer === "core" ? { origin: true } : {}) },
      );
      throw error;
    } finally {
      if (leased) this.release(botId);
    }
  }
  readonly #options: RegistryOptions;
  readonly #entries = new Map<string, Entry>();
  #directoryTail: Promise<unknown> = Promise.resolve();

  #directorySerial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.#directoryTail.then(action);
    this.#directoryTail = next.catch(() => undefined);
    return next;
  }

  async tombstones(
    method: "pull" | "apply" | "status",
    params: unknown,
    trace: string,
  ): Promise<unknown> {
    this.#options.log.emit("info", "core", Events.replicaStart, { trace });
    try {
      let result: unknown;
      if (method === "pull") {
        const { after, limit } = parseTombstones(tombstonePullSchema, params);
        result = await this.#options.directory.tombstones(after, limit);
      } else {
        const { items } = parseTombstones(tombstoneApplySchema, params);
        result = await this.#directorySerial(async () => {
          const affected = await this.#persistDeleted(items);
          for (const entry of affected) await this.#removeEntry(entry, entry.config.id, trace);
          return {};
        });
      }
      this.#options.log.emit("info", "core", Events.replicaOk, { trace });
      return result;
    } catch (error) {
      const failure =
        error instanceof ClassifiedFailure ? error.failure : newFailure("storage_failed");
      const own =
        failure.layer === "core" &&
        !(error instanceof ClassifiedFailure && error.disposition === "runtime");
      this.#options.log.emit(own ? "error" : "warn", "core", Events.replicaFail, {
        trace,
        failure,
        ...(own ? { origin: true } : { detail: { propagated: true } }),
      });
      throw error instanceof ClassifiedFailure
        ? error
        : new ClassifiedFailure(failure, "runtime", "tombstone storage failed", { cause: error });
    }
  }

  async #persistDeleted(items: readonly Tombstone[]): Promise<Entry[]> {
    const ids = new Set(items.map((item) => item.sharedBotId));
    const affected = [...this.#entries.values()].filter(
      (entry) => entry.sharedBotId !== undefined && ids.has(entry.sharedBotId),
    );
    const prior = affected.map((entry) => entry.deleted);
    for (const entry of affected) entry.deleted = true;
    try {
      await this.#options.directory.markDeleted(
        items,
        Object.fromEntries(affected.map((entry) => [entry.config.id, entry.sharedBotId as string])),
      );
    } catch (error) {
      for (const [index, entry] of affected.entries()) entry.deleted = prior[index] ?? false;
      throw error;
    }
    return affected;
  }
  /** The model a newly created bot records; settings can change it at runtime. */
  #defaultModel: { readonly provider: string; readonly modelId: string };
  /** The reasoning level a newly created bot records; settings can change it at runtime. */
  #defaultThinkingLevel: string;
  /** The tool groups a newly created bot records; settings can change it at runtime. */
  #defaultToolGroups: readonly ToolGroup[];
  /** The sidebar groups, refreshed on load and after every mutation. */
  #groups: readonly BotGroup[] = [];
  readonly #boot: () => string;
  #sequence = 0;
  /** Creations in flight, so two concurrent creates cannot both take the last slot. */
  #creating = 0;

  constructor(options: RegistryOptions) {
    this.#defaultModel = options.model;
    this.#defaultThinkingLevel = options.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
    this.#defaultToolGroups = options.toolGroups ?? DEFAULT_TOOL_GROUPS;
    this.#options = options;
    this.#boot =
      options.bootTrace ??
      (() => {
        this.#sequence += 1;
        return `tr_boot_${this.#sequence}`;
      });
  }

  /** Loads the catalog, finishes an interrupted delete, then scans for active work. */
  async start(): Promise<void> {
    const trace = this.#boot();
    this.#groups = await this.#options.directory.loadGroups().catch(() => []);
    try {
      const reconciled = await this.#options.directory.reconcile();
      const finished = new Set(reconciled.finishedDeletes);
      let failed = reconciled.failedDeletes;
      let discoveredAlias = false;
      const bots = await this.#options.directory.load();
      this.#options.log.emit("info", "core", Events.catalogLoadOk, {
        trace,
        detail: { count: bots.length },
      });
      for (const config of bots) {
        let binding: { sharedBotId: string } | undefined;
        let bindingFailure: Failure | undefined;
        try {
          binding = await this.#options.readReplicaBinding?.({
            id: config.id,
            dir: this.#options.directory.botDir(config.id),
          });
        } catch (error) {
          bindingFailure =
            error instanceof ClassifiedFailure ? error.failure : newFailure("storage_failed");
          this.#options.log.emit(
            bindingFailure.layer === "core" ? "error" : "warn",
            "core",
            Events.openFail,
            {
              trace,
              botId: config.id,
              failure: bindingFailure,
              ...(bindingFailure.layer === "core"
                ? { origin: true }
                : { detail: { propagated: true } }),
            },
          );
          this.#options.log.emit("warn", "core", Events.recoveryBotFail, {
            trace,
            botId: config.id,
            failure: bindingFailure,
            detail: { propagated: true },
          });
        }
        if (
          binding !== undefined &&
          (await this.#options.directory.isDeleted(binding.sharedBotId))
        ) {
          await this.#options.directory.markDeleted([{ sharedBotId: binding.sharedBotId }], {
            [config.id]: binding.sharedBotId,
          });
          discoveredAlias = true;
          continue;
        }
        this.#entries.set(config.id, {
          config,
          sharedBotId: binding?.sharedBotId,
          deleted: false,
          state: bindingFailure === undefined ? "catalogued" : "unavailable",
          closing: false,
          handle: undefined,
          opening: undefined,
          subscribers: 0,
          activity: 0,
          deleting: false,
          leaseWaiters: [],
          unavailable:
            bindingFailure === undefined
              ? undefined
              : unavailable(bindingFailure.kind, "the replica binding could not be read"),
          cancelIdle: undefined,
          cancelRetry: undefined,
          settling: undefined,
        });
      }
      if (discoveredAlias) {
        const after = await this.#options.directory.reconcile();
        for (const id of after.finishedDeletes) finished.add(id);
        failed = after.failedDeletes;
      }
      for (const botId of failed) {
        this.#options.log.emit("error", "core", Events.deleteFail, {
          trace,
          botId,
          failure: newFailure("storage_failed"),
          origin: true,
          detail: { reason: "startup" },
        });
      }
      this.#options.log.emit("info", "core", Events.reconcileOk, {
        trace,
        detail: { count: finished.size },
      });
    } catch (error) {
      const failure = newFailure("storage_failed");
      this.#options.log.emit("error", "core", Events.catalogLoadFail, {
        trace,
        failure,
        origin: true,
      });
      throw new ClassifiedFailure(failure, "runtime", "the catalog could not be loaded", {
        cause: error,
      });
    }
    await this.#recover(trace);
  }

  /** One summary per catalogued bot, in catalog order. */
  /** The sidebar groups, in display order. */
  groups(): readonly BotGroup[] {
    return this.#groups;
  }

  async createGroup(title: string, trace: string): Promise<BotGroup> {
    const group = await this.#options.directory.createGroup(title);
    this.#groups = await this.#options.directory.loadGroups();
    this.#options.log.emit("info", "core", Events.groupWriteOk, {
      trace,
      detail: { count: this.#groups.length },
    });
    return group;
  }

  async renameGroup(groupId: string, title: string, trace: string): Promise<BotGroup> {
    const group = await this.#options.directory.renameGroup(groupId, title);
    this.#groups = await this.#options.directory.loadGroups();
    this.#options.log.emit("info", "core", Events.groupWriteOk, {
      trace,
      detail: { count: this.#groups.length },
    });
    return group;
  }

  /** Deletes only an empty group; a group that still holds a bot is refused. */
  async deleteGroup(groupId: string, trace: string): Promise<void> {
    await this.#options.directory.deleteGroup(groupId);
    this.#groups = await this.#options.directory.loadGroups();
    this.#options.log.emit("info", "core", Events.groupWriteOk, {
      trace,
      detail: { count: this.#groups.length },
    });
  }

  async reorderGroups(ids: readonly string[], trace: string): Promise<readonly BotGroup[]> {
    const groups = await this.#options.directory.reorderGroups(ids);
    this.#groups = groups;
    this.#options.log.emit("info", "core", Events.groupWriteOk, {
      trace,
      detail: { count: groups.length },
    });
    return groups;
  }

  /** Files a bot under a group, or clears it with `null`; the summary follows at once. */
  async moveBot(botId: string, groupId: string | null, trace: string): Promise<BotSummary> {
    const entry = this.#entry(botId, trace);
    const at = (this.#options.now?.() ?? new Date()).toISOString();
    const config = await this.#write(trace, botId, () =>
      this.#options.directory.setBotGroup(botId, groupId, at),
    );
    entry.config = config;
    return this.#summary(entry);
  }

  summaries(): readonly BotSummary[] {
    return [...this.#entries.values()]
      .filter((entry) => !entry.deleted)
      .map((entry) => this.#summary(entry));
  }

  state(botId: string): BotState | undefined {
    return this.#entries.get(botId)?.state;
  }

  /** True while a close, delete or shutdown owns this bot's lifecycle. */
  settling(botId: string): boolean {
    const entry = this.#entries.get(botId);
    return entry !== undefined && (entry.settling !== undefined || entry.closing);
  }

  /** The handle the registry currently owns; absent after an idle close or a delete. */
  handleOf(botId: string): RuntimeHandle | undefined {
    return this.#entries.get(botId)?.handle;
  }

  /** Name, label or face changed; the catalog keeps the truth and the summary follows. */
  async update(
    botId: string,
    changes: {
      readonly title?: string;
      readonly label?: string | null;
      readonly appearance?: BotAppearance;
    },
    trace: string,
  ): Promise<BotSummary> {
    const entry = this.#entry(botId, trace);
    const at = (this.#options.now?.() ?? new Date()).toISOString();
    const config = await this.#write(trace, botId, () =>
      this.#options.directory.update(botId, changes, at),
    );
    entry.config = config;
    return this.#summary(entry);
  }

  /** Settings changed the gateway: new bots use the new model, existing ones on reopen. */
  setDefaultModel(model: { readonly provider: string; readonly modelId: string }): void {
    this.#defaultModel = model;
  }

  /**
   * Applies a reasoning level to every bot: the catalog records it and a live conversation
   * follows in place, so no answer has to be interrupted.
   */
  async applyThinkingLevel(thinkingLevel: string, trace: string): Promise<void> {
    this.#defaultThinkingLevel = thinkingLevel;
    for (const entry of this.#entries.values()) {
      if (entry.config.thinkingLevel === thinkingLevel) continue;
      const at = (this.#options.now?.() ?? new Date()).toISOString();
      try {
        const config = await this.#write(trace, entry.config.id, () =>
          this.#options.directory.setThinkingLevel(entry.config.id, thinkingLevel, at),
        );
        entry.config = config;
        if (entry.handle?.configureThinkingLevel !== undefined) {
          await entry.handle.configureThinkingLevel(thinkingLevel, trace);
        }
      } catch {
        // One bot that cannot be written must not stop the others.
      }
    }
  }

  /**
   * Applies a gateway model to every bot: the catalog records it, a live conversation is
   * moved in place (its session keeps its history), and a closed one opens with it later.
   */
  async applyModel(
    model: { readonly provider: string; readonly modelId: string },
    trace: string,
  ): Promise<void> {
    this.#defaultModel = model;
    for (const entry of this.#entries.values()) {
      if (
        entry.config.model.provider === model.provider &&
        entry.config.model.modelId === model.modelId
      ) {
        continue;
      }
      const at = (this.#options.now?.() ?? new Date()).toISOString();
      try {
        const config = await this.#write(trace, entry.config.id, () =>
          this.#options.directory.setModel(entry.config.id, model, at),
        );
        entry.config = config;
        if (entry.handle?.configureModel !== undefined) {
          await entry.handle.configureModel(model, trace);
        }
      } catch {
        // One bot that cannot be written must not stop the others; the failed entry keeps
        // its old model and the next save retries it.
      }
    }
  }

  /**
   * Per-bot agent choice (the `agent` capability): the catalog records it and a live
   * conversation follows in place, so no answer has to be interrupted.
   */
  async setAgent(
    botId: string,
    change: {
      readonly model?: { readonly provider: string; readonly modelId: string };
      readonly thinkingLevel?: string;
    },
    trace: string,
  ): Promise<BotSummary> {
    const entry = this.#entry(botId, trace);
    const at = (this.#options.now?.() ?? new Date()).toISOString();
    let config = entry.config;
    if (change.model !== undefined && change.model.modelId !== config.model.modelId) {
      config = await this.#write(trace, botId, () =>
        this.#options.directory.setModel(
          botId,
          change.model as NonNullable<typeof change.model>,
          at,
        ),
      );
      if (entry.handle?.configureModel !== undefined) {
        await entry.handle.configureModel(change.model, trace);
      }
    }
    if (change.thinkingLevel !== undefined && change.thinkingLevel !== config.thinkingLevel) {
      config = await this.#write(trace, botId, () =>
        this.#options.directory.setThinkingLevel(botId, change.thinkingLevel as string, at),
      );
      if (entry.handle?.configureThinkingLevel !== undefined) {
        await entry.handle.configureThinkingLevel(change.thinkingLevel as string, trace);
      }
    }
    entry.config = config;
    return this.#summary(entry);
  }

  /** Runs one parked task again; the task graph then reports it as live work. */
  async retryTask(botId: string, taskId: string, trace: string): Promise<void> {
    assertTaskId(taskId);
    const entry = this.#entry(botId, trace);
    const handle = entry.handle ?? (await this.open(botId, trace));
    if (handle.retryTask === undefined) {
      throw new ClassifiedFailure(
        newFailure("invalid_command"),
        "not_admitted",
        "this bot cannot retry tasks",
      );
    }
    await handle.retryTask(taskId, trace);
  }

  /** Stops one live task of a bot that is open; a closed bot has nothing to stop. */
  async abortTask(botId: string, taskId: string, trace: string): Promise<void> {
    assertTaskId(taskId);
    const entry = this.#entry(botId, trace);
    const handle = entry.handle;
    if (handle?.abortTask === undefined) {
      throw new ClassifiedFailure(
        newFailure("invalid_command"),
        "not_admitted",
        "this bot cannot stop tasks",
      );
    }
    await handle.abortTask(taskId, trace);
  }

  /**
   * Applies a tool-group selection to every bot: the catalog records it and a live
   * conversation drops or regains the extensions in place.
   */
  async applyToolGroups(toolGroups: readonly string[], trace: string): Promise<void> {
    const resolved = resolveToolGroups(toolGroups);
    this.#defaultToolGroups = resolved;
    const failures: unknown[] = [];
    for (const entry of this.#entries.values()) {
      // A bot that never stored a selection has to store one, even when the default happens
      // to match: the catalog, not the daemon's default, is what a later run reads.
      const stored = entry.config.toolGroups;
      try {
        if (stored === undefined || resolveToolGroups(stored).join(",") !== resolved.join(",")) {
          const at = (this.#options.now?.() ?? new Date()).toISOString();
          entry.config = await this.#write(trace, entry.config.id, () =>
            this.#options.directory.setToolGroups(entry.config.id, resolved, at),
          );
        }
        if (entry.handle?.configureToolGroups !== undefined) {
          await entry.handle.configureToolGroups(resolved, trace);
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw failures[0];
  }

  async create(
    title: string,
    trace: string,
    appearance: { readonly label?: string; readonly appearance?: BotAppearance } = {},
  ): Promise<BotSummary> {
    if (this.#entries.size + this.#creating >= MAX_CATALOG_BOTS) {
      throw new ClassifiedFailure(newFailure("limit_exceeded"), "not_admitted", "catalog is full");
    }
    this.#creating += 1;
    try {
      return await this.#create(title, trace, appearance);
    } finally {
      this.#creating -= 1;
    }
  }

  async #create(
    title: string,
    trace: string,
    extras: { readonly label?: string; readonly appearance?: BotAppearance },
  ): Promise<BotSummary> {
    if (this.#entries.size >= MAX_CATALOG_BOTS) {
      throw new ClassifiedFailure(newFailure("limit_exceeded"), "not_admitted", "catalog is full");
    }
    const at = (this.#options.now?.() ?? new Date()).toISOString();
    const config: BotConfig = {
      id: (this.#options.newBotId ?? (() => newBotId()))(),
      title,
      ...(extras.label === undefined ? {} : { label: extras.label }),
      appearance: extras.appearance ?? DEFAULT_APPEARANCE,
      createdAt: at,
      updatedAt: at,
      model: this.#defaultModel,
      thinkingLevel: this.#defaultThinkingLevel,
      toolGroups: this.#defaultToolGroups,
    };
    // Checked before the write: a summary the `bots` event cannot carry must not exist.
    this.#assertSummary({ ...config, state: "catalogued" }, trace);
    await this.#write(trace, config.id, () => this.#options.directory.create(config));
    const entry: Entry = {
      config,
      sharedBotId: undefined,
      deleted: false,
      state: "catalogued",
      closing: false,
      handle: undefined,
      opening: undefined,
      subscribers: 0,
      activity: 0,
      deleting: false,
      leaseWaiters: [],
      unavailable: undefined,
      cancelIdle: undefined,
      cancelRetry: undefined,
      settling: undefined,
    };
    this.#entries.set(config.id, entry);
    // Creation never waits for a Harness: reply first, warm afterwards.
    void this.open(config.id, trace).catch(() => undefined);
    return this.#summary(entry);
  }

  async rename(botId: string, title: string, trace: string): Promise<BotSummary> {
    const entry = this.#entry(botId, trace);
    const at = (this.#options.now?.() ?? new Date()).toISOString();
    this.#assertSummary({ ...entry.config, title, updatedAt: at, state: entry.state }, trace);
    const config = await this.#write(trace, botId, () =>
      this.#options.directory.rename(botId, title, at),
    );
    entry.config = config;
    void trace;
    return this.#summary(entry);
  }

  /** Closes the handle, then removes the directory in its two idempotent steps. */
  async remove(botId: string, trace: string): Promise<void> {
    return this.#directorySerial(async () => {
      const entry = this.#entries.get(botId);
      if (entry === undefined) throw this.#unresolved(botId, trace);
      await this.#removeEntry(entry, botId, trace);
      const sharedBotId = entry.sharedBotId;
      if (sharedBotId === undefined) return;
      for (const alias of [...this.#entries.values()])
        if (alias.deleted && alias.sharedBotId === sharedBotId)
          await this.#removeEntry(alias, alias.config.id, trace);
    });
  }

  async #removeEntry(entry: Entry, botId: string, trace: string): Promise<void> {
    if (entry.state === "quarantined") {
      throw new ClassifiedFailure(
        newFailure("internal"),
        "not_admitted",
        "the bot is quarantined; its close must finish first",
      );
    }
    this.#options.log.emit("info", "core", Events.deleteStart, { trace, botId });
    entry.closing = true;
    entry.deleting = true;
    this.#cancelTimers(entry);
    try {
      // The door closes first: a new lease or a new open is refused from here on. Only
      // then may the delete wait for the leases already granted — waiting while `settling`
      // is set would deadlock, because an `open()` in flight waits for `settling`
      // (TRIGGERS.md §3.6).
      await this.#drainLeases(entry, trace);
      let finish: () => void = () => undefined;
      // The whole delete is one settling window: an open that arrives while the directory
      // is being moved would create a handle for a bot the catalog no longer has.
      entry.settling = new Promise<void>((resolve) => {
        finish = resolve;
      });
      try {
        await this.#delete(entry, botId, trace);
      } finally {
        entry.settling = undefined;
        finish();
      }
    } finally {
      entry.deleting = false;
    }
  }

  /**
   * Waits until no lease is held, bounded by the close deadline: a lease that never
   * settles quarantines the bot instead of moving a directory under a live lookup.
   */
  async #drainLeases(entry: Entry, trace: string): Promise<void> {
    if (entry.subscribers === 0) return;
    const setTimer = this.#options.setTimer ?? defaultTimer;
    const outcome = await new Promise<"released" | "timeout">((resolve) => {
      const cancel = setTimer(() => {
        const at = entry.leaseWaiters.indexOf(waiter);
        if (at !== -1) entry.leaseWaiters.splice(at, 1);
        resolve("timeout");
      }, this.#options.closeDeadlineMs);
      const waiter = () => {
        cancel();
        resolve("released");
      };
      entry.leaseWaiters.push(waiter);
    });
    if (outcome === "released") return;
    this.#quarantine(entry, trace);
    throw new ClassifiedFailure(
      newFailure("internal"),
      "not_admitted",
      "an admission did not drain; the bot is quarantined",
    );
  }

  async #delete(entry: Entry, botId: string, trace: string): Promise<void> {
    // A warm-up open that is still in flight must settle first, or the handle it creates
    // would own an sqlite file the delete already moved to `trash/`.
    if (entry.opening !== undefined) await entry.opening.catch(() => undefined);
    if (entry.handle !== undefined) {
      // The outer delete window is the settling promise: the close must not replace it,
      // or the directory move would run unprotected.
      const outcome = await entry.handle.close(trace, this.#options.closeDeadlineMs);
      if (outcome === "timeout") {
        // A close that did not finish owns the handle: nothing may move or rewrite the
        // directory until the retry reports `closed` (ARCHITECTURE.md, quarantine).
        this.#quarantine(entry, trace);
        throw new ClassifiedFailure(
          newFailure("internal"),
          "not_admitted",
          "the bot's close timed out; it is quarantined",
        );
      }
      entry.handle = undefined;
    }
    try {
      if (!entry.deleted) {
        const binding = await this.#options.readReplicaBinding?.({
          id: botId,
          dir: this.#options.directory.botDir(botId),
        });
        entry.sharedBotId = binding?.sharedBotId;
        if (binding !== undefined)
          await this.#persistDeleted([{ sharedBotId: binding.sharedBotId }]);
      }
      await this.#options.directory.remove(botId);
    } catch (error) {
      const failure = newFailure("storage_failed");
      entry.closing = false;
      this.#options.log.emit("error", "core", Events.deleteFail, {
        trace,
        botId,
        failure,
        origin: true,
        detail: { reason: "upstream" },
      });
      throw new ClassifiedFailure(failure, "runtime", "the bot could not be deleted", {
        cause: error,
      });
    }
    this.#entries.delete(botId);
    this.#options.log.emit("info", "core", Events.deleteOk, { trace, botId, detail: { count: 1 } });
  }

  /**
   * The handle for this bot, opening it at most once. Two subscribers share one open, a
   * quarantined bot refuses, and a failed open leaves the bot `unavailable` with the
   * classification the caller must carry.
   */
  async open(botId: string, trace: string): Promise<RuntimeHandle> {
    const entry = this.#entry(botId, trace);
    // A close (idle, delete or shutdown) owns the handle until it settles. The delete
    // sets `settling` only after its lease drain, so an open that started before the door
    // closed is never waited on by the drain it belongs to (TRIGGERS.md §3.6). Opening during
    // that window would create a second Harness over one sqlite file, and the close would
    // then clear the handle it never owned (ARCHITECTURE.md, "Bot lifecycle").
    if (entry.settling !== undefined) {
      await entry.settling.catch(() => undefined);
      if (this.#entries.get(botId) !== entry) {
        throw this.#unresolved(botId, trace);
      }
    }
    if (entry.state === "quarantined") {
      throw new ClassifiedFailure(
        newFailure("unknown_bot"),
        "not_admitted",
        "the bot is quarantined",
      );
    }
    if (entry.handle !== undefined && !entry.closing) return entry.handle;
    // A warm-up open already in flight is the one an explicit open joins.
    entry.opening ??= this.#openOnce(entry, trace);
    return entry.opening;
  }

  /** `recover`: re-opens an unavailable bot, retries parked work otherwise. */
  async recover(botId: string, trace: string): Promise<void> {
    const entry = this.#entry(botId, trace);
    if (entry.state === "quarantined") {
      throw new ClassifiedFailure(
        newFailure("internal"),
        "not_admitted",
        "the bot is quarantined; its close must finish first",
      );
    }
    if (entry.handle === undefined) {
      await this.open(botId, trace);
      return;
    }
    await entry.handle.recover(trace);
  }

  /**
   * The runtime reported its session dead: the Harness closed itself, so the handle is
   * gone and the bot is unavailable until `recover` opens it again.
   */
  markUnavailable(
    botId: string,
    reason: ErrorKind,
    message: string,
    options: { readonly dropHandle?: boolean } = {},
  ): boolean {
    const entry = this.#entries.get(botId);
    if (entry === undefined) return false;
    // A dead session takes the handle with it; an escalated watch leaves the harness
    // alive, so the handle stays owned and `recover` re-attaches it instead of opening a
    // second owner over the same sqlite file.
    if (options.dropHandle !== false) entry.handle = undefined;
    entry.state = "unavailable";
    entry.unavailable = unavailable(reason, message);
    entry.closing = false;
    return true;
  }

  /** `recover` brought the bot back: the catalog may say idle again. */
  markRecovered(botId: string, running: boolean): boolean {
    const entry = this.#entries.get(botId);
    if (entry === undefined || entry.state !== "unavailable") return false;
    entry.state = running ? "running" : "idle";
    entry.unavailable = undefined;
    return true;
  }

  /** The run state the service observed; returns true when the catalog changed. */
  markRunning(botId: string, running: boolean): boolean {
    const entry = this.#entries.get(botId);
    if (entry === undefined) return false;
    // An unavailable bot is not made healthy by a status event: only `recover` clears it.
    if (entry.state !== "idle" && entry.state !== "running") return false;
    const next: BotState = running ? "running" : "idle";
    if (entry.state === next) return false;
    entry.state = next;
    return true;
  }

  /**
   * A subscription or an admission started: the bot must stay open while it lasts.
   * Answers false for a bot that is unknown, quarantined or being deleted, so a caller
   * never holds a lease it cannot release.
   */
  touch(botId: string): boolean {
    const entry = this.#entries.get(botId);
    if (entry === undefined || entry.deleted || entry.deleting || entry.state === "quarantined")
      return false;
    this.#touch(entry);
    return true;
  }

  /** The last lease ended: close after the idle window if the bot is quiet. */
  release(botId: string): void {
    const entry = this.#entries.get(botId);
    if (entry === undefined) return;
    entry.subscribers = Math.max(0, entry.subscribers - 1);
    if (entry.subscribers > 0) return;
    // A delete is draining: it owns the next step, so no idle close is scheduled here.
    for (const resolve of entry.leaseWaiters.splice(0)) resolve();
    if (!entry.deleting) this.#scheduleIdle(entry);
  }

  async shutdown(): Promise<void> {
    const trace = this.#boot();
    // One shared deadline for the whole shutdown: a stalled handle must not multiply the
    // budget by the number of bots (ARCHITECTURE.md, "Bot lifecycle", rule 6).
    const deadline = Date.now() + this.#options.closeDeadlineMs;
    await Promise.all(
      [...this.#entries.values()].map(async (entry) => {
        this.#cancelTimers(entry);
        if (entry.handle === undefined) return;
        const handle = entry.handle;
        entry.closing = true;
        const remaining = Math.max(1, deadline - Date.now());
        const closing = handle.close(trace, remaining).catch(() => "timeout" as const);
        entry.settling = closing.then(
          () => undefined,
          () => undefined,
        );
        const outcome = await closing;
        entry.settling = undefined;
        if (outcome === "timeout") {
          // The handle stays owned: quarantining without it would leave nothing to retry.
          entry.handle = handle;
          this.#quarantine(entry, trace);
          return;
        }
        entry.handle = undefined;
        entry.state = "catalogued";
        entry.closing = false;
      }),
    );
  }

  /** The id never resolved, so nothing below core is reached: this is the origin. */
  #unresolved(botId: string, trace: string): ClassifiedFailure {
    const failure = newFailure("unknown_bot", "core");
    this.#options.log.emit("error", "core", Events.resolveFail, {
      trace,
      botId,
      failure,
      origin: true,
    });
    return new ClassifiedFailure(failure, "not_admitted", "unknown bot");
  }

  #entry(botId: string, trace: string): Entry {
    const entry = this.#entries.get(botId);
    if (entry === undefined || entry.deleted) throw this.#unresolved(botId, trace);
    return entry;
  }

  async #openOnce(entry: Entry, trace: string): Promise<RuntimeHandle> {
    const started = performance.now();
    const retryBinding = entry.state === "unavailable";
    let owned: RuntimeHandle | undefined;
    entry.state = "opening";
    this.#options.log.emit("info", "core", Events.openStart, { trace, botId: entry.config.id });
    try {
      if (retryBinding) {
        const binding = await this.#options.readReplicaBinding?.({
          id: entry.config.id,
          dir: this.#options.directory.botDir(entry.config.id),
        });
        if (binding !== undefined && (await this.#options.directory.isDeleted(binding.sharedBotId)))
          throw this.#unresolved(entry.config.id, trace);
      }
      const handle = await this.#options.openRuntime({
        id: entry.config.id,
        dir: this.#options.directory.botDir(entry.config.id),
        model: entry.config.model,
        thinkingLevel: entry.config.thinkingLevel ?? this.#defaultThinkingLevel,
        toolGroups: resolveToolGroups(entry.config.toolGroups ?? this.#defaultToolGroups),
        trace,
      });
      owned = handle;
      const binding = await this.#options.readReplicaBinding?.({
        id: entry.config.id,
        dir: this.#options.directory.botDir(entry.config.id),
      });
      entry.sharedBotId = binding?.sharedBotId;
      if (
        entry.deleted ||
        (binding !== undefined && (await this.#options.directory.isDeleted(binding.sharedBotId)))
      ) {
        throw this.#unresolved(entry.config.id, trace);
      }
      entry.handle = handle;
      entry.state = "idle";
      entry.unavailable = undefined;
      this.#options.log.emit("info", "core", Events.openOk, {
        trace,
        botId: entry.config.id,
        durMs: Math.round(performance.now() - started),
      });
      if (entry.subscribers === 0) this.#scheduleIdle(entry);
      return handle;
    } catch (error) {
      entry.state = "unavailable";
      if (owned !== undefined) {
        const outcome = await owned
          .close(trace, this.#options.closeDeadlineMs)
          .catch(() => "timeout");
        if (outcome === "timeout") {
          entry.handle = owned;
          this.#quarantine(entry, trace);
        }
      }
      const failure: Failure =
        error instanceof ClassifiedFailure ? error.failure : newFailure("storage_failed");
      entry.unavailable = unavailable(failure.kind, "the bot could not be opened");
      const own = failure.layer === "core";
      this.#options.log.emit(own ? "error" : "warn", "core", Events.openFail, {
        trace,
        botId: entry.config.id,
        failure,
        ...(own ? { origin: true as const } : { propagated: true }),
        durMs: Math.round(performance.now() - started),
      });
      throw error instanceof ClassifiedFailure
        ? error
        : new ClassifiedFailure(failure, "runtime", "the bot could not be opened", {
            cause: error,
          });
    } finally {
      entry.opening = undefined;
    }
  }

  #touch(entry: Entry): void {
    entry.subscribers += 1;
    entry.activity += 1;
    entry.cancelIdle?.();
    entry.cancelIdle = undefined;
  }

  #scheduleIdle(entry: Entry): void {
    entry.cancelIdle?.();
    const setTimer = this.#options.setTimer ?? defaultTimer;
    entry.cancelIdle = setTimer(() => {
      entry.cancelIdle = undefined;
      void this.#idleClose(entry);
    }, this.#options.idleCloseMs);
  }

  async #idleClose(entry: Entry): Promise<void> {
    if (entry.subscribers > 0 || entry.handle === undefined) return;
    if (entry.state === "quarantined" || entry.closing) return;
    const trace = this.#boot();
    const activity = entry.activity;
    const busy = await entry.handle.busy().catch(() => ({ run: false, tasks: false }));
    // A lease taken while `busy()` was in flight may have started a run: that answer is
    // stale, and the touch/release pair has already rescheduled this decision.
    if (entry.activity !== activity) return;
    // A subscription or a delete can arrive while `busy()` was in flight.
    if (entry.subscribers > 0 || entry.closing || entry.deleting || entry.handle === undefined)
      return;
    if (busy.run || busy.tasks) {
      // A background task keeps the bot warm; the close condition reads the port.
      this.#scheduleIdle(entry);
      return;
    }
    const handle = entry.handle;
    entry.closing = true;
    const closing = handle.close(trace, this.#options.closeDeadlineMs);
    const window = closing.then(
      () => undefined,
      () => undefined,
    );
    entry.settling = window;
    const outcome = await closing.catch(() => {
      this.#options.log.emit("error", "core", Events.closeFail, {
        trace,
        botId: entry.config.id,
        failure: newFailure("internal", "core"),
        origin: true,
      });
      return "timeout" as const;
    });
    // A delete may have taken the window over while this close was in flight: only the
    // owner of the window may clear it, or an open could slip in during the move.
    if (entry.settling === window) {
      entry.settling = undefined;
      entry.closing = false;
    }
    if (outcome === "timeout") {
      this.#quarantine(entry, trace);
      return;
    }
    entry.handle = undefined;
    entry.state = "catalogued";
    this.#options.log.emit("info", "core", Events.closeOk, {
      trace,
      botId: entry.config.id,
      detail: { quarantined: false },
    });
  }

  /** A close that timed out: the handle stays owned and `open`/`delete` are refused. */
  #quarantine(entry: Entry, trace: string): void {
    entry.state = "quarantined";
    this.#options.log.emit("warn", "core", Events.closeDegrade, {
      trace,
      botId: entry.config.id,
      failure: newFailure("internal"),
      detail: { reason: "quarantine", quarantined: true },
    });
    const setTimer = this.#options.setTimer ?? defaultTimer;
    const retry = () => {
      void entry.handle
        ?.close(trace, this.#options.closeDeadlineMs)
        .then((outcome) => {
          if (outcome === "closed") {
            entry.handle = undefined;
            entry.state = "catalogued";
            entry.closing = false;
            entry.cancelRetry?.();
            entry.cancelRetry = undefined;
            this.#options.log.emit("info", "core", Events.closeOk, {
              trace,
              botId: entry.config.id,
              detail: { quarantined: true },
            });
            return;
          }
          entry.cancelRetry = setTimer(retry, this.#options.quarantineRetryMs);
        })
        .catch(() => {
          entry.cancelRetry = setTimer(retry, this.#options.quarantineRetryMs);
        });
    };
    entry.cancelRetry = setTimer(retry, this.#options.quarantineRetryMs);
  }

  async #recover(trace: string): Promise<void> {
    this.#options.log.emit("info", "core", Events.recoveryStart, { trace });
    let resumed = 0;
    for (const entry of this.#entries.values()) {
      if (entry.state === "unavailable") continue;
      let failure: Failure | undefined;
      const busy = await this.open(entry.config.id, trace)
        .then((handle) => handle.busy())
        .catch((error: unknown) => {
          // The identity the open minted travels with the report: one episode, one id.
          failure =
            error instanceof ClassifiedFailure ? error.failure : newFailure("storage_failed");
          return undefined;
        });
      if (busy === undefined) {
        this.#options.log.emit("warn", "core", Events.recoveryBotFail, {
          trace,
          botId: entry.config.id,
          failure: failure ?? newFailure("storage_failed"),
          detail: { reason: "upstream", propagated: true },
        });
        continue;
      }
      this.#options.log.emit("info", "core", Events.recoveryBotOk, {
        trace,
        botId: entry.config.id,
        detail: { finished: busy.run ? "running" : "idle" },
      });
      if (busy.run || busy.tasks) {
        // The catalog has to say what the scan found: a resumed run is not an idle bot.
        this.markRunning(entry.config.id, true);
        resumed += 1;
        continue;
      }
      // Quiet: keep it open briefly in case a client attaches, then let idle close take it.
      if (entry.subscribers === 0) this.#scheduleIdle(entry);
    }
    this.#options.log.emit("info", "core", Events.recoveryOk, {
      trace,
      detail: { count: resumed },
    });
  }

  #cancelTimers(entry: Entry): void {
    entry.cancelIdle?.();
    entry.cancelIdle = undefined;
    entry.cancelRetry?.();
    entry.cancelRetry = undefined;
  }

  /** One catalog mutation, one outcome record, at the layer that owns the file. */
  async #write<T>(trace: string, botId: string, work: () => Promise<T>): Promise<T> {
    try {
      const result = await work();
      this.#options.log.emit("info", "core", Events.catalogWriteOk, {
        trace,
        botId,
        detail: { count: 1 },
      });
      return result;
    } catch (error) {
      const classified = error instanceof ClassifiedFailure ? error : undefined;
      const failure = classified?.failure ?? newFailure("storage_failed", "core");
      this.#options.log.emit("error", "core", Events.catalogWriteFail, {
        trace,
        botId,
        failure,
        origin: true,
      });
      throw error instanceof ClassifiedFailure
        ? error
        : new ClassifiedFailure(failure, "runtime", "the catalog could not be written", {
            cause: error,
          });
    }
  }

  /** Refuses a summary the derived 240 200-byte catalog bound cannot hold. */
  #assertSummary(summary: BotSummary, trace: string): void {
    const measure = this.#options.measureSummary ?? jsonBytes;
    // The failure that makes a bot unavailable adds a reason and a message to the same
    // summary, so the budget has to hold that variant too: otherwise a failure turns a
    // legal bot into a catalog event the frame budget refuses.
    const worstCase: BotSummary = {
      ...summary,
      unavailable: { reason: "storage_failed", message: "x".repeat(200) },
    };
    if (measure(worstCase) > (this.#options.maxSummaryBytes ?? MAX_SUMMARY_BYTES)) {
      // The refusal happens before any write, so this is the only record it gets.
      const failure = newFailure("limit_exceeded", "core");
      this.#options.log.emit("error", "core", Events.catalogWriteFail, {
        trace,
        botId: summary.id,
        failure,
        origin: true,
      });
      throw new ClassifiedFailure(failure, "not_admitted", "the summary does not fit the budget");
    }
  }

  #summary(entry: Entry): BotSummary {
    return {
      id: entry.config.id,
      title: entry.config.title,
      ...(entry.config.label === undefined ? {} : { label: entry.config.label }),
      appearance: entry.config.appearance ?? DEFAULT_APPEARANCE,
      createdAt: entry.config.createdAt,
      updatedAt: entry.config.updatedAt,
      model: entry.config.model,
      state: entry.state,
      ...(entry.config.groupId === undefined ? {} : { groupId: entry.config.groupId }),
      ...(entry.unavailable === undefined ? {} : { unavailable: entry.unavailable }),
    };
  }
}

const defaultTimer = (run: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(run, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
};
