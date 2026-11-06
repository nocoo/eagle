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
import { type SecretsPort, SecretsStorageError } from "./core/domain.ts";
import { newFailure } from "./core/failures.ts";
import { OriginStore, originPath } from "./core/OriginStore.ts";
import { PeerExchangeStore } from "./core/PeerExchangeStore.ts";
import type { RuntimeEvent } from "./core/RuntimePort.ts";
import { TriggerSecretStore, triggerSecretsPath } from "./core/TriggerSecrets.ts";
import { TriggerStore, triggerJournalPath } from "./core/TriggerStore.ts";
import { declareEvent } from "./log/events.ts";
import { Log } from "./log/log.ts";
import { FileLogSink } from "./log/sink.ts";
import { fileMemoryHost } from "./memory/fileHost.ts";
import { peerApi } from "./peers/api.ts";
import { peerHostFor } from "./peers/host.ts";
import { encodeServerEvent } from "./protocol/encode.ts";
import { composePulls, pullPublisher } from "./pulls/host.ts";
import { ModelRegistry } from "./runtime/pi/models.ts";
import { PiDurableRuntime, type PiSettings } from "./runtime/pi/PiDurableRuntime.ts";
import { SecretsStore } from "./secrets/store.ts";
import { loadToken } from "./server/auth.ts";
import { ClientStore } from "./server/clients.ts";
import { armDevToken } from "./server/devToken.ts";
import {
  type GatewayApi,
  type GatewayConfig,
  gatewayFromEnv,
  isGatewayComplete,
  normalizeBaseUrl,
  publicGateway,
  readGateway,
  testGateway,
  writeGateway,
} from "./server/gateway.ts";
import { type Daemon, type SecretsApi, startServer, type TriggerIngress } from "./server/http.ts";
import {
  PROVIDERS,
  type ProviderApi,
  type ProviderConfig,
  type ProviderDefinition,
  type PublicProvider,
  providerDefinition,
  providersPath,
  publicProviders,
  readProviders,
  selectedProvider,
  writeProviders,
} from "./server/providers.ts";
import { createSettingsSaver } from "./server/settings.ts";
import { acquireLock, LockError } from "./server/singleton.ts";
import { toServerEvent } from "./server/socket.ts";
import { UsageStore } from "./server/usage.ts";
import { ADDRESS_REFUSED, decisionRoot } from "./tools/decision/address.ts";
import type { DecisionClient } from "./tools/decision/client.ts";
import { probeDecision, systemOne } from "./tools/decision/systemone.ts";
import {
  MACHINE_PROMPT_CANDIDATES,
  type MachinePrompt,
  readMachinePrompt,
} from "./tools/machine/tools.ts";
import { createNoteHost } from "./tools/note.ts";
import { createCatalogRegistry, describeToolCatalog } from "./tools/registry.ts";
import type { SearchClient } from "./tools/search/client.ts";
import { createDeepSeekSearch } from "./tools/search/deepseek.ts";
import { createTavilySearch } from "./tools/search/tavily.ts";
import type { SecretsToolHost } from "./tools/types.ts";
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
  close(): Promise<"closed" | "timeout">;
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
    // The composition root reports the failure; the process entry decides to exit
    // (scripts/serve.ts). A host that embeds the daemon keeps running.
    throw new Error(`cannot resolve the root ${config.root}: ${String(error)}`);
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
  // A development bearer is a credential like any other: it must never reach a log line.
  const devTokens = new Set<string>();
  // Every stored secret value joins the redaction list while the daemon runs.
  const secretValues = new Set<string>();
  const sink = new FileLogSink({ root, minimum: canonical.logLevel });
  const log = new Log(sink.sink, undefined, {
    secrets: () => [
      token,
      gateway?.apiKey ?? "",
      ...providers.secrets(),
      ...triggerTokens,
      ...devTokens,
      ...secretValues,
    ],
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
    }
    // The refusal is a fact about the root, so it is thrown rather than exited: an
    // embedded host learns why, and the process entry turns it into a non-zero exit.
    await sink.close();
    throw error;
  }
  log.emit("info", "core", StartupEvents.singletonOk, { trace: startup });
  // The secrets store (docs/bots/EXTENSIONS-AND-TOOLS.md §6.5): a container that cannot be
  // read is a refusal, not a reset, and it must not keep the daemon from starting. The
  // store records its own failure; here it only decides what the rest of the daemon can do.
  const secretsStore = await SecretsStore.open({
    dir: canonical.secretsDir,
    keyPath: canonical.secretsKeyPath,
    log,
    trace: startup,
    onValues: (values) => {
      secretValues.clear();
      for (const value of values) secretValues.add(value);
    },
  }).catch(() => undefined);
  if (secretsStore !== undefined) {
    for (const value of secretsStore.values()) secretValues.add(value);
    // A daemon that was off for three hours still expires what it should.
    await secretsStore.sweep().catch(() => undefined);
  }
  /** The store behind the card answer; without one a card answer is a refusal. */
  const secretsPort: SecretsPort = {
    save: async (input) => {
      if (secretsStore === undefined) {
        throw new SecretsStorageError("the secrets store could not be read");
      }
      return secretsStore.save(input);
    },
    claimAnswer: async (input) => {
      if (secretsStore === undefined) {
        throw new SecretsStorageError("the secrets store could not be read");
      }
      return secretsStore.claimAnswer(input);
    },
    releaseAnswer: async (input) => {
      if (secretsStore === undefined) return;
      await secretsStore.releaseAnswer(input);
    },
  };
  /** The tools' host for one Bot; a broken store refuses instead of losing the group. */
  const secretsHost = (botId: string): SecretsToolHost => {
    if (secretsStore === undefined) {
      const refuse = (): never => {
        throw new SecretsStorageError("the secrets store could not be read");
      };
      return {
        botId,
        list: refuse,
        read: refuse,
        remove: refuse,
        environment: refuse,
        envNameFor: refuse,
      };
    }
    return secretsStore.hostFor(botId);
  };
  /** The settings page's surface: metadata, and the one route that answers a value. */
  const secretsApi: SecretsApi = {
    list: async (input) => {
      if (secretsStore === undefined) {
        throw new SecretsStorageError("the secrets store could not be read");
      }
      return secretsStore.listAll(input ?? {});
    },
    reveal: async (input) => {
      if (secretsStore === undefined) {
        throw new SecretsStorageError("the secrets store could not be read");
      }
      return secretsStore.reveal(input);
    },
    remove: async (input) => {
      if (secretsStore === undefined) {
        throw new SecretsStorageError("the secrets store could not be read");
      }
      return secretsStore.removeAsPerson(input);
    },
  };
  // The development agent's credential is armed here: the file is read once to say
  // whether it is usable, and again on every authentication, so a rewritten file takes
  // effect at once. Without the environment variable there is no reader at all, and no
  // development token is ever accepted.
  const devToken =
    canonical.devAgentTokenPath === undefined
      ? undefined
      : await armDevToken({
          path: canonical.devAgentTokenPath,
          log,
          trace: startup,
          remember: (devToken) => devTokens.add(devToken),
        });
  const directory = new BotDirectory(root, await nodeDirectoryFs());
  // The stored gateway wins over the dotenv; without either, the registry is empty and a
  // run settles `no_model` until a person configures it in the app.
  gateway = (await readGateway(root)) ?? gatewayFromEnv(process.env);
  // A gateway is usable only when it names an endpoint, a model and a key: a file the
  // 工具 or 技能 page wrote before anyone configured one is not a gateway.
  // The provider id the daemon builds its models and its conversations against. It is
  // fixed for this process's lifetime: a save cannot move it (PROTOCOL.md, "Per-bot
  // agent"), and a machine that boots without a gateway has the same id a save would name.
  const bootProvider = gateway?.provider ?? "magpie";
  const configured = isGatewayComplete(gateway);
  const windowTokens = positiveNumber(process.env.BOTS_CONTEXT_WINDOW, 200_000);
  const maxTokens = positiveNumber(process.env.BOTS_MAX_TOKENS, 8_192);
  // The model registry (docs/bots/RUNTIME.md, "The model registry"): one gateway
  // provider, every model the gateway offers, and the models bots already store.
  const modelRegistry = new ModelRegistry({
    provider: bootProvider,
    baseUrl: gateway?.baseUrl ?? "",
    apiKey: gateway?.apiKey ?? "",
    contextWindow: windowTokens,
    maxTokens,
  });
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
  let noteTraces = 0;
  const runtime = new PiDurableRuntime({
    ...(canonical.deviceSocket === undefined ? {} : { deviceSocket: canonical.deviceSocket }),
    models: () => modelRegistry.models,
    log,
    compaction,
    usage: usageStore,
    corePrompt: () => gateway?.corePrompt,
    machinePrompt: () => machinePrompt(),
    // The App's ticks are the only input: the daemon never scans a folder for skills.
    skills: () => gateway?.skills ?? [],
    search: () => providers.client,
    decision: () => providers.decision,
    trigger: async (spec) =>
      triggerHost(spec.id, await triggerStoreFor(spec.id), async (triggerId) => {
        const queue = queues.get(`${spec.id}/${triggerId}`);
        return queue === undefined ? undefined : (await queue).cursor();
      }),
    pulls: pulls.runtimeHost,
    // The two markdown scopes are the person's own documents: the daemon only reads and
    // rewrites records, and the host binds this bot's file so the model never names one.
    memory: (spec) => fileMemoryHost({ dir: canonical.memoryDir, botId: spec.id }),
    // The secrets: the host binds this bot, so the model never names a bot id and never
    // holds a value.
    secrets: (spec) => secretsHost(spec.id),
    // The tool owns the line; the catalog owns the truth, and the broadcast is how the
    // sidebar sees it without another read. A settled run writes through the same host.
    note: (spec) =>
      createNoteHost({
        botId: spec.id,
        async write(text, expectedRevision, owner) {
          noteTraces += 1;
          const trace = `tr_note_${Date.now().toString(36)}_${noteTraces.toString(36)}`;
          return expectedRevision === undefined
            ? registry.update(spec.id, { note: text }, trace)
            : registry.updateNoteIfRevision(spec.id, text, expectedRevision, trace, owner);
        },
        current: () => registry.noteOf(spec.id),
        changed: () => broadcast?.(),
      }),
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
  const defaultModel = configured
    ? { provider: bootProvider, modelId: gateway?.model ?? "" }
    : canonical.model;
  const registry = new BotRegistry({
    directory,
    openRuntime: (spec) => runtime.open(spec),
    model: defaultModel,
    ...(gateway === undefined
      ? {}
      : { thinkingLevel: gateway.thinkingLevel, toolGroups: gateway.toolGroups }),
    // What the daemon knows about a model decides whether a pair can be recorded.
    agentSupport: (model) => modelRegistry.support(model),
    ensureModel: (modelId) => modelRegistry.ensure([modelId]),
    log,
    idleCloseMs: canonical.idleCloseMs,
    quarantineRetryMs: canonical.quarantineRetryMs,
    closeDeadlineMs: canonical.closeDeadlineMs,
  });
  // Every model a bot stores must be registered before the recovery scan resumes an
  // interrupted run: a recovered generation resolves its model by id.
  const stored = await directory.load().catch(() => []);
  modelRegistry.ensure([defaultModel.modelId, ...stored.map((bot) => bot.model.modelId)]);
  // The catalog is loaded and migrated first, then the gateway's stored settings reach
  // every bot, and only then does the scan resume anything: a recovered run must resolve
  // the provider and the model the catalog now holds.
  await registry.start(async () => {
    if (gateway !== undefined) {
      // The daemon's stored selection governs every bot, including one created before a
      // group existed: a restart applies it once, like saving the settings does.
      await registry.applyToolGroups(gateway.toolGroups, "tr_boot_groups");
      // The provider belongs to the gateway, so every stored reference follows it.
      await registry.applyGatewayProvider(gateway.provider, "tr_boot_provider");
    }
    // Every model a bot stores stays usable, and so does the default a new bot records: a
    // recovered generation resolves its model by id.
    modelRegistry.ensure([
      defaultModel.modelId,
      ...registry.summaries().map((summary) => summary.model.modelId),
    ]);
  });
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
    secrets: secretsPort,
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
  // One save at a time: the second one reads what the first stored, so two pages that
  // save at the same moment cannot drop each other's field.
  let discoveredAt = 0;
  /** The gateway is asked once a minute; a failure keeps what the daemon knows. */
  const discoverModels = async (): Promise<void> => {
    const now = Date.now();
    if (now - discoveredAt < 60_000) return;
    discoveredAt = now;
    await modelRegistry.discover();
  };
  const saveSettings = createSettingsSaver({
    current: () => gateway,
    // The provider id names the runtime the daemon built its models and its conversations
    // against. Moving it under a running daemon would hand every open conversation a
    // provider its Harness has never resolved, so it is a restart, not a save. The address
    // and the key are not: those are the same provider with new coordinates.
    // Boot's provider, not the stored one: a daemon that booted with no gateway still
    // built its runtime against one, so the first save cannot move it either.
    refuse: (next) =>
      next.provider !== bootProvider
        ? `provider 由 ${bootProvider} 改为 ${next.provider} 需要重启 Bot 服务后再保存`
        : undefined,
    write: async (config) => {
      await writeGateway(root, config);
      gateway = config;
    },
    apply: async (config, carried) => {
      // Only what the request carried is applied: the 技能 page must not reset the model,
      // the thinking level or the tool groups the other pages chose.
      if (carried.model && isGatewayComplete(config)) {
        // The endpoint, the key and the provider are global: every bot talks to this
        // gateway from now on. The model id is the default for a new bot; every bot that
        // exists keeps the model it stores.
        modelRegistry.reconfigure({
          provider: config.provider,
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          contextWindow: windowTokens,
          maxTokens,
        });
        registry.setDefaultModel({ provider: config.provider, modelId: config.model });
        modelRegistry.ensure([config.model]);
        await modelRegistry.discover();
        discoveredAt = Date.now();
      }
      if (carried.thinkingLevel) {
        registry.setDefaultThinkingLevel(config.thinkingLevel);
      }
      if (carried.toolGroups) {
        await registry.applyToolGroups(config.toolGroups, "tr_http_settings");
      }
    },
  });
  const settings: GatewayApi = {
    public: () => publicGateway(gateway),
    save: saveSettings,
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
  const catalogDescriptions = describeToolCatalog(createCatalogRegistry());
  const daemon = await startServer({
    ...(canonical.deviceSocket === undefined ? {} : { deviceSocket: canonical.deviceSocket }),
    token,
    clients,
    ...(devToken === undefined ? {} : { devToken }),
    log,
    registry,
    service,
    settings,
    machinePrompt,
    // Built once: the tool surface is fixed at start, and describing it never runs a tool.
    toolCatalog: () => catalogDescriptions,
    triggers: triggerApi,
    secrets: secretsApi,
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
    gatewayProvider: () => bootProvider,
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
      await discoverModels();
      return {
        ids: modelRegistry.ids(),
        details: modelRegistry.metadata(),
        ...(modelRegistry.discoveryError === undefined
          ? {}
          : { error: modelRegistry.discoveryError }),
      };
    },
  });
  broadcast = daemon.broadcastCatalog;
  let closing: Promise<"closed" | "timeout"> | undefined;
  const close = (): Promise<"closed" | "timeout"> => {
    closing ??= (async () => {
      // One absolute deadline for the whole shutdown: a stalled socket grace, handle close
      // or log flush must not add up past the configured budget.
      const budget = canonical.closeDeadlineMs + 1_000;
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), budget);
        timer.unref?.();
      });
      const stopped = (async () => {
        // Producers stop first, then admissions already in flight settle, and only then may
        // the registry close handles under them (TRIGGERS.md §3.6).
        producers.stop();
        await daemon.close();
        await service.drain();
        const released = await registry.shutdown();
        await sink.close();
        if (!released) return "timeout" as const;
        await lock.close();
        return "closed" as const;
      })();
      try {
        return await Promise.race([stopped, deadline]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    })();
    return closing;
  };
  return { config: canonical, port: daemon.port, token, daemon, registry, close };
};

