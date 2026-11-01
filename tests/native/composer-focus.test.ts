import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const macosPackage = resolve("apps/macos");

test("the native Chat composer focuses on entry and whitespace while preserving editing", (context) => {
  const root = mkdtempSync(join(tmpdir(), "eagle-composer-focus-"));
  const bundle = join(root, "Focus Fixture.app");
  const macosDir = join(bundle, "Contents", "MacOS");
  const bundleExecutable = join(macosDir, "composer-focus");
  let cleanArguments: string[] = [];
  let cursor: { x: number; y: number } | undefined;
  const failures: unknown[] = [];
  // CI already built EagleDesign for `swift build`; this links the fixture incrementally.
  const linkTimeout = process.env.CI ? 120_000 : 60_000;
  try {
    const build = spawnSync(
      "swift",
      [
        "build",
        "--package-path",
        macosPackage,
        "--target",
        "ComposerFocusFixture",
        "-c",
        "debug",
      ],
      { encoding: "utf8", timeout: linkTimeout, maxBuffer: 10 * 1024 * 1024 },
    );
    assert.equal(build.status, 0, build.stdout + build.stderr);
    const binPath = spawnSync(
      "swift",
      [
        "build",
        "--package-path",
        macosPackage,
        "--target",
        "ComposerFocusFixture",
        "--show-bin-path",
        "-c",
        "debug",
      ],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    assert.equal(binPath.status, 0, binPath.stderr);
    const fixtureBinDir = binPath.stdout.trim();
    mkdirSync(macosDir, { recursive: true });
    writeFileSync(
      join(bundle, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>ai.hexly.eagle.focus-fixture.${randomUUID()}</string>
<key>CFBundleExecutable</key><string>composer-focus</string>
<key>CFBundleName</key><string>Eagle Focus Fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>15.0</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
`,
    );
    copyFileSync(
      join(fixtureBinDir, "ComposerFocusFixture"),
      bundleExecutable,
    );
    for (const name of readdirSync(fixtureBinDir)) {
      if (name.endsWith(".dylib")) {
        copyFileSync(join(fixtureBinDir, name), join(macosDir, name));
      }
    }
    cleanArguments = [
      "-i",
      `DYLD_LIBRARY_PATH=${macosDir}`,
      "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
      "EAGLE_COMPOSER_FOCUS_FIXTURE=1",
      bundleExecutable,
    ];
    const sign = spawnSync(
      "/usr/bin/codesign",
      ["--force", "--sign", "-", "--timestamp=none", bundle],
      { encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024 },
    );
    assert.equal(sign.status, 0, sign.stdout + sign.stderr);
    const position = spawnSync(
      "/usr/bin/env",
      [...cleanArguments, "--cursor-position"],
      { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" },
    );
    assert.equal(position.status, 0, position.stdout + position.stderr);
    cursor = JSON.parse(position.stdout) as { x: number; y: number };
    assert(Number.isFinite(cursor.x) && Number.isFinite(cursor.y));
    // Run-only budget: compile is separate. Traces on stderr show stage progress if this fires.
    const fixtureRunTimeout = process.env.CI ? 150_000 : 45_000;
    const run = spawnSync("/usr/bin/env", cleanArguments, {
      encoding: "utf8",
      timeout: fixtureRunTimeout,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    context.diagnostic(
      JSON.stringify({
        status: run.status,
        signal: run.signal,
        error: run.error?.message ?? null,
        stdout: run.stdout,
        stderr: run.stderr,
      }),
    );
    if (run.error || run.status !== 0) {
      console.error(run.stderr || run.error?.message || run.stdout);
    }
    assert.ifError(run.error);
    const report = JSON.parse(run.stdout.trim() || "null") as {
      complete: boolean;
      checks: { name: string; passed: boolean }[];
    } | null;
    assert.equal(report?.complete, true, run.stdout + run.stderr);
    assert(report);
    context.diagnostic(JSON.stringify(report));
    assert.equal(
      report.checks.length,
      42,
      "all native event checks must finish",
    );
    assert.deepEqual(
      report.checks.filter((check) => !check.passed),
      [],
      JSON.stringify(report),
    );
    assert.equal(run.status, 0, run.stderr);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      if (cursor && cleanArguments.length > 0) {
        const restored = spawnSync(
          "/usr/bin/env",
          [
            ...cleanArguments,
            "--restore-cursor",
            String(cursor.x),
            String(cursor.y),
          ],
          { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" },
        );
        assert.ifError(restored.error);
        assert.equal(restored.status, 0, restored.stdout + restored.stderr);
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Native focus check and cleanup failed");
  }
});
