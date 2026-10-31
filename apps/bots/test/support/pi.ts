// A real pi-durable runtime over real sqlite and pi-ai's faux provider: the model network
// is the only thing faked here (docs/bots/TESTING.md, "What may be faked").
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  type FauxContentBlock,
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { Storage } from "@earendil-works/pi-durable";
import type { RuntimeBotSpec } from "../../src/core/RuntimePort.ts";
import { captureLog, type LogRecord } from "../../src/log/log.ts";
import {
  PiDurableRuntime,
  type PiRuntimeOptions,
  type PiSettings,
} from "../../src/runtime/pi/PiDurableRuntime.ts";
import type { SearchClient } from "../../src/tools/search/client.ts";
import type { UsageMeter } from "../../src/tools/usage.ts";

export { getCurrentSystemMessage } from "@earendil-works/pi-ai";

export const trace = "tr_runtime_1";
export const requestId = "r_runtime_1";

export type Bench = {
  readonly runtime: PiDurableRuntime;
  readonly faux: FauxProviderHandle;
  readonly records: LogRecord[];
  readonly dir: string;
  spec(trace?: string): RuntimeBotSpec;
  cleanup(): Promise<void>;
};

export type BenchOptions = {
  readonly settings?: PiSettings;
  readonly provider?: Parameters<typeof fauxProvider>[0];
  readonly storage?: (path: string) => Promise<Storage>;
  readonly windowMessages?: number;
  readonly maxMessageBytes?: number;
  readonly search?: (spec: RuntimeBotSpec) => SearchClient | undefined;
  readonly usage?: UsageMeter;
};

export const createBench = async (options: BenchOptions = {}): Promise<Bench> => {
  const faux = fauxProvider(options.provider ?? {});
  const models = createModels();
  models.setProvider(faux.provider);
  const dir = await mkdtemp(join(tmpdir(), "bots-runtime-"));
  const { log, records } = captureLog();
  const runtimeOptions: PiRuntimeOptions = {
    models,
    log,
    ...(options.settings === undefined ? {} : { settings: () => options.settings as PiSettings }),
    ...(options.storage === undefined ? {} : { storage: options.storage }),
    ...(options.windowMessages === undefined ? {} : { windowMessages: options.windowMessages }),
    ...(options.maxMessageBytes === undefined ? {} : { maxMessageBytes: options.maxMessageBytes }),
    ...(options.search === undefined ? {} : { search: options.search }),
    ...(options.usage === undefined ? {} : { usage: options.usage }),
  };
  return {
    runtime: new PiDurableRuntime(runtimeOptions),
    faux,
    records,
    dir,
    spec: (specTrace = trace) => ({
      id: "b_runtime",
      dir: join(dir, "b_runtime"),
      model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
      trace: specTrace,
    }),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
};

/** Resolves once `check` is true, or fails the test after a real deadline. */
export const waitFor = async (
  check: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5_000,
): Promise<void> => {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

export const text = (value: string | FauxContentBlock | FauxContentBlock[]) =>
  fauxAssistantMessage(value);
export const assistant = fauxAssistantMessage;
export const textBlock = fauxText;
export const toolCall = fauxToolCall;
export const providerError = (message = "upstream 500") =>
  fauxAssistantMessage("", { stopReason: "error", errorMessage: message });
/** A response that never resolves, so the attempt stays in flight. */
export const hanging = () => () => new Promise<never>(() => undefined);

/** A storage whose `close` never resolves, so a harness close cannot finish (row 36). */
export const hangingCloseStorage = (
  open: (path: string) => Promise<Storage>,
  counter: { calls: number } = { calls: 0 },
) => {
  const factory = async (path: string): Promise<Storage> => {
    const inner = await open(path);
    return new Proxy(inner, {
      get(target, property, receiver) {
        if (property === "close") {
          return () => {
            counter.calls += 1;
            return new Promise<void>(() => undefined);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
  };
  return { factory, counter };
};

/** Storage that starts failing commits once armed, so a session failure is deterministic. */
export const armedFailureStorage = (open: (path: string) => Promise<Storage>) => {
  const state = { armed: false, failed: 0 };
  const factory = async (path: string): Promise<Storage> => {
    const inner = await open(path);
    return new Proxy(inner, {
      get(target, property, receiver) {
        if (property === "commit") {
          return async (...args: unknown[]) => {
            if (state.armed) {
              state.failed += 1;
              throw new Error("storage went away");
            }
            return (target.commit as (...rest: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
  };
  return { factory, state, arm: () => (state.armed = true) };
};
