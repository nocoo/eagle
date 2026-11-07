// The observation schema boundary (SG-002): provider-owned table and column names plus
// the pinned schema version. A conformance test fails when the pinned pi-durable schema
// moves, so this coupling stays explicit and guarded instead of implicit.
import { CURRENT_SQLITE_SCHEMA_VERSION, SQLITE_MIGRATIONS } from "../runtime/pi/schema.ts";

export const CURRENT_SCHEMA_VERSION = CURRENT_SQLITE_SCHEMA_VERSION;
export const SCHEMA_MIGRATIONS = SQLITE_MIGRATIONS;

export const TABLES = {
  schema: "durable_schema",
  metadata: "durable_metadata",
  conversations: "conversations",
  entries: "entries",
  tasks: "tasks",
} as const;

/** One delivered message never exceeds this; larger stored entries are trimmed. */
export const DELIVERY_MESSAGE_BYTES = 64 * 1024;

/** One provider response never exceeds this, so the consumer frame stays under 256 KiB. */
export const RESPONSE_BYTES = 192 * 1024;

/** `changes` carries its baseline in a body; 200 Bots must fit. */
export const BASELINE_BODY_BYTES = 64 * 1024;
