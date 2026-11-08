# Android benchmark app

An Android app that tests how small language models run on a real phone, the counterpart of the [iOS app](../ios/). Everything runs on the phone; nothing is sent anywhere.

**Status: early.** The app builds llama.cpp and shows what it detects on the phone, but doesn't run models yet. A step-by-step guide will follow.

Android apps can be built on Linux, macOS or Windows with [Android Studio](https://developer.android.com/studio). First get the llama.cpp source, from the repository root:

```bash
eval/fetch_llama_cpp.sh
```

Then open this `apps/android` folder in Android Studio. The first build compiles llama.cpp and takes several minutes.

To try a model, copy its `.gguf` file into the app's folder on the phone or emulator. With the device connected and USB debugging on:

```bash
adb push Qwen3.5-2B-Q4_K_M.gguf /sdcard/Android/data/com.wilo.benchmark/files/
```

Then tap **Refresh list** in the app, and tap the model.
