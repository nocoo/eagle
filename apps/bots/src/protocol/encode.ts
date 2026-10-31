// Domain → wire. Key order is fixed so the encoder output can be compared
// byte-for-byte with the normative fixtures.
import type {
  AgentView,
  BotGroup,
  BotSummary,
  ContentBlock,
  ConversationSnapshot,
  DeltaChange,
  Message,
  PullSummary,
  TaskSummary,
  TriggerSummary,
} from "../core/domain.ts";
import type { ClientCommand, ServerEvent } from "./frames.ts";
import { PROTOCOL_VERSION } from "./version.ts";

type Wire = Record<string, unknown>;

const block = (b: ContentBlock): Wire => {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "thinking":
      return { type: "thinking", text: b.text };
    case "toolCall":
      return { type: "toolCall", callId: b.callId, name: b.name, args: b.args };
    case "toolResult":
      return {
        type: "toolResult",
        callId: b.callId,
        name: b.name,
        text: b.text,
        isError: b.isError,
        ...(b.durationMs === undefined ? {} : { durationMs: b.durationMs }),
      };
  }
};

export const encodeMessage = (m: Message): Wire => {
  const wire: Wire = {
    id: m.id,
    role: m.role,
    state: m.state,
    createdAt: m.createdAt,
    blocks: m.blocks.map(block),
  };
  if (m.requestId !== undefined) wire.requestId = m.requestId;
  if (m.stopReason !== undefined) wire.stopReason = m.stopReason;
  // The wire carries what a client renders. Internal ids stay in the daemon.
  if (m.origin !== undefined) {
    wire.origin = {
      kind: m.origin.kind,
      ...(m.origin.kind === "peer" && m.origin.exchangeId !== undefined
        ? { exchangeId: m.origin.exchangeId }
        : {}),
      ...(m.origin.label === undefined ? {} : { label: m.origin.label }),
    };
  }
  return wire;
};

/** A reported pull request: the link opens it, the status decides its colour. */
const encodePull = (pull: PullSummary): Wire => ({
  url: pull.url,
  title: pull.title,
  status: pull.status,
  host: pull.host,
  updatedAt: pull.updatedAt,
});

const encodeTask = (task: TaskSummary): Wire => {
  const wire: Wire = {
    id: task.id,
    kind: task.kind,
    status: task.status,
    phase: task.phase,
    background: task.background,
    conversationId: task.conversationId,
  };
  if (task.blocked !== undefined) wire.blocked = task.blocked;
  if (task.owner !== undefined) wire.owner = task.owner;
  return wire;
};

const encodeBot = (b: BotSummary): Wire => {
  const wire: Wire = {
    id: b.id,
    title: b.title,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    model: { provider: b.model.provider, modelId: b.model.modelId },
    state: b.state,
  };
  if (b.label !== undefined) wire.label = b.label;
  if (b.appearance) wire.appearance = { shape: b.appearance.shape, tint: b.appearance.tint };
  if (b.groupId !== undefined) wire.groupId = b.groupId;
  if (b.unavailable) {
    wire.unavailable = { reason: b.unavailable.reason, message: b.unavailable.message };
  }
  return wire;
};

const encodeGroup = (group: BotGroup): Wire => ({ id: group.id, title: group.title });

const encodeTrigger = (trigger: TriggerSummary): Wire => {
  const wire: Wire = {
    id: trigger.id,
    kind: trigger.kind,
    name: trigger.name,
    enabled: trigger.enabled,
    counters: {
      fired: trigger.counters.fired,
      dropped: trigger.counters.dropped,
      refused: trigger.counters.refused,
    },
  };
  if (trigger.schedule !== undefined) {
    wire.schedule = {
      cron: trigger.schedule.cron,
      timezone: trigger.schedule.timezone,
      ...(trigger.schedule.nextDueAt === undefined
        ? {}
        : { nextDueAt: trigger.schedule.nextDueAt }),
    };
  }
  if (trigger.lastFiredAt !== undefined) wire.lastFiredAt = trigger.lastFiredAt;
  if (trigger.lastSkipped !== undefined) {
    wire.lastSkipped = { at: trigger.lastSkipped.at, reason: trigger.lastSkipped.reason };
  }
  return wire;
};

