"""Summarise benchmark results files as one Markdown table.

Usage (from the repository root):
    uv run eval/summarize_results.py                     # everything under results/
    uv run eval/summarize_results.py /tmp/wilo-bench     # another folder
    uv run eval/summarize_results.py results/linux results/ios

When a model was run more than once on the same device and backend, only the
latest run is shown. All numbers are medians across the runs in a file, except
peak memory, which is the highest value seen.
"""

import argparse
import json
import statistics
import sys
from pathlib import Path

from jsonschema import Draft202012Validator
from validate_results import SCHEMA_PATH, find_problems

DEFAULT_RESULTS_DIR = Path(__file__).resolve().parent.parent / "results"
# Phase 1's only pass/fail criterion: 20 runs back to back, without a crash.
RELIABILITY_RUNS = 20
COLUMNS = [
    "Model", "Device", "Backend", "Runs reliably", "Load", "First token", "Reply speed",
    "Peak memory", "GPU memory", "File size",
]


def load_results(folders: list[Path]) -> list[dict]:
    """Read every valid results file in the folders. Invalid ones are reported and skipped."""
    validator = Draft202012Validator(json.loads(SCHEMA_PATH.read_text()))
    results = []
    for folder in folders:
        for path in sorted(folder.rglob("*.json")):
            try:
                data = json.loads(path.read_text())
                problems = find_problems(data, validator)
            except json.JSONDecodeError as e:
                problems = [f"not valid JSON: {e}"]
            if problems:
                print(f"warning: skipping {path}: {problems[0]}", file=sys.stderr)
                continue
            results.append(data)
    return results


def latest_runs(results: list[dict]) -> list[dict]:
    """Keep the newest file for each model, device and backend, smallest models first."""
    latest = {}
    for data in sorted(results, key=lambda d: d["timestamp"]):
        key = (data["model"]["key"], data["model"]["finetuned"], data["device"]["name"], data["engine"]["backend"])
        latest[key] = data
    return sorted(
        latest.values(),
        key=lambda d: (d["model"]["size_bytes"], d["model"]["finetuned"], d["device"]["name"], d["engine"]["backend"]),
    )


def reliability_text(data: dict) -> str:
    completed = data["reliability"]["runs_completed"]
    requested = data["reliability"]["runs_requested"]
    if data["reliability"]["error"] or completed < requested:
        return f"no ({completed}/{requested})"
    # A short test run can't pass a 20-run criterion, however well it went.
    if requested < RELIABILITY_RUNS:
        return f"too few runs ({completed}/{requested})"
    return f"yes ({completed}/{requested})"


def median_text(values: list[float], fmt: str) -> str:
    return fmt.format(statistics.median(values)) if values else "–"


def gigabytes_text(size_bytes: int | None) -> str:
    return f"{size_bytes / 1e9:.2f} GB" if size_bytes is not None else "–"


def table_row(data: dict) -> list[str]:
    runs = data["runs"]
    name = data["model"]["key"] + (" (fine-tuned)" if data["model"]["finetuned"] else "")
    return [
        name,
        data["device"]["name"],
        data["engine"]["backend"],
        reliability_text(data),
        median_text(data["load_times_s"], "{:.1f} s"),
        median_text([r["time_to_first_token_ms"] for r in runs], "{:.0f} ms"),
        median_text([r["reply_tokens_per_s"] for r in runs], "{:.1f} tokens/s"),
        gigabytes_text(data["peak_memory"]["bytes"]),
        gigabytes_text(data["peak_memory"].get("gpu_bytes")),
        gigabytes_text(data["model"]["size_bytes"]),
    ]


def markdown_table(rows: list[list[str]]) -> str:
    lines = ["| " + " | ".join(COLUMNS) + " |", "|" + "---|" * len(COLUMNS)]
    lines += ["| " + " | ".join(row) + " |" for row in rows]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "folders", nargs="*", type=Path, default=[DEFAULT_RESULTS_DIR],
        help="folders with results files (default: results/)",
    )
    args = parser.parse_args(argv)

    missing = [str(f) for f in args.folders if not f.is_dir()]
    if missing:
        print(f"error: folder not found: {', '.join(missing)}", file=sys.stderr)
        return 1

    results = load_results(args.folders)
    if not results:
        print("No results files found. Run eval/benchmark.py first.", file=sys.stderr)
        return 1

    print(markdown_table([table_row(data) for data in latest_runs(results)]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
