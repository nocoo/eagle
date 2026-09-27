import { DurableObject } from "cloudflare:workers";
import { type DailySettings, DailySettingsSchema } from "../shared/daily.ts";
import { aiEndpoint, sealAiKey, unsealAiKey } from "./ai-secret.ts";

/** Control-plane index only. Each machine owns its metadata and authentication. */
export class MachineDirectory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const old = ctx.storage.kv.get<Record<string, unknown>>("hourly-settings");
    if (old) {
      const { intervalHours: _interval, ...settings } = old;
      ctx.storage.kv.put("daily-settings", DailySettingsSchema.parse(settings));
      ctx.storage.kv.delete("hourly-settings");
    }
  }
  settings(): DailySettings {
    return DailySettingsSchema.parse(
      this.ctx.storage.kv.get("daily-settings") ?? {},
    );
  }
  async aiKey(settings: DailySettings = this.settings()): Promise<string> {
    const value =
      this.ctx.storage.kv.get<Awaited<ReturnType<typeof sealAiKey>>>(
        "ai-credential",
      );
    if (!value || value.endpoint !== aiEndpoint(settings)) return "";
    return unsealAiKey(value, this.env.AI_ENCRYPTION_KEY, aiEndpoint(settings));
  }
  async saveSettings(
    settings: DailySettings,
    apiKey?: string | null,
  ): Promise<DailySettings> {
    const value = DailySettingsSchema.parse(settings);
    const endpoint = aiEndpoint(value);
    const credential = apiKey
      ? await sealAiKey(apiKey, this.env.AI_ENCRYPTION_KEY, endpoint)
      : apiKey === null || endpoint !== aiEndpoint(this.settings())
        ? null
        : undefined;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.put("daily-settings", value);
      if (credential === null) this.ctx.storage.kv.delete("ai-credential");
      else if (credential !== undefined)
        this.ctx.storage.kv.put("ai-credential", credential);
    });
    return value;
  }
  ids(): string[] {
    return [...this.ctx.storage.kv.list({ prefix: "machine:" })].map(([key]) =>
      key.slice(8),
    );
  }
  add(id: string): boolean {
    if (!this.ctx.storage.kv.get(`machine:${id}`) && this.ids().length >= 1000)
      return false;
    this.ctx.storage.kv.put(`machine:${id}`, true);
    return true;
  }
}
