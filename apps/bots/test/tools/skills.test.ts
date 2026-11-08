// The skills a person ticked (docs/bots/EXTENSIONS-AND-TOOLS.md, "Skills"): the daemon stores
// the selection and offers an index of it in the prompt plus one tool that reads a selected
// `SKILL.md`. Discovery belongs to the App; nothing here scans a folder.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { Extension } from "@earendil-works/pi-durable";
import {
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILE_CHARS,
  MAX_SKILL_FILE_LINES,
  normalizeSelectedSkills,
  readSelectedSkill,
  readSkillFile,
  readSkillManifest,
  resolveManifestPath,
  resolveSkillFolder,
  type SelectedSkill,
  skillSection,
  trimIncompleteUtf8,
} from "../../src/skills/selection.ts";
import { createToolRegistry, selectToolExtensions } from "../../src/tools/registry.ts";
import {
  createSkillTools,
  SKILLS_EXTENSION,
  SKILLS_SECTION,
  skillsExtension,
} from "../../src/tools/skills/tools.ts";
import { openWorkspace } from "../../src/tools/workspace.ts";

const rendered = (extension: Extension): string | undefined => {
  const entry = extension.sections?.[0];
  if (entry === undefined) return undefined;
  const value = entry.render({} as never, {} as never);
  return typeof value === "string" ? value : undefined;
};

const skill = (overrides: Partial<SelectedSkill> = {}): SelectedSkill => ({
  name: "alpha",
  version: "1.0.0",
  description: "Runs alpha.",
  path: "/skills/alpha",
  ...overrides,
});

const bench = async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-skills-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
};

const writeSkillFile = async (root: string, name: string, text: string): Promise<string> => {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), text);
  return directory;
};

type Outcome = { output: string; isError?: boolean };

const call = async (
  read: () => readonly SelectedSkill[],
  name: string,
  home?: string,
): Promise<Outcome> => {
  const tool = createSkillTools({ read, ...(home === undefined ? {} : { home: () => home }) })[0];
  assert.ok(tool, "skill_read is registered");
  const result = await tool.execute(
    { name } as never,
    { taskId: "t_skills" } as never,
    {} as never,
  );
  return {
    output: (result.output ?? [])
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n"),
    ...(result.isError === true ? { isError: true as const } : {}),
  };
};

test("an empty selection renders no section at all", () => {
  assert.equal(rendered(skillsExtension({ read: () => [] })), undefined);
  assert.equal(skillSection([]), undefined);
});

test("every selected skill is one line, and the section says how to read it", () => {
  const text = skillSection([
    skill(),
    skill({ name: "beta", version: "2.1.0", description: "Runs beta." }),
  ]);
  assert.ok(text !== undefined);
  assert.match(text, /^- alpha · 1\.0\.0 — Runs alpha\.$/m);
  assert.match(text, /^- beta · 2\.1\.0 — Runs beta\.$/m);
  assert.match(text, /skill_read/, "the model is told the tool that reads a skill");
  assert.match(text, /before following/i);
  assert.ok(text.indexOf("alpha") < text.indexOf("beta"), "the stored order is kept");
});

test("a skill without a version keeps its line readable", () => {
  const text = skillSection([skill({ version: "" })]);
  assert.ok(text !== undefined);
  assert.match(text, /^- alpha — Runs alpha\.$/m);
  assert.doesNotMatch(text, / ·\s*—/);
});

test("a version or description cannot break the one skill per line shape", () => {
  const text = skillSection([
    skill({ description: "第一行\n- beta · 9.9 — 假的一行", version: "1.0\n- gamma" }),
  ]);
  assert.ok(text !== undefined);
  const bullets = text.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(bullets.length, 1, "a newline in a value never becomes another skill");
  assert.match(bullets[0] ?? "", /1\.0 - gamma/);
  assert.match(bullets[0] ?? "", /第一行 - beta · 9\.9 — 假的一行/);
});

test("the section is read again on every ask, so a tick lands on the next turn", () => {
  let selection: readonly SelectedSkill[] = [];
  const extension = skillsExtension({ read: () => selection });
  assert.equal(rendered(extension), undefined);
  selection = [skill()];
  assert.match(rendered(extension) ?? "", /alpha/);
  selection = [];
  assert.equal(rendered(extension), undefined);
});

