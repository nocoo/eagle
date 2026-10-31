# Bots Sync encrypted cache Worker

Independent private Worker, SQLite Sync DO per sharedBot and ciphertext-only R2.
The contract is [SYNC-CACHE.md](../../docs/bots/SYNC-CACHE.md). No Eagle source
imports or root workspace membership. The Registry is reached only through the
named `SyncCacheRegistry` metadata service binding; local tests never deploy it.

Run `npm ci` and `npm run check` here. Check runs strict types, check-only Biome,
the same complete owned Miniflare test suite and a Wrangler dry-run build.
`npm run format` edits formatting; it is not a gate. CI installs this lock
separately. For blocked installs follow [locked recovery](../../docs/NPM-RECOVERY.md).
`wrangler.jsonc` has placeholder deployment bindings; this slice authorizes only
local dry-run/Miniflare. No public bucket, presigned URL or cache fallback exists.
