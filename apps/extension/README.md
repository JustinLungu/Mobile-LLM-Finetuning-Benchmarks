# Wilo Chrome extension

The Wilo prototype: a Chrome extension that asks what you're opening Instagram (or YouTube, TikTok, X, Reddit, Facebook) for and for how long. When time is up, you can ask Wilo for more. Wilo's replies come from a small language model that runs **on your computer, inside Chrome**. Nothing is sent to a server.

## For testers: install Wilo

You get a file called `wilo-extension-0.1.0.zip`.

1. Unzip it. You get a folder `wilo-extension`. Keep it somewhere permanent (e.g. Documents): Chrome loads Wilo from this folder every time.
2. In Chrome, open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the `wilo-extension` folder.
5. Click the puzzle icon in the toolbar and pin **Wilo**. Click it: the first time, Wilo downloads its model (2 GB). This takes a few minutes on good Wi-Fi. If you close Chrome, it continues where it stopped.
6. Optional: in the same window, fill in **What Wilo knows about you** (schedule, habits, how strict Wilo should be). It saves by itself.
7. Open instagram.com and use it as usual.

Works in Chrome on Windows, Mac and Linux, with 8 GB of RAM or more. While Wilo is loaded, Chrome uses about 2–4 GB more memory, depending on the model.

**Trying it without waiting:** click the Wilo icon → **For the study** → **Time's up now**.

**Please rate Wilo's replies** with 👍 or 👎. It tells us which answers to teach it.

**Sending us your results:** your conversations are saved on your computer as you go. At the end of the study, click the Wilo icon → **For the study** → **Save my conversations for the Wilo team**, and send us the file from your Downloads folder. It contains your conversations with Wilo (what you said, what it answered and your ratings), the sites and times of your sessions, and your "What Wilo knows about you" note. Nothing else.

## For the team: build and test

```bash
uv run apps/extension/setup.py          # downloads wllama, writes generated/config.js
uv run apps/extension/setup.py --zip    # also makes dist/wilo-extension-<version>.zip for testers
uv run apps/extension/dev/check_extension.py   # end-to-end check in headless Chrome
```

`setup.py` takes Wilo's rules from `spec/bench_prompts.json` and the model links from `models/registry.yaml`, so the extension uses the same prompt and model files as the benchmarks and the training data. To load your working copy, use **Load unpacked** on `apps/extension/` itself. After editing files, click the reload icon on `chrome://extensions`.

The check needs the GGUF files from `models/download.py`. It serves them locally, opens Instagram, goes through the start screen, jumps to time-up, asks Wilo for more time, and prints the reply and the log entry. Options: `--model llama3.2-3b`, `--say "come on"` (repeat `--say` for a conversation), `--intent`, `--next`, `--dark`, `--flaky-mb 200` (the test server drops the download every 200 MB, to check resuming) and `--from-hf` (download from Hugging Face like testers).

To try another model or model file (e.g. our fine-tuned one): Wilo icon → **Advanced**, then pick a model or paste a link to a `.gguf` file, then click **Use this model**.

## How it works

| File | Role |
|---|---|
| `content.js` | The overlay on the watched sites: the start screen and the time-up chat. Pauses videos while it's shown |
| `background.js` | One session per site (intent, minutes, extensions), builds Wilo's prompt, applies its decision, keeps the log |
| `offscreen.js` | A hidden page that downloads the model (in 32 MB parts, resumable) and runs it with [wllama](https://github.com/ngxson/wllama) (llama.cpp compiled to WebAssembly) |
| `wilo.js` | Wilo's prompt and reply format, identical to the training data |
| `popup.*` | Model status, settings, the log |

- **Wilo sees the whole conversation of the session** (up to 12 earlier exchanges). Each user turn is the situation at that moment (time, app, intent, agreed and used minutes, extensions, next event) plus what the user said, in exactly the training format. Wilo's instructions are in `spec/wilo_prompt.json`, and its JSON reply is forced to the schema, so it can't be malformed.
- **Each reply shows its decision** (✅ +10 min / 🤝 Offer: 5 min / ✋ No extra time) and 👍/👎 buttons.
- **When a time-up conversation ends,** it's saved whole in the log with its outcome (granted, took offer, stayed anyway, done) and the minutes given. These are ready-made fine-tuning examples.
- **Grant:** the session is extended.
- **Counter-offer:** the user can take it or explain more.
- **Decline:** the user can close the tab or ask again. Asking again is immediate after the first decline, then there's a wait that grows with each further decline (10 s, 20 s, …). A small "stay anyway (5 min)" link appears after 20 s, because Wilo never blocks completely.
- **When a session ends:** after no tab of that site has been open for 2 minutes.

**Models:** all four load. The model is saved in 32 MB parts and handed to wllama as pieces on disk, so the browser's 2 GB limit on a single file doesn't apply. The table shows the same conversation ("come on", then "please", then "pleeease, just a bit more") with the base models, on a laptop CPU with no GPU:

| Model | Download | Decisions | Reply time (CPU) |
|---|---|---|---|
| Qwen 3.5 2B | 1.28 GB | granted 10 min to "come on" ✗ | ~21 s |
| Llama 3.2 3B | 2.02 GB | offered 2 min, then 1 min, then declined ✓ | 12–15 s |
| Gemma 4 E2B | 3.11 GB | declined, declined ✓ | 17–29 s |
| Qwen 3.5 4B | 2.74 GB | offered 3, then 2, then 1 min; clearest messages, but never said no | 24–54 s |

Chrome uses the GPU (WebGPU) when it can, which is much faster.