test("skill_read returns the selected skill's SKILL.md", async () => {
  const bench_ = await bench();
  try {
    const directory = await writeSkillFile(bench_.root, "alpha", "# alpha\n\n先读说明。\n");
    const outcome = await call(() => [skill({ path: directory })], "alpha");
    assert.equal(outcome.isError, undefined);
    assert.match(outcome.output, /先读说明。/);
  } finally {
    await bench_.cleanup();
  }
});

test("an unselected name is refused and names what is selected", async () => {
  const bench_ = await bench();
  try {
    const directory = await writeSkillFile(bench_.root, "alpha", "alpha 的说明");
    const outcome = await call(() => [skill({ path: directory })], "beta");
    assert.equal(outcome.isError, true);
    assert.match(outcome.output, /beta/);
    assert.match(outcome.output, /alpha/, "the refusal says which names exist");
    assert.doesNotMatch(outcome.output, /alpha 的说明/, "nothing outside the selection is read");
  } finally {
    await bench_.cleanup();
  }
});

test("a skill whose file is gone is refused honestly", async () => {
  const bench_ = await bench();
  try {
    const outcome = await call(() => [skill({ path: join(bench_.root, "gone") })], "alpha");
    assert.equal(outcome.isError, true);
    assert.match(outcome.output, /SKILL\.md/);
  } finally {
    await bench_.cleanup();
  }
});

test("a directory where the manifest belongs is not read", async () => {
  const bench_ = await bench();
  try {
    const directory = join(bench_.root, "alpha");
    await mkdir(join(directory, "SKILL.md"), { recursive: true });
    const outcome = await call(() => [skill({ path: directory })], "alpha");
    assert.equal(outcome.isError, true);
    assert.match(outcome.output, /regular file/);
  } finally {
    await bench_.cleanup();
  }
});

test("an oversized manifest is cut and says where", async () => {
  const bench_ = await bench();
  try {
    const directory = await writeSkillFile(
      bench_.root,
      "alpha",
      "字".repeat(MAX_SKILL_FILE_CHARS + 100),
    );
    const outcome = await call(() => [skill({ path: directory })], "alpha");
    assert.equal(outcome.isError, undefined);
    assert.ok(outcome.output.startsWith("字".repeat(10)));
    assert.match(outcome.output, /\[truncated at \d+ (bytes|characters|lines)\]/);
    assert.ok(outcome.output.length < MAX_SKILL_FILE_CHARS + 200);
  } finally {
    await bench_.cleanup();
  }
});

test("a manifest is read by bytes, not by characters: a huge file costs a bounded read", async () => {
  const bench_ = await bench();
  try {
    const directory = await writeSkillFile(bench_.root, "alpha", "a".repeat(8 * 1024 * 1024));
    const outcome = await readSkillFile(directory);
    assert.equal(outcome.kind, "text");
    assert.ok(outcome.kind === "text");
    assert.ok(
      outcome.bytesRead <= MAX_SKILL_FILE_BYTES + 1,
      `read ${outcome.bytesRead} bytes, at most ${MAX_SKILL_FILE_BYTES + 1} are allowed`,
    );
    assert.ok(outcome.bytesRead < 8 * 1024 * 1024, "the whole file is never pulled into memory");
    assert.equal(
      outcome.truncatedBy,
      "characters",
      "the read bound was reached, but the character budget is what the model receives",
    );
    assert.match(outcome.text, /\[truncated at \d+ characters\]/);
  } finally {
    await bench_.cleanup();
  }
});

test("a manifest cut by bytes ends on a character boundary", async () => {
  const bench_ = await bench();
  try {
    // Every character is three bytes, so a byte cut lands inside one unless it is repaired.
    const directory = await writeSkillFile(bench_.root, "alpha", "字".repeat(100_000));
    const outcome = await readSkillFile(directory);
    assert.ok(outcome.kind === "text");
    assert.equal(outcome.text.includes("\uFFFD"), false, "no broken character reaches the model");
    assert.equal(outcome.text.startsWith("字"), true);
  } finally {
    await bench_.cleanup();
  }
});

