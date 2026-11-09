import { z } from "zod";
import { configurationInput } from "./configuration.ts";

const id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export const hello = z
  .object({ type: z.literal("hello"), nonce: z.string().regex(/^[0-9a-f]{32}$/) })
  .strict();
export const authentication = z
  .object({ type: z.literal("authenticate"), proof: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();
export const command = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state"), id }).strict(),
  z.object({ type: z.literal("configure"), id, configuration: configurationInput }).strict(),
  z.object({ type: z.literal("send"), id, requestId: id, text: z.string() }).strict(),
  z.object({ type: z.literal("submission"), id, requestId: id }).strict(),
  z
    .object({
      type: z.literal("history"),
      id,
      before: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  z.object({ type: z.literal("abort"), id }).strict(),
  z.object({ type: z.literal("observe-snapshot"), id }).strict(),
  z
    .object({
      type: z.literal("observe-history"),
      id,
      botId: z.string().min(1).max(128),
      scope: z.string().min(1).max(64).optional(),
      before: z
        .string()
        .regex(/^e_[0-9]+$/)
        .optional(),
      limit: z.number().int().min(1).max(200).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("observe-changes"),
      id,
      limit: z.number().int().min(1).max(500).optional(),
    })
    .strict(),
  // SG-004: what the watcher noticed, and the one switch that lets it act.
  z
    .object({
      type: z.literal("attention"),
      id,
      limit: z.number().int().min(1).max(200).optional(),
    })
    .strict(),
  z.object({ type: z.literal("attention-ack"), id, itemId: id }).strict(),
  z
    .object({
      type: z.literal("manage-mode"),
      id,
      mode: z.enum(["off", "notify", "act"]).optional(),
    })
    .strict(),
]);
