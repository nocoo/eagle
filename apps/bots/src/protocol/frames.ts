// Wire ⇄ domain for protocol v1 (docs/bots/PROTOCOL.md). Strict on everything the
// contract calls required, tolerant only of *unknown* fields, which are dropped on
// encode. Nothing reaches a domain type without passing its closed union.

import type {
  AgentView,
  BotGroup,
  BotSummary,
  ContentBlock,
  ConversationSnapshot,
  DeltaChange,
  ErrorDisposition,
  ErrorKind,
  InboxItem,
  Message,
  MessageOrigin,
  MessageRole,
  MessageState,
  PullSummary,
  StopReason,
  Submission,
  SubmissionStatus,
  TaskSummary,
  TriggerSummary,
  Usage,
} from "../core/domain.ts";
import { BOT_SHAPES, BOT_TINTS } from "../core/domain.ts";
import { PROTOCOL_VERSION } from "./version.ts";

export type ClientCommand =
  | { readonly type: "hello"; readonly protocolVersion: number; readonly client: string }
  | {
      readonly type: "subscribe";
      readonly botId: string;
      readonly contextId?: string;
      readonly trace: string;
    }
  | {
      readonly type: "send";
      readonly requestId: string;
      readonly text: string;
      readonly resourceHead?: string;
      readonly contextId?: string;
      readonly whenBusy: "followUp" | "steer" | "reject";
      readonly trace: string;
    }
  | { readonly type: "abort"; readonly trace: string }
  | { readonly type: "recover"; readonly trace: string }
  | { readonly type: "resync"; readonly trace: string }
  | {
      readonly type: "history";
      readonly before: string;
      readonly limit: number;
      readonly trace: string;
    }
  | { readonly type: "ping" };

export type SessionErrorKind = Exclude<ErrorKind, "version_mismatch">;

export type ServerEvent =
  | {
      readonly type: "welcome";
      readonly protocolVersion: number;
      readonly server: {
        readonly version: string;
        readonly instance: string;
        readonly pid: number;
      };
      readonly capabilities: Readonly<Record<string, boolean>>;
      readonly bots: readonly BotSummary[];
      readonly groups?: readonly BotGroup[];
    }
  | {
      readonly type: "snapshot";
      readonly rev: number;
      readonly trace: string;
      readonly value: ConversationSnapshot;
    }
  | {
      readonly type: "append";
      readonly rev: number;
      readonly trace: string;
      readonly message: Message;
      readonly replaces?: string;
    }
  | {
      readonly type: "delta";
      readonly rev: number;
      readonly trace: string;
      readonly messageId: string;
      readonly changes: readonly DeltaChange[];
    }
  | {
      readonly type: "status";
      readonly rev: number;
      readonly trace: string;
      readonly running: boolean;
      readonly streaming: string | null;
      readonly inbox: readonly InboxItem[];
    }
  | {
      readonly type: "submission";
      readonly rev?: number;
      readonly trace: string;
      readonly record: Submission;
    }
  | {
      readonly type: "bots";
      readonly bots: readonly BotSummary[];
      /** The sidebar groups, in display order; absent in a catalog that has none. */
      readonly groups?: readonly BotGroup[];
    }
  | {
      readonly type: "tasks";
      readonly rev: number;
      readonly trace: string;
      readonly tasks: readonly TaskSummary[];
    }
  | {
      readonly type: "triggers";
      readonly rev: number;
      readonly trace: string;
      readonly triggers: readonly TriggerSummary[];
    }
  | {
      readonly type: "pulls";
      readonly rev: number;
      readonly trace: string;
      readonly pulls: readonly PullSummary[];
    }
  | {
      readonly type: "usage";
      readonly rev: number;
      readonly trace: string;
      readonly usage: Usage;
    }
  | {
      readonly type: "agent";
      readonly rev: number;
      readonly trace: string;
      readonly agent: AgentView;
    }
  | {
      readonly type: "history";
      readonly trace: string;
      readonly messages: readonly Message[];
      readonly hasMore: boolean;
    }
  | {
      readonly type: "error";
      readonly rev?: number;
      readonly trace: string;
      readonly kind: SessionErrorKind;
      readonly disposition: ErrorDisposition;
      readonly failure: string;
      readonly message: string;
      readonly requestId?: string;
      readonly taskId?: string;
    }
  | {
      readonly type: "error";
      readonly kind: "version_mismatch";
      readonly message: string;
      readonly server: { readonly protocolVersion: number };
    }
  | { readonly type: "pong" }
  /** An event type this version does not know. Its envelope is preserved so the
   *  revision is consumed rather than mistaken for a gap (PROTOCOL I8). */
  | {
      readonly type: "unknown";
      readonly rawType: string;
      readonly rev?: number;
      readonly trace?: string;
    };

