#!/bin/sh
# The deterministic test file list, shared by `npm test` and `npm run coverage`.
# Includes root-level suites such as test/architecture.test.ts. test/crash and
# test/perf are excluded on purpose: a real SIGKILL and a real clock are not
# deterministic, and they run as their own gates.
set -eu
cd "$(dirname "$0")/.."

files=""
for dir in src test test/protocol test/core test/runtime test/server test/e2e test/log test/tools test/triggers test/peers test/pulls test/secrets test/observation; do
  if [ -d "$dir" ]; then
    found=$(find "$dir" -maxdepth 1 -name '*.test.ts' | sort)
    [ -n "$found" ] && files="$files$found
"
  fi
done

# Nested suites.
if [ -d test/protocol ] || [ -d test/core ] || [ -d test/runtime ] || [ -d test/server ] || [ -d test/e2e ] || [ -d test/log ] || [ -d test/tools ] || [ -d test/triggers ] || [ -d test/peers ] || [ -d test/pulls ] || [ -d test/secrets ] || [ -d test/observation ]; then
  nested=$(find test/protocol test/core test/runtime test/server test/e2e test/log test/tools test/triggers test/peers test/pulls test/secrets test/observation \
    -mindepth 2 -name '*.test.ts' 2>/dev/null | sort || true)
  [ -n "$nested" ] && files="$files$nested
"
fi

if [ -z "$files" ]; then
  echo "no deterministic test files yet; write the first failing test" >&2
  exit 1
fi
printf '%s' "$files"
