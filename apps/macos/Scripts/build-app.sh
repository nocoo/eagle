#!/bin/sh
# Assemble an isolated device candidate. Never installs or launches the App.
#
#     ./Scripts/build-app.sh [debug|release]
#
# Build inputs (never runtime settings):
# EAGLE_NODE_BINARY        verified, host-compatible Node 24+ executable
# EAGLE_AGENT_NPM_CACHE    private cache verified against the root lock
# EAGLE_BOTS_NPM_CACHE     private cache verified against the Bots lock
# EAGLE_DEVICE_PROFILE     device-candidate (default) or device-release
# EAGLE_DEVICE_SERVICE_URL optional HTTPS origin baked into the bundle; a release normally
#                         ships none, and the person configures the address in Settings
# EAGLE_UPDATES_URL       where the App asks which macOS version is published; unset
#                         means "this build never asks"
# EAGLE_CODESIGN_IDENTITY  '-' for local candidate, real identity for release
# EAGLE_ADHOC_RELEASE=1    publish a device-release bundle signed ad-hoc (un-notarized;
#                          the downloader must remove the quarantine flag by hand)
set -eu
cd "$(dirname "$0")/.."

# Use the same Xcode toolchain as macOS checks when it is available.
if [ -d /Applications/Xcode.app/Contents/Developer ]; then
  export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
fi

CONFIG="${1:-debug}"
case "$CONFIG" in debug|release) ;; *) echo "Expected debug or release" >&2; exit 1 ;; esac
PROFILE="${EAGLE_DEVICE_PROFILE:-device-candidate}"
case "$PROFILE" in
  device-candidate) APP_NAME="Eagle Device Candidate.app" ;;
  device-release) APP_NAME="Eagle for Mac.app" ;;
  *) echo "Expected device-candidate or device-release profile" >&2; exit 1 ;;
esac
NODE_BINARY="${EAGLE_NODE_BINARY:-$(command -v node)}"
AGENT_CACHE="${EAGLE_AGENT_NPM_CACHE:-${npm_config_cache:-}}"
BOTS_CACHE="${EAGLE_BOTS_NPM_CACHE:-$AGENT_CACHE}"
IDENTITY="${EAGLE_CODESIGN_IDENTITY:--}"
if [ -z "$AGENT_CACHE" ] || [ -z "$BOTS_CACHE" ]; then
  echo "Set EAGLE_AGENT_NPM_CACHE and EAGLE_BOTS_NPM_CACHE to verified private build caches" >&2
  exit 1
fi
if [ "$PROFILE" = device-release ]; then
  if [ "$IDENTITY" = - ] && [ "${EAGLE_ADHOC_RELEASE:-}" != 1 ]; then
    echo "Release needs an explicit signing identity, or EAGLE_ADHOC_RELEASE=1 for an un-notarized package" >&2
    exit 1
  fi
fi
swift build -c "$CONFIG"
BINARY_DIRECTORY="$(swift build -c "$CONFIG" --show-bin-path)"
BINARY="$BINARY_DIRECTORY/Eagle"
HELPER="$BINARY_DIRECTORY/EagleDeviceHelper"
if [ ! -x "$HELPER" ]; then
  echo "Build requires the EagleDeviceHelper SPM executable target" >&2
  exit 1
fi
CLI="$BINARY_DIRECTORY/eagle-cli"
if [ ! -x "$CLI" ]; then
  echo "Build requires the eagle-cli SPM executable target" >&2
  exit 1
fi
OUTPUT_DIRECTORY=".build/$PROFILE"
APP="$OUTPUT_DIRECTORY/$APP_NAME"
mkdir -p "$OUTPUT_DIRECTORY"
STAGING="$(mktemp -d "$OUTPUT_DIRECTORY/.stage.XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT HUP INT TERM
STAGED_APP="$STAGING/$APP_NAME"

if [ ! -f Sources/EagleDesign/Resources/AppIcon.icns ]; then
  swift Scripts/make-icon.swift
fi
"$NODE_BINARY" Scripts/assemble-device-app.ts --app "$STAGED_APP" \
  --binary "$BINARY" --helper "$HELPER" --cli "$CLI" --profile "$PROFILE" \
  --service-url "${EAGLE_DEVICE_SERVICE_URL:-}" \
  --github-url "${EAGLE_GITHUB_URL:-$(node -p "require('../../package.json').config.repositoryUrl" 2>/dev/null || true)}" \
  --release-url "${EAGLE_RELEASE_URL:-$(node -p "require('../../package.json').config.macosReleaseUrl" 2>/dev/null || true)}" \
  --updates-url "${EAGLE_UPDATES_URL:-}" >/dev/null
"$NODE_BINARY" Scripts/assemble-device-runtime.ts \
  --destination "$STAGED_APP/Contents/Resources/DeviceRuntime" \
  --node "$NODE_BINARY" --agent-cache "$AGENT_CACHE" --bots-cache "$BOTS_CACHE" >/dev/null
if [ "$IDENTITY" = - ]; then
  if [ "$PROFILE" = device-release ]; then
    echo "Signing: ad-hoc release (un-notarized; downloaders remove quarantine by hand)" >&2
    ADHOC="--allow-adhoc"
  else
    echo "Signing: ad-hoc candidate (local verification only)" >&2
    ADHOC=""
  fi
else
  echo "Signing: configured identity" >&2
  ADHOC=""
fi
"$NODE_BINARY" Scripts/assemble-device-app.ts --mode sign --app "$STAGED_APP" \
  --identity "$IDENTITY" $ADHOC >/dev/null

rm -rf "$APP"
mv "$STAGED_APP" "$APP"
echo "$APP"