export type FrameErrorReason =
  | "invalid_json"
  | "invalid_command"
  | "invalid_event"
  | "version_mismatch"
  | "limit_exceeded";

export class FrameError extends Error {
  readonly reason: FrameErrorReason;

  constructor(reason: FrameErrorReason, message: string) {
    super(message);
    this.name = "FrameError";
    this.reason = reason;
  }
}

const ERROR_KINDS: readonly ErrorKind[] = [
  "auth_failed",
  "unknown_bot",
  "invalid_command",
  "limit_exceeded",
  "version_mismatch",
  "model_error",
  "session_failed",
  "task_faulted",
  "task_parked",
  "extension_error",
  "storage_failed",
  "internal",
];
const DISPOSITIONS: readonly ErrorDisposition[] = ["not_admitted", "unknown", "runtime"];
const ROLES: readonly MessageRole[] = ["user", "assistant", "notice", "tool", "system"];
const STATES: readonly MessageState[] = ["streaming", "complete", "aborted", "error"];
const STOP_REASONS: readonly StopReason[] = [
  "stop",
  "length",
  "toolUse",
  "aborted",
  "error",
  "deferred",
];
const SUBMISSION_STATUSES: readonly SubmissionStatus[] = ["queued", "placed", "done", "unanswered"];
const INBOX_MODES: readonly InboxItem["mode"][] = ["followUp", "steer", "queue"];
const BOT_STATES: readonly BotSummary["state"][] = [
  "catalogued",
  "opening",
  "idle",
  "running",
  "unavailable",
  "quarantined",
];

/** Decode context decides whether a schema fault is a client or a server error. */
type Ctx = "command" | "event";

function fail(ctx: Ctx, message: string): never {
  throw new FrameError(ctx === "command" ? "invalid_command" : "invalid_event", message);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const present = (o: Record<string, unknown>, key: string): boolean =>
  Object.hasOwn(o, key) && o[key] !== undefined;

const str = (ctx: Ctx, v: unknown, what: string): string => {
  if (typeof v !== "string" || v.length === 0) fail(ctx, `${what} must be a non-empty string`);
  return v as string;
};

const anyStr = (ctx: Ctx, v: unknown, what: string): string => {
  if (typeof v !== "string") fail(ctx, `${what} must be a string`);
  return v as string;
};

const optStr = (ctx: Ctx, v: unknown, what: string): string | undefined =>
  v === undefined ? undefined : anyStr(ctx, v, what);

const int = (ctx: Ctx, v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) fail(ctx, `${what} must be an integer`);
  return v as number;
};

const nonNegative = (ctx: Ctx, v: unknown, what: string): number => {
  const value = int(ctx, v, what);
  if (value < 0) fail(ctx, `${what} must not be negative`);
  return value;
};

const bool = (ctx: Ctx, v: unknown, what: string): boolean => {
  if (typeof v !== "boolean") fail(ctx, `${what} must be a boolean`);
  return v as boolean;
};

const arr = (ctx: Ctx, v: unknown, what: string): readonly unknown[] => {
  if (!Array.isArray(v)) fail(ctx, `${what} must be an array`);
  return v as readonly unknown[];
};

const oneOf = <T extends string>(ctx: Ctx, v: unknown, values: readonly T[], what: string): T => {
  if (typeof v !== "string" || !values.includes(v as T)) fail(ctx, `${what} is not a known value`);
  return v as T;
};

const required = (ctx: Ctx, o: Record<string, unknown>, key: string): unknown => {
  if (!present(o, key)) fail(ctx, `${key} is required`);
  return o[key];
};

export function parseJson(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new FrameError("invalid_json", "frame is not JSON");
  }
  if (!isObject(value)) throw new FrameError("invalid_json", "frame must be an object");
  return value;
}

export function decodeCommand(raw: Record<string, unknown>): ClientCommand {
  const ctx: Ctx = "command";
  const type = str(ctx, raw.type, "type");
  switch (type) {
    case "hello":
      return {
        type: "hello",
        protocolVersion: int(ctx, raw.protocolVersion, "protocolVersion"),
        client: str(ctx, raw.client, "client"),
      };
    case "subscribe":
      return {
        type,
        botId: str(ctx, raw.botId, "botId"),
        ...(raw.contextId === undefined ? {} : { contextId: str(ctx, raw.contextId, "contextId") }),
        trace: str(ctx, raw.trace, "trace"),
      };
    case "send": {
      // Only an omitted whenBusy defaults; an explicit null is a client bug.
      const whenBusy =
        raw.whenBusy === undefined
          ? "followUp"
          : oneOf(ctx, raw.whenBusy, ["followUp", "steer", "reject"] as const, "whenBusy");
      return {
        type,
        requestId: str(ctx, raw.requestId, "requestId"),
        text: anyStr(ctx, required(ctx, raw, "text"), "text"),
        ...(raw.contextId === undefined ? {} : { contextId: str(ctx, raw.contextId, "contextId") }),
        ...(raw.resourceHead === undefined
          ? {}
          : { resourceHead: str(ctx, raw.resourceHead, "resourceHead") }),
        whenBusy,
        trace: str(ctx, raw.trace, "trace"),
      };
    }
    case "abort":
    case "recover":
    case "resync":
      return { type, trace: str(ctx, raw.trace, "trace") };
    case "history":
      return {
        type,
        before: str(ctx, raw.before, "before"),
        limit: int(ctx, raw.limit, "limit"),
        trace: str(ctx, raw.trace, "trace"),
      };
    case "ping":
      return { type: "ping" };
    default:
      return fail(ctx, `unknown command ${type}`);
  }
}

