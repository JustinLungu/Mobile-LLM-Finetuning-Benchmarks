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
    if (area === "local" && changes.profile) showRules();
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

  // The user's free-time rules (stored in the profile, read by Wilo).
  const getProfile = async () => (await chrome.storage.local.get("profile")).profile || {};
  async function showRules() {
    const rules = (await getProfile()).rules || [];
    $("rules").innerHTML = "";
    if (!rules.length) $("rules").innerHTML = '<p class="hint">No rules yet.</p>';
    rules.forEach((r, i) => {
      const row = document.createElement("div");
      row.className = "rule";
      const label = document.createElement("span");
      label.textContent = `${r.days[0].toUpperCase() + r.days.slice(1)}, ${r.from}–${r.to}` + (r.why ? ` (${r.why})` : "");
      row.appendChild(label);
      const del = document.createElement("button");
      del.textContent = "Remove";
      del.addEventListener("click", async () => {
        const p = await getProfile();
        p.rules = (p.rules || []).filter((_, j) => j !== i);
        await chrome.storage.local.set({ profile: p });
        showRules();
      });
      row.appendChild(del);
      $("rules").appendChild(row);
    });
  }
  showRules();
  $("rule-add").addEventListener("click", async () => {
    const rule = { days: $("rule-days").value, from: $("rule-from").value, to: $("rule-to").value, why: $("rule-why").value };
    const res = await chrome.runtime.sendMessage({ type: "add-rule", rule, from: "popup" });
    if (res && res.rule) $("rule-why").value = "";
    showRules();
  });

  $("time-up").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "time-up-now" });
    window.close();
  });

  // Send to the team's SWITCHdrive folder; if that's not possible, fall back
  // to saving a file the tester emails us.
  const saveCopy = async () => {
    const { log = [] } = await chrome.storage.local.get("log");
    const blob = new Blob([JSON.stringify(log, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `wilo-conversations-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };
  const showSent = async () => {
    const { lastSent } = await chrome.storage.local.get("lastSent");
    const { id } = (await chrome.runtime.sendMessage({ type: "study-id" })) || {};
    $("sent").textContent = (lastSent ? `Last sent: ${new Date(lastSent).toLocaleString()}. ` : "") + (id ? `Your study ID: ${id}` : "");
  };
  showSent();
  $("download").addEventListener("click", async () => {
    if (!CONFIG.upload) {
      await saveCopy();
      $("sent").textContent = "Saved to your Downloads folder. Please email it to us.";
      return;
    }
    $("download").disabled = true;
    $("sent").textContent = "Sending…";
    const res = await chrome.runtime.sendMessage({ type: "send-log" });
    $("download").disabled = false;
    if (res && res.sentAt) {
      await showSent();
      $("sent").textContent = "✅ Sent, thank you! " + $("sent").textContent;
    } else {
      await saveCopy();
      $("sent").textContent = `❌ Couldn't send (${(res && res.error) || "no answer"}). We saved a file to your Downloads folder instead: please email it to us.`;
    }
  });
  $("save-copy").addEventListener("click", saveCopy);

  $("clear").addEventListener("click", async () => {
    if (confirm("Delete all your saved conversations with Wilo from this computer? This can't be undone. (To delete what you already sent, email us with your study ID.)")) {
      await chrome.storage.local.set({ log: [] });
    }
  });
}

init();
