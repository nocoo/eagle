// A real loopback daemon over a fake runtime: the transport, close codes and auth are
// properties of a socket, so they are tested on one (docs/bots/TESTING.md).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, type FauxProviderHandle, fauxProvider } from "@earendil-works/pi-ai";
import { WebSocket } from "ws";
import { BotDirectory, nodeDirectoryFs } from "../../src/core/BotDirectory.ts";
import { BotRegistry, type RegistryOptions } from "../../src/core/BotRegistry.ts";
import { ConversationService } from "../../src/core/ConversationService.ts";
import { resolveToolGroups, type TriggerSummary } from "../../src/core/domain.ts";
import { OriginStore, originPath } from "../../src/core/OriginStore.ts";
import { PeerExchangeStore } from "../../src/core/PeerExchangeStore.ts";
import type { RuntimePort } from "../../src/core/RuntimePort.ts";
import { captureLog, type LogRecord } from "../../src/log/log.ts";
import { measureEvent } from "../../src/main.ts";
import { peerApi } from "../../src/peers/api.ts";
import { peerHostFor } from "../../src/peers/host.ts";
import { PiDurableRuntime } from "../../src/runtime/pi/PiDurableRuntime.ts";
import type { GatewayApi } from "../../src/server/gateway.ts";
import type { TriggerApi, TriggerIngress } from "../../src/server/http.ts";
import { startServer } from "../../src/server/http.ts";
import { FakeRuntime, type FakeScript } from "../../src/testing/FakeRuntime.ts";
import type { PeerToolHost } from "../../src/tools/types.ts";

/** A decoded frame: tests read one field at a time, so the shape stays open here. */
export type Frame = Record<string, unknown>;

export type StubBot = { id: string; state: string };

export type Stack = {
  readonly port: number;
  readonly token: string;
  readonly root: string;
  readonly records: LogRecord[];
  /** Present only for a fake stack; a real stack drives the adapter instead. */
  readonly fake: FakeRuntime | undefined;
  /** Present only for a real stack, so a test can script the model. */
  readonly faux: FauxProviderHandle | undefined;
  readonly directory: BotDirectory;
  readonly registry: BotRegistry;
  readonly service: ConversationService;
  readonly daemon: Awaited<ReturnType<typeof startServer>>;
  readonly opens: () => number;
  createBot(title: string): Promise<string>;
  /** Puts a bot id in the quarantined state the transport refuses with 4090. */
  quarantine(botId: string): void;
  connect(options?: { token?: string; headers?: Record<string, string> }): WebSocket;
  /** The peer tools' host for one bot: what a model's peer_send would call. */
  peersFor(botId: string): PeerToolHost;
  close(): Promise<void>;
};

const token = "test-token-0123456789-abcdefghijklmnop";

export type StackOptions = {
  readonly idleCloseMs?: number;
  readonly script?: FakeScript;
  readonly model?: { provider: string; modelId: string };
  /** Run the real pi-durable adapter over real sqlite; only the model network is faked. */
  readonly real?: boolean;
  /** Seeds the root before the catalog is loaded, for a fault the daemon must survive. */
  readonly prepare?: (context: { root: string; directory: BotDirectory }) => Promise<void>;
  /** Reuse a root, so a restart is a restart and not a new daemon on new state. */
  readonly root?: string;
  /** A runtime the test builds itself, for a fault the standard wiring cannot express. */
  readonly runtime?: RuntimePort;
  /** Real-adapter limits: the message projection cap and the snapshot window. */
  readonly maxMessageBytes?: number;
  /** A trigger surface for the HTTP contract; absent means the daemon has no triggers. */
  readonly triggers?: TriggerApi;
  /** The inbound delivery route; absent means a webhook trigger has no endpoint. */
  readonly ingress?: TriggerIngress;
  /** The baseline trigger list a bot's view opens with. */
  readonly triggersOf?: readonly TriggerSummary[];
  readonly windowMessages?: number;
  /** The tool groups every bot of this stack gets; the daemon's defaults when absent. */
  readonly toolGroups?: readonly string[];
  /** Model streaming pace, for a test that has to attach mid-answer. */
  readonly tokensPerSecond?: number;
  /** A runtime whose close never resolves, so the registry times out and quarantines. */
  readonly closeHangs?: boolean;
  readonly closeDeadlineMs?: number;
  /** Gateway settings routes; a test supplies a fake service. */
  readonly settings?: GatewayApi;
};

