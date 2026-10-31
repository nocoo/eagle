// The bot catalog: one JSON file written atomically, one directory per bot, and the
// reconciliation that finishes a delete interrupted between its two steps
// (docs/bots/ARCHITECTURE.md "Bot lifecycle"). Everything that mutates the catalog runs
// on one internal queue, so concurrent callers cannot overwrite each other.
import { randomUUID } from "node:crypto";
import type { BotAppearance, BotGroup, BotRecord, ToolGroup } from "./domain.ts";
import { BOT_ID_PATTERN, isToolGroup, MAX_BOT_GROUPS, MAX_GROUP_TITLE_CHARS } from "./domain.ts";
import { type Tombstone, tombstoneSchema } from "./Tombstones.ts";

export type DirEntry = { readonly name: string; isDirectory(): boolean };

export interface DirectoryFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, body: string, mode?: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
}

export type DirectoryErrorReason =
  | "unknown_bot"
  | "duplicate_bot"
  | "corrupt_catalog"
  | "storage_failed"
  | "group_not_found"
  | "group_not_empty"
  | "invalid_groups"
  | "limit_exceeded";

export class DirectoryError extends Error {
  readonly reason: DirectoryErrorReason;

  constructor(reason: DirectoryErrorReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DirectoryError";
    this.reason = reason;
  }
}

const CATALOG = "catalog.json";
const CATALOG_VERSION = 1;
const GROUP_ID_PATTERN = /^g_[A-Za-z0-9_-]{6,}$/;

type CatalogState = {
  readonly bots: readonly BotConfig[];
  readonly groups: readonly BotGroup[];
  readonly tombstones: readonly Tombstone[];
  readonly cleanup: Readonly<Record<string, string>>;
};

const isGroupRecord = (value: unknown): value is BotGroup =>
  isObject(value) &&
  typeof value.id === "string" &&
  GROUP_ID_PATTERN.test(value.id) &&
  typeof value.title === "string" &&
  value.title.trim().length > 0;

export type BotConfig = BotRecord & {
  readonly instructions?: string;
  readonly thinkingLevel?: string;
  /** The sidebar group this bot is filed under; absent means ungrouped. */
  readonly groupId?: string;
  /** The tool groups this bot was given; absent means every group. */
  readonly toolGroups?: readonly ToolGroup[];
};

const withGroup = (bot: BotConfig, groupId: string | undefined): BotConfig => {
  const { groupId: _previous, ...rest } = bot;
  return groupId === undefined ? rest : { ...rest, groupId };
};

export type ReconcileResult = {
  readonly finishedDeletes: readonly string[];
  readonly failedDeletes: readonly string[];
  readonly orphanedTrash: readonly string[];
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const RECORD_KEYS = new Set([
  "id",
  "title",
  "label",
  "appearance",
  "createdAt",
  "updatedAt",
  "model",
  "instructions",
  "thinkingLevel",
  "toolGroups",
  "groupId",
]);

const isBotRecord = (value: unknown): value is BotConfig => {
  if (!isObject(value)) return false;
  if (Object.keys(value).some((key) => !RECORD_KEYS.has(key))) return false;
  if (!isObject(value.model)) return false;
  if (Object.keys(value.model).some((key) => key !== "provider" && key !== "modelId")) return false;
  const optional = value as { instructions?: unknown; thinkingLevel?: unknown };
  if (optional.instructions !== undefined && typeof optional.instructions !== "string")
    return false;
  const labelled = value as { label?: unknown; appearance?: unknown };
  if (labelled.label !== undefined && typeof labelled.label !== "string") return false;
  if (labelled.appearance !== undefined) {
    const appearance = labelled.appearance;
    if (!isObject(appearance)) return false;
    if (typeof appearance.shape !== "string" || typeof appearance.tint !== "string") return false;
  }
  if (optional.thinkingLevel !== undefined && typeof optional.thinkingLevel !== "string") {
    return false;
  }
  const inGroup = value as { groupId?: unknown };
  if (inGroup.groupId !== undefined && typeof inGroup.groupId !== "string") return false;
  const grouped = value as { toolGroups?: unknown };
  if (
    grouped.toolGroups !== undefined &&
    (!Array.isArray(grouped.toolGroups) || grouped.toolGroups.some((name) => !isToolGroup(name)))
  ) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    BOT_ID_PATTERN.test(value.id) &&
    typeof value.title === "string" &&
    value.title.trim().length > 0 &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.model.provider === "string" &&
    typeof value.model.modelId === "string"
  );
};

