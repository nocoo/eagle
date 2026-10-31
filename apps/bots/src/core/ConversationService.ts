// Command routing for the daemon (docs/bots/PLAN.md, rows 17-22): a connection sees one
// bot for its whole life, a subscription renders the first snapshot before it is live,
// and a command either reaches the runtime or is refused before admission.
import { declareEvent } from "../log/events.ts";
import type { Log } from "../log/log.ts";
import type {
  ConversationSnapshot,
  EntryId,
  ErrorDisposition,
  ErrorKind,
  Failure,
  Message,
  PullSummary,
  Submission,
  TriggerSummary,
  Usage,
} from "./domain.ts";
import { ClassifiedFailure } from "./domain.ts";
import { EventHub, type HubSubscriber, type HubSubscription } from "./EventHub.ts";
import { newFailure } from "./failures.ts";
import {
  INVOCATION_ID,
  type Invocation,
  type InvocationPort,
  MAX_INVOCATION_TEXT,
} from "./Invocation.ts";
import type { OriginStore } from "./OriginStore.ts";
import type { RuntimeEvent, RuntimeHandle, RuntimeHistory, SubmitInput } from "./RuntimePort.ts";
import { reduceView, type SubmissionRanks, seedRanks, trimWindow } from "./view.ts";

/** The closed origin set of the invocation port; `unknown` is a reconstruction only. */
const ORIGIN_KINDS = new Set(["human", "schedule", "webhook", "peer", "unknown"]);

const Events = {
  subscribeStart: declareEvent("core.subscribe.start"),
  subscribeOk: declareEvent("core.subscribe.ok"),
  subscribeFail: declareEvent("core.subscribe.fail"),
  resolveFail: declareEvent("core.bot.resolve.fail"),
  submitStart: declareEvent("core.submit.start"),
  submitOk: declareEvent("core.submit.ok"),
  submitFail: declareEvent("core.submit.fail"),
  historyStart: declareEvent("core.history.start"),
  historyOk: declareEvent("core.history.ok"),
  historyFail: declareEvent("core.history.fail"),
} as const;

/** A bot fans out to at most this many connections (PROTOCOL.md, "Limits"). */
export const MAX_SUBSCRIBERS_PER_BOT = 8;
/** Admitted-but-unsettled entries, and the runtime inbox, are both bounded (same table). */
export const MAX_PENDING = 32;
/** A reservation whose events never arrive is released after this window. */
export const RESERVATION_TTL_MS = 60_000;
export const MAX_INBOX = 32;
/** The newest page a snapshot carries; older messages are reachable through `history`. */
export const MAX_WINDOW_MESSAGES = 200;
/** PROTOCOL.md, "Limits": a page frame is at most this many encoded bytes. */
export const MAX_PAGE_BYTES = 192 * 1024;

/** Opens (or recovers) one bot. The registry owns catalog policy; the service owns routing. */
export type OpenBot = (botId: string, trace: string) => Promise<RuntimeHandle>;

export type ConversationServiceOptions = {
  readonly open: OpenBot;
  /** The handle the registry owns right now; a cached bot whose handle was closed is stale. */
  readonly handleOf?: (botId: string) => RuntimeHandle | undefined;
  /** True while a close or delete owns the bot, so a cached view may be about to die. */
  readonly settlingOf?: (botId: string) => boolean;
  /** Wall clock for the reservation TTL. */
  readonly now?: () => number;
  /** Encoded bytes of one event, measured by the transport (see EventHub). */
  readonly measure: (event: RuntimeEvent) => number;
  readonly schedule?: (run: () => void) => void;
  /** Every crossing is recorded; the service owns the core outcome of its commands. */
  readonly log?: Log;
  /** Newest messages kept in a rendered snapshot (PROTOCOL.md, "snapshot.messages page"). */
  readonly windowMessages?: number;
  /** The bot started or stopped working, so the catalog state can follow the run. */
  readonly onRunning?: (botId: string, running: boolean) => void;
  /** The runtime reported a failure the view can no longer serve. */
  readonly onSessionFailed?: (
    botId: string,
    reason: ErrorKind,
    message: string,
    dropHandle: boolean,
  ) => void;
  /** `recover` brought the bot back, so the catalog may leave `unavailable`. */
  readonly onRecovered?: (botId: string, running: boolean) => void;
  /** A conversation reported its cumulative spend, for the usage statistics. */
  readonly onUsage?: (botId: string, usage: Usage) => void;
  /**
   * The registry's lease, so an invocation without a connection keeps a bot open and still
   * lets it idle-close. `acquire` answers false for an unknown, deleting or quarantined bot.
   */
  readonly lease?: {
    readonly acquire: (botId: string) => boolean;
    readonly release: (botId: string) => void;
  };
  /**
   * The bot's triggers, read when its view opens (docs/bots/TRIGGERS.md §8). Absent means
   * the daemon has no trigger storage; every existing path still works.
   */
  readonly triggersOf?: {
    readonly list: (botId: string) => Promise<readonly TriggerSummary[]>;
  };
  /**
   * The bot's reported pull requests, read when its view opens. Absent means no coding
   * reports are stored; every existing path still works.
   */
  readonly pullsOf?: {
    readonly list: (botId: string) => Promise<readonly PullSummary[]>;
  };
  /**
   * The per-bot origin record (docs/bots/TRIGGERS.md §6). Absent means the daemon does not
   * label admissions, which is the phase-1 behavior; every caller still works.
   */
  readonly origins?: {
    readonly store: (botId: string) => Promise<OriginStore | undefined>;
  };
};

/** Only `not_admitted` lets a client drop its outbox entry (docs/bots/PROTOCOL.md). */
export class CommandError extends ClassifiedFailure {
  readonly kind: ErrorKind;
  readonly requestId: string | undefined;

  constructor(
    failure: Failure,
    disposition: ErrorDisposition,
    message: string,
    requestId?: string,
    options?: { cause?: unknown },
  ) {
    super(failure, disposition, message, options);
    this.name = "CommandError";
    this.kind = failure.kind;
    this.requestId = requestId;
  }
}

