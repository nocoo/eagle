// The skills a person ticked (docs/bots/EXTENSIONS-AND-TOOLS.md, "Skills"): the App owns
// discovery, so the selection is the daemon's only input. Nothing here scans a folder, and
// nothing here accepts a path from the model: a name selects one entry of this list.
import { constants } from "node:fs";
import { type FileHandle, open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";

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
/** The most characters of one `SKILL.md` a Bot reads in one call: a skill is instructions, not a manual. */
export const MAX_SKILL_FILE_CHARS = 32_000;
/** The most bytes one read pulls from the file, so a huge manifest cannot fill the memory. */
export const MAX_SKILL_FILE_BYTES = 64 * 1024;
/** The most lines one read keeps, so a long file stays a readable instruction. */
export const MAX_SKILL_FILE_LINES = 4_096;

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

/** The three budgets one manifest read answers to; each of them is a hard bound. */
export type SkillFileLimits = {
  /** The most bytes pulled from the file, so the read costs a bounded amount of memory. */
  readonly maxBytes: number;
  /** The most characters kept in the answer. */
  readonly maxChars: number;
  /** The most lines kept in the answer. */
  readonly maxLines: number;
};

export const SKILL_FILE_LIMITS: SkillFileLimits = {
  maxBytes: MAX_SKILL_FILE_BYTES,
  maxChars: MAX_SKILL_FILE_CHARS,
  maxLines: MAX_SKILL_FILE_LINES,
};

/** Which budget ended the text, and so what the note says. */
export type SkillTruncation = "bytes" | "characters" | "lines";

export type SkillFileOutcome =
  | {
      readonly kind: "text";
      readonly text: string;
      /** How many bytes the file gave us; the bound is what makes a huge file harmless. */
      readonly bytesRead: number;
      readonly truncatedBy?: SkillTruncation;
    }
  | { readonly kind: "refusal"; readonly reason: string };

/** The longest character UTF-8 has, in bytes. */
const MAX_UTF8_BYTES = 4;

/** The bytes one UTF-8 character takes, counted from its first byte. */
const utf8SequenceLength = (lead: number): number => {
  if (lead < 0x80) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return MAX_UTF8_BYTES;
  return 1;
};

/**
 * The tail of a cut file, without the half character at its end: a byte cut inside a
 * character would decode into a replacement character, so the incomplete character goes.
 *
 * The scan looks back four bytes, because the lead of a four-byte character sits three
 * continuation bytes from the end: looking back only three would find no lead and cut a
 * complete character apart.
 */
export const trimIncompleteUtf8 = (bytes: Buffer): Buffer => {
  for (let back = 1; back <= MAX_UTF8_BYTES && back <= bytes.length; back += 1) {
    const byte = bytes[bytes.length - back] ?? 0;
    if ((byte & 0xc0) === 0x80) continue;
    return back >= utf8SequenceLength(byte) ? bytes : bytes.subarray(0, bytes.length - back);
  }
  // Four continuation bytes in a row are not UTF-8 at all: no character ends here.
  return bytes.length > MAX_UTF8_BYTES
    ? bytes.subarray(0, bytes.length - MAX_UTF8_BYTES)
    : Buffer.alloc(0);
};

/**
 * The bytes of the manifest, at most one past the budget: the extra byte is what tells a
 * file that is exactly at the budget from one that continues past it.
 */
const readBoundedBytes = async (
  handle: FileHandle,
  maxBytes: number,
): Promise<{ readonly bytes: Buffer; readonly bytesRead: number; readonly truncated: boolean }> => {
  const chunks: Buffer[] = [];
  let total = 0;
  const chunk = Buffer.allocUnsafe(8 * 1024);
  while (total <= maxBytes) {
    const wanted = Math.min(chunk.length, maxBytes + 1 - total);
    if (wanted <= 0) break;
    const { bytesRead } = await handle.read(chunk, 0, wanted, null);
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    total += bytesRead;
  }
  return { bytes: Buffer.concat(chunks, total), bytesRead: total, truncated: total > maxBytes };
};

/** The text at most `maxChars` characters long, never splitting a character in half. */
const cutCharacters = (text: string, maxChars: number): { text: string; cut: boolean } => {
  if (text.length <= maxChars) return { text, cut: false };
  let end = maxChars;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), cut: true };
};

