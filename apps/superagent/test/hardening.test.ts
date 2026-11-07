import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startService } from "../src/server.ts";

async function status(port: number, headers: Record<string, string>) {
  return new Promise<number | undefined>((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}/v1/health`, { headers }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end("body");
  });
}

test("unsafe existing root is refused without permissions repair or credential creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "superagent-root-"));
  try {
    await chmod(root, 0o777);
    await assert.rejects(async () => {
      await (await startService({ root, port: 0 })).close();
    }, /unsafe_root/);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed UUID identity fails closed rather than becoming a healthy store", async () => {
  const root = await mkdtemp(join(tmpdir(), "superagent-uuid-"));
  try {
    await writeFile(
      join(root, "identity.json"),
      JSON.stringify({ service: "eagle-superagent", storeId: "-".repeat(36) }),
      { mode: 0o600 },
    );
    await assert.rejects(async () => {
      await (await startService({ root, port: 0 })).close();
    }, /invalid_identity/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bodyless health refuses both content-length and chunked payloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "superagent-body-"));
  const service = await startService({ root, port: 0 });
  try {
    assert.equal(await status(service.port, { "content-length": "4" }), 413);
    assert.equal(await status(service.port, { "transfer-encoding": "chunked" }), 413);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
