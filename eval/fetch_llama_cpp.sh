#!/usr/bin/env bash
# Get the llama.cpp source code at the version pinned in eval/llama_cpp.env,
# into third_party/llama.cpp/ (git-ignored). Used by build_llama_cpp.sh and by
# the Android app, which compiles llama.cpp itself.
#
# Usage (from anywhere):
#     eval/fetch_llama_cpp.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=llama_cpp.env
source "$REPO_ROOT/eval/llama_cpp.env"

SRC="$REPO_ROOT/third_party/llama.cpp"

if [[ ! -d "$SRC/.git" ]]; then
    echo "Cloning llama.cpp $LLAMA_CPP_TAG..."
    git clone --quiet --depth 1 --branch "$LLAMA_CPP_TAG" \
        https://github.com/ggml-org/llama.cpp "$SRC"
elif [[ "$(git -C "$SRC" rev-parse HEAD)" != "$LLAMA_CPP_COMMIT" ]]; then
    echo "Switching llama.cpp to $LLAMA_CPP_TAG..."
    git -C "$SRC" fetch --quiet --depth 1 origin tag "$LLAMA_CPP_TAG"
    git -C "$SRC" -c advice.detachedHead=false checkout --quiet "$LLAMA_CPP_TAG"
fi

# A tag can in principle be moved; the commit hash cannot.
actual="$(git -C "$SRC" rev-parse HEAD)"
if [[ "$actual" != "$LLAMA_CPP_COMMIT" ]]; then
    echo "error: $LLAMA_CPP_TAG points to $actual, expected $LLAMA_CPP_COMMIT" >&2
    exit 1
fi
echo "llama.cpp $LLAMA_CPP_TAG ($LLAMA_CPP_COMMIT)"
