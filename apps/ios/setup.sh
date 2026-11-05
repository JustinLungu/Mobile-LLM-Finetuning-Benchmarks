#!/usr/bin/env bash
# Prepare the iOS app on a Mac: check the tools, download the llama.cpp library
# and generate the Xcode project. Safe to run again at any time.
#
# Usage (from anywhere):
#     apps/ios/setup.sh
#     apps/ios/setup.sh --no-open    # don't open Xcode at the end (used by CI)

set -euo pipefail

IOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPEN_XCODE=true
[[ "${1:-}" == "--no-open" ]] && OPEN_XCODE=false

fail() {
    echo "error: $1" >&2
    exit 1
}

# --- 1. Check the Mac ---------------------------------------------------------

[[ "$(uname -s)" == "Darwin" ]] || fail "this script needs a Mac, because iPhone apps can only be built with Xcode."

if ! xcodebuild -version > /dev/null 2>&1; then
    fail "Xcode not found. Install it from the App Store, open it once to finish setup, then run this again."
fi
echo "Found $(xcodebuild -version | head -1)."

if ! command -v xcodegen > /dev/null; then
    command -v brew > /dev/null || fail "XcodeGen and Homebrew are both missing. Install Homebrew from https://brew.sh, then run this again."
    echo "Installing XcodeGen with Homebrew..."
    brew install xcodegen
fi

# --- 2. Get the library and generate the project ------------------------------

"$IOS_DIR/fetch_framework.sh"

echo "Generating the Xcode project..."
(cd "$IOS_DIR" && xcodegen generate --quiet)

# --- 3. What to do next -------------------------------------------------------

echo
echo "Setup is done. Next steps are in apps/ios/README.md, under 'Run it on an iPhone'."
if [[ "$OPEN_XCODE" == true ]]; then
    open "$IOS_DIR/WiloBench.xcodeproj"
fi
