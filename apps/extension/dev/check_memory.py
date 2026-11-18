"""Check what Wilo learns about a user, and the check-in questions it asks.

Usage (from the repository root, after `uv run apps/extension/setup.py`):
    uv run apps/extension/dev/check_memory.py

Gives a fresh extension a made-up history (5 Instagram sessions at the current
hour, mostly running over, two with "Gym at 18:30" next), then prints:
the memory note Wilo writes, the questions it would ask in order, and the note
after a typed answer. Also checks that only one question is asked per day, and
saves a screenshot of the question on the start screen to results/extension/.
No model is needed.
"""

import base64
import json
import shutil
import sys
import tempfile
import time

from check_extension import EXTENSION, REPO_ROOT, Chrome, page_js, wait_for

out = REPO_ROOT / "results" / "extension"
profile = tempfile.mkdtemp(prefix="wilo-chrome-")
chrome = Chrome(profile)
try:
    chrome.call("Target.setDiscoverTargets", {"discover": True})
    ext = chrome.call("Extensions.loadUnpacked", {"path": str(EXTENSION)})["id"]
    sw = chrome.attach(chrome.find_target(lambda t: t["type"] == "service_worker" and ext in t["url"])["targetId"])
    hour = time.localtime().tm_hour; wd = (time.localtime().tm_wday + 1) % 7
    # 5 past Instagram sessions at this hour on this kind of day, mostly overrunning, with a repeated next event.
    log = []
    for i in range(5):
        log.append({"kind": "start", "app": "Instagram", "hour": hour, "weekday": wd, "next": "Gym at 18:30" if i < 2 else "", "minutes": 10})
        log.append({"kind": "session-end", "app": "Instagram", "agreedMin": 10, "usedMin": 18 + i, "extensions": 1 if i % 2 == 0 else 0, "startHour": hour, "weekday": wd})
    prof = {"onboarding": {"offered": True, "answers": {"bedtime": "23:00", "strictness": "Balanced"}}, "facts": [], "asked": {}}
    chrome.evaluate(sw, f"chrome.storage.local.set({{log: {json.dumps(log)}, profile: {json.dumps(prof)}}}).then(() => true)")
    print("note:\n" + chrome.evaluate(sw, "wilo.currentNote()"))
    # Which questions come, in order, if each is answered in turn (ignoring the one-a-day limit)?
    order = chrome.evaluate(sw, """(async () => { const {log, profile} = await chrome.storage.local.get(['log', 'profile']);
        let p = profile; const out = [];
        for (let i = 0; i < 6; i++) { const q = wilo.nextQuestion({...p, lastQuestionDay: null}, log, {app: 'Instagram', now: new Date()}); if (!q) break;
            out.push(q.text + ' -> ' + q.options.map(o => o.label).join(' | ')); p = {...p, asked: {...p.asked, [q.key]: 1}}; }
        return out; })()""")
    print("questions:\n  " + "\n  ".join(order))
    page = chrome.attach(chrome.call("Target.createTarget", {"url": "https://www.instagram.com/"})["targetId"])
    chrome.call("Emulation.setEmulatedMedia", {"features": [{"name": "prefers-color-scheme", "value": "dark"}]}, page)
    wait_for(lambda: chrome.evaluate(page, page_js("return !!r && !!r.querySelector('.question');")), 30, every=0.5, what="question card")
    shot = chrome.call("Page.captureScreenshot", {"format": "png"}, page)
    out.mkdir(parents=True, exist_ok=True)
    open(out / "question_dark.png", "wb").write(base64.b64decode(shot["data"]))
    chrome.evaluate(page, page_js("const i = r.querySelector('.question .own-text'); i.value = 'only on Fridays, the other days I have labs until 17:00'; i.dispatchEvent(new Event('input')); r.querySelector('.question .own-send').click(); return true;"))
    time.sleep(1)
    print("after answering, note:\n" + chrome.evaluate(sw, "wilo.currentNote()"))
    print("second question today?", chrome.evaluate(sw, "(async () => { const {log, profile} = await chrome.storage.local.get(['log','profile']); const q = wilo.nextQuestion(profile, log, {app: 'Instagram', now: new Date()}); return q ? q.text : null; })()"))
    errors = [l for l in chrome.console if "EXCEPTION" in l]
    print("errors:", errors or "none")
finally:
    chrome.close(); shutil.rmtree(profile, ignore_errors=True)
