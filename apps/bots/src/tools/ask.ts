import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

export const ASK_TOOL = "ask_user";

export const MAX_QUESTIONS = 5;
export const MAX_OPTIONS = 8;
const MAX_PROMPT_CHARS = 240;
const MAX_LABEL_CHARS = 120;
const MAX_DETAIL_CHARS = 240;

/**
 * Questions for the person, asked as a card instead of a sentence in the transcript: the call
 * returns at once and the answer arrives as the next (hidden) user message, so a run never sits
 * waiting on a human. Nothing here blocks, and nothing here decides what the answer means.
 */
export const createAskTool = () =>
  defineTool({
    name: ASK_TOOL,
    description:
      "Ask the person a question with selectable options. This call returns immediately: the questions appear as a card in the conversation, and the person's choices arrive as your next message, so stop after calling it and do not repeat the questions or guess the answer. Each question is single choice or multiple choice, and one call may ask up to five. If the answer is not needed any more, continue and say so.",
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          prompt: Type.String({
            minLength: 1,
            maxLength: MAX_PROMPT_CHARS,
            description: "The question, one line, in the language the person is reading.",
          }),
          kind: Type.Union([Type.Literal("single"), Type.Literal("multi")], {
            description: "single: the person picks one option. multi: one or more.",
          }),
          options: Type.Array(
            Type.Object({
              label: Type.String({
                minLength: 1,
                maxLength: MAX_LABEL_CHARS,
                description: "What the person sees on the row and what you get back when chosen.",
              }),
              detail: Type.Optional(
                Type.String({
                  maxLength: MAX_DETAIL_CHARS,
                  description: "One line under the label, for a cost or a consequence.",
                }),
              ),
            }),
            {
              minItems: 2,
              maxItems: MAX_OPTIONS,
              description: "Two to eight options, in the order they should be read.",
            },
          ),
        }),
        {
          minItems: 1,
          maxItems: MAX_QUESTIONS,
          description: "One to five questions, asked together on one card.",
        },
      ),
    }),
    replay: "safe",
    async execute() {
      return {
        output: [
          {
            type: "text" as const,
            text: "The questions are on the person's screen now. Stop here: their choices arrive as the next message. Do not repeat the questions, and do not assume an answer.",
          },
        ],
      };
    },
  });
