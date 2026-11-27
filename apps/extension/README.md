# Wilo Chrome extension

The Wilo prototype: a Chrome extension that asks what you're opening Instagram (or YouTube, TikTok, X, Reddit, Facebook) for and for how long. When time is up, you can ask Wilo for more. Wilo's replies come from a small language model that runs **on your computer, inside Chrome**. Nothing is sent to a server.

## For testers: install Wilo

You get a file called `wilo-extension-0.3.0.zip`. Use **Google Chrome** (Edge and Brave should work too; Safari and Firefox don't), with 8 GB of RAM or more and good Wi-Fi for the first start.

1. Unzip it. You get a folder `wilo-extension`. Keep it somewhere permanent (e.g. Documents): Chrome loads Wilo from this folder every time.
2. In Chrome, open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the `wilo-extension` folder.
5. Click the puzzle icon in the toolbar and pin **Wilo**. Click it: the first time, Wilo downloads its model (2 GB). This takes a few minutes. If you close Chrome, it continues where it stopped. Wait for **✅ Wilo is ready**.
6. Open instagram.com (or YouTube, TikTok, X, Reddit, Facebook) and use it as usual.

**What happens:**
- **When you open one of these sites,** Wilo asks what you're there for and for how long, then takes a quick look at your plan: it may say OK, suggest less time, or ask you something. The first time, it offers 4 quick questions to get to know you; you can skip them.
- **When your time is up,** you can ask Wilo for more. Tell it why, as you would tell a friend. It may say yes, offer less, or say no. You can always explain more, or click **I'm done**.
- **Now and then,** Wilo asks one optional question on the start screen, to get to know you better.
- **Free time:** under **Set up free time** on the start screen, choose times when you can scroll freely, without Wilo asking anything.

**Please:**
- Use it normally for a few days, on the sites you actually use.
- Rate Wilo's replies with 👍 or 👎. That tells us which answers to teach it.
- Expect Wilo to take 5–25 seconds to answer, depending on your computer. It's thinking on your computer, not in the cloud.

**Sending us your results:** your conversations are saved on your computer as you go; nothing leaves it until you send them. At the end of the study (or whenever we ask), click the Wilo icon → **For the study** → **Send my conversations to the Wilo team**. They go straight to the team's private SWITCHdrive folder; there's nothing else to do. If sending fails, Wilo saves a file to your Downloads folder instead: please email it to us. What's sent: what you told Wilo and what it answered, your ratings, your answers to its questions and free-time settings, and when you used which site and for how long, with a random study ID instead of your name. Nothing else: Wilo never sees what you look at on these sites. To read it first, click **Save a copy on this computer**; to remove it, **Delete my conversations**.

**If something goes wrong:** open `chrome://extensions`, click the reload icon on the Wilo card, and tell us what happened (a screenshot helps).

## For the team: build and test

```bash
uv run apps/extension/setup.py          # downloads wllama, writes generated/config.js
uv run apps/extension/setup.py --zip    # also makes dist/wilo-extension-<version>.zip for testers
uv run apps/extension/dev/check_extension.py   # end-to-end check in headless Chrome
uv run apps/extension/dev/check_open_tabs.py   # Wilo in tabs open before an install or update
uv run apps/extension/dev/check_memory.py      # what Wilo learns, and its check-in questions
uv run apps/extension/dev/check_between_sessions.py  # welcome back after a session, free-time rules
```

**Receiving testers' conversations (SWITCHdrive).** The **Send** button uploads `wilo-<study id>-<time>.json` to an upload-only SWITCHdrive share. Put the share link (e.g. `https://drive.switch.ch/index.php/s/AbC123`) in `apps/extension/upload-link.txt` (git-ignored) before running `setup.py`; without it the button saves a file as before. The share must be **File drop (upload only)** with **no password**: the link ships inside the extension, so anyone could find it, but with upload-only they can only add files, never read them. Each send holds the whole log, so the newest file per study ID is complete.

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
| `memory.js` | What Wilo knows about the user: onboarding answers, check-in questions and patterns learned from sessions, written as the memory note |
| `popup.*` | Model status, settings, the log |

- **Wilo reviews every plan before the session starts:** after Start, it accepts the plan (✅), offers less time (🤝) or asks something (❓, e.g. for "idk"). The user can answer, take the offer, or click "I'm done". It never gives more than asked. This conversation becomes the start of the session's history.
- **Wilo sees the whole conversation of the session** (up to 12 earlier exchanges). Each user turn is the situation at that moment (time, app, intent, agreed and used minutes, extensions, next event) plus what the user said, in exactly the training format. Wilo's instructions are in `spec/wilo_prompt.json`, and its JSON reply is forced to the schema, so it can't be malformed.
- **Each reply shows its decision** (✅ +10 min / 🤝 Offer: 5 min / ✋ No extra time) and 👍/👎 buttons.
- **When a time-up conversation ends,** it's saved whole in the log with its outcome (granted, took offer, done) and the minutes given. These are ready-made fine-tuning examples.
- **Grant:** the session is extended.
- **Counter-offer:** the user can take it or explain more.
- **Decline:** the user can close the tab or ask again. Asking again is immediate after the first decline, then there's a wait that grows with each further decline (10 s, 20 s, …). There is no way around a "no": the only ways out are a real reason or "I'm done".
- **When a session ends:** after no tab of that site has been open for 2 minutes.

**What Wilo knows about the user** is written by Wilo itself, in the same layout as the training data's memory note (Schedule / Preferences / Typical sessions / Patterns). It comes from three sources:
- **Onboarding:** the first time, 4 optional questions (bedtime, how strict, what to help with, what they enjoy besides social media). Users tap an answer or type their own.
- **Check-in questions:** at most one a day, at the top of the start screen ("Let's get to know each other a bit"), each asked once and always skippable, with "Don't ask me questions" to stop them. Wilo asks when it notices something:
  - a usual time ("is that free time?")
  - an unusual time
  - a "next event" that keeps coming up ("is it a regular thing?")
  - being past bedtime
  - sessions that keep running long

  Otherwise about once a week it asks an open question about the week. Typed answers are kept in the user's own words.
- **Recently:** the last sessions of the past 3 hours (when they ended, what was planned, what came next, Wilo's last answer). Coming back soon after, the start screen says *"Welcome back. You left Instagram 1 min ago and said "Sleep" was next."*
- **Their rules:** free-time windows, set on the start screen ("Set up free time") or in the popup ("Your rules"), e.g. weekdays 17:00–19:00, with an optional "Anything Wilo should know about this time?" kept in the user's words. In a window there's no start screen, only a small note ("Free time until 19:00, enjoy! 📚 A few pages of your book would be nice too.", using the hobby from the onboarding). A session runs until the window ends, then the normal time-up.
- **Learned:** typical session length per app (median of at least 3 finished sessions), how often the user asks for more, and overruns, especially late at night.

You can read the note in the popup under **Advanced**.

**Models:** all four load. The model is saved in 32 MB parts and handed to wllama as pieces on disk, so the browser's 2 GB limit on a single file doesn't apply. The table shows the same conversation ("come on", then "please", then "pleeease, just a bit more") with the base models, on a laptop CPU with no GPU:

| Model | Download | Decisions | Reply time (CPU) |
|---|---|---|---|
| Qwen 3.5 2B | 1.28 GB | granted 10 min to "come on" ✗ | ~21 s |
| Llama 3.2 3B | 2.02 GB | offered 2 min, then 1 min, then declined ✓ | 12–15 s |
| Gemma 4 E2B | 3.11 GB | declined, declined ✓ | 17–29 s |
| Qwen 3.5 4B | 2.74 GB | offered 3, then 2, then 1 min; clearest messages, but never said no | 24–54 s |

Chrome uses the GPU (WebGPU) when it can, which is much faster.
