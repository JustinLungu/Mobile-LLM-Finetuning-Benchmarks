// Wilo's background script: keeps one session per site, asks the model when
// time is up, and records every negotiation in a local log.
//
// Chrome can stop this script whenever it is idle, so all state lives in
// chrome.storage, never in variables:
//   storage.session  sessions (per site), model status. Cleared when Chrome closes.
//   storage.local    settings (model, memory note), the log, and a copy of
//                    the open sessions (openState). Kept.

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

// What's open (sessions, plans, which tab shows which site) lives in
// storage.session, which Chrome empties when it quits and when the extension
// is updated or reloaded. Every change is also copied to storage.local
// ("openState"), so the next start can end what was left open, and an update
// can put it back. Done here, in the same step as the write, rather than in a
// storage.onChanged listener: a listener runs later, out of order with the
// queued tab events, and may not run at all when Chrome is quitting.
// Not copied until boot() has settled the old copy ("booted"), so an early
// write can't overwrite what is still to be settled.
async function saveOpen(values) {
  await chrome.storage.session.set(values);
  const { booted, ...open } = await chrome.storage.session.get(["sessions", "plans", "tabSites", "tabSeen", "booted"]);
  if (booted) await chrome.storage.local.set({ openState: open });
}

async function getSessions() {
  const { sessions } = await chrome.storage.session.get("sessions");
  return sessions || {};
}

async function updateSession(site, change) {
  const sessions = await getSessions();
  sessions[site] = change(sessions[site]);
  if (!sessions[site]) delete sessions[site];
  await saveOpen({ sessions });
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
  // Added to the session as it is now (re-read in serial): a check-in may
  // have changed it while Wilo was thinking. If it ended meanwhile, it stays ended.
  await serial(() => updateSession(site, (s) => s && {
    ...s,
    turns: [...s.turns, turn],
    declines: s.declines + (reply.decision === "decline" ? 1 : 0),
  }));
  await appendLog({ kind: "negotiation", site, app: session.app, ...turn, historyTurns: history.length / 2, timings: result && result.timings });
  if (reply.decision === "grant") await serial(() => grant(site, reply.minutes, "granted"));
  return { reply, id: turn.id, fallback: !!error };
}

// More time agreed: extend the session and save the time-up conversation.
// Not queued itself: callers run it in serial.
async function grant(site, minutes, outcome) {
  const session = await extend(site, minutes);
  await closeConversation(site, outcome, minutes);
  return session;
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
  await saveOpen({ plans });
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
  // Add the turn to the plan as it is now: the user may have left (or come
  // back) while Wilo was thinking. If the plan ended meanwhile, it stays ended.
  await serial(async () => {
    const current = (await getPlans())[site];
    if (current) await setPlan(site, { ...current, turns: [...current.turns, turn] });
  });
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
// how: how they left (closed-tab, navigated-away, ..., unknown), null for done.
async function endSession(site, s, reason, how = null) {
  const started = new Date(s.startedAt);
  const endedAt = reason === "done" ? Date.now() : (s.leftAt ?? s.lastSeen);
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
    how,
    fastForwarded: !!s.fastForwarded,
  });
  await updateSession(site, () => undefined);
}

// One time-up conversation is over: save it whole, with how it ended, as a
// ready-made example for fine-tuning (testers send us these logs).
// endedAt: when it ended, earlier than now if the user left the site.
async function closeConversation(site, outcome, minutes = 0, endedAt = Date.now()) {
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
      usedMin: Math.round((endedAt - s.startedAt) / 60000),
      outcome, // granted, took offer, done, left
      fastForwarded: !!s.fastForwarded, // "Time's up now" was used: not a real time-up
      minutes,
      memoryNote: note,
      system: systemPrompt(note),
      turns: turns.map(({ id, says, situation, raw, reply, error, model }) => ({ id, says, situation, raw, reply, error, model })),
    });
  }
  await updateSession(site, (x) => x && { ...x, conversationFrom: x.turns.length });
}

