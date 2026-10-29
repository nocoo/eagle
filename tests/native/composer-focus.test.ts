import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("the native Chat composer focuses on entry and whitespace while preserving editing", (context) => {
  const root = mkdtempSync(join(tmpdir(), "eagle-composer-focus-"));
  const bundle = join(root, "Focus Fixture.app");
  const executable = join(bundle, "Contents", "MacOS", "composer-focus");
  const cleanArguments = [
    "-i",
    "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
    executable,
  ];
  let cursor: { x: number; y: number } | undefined;
  const failures: unknown[] = [];
  try {
    const source = resolve("apps/macos/Sources/EagleDesign");
    const files = readdirSync(source, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".swift"))
      .map((name) => join(source, name));
    mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
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
    const build = spawnSync(
      "xcrun",
      [
        "swiftc",
        "-swift-version",
        "6",
        "-parse-as-library",
        ...files,
        "tests/fixtures/native-composer-focus.swift",
        "-o",
        executable,
      ],
      { encoding: "utf8", timeout: 90_000, maxBuffer: 1024 * 1024 },
    );
    assert.equal(build.status, 0, build.stdout + build.stderr);
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
    // Local runs keep a tight deadline; CI AppKit fixtures compile and exercise more UI.
    const fixtureRunTimeout = process.env.CI ? 60_000 : 15_000;
    const run = spawnSync("/usr/bin/env", cleanArguments, {
      encoding: "utf8",
      timeout: fixtureRunTimeout,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
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
      if (cursor) {
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
