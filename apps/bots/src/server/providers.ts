// Third-party providers a bot's tools may call (docs/bots/PROTOCOL.md, "Providers"): the
// catalogue is code (id, title, service, endpoint, model, docs), the secret is stored under the
// user's home config with 0600, and the public shape only says whether a key is set. Adding a
// provider is a definition here, not a new store.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The two things a provider is for. A person selects one of each independently: the search
 * provider serves `web_search`/`web_fetch`, the decision provider answers System One questions.
 */
export type ProviderService = "search" | "decision";

export type ProviderDefinition = {
  readonly id: string;
  readonly title: string;
  readonly service: ProviderService;
  readonly kind: "deepseek-search" | "tavily-search" | "systemone";
  /** The API root: a decision provider appends `/v1/systemone`; search clients use it as-is. */
  readonly baseUrl: string;
  /** The model a decision provider asks for by default; empty for a search provider. */
  readonly model: string;
  readonly docsUrl: string;
  /** What the key field asks for, in the person's words. */
  readonly keyLabel: string;
  /** A relay may carry its own upstream credential, so its key field is optional. */
  readonly keyRequired: boolean;
};

export const PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: "deepseek-search",
    title: "DeepSeek",
    service: "search",
    kind: "deepseek-search",
    baseUrl: "https://api.deepseek.com",
    model: "",
    docsUrl: "https://api-docs.deepseek.com/guides/search/",
    keyLabel: "DeepSeek API Key",
    keyRequired: true,
  },
  {
    id: "tavily-search",
    title: "Tavily",
    service: "search",
    kind: "tavily-search",
    baseUrl: "https://api.tavily.com",
    model: "",
    docsUrl: "https://docs.tavily.com/documentation/quickstart",
    keyLabel: "Tavily API Key",
    keyRequired: true,
  },
  {
    id: "typesafe",
    title: "TypeSafe",
    service: "decision",
    kind: "systemone",
    baseUrl: "https://api.typesafe.ai",
    model: "jev-latest",
    docsUrl: "https://docs.typesafe.ai/introduction",
    keyLabel: "TypeSafe API Key",
    keyRequired: true,
  },
  {
    id: "falcon",
    title: "Falcon",
    service: "decision",
    kind: "systemone",
    baseUrl: "http://127.0.0.1:19823",
    model: "jev-latest",
    docsUrl: "https://github.com/nocoo/falcon/blob/main/docs/03-protocol.md",
    keyLabel: "Falcon Source Key",
    keyRequired: true,
  },
  {
    id: "falcon-relay",
    title: "Falcon Relay",
    service: "decision",
    kind: "systemone",
    baseUrl: "https://falcon.hexly.ai",
    model: "jev-latest",
    docsUrl: "https://github.com/nocoo/falcon/blob/main/docs/09-relay.md",
    keyLabel: "Relay Token",
    keyRequired: true,
  },
  {
    id: "jev-relay",
    title: "Jev 中转站",
    service: "decision",
    kind: "systemone",
    baseUrl: "http://127.0.0.1:3425",
    model: "typesafe/jev-latest",
    docsUrl: "",
    keyLabel: "中转站 API Key（可留空）",
    keyRequired: false,
  },
  {
    id: "raven",
    title: "Raven",
    service: "decision",
    kind: "systemone",
    baseUrl: "http://127.0.0.1:7024",
    model: "microsoft-decision-1",
    docsUrl: "https://github.com/nocoo/raven/blob/main/docs/30-systemone.md",
    keyLabel: "Raven API Key",
    keyRequired: true,
  },
];

export type ProviderConfig = {
  readonly apiKey: string;
  readonly enabled: boolean;
  /** A stored override of the catalogue address, kept only while it differs from it. */
  readonly baseUrl?: string;
  /** A stored override of the catalogue model name, kept only while it differs from it. */
  readonly model?: string;
};

