// What Wilo knows about the user, written automatically. Three sources:
//   1. onboarding: three tap-to-answer questions the very first time (optional)
//   2. learned: typical session lengths and patterns, from finished sessions
//   3. check-in questions: Wilo occasionally asks about something it noticed
//      (at most one a day, on the start screen only, always skippable)
// The note uses the same layout as the training data's memory (Schedule /
// Preferences / Typical sessions / Patterns), so the model sees what it learned.

const MIN_SESSIONS_TO_LEARN = 3;

// --- Onboarding --------------------------------------------------------------

export const ONBOARDING = [
  {
    key: "bedtime",
    label: "Bedtime",
    text: "Usually in bed by?",
    options: ["22:00", "23:00", "00:00", "Later"],
  },
  {
    key: "strictness",
    label: "How strict Wilo should be",
    text: "How strict should I be?",
    options: ["Gentle", "Balanced", "Strict"],
  },
  {
    key: "help",
    label: "Wants help with",
    text: "What do you mostly want help with?",
    options: ["Scrolling too long", "Getting distracted", "Sleeping on time"],
  },
  {
    key: "hobby",
    label: "Enjoys",
    text: "What do you enjoy besides social media?",
    options: ["Reading", "Sport", "Music", "Seeing friends"],
  },
];

// --- The user's own rules: free time without explaining ------------------------
// A rule: { days: "every day" | "weekdays" | "weekends", from: "17:00", to: "19:00" }.
// A window may cross midnight (from "22:00" to "01:00").

const minutesOf = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + (m || 0);
};

function dayMatches(days, weekday) {
  if (days === "weekdays") return weekday >= 1 && weekday <= 5;
  if (days === "weekends") return weekday === 0 || weekday === 6;
  return true;
}

// The free window the user is in now, with the minutes left, or null.
export function freeWindowNow(rules, now = new Date()) {
  const t = now.getHours() * 60 + now.getMinutes();
  for (const rule of rules || []) {
    const from = minutesOf(rule.from);
    const to = minutesOf(rule.to);
    if (from === to) continue;
    const crosses = to < from;
    // For a window crossing midnight, the part after midnight belongs to the previous day's rule.
    const inToday = crosses ? t >= from : t >= from && t < to;
    const inYesterdays = crosses && t < to;
    const day = inYesterdays ? (now.getDay() + 6) % 7 : now.getDay();
    if ((inToday || inYesterdays) && dayMatches(rule.days, day)) {
      const left = inYesterdays ? to - t : (crosses ? to + 24 * 60 : to) - t;
      return { rule, minutesLeft: left };
    }
  }
  return null;
}

export const describeRule = (r) => `${r.days} ${r.from}–${r.to}` + (r.why ? ` ("${r.why}")` : "");

// Validate a rule from the page or the popup; null if it isn't usable.
export function cleanRule(r) {
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!r || !time.test(r.from) || !time.test(r.to) || r.from === r.to) return null;
  const days = ["every day", "weekdays", "weekends"].includes(r.days) ? r.days : "every day";
  const why = String(r.why || "").trim().slice(0, 200);
  return { days, from: r.from, to: r.to, ...(why ? { why } : {}) };
}

// --- Recent sessions: Wilo remembers what happened between sessions ------------

const RECENT_HOURS = 3;

function ago(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return "less than a minute ago";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const h = Math.round(min / 60);
  return `${h} hour${h === 1 ? "" : "s"} ago`;
}

const DECISION_WORDS = { grant: "more time", counter_offer: "a shorter offer", decline: "no extra time" };

export function recentSessions(log, now = Date.now(), hours = RECENT_HOURS) {
  return log
    .filter((e) => e.kind === "session-end" && e.endedAt && now - e.endedAt < hours * 3600000)
    .slice(-3);
}

function recentLine(e, now) {
  let line = `left ${e.app} ${ago(now - e.endedAt)}`;
  if (e.intent) line += ` after planning ${e.agreedMin} minutes for "${e.intent}"`;
  if (!e.fastForwarded && e.usedMin) line += ` and using ${e.usedMin}`;
  const extras = [];
  if (e.next) extras.push(`said "${e.next}" was next`);
  if (e.lastDecision) extras.push(`Wilo's last answer: ${DECISION_WORDS[e.lastDecision] || e.lastDecision}`);
  return extras.length ? `${line} (${extras.join("; ")})` : line;
}

// --- Time helpers --------------------------------------------------------------

export function daypart(hour) {
  if (hour >= 6 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 22) return "evening";
  return "night";
}

const dayKind = (weekday) => (weekday === 0 || weekday === 6 ? "weekend" : "weekday");
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const normalize = (t) => String(t || "").trim().toLowerCase().replace(/\s+/g, " ");
const today = () => new Date().toDateString();