// The plan conversation at the start, saved whole when it ends without a
// session (I'm done, or the user left).
async function logPlanConversation(site, plan, outcome) {
  const note = await currentNote();
  await appendLog({
    kind: "conversation", phase: "start", site, app: plan.app, intent: plan.intent, next: plan.next,
    plannedMin: plan.minutes, outcome, minutes: 0, memoryNote: note, system: systemPrompt(note),
    turns: plan.turns.map(({ id, says, situation, raw, reply, error, model }) => ({ id, says, situation, raw, reply, error, model })),
  });
}

// --- Leaving the site ----------------------------------------------------------
// The background knows which tab shows which watched site ("tabSites" in
// storage.session, from each tab's check-ins). When the last tab of a site is
// closed or goes elsewhere, the user left: log it right away, then wait
// GONE_AFTER_MS (an alarm) before ending the session, so coming back quickly
// continues it.
//
// Tab events and check-ins arrive in any order, and each step reads then
// writes storage, so they run one at a time. The queue lives in a variable:
// if Chrome stops this script, nothing is in it anymore. Each time the script
// starts, the first step is boot() (below).
let queue = null;

function serial(task) {
  if (!queue) queue = boot().catch(() => {});
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

// Every read-then-write of what's open (sessions, plans, tabSites, tabSeen)
// runs in serial, or a check-in's write (lastSeen) could put back what it read
// just before: a session just started, a grant, a turn. The helpers
// (updateSession, setPlan, closeConversation, endSession, endLeft...) are not
// queued themselves, since queued steps call them: a step waiting for a later
// step in the same queue would wait forever. So callers outside the queue
// wrap them, and never wait for the model inside it.

const GONE_ALARM = "wilo-gone:";
const goneAlarm = (site) => GONE_ALARM + site;

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null; // no URL: Chrome hides it on sites Wilo has no access to
  }
}

// { [tabId]: site }, or null for a tab Wilo is closing itself (I'm done).
async function getTabSites() {
  const { tabSites } = await chrome.storage.session.get("tabSites");
  return tabSites || {};
}

// Is this tab showing this site right now? A check-in can arrive late, from a
// tab that was just closed or has moved on, or from a page loading in the
// background (prerender) that the user hasn't seen.
async function tabOnSite(tabId, site) {
  try {
    return hostOf((await chrome.tabs.get(tabId)).url) === site;
  } catch {
    return false; // tab gone
  }
}

async function trackTab(tabId, site, now) {
  const tabSites = await getTabSites();
  const old = tabSites[tabId];
  if (old === null || old === site) return;
  tabSites[tabId] = site;
  await saveOpen({ tabSites });
  // Went from one watched site to another before we saw the move.
  if (old) await leaveIfLast(old, "navigated-away", now);
}

async function untrackTab(tabId, how, now) {
  const tabSites = await getTabSites();
  if (!(tabId in tabSites)) return;
  const site = tabSites[tabId];
  delete tabSites[tabId];
  await saveOpen({ tabSites });
  if (site) await leaveIfLast(site, how, now);
}

// When each tracked tab last checked in ("tabSeen", { [tabId]: ms }). At the
// next start this tells a page that survived an update (loaded before then)
// from a new one with a repeated tab id, and dates a quit on the start screen.
async function seeTab(tabId, now) {
  const { tabSeen = {} } = await chrome.storage.session.get("tabSeen");
  const tabSites = await getTabSites();
  for (const id of Object.keys(tabSeen)) if (!(id in tabSites)) delete tabSeen[id]; // closed since
  tabSeen[tabId] = now;
  await saveOpen({ tabSeen });
}

async function markClosing(tabId) {
  const tabSites = await getTabSites();
  tabSites[tabId] = null;
  await saveOpen({ tabSites });
}

async function leaveIfLast(site, how, now) {
  if (Object.values(await getTabSites()).includes(site)) return; // another tab still has it
  await logLeave(site, how, now);
}