const decodeBlock = (ctx: Ctx, raw: unknown): ContentBlock => {
  if (!isObject(raw)) fail(ctx, "block must be an object");
  const type = str(ctx, raw.type, "block.type");
  if (type === "text") return { type: "text", text: anyStr(ctx, raw.text, "block.text") };
  if (type === "thinking") return { type: "thinking", text: anyStr(ctx, raw.text, "block.text") };
  if (type === "toolCall") {
    const args = required(ctx, raw, "args");
    if (!isObject(args)) fail(ctx, "block.args must be an object");
    return {
      type: "toolCall",
      callId: str(ctx, raw.callId, "block.callId"),
      name: str(ctx, raw.name, "block.name"),
      args: args as Record<string, unknown>,
    };
  }
  if (type === "toolResult") {
    const durationMs =
      raw.durationMs === undefined ? undefined : int(ctx, raw.durationMs, "block.durationMs");
    if (durationMs !== undefined && durationMs < 0) {
      fail(ctx, "block.durationMs must not be negative");
    }
    return {
      type: "toolResult",
      callId: str(ctx, raw.callId, "block.callId"),
      name: str(ctx, raw.name, "block.name"),
      text: anyStr(ctx, raw.text, "block.text"),
      isError: bool(ctx, raw.isError, "block.isError"),
      ...(durationMs === undefined ? {} : { durationMs }),
    };
  }
  return fail(ctx, `unknown block type ${type}`);
};

const ORIGIN_KINDS = ["human", "schedule", "webhook", "peer", "unknown"] as const;

/** Additive (PROTOCOL.md v1): a client that predates `origin` simply never sees it. */
const decodeOrigin = (ctx: Ctx, raw: unknown): MessageOrigin => {
  if (!isObject(raw)) fail(ctx, "message.origin must be an object");
  const kind = oneOf(ctx, raw.kind, ORIGIN_KINDS, "message.origin.kind");
  const label =
    raw.label === undefined ? undefined : anyStr(ctx, raw.label, "message.origin.label");
  const exchangeId =
    raw.exchangeId === undefined
      ? undefined
      : anyStr(ctx, raw.exchangeId, "message.origin.exchangeId");
  return {
    kind,
    ...(exchangeId === undefined ? {} : { exchangeId }),
    ...(label === undefined ? {} : { label }),
  } as MessageOrigin;
};

/** Additive (PROTOCOL.md v1): a client that predates `pulls` simply never sees them. */
const decodePull = (ctx: Ctx, raw: unknown): PullSummary => {
  if (!isObject(raw)) fail(ctx, "pull must be an object");
  return {
    url: str(ctx, raw.url, "pull.url"),
    title: anyStr(ctx, raw.title, "pull.title"),
    status: anyStr(ctx, raw.status, "pull.status"),
    host: anyStr(ctx, raw.host, "pull.host"),
    updatedAt: anyStr(ctx, raw.updatedAt, "pull.updatedAt"),
  };
};

const TRIGGER_KINDS = ["schedule", "webhook"] as const;
const SKIP_REASONS = ["disabled", "missed", "rate_limited", "queue_full"] as const;

