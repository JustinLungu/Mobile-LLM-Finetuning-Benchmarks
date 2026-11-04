# iOS benchmark app

An iPhone app that measures how small language models run on a real phone: whether they load, how fast they answer and how much memory they use. Everything runs on the phone; nothing is sent anywhere.

**Status: early.** The app can load a model. Generating replies and producing results come next, and this page will grow with them.

## What you need

- A Mac with [Xcode](https://apps.apple.com/app/xcode/id497799835) installed. Open it once after installing, to finish its setup.
- [Homebrew](https://brew.sh), used to install XcodeGen automatically.
- An iPhone with iOS 16.4 or later, and a cable.
- An Apple ID. A free one is enough.

No Apple or iOS experience is needed.

## Set up the Mac

```bash
git clone https://github.com/JustinLungu/Mobile-LLM-Finetuning-Benchmarks.git
cd Mobile-LLM-Finetuning-Benchmarks
apps/ios/setup.sh
```

This takes a few minutes. It checks your tools, downloads the llama.cpp library (about 70 MB) and generates the Xcode project, then opens it in Xcode. It is safe to run again at any time.

## Run it on an iPhone

Most of this is only needed the first time.

**On the iPhone:**

1. Connect it to the Mac with the cable, and tap **Trust** if asked.
2. Turn on Developer Mode: **Settings → Privacy & Security → Developer Mode**. The phone restarts. If the option is missing, do step 5 below first; it appears once Xcode has seen the phone.

**In Xcode:**

3. In the left sidebar, click **WiloBench** at the very top. Then go to **Signing & Capabilities**.
4. Tick **Automatically manage signing**. Under **Team**, choose your Apple ID, or click **Add an Account** to sign in.
5. At the top of the window, click the device name and choose your iPhone.
6. Press **Run** (the play button, or Cmd+R). The first build takes a few minutes.

**Back on the iPhone, the first time only:**

7. If the app won't open because of an untrusted developer, go to **Settings → General → VPN & Device Management**, tap your Apple ID and tap **Trust**. Then press Run in Xcode again.

**It worked if** the app opens and shows the title *Wilo Bench* with an empty model list.

With a free Apple ID, the app stops opening after 7 days. Press Run again to reinstall it.

## Copy a model onto the iPhone

Start with Qwen 3.5 2B: it's the smallest model, at 1.28 GB. Make sure the iPhone has room for it.

**1. Download it on the Mac,** from the repository folder:

```bash
curl -L -o Qwen3.5-2B-Q4_K_M.gguf https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/f6d5376be1edb4d416d56da11e5397a961aca8ae/Qwen3.5-2B-Q4_K_M.gguf
shasum -a 256 Qwen3.5-2B-Q4_K_M.gguf
```

The checksum should start with `aaf42c8b` and end with `14699223`. Otherwise, download it again.

**2. Copy it to the iPhone,** with the app installed and the cable connected:

1. Open **Finder** and click your iPhone in the sidebar.
2. Open the **Files** tab and expand **WiloBench**.
3. Drag the `.gguf` file onto **WiloBench**, and wait for the copy to finish.

**3. Load it:** open the app and pull down on the list to refresh it. Tap the model.

**It worked if** the status says *Loaded Qwen3.5-2B-Q4_K_M.gguf in ... s*. If the app suddenly closes while loading, iOS probably stopped it for using too much memory. Please note that: it's a useful result.

The model files for the other models are listed in [`models/registry.yaml`](../../models/registry.yaml).

## If something goes wrong

| Problem | What to do |
|---|---|
| `error: Xcode not found` | Install Xcode from the App Store and open it once |
| `Homebrew are both missing` | Install [Homebrew](https://brew.sh) and run `apps/ios/setup.sh` again |
| *No such module 'llama'*, or `llama.xcframework` not found | Run `apps/ios/setup.sh` again, and close and reopen Xcode |
| *Failed to register bundle identifier*, or the ID is taken | In `project.yml`, change `com.wilo.benchmark` to something unique, like `com.yourname.wilobench`, and run `apps/ios/setup.sh` again |
| *Signing requires a development team* | Repeat steps 3 and 4 |
| The phone isn't listed in Xcode | Unlock it, reconnect the cable and tap **Trust** |
| The model doesn't appear in the app | Pull down on the list to refresh it, and check the file ends in `.gguf` |
| *Could not load ...* in the status | The file may be incomplete: check its checksum, and copy it again |
| The build fails with another error | Send the first red error from Xcode's Issue Navigator (Cmd+5), with your Xcode version |

## For developers

Don't change project settings in Xcode: the project is generated from [`project.yml`](project.yml), and changes made in Xcode are lost the next time it's generated. After changing `project.yml` or adding files, run `apps/ios/setup.sh` again.

The llama.cpp version is pinned in [`eval/llama_cpp.env`](../../eval/llama_cpp.env).