// Where the user was when they left.
function leaveStage(s, plan, now) {
  if (s) return now >= s.endsAt ? "time-up" : "session";
  return plan ? "plan-review" : "start-screen";
}

// The user left the site: log it now, with what was going on, and start the
// grace period if there's a session or a plan to come back to.
// extra: more fields for the entry (approx: true when the time is a guess).
async function logLeave(site, how, now, extra = {}) {
  const s = (await getSessions())[site];
  const plan = (await getPlans())[site];
  const stage = leaveStage(s, plan, now);
  const entry = { kind: "leave", site, app: (s || plan || {}).app || SITES[site] || site, how, stage, leftAt: now, ...extra };
  if (s) {
    Object.assign(entry, {
      intent: s.intent,
      agreedMin: s.agreedMin,
      usedMin: Math.max(0, Math.round((now - s.startedAt) / 60000)),
      minutesOver: stage === "time-up" ? Math.max(0, Math.round((now - s.endsAt) / 60000)) : undefined,
      inConversation: s.turns.length > s.conversationFrom, // time-up talk not saved yet
      free: !!s.free,
      fastForwarded: !!s.fastForwarded,
    });
  } else if (plan) {
    Object.assign(entry, { intent: plan.intent, plannedMin: plan.minutes, planTurns: plan.turns.length });
  }
  await appendLog(entry);
  if (!s && !plan) return; // start screen: nothing to come back to
  if (s) await updateSession(site, (x) => x && { ...x, leftAt: now, leftHow: how });
  if (plan) await setPlan(site, { ...plan, leftAt: now, leftHow: how });
  await chrome.alarms.create(goneAlarm(site), { when: now + GONE_AFTER_MS });
}

// Back within the grace period: the session (or plan) just continues.
async function logReturn(site, leftAt, now) {
  const s = (await getSessions())[site];
  const plan = (await getPlans())[site];
  await appendLog({ kind: "return", site, app: (s || plan || {}).app || SITES[site] || site, awayS: Math.round((now - leftAt) / 1000) });
  const stay = ({ leftAt: _at, leftHow: _how, ...rest }) => rest;
  if (s) await updateSession(site, (x) => x && stay(x));
  if (plan) await setPlan(site, stay(plan));
  await chrome.alarms.clear(goneAlarm(site));
}

// The user left and didn't come back in time: save the conversation that was
// going on (plan review or time-up), then end the plan and the session as of
// when they left. The one way a left site ends (alarm, next check-in, startup).
async function endLeft(site) {
  const plan = (await getPlans())[site];
  if (plan) {
    await logPlanConversation(site, plan, "left");
    await setPlan(site, null);
  }
  const s = (await getSessions())[site];
  if (s) {
    await closeConversation(site, "left", 0, s.leftAt ?? s.lastSeen);
    await endSession(site, (await getSessions())[site], "left", s.leftHow || "unknown");
  }
  await chrome.alarms.clear(goneAlarm(site));
}

// A tab of this site checked in: track it, then settle any earlier leave.
// Returns the session, if one is running.
async function checkIn(site, tab, now) {
  const live = !!tab && (await tabOnSite(tab.id, site));
  if (live) {
    await trackTab(tab.id, site, now);
    await seeTab(tab.id, now);
  }
  const s = (await getSessions())[site];
  const plan = (await getPlans())[site];
  const leftAt = (s && s.leftAt) ?? (plan && plan.leftAt);
  if (leftAt && now - leftAt > GONE_AFTER_MS) await endLeft(site); // left long enough ago: new session
  else if (leftAt && live) await logReturn(site, leftAt, now);
  // No leave seen (e.g. the computer slept), but no check-in for too long.
  else if (s && !s.leftAt && now - s.lastSeen > GONE_AFTER_MS) await endLeft(site);
  // Plans too, so a quit during the plan review has a time to log.
  const p = (await getPlans())[site];
  if (p) await setPlan(site, { ...p, lastSeen: now });
  return updateSession(site, (x) => x && { ...x, lastSeen: now });
}