type Bot = {
  readonly contexts: Map<string, { ready: Promise<Bot>; view?: Bot }>;
  scopeRoot: Bot | undefined;
  contextId: string | undefined;
  /** Absent while the bot is unavailable: the view still renders, the run cannot. */
  handle: RuntimeHandle | undefined;
  degraded: { readonly reason: ErrorKind; readonly message: string } | undefined;
  readonly hub: EventHub;
  snapshot: ConversationSnapshot;
  readonly ranks: SubmissionRanks;
  /** Admissions in flight, keyed by request id, with the time the reservation was made. */
  readonly reserved: Map<string, number>;
  /** Detaches the runtime subscription this bot holds, when it has one. */
  detach: (() => void) | undefined;
  /** Publishes what the runtime delivered while the first subscription was rendering. */
  readonly release: () => void;
  /** Where this bot's admission origins are read and written, when the daemon records them. */
  origins: OriginStore | undefined;
};

type Connection = {
  readonly botId: string;
  readonly contextId?: string;
  state: "pending" | "live" | "closed";
  bot: Bot | undefined;
  hub: HubSubscription | undefined;
};

type FailEvent =
  | typeof Events.subscribeFail
  | typeof Events.submitFail
  | typeof Events.historyFail
  | typeof Events.resolveFail;