export type PublicProvider = {
  readonly id: string;
  readonly title: string;
  readonly service: ProviderService;
  readonly kind: ProviderDefinition["kind"];
  readonly baseUrl: string;
  readonly model: string;
  readonly docsUrl: string;
  readonly keyLabel: string;
  readonly keyRequired: boolean;
  readonly hasApiKey: boolean;
  readonly enabled: boolean;
  /** What the catalogue says, so a page can name the value an override falls back to. */
  readonly defaults: { readonly baseUrl: string; readonly model: string };
};

export type ProviderInput = {
  readonly apiKey?: string;
  readonly enabled?: boolean;
  /** Empty means "use the catalogue address again". */
  readonly baseUrl?: string;
  /** Empty means "use the catalogue model name again". */
  readonly model?: string;
};

/** The file lives in the user's own config, not beside this machine's daemon state. */
export const providersPath = (): string =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "eagle-bots", "providers.json");

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** A malformed file is "nothing configured", never a crash. */
export const readProviders = async (
  path: string = providersPath(),
): Promise<Readonly<Record<string, ProviderConfig>>> => {
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return {};
  try {
    const raw = JSON.parse(text) as unknown;
    if (!isObject(raw) || !isObject(raw.providers)) return {};
    const out: Record<string, ProviderConfig> = {};
    for (const [id, value] of Object.entries(raw.providers)) {
      if (!isObject(value) || typeof value.apiKey !== "string") continue;
      const baseUrl = optionalString(value.baseUrl);
      const model = optionalString(value.model);
      out[id] = {
        apiKey: value.apiKey,
        enabled: value.enabled === true,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(model === undefined ? {} : { model }),
      };
    }
    return out;
  } catch {
    return {};
  }
};

export const writeProviders = async (
  configs: Readonly<Record<string, ProviderConfig>>,
  path: string = providersPath(),
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, providers: configs }, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
};

export const publicProviders = (
  configs: Readonly<Record<string, ProviderConfig>>,
): readonly PublicProvider[] =>
  PROVIDERS.map((provider) => {
    const config = configs[provider.id];
    return {
      id: provider.id,
      title: provider.title,
      service: provider.service,
      kind: provider.kind,
      baseUrl: config?.baseUrl ?? provider.baseUrl,
      model: config?.model ?? provider.model,
      docsUrl: provider.docsUrl,
      keyLabel: provider.keyLabel,
      keyRequired: provider.keyRequired,
      hasApiKey: (config?.apiKey.length ?? 0) > 0,
      enabled: selectedProvider(configs, provider.service)?.id === provider.id,
      defaults: { baseUrl: provider.baseUrl, model: provider.model },
    };
  });

export const providerDefinition = (id: string): ProviderDefinition | undefined =>
  PROVIDERS.find((provider) => provider.id === id);

export type ProviderProbe = {
  readonly ok: boolean;
  readonly message: string;
  readonly latencyMs: number;
  /** How many results a search probe returned. */
  readonly results?: number;
  /** The model id the probe asked for, and the one the answer reports. */
  readonly model?: string;
  readonly resolvedModel?: string;
};

/** What the HTTP layer may ask of the provider settings. */
export type ProviderApi = {
  public(): readonly PublicProvider[];
  save(id: string, input: ProviderInput): Promise<{ provider?: PublicProvider; error?: string }>;
  test(id: string): Promise<ProviderProbe>;
};

/**
 * The single chosen provider of one service, or nothing: an ambiguous stored selection picks no
 * provider rather than the first one in catalogue order.
 */
export const selectedProvider = (
  configs: Readonly<Record<string, ProviderConfig>>,
  service: ProviderService,
): ProviderDefinition | undefined => {
  const selected = PROVIDERS.filter(
    (provider) => provider.service === service && configs[provider.id]?.enabled,
  );
  const [candidate] = selected;
  if (candidate === undefined || selected.length > 1) return undefined;
  return candidate.keyRequired && !(configs[candidate.id]?.apiKey.trim() ?? "")
    ? undefined
    : candidate;
};
