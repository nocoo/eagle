// The model gateway settings (docs/bots/PROTOCOL.md, "Gateway settings"): one local
// endpoint, one key and one model, stored beside the token so a person can configure the
// app instead of editing a dotenv. The key never leaves the daemon except in a request
// that already carries the bearer token; the public shape only says whether it is set.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_HC,
  DEFAULT_THINKING_LEVEL,
  DEFAULT_TOOL_GROUPS,
  type HcConfig,
  isThinkingLevel,
  normalizeHc,
  resolveToolGroups,
  type ThinkingLevel,
  type ToolGroup,
} from "../core/domain.ts";
import { normalizeSelectedSkills, type SelectedSkill } from "../skills/selection.ts";

export type GatewayConfig = {
  readonly provider: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly thinkingLevel: ThinkingLevel;
  /** The tool groups every bot is given; `core` is always included. */
  readonly toolGroups: readonly ToolGroup[];
  /** The person's standing instruction, the first section of every bot's system prompt. */
  readonly corePrompt: string;
  /** The skills this person ticked for the machine's Bot service (PROTOCOL.md, "Skills"). */
  readonly skills: readonly SelectedSkill[];
  /** What each hc role runs on; the Bot's `hc_start` reads it on every call. */
  readonly hc: HcConfig;
};

export type PublicGateway = {
  readonly configured: boolean;
  readonly provider: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly hasApiKey: boolean;
  readonly thinkingLevel: ThinkingLevel;
  readonly toolGroups: readonly ToolGroup[];
  readonly corePrompt: string;
  readonly skills: readonly SelectedSkill[];
  readonly hc: HcConfig;
};

/** What the gateway's own health endpoint says, when that origin has one. */
export type GatewayHealth = {
  readonly ok: boolean;
  readonly status?: number;
  readonly version?: string;
  readonly revision?: string;
  readonly latencyMs: number;
};

export type GatewayTest = {
  readonly ok: boolean;
  readonly status?: number;
  readonly message: string;
  readonly latencyMs: number;
  readonly models?: number;
  readonly health?: GatewayHealth;
};

/** `/v1` is a path on the gateway, so health asks the origin that serves it. */
export const gatewayOrigin = (baseUrl: string): string | undefined => {
  try {
    const url = new URL(baseUrl);
    return url.origin;
  } catch {
    return undefined;
  }
};

/**
 * A gateway that publishes `/api/live` states its own health and version; asking it is cheaper
 * than inferring liveness from a model list and says which build a person is actually talking to.
 */