/** The text at most `maxLines` lines long; a trailing newline does not make another line. */
const cutLines = (text: string, maxLines: number): { text: string; cut: boolean } => {
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  if (lines.length <= maxLines) return { text, cut: false };
  return { text: lines.slice(0, maxLines).join("\n"), cut: true };
};

/** A path is inside a folder when it is under it; the folder itself is not inside itself. */
const isInside = (directory: string, file: string): boolean => {
  const prefix = directory.endsWith(sep) ? directory : `${directory}${sep}`;
  return file.startsWith(prefix);
};

/** The unit each budget is counted in, for the note the model reads. */
const BUDGET_UNIT: Readonly<Record<SkillTruncation, string>> = {
  bytes: "bytes",
  characters: "characters",
  lines: "lines",
};

/**
 * The text the three budgets leave, and the budget that produced it.
 *
 * Every budget leaves a prefix of the decoded text, so the shortest prefix is the one the
 * model receives; the note names that budget rather than the first one that happened to
 * apply, so 100 000 ASCII bytes say `characters` and 40 000 short lines say `lines`.
 */
const boundText = (
  decoded: string,
  readBound: boolean,
  limits: SkillFileLimits,
): { readonly text: string; readonly truncatedBy?: SkillTruncation } => {
  const candidates: { readonly by: SkillTruncation; readonly text: string }[] = [];
  if (readBound) candidates.push({ by: "bytes", text: decoded });
  const characters = cutCharacters(decoded, limits.maxChars);
  if (characters.cut) candidates.push({ by: "characters", text: characters.text });
  const lines = cutLines(decoded, limits.maxLines);
  if (lines.cut) candidates.push({ by: "lines", text: lines.text });
  if (candidates.length === 0) return { text: decoded };
  const shortest = candidates.reduce((kept, next) =>
    next.text.length < kept.text.length ? next : kept,
  );
  const bound =
    shortest.by === "bytes"
      ? limits.maxBytes
      : shortest.by === "characters"
        ? limits.maxChars
        : limits.maxLines;
  return {
    text: `${shortest.text}\n\n[truncated at ${bound} ${BUDGET_UNIT[shortest.by]}]`,
    truncatedBy: shortest.by,
  };
};

/** A skill's folder as it was validated: its real path and the identity it had then. */
export type SkillFolder = {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
};

export type SkillFolderResolution =
  | { readonly kind: "folder"; readonly folder: SkillFolder }
  | { readonly kind: "refusal"; readonly reason: string };

/** Resolves a selected skill's folder and records which directory it is, right now. */
export const resolveSkillFolder = async (directory: string): Promise<SkillFolderResolution> => {
  const path = await realpath(directory).catch(() => undefined);
  if (path === undefined) {
    return { kind: "refusal", reason: "SKILL.md is not readable; it may have been removed" };
  }
  const folder = await stat(path).catch(() => undefined);
  if (folder === undefined || !folder.isDirectory()) {
    return { kind: "refusal", reason: "the skill's folder is not a directory" };
  }
  return { kind: "folder", folder: { path, dev: folder.dev, ino: folder.ino } };
};

export type ManifestPathResolution =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "refusal"; readonly reason: string };

/** Resolves `SKILL.md` from a pinned folder; the manifest has to stay inside that folder. */
export const resolveManifestPath = async (folder: SkillFolder): Promise<ManifestPathResolution> => {
  const path = await realpath(join(folder.path, "SKILL.md")).catch(() => undefined);
  if (path === undefined) {
    return { kind: "refusal", reason: "SKILL.md is not readable; it may have been removed" };
  }
  if (!isInside(folder.path, path)) {
    return { kind: "refusal", reason: "SKILL.md points outside the skill's folder" };
  }
  return { kind: "path", path };
};

