// The skills a person ticked, offered to every Bot (docs/bots/EXTENSIONS-AND-TOOLS.md,
// "Skills"). The selection is the switch, so this extension has no tool group: the prompt
// section is an index, and skill_read reads one selected `SKILL.md`. Neither does filesystem
// work until the model asks for a file.
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  section,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILE_LINES,
  readSelectedSkill,
  type SelectedSkill,
  skillSection,
} from "../../skills/selection.ts";

export const SKILLS_EXTENSION = "bots-skills";
export const SKILLS_SECTION = "bots-skills";

export type SkillToolsOptions = {
  /** Read on every ask and every call, so a tick lands without reopening the conversation. */
  readonly read: () => readonly SelectedSkill[];
  /** What `~` means; the daemon's own home unless a test points elsewhere. */
  readonly home?: () => string;
};

export const createSkillTools = (options: SkillToolsOptions): readonly ToolRegistration[] => [
  defineTool({
    name: "skill_read",
    description:
      "Read the SKILL.md of one skill this person selected for this machine. Call it with the skill's name, exactly as the prompt lists it, before following that skill: the file holds the instructions, the prompt holds only the index. A name that is not selected is refused.",
    parameters: Type.Object({
      name: Type.String({ description: "The selected skill's name, from the prompt's list" }),
    }),
    execute: async (args) => {
      const outcome = await readSelectedSkill(
        options.read(),
        args.name,
        options.home === undefined ? undefined : options.home(),
      );
      return "text" in outcome
        ? { output: [{ type: "text" as const, text: outcome.text }] }
        : { output: [{ type: "text" as const, text: outcome.refusal }], isError: true };
    },
    // The read's own budgets are the limits: the harness must not cut the manifest (or the
    // truncation note) a second time, with its own smaller defaults.
    outputLimits: {
      maxBytes: MAX_SKILL_FILE_BYTES + 4_096,
      maxLines: MAX_SKILL_FILE_LINES + 16,
      retain: "head",
    },
  }),
];

export const skillsExtension = (options: SkillToolsOptions) =>
  defineExtension({
    name: SKILLS_EXTENSION,
    tools: createSkillTools(options),
    sections: [section(SKILLS_SECTION, () => skillSection(options.read()))],
  });
