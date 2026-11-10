import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
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
const source = "apps/macos/Sources/EagleFeatures/Example.swift";
const guard = "apps/macos/Scripts/DesignGuard.swift";
const launcher = "apps/macos/Scripts/check-design.ts";
const valid = "import SwiftUI\n\nlet fill = Theme.Palette.accent\n";
const invalid = "import SwiftUI\n\nlet fill = Color.red\n";

function fixture(
  run: (root: string, git: (...args: string[]) => string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "eagle-design-gate-"));
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
      timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git("init", "--initial-branch=main");
    git("config", "core.hooksPath", ".githooks");
    git("config", "commit.gpgSign", "false");
    git("config", "user.name", "Design Guard Fixture");
    git("config", "user.email", "fixture@example.invalid");
    for (const file of [
      ".githooks/pre-commit",
      ".c8rc.json",
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "scripts/l1-index-gate.sh",
      "scripts/check-test-focus.sh",
      guard,
      launcher,
      "packages/contracts/src/canonical.ts",
      "tests/canonical-stub.test.ts",
      "tests/native/design-guard.test.ts",
    ]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      copyFileSync(join(repository, file), join(root, file));
    }
    symlinkSync(join(repository, "node_modules"), join(root, "node_modules"));
    copyFileSync(join(repository, "biome.json"), join(root, "biome.json"));
    chmodSync(join(root, ".githooks/pre-commit"), 0o755);
    chmodSync(join(root, "scripts/l1-index-gate.sh"), 0o755);
    chmodSync(join(root, "scripts/check-test-focus.sh"), 0o755);
    mkdirSync(join(root, "apps/macos/Sources/EagleDesign"), {
      recursive: true,
    });
    mkdirSync(join(root, "apps/macos/Sources/EagleFeatures"), {
      recursive: true,
    });
    mkdirSync(join(root, "apps/macos/Tests"), { recursive: true });
    writeFileSync(
      join(root, "apps/macos/Sources/EagleDesign/Theme.swift"),
      "enum Theme {}\n",
    );
    writeFileSync(join(root, source), valid);
    git(
      "add",
      ".githooks",
      "scripts",
      ".c8rc.json",
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "biome.json",
      "packages/contracts/src/canonical.ts",
      "tests/canonical-stub.test.ts",
      "apps/macos",
      "tests/native/design-guard.test.ts",
    );
    run(root, git);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function commit(root: string, overrides: Record<string, string> = {}) {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    npm_config_offline: "true",
    npm_config_cache: join(root, ".npm-cache"),
    ...overrides,
  };
  delete environment.NODE_TEST_CONTEXT;
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
  ])
    delete environment[key];
  const result = spawnSync(
    "git",
    ["-C", root, "commit", "-m", "test: exercise staged design gate"],
    {
      env: environment,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  assert.ifError(result.error);
  return result;
}

test("a staged style violation blocks a real commit despite an unstaged correction", () => {
  fixture((root, git) => {
    writeFileSync(join(root, source), invalid);
    git("add", source);
    writeFileSync(join(root, source), valid);
    const index = git("write-tree");
    const result = commit(root);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /palette-ownership/);
    assert.equal(git("write-tree"), index);
  });
});

test("valid staged source is not rejected for an unstaged style violation", () => {
  fixture((root) => {
    writeFileSync(join(root, source), invalid);
    const result = commit(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
});

test("an unstaged disabled checker cannot replace the staged checker", () => {
  fixture((root, git) => {
    writeFileSync(join(root, source), invalid);
    git("add", source);
    writeFileSync(
      join(root, launcher),
      'console.log("not the staged checker");\n',
    );
    const result = commit(root);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /palette-ownership/);
  });
});

test("renamed new Swift source remains in the full scan", () => {
  fixture((root, git) => {
    writeFileSync(join(root, source), invalid);
    git("add", source);
    git("mv", source, "apps/macos/Sources/EagleFeatures/Renamed.swift");
    const result = commit(root);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /Renamed.swift:3: palette-ownership/);
  });
});

for (const directory of ["Sources", "Scripts"]) {
  test(`staged ${directory} directory cannot redirect the check outside its snapshot`, () => {
    fixture((root, git) => {
      cpSync(join(root, "apps/macos"), join(root, "outside"), {
        recursive: true,
      });
      const path = `apps/macos/${directory}`;
      git("rm", "-r", "--cached", path);
      rmSync(join(root, path), { recursive: true });
      symlinkSync(join(root, "outside", directory), join(root, path));
      git("add", path);
      const result = commit(root);
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stderr, /snapshot path refused/);
    });
  });
}

test("missing required Xcode tooling rejects the commit rather than skipping", () => {
  fixture((root) => {
    const result = commit(root, { DEVELOPER_DIR: join(root, "missing-xcode") });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /skipping/);
  });
});

for (const missing of [
  guard,
  launcher,
  "apps/macos/Sources/EagleDesign/Theme.swift",
]) {
  test(`missing staged design input fails closed: ${missing}`, () => {
    fixture((root, git) => {
      git("rm", "-f", missing);
      const result = commit(root);
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
    });
  });
}
