import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("pre-commit rejects a bad index even when only the working tree is repaired", {
  timeout: 15000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "superagent-index-"));
  const run = (...args: string[]) =>
    spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    });
  try {
    assert.equal(run("init", "-q").status, 0);
    await mkdir(join(root, ".githooks"));
    const hook = join(root, ".githooks/pre-commit");
    await writeFile(
      hook,
      await readFile(new URL("../../../.githooks/pre-commit", import.meta.url)),
    );
    await chmod(hook, 0o755);
    run("config", "core.hooksPath", ".githooks");
    await mkdir(join(root, "apps/superagent/node_modules"), { recursive: true });
    await writeFile(
      join(root, "apps/superagent/package.json"),
      JSON.stringify({ scripts: { check: "node check.cjs" } }),
    );
    await writeFile(
      join(root, "apps/superagent/check.cjs"),
      "if (require('node:fs').readFileSync('input.txt','utf8') !== 'green') process.exit(1);\n",
    );
    await writeFile(join(root, "apps/superagent/input.txt"), "red");
    run(
      "add",
      "apps/superagent/package.json",
      "apps/superagent/check.cjs",
      "apps/superagent/input.txt",
    );
    await writeFile(join(root, "apps/superagent/input.txt"), "green");
    const rejected = run("commit", "-qm", "test: reject staged regression");
    assert.notEqual(rejected.status, 0, rejected.stdout + rejected.stderr);
    run("add", "apps/superagent/input.txt");
    await writeFile(join(root, "apps/superagent/input.txt"), "red");
    const accepted = run("commit", "-qm", "test: accept healthy staged snapshot");
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
