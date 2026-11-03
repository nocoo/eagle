// The secret card (docs/bots/EXTENSIONS-AND-TOOLS.md §6.5): the card is the tool call's own
// arguments, read back from the transcript, so a restart loses nothing and the daemon never
// stores the card twice. The hidden message the person triggers names the record, its scope
// and its lifetime — never the value.
import type { Message, SecretScope } from "./domain.ts";

export const SECRET_REQUEST_TOOL = "secret_request";

export type SecretCard = {
  /** The record's identity: what secret_read takes later. */
  readonly key: string;
  /** One line saying what the value is for; it is kept on the record. */
  readonly purpose: string;
  /** What the card preselects; the person has the last word. */
  readonly scope: SecretScope;
  /** The lifetime the card preselects; absent means the record is permanent. */
  readonly ttlMinutes?: number;
};

/**
 * What a client reports back for a secret card: the key the card named, the value the
 * person typed, and the two choices the person has the last word on.
 */
export type SecretAnswerInput = {
  /** The transcript entry that carries the secret_request call: the card a client renders. */
  readonly entryId: string;
  /**
   * Which call of that entry, from zero. One model response may ask for two passwords, and
   * each card is its own question, so the answer names the one it answers.
   */
  readonly callIndex?: number;
  /** The record's name; it must be the card's own key. */
  readonly key: string;
  /** The value the person typed; it never reaches the transcript. */
  readonly value: string;
  /** Absent keeps the card's scope, which is this Bot's own record. */
  readonly scope?: SecretScope;
  /** Absent keeps the card's lifetime, `null` makes the record permanent. */
  readonly ttlMinutes?: number | null;
  readonly skipped?: boolean;
  /** The caller's own trace, so the admission is logged against one command. */
  readonly trace?: string;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * The name a secret card's answer is written back under. It is always namespaced, so an
 * `ask_user` answer for the same entry — which names the entry itself — cannot close a secret
 * card, and the second card of one answer appends its index.
 */
export const secretAnswersTo = (entryId: string, index = 0): string =>
  index === 0 ? `secret:${entryId}` : `secret:${entryId}#${index}`;

/** How many secret cards one entry carries: a model may ask for two passwords at once. */
export const secretCardCount = (message: Message): number =>
  message.blocks.filter((block) => block.type === "toolCall" && block.name === SECRET_REQUEST_TOOL)
    .length;

/**
 * The card one secret_request call asked for, read from the transcript itself: the call's
 * arguments are the only record of what was asked. `index` picks the call, so two cards in
 * one answer stay two questions.
 */
export const secretCardOf = (message: Message, index = 0): SecretCard | undefined => {
  const calls = message.blocks.filter(
    (block): block is Extract<Message["blocks"][number], { type: "toolCall" }> =>
      block.type === "toolCall" && block.name === SECRET_REQUEST_TOOL,
  );
  const block = calls[index];
  if (block !== undefined) {
    const args = asRecord(block.args);
    if (args === undefined) return undefined;
    const key = args.key;
    const purpose = args.purpose;
    if (typeof key !== "string" || key.length === 0) return undefined;
    if (typeof purpose !== "string" || purpose.length === 0) return undefined;
    const scope = args.scope === undefined ? "bot" : args.scope;
    if (scope !== "bot" && scope !== "shared") return undefined;
    const ttl = args.ttlMinutes;
    return {
      key,
      purpose,
      scope,
      ...(typeof ttl === "number" ? { ttlMinutes: ttl } : {}),
    };
  }
  return undefined;
};

/** A lifetime the way a person says it. */
const duration = (minutes: number): string => {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hoursText = `${hours} hour${hours === 1 ? "" : "s"}`;
  if (rest === 0) return hoursText;
  return `${hoursText} ${rest} minute${rest === 1 ? "" : "s"}`;
};

/**
 * The message the bot reads next. It names the record, who may read it and how long it
 * lives, and never the value: the bot reads that with secret_read when it needs it.
 */
export const secretAnswerText = (
  card: SecretCard,
  input: {
    readonly entryId: string;
    readonly callIndex?: number;
    readonly scope?: SecretScope;
    /** The lifetime that was actually stored: absent means the record never expires. */
    readonly ttlMinutes?: number;
    readonly skipped?: boolean;
  },
): string => {
  if (input.skipped === true) {
    return `The person skipped the secret request for "${card.key}" from ${input.entryId} without answering. Continue without the secret, and do not ask for it again in this turn.`;
  }
  const scope = input.scope ?? card.scope;
  const where = scope === "shared" ? "every bot on this machine" : "this bot only";
  // The stored lifetime is the answer's own, never the card's suggestion: a person who
  // chose 永久 must not be reported as a one-hour record.
  const life =
    input.ttlMinutes === undefined ? "no expiry" : `expires in ${duration(input.ttlMinutes)}`;
  return `The person saved the secret "${card.key}" (${where}, ${life}) from ${input.entryId}. Read it with secret_read and use the environment variable it names; the value itself never enters the conversation.`;
};
