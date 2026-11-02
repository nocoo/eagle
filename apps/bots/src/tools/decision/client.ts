// What a bot may ask a System One decision provider (docs/bots/PROTOCOL.md, "Providers"): the
// wire shape is TypeSafe's own, so a tool call is the documented request and nothing is
// re-invented here. The client is resolved per call, so a key or provider change lands on the
// next judgment instead of the next conversation.
export type DecisionEntry = string | Record<string, unknown> | readonly unknown[];

export type DecisionQuestion =
  | {
      readonly type: "choice";
      readonly instructions: DecisionEntry;
      readonly criteria: Readonly<Record<string, DecisionEntry>>;
    }
  | {
      readonly type: "noul";
      readonly instructions: DecisionEntry;
      readonly criteria?: { readonly true?: DecisionEntry; readonly false?: DecisionEntry };
    }
  | {
      readonly type: "score";
      readonly instructions: DecisionEntry;
      readonly criteria: readonly DecisionEntry[];
    };

export type DecisionRequest = {
  /** Text, a JSON object or an array: Jev reads all three, and paths address a structure. */
  readonly state: DecisionEntry;
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
};

export type DecisionAnswer =
  | {
      readonly type: "choice";
      readonly choice: string;
      readonly probabilities: Readonly<Record<string, number>>;
      readonly confidence?: number;
    }
  | { readonly type: "noul"; readonly noul: number }
  | {
      readonly type: "score";
      /** A position along the levels; it may fall between two of them. */
      readonly score: number;
      readonly legend: readonly string[];
      readonly probabilities: readonly number[];
      readonly confidence?: number;
    };

export type DecisionReply = {
  readonly answers: Readonly<Record<string, DecisionAnswer>>;
  /** The model the answer names, when it names one: the requested alias is not evidence. */
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
};

export type DecisionClient = {
  /** One request, one aborted signal, no retry: an answer may already have been paid for. */
  ask(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionReply>;
};
