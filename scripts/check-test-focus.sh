#!/bin/sh
# Fail closed when tests declare skip/focus in the staged snapshot.
set -eu
root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
violations=
for pattern in 'test\.only' 'describe\.only' 'test\.skip' 'describe\.skip' 'it\.only' 'it\.skip'; do
  found=$(grep -R --include='*.test.ts' --include='*.spec.ts' -n -E "$pattern" \
    tests apps/web packages scripts 2>/dev/null || true)
  [ -n "$found" ] || continue
  violations=$(printf '%s\n%s' "$violations" "$found")
done
if [ -n "$violations" ]; then
  echo "l1-index-gate: skip/focus tests are not allowed" >&2
  printf '%s\n' "$violations" >&2
  exit 1
fi