/**
 * The resolved manifest as it is read.
 *
 * Each check is a fact about its own moment, in this order: the path names a regular file;
 * the opened descriptor is that file (`fstat` dev and inode); the pinned folder is still the
 * directory that was resolved; and a fresh resolution from that folder now leads inside it
 * and ends at the same inode. The last one is what a swapped intermediate component needs:
 * the resolved path is a string, so any directory along it can be replaced by a symlink to
 * another tree while the folder's own identity stays untouched.
 *
 * Because the checks and the open are separate calls (Node has no `openat` scoped to a
 * directory descriptor), the composite proves no more than that each fact held when it was
 * observed: a swap that happens after the last check is not detected, and a tree that is
 * changed and restored between two checks is not seen either. What is read is the descriptor
 * that was opened and checked, so a later swap cannot change which file those bytes come from.
 */
export const readSkillManifest = async (
  folder: SkillFolder,
  path: string,
  limits: SkillFileLimits = SKILL_FILE_LIMITS,
): Promise<SkillFileOutcome> => {
  const expected = await stat(path).catch(() => undefined);
  if (expected === undefined || !expected.isFile()) {
    return { kind: "refusal", reason: "SKILL.md is not a regular file" };
  }
  // O_NONBLOCK keeps a fifo from parking the read forever; O_NOFOLLOW keeps the last
  // component from being a symlink that appeared after the paths were resolved.
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  ).catch(() => undefined);
  if (handle === undefined) {
    return { kind: "refusal", reason: "SKILL.md is not readable; it may have been removed" };
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      return { kind: "refusal", reason: "SKILL.md is not a regular file" };
    }
    if (opened.dev !== expected.dev || opened.ino !== expected.ino) {
      return { kind: "refusal", reason: "SKILL.md changed while it was read" };
    }
    // The tree that was validated has to be the one the manifest path leads into: a folder
    // replaced after it was resolved would otherwise read another tree and never notice.
    const living = await stat(folder.path).catch(() => undefined);
    if (living === undefined || living.dev !== folder.dev || living.ino !== folder.ino) {
      return { kind: "refusal", reason: "the skill's folder changed while it was read" };
    }
    // And the path has to lead back to the very descriptor being read, resolved again from
    // the pinned folder: an intermediate directory of the resolved path can be swapped for a
    // symlink to another tree without touching the folder's identity.
    const settled = await resolveManifestPath(folder);
    if (settled.kind === "refusal") return settled;
    const current = await stat(settled.path).catch(() => undefined);
    if (current === undefined || current.dev !== opened.dev || current.ino !== opened.ino) {
      return { kind: "refusal", reason: "SKILL.md changed while it was read" };
    }
    const { bytes, bytesRead, truncated } = await readBoundedBytes(handle, limits.maxBytes);
    const decoded = trimIncompleteUtf8(
      truncated ? bytes.subarray(0, limits.maxBytes) : bytes,
    ).toString("utf8");
    return { kind: "text", ...boundText(decoded, truncated, limits), bytesRead };
  } finally {
    await handle.close();
  }
};

/**
 * One skill's `SKILL.md`, or why it cannot be read: resolve the folder, resolve the manifest
 * inside it, then read it. The steps are separate so a tree swapped between two of them is a
 * refusal rather than a read, and so each step can be observed on its own.
 */
export const readSkillFile = async (
  directory: string,
  limits: SkillFileLimits = SKILL_FILE_LIMITS,
): Promise<SkillFileOutcome> => {
  const folder = await resolveSkillFolder(directory);
  if (folder.kind === "refusal") return folder;
  const manifest = await resolveManifestPath(folder.folder);
  if (manifest.kind === "refusal") return manifest;
  return readSkillManifest(folder.folder, manifest.path, limits);
};

/**
 * One selected skill's `SKILL.md`, or why it cannot be read. Only a name is accepted: the
 * path comes from the selection, so the model can never turn this into a file reader.
 */
export const readSelectedSkill = async (
  skills: readonly SelectedSkill[],
  name: string,
  home: string = homedir(),
): Promise<SkillRead> => {
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
  const outcome = await readSkillFile(expandSkillPath(skill.path, home));
  if (outcome.kind === "refusal") return { refusal: `${name}: ${outcome.reason}` };
  return { text: outcome.text };
};
