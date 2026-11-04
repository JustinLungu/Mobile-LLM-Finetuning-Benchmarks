"""Check that results files follow spec/results.schema.json.

Usage (from the repository root):
    uv run eval/validate_results.py spec/results.example.json
    uv run eval/validate_results.py results/*.json
"""

import argparse
import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "spec" / "results.schema.json"


def find_problems(data: object, validator: Draft202012Validator) -> list[str]:
    """Every way the data breaks the format, including checks a schema can't express."""
    problems = []
    for error in sorted(validator.iter_errors(data), key=lambda e: list(map(str, e.path))):
        where = ".".join(str(part) for part in error.path) or "(top level)"
        problems.append(f"{where}: {error.message}")
    if problems:
        return problems

    reliability = data["reliability"]
    if reliability["runs_completed"] > reliability["runs_requested"]:
        problems.append("reliability: more runs completed than requested")
    if reliability["runs_completed"] < reliability["runs_requested"] and reliability["error"] is None:
        problems.append("reliability: runs are missing but no error is recorded")
    if reliability["runs_completed"] != len(data["runs"]):
        problems.append("reliability: runs_completed does not match the number of entries in runs")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("files", nargs="+", type=Path, help="results files to check")
    args = parser.parse_args(argv)

    validator = Draft202012Validator(json.loads(SCHEMA_PATH.read_text()))
    failed = 0
    for path in args.files:
        try:
            problems = find_problems(json.loads(path.read_text()), validator)
        except FileNotFoundError:
            problems = ["file not found"]
        except json.JSONDecodeError as e:
            problems = [f"not valid JSON: {e}"]

        print(f"{path}: {'ok' if not problems else 'INVALID'}")
        for problem in problems:
            print(f"  {problem}")
        failed += bool(problems)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
