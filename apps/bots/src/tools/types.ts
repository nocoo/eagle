import type { SubmissionStatus } from "../core/domain.ts";

// The shape every bot tool speaks (docs/bots/RUNTIME.md, "Tools"): a handler receives the
// workspace and validated arguments and returns what the model should see. Failures are
// results, not exceptions, so one bad path cannot fail the run.
export type BotWorkspace = {
  /** The bot's canonical default working directory. */
  readonly root: string;
};

export type ToolOutcome = {
  readonly output: string;
  readonly isError?: boolean;
};

/** A path or argument that the workspace refuses; the message is safe to show the model. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export const failed = (message: string): ToolOutcome => ({ output: message, isError: true });

/** What one Bot may write about itself: the sidebar line the daemon stores in its catalog. */
export type NoteToolHost = {
  readonly botId: string;
  /** Sets the note; an empty string clears it. Answers what the catalog now holds. */
  set(text: string): Promise<{ readonly note?: string }>;
};

/** One trigger as a tool sees it: the daemon owns the storage, the tool owns the surface. */
export type TriggerView = {
  readonly id: string;
  readonly kind: "schedule" | "webhook";
  readonly name: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly schedule?: {
    readonly cron: string;
    readonly timezone: string;
    readonly cursor?: string;
  };
  readonly counters: { readonly fired: number; readonly dropped: number; readonly refused: number };
  readonly lastFiredAt?: string;
  readonly lastSkipped?: { readonly at: string; readonly reason: string };
};

/**
 * What the trigger tools may do to their own Bot's definitions. Every mutation carries the
 * durable tool-task id as its operation id, so a replayed call returns the recorded result
 * instead of acting twice (docs/bots/TRIGGERS.md §7). The host is bound per Bot.
 */
export type TriggerToolHost = {
  readonly botId: string;
  create(input: {
    readonly opId: string;
    readonly kind: "schedule" | "webhook";
    readonly name: string;
    readonly prompt: string;
    readonly cron?: string;
    readonly timezone?: string;
  }): Promise<{ readonly trigger: TriggerView; readonly created: boolean }>;
  list(): Promise<readonly TriggerView[]>;
  update(input: {
    readonly opId: string;
    readonly triggerId: string;
    readonly name?: string;
    readonly prompt?: string;
  }): Promise<TriggerView>;
  enable(input: {
    readonly opId: string;
    readonly triggerId: string;
    readonly enabled: boolean;
  }): Promise<TriggerView>;
  remove(input: {
    readonly opId: string;
    readonly triggerId: string;
  }): Promise<{ readonly triggerId: string }>;
  /** Where a webhook delivers to, without the credential the app keeps. */
  endpoint(triggerId: string): string;
};

/** One bot another bot may talk to. Availability is an observation, never a promise. */
export type PeerListing = {
  readonly botId: string;
  readonly title: string;
  readonly availability: "idle" | "working" | "unavailable";
};

/** What one admitted peer message reports: admission and the remaining budget, never an answer. */
export type PeerSendResult = {
  readonly toBotId: string;
  readonly requestId: string;
  readonly status: SubmissionStatus;
  readonly exchangeId: string;
  /** How many messages this bot has now sent inside the exchange. */
  readonly sent: number;
  /** What this bot may still send before its side is spent. */
  readonly remaining: number;
  readonly exchangeStatus: "open" | "finished";
};

export type PeerReadResult = {
  readonly requestId: string;
  readonly toBotId: string;
  readonly status: SubmissionStatus | "unknown";
  readonly reason?: string;
  /** The recipient's answer, once it has one. */
  readonly answer?: string;
};

export type PeerReceiptView = {
  readonly requestId: string;
  readonly toBotId: string;
  readonly at: string;
  readonly status: SubmissionStatus | "unknown";
};

/**
 * What the peer tools may do (docs/bots/EXTENSIONS-AND-TOOLS.md §6.4). The host binds the sender:
 * the model names a recipient and a message, never who it is. Admission, durability and the turn
 * budget belong to the daemon, so a tool cannot promise more than the exchange allows.
 */
export type PeerToolHost = {
  readonly botId: string;
  /** The longest message the admission port accepts, in characters. */
  readonly maxMessage: number;
  list(input: {
    readonly query?: string;
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<{ readonly items: readonly PeerListing[]; readonly nextCursor?: string }>;
  send(input: {
    readonly taskId: string;
    readonly toBotId: string;
    readonly message: string;
  }): Promise<PeerSendResult>;
  read(input: { readonly requestId: string }): Promise<PeerReadResult>;
  receipts(input: {
    readonly toBotId?: string;
    readonly limit: number;
  }): Promise<readonly PeerReceiptView[]>;
};

/** The states a person sees as a colour; a forge's own vocabulary maps onto these. */
export const PULL_STATUSES = ["draft", "open", "reviewing", "merged", "closed", "failed"] as const;

export type PullStatus = (typeof PULL_STATUSES)[number];

/** One pull request as the App draws it: a link, a title and a state. */
export type PullView = {
  readonly url: string;
  readonly title: string;
  readonly status: string;
  /** The host the row labels itself with, so any forge reads alike. */
  readonly host: string;
  readonly updatedAt: string;
};

/**
 * What the pull-request tools may do (docs/bots/EXTENSIONS-AND-TOOLS.md, coding group). The
 * daemon stores reports; it never asks a forge and never invents a state.
 */
export type PullToolHost = {
  readonly botId: string;
  register(input: {
    readonly opId: string;
    readonly url: string;
    readonly title: string;
    readonly status: string;
  }): Promise<{ readonly pull: PullView; readonly created: boolean }>;
  list(): Promise<readonly PullView[]>;
};