const assertRecord = (bot: unknown, what: string): BotConfig => {
  if (!isBotRecord(bot)) throw new DirectoryError("corrupt_catalog", `${what} is malformed`);
  return bot;
};

export class BotDirectory {
  readonly #root: string;
  readonly #fs: DirectoryFs;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(root: string, fs: DirectoryFs) {
    this.#root = root;
    this.#fs = fs;
  }

  get catalogPath(): string {
    return `${this.#root}/${CATALOG}`;
  }

  botDir(id: string): string {
    return `${this.#root}/bots/${id}`;
  }

  trashDir(id: string): string {
    return `${this.#root}/trash/${id}`;
  }

  async load(): Promise<readonly BotConfig[]> {
    const state = await this.#readCatalog();
    return state.bots.filter((bot) => state.cleanup[bot.id] === undefined);
  }

  async tombstones(after: number, limit: number) {
    const { tombstones } = await this.#readCatalog();
    const items = tombstones.slice(after, after + limit);
    const nextAfter = after + items.length;
    return { items, nextAfter, hasMore: nextAfter < tombstones.length };
  }

  async isDeleted(sharedBotId: string): Promise<boolean> {
    return (await this.#readCatalog()).tombstones.some((item) => item.sharedBotId === sharedBotId);
  }

  async markDeleted(
    items: readonly Tombstone[],
    cleanup: Readonly<Record<string, string>>,
  ): Promise<void> {
    await this.#serial(async () => {
      const state = await this.#readCatalog();
      const deleted = new Set(state.tombstones.map((item) => item.sharedBotId));
      const added = items.filter((item) => {
        if (deleted.has(item.sharedBotId)) return false;
        deleted.add(item.sharedBotId);
        return true;
      });
      await this.#writeCatalog({
        ...state,
        tombstones: [...state.tombstones, ...added],
        cleanup: { ...state.cleanup, ...cleanup },
      });
    });
  }

  async loadGroups(): Promise<readonly BotGroup[]> {
    return (await this.#readCatalog()).groups;
  }

  /** One read of the catalog: the bots, the groups, and no dangling membership. */
  async #readCatalog(): Promise<CatalogState> {
    let body: string;
    try {
      body = await this.#fs.readFile(this.catalogPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { bots: [], groups: [], tombstones: [], cleanup: {} };
      throw new DirectoryError("storage_failed", "cannot read catalog", { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new DirectoryError("corrupt_catalog", "catalog is not JSON", { cause: error });
    }
    if (!isObject(parsed)) throw new DirectoryError("corrupt_catalog", "catalog is not an object");
    if (parsed.version !== CATALOG_VERSION) {
      throw new DirectoryError("corrupt_catalog", "catalog version is not 1");
    }
    const bots = parsed.bots;
    if (!Array.isArray(bots))
      throw new DirectoryError("corrupt_catalog", "catalog has no bots array");
    const groups = parsed.groups ?? [];
    if (!Array.isArray(groups) || groups.some((group) => !isGroupRecord(group))) {
      throw new DirectoryError("corrupt_catalog", "catalog has a malformed groups array");
    }
    const ids = new Set<string>();
    for (const group of groups as readonly BotGroup[]) {
      if (ids.has(group.id)) {
        throw new DirectoryError("corrupt_catalog", `catalog repeats group ${group.id}`);
      }
      ids.add(group.id);
    }
    const seen = new Set<string>();
    const kept: BotConfig[] = [];
    for (const [index, bot] of bots.entries()) {
      if (!isBotRecord(bot)) {
        throw new DirectoryError("corrupt_catalog", `catalog entry ${index} is malformed`);
      }
      if (seen.has(bot.id)) {
        throw new DirectoryError("corrupt_catalog", `catalog repeats bot ${bot.id}`);
      }
      seen.add(bot.id);
      // A bot that points at a group which no longer exists is simply ungrouped: the
      // sidebar must keep working after a manual edit.
      kept.push(
        bot.groupId === undefined || ids.has(bot.groupId) ? bot : withGroup(bot, undefined),
      );
    }
    const tombstones = parsed.tombstones ?? [];
    if (
      !Array.isArray(tombstones) ||
      tombstones.some((item) => !tombstoneSchema.safeParse(item).success)
    )
      throw new DirectoryError("corrupt_catalog", "invalid tombstones");
    const deleted = new Set((tombstones as Tombstone[]).map((item) => item.sharedBotId));
    if (deleted.size !== tombstones.length)
      throw new DirectoryError("corrupt_catalog", "duplicate tombstone");
    const cleanup = parsed.cleanup ?? {};
    if (
      !isObject(cleanup) ||
      Object.entries(cleanup).some(
        ([id, shared]) =>
          !BOT_ID_PATTERN.test(id) || typeof shared !== "string" || !deleted.has(shared),
      )
    )
      throw new DirectoryError("corrupt_catalog", "invalid tombstone cleanup mapping");
    return {
      bots: kept,
      groups: groups as readonly BotGroup[],
      tombstones: tombstones as Tombstone[],
      cleanup: cleanup as Record<string, string>,
    };
  }

  async #writeAll(bots: readonly BotConfig[]): Promise<void> {
    for (const [index, bot] of bots.entries()) {
      if (!isBotRecord(bot)) {
        return Promise.reject(
          new DirectoryError("corrupt_catalog", `refusing to write malformed entry ${index}`),
        );
      }
    }
    // Called from inside the serial queue already; reading the groups here keeps the
    // membership and the bot list in one atomic write without a nested acquire.
    const state = await this.#readCatalog();
    return this.#writeCatalog({ ...state, bots });
  }

  async #writeCatalog(state: CatalogState): Promise<void> {
    const temp = `${this.catalogPath}.${randomUUID()}.tmp`;
    const body = `${JSON.stringify({ version: CATALOG_VERSION, bots: state.bots, groups: state.groups, ...(state.tombstones.length === 0 ? {} : { tombstones: state.tombstones }), ...(Object.keys(state.cleanup).length === 0 ? {} : { cleanup: state.cleanup }) }, null, 2)}\n`;
    try {
      await this.#fs.writeFile(temp, body, 0o600);
      await this.#fs.rename(temp, this.catalogPath);
    } catch (error) {
      await this.#fs.unlink(temp).catch(() => {});
      throw new DirectoryError("storage_failed", "cannot write catalog", { cause: error });
    }
  }

  /** Persists the bot config, then publishes the catalog entry. */
  async create(config: BotConfig): Promise<void> {
    // Validate before touching the filesystem: a malformed config must not leave a
    // directory or a bot.json behind.
    assertRecord(config, "bot config");
    await this.#serial(async () => {
      const bots = await this.load();
      if (bots.some((bot) => bot.id === config.id)) {
        throw new DirectoryError("duplicate_bot", `bot ${config.id} already exists`);
      }
      if (config.groupId !== undefined) {
        const groups = await this.loadGroups();
        if (!groups.some((group) => group.id === config.groupId)) {
          throw new DirectoryError("group_not_found", `no group ${config.groupId}`);
        }
      }
      try {
        await this.#fs.mkdir(this.botDir(config.id), { recursive: true });
        await this.#fs.writeFile(
          `${this.botDir(config.id)}/bot.json`,
          `${JSON.stringify(config, null, 2)}\n`,
          0o600,
        );
      } catch (error) {
        throw new DirectoryError("storage_failed", `cannot write bot ${config.id}`, {
          cause: error,
        });
      }
      await this.#writeAll([...bots, config]);
    });
  }

  /** Name, label or face changed; `label: null` clears it, `undefined` leaves it alone. */
  async update(
    id: string,
    changes: {
      readonly title?: string;
      readonly label?: string | null;
      readonly appearance?: BotAppearance;
    },
    at: string,
  ): Promise<BotConfig> {
    return this.#serial(async () => {
      const bots = await this.load();
      const index = bots.findIndex((bot) => bot.id === id);
      if (index === -1) throw new DirectoryError("unknown_bot", `bot ${id} does not exist`);
      const current = bots[index] as BotConfig;
      const { label, ...rest } = current;
      const updated: BotConfig = {
        ...rest,
        ...(changes.title === undefined ? {} : { title: changes.title }),
        ...(changes.appearance === undefined ? {} : { appearance: changes.appearance }),
        ...(changes.label === undefined
          ? label === undefined
            ? {}
            : { label }
          : changes.label === null
            ? {}
            : { label: changes.label }),
        updatedAt: at,
      };
      await this.#writeAll(bots.map((bot, position) => (position === index ? updated : bot)));
      return updated;
    });
  }

  /** Gateway settings changed the model of every bot; the catalog is the source of truth. */
  async setModel(
    id: string,
    model: { readonly provider: string; readonly modelId: string },
    at: string,
  ): Promise<BotConfig> {
    return this.#serial(async () => {
      const bots = await this.load();
      const index = bots.findIndex((bot) => bot.id === id);
      if (index === -1) throw new DirectoryError("unknown_bot", `bot ${id} does not exist`);
      const current = bots[index] as BotConfig;
      const updated: BotConfig = { ...current, model, updatedAt: at };
      await this.#writeAll(bots.map((bot, position) => (position === index ? updated : bot)));
      return updated;
    });
  }

  async setThinkingLevel(id: string, thinkingLevel: string, at: string): Promise<BotConfig> {
    return this.#serial(async () => {
      const bots = await this.load();
      const index = bots.findIndex((bot) => bot.id === id);
      if (index === -1) throw new DirectoryError("unknown_bot", `bot ${id} does not exist`);
      const current = bots[index] as BotConfig;
      const updated: BotConfig = { ...current, thinkingLevel, updatedAt: at };
      await this.#writeAll(bots.map((bot, position) => (position === index ? updated : bot)));
      return updated;
    });
  }

  async setToolGroups(
    id: string,
    toolGroups: readonly ToolGroup[],
    at: string,
  ): Promise<BotConfig> {
    return this.#serial(async () => {
      const bots = await this.load();
      const index = bots.findIndex((bot) => bot.id === id);
      if (index === -1) throw new DirectoryError("unknown_bot", `bot ${id} does not exist`);
      const current = bots[index] as BotConfig;
      const updated: BotConfig = { ...current, toolGroups, updatedAt: at };
      await this.#writeAll(bots.map((bot, position) => (position === index ? updated : bot)));
      return updated;
    });
  }

  async rename(id: string, title: string, at: string): Promise<BotConfig> {
    return this.#serial(async () => {
      const bots = await this.load();
      const index = bots.findIndex((bot) => bot.id === id);
      if (index === -1) throw new DirectoryError("unknown_bot", `bot ${id} does not exist`);
      const current = bots[index] as BotConfig;
      const updated: BotConfig = { ...current, title, updatedAt: at };
      await this.#writeAll(bots.map((bot, position) => (position === index ? updated : bot)));
      return updated;
    });
  }

  /**
   * Two idempotent steps. ENOENT from the move is only acceptable when the source is
   * gone *and* the trash directory is there; anything else keeps the catalog entry so
   * the bot cannot become unreachable.
   */
  async createGroup(title: string): Promise<BotGroup> {
    const clean = title.trim();
    if (clean.length === 0 || clean.length > MAX_GROUP_TITLE_CHARS) {
      throw new DirectoryError(
        "invalid_groups",
        `a group title is 1-${MAX_GROUP_TITLE_CHARS} characters`,
      );
    }
    return this.#serial(async () => {
      const state = await this.#readCatalog();
      if (state.groups.length >= MAX_BOT_GROUPS) {
        throw new DirectoryError("limit_exceeded", "the catalog holds too many groups");
      }
      const group: BotGroup = { id: `g_${randomUUID()}`, title: clean };
      await this.#writeCatalog({ ...state, bots: state.bots, groups: [...state.groups, group] });
      return group;
    });
  }

  async renameGroup(id: string, title: string): Promise<BotGroup> {
    const clean = title.trim();
    if (clean.length === 0 || clean.length > MAX_GROUP_TITLE_CHARS) {
      throw new DirectoryError(
        "invalid_groups",
        `a group title is 1-${MAX_GROUP_TITLE_CHARS} characters`,
      );
    }
    return this.#serial(async () => {
      const state = await this.#readCatalog();
      const index = state.groups.findIndex((group) => group.id === id);
      if (index === -1) throw new DirectoryError("group_not_found", `no group ${id}`);
      const renamed = { ...(state.groups[index] as BotGroup), title: clean };
      await this.#writeCatalog({
        ...state,
        bots: state.bots,
        groups: state.groups.map((group, position) => (position === index ? renamed : group)),
      });
      return renamed;
    });
  }

  /** Removes an empty group; a group that still holds a bot is refused, never emptied. */
  async deleteGroup(id: string): Promise<void> {
    await this.#serial(async () => {
      const state = await this.#readCatalog();
      if (!state.groups.some((group) => group.id === id)) {
        throw new DirectoryError("group_not_found", `no group ${id}`);
      }
      if (state.bots.some((bot) => bot.groupId === id)) {
        throw new DirectoryError("group_not_empty", "the group still holds bots");
      }
      await this.#writeCatalog({
        ...state,
        bots: state.bots,
        groups: state.groups.filter((group) => group.id !== id),
      });
    });
  }

  /** The full display order; ids must be a permutation of the stored groups. */
  async reorderGroups(ids: readonly string[]): Promise<readonly BotGroup[]> {
    return this.#serial(async () => {
      const state = await this.#readCatalog();
      const known = new Set(state.groups.map((group) => group.id));
      const unique = new Set(ids);
      if (
        ids.length !== known.size ||
        unique.size !== ids.length ||
        ids.some((id) => !known.has(id))
      ) {
        throw new DirectoryError("invalid_groups", "the order must list every group once");
      }
      const ordered = ids.map((id) => state.groups.find((group) => group.id === id) as BotGroup);
      await this.#writeCatalog({ ...state, bots: state.bots, groups: ordered });
      return ordered;
    });
  }

  /** Files a bot under a group, or clears the membership with `null`. */
  async setBotGroup(id: string, groupId: string | null, at: string): Promise<BotConfig> {
    return this.#serial(async () => {
      const state = await this.#readCatalog();
      const index = state.bots.findIndex((bot) => bot.id === id);
      if (index === -1) throw new DirectoryError("unknown_bot", `bot ${id} does not exist`);
      if (groupId !== null && !state.groups.some((group) => group.id === groupId)) {
        throw new DirectoryError("group_not_found", `no group ${groupId}`);
      }
      const current = state.bots[index] as BotConfig;
      const updated: BotConfig = {
        ...withGroup(current, groupId ?? undefined),
        updatedAt: at,
      };
      await this.#writeCatalog({
        ...state,
        bots: state.bots.map((bot, position) => (position === index ? updated : bot)),
        groups: state.groups,
      });
      return updated;
    });
  }

  async remove(id: string): Promise<void> {
    await this.#serial(async () => {
      const state = await this.#readCatalog();
      if (!state.bots.some((bot) => bot.id === id) && state.cleanup[id] === undefined) {
        throw new DirectoryError("unknown_bot", `bot ${id} does not exist`);
      }
      await this.#moveToTrash(id);
      const cleanup = { ...state.cleanup };
      delete cleanup[id];
      await this.#writeCatalog({
        ...state,
        bots: state.bots.filter((bot) => bot.id !== id),
        cleanup,
      });
    });
  }

  async #moveToTrash(id: string): Promise<void> {
    try {
      await this.#fs.mkdir(`${this.#root}/trash`, { recursive: true });
      await this.#fs.rename(this.botDir(id), this.trashDir(id));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const sourceGone = !(await this.#exists(this.botDir(id)));
      const trashed = await this.#exists(this.trashDir(id));
      if (!trashed && (await this.#exists(this.trashDir(id)))) {
        throw new DirectoryError("storage_failed", `trash path for ${id} is not a directory`);
      }
      if (!(code === "ENOENT" && sourceGone && trashed)) {
        throw new DirectoryError("storage_failed", `cannot move bot ${id} to trash`, {
          cause: error,
        });
      }
    }
  }

  async reconcile(): Promise<ReconcileResult> {
    return this.#serial(async () => {
      const state = await this.#readCatalog();
      const bots = state.bots;
      const cleanup = { ...state.cleanup };
      const completed: string[] = [];
      const failedDeletes: string[] = [];
      for (const id of Object.keys(cleanup)) {
        try {
          await this.#moveToTrash(id);
          delete cleanup[id];
          completed.push(id);
        } catch (error) {
          if (!(error instanceof DirectoryError) || error.reason !== "storage_failed") throw error;
          failedDeletes.push(id);
        }
      }
      const trashed = new Set(await this.#list(`${this.#root}/trash`));
      const present = new Set(await this.#list(`${this.#root}/bots`));
      const finishedDeletes = [
        ...new Set([
          ...completed,
          ...bots
            .filter(
              (bot) => cleanup[bot.id] === undefined && !present.has(bot.id) && trashed.has(bot.id),
            )
            .map((bot) => bot.id),
        ]),
      ];
      if (finishedDeletes.length > 0) {
        await this.#writeCatalog({
          ...state,
          bots: bots.filter((bot) => !finishedDeletes.includes(bot.id)),
          cleanup,
        });
      }
      const catalogIds = new Set(bots.map((bot) => bot.id));
      return {
        finishedDeletes,
        failedDeletes,
        orphanedTrash: [...trashed].filter((name) => !catalogIds.has(name)).sort(),
      };
    });
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #exists(path: string): Promise<boolean> {
    try {
      const stats = await this.#fs.stat(path);
      return stats.isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new DirectoryError("storage_failed", `cannot inspect ${path}`, { cause: error });
    }
  }

  async #list(path: string): Promise<string[]> {
    try {
      const entries = await this.#fs.readdir(path);
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new DirectoryError("storage_failed", `cannot list ${path}`, { cause: error });
    }
  }
}

/** The real filesystem adapter used by the daemon. */
export const nodeDirectoryFs = async (): Promise<DirectoryFs> => {
  const fs = await import("node:fs/promises");
  return {
    readFile: (path) => fs.readFile(path, "utf8"),
    writeFile: (path, body, mode) => fs.writeFile(path, body, { mode: mode ?? 0o600 }),
    rename: (from, to) => fs.rename(from, to),
    unlink: (path) => fs.unlink(path),
    mkdir: (path, options) => fs.mkdir(path, options).then(() => undefined),
    readdir: async (path) =>
      (await fs.readdir(path, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        isDirectory: () => entry.isDirectory(),
      })),
    stat: async (path) => {
      const stats = await fs.stat(path);
      return { isDirectory: () => stats.isDirectory() };
    },
  };
};
