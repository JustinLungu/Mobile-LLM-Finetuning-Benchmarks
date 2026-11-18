import { CONFIG } from "./generated/config.js";

const $ = (id) => document.getElementById(id);
const gb = (bytes) => (bytes / 1e9).toFixed(2) + " GB";

async function settings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { modelKey: CONFIG.defaultModel, customModelUrl: "", ...(settings || {}) };
}

async function saveSettings(change) {
  await chrome.storage.local.set({ settings: { ...(await settings()), ...change } });
}

// Plain words for testers; the technical detail goes in the small line below.
function showModel(model) {
  const fill = $("bar-fill");
  const bar = $("bar");
  const name = model && (CONFIG.models.find((m) => m.key === model.key) || { name: "Custom model" }).name;
  let text = "Starting…", detail = "", width = 0, showBar = true;
  if (!model) {
    text = "Starting…";
  } else if (model.state === "downloading") {
    const pct = model.total ? Math.round((100 * model.loaded) / model.total) : 0;
    text = `Getting Wilo ready: downloading ${pct}% of ${gb(model.total || 0)}`;
    detail = "Only the first time. If you close Chrome, it continues later." + (model.note ? ` (${model.note})` : "");
    width = pct;
  } else if (model.state === "warming") {
    text = "Almost ready…";
    detail = `${name}, ${model.note || "loading"}`;
    width = 100;
  } else if (model.state === "ready") {
    text = "✅ Wilo is ready";
    detail = `${name}, ${model.gpu ? "on the GPU" : "on the CPU"}` + (model.gpuNote ? ` (${model.gpuNote})` : "");
    showBar = false;
  } else if (model.state === "error") {
    text = "❌ Wilo couldn't start";
    detail = `${name}: ${model.error}`;
    showBar = false;
  }
  $("status").textContent = text;
  $("status-detail").textContent = detail;
  bar.style.display = showBar ? "block" : "none";
  fill.style.width = width + "%";
}

function showSessions(sessions) {
  const list = Object.values(sessions || {});
  if (!list.length) { $("sessions").textContent = "No open sessions."; return; }
  $("sessions").innerHTML = "";
  for (const s of list) {
    const left = Math.round((s.endsAt - Date.now()) / 60000);
    const div = document.createElement("div");
    div.textContent = `${s.app}: ${s.intent} (${left > 0 ? left + " min left" : "time's up"})`;
    $("sessions").appendChild(div);
  }
}

async function showLogCount() {
  const { log = [] } = await chrome.storage.local.get("log");
  const n = log.filter((e) => e.kind === "conversation").length;
  $("log-count").textContent = `${n} conversation${n === 1 ? "" : "s"} so far.`;
}

async function init() {
  const s = await settings();
  for (const m of CONFIG.models) $("model").add(new Option(`${m.name} (${gb(m.sizeBytes)})`, m.key));
  $("model").value = s.modelKey;
  $("custom-url").value = s.customModelUrl;

  const { model, sessions } = await chrome.storage.session.get(["model", "sessions"]);
  showModel(model);
  showSessions(sessions);
  showLogCount();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.model) showModel(changes.model.newValue);
    if (area === "session" && changes.sessions) showSessions(changes.sessions.newValue);
    if (area === "local" && changes.log) showLogCount();
    if (area === "local" && (changes.profile || changes.log)) showNote();
  });

  const showNote = async () => {
    const res = await chrome.runtime.sendMessage({ type: "memory-note" });
    $("note").textContent = (res && res.note) || "Nothing yet.";
  };
  showNote();
  $("redo").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "redo-questions" });
    $("redo").textContent = "Done: Wilo will ask on your next start screen.";
  });

  $("apply-model").addEventListener("click", async () => {
    const before = await settings();
    const change = { modelKey: $("model").value, customModelUrl: $("custom-url").value.trim() };
    if (change.modelKey === before.modelKey && change.customModelUrl === before.customModelUrl) {
      $("model-saved").textContent = "Already using this model.";
      return;
    }
    await saveSettings(change);
    await chrome.runtime.sendMessage({ type: "restart-model" });
    $("model-saved").textContent = "Switching model…";
  });

  $("time-up").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "time-up-now" });
    window.close();
  });

  $("download").addEventListener("click", async () => {
    const { log = [] } = await chrome.storage.local.get("log");
    const blob = new Blob([JSON.stringify(log, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `wilo-conversations-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  });

  $("clear").addEventListener("click", async () => {
    if (confirm("Delete all your saved conversations with Wilo? This can't be undone.")) {
      await chrome.storage.local.set({ log: [] });
    }
  });
}

init();
