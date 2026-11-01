// Domain types for Bots. No wire encoding, no pi-durable, no zod: this module is
// what every layer below the protocol agrees on.
// See docs/bots/PROTOCOL.md (entities) and docs/bots/ARCHITECTURE.md (ownership).

export type BotId = string;

/** Bot ids as the catalog, protocol and filesystem accept them. */
export const BOT_ID_PATTERN = /^b_[A-Za-z0-9_-]{1,64}$/;
export type EntryId = string;

export type BotState =
  | "catalogued"
  | "opening"
  | "idle"
  | "running"
  | "unavailable"
  | "quarantined";

export type BusyMode = "followUp" | "steer" | "reject";

export type ErrorKind =
  | "auth_failed"
  | "auth_scope"
  | "client_active"
  | "unknown_bot"
  | "invalid_command"
  | "limit_exceeded"
  | "version_mismatch"
  | "model_error"
  | "session_failed"
  | "task_faulted"
  | "task_parked"
  | "extension_error"
  | "storage_failed"
  | "internal";

/** Only `notAdmitted` lets a client drop an outbox entry and restore its text. */
export type ErrorDisposition = "not_admitted" | "unknown" | "runtime";

export type StopReason = "stop" | "length" | "toolUse" | "aborted" | "error" | "deferred";

export type TextBlock = { readonly type: "text"; readonly text: string };
export type ThinkingBlock = { readonly type: "thinking"; readonly text: string };
export type ToolCallBlock = {
  readonly type: "toolCall";
  readonly callId: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
};
export type ToolResultBlock = {
  readonly type: "toolResult";
  readonly callId: string;
  /** The tool the call named, so a row survives a page whose call was trimmed away. */
  readonly name: string;
  readonly text: string;
  readonly isError: boolean;
  /** How long the tool took, when pi recorded it. */
  readonly durationMs?: number;
};

export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | ToolResultBlock;

export type MessageRole = "user" | "assistant" | "notice" | "tool" | "system";

/**
 * Who admitted the input that produced a user message (docs/bots/TRIGGERS.md §6). Absent
 * means the daemon has no record — an older message, or one it never admitted — and the
 * wire reports that as `unknown`, never as `human`.
 */
export type MessageOrigin =
  | { readonly kind: "human"; readonly label?: string }
  | { readonly kind: "schedule"; readonly triggerId?: string; readonly label?: string }
  | { readonly kind: "webhook"; readonly triggerId?: string; readonly label?: string }
  | {
      readonly kind: "peer";
      readonly fromBotId?: string;
      /** The exchange this message belongs to, so a client folds the whole round trip. */
      readonly exchangeId?: string;
      readonly label?: string;
    }
  | { readonly kind: "unknown"; readonly label?: string };
export type MessageState = "streaming" | "complete" | "aborted" | "error";

export type Message = {
  readonly id: EntryId;
  readonly role: MessageRole;
  readonly state: MessageState;
  readonly createdAt: string;
  readonly blocks: readonly ContentBlock[];
  /** User messages only: ties the committed entry to the `send` that caused it. */
  readonly requestId?: string;
  /** User messages only: who admitted this input, when the daemon recorded it. */
  readonly origin?: MessageOrigin;
  readonly stopReason?: StopReason;
};

export type InboxItem = {
  readonly id: string;
  readonly mode: "followUp" | "steer" | "queue";
};

export type SubmissionStatus = "queued" | "placed" | "done" | "unanswered";

export type Submission = {
  readonly id: string;
  readonly requestId: string;
  readonly status: SubmissionStatus;
  /** `pi.user` entry, once placed. */
  readonly entryId?: string;
  /** `pi.assistant` entry, once done. */
  readonly answerEntryId?: string;
  /** Only on `unanswered`: `model_error`, `aborted`, `run_failed`, `stale`, `withdrawn`, … */
  readonly reason?: string;
};

