// The daemon entry point (docs/bots/ARCHITECTURE.md "Process model"): one root, one lock,
// one token, one log, one registry and one server. Everything here is composition; the
// behaviour lives in the modules it wires.
import { readFileSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DaemonConfig } from "./config.ts";
import { BotDirectory, nodeDirectoryFs } from "./core/BotDirectory.ts";
import { BotRegistry } from "./core/BotRegistry.ts";
import { ConversationService } from "./core/ConversationService.ts";
import type { TriggerSummary } from "./core/domain.ts";
import {
  DEFAULT_THINKING_LEVEL,
  isThinkingLevel,
  isToolGroup,
  resolveToolGroups,
} from "./core/domain.ts";
import { newFailure } from "./core/failures.ts";
import { OriginStore, originPath } from "./core/OriginStore.ts";
import { PeerExchangeStore } from "./core/PeerExchangeStore.ts";
import type { RuntimeEvent } from "./core/RuntimePort.ts";
import { TriggerSecretStore, triggerSecretsPath } from "./core/TriggerSecrets.ts";
import { TriggerStore, triggerJournalPath } from "./core/TriggerStore.ts";
import { declareEvent } from "./log/events.ts";
import { Log } from "./log/log.ts";
import { FileLogSink } from "./log/sink.ts";
import { peerApi } from "./peers/api.ts";
import { peerHostFor } from "./peers/host.ts";
import { encodeServerEvent } from "./protocol/encode.ts";
import { composePulls, pullPublisher } from "./pulls/host.ts";
import { createDaemonModels } from "./runtime/pi/models.ts";
import { PiDurableRuntime, type PiSettings } from "./runtime/pi/PiDurableRuntime.ts";
import { loadToken } from "./server/auth.ts";
import { ClientStore } from "./server/clients.ts";
import {
  DEFAULT_CORE_PROMPT,
  type GatewayApi,
  type GatewayConfig,
  gatewayFromEnv,
  listGatewayModels,
  MAX_CORE_PROMPT,
  normalizeBaseUrl,
  normalizeCorePrompt,
  publicGateway,
  readGateway,
  testGateway,
  writeGateway,
} from "./server/gateway.ts";
import { type Daemon, startServer, type TriggerIngress } from "./server/http.ts";
import {
  PROVIDERS,
  type ProviderApi,
  type ProviderDefinition,
  type PublicProvider,
  providerDefinition,
  providersPath,
  publicProviders,
  readProviders,
  selectedProvider,
  writeProviders,
} from "./server/providers.ts";
import { acquireLock, LockError } from "./server/singleton.ts";
import { toServerEvent } from "./server/socket.ts";
import { UsageStore } from "./server/usage.ts";
import {
  MACHINE_PROMPT_CANDIDATES,
  type MachinePrompt,
  readMachinePrompt,
} from "./tools/machine/tools.ts";
import type { SearchClient } from "./tools/search/client.ts";
import { createDeepSeekSearch } from "./tools/search/deepseek.ts";
import { createTavilySearch } from "./tools/search/tavily.ts";
import { triggerHost } from "./triggers/host.ts";
import { createIngress } from "./triggers/ingress.ts";
import { TriggerProducers } from "./triggers/producers.ts";
import { fileJournal, TriggerQueue } from "./triggers/queue.ts";

export type DaemonHandle = {
  readonly config: DaemonConfig;
  readonly port: number;
  readonly token: string;
  readonly daemon: Daemon;
  readonly registry: BotRegistry;
  close(): Promise<void>;
};

