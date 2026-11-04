import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import {
  DeviceId,
  DevicePolicy,
  type OperationRequest,
  type OperationResult,
  type PolicySetRequest,
} from "../contracts/src/devices.ts";

export type OperationOutcome = {
  state: "succeeded" | "failed" | "cancelled" | "unknown";
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export type OperationRecord = Omit<OperationOutcome, "state"> & {
  id: string;
  state: "running" | OperationOutcome["state"];
};
export type OperationScope = {
  kind: "device";
  sourceDeviceId: string;
  targetDeviceId: string;
  sourceBotId?: string;
};

type Row = {
  id: string;
  fingerprint: string;
  state: OperationRecord["state"];
  stdout: string;
  stderr: string;
  exit_code: number | null;
  scope: string | null;
  native_blocked: number;
  native_boot_session_id: string | null;
};

const terminalStates = new Set(["succeeded", "failed", "cancelled", "unknown"]);
function scopeText(scope?: OperationScope | null): string | null {
  if (!scope) return null;
  if (
    scope.kind !== "device" ||
    typeof scope.sourceDeviceId !== "string" ||
    typeof scope.targetDeviceId !== "string"
  )
    throw new OperationAdmissionError("Invalid device scope");
  return JSON.stringify(scope);
}
// Shared even when source/built copies of this module are loaded together. On
// POSIX, closing any descriptor for the database can release this process's
// SQLite locks. Reject another owner before opening a descriptor at all.
const ownerSymbol = Symbol.for("eagle.device-journal.owners");
const shared = globalThis as { [key: symbol]: unknown };
shared[ownerSymbol] ??= new Set<string>();
const localOwners = shared[ownerSymbol] as Set<string>;

/** Hold an existing journal idle without recovery or modifying any operation. */
export function withIdleJournal<T>(path: string, action: () => T): T {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return action();
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o600
  )
    throw new Error("Invalid private operation journal");
  const keys = [`path:${realpathSync(path)}`, `inode:${info.dev}:${info.ino}`];
  if (keys.some((key) => localOwners.has(key)))
    throw new Error("Operation journal is busy");
  for (const key of keys) localOwners.add(key);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path);
    database.exec("PRAGMA busy_timeout = 100; BEGIN EXCLUSIVE;");
    return action();
  } finally {
    database?.close();
    for (const key of keys) localOwners.delete(key);
  }
}
const record = (row: Row): OperationRecord => ({
  id: row.id,
  state: row.state,
  stdout: row.stdout,
  stderr: row.stderr,
  exitCode: row.exit_code,
});

/** Expected admission rejection; other journal errors mean storage is unhealthy. */
export class OperationAdmissionError extends Error {}

export class OperationJournal {
  private database: DatabaseSync;
  private capacity: number;
  private closed = false;
  private ownerKeys: string[] = [];
  private bootSessionId?: string;

