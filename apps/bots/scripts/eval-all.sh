#!/bin/sh
# The CLI acceptance run: build the macOS CLI, then drive the `cli-*` eval cases
# through it against a real daemon (tests/eval/README.md, "CLI cases").
#
#     ./scripts/eval-cli.sh [--case cli-chat] [--verbose] [--keep]
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
  echo "eval-cli: no CLI at $bin" >&2
  exit 1
fi

exec node --experimental-strip-types scripts/eval.ts --match cli- --cli "$bin" "$@"
