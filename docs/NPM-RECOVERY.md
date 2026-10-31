# Locked npm recovery

Use the installed npm-locked-recovery skill for bounded diagnosis, original
lockfile SRI/name/version verification and a task-private cache. Keep every
existing lock byte, normal lifecycle/build/check and hook. Do not copy a temporary
registry/cache or script policy into global configuration.

## 2026-10-31 independent Bots Sync Worker

Evidence: `.local/sync-p4-cf72h-cache/worker-dependency-recovery.json` (f4ba1390),
`npm-recovery/inventory.json`, original verified tarballs and `worker-install-second`
start/raw/exit. First offline ci failed ENOTCACHED for nested undici7.29.1; the
original metadata/cache failures remain. One platform inventory identified54
original tarballs, reused cache by locked SRI and fetched only missing originals
from the already approved task registry. Each original tgz was checked against
lock SRI and package name/version; registry-specific packument entries were
restored before the next normal install.

The new independent `apps/bots-sync/package-lock.json` SHA is
`09589d486d6b0e26211a0416e78fc9db3a04e462ca27e846ae1b7bce681a0b99`.
It selects top-level undici7.29.0/sharp0.35.4 under its original dependency ranges.
Root's pre-existing overrides select7.30.1/0.35.5; its lock and the Bots lock are
unchanged. This difference is an independent resolution, not a recovery upgrade.
Normal `npm ci --offline --foreground-scripts` succeeded, actually running
esbuild0.28.2 and workerd1.20260918.1/1.20261019.1 postinstall. Exact verified
lifecycle permissions are local to this new private package; no ignore-scripts
result is accepted as installation. No global setting, skill, root override,
original package bytes or lock was changed. No install or publication in another
tree is part of this incident. Runtime/build/test results have separate receipts.
