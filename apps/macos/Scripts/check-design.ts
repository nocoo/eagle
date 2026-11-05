import { execFileSync, spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = dirname(fileURLToPath(import.meta.url));
const sources = resolve(scripts, "../Sources");
const environment = {
  ...process.env,
  DEVELOPER_DIR:
    process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer",
};

export function compileDesignGuard(directory: string): string {
  const compiler = execFileSync("/usr/bin/xcrun", ["--find", "swiftc"], {
    env: environment,
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  const host = resolve(dirname(compiler), "../lib/swift/host");
  const sdk = execFileSync("/usr/bin/xcrun", ["--show-sdk-path"], {
    env: environment,
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  const binary = join(directory, "design-guard");
  execFileSync(
    compiler,
    [
      "-sdk",
      sdk,
      "-I",
      host,
      "-L",
      host,
      "-Xlinker",
      "-rpath",
      "-Xlinker",
      host,
      join(scripts, "DesignGuard.swift"),
      "-o",
      binary,
    ],
    { env: environment, timeout: 60_000, stdio: "pipe" },
  );
  return binary;
}

function sourceFiles(directory: string): Record<string, string> {
  if (lstatSync(directory).isSymbolicLink())
    throw new Error(`design-guard: source symlink refused: ${directory}`);
  const files: Record<string, string> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`design-guard: source symlink refused: ${path}`);
    if (entry.isDirectory()) Object.assign(files, sourceFiles(path));
    else if (entry.name.endsWith(".swift"))
      files[relative(sources, path)] = readFileSync(path, "utf8");
  }
  return files;
}

function main(): void {
  const directory = mkdtempSync(join(tmpdir(), "eagle-design-guard-"));
  try {
    const binary = compileDesignGuard(directory);
    const result = spawnSync(binary, [], {
      input: JSON.stringify(sourceFiles(sources)),
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(result.stderr || `design-guard exited ${result.status}`);
    const findings = JSON.parse(result.stdout) as {
      path: string;
      line: number;
      rule: string;
    }[];
    for (const item of findings)
      console.error(
        `apps/macos/Sources/${item.path}:${item.line}: ${item.rule}`,
      );
    if (findings.length) process.exitCode = 1;
    else console.log("design-guard: palette and typography ownership passed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
