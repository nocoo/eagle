// The provider owns SQL because the pinned SDK exposes no read-only storage API
// (docs/bots/specs/OBSERVATION-SPIKE.md). This test makes that coupling explicit: it
// fails the moment the pinned schema's version or table names move.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { applySqliteMigrations } from "@earendil-works/pi-durable/storage/sqlite";
import { CURRENT_SCHEMA_VERSION, SCHEMA_MIGRATIONS, TABLES } from "../../src/observation/schema.ts";

test("the pinned schema version is the one the provider reads", () => {
  assert.equal(CURRENT_SCHEMA_VERSION, 2);
  assert.equal(SCHEMA_MIGRATIONS.at(-1)?.version, CURRENT_SCHEMA_VERSION);
});

test("every provider table name exists in the pinned schema", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bots-schema-"));
  const path = join(dir, "session.sqlite");
  try {
    const db = await openNodeSqliteDatabase(path);
    await applySqliteMigrations(db);
    await db.close();

    const raw = new DatabaseSync(path, { readOnly: true });
    try {
      const names = new Set(
        (
          raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
            name: string;
          }[]
        ).map((row) => row.name),
      );
      for (const table of Object.values(TABLES)) {
        assert.ok(names.has(table), `${table} is part of the pinned schema`);
      }
      const version = raw
        .prepare(`SELECT version FROM ${TABLES.schema} WHERE singleton = 1`)
        .get() as { version: number } | undefined;
      assert.equal(version?.version, CURRENT_SCHEMA_VERSION);
    } finally {
      raw.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