test("a four-byte character at the byte boundary survives whole", async () => {
  const bench_ = await bench();
  try {
    // 21 844 three-byte characters and one emoji are exactly the byte budget, and the emoji's
    // lead byte sits four bytes from the end: a scan that only looks back three would cut the
    // complete character and leave a broken byte behind.
    const emoji = "\u{1F600}";
    const fill = "字".repeat((MAX_SKILL_FILE_BYTES - Buffer.byteLength(emoji)) / 3);
    const exact = await writeSkillFile(bench_.root, "exact", `${fill}${emoji}`);
    const kept = await readSkillFile(exact);
    assert.ok(kept.kind === "text");
    assert.equal(kept.truncatedBy, undefined, "the file fits the budget exactly");
    assert.equal(kept.text.includes("\uFFFD"), false, "no half character reaches the model");
    assert.equal(kept.text.endsWith(emoji), true, "the last character is whole");

    const over = await writeSkillFile(bench_.root, "over", `${fill}${emoji}${"字".repeat(8)}`);
    const cut = await readSkillFile(over);
    assert.ok(cut.kind === "text");
    assert.equal(cut.truncatedBy, "bytes");
    assert.equal(cut.text.includes("\uFFFD"), false, "the cut keeps a character boundary");
    assert.equal(
      cut.text.slice(0, cut.text.indexOf("\n\n[truncated")).endsWith(emoji),
      true,
      "the emoji is kept whole, not cut into a broken byte",
    );
  } finally {
    await bench_.cleanup();
  }
});

test("a character cut inside itself is dropped, not decoded", async () => {
  const bench_ = await bench();
  try {
    // The budget lands one byte into the next three-byte character.
    const directory = await writeSkillFile(
      bench_.root,
      "partial",
      "字".repeat(MAX_SKILL_FILE_BYTES / 3 + 2),
    );
    const outcome = await readSkillFile(directory);
    assert.ok(outcome.kind === "text");
    assert.equal(outcome.truncatedBy, "bytes");
    assert.equal(outcome.text.includes("\uFFFD"), false, "the broken tail is gone");
    assert.equal(
      outcome.text,
      `${"字".repeat((MAX_SKILL_FILE_BYTES - 1) / 3)}\n\n[truncated at ${MAX_SKILL_FILE_BYTES} bytes]`,
    );
  } finally {
    await bench_.cleanup();
  }
});

test("the tail trim keeps every complete character and only drops a broken one", () => {
  const emoji = Buffer.from("\u{1F600}", "utf8");
  assert.deepEqual(trimIncompleteUtf8(emoji), emoji, "a complete four-byte character stays");
  assert.deepEqual(
    trimIncompleteUtf8(Buffer.concat([Buffer.from("a"), emoji])),
    Buffer.concat([Buffer.from("a"), emoji]),
    "a complete character after another character stays",
  );
  assert.deepEqual(
    trimIncompleteUtf8(Buffer.from([0xe4, 0xb8])),
    Buffer.alloc(0),
    "half of one goes",
  );
  assert.deepEqual(
    trimIncompleteUtf8(emoji.subarray(0, 3)),
    Buffer.alloc(0),
    "three bytes of four go",
  );
  assert.deepEqual(
    trimIncompleteUtf8(Buffer.from([0xf0])),
    Buffer.alloc(0),
    "a lone lead byte goes",
  );
  assert.deepEqual(trimIncompleteUtf8(Buffer.from("abc")), Buffer.from("abc"), "ascii stays");
});

