import { randomUUID } from "node:crypto";
import { open, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  createProvider,
  type Models,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import {
  type Conversation,
  type ConversationView,
  createRegistry,
  type EntryId,
  Harness as Factory,
  type Harness,
  type Storage,
  type SubmissionRecord,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ConfigurationStore, publicConfiguration } from "./configuration.ts";
import {
  type ConfigurationInput,
  emptySnapshot,
  type FailureCode,
  type HistoryPage,
  MAX_INPUT,
  MAX_PENDING,
  ServiceError,
  type Snapshot,
  type Submission,
} from "./domain.ts";
import { confirmedWithin, modelFailure } from "./failure.ts";
import { boundedText, entryMessage, fitMessages, project } from "./projection.ts";

const requestID = /^[A-Za-z0-9_-]{8,64}$/;
const STORE_VERSION = 1;

const exists = async (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Refuse a store that is absent, truncated or not the durable SQLite pi wrote. */
async function assertUsableStore(path: string) {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile() || info.size < 100) throw new ServiceError("storage_failed");
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(16);
    const read = await file.read(header, 0, 16, 0);
    if (read.bytesRead !== 16 || header.toString("latin1") !== "SQLite format 3\u0000") {
      throw new ServiceError("storage_failed");
    }
  } finally {
    await file.close();
  }
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const row = database
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('entries','submissions','conversations')",
      )
      .get() as { n?: number } | undefined;
    if (row?.n !== 3) throw new ServiceError("storage_failed");
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError("storage_failed");
  } finally {
    database?.close();
  }
}

export async function markInitialized(root: string, storeId: string) {
  const path = join(root, "session.initialized.json");
  if (await exists(path)) return;
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: STORE_VERSION, storeId }), {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
}
const instructions =
  "You are Eagle Super Bot, an independent conversational assistant. Answer clearly in the user's language. You have no tools, cannot read worker bots, their histories or their observation state yourself, and cannot execute commands or delegate tasks. When the person relays what a worker shows, work from what they said; never claim to have observed or changed a worker on your own.";

export class ChatRuntime {
  /** One prompt the service itself writes, for a proactive report (SG-004). */
  async report(text: string): Promise<void> {
    await this.submit(randomUUID(), text);
  }

  readonly #store: ConfigurationStore;
  readonly #models: Models;
  readonly #mutable: MutableModels | undefined;
  #harness!: Harness;
  #root!: Conversation;
  #state = emptySnapshot();
  #view: ConversationView | undefined;
  #dispose: (() => void) | undefined;
  #listeners = new Set<(value: Snapshot) => void>();
  #chain: Promise<unknown> = Promise.resolve();
  #closing: Promise<void> | undefined;
  #accepting = true;
  #stopping = false;

  private constructor(store: ConfigurationStore, models?: Models) {
    this.#store = store;
    if (models) this.#models = models;
    else {
      this.#mutable = createModels();
      this.#models = this.#mutable;
    }
  }

