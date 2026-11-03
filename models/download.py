"""Download the models listed in models/registry.yaml.

Usage:
    uv run models/download.py --list
    uv run models/download.py qwen3.5-2b
    uv run models/download.py --all
    uv run models/download.py qwen3.5-2b --force   # re-download, e.g. after a failed check
    uv run models/download.py qwen3.5-2b --original --dry-run   # show what fine-tuning needs

GGUF files (for llama.cpp and phones) are saved to models/<key>/. Original
weights (for fine-tuning) are saved to models/<key>/original/ with --original.
Both are git-ignored and checked against SHA256 checksums after download.
"""

import argparse
import fnmatch
import hashlib
import re
import sys
from pathlib import Path

import yaml
from huggingface_hub import HfApi, get_token, hf_hub_download, snapshot_download
from huggingface_hub.errors import (
    EntryNotFoundError,
    GatedRepoError,
    HfHubHTTPError,
    LocalEntryNotFoundError,
    RepositoryNotFoundError,
    RevisionNotFoundError,
)

MODELS_DIR = Path(__file__).parent
REGISTRY_PATH = MODELS_DIR / "registry.yaml"

# Fields every registry entry must have, so later code can rely on them.
REQUIRED_FIELDS = {
    "": ["display_name", "original", "gguf", "context_length", "supports_thinking"],
    "original": ["repo", "revision", "params", "license", "gated"],
    "gguf": ["repo", "revision", "file", "quant", "size_bytes", "sha256"],
}

COMMIT_HASH = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")

# Files in the original repos that fine-tuning does not need. Meta's Llama
# repos keep a second full copy of the weights in their own format in a
# folder called original/ (6.4 GB for Llama 3.2 3B); we use the .safetensors
# copy instead.
ORIGINAL_SKIP_PATTERNS = ["original/*", "*.pth"]

# Read files in 8 MB pieces when hashing, so a multi-gigabyte model never has
# to fit in memory at once.
HASH_CHUNK_BYTES = 8 * 1024 * 1024


class RegistryError(Exception):
    """The registry file is missing, malformed or incomplete."""


def load_registry(path: Path = REGISTRY_PATH) -> dict[str, dict]:
    """Read the registry and check every entry before anything else uses it."""
    try:
        data = yaml.safe_load(path.read_text())
    except FileNotFoundError:
        raise RegistryError(f"registry not found: {path}")
    except yaml.YAMLError as e:
        raise RegistryError(f"{path} is not valid YAML:\n{e}")

    models = (data or {}).get("models")
    if not models:
        raise RegistryError(f"{path} has no 'models' section")

    for key, entry in models.items():
        validate_entry(key, entry)
    return models


def validate_entry(key: str, entry: dict) -> None:
    for section, fields in REQUIRED_FIELDS.items():
        block = entry.get(section) if section else entry
        where = f"{key}.{section}" if section else key
        if not isinstance(block, dict):
            raise RegistryError(f"{where}: missing or not a mapping")
        missing = [f for f in fields if f not in block]
        if missing:
            raise RegistryError(f"{where}: missing {', '.join(missing)}")

    for section in ("original", "gguf"):
        if not COMMIT_HASH.match(str(entry[section]["revision"])):
            raise RegistryError(f"{key}.{section}.revision: not a 40-character commit hash")
    if not SHA256.match(str(entry["gguf"]["sha256"])):
        raise RegistryError(f"{key}.gguf.sha256: not a 64-character SHA256 hash")


def print_models(models: dict[str, dict]) -> None:
    rows = [("KEY", "MODEL", "GGUF SIZE", "QUANT", "LICENSE", "GATED")]
    for key, m in models.items():
        rows.append((
            key,
            m["display_name"],
            f"{m['gguf']['size_bytes'] / 1e9:.2f} GB",
            m["gguf"]["quant"],
            m["original"]["license"],
            "yes" if m["original"]["gated"] else "no",
        ))
    widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]))]
    for row in rows:
        print("  ".join(cell.ljust(w) for cell, w in zip(row, widths)).rstrip())

    total = sum(m["gguf"]["size_bytes"] for m in models.values())
    print(f"\nTotal GGUF download: {total / 1e9:.2f} GB")