export const checkGatewayHealth = async (
  baseUrl: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<GatewayHealth> => {
  const started = performance.now();
  const origin = gatewayOrigin(baseUrl);
  if (!origin) return { ok: false, latencyMs: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${origin}/api/live`, { signal: controller.signal });
    const latencyMs = Math.round(performance.now() - started);
    if (!response.ok) return { ok: false, status: response.status, latencyMs };
    const body = (await response.json().catch(() => undefined)) as
      | { status?: unknown; version?: unknown; revision?: unknown }
      | undefined;
    const version = typeof body?.version === "string" ? body.version : undefined;
    const revision = typeof body?.revision === "string" ? body.revision : undefined;
    const healthy = body?.status === "ok" || version !== undefined;
    return {
      ok: healthy,
      status: response.status,
      latencyMs,
      ...(version === undefined ? {} : { version }),
      ...(revision === undefined ? {} : { revision }),
    };
  } catch {
    return { ok: false, latencyMs: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
  }
};

export type GatewayInput = {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly thinkingLevel?: string;
  readonly toolGroups?: readonly string[];
  readonly corePrompt?: string;
  readonly skills?: readonly SelectedSkill[];
  /** The whole Herdr block; the page saves its three rows together. */
  readonly hc?: HcConfig;
};

const FILE = "gateway.json";
const DEFAULT_PROVIDER = "magpie";

/** What a person who has never opened Settings gets: one sentence, editable, not a persona suite. */
export const DEFAULT_CORE_PROMPT =
  "你是一个务实、友好的 agent：先说结论，再给依据；做不到就直说，不要编。";
/** The protocol's own bound for a standing instruction. */
export const MAX_CORE_PROMPT = 4_000;
/** Each version names the groups a stored list could not have known yet. */
const FILE_VERSION = 4;
/** Groups that a file written before this version could not name, in the order they arrived. */
const GAINED_GROUPS: readonly {
  readonly version: number;
  readonly groups: readonly ToolGroup[];
}[] = [
  { version: 2, groups: ["persona", "machine"] },
  { version: 3, groups: ["memory"] },
  { version: 4, groups: ["hc"] },
];
const TEST_TIMEOUT_MS = 8_000;

export const gatewayPath = (root: string): string => join(root, FILE);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Reads the stored settings; a malformed file is "not configured", never a crash. */
export const readGateway = async (root: string): Promise<GatewayConfig | undefined> => {
  const text = await readFile(gatewayPath(root), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const raw = JSON.parse(text) as unknown;
    if (!isObject(raw)) return undefined;
    const baseUrl = raw.baseUrl;
    const model = raw.model;
    const apiKey = raw.apiKey;
    if (typeof baseUrl !== "string" || typeof model !== "string" || typeof apiKey !== "string") {
      return undefined;
    }
    return {
      provider:
        typeof raw.provider === "string" && raw.provider.length > 0
          ? raw.provider
          : DEFAULT_PROVIDER,
      baseUrl,
      model,
      apiKey,
      thinkingLevel: isThinkingLevel(raw.thinkingLevel)
        ? raw.thinkingLevel
        : DEFAULT_THINKING_LEVEL,
      toolGroups: readGroups(raw),
      corePrompt: typeof raw.corePrompt === "string" ? raw.corePrompt : DEFAULT_CORE_PROMPT,
      skills: readSkills(raw.skills),
      hc: normalizeHc(raw.hc) ?? DEFAULT_HC,
    };
  } catch {
    return undefined;
  }
};

/**
 * A file written before a group existed could not name it, so an older file gains the groups
 * that arrived since: the person's other choices stay as they were, and the next write records
 * the version, which makes a deliberate "off" survive a restart.
 */
const readGroups = (raw: Record<string, unknown>): readonly ToolGroup[] => {
  if (raw.toolGroups === undefined) return DEFAULT_TOOL_GROUPS;
  const stored = Array.isArray(raw.toolGroups)
    ? raw.toolGroups.filter((name): name is string => typeof name === "string")
    : [];
  const version = typeof raw.version === "number" ? raw.version : 0;
  const gained = GAINED_GROUPS.filter((entry) => entry.version > version).flatMap(
    (entry) => entry.groups,
  );
  return resolveToolGroups([...stored, ...gained]);
};

/**
 * The stored selection, read tolerantly: a file an older daemon wrote has no field at all,
 * and a hand-edited one that breaks a bound is read as no skills rather than as a crash. The
 * App pushes the selection again on the next tick or page visit.
 */
const readSkills = (value: unknown): readonly SelectedSkill[] => {
  const outcome = normalizeSelectedSkills(Array.isArray(value) ? value : []);
  return "skills" in outcome ? outcome.skills : [];
};

/** How many settings files this daemon has written; it names the temporary files. */
let temporaryCounter = 0;

/** Writes the settings atomically with 0600: the key is a secret like the token. */
export const writeGateway = async (root: string, config: GatewayConfig): Promise<void> => {
  await mkdir(root, { recursive: true, mode: 0o700 });
  // The temporary name is the daemon's own and it is unique per write: two writes that
  // overlap must not share one file to write into.
  temporaryCounter += 1;
  const temporary = `${gatewayPath(root)}.${process.pid}.${temporaryCounter}.tmp`;
  const body = { ...config, version: FILE_VERSION };
  await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, gatewayPath(root));
};

/**
 * A gateway is usable only when it names an endpoint, a model and a key. A file the 工具
 * or 技能 page wrote before anyone configured one is not a gateway: it must not register a
 * model and it must not become a Bot's default.
 */
export const isGatewayComplete = (config: GatewayConfig | undefined): boolean =>
  config !== undefined &&
  config.baseUrl.length > 0 &&
  config.model.length > 0 &&
  config.apiKey.length > 0;

/**
 * The standing instruction as it is stored: trimmed, and bounded by the protocol's own limit.
 * Undefined means the text is too long, which the caller reports as a refusal.
 */
export const normalizeCorePrompt = (value: string): string | undefined => {
  const text = value.trim();
  return text.length > MAX_CORE_PROMPT ? undefined : text;
};

/** The dotenv values a fresh checkout still uses; the file wins when both exist. */
export const gatewayFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): GatewayConfig | undefined => {
  const baseUrl = env.BOTS_BASE_URL?.trim() ?? "";
  const apiKey = env.BOTS_API_KEY?.trim() ?? "";
  const model = env.BOTS_MODEL?.trim() ?? "";
  if (baseUrl.length === 0 || apiKey.length === 0 || model.length === 0) return undefined;
  const provider = env.BOTS_PROVIDER?.trim() ?? "";
  const level = env.BOTS_THINKING_LEVEL?.trim();
  return {
    provider: provider.length > 0 ? provider : DEFAULT_PROVIDER,
    baseUrl,
    model,
    apiKey,
    thinkingLevel: isThinkingLevel(level) ? level : DEFAULT_THINKING_LEVEL,
    toolGroups:
      env.BOTS_TOOL_GROUPS === undefined
        ? DEFAULT_TOOL_GROUPS
        : resolveToolGroups(env.BOTS_TOOL_GROUPS.split(",").map((name) => name.trim())),
    corePrompt: DEFAULT_CORE_PROMPT,
    skills: [],
    hc: DEFAULT_HC,
  };
};

export const publicGateway = (config: GatewayConfig | undefined): PublicGateway => ({
  configured: isGatewayComplete(config),
  provider: config?.provider ?? DEFAULT_PROVIDER,
  baseUrl: config?.baseUrl ?? "",
  model: config?.model ?? "",
  hasApiKey: (config?.apiKey.length ?? 0) > 0,
  thinkingLevel: config?.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
  toolGroups: config?.toolGroups ?? DEFAULT_TOOL_GROUPS,
  corePrompt: config?.corePrompt ?? DEFAULT_CORE_PROMPT,
  skills: config?.skills ?? [],
  hc: config?.hc ?? DEFAULT_HC,
});

/** A gateway URL is http(s) and has no trailing slash, so `/models` appends cleanly. */
export const normalizeBaseUrl = (value: string): string | undefined => {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
};

/** The model ids the gateway offers, in its own order; empty when it cannot be asked. */
export const listGatewayModels = async (
  config: Pick<GatewayConfig, "baseUrl" | "apiKey">,
  options: { readonly timeoutMs?: number } = {},
): Promise<readonly string[]> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/models`, {
      headers: { authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const body = (await response.json().catch(() => undefined)) as { data?: unknown } | undefined;
    if (!Array.isArray(body?.data)) return [];
    return body.data.flatMap((item) => {
      const id = (item as { id?: unknown }).id;
      return typeof id === "string" && id.length > 0 ? [id] : [];
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Proves the app can reach the gateway and that the key is accepted. It asks for the
 * model list, which the OpenAI-compatible endpoint implements, instead of spending a
 * generation; a 401 is an auth problem, a timeout is a reachability problem.
 */
export const testGateway = async (
  config: Pick<GatewayConfig, "provider" | "baseUrl" | "model" | "apiKey">,
  options: { readonly timeoutMs?: number } = {},
): Promise<GatewayTest> => {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TEST_TIMEOUT_MS);
  const health = await checkGatewayHealth(config.baseUrl, options);
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/models`, {
      headers: { authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
    });
    const latencyMs = Math.round(performance.now() - started);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: response.status === 401 ? "API Key 被拒绝" : `网关返回 ${response.status}`,
        latencyMs,
        health,
      };
    }
    const body = (await response.json().catch(() => undefined)) as { data?: unknown } | undefined;
    const models = Array.isArray(body?.data) ? body.data.length : undefined;
    return {
      ok: true,
      status: response.status,
      message: models === undefined ? "连接成功" : `连接成功，网关报告 ${models} 个模型`,
      latencyMs,
      health,
      ...(models === undefined ? {} : { models }),
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      message: aborted ? "连接超时" : "无法连接网关",
      latencyMs: Math.round(performance.now() - started),
      health,
    };
  } finally {
    clearTimeout(timer);
  }
};

export type GatewayApi = {
  readonly public: () => PublicGateway;
  readonly save: (
    input: GatewayInput,
  ) => Promise<{ readonly settings: PublicGateway; readonly error?: string }>;
  readonly test: (input: GatewayInput) => Promise<GatewayTest>;
};

export {
  DEFAULT_HC,
  type HcConfig,
  type HcRole,
  MAX_HC_MODEL,
  normalizeHc,
} from "../core/domain.ts";
