// Runs the model with wllama (llama.cpp compiled to WebAssembly).
// Offscreen pages can only use chrome.runtime, so the background script tells
// this page what to load and what to answer.

import { Wllama } from "./vendor/index.js";

let wllama = null;
let loading = null; // Promise while a model loads
let current = null; // { key, url } of the loaded model
let maxTokens = 128;

// --- Downloading the model ---------------------------------------------------
// wllama can download by itself, but in one long stream: on a slow or flaky
// connection (we measured 0.7 MB/s, ~30 minutes for 1.3 GB) one dropped
// connection loses everything. Instead we save the file in 32 MB parts in the
// browser's private storage (OPFS): a failed part is retried, and a download
// interrupted by closing Chrome resumes where it stopped.

const PART_BYTES = 32 * 1024 * 1024;
const MAX_FAILURES = 8; // in a row, without any new part saved

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const partName = (i) => `part-${String(i).padStart(4, "0")}`;

async function folderFor(url) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url)));
  const id = [...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const root = await navigator.storage.getDirectory();
  const models = await root.getDirectoryHandle("wilo-models", { create: true });
  // Keep only the model in use: others take 1-3 GB each.
  for await (const name of models.keys()) {
    if (name !== id) await models.removeEntry(name, { recursive: true }).catch(() => {});
  }
  return models.getDirectoryHandle(id, { create: true });
}

async function fileSize(url, known) {
  if (known) return known;
  const head = await fetch(url, { method: "HEAD" });
  const size = Number(head.headers.get("content-length"));
  if (!head.ok || !size) throw new Error(`can't read the model's size (HTTP ${head.status})`);
  return size;
}

async function downloadModel(model, onProgress) {
  const dir = await folderFor(model.url);
  const total = await fileSize(model.url, model.sizeBytes);
  const nParts = Math.ceil(total / PART_BYTES);
  const sizeOf = (i) => Math.min(PART_BYTES, total - i * PART_BYTES);

  const done = [];
  for (let i = 0; i < nParts; i++) {
    const file = await dir.getFileHandle(partName(i)).then((h) => h.getFile(), () => null);
    done.push(!!file && file.size === sizeOf(i));
  }
  const savedBytes = () => done.reduce((sum, d, i) => sum + (d ? sizeOf(i) : 0), 0);

  let failures = 0;
  while (done.includes(false)) {
    const first = done.indexOf(false);
    try {
      // Ask for everything from the first missing part. Servers that ignore
      // Range (status 200) send the whole file; parts we have are skipped.
      const res = await fetch(model.url, { headers: { Range: `bytes=${first * PART_BYTES}-` } });
      if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
      let part = res.status === 206 ? first : 0;
      let chunks = [];
      let filled = 0;
      let lastReport = 0;
      const reader = res.body.getReader();
      while (part < nParts) {
        const { value, done: ended } = await reader.read();
        if (ended) throw new Error("connection closed early");
        let offset = 0;
        while (offset < value.length && part < nParts) {
          const take = Math.min(value.length - offset, sizeOf(part) - filled);
          if (!done[part]) chunks.push(value.subarray(offset, offset + take));
          filled += take;
          offset += take;
          if (filled === sizeOf(part)) {
            if (!done[part]) {
              const writable = await (await dir.getFileHandle(partName(part), { create: true })).createWritable();
              await writable.write(new Blob(chunks));
              await writable.close();
              done[part] = true;
              failures = 0;
            }
            chunks = [];
            filled = 0;
            part++;
          }
        }
        if (Date.now() - lastReport > 250) {
          lastReport = Date.now();
          onProgress(savedBytes() + (done[part] ? 0 : filled), total);
        }
      }
      reader.cancel().catch(() => {});
    } catch (e) {
      if (++failures > MAX_FAILURES) throw new Error(`download failed: ${e.message || e}`);
      onProgress(savedBytes(), total, `connection problem, retrying (${failures}/${MAX_FAILURES})`);
      await sleep(Math.min(30000, 1000 * 2 ** failures));
    }
  }
  onProgress(total, total);
  const files = [];
  for (let i = 0; i < nParts; i++) files.push(await (await dir.getFileHandle(partName(i))).getFile());
  // One Blob made of the parts; Chrome reads it from disk as needed.
  return new Blob(files);
}

