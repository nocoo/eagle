// Bot lifecycle (docs/bots/ARCHITECTURE.md "Bot lifecycle"): the catalog, the one in-flight
// open per bot, idle close, quarantine with its retry, the startup recovery scan and
// delete. The registry owns state; the service owns routing; the adapter owns the Harness.
import { createHash, randomUUID } from "node:crypto";
import { declareEvent } from "../log/events.ts";
import type { Log } from "../log/log.ts";
import type { BotConfig, BotDirectory } from "./BotDirectory.ts";
import {
  type BotAppearance,
  type BotCreationAppearance,
  type BotGroup,
  type BotState,
  type BotSummary,
  ClassifiedFailure,
  DEFAULT_APPEARANCE,
  DEFAULT_THINKING_LEVEL,
  DEFAULT_TOOL_GROUPS,
  type ErrorKind,
  type Failure,
  IDENTITY_TINTS,
  resolveToolGroups,
  type ToolGroup,
} from "./domain.ts";
import { newFailure } from "./failures.ts";
import type { RuntimeBotSpec, RuntimeHandle } from "./RuntimePort.ts";

const Events = {
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
} as const;

type Entry = {
  config: BotConfig;
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
  readonly directory: BotDirectory;
  readonly openRuntime: (spec: RuntimeBotSpec) => Promise<RuntimeHandle>;
  readonly model: { readonly provider: string; readonly modelId: string };
  /** The reasoning level a newly created bot records; settings can change it at runtime. */
  readonly thinkingLevel?: string;
  /** The tool groups a newly created bot records; settings can change it at runtime. */
  readonly toolGroups?: readonly ToolGroup[];
  /**
   * What the daemon knows about a model: the reasoning levels it accepts. A level the
   * model cannot take is refused before anything is written.
   */
  readonly agentSupport?: (model: { readonly provider: string; readonly modelId: string }) => {
    readonly levels: readonly string[];
  };
  /** Registers a model a bot names, so the daemon can run it. */
  readonly ensureModel?: (modelId: string) => void;
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

export class BotRegistry {
  readonly #options: RegistryOptions;
  readonly #entries = new Map<string, Entry>();
  /** The model a newly created bot records; settings can change it at runtime. */
  #defaultModel: { readonly provider: string; readonly modelId: string };
  /** The reasoning level a newly created bot records; settings can change it at runtime. */
  #defaultThinkingLevel: string;
  /** The tool groups a newly created bot records; settings can change it at runtime. */
  #defaultToolGroups: readonly ToolGroup[];
  /** One queue per bot: two agent changes cannot interleave on one catalog. */
  readonly #agentQueues = new Map<string, Promise<unknown>>();
  /** The sidebar groups, refreshed on load and after every mutation. */
  #groups: readonly BotGroup[] = [];
  readonly #boot: () => string;
  #sequence = 0;
  /** Creations in flight, so two concurrent creates cannot both take the last slot. */
  #creating = 0;
  #stopping = false;
  #unsafeShutdown = false;
  #shutdownDeadline: number | undefined;

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

  /**
   * Loads the catalog, finishes an interrupted delete, gives a bot created before the
   * level existed the level it runs with today, then scans for active work.
   */
  async start(): Promise<void> {
    const trace = this.#boot();
    this.#groups = await this.#options.directory.loadGroups().catch(() => []);
    let bots: readonly BotConfig[];
    try {
      const reconciled = await this.#options.directory.reconcile();
      this.#options.log.emit("info", "core", Events.reconcileOk, {
        trace,
        detail: { count: reconciled.finishedDeletes.length },
      });
      bots = await this.#options.directory.load();
      this.#options.log.emit("info", "core", Events.catalogLoadOk, {
        trace,
        detail: { count: bots.length },
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
    for (let config of bots) {
      // A bot created before the level was stored keeps running with the level it has
      // today, written once: after this it is its own, and a later change of the daemon's
      // default cannot move it.
      if (config.thinkingLevel === undefined) {
        config = await this.#write(trace, config.id, () =>
          this.#options.directory.setAgent(
            config.id,
            { thinkingLevel: this.#defaultThinkingLevel },
            (this.#options.now?.() ?? new Date()).toISOString(),
          ),
        );
      }
      this.#entries.set(config.id, {
        config,
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
    return [...this.#entries.values()].map((entry) => this.#summary(entry));
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

  /** The line a bot wrote about itself and when: the prompt shows both, the wire neither. */
  noteOf(botId: string): {
    readonly note?: string;
    readonly at?: string;
    readonly revision: string;
    readonly owner?: number;
  } {
    const config = this.#entries.get(botId)?.config;
    return {
      ...(config?.note === undefined ? {} : { note: config.note }),
      ...(config?.noteAt === undefined ? {} : { at: config.noteAt }),
      revision: config?.noteRevision ?? "",
      ...(config?.noteOwner === undefined ? {} : { owner: config.noteOwner }),
    };
  }

  /** Name, label, note or face changed; the catalog keeps the truth and the summary follows. */
  async update(
    botId: string,
    changes: {
      readonly title?: string;
      readonly label?: string | null;
      readonly note?: string | null;
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

  async updateNoteIfRevision(
    botId: string,
    note: string,
    revision: string,
    trace: string,
    owner?: number,
  ): Promise<BotSummary | undefined> {
    const entry = this.#entry(botId, trace);
    const at = (this.#options.now?.() ?? new Date()).toISOString();
    const config = await this.#write(trace, botId, () =>
      this.#options.directory.updateNoteIfRevision(botId, note, revision, at, owner),
    );
    if (config === undefined) return undefined;
    entry.config = config;
    return this.#summary(entry);
  }

  /** Settings changed the gateway: new bots use the new model, existing ones keep theirs. */
  setDefaultModel(model: { readonly provider: string; readonly modelId: string }): void {
    this.#defaultModel = model;
  }

  /** Settings changed the reasoning level: new bots use it, existing ones keep theirs. */
  setDefaultThinkingLevel(thinkingLevel: string): void {
    this.#defaultThinkingLevel = thinkingLevel;
  }

  /**
   * The provider belongs to the gateway, not to a bot: every stored reference follows it,
   * while the model id each bot chose stays that bot's own.
   */
  async applyGatewayProvider(provider: string, trace: string): Promise<void> {
    for (const entry of this.#entries.values()) {
      if (entry.config.model.provider === provider) continue;
      const at = (this.#options.now?.() ?? new Date()).toISOString();
      try {
        entry.config = await this.#write(trace, entry.config.id, () =>
          this.#options.directory.setAgent(
            entry.config.id,
            { model: { provider, modelId: entry.config.model.modelId } },
            at,
          ),
        );
      } catch {
        // One bot that cannot be written must not stop the others.
      }
    }
  }

  /**
   * One bot's own pair, in one change: the model it runs with and the reasoning level it
   * runs at. The catalog is written once, the conversation is configured once, and a
   * request that is already in flight keeps the model it was prepared with.
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
    return this.#serializeAgent(botId, async () => {
      const current = entry.config;
      const currentLevel = await this.#storedLevel(entry, trace);
      const model = change.model ?? current.model;
      const level = change.thinkingLevel ?? currentLevel;
      const sameModel =
        change.model === undefined ||
        (change.model.provider === current.model.provider &&
          change.model.modelId === current.model.modelId);
      const sameLevel = level === currentLevel;
      if (sameModel && sameLevel) return this.#summary(entry);
      // The pair has to be one the model accepts, and that is checked before anything is
      // written: a bot never records a pair it cannot run with.
      if (change.model !== undefined) this.#options.ensureModel?.(change.model.modelId);
      const support = this.#options.agentSupport?.(model);
      if (support !== undefined && !support.levels.includes(level)) {
        throw new ClassifiedFailure(
          newFailure("invalid_command"),
          "not_admitted",
          `${model.modelId} does not support the ${level} thinking level`,
        );
      }
      const at = (this.#options.now?.() ?? new Date()).toISOString();
      // The edit holds a lease while it runs, and it waits for a close that is already in
      // flight: an idle close must not take the handle away in the middle of the change.
      // A close that wins leaves no handle, and then the catalog alone records the pair
      // the next open configures.
      const leased = this.touch(botId);
      try {
        if (entry.settling !== undefined) await entry.settling.catch(() => undefined);
        const handle = entry.handle;
        // The live conversation follows first: a conversation that refuses the pair must
        // not be recorded as having it.
        if (handle?.configureAgent !== undefined) {
          await handle.configureAgent({ model, thinkingLevel: level }, trace);
        }
        try {
          const config = await this.#write(trace, botId, () =>
            this.#options.directory.setAgent(botId, { model, thinkingLevel: level }, at),
          );
          entry.config = config;
        } catch (error) {
          // The catalog is the truth: a conversation that took the pair and a catalog that
          // did not would run two different pairs. The old pair goes back.
          if (handle?.configureAgent !== undefined) {
            await handle
              .configureAgent(
                {
                  model: current.model,
                  thinkingLevel: currentLevel,
                },
                trace,
              )
              .catch(() => undefined);
          }
          throw error;
        }
      } finally {
        if (leased) this.release(botId);
      }
      return this.#summary(entry);
    });
  }

  /** One agent change at a time per bot: two patches cannot interleave on one catalog. */
  #serializeAgent<T>(botId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#agentQueues.get(botId) ?? Promise.resolve();
    const run = previous.then(work, work);
    this.#agentQueues.set(
      botId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
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
    extras: {
      readonly label?: string;
      readonly appearance?: BotCreationAppearance;
      /** Files the bot at creation, so a group is never a second write that can fail alone. */
      readonly groupId?: string;
    } = {},
  ): Promise<BotSummary> {
    if (this.#entries.size + this.#creating >= MAX_CATALOG_BOTS) {
      throw new ClassifiedFailure(newFailure("limit_exceeded"), "not_admitted", "catalog is full");
    }
    this.#creating += 1;
    try {
      return await this.#create(title, trace, extras);
    } finally {
      this.#creating -= 1;
    }
  }

  async #create(
    title: string,
    trace: string,
    extras: {
      readonly label?: string;
      readonly appearance?: BotCreationAppearance;
      readonly groupId?: string;
    },
  ): Promise<BotSummary> {
    if (this.#entries.size >= MAX_CATALOG_BOTS) {
      throw new ClassifiedFailure(newFailure("limit_exceeded"), "not_admitted", "catalog is full");
    }
    const at = (this.#options.now?.() ?? new Date()).toISOString();
    const id = (this.#options.newBotId ?? (() => newBotId()))();
    const slot = (createHash("sha256").update(`bot:${id}`, "utf8").digest().readUInt8(0) % 8) as
      | 0
      | 1
      | 2
      | 3
      | 4
      | 5
      | 6
      | 7;
    const defaultTint = IDENTITY_TINTS[slot];
    const config: BotConfig = {
      id,
      title,
      ...(extras.label === undefined ? {} : { label: extras.label }),
      ...(extras.groupId === undefined ? {} : { groupId: extras.groupId }),
      appearance: {
        shape: extras.appearance?.shape ?? "blob",
        tint: extras.appearance?.tint ?? defaultTint,
      },
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
    const entry = this.#entry(botId, trace);
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
    }
    try {
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
    if (this.#stopping) {
      throw new ClassifiedFailure(
        newFailure("internal", "core"),
        "not_admitted",
        "the daemon is shutting down",
      );
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
    if (entry === undefined || entry.deleting || entry.state === "quarantined") return false;
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

  async shutdown(): Promise<boolean> {
    this.#stopping = true;
    const trace = this.#boot();
    // One shared deadline for the whole shutdown: a stalled handle must not multiply the
    // budget by the number of bots (ARCHITECTURE.md, "Bot lifecycle", rule 6).
    this.#shutdownDeadline ??= Date.now() + this.#options.closeDeadlineMs;
    const deadline = this.#shutdownDeadline;
    const closed = await Promise.all(
      [...this.#entries.values()].map(async (entry) => {
        this.#cancelTimers(entry);
        if (entry.opening !== undefined) {
          await entry.opening.catch(() => undefined);
          return entry.handle === undefined;
        }
        if (entry.handle === undefined) return true;
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
          return false;
        }
        entry.handle = undefined;
        entry.state = "catalogued";
        entry.closing = false;
        return true;
      }),
    );
    return closed.every(Boolean) && !this.#unsafeShutdown;
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
    if (entry === undefined) throw this.#unresolved(botId, trace);
    return entry;
  }

  async #openOnce(entry: Entry, trace: string): Promise<RuntimeHandle> {
    const started = performance.now();
    entry.state = "opening";
    this.#options.log.emit("info", "core", Events.openStart, { trace, botId: entry.config.id });
    try {
      const handle = await this.#options.openRuntime({
        id: entry.config.id,
        dir: this.#options.directory.botDir(entry.config.id),
        model: entry.config.model,
        thinkingLevel: await this.#storedLevel(entry, trace),
        toolGroups: resolveToolGroups(entry.config.toolGroups ?? this.#defaultToolGroups),
        trace,
      });
      entry.handle = handle;
      if (this.#stopping) {
        entry.closing = true;
        const remaining = Math.max(1, (this.#shutdownDeadline ?? Date.now()) - Date.now());
        const outcome = await handle.close(trace, remaining).catch(() => "timeout");
        if (outcome === "timeout") this.#quarantine(entry, trace);
        else {
          entry.handle = undefined;
          entry.state = "catalogued";
          entry.closing = false;
        }
        throw new ClassifiedFailure(
          newFailure("internal", "core"),
          "not_admitted",
          "the daemon is shutting down",
        );
      }
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
      if (this.#stopping) {
        if (entry.state === "opening") {
          this.#unsafeShutdown = true;
          entry.state = "unavailable";
        }
        throw error;
      }
      const failure: Failure =
        error instanceof ClassifiedFailure ? error.failure : newFailure("storage_failed");
      entry.state = "unavailable";
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

  /**
   * The level a bot runs at. A bot created before the field existed gets the daemon's
   * current default once, written into the catalog, and keeps it from then on: the
   * default is a default for new bots, never a value an existing bot follows.
   */
  async #storedLevel(entry: Entry, trace: string): Promise<string> {
    const stored = entry.config.thinkingLevel;
    if (stored !== undefined) return stored;
    const config = await this.#write(trace, entry.config.id, () =>
      this.#options.directory.setAgent(
        entry.config.id,
        { thinkingLevel: this.#defaultThinkingLevel },
        (this.#options.now?.() ?? new Date()).toISOString(),
      ),
    );
    entry.config = config;
    const written = config.thinkingLevel;
    if (written === undefined) {
      throw new ClassifiedFailure(
        newFailure("internal", "core"),
        "not_admitted",
        "the catalog did not keep the bot's thinking level",
      );
    }
    return written;
  }

  #touch(entry: Entry): void {
    entry.subscribers += 1;
    entry.activity += 1;
    entry.cancelIdle?.();
    entry.cancelIdle = undefined;
  }

  #scheduleIdle(entry: Entry): void {
    if (this.#stopping) return;
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
    if (this.#stopping) return;
    const setTimer = this.#options.setTimer ?? defaultTimer;
    const retry = () => {
      if (this.#stopping) return;
      void entry.handle
        ?.close(trace, this.#options.closeDeadlineMs)
        .then((outcome) => {
          if (this.#stopping) return;
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
          if (!this.#stopping) entry.cancelRetry = setTimer(retry, this.#options.quarantineRetryMs);
        });
    };
    entry.cancelRetry = setTimer(retry, this.#options.quarantineRetryMs);
  }

  async #recover(trace: string): Promise<void> {
    this.#options.log.emit("info", "core", Events.recoveryStart, { trace });
    let resumed = 0;
    for (const entry of this.#entries.values()) {
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
      ...(entry.config.note === undefined ? {} : { note: entry.config.note }),
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