const encodeAgent = (agent: AgentView): Wire => ({
  model: { provider: agent.model.provider, modelId: agent.model.modelId },
  thinkingLevel: agent.thinkingLevel,
  instructions: agent.instructions,
});

export const encodeSnapshot = (s: ConversationSnapshot): Wire => {
  const value: Wire = { botId: s.botId };
  if (s.tasks !== undefined) value.tasks = s.tasks.map(encodeTask);
  if (s.triggers !== undefined) value.triggers = s.triggers.map(encodeTrigger);
  if (s.pulls !== undefined) value.pulls = s.pulls.map(encodePull);
  if (s.agent) value.agent = encodeAgent(s.agent);
  value.messages = s.messages.map(encodeMessage);
  if (s.truncatedBefore !== undefined) value.truncatedBefore = s.truncatedBefore;
  value.streaming = s.streaming === null ? null : { messageId: s.streaming };
  if (s.parked === true) value.parked = true;
  value.pending = s.pending.map((p) => {
    const wire: Wire = { requestId: p.requestId, submissionId: p.id, status: p.status };
    if (p.entryId !== undefined) wire.entryId = p.entryId;
    if (p.reason !== undefined) wire.reason = p.reason;
    return wire;
  });
  value.inbox = s.inbox.map((i) => ({ id: i.id, mode: i.mode }));
  value.running = s.running;
  if (s.usage) {
    value.usage = {
      inputTokens: s.usage.inputTokens,
      outputTokens: s.usage.outputTokens,
      totalTokens: s.usage.totalTokens,
      ...(s.usage.costUsd === undefined ? {} : { costUsd: s.usage.costUsd }),
    };
  }
  if (s.unavailable) {
    value.unavailable = { reason: s.unavailable.reason, message: s.unavailable.message };
  }
  return value;
};

const encodeChange = (change: DeltaChange): Wire => {
  switch (change.kind) {
    case "text":
    case "thinking":
      return { kind: change.kind, index: change.index, append: change.append };
    case "toolcall":
      return {
        kind: change.kind,
        index: change.index,
        callId: change.callId,
        path: change.path,
        append: change.append,
      };
    case "block":
      return { kind: change.kind, index: change.index, block: block(change.block) };
    case "message":
      return { kind: change.kind, message: encodeMessage(change.message) };
  }
};

