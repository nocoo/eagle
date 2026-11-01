// The Bot's own sidebar note (docs/bots/EXTENSIONS-AND-TOOLS.md, core group): one line a
// person reads without opening the conversation, normalized and bounded on the way in.
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { MAX_BOT_NOTE_CHARS, normalizeBotNote } from "../core/domain.ts";
import { failed, type NoteToolHost, type ToolOutcome } from "./types.ts";

const respond = (outcome: ToolOutcome) => ({
  output: [{ type: "text" as const, text: outcome.output }],
  ...(outcome.isError === true ? { isError: true } : {}),
});

export const createNoteSetTool = (host: NoteToolHost | undefined) =>
  defineTool({
    name: "note_set",
    description: `Set the one line a person sees next to this bot in their sidebar. It is a status, so update it when the work changes, not every turn. At most ${MAX_BOT_NOTE_CHARS} characters after trimming and whitespace collapse; an empty text clears it.`,
    parameters: Type.Object({
      text: Type.String({
        description: "The status line to show; an empty string clears it",
      }),
    }),
    replay: "safe",
    async execute(args) {
      const text = normalizeBotNote(args.text);
      if (text !== undefined && text.length > MAX_BOT_NOTE_CHARS) {
        return respond(
          failed(
            `a note is at most ${MAX_BOT_NOTE_CHARS} characters after trimming and whitespace collapse; it was not written`,
          ),
        );
      }
      if (host === undefined) return respond(failed("this bot has no catalog to write a note to"));
      try {
        const note = (await host.set(text ?? "")).note;
        return respond({ output: note === undefined ? "note cleared" : `note set: ${note}` });
      } catch (error) {
        return respond(failed(error instanceof Error ? error.message : "the note was not written"));
      }
    },
  });
