import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  OperationJournal,
  type OutgoingScope,
} from "../packages/agent/device-journal.ts";
import type { OperationRequest } from "../packages/contracts/src/devices.ts";

test("remote operation IDs remain bound to their original relay", () => {
  const root = mkdtempSync(join(tmpdir(), "device-origin-"));
  let journal = new OperationJournal(join(root, "journal.sqlite"));
  const input: OperationRequest = {
    requestId: randomUUID(),
    operationId: randomUUID(),
    targetDeviceId: randomUUID(),
    action: "run",
    operation: { kind: "command", command: "printf original-target" },
    digest: "a".repeat(64),
  };
  const a: OutgoingScope = { kind: "remote", origin: "https://a.example" };
  const b: OutgoingScope = { kind: "remote", origin: "https://b.example" };
  const prepare = (value: OperationRequest, scope: OutgoingScope) =>
    journal.prepareOutgoing(value, scope);
  try {
    assert.equal(prepare(input, a).action, "run");
    assert.throws(() => prepare(input, b), /relay_origin_mismatch/);
    assert.equal(prepare(input, a).action, "get");
    journal.close();
    journal = new OperationJournal(join(root, "journal.sqlite"));
    assert.throws(() => prepare(input, b), /relay_origin_mismatch/);
    assert.equal(prepare(input, a).action, "get");
    const another = {
      ...input,
      requestId: randomUUID(),
      operationId: randomUUID(),
    };
    assert.equal(prepare(another, b).action, "run");
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pre-approved origin cannot be rebound and is not marked sent", () => {
  const root = mkdtempSync(join(tmpdir(), "device-origin-intent-"));
  const journal = new OperationJournal(join(root, "journal.sqlite"));
  const request: OperationRequest = {
    requestId: randomUUID(),
    operationId: randomUUID(),
    targetDeviceId: randomUUID(),
    action: "run",
    operation: { kind: "command", command: "printf original-target" },
    digest: "c".repeat(64),
  };
  const a: OutgoingScope = { kind: "remote", origin: "https://a.example" };
  const b: OutgoingScope = { kind: "remote", origin: "https://b.example" };
  try {
    journal.bindOperationOrigin(request, a);
    assert.equal(journal.outgoingState(request), undefined);
    assert.throws(
      () => journal.bindOperationOrigin(request, b),
      /relay_origin_mismatch/,
    );
    assert.throws(
      () => journal.prepareOutgoing(request, b),
      /relay_origin_mismatch/,
    );
    assert.throws(
      () =>
        journal.prepareOutgoing(
          { ...request, targetDeviceId: randomUUID() },
          a,
        ),
      /operation_binding_conflict/,
    );
    assert.equal(journal.prepareOutgoing(request, a).action, "run");
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-approval intents count against the existing journal capacity", () => {
  const root = mkdtempSync(join(tmpdir(), "device-origin-capacity-"));
  const journal = new OperationJournal(join(root, "journal.sqlite"), 1);
  const input: OperationRequest = {
    requestId: randomUUID(),
    operationId: randomUUID(),
    targetDeviceId: randomUUID(),
    action: "run",
    operation: { kind: "command", command: "printf bounded" },
    digest: "e".repeat(64),
  };
  const scope: OutgoingScope = { kind: "remote", origin: "https://a.example" };
  try {
    journal.bindOperationOrigin(input, scope);
    journal.bindOperationOrigin(input, scope);
    const another = { ...input, operationId: randomUUID() };
    assert.throws(
      () => journal.bindOperationOrigin(another, scope),
      /caller_journal_capacity/,
    );
    assert.equal(journal.prepareOutgoing(input, scope).action, "run");
    assert.throws(
      () => journal.prepareOutgoing(another, scope),
      /caller_journal_capacity/,
    );
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote policy request IDs remain bound to their original relay", () => {
  const root = mkdtempSync(join(tmpdir(), "device-policy-origin-"));
  let journal = new OperationJournal(join(root, "journal.sqlite"));
  const request = {
    requestId: randomUUID(),
    deviceId: randomUUID(),
    mode: "paused" as const,
  };
  const a: OutgoingScope = { kind: "remote", origin: "https://a.example" };
  const b: OutgoingScope = { kind: "remote", origin: "https://b.example" };
  const prepare = (scope: OutgoingScope) =>
    journal.preparePolicy(request, scope);
  try {
    prepare(a);
    assert.throws(() => prepare(b), /relay_origin_mismatch/);
    assert.throws(
      () => prepare(a),
      /policy_request_already_sent_refresh_target/,
    );
    journal.close();
    journal = new OperationJournal(join(root, "journal.sqlite"));
    assert.throws(() => prepare(b), /relay_origin_mismatch/);
    assert.throws(
      () => prepare(a),
      /policy_request_already_sent_refresh_target/,
    );
    journal.preparePolicy({ ...request, requestId: randomUUID() }, b);
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("pairing IDs bind the code digest and relay without storing the code", () => {
  const root = mkdtempSync(join(tmpdir(), "device-pairing-origin-"));
  let journal = new OperationJournal(join(root, "journal.sqlite"));
  const a: OutgoingScope = { kind: "remote", origin: "https://a.example" };
  const b: OutgoingScope = { kind: "remote", origin: "https://b.example" };
  const id = randomUUID();
  const digest = "d".repeat(64);
  try {
    journal.bindPairing(id, digest, a);
    journal.bindPairing(id, digest, a);
    assert.throws(
      () => journal.bindPairing(id, digest, b),
      /relay_origin_mismatch/,
    );
    assert.throws(
      () => journal.bindPairing(id, "e".repeat(64), a),
      /request_conflict/,
    );
    assert.throws(
      () => journal.pairingOrigin(randomUUID()),
      /relay_origin_unknown/,
    );
    journal.close();
    journal = new OperationJournal(join(root, "journal.sqlite"));
    assert.equal(journal.pairingOrigin(id), "https://a.example");
    assert.throws(
      () => journal.bindPairing(id, digest, b),
      /relay_origin_mismatch/,
    );
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("pairing origin intents are bounded without deleting old bindings", () => {
  const root = mkdtempSync(join(tmpdir(), "device-pairing-capacity-"));
  const journal = new OperationJournal(join(root, "journal.sqlite"), 1);
  const scope: OutgoingScope = { kind: "remote", origin: "https://a.example" };
  const id = randomUUID();
  const digest = "f".repeat(64);
  try {
    journal.bindPairing(id, digest, scope);
    journal.bindPairing(id, digest, scope);
    assert.throws(
      () => journal.bindPairing(randomUUID(), digest, scope),
      /pairing_request_capacity/,
    );
    assert.equal(journal.pairingOrigin(id), "https://a.example");
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote origin binding is atomic and never adopts unknown operations", () => {
  const root = mkdtempSync(join(tmpdir(), "device-origin-atomic-"));
  const journal = new OperationJournal(join(root, "journal.sqlite"));
  const database = (journal as unknown as { database: DatabaseSync }).database;
  const request: OperationRequest = {
    requestId: randomUUID(),
    operationId: randomUUID(),
    targetDeviceId: randomUUID(),
    action: "run",
    operation: { kind: "command", command: "printf original-target" },
    digest: "b".repeat(64),
  };
  const remote: OutgoingScope = { kind: "remote", origin: "https://a.example" };
  try {
    database.exec(
      "CREATE TRIGGER reject_binding BEFORE INSERT ON outgoing_relay_bindings BEGIN SELECT RAISE(ABORT,'binding failure'); END",
    );
    assert.throws(
      () => journal.prepareOutgoing(request, remote),
      /binding failure/,
    );
    assert.equal(
      (
        database
          .prepare("SELECT count(*) n FROM outgoing_requests WHERE id=?")
          .get(request.operationId) as { n: number }
      ).n,
      0,
    );
    database.exec("DROP TRIGGER reject_binding");
    assert.throws(
      () => journal.prepareOutgoing({ ...request, action: "get" }, remote),
      /relay_origin_unknown/,
    );
    const old = { ...request, operationId: randomUUID() };
    database
      .prepare("INSERT INTO outgoing_requests VALUES(?,?,?,?,'sent')")
      .run(old.operationId, old.targetDeviceId, old.digest ?? null, null);
    assert.throws(
      () => journal.prepareOutgoing(old, remote),
      /relay_origin_unknown/,
    );
    assert.equal(
      (
        database
          .prepare("SELECT count(*) n FROM outgoing_relay_bindings WHERE id=?")
          .get(old.operationId) as { n: number }
      ).n,
      0,
    );
    assert.equal(journal.prepareOutgoing(request, remote).action, "run");
    assert.throws(
      () =>
        journal.completeOutgoing(
          request,
          { status: "denied" },
          { kind: "remote", origin: "https://b.example" },
        ),
      /relay_origin_mismatch/,
    );
    assert.equal(journal.outgoingState(request), "sent");
    assert.throws(
      () => journal.prepareOutgoing(request, { kind: "local" }),
      /relay_origin_mismatch/,
    );
    assert.throws(
      () =>
        journal.prepareOutgoing(
          { ...request, operationId: randomUUID() },
          { kind: "remote", origin: "https://user:pass@a.example/path" },
        ),
      /invalid_relay_origin/,
    );
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});
