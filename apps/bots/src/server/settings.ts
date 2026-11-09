// The one settings save (docs/bots/PROTOCOL.md, "Gateway settings"): one request, one
// answer, one write. Two saves never overlap, so the second one reads what the first
// stored: a save that names one field cannot drop a field the daemon stored a moment
// earlier. A request applies only the fields it carries, so the 技能 page cannot undo the
// 模型网关 page's choices.
import {
  DEFAULT_THINKING_LEVEL,
  DEFAULT_TOOL_GROUPS,
  isThinkingLevel,
  isToolGroup,
  resolveToolGroups,
} from "../core/domain.ts";
import { normalizeSelectedSkills } from "../skills/selection.ts";
import {
  DEFAULT_CORE_PROMPT,
  DEFAULT_HC,
  type GatewayConfig,
  type GatewayInput,
  MAX_CORE_PROMPT,
  MAX_HC_MODEL,
  normalizeBaseUrl,
  normalizeCorePrompt,
  normalizeHc,
  type PublicGateway,
  publicGateway,
} from "./gateway.ts";

/** What one request carried: only these fields are applied to the running daemon. */
export type CarriedSettings = {
  /** The gateway's own fields: address, model, key and provider. */
  readonly model: boolean;
  readonly thinkingLevel: boolean;
  readonly toolGroups: boolean;
  readonly hc: boolean;
};

export type SettingsStore = {
  /** The settings as they are stored right now. */
  readonly current: () => GatewayConfig | undefined;
  /** Refuses a change the running daemon cannot apply, before anything is written. */
  readonly refuse?: (next: GatewayConfig, current: GatewayConfig | undefined) => string | undefined;
  /** Stores the settings; the file is the truth. */
  readonly write: (config: GatewayConfig) => Promise<void>;
  /** Applies what the request carried to the running daemon. */
  readonly apply: (config: GatewayConfig, carried: CarriedSettings) => Promise<void>;
};

export type SettingsAnswer = { readonly settings: PublicGateway; readonly error?: string };

/** What a request carries: a field that is not named keeps the stored value. */
export const carriedSettings = (input: GatewayInput): CarriedSettings => ({
  model:
    input.baseUrl !== undefined ||
    input.model !== undefined ||
    input.apiKey !== undefined ||
    input.provider !== undefined,
  thinkingLevel: input.thinkingLevel !== undefined,
  toolGroups: input.toolGroups !== undefined,
  hc: input.hc !== undefined,
});

/**
 * The saver the daemon hands to its settings route: one save at a time, each one reading
 * the settings the previous save stored.
 */
export const createSettingsSaver = (store: SettingsStore) => {
  let queue: Promise<unknown> = Promise.resolve();
  const save = async (input: GatewayInput): Promise<SettingsAnswer> => {
    const gateway = store.current();
    const baseUrl =
      input.baseUrl === undefined
        ? (gateway?.baseUrl ?? "")
        : (normalizeBaseUrl(input.baseUrl) ?? "");
    const model = (input.model ?? gateway?.model ?? "").trim();
    const apiKey =
      input.apiKey !== undefined && input.apiKey.trim().length > 0
        ? input.apiKey.trim()
        : (gateway?.apiKey ?? "");
    const provider = (input.provider ?? gateway?.provider ?? "magpie").trim() || "magpie";
    const thinkingLevel =
      input.thinkingLevel === undefined
        ? (gateway?.thinkingLevel ?? DEFAULT_THINKING_LEVEL)
        : input.thinkingLevel.trim();
    if (!isThinkingLevel(thinkingLevel)) {
      return {
        settings: publicGateway(gateway),
        error: "思考等级必须是 off、minimal、low、medium、high、xhigh 或 max",
      };
    }
    // A save that names no gateway field is the 工具 page: it may run before a gateway is
    // configured, so the three required fields are only checked when this request decides
    // them or when a gateway is already stored.
    const carried = carriedSettings(input);
    const touchesGateway = carried.model || carried.thinkingLevel;
    // A file the 工具 page wrote before anyone configured a gateway is not a gateway: it
    // must not make every later save demand fields the person never set.
    const needsGateway = touchesGateway || (gateway?.baseUrl.length ?? 0) > 0;
    if (needsGateway && baseUrl.length === 0) {
      return { settings: publicGateway(gateway), error: "网关地址必须是 http(s) URL" };
    }
    if (needsGateway && model.length === 0) {
      return { settings: publicGateway(gateway), error: "模型不能为空" };
    }
    if (needsGateway && apiKey.length === 0) {
      return { settings: publicGateway(gateway), error: "API Key 不能为空" };
    }
    if (input.toolGroups !== undefined) {
      const unknown = input.toolGroups.filter((name) => !isToolGroup(name));
      if (unknown.length > 0) {
        return {
          settings: publicGateway(gateway),
          error: `未知的工具组：${unknown.join("、")}`,
        };
      }
    }
    const corePrompt =
      input.corePrompt === undefined
        ? (gateway?.corePrompt ?? DEFAULT_CORE_PROMPT)
        : normalizeCorePrompt(input.corePrompt);
    if (corePrompt === undefined) {
      return {
        settings: publicGateway(gateway),
        error: `人格提示不能超过 ${MAX_CORE_PROMPT} 个字符`,
      };
    }
    // An absent field keeps the stored choice; a named one replaces it. The daemon's own
    // default is what a machine that stored nothing runs with.
    const toolGroups =
      input.toolGroups === undefined
        ? (gateway?.toolGroups ?? DEFAULT_TOOL_GROUPS)
        : resolveToolGroups(input.toolGroups);
    // An absent field keeps the stored ticks; an empty array is the person clearing them.
    const selection = normalizeSelectedSkills(input.skills ?? gateway?.skills ?? []);
    if ("error" in selection) {
      return { settings: publicGateway(gateway), error: selection.error };
    }
    // The Herdr page saves its three role rows together, so a named block replaces the
    // stored one; a block that breaks a bound is refused instead of half-applied.
    let hc = gateway?.hc ?? DEFAULT_HC;
    if (input.hc !== undefined) {
      const normalized = normalizeHc(input.hc);
      if (normalized === undefined) {
        return {
          settings: publicGateway(gateway),
          error: `Herdr 页的模型每行必填、不超过 ${MAX_HC_MODEL} 个字符，思考等级必须是已知值`,
        };
      }
      hc = normalized;
    }
    const next: GatewayConfig = {
      provider,
      baseUrl,
      model,
      apiKey,
      thinkingLevel,
      toolGroups,
      corePrompt,
      skills: selection.skills,
      hc,
    };
    const refused = store.refuse?.(next, gateway);
    if (refused !== undefined) return { settings: publicGateway(gateway), error: refused };
    await store.write(next);
    await store.apply(next, carried);
    return { settings: publicGateway(next) };
  };
  return (input: GatewayInput): Promise<SettingsAnswer> => {
    const run = queue.then(
      () => save(input),
      () => save(input),
    );
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
};
