import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fixture(
  run: (root: string, git: (...args: string[]) => string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "eagle-l1-gate-"));
  const environment = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
  ])
    delete environment[key];
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", root, ...args], {
      env: environment,
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git("init", "--initial-branch=main");
    git("config", "core.hooksPath", ".githooks");
    git("config", "commit.gpgSign", "false");
    git("config", "user.name", "L1 Gate Fixture");
    git("config", "user.email", "fixture@example.invalid");
    for (const file of [
      ".githooks/pre-commit",
      "scripts/l1-index-gate.sh",
      "scripts/check-test-focus.sh",
      ".c8rc.json",
      "biome.json",
      "tsconfig.json",
      "package.json",
      "package-lock.json",
    ]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      copyFileSync(join(repository, file), join(root, file));
    }
    chmodSync(join(root, ".githooks/pre-commit"), 0o755);
    chmodSync(join(root, "scripts/l1-index-gate.sh"), 0o755);
    chmodSync(join(root, "scripts/check-test-focus.sh"), 0o755);
    symlinkSync(join(repository, "node_modules"), join(root, "node_modules"));
    mkdirSync(join(root, "packages/contracts/src"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    for (const file of [
      "apps/macos/Scripts/check-design.ts",
      "apps/macos/Scripts/DesignGuard.swift",
      "tests/native/design-guard.test.ts",
    ]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      copyFileSync(join(repository, file), join(root, file));
    }
    mkdirSync(join(root, "apps/macos/Sources/EagleDesign"), {
      recursive: true,
    });
    writeFileSync(
      join(root, "apps/macos/Sources/EagleDesign/Theme.swift"),
      "enum Theme {}\n",
    );
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            module: "ESNext",
            moduleResolution: "Bundler",
            target: "ES2023",
            skipLibCheck: true,
            allowImportingTsExtensions: true,
            types: ["node"],
          },
          include: ["packages/contracts/src", "tests"],
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(root, "packages/contracts/src/mean.ts"),
      "export const mean = (values: number[]) =>\n  values.length\n    ? values.reduce((sum, value) => sum + value, 0) / values.length\n    : null;\n",
    );
    writeFileSync(
      join(root, "tests/mean.test.ts"),
      `import assert from "node:assert/strict";
import { test } from "node:test";
import { mean } from "../packages/contracts/src/mean.ts";

test("mean handles values and empty input", () => {
  assert.equal(mean([1, 3]), 2);
  assert.equal(mean([]), null);
});
`,
    );
    const format = spawnSync(
      "npx",
      [
        "--no-install",
        "biome",
        "format",
        "--write",
        "tsconfig.json",
        ".c8rc.json",
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(format.status, 0, format.stderr);
    git(
      "add",
      ".githooks/pre-commit",
      "scripts",
      ".c8rc.json",
      "biome.json",
      "tsconfig.json",
      "package.json",
      "package-lock.json",
      "packages/contracts/src/mean.ts",
      "tests/mean.test.ts",
    );
    run(root, git);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function commit(root: string): ReturnType<typeof spawnSync> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    npm_config_offline: "true",
  };
  delete (environment as Record<string, string | undefined>).NODE_TEST_CONTEXT;
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
  ])
    delete (environment as Record<string, string | undefined>)[key];
  return spawnSync(
    "git",
    ["-C", root, "commit", "-m", "test: exercise l1 gate"],
    {
      env: environment,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
}

test("healthy staged sources pass the index-snapshot L1 gate", () => {
  fixture((_root, _git) => {
    const result = commit(_root);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(`${result.stderr}${result.stdout}`, /L1 index snapshot/);
  });
});

test("a failing unit test blocks commit", () => {
  fixture((root, git) => {
    writeFileSync(
      join(root, "tests/mean.test.ts"),
      `import assert from "node:assert/strict";
import { test } from "node:test";
import { mean } from "../packages/contracts/src/mean.ts";
test("forced failure", () => {
  assert.equal(mean([1, 1]), 3);
});
`,
    );
    git("add", "tests/mean.test.ts");
    const index = git("write-tree");
    const result = commit(root);
    assert.notEqual(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(git("write-tree"), index);
  });
});

test("insufficient coverage blocks commit", () => {
  fixture((root, git) => {
    writeFileSync(
      join(root, "packages/contracts/src/mean.ts"),
      "export const mean = (values: number[]) =>\n  values.reduce((sum, value) => sum + value, 0) / values.length;\nexport const unused = () => 1;\n",
    );
    git("add", "packages/contracts/src/mean.ts");
    const result = commit(root);
    assert.notEqual(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(`${result.stderr}${result.stdout}`, /Coverage|threshold/i);
  });
});

test("a staged regression fails even when the worktree is already fixed", () => {
  fixture((root, git) => {
    writeFileSync(
      join(root, "packages/contracts/src/mean.ts"),
      "export const mean = () => 0;\n",
    );
    git("add", "packages/contracts/src/mean.ts");
    writeFileSync(
      join(root, "packages/contracts/src/mean.ts"),
      "export const mean = (values: number[]) =>\n  values.length\n    ? values.reduce((sum, value) => sum + value, 0) / values.length\n    : null;\n",
    );
    const index = git("write-tree");
    const result = commit(root);
    assert.notEqual(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(git("write-tree"), index);
  });
});
