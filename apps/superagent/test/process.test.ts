import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";

async function launch(root: string) {
  const child = spawn(process.execPath, ["scripts/serve.ts", "--root", root, "--port", "0"], {
    cwd: new URL("..", import.meta.url),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.resume();
  const ready = await new Promise<{ port: number; instance: string; storeId: string }>(
    (resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("startup_timeout"));
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error("startup_failed"));
      });
      const lines = createInterface({ input: child.stdout });
      lines.once("line", (line) => {
        clearTimeout(timeout);
        lines.close();
        resolve(JSON.parse(line));
      });
    },
  );
  return { child, ready };
}

async function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 8_000);
  child.kill(signal);
  await exited;
  clearTimeout(timeout);
}

test("SG001-A01/A02/A07: executable starts alone, rejects duplicate root, stops and recovers after SIGKILL", {
  timeout: 20_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "superagent-process-"));
  const children: ChildProcess[] = [];
  try {
    const first = await launch(root);
    children.push(first.child);
    const health = (await (
      await fetch(`http://127.0.0.1:${first.ready.port}/v1/health`)
    ).json()) as { modelReady: boolean };
    assert.equal(health.modelReady, false);
    await assert.rejects(launch(root), /startup_failed/);
    await stop(first.child, "SIGKILL");
    const second = await launch(root);
    children.push(second.child);
    assert.equal(second.ready.storeId, first.ready.storeId);
    assert.notEqual(second.ready.instance, first.ready.instance);
    await stop(second.child);
    assert.equal(second.child.exitCode, 0);
  } finally {
    for (const child of children) await stop(child);
    await rm(root, { recursive: true, force: true });
  }
});
