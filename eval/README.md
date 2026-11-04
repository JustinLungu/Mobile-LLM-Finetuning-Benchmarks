# eval

Runs the models on a computer with [llama.cpp](https://github.com/ggml-org/llama.cpp) and measures load time, time to first token, generation speed, peak memory and reliability. The phone apps use the same prompts and results format, so all numbers end up in one table.

Laptop numbers are a reference point and a check that everything works. They don't predict phone speed or memory.

Judgment quality (how well a model reasons about a user's request) will be evaluated after the setup phase.

## Quick start

From the repository root:

```bash
uv sync                                        # install Python dependencies
uv run models/download.py --all                # download the models (~9.2 GB)
eval/build_llama_cpp.sh                        # build llama.cpp (a few minutes)
uv run eval/smoke_test.py                      # check that every model answers (~30 s)
uv run eval/benchmark.py --all                 # full benchmark (~15 min)
uv run eval/summarize_results.py               # print the results table
```

Everything runs locally. After the downloads, nothing needs the internet.

## Tools

| Tool | Use it to | Time |
|---|---|---|
| `build_llama_cpp.sh` | Build llama.cpp at the version pinned in `llama_cpp.env`, for CPU and, if `nvcc` is installed, CUDA | ~5 min once |
| `smoke_test.py` | Check that models load and answer correctly | ~30 s |
| `try_prompts.py` | Run prompts on a model and read the full replies, for debugging and experiments | Seconds |
| `benchmark.py` | Measure models and write results files | ~15 min for all |
| `summarize_results.py` | Turn results files into one Markdown table | Instant |
| `validate_results.py` | Check that results files follow the [format](../spec/results.schema.json), including those from phone apps | Instant |

`llama_server.py` is not run directly: the tools above use it to start and talk to `llama-server`.

## Trying things out

`try_prompts.py` is the place to experiment. Its settings can be changed freely, and it writes no results.

```bash
uv run eval/try_prompts.py qwen3.5-2b                                     # all benchmark prompts
uv run eval/try_prompts.py gemma4-e2b --prompt manipulation               # one prompt
uv run eval/try_prompts.py llama3.2-3b --user "Just two more minutes."    # your own message
uv run eval/try_prompts.py gemma4-e2b --prompt manipulation --thinking    # show the model's reasoning
uv run eval/try_prompts.py qwen3.5-2b --temperature 0.7 --build cpu       # other settings
```

Server logs are in `results/logs/`, one per model and build.

## Benchmarking

```bash
uv run eval/benchmark.py --all                                   # every downloaded model, every build
uv run eval/benchmark.py qwen3.5-2b --build cuda                 # one model on one build
uv run eval/benchmark.py qwen3.5-2b --repeats 1 --output-dir /tmp/try-it   # quick trial, outside results/
```

Each run writes one file per model and build to `results/linux/`, which stays local and is not committed. Use `--output-dir` to keep trial runs separate.

The benchmark runs the 5 prompts in [`spec/bench_prompts.json`](../spec/bench_prompts.json) 4 times, restarting the server each time, because Wilo loads the model every time it wakes up. These 20 runs are the reliability check: a model passes if all of them complete without a crash. A failed run still writes a results file, with the error.

### Fixed settings

Benchmarks can't change these, so that results stay comparable. llama.cpp's own defaults adapt to the machine, so everything is set explicitly.

| Setting | Value | Why |
|---|---|---|
| Context size | 4,096 tokens | Enough for Wilo's prompts; the default reserves far more memory |
| Prompt cache | Off | Wilo loads the model fresh, so nothing would be cached |
| Thinking | Off | Llama has no thinking mode, and thinking lengths vary a lot |
| Temperature, seed | 0, 0 | Repeatable output |
| Weight repacking | Off | A second copy of the weights: measured up to 1.3 GB more memory, and no faster |
| Automatic fitting (`--fit`) | Off | It would silently change settings to fit memory |
| Parallel requests | 1 | One request at a time, like a phone app |
| Threads | 8 | This laptop's performance cores; hardcoded for now |
| GPU layers | All on CUDA, none on CPU | The CUDA build stops with an error if it can't see a GPU |

## Reading the results

| Column | Meaning |
|---|---|
| **Runs reliably** | `yes (20/20)` if all 20 runs finished; `no` with the count if it failed; `too few runs` for short trials |
| **Load** | Seconds until the model is ready. Often best-case, because recently used files are cached in memory |
| **First token** | Delay from sending a request until the reply starts. Mostly prompt processing, so it grows with prompt length |
| **Reply speed** | Tokens per second while writing the reply, excluding the first-token delay |
| **Peak memory** | The most memory the process used (`VmHWM`), including the pages mapped from the model file. Use this to judge whether a model fits |
| **GPU memory** | Memory used on the graphics card, on CUDA only |
| **File size** | Size of the 4-bit model file |

The results files also record `private_bytes`, the part of the memory that the OS can't drop and re-read from the model file. It helps explain why a model uses what it does, but a model needs far more than this to run at a usable speed.

## Limitations

- **Laptop speed varies.** Other programs and the power mode affect it. Each file records the power mode, and the table uses medians to limit the effect of outliers.
- **Memory is measured differently on each platform,** so compare phone and laptop numbers with care. Each file records its method.
- **Some replies hit the 128-token limit,** which cuts off their JSON. This doesn't affect the speed numbers.
- **`DEFAULT_THREADS` is set for one laptop,** in `llama_server.py`. Change it if you benchmark on another machine.