/** What a client renders about one trigger; the prompt and the endpoint come over HTTP. */
export type TriggerSummary = {
  readonly id: string;
  readonly kind: "schedule" | "webhook";
  readonly name: string;
  readonly enabled: boolean;
  readonly schedule?: {
    readonly cron: string;
    readonly timezone: string;
    readonly nextDueAt?: string;
  };
  readonly counters: { readonly fired: number; readonly dropped: number; readonly refused: number };
  readonly lastFiredAt?: string;
  readonly lastSkipped?: { readonly at: string; readonly reason: string };
};

export type Usage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  /** What the provider reported as cost for these tokens, when it reports any. */
  readonly costUsd?: number;
};

/** One pull request a bot reported: a link, a title and a state (coding group). */
export type PullSummary = {
  readonly url: string;
  readonly title: string;
  /** draft, open, reviewing, merged, closed or failed. */
  readonly status: string;
  /** The row's label for any forge: github.com, dev.azure.com, … */
  readonly host: string;
  readonly updatedAt: string;
};

export type AgentView = {
  readonly model: { readonly provider: string; readonly modelId: string };
  readonly thinkingLevel: string;
  readonly instructions: string;
};

/** The closed sets the client and the daemon share for a bot's face. */
export const BOT_SHAPES = [
  "blob",
  "pebble",
  "squircle",
  "star",
  "cloud",
  "shield",
  "drop",
  "hex",
  "heart",
  "flower",
] as const;
export type BotShape = (typeof BOT_SHAPES)[number];

export const BOT_TINTS = [
  "paper",
  "clay",
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "sky",
  "blue",
  "violet",
  "pink",
  "graphite",
] as const;
export type BotTint = (typeof BOT_TINTS)[number];

/** How the client draws a bot: one shape and one tint from the closed sets. */
export type BotAppearance = {
  readonly shape: BotShape;
  readonly tint: BotTint;
};

export const DEFAULT_APPEARANCE: BotAppearance = { shape: "blob", tint: "green" };

/** A sidebar group real bots are filed under; groups live beside the catalog. */
export type BotGroup = {
  readonly id: string;
  readonly title: string;
};

export const MAX_BOT_GROUPS = 50;
export const MAX_GROUP_TITLE_CHARS = 40;
/** The one line a Bot writes about itself; normalized before it is measured. */
export const MAX_BOT_NOTE_CHARS = 120;

/** Trims and collapses whitespace runs; an empty result means the note is cleared. */
export const normalizeBotNote = (text: string): string | undefined => {
  const note = text.replace(/\s+/gu, " ").trim();
  return note.length === 0 ? undefined : note;
};

export type BotSummary = {
  readonly id: BotId;
  readonly title: string;
  /** Optional short label the user typed; never user content beyond this field. */
  readonly label?: string;
  /** The Bot's own one-line status; absent when it never set one. */
  readonly note?: string;
  /** Absent only in a catalog written before appearance existed. */
  readonly appearance?: BotAppearance;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly model: { readonly provider: string; readonly modelId: string };
  readonly state: BotState;
  /** Absent when the bot is not filed under a group. */
  readonly groupId?: string;
  readonly unavailable?: { readonly reason: ErrorKind; readonly message: string };
};

/** One live task of a bot, as the inspector's 任务 section shows it. */
export type TaskSummary = {
  readonly id: string;
  readonly kind: string;
  readonly status: "pending" | "running" | "waiting" | "sleeping" | "completing";
  readonly phase: string;
  readonly background: boolean;
  /** Why it cannot run here: a missing definition, an old version, or the restart limit. */
  readonly blocked?: string;
  /** The owning task, when this one is a child. */
  readonly owner?: string;
  readonly conversationId: string;
};

export type ConversationSnapshot = {
  readonly botId: BotId;
  readonly agent?: AgentView;
  /** Newest page, oldest first. Empty when `unavailable` is present. */
  readonly messages: readonly Message[];
  /** Present when older messages exist and are loadable through `history`. */
  readonly truncatedBefore?: EntryId;
  /** `null` when no attempt is in flight, including a withdrawn over-limit attempt. */
  readonly streaming: string | null;
  /** A task is parked and `recover` retries it; a new client needs this from the snapshot. */
  readonly parked?: boolean;
  /** Live work of every conversation this bot owns, for the inspector. */
  readonly tasks?: readonly TaskSummary[];
  /** The bot's own triggers, newest page of the sidebar's trigger section (TRIGGERS.md §8). */
  readonly triggers?: readonly TriggerSummary[];
  /** Pull requests the bot reported, newest first; the App never asks a forge. */
  readonly pulls?: readonly PullSummary[];
  readonly pending: readonly Submission[];
  readonly inbox: readonly InboxItem[];
  readonly running: boolean;
  readonly usage?: Usage;
  readonly unavailable?: { readonly reason: ErrorKind; readonly message: string };
};

