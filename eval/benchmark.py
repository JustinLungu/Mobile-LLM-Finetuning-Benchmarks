"""Benchmark models with llama.cpp and write one results file per model and build.

Usage (from the repository root):
    uv run eval/benchmark.py qwen3.5-2b --build cuda
    uv run eval/benchmark.py --all
    uv run eval/benchmark.py --all --output-dir /tmp/try-it

Results follow spec/results.schema.json and go to results/linux/ by default.
"""

import argparse
import json
import platform
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from jsonschema import Draft202012Validator
from llama_server import (
    DEFAULT_CTX_SIZE,
    REPO_ROOT,
    LlamaServer,
    ServerError,
    available_builds,
    gguf_path,
    load_registry,
)
from validate_results import SCHEMA_PATH, find_problems

PROMPTS_PATH = REPO_ROOT / "spec" / "bench_prompts.json"
LLAMA_CPP_ENV_PATH = REPO_ROOT / "eval" / "llama_cpp.env"
DEFAULT_OUTPUT_DIR = REPO_ROOT / "results" / "linux"
SEED = 0


class BenchmarkServer(LlamaServer):
    """A LlamaServer that can also time replies the way a user experiences them."""

    def chat_timed(self, messages: list[dict], max_tokens: int = 64, timeout_s: float = 300) -> dict:
        """Send one chat request, streaming the reply, and time it as a user would experience it.

        Returns the reply text, finish reason, the server's own timings, and
        time_to_first_token_ms and total_ms measured from here.
        """
        request = self._request(messages, max_tokens, stream=True)
        text = ""
        first_token_ms = None
        finish_reason = None
        timings = None
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(request, timeout=timeout_s) as r:
                # The reply arrives as lines of "data: {json}", ending in "data: [DONE]".
                for raw_line in r:
                    line = raw_line.decode().strip()
                    if not line.startswith("data: ") or line == "data: [DONE]":
                        continue
                    chunk = json.loads(line.removeprefix("data: "))
                    choice = chunk["choices"][0] if chunk.get("choices") else {}
                    # The first chunk announces the reply but has no text yet.
                    content = choice.get("delta", {}).get("content")
                    if content:
                        if first_token_ms is None:
                            first_token_ms = (time.perf_counter() - started) * 1000
                        text += content
                    finish_reason = choice.get("finish_reason") or finish_reason
                    timings = chunk.get("timings") or timings
        except (urllib.error.URLError, TimeoutError) as e:
            raise ServerError(f"chat request failed: {e}. See {self.log_path}") from e
        total_ms = (time.perf_counter() - started) * 1000

        if first_token_ms is None:
            raise ServerError(f"the model produced no text. See {self.log_path}")
        if timings is None:
            raise ServerError(f"the server reported no timings. See {self.log_path}")
        return {
            "text": text,
            "finish_reason": finish_reason,
            "timings": timings,
            "time_to_first_token_ms": first_token_ms,
            "total_ms": total_ms,
        }


def read_text(path: str) -> str | None:
    """Contents of a system file, or None if this machine doesn't have it."""
    try:
        return Path(path).read_text().strip()
    except OSError:
        return None


def device_info(build: str) -> dict:
    # The laptop model, not the hostname: results are committed to a public repo.
    name = read_text("/sys/class/dmi/id/product_name") or platform.machine()

    cpuinfo = read_text("/proc/cpuinfo") or ""
    cpu = next((line.split(":", 1)[1].strip() for line in cpuinfo.splitlines() if line.startswith("model name")), "")
    chip = cpu or platform.processor()
    if build == "cuda":
        gpu = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], capture_output=True, text=True
        ).stdout.strip()
        chip = f"{chip} + {gpu}"

    meminfo = read_text("/proc/meminfo") or ""
    total_kb = next((int(line.split()[1]) for line in meminfo.splitlines() if line.startswith("MemTotal")), 0)

    return {
        "name": name,
        "platform": "linux",
        "os": platform.freedesktop_os_release().get("PRETTY_NAME", platform.platform()),
        "chip": chip,
        "ram_gb": round(total_kb / 1024**2, 1),
    }


def engine_info(server: LlamaServer) -> dict:
    pinned = dict(
        line.split("=", 1)
        for line in LLAMA_CPP_ENV_PATH.read_text().splitlines()
        if "=" in line and not line.startswith("#")
    )
    return {
        "llama_cpp_tag": pinned["LLAMA_CPP_TAG"],
        "llama_cpp_commit": pinned["LLAMA_CPP_COMMIT"],
        "backend": server.build,
        "gpu_layers": "all" if server.build == "cuda" else "0",
        "threads": server.threads,
    }


