#!/bin/sh
# Acceptance, with the CLI built first: the cases drive the daemon over the wire and the
# `cli-*` cases drive it through the shipped command (tests/eval/README.md).
#
#     ./scripts/eval-all.sh [--match cli-] [--case cli-chat] [--verbose] [--keep]
#
# The binary is run under the name `eagle-dev`, because that name is what makes it use
# the development credential and its own config file.
set -eu

cd "$(dirname "$0")/.."
root=$(cd ../.. && pwd)

if [ -d /Applications/Xcode.app/Contents/Developer ]; then
  export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
fi

(
  cd "$root/apps/macos" || exit 1
  swift build --product eagle-cli
)
bin=$(cd "$root/apps/macos" && swift build --show-bin-path)/eagle-cli
if [ ! -x "$bin" ]; then
  echo "eval-all: no CLI at $bin" >&2
  exit 1
fi

exec node --experimental-strip-types scripts/eval.ts --cli "$bin" "$@"