const packageVersion = (): string => {
  try {
    const body = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(body) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
};

/** The answer text a peer reads: the text blocks of one committed message. */
const textOf = (
  blocks: readonly { readonly type: string; readonly text?: string }[],
): string | undefined => {
  const text = blocks.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
  return text === "" ? undefined : text;
};

/** Encoded bytes of one event, measured on the frame the wire layer would write. */
const StartupEvents = {
  singletonStart: declareEvent("core.singleton.start"),
  singletonOk: declareEvent("core.singleton.ok"),
  singletonFail: declareEvent("core.singleton.fail"),
  originReplayDegrade: declareEvent("core.origin.replay.degrade"),
} as const;

export const measureEvent = (event: RuntimeEvent): number =>
  Buffer.byteLength(JSON.stringify(encodeServerEvent(toServerEvent({ ...event, rev: 0 }))));

/** A positive integer from the environment, else the default. */
const positiveNumber = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return raw !== undefined && Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

/**
 * The compaction policy the daemon runs with: on by default, with thresholds expressed in
 * tokens of the declared window, so a small window compacts early and a large one late.
 */
export const compactionFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  windowTokens: number,
): PiSettings["compaction"] => {
  if (env.BOTS_COMPACTION === "off") return { enabled: false };
  return {
    enabled: true,
    reserveTokens: Math.min(
      positiveNumber(env.BOTS_COMPACTION_RESERVE_TOKENS, 16_384),
      windowTokens / 2,
    ),
    keepRecentTokens: positiveNumber(env.BOTS_COMPACTION_KEEP_RECENT_TOKENS, 8_192),
    backgroundTokens: Math.min(
      positiveNumber(env.BOTS_COMPACTION_BACKGROUND_TOKENS, 32_768),
      windowTokens / 4,
    ),
  };
};

