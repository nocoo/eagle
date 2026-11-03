// The secrets audit ledger (docs/bots/EXTENSIONS-AND-TOOLS.md §6.5 "Audit"): one JSON
// object per line, the newest 2000 kept, and never a value.
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SecretAudit, type SecretAuditEntry } from "../../src/secrets/audit.ts";

const bench = async () => {
  const root = await mkdtemp(join(tmpdir(), "bots-secret-audit-"));
  return { root, path: join(root, "secrets.audit.jsonl") };
};

const entry = (overrides: Partial<SecretAuditEntry> = {}): SecretAuditEntry => ({
  ts: "2026-11-03T01:10:02.104Z",
  op: "read",
  scope: "shared",
  key: "github-pat",
  botId: "b_0190a1b0",
  by: "bot",
  trace: "tr_0190a1b2",
  ok: true,
  ...overrides,
});

test("one entry is one line, and the file is private", async () => {
  const { root, path } = await bench();
  try {
    const audit = new SecretAudit({ path });
    await audit.append(entry());
    await audit.append(entry({ op: "write", by: "person", ok: true }));
    const text = await readFile(path, "utf8");
    const lines = text.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0] as string), {
      ts: "2026-11-03T01:10:02.104Z",
      op: "read",
      scope: "shared",
      key: "github-pat",
      botId: "b_0190a1b0",
      by: "bot",
      trace: "tr_0190a1b2",
      ok: true,
    });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root))).mode & 0o777, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the newest entries are kept and the oldest are dropped", async () => {
  const { root, path } = await bench();
  try {
    const audit = new SecretAudit({ path, limit: 5 });
    for (let index = 0; index < 8; index += 1) {
      await audit.append(entry({ key: `k${String(index)}` }));
    }
    const entries = await audit.entries();
    assert.equal(entries.length, 5);
    assert.deepEqual(
      entries.map((row) => row.key),
      ["k3", "k4", "k5", "k6", "k7"],
    );
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    assert.equal(lines.length, 5, "the file itself is trimmed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the ledger keeps two thousand entries by default", async () => {
  const { root, path } = await bench();
  try {
    const audit = new SecretAudit({ path });
    for (let index = 0; index < 2005; index += 1) {
      await audit.append(entry({ key: `k${String(index)}` }));
    }
    const entries = await audit.entries();
    assert.equal(entries.length, 2000);
    assert.equal(entries[0]?.key, "k5", "the five oldest rows are dropped");
    assert.equal(entries.at(-1)?.key, "k2004");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the tail can be read without the whole file", async () => {
  const { root, path } = await bench();
  try {
    const audit = new SecretAudit({ path });
    await audit.append(entry({ key: "first" }));
    await audit.append(entry({ key: "second" }));
    const tail = await audit.entries({ limit: 1 });
    assert.deepEqual(
      tail.map((row) => row.key),
      ["second"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the last use of a record is what the ledger says", async () => {
  const { root, path } = await bench();
  try {
    const audit = new SecretAudit({ path });
    await audit.append(entry({ op: "read", ts: "2026-11-03T01:10:00.000Z" }));
    await audit.append(entry({ op: "read", ts: "2026-11-03T02:10:00.000Z", by: "bot" }));
    await audit.append(entry({ op: "read", ts: "2026-11-03T03:10:00.000Z", by: "person" }));
    await audit.append(entry({ op: "write", ts: "2026-11-03T04:10:00.000Z" }));
    assert.deepEqual(await audit.lastUse("github-pat", "shared"), {
      at: "2026-11-03T03:10:00.000Z",
      by: "person",
    });
    assert.equal(await audit.lastUse("absent", "shared"), undefined);
    assert.equal(await audit.lastUse("github-pat", "bot"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a ledger that does not exist is an empty ledger", async () => {
  const { root, path } = await bench();
  try {
    const audit = new SecretAudit({ path });
    assert.deepEqual(await audit.entries(), []);
    assert.equal(await audit.lastUse("github-pat", "shared"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a line that is not a row is skipped, not guessed at", async () => {
  const { root, path } = await bench();
  try {
    const audit = new SecretAudit({ path });
    await audit.append(entry({ key: "good" }));
    await appendFile(path, "not json\n", "utf8");
    await appendFile(path, `${JSON.stringify({ op: "read" })}\n`, "utf8");
    await appendFile(path, `${JSON.stringify({ ...entry(), op: "unknown" })}\n`, "utf8");
    await appendFile(path, `${JSON.stringify({ ...entry(), key: "good2" })}\n`, "utf8");
    const entries = await audit.entries();
    assert.deepEqual(
      entries.map((row) => row.key),
      ["good", "good2"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
