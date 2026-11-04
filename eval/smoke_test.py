"""Check that every downloaded model loads and answers, on every llama.cpp build.

Usage (from the repository root):
    uv run eval/smoke_test.py                  # all downloaded models, all builds
    uv run eval/smoke_test.py qwen3.5-2b       # one model
    uv run eval/smoke_test.py --build cuda     # one build

This is not a benchmark: it only answers "does it work at all?" before we
spend time measuring.
"""

import argparse
import sys

from llama_server import LlamaServer, ServerError, available_builds, gguf_path, load_registry

QUESTION = "What colour is the sky on a clear day? Answer in one word."
# Allows answers like "Blue." or "It's blue" but not a paragraph.
MAX_ANSWER_WORDS = 3


def check(key: str, build: str) -> tuple[bool, str]:
    """Load one model on one build and ask the question. Returns (passed, details)."""
    try:
        with LlamaServer(gguf_path(key), build=build) as server:
            response = server.chat([{"role": "user", "content": QUESTION}], max_tokens=16)
            load_time = server.load_time_s
    except ServerError as e:
        return False, str(e)

    message = response["choices"][0]["message"]
    answer = (message.get("content") or "").strip()
    if not answer:
        return False, "empty answer"
    # Thinking is switched off for benchmarks; it must not run hidden...
    if message.get("reasoning_content"):
        return False, f"model is still thinking: {message['reasoning_content'][:60]!r}"
    # ...or leak into the answer as plain text (Gemma does this if thinking is
    # cut off the wrong way). A one-word question should get a short answer.
    if "blue" not in answer.lower() or len(answer.split()) > MAX_ANSWER_WORDS:
        return False, f"unexpected answer: {answer!r}"
    return True, f"loaded in {load_time:.1f} s, answered {answer!r}"


def main(argv: list[str] | None = None) -> int:
    models = load_registry()
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("models", nargs="*", metavar="MODEL", help="model keys (default: all downloaded)")
    parser.add_argument("--build", choices=["cpu", "cuda"], help="only this llama.cpp build (default: all built)")
    args = parser.parse_args(argv)

    builds = [args.build] if args.build else available_builds()
    if not builds:
        print("error: llama.cpp is not built. Run eval/build_llama_cpp.sh first.", file=sys.stderr)
        return 1
    if args.build and args.build not in available_builds():
        print(f"error: the {args.build} build does not exist. Run eval/build_llama_cpp.sh.", file=sys.stderr)
        return 1

    unknown = [k for k in args.models if k not in models]
    if unknown:
        print(f"error: unknown model(s): {', '.join(unknown)}", file=sys.stderr)
        return 1
    keys = args.models or [k for k in models if gguf_path(k).exists()]
    if not keys:
        print("error: no models downloaded. Run models/download.py --all first.", file=sys.stderr)
        return 1

    failed = 0
    for key in keys:
        for build in builds:
            print(f"{key:12} {build:5} ", end="", flush=True)
            passed, details = check(key, build)
            print(("PASS  " if passed else "FAIL  ") + details)
            failed += not passed

    total = len(keys) * len(builds)
    print(f"\n{total - failed}/{total} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