const decodeTriggerSummary = (ctx: Ctx, raw: unknown): TriggerSummary => {
  if (!isObject(raw)) fail(ctx, "trigger must be an object");
  const schedule = raw.schedule === undefined ? undefined : raw.schedule;
  if (schedule !== undefined && !isObject(schedule))
    fail(ctx, "trigger.schedule must be an object");
  const counters = raw.counters;
  if (!isObject(counters)) fail(ctx, "trigger.counters must be an object");
  const lastSkipped = raw.lastSkipped;
  if (lastSkipped !== undefined && !isObject(lastSkipped)) {
    fail(ctx, "trigger.lastSkipped must be an object");
  }
  return {
    id: str(ctx, raw.id, "trigger.id"),
    kind: oneOf(ctx, raw.kind, TRIGGER_KINDS, "trigger.kind"),
    name: anyStr(ctx, raw.name, "trigger.name"),
    enabled: bool(ctx, raw.enabled, "trigger.enabled"),
    ...(schedule === undefined
      ? {}
      : {
          schedule: {
            cron: anyStr(ctx, (schedule as Record<string, unknown>).cron, "trigger.schedule.cron"),
            timezone: anyStr(
              ctx,
              (schedule as Record<string, unknown>).timezone,
              "trigger.schedule.timezone",
            ),
            ...((schedule as Record<string, unknown>).nextDueAt === undefined
              ? {}
              : {
                  nextDueAt: anyStr(
                    ctx,
                    (schedule as Record<string, unknown>).nextDueAt,
                    "trigger.schedule.nextDueAt",
                  ),
                }),
          },
        }),
    counters: {
      fired: int(ctx, (counters as Record<string, unknown>).fired, "trigger.counters.fired"),
      dropped: int(ctx, (counters as Record<string, unknown>).dropped, "trigger.counters.dropped"),
      refused: int(ctx, (counters as Record<string, unknown>).refused, "trigger.counters.refused"),
    },
    ...(raw.lastFiredAt === undefined
      ? {}
      : { lastFiredAt: anyStr(ctx, raw.lastFiredAt, "trigger.lastFiredAt") }),
    ...(lastSkipped === undefined
      ? {}
      : {
          lastSkipped: {
            at: anyStr(ctx, (lastSkipped as Record<string, unknown>).at, "trigger.lastSkipped.at"),
            reason: oneOf(
              ctx,
              (lastSkipped as Record<string, unknown>).reason,
              SKIP_REASONS,
              "trigger.lastSkipped.reason",
            ),
          },
        }),
  };
};

const decodeMessage = (ctx: Ctx, raw: unknown): Message => {
  if (!isObject(raw)) fail(ctx, "message must be an object");
  const role = oneOf(ctx, raw.role, ROLES, "message.role");
  const requestId =
    raw.requestId === undefined ? undefined : anyStr(ctx, raw.requestId, "message.requestId");
  if (requestId !== undefined && !/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) {
    fail(ctx, "message.requestId is malformed");
  }
  if (requestId !== undefined && role !== "user") {
    fail(ctx, "requestId belongs to user messages only");
  }
  const stopReason =
    raw.stopReason === undefined
      ? undefined
      : oneOf(ctx, raw.stopReason, STOP_REASONS, "message.stopReason");
  const origin = raw.origin === undefined ? undefined : decodeOrigin(ctx, raw.origin);
  if (origin !== undefined && role !== "user") {
    fail(ctx, "origin belongs to user messages only");
  }
  return {
    id: str(ctx, raw.id, "message.id"),
    role,
    state: oneOf(ctx, raw.state, STATES, "message.state"),
    createdAt: str(ctx, raw.createdAt, "message.createdAt"),
    blocks: arr(ctx, raw.blocks, "message.blocks").map((b) => decodeBlock(ctx, b)),
    ...(requestId === undefined ? {} : { requestId }),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(origin === undefined ? {} : { origin }),
  };
};

const decodeUsage = (ctx: Ctx, raw: unknown): Usage => {
  if (!isObject(raw)) fail(ctx, "usage must be an object");
  const costUsd =
    raw.costUsd === undefined ? undefined : nonNegative(ctx, raw.costUsd, "usage.costUsd");
  return {
    inputTokens: nonNegative(ctx, raw.inputTokens, "usage.inputTokens"),
    outputTokens: nonNegative(ctx, raw.outputTokens, "usage.outputTokens"),
    totalTokens: nonNegative(ctx, raw.totalTokens, "usage.totalTokens"),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
};

const decodeInboxItem = (ctx: Ctx, raw: unknown): InboxItem => {
  if (!isObject(raw)) fail(ctx, "inbox item must be an object");
  return {
    id: str(ctx, raw.id, "inbox.id"),
    mode: oneOf(ctx, raw.mode, INBOX_MODES, "inbox.mode"),
  };
};

const decodeSubmission = (ctx: Ctx, raw: unknown): Submission => {
  if (!isObject(raw)) fail(ctx, "submission must be an object");
  const status = oneOf(ctx, raw.status, SUBMISSION_STATUSES, "submission.status");
  const entryId = optStr(ctx, raw.entryId, "submission.entryId");
  const answerEntryId = optStr(ctx, raw.answerEntryId, "submission.answerEntryId");
  const reason = optStr(ctx, raw.reason, "submission.reason");
  for (const [id, what] of [
    [entryId, "submission.entryId"],
    [answerEntryId, "submission.answerEntryId"],
  ] as const) {
    if (id !== undefined && !/^e_[A-Za-z0-9_-]{1,64}$/.test(id))
      fail(ctx, `${what} is not a committed entry`);
  }
  if (reason !== undefined && reason.trim().length === 0) fail(ctx, "submission.reason is empty");
  if (status === "queued" && (entryId !== undefined || answerEntryId !== undefined)) {
    fail(ctx, "queued submissions have no entries");
  }
  if (status === "placed" && (entryId === undefined || answerEntryId !== undefined)) {
    fail(ctx, "placed submissions have entryId only");
  }
  if (status === "done" && (entryId === undefined || answerEntryId === undefined)) {
    fail(ctx, "done submissions have entryId and answerEntryId");
  }
  if (status === "unanswered" && (reason === undefined || answerEntryId !== undefined)) {
    fail(ctx, "unanswered submissions have reason and no answer");
  }
  if (status !== "unanswered" && reason !== undefined) {
    fail(ctx, "reason belongs to unanswered submissions only");
  }
  return {
    id: str(ctx, raw.submissionId, "submission.submissionId"),
    requestId: (() => {
      const requestId = str(ctx, raw.requestId, "submission.requestId");
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) fail(ctx, "submission.requestId is malformed");
      return requestId;
    })(),
    status,
    ...(entryId === undefined ? {} : { entryId }),
    ...(answerEntryId === undefined ? {} : { answerEntryId }),
    ...(reason === undefined ? {} : { reason }),
  };
};