  constructor(path: string, capacity = 10_000, bootSessionId?: string) {
    if (!isMainThread)
      throw new Error("Operation journal must be owned by the primary thread");
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100_000)
      throw new Error("Invalid operation journal capacity");
    this.capacity = capacity;
    this.bootSessionId =
      bootSessionId === undefined ? undefined : DeviceId.parse(bootSessionId);
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || (parent.mode & 0o077) !== 0)
      throw new Error("Operation journal needs a private directory");
    const canonicalPath = join(realpathSync(directory), basename(path));
    const pathKey = `path:${canonicalPath}`;
    const existing = lstatSync(canonicalPath, { throwIfNoEntry: false });
    const inodeKey = existing ? `inode:${existing.dev}:${existing.ino}` : null;
    if (localOwners.has(pathKey) || (inodeKey && localOwners.has(inodeKey)))
      throw new Error("Operation journal is locked by this process");
    this.ownerKeys.push(pathKey);
    localOwners.add(pathKey);
    let database: DatabaseSync | undefined;
    try {
      const fd = openSync(
        canonicalPath,
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const file = fstatSync(fd);
        if (!file.isFile())
          throw new Error("Operation journal must be a regular file");
        fchmodSync(fd, 0o600);
        const key = `inode:${file.dev}:${file.ino}`;
        this.ownerKeys.push(key);
        localOwners.add(key);
      } finally {
        closeSync(fd);
      }
      database = new DatabaseSync(canonicalPath);
      this.database = database;
      // An exclusive connection retains its lock across transactions. Recovery
      // cannot run while another service owns this journal, even in this process.
      this.database.exec(`
        PRAGMA busy_timeout = 100;
        PRAGMA locking_mode = EXCLUSIVE;
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = FULL;
        BEGIN EXCLUSIVE;
        CREATE TABLE IF NOT EXISTS operations (
          id TEXT PRIMARY KEY,
          fingerprint TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN
            ('running','succeeded','failed','cancelled','unknown')),
          stdout TEXT NOT NULL DEFAULT '',
          stderr TEXT NOT NULL DEFAULT '',
          exit_code INTEGER,
          scope TEXT,
          native_blocked INTEGER NOT NULL DEFAULT 0,
          native_boot_session_id TEXT
        );
        CREATE TABLE IF NOT EXISTS outgoing_requests (
          id TEXT PRIMARY KEY,target TEXT NOT NULL,digest TEXT,source_bot TEXT,
          state TEXT NOT NULL CHECK(state IN ('sent','retryable'))
        );
        CREATE TABLE IF NOT EXISTS device_policy (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),mode TEXT NOT NULL,version INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS device_policy_requests (
          source TEXT NOT NULL,id TEXT NOT NULL,target TEXT NOT NULL,mode TEXT NOT NULL,version INTEGER NOT NULL,
          PRIMARY KEY(source,id)
        );
        CREATE TABLE IF NOT EXISTS outgoing_policy_requests (
          id TEXT PRIMARY KEY,target TEXT NOT NULL,mode TEXT NOT NULL
        );
        UPDATE operations SET state = 'unknown', exit_code = NULL
          WHERE state = 'running';
        COMMIT;
      `);
      const columns = this.database
        .prepare("PRAGMA table_info(operations)")
        .all() as { name: string }[];
      if (!columns.some((column) => column.name === "scope"))
        this.database.exec("ALTER TABLE operations ADD COLUMN scope TEXT");
      if (!columns.some((column) => column.name === "native_blocked"))
        this.database.exec(
          "ALTER TABLE operations ADD COLUMN native_blocked INTEGER NOT NULL DEFAULT 0",
        );
      if (!columns.some((column) => column.name === "native_boot_session_id"))
        this.database.exec(
          "ALTER TABLE operations ADD COLUMN native_boot_session_id TEXT",
        );
      // Only a trusted helper's proof of a different OS boot establishes that
      // the old native process cannot still be running. Never upgrade unknown
      // outcome evidence or give the original operation another admission.
      if (this.bootSessionId)
        this.database
          .prepare(`UPDATE operations
          SET state='unknown',exit_code=NULL,native_blocked=0
          WHERE native_blocked=1 AND native_boot_session_id IS NOT NULL
            AND native_boot_session_id<>?`)
          .run(this.bootSessionId);
    } catch (error) {
      database?.close();
      for (const key of this.ownerKeys) localOwners.delete(key);
      throw error;
    }
  }

  begin(
    id: string,
    fingerprint: string,
    scope?: OperationScope,
    nativeBlocked = false,
  ): { created: boolean; operation: OperationRecord } {
    if (
      !/^[a-zA-Z0-9_-]{1,120}$/.test(id) ||
      !/^[a-f0-9]{64}$/.test(fingerprint)
    )
      throw new OperationAdmissionError("Invalid operation identity");
    const scopeValue = scopeText(scope);
    const previous = this.row(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint || previous.scope !== scopeValue)
        throw new OperationAdmissionError("Operation identity conflict");
      return { created: false, operation: record(previous) };
    }
    const count = this.database
      .prepare("SELECT COUNT(*) AS count FROM operations")
      .get() as { count: number };
    if (count.count >= this.capacity)
      throw new OperationAdmissionError("Operation journal capacity reached");
    this.database
      .prepare(
        "INSERT INTO operations (id, fingerprint, state, scope,native_blocked,native_boot_session_id) VALUES (?, ?, 'running', ?,?,?)",
      )
      .run(
        id,
        fingerprint,
        scopeValue,
        nativeBlocked ? 1 : 0,
        nativeBlocked ? (this.bootSessionId ?? null) : null,
      );
    return {
      created: true,
      operation: {
        id,
        state: "running",
        stdout: "",
        stderr: "",
        exitCode: null,
      },
    };
  }

  finish(
    id: string,
    outcome: OperationOutcome,
    settleNative = false,
  ): OperationRecord {
    if (
      !terminalStates.has(outcome.state) ||
      typeof outcome.stdout !== "string" ||
      typeof outcome.stderr !== "string" ||
      Buffer.byteLength(outcome.stdout) + Buffer.byteLength(outcome.stderr) >
        65_536 ||
      (outcome.exitCode !== null &&
        (!Number.isInteger(outcome.exitCode) ||
          outcome.exitCode < 0 ||
          outcome.exitCode > 255)) ||
      (outcome.state === "succeeded" &&
        outcome.exitCode !== 0 &&
        outcome.exitCode !== null) ||
      (["cancelled", "unknown"].includes(outcome.state) &&
        outcome.exitCode !== null)
    )
      throw new Error("Invalid or over-budget operation result");
    const previous = this.row(id);
    if (!previous) throw new Error("Unknown operation");
    if (
      previous.state !== "running" &&
      !(settleNative && previous.state === "unknown" && previous.native_blocked)
    )
      return record(previous);
    this.database
      .prepare(
        "UPDATE operations SET state = ?, stdout = ?, stderr = ?, exit_code = ?,native_blocked=CASE WHEN ? THEN 0 ELSE native_blocked END WHERE id = ?",
      )
      .run(
        outcome.state,
        outcome.stdout,
        outcome.stderr,
        outcome.exitCode,
        settleNative ? 1 : 0,
        id,
      );
    const stored = this.row(id);
    if (!stored) throw new Error("Operation result was not persisted");
    return record(stored);
  }

  get(id: string): OperationRecord | null {
    const row = this.row(id);
    return row ? record(row) : null;
  }
  policy(initial?: DevicePolicy): DevicePolicy | undefined {
    if (initial)
      this.database
        .prepare("INSERT OR IGNORE INTO device_policy VALUES(1,?,?)")
        .run(initial.mode, initial.version);
    const row = this.database
      .prepare("SELECT mode,version FROM device_policy WHERE singleton=1")
      .get();
    return row ? DevicePolicy.parse(row) : undefined;
  }
  setPolicy(
    mode: DevicePolicy["mode"],
    source?: string,
    request?: PolicySetRequest,
  ): DevicePolicy {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (request && source) {
        const previous = this.database
          .prepare(
            "SELECT target,mode,version FROM device_policy_requests WHERE source=? AND id=?",
          )
          .get(source, request.requestId) as
          | { target: string; mode: DevicePolicy["mode"]; version: number }
          | undefined;
        if (previous) {
          if (previous.target !== request.deviceId || previous.mode !== mode)
            throw new OperationAdmissionError("policy_request_conflict");
          this.database.exec("COMMIT");
          return { mode: previous.mode, version: previous.version };
        }
        const count = this.database
          .prepare("SELECT count(*) n FROM device_policy_requests")
          .get() as { n: number };
        if (count.n >= this.capacity)
          throw new OperationAdmissionError("policy_request_capacity");
      }
      const current = this.policy();
      if (!current) throw new Error("policy_missing");
      const next = DevicePolicy.parse({ mode, version: current.version + 1 });
      this.database
        .prepare("UPDATE device_policy SET mode=?,version=? WHERE singleton=1")
        .run(next.mode, next.version);
      if (request && source)
        this.database
          .prepare("INSERT INTO device_policy_requests VALUES(?,?,?,?,?)")
          .run(
            source,
            request.requestId,
            request.deviceId,
            next.mode,
            next.version,
          );
      this.database.exec("COMMIT");
      return next;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  preparePolicy(request: PolicySetRequest): void {
    const previous = this.database
      .prepare("SELECT target,mode FROM outgoing_policy_requests WHERE id=?")
      .get(request.requestId) as { target: string; mode: string } | undefined;
    if (previous) {
      if (
        previous.target !== request.deviceId ||
        previous.mode !== request.mode
      )
        throw new OperationAdmissionError("policy_request_conflict");
      throw new OperationAdmissionError(
        "policy_request_already_sent_refresh_target",
      );
    }
    const count = this.database
      .prepare("SELECT count(*) n FROM outgoing_policy_requests")
      .get() as { n: number };
    if (count.n >= this.capacity)
      throw new OperationAdmissionError("policy_request_capacity");
    this.database
      .prepare("INSERT INTO outgoing_policy_requests VALUES(?,?,?)")
      .run(request.requestId, request.deviceId, request.mode);
  }
  getScope(id: string): OperationScope | null {
    const value = this.row(id)?.scope;
    if (!value) return null;
    const scope = JSON.parse(value) as OperationScope;
    scopeText(scope);
    return scope;
  }
  blockedNative(): string[] {
    return (
      this.database
        .prepare("SELECT id FROM operations WHERE native_blocked=1")
        .all() as { id: string }[]
    ).map((row) => row.id);
  }
  private outgoing(request: OperationRequest) {
    const row = this.database
      .prepare(
        "SELECT target,digest,source_bot,state FROM outgoing_requests WHERE id=?",
      )
      .get(request.operationId) as
      | {
          target: string;
          digest: string | null;
          source_bot: string | null;
          state: "sent" | "retryable";
        }
      | undefined;
    if (
      row &&
      (row.target !== request.targetDeviceId ||
        (request.digest !== undefined && row.digest !== request.digest) ||
        (request.action === "run" &&
          row.source_bot !== (request.sourceBotId ?? null)))
    )
      throw new OperationAdmissionError("operation_binding_conflict");
    return row;
  }
  outgoingState(request: OperationRequest): "sent" | "retryable" | undefined {
    return this.outgoing(request)?.state;
  }
  prepareOutgoing(request: OperationRequest): OperationRequest {
    const row = this.outgoing(request);
    if (row) {
      const action =
        request.action === "run" && row.state !== "retryable"
          ? "get"
          : request.action;
      this.database
        .prepare("UPDATE outgoing_requests SET state='sent' WHERE id=?")
        .run(request.operationId);
      return { ...request, action };
    }
    const count = this.database
      .prepare("SELECT count(*) n FROM outgoing_requests")
      .get() as { n: number };
    if (count.n >= this.capacity)
      throw new OperationAdmissionError("caller_journal_capacity");
    this.database
      .prepare("INSERT INTO outgoing_requests VALUES(?,?,?,?,'sent')")
      .run(
        request.operationId,
        request.targetDeviceId,
        request.digest ?? null,
        request.sourceBotId ?? null,
      );
    return request;
  }
  completeOutgoing(request: OperationRequest, value: OperationResult): void {
    const retryable =
      request.action === "run" && ["busy", "denied"].includes(value.status);
    this.database
      .prepare("UPDATE outgoing_requests SET state=? WHERE id=? AND target=?")
      .run(
        retryable ? "retryable" : "sent",
        request.operationId,
        request.targetDeviceId,
      );
  }

  private row(id: string): Row | undefined {
    return this.database
      .prepare("SELECT * FROM operations WHERE id = ?")
      .get(id) as Row | undefined;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
    for (const key of this.ownerKeys) localOwners.delete(key);
  }
}