// Bedtime "23:00" -> 23, "00:00" -> 24, "Later" -> 25.
function bedtimeHour(answer) {
  if (!answer) return null;
  if (answer === "Later") return 25;
  const h = Number(answer.slice(0, 2));
  return h < 12 ? h + 24 : h;
}

// --- Learning from finished sessions ------------------------------------------

function learned(log) {
  // Fast-forwarded sessions ("Time's up now") don't reflect real habits.
  const ends = log.filter((e) => e.kind === "session-end" && e.usedMin > 0 && !e.fastForwarded);
  const byApp = {};
  for (const e of ends) (byApp[e.app] ||= []).push(e);
  const typical = [];
  const patterns = [];
  for (const [app, list] of Object.entries(byApp)) {
    if (list.length < MIN_SESSIONS_TO_LEARN) continue;
    typical.push(`${app} about ${median(list.map((e) => e.usedMin))} minutes`);
    const extended = list.filter((e) => e.extensions > 0).length / list.length;
    if (extended >= 0.5) patterns.push(`asks for more time in most ${app} sessions`);
    const overran = list.filter((e) => e.usedMin > 1.5 * e.agreedMin).length / list.length;
    if (overran >= 0.5) patterns.push(`${app} sessions often run well over the plan`);
  }
  const late = ends.filter((e) => daypart(e.startHour) === "night");
  if (late.length >= 2 && late.filter((e) => e.usedMin > 1.5 * e.agreedMin).length / late.length >= 0.5) {
    patterns.push("late-night sessions tend to overrun");
  }
  return { typical, patterns };
}

// --- The note ------------------------------------------------------------------

export function memoryNote(profile, log) {
  const a = (profile.onboarding && profile.onboarding.answers) || {};
  const schedule = [];
  const preferences = [];
  // A tapped option becomes a phrase; a typed answer is kept in the user's words.
  const typed = (key) => {
    const q = ONBOARDING.find((x) => x.key === key);
    return a[key] && !q.options.includes(a[key]) ? `${q.label}: "${a[key]}"` : null;
  };
  if (a.bedtime) schedule.push(typed("bedtime") || (a.bedtime === "Later" ? "usually goes to bed after midnight" : `usually in bed by ${a.bedtime}`));
  const STRICT = { Gentle: "wants Wilo to be gentle", Balanced: "wants Wilo balanced between gentle and strict", Strict: "wants Wilo to be strict" };
  if (a.strictness) preferences.push(typed("strictness") || STRICT[a.strictness]);
  if (a.help) preferences.push(typed("help") || `mostly wants help with ${a.help.toLowerCase()}`);
  if (a.hobby) preferences.push(typed("hobby") || `enjoys ${a.hobby.toLowerCase()}`);
  for (const f of profile.facts || []) (f.section === "schedule" ? schedule : preferences).push(f.text);
  const { typical, patterns } = learned(log);

  const lines = [];
  if (schedule.length) lines.push(`Schedule: ${schedule.map(cap).join(". ")}.`);
  if (preferences.length) lines.push(`Preferences: ${preferences.map(cap).join(". ")}.`);
  if (typical.length) lines.push(`Typical sessions: ${typical.join(", ")}.`);
  if (patterns.length) lines.push(`Patterns: ${patterns.join("; ")}.`);
  if ((profile.rules || []).length) {
    lines.push(`Their rules: free time without needing a reason on ${profile.rules.map(describeRule).join(", ")}.`);
  }
  const now = Date.now();
  const recent = recentSessions(log, now);
  if (recent.length) lines.push(`Recently: ${recent.map((e) => recentLine(e, now)).join("; ")}.`);
  return lines.join("\n");
}

// --- Check-in questions --------------------------------------------------------
// Each has a key (asked once), the question, and options that each map to a fact
// (or null: nothing to remember).