const decodeAgent = (ctx: Ctx, raw: unknown): AgentView => {
  if (!isObject(raw)) fail(ctx, "agent must be an object");
  const model = isObject(raw.model) ? raw.model : {};
  const provider = str(ctx, model.provider, "agent.model.provider");
  const modelId = str(ctx, model.modelId, "agent.model.modelId");
  const thinkingLevel = anyStr(ctx, raw.thinkingLevel, "agent.thinkingLevel");
  const instructions = anyStr(ctx, raw.instructions, "agent.instructions");
  if (Array.from(instructions).length > 4_000)
    fail(ctx, "agent.instructions exceeds 4000 characters");
  return { model: { provider, modelId }, thinkingLevel, instructions };
};

const decodeSnapshot = (ctx: Ctx, raw: unknown): ConversationSnapshot => {
  if (!isObject(raw)) fail(ctx, "snapshot value must be an object");
  const streamingRaw = required(ctx, raw, "streaming");
  let streaming: string | null;
  if (streamingRaw === null) streaming = null;
  else if (isObject(streamingRaw))
    streaming = str(ctx, streamingRaw.messageId, "streaming.messageId");
  else return fail(ctx, "streaming must be null or an object");

  const messages = arr(ctx, required(ctx, raw, "messages"), "messages").map((m) =>
    decodeMessage(ctx, m),
  );
  if (streaming !== null) {
    const target = messages.find((m) => m.id === streaming);
    if (target === undefined) fail(ctx, "streaming id must be one of the snapshot messages");
    if (target?.state !== "streaming")
      fail(ctx, "the streaming message must be in streaming state");
  }

  const truncatedBefore =
    raw.truncatedBefore === undefined
      ? undefined
      : str(ctx, raw.truncatedBefore, "truncatedBefore");
  if (present(raw, "agent") && !isObject(raw.agent)) fail(ctx, "agent must be an object");
  if (present(raw, "unavailable") && !isObject(raw.unavailable)) {
    fail(ctx, "unavailable must be an object");
  }
  const agent = isObject(raw.agent) ? decodeAgent(ctx, raw.agent) : undefined;
  const unavailable = isObject(raw.unavailable)
    ? {
        reason: oneOf(ctx, raw.unavailable.reason, ERROR_KINDS, "unavailable.reason"),
        message: anyStr(ctx, raw.unavailable.message, "unavailable.message"),
      }
    : undefined;

  const parked = present(raw, "parked") ? bool(ctx, raw.parked, "parked") : undefined;
  const pending = arr(ctx, required(ctx, raw, "pending"), "pending").map((p) =>
    decodeSubmission(ctx, p),
  );
  const inbox = arr(ctx, required(ctx, raw, "inbox"), "inbox").map((i) => decodeInboxItem(ctx, i));
  const running = bool(ctx, required(ctx, raw, "running"), "running");

  // State relations the contract requires of every snapshot.
  if (pending.some((record) => record.status === "done" || record.status === "unanswered")) {
    fail(ctx, "pending holds admitted, unsettled submissions only");
  }
  if (unavailable !== undefined) {
    if (
      messages.length > 0 ||
      pending.length > 0 ||
      inbox.length > 0 ||
      running ||
      streaming !== null
    ) {
      fail(ctx, "an unavailable snapshot has unknown collections, so they must be empty");
    }
  }

  return {
    botId: str(ctx, raw.botId, "botId"),
    messages,
    streaming,
    pending,
    inbox,
    running,
    ...(truncatedBefore === undefined ? {} : { truncatedBefore }),
    ...(parked === undefined ? {} : { parked }),
    ...(raw.usage === undefined ? {} : { usage: decodeUsage(ctx, raw.usage) }),
    ...(raw.tasks === undefined
      ? {}
      : { tasks: arr(ctx, raw.tasks, "tasks").map((task) => decodeTaskSummary(ctx, task)) }),
    ...(raw.triggers === undefined
      ? {}
      : {
          triggers: arr(ctx, raw.triggers, "triggers").map((trigger) =>
            decodeTriggerSummary(ctx, trigger),
          ),
        }),
    ...(raw.pulls === undefined
      ? {}
      : { pulls: arr(ctx, raw.pulls, "pulls").map((pull) => decodePull(ctx, pull)) }),
    ...(agent === undefined ? {} : { agent }),
    ...(unavailable === undefined ? {} : { unavailable }),
  };
};

