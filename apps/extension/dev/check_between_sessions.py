"""Check what Wilo remembers between sessions, and the user's free-time rules.

Usage (from the repository root, after `uv run apps/extension/setup.py`):
    uv run apps/extension/dev/check_between_sessions.py

1. Starts an Instagram session ("Sleep" planned after), clicks "I'm done",
   reopens Instagram: the start screen must say "Welcome back" and mention
   "Sleep", and Wilo's memory note must have a "Recently" line.
2. Sets up a free-time rule covering the current time from the start screen's
   form, with a reason: the start screen closes, a "Free time until ..." note
   appears in the corner, a session runs until the window ends, and the rule
   and its reason are in Wilo's note.
Screenshots go to results/extension/. No model is needed.
"""

import base64
import json
import shutil
import sys
import tempfile
import time

from check_extension import EXTENSION, REPO_ROOT, Chrome, page_js, wait_for

OUT = REPO_ROOT / "results" / "extension"


def shot(chrome, page, name):
    OUT.mkdir(parents=True, exist_ok=True)
    data = chrome.call("Page.captureScreenshot", {"format": "png"}, page)["data"]
    (OUT / name).write_bytes(base64.b64decode(data))


def open_instagram(chrome):
    page = chrome.attach(chrome.call("Target.createTarget", {"url": "https://www.instagram.com/"})["targetId"])
    chrome.call("Emulation.setEmulatedMedia", {"features": [{"name": "prefers-color-scheme", "value": "dark"}]}, page)
    return page


def main() -> int:
    profile = tempfile.mkdtemp(prefix="wilo-chrome-")
    chrome = Chrome(profile)
    ok = True
    try:
        chrome.call("Target.setDiscoverTargets", {"discover": True})
        ext = chrome.call("Extensions.loadUnpacked", {"path": str(EXTENSION)})["id"]
        sw = chrome.attach(chrome.find_target(lambda t: t["type"] == "service_worker" and ext in t["url"])["targetId"])

        # 1. A session with "Sleep" next, ended with "I'm done", then back right away.
        page = open_instagram(chrome)
        wait_for(lambda: chrome.evaluate(page, page_js("return !!r && !!r.getElementById('sure');")), 30, every=0.5, what="onboarding")
        chrome.evaluate(page, page_js("r.getElementById('sure').click(); return true;"))
        for answer in ["00:00", "Balanced", "Sleeping on time", "Reading"]:
            wait_for(lambda: chrome.evaluate(page, page_js(f"const c = [...r.querySelectorAll('.chip')].find(c => c.textContent === {json.dumps(answer)}); if (c) c.click(); return !!c;")), 5, every=0.2, what=f"answer {answer}")
        wait_for(lambda: chrome.evaluate(page, page_js("return !!r.getElementById('intent');")), 10, every=0.3, what="start screen")
        chrome.evaluate(page, page_js("""const set = (id, v) => { const e = r.getElementById(id); e.value = v; e.dispatchEvent(new Event('input')); };
            set('intent', 'Check reels'); r.querySelector('.chip[data-min="10"]').click(); set('next', 'Sleep'); r.getElementById('go').click(); return true;"""))
        wait_for(lambda: chrome.evaluate(page, page_js("const g = r && r.getElementById('go-now'); if (g) g.click(); return !!g;")), 20, every=0.3, what="Let's go")
        time.sleep(1)
        chrome.evaluate(sw, "wilo.handlers['time-up-now']()")
        wait_for(lambda: chrome.evaluate(page, page_js("return !!r.getElementById('done');")), 15, every=0.3, what="time-up")
        chrome.evaluate(page, page_js("r.getElementById('done').click(); return true;"))  # closes the tab
        time.sleep(2)
        page = open_instagram(chrome)
        welcome = wait_for(lambda: chrome.evaluate(page, page_js("const w = r && r.querySelector('.welcome'); return w && w.textContent;")), 30, every=0.5, what="welcome back")
        print(f"1. Start screen after coming back: {welcome}")
        ok &= "Sleep" in welcome
        shot(chrome, page, "welcome_back_dark.png")
        note = chrome.evaluate(sw, "wilo.currentNote()")
        print("   Memory note:\n     " + note.replace("\n", "\n     "))
        ok &= "Recently:" in note and "Enjoys reading" in note and "strict strictness" not in note

        # 2. A free-time rule covering now, set up from the start screen with a reason.
        rule = {"from": time.strftime("%H:%M", time.localtime(time.time() - 600)), "to": time.strftime("%H:%M", time.localtime(time.time() + 3600))}
        chrome.evaluate(sw, "chrome.storage.session.set({sessions: {}}).then(() => true)")
        page = open_instagram(chrome)
        wait_for(lambda: chrome.evaluate(page, page_js("return !!r && !!r.getElementById('free-open');")), 30, every=0.5, what="start screen")
        chrome.evaluate(page, page_js("r.getElementById('free-open').click(); return true;"))
        time.sleep(0.3)
        shot(chrome, page, "free_time_form_dark.png")
        chrome.evaluate(page, page_js(f"""const set = (id, v) => {{ r.getElementById(id).value = v; }};
            set('free-from', {json.dumps(rule['from'])}); set('free-to', {json.dumps(rule['to'])}); set('free-why', 'my break between lectures');
            r.getElementById('free-save').click(); return true;"""))
        toast = wait_for(lambda: chrome.evaluate(page, "(() => { const t = [...document.querySelectorAll('[data-wilo-overlay]')].find(e => e.shadowRoot && e.shadowRoot.querySelector('.toast')); return t && t.shadowRoot.querySelector('.toast').innerText; })()"), 30, every=0.5, what="free-time note")
        print(f"2. Free-time note: {toast!r}")
        shot(chrome, page, "free_time_dark.png")
        start_shown = chrome.evaluate(page, page_js("return !!r && host.style.display === 'block';"))
        session = chrome.evaluate(sw, "chrome.storage.session.get('sessions').then(x => x.sessions['www.instagram.com'])")
        print(f"   Start screen shown: {start_shown}; session: free={session.get('free')}, {session['agreedMin']} min until {rule['to']}")
        ok &= not start_shown and session.get("free") and "Free time until" in toast
        note = chrome.evaluate(sw, "wilo.currentNote()")
        ok &= "Their rules:" in note and "my break between lectures" in note
        print("   Rules line: " + [l for l in note.split("\n") if l.startswith("Their rules")][0])
        errors = [l for l in chrome.console if "EXCEPTION" in l]
        print("errors:", errors or "none")
        ok &= not errors
    finally:
        chrome.close()
        shutil.rmtree(profile, ignore_errors=True)
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
