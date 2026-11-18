import { CONFIG } from "./generated/config.js";

const $ = (id) => document.getElementById(id);
const gb = (bytes) => (bytes / 1e9).toFixed(2) + " GB";

async function settings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { modelKey: CONFIG.defaultModel, customModelUrl: "", memoryNote: "", ...(settings || {}) };
}

function showModel(model) {
  const fill = $("bar-fill");
  if (!model) { $("model-status").textContent = "Not started yet."; fill.style.width = "0"; return; }
  const name = (CONFIG.models.find((m) => m.key === model.key) || { name: model.key || "" }).name;
  if (model.state === "downloading") {
    const pct = model.total ? Math.round((100 * model.loaded) / model.total) : 0;
    $("model-status").textContent = `Downloading ${name}: ${pct}% of ${gb(model.total || 0)} (only the first time)` + (model.note ? ` – ${model.note}` : "");
    fill.style.width = pct + "%";
  } else if (model.state === "warming") {
    $("model-status").textContent = `Loading ${name}…`;
    fill.style.width = "100%";
  } else if (model.state === "ready") {
    const extras = [model.webgpu ? "GPU available" : "CPU only", model.multithread ? "multithreaded" : "single thread"].join(", ");
    $("model-status").textContent = `✅ ${name} ready (${extras})`;
    fill.style.width = "100%";
  } else if (model.state === "error") {
    $("model-status").textContent = `❌ ${name}: ${model.error}`;
    fill.style.width = "0";
  } else {
    $("model-status").textContent = "Starting…";
  }
}

function showSessions(sessions) {
  const list = Object.values(sessions || {});
  if (!list.length) { $("sessions").textContent = "No open sessions."; return; }
  $("sessions").innerHTML = "";
  for (const s of list) {
    const left = Math.round((s.endsAt - Date.now()) / 60000);
    const div = document.createElement("div");
    div.textContent = `${s.app}: ${s.intent} (${left > 0 ? left + " min left" : "time's up"}, ${s.extensions} extension${s.extensions === 1 ? "" : "s"})`;
    $("sessions").appendChild(div);
  }
}

async function showLogCount() {
  const { log = [] } = await chrome.storage.local.get("log");
  $("log-count").textContent = `${log.filter((e) => e.kind === "negotiation").length} negotiations so far.`;
}

async function init() {
  const s = await settings();
  for (const m of CONFIG.models) {
    const option = new Option(`${m.name} (${gb(m.sizeBytes)})${m.browserReady ? "" : " – too big for the browser yet"}`, m.key);
    option.disabled = !m.browserReady;
    $("model").add(option);
  }
  $("model").value = s.modelKey;
  $("custom-url").value = s.customModelUrl;
  $("memory").value = s.memoryNote;

  const { model, sessions } = await chrome.storage.session.get(["model", "sessions"]);
  showModel(model);
  showSessions(sessions);
  showLogCount();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.model) showModel(changes.model.newValue);
    if (area === "session" && changes.sessions) showSessions(changes.sessions.newValue);
    if (area === "local" && changes.log) showLogCount();
  });

  $("save").addEventListener("click", async () => {
    const before = await settings();
    const after = { modelKey: $("model").value, customModelUrl: $("custom-url").value.trim(), memoryNote: $("memory").value.trim() };
    await chrome.storage.local.set({ settings: after });
    const modelChanged = before.modelKey !== after.modelKey || before.customModelUrl !== after.customModelUrl;
    if (modelChanged) await chrome.runtime.sendMessage({ type: "restart-model" });
    $("saved").textContent = modelChanged ? "Saved. Loading the new model…" : "Saved.";
  });

  $("download").addEventListener("click", async () => {
    const { log = [] } = await chrome.storage.local.get("log");
    const blob = new Blob([JSON.stringify(log, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `wilo-log-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  });

  $("clear").addEventListener("click", async () => {
    if (confirm("Delete the whole log? This can't be undone.")) await chrome.storage.local.set({ log: [] });
  });
}

init();
