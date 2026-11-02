# Locked npm recovery

Keep both lockfiles unchanged and use the machine-approved registry. Follow the
user's existing source authorization; a previous task's exception is not a new
global default.

1. Record the failed package/version, Node/npm versions, platform and both lock
   hashes. Inventory the root lock and the independent `apps/bots` lock before
   repeating an install.
2. Read retained cache content by the lock's integrity digest. Verify each
   original tarball's SRI and embedded package name/version; do not reconstruct
   archives from installed packages or change locked versions.
3. Add verified `.tgz` files with normal `npm cache add` to a private task cache.
   Run normal `npm ci` separately at the root and `apps/bots`, carrying the cache
   and offline policy to builds, packaging and hooks. Keep lifecycle scripts.
4. A fresh package-install prefix may also require registry-specific metadata.
   Fetch the exact package's real packument through an authorized registry, and
   verify its name/version/integrity against the lock with an offline `npm view`.
5. Audit installed manifests and unchanged locks, then run the normal checks.
   Never bypass a hook or substitute another version to finish recovery.

The 2026-11-02 local recovery needed no new tarball source: all 306 relevant
artifacts were already retained locally. Exact `ws@8.22.0` and `zod@4.6.7`
metadata came from the configured proxy. Evidence is in the ignored
`.local/npm-recovery/` directory and the root [retrospective](../Retrospective.md).
