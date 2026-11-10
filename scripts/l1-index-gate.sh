#!/bin/sh
# L1 quality gate for the Git index snapshot: UT with coverage, strict types, lint.
# Run only inside a checkout-index export with linked node_modules.
set -eu

if [ ! -d node_modules ]; then
  echo "l1-index-gate: node_modules is required" >&2
  exit 1
fi

npm run test:coverage
npm run typecheck
npm run lint
sh scripts/check-test-focus.sh