const decodeDeltaChange = (ctx: Ctx, raw: unknown): DeltaChange => {
  if (!isObject(raw)) fail(ctx, "delta change must be an object");
  const kind = str(ctx, raw.kind, "change.kind");
  if (kind === "message")
    return { kind, message: decodeMessage(ctx, required(ctx, raw, "message")) };
  // Block-scoped changes all name their index; `message` is the documented exception.
  const index = nonNegative(ctx, required(ctx, raw, "index"), "change.index");
  if (kind === "text" || kind === "thinking") {
    return { kind, index, append: anyStr(ctx, raw.append, "change.append") };
  }
  if (kind === "toolcall") {
    const path = arr(ctx, required(ctx, raw, "path"), "change.path").map((part, position) => {
      if (typeof part === "string") return part;
      if (typeof part === "number" && Number.isSafeInteger(part)) return part;
      return fail(ctx, `change.path[${position}] must be a string or an integer`);
    });
    return {
      kind,
      index,
      callId: str(ctx, raw.callId, "change.callId"),
      path,
      append: anyStr(ctx, raw.append, "change.append"),
    };
  }
  if (kind === "block") return { kind, index, block: decodeBlock(ctx, raw.block) };
  return fail(ctx, `unknown change kind ${kind}`);
};

const welcomeGroups = (
  ctx: Ctx,
  raw: Record<string, unknown>,
): { groups?: readonly BotGroup[] } => {
  const groups = decodeGroups(ctx, raw);
  return groups === undefined ? {} : { groups };
};

const TASK_STATUSES = ["pending", "running", "waiting", "sleeping", "completing"] as const;

const decodeTaskSummary = (ctx: Ctx, raw: unknown): TaskSummary => {
  if (!isObject(raw)) fail(ctx, "task must be an object");
  const blocked = present(raw, "blocked") ? str(ctx, raw.blocked, "task.blocked") : undefined;
  const owner = present(raw, "owner") ? str(ctx, raw.owner, "task.owner") : undefined;
  return {
    id: str(ctx, raw.id, "task.id"),
    kind: str(ctx, raw.kind, "task.kind"),
    status: oneOf(ctx, raw.status, TASK_STATUSES, "task.status"),
    phase: anyStr(ctx, raw.phase, "task.phase"),
    background: bool(ctx, raw.background, "task.background"),
    ...(blocked === undefined ? {} : { blocked }),
    ...(owner === undefined ? {} : { owner }),
    conversationId: str(ctx, raw.conversationId, "task.conversationId"),
  };
};

const decodeBotGroup = (ctx: Ctx, raw: unknown): BotGroup => {
  if (!isObject(raw)) fail(ctx, "group must be an object");
  return { id: str(ctx, raw.id, "group.id"), title: str(ctx, raw.title, "group.title") };
};

const decodeGroups = (ctx: Ctx, raw: Record<string, unknown>): readonly BotGroup[] | undefined =>
  present(raw, "groups") === false
    ? undefined
    : arr(ctx, raw.groups, "groups").map((group) => decodeBotGroup(ctx, group));

