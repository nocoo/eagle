// pi-ai → domain conversion (docs/bots/RUNTIME.md, "Event mapping"). This is the only
// module that reads pi-ai types: nothing from `@earendil-works/pi-ai` reaches
// `core/domain.ts`, and blocks, messages, usage and stop reasons are all converted here.

import type {
  AssistantMessage,
  Message as PiMessage,
  Usage as PiUsage,
} from "@earendil-works/pi-ai";
import { z } from "zod";
import type { ContentBlock, Message, MessageState, StopReason, Usage } from "../../core/domain.ts";

/** A committed entry becomes `e_<id>`; a provisional is `p_a<attempt>` (PROTOCOL.md). */
export const entryMessageId = (entryId: string | number): string => {
  const text = String(entryId);
  return text.startsWith("e_") ? text : `e_${text}`;
};

export const provisionalMessageId = (attempt: number): string => `p_a${attempt}`;

const isoFrom = (timestamp: number | undefined, now: () => Date): string =>
  new Date(
    typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : now().getTime(),
  ).toISOString();

/** F13: every `stopReason`, and the message state it means. `null` means "no message". */
const STATE_BY_STOP_REASON: Readonly<Record<AssistantMessage["stopReason"], MessageState | null>> =
  {
    pending: "streaming",
    stop: "complete",
    length: "complete",
    toolUse: "complete",
    aborted: "aborted",
    error: "error",
    // F23: a deferred response commits a polling checkpoint, not an assistant entry.
    deferred: null,
  };

export const messageStateOf = (stopReason: AssistantMessage["stopReason"]): MessageState | null =>
  STATE_BY_STOP_REASON[stopReason];

/** The domain stop reason: `pending` and `deferred` never describe a committed message. */
export const stopReasonOf = (stopReason: AssistantMessage["stopReason"]): StopReason | undefined =>
  stopReason === "pending" || stopReason === "deferred" ? undefined : stopReason;

type AssistantBlock = AssistantMessage["content"][number];

type ToolResultLike = {
  readonly role: "toolResult";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly isError: boolean;
  readonly timestamp: number;
  readonly durationMs?: number;
};

const interruptedDeviceReceipt = z.strictObject({
  type: z.literal("device-operation"),
  version: z.literal(1),
  targetDeviceId: z.uuid(),
  operationId: z.uuid(),
  digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  status: z.literal("unknown"),
  error: z.enum(["remote_not_configured", "device_service_unavailable"]),
  truncated: z.literal(false),
});

const toolText = (result: ToolResultLike): string => {
  const texts = result.content.flatMap((part) =>
    part.type === "text" && typeof part.text === "string" ? [part.text] : [],
  );
  if (
    result.isError &&
    ["remote_execute", "remote_operation"].includes(result.toolName) &&
    texts.length > 1 &&
    texts.slice(1).every((text) => text.startsWith("<harness>\n") && text.endsWith("\n</harness>"))
  ) {
    try {
      const receipt = interruptedDeviceReceipt.safeParse(JSON.parse(texts[0] ?? ""));
      if (receipt.success) return JSON.stringify({ ...receipt.data, diagnostics: texts.slice(1) });
    } catch {}
  }
  return texts.join("\n");
};

const isTextBlock = (block: AssistantBlock | TextBlockLike): block is TextBlockLike =>
  block.type === "text";

type TextBlockLike = { readonly type: "text"; readonly text: string };
type ThinkingBlockLike = { readonly type: "thinking"; readonly thinking: string };
type ToolCallLike = {
  readonly type: "toolCall";
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
};

/** One pi content block as a domain block. Images have no wire shape in phase 1. */
export const convertBlock = (block: AssistantBlock): ContentBlock | undefined => {
  if (isTextBlock(block)) return { type: "text", text: block.text };
  const thinking = block as ThinkingBlockLike;
  if (thinking.type === "thinking") return { type: "thinking", text: thinking.thinking };
  const call = block as ToolCallLike;
  if (call.type === "toolCall") {
    return { type: "toolCall", callId: call.id, name: call.name, args: call.arguments };
  }
  return undefined;
};

const convertBlocks = (
  blocks: readonly AssistantBlock[] | TextBlockLike[],
): readonly ContentBlock[] => {
  const converted: ContentBlock[] = [];
  for (const block of blocks) {
    const value = convertBlock(block as AssistantBlock);
    if (value !== undefined) converted.push(value);
  }
  return converted;
};

const userBlocks = (content: string | readonly unknown[]): readonly ContentBlock[] => {
  if (typeof content === "string") return [{ type: "text", text: content }];
  const blocks: ContentBlock[] = [];
  for (const entry of content) {
    const block = entry as TextBlockLike;
    if (block.type === "text") blocks.push({ type: "text", text: block.text });
  }
  return blocks;
};

export type ConvertOptions = {
  /** The message id: `e_<entry>` for a committed entry, `p_a<n>` for a provisional. */
  readonly id: string;
  readonly requestId?: string;
  readonly now: () => Date;
};

/** Converts a pi message. Returns `undefined` when it has no domain state (deferred). */
export const convertMessage = (
  message: PiMessage,
  options: ConvertOptions,
): Message | undefined => {
  const createdAt = isoFrom(message.timestamp, options.now);
  if (message.role === "assistant") {
    const state = messageStateOf(message.stopReason);
    if (state === null) return undefined;
    const stopReason = stopReasonOf(message.stopReason);
    return {
      id: options.id,
      role: "assistant",
      state,
      createdAt,
      blocks: convertBlocks(message.content),
      ...(stopReason === undefined ? {} : { stopReason }),
    };
  }
  if (message.role === "user") {
    return {
      id: options.id,
      role: "user",
      state: "complete",
      createdAt,
      blocks: userBlocks(message.content),
      ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    };
  }
  if (message.role === "system") {
    return {
      id: options.id,
      role: "system",
      state: "complete",
      createdAt,
      blocks: userBlocks(message.content),
    };
  }
  if (message.role === "toolResult") {
    const result = message as ToolResultLike;
    return {
      id: options.id,
      role: "tool",
      state: "complete",
      createdAt,
      blocks: [
        {
          type: "toolResult",
          callId: result.toolCallId,
          name: result.toolName,
          text: toolText(result),
          isError: result.isError === true,
          ...(typeof result.durationMs === "number" ? { durationMs: result.durationMs } : {}),
        },
      ],
    };
  }
  return undefined;
};

/** Sums a `pi.usage` state into the domain's three counters. */
export const convertUsage = (state: {
  readonly models: Readonly<Record<string, PiUsage>>;
  readonly tools: Readonly<Record<string, PiUsage>>;
}): Usage => {
  let input = 0;
  let output = 0;
  let total = 0;
  let cost = 0;
  for (const bucket of [...Object.values(state.models), ...Object.values(state.tools)]) {
    input += bucket.input;
    output += bucket.output;
    total += bucket.totalTokens;
    cost += bucket.cost?.total ?? 0;
  }
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    ...(cost > 0 ? { costUsd: cost } : {}),
  };
};

/** The encoded size of one converted message, measured the way the wire measures it. */
export const messageBytes = (message: Message): number =>
  new TextEncoder().encode(JSON.stringify(message)).length;