export const startDaemon = async (config: DaemonConfig): Promise<DaemonHandle> => {
  // The lock port is derived from the canonical root, so the root has to exist before the
  // hash is computed: a path that resolves differently on the next start would give the
  // same directory a second lock port (ARCHITECTURE.md, "Singleton lock").
  await mkdir(config.root, { recursive: true, mode: 0o700 }).catch(() => undefined);
  const root = await realpath(config.root).catch((error: unknown) => {
    process.stderr.write(`bots: cannot resolve the root ${config.root}: ${String(error)}\n`);
    process.exit(1);
  });
  const canonical: DaemonConfig = { ...config, root };
  const token = await loadToken(root);
  const clients = await ClientStore.open(root);
  const providers = await createProviderService();
  let gateway: GatewayConfig | undefined;
  // The log exists before the lock so a refused second start is on record, and it holds
  // the token as a secret for redaction from its first record.
  // Declared before the log: its redaction closure reads this set on every record.
  const triggerTokens = new Set<string>();
  const sink = new FileLogSink({ root, minimum: canonical.logLevel });
  const log = new Log(sink.sink, undefined, {
    secrets: () => [token, gateway?.apiKey ?? "", ...providers.secrets(), ...triggerTokens],
  });
  const startup = "tr_boot_1";
  log.emit("info", "core", StartupEvents.singletonStart, { trace: startup });
  let lock: Awaited<ReturnType<typeof acquireLock>>;
  try {
    lock = await acquireLock({ root });
  } catch (error) {
    if (error instanceof LockError) {
      log.emit("error", "core", StartupEvents.singletonFail, {
        trace: startup,
        failure: newFailure("internal", "core"),
        origin: true,
        detail: { reason: "startup" },
      });
      await sink.close();
      process.stderr.write(`bots: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
  log.emit("info", "core", StartupEvents.singletonOk, { trace: startup });
  const directory = new BotDirectory(root, await nodeDirectoryFs());
  // The stored gateway wins over the dotenv; without either, the registry is empty and a
  // run settles `no_model` until a person configures it in the app.
  gateway = (await readGateway(root)) ?? gatewayFromEnv(process.env);
  const windowTokens = positiveNumber(process.env.BOTS_CONTEXT_WINDOW, 200_000);
  let models = createDaemonModels(
    gateway === undefined
      ? undefined
      : {
          baseUrl: gateway.baseUrl,
          apiKey: gateway.apiKey,
          provider: gateway.provider,
          modelId: gateway.model,
          contextWindow: windowTokens,
          ...(process.env.BOTS_MAX_TOKENS === undefined
            ? {}
            : { maxTokens: positiveNumber(process.env.BOTS_MAX_TOKENS, 8_192) }),
        },
  );
  const compaction = compactionFromEnv(process.env, windowTokens);
  const usageStore = new UsageStore(join(root, "usage.sqlite"));
  // Exchanges between bots live next to the catalog: one durable record each, with the budget.
  const peerStore = new PeerExchangeStore(join(root, "peers"));
  await peerStore.open();
  // One pull-request journal per bot, opened on demand: a bot that reports nothing reads none.
  const pullSink = pullPublisher();
  const pulls = composePulls({
    botDir: directory.botDir.bind(directory),
    publish: pullSink,
  });
  // One store per bot, opened on demand: a bot that never uses a trigger reads no journal.
  const triggers = new Map<string, Promise<TriggerStore>>();
  /** Webhook credentials per bot, and every token the log must redact. */
  const secretStores = new Map<string, Promise<TriggerSecretStore>>();
  const secretsFor = (botId: string): Promise<TriggerSecretStore> => {
    const open = secretStores.get(botId);
    if (open !== undefined) return open;
    const opened = TriggerSecretStore.open(triggerSecretsPath(directory.botDir(botId)));
    secretStores.set(botId, opened);
    opened.catch(() => secretStores.delete(botId));
    opened.then((store) => {
      for (const token of store.tokens()) triggerTokens.add(token);
    });
    return opened;
  };
  /** A webhook trigger is usable the moment it exists, so its token is minted here. */
  const ensureWebhookTokens = async (botId: string): Promise<void> => {
    const store = await triggerStoreFor(botId);
    const webhooks = store.list().filter((trigger) => trigger.kind === "webhook");
    if (webhooks.length === 0) return;
    const secrets = await secretsFor(botId);
    for (const trigger of webhooks) triggerTokens.add(await secrets.tokenFor(trigger.id));
  };
  /** Set once the service exists: a model's own edit has to reach the sidebar. */
  let refreshTriggers: (botId: string) => void = () => undefined;
  const triggerStoreFor = (botId: string): Promise<TriggerStore> => {
    const open = triggers.get(botId);
    if (open !== undefined) return open;
    const opened = TriggerStore.open(botId, triggerJournalPath(directory.botDir(botId)), {
      onChange: () => refreshTriggers(botId),
      onDropped: (count) => {
        log.emit("warn", "core", StartupEvents.originReplayDegrade, {
          trace: "tr_trigger_load_0001",
          botId,
          failure: newFailure("internal", "core"),
          detail: { count },
        });
      },
    });
    triggers.set(botId, opened);
    opened.catch(() => triggers.delete(botId));
    return opened;
  };
  // One queue per trigger, keyed by bot and trigger: the delivery journal is its own file,
  // so deleting a trigger cannot touch another one's undelivered work.
  const queues = new Map<string, Promise<TriggerQueue>>();
  const queueFor = (botId: string, triggerId: string): Promise<TriggerQueue> => {
    const key = `${botId}/${triggerId}`;
    const open = queues.get(key);
    if (open !== undefined) return open;
    const opened = TriggerQueue.open({
      triggerId,
      journal: fileJournal(join(directory.botDir(botId), "triggers", `${triggerId}.jsonl`)),
    });
    queues.set(key, opened);
    opened.catch(() => queues.delete(key));
    return opened;
  };
  /** What the sidebar sees: definitions, counters, and the queue's next due instant. */
  const summarize = async (botId: string): Promise<readonly TriggerSummary[]> => {
    const store = await triggerStoreFor(botId);
    return Promise.all(
      store.list().map(async (trigger) => {
        const queue = await queueFor(botId, trigger.id);
        const cursor = trigger.schedule === undefined ? undefined : queue.cursor();
        return {
          id: trigger.id,
          kind: trigger.kind,
          name: trigger.name,
          enabled: trigger.enabled,
          counters: trigger.counters,
          ...(trigger.schedule === undefined
            ? {}
            : {
                schedule: {
                  cron: trigger.schedule.cron,
                  timezone: trigger.schedule.timezone,
                  ...(cursor === undefined ? {} : { nextDueAt: cursor }),
                },
              }),
          ...(trigger.lastFiredAt === undefined ? {} : { lastFiredAt: trigger.lastFiredAt }),
          ...(trigger.lastSkipped === undefined ? {} : { lastSkipped: trigger.lastSkipped }),
        };
      }),
    );
  };
  /** Detail for the app: the list plus what only the store knows, never a credential. */
  const triggerDetails = async (botId: string): Promise<Record<string, unknown>[]> => {
    const store = await triggerStoreFor(botId);
    const summaries = await summarize(botId);
    const entries: Record<string, unknown>[] = [];
    for (const summary of summaries) {
      const definition = store.get(summary.id);
      const endpoint =
        summary.kind === "webhook" ? `/v1/triggers/${botId}/${summary.id}` : undefined;
      let token: string | undefined;
      if (endpoint !== undefined) {
        token = await (await secretsFor(botId)).tokenFor(summary.id);
        triggerTokens.add(token);
      }
      entries.push({
        ...summary,
        prompt: definition?.prompt ?? "",
        ...(endpoint === undefined ? {} : { endpoint }),
        ...(token === undefined ? {} : { token }),
      });
    }
    return entries;
  };
  // The machine's instructions, read on every ask so an edit shows up on the next turn. An
  // explicit path wins, which is how a test or a second machine points at its own file.
  const machinePrompt = (): MachinePrompt | undefined =>
    readMachinePrompt(homedir(), machinePromptCandidates());
  const machinePromptCandidates = (): readonly string[] => {
    const explicit = process.env.BOTS_MACHINE_AGENTS?.trim();
    return explicit === undefined || explicit.length === 0 ? MACHINE_PROMPT_CANDIDATES : [explicit];
  };
  const runtime = new PiDurableRuntime({
    ...(canonical.deviceSocket === undefined ? {} : { deviceSocket: canonical.deviceSocket }),
    models: () => models,
    log,
    compaction,
    usage: usageStore,
    corePrompt: () => gateway?.corePrompt,
    machinePrompt: () => machinePrompt(),
    search: () => providers.client,
    trigger: async (spec) =>
      triggerHost(spec.id, await triggerStoreFor(spec.id), async (triggerId) => {
        const queue = queues.get(`${spec.id}/${triggerId}`);
        return queue === undefined ? undefined : (await queue).cursor();
      }),
    pulls: pulls.runtimeHost,
    peers: async (spec) =>
      peerHostFor({
        botId: spec.id,
        store: peerStore,
        bots: () => registry.summaries(),
        invoke: (input) => service.invoke(input),
        submission: (query) => service.submission(query),
        entryText: async (botId, entryId) => {
          const message = await registry.handleOf(botId)?.entryById?.(entryId);
          return message === undefined ? undefined : textOf(message.blocks);
        },
      }),
  });
  const defaultModel =
    gateway === undefined
      ? canonical.model
      : { provider: gateway.provider, modelId: gateway.model };
  const registry = new BotRegistry({
    directory,
    openRuntime: (spec) => runtime.open(spec),
    model: defaultModel,
    ...(gateway === undefined
      ? {}
      : { thinkingLevel: gateway.thinkingLevel, toolGroups: gateway.toolGroups }),
    log,
    idleCloseMs: canonical.idleCloseMs,
    quarantineRetryMs: canonical.quarantineRetryMs,
    closeDeadlineMs: canonical.closeDeadlineMs,
  });
  await registry.start();
  // The daemon's stored selection governs every bot, including one created before a group
  // existed: a restart applies it once, exactly like saving the settings does.
  if (gateway !== undefined) {
    await registry.applyToolGroups(gateway.toolGroups, "tr_boot_groups");
  }
  // The daemon exists after the service that has to broadcast through it.
  let broadcast: (() => void) | undefined;
  const service = new ConversationService({
    open: (botId, trace) => registry.open(botId, trace),
    handleOf: (botId) => registry.handleOf(botId),
    settlingOf: (botId) => registry.settling(botId),
    measure: measureEvent,
    log,
    // A caller without a connection still needs the bot open while it admits, and the bot
    // must be able to idle-close afterwards (TRIGGERS.md §3.3).
    lease: {
      acquire: (botId) => registry.touch(botId),
      release: (botId) => registry.release(botId),
    },
    triggersOf: { list: summarize },
    pullsOf: { list: pulls.list },
    // Every admission is labelled, so an unlabelled message means "unknown", never
    // "human" (TRIGGERS.md §6.2). One file per bot, under its own directory.
    origins: {
      store: async (botId) => {
        const store = await OriginStore.open(originPath(directory.botDir(botId)));
        if (store.dropped > 0) {
          log.emit("warn", "core", StartupEvents.originReplayDegrade, {
            trace: "tr_origin_load_0001",
            botId,
            failure: newFailure("internal", "core"),
            detail: { count: store.dropped },
          });
        }
        return store;
      },
    },
    onRunning: (botId, running) => {
      if (registry.markRunning(botId, running)) broadcast?.();
    },
    onSessionFailed: (botId, reason, message, dropHandle) => {
      if (registry.markUnavailable(botId, reason, message, { dropHandle })) broadcast?.();
    },
    onUsage: (botId, usage) => {
      try {
        usageStore.recordModelUsage(botId, usage);
      } catch {
        // Statistics are a side channel: a full disk must not fail the conversation.
      }
    },
    onRecovered: (botId, running) => {
      // Always push: the client that showed `unavailable` has to see the recovery even
      // when the registry's own state already moved on.
      registry.markRecovered(botId, running);
      broadcast?.();
    },
  });

  // The store exists before the runtime; the sink forwards its changes to the service now.
  pullSink.set(service.publishPulls.bind(service));

  // Producers: one pump per bot and one schedule ticker, stopped before admissions drain.
  let triggerTraces = 0;
  const producers = new TriggerProducers({
    bots: () => registry.summaries().map((summary) => summary.id),
    storeFor: triggerStoreFor,
    queueFor,
    port: service,
    now: () => new Date(),
    newTrace: () => {
      triggerTraces += 1;
      return `tr_trigger_${Date.now().toString(36)}_${triggerTraces.toString(36)}`;
    },
    // A tick moves the cursor, which lives in the queue rather than the store: without
    // this the sidebar's "next" would stay empty until the trigger first fired.
    onTick: ({ botId }) => refreshTriggers(botId),
  });
  producers.start();
  // A webhook trigger that existed before this process must be deliverable immediately:
  // its token is minted at boot, not on the first time somebody opens the row.
  for (const summary of registry.summaries()) {
    void ensureWebhookTokens(summary.id).catch(() => undefined);
  }
  refreshTriggers = (botId: string) => {
    void ensureWebhookTokens(botId).catch(() => undefined);
    void summarize(botId)
      .then((list) =>
        service.publishTriggers(botId, list, `tr_trigger_refresh_${Date.now().toString(36)}`),
      )
      .catch(() => undefined);
  };
  // One inbound delivery: authenticate, dedupe, enqueue; the pump decides when it runs.
  const ingress: TriggerIngress = createIngress({
    storeFor: triggerStoreFor,
    secretsFor,
    queueFor,
    drain: (botId) => void producers.pumpFor(botId).drain(),
    now: () => new Date(),
    count: (botId, triggerId, delta) => {
      void triggerStoreFor(botId)
        .then((store) => {
          const current = store.get(triggerId);
          if (current === undefined) return undefined;
          return store.patch({
            triggerId,
            patch: {
              counters: {
                fired: current.counters.fired + (delta.fired ?? 0),
                dropped: current.counters.dropped + (delta.dropped ?? 0),
                refused: current.counters.refused + (delta.refused ?? 0),
              },
            },
          });
        })
        .catch(() => undefined);
    },
  });
  const triggerApi = {
    list: triggerDetails,
    setEnabled: async (botId: string, triggerId: string, enabled: boolean, trace: string) => {
      const store = await triggerStoreFor(botId);
      if (store.get(triggerId) === undefined) return undefined;
      await store.enable({ opId: `ui_${trace}`, triggerId, enabled });
      const details = await triggerDetails(botId);
      return details.find((entry) => entry.id === triggerId);
    },
  };
  const capabilities = {
    agent: true,
    tools: true,
    tasks: true,
    entries: false,
    usage: true,
    peers: false,
    triggers: true,
  };
  let modelCache: { at: number; ids: readonly string[] } | undefined;
  const settings: GatewayApi = {
    public: () => publicGateway(gateway),
    save: async (input) => {
      const baseUrl =
        input.baseUrl === undefined
          ? (gateway?.baseUrl ?? "")
          : (normalizeBaseUrl(input.baseUrl) ?? "");
      const model = (input.model ?? gateway?.model ?? "").trim();
      const apiKey =
        input.apiKey !== undefined && input.apiKey.trim().length > 0
          ? input.apiKey.trim()
          : (gateway?.apiKey ?? "");
      const provider = (input.provider ?? gateway?.provider ?? "magpie").trim() || "magpie";
      const thinkingLevel =
        input.thinkingLevel === undefined
          ? (gateway?.thinkingLevel ?? DEFAULT_THINKING_LEVEL)
          : input.thinkingLevel.trim();
      if (!isThinkingLevel(thinkingLevel)) {
        return {
          settings: publicGateway(gateway),
          error: "思考等级必须是 off、minimal、low、medium、high、xhigh 或 max",
        };
      }
      // A save that names no gateway field is the 工具 page: it may run before a gateway is
      // configured, so the three required fields are only checked when this request decides
      // them or when a gateway is already stored.
      const touchesGateway =
        input.baseUrl !== undefined ||
        input.model !== undefined ||
        input.apiKey !== undefined ||
        input.provider !== undefined ||
        input.thinkingLevel !== undefined;
      const needsGateway = touchesGateway || gateway !== undefined;
      if (needsGateway && baseUrl.length === 0) {
        return { settings: publicGateway(gateway), error: "网关地址必须是 http(s) URL" };
      }
      if (needsGateway && model.length === 0) {
        return { settings: publicGateway(gateway), error: "模型不能为空" };
      }
      if (needsGateway && apiKey.length === 0) {
        return { settings: publicGateway(gateway), error: "API Key 不能为空" };
      }
      const requestedGroups = input.toolGroups;
      if (requestedGroups !== undefined) {
        const unknown = requestedGroups.filter((name) => !isToolGroup(name));
        if (unknown.length > 0) {
          return {
            settings: publicGateway(gateway),
            error: `未知的工具组：${unknown.join("、")}`,
          };
        }
      }
      const corePrompt =
        input.corePrompt === undefined
          ? (gateway?.corePrompt ?? DEFAULT_CORE_PROMPT)
          : normalizeCorePrompt(input.corePrompt);
      if (corePrompt === undefined) {
        return {
          settings: publicGateway(gateway),
          error: `人格提示不能超过 ${MAX_CORE_PROMPT} 个字符`,
        };
      }
      const toolGroups = resolveToolGroups(requestedGroups ?? gateway?.toolGroups);
      const next: GatewayConfig = {
        provider,
        baseUrl,
        model,
        apiKey,
        thinkingLevel,
        toolGroups,
        corePrompt,
      };
      await writeGateway(root, next);
      gateway = next;
      // Without a complete gateway there is nothing to apply: the tools page is allowed to
      // store a persona before anyone configures a model.
      if (next.baseUrl.length > 0 && next.model.length > 0 && next.apiKey.length > 0) {
        models = createDaemonModels({
          baseUrl,
          apiKey,
          provider,
          modelId: model,
        });
        await registry.applyModel({ provider, modelId: model }, "tr_http_settings");
      }
      await registry.applyThinkingLevel(thinkingLevel, "tr_http_settings");
      await registry.applyToolGroups(toolGroups, "tr_http_settings");
      return { settings: publicGateway(next) };
    },
    test: async (input) => {
      const baseUrl =
        input.baseUrl === undefined
          ? (gateway?.baseUrl ?? "")
          : (normalizeBaseUrl(input.baseUrl) ?? "");
      const apiKey =
        input.apiKey !== undefined && input.apiKey.trim().length > 0
          ? input.apiKey.trim()
          : (gateway?.apiKey ?? "");
      if (baseUrl.length === 0 || apiKey.length === 0) {
        return { ok: false, message: "请填写有效的网关地址和 API Key", latencyMs: 0 };
      }
      return testGateway({
        provider: input.provider ?? gateway?.provider ?? "magpie",
        baseUrl,
        model: (input.model ?? gateway?.model ?? "").trim(),
        apiKey,
      });
    },
  };
  const daemon = await startServer({
    ...(canonical.deviceSocket === undefined ? {} : { deviceSocket: canonical.deviceSocket }),
    token,
    clients,
    log,
    registry,
    service,
    settings,
    machinePrompt,
    triggers: triggerApi,
    peers: peerApi({
      store: peerStore,
      bots: () => registry.summaries(),
      submission: (query) => service.submission(query),
      entryText: async (botId, entryId) => {
        const message = await registry.handleOf(botId)?.entryById?.(entryId);
        return message === undefined ? undefined : textOf(message.blocks);
      },
    }),
    ingress,
    version: packageVersion(),
    instance: `i_${process.pid}`,
    capabilities,
    port: canonical.port,
    gatewayProvider: () => gateway?.provider ?? "magpie",
    providers,
    usage: async (days: number) => {
      const report = usageStore.report(days);
      const titles = new Map(registry.summaries().map((bot) => [bot.id, bot.title]));
      return {
        ...report,
        bots: report.bots.map((bot) => ({ ...bot, title: titles.get(bot.botId) ?? bot.botId })),
      };
    },
    models: async () => {
      if (gateway === undefined) return [];
      const now = Date.now();
      if (modelCache !== undefined && now - modelCache.at < 60_000) return modelCache.ids;
      const ids = await listGatewayModels(gateway);
      modelCache = { at: now, ids };
      return ids;
    },
  });
  broadcast = daemon.broadcastCatalog;
  const close = async (): Promise<void> => {
    // One absolute deadline for the whole shutdown: a stalled socket grace, handle close
    // or log flush must not add up past the configured budget.
    const budget = canonical.closeDeadlineMs + 1_000;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budget);
      timer.unref?.();
    });
    const stopped = (async () => {
      // Producers stop first, then admissions already in flight settle, and only then may
      // the registry close handles under them (TRIGGERS.md §3.6).
      producers.stop();
      await daemon.close();
      await service.drain();
      await registry.shutdown();
      await sink.close();
      await lock.close();
    })();
    try {
      await Promise.race([stopped, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  return { config: canonical, port: daemon.port, token, daemon, registry, close };
};

export const createProviderService = async (
  options: { readonly path?: string; readonly fetch?: typeof fetch } = {},
): Promise<ProviderApi & { readonly client: SearchClient; secrets(): readonly string[] }> => {
  const path = options.path ?? providersPath();
  let configs = await readProviders(path);
  let queue = Promise.resolve();
  const clientFor = (definition: ProviderDefinition): SearchClient => {
    const http = {
      apiKey: configs[definition.id]?.apiKey ?? "",
      baseUrl: definition.baseUrl,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    };
    return definition.kind === "deepseek-search"
      ? createDeepSeekSearch(http)
      : createTavilySearch(http);
  };
  const selectedClient = (): SearchClient => {
    const definition = selectedProvider(configs);
    if (definition === undefined) throw new Error("请先在服务中选择一个已保存 Key 的搜索服务商。");
    return clientFor(definition);
  };
  const save: ProviderApi["save"] = async (id, input) => {
    const definition = providerDefinition(id);
    if (definition === undefined) return { error: `未知的服务：${id}` };
    const current = configs[id] ?? { apiKey: "", enabled: false };
    const apiKey = input.apiKey === undefined ? current.apiKey : input.apiKey.trim();
    if ((input.apiKey !== undefined || input.enabled === true) && apiKey.length === 0) {
      return { error: "请先保存 API Key" };
    }
    const next = { ...configs, [id]: { apiKey, enabled: input.enabled ?? current.enabled } };
    if (input.enabled === true) {
      for (const provider of PROVIDERS) {
        const config = next[provider.id];
        if (config !== undefined && provider.id !== id)
          next[provider.id] = { ...config, enabled: false };
      }
    }
    await writeProviders(next, path);
    configs = next;
    return {
      provider: publicProviders(configs).find((provider) => provider.id === id) as PublicProvider,
    };
  };
  return {
    public: () => publicProviders(configs),
    secrets: () => Object.values(configs).map((config) => config.apiKey),
    save(id, input) {
      const result = queue.then(() => save(id, input));
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    async test(id) {
      const definition = providerDefinition(id);
      if (definition === undefined || !configs[id]?.apiKey.trim()) {
        return { ok: false, message: "还没有保存这个服务的 API Key", latencyMs: 0 };
      }
      const started = performance.now();
      try {
        const results = await clientFor(definition).search({ query: "web search", count: 1 });
        return {
          ok: true,
          message: `连接成功，返回 ${results.length} 条结果`,
          latencyMs: Math.round(performance.now() - started),
          results: results.length,
        };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : "搜索服务不可用",
          latencyMs: Math.round(performance.now() - started),
        };
      }
    },
    client: {
      search: async (input, signal) => selectedClient().search(input, signal),
      fetchPage: async (input, signal) => selectedClient().fetchPage(input, signal),
    },
  };
};
