// Wilo's background script: keeps one session per site, asks the model when
// time is up, and records every negotiation in a local log.
//
// Chrome can stop this script whenever it is idle, so all state lives in
// chrome.storage, never in variables:
//   storage.session  sessions (per site), model status. Cleared when Chrome closes.
//   storage.local    settings (model, memory note) and the log. Kept.

import { CONFIG } from "./generated/config.js";
import { PLAN_SCHEMA, REPLY_SCHEMA, SITES, capPlan, capReply, modelByKey, planText, situationText, systemPrompt } from "./wilo.js";
import { ONBOARDING, cleanRule, freeWindowNow, memoryNote, nextQuestion, recentSessions, recordAnswer } from "./memory.js";

// A session ends when no tab of the site has been open for this long.
const GONE_AFTER_MS = 2 * 60 * 1000;
const LOG_LIMIT = 5000;

// Content scripts read sessions directly to notice changes from other tabs.
chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });

// --- Storage helpers -------------------------------------------------------

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { modelKey: CONFIG.defaultModel, customModelUrl: "", ...(settings || {}) };
}

// What Wilo has learned about the user (memory.js): onboarding answers, facts
// from check-in questions, and which questions were asked.
async function getProfile() {
  const { profile } = await chrome.storage.local.get("profile");
  return { onboarding: { offered: false, answers: {} }, facts: [], asked: {}, ...(profile || {}) };
}

async function getLog() {
  const { log = [] } = await chrome.storage.local.get("log");
  return log;
}

