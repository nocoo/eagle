import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Configuration, PublicConfiguration } from "./domain.ts";
import { ServiceError } from "./domain.ts";
import { missing, readPrivate } from "./identity.ts";

export const configurationInput = z
  .object({
    baseUrl: z
      .string()
      .max(2048)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            ["http:", "https:"].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash
          );
        } catch {
          return false;
        }
      }),
    model: z.string().trim().min(1).max(200),
    thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
    apiKey: z.string().max(8192).optional(),
  })
  .strict();

export const publicConfiguration = (value: Configuration | null): PublicConfiguration | null => {
  if (!value) return null;
  const { apiKey, ...rest } = value;
  return { ...rest, hasApiKey: apiKey.length > 0 };
};

export class ConfigurationStore {
  readonly path: string;
  value: Configuration | null = null;
  constructor(root: string) {
    this.path = join(root, "configuration.json");
  }
  async load() {
    try {
      const parsed = configurationInput.parse(JSON.parse(await readPrivate(this.path)));
      if (parsed.apiKey === undefined) throw new Error("missing_key_field");
      this.value = { ...parsed, apiKey: parsed.apiKey };
    } catch (error) {
      if (!missing(error)) throw new ServiceError("storage_failed");
    }
  }
  async save(input: unknown) {
    const parsed = configurationInput.safeParse(input);
    if (!parsed.success) throw new ServiceError("invalid_command");
    const next = { ...parsed.data, apiKey: parsed.data.apiKey ?? this.value?.apiKey ?? "" };
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(next), { mode: 0o600, flag: "wx" });
      await rename(temp, this.path);
      this.value = next;
    } catch {
      throw new ServiceError("storage_failed");
    } finally {
      await rm(temp, { force: true });
    }
    return publicConfiguration(next);
  }
}