const decodeBotSummary = (ctx: Ctx, raw: unknown): BotSummary => {
  if (!isObject(raw)) fail(ctx, "bot must be an object");
  const model = isObject(raw.model) ? raw.model : {};
  if (present(raw, "unavailable") && !isObject(raw.unavailable)) {
    fail(ctx, "bot.unavailable must be an object when present");
  }
  const unavailable = isObject(raw.unavailable)
    ? {
        reason: oneOf(ctx, raw.unavailable.reason, ERROR_KINDS, "bot.unavailable.reason"),
        message: anyStr(ctx, raw.unavailable.message, "bot.unavailable.message"),
      }
    : undefined;
  const state = oneOf(ctx, raw.state, BOT_STATES, "bot.state");
  if (state === "unavailable" && unavailable === undefined) {
    fail(ctx, "an unavailable bot must carry its reason");
  }
  if (state !== "unavailable" && unavailable !== undefined) {
    fail(ctx, "only an unavailable bot carries a reason");
  }
  const label = present(raw, "label") ? str(ctx, raw.label, "bot.label") : undefined;
  let appearance: BotSummary["appearance"];
  if (present(raw, "appearance")) {
    const face = raw.appearance;
    if (!isObject(face)) fail(ctx, "bot.appearance must be an object");
    appearance = {
      shape: oneOf(ctx, face.shape, BOT_SHAPES, "bot.appearance.shape"),
      tint: oneOf(ctx, face.tint, BOT_TINTS, "bot.appearance.tint"),
    };
  }
  const groupId = present(raw, "groupId") ? str(ctx, raw.groupId, "bot.groupId") : undefined;
  return {
    id: str(ctx, raw.id, "bot.id"),
    title: str(ctx, raw.title, "bot.title"),
    ...(groupId === undefined ? {} : { groupId }),
    ...(label === undefined ? {} : { label }),
    ...(appearance === undefined ? {} : { appearance }),
    createdAt: str(ctx, raw.createdAt, "bot.createdAt"),
    updatedAt: str(ctx, raw.updatedAt, "bot.updatedAt"),
    model: {
      provider: str(ctx, model.provider, "bot.model.provider"),
      modelId: str(ctx, model.modelId, "bot.model.modelId"),
    },
    state,
    ...(unavailable === undefined ? {} : { unavailable }),
  };
};

const envelope = (ctx: Ctx, raw: Record<string, unknown>) => ({
  rev: present(raw, "rev") ? nonNegative(ctx, raw.rev, "rev") : undefined,
  trace: present(raw, "trace") ? str(ctx, raw.trace, "trace") : undefined,
});

const requireEnvelope = (ctx: Ctx, raw: Record<string, unknown>, rev: boolean) => {
  const { rev: revision, trace } = envelope(ctx, raw);
  if (trace === undefined) fail(ctx, "trace is required");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(trace as string)) fail(ctx, "trace is malformed");
  if (rev && revision === undefined) fail(ctx, "rev is required");
  return { trace: trace as string, rev: revision };
};

