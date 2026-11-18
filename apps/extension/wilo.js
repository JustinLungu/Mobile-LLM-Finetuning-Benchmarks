// Wilo's prompt and reply format, shared by the background script.
// The situation text matches the benchmark prompts and the training data
// (data/wilo_reactions_v1/build_dataset.py) exactly, so the model sees in the
// browser what it saw in training.

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

export function situationText(session, userSays, now = new Date()) {
  const usedMin = Math.max(0, Math.round((now.getTime() - session.startedAt) / 60000));
  return (
    `Current time: ${dayTime(now)}.\n` +
    `App: ${session.app}.\n` +
    `Declared intent: ${clause(session.intent)}.\n` +
    `Agreed time: ${session.agreedMin} minutes. Time used: ${usedMin} minutes.\n` +
    `Extensions so far: ${session.extensions}.\n` +
    `Next event: ${clause(session.next) || "nothing planned"}.\n` +
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