test("the note names the budget that actually bound the text", async () => {
  const bench_ = await bench();
  try {
    // 100 000 ASCII bytes: the read stops at the byte budget, but the character budget is
    // what the model receives, so the note has to name that one.
    const ascii = await writeSkillFile(bench_.root, "ascii", "a".repeat(100_000));
    const kept = await readSkillFile(ascii);
    assert.ok(kept.kind === "text");
    assert.equal(kept.truncatedBy, "characters");
    assert.equal(
      kept.text,
      `${"a".repeat(MAX_SKILL_FILE_CHARS)}\n\n[truncated at ${MAX_SKILL_FILE_CHARS} characters]`,
    );

    // 40 000 one-character lines: the read budget is reached, but the line budget decides.
    const lines = await writeSkillFile(
      bench_.root,
      "lines",
      `${Array.from({ length: 40_000 }, () => "x").join("\n")}\n`,
    );
    const byLines = await readSkillFile(lines);
    assert.ok(byLines.kind === "text");
    assert.equal(byLines.truncatedBy, "lines");
    assert.equal(
      byLines.text,
      `${Array.from({ length: MAX_SKILL_FILE_LINES }, () => "x").join("\n")}\n\n[truncated at ${MAX_SKILL_FILE_LINES} lines]`,
    );

    // Three-byte characters: the read budget leaves the shortest prefix, so it is named.
    const cjk = await writeSkillFile(bench_.root, "cjk", "字".repeat(40_000));
    const byBytes = await readSkillFile(cjk);
    assert.ok(byBytes.kind === "text");
    assert.equal(byBytes.truncatedBy, "bytes");
    assert.equal(
      byBytes.text,
      `${"字".repeat((MAX_SKILL_FILE_BYTES - 1) / 3)}\n\n[truncated at ${MAX_SKILL_FILE_BYTES} bytes]`,
    );
  } finally {
    await bench_.cleanup();
  }
});

test("a folder replaced after it was resolved is refused, not read", async () => {
  const bench_ = await bench();
  try {
    const original = await writeSkillFile(bench_.root, "alpha", "原来这个目录的说明");
    const resolved = await resolveSkillFolder(original);
    assert.equal(resolved.kind, "folder");
    assert.ok(resolved.kind === "folder");

    // Another tree takes the folder's path: the tree that was validated is gone, and the
    // manifest path now names a file in the new one.
    const replacement = join(bench_.root, "replacement");
    await mkdir(replacement, { recursive: true });
    await writeFile(join(replacement, "SKILL.md"), "另一个目录里的说明");
    await rename(original, join(bench_.root, "alpha-gone"));
    await rename(replacement, original);

    const path = await resolveManifestPath(resolved.folder);
    assert.ok(path.kind === "path");
    const outcome = await readSkillManifest(resolved.folder, path.path);
    assert.equal(outcome.kind, "refusal");
    assert.ok(outcome.kind === "refusal");
    assert.match(outcome.reason, /folder changed/, "the folder's own identity is what refused");
    assert.doesNotMatch(outcome.reason, /另一个目录里的说明/);
  } finally {
    await bench_.cleanup();
  }
});

test("an intermediate directory of the manifest path cannot be swapped for an outside tree", async () => {
  const bench_ = await bench();
  try {
    const selected = join(bench_.root, "selected");
    await mkdir(join(selected, "sub"), { recursive: true });
    await writeFile(join(selected, "sub", "SKILL.md"), "这个技能自己的说明\n");
    // A legitimate link inside the folder: SKILL.md → sub/SKILL.md.
    await symlink(join("sub", "SKILL.md"), join(selected, "SKILL.md"));
    const legitimate = await readSkillFile(selected);
    assert.ok(legitimate.kind === "text");
    assert.match(legitimate.text, /这个技能自己的说明/, "the legitimate link is read");

    const resolved = await resolveSkillFolder(selected);
    assert.ok(resolved.kind === "folder");
    const path = await resolveManifestPath(resolved.folder);
    assert.ok(path.kind === "path", "the manifest resolves inside the folder before the swap");

    // The reproduction: the manifest path is resolved, then its subdirectory is replaced by
    // a symlink to a tree outside, and it is never restored. The folder's own identity is
    // untouched, so the root pin alone still agrees with the outside file.
    const outside = join(bench_.root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "SKILL.md"), "OUTSIDE-SENTINEL\n");
    await rename(join(selected, "sub"), join(bench_.root, "sub-gone"));
    await symlink(outside, join(selected, "sub"));

    const outcome = await readSkillManifest(resolved.folder, path.path);
    assert.equal(outcome.kind, "refusal", "the swapped path is refused, not read");
    assert.ok(outcome.kind === "refusal");
    assert.doesNotMatch(outcome.reason, /OUTSIDE-SENTINEL/);
  } finally {
    await bench_.cleanup();
  }
});