export function decodeServerEvent(raw: Record<string, unknown>): ServerEvent {
  const ctx: Ctx = "event";
  const type = str(ctx, raw.type, "type");

  switch (type) {
    case "welcome": {
      const serverRaw = required(ctx, raw, "server");
      if (!isObject(serverRaw)) fail(ctx, "server must be an object");
      const server = serverRaw as Record<string, unknown>;
      const capabilitiesValue = required(ctx, raw, "capabilities");
      if (!isObject(capabilitiesValue)) fail(ctx, "capabilities must be an object");
      const capabilitiesRaw = capabilitiesValue as Record<string, unknown>;
      const capabilities: Record<string, boolean> = {};
      for (const name of ["agent", "tools", "tasks", "entries", "usage", "peers", "triggers"]) {
        capabilities[name] = bool(
          ctx,
          required(ctx, capabilitiesRaw, name),
          `capabilities.${name}`,
        );
      }
      return {
        type,
        protocolVersion: int(ctx, required(ctx, raw, "protocolVersion"), "protocolVersion"),
        server: {
          version: str(ctx, server.version, "server.version"),
          instance: str(ctx, server.instance, "server.instance"),
          pid: int(ctx, server.pid, "server.pid"),
        },
        capabilities,
        bots: arr(ctx, required(ctx, raw, "bots"), "bots").map((b) => decodeBotSummary(ctx, b)),
        ...welcomeGroups(ctx, raw),
      };
    }
    case "snapshot": {
      const { rev, trace } = requireEnvelope(ctx, raw, true);
      return {
        type,
        rev: rev as number,
        trace,
        value: decodeSnapshot(ctx, required(ctx, raw, "value")),
      };
    }
    case "append": {
      const { rev, trace } = requireEnvelope(ctx, raw, true);
      const replaces = optStr(ctx, raw.replaces, "replaces");
      const message = decodeMessage(ctx, required(ctx, raw, "message"));
      return replaces === undefined
        ? { type, rev: rev as number, trace, message }
        : { type, rev: rev as number, trace, message, replaces };
    }
    case "delta": {
      const { rev, trace } = requireEnvelope(ctx, raw, true);
      return {
        type,
        rev: rev as number,
        trace,
        messageId: str(ctx, required(ctx, raw, "messageId"), "messageId"),
        changes: arr(ctx, required(ctx, raw, "changes"), "changes").map((c) =>
          decodeDeltaChange(ctx, c),
        ),
      };
    }
    case "status": {
      const { rev, trace } = requireEnvelope(ctx, raw, true);
      const streamingRaw = required(ctx, raw, "streaming");
      const streaming = streamingRaw === null ? null : anyStr(ctx, streamingRaw, "streaming");
      return {
        type,
        rev: rev as number,
        trace,
        running: bool(ctx, required(ctx, raw, "running"), "running"),
        streaming,
        inbox: arr(ctx, required(ctx, raw, "inbox"), "inbox").map((i) => decodeInboxItem(ctx, i)),
      };
    }
    case "submission": {
      const { trace, rev } = requireEnvelope(ctx, raw, false);
      const record = decodeSubmission(ctx, raw);
      return rev === undefined ? { type, trace, record } : { type, rev, trace, record };
    }
    case "bots": {
      const groups = decodeGroups(ctx, raw);
      return {
        type,
        bots: arr(ctx, required(ctx, raw, "bots"), "bots").map((b) => decodeBotSummary(ctx, b)),
        ...(groups === undefined ? {} : { groups }),
      };
    }
    case "usage": {
      const { rev, trace } = requireEnvelope(ctx, raw, true);
      return {
        type,
        rev: rev as number,
        trace,
        usage: decodeUsage(ctx, required(ctx, raw, "usage")),
      };
    }
    case "agent": {
      const { rev, trace } = requireEnvelope(ctx, raw, true);
      return {
        type,
        rev: rev as number,
        trace,
        agent: decodeAgent(ctx, required(ctx, raw, "agent")),
      };
    }
    case "tasks": {
      const { rev, trace } = requireEnvelope(ctx, raw, true);
      return {
        type,
        rev: rev as number,
        trace,
        tasks: arr(ctx, required(ctx, raw, "tasks"), "tasks").map((task) =>
          decodeTaskSummary(ctx, task),
        ),
      };
    }
    case "pulls": {
      const { rev, trace } = requireEnvelope(ctx, raw, true);
      return {
        type,
        rev: rev as number,
        trace,
        pulls: arr(ctx, required(ctx, raw, "pulls"), "pulls").map((pull) => decodePull(ctx, pull)),
      };
    }
    case "triggers": {
      const { rev, trace } = requireEnvelope(ctx, raw, true);
      return {
        type,
        rev: rev as number,
        trace,
        triggers: arr(ctx, required(ctx, raw, "triggers"), "triggers").map((trigger) =>
          decodeTriggerSummary(ctx, trigger),
        ),
      };
    }
    case "history": {
      const { trace } = requireEnvelope(ctx, raw, false);
      return {
        type,
        trace,
        messages: arr(ctx, required(ctx, raw, "messages"), "messages").map((m) =>
          decodeMessage(ctx, m),
        ),
        hasMore: bool(ctx, required(ctx, raw, "hasMore"), "hasMore"),
      };
    }
    case "error": {
      const kind = oneOf(ctx, required(ctx, raw, "kind"), ERROR_KINDS, "kind") as ErrorKind;
      const message = anyStr(ctx, required(ctx, raw, "message"), "message");
      if (kind === "version_mismatch") {
        // Handshake failure: no session exists, so no disposition or failure id.
        if (present(raw, "disposition") || present(raw, "failure")) {
          fail(ctx, "the handshake error carries server, not disposition");
        }
        const serverValue = required(ctx, raw, "server");
        if (!isObject(serverValue)) fail(ctx, "server must be an object");
        const server = serverValue as Record<string, unknown>;
        return {
          type,
          kind,
          message,
          server: { protocolVersion: int(ctx, server.protocolVersion, "server.protocolVersion") },
        };
      }
      const { rev } = requireEnvelope(ctx, raw, false);
      const event: {
        type: "error";
        rev?: number;
        trace: string;
        kind: SessionErrorKind;
        disposition: ErrorDisposition;
        failure: string;
        message: string;
        requestId?: string;
        taskId?: string;
      } = {
        type,
        trace: str(ctx, raw.trace, "trace"),
        kind,
        disposition: oneOf(ctx, required(ctx, raw, "disposition"), DISPOSITIONS, "disposition"),
        // Opaque identity minted by the daemon: the contract fixes no format.
        failure: str(ctx, required(ctx, raw, "failure"), "failure"),
        message,
      };
      if (rev !== undefined) event.rev = rev;
      if (raw.requestId !== undefined) {
        const requestId = anyStr(ctx, raw.requestId, "requestId");
        if (!/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) fail(ctx, "requestId is malformed");
        event.requestId = requestId;
      }
      if (raw.taskId !== undefined) event.taskId = anyStr(ctx, raw.taskId, "taskId");
      return event;
    }
    case "pong":
      return { type };
    default: {
      // Additive versioning: an unknown event is ignorable, but its revision still
      // advances the client's baseline, so it is not a gap.
      const ignored = envelope(ctx, raw);
      return ignored.rev === undefined
        ? {
            type: "unknown",
            rawType: type,
            ...(ignored.trace === undefined ? {} : { trace: ignored.trace }),
          }
        : {
            type: "unknown",
            rawType: type,
            rev: ignored.rev,
            ...(ignored.trace === undefined ? {} : { trace: ignored.trace }),
          };
    }
  }
}

export { PROTOCOL_VERSION };