export const encodeServerEvent = (event: ServerEvent): Wire => {
  // The envelope is per variant: welcome and bots carry no revision, pong carries
  // nothing, and a handshake error carries neither trace nor failure.
  const wire: Wire = { type: event.type };
  if (event.type !== "welcome" && event.type !== "bots" && event.type !== "pong") {
    if ("rev" in event && event.rev !== undefined) wire.rev = event.rev;
    if ("trace" in event && event.trace !== undefined) wire.trace = event.trace;
  }

  switch (event.type) {
    case "welcome":
      wire.protocolVersion = event.protocolVersion;
      wire.server = {
        version: event.server.version,
        instance: event.server.instance,
        pid: event.server.pid,
      };
      if (event.groups !== undefined) wire.groups = event.groups.map(encodeGroup);
      wire.capabilities = {
        agent: event.capabilities.agent === true,
        tools: event.capabilities.tools === true,
        tasks: event.capabilities.tasks === true,
        entries: event.capabilities.entries === true,
        usage: event.capabilities.usage === true,
        peers: event.capabilities.peers === true,
        triggers: event.capabilities.triggers === true,
      };
      wire.bots = event.bots.map(encodeBot);
      if (event.groups !== undefined) wire.groups = event.groups.map(encodeGroup);
      return wire;
    case "snapshot":
      wire.value = encodeSnapshot(event.value);
      return wire;
    case "agent":
      wire.agent = encodeAgent(event.agent);
      return wire;
    case "append":
      if (event.replaces !== undefined) wire.replaces = event.replaces;
      wire.message = encodeMessage(event.message);
      return wire;
    case "delta":
      wire.messageId = event.messageId;
      wire.changes = event.changes.map(encodeChange);
      return wire;
    case "usage":
      wire.usage = {
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        totalTokens: event.usage.totalTokens,
        ...(event.usage.costUsd === undefined ? {} : { costUsd: event.usage.costUsd }),
      };
      return wire;
    case "triggers":
      wire.triggers = event.triggers.map(encodeTrigger);
      return wire;
    case "pulls":
      wire.pulls = event.pulls.map(encodePull);
      return wire;
    case "tasks":
      wire.tasks = event.tasks.map(encodeTask);
      return wire;
    case "status":
      wire.running = event.running;
      wire.streaming = event.streaming;
      wire.inbox = event.inbox.map((i) => ({ id: i.id, mode: i.mode }));
      return wire;
    case "submission":
      wire.requestId = event.record.requestId;
      wire.submissionId = event.record.id;
      wire.status = event.record.status;
      if (event.record.entryId !== undefined) wire.entryId = event.record.entryId;
      if (event.record.answerEntryId !== undefined) wire.answerEntryId = event.record.answerEntryId;
      if (event.record.reason !== undefined) wire.reason = event.record.reason;
      return wire;
    case "bots":
      wire.bots = event.bots.map(encodeBot);
      if (event.groups !== undefined) wire.groups = event.groups.map(encodeGroup);
      return wire;
    case "history":
      wire.hasMore = event.hasMore;
      wire.messages = event.messages.map(encodeMessage);
      return wire;
    case "error": {
      wire.kind = event.kind;
      wire.message = event.message;
      // Both error shapes share `type`, so narrow explicitly instead of relying on a
      // discriminant TypeScript cannot see.
      if (event.kind === "version_mismatch") {
        const handshake = event as Extract<ServerEvent, { kind: "version_mismatch" }>;
        wire.server = { protocolVersion: handshake.server.protocolVersion };
        return wire;
      }
      const session = event as Extract<ServerEvent, { disposition: unknown }>;
      wire.failure = session.failure;
      wire.disposition = session.disposition;
      if (session.requestId !== undefined) wire.requestId = session.requestId;
      if (session.taskId !== undefined) wire.taskId = session.taskId;
      return wire;
    }
    case "pong":
    case "unknown":
      // `unknown` is decode-only: this daemon never emits an event it cannot name.
      return wire;
  }
};

export const encodeCommand = (command: ClientCommand): Wire => {
  switch (command.type) {
    case "hello":
      return { type: "hello", protocolVersion: command.protocolVersion, client: command.client };
    case "subscribe":
      return {
        type: "subscribe",
        botId: command.botId,
        ...(command.contextId === undefined ? {} : { contextId: command.contextId }),
        trace: command.trace,
      };
    case "send":
      return {
        type: "send",
        requestId: command.requestId,
        text: command.text,
        ...(command.contextId === undefined ? {} : { contextId: command.contextId }),
        ...(command.resourceHead === undefined ? {} : { resourceHead: command.resourceHead }),
        whenBusy: command.whenBusy,
        trace: command.trace,
      };
    case "abort":
    case "recover":
    case "resync":
      return { type: command.type, trace: command.trace };
    case "history":
      return {
        type: "history",
        before: command.before,
        limit: command.limit,
        trace: command.trace,
      };
    case "ping":
      return { type: "ping" };
  }
};

/** The transport form: compact JSON, exactly the bytes the budget measures. */
export const serializeFrame = (wire: Wire): string => JSON.stringify(wire);

/** The review form the fixtures are written in: same object, pretty-printed. */
export const serialize = (wire: Wire): string => `${JSON.stringify(wire, null, 2)}\n`;

export const currentProtocolVersion = PROTOCOL_VERSION;
