#!/bin/sh
# Logic coverage for the Superagent client package. Views live in the Eagle app; the
# service's connect/reconnect lifecycle also has real-process tests above this gate.
#
#     ./Scripts/coverage.sh [minimum-percent]
set -eu
cd "$(dirname "$0")/.."

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
MINIMUM="${1:-95}"

swift test --enable-code-coverage

PROFILE="$(find .build -name default.profdata -print -quit)"
[ -n "$PROFILE" ] || { echo "coverage: no profile data found"; exit 1; }

REPORT=".build/coverage.txt"
: > "$REPORT"
for bundle in $(find .build -name '*.xctest' -type d); do
  name="$(basename "$bundle" .xctest)"
  binary="$bundle/Contents/MacOS/$name"
  [ -x "$binary" ] || continue
  xcrun llvm-cov report "$binary" -instr-profile "$PROFILE" >> "$REPORT"
done

awk -v minimum="$MINIMUM" '
  /Domain\.swift|Ports\.swift|IdentityProof\.swift|Endpoint\.swift|Client\.swift|ChatViewModel\.swift/ {
    regions = $4 + 0; functions = $7 + 0; lines = $10 + 0; branches = $13 + 0
    # A file appears once per test bundle; keep its best covered percentages.
    if (!(($1) in bestRegion) || regions > bestRegion[$1]) {
      bestRegion[$1] = regions; bestFunction[$1] = functions
      bestLine[$1] = lines; bestBranch[$1] = branches
    }
  }
  END {
    for (file in bestRegion) {
      printf "  %-48s regions %5.1f  functions %5.1f  lines %5.1f  branches %5.1f\n",
        file, bestRegion[file], bestFunction[file], bestLine[file], bestBranch[file]
      if (bestRegion[file] + 0 < minimum + 0 || bestFunction[file] + 0 < minimum + 0 ||
          bestLine[file] + 0 < minimum + 0 || bestBranch[file] + 0 < minimum + 0) failed = 1
    }
    if (failed) { printf "coverage below %s%%\n", minimum; exit 1 }
    printf "coverage: every metric at or above %s%%\n", minimum
  }
' "$REPORT"
