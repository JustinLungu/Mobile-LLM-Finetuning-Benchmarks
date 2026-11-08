#!/usr/bin/env bash
# Build llama.cpp at the version pinned in eval/llama_cpp.env.
#
# Usage (from the repository root):
#     eval/build_llama_cpp.sh
#
# Produces up to two builds in third_party/llama.cpp/ (git-ignored):
#     build-cpu/bin/   always
#     build-cuda/bin/  only if the CUDA compiler (nvcc) is found
#
# Environment variables:
#     JOBS                  parallel compile jobs (default: all CPU threads)
#     CUDA_ARCHITECTURES    GPU architecture, e.g. 89 (default: detected with nvidia-smi)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/third_party/llama.cpp"
JOBS="${JOBS:-$(nproc)}"
TARGETS=(llama-server llama-bench llama-cli)

# --- 1. Get the source at the pinned version --------------------------------

"$REPO_ROOT/eval/fetch_llama_cpp.sh"

# --- 2. Build ----------------------------------------------------------------

build() {
    local name="$1"; shift
    echo
    echo "=== Building $name ==="
    cmake -S "$SRC" -B "$SRC/build-$name" \
        -DCMAKE_BUILD_TYPE=Release \
        -DLLAMA_BUILD_TESTS=OFF \
        -DLLAMA_BUILD_EXAMPLES=OFF \
        -DLLAMA_OPENSSL=OFF \
        -DLLAMA_USE_PREBUILT_UI=OFF \
        "$@"
    cmake --build "$SRC/build-$name" --config Release -j "$JOBS" --target "${TARGETS[@]}"
    echo "=== $name build ready: $SRC/build-$name/bin/ ==="
}

build cpu -DGGML_CUDA=OFF

# nvcc is often installed but not on PATH in non-interactive shells.
NVCC="$(command -v nvcc || true)"
if [[ -z "$NVCC" && -x /usr/local/cuda/bin/nvcc ]]; then
    NVCC=/usr/local/cuda/bin/nvcc
fi

if [[ -z "$NVCC" ]]; then
    echo
    echo "nvcc not found: skipping the CUDA build (CPU build only)."
    exit 0
fi

# Compute capability 8.9 (RTX 40 series) becomes architecture 89. Building
# only for the local GPU is much faster than building for every architecture.
if [[ -z "${CUDA_ARCHITECTURES:-}" ]]; then
    CUDA_ARCHITECTURES="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -1 | tr -d '.')"
fi

build cuda \
    -DGGML_CUDA=ON \
    -DCMAKE_CUDA_COMPILER="$NVCC" \
    -DCMAKE_CUDA_ARCHITECTURES="$CUDA_ARCHITECTURES"

# A CUDA build that silently fell back to CPU would still run, only slowly.
if ! "$SRC/build-cuda/bin/llama-server" --list-devices 2>&1 | grep -q CUDA; then
    echo "error: the CUDA build does not see a GPU. Check the build log and nvidia-smi." >&2
    exit 1
fi
echo "CUDA build sees the GPU."