chrome.tabs.onRemoved.addListener((tabId, { isWindowClosing }) => {
  const now = Date.now();
  serial(() => untrackTab(tabId, isWindowClosing ? "closed-window" : "closed-tab", now));
});

// A tracked tab now shows another site (its URL is hidden from Wilo on sites
// it has no access to). Reloads and moves within the site don't count.
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!("url" in change) && !("status" in change)) return;
  const now = Date.now();
  serial(async () => {
    const site = (await getTabSites())[tabId];
    if (site && hostOf(tab.url) !== site) await untrackTab(tabId, "navigated-away", now);
  });
});

// Chrome swapped a tab for another (e.g. a page loaded ahead of time): same tab for the user.
chrome.tabs.onReplaced.addListener((addedId, removedId) => {
  serial(async () => {
    const tabSites = await getTabSites();
    if (!(removedId in tabSites)) return;
    tabSites[addedId] = tabSites[removedId];
    delete tabSites[removedId];
    await saveOpen({ tabSites });
  });
});

// The grace period is over: end the session unless the user came back.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(GONE_ALARM)) return;
  const site = alarm.name.slice(GONE_ALARM.length);
  serial(async () => {
    if (Object.values(await getTabSites()).includes(site)) return; // back
    const s = (await getSessions())[site];
    const plan = (await getPlans())[site];
    if ((s && s.leftAt) || (plan && plan.leftAt)) await endLeft(site);
  });
});

// --- Chrome quit, or the extension was updated --------------------------------
// Both empty storage.session (also: extension disabled then enabled); the copy
// in storage.local ("openState") is still there. The first queued step of each
// worker lifetime is boot(): if storage.session has no "booted" mark, it was
// emptied, so boot settles what the copy says was open before anything else
// runs. This doesn't depend on which event (startup, update, a check-in, a tab
// event) wakes the worker first.

async function clearGoneAlarms() {
  const alarms = await chrome.alarms.getAll();
  await Promise.all(alarms.filter((a) => a.name.startsWith(GONE_ALARM)).map((a) => chrome.alarms.clear(a.name)));
}

async function boot() {
  if ((await chrome.storage.session.get("booted")).booted) return;
  try {
    const { openState } = await chrome.storage.local.get("openState");
    if (openState) await settleOpen(openState);
  } finally {
    await saveOpen({ booted: true }); // from now on, changes are copied again
  }
}

// Is this the very page that checked in before storage.session was emptied
// (the extension was updated or reloaded, the page stayed)? After a Chrome
// restart, tab ids start over and may repeat, even on the same site, but the
// page is a new one: it was loaded after the last check-in (seenAt).
async function samePage(tabId, site, seenAt) {
  if (!seenAt || !(await tabOnSite(tabId, site))) return false;
  try {
    // Boot runs at the head of the queue: a frozen or hung tab must not hold
    // up every check-in and tab event behind it.
    const [{ result }] = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId },
        func: () => performance.timeOrigin, // when this page started loading
        injectImmediately: true, // don't wait for a restored tab to finish loading
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
    ]);
    return result < seenAt;
  } catch {
    return false; // not loaded (e.g. restored tab not opened yet), or gone
  }
}