function status(fields) {
  chrome.runtime.sendMessage({ from: "offscreen", type: "model-status", ...fields }).catch(() => {});
}

// Chrome can expose WebGPU (navigator.gpu) and still refuse to hand out a GPU,
// e.g. after a graphics driver hiccup, until Chrome restarts. wllama then
// fails without returning, so check for a real GPU ourselves first.
async function gpuAvailable() {
  try {
    return !!(navigator.gpu && (await navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

const withTimeout = (promise, ms, what) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} took over ${ms / 1000} s`)), ms))]);

// Load the model and process Wilo's rules once (warm-up), on the GPU when
// possible. Returns where it runs.
async function startEngine(file, system, useGpu) {
  timing.t0 = performance.now();
  if (wllama) await wllama.exit().catch(() => {});
  wllama = new Wllama({ default: chrome.runtime.getURL("vendor/wllama.wasm") }, { suppressNativeLog: true });
  await wllama.loadModel([file], {
    n_ctx: 4096, // room for a whole session's conversation
    reasoning: false, // Qwen and Gemma would otherwise "think" first: slower, and not what we trained
    ...(useGpu ? {} : { n_gpu_layers: 0 }), // 0 = CPU only
  });
  timing.loadMs = Math.round(performance.now() - timing.t0);
  // Process Wilo's rules once now, so the first real reply only has to read
  // the short situation: llama.cpp reuses the matching start. (Works for
  // Llama; Qwen 3.5's hybrid layers can only reuse an exact match, so for
  // Qwen this only warms up the engine.)
  await wllama.createChatCompletion({
    messages: [
      { role: "system", content: system },
      { role: "user", content: "Hi" },
    ],
    max_tokens: 1,
    temperature: 0,
  });
  timing.warmMs = Math.round(performance.now() - timing.t0) - timing.loadMs;
}

const timing = {};

async function load({ model, system, max_tokens }) {
  maxTokens = max_tokens || maxTokens;
  if (current && current.url === model.url) return;
  if (loading) return loading;
  loading = (async () => {
    try {
      status({ state: "downloading", key: model.key, loaded: 0, total: model.sizeBytes || 0 });
      const file = await downloadModel(model, (loaded, total, note) =>
        status({ state: "downloading", key: model.key, loaded, total, note }),
      );
      status({ state: "warming", key: model.key });
      let gpu = await gpuAvailable();
      let gpuNote = gpu ? "" : "no GPU available";
      if (gpu) {
        try {
          await withTimeout(startEngine(file, system, true), 180000, "loading on the GPU");
        } catch (e) {
          gpu = false;
          gpuNote = `GPU failed (${(e && e.message) || e}), using the CPU`;
        }
      }
      if (!gpu) await startEngine(file, system, false);
      current = { key: model.key, url: model.url };
      status({
        state: "ready",
        key: model.key,
        loadMs: timing.loadMs,
        warmMs: timing.warmMs,
        multithread: wllama.isMultithread(),
        gpu,
        gpuNote,
      });
    } catch (e) {
      current = null;
      status({ state: "error", key: model.key, error: String((e && e.message) || e) });
      throw e;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

async function generate({ messages, schema }) {
  if (loading) await loading;
  if (!current) throw new Error("model not loaded");
  const t0 = performance.now();
  const res = await wllama.createChatCompletion({
    messages,
    max_tokens: maxTokens,
    // Low but not zero: Wilo's wording varies a little between replies, while
    // its decisions stay stable.
    temperature: 0.3,
    response_format: { type: "json_schema", json_schema: { name: "wilo_reply", schema, strict: true } },
  });
  const raw = res.choices[0].message.content || "";
  return { raw, ms: Math.round(performance.now() - t0), timings: res.timings || null, model: current.key };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== "offscreen") return false;
  const job = msg.type === "load" ? load(msg) : msg.type === "generate" ? generate(msg) : null;
  if (!job) return false;
  job.then(
    (result) => sendResponse({ ok: true, ...(result || {}) }),
    (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }),
  );
  return true; // answer asynchronously
});

// Tell the background script this page is up; it replies with what to load.
chrome.runtime.sendMessage({ from: "offscreen", type: "hello" }).catch(() => {});