export class ConversationService implements InvocationPort {
  readonly #open: OpenBot;
  readonly #handleOf: ((botId: string) => RuntimeHandle | undefined) | undefined;
  readonly #settlingOf: ((botId: string) => boolean) | undefined;
  readonly #now: () => number;
  readonly #hubOptions: {
    readonly measure: (event: RuntimeEvent) => number;
    readonly schedule?: (run: () => void) => void;
    readonly log?: Log;
  };
  readonly #log: Log | undefined;
  readonly #window: number;
  readonly #onRunning: ((botId: string, running: boolean) => void) | undefined;
  readonly #onSessionFailed:
    | ((botId: string, reason: ErrorKind, message: string, dropHandle: boolean) => void)
    | undefined;
  readonly #onRecovered: ((botId: string, running: boolean) => void) | undefined;
  readonly #onUsage: ((botId: string, usage: Usage) => void) | undefined;
  readonly #lease: ConversationServiceOptions["lease"];
  readonly #origins: ConversationServiceOptions["origins"];
  readonly #triggersOf: ConversationServiceOptions["triggersOf"];
  readonly #pullsOf: ConversationServiceOptions["pullsOf"];
  /** Resolved views by bot id, so `observe` can answer synchronously without opening. */
  readonly #current = new Map<string, Bot>();
  /** Invocation observers, keyed by bot id and bound to the value, not to one Bot object. */
  readonly #observers = new Map<string, Set<(running: boolean) => void>>();
  /** Admissions in flight across every bot: `drain` waits for them before shutdown. */
  #admitting = 0;
  #draining = false;
  readonly #idle: (() => void)[] = [];
  /** Per-bot admission serialization: check-then-submit is one serial section. */
  readonly #admissions = new Map<string, Promise<unknown>>();
  /** Per-bot view serialization: subscribe and recover never rebuild one view twice. */
  readonly #views = new Map<string, Promise<unknown>>();
  /** A bot whose recovery snapshot is being published: a second degrade waits for it. */
  readonly #refreshing = new Set<string>();
  /** The view currently attached per bot, so a degraded subscriber can be refreshed. */
  readonly #live = new Map<string, Bot>();
  /** Failure ids this service minted: only those may be recorded as an origin here. */
  readonly #minted = new Set<string>();
  readonly #bots = new Map<string, Promise<Bot>>();
  readonly #connections = new Map<string, Connection>();

  constructor(options: ConversationServiceOptions) {
    this.#open = options.open;
    this.#handleOf = options.handleOf;
    this.#settlingOf = options.settlingOf;
    this.#now = options.now ?? Date.now;
    this.#log = options.log;
    this.#window = options.windowMessages ?? MAX_WINDOW_MESSAGES;
    this.#onRunning = options.onRunning;
    this.#onSessionFailed = options.onSessionFailed;
    this.#onRecovered = options.onRecovered;
    this.#onUsage = options.onUsage;
    this.#lease = options.lease;
    this.#origins = options.origins;
    this.#triggersOf = options.triggersOf;
    this.#pullsOf = options.pullsOf;
    this.#hubOptions = {
      measure: options.measure,
      ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
      ...(options.log === undefined ? {} : { log: options.log }),
    };
  }

  /**
   * Opens the bot, renders its current view as the connection's baseline, then goes live.
   * Pending deltas are flushed first and the baseline's own revision is captured, so the
   * first frame a client sees is the snapshot it is told about.
   */
  async subscribe(
    connectionId: string,
    botId: string,
    trace: string,
    sink: HubSubscriber,
    contextId?: string,
  ): Promise<{ readonly rev: number; readonly snapshot: ConversationSnapshot }> {
    this.#log?.emit("info", "core", Events.subscribeStart, {
      trace,
      botId,
      connId: connectionId,
    });
    if (this.#connections.has(connectionId)) {
      throw this.#refuseSubscribed(trace, botId, connectionId);
    }
    // Reserve the id before opening, so a concurrent subscribe or a disconnect during the
    // open cannot slip past the one-bot-per-connection rule.
    const connection: Connection = {
      botId,
      ...(contextId === undefined ? {} : { contextId }),
      state: "pending",
      bot: undefined,
      hub: undefined,
    };
    this.#connections.set(connectionId, connection);
    let bot: Bot;
    try {
      bot = await this.#serializeView(botId, async () => {
        const current = await this.#bot(botId, trace, contextId);
        await current.handle?.refreshTools(trace);
        return current;
      });
    } catch (error) {
      if (this.#connections.get(connectionId) === connection)
        this.#connections.delete(connectionId);
      this.#record(Events.subscribeFail, trace, botId, connectionId, error);
      throw error;
    }
    if (connection.state !== "pending") {
      throw this.#cancelled(Events.subscribeFail, trace, botId, connectionId);
    }
    if (
      [...this.#connections.values()].filter(
        (item) => item.botId === botId && item.state === "live",
      ).length >= MAX_SUBSCRIBERS_PER_BOT
    ) {
      // Refused, not closed: the connection can still be used for a different bot.
      this.#connections.delete(connectionId);
      throw this.#refuseWith(
        Events.subscribeFail,
        trace,
        botId,
        connectionId,
        "limit_exceeded",
        "not_admitted",
        "this bot already has the maximum number of subscribers",
      );
    }
    bot.hub.drain();
    // A sink drained by the flush can disconnect this connection; only a connection that
    // is still pending may be attached.
    if (this.#connections.get(connectionId) !== connection || connection.state !== "pending") {
      throw this.#cancelled(Events.subscribeFail, trace, botId, connectionId);
    }
    const snapshot = bot.snapshot;
    let baseline: number | undefined;
    connection.hub = bot.hub.subscribe((event) => {
      // Frames published before the baseline belong to no client yet: the snapshot that
      // follows already contains their effect, so delivering them first would break the
      // first-frame rule and the baseline revision.
      if (baseline === undefined) {
        if (event.type !== "snapshot") return;
        baseline = event.rev;
      }
      sink(event);
    });
    connection.bot = bot;
    connection.state = "live";
    bot.hub.publishSnapshot(snapshot, trace);
    // Deliver inside this call: a commit published from the baseline callback is part of
    // the same subscription, and a caller that awaits `subscribe` has seen everything.
    bot.hub.drain();
    // A bot whose baseline is already running is running, not idle. The catalog event
    // follows the baseline, so the first frame a client sees is still the snapshot.
    this.#emitRunning(snapshot.botId, snapshot.running);
    if (baseline === undefined) {
      throw this.#cancelled(Events.subscribeFail, trace, botId, connectionId);
    }
    this.#log?.emit("info", "core", Events.subscribeOk, {
      trace,
      botId,
      connId: connectionId,
      rev: baseline,
      detail: { count: bot.hub.subscriberCount },
    });
    return { rev: baseline, snapshot };
  }

  /** Ends a connection's subscription. The bot stays open for the registry to reclaim. */
  unsubscribe(connectionId: string): void {
    const connection = this.#connections.get(connectionId);
    if (connection === undefined) return;
    connection.state = "closed";
    connection.hub?.detach();
    this.#connections.delete(connectionId);
    if (connection.bot !== undefined) this.#pruneContext(connection.bot);
  }

  /**
   * A duplicate `requestId` answers from the stored record without touching the runtime,
   * which is how a lost reply is recovered. The reply is connection-scoped: it carries no
   * revision, and settlements reach everyone through the hub instead.
   */
  async send(connectionId: string, input: SubmitInput): Promise<Submission> {
    // The connection owns the subscription, so it names the bot: the view's own id is the
    // runtime's answer, not the identity a command must address.
    let botId: string;
    try {
      this.#botOf(connectionId, input.requestId);
      botId = this.#connectionBot(connectionId) as string;
      if (this.#connections.get(connectionId)?.contextId !== input.contextId)
        throw this.#refuse("the send context differs from the subscription", input.requestId);
    } catch (error) {
      this.#record(
        Events.submitFail,
        input.trace,
        this.#connectionBot(connectionId),
        connectionId,
        error,
        input.requestId,
      );
      throw error;
    }
    return this.#admitAndLog({ ...input, botId, origin: { kind: "human" } }, connectionId);
  }

  /**
   * Admit work on behalf of a caller with no connection (docs/bots/TRIGGERS.md §3). The
   * port is idempotent by `(botId, requestId)`, opens a cold bot, and never waits for an
   * answer; queueing, batching and timing stay with the caller.
   */
  async invoke(input: Invocation): Promise<Submission> {
    return this.#admitAndLog(input, undefined);
  }

  /** Durable by `requestId` once the runtime adapter reads its own storage (§3.2). */
  async submission(query: {
    readonly botId: string;
    readonly requestId: string;
    readonly contextId?: string;
  }): Promise<Submission | undefined> {
    const bot = await this.#bot(query.botId, query.requestId, query.contextId);
    return bot.handle?.submission({ requestId: query.requestId });
  }

  /**
   * The bot's run state for a caller with no connection. Attach reports the current value
   * and then every transition, so a caller waits on an edge instead of polling; an
   * unopened bot reports `false` and is not opened by observing it.
   */
  observe(botId: string, sink: (running: boolean) => void): { detach(): void } {
    const observers = this.#observers.get(botId) ?? new Set<(running: boolean) => void>();
    this.#observers.set(botId, observers);
    observers.add(sink);
    const current = this.#current.get(botId);
    sink(current !== undefined && this.#allViews(current).some((item) => item.snapshot.running));
    return {
      detach: () => {
        observers.delete(sink);
        if (observers.size === 0 && this.#observers.get(botId) === observers) {
          this.#observers.delete(botId);
        }
      },
    };
  }

  /**
   * Stops accepting admissions and waits for the ones already in flight, so shutdown can
   * close bots without racing a submit (docs/bots/TRIGGERS.md §3.6).
   */
  async drain(): Promise<void> {
    this.#draining = true;
    if (this.#admitting === 0) return;
    await new Promise<void>((resolve) => this.#idle.push(resolve));
  }

  /** One admission path for a connection and for a port caller; logging keeps the connId. */
  async #admitAndLog(input: Invocation, connId: string | undefined): Promise<Submission> {
    const botId = input.botId;
    const withConn = connId === undefined ? {} : { connId };
    this.#log?.emit("info", "core", Events.submitStart, {
      trace: input.trace,
      botId,
      ...withConn,
      reqId: input.requestId,
    });
    let leased = false;
    this.#admitting += 1;
    try {
      this.#assertInvocation(input);
      if (this.#lease !== undefined) {
        if (!this.#lease.acquire(botId)) {
          throw new CommandError(
            this.#mint("unknown_bot"),
            "not_admitted",
            "the bot cannot be admitted right now",
            input.requestId,
          );
        }
        leased = true;
      }
      // Write-ahead: the label must exist before the entry does, or a restart would leave
      // a message whose cause is unknown forever (TRIGGERS.md §6.2).
      await this.#recordOrigin(botId, input);
      const record = await this.#admit(botId, {
        requestId: input.requestId,
        text: input.text,
        ...(input.contextId === undefined ? {} : { contextId: input.contextId }),
        ...(input.resourceHead === undefined ? {} : { resourceHead: input.resourceHead }),
        whenBusy: input.whenBusy ?? "followUp",
        trace: input.trace,
      });
      this.#log?.emit("info", "core", Events.submitOk, {
        trace: input.trace,
        botId,
        ...withConn,
        reqId: input.requestId,
        detail: { queued: record.status === "queued", count: 1 },
      });
      return record;
    } catch (error) {
      this.#record(Events.submitFail, input.trace, botId, connId, error, input.requestId);
      throw error;
    } finally {
      if (leased) this.#lease?.release(botId);
      this.#admitting -= 1;
      if (this.#admitting === 0) for (const resolve of this.#idle.splice(0)) resolve();
    }
  }

  /**
   * Replaces the bot's trigger list and tells its subscribers. Called by whoever owns the
   * store after a mutation, so a sidebar follows a model's own edit (TRIGGERS.md §8.3).
   */
  /** A reported pull request reaches every open view, exactly as a trigger list does. */
  publishPulls(
    botId: string,
    pulls: readonly PullSummary[],
    trace = `tr_pulls_${Date.now().toString(36)}`,
  ): void {
    const bot = this.#current.get(botId);
    if (bot === undefined) return;
    bot.snapshot = { ...bot.snapshot, pulls };
    bot.hub.publish({ type: "pulls", trace, pulls });
  }

  publishTriggers(botId: string, triggers: readonly TriggerSummary[], trace: string): void {
    const bot = this.#current.get(botId);
    if (bot === undefined) return;
    bot.snapshot = { ...bot.snapshot, triggers };
    bot.hub.publish({ type: "triggers", trace, triggers });
  }

  /** A broken sidecar must not make a bot unusable: its labels fall back to `unknown`. */
  async #openOrigins(botId: string, trace: string): Promise<OriginStore | undefined> {
    void trace;
    if (this.#origins === undefined) return undefined;
    return this.#origins.store(botId).catch(() => undefined);
  }

  /** The bot's origin record, loaded once per bot and cached on its view. */
  async #originsFor(botId: string): Promise<OriginStore | undefined> {
    if (this.#origins === undefined) return undefined;
    const bot = await this.#bot(botId, "tr_origin_load_0001");
    return bot.origins;
  }

  /** A failed origin write refuses the admission: an unlabeled entry is worse than none. */
  async #recordOrigin(botId: string, input: Invocation): Promise<void> {
    if (this.#origins === undefined) return;
    const store = await this.#originsFor(botId);
    if (store === undefined) return;
    try {
      await store.record({ requestId: input.requestId, origin: input.origin });
    } catch (cause) {
      throw new CommandError(
        this.#mint("storage_failed"),
        "runtime",
        "the admission origin could not be recorded",
        input.requestId,
        { cause },
      );
    }
  }

  /** Attaches the recorded origin, by entry id and then by request id (TRIGGERS.md §6.2). */
  #withOrigin(message: Message, store: OriginStore | undefined): Message {
    if (store === undefined || message.role !== "user") return message;
    const origin = store.originOf(message);
    return origin === undefined ? message : { ...message, origin };
  }

  #withOrigins(view: ConversationSnapshot, store: OriginStore | undefined): ConversationSnapshot {
    if (store === undefined) return view;
    let changed = false;
    const messages = view.messages.map((message) => {
      const next = this.#withOrigin(message, store);
      if (next !== message) changed = true;
      return next;
    });
    return changed ? { ...view, messages } : view;
  }

  /** Refuses what can never be admitted before any runtime call: the key alphabet and the
   * send budget mirror the wire contract, and a non-human caller may not interrupt a run.
   */
  #assertInvocation(input: Invocation): void {
    if (this.#draining) {
      throw new CommandError(
        this.#mint("internal"),
        "not_admitted",
        "the daemon is shutting down",
        input.requestId,
      );
    }
    if (!INVOCATION_ID.test(input.requestId)) {
      throw this.#refuse("the request id is malformed", input.requestId);
    }
    if (input.resourceHead !== undefined && !/^[a-f0-9]{64}$/.test(input.resourceHead))
      throw this.#refuse("the resource head is malformed", input.requestId);
    if (input.contextId !== undefined && !INVOCATION_ID.test(input.contextId))
      throw this.#refuse("the context id is malformed", input.requestId);
    if (Array.from(input.text).length > MAX_INVOCATION_TEXT) {
      throw this.#refuse(`text exceeds ${MAX_INVOCATION_TEXT} characters`, input.requestId);
    }
    if (!ORIGIN_KINDS.has(input.origin?.kind as string)) {
      throw this.#refuse("the invocation origin is unknown", input.requestId);
    }
    if (input.whenBusy === "steer" && input.origin.kind !== "human") {
      throw this.#refuse("only a person may steer a running answer", input.requestId);
    }
  }

  /** `abort` withdraws the running input and everything queued behind it. */
  async abort(connectionId: string, trace: string): Promise<void> {
    await this.#handle(connectionId).abort(trace);
  }

  /**
   * `recover` never aborts a healthy answer: an unavailable bot is opened again and the
   * connection is handed the new view, a parked task is retried, a healthy bot answers
   * with its snapshot.
   */
  async recover(connectionId: string, trace: string): Promise<void> {
    const connection = this.#connections.get(connectionId);
    if (connection === undefined || connection.state !== "live" || connection.bot === undefined) {
      throw this.#refuse("the connection has no subscription");
    }
    const bot = connection.bot;
    // Concurrent recovers must not attach a second watch to one handle: one serial
    // section per bot re-checks the state it saw before it acts.
    await this.#serializeView(bot.snapshot.botId, async () => {
      const botId = bot.snapshot.botId;
      const leased = this.#lease?.acquire(botId);
      if (leased === false)
        throw this.#refuseWith(
          Events.resolveFail,
          trace,
          botId,
          connectionId,
          "unknown_bot",
          "not_admitted",
          "the bot cannot recover right now",
        );
      try {
        if (bot.degraded !== undefined && bot.handle === undefined) {
          const rebuilt = await this.#reopen(bot, connection.botId, trace);
          // The snapshot first, then the catalog: a client learns the recovery from the
          // frame that carries its content (PROTOCOL I1/I3).
          bot.hub.publishSnapshot(rebuilt, trace);
          bot.hub.drain();
          // A second failure during the recovery must leave the catalog unavailable.
          if (bot.degraded === undefined) {
            this.#onRecovered?.(bot.snapshot.botId, rebuilt.running);
          }
          return;
        }
        // A degraded-but-owned bot still has its handle: recover must ask that owner.
        const handle = bot.handle ?? this.#handle(connectionId);
        await handle.recover(trace);
        if (bot.degraded !== undefined) {
          // The harness survived; its watch was re-attached by the runtime. Re-render from
          // the same owner rather than opening a second Harness over one sqlite file.
          bot.detach?.();
          const attached = await this.#attach(handle, bot.hub, trace, bot);
          attached.release();
          if (bot.degraded === undefined) {
            this.#onRecovered?.(bot.snapshot.botId, bot.snapshot.running);
          }
        }
        // The retry ran: the snapshot no longer asks for one.
        const { parked: _parked, ...rest } = bot.snapshot;
        bot.snapshot = rest;
        bot.hub.publishSnapshot(bot.snapshot, trace);
      } finally {
        if (leased === true) this.#lease?.release(botId);
      }
    });
  }

  /** Re-opens an unavailable bot and adopts the new handle in place, so the hub survives. */
  async #reopen(bot: Bot, botId: string, trace: string): Promise<ConversationSnapshot> {
    // The dead handle's watch is gone with it; keep the view, replace the runtime behind it.
    bot.detach?.();
    const owner = await this.#open(botId, trace);
    const handle =
      bot.contextId === undefined ? owner : await owner.context?.(bot.contextId, trace);
    if (handle === undefined) throw this.#refuse("runtime has no contexts");
    // Attached onto the same object: the event closure, the connection and the cache all
    // keep pointing at one view, and the hub keeps its subscribers.
    const attached = await this.#attach(handle, bot.hub, trace, bot);
    attached.release();
    this.#emitRunning(bot.snapshot.botId, bot.snapshot.running);
    return bot.snapshot;
  }

  /** Older messages, oldest first. The newest window is not re-fetched. */
  async history(
    connectionId: string,
    input: { readonly beforeEntryId?: EntryId; readonly limit: number },
    trace: string,
  ): Promise<RuntimeHistory> {
    const botId = this.#subscribed(connectionId);
    this.#log?.emit("info", "core", Events.historyStart, {
      trace,
      botId,
      connId: connectionId,
    });
    try {
      const page = await this.#handle(connectionId).history({ ...input, trace });
      // A page is bounded by count and encoded bytes. The page must stay contiguous with
      // the cursor, so the *newest* messages are kept and the older ones come next time.
      const kept: Message[] = [];
      let bytes = 0;
      for (let index = page.messages.length - 1; index >= 0; index -= 1) {
        const raw = page.messages[index];
        if (raw === undefined) break;
        const message = this.#withOrigin(raw, this.#current.get(botId)?.origins);
        const size = this.#measureMessage(message);
        if (kept.length >= MAX_WINDOW_MESSAGES || bytes + size > MAX_PAGE_BYTES) break;
        kept.push(message);
        bytes += size;
      }
      const messages = kept.reverse();
      const bounded = {
        messages,
        hasMore: page.hasMore || messages.length < page.messages.length,
      };
      this.#log?.emit("info", "core", Events.historyOk, {
        trace,
        botId,
        connId: connectionId,
        detail: { count: bounded.messages.length },
      });
      return bounded;
    } catch (error) {
      if (error instanceof ClassifiedFailure) {
        this.#record(Events.historyFail, trace, botId, connectionId, error);
        throw error;
      }
      const failure = this.#mint("storage_failed");
      const classified = new ClassifiedFailure(failure, "runtime", "the page could not be read", {
        cause: error,
      });
      this.#record(Events.historyFail, trace, botId, connectionId, classified);
      throw classified;
    }
  }

  /**
   * Answers by broadcasting a snapshot of the current view on this connection. The
   * broadcast is the only reply: the caller must not write a second frame for it, or a
   * later increment could be followed by this older snapshot. The event carries the
   * command's trace and a revision that names exactly its content, because pending
   * deltas are folded in first.
   */
  resync(connectionId: string, trace: string): void {
    const bot = this.#botOf(connectionId);
    bot.hub.publishSnapshot(bot.snapshot, trace);
  }

  /**
   * Read-then-submit as one serial section per bot: a stored record answers a retry
   * without admitting anything new, and the budget check cannot interleave with another
   * admission. A reservation is held until that submission's own event arrives, because
   * the view only learns about the work after the runtime commits it.
   */
  async #admit(botId: string, input: SubmitInput): Promise<Submission> {
    // A port caller may be the first thing to touch this bot: open (and recover) it here,
    // outside the serial section, so an unavailable bot still answers with its view.
    await this.#bot(botId, input.requestId, input.contextId);
    return this.#serialize(botId, async () => {
      const bot = await this.#bot(botId, input.requestId, input.contextId);
      const handle = this.#handleOfBot(bot, input.requestId);
      let stored: Submission | undefined;
      try {
        stored = await handle.submission({
          requestId: input.requestId,
          retry: { whenBusy: input.whenBusy, trace: input.trace },
        });
      } catch (cause) {
        if (cause instanceof ClassifiedFailure) throw cause;
        throw new CommandError(
          this.#mint("internal"),
          "unknown",
          "the submission record could not be read",
          input.requestId,
          { cause },
        );
      }
      if (stored !== undefined) {
        // A terminal record settles its reservation; a queued one is still outstanding, and
        // only the view's pending list may count it.
        if (stored.status === "done" || stored.status === "unanswered") {
          bot.reserved.delete(input.requestId);
        }
        return input.resourceHead === undefined && input.contextId === undefined
          ? stored
          : handle.submit(input);
      }
      // A reservation already visible as pending is the same admission, not a second one.
      // An expired one is released only after the runtime says it is not outstanding:
      // time alone is not evidence that an admission ended.
      const now = this.#now();
      for (const [requestId, at] of [...bot.reserved]) {
        if (now - at <= RESERVATION_TTL_MS) continue;
        let record: Submission | undefined;
        try {
          record = await handle.submission({ requestId });
        } catch {
          // An unreadable status is not evidence that the admission ended: keep the slot
          // and check again later.
          bot.reserved.set(requestId, now);
          continue;
        }
        if (record === undefined || record.status === "done" || record.status === "unanswered") {
          bot.reserved.delete(requestId);
        } else {
          // Still queued or placed: it owns its slot, so the clock restarts.
          bot.reserved.set(requestId, now);
        }
      }
      const root = bot.scopeRoot ?? bot;
      const views = this.#allViews(root);
      // Views are projections, not the durable admission catalog: a cold context need not
      // have a view. Union its persisted records with reservations whose commit is unknown.
      const durable = (await this.#handleOfBot(root).outstanding?.(input.trace)) ?? [];
      const pending = new Set(
        durable.map((record) => record.requestId || `submission:${record.id}`),
      );
      const inbox = new Set(
        durable.filter((record) => record.status === "queued").map((record) => record.id),
      );
      for (const view of views) {
        for (const record of view.snapshot.pending)
          pending.add(record.requestId || `submission:${record.id}`);
        for (const requestId of view.reserved.keys()) pending.add(requestId);
        for (const item of view.snapshot.inbox) inbox.add(item.id);
      }
      if (pending.size >= MAX_PENDING || inbox.size >= MAX_INBOX) {
        throw new CommandError(
          this.#mint("limit_exceeded"),
          "not_admitted",
          "the bot has no room for another admission",
          input.requestId,
        );
      }
      bot.reserved.set(input.requestId, this.#now());
      try {
        // The bot can become unavailable while the record lookup awaited: the handle this
        // section captured may be dead by now, so availability is re-checked here.
        const live = await this.#bot(botId, input.requestId, input.contextId);
        if (live.degraded !== undefined || live.handle !== handle) {
          bot.reserved.delete(input.requestId);
          throw new CommandError(
            this.#mint(live.degraded?.reason ?? "storage_failed"),
            "runtime",
            "the bot is unavailable; recover it first",
            input.requestId,
          );
        }
        const record = await handle.submit(input);
        if (record.status === "done" || record.status === "unanswered") {
          bot.reserved.delete(input.requestId);
        }
        return record;
      } catch (cause) {
        // A refusal is known not to be admitted, so its slot is free again. An "unknown"
        // disposition may still have been admitted: the slot stays reserved until the
        // retry of the same requestId resolves it.
        const known =
          cause instanceof ClassifiedFailure &&
          (cause.disposition === "not_admitted" || cause.disposition === "runtime");
        if (known) bot.reserved.delete(input.requestId);
        // A failure the runtime already classified keeps its identity and disposition;
        // only an unclassified one becomes "admission unconfirmed", where the client
        // keeps its outbox entry and retries with the same requestId.
        if (cause instanceof ClassifiedFailure) throw cause;
        throw new CommandError(
          this.#mint("internal"),
          "unknown",
          "admission could not be confirmed",
          input.requestId,
          { cause },
        );
      }
    });
  }

  /** One bot's admissions never interleave, so a budget check is atomic with its submit. */
  #serialize<T>(botId: string, run: () => Promise<T>): Promise<T> {
    return this.#chain(this.#admissions, botId, run);
  }

  #serializeView<T>(botId: string, run: () => Promise<T>): Promise<T> {
    return this.#chain(this.#views, botId, run);
  }

  #chain<T>(
    chains: Map<string, Promise<unknown>>,
    botId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const previous = chains.get(botId) ?? Promise.resolve();
    const next = previous.then(run, run);
    chains.set(
      botId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /** Trims a page against the whole snapshot frame, envelope and state included. */
  #fitPage(view: ConversationSnapshot): ConversationSnapshot {
    const overhead = this.#hubOptions.measure({
      type: "snapshot",
      trace: "tr_measure",
      value: { ...view, messages: [] },
    });
    return trimWindow(
      view,
      this.#window,
      this.#measureMessage,
      Math.max(0, MAX_PAGE_BYTES - overhead),
    );
  }

  /** Encoded bytes of one message in the frame a client would receive it in. */
  #measureMessage = (message: ConversationSnapshot["messages"][number]): number =>
    this.#hubOptions.measure({ type: "append", trace: "tr_measure", message });

  /** One failure episode, one error record: only a failure minted here is an origin. */
  #record(
    evt: FailEvent,
    trace: string,
    botId: string | undefined,
    connectionId: string | undefined,
    error: unknown,
    requestId?: string,
  ): void {
    const classified = error instanceof ClassifiedFailure ? error : undefined;
    const failure = classified?.failure ?? this.#mint("internal");
    const own = this.#minted.has(failure.id);
    this.#log?.emit(own ? "error" : "warn", "core", evt, {
      trace,
      ...(botId === undefined ? {} : { botId }),
      ...(connectionId === undefined ? {} : { connId: connectionId }),
      ...(requestId === undefined ? {} : { reqId: requestId }),
      failure,
      ...(own ? { origin: true as const } : { propagated: true }),
    });
  }

  /** One place publishes a run-state change: the catalog and every invocation observer. */
  #emitRunning(botId: string, running: boolean): void {
    const current = this.#current.get(botId);
    if (current !== undefined)
      running = this.#allViews(current).some((item) => item.snapshot.running);
    this.#onRunning?.(botId, running);
    for (const sink of [...(this.#observers.get(botId) ?? [])]) sink(running);
  }

  /** A failure this service owns: minted once, recorded once, carried unchanged. */
  #mint(kind: ErrorKind): Failure {
    const minted = newFailure(kind, "core");
    this.#minted.add(minted.id);
    return minted;
  }

  #refuse(message: string, requestId?: string): CommandError {
    return new CommandError(this.#mint("invalid_command"), "not_admitted", message, requestId);
  }

  /** A refusal the service mints: recorded at error, because core is its origin. */
  #refuseWith(
    evt: FailEvent,
    trace: string,
    botId: string,
    connectionId: string,
    kind: ErrorKind,
    disposition: ErrorDisposition,
    message: string,
    requestId?: string,
  ): CommandError {
    const failure = this.#mint(kind);
    this.#record(
      evt,
      trace,
      botId,
      connectionId,
      new ClassifiedFailure(failure, disposition, message),
      requestId,
    );
    return new CommandError(failure, disposition, message, requestId);
  }

  #refuseSubscribed(trace: string, botId: string, connectionId: string): CommandError {
    return this.#refuseWith(
      Events.subscribeFail,
      trace,
      botId,
      connectionId,
      "invalid_command",
      "not_admitted",
      "a connection subscribes to one bot for its whole life",
    );
  }

  #cancelled(evt: FailEvent, trace: string, botId: string, connectionId: string): CommandError {
    return this.#refuseWith(
      evt,
      trace,
      botId,
      connectionId,
      "internal",
      "unknown",
      "the subscription was cancelled",
    );
  }

  /** A live bot that can actually run; an unavailable one refuses the command. */
  #handle(connectionId: string, requestId?: string): RuntimeHandle {
    return this.#handleOfBot(this.#botOf(connectionId, requestId), requestId);
  }

  #handleOfBot(bot: Bot, requestId?: string): RuntimeHandle {
    if (bot.degraded !== undefined || bot.handle === undefined) {
      throw new CommandError(
        this.#mint(bot.degraded?.reason ?? "storage_failed"),
        "runtime",
        "the bot is unavailable; recover it first",
        requestId,
      );
    }
    return bot.handle;
  }

  #subscribed(connectionId: string, requestId?: string): string {
    return this.#botOf(connectionId, requestId).snapshot.botId;
  }

  #connectionBot(connectionId: string): string | undefined {
    return this.#connections.get(connectionId)?.botId;
  }

  #botOf(connectionId: string, requestId?: string): Bot {
    const connection = this.#connections.get(connectionId);
    if (connection === undefined || connection.state !== "live" || connection.bot === undefined) {
      throw this.#refuse("the connection has no subscription", requestId);
    }
    return connection.bot;
  }

  async #bot(botId: string, trace: string, contextId?: string): Promise<Bot> {
    try {
      const bot = await this.#resolveBot(botId, trace);
      this.#current.set(botId, bot);
      return contextId === undefined ? bot : this.#contextBot(bot, contextId, trace);
    } catch (error) {
      // A bot that is gone must not keep answering `observe` from a stale view.
      if (error instanceof ClassifiedFailure && error.failure.kind === "unknown_bot") {
        this.#current.delete(botId);
      }
      throw error;
    }
  }

  #allViews(root: Bot): Bot[] {
    return [
      root,
      ...[...root.contexts.values()].flatMap((slot) =>
        slot.view === undefined ? [] : [slot.view],
      ),
    ];
  }

  #pruneContext(bot: Bot): void {
    const root = bot.scopeRoot;
    if (
      root === undefined ||
      bot.contextId === undefined ||
      bot.hub.subscriberCount > 0 ||
      bot.snapshot.running ||
      bot.snapshot.pending.length > 0 ||
      bot.snapshot.inbox.length > 0 ||
      bot.reserved.size > 0
    )
      return;
    if (root.contexts.get(bot.contextId)?.view === bot) {
      bot.detach?.();
      root.contexts.delete(bot.contextId);
    }
  }

  #contextBot(root: Bot, contextId: string, trace: string): Promise<Bot> {
    if (!INVOCATION_ID.test(contextId)) throw this.#refuse("the context id is malformed");
    const existing = root.contexts.get(contextId);
    if (existing !== undefined) return existing.ready;
    const pending = (async () => {
      const owner = this.#handleOfBot(root);
      const handle = await owner.context?.(contextId, trace);
      if (handle === undefined) throw this.#refuse("runtime has no contexts");
      let bot: Bot | undefined;
      let refreshing = false;
      const hub = new EventHub(root.snapshot.botId, trace, {
        ...this.#hubOptions,
        onDegrade: () => {
          if (bot === undefined || refreshing) return;
          refreshing = true;
          try {
            bot.hub.publishSnapshot(bot.snapshot, trace);
          } finally {
            refreshing = false;
          }
        },
      });
      bot = await this.#attach(handle, hub, trace, undefined, root, contextId);
      bot.origins = root.origins;
      if (bot.origins !== undefined) bot.snapshot = this.#withOrigins(bot.snapshot, bot.origins);
      const slot = root.contexts.get(contextId);
      if (slot !== undefined) slot.view = bot;
      bot.release();
      return bot;
    })();
    root.contexts.set(contextId, { ready: pending });
    pending.catch(() => {
      if (root.contexts.get(contextId)?.ready === pending) root.contexts.delete(contextId);
    });
    return pending;
  }

  async #resolveBot(botId: string, trace: string): Promise<Bot> {
    const cached = this.#bots.get(botId);
    if (cached !== undefined) {
      const bot = await cached.catch(() => undefined);
      if (bot !== undefined) {
        const live = this.#handleOf?.(botId);
        const settling = this.#settlingOf?.(botId) === true;
        // A live handle that the registry still owns is this view's handle: no extra open.
        if (!settling && (this.#handleOf === undefined || bot.handle === live)) return bot;
        if (settling) {
          // A close or delete in flight owns the handle: ask the registry, which waits
          // for it, so a subscribe never holds a handle the registry is about to drop.
          const opened = await this.#open(botId, trace).catch((error: unknown) => {
            if (error instanceof ClassifiedFailure && error.failure.kind === "unknown_bot") {
              throw error;
            }
            return undefined;
          });
          if (opened !== undefined && bot.handle === opened) return bot;
          if (opened === undefined && bot.handle === undefined) return bot;
        }
      }
      this.#bots.delete(botId);
      this.#current.delete(botId);
    }
    return this.#openBotCached(botId, trace);
  }

  #openBotCached(botId: string, trace: string): Promise<Bot> {
    const existing = this.#bots.get(botId);
    if (existing !== undefined) return existing;
    const created = this.#openBot(botId, trace);
    this.#bots.set(botId, created);
    created.catch(() => {
      // A failed open must not poison every later attempt.
      if (this.#bots.get(botId) === created) this.#bots.delete(botId);
    });
    return created;
  }

  async #openBot(botId: string, trace: string): Promise<Bot> {
    const hub = new EventHub(botId, trace, {
      ...this.#hubOptions,
      // A subscriber the transport downgraded gets the current view as its anchor. A
      // snapshot that is itself refused would degrade again, so one attempt runs at a
      // time: a client that never reads cannot spin the daemon.
      onDegrade: () => {
        const bot = this.#live.get(botId);
        if (bot === undefined || this.#refreshing.has(botId)) return;
        this.#refreshing.add(botId);
        try {
          bot.hub.publishSnapshot(bot.snapshot, trace);
        } finally {
          this.#refreshing.delete(botId);
        }
      },
    });
    try {
      const handle = await this.#open(botId, trace);
      const bot = await this.#attach(handle, hub, trace);
      const triggers = await this.#triggersOf?.list(botId).catch(() => undefined);
      if (triggers !== undefined) bot.snapshot = { ...bot.snapshot, triggers };
      if (this.#pullsOf !== undefined)
        bot.snapshot = {
          ...bot.snapshot,
          pulls: await this.#pullsOf.list(botId).catch(() => [] as readonly PullSummary[]),
        };
      bot.origins = await this.#openOrigins(botId, trace);
      if (bot.origins !== undefined) bot.snapshot = this.#withOrigins(bot.snapshot, bot.origins);
      // The view is live whether or not a client ever subscribes: a port caller must see
      // commits, and `subscribe` re-reads the snapshot synchronously before publishing its
      // baseline, so nothing can be lost between the two.
      bot.release();
      return bot;
    } catch (error) {
      // A bot that cannot open is `unavailable`, not a failed connection: the client
      // renders the reason and can `recover` it.
      if (error instanceof ClassifiedFailure && error.failure.kind === "unknown_bot") throw error;
      if (error instanceof CommandError && error.disposition === "not_admitted") throw error;
      const classified = error instanceof ClassifiedFailure ? error : undefined;
      const reason = classified?.failure.kind ?? "storage_failed";
      const message = classified?.message ?? "the bot could not be opened";
      return {
        contexts: new Map(),
        scopeRoot: undefined,
        contextId: undefined,
        handle: undefined,
        degraded: { reason, message },
        hub,
        snapshot: {
          botId,
          messages: [],
          pending: [],
          inbox: [],
          running: false,
          streaming: null,
          unavailable: { reason, message },
        },
        ranks: new Map(),
        reserved: new Map<string, number>(),
        detach: undefined,
        release: () => undefined,
        origins: undefined,
      };
    }
  }

  async #attach(
    handle: RuntimeHandle,
    hub: EventHub,
    trace: string,
    target?: Bot,
    scopeRoot?: Bot,
    contextId?: string,
  ): Promise<Bot> {
    const buffered: RuntimeEvent[] = [];
    let ready = false;
    let bot: Bot;
    const enrich = (event: RuntimeEvent): RuntimeEvent => {
      const store = bot.origins;
      if (store === undefined) return event;
      if (event.type === "append")
        return { ...event, message: this.#withOrigin(event.message, store) };
      if (event.type === "snapshot")
        return { ...event, value: this.#withOrigins(event.value, store) };
      return event;
    };
    const apply = (incoming: RuntimeEvent): void => {
      const event = enrich(incoming);
      const wasRunning = bot.snapshot.running;
      if (event.type === "usage") this.#onUsage?.(bot.snapshot.botId, event.usage);
      if (event.type === "submission") {
        bot.reserved.delete(event.record.requestId);
        // The entry id is durable now, so the label becomes reachable after a restart.
        const { requestId, entryId } = event.record;
        if (entryId !== undefined && bot.origins !== undefined) {
          void bot.origins.backfill({ requestId, entryId }).catch(() => undefined);
        }
      }
      let next = reduceView(bot.snapshot, event, bot.ranks);
      if (
        event.type === "error" &&
        (event.failure.kind === "storage_failed" || event.failure.kind === "internal")
      ) {
        const dead = event.failure.kind === "storage_failed";
        // The harness closed itself or the watch escalated: the handle is dead, so the bot
        // is unavailable until `recover` opens it again (ARCHITECTURE.md, "Failure
        // containment"). An unavailable snapshot's collections are unknown, so they are
        // empty — the production decoder refuses anything else (PROTOCOL.md).
        const { truncatedBefore: _dropped, ...rest } = next;
        next = {
          ...rest,
          messages: [],
          running: false,
          streaming: null,
          pending: [],
          inbox: [],
          unavailable: { reason: event.failure.kind, message: event.message },
        };
        bot.handle = dead ? undefined : bot.handle;
        bot.degraded = { reason: event.failure.kind, message: event.message };
        // A dead session takes the handle; an escalated watch leaves the harness owned, so
        // the registry keeps it and `recover` re-attaches instead of opening a second one.
        this.#onSessionFailed?.(next.botId, event.failure.kind, event.message, dead);
      }
      next = this.#fitPage(next);
      bot.snapshot = next;
      if (next.running !== wasRunning) this.#emitRunning(next.botId, next.running);
      // A snapshot from the runtime may carry a stale pending list; broadcast the one the
      // bot actually holds so a client never adopts a downgraded submission.
      hub.publish(
        event.type === "snapshot" && next !== event.value ? { ...event, value: next } : event,
      );
      this.#pruneContext(bot);
    };
    const ranks: SubmissionRanks = new Map();
    const subscription = await handle.subscribe(trace, (event) => {
      if (!ready) {
        buffered.push(event);
        return;
      }
      apply(event);
    });
    seedRanks(ranks, subscription.snapshot.pending);
    bot = target ?? ({} as Bot);
    if (scopeRoot === undefined && target?.scopeRoot === undefined) this.#live.set(hub.botId, bot);
    Object.assign(bot, {
      contexts: target?.contexts ?? new Map(),
      scopeRoot: scopeRoot ?? target?.scopeRoot,
      contextId: contextId ?? target?.contextId,
      handle,
      degraded: undefined,
      hub,
      detach: () => subscription.detach(),
      // The runtime's own baseline is a page too: it is trimmed before any client sees it.
      snapshot: this.#fitPage(subscription.snapshot),
      ranks,
      // Re-attaching onto the same view keeps the admissions already in flight: they were
      // neither settled nor in a snapshot yet.
      reserved: target === undefined ? new Map<string, number>() : target.reserved,
      release: () => {
        // Stay buffering while draining: an event produced by a sink mid-release must
        // queue behind the earlier ones instead of overtaking them.
        while (!ready) {
          const event = buffered.shift();
          if (event === undefined) {
            ready = true;
            break;
          }
          apply(event);
        }
      },
    });
    return bot;
  }
}