export const createProviderService = async (
  options: { readonly path?: string; readonly fetch?: typeof fetch } = {},
): Promise<
  ProviderApi & {
    readonly client: SearchClient;
    readonly decision: DecisionClient;
    secrets(): readonly string[];
  }
> => {
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
    const definition = selectedProvider(configs, "search");
    if (definition === undefined) throw new Error("请先在服务中选择一个已保存 Key 的搜索服务商。");
    return clientFor(definition);
  };
  const save: ProviderApi["save"] = async (id, input) => {
    const definition = providerDefinition(id);
    if (definition === undefined) return { error: `未知的服务：${id}` };
    if (
      definition.service !== "decision" &&
      (input.baseUrl !== undefined || input.model !== undefined)
    ) {
      return { error: "搜索服务没有可覆盖的地址或模型" };
    }
    const current = configs[id] ?? { apiKey: "", enabled: false };
    const apiKey = input.apiKey === undefined ? current.apiKey : input.apiKey.trim();
    if (
      definition.keyRequired &&
      (input.apiKey !== undefined || input.enabled === true) &&
      apiKey.length === 0
    ) {
      return { error: "请先保存 API Key" };
    }
    const next: { -readonly [K in keyof ProviderConfig]: ProviderConfig[K] } = {
      apiKey,
      enabled: input.enabled ?? current.enabled,
    };
    if (current.baseUrl !== undefined) next.baseUrl = current.baseUrl;
    if (current.model !== undefined) next.model = current.model;
    if (input.baseUrl !== undefined) {
      const typed = input.baseUrl.trim();
      if (typed.length === 0) {
        delete next.baseUrl;
      } else {
        const root = decisionRoot(typed);
        if (root === undefined) return { error: ADDRESS_REFUSED };
        if (root === definition.baseUrl) delete next.baseUrl;
        else next.baseUrl = root;
      }
    }
    if (input.model !== undefined) {
      const model = input.model.trim();
      if (model.length === 0 || model === definition.model) delete next.model;
      else next.model = model;
    }
    const saved = { ...configs, [id]: next };
    if (input.enabled === true) {
      for (const provider of PROVIDERS) {
        if (provider.id === id || provider.service !== definition.service) continue;
        const config = saved[provider.id];
        if (config !== undefined) saved[provider.id] = { ...config, enabled: false };
      }
    }
    await writeProviders(saved, path);
    configs = saved;
    return {
      provider: publicProviders(configs).find((provider) => provider.id === id) as PublicProvider,
    };
  };
  return {
    public: () => publicProviders(configs),
    secrets: () => Object.values(configs).map((config) => config.apiKey),
    // Resolved per call, so a new key or another relay applies to the next judgment. This is the
    // only place a tool reaches a decision provider, and it never falls back to another one.
    decision: {
      ask: async (request, signal) => {
        const definition = selectedProvider(configs, "decision");
        if (definition === undefined) {
          throw new Error("请先在服务中选择一个已保存 Key 的决策服务商。");
        }
        const config = configs[definition.id];
        return systemOne(
          {
            baseUrl: config?.baseUrl ?? definition.baseUrl,
            model: config?.model ?? definition.model,
            apiKey: config?.apiKey ?? "",
          },
          request,
          {
            ...(signal === undefined ? {} : { signal }),
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          },
        );
      },
    } satisfies DecisionClient,
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
      if (definition === undefined) {
        return { ok: false, message: `未知的服务：${id}`, latencyMs: 0 };
      }
      const config = configs[id];
      if (definition.keyRequired && !config?.apiKey.trim()) {
        return { ok: false, message: "还没有保存这个服务的 API Key", latencyMs: 0 };
      }
      if (definition.kind === "systemone") {
        return probeDecision(
          {
            baseUrl: config?.baseUrl ?? definition.baseUrl,
            model: config?.model ?? definition.model,
            apiKey: config?.apiKey ?? "",
          },
          options.fetch === undefined ? {} : { fetch: options.fetch },
        );
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