def model_info(key: str) -> dict:
    gguf = load_registry()[key]["gguf"]
    return {
        "key": key,
        "file": gguf["file"],
        "quant": gguf["quant"],
        "size_bytes": gguf["size_bytes"],
        "sha256": gguf["sha256"],
        "finetuned": False,
    }


def machine_notes() -> str | None:
    """Conditions that change laptop speed a lot, and are easy to forget later."""
    profile = read_text("/sys/firmware/acpi/platform_profile")
    return f"Power profile: {profile}." if profile else None


def measure(server: BenchmarkServer, spec: dict, prompt: dict, repeat: int) -> dict:
    """Run one prompt and return its entry for the results file."""
    reply = server.chat_timed(
        [{"role": "system", "content": spec["system"]}, {"role": "user", "content": prompt["user"]}],
        max_tokens=spec["max_tokens"],
    )
    timings = reply["timings"]
    return {
        "prompt_id": prompt["id"],
        "repeat": repeat,
        "prompt_tokens": timings["prompt_n"],
        "reply_tokens": timings["predicted_n"],
        "finish_reason": reply["finish_reason"],
        "time_to_first_token_ms": reply["time_to_first_token_ms"],
        "prompt_tokens_per_s": timings["prompt_per_second"],
        "reply_tokens_per_s": timings["predicted_per_second"],
        "total_ms": reply["total_ms"],
    }


def benchmark(key: str, build: str) -> dict:
    """Benchmark one model on one build. A failure is recorded in the results, not raised."""
    spec = json.loads(PROMPTS_PATH.read_text())
    server = BenchmarkServer(gguf_path(key), build=build)
    results = {
        "schema_version": 1,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "device": device_info(build),
        "engine": engine_info(server),
        "model": model_info(key),
        "settings": {
            "ctx_size": DEFAULT_CTX_SIZE,
            "max_tokens": spec["max_tokens"],
            "temperature": 0,
            "seed": SEED,
            "thinking": False,
            "prompts_version": spec["version"],
            "repeats": 1,
        },
        "reliability": {"runs_requested": len(spec["prompts"]), "runs_completed": 0, "error": None},
        "load_times_s": [],
        "peak_memory": {"bytes": None, "method": None},
        "runs": [],
    }
    notes = machine_notes()
    if notes:
        results["notes"] = notes

    try:
        with server:
            results["load_times_s"].append(server.load_time_s)
            for prompt in spec["prompts"]:
                results["runs"].append(measure(server, spec, prompt, repeat=0))
                results["reliability"]["runs_completed"] += 1
    except ServerError as e:
        results["reliability"]["error"] = str(e)
    return results


def write_results(results: dict, output_dir: Path) -> Path:
    """Save the results as <model>-<backend>-<time>.json. Invalid results are a bug, so stop."""
    problems = find_problems(results, Draft202012Validator(json.loads(SCHEMA_PATH.read_text())))
    if problems:
        raise ValueError("results do not follow the format:\n  " + "\n  ".join(problems))

    output_dir.mkdir(parents=True, exist_ok=True)
    stamp = results["timestamp"].replace("-", "").replace(":", "")
    path = output_dir / f"{results['model']['key']}-{results['engine']['backend']}-{stamp}.json"
    path.write_text(json.dumps(results, indent=2) + "\n")
    return path


def main(argv: list[str] | None = None) -> int:
    models = load_registry()
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("models", nargs="*", metavar="MODEL", help="model keys to benchmark")
    parser.add_argument("--all", action="store_true", help="every downloaded model")
    parser.add_argument("--build", choices=["cpu", "cuda"], help="only this llama.cpp build (default: all built)")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR, help="where to write results")
    args = parser.parse_args(argv)

    keys = [k for k in models if gguf_path(k).exists()] if args.all else args.models
    if not keys:
        parser.print_help()
        return 0
    unknown = [k for k in keys if k not in models]
    if unknown:
        print(f"error: unknown model(s): {', '.join(unknown)}", file=sys.stderr)
        return 1

    builds = [args.build] if args.build else available_builds()
    if not builds or (args.build and args.build not in available_builds()):
        print("error: that llama.cpp build does not exist. Run eval/build_llama_cpp.sh.", file=sys.stderr)
        return 1

    failed = 0
    for key in keys:
        for build in builds:
            print(f"{key:12} {build:5} ", end="", flush=True)
            results = benchmark(key, build)
            path = write_results(results, args.output_dir)
            error = results["reliability"]["error"]
            if error:
                failed += 1
                print(f"FAILED: {error}")
                continue
            runs = results["runs"]
            speed = sum(r["reply_tokens_per_s"] for r in runs) / len(runs)
            print(f"load {results['load_times_s'][0]:5.1f} s   reply {speed:6.1f} tokens/s   {path.name}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