class ChecksumError(Exception):
    """A downloaded file does not match the checksum in the registry."""


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(HASH_CHUNK_BYTES):
            digest.update(chunk)
    return digest.hexdigest()


def verify(path: Path, expected_sha256: str) -> None:
    actual = sha256_of(path)
    if actual != expected_sha256:
        raise ChecksumError(
            f"{path.name} does not match its expected checksum\n"
            f"  expected {expected_sha256}\n"
            f"  got      {actual}\n"
            f"  The file is incomplete or modified. Re-download it with --force."
        )


class DownloadError(Exception):
    """A file could not be downloaded from Hugging Face."""


def explain_hub_error(e: Exception, repo: str, revision: str, filename: str) -> str:
    """Turn a huggingface_hub exception into a message that says what to do.

    Order matters: GatedRepoError is a subclass of RepositoryNotFoundError, and
    LocalEntryNotFoundError of EntryNotFoundError, so the specific cases must
    be checked first.
    """
    url = f"https://huggingface.co/{repo}"
    if isinstance(e, GatedRepoError):
        if get_token() is None:
            return (
                f"{repo} is gated and you are not logged in to Hugging Face.\n"
                f"  1. Request access at {url}\n"
                f"  2. Create a read token at https://huggingface.co/settings/tokens\n"
                f"  3. Run: uv run hf auth login"
            )
        return (
            f"{repo} is gated and your Hugging Face account has no access yet.\n"
            f"  Request access at {url}. Some authors approve manually, which can take hours or days."
        )
    if isinstance(e, RepositoryNotFoundError):
        return f"repository {repo} not found. Check the repo name in models/registry.yaml."
    if isinstance(e, RevisionNotFoundError):
        return f"revision {revision} not found in {repo}. Check the revision in models/registry.yaml."
    if isinstance(e, LocalEntryNotFoundError):
        return "could not reach Hugging Face and the file is not downloaded yet. Check your internet connection."
    if isinstance(e, EntryNotFoundError):
        # Hugging Face also reports a well-formed but nonexistent commit hash
        # this way, so either value may be wrong.
        return (
            f"{filename} not found in {repo} at revision {revision[:8]}.\n"
            f"  Check the file name and the revision in models/registry.yaml."
        )
    return f"Hugging Face request failed: {e}"


def download_gguf(key: str, model: dict, force: bool = False) -> Path:
    """Download one model's GGUF file to models/<key>/ and return its path.

    Files that are already complete are not downloaded again (unless `force`),
    and an interrupted download resumes where it stopped.
    """
    gguf = model["gguf"]
    print(f"{key}: {gguf['file']} ({gguf['size_bytes'] / 1e9:.2f} GB) from {gguf['repo']}")
    try:
        path = hf_hub_download(
            repo_id=gguf["repo"],
            filename=gguf["file"],
            revision=gguf["revision"],
            local_dir=MODELS_DIR / key,
            force_download=force,
        )
    except (HfHubHTTPError, EntryNotFoundError) as e:
        raise DownloadError(explain_hub_error(e, gguf["repo"], gguf["revision"], gguf["file"])) from e
    return Path(path)


def list_original_files(model: dict) -> list:
    """Ask Hugging Face which files of the original repo we need, with sizes and checksums."""
    o = model["original"]
    try:
        info = HfApi().model_info(o["repo"], revision=o["revision"], files_metadata=True)
    except (HfHubHTTPError, EntryNotFoundError) as e:
        raise DownloadError(explain_hub_error(e, o["repo"], o["revision"], "")) from e
    return [
        f for f in info.siblings
        if not any(fnmatch.fnmatch(f.rfilename, p) for p in ORIGINAL_SKIP_PATTERNS)
    ]


