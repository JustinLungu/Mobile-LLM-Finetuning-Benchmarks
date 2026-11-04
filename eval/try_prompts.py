"""Run the benchmark prompts on one model and print the full replies, for debugging.

Usage (from the repository root):
    uv run eval/try_prompts.py qwen3.5-2b
    uv run eval/try_prompts.py qwen3.5-2b --build cpu
    uv run eval/try_prompts.py gemma4-e2b --prompt manipulation
    uv run eval/try_prompts.py llama3.2-3b --user "I just need two more minutes to finish my reply."
    uv run eval/try_prompts.py gemma4-e2b --prompt manipulation --thinking
    uv run eval/try_prompts.py qwen3.5-2b --temperature 0.7

Timings here are only a rough indication: use the benchmarks for real numbers.
"""

import argparse
import json
import sys

from llama_server import REPO_ROOT, LlamaServer, ServerError, available_builds, gguf_path, load_registry

PROMPTS_PATH = REPO_ROOT / "spec" / "bench_prompts.json"
# Reasoning counts towards the reply limit, and usually takes far more tokens than the answer.
THINKING_MAX_TOKENS = 1024


def main(argv: list[str] | None = None) -> int:
    spec = json.loads(PROMPTS_PATH.read_text())
    prompt_ids = [p["id"] for p in spec["prompts"]]

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("model", choices=list(load_registry()), help="model key")
    parser.add_argument("--build", choices=["cpu", "cuda"], help="llama.cpp build (default: cuda if built, else cpu)")
    parser.add_argument("--prompt", choices=prompt_ids, help="only this prompt (default: all)")
    parser.add_argument("--user", help="your own user message, instead of the prompts in the file")
    parser.add_argument("--no-system", action="store_true", help="leave out the system text and memory note")
    parser.add_argument("--thinking", action="store_true", help="let the model think first and show its reasoning")
    parser.add_argument("--temperature", type=float, default=0, help="0 is repeatable, higher varies more (default: 0)")
    parser.add_argument(
        "--max-tokens", type=int,
        help=f"reply limit (default: {spec['max_tokens']}, or {THINKING_MAX_TOKENS} with --thinking)",
    )
    args = parser.parse_args(argv)

    builds = available_builds()
    if not builds:
        print("error: llama.cpp is not built. Run eval/build_llama_cpp.sh first.", file=sys.stderr)
        return 1
    build = args.build or ("cuda" if "cuda" in builds else builds[0])
    max_tokens = args.max_tokens or (THINKING_MAX_TOKENS if args.thinking else spec["max_tokens"])

    if args.user:
        prompts = [{"id": "custom", "user": args.user}]
    else:
        prompts = [p for p in spec["prompts"] if not args.prompt or p["id"] == args.prompt]

    try:
        with LlamaServer(gguf_path(args.model), build=build, thinking=args.thinking) as server:
            print(f"{args.model} on {build}, loaded in {server.load_time_s:.1f} s")
            print(f"Server log: {server.log_path}\n")
            for prompt in prompts:
                messages = [{"role": "user", "content": prompt["user"]}]
                if not args.no_system:
                    messages.insert(0, {"role": "system", "content": spec["system"]})
                response = server.chat(messages, max_tokens=max_tokens, temperature=args.temperature)

                choice = response["choices"][0]
                usage = response["usage"]
                timings = response.get("timings", {})
                print(f"--- {prompt['id']} ---")
                print(f"User: {prompt['user']}\n")
                if choice["message"].get("reasoning_content"):
                    print(f"Reasoning:\n{choice['message']['reasoning_content']}\n")
                print(f"Reply:\n{choice['message'].get('content')}\n")
                print(
                    f"prompt: {usage['prompt_tokens']} tokens, reply: {usage['completion_tokens']} tokens, "
                    f"finish: {choice['finish_reason']}, "
                    f"speed: {timings.get('predicted_per_second', 0):.1f} tokens/s\n"
                )
                if choice["finish_reason"] == "length":
                    print(f"Note: cut off at the {max_tokens}-token limit. Try a higher --max-tokens.\n")
    except ServerError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
