// Asking the person something (docs/bots/EXTENSIONS-AND-TOOLS.md, "ask_user"): the tool puts a
// card in front of them and returns at once, and their choices come back as one hidden user
// message. The daemon owns that message's wording, so the App and the CLI only report choices.
import { DirectoryError } from "./BotDirectory.ts";
import type { Message } from "./domain.ts";

export const ASK_TOOL_NAME = "ask_user";

export type AskOption = {
  readonly label: string;
  readonly detail?: string;
};

export type AskQuestion = {
  readonly prompt: string;
  readonly kind: "single" | "multi";
  readonly options: readonly AskOption[];
};

/** What a client reports back: one list of chosen labels per question, or a whole-card skip. */
export type AnswerInput = {
  /** The transcript entry that carries the ask_user call: the card a client renders. */
  readonly entryId: string;
  /** The caller's own trace, so the admission is logged against one command. */
  readonly trace?: string;
  readonly skipped?: boolean;
  readonly answers?: readonly (readonly string[])[];
};

const invalid = (message: string): DirectoryError => new DirectoryError("invalid_answer", message);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * The questions an ask_user call asked, read from the transcript itself: the card is the call's
 * arguments, so nothing has to be stored a second time and a restart does not lose it.
 */
export const questionsOf = (message: Message): readonly AskQuestion[] | undefined => {
  for (const block of message.blocks) {
    if (block.type !== "toolCall" || block.name !== ASK_TOOL_NAME) continue;
    const questions = asRecord(block.args)?.questions;
    if (!Array.isArray(questions)) return undefined;
    const parsed: AskQuestion[] = [];
    for (const raw of questions) {
      const question = asRecord(raw);
      const options = question?.options;
      if (question === undefined || !Array.isArray(options)) return undefined;
      const kind = question.kind === "multi" ? "multi" : "single";
      parsed.push({
        prompt: String(question.prompt ?? ""),
        kind,
        options: options.map((option) => {
          const record = asRecord(option) ?? {};
          return {
            label: String(record.label ?? ""),
            ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
          };
        }),
      });
    }
    return parsed;
  }
  return undefined;
};

/**
 * The message the bot reads next. It names the call it answers, so the conversation can close
 * that card, and it repeats each prompt with the labels that were chosen: the model never has to
 * match numbers back to what it asked.
 */
export const answerText = (questions: readonly AskQuestion[], input: AnswerInput): string => {
  if (input.skipped === true) {
    return `The person skipped the questions from ${input.entryId} without answering. Continue without them, and do not ask the same questions again in this turn.`;
  }
  const answers = input.answers;
  if (answers === undefined || answers.length !== questions.length) {
    throw invalid("every question needs one list of choices");
  }
  const lines = [`The person answered the questions from ${input.entryId}:`];
  questions.forEach((question, index) => {
    const chosen = answers[index] ?? [];
    if (chosen.length === 0) throw invalid("every question needs at least one choice");
    if (question.kind === "single" && chosen.length !== 1) {
      throw invalid("a single-choice question takes exactly one choice");
    }
    for (const label of chosen) {
      if (!question.options.some((option) => option.label === label)) {
        throw invalid(`"${label}" is not an option of question ${index + 1}`);
      }
    }
    lines.push(`${index + 1}. ${question.prompt}`, `   chosen: ${chosen.join(", ")}`);
  });
  return lines.join("\n");
};