def download_original(key: str, model: dict, files: list, force: bool = False) -> Path:
    """Download the given files of the original repo to models/<key>/original/."""
    o = model["original"]
    try:
        path = snapshot_download(
            repo_id=o["repo"],
            revision=o["revision"],
            local_dir=MODELS_DIR / key / "original",
            # Exactly the files listed by list_original_files(), so a dry run
            # and a real download always agree.
            allow_patterns=[f.rfilename for f in files],
            force_download=force,
        )
    except (HfHubHTTPError, EntryNotFoundError) as e:
        raise DownloadError(explain_hub_error(e, o["repo"], o["revision"], "")) from e
    return Path(path)


def fetch_gguf(key: str, model: dict, force: bool, dry_run: bool) -> int:
    """Download and verify one GGUF file. Returns its size in bytes."""
    gguf = model["gguf"]
    if dry_run:
        print(f"{key}: would download {gguf['file']} ({gguf['size_bytes'] / 1e9:.2f} GB) from {gguf['repo']}")
        return gguf["size_bytes"]

    path = download_gguf(key, model, force=force)
    print("  verifying checksum...", end=" ", flush=True)
    try:
        verify(path, gguf["sha256"])
    except ChecksumError:
        print("FAILED")
        raise
    print("ok")
    print(f"  saved to {path}")
    return gguf["size_bytes"]


def fetch_original(key: str, model: dict, force: bool, dry_run: bool) -> int:
    """Download and verify one model's original weights. Returns their size in bytes."""
    repo = model["original"]["repo"]
    files = list_original_files(model)
    total = sum(f.size or 0 for f in files)
    verb = "would download" if dry_run else "downloading"
    print(f"{key}: {verb} {len(files)} files ({total / 1e9:.2f} GB) from {repo}")
    if dry_run:
        for f in files:
            print(f"  {f.rfilename:50} {(f.size or 0) / 1e6:10.1f} MB")
        return total

    path = download_original(key, model, files, force=force)
    # Hugging Face publishes SHA256 checksums for large (LFS) files only, which
    # covers the weights; small text files have no published checksum.
    large = [f for f in files if f.lfs]
    print(f"  verifying {len(large)} checksums...", end=" ", flush=True)
    try:
        for f in large:
            verify(path / f.rfilename, f.lfs.sha256)
    except ChecksumError:
        print("FAILED")
        raise
    print("ok")
    print(f"  saved to {path}")
    return total


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Download the models listed in models/registry.yaml."
    )
    parser.add_argument("models", nargs="*", metavar="MODEL", help="model keys to download (see --list)")
    parser.add_argument("--all", action="store_true", help="download every model in the registry")
    parser.add_argument("--list", action="store_true", help="list available models and exit")
    parser.add_argument("--force", action="store_true", help="re-download even if the file already exists")
    parser.add_argument(
        "--original", action="store_true",
        help="download the original weights (for fine-tuning) instead of the GGUF file",
    )
    parser.add_argument("--dry-run", action="store_true", help="show what would be downloaded, without downloading")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        models = load_registry()
    except RegistryError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    if args.list:
        print_models(models)
        return 0

    keys = list(models) if args.all else args.models
    if not keys:
        parser.print_help()
        return 0

    unknown = [k for k in keys if k not in models]
    if unknown:
        print(f"error: unknown model(s): {', '.join(unknown)}. Run --list to see them.", file=sys.stderr)
        return 1

    fetch = fetch_original if args.original else fetch_gguf
    failed = []
    total = 0
    for key in keys:
        try:
            total += fetch(key, models[key], force=args.force, dry_run=args.dry_run)
        except (DownloadError, ChecksumError) as e:
            print(f"error: {e}", file=sys.stderr)
            failed.append(key)

    if args.dry_run:
        print(f"\nTotal: {total / 1e9:.2f} GB (nothing downloaded)")
    if failed:
        print(f"\n{len(failed)} model(s) failed: {', '.join(failed)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
