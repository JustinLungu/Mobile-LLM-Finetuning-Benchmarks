// Runs on the watched sites. Shows Wilo's overlay: when the site opens (what
// are you here for, and for how long?) and when the time is up (negotiate).
// Everything Wilo decides happens in the background script.

(() => {
  if (window.top !== window) return; // never inside frames

  // After the extension is reloaded or updated, scripts already running in open
  // tabs lose their connection ("Extension context invalidated"). background.js
  // then injects the new version into those tabs, and the newest copy always
  // takes over: it switches the previous one off and removes its overlay.
  // (Chrome declares each page's content script once, so a previous copy only
  // exists after such an update.)
  const connected = () => {
    try {
      return !!chrome.runtime.id;
    } catch {
      return false;
    }
  };
  if (window.__wilo) window.__wilo.dispose();
  document.querySelectorAll("[data-wilo-overlay]").forEach((e) => e.remove());

  const site = location.hostname;
  const CHECK_IN_MS = 30 * 1000; // tells the background script this tab is still open
  const DECLINE_WAIT_S = 10; // wait before asking again grows by this much per decline
  const OVERRIDE_AFTER_S = 20; // "stay anyway" appears after this long

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
        width: min(420px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto;
        background: var(--card); color: var(--text); border-radius: 18px; padding: 22px; box-sizing: border-box;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
      }
      h1 { font-size: 19px; margin: 0 0 4px; color: var(--text); }
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
      .meta { display: flex; align-items: center; gap: 4px; margin-top: 6px; font-size: 12px; }
      .tag { font-weight: 600; color: var(--sub); margin-right: auto; }
      .rate { background: none; border: 0; cursor: pointer; font-size: 13px; padding: 0 2px; opacity: 0.45; }
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
  window.__wilo = { connected, dispose };

  function show(newMode) {
    if (!connected()) return dispose(); // a disconnected copy must not cover the page
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

  function showStart() {
    show("start");
    card.innerHTML = `
      <h1>Hi, I'm Wilo 👋</h1>
      <p class="sub">Before you dive into ${esc(appName())}: what's the plan?</p>
      <label for="intent">What are you here for?</label>
      <input id="intent" maxlength="200" placeholder="e.g. reply to my study group" />
      <label>How long do you need?</label>
      <div class="chips" id="chips">
        ${[5, 10, 15, 30].map((m) => `<button class="chip" data-min="${m}">${m} min</button>`).join("")}
        <input id="custom" type="number" min="1" max="240" placeholder="other" style="width: 90px;" />
      </div>
      <label for="next">Anything planned after? <span class="optional">(optional)</span></label>
      <input id="next" maxlength="200" placeholder="e.g. dinner at 19:30" />
      <div class="row"><button class="main" id="go" disabled>Start</button></div>
      <div class="err" id="err"></div>`;
    let minutes = null;
    const go = root.getElementById("go");
    const intent = root.getElementById("intent");
    const custom = root.getElementById("custom");
    const refresh = () => (go.disabled = !(intent.value.trim() && minutes > 0));
    root.getElementById("chips").addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      minutes = Number(chip.dataset.min);
      custom.value = "";
      root.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === chip));
      refresh();
    });
    custom.addEventListener("input", () => {
      minutes = Number(custom.value) || null;
      root.querySelectorAll(".chip").forEach((c) => c.classList.remove("on"));
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
      <p class="sub">You planned ${session.agreedMin} min to ${esc(lowerFirst(session.intent))}. You've been on ${esc(session.app)} for ${used} min.</p>
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

  const lowerFirst = (s) => String(s).slice(0, 1).toLowerCase() + String(s).slice(1);

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
  function askBox(waitS = 0, showOverride = false) {
    const actions = root.getElementById("actions");
    actions.innerHTML = `
      <label for="why">${showOverride ? "Still want more time? Give Wilo a real reason." : "Need more time? Tell Wilo why."}</label>
      <textarea id="why" maxlength="500" placeholder="e.g. I'm still answering the group's questions"></textarea>
      <div class="row">
        <button class="alt" id="done">I'm done</button>
        <button class="main" id="ask" disabled>Ask Wilo</button>
      </div>
      <div class="note" id="wait"></div>
      ${showOverride ? `<button class="link" id="override" style="display: none;">Stay anyway (5 min)</button>` : ""}`;
    const why = root.getElementById("why");
    const ask = root.getElementById("ask");
    const waitNote = root.getElementById("wait");
    let waiting = waitS;
    const refresh = () => (ask.disabled = waiting > 0 || !why.value.trim());
    why.addEventListener("input", refresh);
    if (waiting > 0) {
      const tick = () => {
        waitNote.textContent = waiting > 0
          ? `Wilo said no a few times, so take a breath: you can ask again in ${waiting} s.`
          : "";
        refresh();
        if (waiting-- > 0) setTimeout(tick, 1000);
      };
      tick();
    }
    if (showOverride) {
      setTimeout(() => {
        const o = root.getElementById("override");
        if (o) o.style.display = "inline";
      }, OVERRIDE_AFTER_S * 1000);
      root.getElementById("override").addEventListener("click", async () => {
        const res = await send("override");
        resume(res);
      });
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
      if (mode !== "start") showStart();
      return;
    }
    if (mode === "start") hide(); // started from another tab
    schedule();
  }

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
    if (connected()) send("status");
    else dispose();
  }, CHECK_IN_MS);
  check();
})();