  static async open(
    root: string,
    models?: Models,
    storageFactory: (path: string) => Promise<Storage> = openNodeSqliteStorage,
  ) {
    const store = new ConfigurationStore(root);
    await store.load();
    const runtime = new ChatRuntime(store, models);
    runtime.#installModel();
    const databasePath = join(root, "session.sqlite");
    const markerPath = join(root, "session.initialized.json");
    const existed = await exists(databasePath);
    const marker = await exists(markerPath);
    const configured = await exists(store.path);
    if (marker || existed || configured) await assertUsableStore(databasePath);
    const storage = await storageFactory(databasePath);
    try {
      runtime.#harness = await Factory.open(
        storage,
        {
          models: runtime.#models,
          registry: createRegistry(),
          settings: {
            stream: { timeoutMs: 120000 },
            retry: { maxRetries: 2 },
            restartLimit: 5,
            afterFailedRun: "continue",
            progress: { partialIntervalMs: 30 },
            compaction: {
              enabled: true,
              reserveTokens: 16384,
              keepRecentTokens: 8192,
              backgroundTokens: 32768,
            },
          },
          onReport: (_error, info) => {
            if (info.type === "session_failed") runtime.#fail("storage_failed");
            if (info.type === "task_parked") runtime.#fail("task_parked");
          },
        },
        context,
      );
      runtime.#root = await runtime.#harness.root(context, { agent: runtime.#agent() });
      await runtime.#root.configure(runtime.#agent(), context);
      const view = await runtime.#root.viewState(context);
      runtime.#update(view.value);
      const detach = view.subscribe((value) => runtime.#update(value));
      runtime.#dispose = () => {
        detach();
        view.dispose();
      };
      runtime.#harness.closed.then((end) => {
        if (end.reason === "failed") runtime.#fail("storage_failed");
      });
      if (runtime.#store.value?.apiKey) runtime.#harness.resume();
      return runtime;
    } catch (error) {
      if (runtime.#harness) await runtime.#harness.close(context);
      else await storage.close(context);
      if (!existed) {
        for (const suffix of ["", "-wal", "-shm"])
          await rm(`${databasePath}${suffix}`, { force: true }).catch(() => undefined);
      }
      throw error instanceof ServiceError ? error : new ServiceError("storage_failed");
    }
  }

  snapshot(): Snapshot {
    return this.#state;
  }

  observe(sink: (state: Snapshot) => void) {
    this.#listeners.add(sink);
    sink(this.#state);
    return () => {
      this.#listeners.delete(sink);
    };
  }

  configure(input: ConfigurationInput) {
    if (this.#stopping) return Promise.reject(new ServiceError("busy"));
    return this.#serial(async () => {
      this.#ensureOpen();
      if ((await this.#harness.inspect(context)).submissions.length > 0)
        throw new ServiceError("busy");
      const result = await this.#store.save(input);
      this.#installModel();
      await this.#root.configure(this.#agent(), context);
      if (this.#view) this.#update(this.#view);
      return result;
    });
  }

  submit(requestId: string, text: string): Promise<Submission> {
    if (this.#stopping) return Promise.reject(new ServiceError("busy"));
    return this.#serial(async () => {
      this.#ensureOpen();
      if (!requestID.test(requestId) || !text.trim()) throw new ServiceError("invalid_command");
      const existing = await this.submission(requestId);
      if (existing) return existing;
      if (Array.from(text).length > MAX_INPUT) throw new ServiceError("limit_exceeded");
      if (!this.#state.modelReady) throw new ServiceError("unconfigured");
      const pending = await this.#harness.inspect(context);
      if (pending.submissions.length >= MAX_PENDING) throw new ServiceError("limit_exceeded");
      const submission = await this.#root.submit(
        {
          type: "input",
          requestId,
          content: text,
          whenBusy: "followUp",
          entry: { kind: "superagent.input", data: { requestId } },
        },
        context,
      );
      return this.#record(await submission.status(context));
    });
  }

  async submission(requestId: string): Promise<Submission | null> {
    const record = await this.#harness.commit(
      (tx) => tx.submissionByRequest(this.#root.id, requestId),
      context,
    );
    return record ? this.#record(record) : null;
  }

  async #record(record: SubmissionRecord): Promise<Submission> {
    let answer: string | undefined;
    if (record.type === "input" && record.status === "done") {
      const page = await this.#root.entries(
        { minEntryId: record.answer, maxEntryId: record.answer },
        1,
        undefined,
        context,
      );
      const entry = page.items[0];
      answer = entry ? entryMessage(entry)?.text : undefined;
    }
    return {
      id: `s_${record.id}`,
      requestId: record.requestId ?? "",
      status: record.status,
      ...(record.entry === undefined ? {} : { entryId: `e_${record.entry}` }),
      ...(record.type !== "input" || record.status !== "done"
        ? {}
        : { answerEntryId: `e_${record.answer}` }),
      ...(answer === undefined ? {} : { answer: boundedText(answer) }),
      ...(record.status !== "unanswered"
        ? {}
        : {
            reason:
              record.reason === "model_error"
                ? modelFailure(record.detail)
                : ["aborted", "withdrawn", "stale"].includes(record.reason)
                  ? record.reason
                  : "run_failed",
          }),
    };
  }

  async history(before?: number, limit = 100): Promise<HistoryPage> {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
    )
      throw new ServiceError("invalid_command");
    const collected = [];
    let cursor: Awaited<ReturnType<Conversation["entries"]>>["next"];
    let scanned = 0;
    let last: number | undefined;
    do {
      const page = await this.#root.entries(
        {
          order: "descending",
          ...(before === undefined ? {} : { maxEntryId: (before - 1) as EntryId }),
        },
        128,
        cursor,
        context,
      );
      for (const entry of page.items) {
        last = entry.id;
        const message = entryMessage(entry);
        if (message) collected.push(message);
        if (collected.length > limit) break;
      }
      scanned += page.items.length;
      cursor = page.next;
    } while (cursor && collected.length <= limit && scanned < 4096);
    const more = collected.length > limit || cursor !== undefined;
    const messages = fitMessages(collected.slice(0, limit).reverse());
    const hasMore = more || messages.length < Math.min(collected.length, limit);
    const first = messages[0];
    const nextBefore = first ? Number(first.id.slice(2)) : last;
    return {
      messages,
      hasMore,
      coverage:
        hasMore || messages.some((message) => message.text.endsWith("\n[truncated]"))
          ? "partial"
          : "complete",
      ...(hasMore && nextBefore !== undefined ? { nextBefore } : {}),
    };
  }

  abort() {
    if (this.#stopping) return Promise.reject(new ServiceError("cancellation_unconfirmed"));
    this.#stopping = true;
    const work = this.#serial(async () => {
      try {
        this.#ensureOpen();
        await this.#root.abort(context, { background: true });
      } finally {
        this.#stopping = false;
      }
    });
    return confirmedWithin(work, 5000);
  }

  close() {
    this.#accepting = false;
    this.#closing ??= (async () => {
      await this.#chain;
      this.#dispose?.();
      this.#listeners.clear();
      await this.#harness.close(context);
    })();
    return this.#closing;
  }

  #ensureOpen() {
    if (!this.#accepting) throw new ServiceError("shutting_down");
    if (
      this.#state.failure?.code === "storage_failed" ||
      this.#state.failure?.code === "task_parked"
    )
      throw new ServiceError("storage_failed");
  }
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(work, work);
    this.#chain = next.catch(() => {});
    return next;
  }
  #update(view: ConversationView) {
    this.#view = view;
    this.#state = project(view, {
      ...this.#state,
      configuration: publicConfiguration(this.#store.value),
      modelReady: !!this.#store.value?.apiKey,
    });
    for (const sink of this.#listeners) sink(this.#state);
  }
  #fail(code: FailureCode) {
    if (this.#state.failure?.code === code) return;
    this.#state = {
      ...this.#state,
      failure: { code, id: `failure_${randomUUID()}` },
      running: false,
    };
    for (const sink of this.#listeners) sink(this.#state);
  }
  #agent() {
    return {
      model: { provider: "superagent", modelId: this.#store.value?.model ?? "unconfigured" },
      thinkingLevel: this.#store.value?.thinkingLevel ?? ("medium" as const),
      tools: [],
      extensions: [],
      instructions,
    };
  }
  #installModel() {
    if (!this.#mutable) return;
    const config = this.#store.value;
    this.#mutable.setProvider(
      createProvider({
        id: "superagent",
        name: "Eagle Super Bot",
        baseUrl: config?.baseUrl ?? "http://127.0.0.1:1",
        auth: {
          apiKey: {
            name: "Superagent API key",
            resolve: async () => (config?.apiKey ? { auth: { apiKey: config.apiKey } } : undefined),
          },
        },
        models: !config?.apiKey
          ? []
          : [
              {
                id: config.model,
                name: config.model,
                provider: "superagent",
                api: "openai-responses",
                baseUrl: config.baseUrl,
                reasoning: true,
                input: ["text"],
                contextWindow: 200000,
                maxTokens: 8192,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                thinkingLevelMap: {
                  off: "none",
                  minimal: "minimal",
                  low: "low",
                  medium: "medium",
                  high: "high",
                  xhigh: "xhigh",
                  max: "max",
                },
              },
            ],
        api: openAIResponsesApi(),
      }),
    );
  }
}