export type DeltaChange =
  | { readonly kind: "text"; readonly index: number; readonly append: string }
  | { readonly kind: "thinking"; readonly index: number; readonly append: string }
  | {
      readonly kind: "toolcall";
      readonly index: number;
      readonly callId: string;
      readonly path: readonly (string | number)[];
      readonly append: string;
    }
  | { readonly kind: "block"; readonly index: number; readonly block: ContentBlock }
  | { readonly kind: "message"; readonly message: Message };

export type Capabilities = {
  readonly agent: boolean;
  readonly tools: boolean;
  readonly tasks: boolean;
  readonly entries: boolean;
  readonly usage: boolean;
  readonly peers: boolean;
  readonly triggers: boolean;
};

export const ALL_CAPABILITIES_OFF: Capabilities = {
  agent: false,
  tools: false,
  tasks: false,
  entries: false,
  usage: true,
  peers: false,
  triggers: false,
};

/** Every domain failure crosses layers with one identity minted by its classifier. */
export type Failure = {
  readonly id: string;
  readonly kind: ErrorKind;
  readonly layer: "transport" | "protocol" | "core" | "runtime" | "pi";
};

/**
 * A failure a layer already classified. The identity and the disposition travel with it,
 * so an upper layer rethrows instead of minting a second failure for one episode. It
 * lives in the domain so adapters can throw it without depending on the service.
 */
export class ClassifiedFailure extends Error {
  readonly failure: Failure;
  readonly disposition: ErrorDisposition;

  constructor(
    failure: Failure,
    disposition: ErrorDisposition,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ClassifiedFailure";
    this.failure = failure;
    this.disposition = disposition;
  }
}

/** A bot as the catalog stores it. Runtime state is not persisted here. */
export type BotRecord = {
  readonly id: BotId;
  readonly title: string;
  readonly label?: string;
  /** The Bot's own one-line status; absent means it never set one. */
  readonly note?: string;
  /** Absent in catalogs written before appearance existed; defaults on load. */
  readonly appearance?: BotAppearance;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly model: { readonly provider: string; readonly modelId: string };
};

/** The reasoning levels pi accepts; `medium` is the product default. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

export const isThinkingLevel = (value: unknown): value is ThinkingLevel =>
  typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);

export const TOOL_GROUP_NAMES = [
  "persona",
  "machine",
  "core",
  "coding",
  "herdr",
  "agents",
  "search",
  "trigger",
  "peers",
] as const;

export type ToolGroup = (typeof TOOL_GROUP_NAMES)[number];

export const MANDATORY_TOOL_GROUPS: readonly ToolGroup[] = ["core", "coding"];

/** What a daemon with no stored choice runs: the two core prompts come before the tools. */
export const DEFAULT_TOOL_GROUPS: readonly ToolGroup[] = [
  "persona",
  "machine",
  "core",
  "coding",
  "herdr",
  "agents",
  "trigger",
];

export const isToolGroup = (value: unknown): value is ToolGroup =>
  typeof value === "string" && (TOOL_GROUP_NAMES as readonly string[]).includes(value);

/** A stored selection, normalized: mandatory groups always present, order stable. */
export const resolveToolGroups = (names: readonly string[] | undefined): readonly ToolGroup[] => {
  const chosen = new Set<ToolGroup>(MANDATORY_TOOL_GROUPS);
  for (const name of names ?? []) if (isToolGroup(name)) chosen.add(name);
  return TOOL_GROUP_NAMES.filter((name) => chosen.has(name));
};
