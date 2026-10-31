import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

// Test-owned pipes hold a real helper reply; the service and helper stay unmodified.
const root = process.argv[2];
const child = spawn(process.execPath, process.argv.slice(3), {
  stdio: ["pipe", "inherit", "inherit"],
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const marker = join(root, "hold-helper");
  const message = JSON.parse(line);
  if (existsSync(marker) && readFileSync(marker, "utf8") === message.type) {
    writeFileSync(join(root, "helper-held"), message.type);
    const deadline = Date.now() + 12000;
    while (existsSync(marker)) {
      assert(
        Date.now() < deadline,
        "owned helper reply barrier was not released",
      );
      await delay(5);
    }
  }
  child.stdin.write(line + "\n");
}
child.stdin.end();