test("a folder replaced before it is resolved is read as it is now", async () => {
  const bench_ = await bench();
  try {
    const original = await writeSkillFile(bench_.root, "alpha", "旧目录的说明");
    const replacement = join(bench_.root, "replacement");
    await mkdir(replacement, { recursive: true });
    await writeFile(join(replacement, "SKILL.md"), "新目录的说明");
    await rename(original, join(bench_.root, "alpha-gone"));
    await rename(replacement, original);

    const outcome = await readSkillFile(original);
    assert.ok(outcome.kind === "text");
    assert.match(outcome.text, /新目录的说明/, "resolution is the moment the tree is chosen");
  } finally {
    await bench_.cleanup();
  }
});

test("a manifest with too many lines is cut at the line budget", async () => {
  const bench_ = await bench();
  try {
    const directory = await writeSkillFile(
      bench_.root,
      "alpha",
      `${Array.from({ length: MAX_SKILL_FILE_LINES + 100 }, () => "x").join("\n")}\n`,
    );
    const outcome = await readSkillFile(directory);
    assert.ok(outcome.kind === "text");
    assert.equal(outcome.truncatedBy, "lines");
    assert.match(outcome.text, new RegExp(`\\[truncated at ${MAX_SKILL_FILE_LINES} lines\\]`));
    const lines = outcome.text.split("\n");
    assert.equal(lines.length <= MAX_SKILL_FILE_LINES + 3, true, "the note is the only extra");
  } finally {
    await bench_.cleanup();
  }
});

test("a manifest outside the skill's folder is refused and its text never leaks", async () => {
  const bench_ = await bench();
  try {
    const outside = join(bench_.root, "outside.md");
    await writeFile(outside, "这个文件不在技能目录里");
    const directory = join(bench_.root, "alpha");
    await mkdir(directory, { recursive: true });
    await symlink(outside, join(directory, "SKILL.md"));
    const outcome = await call(() => [skill({ path: directory })], "alpha");
    assert.equal(outcome.isError, true);
    assert.match(outcome.output, /outside|不在技能目录/);
    assert.doesNotMatch(outcome.output, /这个文件不在技能目录里/);
  } finally {
    await bench_.cleanup();
  }
});

test("a manifest swapped for a symlink to a folder is refused", async () => {
  const bench_ = await bench();
  try {
    const directory = join(bench_.root, "alpha");
    await mkdir(join(directory, "elsewhere"), { recursive: true });
    await symlink(join(directory, "elsewhere"), join(directory, "SKILL.md"));
    const outcome = await call(() => [skill({ path: directory })], "alpha");
    assert.equal(outcome.isError, true);
    assert.match(outcome.output, /regular file/);
  } finally {
    await bench_.cleanup();
  }
});

test("a fifo is refused instead of hanging the read", async () => {
  const bench_ = await bench();
  try {
    const directory = join(bench_.root, "alpha");
    await mkdir(directory, { recursive: true });
    await promisify(execFile)("mkfifo", [join(directory, "SKILL.md")]);
    const outcome = await Promise.race([
      call(() => [skill({ path: directory })], "alpha"),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("the read hung on a fifo")), 5_000),
      ),
    ]);
    assert.equal(outcome.isError, true);
    assert.match(outcome.output, /regular file/);
  } finally {
    await bench_.cleanup();
  }
});

test("a skill folder that is a symlink is resolved, and its own manifest is read", async () => {
  const bench_ = await bench();
  try {
    const real = await writeSkillFile(bench_.root, "real", "真实目录里的说明");
    const linked = join(bench_.root, "linked");
    await symlink(real, linked);
    const outcome = await call(() => [skill({ path: linked })], "alpha");
    assert.equal(outcome.isError, undefined);
    assert.match(outcome.output, /真实目录里的说明/);
  } finally {
    await bench_.cleanup();
  }
});

test("a path that starts with ~/ is expanded against the home the daemon was given", async () => {
  const bench_ = await bench();
  try {
    await writeSkillFile(bench_.root, ".agents/skills/alpha", "home 里的说明");
    const outcome = await call(
      () => [skill({ path: "~/.agents/skills/alpha" })],
      "alpha",
      bench_.root,
    );
    assert.equal(outcome.isError, undefined);
    assert.match(outcome.output, /home 里的说明/);
  } finally {
    await bench_.cleanup();
  }
});

