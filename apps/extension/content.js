// Runs on the watched sites. Shows Wilo's overlay: when the site opens (what
// are you here for, and for how long?) and when the time is up (negotiate).
// Everything Wilo decides happens in the background script.

(() => {
  if (window.top !== window || window.__wilo) return; // once per page, never inside frames
  window.__wilo = true;

  const site = location.hostname;
  const CHECK_IN_MS = 30 * 1000; // tells the background script this tab is still open
  const DECLINE_WAIT_S = 10; // wait before asking again grows by this much per decline
  const OVERRIDE_AFTER_S = 20; // "stay anyway" appears after this long

  let session = null;
  let timer = null;
  let mode = null; // null | "start" | "timeup"
  // True while this tab talks to Wilo: session updates from that conversation
  // (e.g. a grant) must not close the overlay before the reply is shown.
  let talking = false;

  const send = (type, fields = {}) => chrome.runtime.sendMessage({ type, site, ...fields });

  // --- Overlay ---------------------------------------------------------------

  const host = document.createElement("div");
  host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647; display: none;";
  // Open (not closed) so dev/check_extension.py can click through it.
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .backdrop {
        position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
        background: rgba(15, 23, 42, 0.72); backdrop-filter: blur(6px);
        font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #0f172a;
      }
      .card {
        width: min(420px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto;
        background: #fff; border-radius: 18px; padding: 22px; box-sizing: border-box;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
      }
      h1 { font-size: 19px; margin: 0 0 4px; }
      .sub { color: #475569; margin: 0 0 16px; }
      label { display: block; font-weight: 600; margin: 12px 0 6px; }
      input, textarea {
        width: 100%; box-sizing: border-box; font: inherit; color: inherit; background: #f8fafc;
        border: 1px solid #cbd5e1; border-radius: 10px; padding: 9px 11px;
      }
      textarea { resize: vertical; min-height: 64px; }
      input:focus, textarea:focus { outline: 2px solid #6366f1; border-color: transparent; }
      .chips { display: flex; gap: 8px; flex-wrap: wrap; }
      .chip {
        border: 1px solid #cbd5e1; background: #fff; border-radius: 999px; padding: 6px 14px; cursor: pointer; font: inherit;
      }
      .chip.on { background: #4f46e5; border-color: #4f46e5; color: #fff; }
      .row { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
      button.main, button.alt {
        flex: 1; font: inherit; font-weight: 600; border-radius: 10px; padding: 10px 14px; cursor: pointer; border: 0;
      }
      button.main { background: #4f46e5; color: #fff; }
      button.alt { background: #e2e8f0; color: #0f172a; }
      button:disabled { opacity: 0.5; cursor: default; }
      .link { background: none; border: 0; color: #64748b; text-decoration: underline; cursor: pointer; font: inherit; font-size: 13px; padding: 0; margin-top: 12px; }
      .chat { display: flex; flex-direction: column; gap: 8px; margin: 12px 0 0; }
      .bubble { padding: 9px 12px; border-radius: 14px; max-width: 85%; white-space: pre-wrap; }
      .bubble.user { align-self: flex-end; background: #4f46e5; color: #fff; border-bottom-right-radius: 4px; }
      .bubble.wilo { align-self: flex-start; background: #f1f5f9; border-bottom-left-radius: 4px; }
      .bubble.thinking { color: #64748b; font-style: italic; }
      .note { color: #64748b; font-size: 13px; margin-top: 8px; }
      .err { color: #b91c1c; font-size: 13px; margin-top: 8px; }
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

  function show(newMode) {
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
  document.addEventListener("play", () => { if (mode) pauseMedia(); }, true);

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
      <label for="next">Anything planned after? <span style="font-weight: 400; color: #64748b;">(optional)</span></label>
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
    askBox();
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

  // Text box to ask for more time, plus "I'm done". waitS > 0 delays asking.
  function askBox(waitS = 0, showOverride = false) {
    const actions = root.getElementById("actions");
    actions.innerHTML = `
      <label for="why">Need more time? Tell Wilo why.</label>
      <textarea id="why" maxlength="500" placeholder="e.g. I'm still answering the group's questions"></textarea>
      <div class="row">
        <button class="alt" id="done">I'm done</button>
        <button class="main" id="ask" disabled>Ask Wilo</button>
      </div>
      <div class="note" id="wait"></div>
      ${showOverride ? `<button class="link" id="override" style="display: none;">Stay anyway (${5} min)</button>` : ""}`;
    const why = root.getElementById("why");
    const ask = root.getElementById("ask");
    const waitNote = root.getElementById("wait");
    let waiting = waitS;
    const refresh = () => (ask.disabled = waiting > 0 || !why.value.trim());
    why.addEventListener("input", refresh);
    if (waiting > 0) {
      const tick = () => {
        waitNote.textContent = waiting > 0 ? `You can ask again in ${waiting} s.` : "";
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
    bubble(reply.message, "wilo");
    if (reply.decision === "grant") {
      actions.innerHTML = `<div class="row"><button class="main" id="ok">Thanks, Wilo (${reply.minutes} min)</button></div>`;
      root.getElementById("ok").addEventListener("click", async () => resume(await send("status")));
    } else if (reply.decision === "counter_offer") {
      actions.innerHTML = `<div class="row">
          <button class="alt" id="done">I'm done</button>
          <button class="main" id="take">Take ${reply.minutes} min</button>
        </div>
        <button class="link" id="argue">Explain more instead</button>`;
      root.getElementById("done").addEventListener("click", () => send("done"));
      root.getElementById("take").addEventListener("click", async () => resume(await send("accept", { minutes: reply.minutes })));
      root.getElementById("argue").addEventListener("click", () => askBox());
    } else {
      // Declined: asking again is always possible, but each decline adds a wait.
      const latest = await send("status");
      const declines = (latest && latest.session && latest.session.declines) || 1;
      askBox(DECLINE_WAIT_S * declines, true);
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
    let res;
    try {
      res = await send("status");
    } catch {
      return; // extension reloaded: this old script is orphaned
    }
    session = res && res.session;
    if (!session) {
      if (mode !== "start") showStart();
      return;
    }
    if (mode === "start") hide(); // started from another tab
    schedule();
  }

  // Another tab started, extended or ended this site's session.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "session" || !changes.sessions) return;
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

  setInterval(() => send("status").catch(() => {}), CHECK_IN_MS);
  check();
})();
