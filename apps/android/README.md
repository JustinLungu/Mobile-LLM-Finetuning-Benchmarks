# Android benchmark app

An Android app that tests how small language models run on a real phone, the counterpart of the [iOS app](../ios/). Everything runs on the phone; nothing is sent anywhere.

**Today's goal:** get one model running on an Android phone and generating a reply. The app doesn't produce benchmark results yet.

No Android experience is needed. Follow the parts in order. Each one ends with what you should see. If you see something else, go to [If something goes wrong](#if-something-goes-wrong).

**Allow about an hour** the first time, plus the Android Studio download if it isn't installed yet.

## Before you start

**On the computer** (Linux, macOS or Windows):

- [Android Studio](https://developer.android.com/studio), installed and opened once. It's a big download, so do this ahead of time.
- Git. On Windows, run the commands below in **Git Bash**, which comes with [Git for Windows](https://git-scm.com/download/win).

**And one of these:**

- **An Android phone** with Android 9 or later, at least 2 GB free, and a USB cable. Use this for real results.
- **The emulator** built into Android Studio. Good for checking that everything works, but its speed and memory say nothing about phones.

## Part 1: Get the code (about 5 minutes)

Open a terminal and run these one at a time:

```bash
git clone https://github.com/JustinLungu/Mobile-LLM-Finetuning-Benchmarks.git
```
```bash
cd Mobile-LLM-Finetuning-Benchmarks
```
```bash
eval/fetch_llama_cpp.sh
```

The last command downloads the llama.cpp source code, which the app compiles itself.

**You should see** `llama.cpp b12078 (19e8a86...)` at the end.

## Part 2: Open the app in Android Studio (10–20 minutes the first time)

1. In Android Studio, choose **File → Open** (or **Open** on the welcome screen).
2. Select the `apps/android` folder inside the repository, not the repository itself, and click **OK**.
3. Wait while Android Studio prepares the project ("Gradle sync"). The progress bar is at the bottom of the window.
4. If it asks to install missing components or accept licences, such as **NDK** or **CMake**, accept and install them.
5. Choose **Build → Make Project**. The first build compiles llama.cpp and can take 10 minutes or more.

**You should see** *BUILD SUCCESSFUL* in the **Build** panel at the bottom.

## Part 3: Prepare a device (about 5 minutes)

**With an Android phone:**

1. On the phone, open **Settings → About phone** and tap **Build number** seven times. This turns on **Developer options**. On some phones, *Build number* is under **Software information**.
2. Go to **Settings → System → Developer options** (or search Settings for "Developer options"), and turn on **USB debugging**.
3. Connect the phone to the computer with the cable.
4. On the phone, allow USB debugging for this computer when asked. Tick **Always allow**.

**Or, with the emulator:**

1. In Android Studio, open **Device Manager** (the phone icon on the right edge, or **View → Tool Windows → Device Manager**).
2. Click **+**, then **Create Virtual Device**. Choose **Pixel 6a**, then a recent system image, and finish.
3. Before starting it, edit the device (pencil icon), and under **Additional settings** give it at least **4 GB of RAM** and **8 GB of internal storage**, so a model fits.

**You should see** your phone or emulator in the device list at the top of Android Studio.

## Part 4: Install the app (about 5 minutes)

1. At the top of Android Studio, choose your phone or emulator in the device list.
2. Press **Run** (the green triangle), or Shift+F10.

**You should see** the app open on the device, titled **Wilo Bench**, with *Models on this phone* saying *None yet* and a folder path, and a section *llama.cpp on this phone* with technical text.

**Without Android Studio:** every push to GitHub builds the app. On the repository's **Actions** tab, open the latest **Android build** run, and download **wilo-bench-debug-apk** under *Artifacts*. Unzip it, then install the `.apk` with `adb install app-debug.apk`, or copy it to the phone and open it there, allowing installs from unknown sources when asked.

## Part 5: Copy a model onto the device (about 15 minutes)

We start with Qwen 3.5 2B, the smallest model.

**Download it,** in the terminal, in the repository folder. It's 1.28 GB:

```bash
curl -L -o Qwen3.5-2B-Q4_K_M.gguf https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/f6d5376be1edb4d416d56da11e5397a961aca8ae/Qwen3.5-2B-Q4_K_M.gguf
```

**Check the download.** On Linux or Windows:

```bash
sha256sum Qwen3.5-2B-Q4_K_M.gguf
```

On macOS:

```bash
shasum -a 256 Qwen3.5-2B-Q4_K_M.gguf
```

**You should see** a long code starting with `aaf42c8b` and ending with `14699223`. If it's different, download it again.

**Copy it to the device,** with the app installed and the device connected:

```bash
adb push Qwen3.5-2B-Q4_K_M.gguf /sdcard/Android/data/com.wilo.benchmark/files/
```

`adb` comes with Android Studio. If the command isn't found, use its full path: `~/Android/Sdk/platform-tools/adb` on Linux, `~/Library/Android/sdk/platform-tools/adb` on macOS, or `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb` on Windows.

**You should see** a line ending in `1 file pushed` after a minute or two.

## Part 6: Load the model (about 1 minute)

Close other apps on the phone first, to leave as much memory as possible.

1. In the app, tap **Refresh list**.
2. Tap `Qwen3.5-2B-Q4_K_M.gguf`.
3. Wait, and watch the **Status** section.

**You should see** `Loaded Qwen3.5-2B-Q4_K_M.gguf in ... s.`, and a new **Try a prompt** section.

**If the app suddenly closes,** Android probably stopped it for using too much memory. Write that down: it's a useful result, not a failure on your part.

## Part 7: Generate a reply (about 1 minute)

1. Under **Try a prompt**, tap `manipulation`.
2. Wait. **Status** says `Generating a reply to manipulation...` while it works. On the emulator, this can take a few minutes.

**You should see:**

- Text below **Status** starting with `{`, containing words like `relation`, `decision` and `message`. The content itself doesn't matter yet.
- **Status** showing the token counts, like `449 prompt tokens, 90 reply tokens in ... s (stop).`
- **No** warning about expected prompt tokens.

**If you got this far, the main goal is reached:** a language model is running on the device.

## Part 8: Write down what happened

Please send the team this, for each model you tried:

| What | Example |
|---|---|
| Phone model and Android version, or "emulator" | Pixel 6a, Android 15 |
| Model | Qwen 3.5 2B |
| Did it load? How long did it take? | Yes, 4.2 s |
| Did it generate? Status line | `449 prompt tokens, 90 reply tokens in 12.3 s (stop).` |
| Any warning, error or sudden close? | None |

**If you have time,** try the other models. Their file names and download locations are in [`models/registry.yaml`](../../models/registry.yaml). In order of size: Llama 3.2 3B (2.02 GB), Qwen 3.5 4B (2.74 GB) and Gemma 4 E2B (3.11 GB). A model that crashes the app is just as useful to know about as one that works.

## If something goes wrong

| Where | Problem | What to do |
|---|---|---|
| Part 1 | `eval/fetch_llama_cpp.sh: No such file` | You're in the wrong folder: repeat the `cd` command |
| Part 2 | *llama.cpp source not found* | Run `eval/fetch_llama_cpp.sh` from the repository folder (Part 1), then **File → Sync Project with Gradle Files** |
| Part 2 | A message about licences, the NDK or CMake | Click the link in the message to install it, or install them under **Tools → SDK Manager → SDK Tools** (tick *Show Package Details*): NDK 29.0.13113456 and CMake 3.31.6 |
| Part 2 | Gradle sync fails with another error | Send the team the first error in the **Build** panel, with your Android Studio version |
| Part 3 | No *Developer options* | Tap **Build number** seven times again; Android says "You are now a developer" |
| Part 3 | The phone isn't in the device list | Reconnect the cable, unlock the phone, and allow USB debugging. Try another cable: some only charge |
| Part 5 | `adb: command not found` | Use the full path to `adb` given in Part 5 |
| Part 5 | `adb: no devices/emulators found` | Same as "The phone isn't in the device list" above |
| Part 5 | `Permission denied`, or the folder doesn't exist | Open the app once first (Part 4), so Android creates its folder |
| Part 5 | The emulator runs out of space | Give it more internal storage (Part 3, emulator step 3) |
| Part 6 | The model isn't in the list | Tap **Refresh list**, and check the `adb push` finished |
| Part 6 | `Could not load ...` | The file may be incomplete, or the app may need a newer llama.cpp. Check the checksum, push it again, and send the team the message |
| Part 6 or 7 | The app suddenly closes | Write it down (Part 8). Close other apps and try once more |
| Part 7 | A warning about expected prompt tokens | Send the team the full status line |
| Part 7 | Very slow, or no reply after 5 minutes | On the emulator this is normal. On a phone, write it down (Part 8), including roughly how long you waited |

These steps were written without testing on every phone, and menu names differ between Android brands. If a step is wrong, tell the team so it can be corrected here.

## For developers

- The app compiles llama.cpp from `third_party/llama.cpp` (git-ignored), at the version pinned in [`eval/llama_cpp.env`](../../eval/llama_cpp.env). Run `eval/fetch_llama_cpp.sh` again after changing it.
- The native code is in [`app/src/main/cpp/`](app/src/main/cpp/): a small JNI bridge in `wilo_bench.cpp`, called from `LlamaNative.kt`.
- The prompts come from [`spec/rendered_prompts.json`](../../spec/rendered_prompts.json), generated by [`eval/render_prompts.py`](../../eval/render_prompts.py).
- On real phones the app runs on the CPU. The emulator build (`x86_64`) is only for checking that the app works.
