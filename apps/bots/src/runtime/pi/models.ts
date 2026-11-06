// The daemon's model registry (docs/bots/RUNTIME.md, "The model registry"): one gateway
// provider, every model the gateway offers, and the facts the daemon needs about each of
// them. The endpoint and the key are global; the model and the reasoning level belong to
// one bot, so the registry holds many models and never swaps one for another.
import {
  type Api,
  createModels,
  createProvider,
  getSupportedThinkingLevels,
  type Model,
  type Models,
  type ModelThinkingLevel,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

/** What the daemon knows about one model of the gateway. */
export type ModelMetadata = {
  readonly id: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly reasoning: boolean;
  /** The reasoning levels the model accepts; `xhigh` and `max` are opt-in per model. */
  readonly thinkingLevels: readonly ModelThinkingLevel[];
};

/** The facts the catalogue knows about one model. */
type CatalogEntry = {
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly reasoning: boolean;
  readonly thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
};

/**
 * The levels a model the daemon cannot describe accepts: every level, sent as it is.
 * The daemon does not know the model's limits, so it does not lower a level behind the
 * person's back; the gateway decides what it takes.
 */
const PASS_THROUGH_LEVELS: NonNullable<Model<Api>["thinkingLevelMap"]> = {
  off: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

let catalogIndex: Map<string, CatalogEntry> | undefined;

/**
 * pi-ai's own catalogue: the real facts about the models it knows. A gateway id is
 * matched by its full id and by the name after its last `/`, because a routing gateway
 * publishes `auto/gpt-6-luna` for the model the catalogue calls `gpt-6-luna`.
 */
const catalog = (): Map<string, CatalogEntry> => {
  if (catalogIndex !== undefined) return catalogIndex;
  const index = new Map<string, CatalogEntry>();
  for (const provider of getBuiltinProviders()) {
    for (const model of getBuiltinModels(provider) as readonly Model<Api>[]) {
      if (index.has(model.id)) continue;
      index.set(model.id, {
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        reasoning: model.reasoning,
        ...(model.thinkingLevelMap === undefined
          ? {}
          : { thinkingLevelMap: model.thinkingLevelMap }),
      });
    }
  }
  catalogIndex = index;
  return index;
};

const entryFor = (id: string): CatalogEntry | undefined => {
  const index = catalog();
  return index.get(id) ?? index.get(id.slice(id.lastIndexOf("/") + 1));
};

/** The gateway's own model: its id, its endpoint and what the catalogue knows about it. */
const gatewayModel = (
  id: string,
  options: {
    readonly provider: string;
    readonly baseUrl: string;
    readonly contextWindow: number;
    readonly maxTokens: number;
  },
): Model<"openai-responses"> => {
  const known = entryFor(id);
  return {
    id,
    name: id,
    provider: options.provider,
    baseUrl: options.baseUrl,
    api: "openai-responses",
    reasoning: known?.reasoning ?? true,
    input: ["text"],
    contextWindow: known?.contextWindow ?? options.contextWindow,
    maxTokens: known?.maxTokens ?? options.maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(known?.thinkingLevelMap === undefined
      ? { thinkingLevelMap: PASS_THROUGH_LEVELS }
      : { thinkingLevelMap: known.thinkingLevelMap }),
  };
};

export type ModelRegistryOptions = {
  readonly provider: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  /** The window the daemon declares for a model nothing describes. */
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly fetch?: typeof fetch;
};

const DISCOVERY_TIMEOUT_MS = 8_000;

/**
 * The registry: one provider, many models, and a discovery that keeps what it knows
 * when the gateway cannot be asked.
 */
export class ModelRegistry {
  #options: ModelRegistryOptions;
  readonly #models: MutableModels;
  /** The ids that must stay usable: what a bot stores and what the default names. */
  readonly #referenced = new Set<string>();
  /** The ids the gateway listed the last time it could be asked. */
  #listed = new Set<string>();
  /** The ids the registry holds, as the last install left them. */
  #ids: readonly string[] = [];
  #discoveryError: string | undefined;

  constructor(options: ModelRegistryOptions) {
    this.#options = options;
    this.#models = createModels();
    this.#install();
  }

  /** The collection every Harness reads; it is replaced in place, never swapped. */
  get models(): Models {
    return this.#models;
  }

  /** The ids the daemon knows: what the gateway listed and what a bot or the default names. */
  ids(): readonly string[] {
    return [...this.#ids];
  }

  /** What the daemon knows about each model it knows. */
  metadata(): readonly ModelMetadata[] {
    return this.ids().map((id) => {
      const model = this.#models.getModel(this.#options.provider, id);
      const known = entryFor(id);
      return {
        id,
        contextWindow: model?.contextWindow ?? known?.contextWindow ?? this.#options.contextWindow,
        maxTokens: model?.maxTokens ?? known?.maxTokens ?? this.#options.maxTokens,
        reasoning: model?.reasoning ?? known?.reasoning ?? true,
        thinkingLevels: model === undefined ? [] : [...getSupportedThinkingLevels(model)],
      };
    });
  }

  /** The last discovery failure, or undefined when the gateway answered. */
  get discoveryError(): string | undefined {
    return this.#discoveryError;
  }

  /**
   * Keeps ids usable even when the gateway does not list them: a bot that stores a model
   * the gateway dropped still runs with it.
   */
  ensure(ids: readonly string[]): void {
    let changed = false;
    for (const id of ids) {
      if (id.length === 0 || this.#referenced.has(id)) continue;
      this.#referenced.add(id);
      changed = true;
    }
    if (changed) this.#install();
  }

  /** The gateway changed: the endpoint, the key and the provider are global. */
  reconfigure(options: ModelRegistryOptions): void {
    this.#options = options;
    this.#install();
  }

  /**
   * Asks the gateway which models it offers. A failure keeps the models the daemon
   * already knows and is reported apart from a gateway that offers none.
   */
  async discover(): Promise<{ readonly ok: boolean; readonly error?: string }> {
    if (this.#options.baseUrl.length === 0 || this.#options.apiKey.length === 0) {
      this.#discoveryError = "the gateway has no address or no key";
      return { ok: false, error: this.#discoveryError };
    }
    const result = await this.#models.refresh({ providers: [this.#options.provider] });
    const failure = result.errors.get(this.#options.provider);
    if (failure !== undefined) {
      this.#discoveryError = failure.message;
      return { ok: false, error: this.#discoveryError };
    }
    this.#discoveryError = undefined;
    // The provider is rebuilt with the ids it just learned, so the collection holds
    // exactly what the daemon knows and a model the gateway dropped stops being offered.
    this.#install();
    return { ok: true };
  }

  /** What the daemon knows about one model: the levels it accepts. */
  support(model: { readonly provider: string; readonly modelId: string }): {
    readonly known: boolean;
    readonly levels: readonly string[];
  } {
    const registered = this.#models.getModel(model.provider, model.modelId);
    const described =
      registered ??
      gatewayModel(model.modelId, {
        provider: model.provider,
        baseUrl: this.#options.baseUrl,
        contextWindow: this.#options.contextWindow,
        maxTokens: this.#options.maxTokens,
      });
    return { known: true, levels: [...getSupportedThinkingLevels(described)] };
  }

  /** The ids the gateway lists, or undefined when it could not be asked. */
  async #fetchIds(signal: AbortSignal): Promise<readonly string[] | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
    timer.unref?.();
    const stop = (): void => {
      clearTimeout(timer);
      controller.abort();
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      const request = this.#options.fetch ?? fetch;
      const response = await request(`${this.#options.baseUrl.replace(/\/$/, "")}/models`, {
        headers: { authorization: `Bearer ${this.#options.apiKey}` },
        signal: controller.signal,
      });
      if (!response.ok) return undefined;
      const body = (await response.json().catch(() => undefined)) as { data?: unknown } | undefined;
      if (!Array.isArray(body?.data)) return undefined;
      return body.data.flatMap((item) => {
        const id = (item as { id?: unknown }).id;
        return typeof id === "string" && id.length > 0 ? [id] : [];
      });
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    }
  }

  /** One provider, rebuilt in place: the models it holds are the ones the daemon knows. */
  #install(): void {
    const options = this.#options;
    // Without an endpoint or a key there is no gateway to run a model against, so the
    // registry holds nothing and a run settles `no_model`.
    const configured = options.baseUrl.length > 0 && options.apiKey.length > 0;
    const ids = configured ? [...new Set([...this.#listed, ...this.#referenced])] : [];
    this.#ids = ids;
    this.#models.setProvider(
      createProvider({
        id: options.provider,
        name: "Bots model endpoint",
        baseUrl: options.baseUrl,
        auth: {
          apiKey: {
            name: "Bots model API key",
            resolve: async () =>
              options.apiKey.length > 0 ? { auth: { apiKey: options.apiKey } } : undefined,
          },
        },
        models: ids.map((id) => gatewayModel(id, options)),
        fetchModels: async (context) => {
          const listed = await this.#fetchIds(context.signal);
          if (listed === undefined) {
            throw new Error("the gateway could not be asked for its models");
          }
          this.#listed = new Set(listed);
          return listed.map((id) => gatewayModel(id, options));
        },
        api: openAIResponsesApi(),
      }),
    );
  }
}
