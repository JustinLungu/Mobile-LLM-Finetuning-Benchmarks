// Wilo's background script: keeps one session per site, asks the model when
// time is up, and records every negotiation in a local log.
//
// Chrome can stop this script whenever it is idle, so all state lives in
// chrome.storage, never in variables:
//   storage.session  sessions (per site), model status. Cleared when Chrome closes.
//   storage.local    settings (model, memory note) and the log. Kept.

import { CONFIG } from "./generated/config.js";
import { REPLY_SCHEMA, SITES, modelByKey, situationText, systemPrompt } from "./wilo.js";

// A session ends when no tab of the site has been open for this long.
const GONE_AFTER_MS = 2 * 60 * 1000;
const LOG_LIMIT = 5000;
// "Stay anyway" after a decline: Wilo never blocks completely (DECISIONS §5).
const OVERRIDE_MINUTES = 5;

// Content scripts read sessions directly to notice changes from other tabs.
chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });

// --- Storage helpers -------------------------------------------------------

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { modelKey: CONFIG.defaultModel, customModelUrl: "", memoryNote: "", ...(settings || {}) };
}

async function getSessions() {
  const { sessions } = await chrome.storage.session.get("sessions");
  return sessions || {};
}

async function updateSession(site, change) {
  const sessions = await getSessions();
  sessions[site] = change(sessions[site]);
  if (!sessions[site]) delete sessions[site];
  await chrome.storage.session.set({ sessions });
  return sessions[site];
}

async function appendLog(entry) {
  const { log = [] } = await chrome.storage.local.get("log");
  log.push({ at: new Date().toISOString(), ...entry });
  await chrome.storage.local.set({ log: log.slice(-LOG_LIMIT) });
}

// --- The model (lives in the offscreen page) --------------------------------

let creating = null;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length) return;
  creating ??= chrome.offscreen
    .createDocument({ url: "offscreen.html", reasons: ["WORKERS"], justification: "Runs Wilo's language model on this computer" })
    .finally(() => (creating = null));
  await creating;
}

async function modelToLoad() {
  const settings = await getSettings();
  if (settings.customModelUrl) {
    return { key: "custom", name: "Custom model", url: settings.customModelUrl, sizeBytes: 0 };
  }
  return modelByKey(settings.modelKey);
}

async function sendLoad() {
  const settings = await getSettings();
  return chrome.runtime.sendMessage({
    target: "offscreen",
    type: "load",
    model: await modelToLoad(),
    system: systemPrompt(settings.memoryNote),
    max_tokens: CONFIG.maxTokens,
  });
}

async function restartModel() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length) await chrome.offscreen.closeDocument();
  await chrome.storage.session.set({ model: { state: "starting" } });
  await ensureOffscreen(); // the new page says hello, and we answer with sendLoad()
}

// --- Asking Wilo -------------------------------------------------------------

function fallbackReply(reason) {
  return {
    relation: "vague",
    assessment: `No model reply (${reason}).`,
    decision: "counter_offer",
    minutes: 5,
    message: "My brain isn't ready yet, so here are 5 minutes. Let's check in again after that.",
  };
}

function parseReply(raw) {
  const reply = JSON.parse(raw);
  for (const field of REPLY_SCHEMA.required) {
    if (!(field in reply)) throw new Error(`missing ${field}`);
  }
  reply.minutes = Math.max(0, Math.min(240, Math.round(Number(reply.minutes) || 0)));
  // A grant of 0 minutes isn't a grant.
  if (reply.decision === "grant" && reply.minutes === 0) reply.minutes = 5;
  if (reply.decision === "decline") reply.minutes = 0;
  return reply;
}

