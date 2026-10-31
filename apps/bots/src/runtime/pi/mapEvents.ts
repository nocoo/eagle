// pi-durable → `RuntimeEvent` (docs/bots/RUNTIME.md, "Event mapping"). Pure: the mapper
// owns the attempt-scoped provisional, the submission ledger and the projected view, and
// never numbers revisions, touches a socket or reads the catalog.

import type {
  AgentEvent,
  EntryRecord,
  MessageChange,
  SnapshotEvent,
  SubmissionRecord,
} from "@earendil-works/pi-durable";
import type {
  AgentView,
  ContentBlock,
  ConversationSnapshot,
  DeltaChange,
  InboxItem,
  Message,
  Submission,
} from "../../core/domain.ts";
import type { RuntimeEvent } from "../../core/RuntimePort.ts";
import {
  convertBlock,
  convertMessage,
  convertUsage,
  entryMessageId,
  messageBytes,
  provisionalMessageId,
  stopReasonOf,
} from "./convert.ts";
import { MergeContribution } from "./HistoryReplica.ts";
import { RESOURCE_USER_KIND } from "./HistoryResources.ts";
import { MAX_MESSAGE_BYTES, OVERSIZED_NOTICE, WINDOW_MESSAGES } from "./limits.ts";

export type EventMapperOptions = {
  readonly botId: string;
  readonly windowMessages?: number;
  readonly maxMessageBytes?: number;
  readonly now?: () => Date;
};

const inboxMode = (mode: string): InboxItem["mode"] =>
  mode === "steer" ? "steer" : mode === "followUp" ? "followUp" : "queue";

/** pi's submission record as the domain's, for the ids the wire carries. */
export const convertSubmission = (record: SubmissionRecord): Submission | undefined => {
  if (record.type !== "input") return undefined;
  const answer = "answer" in record ? record.answer : undefined;
  return {
    id: String(record.id),
    requestId: record.requestId ?? "",
    status: record.status,
    ...(record.entry === undefined ? {} : { entryId: entryMessageId(record.entry) }),
    ...(answer === undefined ? {} : { answerEntryId: entryMessageId(answer) }),
    ...(record.status === "unanswered" ? { reason: record.reason } : {}),
  };
};

/**
 * One bot's adapter state: the current attempt, its provisional id, the projected
 * window, the inbox and the submission ledger. `seed` renders the subscription's
 * baseline; `map` translates later commits.
 */
export class EventMapper {
  readonly #botId: string;
  readonly #window: number;
  readonly #maxMessageBytes: number;
  readonly #now: () => Date;

  #attempt = 0;
  /** True while pi has an attempt in flight that has not committed an entry yet. */
  #attemptOpen = false;
  #provisional: string | null = null;
  #withheld = false;
  #messages: Message[] = [];
  #truncatedBefore: string | undefined;
  #inbox: InboxItem[] = [];
  #running = false;
  #usage: ConversationSnapshot["usage"];
  #agent: AgentView | undefined;
  readonly #requestByEntry = new Map<string, string>();
  readonly #records = new Map<string, Submission>();

  constructor(options: EventMapperOptions) {
    this.#botId = options.botId;
    this.#window = options.windowMessages ?? WINDOW_MESSAGES;
    this.#maxMessageBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
    this.#now = options.now ?? (() => new Date());
  }

