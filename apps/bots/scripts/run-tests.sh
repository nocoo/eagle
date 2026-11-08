#!/bin/sh
# Runs the deterministic file list. Fails loudly when the list is empty, so a gate
# can never pass because it found nothing to run.
set -eu
cd "$(dirname "$0")/.."

files=$(sh scripts/unit-files.sh)

if [ "${1:-}" = "--coverage" ]; then
  exec node --test \
    --test-concurrency=4 \
    --experimental-test-coverage \
    --test-coverage-include='src/**/*.ts' \
    --test-coverage-exclude='src/testing/**' \
    --test-coverage-exclude='src/**/*.test.ts' \
    --test-coverage-include-all \
    --test-coverage-lines=90 --test-coverage-functions=90 --test-coverage-branches=85 \
    $files
fi
exec node --test --test-concurrency=4 $files
