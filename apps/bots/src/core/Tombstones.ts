import { z } from "zod";
import { ClassifiedFailure } from "./domain.ts";
import { newFailure } from "./failures.ts";

export const tombstoneSchema = z.strictObject({ sharedBotId: z.uuid() });
export type Tombstone = z.infer<typeof tombstoneSchema>;
export const tombstonePullSchema = z.strictObject({
  after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().min(1).max(128).default(128),
});
export const tombstoneApplySchema = z.strictObject({
  items: z.array(tombstoneSchema).min(1).max(128),
});

export const parseTombstones = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ClassifiedFailure(
      newFailure("invalid_command"),
      "not_admitted",
      "invalid tombstone request",
    );
  return parsed.data;
};