// Per site that was open (session, plan, or only the start screen in a tab):
// a page still showing it (after an update) means the user never left: it
// just continues, no leave logged. Otherwise they left while Wilo wasn't
// running: log the leave at the last time Wilo saw the site (approx), unless
// it was already logged (e.g. closed-window while quitting), then end it, or
// wait out the rest of the grace period if it's recent.
async function settleOpen(openState) {
  const now = Date.now();
  const old = { sessions: {}, plans: {}, tabSites: {}, tabSeen: {}, ...openState };
  // Put the copy back (anything written since this start wins).
  const sessions = { ...old.sessions, ...(await getSessions()) };
  const plans = { ...old.plans, ...(await getPlans()) };
  const tabSites = await getTabSites();
  const { tabSeen = {} } = await chrome.storage.session.get("tabSeen");
  const lastSeen = (site) => Math.max((sessions[site] && sessions[site].lastSeen) || 0, (plans[site] && plans[site].lastSeen) || 0);
  let kept = 0;
  for (const [id, site] of Object.entries(old.tabSites)) {
    if (!site || id in tabSites) continue;
    const seenAt = old.tabSeen[id] ?? lastSeen(site); // the page's own check-in, else the site's
    if (!(await samePage(Number(id), site, seenAt))) continue;
    tabSites[id] = site;
    tabSeen[id] ??= seenAt;
    kept++;
  }
  await saveOpen({ sessions, plans, tabSites, tabSeen });
  await clearGoneAlarms();
  // No old page survived: Chrome was restarted. Otherwise the extension was
  // updated, and a site with no page left was closed during the update.
  const how = kept ? "unknown" : "browser-closed";
  const open = new Set(Object.values(tabSites));
  const tabsOf = (site) => Object.keys(old.tabSites).filter((id) => old.tabSites[id] === site);
  const sites = new Set([...Object.keys(old.sessions), ...Object.keys(old.plans), ...Object.values(old.tabSites).filter(Boolean)]);
  for (const site of sites) {
    if (open.has(site)) continue;
    const s = sessions[site];
    const plan = plans[site];
    let leftAt = (s && s.leftAt) ?? (plan && plan.leftAt);
    if (!leftAt) {
      leftAt = Math.max(lastSeen(site), ...tabsOf(site).map((id) => old.tabSeen[id] || 0)) || now;
      await logLeave(site, how, leftAt, { approx: true }); // stage start-screen if neither
    }
    if (!s && !plan) continue; // start screen: nothing to end
    if (now - leftAt >= GONE_AFTER_MS) await endLeft(site);
    else await chrome.alarms.create(goneAlarm(site), { when: leftAt + GONE_AFTER_MS });
  }
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
  async status(msg, sender) {
    await ensureOffscreen();
    const now = Date.now();
    const session = await serial(() => checkIn(msg.site, sender.tab, now));
    if (session) return { session, now };
    const profile = await getProfile();
    const log = await getLog();
    const app = SITES[msg.site] || msg.site;

    // Inside one of the user's free-time windows: no questions, a session runs
    // until the window ends (then the normal time-up).
    const free = freeWindowNow(profile.rules, new Date(now));
    if (free) {
      // Re-checked in serial: another tab of the site may have just started one.
      const started = await serial(async () => (await getSessions())[msg.site] ? null
        : updateSession(msg.site, () => newSession(app, "Free time (your rule)", "", free.minutesLeft, now, { free: true })));
      if (!started) return { session: (await getSessions())[msg.site], now };
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
    const session = await serial(() => updateSession(msg.site, () =>
      newSession(SITES[msg.site] || msg.site, String(msg.intent || "").slice(0, 200), String(msg.next || "").slice(0, 200), minutes, now),
    ));
    const d = new Date(now);
    await appendLog({ kind: "start", site: msg.site, app: session.app, intent: session.intent, minutes, next: session.next, hour: d.getHours(), weekday: d.getDay() });
    return { session };
  },

  // The start screen's plan: Wilo reviews it before the session starts.
  async plan(msg) {
    const minutes = Math.max(1, Math.min(240, Math.round(Number(msg.minutes) || 0)));
    // Plan writes go through serial, like check-ins (which also update the
    // plan): otherwise a check-in could write back the plan it read before.
    await serial(() => setPlan(msg.site, {
      app: SITES[msg.site] || msg.site,
      intent: String(msg.intent || "").slice(0, 200),
      next: String(msg.next || "").slice(0, 200),
      minutes,
      turns: [],
      lastSeen: Date.now(),
    }));
    return reviewPlan(msg.site, null);
  },

  // The user answers Wilo's question or explains more about the plan.
  async "plan-reply"(msg) {
    return reviewPlan(msg.site, String(msg.text || "").slice(0, 500));
  },

  // The plan is agreed: start the session with the agreed minutes. The plan
  // conversation becomes the start of the session's history.
  async "plan-accept"(msg) {
    // In serial, so a check-in can't bring the plan back (see plan).
    const accepted = await serial(async () => {
      const plan = (await getPlans())[msg.site];
      if (!plan) return null;
      const minutes = Math.max(1, Math.min(plan.minutes, Math.round(Number(msg.minutes) || plan.minutes)));
      const now = Date.now();
      const session = await updateSession(msg.site, () => ({
        ...newSession(plan.app, plan.intent, plan.next, minutes, now),
        turns: plan.turns,
        conversationFrom: plan.turns.length,
        plannedMin: plan.minutes,
      }));
      await setPlan(msg.site, null);
      return { plan, minutes, now, session };
    });
    if (!accepted) return { error: "no plan" };
    const { plan, minutes, now, session } = accepted;
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
    const session = await serial(() => grant(msg.site, minutes, "took offer"));
    return { session };
  },


  async done(msg, sender) {
    // In serial, so a check-in can't bring the plan or session back (see plan).
    await serial(async () => {
      // Wilo closes this tab itself below: that's not the user leaving.
      if (sender.tab) await markClosing(sender.tab.id);
      // Still discussing the plan: save that conversation and drop the plan.
      const plan = (await getPlans())[msg.site];
      if (plan) {
        await logPlanConversation(msg.site, plan, "done");
        await setPlan(msg.site, null);
      }
      await closeConversation(msg.site, "done");
      const s = (await getSessions())[msg.site];
      if (s) await endSession(msg.site, s, "done");
    });
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
    await serial(async () => {
      const sessions = await getSessions();
      const now = Date.now();
      for (const s of Object.values(sessions)) {
        const skip = Math.max(0, s.endsAt - now);
        s.startedAt -= skip;
        s.endsAt -= skip;
        s.fastForwarded = true;
      }
      await saveOpen({ sessions });
    });
    return {};
  },

  async "end-session"(msg) {
    await serial(() => updateSession(msg.site, () => undefined));
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
    const { name, body } = await studyPayload();
    const res = await fetch(`${CONFIG.upload.base}/public.php/dav/files/${CONFIG.upload.token}/${name}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
      body,
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`upload failed (HTTP ${res.status})`);
    const sentAt = new Date().toISOString();
    await chrome.storage.local.set({ lastSent: sentAt });
    return { sentAt, file: name };
  },

  async "study-id"() {
    return { id: await studyId() };
  },

  // Popup: the exact file "send-log" uploads, for "Save a copy" and the
  // email fallback.
  async "study-payload"() {
    return studyPayload();
  },

  // Popup: a free-text comment for the team. Kept in the log (with its time
  // and version) so it's sent with the conversations; never edited after.
  async "add-comment"(msg) {
    const text = String(msg.text || "").trim().slice(0, 5000);
    if (!text) return { ok: false };
    await appendLog({ kind: "comment", text });
    await chrome.storage.local.remove("commentDraft");
    return { ok: true };
  },
};

// The file sent to the team: study ID, version and log, named by study ID.
async function studyPayload() {
  const id = await studyId();
  const name = `wilo-${id}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const body = JSON.stringify({ studyId: id, version: chrome.runtime.getManifest().version, log: await getLog() }, null, 2);
  return { name, body };
}

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
// Both also settle what was open before (boot), without waiting for a tab to check in.
chrome.runtime.onStartup.addListener(() => {
  serial(() => {});
  ensureOffscreen();
});
chrome.runtime.onInstalled.addListener((details) => {
  console.log(`[wilo] installed (${details.reason})`);
  serial(() => {});
  restartModel();
  for (const delay of [1500, 5000, 12000]) setTimeout(ensureWiloInOpenTabs, delay);
});

// For debugging from the service worker's DevTools console (and dev/check_extension.py).
globalThis.wilo = { restartModel, handlers, currentNote, getProfile, memoryNote, nextQuestion, capReply, getTabSites, endLeft: (site) => serial(() => endLeft(site)), boot: () => serial(boot) };
