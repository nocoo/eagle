// The invocation boundary (docs/bots/TRIGGERS.md, "Invocation contract"): the one way a
// caller without a client connection admits work to a bot. It owns no queue, no timer and
// no rate limit; those are caller policy, so a caller can be replaced without touching core.
import type { BusyMode, Submission } from "./domain.ts";

/** Who admitted the work. Closed on purpose: `unknown` is a reconstruction, never input. */
export type InvocationOrigin =
  | { readonly kind: "human" }
  | { readonly kind: "schedule"; readonly triggerId: string }
  | { readonly kind: "webhook"; readonly triggerId: string }
  | { readonly kind: "peer"; readonly fromBotId: string; readonly exchangeId?: string }
  | { readonly kind: "unknown" };

export type Invocation = {
  readonly botId: string;
  /** Caller-owned and durable: pi dedupes by it inside one conversation, across restarts. */
  readonly requestId: string;
  readonly text: string;
  readonly contextId?: string;
  readonly resourceHead?: string;
  readonly origin: InvocationOrigin;
  readonly whenBusy?: BusyMode;
  readonly trace: string;
};

export interface InvocationPort {
  /** Idempotent by `(botId, requestId)`. Returns the admission record, never the answer. */
  invoke(input: Invocation): Promise<Submission>;
  /** Durable lookup, including a settled record after a restart. */
  submission(query: {
    readonly botId: string;
    readonly requestId: string;
    readonly contextId?: string;
  }): Promise<Submission | undefined>;
  /** Delivers the current run state on attach, then transitions. Never opens the bot. */
  observe(botId: string, sink: (running: boolean) => void): { detach(): void };
}

/** Mirrors `protocol/limits.ts#REQUEST_ID`; `test/core/invocation.test.ts` fails on drift. */
export const INVOCATION_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Mirrors `protocol/limits.ts#MAX_SEND_TEXT`, in code points. */
export const MAX_INVOCATION_TEXT = 8_000;
