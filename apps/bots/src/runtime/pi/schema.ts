// The pinned pi-durable schema, re-exported for the read-only observation projection
// (SG-002). Only the adapter may import the SDK, so the provider's schema guard reads the
// version and migrations through this module.
export {
  CURRENT_SQLITE_SCHEMA_VERSION,
  SQLITE_MIGRATIONS,
} from "@earendil-works/pi-durable/storage/sqlite";
