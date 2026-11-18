# Wilo Chrome extension

The Wilo prototype: a Chrome extension that asks what you're opening Instagram (or YouTube, TikTok, X, Reddit, Facebook) for and for how long. When time is up, you can ask Wilo for more. Wilo's replies come from a small language model that runs **on your computer, inside Chrome**. Nothing is sent to a server.

## For testers: install Wilo

You get a file called `wilo-extension-0.1.0.zip`.

1. Unzip it. You get a folder `wilo-extension`. Keep it somewhere permanent (e.g. Documents): Chrome loads Wilo from this folder every time.
2. In Chrome, open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the `wilo-extension` folder.
5. Click the puzzle icon in the toolbar and pin **Wilo**. Click it: the first time, Wilo downloads its model (1.3 GB). This takes a few minutes on good Wi-Fi. If you close Chrome, it continues where it stopped.
6. Optional: in the same window, fill in **What Wilo knows about you** (schedule, habits, how strict Wilo should be) and click **Save**.
7. Open instagram.com and use it as usual.

Works in Chrome on Windows, Mac and Linux, with 8 GB of RAM or more. While Wilo is loaded, Chrome uses about 2 GB more memory.

**Sending us your results:** click the Wilo icon → **Download log**, and send us the file. It contains what you told Wilo and what it answered, nothing else.

## For the team: build and test

```bash
uv run apps/extension/setup.py          # downloads wllama, writes generated/config.js
uv run apps/extension/setup.py --zip    # also makes dist/wilo-extension-<version>.zip for testers
uv run apps/extension/dev/check_extension.py   # end-to-end check in headless Chrome
```

`setup.py` takes Wilo's rules from `spec/bench_prompts.json` and the model links from `models/registry.yaml`, so the extension uses the same prompt and model files as the benchmarks and the training data. To load your working copy, use **Load unpacked** on `apps/extension/` itself. After editing files, click the reload icon on `chrome://extensions`.

The check needs the GGUF files from `models/download.py`. It serves them locally, opens Instagram, goes through the start screen, jumps to time-up, asks Wilo for more time, and prints the reply and the log entry. Options: `--model llama3.2-3b`, `--reason "come on"`, `--flaky-mb 200` (the test server drops the download every 200 MB, to check resuming) and `--from-hf` (download from Hugging Face like testers).

To try another model file (e.g. our fine-tuned one): Wilo icon → **Use another model file**, then paste a link to a `.gguf` file under 2 GB.

## How it works

| File | Role |
|---|---|
| `content.js` | The overlay on the watched sites: the start screen and the time-up chat. Pauses videos while it's shown |
| `background.js` | One session per site (intent, minutes, extensions), builds Wilo's prompt, applies its decision, keeps the log |
| `offscreen.js` | A hidden page that downloads the model (in 32 MB parts, resumable) and runs it with [wllama](https://github.com/ngxson/wllama) (llama.cpp compiled to WebAssembly) |
| `wilo.js` | Wilo's prompt and reply format, identical to the training data |
| `popup.*` | Model status, settings, the log |

- **Each time-up request is one prompt** in exactly the training format: the situation (time, app, intent, agreed and used minutes, extensions, next event) plus what the user said. Wilo's JSON reply is forced to the schema, so it can't be malformed.
- **Grant:** the session is extended.
- **Counter-offer:** the user can take it or explain more.
- **Decline:** the user can close the tab or ask again, after a wait that grows with each decline (10 s, 20 s, …). A small "stay anyway (5 min)" link appears after 20 s, because Wilo never blocks completely.
- **When a session ends:** after no tab of that site has been open for 2 minutes.

**Limits:**
- **2 GB per file:** browsers can't load one file larger than this. Qwen 3.5 2B and Llama 3.2 3B work. Qwen 3.5 4B and Gemma 4 E2B would need to be split into parts first.
- **Speed:** on a laptop CPU, a reply takes about 12–17 s with the base models. Chrome uses the GPU (WebGPU) when it can, which is faster.
