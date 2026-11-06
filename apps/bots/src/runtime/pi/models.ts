// The daemon's model registry (docs/bots/RUNTIME.md, "The model registry"): one gateway
// provider, every model the gateway offers, and what the daemon will ask of each of them.
// The endpoint and the key are global; the model and the reasoning level belong to one
// bot, so the registry holds many models and never swaps one for another.
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

/**
 * What the daemon will request from one model of the gateway. The gateway publishes ids
 * and nothing else, so the window and the token cap are the daemon's own and the level is
 * a request, not a claim about the model.
 */
export type ModelMetadata = {
  readonly id: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly reasoning: boolean;
  /** The levels the daemon may request; `xhigh` and `max` are mapped to themselves. */
  readonly thinkingLevels: readonly ModelThinkingLevel[];
};

/**
 * Every level, mapped to itself — except `off`, which means no reasoning at all and is the
 * one value pi-ai reads as the model's "no effort" name. A gateway alias says nothing about
 * the model behind it, and pi-ai lowers `xhigh` and `max` unless the model declares them,
 * so the map is explicit: the daemon sends the level the person chose and the gateway
 * decides what it takes. A refusal is the run's error, never a silent fallback.
 */
const REQUESTED_LEVELS: NonNullable<Model<Api>["thinkingLevelMap"]> = {
  off: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/** The gateway's own model: its id, its endpoint and what the daemon will ask of it. */
const gatewayModel = (
  id: string,
  options: {
    readonly provider: string;
    readonly baseUrl: string;
    readonly contextWindow: number;
    readonly maxTokens: number;
  },
): Model<"openai-responses"> => ({
  id,
  name: id,
  provider: options.provider,
  baseUrl: options.baseUrl,
  api: "openai-responses",
  reasoning: true,
  input: ["text"],
  contextWindow: options.contextWindow,
  maxTokens: options.maxTokens,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  thinkingLevelMap: REQUESTED_LEVELS,
});

export type ModelRegistryOptions = {
  readonly provider: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  /** The window the daemon declares; compaction thresholds count from it. */
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
  /** The provider id the collection currently holds, so a moved id can be removed. */
  #installed: string | undefined;
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

  /** What the daemon will request from each model it knows. */
  metadata(): readonly ModelMetadata[] {
    return this.#ids.map((id) => {
      const model = this.#models.getModel(this.#options.provider, id);
      return {
        id,
        contextWindow: model?.contextWindow ?? this.#options.contextWindow,
        maxTokens: model?.maxTokens ?? this.#options.maxTokens,
        reasoning: model?.reasoning ?? true,
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
    // The daemon asks for the list itself. pi-ai's `refresh()` keeps a per-provider store
    // and would restore the models of the previous endpoint under the new key, so the
    // registry owns this: one answer, then one provider built from the current options.
    const controller = new AbortController();
    const listed = await this.#fetchIds(controller.signal);
    if (listed === undefined) {
      this.#discoveryError = "the gateway could not be asked for its models";
      return { ok: false, error: this.#discoveryError };
    }
    this.#listed = new Set(listed);
    this.#discoveryError = undefined;
    this.#install();
    return { ok: true };
  }

  /** The levels a model takes, as the registry will run it. */
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

  /** One provider, rebuilt in place: the models it holds are the ones the daemon knows. */
  #install(): void {
    const options = this.#options;
    // A provider id that moved must be gone from the collection: a live Harness reads the
    // collection at each access, and a leftover provider still holds the old address and
    // key. Removing it makes the old endpoint unreachable rather than merely unused.
    if (this.#installed !== undefined && this.#installed !== options.provider) {
      this.#models.deleteProvider(this.#installed);
    }
    this.#installed = options.provider;
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
        api: openAIResponsesApi(),
      }),
    );
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
}
