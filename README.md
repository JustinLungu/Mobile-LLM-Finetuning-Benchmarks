# Mobile-LLM-Finetuning-Benchmarks
Fine-tuning and benchmarking small LLMs (2–4B) for private on-device reasoning on iPhone and Android, including judgment quality, memory usage, latency, throughput and 4-bit quantization with llama.cpp. Built for Wilo, an AI accountability companion.

> **Status:** Phase 1, setup and measurement. No results yet.

## Why

[Wilo](https://github.com/JustinLungu/Wilo) ("Why I Logged On") helps people use social media on purpose. Before opening an app, the user states why and for how long; when time is up, they have to give Wilo a reason for more time, and Wilo decides whether it holds up.

That reasoning has to run **entirely on the phone**: no cloud calls, no screen reading, and each user's preferences kept in a short local memory note. This repo measures which small open models can do that on real phones, before and after fine-tuning.

## Target devices

| Tier | Devices | RAM |
|---|---|---|
| Low end (floor) | iPhone 12 / 13 | 4 GB |
| Baseline | iPhone 13 Pro Max | 6 GB |
| Android | Floor device to be defined | – |

iOS and Android run the **same** fine-tuned models, so users get the same behaviour on either platform.

## Models

| Model | Why it's included |
|---|---|
| Qwen 3.5 2B | Smallest candidate; expected to fit 4 GB comfortably |
| Llama 3.2 3B | Mature, widely fine-tuned middle option |
| Gemma 4 E2B | Designed for phones; may give ~3B quality at ~2B memory |
| Qwen 3.5 4B | Upper bound; shows how much a larger size helps |

All models run as 4-bit GGUF files with [llama.cpp](https://github.com/ggml-org/llama.cpp).

## What is measured

For every model, before and after fine-tuning, on every device:

| Metric | Meaning |
|---|---|
| Runs reliably | Loads and completes 20 back-to-back runs without crashing or being killed by the OS |
| Load time | Time to load the model into memory |
| Time to first token | Delay before the reply starts, with a ~400-token prompt |
| Tokens/s | Generation speed |
| Peak memory | Highest memory use during a run |
| File size | Size of the 4-bit model file |
| Heat | Device temperature state after 20 runs |

## Results

_To be filled in._

| Model | Device | Runs reliably | Load time | Time to first token | Tokens/s | Peak memory | File size |
|---|---|---|---|---|---|---|---|
| Qwen 3.5 2B | – | – | – | – | – | – | – |
| Llama 3.2 3B | – | – | – | – | – | – | – |
| Gemma 4 E2B | – | – | – | – | – | – | – |
| Qwen 3.5 4B | – | – | – | – | – | – | – |

## Plan

1. **Get the models:** reproducible downloads and verified model details
2. **Desktop setup:** llama.cpp benchmarks on Linux
3. **Phone setups:** iOS and Android benchmark apps
4. **Base model benchmarks** on all devices
5. **Fine-tuning pipeline:** LoRA training and conversion to 4-bit GGUF
6. **Fine-tuned model benchmarks** on all devices
7. **Results** and recommendation

Judgment-quality evaluation (how well each model reasons about the user's requests) follows once the setup is complete.

## Repository layout

```
spec ─► data ─► finetune ─► convert ─► eval (computer)
                                  │
                                  └──► apps/ios, apps/android (on device) ─► results
```

| Folder | Contents | Runs on |
|---|---|---|
| [`models/`](models/) | Model download scripts (weights are not committed) | Any |
| [`spec/`](spec/) | Input/output format and memory-note format | – |
| [`data/`](data/) | Synthetic training data generator | Any |
| [`finetune/`](finetune/) | LoRA training configs | GPU |
| [`convert/`](convert/) | Merge and quantize to 4-bit GGUF | Any |
| [`eval/`](eval/) | Benchmarks with llama.cpp on a computer | Any |
| [`apps/ios/`](apps/ios/) | iPhone benchmark app (Swift, XcodeGen) | Mac + iPhone |
| [`apps/android/`](apps/android/) | Android benchmark app (Kotlin, NDK) | Any + Android phone |
| [`results/`](results/) | Results from all runs, in one shared format | – |

## License

[MIT](LICENSE)
