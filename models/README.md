# models

Download scripts and the model registry. Model files are **not** committed: run the script to get them.

## Quick start

From the repository root:

```bash
uv sync                                    # install dependencies (once)
uv run models/download.py --list           # see the available models
uv run models/download.py --all            # download all GGUF files (~9.2 GB)
```

Each file is checked against its SHA256 checksum after download. Running the command again skips files that are already complete.

## Two formats

| Format | Used for | Command | Saved to | Total size |
|---|---|---|---|---|
| **GGUF** (4-bit) | Benchmarks with llama.cpp, phone apps | `download.py <model>` | `models/<model>/` | ~9.2 GB |
| **Original weights** (16-bit `.safetensors`) | Fine-tuning | `download.py <model> --original` | `models/<model>/original/` | ~30.6 GB |

Check sizes before downloading with `--dry-run`:

```bash
uv run models/download.py --all --original --dry-run
```

## Commands

| Command | What it does |
|---|---|
| `download.py --list` | List models, file sizes and licenses |
| `download.py qwen3.5-2b llama3.2-3b` | Download specific models' GGUF files |
| `download.py --all` | Download every model's GGUF file |
| `download.py <model> --original` | Download the original weights instead |
| `download.py ... --dry-run` | Show what would be downloaded, without downloading |
| `download.py ... --force` | Download again, e.g. after a failed checksum |

## Models

All details checked against Hugging Face on 1 November 2026.

| Key | Model | GGUF size | Parameters | Context | Thinking mode | License | Gated |
|---|---|---|---|---|---|---|---|
| `qwen3.5-2b` | [Qwen 3.5 2B](https://huggingface.co/Qwen/Qwen3.5-2B) | 1.28 GB | 2.27B ¹ | 262K | Yes | Apache 2.0 | No |
| `llama3.2-3b` | [Llama 3.2 3B Instruct](https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct) | 2.02 GB | 3.21B | 131K | No | Llama 3.2 Community | **Yes** ² |
| `gemma4-e2b` | [Gemma 4 E2B Instruct](https://huggingface.co/google/gemma-4-E2B-it) | 3.11 GB | 5.12B ³ | 131K | Yes | Apache 2.0 | No |
| `qwen3.5-4b` | [Qwen 3.5 4B](https://huggingface.co/Qwen/Qwen3.5-4B) | 2.74 GB | 4.66B ¹ | 262K | Yes | Apache 2.0 | No |

¹ Includes a vision encoder that this project does not use.
² Only the original weights are gated; the GGUF file is not. See [Gated models](#gated-models).
³ 2.3B "effective": most of the rest are per-layer embedding tables used only for lookups.

All GGUF files are `Q4_K_M` conversions by [Unsloth](https://huggingface.co/unsloth), so every model is compressed the same way. Exact repos, file names, pinned revisions and checksums are in [`registry.yaml`](registry.yaml).

## Gated models

Meta's Llama weights require approval before download:

1. Request access on the [model page](https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct). Meta approves requests manually, which can take hours or days.
2. Create a **read** token at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens).
3. Log in once on your machine (the token is stored by Hugging Face, outside this repo):
   ```bash
   uv run hf auth login
   ```

## Troubleshooting

| Message | Fix |
|---|---|
| `… is gated and you are not logged in` | Follow [Gated models](#gated-models) |
| `… is gated and your Hugging Face account has no access yet` | Wait for approval, or check your request on the model page |
| `does not match its expected checksum` | Run the same command again with `--force` |
| `could not reach Hugging Face` | Check your internet connection |
| `not found … Check … models/registry.yaml` | A repo, file name or revision in the registry is wrong |

## Adding a model

Add an entry to [`registry.yaml`](registry.yaml), copying the structure of an existing one. Take every value from Hugging Face: the commit hash from the repo's *Files and versions* tab, and the GGUF file's size and SHA256 from its file page. The script checks the entry's format when it loads.
