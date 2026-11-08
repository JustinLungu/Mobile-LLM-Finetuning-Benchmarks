# iOS benchmark app

An iPhone app that tests how small language models run on a real phone. Everything runs on the phone; nothing is sent anywhere.

**Today's goal:** get one model running on an iPhone and generating a reply. The app doesn't produce benchmark results yet.

No Apple or iOS experience is needed. Follow the parts in order. Each one ends with what you should see. If you see something else, go to [If something goes wrong](#if-something-goes-wrong).

**Allow about an hour** the first time, plus the Xcode download if it isn't installed yet.

## Before you start

**On the Mac:**

- [Xcode](https://apps.apple.com/app/xcode/id497799835), installed and opened once. It's a big download, so do this ahead of time.
- [Homebrew](https://brew.sh).

**You also need:**

- An iPhone with iOS 16.4 or later (**Settings → General → About**), with at least 2 GB free.
- A cable that connects the iPhone to the Mac.
- An Apple ID. A free one is enough.

## Part 1: Set up the Mac (about 5 minutes)

Open **Terminal** and run these one at a time:

```bash
git clone https://github.com/JustinLungu/Mobile-LLM-Finetuning-Benchmarks.git
```
```bash
cd Mobile-LLM-Finetuning-Benchmarks
```
```bash
apps/ios/setup.sh
```

**You should see** `Setup is done` in Terminal, and Xcode opens with the **WiloBench** project.

## Part 2: Prepare the iPhone (about 5 minutes)

1. Connect the iPhone to the Mac with the cable, and unlock it.
2. If the iPhone asks whether to trust this computer, tap **Trust** and enter your passcode.
3. On the iPhone, go to **Settings → Privacy & Security → Developer Mode** and turn it on. The iPhone restarts. Confirm after the restart.

If **Developer Mode** isn't in the list, do Part 3 first. It appears after Xcode has tried to install on the phone.

**You should see** the Developer Mode switch turned on.

## Part 3: Install the app (about 10 minutes)

In Xcode:

1. In the left sidebar, click **WiloBench** at the very top.
2. Open the **Signing & Capabilities** tab.
3. Tick **Automatically manage signing**.
4. Under **Team**, choose your Apple ID. If it isn't listed, choose **Add an Account** and sign in.
5. At the top of the window, click the device name, and choose your iPhone.
6. Press the **Run** button (the triangle), or Cmd+R. The first build takes a few minutes.

If the iPhone says the developer isn't trusted:

7. On the iPhone, go to **Settings → General → VPN & Device Management**, tap your Apple ID, then **Trust**.
8. Press **Run** in Xcode again.

**You should see** the app open on the iPhone, titled **Wilo Bench**, with *Models on this iPhone* and an empty list.

## Part 4: Copy a model onto the iPhone (about 15 minutes)

We start with Qwen 3.5 2B, the smallest model.

**Download it** in Terminal, in the same folder. It's 1.28 GB:

```bash
curl -L -o Qwen3.5-2B-Q4_K_M.gguf https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/f6d5376be1edb4d416d56da11e5397a961aca8ae/Qwen3.5-2B-Q4_K_M.gguf
```

**Check the download:**

```bash
shasum -a 256 Qwen3.5-2B-Q4_K_M.gguf
```

**You should see** a long code starting with `aaf42c8b` and ending with `14699223`. If it's different, download it again.

**Copy it to the iPhone:**

1. Open **Finder**, and click your iPhone in the left sidebar.
2. Click the **Files** tab, and find **WiloBench**.
3. Drag the `.gguf` file from the repository folder onto **WiloBench**.
4. Wait for the copy to finish. It can take a few minutes.

**You should see** `Qwen3.5-2B-Q4_K_M.gguf` listed under WiloBench in Finder.

## Part 5: Load the model (about 1 minute)

Close other apps on the iPhone first, to leave as much memory as possible.

1. Open the app. If it's already open, pull down on the list to refresh it.
2. Tap `Qwen3.5-2B-Q4_K_M.gguf`.
3. Wait, and watch the **Status** section.

**You should see** `Loaded Qwen3.5-2B-Q4_K_M.gguf in ... s`, and a new **Try a prompt** section.

**If the app suddenly closes,** iOS probably stopped it for using too much memory. Write that down: it's a useful result, not a failure on your part.

## Part 6: Generate a reply (about 1 minute)

1. Under **Try a prompt**, tap `manipulation`.
2. Wait. **Status** says `Generating a reply to manipulation...` while it works.

**You should see:**

- A **Reply** section with text starting with `{`, containing words like `relation`, `decision` and `message`. The content itself doesn't matter yet.
- **Status** showing the token counts, like `449 prompt tokens, 90 reply tokens in ... s (stop)`.
- **No** warning about expected prompt tokens.

**If you got this far, the main goal is reached:** a language model is running on the iPhone.

## Part 7: Write down what happened

Please send the team this, for each model you tried:

| What | Example |
|---|---|
| iPhone model and iOS version | iPhone 13 Pro Max, iOS 18.1 |
| Model | Qwen 3.5 2B |
| Did it load? How long did it take? | Yes, 4.2 s |
| Did it generate? Status line | `449 prompt tokens, 90 reply tokens in 12.3 s (stop)` |
| Any warning, error or sudden close? | None |

**If you have time,** try the other models. Their file names and download locations are in [`models/registry.yaml`](../../models/registry.yaml). In order of size: Llama 3.2 3B (2.02 GB), Qwen 3.5 4B (2.74 GB) and Gemma 4 E2B (3.11 GB). A model that crashes the app is just as useful to know about as one that works.

## If something goes wrong

| Where | Problem | What to do |
|---|---|---|
| Part 1 | `error: Xcode not found` | Install Xcode from the App Store, open it once, and run `apps/ios/setup.sh` again |
| Part 1 | `Homebrew are both missing` | Install [Homebrew](https://brew.sh), and run `apps/ios/setup.sh` again |
| Part 1 | `apps/ios/setup.sh: No such file` | You're in the wrong folder: repeat the `cd` command, and check you're on the `main` branch with `git status` |
| Part 3 | *Signing requires a development team* | Repeat steps 1–4 of Part 3 |
| Part 3 | *Failed to register bundle identifier*, or the ID is taken | In `apps/ios/project.yml`, change `com.wilo.benchmark` to something unique, like `com.yourname.wilobench`. Run `apps/ios/setup.sh` again, then repeat Part 3 |
| Part 3 | *No such module 'llama'*, or `llama.xcframework` not found | Run `apps/ios/setup.sh` again, and close and reopen Xcode |
| Part 3 | The iPhone isn't listed in Xcode | Unlock it, reconnect the cable and tap **Trust** |
| Part 3 | The build fails with another error | Send the team the first red error from Xcode's Issue Navigator (Cmd+5), with your Xcode version |
| Part 4 | The download or checksum fails | Run the `curl` command again |
| Part 4 | No **Files** tab or no **WiloBench** in Finder | The app must be installed first (Part 3). Then reconnect the iPhone |
| Part 5 | The model isn't in the list | Pull down on the list to refresh it, and check that the file name ends in `.gguf` |
| Part 5 | `Could not load ...` | The file may be incomplete, or the app may need a newer llama.cpp. Check the checksum, copy it again, and send the team the message |
| Part 5 or 6 | The app suddenly closes | Write it down (Part 7). Close other apps and try once more |
| Part 6 | A warning about expected prompt tokens | Send the team the full status line |
| Part 6 | Very slow, or no reply after 5 minutes | Write it down (Part 7), including roughly how long you waited |
| Later | The app stops opening after 7 days | Normal with a free Apple ID: press **Run** in Xcode again |

These steps were written without access to a Mac, so a menu name may differ slightly. If a step is wrong, tell the team so it can be corrected here.

## For developers

- Don't change project settings in Xcode: the project is generated from [`project.yml`](project.yml), and changes are lost the next time it's generated. After changing `project.yml` or adding files, run `apps/ios/setup.sh` again.
- Running `setup.sh` regenerates the project, so choose your **Team** again afterwards (Part 3, step 4).
- The llama.cpp version is pinned in [`eval/llama_cpp.env`](../../eval/llama_cpp.env). The prompts are generated by [`eval/render_prompts.py`](../../eval/render_prompts.py).