// The memory note Wilo reads, written from the profile and the log.
async function currentNote() {
  return memoryNote(await getProfile(), await getLog());
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
  log.push({ at: new Date().toISOString(), version: chrome.runtime.getManifest().version, ...entry });
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
  return chrome.runtime.sendMessage({
    target: "offscreen",
    type: "load",
    model: await modelToLoad(),
    system: systemPrompt(await currentNote()),
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

// Wilo sees the whole conversation of the session, up to this many exchanges
// back (about 120 tokens each, well within the model's 4096-token window).
const HISTORY_TURNS = 12;

async function askWilo(site, userSays) {
  const sessions = await getSessions();
  const session = sessions[site];
  if (!session) return { error: "no session" };
  const system = systemPrompt(await currentNote());
  const user = situationText(session, userSays);
  // Earlier exchanges, in the same format: each user turn is the situation at
  // that moment plus what they said, each Wilo turn is its JSON reply.
  // Fallback replies (no model) are left out: Wilo never said them.
  const history = session.turns
    .filter((t) => t.raw)
    .slice(-HISTORY_TURNS)
    .flatMap((t) => [
      { role: "user", content: t.situation },
      { role: "assistant", content: t.raw },
    ]);
  const messages = [{ role: "system", content: system }, ...history, { role: "user", content: user }];

  const { model } = await chrome.storage.session.get("model");
  let reply, result = null, error = null;
  if (!model || model.state !== "ready") {
    error = `model ${model ? model.state : "not started"}`;
    reply = fallbackReply(error);
  } else {
    result = await chrome.runtime.sendMessage({ target: "offscreen", type: "generate", messages, schema: REPLY_SCHEMA });
    try {
      if (!result || !result.ok) throw new Error(result ? result.error : "no answer from the model page");
      reply = parseReply(result.raw);
    } catch (e) {
      error = String(e.message || e);
      reply = fallbackReply("the reply couldn't be read");
    }
  }

  // Safety net: limit how many minutes Wilo can give (see capReply).
  const capped = capReply(reply, session);
  reply = capped.reply;

  const turn = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    says: userSays,
    situation: user,
    raw: error ? null : result.raw, // what the model said
    reply, // what was applied (after the safety net)
    cappedFrom: capped.capped ? capped.modelMinutes : undefined,
    error,
    model: result && result.model,
    ms: result && result.ms,
  };
  await updateSession(site, (s) => s && {
    ...s,
    turns: [...s.turns, turn],
    declines: s.declines + (reply.decision === "decline" ? 1 : 0),
  });
  await appendLog({ kind: "negotiation", site, app: session.app, ...turn, historyTurns: history.length / 2, timings: result && result.timings });
  if (reply.decision === "grant") {
    await extend(site, reply.minutes);
    await closeConversation(site, "granted", reply.minutes);
  }
  return { reply, id: turn.id, fallback: !!error };
}

async function extend(site, minutes) {
  return updateSession(site, (s) => s && {
    ...s,
    endsAt: Date.now() + minutes * 60000,
    extensions: s.extensions + 1,
    declines: 0,
  });
}

// --- Reviewing the plan at the start ------------------------------------------
// Before a session exists, Wilo reads the user's plan and accepts it, offers
// less time, or asks something. The plan conversation lives in
// storage.session ("plans") and moves into the session once agreed, so Wilo
// still remembers it at time-up.

async function getPlans() {
  const { plans } = await chrome.storage.session.get("plans");
  return plans || {};
}

async function setPlan(site, plan) {
  const plans = await getPlans();
  if (plan) plans[site] = plan;
  else delete plans[site];
  await chrome.storage.session.set({ plans });
}

async function reviewPlan(site, userSays) {
  const plan = (await getPlans())[site];
  if (!plan) return { error: "no plan" };
  const note = await currentNote();
  const user = planText(plan, userSays);
  const history = plan.turns.filter((t) => t.raw).flatMap((t) => [
    { role: "user", content: t.situation },
    { role: "assistant", content: t.raw },
  ]);
  const messages = [{ role: "system", content: systemPrompt(note) }, ...history, { role: "user", content: user }];

  const { model } = await chrome.storage.session.get("model");
  let reply, result = null, error = null;
  if (!model || model.state !== "ready") {
    error = `model ${model ? model.state : "not started"}`;
    reply = { assessment: `No model reply (${error}).`, decision: "accept", minutes: plan.minutes, message: "I'm still waking up, so your plan starts as it is. Have a good one!" };
  } else {
    result = await chrome.runtime.sendMessage({ target: "offscreen", type: "generate", messages, schema: PLAN_SCHEMA });
    try {
      if (!result || !result.ok) throw new Error(result ? result.error : "no answer from the model page");
      reply = JSON.parse(result.raw);
      for (const f of PLAN_SCHEMA.required) if (!(f in reply)) throw new Error(`missing ${f}`);
    } catch (e) {
      error = String(e.message || e);
      reply = { assessment: "The reply couldn't be read.", decision: "accept", minutes: plan.minutes, message: "Sounds like a plan. Have a good one!" };
    }
  }
  const capped = capPlan(reply, plan);
  reply = capped.reply;
  const turn = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    phase: "start",
    says: userSays || null,
    situation: user,
    raw: error ? null : result.raw,
    reply,
    error,
    cappedFrom: capped.cappedFrom,
    model: result && result.model,
    ms: result && result.ms,
  };
  await setPlan(site, { ...plan, turns: [...plan.turns, turn] });
  await appendLog({ kind: "plan-review", site, app: plan.app, ...turn, timings: result && result.timings });
  return { reply, id: turn.id, fallback: !!error };
}

function newSession(app, intent, next, minutes, now, extra = {}) {
  return {
    app,
    intent,
    next,
    agreedMin: minutes,
    startedAt: now,
    endsAt: now + minutes * 60000,
    extensions: 0,
    declines: 0,
    lastSeen: now,
    turns: [], // every exchange with Wilo in this session
    conversationFrom: 0, // where the current time-up conversation starts in turns
    ...extra,
  };
}

// A session is over (the user clicked "I'm done", or left the site): record
// how it went. Wilo learns typical session lengths and patterns from these.
async function endSession(site, s, reason) {
  const started = new Date(s.startedAt);
  const endedAt = reason === "done" ? Date.now() : s.lastSeen;
  const answered = (s.turns || []).filter((t) => t.reply);
  const last = answered[answered.length - 1];
  await appendLog({
    kind: "session-end",
    site,
    app: s.app,
    intent: s.intent,
    next: s.next,
    agreedMin: s.agreedMin,
    usedMin: Math.max(0, Math.round((endedAt - s.startedAt) / 60000)),
    endedAt,
    lastDecision: last ? last.reply.decision : null,
    free: !!s.free,
    extensions: s.extensions,
    startHour: started.getHours(),
    weekday: started.getDay(),
    reason,
    fastForwarded: !!s.fastForwarded,
  });
  await updateSession(site, () => undefined);
}

// One time-up conversation is over: save it whole, with how it ended, as a
// ready-made example for fine-tuning (testers send us these logs).
async function closeConversation(site, outcome, minutes = 0) {
  const sessions = await getSessions();
  const s = sessions[site];
  if (!s) return;
  const turns = s.turns.slice(s.conversationFrom);
  if (turns.length) {
    const note = await currentNote();
    await appendLog({
      kind: "conversation",
      site,
      app: s.app,
      intent: s.intent,
      next: s.next,
      agreedMin: s.agreedMin,
      usedMin: Math.round((Date.now() - s.startedAt) / 60000),
      outcome, // granted, took offer, done
      fastForwarded: !!s.fastForwarded, // "Time's up now" was used: not a real time-up
      minutes,
      memoryNote: note,
      system: systemPrompt(note),
      turns: turns.map(({ id, says, situation, raw, reply, error, model }) => ({ id, says, situation, raw, reply, error, model })),
    });
  }
  await updateSession(site, (x) => x && { ...x, conversationFrom: x.turns.length });
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

  // A content script loaded on a watched site, or checks in. Without a session
  // the start screen shows, with the onboarding (first time only) or at most
  // one optional check-in question.
  async status(msg) {
    await ensureOffscreen();
    const now = Date.now();
    const before = (await getSessions())[msg.site];
    if (before && now - before.lastSeen > GONE_AFTER_MS) await endSession(msg.site, before, "left"); // left long enough ago: new session
    const session = await updateSession(msg.site, (s) => s && { ...s, lastSeen: now });
    if (session) return { session, now };
    const profile = await getProfile();
    const log = await getLog();
    const app = SITES[msg.site] || msg.site;

    // Inside one of the user's free-time windows: no questions, a session runs
    // until the window ends (then the normal time-up).
    const free = freeWindowNow(profile.rules, new Date(now));
    if (free) {
      const started = await updateSession(msg.site, () => newSession(app, "Free time (your rule)", "", free.minutesLeft, now, { free: true }));
      const d = new Date(now);
      await appendLog({ kind: "start", site: msg.site, app, intent: started.intent, minutes: free.minutesLeft, next: "", hour: d.getHours(), weekday: d.getDay(), free: true });
      const hobby = profile.onboarding.answers && profile.onboarding.answers.hobby;
      return { session: started, now, freeStart: { until: free.rule.to, hobby: hobby || null } };
    }

    const onboarding = profile.onboarding.offered ? null : ONBOARDING;
    const question = onboarding ? null : nextQuestion(profile, log, { app, now: new Date() });
    // Back soon after a session: the start screen reminds them what they said.
    const recent = recentSessions(log, now, 1).pop();
    const welcomeBack = recent && {
      app: recent.app,
      minutesAgo: Math.max(0, Math.round((now - recent.endedAt) / 60000)),
      next: recent.next || null,
      lastDecision: recent.lastDecision || null,
    };
    const plan = (await getPlans())[msg.site] || null;
    return { session: null, now, onboarding, question, welcomeBack, plan };
  },

  // First start screen: the three tap questions, or null if skipped.
  async onboarding(msg) {
    const answers = msg.answers && typeof msg.answers === "object" ? msg.answers : {};
    const profile = await getProfile();
    // The onboarding counts as today's questions: no check-in question until tomorrow.
    await chrome.storage.local.set({ profile: { ...profile, onboarding: { offered: true, answers }, lastQuestionDay: new Date().toDateString() } });
    await appendLog({ kind: "onboarding", answers, skipped: !msg.answers });
    return {};
  },

  // A check-in question was shown: that's today's one.
  async "question-shown"() {
    const profile = await getProfile();
    await chrome.storage.local.set({ profile: { ...profile, lastQuestionDay: new Date().toDateString() } });
    return {};
  },

  // Answered (option index) or skipped (-1).
  async answer(msg) {
    const q = msg.question;
    if (!q || !q.key || !Array.isArray(q.options)) return {};
    const text = String(msg.text || "").trim().slice(0, 300);
    const profile = recordAnswer(await getProfile(), q, Number(msg.option), text);
    await chrome.storage.local.set({ profile });
    const option = q.options[Number(msg.option)];
    await appendLog({ kind: "question", key: q.key, question: q.text, answer: text || (option ? option.label : "skipped"), typed: !!text });
    return {};
  },

  // A free-time rule added from the page or the popup.
  async "add-rule"(msg) {
    const rule = cleanRule(msg.rule);
    if (!rule) return { error: "invalid rule" };
    const profile = await getProfile();
    await chrome.storage.local.set({ profile: { ...profile, rules: [...(profile.rules || []), rule] } });
    await appendLog({ kind: "rule", rule, from: msg.from || "page" });
    return { rule };
  },

  async "no-questions"() {
    const profile = await getProfile();
    await chrome.storage.local.set({ profile: { ...profile, noQuestions: true } });
    await appendLog({ kind: "question", answer: "don't ask me questions" });
    return {};
  },

  // Popup: what Wilo knows, and starting over.
  async "memory-note"() {
    return { note: await currentNote() };
  },

  async "redo-questions"() {
    const profile = await getProfile();
    await chrome.storage.local.set({ profile: { ...profile, onboarding: { offered: false, answers: {} }, noQuestions: false } });
    return {};
  },

  async start(msg) {
    const minutes = Math.max(1, Math.min(240, Math.round(Number(msg.minutes) || 0)));
    const now = Date.now();
    const session = await updateSession(msg.site, () =>
      newSession(SITES[msg.site] || msg.site, String(msg.intent || "").slice(0, 200), String(msg.next || "").slice(0, 200), minutes, now),
    );
    const d = new Date(now);
    await appendLog({ kind: "start", site: msg.site, app: session.app, intent: session.intent, minutes, next: session.next, hour: d.getHours(), weekday: d.getDay() });
    return { session };
  },

  // The start screen's plan: Wilo reviews it before the session starts.
  async plan(msg) {
    const minutes = Math.max(1, Math.min(240, Math.round(Number(msg.minutes) || 0)));
    await setPlan(msg.site, {
      app: SITES[msg.site] || msg.site,
      intent: String(msg.intent || "").slice(0, 200),
      next: String(msg.next || "").slice(0, 200),
      minutes,
      turns: [],
    });
    return reviewPlan(msg.site, null);
  },

  // The user answers Wilo's question or explains more about the plan.
  async "plan-reply"(msg) {
    return reviewPlan(msg.site, String(msg.text || "").slice(0, 500));
  },

  // The plan is agreed: start the session with the agreed minutes. The plan
  // conversation becomes the start of the session's history.
  async "plan-accept"(msg) {
    const plan = (await getPlans())[msg.site];
    if (!plan) return { error: "no plan" };
    const minutes = Math.max(1, Math.min(plan.minutes, Math.round(Number(msg.minutes) || plan.minutes)));
    const now = Date.now();
    const session = await updateSession(msg.site, () => ({
      ...newSession(plan.app, plan.intent, plan.next, minutes, now),
      turns: plan.turns,
      conversationFrom: plan.turns.length,
      plannedMin: plan.minutes,
    }));
    await setPlan(msg.site, null);
    const d = new Date(now);
    await appendLog({ kind: "start", site: msg.site, app: plan.app, intent: plan.intent, minutes, plannedMin: plan.minutes, next: plan.next, hour: d.getHours(), weekday: d.getDay() });
    const note = await currentNote();
    await appendLog({
      kind: "conversation",
      phase: "start",
      site: msg.site,
      app: plan.app,
      intent: plan.intent,
      next: plan.next,
      plannedMin: plan.minutes,
      outcome: minutes === plan.minutes ? "plan accepted" : "took offer",
      minutes,
      memoryNote: note,
      system: systemPrompt(note),
      turns: plan.turns.map(({ id, says, situation, raw, reply, error, model }) => ({ id, says, situation, raw, reply, error, model })),
    });
    return { session };
  },

  async ask(msg) {
    return askWilo(msg.site, String(msg.text || "").slice(0, 500));
  },

  // The user took Wilo's counter-offer.
  async accept(msg) {
    const minutes = Math.max(1, Math.min(240, Math.round(Number(msg.minutes) || 0)));
    const session = await extend(msg.site, minutes);
    await closeConversation(msg.site, "took offer", minutes);
    return { session };
  },


  async done(msg, sender) {
    // Still discussing the plan: save that conversation and drop the plan.
    const plan = (await getPlans())[msg.site];
    if (plan) {
      const note = await currentNote();
      await appendLog({
        kind: "conversation", phase: "start", site: msg.site, app: plan.app, intent: plan.intent, next: plan.next,
        plannedMin: plan.minutes, outcome: "done", minutes: 0, memoryNote: note, system: systemPrompt(note),
        turns: plan.turns.map(({ id, says, situation, raw, reply, error, model }) => ({ id, says, situation, raw, reply, error, model })),
      });
      await setPlan(msg.site, null);
    }
    await closeConversation(msg.site, "done");
    const s = (await getSessions())[msg.site];
    if (s) await endSession(msg.site, s, "done");
    if (sender.tab) await chrome.tabs.remove(sender.tab.id);
    return {};
  },

  // 👍 or 👎 on one of Wilo's replies.
  async feedback(msg) {
    await appendLog({ kind: "feedback", site: msg.site, id: String(msg.id), good: !!msg.good });
    return {};
  },

  // Popup, for testing: end the time of every open session now.
  // Fast-forwards the whole session (start and end), as if the planned time had
  // passed, so "time used" matches the plan for the screen and for Wilo.
  // Marked in the log so these can be told apart from real sessions.
  async "time-up-now"() {
    const sessions = await getSessions();
    const now = Date.now();
    for (const s of Object.values(sessions)) {
      const skip = Math.max(0, s.endsAt - now);
      s.startedAt -= skip;
      s.endsAt -= skip;
      s.fastForwarded = true;
    }
    await chrome.storage.session.set({ sessions });
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

  // Popup: send the whole log to the team's upload-only SWITCHdrive folder.
  // Done here, not in the popup, so it finishes even if the popup closes.
  async "send-log"() {
    if (!CONFIG.upload) return { error: "not set up" };
    const id = await studyId();
    const name = `wilo-${id}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const body = JSON.stringify({ studyId: id, version: chrome.runtime.getManifest().version, log: await getLog() }, null, 2);
    const res = await fetch(`${CONFIG.upload.base}/public.php/dav/files/${CONFIG.upload.token}/${name}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
      body,
    });
    if (!res.ok) throw new Error(`upload failed (HTTP ${res.status})`);
    const sentAt = new Date().toISOString();
    await chrome.storage.local.set({ lastSent: sentAt });
    return { sentAt, file: name };
  },

  async "study-id"() {
    return { id: await studyId() };
  },
};

