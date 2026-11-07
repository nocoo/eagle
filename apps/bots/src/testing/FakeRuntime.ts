// A scripted runtime for core tests. Each bot id gets its own handle and state, opening
// the same id twice returns the same handle, and every emitted event is applied to that
// state, so `submission()`, `history()` and `subscribe()` answer from what was delivered.
import type { ConversationSnapshot, Message, Submission } from "../core/domain.ts";
import type {
  RuntimeBotSpec,
  RuntimeEvent,
  RuntimeHandle,
  RuntimeHistory,
  RuntimePort,
  RuntimeSubscription,
  SubmitInput,
} from "../core/RuntimePort.ts";
import {
  applyChanges,
  mergeOrdered,
  reduceView,
  type SubmissionRanks,
  seedRanks,
  statusRank,
} from "../core/view.ts";

export type FakeScript = {
  /** Events emitted after a submit is admitted. */
  readonly onSubmit?: (input: SubmitInput) => RuntimeEvent[];
};

export class FakeHandle implements RuntimeHandle {
  readonly refreshes: string[] = [];
  readonly spec: RuntimeBotSpec;
  readonly opens: string[] = [];
  readonly closes: { trace: string; deadlineMs: number }[] = [];
  readonly #script: FakeScript;
  #snapshot: ConversationSnapshot;
  /** Every message ever committed, in order: the window may move, history may not. */
  #committed: Message[] = [];
  #sink: ((event: RuntimeEvent) => void) | undefined;
  #submissions = new Map<string, Submission>();
  #ranks: SubmissionRanks = new Map();

  closed = false;

  constructor(
    spec: RuntimeBotSpec,
    options: { script?: FakeScript; snapshot?: (() => ConversationSnapshot) | undefined },
  ) {
    this.spec = spec;
    this.#script = options.script ?? {};
    this.#snapshot = options.snapshot?.() ?? {
      botId: spec.id,
      messages: [],
      streaming: null,
      pending: [],
      inbox: [],
      running: false,
    };
    this.#committed = this.#snapshot.messages.filter((message) => message.state !== "streaming");
    for (const record of this.#snapshot.pending) this.#remember(record);
    seedRanks(this.#ranks, this.#snapshot.pending);
  }

  get snapshot(): ConversationSnapshot {
    return this.#snapshot;
  }

  async refreshTools(trace: string): Promise<void> {
    this.refreshes.push(trace);
  }

  subscribe(trace: string, sink: (event: RuntimeEvent) => void): Promise<RuntimeSubscription> {
    void trace;
    this.#sink = sink;
    return Promise.resolve({ snapshot: this.#snapshot, detach: () => (this.#sink = undefined) });
  }

  async submit(input: SubmitInput): Promise<Submission> {
    const existing = this.#submissions.get(input.requestId);
    if (existing) return existing;
    const record: Submission = {
      id: this.#nextSubmissionId(),
      requestId: input.requestId,
      status: "queued",
    };
    this.#remember(record);
    this.#snapshot = { ...this.#snapshot, pending: [...this.#snapshot.pending, record] };
    for (const event of this.#script.onSubmit?.(input) ?? []) this.emit(event);
    return this.#submissions.get(input.requestId) ?? record;
  }

  submission(
    key: { submissionId: string } | { requestId: string },
  ): Promise<Submission | undefined> {
    const found =
      "submissionId" in key
        ? [...this.#submissions.values()].find((record) => record.id === key.submissionId)
        : this.#submissions.get(key.requestId);
    return Promise.resolve(found);
  }

  history(input: { beforeEntryId?: string; limit: number }): Promise<RuntimeHistory> {
    const messages: readonly Message[] = this.#committed;
    const end = input.beforeEntryId
      ? Math.max(
          0,
          messages.findIndex((message) => message.id === input.beforeEntryId),
        )
      : messages.length;
    const start = Math.max(0, end - input.limit);
    return Promise.resolve({ messages: messages.slice(start, end), hasMore: start > 0 });
  }

  abort(trace: string): Promise<void> {
    void trace;
    return Promise.resolve();
  }

  promote(requestId: string, trace: string): Promise<Submission> {
    void trace;
    const record = this.#submissions.get(requestId);
    if (record === undefined) return Promise.reject(new Error("no such submission"));
    return Promise.resolve(record);
  }

  recover(trace: string): Promise<void> {
    void trace;
    return Promise.resolve();
  }

  busy(): Promise<{ run: boolean; tasks: boolean }> {
    return Promise.resolve({ run: this.#snapshot.running, tasks: false });
  }

  close(trace: string, deadlineMs: number): Promise<"closed" | "timeout"> {
    this.closes.push({ trace, deadlineMs });
    this.closed = true;
    this.#sink = undefined;
    return Promise.resolve("closed");
  }

  /** Delivers an event and applies it to this bot's state. */
  emit(event: RuntimeEvent): void {
    this.#apply(event);
    this.#sink?.(event);
  }

  /** A ranked-lower duplicate never overwrites the record a client already settled. */
  #remember(record: Submission): void {
    const known = this.#submissions.get(record.requestId);
    if (known === undefined || statusRank(record.status) >= statusRank(known.status)) {
      this.#submissions.set(record.requestId, record);
    }
  }

  /** Never collides with an id restored from a snapshot. */
  #nextSubmissionId(): string {
    let highest = 0;
    for (const id of [...this.#submissions.values()].map((record) => record.id)) {
      const match = /^s_(\d+)$/.exec(id);
      if (match?.[1]) highest = Math.max(highest, Number(match[1]));
    }
    return `s_${highest + 1}`;
  }

  #apply(event: RuntimeEvent): void {
    const next = reduceView(this.#snapshot, event, this.#ranks);
    if (event.type === "append" && event.message.state !== "streaming") {
      // Only committed entries belong to history: a provisional is projection-only, so a
      // withdrawn attempt leaves no message behind. A finalization takes the position the
      // projection gives it, so paging and the window never disagree.
      const without =
        event.replaces === undefined
          ? this.#committed
          : this.#committed.filter((message) => message.id !== event.replaces);
      this.#committed = mergeOrdered(
        without,
        next.messages.filter((message) => message.state !== "streaming"),
      );
    }
    if (event.type === "delta") {
      this.#committed = this.#committed.map((message) =>
        message.id === event.messageId ? applyChanges(message, event.changes) : message,
      );
    }
    if (event.type === "snapshot") {
      // The window may shrink, but committed history stays readable through history().
      this.#committed = mergeOrdered(
        this.#committed,
        event.value.messages.filter((message) => message.state !== "streaming"),
      );
      for (const record of event.value.pending) this.#remember(record);
    }
    if (event.type === "submission") this.#remember(event.record);
    this.#snapshot = next;
  }
}

export class FakeRuntime implements RuntimePort {
  readonly #options: {
    script?: FakeScript;
    snapshot?: (() => ConversationSnapshot) | undefined;
  };
  readonly handles = new Map<string, FakeHandle>();

  constructor(
    options: { script?: FakeScript; snapshot?: (() => ConversationSnapshot) | undefined } = {},
  ) {
    this.#options = options;
  }

  async open(spec: RuntimeBotSpec): Promise<RuntimeHandle> {
    const existing = this.handles.get(spec.id);
    if (existing) return existing;
    const handle = new FakeHandle(spec, this.#options);
    this.handles.set(spec.id, handle);
    return handle;
  }

  handle(id: string): FakeHandle {
    const found = this.handles.get(id);
    if (!found) throw new Error(`bot ${id} is not open`);
    return found;
  }
}
