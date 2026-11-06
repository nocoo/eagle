// The skills a person ticked (docs/bots/EXTENSIONS-AND-TOOLS.md, "Skills"): the App owns
// discovery, so the selection is the daemon's only input. Nothing here scans a folder, and
// nothing here accepts a path from the model: a name selects one entry of this list.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** One ticked skill, exactly as the App reports it (docs/bots/PROTOCOL.md, "Gateway settings"). */
export type SelectedSkill = {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  /** The skill's own directory: absolute, or relative to the daemon's home as `~/…`. */
  readonly path: string;
};

export const MAX_SELECTED_SKILLS = 50;
export const MAX_SKILL_NAME = 80;
export const MAX_SKILL_VERSION = 40;
export const MAX_SKILL_DESCRIPTION = 500;
export const MAX_SKILL_PATH = 1_024;
/** The most of one `SKILL.md` a Bot reads in one call: a skill is instructions, not a manual. */
export const MAX_SKILL_FILE = 32_000;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** One line whatever the value held: a newline in a description is not another skill. */
export const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The four strings a skill entry has, or nothing when any of them is missing. */
export const parseSelectedSkill = (value: unknown): SelectedSkill | undefined => {
  if (!isObject(value)) return undefined;
  const { name, version, description, path } = value;
  if (
    typeof name !== "string" ||
    typeof version !== "string" ||
    typeof description !== "string" ||
    typeof path !== "string"
  ) {
    return undefined;
  }
  return { name, version, description, path };
};

export type SkillSelection =
  | { readonly skills: readonly SelectedSkill[] }
  | { readonly error: string };

/**
 * The selection as it is stored: every entry complete, one line per value, one name per skill
 * and a path a person could have chosen. A refusal says why in the daemon's own words; the
 * wire answer for it is `400 invalid_command`.
 */
export const normalizeSelectedSkills = (entries: readonly unknown[]): SkillSelection => {
  if (entries.length > MAX_SELECTED_SKILLS) {
    return { error: `一次最多勾选 ${MAX_SELECTED_SKILLS} 个技能` };
  }
  const skills: SelectedSkill[] = [];
  const names = new Set<string>();
  for (const entry of entries) {
    const parsed = parseSelectedSkill(entry);
    if (parsed === undefined) {
      return { error: "每个技能都需要 name、version、description 和 path" };
    }
    const name = oneLine(parsed.name);
    if (name.length === 0 || name.length > MAX_SKILL_NAME) {
      return { error: `技能名必须是 1-${MAX_SKILL_NAME} 个字符` };
    }
    if (names.has(name)) return { error: `技能名重复：${name}` };
    names.add(name);
    const version = oneLine(parsed.version);
    if (version.length > MAX_SKILL_VERSION) {
      return { error: `技能版本最多 ${MAX_SKILL_VERSION} 个字符` };
    }
    const description = oneLine(parsed.description);
    if (description.length > MAX_SKILL_DESCRIPTION) {
      return { error: `技能描述最多 ${MAX_SKILL_DESCRIPTION} 个字符` };
    }
    const path = parsed.path;
    if (
      path.length === 0 ||
      path.length > MAX_SKILL_PATH ||
      !(path.startsWith("/") || (path.startsWith("~/") && path.length > 2))
    ) {
      return { error: "技能路径必须是绝对路径或以 ~/ 开头" };
    }
    skills.push({ name, version, description, path });
  }
  return { skills };
};

/** The selection as the prompt lists it: absent when nothing is ticked. */
export const skillSection = (skills: readonly SelectedSkill[]): string | undefined => {
  if (skills.length === 0) return undefined;
  return [
    "This person selected these skills for this machine's Bot service:",
    ...skills.map((skill) => {
      const version = oneLine(skill.version);
      const description = oneLine(skill.description);
      return `- ${oneLine(skill.name)}${version.length === 0 ? "" : ` · ${version}`}${
        description.length === 0 ? "" : ` — ${description}`
      }`;
    }),
    "Call skill_read with a skill's name before following it. The file is the instruction; this list is only the index.",
  ].join("\n");
};

export type SkillRead = { readonly text: string } | { readonly refusal: string };

/** `~/a` is relative to the home the daemon runs in, which is where the App scanned. */
export const expandSkillPath = (path: string, home: string = homedir()): string =>
  path.startsWith("~/") ? join(home, path.slice(2)) : path;

/**
 * One selected skill's `SKILL.md`, or why it cannot be read. Only a name is accepted: the
 * path comes from the selection, so the model can never turn this into a file reader.
 */
export const readSelectedSkill = (
  skills: readonly SelectedSkill[],
  name: string,
  home: string = homedir(),
): SkillRead => {
  const skill = skills.find((entry) => entry.name === name);
  if (skill === undefined) {
    const known = skills.map((entry) => entry.name).join(", ");
    return {
      refusal:
        known.length === 0
          ? `no skill named ${name} is selected on this machine; no skills are selected at all`
          : `no skill named ${name} is selected on this machine; selected: ${known}`,
    };
  }
  const manifest = join(expandSkillPath(skill.path, home), "SKILL.md");
  let text: string;
  try {
    if (!statSync(manifest).isFile()) {
      return { refusal: `${name}: SKILL.md is not a regular file` };
    }
    text = readFileSync(manifest, "utf8");
  } catch {
    return { refusal: `${name}: SKILL.md is not readable; it may have been removed` };
  }
  return {
    text:
      text.length > MAX_SKILL_FILE
        ? `${text.slice(0, MAX_SKILL_FILE)}\n\n[truncated at ${MAX_SKILL_FILE} characters]`
        : text,
  };
};
