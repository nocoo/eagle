import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { hash, validateBundle } from "../../src/runtime/pi/HistoryReplica.ts";
import {
  keyOf,
  pageSchema,
  resourceManifest,
  validateResourceCarrier,
} from "../../src/runtime/pi/syncProtocol.ts";

test("normative resource-only carrier and incremental refs retain original ordered bytes", async () => {
  const load = async (name: string) =>
    JSON.parse(
      await readFile(new URL(`../../../../fixtures/bots-sync/${name}`, import.meta.url), "utf8"),
    );
  const carrier = validateResourceCarrier(await load("resource-carrier.v1.json"));
  const page = pageSchema.parse(await load("resource-page.v1.json"));
  assert.deepEqual(carrier.resources, await load("resources.v1.json"));
  assert.deepEqual(page.events.at(-1)?.body, resourceManifest(carrier.resources));
  assert.equal(carrier.head, keyOf(resourceManifest(carrier.resources)));
  assert.deepEqual(
    page.events.slice(0, -1).map((e) => keyOf(e.body as Parameters<typeof keyOf>[0])),
    resourceManifest(carrier.resources).resources,
  );
  assert.throws(() => validateBundle(carrier));
  for (const bad of [
    { ...carrier, head: "0".repeat(64) },
    { ...carrier, resources: [] },
    { ...carrier, resources: carrier.resources.slice(1) },
    { ...carrier, resources: [...carrier.resources].reverse() },
    { ...carrier, agent: { cwd: "/foreign" } },
  ])
    assert.throws(() => validateResourceCarrier(bad));
  // Existing no-resource P0 digests and nonempty history remain independent formats.
  const history = validateBundle(await load("history.v1.json"));
  const { head, ...payload } = history;
  assert.equal(hash(payload), head);
  assert.ok(history.entries.length > 0);
});
