#!/usr/bin/env bash
# Download the prebuilt iOS library of llama.cpp, at the version pinned in
# eval/llama_cpp.env, into apps/ios/Frameworks/ (git-ignored).
#
# Usage (from anywhere):
#     apps/ios/fetch_framework.sh

set -euo pipefail

IOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../eval/llama_cpp.env
source "$IOS_DIR/../../eval/llama_cpp.env"

FRAMEWORKS_DIR="$IOS_DIR/Frameworks"
TARGET="$FRAMEWORKS_DIR/llama.xcframework"
VERSION_FILE="$FRAMEWORKS_DIR/version.txt"

if [[ -d "$TARGET" && "$(cat "$VERSION_FILE" 2>/dev/null)" == "$LLAMA_CPP_XCFRAMEWORK_SHA256" ]]; then
    echo "llama.xcframework ($LLAMA_CPP_TAG) is already in place."
    exit 0
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

ZIP_NAME="llama-$LLAMA_CPP_TAG-xcframework.zip"
echo "Downloading $ZIP_NAME..."
curl --fail --location --silent --show-error --output "$WORK_DIR/$ZIP_NAME" \
    "https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA_CPP_TAG/$ZIP_NAME"

# macOS has shasum; most Linux systems have sha256sum.
if command -v sha256sum > /dev/null; then
    actual="$(sha256sum "$WORK_DIR/$ZIP_NAME" | cut -d' ' -f1)"
else
    actual="$(shasum -a 256 "$WORK_DIR/$ZIP_NAME" | cut -d' ' -f1)"
fi
if [[ "$actual" != "$LLAMA_CPP_XCFRAMEWORK_SHA256" ]]; then
    echo "error: $ZIP_NAME has checksum $actual, expected $LLAMA_CPP_XCFRAMEWORK_SHA256" >&2
    exit 1
fi

unzip -q "$WORK_DIR/$ZIP_NAME" -d "$WORK_DIR"
mkdir -p "$FRAMEWORKS_DIR"
rm -rf "$TARGET"
mv "$WORK_DIR/build-apple/llama.xcframework" "$TARGET"
echo "$LLAMA_CPP_XCFRAMEWORK_SHA256" > "$VERSION_FILE"
echo "llama.xcframework ($LLAMA_CPP_TAG) is ready in $FRAMEWORKS_DIR."
