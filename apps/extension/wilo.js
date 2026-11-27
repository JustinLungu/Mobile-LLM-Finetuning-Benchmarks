// Wilo's prompt and reply format, shared by the background script.
// The situation uses the benchmark/training layout, with live playback facts
// and the current extension limit added for the browser.

import { CONFIG } from "./generated/config.js";

export const SITES = {
  "www.instagram.com": "Instagram",
  "www.youtube.com": "YouTube",
  "www.tiktok.com": "TikTok",
  "x.com": "X",
  "www.reddit.com": "Reddit",
  "www.facebook.com": "Facebook",
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function dayTime(date = new Date()) {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${DAYS[date.getDay()]} ${hh}:${mm}`;
}

// "Reply to messages." -> "reply to messages"
function clause(text) {
  const t = String(text || "").trim().replace(/[.\s]+$/, "");
  return t.slice(0, 1).toLowerCase() + t.slice(1);
}

export function systemPrompt(memoryNote) {
  const note = String(memoryNote || "").trim() || "Nothing yet: this is a new user.";
  return `${CONFIG.rules}\n\n${CONFIG.memoryHeader}\n${note}`;
}

export function situationText(session, userSays, now = new Date(), videoContext = "Current video metadata unavailable. Do not invent a title.") {
  const usedMin = Math.max(0, Math.round((now.getTime() - session.startedAt) / 60000));
  return (
    `Current time: ${dayTime(now)}.\n` +
    `App: ${session.app}.\n` +
    `Declared intent: ${clause(session.intent)}.\n` +
    `Agreed time: ${session.agreedMin} minutes. Time used: ${usedMin} minutes.\n` +
    `Extensions so far: ${session.extensions}. Extra time actually granted: ${session.grantedExtraMin || 0} minutes.\n` +
    `Next event: ${clause(session.next) || "nothing planned"}.\n` +
    `Maximum extension available this turn: ${maxExtension(session)} minutes.\n` +
    `${videoContext}\n` +
    `\n` +
    `The user says: ${String(userSays).trim()}`
  );
}

// Constrains the model's output to valid Wilo JSON (llama.cpp turns this
// schema into a grammar, so a malformed reply can't be generated).
export const REPLY_SCHEMA = {
  type: "object",
  properties: {
    relation: { type: "string", enum: ["continuation", "new_task", "leisure_choice", "vague"] },
    assessment: { type: "string" },
    decision: { type: "string", enum: ["grant", "counter_offer", "decline"] },
    minutes: { type: "integer", minimum: 0, maximum: 240 },
    message: { type: "string" },
  },
  required: ["relation", "assessment", "decision", "minutes", "message"],
  additionalProperties: false,
};

export function modelByKey(key) {
  return CONFIG.models.find((m) => m.key === key) || CONFIG.models.find((m) => m.key === CONFIG.defaultModel);
}

// Safety net until the model is fine-tuned: the base models sometimes offer far
// too much (30 min on a 1-minute plan). The first extension is at most the
// agreed time (counted as 5 to 30 minutes), each further one half of the
// previous limit, never under 2 minutes.
export function maxExtension(session) {
  const base = Math.max(5, Math.min(30, session.agreedMin));
  return Math.max(2, Math.round(base / 2 ** session.extensions));
}

// Cap a reply's minutes; if its message names the old number, fix that too.
export function capReply(reply, session) {
  const limit = maxExtension(session);
  if (reply.decision === "decline" || reply.minutes <= limit) return { reply, capped: false };
  const said = new RegExp(`\\b${reply.minutes}(\\s*(more\\s+)?(min|mins|minutes)\\b)`, "gi");
  return {
    reply: { ...reply, minutes: limit, message: reply.message.replace(said, `${limit}$1`) },
    capped: true,
    modelMinutes: reply.minutes,
  };
}

// --- Reviewing the plan at the start of a session ----------------------------

// The user's plan, in the same layout as the time-up situation.
export function planText(plan, userSays, now = new Date()) {
  let text =
    `Current time: ${dayTime(now)}.\n` +
    `App: ${plan.app}.\n` +
    `The user is starting a session.\n` +
    `Plan: ${clause(plan.intent) || "not given"}.\n` +
    `Planned time: ${plan.minutes} minutes.\n` +
    `Next event: ${clause(plan.next) || "nothing planned"}.`;
  if (userSays) text += `\n\nThe user says: ${String(userSays).trim()}`;
  return text;
}

export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    assessment: { type: "string" },
    decision: { type: "string", enum: ["accept", "counter_offer", "ask"] },
    minutes: { type: "integer", minimum: 0, maximum: 240 },
    message: { type: "string" },
  },
  required: ["assessment", "decision", "minutes", "message"],
  additionalProperties: false,
};

// Wilo never gives more than the user asked for, nor less than a minute.
// If the message names a bigger number, it is corrected too.
export function capPlan(reply, plan) {
  const asked = plan.minutes;
  let minutes = Math.round(Number(reply.minutes) || 0);
  if (reply.decision === "ask" || minutes <= 0) minutes = asked;
  const capped = Math.max(1, Math.min(asked, minutes));
  let message = reply.message;
  if (capped !== minutes && minutes > 0) {
    const said = new RegExp(`\\b${minutes}(\\s*(more\\s+)?(min|mins|minutes)\\b)`, "gi");
    message = message.replace(said, `${capped}$1`);
  }
  return { reply: { ...reply, minutes: capped, message }, cappedFrom: capped !== minutes ? minutes : undefined };
}
