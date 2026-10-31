import type { Message } from "@earendil-works/pi-ai";
import { z } from "zod";

const jsonObject = z.record(z.string(), z.json());
const text = z.looseObject({
  type: z.literal("text"),
  text: z.string(),
  textSignature: z.string().optional(),
});
const image = z.looseObject({ type: z.literal("image"), data: z.string(), mimeType: z.string() });
const toolCall = z.looseObject({
  type: z.literal("toolCall"),
  id: z.string(),
  name: z.string(),
  arguments: jsonObject,
  thoughtSignature: z.string().optional(),
  namespace: z.string().optional(),
  argumentsError: z.string().optional(),
});
const thinking = z.looseObject({
  type: z.literal("thinking"),
  thinking: z.string(),
  thinkingSignature: z.string().optional(),
  redacted: z.boolean().optional(),
});
const usage = z.looseObject({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  totalTokens: z.number(),
  cacheWrite1h: z.number().optional(),
  reasoning: z.number().optional(),
  cost: z.looseObject({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    total: z.number(),
  }),
});
const level = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);
const schema = z.discriminatedUnion("role", [
  z.looseObject({
    role: z.literal("system"),
    content: z.union([z.string(), z.array(text)]),
    timestamp: z.number(),
    sections: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
    toolsAdded: z
      .array(
        z.looseObject({
          name: z.string(),
          description: z.string(),
          parameters: jsonObject,
          constrainedSampling: z.union([z.literal(false), jsonObject]).optional(),
        }),
      )
      .optional(),
    toolsRemoved: z.array(z.looseObject({ name: z.string() })).optional(),
  }),
  z.looseObject({
    role: z.literal("user"),
    content: z.union([z.string(), z.array(z.union([text, image]))]),
    timestamp: z.number(),
  }),
  z.looseObject({
    role: z.literal("assistant"),
    content: z.array(z.union([text, thinking, toolCall])),
    api: z.string(),
    provider: z.string(),
    model: z.string(),
    timestamp: z.number(),
    usage,
    stopReason: z.enum(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]),
    responseModel: z.string().optional(),
    responseId: z.string().optional(),
    providerThinkingLevel: z.string().optional(),
    thinkingLevel: level.optional(),
    deferred: z
      .looseObject({
        provider: z.string(),
        modelId: z.string(),
        api: z.string(),
        id: z.string(),
        expiresAt: z.number().optional(),
        pollAfterMs: z.number().optional(),
        data: z.json().optional(),
      })
      .optional(),
    diagnostics: z
      .array(
        z.looseObject({
          type: z.string(),
          timestamp: z.number(),
          details: jsonObject.optional(),
          error: z
            .looseObject({
              message: z.string(),
              name: z.string().optional(),
              stack: z.string().optional(),
              code: z.union([z.string(), z.number()]).optional(),
            })
            .optional(),
        }),
      )
      .optional(),
    errorMessage: z.string().optional(),
    rawStopReason: z.string().optional(),
    endTurn: z.boolean().optional(),
    durationMs: z.number().optional(),
  }),
  z.looseObject({
    role: z.literal("toolResult"),
    toolCallId: z.string(),
    toolName: z.string(),
    content: z.array(z.union([text, image])),
    timestamp: z.number(),
    isError: z.boolean(),
    details: z.json().optional(),
    usage: usage.optional(),
    durationMs: z.number().optional(),
    nestedCalls: z
      .looseObject({
        complete: z.boolean(),
        calls: z.array(
          z.looseObject({
            id: z.string(),
            name: z.string(),
            status: z.enum(["ok", "error", "unfinished"]),
            arguments: jsonObject.optional(),
            argumentsBytes: z.number().optional(),
            durationMs: z.number().optional(),
            error: z.string().optional(),
          }),
        ),
      })
      .optional(),
  }),
]);

// Validate the full 1.4.0 shape but keep the original object, including opaque JSON metadata.
export const historyMessage = z.custom<Message>(
  (value) => z.json().safeParse(value).success && schema.safeParse(value).success,
);