// A random ID per install, so the team can tell testers' files apart (and
// delete someone's data on request) without knowing who they are.
async function studyId() {
  let { studyId: id } = await chrome.storage.local.get("studyId");
  if (!id) {
    id = crypto.randomUUID().slice(0, 8);
    await chrome.storage.local.set({ studyId: id });
  }
  return id;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === "offscreen") return false; // meant for the model page
  const handler = handlers[msg.type];
  if (!handler) return false;
  handler(msg, sender).then(sendResponse, (e) => sendResponse({ error: String((e && e.message) || e) }));
  return true;
});

// Chrome only adds content scripts to pages opened after the extension is
// installed or updated. Add Wilo to tabs already open on watched sites, so
// nobody has to reload them. Right after an update Chrome is still tearing
// down the old version's scripts, and a copy added at that moment can be torn
// down with it ("Extension context invalidated"), however long we wait first.
// So: ask the tab whether a working copy is there, add one only if not, and
// check again a few seconds later.
const WATCHED = chrome.runtime.getManifest().content_scripts[0];

async function hasWilo(tabId) {
  try {
    const answer = await chrome.tabs.sendMessage(tabId, { type: "wilo-ping" });
    return !!(answer && answer.alive);
  } catch {
    return false; // nothing listening in that tab
  }
}

async function ensureWilo(tabId) {
  if (await hasWilo(tabId)) return;
  await chrome.scripting.executeScript({ target: { tabId }, files: WATCHED.js }).catch(() => {});
}

async function ensureWiloInOpenTabs() {
  const tabs = await chrome.tabs.query({ url: WATCHED.matches });
  await Promise.all(tabs.map((tab) => ensureWilo(tab.id)));
}

// Also when the user switches to a watched tab: covers any tab missed above.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const [match] = await chrome.tabs.query({ url: WATCHED.matches }).then((tabs) => tabs.filter((t) => t.id === tabId));
  if (match) ensureWilo(tabId);
});

// Load the model as soon as Chrome starts, so the first reply is quick.
chrome.runtime.onStartup.addListener(() => ensureOffscreen());
chrome.runtime.onInstalled.addListener((details) => {
  console.log(`[wilo] installed (${details.reason})`);
  restartModel();
  for (const delay of [1500, 5000, 12000]) setTimeout(ensureWiloInOpenTabs, delay);
});

// For debugging from the service worker's DevTools console (and dev/check_extension.py).
globalThis.wilo = { restartModel, handlers, currentNote, getProfile, memoryNote, nextQuestion, capReply };