async function askWilo(site, userSays) {
  const sessions = await getSessions();
  const session = sessions[site];
  if (!session) return { error: "no session" };
  const settings = await getSettings();
  const system = systemPrompt(settings.memoryNote);
  const user = situationText(session, userSays);

  const { model } = await chrome.storage.session.get("model");
  let reply, result = null, error = null;
  if (!model || model.state !== "ready") {
    error = `model ${model ? model.state : "not started"}`;
    reply = fallbackReply(error);
  } else {
    result = await chrome.runtime.sendMessage({ target: "offscreen", type: "generate", system, user, schema: REPLY_SCHEMA });
    try {
      if (!result || !result.ok) throw new Error(result ? result.error : "no answer from the model page");
      reply = parseReply(result.raw);
    } catch (e) {
      error = String(e.message || e);
      reply = fallbackReply("the reply couldn't be read");
    }
  }

  if (reply.decision === "grant") await extend(site, reply.minutes);
  if (reply.decision === "decline") await updateSession(site, (s) => s && { ...s, declines: s.declines + 1 });

  await appendLog({
    kind: "negotiation",
    site,
    app: session.app,
    situation: user,
    reply,
    raw: result && result.raw,
    error,
    model: result && result.model,
    ms: result && result.ms,
    timings: result && result.timings,
  });
  return { reply, fallback: !!error };
}

async function extend(site, minutes) {
  return updateSession(site, (s) => s && {
    ...s,
    endsAt: Date.now() + minutes * 60000,
    extensions: s.extensions + 1,
    declines: 0,
  });
}

// --- Messages from the content scripts, the popup and the offscreen page ----

const handlers = {
  // Offscreen page started: tell it which model to load.
  async hello() {
    sendLoad().catch(() => {});
    return {};
  },

  async "model-status"(msg) {
    const { from, type, ...status } = msg;
    await chrome.storage.session.set({ model: { ...status, updatedAt: Date.now() } });
    return {};
  },

  // A content script loaded on a watched site, or checks in.
  async status(msg) {
    await ensureOffscreen();
    const now = Date.now();
    const session = await updateSession(msg.site, (s) => {
      if (s && now - s.lastSeen > GONE_AFTER_MS) return undefined; // left long enough ago: new session
      return s && { ...s, lastSeen: now };
    });
    return { session: session || null, now };
  },

  async start(msg) {
    const minutes = Math.max(1, Math.min(240, Math.round(Number(msg.minutes) || 0)));
    const now = Date.now();
    const session = await updateSession(msg.site, () => ({
      app: SITES[msg.site] || msg.site,
      intent: String(msg.intent || "").slice(0, 200),
      next: String(msg.next || "").slice(0, 200),
      agreedMin: minutes,
      startedAt: now,
      endsAt: now + minutes * 60000,
      extensions: 0,
      declines: 0,
      lastSeen: now,
    }));
    await appendLog({ kind: "start", site: msg.site, app: session.app, intent: session.intent, minutes, next: session.next });
    return { session };
  },

  async ask(msg) {
    return askWilo(msg.site, String(msg.text || "").slice(0, 500));
  },

  // The user took Wilo's counter-offer.
  async accept(msg) {
    const minutes = Math.max(1, Math.min(240, Math.round(Number(msg.minutes) || 0)));
    const session = await extend(msg.site, minutes);
    await appendLog({ kind: "accepted", site: msg.site, minutes });
    return { session };
  },

  async override(msg) {
    const session = await extend(msg.site, OVERRIDE_MINUTES);
    await appendLog({ kind: "override", site: msg.site, minutes: OVERRIDE_MINUTES });
    return { session };
  },

  async done(msg, sender) {
    await updateSession(msg.site, () => undefined);
    await appendLog({ kind: "done", site: msg.site });
    if (sender.tab) await chrome.tabs.remove(sender.tab.id);
    return {};
  },

  async "end-session"(msg) {
    await updateSession(msg.site, () => undefined);
    return {};
  },

  // Popup: settings changed in a way that needs another model, or a new note.
  async "restart-model"() {
    await restartModel();
    return {};
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === "offscreen") return false; // meant for the model page
  const handler = handlers[msg.type];
  if (!handler) return false;
  handler(msg, sender).then(sendResponse, (e) => sendResponse({ error: String((e && e.message) || e) }));
  return true;
});

// Load the model as soon as Chrome starts, so the first reply is quick.
chrome.runtime.onStartup.addListener(() => ensureOffscreen());
chrome.runtime.onInstalled.addListener(() => restartModel());

// For debugging from the service worker's DevTools console (and dev/check_extension.py).
globalThis.wilo = { restartModel, handlers };
