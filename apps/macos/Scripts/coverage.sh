#!/bin/sh
# Unit-test coverage for the logic layer.
#
# SwiftUI views are not covered here: they are exercised by the snapshot
# renderer and reviewed as images. The threshold applies to the view models and
# token helpers, which is where behaviour lives.
#
#     ./Scripts/coverage.sh [minimum-percent]
set -eu
cd "$(dirname "$0")/.."

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
MINIMUM="${1:-90}"

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

if ! grep -q 'WorkspaceViewModels.swift' "$REPORT"; then
  echo "coverage: no logic files matched; profile=$PROFILE"
  ls -d .build/out/Products/Debug/*.xctest 2>/dev/null || true
  exit 1
fi

awk -v minimum="$MINIMUM" '
  /WorkspaceViewModels\.swift|SettingsViewModel\.swift|SettingsModels\.swift|SidebarComposition\.swift|Theme\.swift|SidebarList\.swift|SkillScanner\.swift|SkillsSettingsViewModel\.swift|SkillsSelection\.swift/ {
    lines += $8
    missed += $9
    printf "  %-52s %6s lines, %s covered\n", $1, $8, $10
  }
  END {
    covered = lines - missed
    percent = (covered * 100) / lines
    printf "coverage: %d/%d lines = %.1f%% (minimum %.1f%%)\n", covered, lines, percent, minimum
    if (percent + 0 < minimum + 0) {
      print "coverage below threshold"
      exit 1
    }
  }
' "$REPORT"