export const startStack = async (options: StackOptions = {}): Promise<Stack> => {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), "bots-server-")));
  const { log, records } = captureLog();
  const fake =
    options.real === true
      ? undefined
      : new FakeRuntime(options.script === undefined ? {} : { script: options.script });
  let faux: FauxProviderHandle | undefined;
  let model = options.model ?? { provider: "faux", modelId: "faux-1" };
  let openRuntime: RegistryOptions["openRuntime"];
  let readReplicaBinding: RuntimePort["readReplicaBinding"];
  if (options.runtime !== undefined) {
    const runtime = options.runtime;
    openRuntime = (spec) => runtime.open(spec);
    readReplicaBinding = runtime.readReplicaBinding?.bind(runtime);
  } else if (options.real === true) {
    faux = fauxProvider(
      options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond },
    );
    const models = createModels();
    models.setProvider(faux.provider);
    model = options.model ?? {
      provider: faux.getModel().provider,
      modelId: faux.getModel().id,
    };
    const adapter = new PiDurableRuntime({
      models,
      log,
      ...(options.maxMessageBytes === undefined
        ? {}
        : { maxMessageBytes: options.maxMessageBytes }),
      ...(options.windowMessages === undefined ? {} : { windowMessages: options.windowMessages }),
      // The host needs the registry and the service, which exist after the adapter does.
      peers: async (spec) => peersHolder.current?.(spec.id),
    });
    openRuntime = (spec) => adapter.open(spec);
    readReplicaBinding = (spec) => adapter.readReplicaBinding(spec);
  } else {
    const runtime = fake as FakeRuntime;
    openRuntime = (spec) => runtime.open(spec);
  }
  if (options.closeHangs === true) {
    const base = openRuntime;
    openRuntime = async (spec) => {
      const handle = await base(spec);
      // A delegating wrapper: spreading a class instance would lose its methods.
      return {
        refreshTools: (trace) => handle.refreshTools(trace),
        subscribe: (trace, sink) => handle.subscribe(trace, sink),
        submit: (input) => handle.submit(input),
        submission: (key) => handle.submission(key),
        history: (input) => handle.history(input),
        abort: (trace) => handle.abort(trace),
        recover: (trace) => handle.recover(trace),
        busy: () => handle.busy(),
        // The deadline is the handle's own timeout: resolve it as a timeout after the
        // deadline instead of hanging the test forever.
        close: async (_trace: string, deadlineMs: number) => {
          await new Promise<void>((resolve) => setTimeout(resolve, deadlineMs));
          return "timeout" as const;
        },
      };
    };
  }
  const peerStore = new PeerExchangeStore(join(root, "peers"));
  await peerStore.open();
  const peersHolder: { current?: (botId: string) => PeerToolHost } = {};
  const directory = new BotDirectory(root, await nodeDirectoryFs());
  await options.prepare?.({ root, directory });
  let opens = 0;
  const registry = new BotRegistry({
    directory,
    openRuntime: async (spec) => {
      opens += 1;
      return openRuntime(spec);
    },
    ...(readReplicaBinding === undefined ? {} : { readReplicaBinding }),
    model,
    log,
    ...(options.toolGroups === undefined
      ? {}
      : { toolGroups: resolveToolGroups(options.toolGroups) }),
    idleCloseMs: options.idleCloseMs ?? 10 * 60 * 1000,
    quarantineRetryMs: 30_000,
    closeDeadlineMs: options.closeDeadlineMs ?? 500,
    bootTrace: () => "tr_boot_probe",
  });
  await registry.start();
  const quarantined = new Set<string>();
  const registryView = new Proxy(registry, {
    get(target, property) {
      if (property === "state") {
        return (botId: string) => (quarantined.has(botId) ? "quarantined" : target.state(botId));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let broadcast: (() => void) | undefined;
  const service = new ConversationService({
    open: (botId, trace) => registry.open(botId, trace),
    handleOf: (botId) => registry.handleOf(botId),
    settlingOf: (botId) => registry.settling(botId),
    measure: measureEvent,
    log,
    ...(options.triggersOf === undefined
      ? {}
      : { triggersOf: { list: async () => options.triggersOf as readonly TriggerSummary[] } }),
    // The composition root's lease (main.ts does the same), so an invocation without a
    // connection keeps the bot open while it admits.
    lease: {
      acquire: (botId) => registry.touch(botId),
      release: (botId) => registry.release(botId),
    },
    origins: { store: async (botId) => OriginStore.open(originPath(directory.botDir(botId))) },
    onRunning: (botId, running) => {
      if (registry.markRunning(botId, running)) broadcast?.();
    },
    onSessionFailed: (botId, reason, message, dropHandle) => {
      if (registry.markUnavailable(botId, reason, message, { dropHandle })) broadcast?.();
    },
    onRecovered: (botId, running) => {
      // Always push: the client that showed `unavailable` has to see the recovery even
      // when the registry's own state already moved on.
      registry.markRecovered(botId, running);
      broadcast?.();
    },
    ...(options.windowMessages === undefined ? {} : { windowMessages: options.windowMessages }),
  });
  const textOfBlocks = (blocks: readonly { type: string; text?: string }[]): string | undefined => {
    const text = blocks.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
    return text === "" ? undefined : text;
  };
  const peersApi = peerApi({
    store: peerStore,
    bots: () => registry.summaries(),
    submission: (query) => service.submission(query),
    entryText: async (target, entryId) => {
      const message = await registry.handleOf(target)?.entryById?.(entryId);
      return message === undefined ? undefined : textOfBlocks(message.blocks);
    },
  });
  peersHolder.current = (botId) =>
    peerHostFor({
      botId,
      store: peerStore,
      bots: () => registry.summaries(),
      invoke: (input) => service.invoke(input),
      submission: (query) => service.submission(query),
      entryText: async (target, entryId) => {
        const message = await registry.handleOf(target)?.entryById?.(entryId);
        if (message === undefined) return undefined;
        const text = message.blocks
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("");
        return text === "" ? undefined : text;
      },
    });
  const daemon = await startServer({
    token,
    log,
    registry: registryView,
    service,
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    version: "0.0.0-test",
    instance: "i_test",
    capabilities: {
      agent: false,
      tools: true,
      tasks: false,
      entries: false,
      usage: true,
      peers: false,
      triggers: true,
    },
    ...(options.triggers === undefined ? {} : { triggers: options.triggers }),
    peers: peersApi,
    ...(options.ingress === undefined ? {} : { ingress: options.ingress }),
    port: 0,
  });
  broadcast = daemon.broadcastCatalog;
  return {
    port: daemon.port,
    token,
    root,
    records,
    fake,
    faux,
    directory,
    registry,
    service,
    daemon,
    opens: () => opens,
    peersFor: (botId: string) => {
      if (peersHolder.current === undefined) throw new Error("the stack has no peer host yet");
      return peersHolder.current(botId);
    },
    createBot: async (title) => (await registry.create(title, "tr_create_probe")).id,
    quarantine: (botId) => quarantined.add(botId),
    connect: (connectOptions = {}) =>
      new WebSocket(`ws://127.0.0.1:${daemon.port}/v1/socket`, {
        headers: {
          authorization: `Bearer ${connectOptions.token ?? token}`,
          ...connectOptions.headers,
        },
      }),
    close: async () => {
      await daemon.close();
      await registry.shutdown();
      if (options.root === undefined) await rm(root, { recursive: true, force: true });
    },
  };
};

/** A buffered reader: frames that arrive before `next()` is awaited are kept. */
export const frameQueue = (socket: WebSocket) => {
  const buffered: Frame[] = [];
  const waiters: ((frame: Frame) => void)[] = [];
  socket.on("message", (data: { toString(): string }) => {
    const frame = JSON.parse(data.toString()) as Frame;
    const waiter = waiters.shift();
    if (waiter === undefined) buffered.push(frame);
    else waiter(frame);
  });
  return {
    next: (timeoutMs = 5_000): Promise<Frame> => {
      const frame = buffered.shift();
      if (frame !== undefined) return Promise.resolve(frame);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no frame")), timeoutMs);
        waiters.push((value) => {
          clearTimeout(timer);
          resolve(value);
        });
      });
    },
  };
};

/** The next frame as a JSON object, or a rejection when the socket closes first. */
export const nextFrame = (socket: WebSocket): Promise<Frame> =>
  new Promise((resolve, reject) => {
    const onMessage = (data: { toString(): string }) => {
      cleanup();
      resolve(JSON.parse(data.toString()) as Frame);
    };
    const onClose = (code: number) => {
      cleanup();
      reject(new Error(`closed ${code}`));
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.once("message", onMessage);
    socket.once("close", onClose);
  });

/** Resolves with the close code, or rejects when the socket does not close. */
export const closeCode = (socket: WebSocket, timeoutMs = 2_000): Promise<number> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket stayed open")), timeoutMs);
    socket.once("close", (code: number) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

/** Sends one frame once the socket is open. */
export const send = async (socket: WebSocket, frame: unknown): Promise<void> => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(frame));
    return;
  }
  await new Promise<void>((resolve) => socket.once("open", () => resolve()));
  socket.send(JSON.stringify(frame));
};

export const hello = { type: "hello", protocolVersion: 1, client: "BotsTest/0.0.0" };
