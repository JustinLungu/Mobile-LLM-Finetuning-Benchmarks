"""Run the benchmark prompts on one model and print the full replies, for debugging.

Usage (from the repository root):
    uv run eval/try_prompts.py qwen3.5-2b
    uv run eval/try_prompts.py qwen3.5-2b --build cpu
    uv run eval/try_prompts.py gemma4-e2b --prompt manipulation
    uv run eval/try_prompts.py llama3.2-3b --user "I just need two more minutes to finish my reply."

Timings here are only a rough indication: use the benchmarks for real numbers.
"""

import argparse
import json
import sys

from llama_server import REPO_ROOT, LlamaServer, ServerError, available_builds, gguf_path, load_registry

PROMPTS_PATH = REPO_ROOT / "spec" / "bench_prompts.json"


def main(argv: list[str] | None = None) -> int:
    spec = json.loads(PROMPTS_PATH.read_text())
    prompt_ids = [p["id"] for p in spec["prompts"]]

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("model", choices=list(load_registry()), help="model key")
    parser.add_argument("--build", choices=["cpu", "cuda"], help="llama.cpp build (default: cuda if built, else cpu)")
    parser.add_argument("--prompt", choices=prompt_ids, help="only this prompt (default: all)")
    parser.add_argument("--user", help="your own user message, instead of the prompts in the file")
    parser.add_argument("--no-system", action="store_true", help="leave out the system text and memory note")
    args = parser.parse_args(argv)

    builds = available_builds()
    if not builds:
        print("error: llama.cpp is not built. Run eval/build_llama_cpp.sh first.", file=sys.stderr)
        return 1
    build = args.build or ("cuda" if "cuda" in builds else builds[0])

    if args.user:
        prompts = [{"id": "custom", "user": args.user}]
    else:
        prompts = [p for p in spec["prompts"] if not args.prompt or p["id"] == args.prompt]

    try:
        with LlamaServer(gguf_path(args.model), build=build) as server:
            print(f"{args.model} on {build}, loaded in {server.load_time_s:.1f} s")
            print(f"Server log: {server.log_path}\n")
            for prompt in prompts:
                messages = [{"role": "user", "content": prompt["user"]}]
                if not args.no_system:
                    messages.insert(0, {"role": "system", "content": spec["system"]})
                response = server.chat(messages, max_tokens=spec["max_tokens"])

                choice = response["choices"][0]
                usage = response["usage"]
                timings = response.get("timings", {})
                print(f"--- {prompt['id']} ---")
                print(f"User: {prompt['user']}\n")
                print(f"Reply:\n{choice['message'].get('content')}\n")
                print(
                    f"prompt: {usage['prompt_tokens']} tokens, reply: {usage['completion_tokens']} tokens, "
                    f"finish: {choice['finish_reason']}, "
                    f"speed: {timings.get('predicted_per_second', 0):.1f} tokens/s\n"
                )
    except ServerError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
