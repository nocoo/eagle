// The skills a person ticked (docs/bots/EXTENSIONS-AND-TOOLS.md, "Skills"): the daemon stores
// the selection and offers an index of it in the prompt plus one tool that reads a selected
// `SKILL.md`. Discovery belongs to the App; nothing here scans a folder.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Extension } from "@earendil-works/pi-durable";
import {
  MAX_SKILL_FILE,
  normalizeSelectedSkills,
  readSelectedSkill,
  type SelectedSkill,
  skillSection,
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
    const directory = await writeSkillFile(bench_.root, "alpha", "字".repeat(MAX_SKILL_FILE + 100));
    const outcome = await call(() => [skill({ path: directory })], "alpha");
    assert.equal(outcome.isError, undefined);
    assert.ok(outcome.output.startsWith("字".repeat(10)));
    assert.match(outcome.output, new RegExp(`\\[truncated at ${MAX_SKILL_FILE} characters\\]`));
    assert.ok(outcome.output.length < MAX_SKILL_FILE + 200);
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
    for (const groups of [[], ["core", "coding", "herdr"]]) {
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
    const outcome = readSelectedSkill(selection, "alpha");
    assert.ok("text" in outcome);
    assert.match(outcome.text, /范围之内的说明/);
  } finally {
    await bench_.cleanup();
  }
});
