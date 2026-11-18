// Runs on the watched sites. Shows Wilo's overlay: when the site opens (what
// are you here for, and for how long?) and when the time is up (negotiate).
// Everything Wilo decides happens in the background script.

(() => {
  if (window.top !== window) return; // never inside frames

  // After the extension is reloaded or updated, scripts already running in open
  // tabs lose their connection ("Extension context invalidated") and stop
  // themselves (their connection checks fail). background.js then adds the new
  // version to those tabs; it removes any overlay an old copy left behind. It
  // never calls into the old copy: Chrome may refuse to run that code.
  const connected = () => {
    try {
      return !!chrome.runtime.id;
    } catch {
      return false;
    }
  };
  document.querySelectorAll("[data-wilo-overlay]").forEach((e) => e.remove());
  // Two copies can start in the same page (the page's own and one added by
  // background.js right after an update). Only the newest may show anything.
  const copyId = Math.random().toString(36).slice(2);
  document.documentElement.dataset.wiloCopy = copyId;
  const newest = () => document.documentElement.dataset.wiloCopy === copyId;

  const site = location.hostname;
  const CHECK_IN_MS = 30 * 1000; // tells the background script this tab is still open
  const DECLINE_WAIT_S = 10; // wait before asking again grows by this much per decline

  let session = null;
  let timer = null;
  let mode = null; // null | "start" | "timeup"
  let checkIn = null;
  let disposed = false;
  // True while this tab talks to Wilo: session updates from that conversation
  // (e.g. a grant) must not close the overlay before the reply is shown.
  let talking = false;

  const send = (type, fields = {}) => {
    if (!connected()) return Promise.resolve(null);
    try {
      return chrome.runtime.sendMessage({ type, site, ...fields }).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  };

  // --- Overlay ---------------------------------------------------------------

  const host = document.createElement("div");
  host.dataset.wiloOverlay = "";
  host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647; display: none;";
  // Open (not closed) so dev/check_extension.py can click through it.
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      /* Colours as tokens, with a dark set that follows the system setting.
         Every element sets its colours explicitly: sites like Instagram switch
         the page to dark mode, which would otherwise turn default button text
         white on our white card. */
      .backdrop {
        --card: #ffffff; --text: #0f172a; --muted: #64748b; --sub: #475569;
        --field: #f8fafc; --line: #cbd5e1; --chip: #ffffff; --alt: #e2e8f0;
        --accent: #4f46e5; --on-accent: #ffffff; --bubble: #f1f5f9; --error: #b91c1c;
        --shade: rgba(15, 23, 42, 0.72);
        color-scheme: light;
      }
      @media (prefers-color-scheme: dark) {
        .backdrop {
          --card: #1e1f24; --text: #f1f5f9; --muted: #9aa3b2; --sub: #b6bfcc;
          --field: #2a2c33; --line: #3f424c; --chip: #2a2c33; --alt: #343741;
          --accent: #6366f1; --on-accent: #ffffff; --bubble: #2f323b; --error: #f87171;
          --shade: rgba(0, 0, 0, 0.7);
          color-scheme: dark;
        }
      }
      .backdrop {
        position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
        background: var(--shade); backdrop-filter: blur(6px);
        font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--text);
      }
      .card {
        /* One knob for the whole card's size: everything inside scales with it. */
        --scale: 1.5;
        zoom: var(--scale);
        width: min(530px, calc((100vw - 32px) / var(--scale))); max-height: calc((100vh - 32px) / var(--scale)); overflow: auto;
        background: var(--card); color: var(--text); border-radius: 18px; padding: 22px; box-sizing: border-box;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
      }
      h1 { font-size: 20px; margin: 0 0 4px; color: var(--text); }
      .sub { color: var(--sub); margin: 0 0 16px; }
      label { display: block; font-weight: 600; margin: 12px 0 6px; color: var(--text); }
      .optional { font-weight: 400; color: var(--muted); }
      input, textarea {
        width: 100%; box-sizing: border-box; font: inherit; color: var(--text); background: var(--field);
        border: 1px solid var(--line); border-radius: 10px; padding: 9px 11px;
      }
      input::placeholder, textarea::placeholder { color: var(--muted); opacity: 1; }
      textarea { resize: vertical; min-height: 64px; }
      input:focus, textarea:focus { outline: 2px solid var(--accent); border-color: transparent; }
      .chips { display: flex; gap: 8px; flex-wrap: wrap; }
      .chip {
        border: 1px solid var(--line); background: var(--chip); color: var(--text);
        border-radius: 999px; padding: 6px 14px; cursor: pointer; font: inherit;
      }
      .chip.on { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
      .custom-box { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--accent); border-radius: 999px; padding: 2px 12px 2px 4px; background: var(--field); }
      .custom-box[hidden] { display: none; }
      .custom-box input { width: 56px; border: 0; background: transparent; padding: 4px 6px; text-align: right; }
      .custom-box input:focus { outline: none; }
      .custom-box span { color: var(--muted); }
      .row { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
      button.main, button.alt {
        flex: 1; font: inherit; font-weight: 600; border-radius: 10px; padding: 10px 14px; cursor: pointer; border: 0;
      }
      button.main { background: var(--accent); color: var(--on-accent); }
      button.alt { background: var(--alt); color: var(--text); }
      button:disabled { opacity: 0.5; cursor: default; }
      .link { background: none; border: 0; color: var(--muted); text-decoration: underline; cursor: pointer; font: inherit; font-size: 13px; padding: 0; margin-top: 12px; }
      .chat { display: flex; flex-direction: column; gap: 8px; margin: 12px 0 0; }
      .bubble { padding: 9px 12px; border-radius: 14px; max-width: 85%; white-space: pre-wrap; }
      .bubble.user { align-self: flex-end; background: var(--accent); color: var(--on-accent); border-bottom-right-radius: 4px; }
      .bubble.wilo { align-self: flex-start; background: var(--bubble); color: var(--text); border-bottom-left-radius: 4px; }
      .bubble.thinking { color: var(--muted); font-style: italic; }
      .note { color: var(--muted); font-size: 13px; margin-top: 8px; }
      .welcome { margin: 2px 0 10px; color: var(--sub); }
      .free { margin-top: 10px; text-align: center; }
      #free-form { text-align: left; margin-top: 8px; }
      #free-form[hidden] { display: none; }
      .free-row { display: flex; gap: 6px; align-items: center; margin: 8px 0; }
      .free-row select, .free-row input { width: auto; min-width: 0; box-sizing: border-box; }
      .free-row select { flex: 0 0 auto; padding: 8px 4px; }
      .free-row input { flex: 1; padding: 8px 6px; }
      select { font: inherit; color: var(--text); background: var(--field); border: 1px solid var(--line); border-radius: 10px; padding: 8px; }
      .question { margin: 10px 0 14px; padding: 12px; border-radius: 12px; background: var(--bubble); }
      .question .note { margin: 6px 0 0; }
      .qhead { font-size: 11.5px; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase; color: var(--muted); margin-bottom: 4px; }
      .qtext { margin-bottom: 8px; }
      .own { display: flex; gap: 6px; margin-top: 8px; }
      .own input { flex: 1; padding: 6px 9px; }
      .own-send { font: inherit; font-weight: 600; border: 0; border-radius: 10px; padding: 6px 12px; background: var(--accent); color: var(--on-accent); cursor: pointer; }
      .own-send:disabled { opacity: 0.4; cursor: default; }
      .chip.small { padding: 4px 11px; font-size: 13px; }
      .meta { display: flex; align-items: center; gap: 4px; margin-top: 6px; font-size: 12px; }
      .tag { font-weight: 600; color: var(--sub); margin-right: auto; }
      .rate { background: none; border: 0; cursor: pointer; font-size: 14px; padding: 0 2px; opacity: 0.45; }
      .rate:hover, .rate.picked { opacity: 1; }
      .err { color: var(--error); font-size: 13px; margin-top: 8px; }
    </style>
    <div class="backdrop"><div class="card" id="card"></div></div>`;
  const card = root.getElementById("card");

  // Keys typed in Wilo's boxes must not reach the site (YouTube's "k" pauses, etc.).
  for (const type of ["keydown", "keyup", "keypress"]) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }

  function mount() {
    if (!host.isConnected) document.documentElement.appendChild(host);
  }

  // Stop this copy for good: remove its overlay, timers and reactions.
  function dispose() {
    disposed = true;
    mode = null;
    clearTimeout(timer);
    clearInterval(checkIn);
    host.remove();
  }

  function show(newMode) {
    if (!connected() || !newest()) return dispose(); // a disconnected or replaced copy must not cover the page
    mount();
    mode = newMode;
    host.style.display = "block";
    pauseMedia();
  }

  function hide() {
    mode = null;
    host.style.display = "none";
    card.innerHTML = "";
  }

  // Videos keep playing under the overlay otherwise; also stop ones that start later.
  function pauseMedia() {
    document.querySelectorAll("video, audio").forEach((m) => m.pause());
  }
  document.addEventListener("play", () => { if (mode && !disposed) pauseMedia(); }, true);

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const appName = () => (session && session.app) || { "www.instagram.com": "Instagram", "www.youtube.com": "YouTube", "www.tiktok.com": "TikTok", "x.com": "X", "www.reddit.com": "Reddit", "www.facebook.com": "Facebook" }[site] || site;

  // --- Start: declare an intent and a time ----------------------------------

  // The first time ever: offer three tap questions so Wilo knows a bit about
  // the user. Skippable; then the normal start screen.
  function showOnboarding(questions, then) {
    show("start");
    const answers = {};
    card.innerHTML = `
      <h1>Hi, I'm Wilo 👋</h1>
      <p class="sub">I help you use ${esc(appName())} on purpose. Want me to get to know you a bit first? It's 4 quick questions.</p>
      <div class="row">
        <button class="alt" id="skip">Not now</button>
        <button class="main" id="sure">Sure</button>
      </div>`;
    root.getElementById("skip").addEventListener("click", () => {
      send("onboarding", { answers: null });
      then();
    });
    root.getElementById("sure").addEventListener("click", () => ask(0));
    function ask(i) {
      if (i >= questions.length) {
        send("onboarding", { answers });
        then();
        return;
      }
      const q = questions[i];
      card.innerHTML = `
        <p class="sub">Let's get to know each other a bit · ${i + 1} of ${questions.length}</p>
        <h1>${esc(q.text)}</h1>
        <div class="chips" style="margin-top: 14px;">
          ${q.options.map((o, n) => `<button class="chip" data-n="${n}">${esc(o)}</button>`).join("")}
        </div>
        ${ownWords("Or in your own words…")}
        <button class="link" id="skip-one">Skip this one</button>`;
      root.querySelectorAll(".chip").forEach((chip) =>
        chip.addEventListener("click", () => {
          answers[q.key] = q.options[Number(chip.dataset.n)];
          ask(i + 1);
        }),
      );
      wireOwnWords(card, (text) => {
        answers[q.key] = text;
        ask(i + 1);
      });
      root.getElementById("skip-one").addEventListener("click", () => ask(i + 1));
    }
  }

  // A text box to answer in one's own words, with a send button.
  const ownWords = (placeholder) => `
    <div class="own">
      <input class="own-text" maxlength="300" placeholder="${esc(placeholder)}" />
      <button class="own-send" disabled>Send</button>
    </div>`;

  function wireOwnWords(box, onSend) {
    const input = box.querySelector(".own-text");
    const button = box.querySelector(".own-send");
    input.addEventListener("input", () => (button.disabled = !input.value.trim()));
    const sendIt = () => input.value.trim() && onSend(input.value.trim());
    button.addEventListener("click", sendIt);
    input.addEventListener("keydown", (e) => e.key === "Enter" && sendIt());
  }

  // An optional question at the top of the start screen, so Wilo keeps
  // learning about the user: tap an answer or say more in their own words,
  // skip, or turn questions off. Starting never depends on it.
  function questionCard(q) {
    const box = root.getElementById("question");
    if (!q || !box) return;
    send("question-shown");
    box.innerHTML = `
      <div class="question">
        <div class="qhead">Let's get to know each other a bit</div>
        <div class="qtext">${esc(q.text)}</div>
        ${q.options.length ? `<div class="chips">${q.options.map((o, n) => `<button class="chip small" data-n="${n}">${esc(o.label)}</button>`).join("")}</div>` : ""}
        ${ownWords(q.options.length ? "Or tell me more in your own words…" : "Tell me in your own words…")}
        <div class="note"><button class="link" id="q-skip">Skip</button> · <button class="link" id="q-never">Don't ask me questions</button></div>
      </div>`;
    const done = (text) => (box.innerHTML = `<div class="question note">${text}</div>`);
    box.querySelectorAll(".chip").forEach((chip) =>
      chip.addEventListener("click", () => {
        send("answer", { question: q, option: Number(chip.dataset.n) });
        done("Thanks, I'll remember that.");
      }),
    );
    wireOwnWords(box, (text) => {
      send("answer", { question: q, option: -1, text });
      done("Thanks, I'll remember that.");
    });
    root.getElementById("q-skip").addEventListener("click", () => {
      send("answer", { question: q, option: -1 });
      done("No problem.");
    });
    root.getElementById("q-never").addEventListener("click", () => {
      send("no-questions");
      done("Got it, no more questions.");
    });
  }

  // Back soon after a session: remind them, gently, what they said.
  function welcomeLine(w) {
    if (!w) return "";
    const when = w.minutesAgo < 1 ? "just now" : `${w.minutesAgo} min ago`;
    let text = `You left ${esc(w.app)} ${when}`;
    if (w.next) text += ` and said “${esc(w.next)}” was next`;
    else if (w.lastDecision === "decline") text += " after Wilo said no more time";
    return `<p class="welcome">${text}. What's the plan now?</p>`;
  }

  // Inside one of the user's free-time windows: a small note in the corner
  // instead of the start screen. It doesn't block the page.
  const NUDGES = {
    Reading: "📚 A few pages of your book would be nice too.",
    Sport: "🏃 A bit of sport later would feel good too.",
    Music: "🎵 Some music would be a nice break too.",
    "Seeing friends": "👋 Maybe message a friend to meet up, too.",
  };
  function freeToast({ until, hobby }) {
    if (!newest()) return;
    const nudge = hobby ? NUDGES[hobby] || `Remember: ${esc(hobby)} is good for you too.` : "Enjoy it, and keep an eye on the clock.";
    const t = document.createElement("div");
    t.dataset.wiloOverlay = "";
    t.style.cssText = "all: initial; position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;";
    const shadow = t.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        .toast { --card: #ffffff; --text: #0f172a; --muted: #64748b; color-scheme: light;
          font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; zoom: 1.4; background: var(--card); color: var(--text);
          border-radius: 14px; padding: 12px 36px 12px 14px; max-width: 300px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3); position: relative; }
        @media (prefers-color-scheme: dark) { .toast { --card: #1e1f24; --text: #f1f5f9; --muted: #9aa3b2; color-scheme: dark; } }
        b { display: block; margin-bottom: 2px; }
        .muted { color: var(--muted); }
        button { position: absolute; top: 6px; right: 8px; background: none; border: 0; color: var(--muted); font-size: 16px; cursor: pointer; }
      </style>
      <div class="toast"><b>Free time until ${esc(until)}, enjoy! 😊</b><span class="muted">${nudge}</span><button title="Close">×</button></div>`;
    shadow.querySelector("button").addEventListener("click", () => t.remove());
    document.documentElement.appendChild(t);
    setTimeout(() => t.remove(), 10000);
  }

  // Setting up a free-time window right from the start screen. If it covers
  // now, the start screen closes and the free-time note appears.
  function wireFreeForm() {
    const form = root.getElementById("free-form");
    root.getElementById("free-open").addEventListener("click", () => (form.hidden = !form.hidden));
    root.getElementById("free-save").addEventListener("click", async () => {
      const rule = {
        days: root.getElementById("free-days").value,
        from: root.getElementById("free-from").value,
        to: root.getElementById("free-to").value,
        why: root.getElementById("free-why").value,
      };
      const res = await send("add-rule", { rule, from: "page" });
      if (!res || !res.rule) {
        root.getElementById("err").textContent = "Pick two different times.";
        return;
      }
      form.innerHTML = `<p class="note">Saved: ${esc(rule.days)} ${esc(rule.from)}–${esc(rule.to)}. You can change it in the Wilo icon's menu.</p>`;
      const now = await send("status");
      if (now && now.session) {
        session = now.session;
        if (now.freeStart) freeToast(now.freeStart);
        hide();
        schedule();
      }
    });
  }

  function showStart(extra = {}) {
    if (extra.onboarding) return showOnboarding(extra.onboarding, () => showStart({}));
    show("start");
    card.innerHTML = `
      <h1>${extra.welcomeBack ? "Welcome back 👋" : "Hi, I'm Wilo 👋"}</h1>
      ${welcomeLine(extra.welcomeBack)}
      <div id="question"></div>
      ${extra.welcomeBack ? "" : `<p class="sub">Before you dive into ${esc(appName())}: what's the plan?</p>`}
      <label for="intent">What are you here for?</label>
      <input id="intent" maxlength="200" placeholder="e.g. reply to my study group" />
      <label>How long do you need?</label>
      <div class="chips" id="chips">
        ${[5, 10, 15, 30].map((m) => `<button class="chip" data-min="${m}">${m} min</button>`).join("")}
        <button class="chip" id="custom-chip">Custom</button>
        <span class="custom-box" id="custom-box" hidden><input id="custom" type="number" min="1" max="240" placeholder="20" /><span>min</span></span>
      </div>
      <label for="next">Anything planned after? <span class="optional">(optional)</span></label>
      <input id="next" maxlength="200" placeholder="e.g. dinner at 19:30" />
      <div class="row"><button class="main" id="go" disabled>Start</button></div>
      <div class="err" id="err"></div>
      <div class="free">
        <button class="link" id="free-open">Set up free time</button>
        <div id="free-form" hidden>
          <p class="note">Pick times when you can scroll freely. Wilo won't ask what you're here for during them.</p>
          <div class="free-row">
            <select id="free-days">
              <option value="every day">Every day</option>
              <option value="weekdays">Weekdays</option>
              <option value="weekends">Weekends</option>
            </select>
            <input id="free-from" type="time" value="17:00" />
            <span>–</span>
            <input id="free-to" type="time" value="19:00" />
          </div>
          <input id="free-why" maxlength="200" placeholder="Anything Wilo should know about this time? (optional)" />
          <div class="row"><button class="alt" id="free-save">Save free time</button></div>
        </div>
      </div>`;
    wireFreeForm();
    questionCard(extra.question);
    let minutes = null;
    const go = root.getElementById("go");
    const intent = root.getElementById("intent");
    const custom = root.getElementById("custom");
    const refresh = () => (go.disabled = !(intent.value.trim() && minutes > 0));
    const customBox = root.getElementById("custom-box");
    root.getElementById("chips").addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      root.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === chip));
      if (chip.id === "custom-chip") {
        // Custom: a minutes box appears next to the button.
        customBox.hidden = false;
        minutes = Math.round(Number(custom.value)) || null;
        custom.focus();
      } else {
        customBox.hidden = true;
        minutes = Number(chip.dataset.min);
      }
      refresh();
    });
    custom.addEventListener("input", () => {
      minutes = Math.round(Number(custom.value)) || null;
      if (minutes) minutes = Math.max(1, Math.min(240, minutes));
      refresh();
    });
    intent.addEventListener("input", refresh);
    go.addEventListener("click", async () => {
      go.disabled = true;
      const res = await send("start", { intent: intent.value.trim(), minutes, next: root.getElementById("next").value.trim() });
      if (res && res.session) {
        session = res.session;
        hide();
        schedule();
      } else {
        root.getElementById("err").textContent = "Something went wrong. Try again.";
        go.disabled = false;
      }
    });
    setTimeout(() => intent.focus(), 50);
  }

  // --- Time's up: negotiate with Wilo ----------------------------------------

  function showTimeUp() {
    show("timeup");
    const used = Math.max(1, Math.round((Date.now() - session.startedAt) / 60000));
    card.innerHTML = `
      <h1>Time's up ⏰</h1>
      <p class="sub">You planned ${session.agreedMin} min for “${esc(session.intent)}”. You've been on ${esc(session.app)} for ${used} min.</p>
      <div class="chat" id="chat"></div>
      <div id="actions"></div>`;
    // After a reload, show this time-up's conversation so far and carry on.
    const turns = (session.turns || []).slice(session.conversationFrom || 0);
    for (const t of turns) {
      bubble(t.says, "user");
      wiloBubble(t.reply, t.id);
    }
    const last = turns[turns.length - 1];
    if (last && last.reply.decision === "counter_offer") offerActions(last.reply);
    else if (last && last.reply.decision === "decline") declinedActions();
    else askBox();
  }


  function bubble(text, who) {
    const b = document.createElement("div");
    b.className = `bubble ${who}`;
    b.textContent = text;
    root.getElementById("chat").appendChild(b);
    b.scrollIntoView({ block: "nearest" });
    return b;
  }

  const DECISION_LABEL = {
    grant: (m) => `✅ +${m} min`,
    counter_offer: (m) => `🤝 Offer: ${m} min`,
    decline: () => "✋ No extra time",
  };

  // Wilo's message, its decision in plain words, and 👍/👎 (logged, so testers'
  // logs tell us which replies to learn from).
  function wiloBubble(reply, id) {
    const b = bubble(reply.message, "wilo");
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `<span class="tag">${esc((DECISION_LABEL[reply.decision] || (() => ""))(reply.minutes))}</span>`;
    if (id) {
      for (const [good, icon] of [[true, "👍"], [false, "👎"]]) {
        const button = document.createElement("button");
        button.className = "rate";
        button.title = good ? "Good reply" : "Bad reply";
        button.textContent = icon;
        button.addEventListener("click", () => {
          send("feedback", { id, good });
          meta.querySelectorAll(".rate").forEach((x) => x.classList.toggle("picked", x === button));
        });
        meta.appendChild(button);
      }
    }
    b.appendChild(meta);
    return b;
  }

  // Text box to ask for more time, plus "I'm done". waitS > 0 delays asking.
  // afterDecline: Wilo just said no, so ask for a real reason.
  function askBox(waitS = 0, afterDecline = false) {
    const actions = root.getElementById("actions");
    actions.innerHTML = `
      <label for="why">${afterDecline ? "Still want more time? Give Wilo a real reason." : "Need more time? Tell Wilo why."}</label>
      <textarea id="why" maxlength="500" placeholder="e.g. I'm still answering the group's questions"></textarea>
      <div class="row">
        <button class="alt" id="done">I'm done</button>
        <button class="main" id="ask" disabled>Ask Wilo</button>
      </div>
      <div class="note" id="wait"></div>`;
    const why = root.getElementById("why");
    const ask = root.getElementById("ask");
    const waitNote = root.getElementById("wait");
    let waiting = waitS;
    const refresh = () => (ask.disabled = waiting > 0 || !why.value.trim());
    why.addEventListener("input", refresh);
    if (waiting > 0) {
      const tick = () => {
        waitNote.textContent = waiting > 0
          ? `Wilo said no a few times, so take a breath: you can ask again in ${waiting} s, or call it a day.`
          : "";
        refresh();
        if (waiting-- > 0) setTimeout(tick, 1000);
      };
      tick();
    }
    root.getElementById("done").addEventListener("click", () => send("done"));
    ask.addEventListener("click", () => askWilo(why.value.trim()));
    setTimeout(() => why.focus(), 50);
  }

  function offerActions(reply) {
    const actions = root.getElementById("actions");
    actions.innerHTML = `<div class="row">
        <button class="alt" id="done">I'm done</button>
        <button class="main" id="take">Take ${reply.minutes} min</button>
      </div>
      <button class="link" id="argue">Explain more instead</button>`;
    root.getElementById("done").addEventListener("click", () => send("done"));
    root.getElementById("take").addEventListener("click", async () => resume(await send("accept", { minutes: reply.minutes })));
    root.getElementById("argue").addEventListener("click", () => askBox());
  }

  // Declined: asking again is always possible. The first time straight away,
  // then with a wait that grows with each further decline (friction, DECISIONS §5).
  async function declinedActions() {
    const latest = await send("status");
    const declines = (latest && latest.session && latest.session.declines) || 1;
    askBox(DECLINE_WAIT_S * (declines - 1), true);
  }

  async function askWilo(text) {
    talking = true;
    bubble(text, "user");
    const actions = root.getElementById("actions");
    actions.innerHTML = "";
    const thinking = bubble("Wilo is thinking…", "wilo thinking");
    const res = await send("ask", { text });
    thinking.remove();
    if (!res || !res.reply) {
      bubble("Sorry, I couldn't think just now. Try again?", "wilo");
      askBox();
      return;
    }
    const { reply } = res;
    wiloBubble(reply, res.fallback ? null : res.id);
    if (reply.decision === "grant") {
      actions.innerHTML = `<div class="row"><button class="main" id="ok">Thanks, Wilo</button></div>`;
      root.getElementById("ok").addEventListener("click", async () => resume(await send("status")));
    } else if (reply.decision === "counter_offer") {
      offerActions(reply);
    } else {
      declinedActions();
    }
  }

  function resume(res) {
    talking = false;
    if (res && res.session) session = res.session;
    hide();
    schedule();
  }

  // --- Keeping in sync -------------------------------------------------------

  function schedule() {
    clearTimeout(timer);
    if (!session) return;
    const left = session.endsAt - Date.now();
    if (left <= 0) {
      if (mode !== "timeup") showTimeUp();
      return;
    }
    if (mode === "timeup") hide(); // extended from another tab
    timer = setTimeout(schedule, Math.min(left + 250, 60 * 1000));
  }

  async function check() {
    const res = await send("status");
    if (!res) return; // no answer: extension reloaded, this old script is disconnected
    session = res.session;
    if (!session) {
      if (mode !== "start") showStart({ onboarding: res.onboarding, question: res.question, welcomeBack: res.welcomeBack });
      return;
    }
    if (res.freeStart) freeToast(res.freeStart);
    if (mode === "start") hide(); // started from another tab
    schedule();
  }

  // background.js asks this before adding Wilo to an open tab, so a tab never
  // gets two copies.
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg && msg.type === "wilo-ping" && !disposed && newest()) reply({ alive: true });
  });

  // Another tab started, extended or ended this site's session.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (disposed || area !== "session" || !changes.sessions) return;
    const next = (changes.sessions.newValue || {})[site] || null;
    const had = !!session;
    session = next;
    if (talking) return;
    if (!session) {
      if (had && mode !== "start") showStart();
      return;
    }
    if (mode === "start") hide();
    if (mode !== "timeup" || session.endsAt > Date.now()) schedule();
  });

  checkIn = setInterval(() => {
    if (connected() && newest()) send("status");
    else dispose();
  }, CHECK_IN_MS);
  check();
})();