function candidates(profile, log, { app, now }) {
  const hour = now.getHours();
  const part = daypart(hour);
  const kind = dayKind(now.getDay());
  const starts = log.filter((e) => e.kind === "start" && typeof e.hour === "number");
  const sameApp = starts.filter((e) => e.app === app);
  const list = [];

  // Past bedtime: stricter at night?
  const bedAnswer = profile.onboarding && profile.onboarding.answers && profile.onboarding.answers.bedtime;
  const bed = ONBOARDING[0].options.includes(bedAnswer) ? bedtimeHour(bedAnswer) : null;
  const h = hour < 12 ? hour + 24 : hour;
  if (bed && h >= bed && bed <= 24) {
    list.push({
      key: "stricter-at-night",
      section: "preferences",
      topic: "At night",
      text: "It's past your usual bedtime. Should I be stricter at night?",
      options: [
        { label: "Yes, be stricter", fact: { section: "preferences", text: "wants Wilo to be stricter after bedtime" } },
        { label: "No, it's fine", fact: { section: "preferences", text: "is fine with the occasional late session" } },
      ],
    });
  }

  // A usual time for this app: free time or not?
  const usual = sameApp.filter((e) => daypart(e.hour) === part && dayKind(e.weekday) === kind);
  if (usual.length >= 3) {
    const when = `${kind} ${part === "night" ? "nights" : part + "s"}`;
    list.push({
      key: `free-${kind}-${part}`,
      section: "schedule",
      topic: cap(when),
      text: `You often open ${app} on ${when}. Is that usually free time for you?`,
      options: [
        { label: "Yes, free time", fact: { section: "schedule", text: `${when} are usually free time` } },
        { label: "No, I should be busy", fact: { section: "schedule", text: `${when} are usually busy (study or work)` } },
        { label: "It depends", fact: null },
      ],
    });
  }

  // An unusual time: a break from something?
  if (starts.length >= 8 && !starts.some((e) => daypart(e.hour) === part)) {
    list.push({
      key: `unusual-${part}`,
      section: "schedule",
      topic: `Using ${app} in the ${part}`,
      text: `This isn't when you usually open ${app}. Taking a break from something?`,
      options: [
        { label: "Yes, a short break", fact: { section: "schedule", text: `sometimes takes short breaks in the ${part}` } },
        { label: "No, I'm free now", fact: null },
      ],
    });
  }

  // A next event typed before: a routine?
  const nexts = {};
  for (const e of starts) if (e.next) (nexts[normalize(e.next)] ||= []).push(e.next);
  const repeated = Object.values(nexts).find((xs) => xs.length >= 2);
  if (repeated) {
    const event = repeated[repeated.length - 1].trim().replace(/[.\s]+$/, "");
    list.push({
      key: `routine-${normalize(event)}`,
      section: "schedule",
      topic: event,
      text: `"${event}" came up before. Is it a regular thing?`,
      options: [
        { label: "Every weekday", fact: { section: "schedule", text: `${event} on weekdays` } },
        { label: "Most days", fact: { section: "schedule", text: `${event} on most days` } },
        { label: "Just sometimes", fact: null },
      ],
    });
  }

  // Sessions keep running long: realistic times or hold to the plan?
  const ends = log.filter((e) => e.kind === "session-end" && e.app === app && !e.fastForwarded);
  if (ends.length >= 4 && ends.filter((e) => e.usedMin > 1.5 * e.agreedMin).length / ends.length >= 0.5) {
    list.push({
      key: `overrun-${app}`,
      section: "preferences",
      topic: `Long ${app} sessions`,
      text: `Your ${app} sessions usually take longer than planned. What would help more?`,
      options: [
        { label: "Suggest realistic times", fact: { section: "preferences", text: `wants realistic time suggestions for ${app}` } },
        { label: "Hold me to my plan", fact: { section: "preferences", text: `wants to be held to the plan on ${app}` } },
      ],
    });
  }
  // Nothing specific stands out: about once a week, an open question.
  const week = Math.floor(now.getTime() / (7 * 24 * 60 * 60 * 1000));
  list.push({
    key: `open-week-${week}`,
    section: "schedule",
    topic: `Week of ${now.toISOString().slice(0, 10)}`,
    text: "Anything about your week I should know? Exams, a trip, a busy day…",
    options: [],
  });
  return list;
}

// The question to show now, or null. At most one a day, each only once, never
// after "Don't ask me questions", never before onboarding was offered.
export function nextQuestion(profile, log, context) {
  if (profile.noQuestions || !(profile.onboarding && profile.onboarding.offered)) return null;
  if (profile.lastQuestionDay === today()) return null;
  const asked = profile.asked || {};
  return candidates(profile, log, context).find((q) => !asked[q.key]) || null;
}

// Record an answer: a tapped option (its fact), or text typed in the user's own
// words (kept as they wrote it), or a skip (optionIndex -1, no text).
const MAX_FACTS = 15; // oldest facts drop off, so the note stays short

export function recordAnswer(profile, question, optionIndex, text = "") {
  const p = { ...profile, asked: { ...(profile.asked || {}), [question.key]: Date.now() }, lastQuestionDay: today() };
  const option = question.options[optionIndex];
  const words = String(text || "").trim().slice(0, 300);
  const fact = words
    ? { section: question.section || "schedule", text: `${question.topic || "Note"}: "${words}"` }
    : option && option.fact;
  if (fact) p.facts = [...(p.facts || []).filter((f) => f.key !== question.key), { key: question.key, ...fact }].slice(-MAX_FACTS);
  return p;
}