  /** The current view, without publishing anything. */
  view(): ConversationSnapshot {
    return {
      botId: this.#botId,
      ...(this.#agent === undefined ? {} : { agent: this.#agent }),
      messages: [...this.#messages],
      ...(this.#truncatedBefore === undefined ? {} : { truncatedBefore: this.#truncatedBefore }),
      streaming: this.#streaming(),
      pending: [...this.#records.values()].filter(
        (record) => record.status === "queued" || record.status === "placed",
      ),
      inbox: [...this.#inbox],
      running: this.#running,
      ...(this.#usage === undefined ? {} : { usage: this.#usage }),
    };
  }

  /**
   * Resets adapter state from an attach or reattach snapshot and returns its baseline.
   * `pending` is rebuilt from the snapshot itself — the submission ids the run and the
   * inbox name — plus any record `active` supplies, because a snapshot says which work
   * exists while only a record says what it is. A record that is not in the snapshot is
   * dropped: it settled, whatever the ledger last saw.
   */
  seed(event: SnapshotEvent, trace: string, active: readonly Submission[] = []): RuntimeEvent[] {
    this.#attempt = event.generation?.attempt ?? 0;
    this.#attemptOpen = event.generation !== undefined;
    this.#provisional = null;
    this.#withheld = false;
    const live = new Set<string>([
      ...(event.run?.inputs ?? []).map((id) => String(id)),
      ...event.inbox.map((item) => String(item.id)),
    ]);
    for (const record of active) {
      if (live.has(record.id)) this.#records.set(record.id, record);
    }
    for (const id of [...this.#records.keys()]) {
      if (!live.has(id)) this.#records.delete(id);
    }
    // The snapshot is the newer truth about status: an input the run names has been
    // placed, whatever the ledger last saw (PROTOCOL.md ranks statuses this way).
    for (const input of event.run?.inputs ?? []) {
      const record = this.#records.get(String(input));
      if (record !== undefined && record.status === "queued") {
        this.#records.set(record.id, { ...record, status: "placed" });
      }
    }
    this.#running = event.run !== undefined;
    this.#inbox = event.inbox.map((item) => ({ id: String(item.id), mode: inboxMode(item.mode) }));
    const snapshotUsage = convertUsage(event.usage);
    this.#usage = snapshotUsage.totalTokens > 0 ? snapshotUsage : undefined;
    this.#agent = {
      model: {
        provider: event.agent.model?.provider ?? "",
        modelId: event.agent.model?.modelId ?? "",
      },
      thinkingLevel: event.agent.thinkingLevel ?? "off",
      instructions: event.agent.instructions ?? "",
    };

    const messages: Message[] = [];
    for (const entry of event.entries) {
      const message = this.#convertEntry(entry);
      if (message !== undefined) messages.push(message);
    }
    this.#setWindow(messages);

    const partial = event.generation?.message;
    if (partial !== undefined) {
      const message = asStreaming(
        convertMessage(partial, {
          id: provisionalMessageId(this.#attempt),
          now: this.#now,
        }),
      );
      if (message !== undefined) this.#openProvisional(message);
    }
    return [{ type: "snapshot", trace, value: this.view() }];
  }

  /**
   * Translates one pi commit. Unknown or reserved events map to nothing. A snapshot
   * event carries only the ids of the work it names, so the adapter supplies the records
   * it read for them; without them `pending` still drops settled work but cannot
   * describe new work.
   */
  map(event: AgentEvent, trace: string, active: readonly Submission[] = []): RuntimeEvent[] {
    switch (event.type) {
      case "snapshot":
        return this.seed(event, trace, active);
      case "message_start":
        return this.#messageStart(event.message, trace);
      case "message_update":
        return this.#messageUpdate(event.changes, trace);
      case "message_end":
        return this.#messageEnd(event.entry, trace);
      case "run_start":
        this.#running = true;
        return [this.#status(trace)];
      case "run_end":
        this.#running = false;
        this.#closeProvisional();
        this.#attemptOpen = false;
        return [this.#status(trace)];
      case "inbox_update":
        this.#inbox = event.items.map((item) => ({
          id: String(item.id),
          mode: inboxMode(item.mode),
        }));
        return [this.#status(trace)];
      case "submission":
        return this.#submission(event.record, trace);
      case "usage_changed": {
        const usage = convertUsage(event.usage);
        // A conversation that has not spent anything yet reports zeros; the client shows
        // its empty state instead of a row of zeros.
        this.#usage = usage.totalTokens > 0 ? usage : undefined;
        return this.#usage === undefined ? [] : [{ type: "usage", trace, usage: this.#usage }];
      }
      case "agent_changed":
        this.#agent = {
          model: {
            provider: event.agent.model?.provider ?? "",
            modelId: event.agent.model?.modelId ?? "",
          },
          thinkingLevel: event.agent.thinkingLevel ?? "off",
          instructions: event.agent.instructions ?? "",
        };
        return [{ type: "agent", trace, agent: this.#agent }];
      case "deferred_poll":
        // F23: upstream dropped the partial, so the client must drop the provisional
        // too. Only a snapshot can say that, and `running` stays true: polling is work.
        this.#closeProvisional();
        return [
          { type: "snapshot", trace, value: { ...this.view(), running: true } },
          this.#status(trace),
        ];
      default:
        return [];
    }
  }

  /** Records a submission the adapter read itself, so the view and ledger agree. */
  record(record: SubmissionRecord, trace: string): RuntimeEvent[] {
    return this.#submission(record, trace);
  }

  /** Teaches the ledger a record without publishing an event: `submit` replies per connection. */
  observe(record: SubmissionRecord): void {
    this.#remember(record);
  }

  /**
   * Resolves this commit batch's submission records before anything is mapped, so a user
   * append in the same batch already knows its `requestId` — and therefore its origin —
   * when it is published. The wire order stays append → submission either way; what
   * changes is that the append is no longer published blind (TRIGGERS.md §6.3a).
   */
  prime(batch: readonly AgentEvent[]): void {
    for (const event of batch) {
      if (event.type === "submission") this.#remember(event.record);
    }
  }

  /** One committed entry as a domain message, for `history`. */
  entryMessage(entry: EntryRecord): Message | undefined {
    return this.#convertEntry(entry);
  }

  /** Committed entry ids of the messages the client can page back to. */
  historyCursor(): string | undefined {
    return this.#truncatedBefore;
  }

  #submission(record: SubmissionRecord, trace: string): RuntimeEvent[] {
    const converted = this.#remember(record);
    return converted === undefined ? [] : [{ type: "submission", trace, record: converted }];
  }

  #remember(record: SubmissionRecord): Submission | undefined {
    const converted = convertSubmission(record);
    if (converted === undefined) return undefined;
    if (converted.entryId !== undefined && converted.requestId.length > 0) {
      this.#requestByEntry.set(converted.entryId, converted.requestId);
      this.#attachRequestId(converted.entryId, converted.requestId);
    }
    this.#records.set(converted.id, converted);
    return converted;
  }

  /**
   * The user entry is committed in the same commit as its submission record, but the
   * `message_end` for it arrives first, so the request id lands on the message right after
   * and a later snapshot carries what the live append could not.
   */
  #attachRequestId(entryId: string, requestId: string): void {
    const index = this.#messages.findIndex((message) => message.id === entryId);
    const message = index < 0 ? undefined : this.#messages[index];
    if (message === undefined || message.requestId !== undefined) return;
    this.#messages[index] = { ...message, requestId };
  }

  #messageStart(
    message: Extract<AgentEvent, { type: "message_start" }>["message"],
    trace: string,
  ): RuntimeEvent[] {
    if (message.role !== "assistant") return [];
    if (message.stopReason === "deferred") return [];
    // A re-announcement keeps its attempt; a genuinely new attempt is the last one plus
    // one, even when the attach snapshot already counted the current attempt.
    const id =
      this.#provisional ??
      provisionalMessageId(this.#attemptOpen ? Math.max(this.#attempt, 1) : this.#attempt + 1);
    // A partial is always in flight, whatever the resolved message's `stopReason` says:
    // the entry that ends the attempt is what carries the final state.
    const converted = asStreaming(convertMessage(message, { id, now: this.#now }));
    if (converted === undefined) return [];
    if (this.#provisional !== null) {
      // The same attempt re-announced with its accumulated content (F4): keep the id and
      // replace the content wholesale instead of streaming it twice.
      if (this.#withheld) return [];
      if (messageBytes(converted) > this.#maxMessageBytes) return this.#withdrawProvisional(trace);
      this.#replaceMessage(converted);
      const changes: DeltaChange[] = [{ kind: "message", message: converted }];
      return [{ type: "delta", trace, messageId: id, changes }];
    }
    if (!this.#attemptOpen) this.#attempt += 1;
    this.#attemptOpen = true;
    this.#provisional = id;
    return this.#appendProvisional(converted, trace);
  }

  #messageUpdate(changes: readonly MessageChange[], trace: string): RuntimeEvent[] {
    const id = this.#provisional;
    if (id === null || this.#withheld) return [];
    const index = this.#messages.findIndex((item) => item.id === id);
    // A delta for an unknown id belongs to a state a snapshot already reset (F8).
    if (index < 0) return [];
    const converted: DeltaChange[] = [];
    for (const change of changes) {
      switch (change.type) {
        case "text_delta":
        case "thinking_delta":
          converted.push({
            kind: change.type === "text_delta" ? "text" : "thinking",
            index: change.contentIndex,
            append: change.delta,
          });
          break;
        case "toolcall_delta": {
          const block = (this.#messages[index] as Message).blocks[change.contentIndex];
          converted.push({
            kind: "toolcall",
            index: change.contentIndex,
            callId: block !== undefined && block.type === "toolCall" ? block.callId : "",
            // pi's path is relative to the call's arguments; the wire's is relative to
            // the block (PROTOCOL I13), so `["q"]` becomes `["args","q"]`.
            path: ["args", ...change.path],
            append: change.delta,
          });
          break;
        }
        case "message": {
          const message = asStreaming(convertMessage(change.message, { id, now: this.#now }));
          if (message !== undefined) converted.push({ kind: "message", message });
          break;
        }
        default: {
          const block = convertBlock(change.block);
          if (block !== undefined) {
            converted.push({ kind: "block", index: change.contentIndex, block });
          }
        }
      }
    }
    if (converted.length === 0) return [];
    let message = this.#messages[index] as Message;
    for (const change of converted) message = applyChange(message, change);
    this.#messages[index] = message;
    if (this.#provisionalBytesExceeded()) return this.#withdrawProvisional(trace);
    return [{ type: "delta", trace, messageId: id, changes: converted }];
  }

  #messageEnd(entry: EntryRecord, trace: string): RuntimeEvent[] {
    if (
      entry.kind !== "pi.user" &&
      !(entry.kind === RESOURCE_USER_KIND && entry.model?.[0]?.role === "user") &&
      entry.kind !== "pi.assistant" &&
      entry.kind !== "pi.tool-result" &&
      !MergeContribution.is(entry)
    ) {
      return [];
    }
    const toolResult =
      entry.kind === "pi.tool-result" ||
      (MergeContribution.is(entry) && entry.model?.[0]?.role === "toolResult");
    const replaces = entry.kind === "pi.assistant" ? (this.#provisional ?? undefined) : undefined;
    const message = this.#convertEntry(entry);
    // A tool result is a transcript row of its own; it neither ends nor replaces the
    // attempt the assistant is still streaming into.
    if (!toolResult) {
      this.#provisional = null;
      this.#withheld = false;
    }
    if (entry.kind === "pi.assistant") this.#attemptOpen = false;
    if (message === undefined) return [];
    this.#upsert(message, replaces);
    return [
      {
        type: "append",
        trace,
        message,
        ...(replaces === undefined ? {} : { replaces }),
      },
    ];
  }

  #appendProvisional(message: Message, trace: string): RuntimeEvent[] {
    if (messageBytes(message) > this.#maxMessageBytes) {
      this.#withheld = true;
      return this.#withdrawProvisional(trace);
    }
    this.#messages.push(message);
    this.#trim();
    return [{ type: "append", trace, message }];
  }

  #openProvisional(message: Message): void {
    this.#provisional = message.id;
    if (messageBytes(message) > this.#maxMessageBytes) {
      this.#withheld = true;
      return;
    }
    this.#messages.push(message);
    this.#trim();
  }

  /** PROTOCOL.md: an over-limit attempt is withdrawn through a snapshot, streaming null. */
  #withdrawProvisional(trace: string): RuntimeEvent[] {
    this.#withheld = true;
    this.#dropProvisional();
    return [{ type: "snapshot", trace, value: this.view() }, this.#status(trace)];
  }

  /** Ends the attempt without a committed entry (a run that ended, or a deferred poll). */
  #closeProvisional(): void {
    this.#dropProvisional();
    this.#provisional = null;
    this.#withheld = false;
    // The closed attempt keeps its id: the next attempt must not reuse `p_a<n>`.
    this.#attemptOpen = false;
  }

  #dropProvisional(): void {
    const id = this.#provisional;
    if (id === null) return;
    this.#messages = this.#messages.filter((message) => message.id !== id);
  }

  #provisionalBytesExceeded(): boolean {
    const id = this.#provisional;
    if (id === null) return false;
    const message = this.#messages.find((item) => item.id === id);
    return message !== undefined && messageBytes(message) > this.#maxMessageBytes;
  }

  #status(trace: string): RuntimeEvent {
    return {
      type: "status",
      trace,
      running: this.#running,
      streaming: this.#streaming(),
      inbox: [...this.#inbox],
    };
  }

  #streaming(): string | null {
    return this.#withheld ? null : this.#provisional;
  }

  #convertEntry(entry: EntryRecord): Message | undefined {
    const model = entry.model?.[0];
    if (model === undefined) return undefined;
    if (
      entry.kind !== "pi.user" &&
      !(entry.kind === RESOURCE_USER_KIND && model.role === "user") &&
      entry.kind !== "pi.assistant" &&
      entry.kind !== "pi.tool-result" &&
      !MergeContribution.is(entry)
    ) {
      return undefined;
    }
    const id = entryMessageId(entry.id);
    const requestId = this.#requestByEntry.get(id);
    const message = convertMessage(model, {
      id,
      now: this.#now,
      ...(requestId === undefined ? {} : { requestId }),
    });
    if (message === undefined) return undefined;
    if (messageBytes(message) > this.#maxMessageBytes) {
      // A tool result is bounded by its own tool, but a hostile or future tool must not
      // turn into an "answer too large" notice: clamp the row instead.
      if (message.role === "tool") return this.#boundedTool(message);
      return this.#notice(id, message.createdAt);
    }
    return message;
  }

  /**
   * Clamps a tool row to the message budget. The budget is the encoded message, not the
   * raw text: quotes, newlines and backslashes cost two bytes on the wire, so the fitting
   * prefix is found by measuring, never by assuming one byte per character.
   */
  #boundedTool(message: Message): Message {
    const block = message.blocks[0];
    if (block === undefined || block.type !== "toolResult") return message;
    const marker = "\n[tool output truncated]";
    const build = (size: number): Message => ({
      ...message,
      blocks: [{ ...block, text: `${block.text.slice(0, size)}${marker}` }],
    });
    let low = 0;
    let high = block.text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (messageBytes(build(middle)) <= this.#maxMessageBytes) low = middle;
      else high = middle - 1;
    }
    return build(low);
  }

  /** The withheld answer's replacement: the entry's own id and timestamp, so a reconnect sees the same. */
  #notice(id: string, createdAt: string): Message {
    return {
      id,
      role: "notice",
      state: "complete",
      createdAt,
      blocks: [{ type: "text", text: OVERSIZED_NOTICE }],
    };
  }

  #replaceMessage(message: Message): void {
    const index = this.#messages.findIndex((item) => item.id === message.id);
    if (index >= 0) this.#messages[index] = message;
    else this.#messages.push(message);
    this.#trim();
  }

  #upsert(message: Message, replaces?: string): void {
    // A finalized entry is the newest commit, so it lands after anything that arrived
    // while the attempt streamed (a tool result). Replacing in place would invert the
    // order against a snapshot built from the same entries.
    if (replaces !== undefined) {
      const replaced = this.#messages.findIndex((item) => item.id === replaces);
      if (replaced >= 0) this.#messages.splice(replaced, 1);
    }
    const existing = this.#messages.findIndex((item) => item.id === message.id);
    if (existing >= 0) this.#messages[existing] = message;
    else this.#messages.push(message);
    this.#trim();
  }

  #setWindow(messages: readonly Message[]): void {
    this.#messages = [...messages];
    this.#truncatedBefore = undefined;
    this.#trim();
  }

  #trim(): void {
    if (this.#messages.length <= this.#window) return;
    const dropped = this.#messages.slice(0, this.#messages.length - this.#window);
    const first = dropped.find((message) => message.id.startsWith("e_"));
    if (first !== undefined) this.#truncatedBefore = first.id;
    this.#messages = this.#messages.slice(-this.#window);
    // `streaming` must always name a message in the window: a trimmed-away provisional is
    // dropped, and the entry that ends its attempt is appended without `replaces`.
    if (
      this.#provisional !== null &&
      !this.#messages.some((item) => item.id === this.#provisional)
    ) {
      this.#provisional = null;
      this.#withheld = false;
    }
  }
}

/** The provisional is `streaming` and has no stop reason until its entry commits. */
const asStreaming = (message: Message | undefined): Message | undefined =>
  message === undefined
    ? undefined
    : {
        id: message.id,
        role: "assistant",
        state: "streaming",
        createdAt: message.createdAt,
        blocks: message.blocks,
      };

/** Applies one change to a message; the snapshot fold must agree with the wire's. */
export const applyChange = (message: Message, change: DeltaChange): Message => {
  if (change.kind === "message") return change.message;
  const blocks = [...message.blocks];
  if (change.kind === "block") {
    blocks[change.index] = change.block;
    return { ...message, blocks };
  }
  const block = blocks[change.index];
  if (block === undefined) return message;
  if (change.kind === "text" && block.type === "text") {
    blocks[change.index] = { type: "text", text: block.text + change.append };
    return { ...message, blocks };
  }
  if (change.kind === "thinking" && block.type === "thinking") {
    blocks[change.index] = { type: "thinking", text: block.text + change.append };
    return { ...message, blocks };
  }
  if (change.kind === "toolcall" && block.type === "toolCall") {
    const call: ContentBlock = structuredClone(block);
    if (call.type !== "toolCall") return message;
    appendAtPath(call as unknown as object, change.path, change.append);
    blocks[change.index] = call;
    return { ...message, blocks };
  }
  return message;
};

/**
 * The same fold the wire and the service use: the path is rooted at the block, and a
 * missing intermediate object or array is created from the next component. pi streams JSON
 * arguments as text, so the containers it names do not exist until the client folds them.
 */
const appendAtPath = (root: object, path: readonly (string | number)[], append: string): void => {
  if (path.some((key) => typeof key === "number" && key < 0)) return;
  let node = root as Record<string | number, unknown>;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (key === undefined) return;
    const next = path[index + 1];
    let child = node[key];
    if (child === null || typeof child !== "object") {
      child = typeof next === "number" ? [] : {};
      node[key] = child;
    }
    node = child as Record<string | number, unknown>;
  }
  const leaf = path[path.length - 1];
  if (leaf === undefined) return;
  const prior = node[leaf];
  node[leaf] = `${typeof prior === "string" ? prior : ""}${append}`;
};

export const createEventMapper = (options: EventMapperOptions): EventMapper =>
  new EventMapper(options);

export { stopReasonOf };