test("the read is done against the selection of the moment, not the one at open", async () => {
  const bench_ = await bench();
  try {
    const first = await writeSkillFile(bench_.root, "alpha", "第一版");
    const second = await writeSkillFile(bench_.root, "alpha-2", "第二版");
    let selection: readonly SelectedSkill[] = [skill({ path: first })];
    const read = () => selection;
    assert.match((await call(read, "alpha")).output, /第一版/);
    selection = [skill({ path: second, name: "beta" })];
    assert.match((await call(read, "beta")).output, /第二版/);
    assert.equal((await call(read, "alpha")).isError, true);
  } finally {
    await bench_.cleanup();
  }
});

test("a selected entry must name a skill, a version, a description and a path", () => {
  assert.deepEqual(normalizeSelectedSkills([]), { skills: [] });
  assert.deepEqual(normalizeSelectedSkills([skill()]), { skills: [skill()] });
  const bad = [skill(), { name: "beta", version: "1.0.0", description: "b" }];
  assert.equal("error" in normalizeSelectedSkills(bad), true);
});

test("the selection is bounded and a path is absolute or starts with ~/", () => {
  const tooMany = Array.from({ length: 51 }, (_value, index) => skill({ name: `s${index}` }));
  const count = normalizeSelectedSkills(tooMany);
  assert.equal("error" in count, true);

  for (const path of ["skills/alpha", "~", "~/", "", " /abs"]) {
    const outcome = normalizeSelectedSkills([skill({ path })]);
    assert.equal("error" in outcome, true, `${path} is not an accepted path`);
  }
  assert.deepEqual(normalizeSelectedSkills([skill({ path: "~/a/b" })]), {
    skills: [skill({ path: "~/a/b" })],
  });

  assert.equal("error" in normalizeSelectedSkills([skill({ name: "" })]), true);
  assert.equal("error" in normalizeSelectedSkills([skill({ name: "x".repeat(81) })]), true);
  assert.equal("error" in normalizeSelectedSkills([skill({ description: "x".repeat(501) })]), true);
  assert.equal("error" in normalizeSelectedSkills([skill({ version: "x".repeat(41) })]), true);
  assert.equal("error" in normalizeSelectedSkills([skill(), skill()]), true, "one name, one skill");
});

test("the selection is trimmed and collapsed before it is stored", () => {
  assert.deepEqual(
    normalizeSelectedSkills([skill({ name: "  alpha ", description: "a\n b", version: " 1.0 " })]),
    { skills: [skill({ name: "alpha", description: "a b", version: "1.0" })] },
  );
});

test("selecting bots-skills needs no tool group: a tick is the switch", async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-skills-registry-"));
  try {
    const workspace = await openWorkspace(join(root, "workspace"));
    const withSkills = createToolRegistry(workspace, { skills: () => [] });
    for (const groups of [[], ["core", "core-ui", "coding", "herdr"]]) {
      assert.ok(
        selectToolExtensions(withSkills, groups).some(
          (extension) => extension.name === SKILLS_EXTENSION,
        ),
        "the extension is selected whatever the groups are",
      );
    }
    const section = withSkills
      .snapshot()
      .sections()
      .find(({ section: entry }) => entry.key === SKILLS_SECTION);
    assert.ok(section, "the section is registered");
    assert.equal(section.section.render({} as never, {} as never), undefined);

    const without = createToolRegistry(workspace);
    assert.equal(
      without
        .snapshot()
        .installed()
        .some((extension) => extension.name === SKILLS_EXTENSION),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skill_read sees the selection it was built with", async () => {
  const bench_ = await bench();
  try {
    const directory = await writeSkillFile(bench_.root, "alpha", "范围之内的说明");
    const selection = [skill({ path: directory })];
    const outcome = await readSelectedSkill(selection, "alpha");
    assert.ok("text" in outcome);
    assert.match(outcome.text, /范围之内的说明/);
  } finally {
    await bench_.cleanup();
  }
});
