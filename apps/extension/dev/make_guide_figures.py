"""Make the screenshots for the tester guide (apps/extension/guide/img/).

Usage (from the repository root, after `uv run apps/extension/setup.py`):
    uv run apps/extension/dev/make_guide_figures.py

Uses the real extension in headless Chrome. The conversations shown are
staged (written into the session, not generated), so the pictures stay the
same every time; the model isn't needed. Re-run after changing the design.
"""

import base64
import json
import shutil
import sys
import tempfile
import time

from check_extension import EXTENSION, Chrome, page_js, wait_for

OUT = EXTENSION / "guide" / "img"
SCALE = 2  # retina-sharp pictures

# A short, realistic negotiation (the kind the base model gives).
CONVERSATION = [
    {
        "says": "My friend just answered, I want to reply to her last message",
        "reply": {"relation": "continuation", "assessment": "", "decision": "counter_offer", "minutes": 3,
                  "message": "Sure, finish that reply! I can give you 3 more minutes, then it's time for your study session."},
    },
]


def card_clip(chrome, page, selector_js, pad=14):
    rect = wait_for(lambda: chrome.evaluate(page, f"(() => {{ try {{ const r = {selector_js}.getBoundingClientRect(); return {{x: r.x, y: r.y, w: r.width, h: r.height}}; }} catch {{ return null; }} }})()"), 10, every=0.3, what="element to picture")
    return {"x": max(0, rect["x"] - pad), "y": max(0, rect["y"] - pad), "width": rect["w"] + 2 * pad, "height": rect["h"] + 2 * pad, "scale": 1}


def shoot(chrome, page, name, clip=None):
    params = {"format": "png", "captureBeyondViewport": False}
    if clip:
        params["clip"] = clip
    data = chrome.call("Page.captureScreenshot", params, page)["data"]
    (OUT / name).write_bytes(base64.b64decode(data))
    print(f"  {name}")


def new_page(chrome, url, width=1280, height=900, dark=False):
    page = chrome.attach(chrome.call("Target.createTarget", {"url": url})["targetId"])
    chrome.call("Emulation.setDeviceMetricsOverride", {"width": width, "height": height, "deviceScaleFactor": SCALE, "mobile": False}, page)
    chrome.call("Emulation.setEmulatedMedia", {"features": [{"name": "prefers-color-scheme", "value": "dark" if dark else "light"}]}, page)
    return page


CARD = "[...document.documentElement.children].find(e => e.shadowRoot && e.shadowRoot.getElementById('card')).shadowRoot.getElementById('card')"


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    profile = tempfile.mkdtemp(prefix="wilo-chrome-")
    chrome = Chrome(profile)
    try:
        chrome.call("Target.setDiscoverTargets", {"discover": True})
        ext = chrome.call("Extensions.loadUnpacked", {"path": str(EXTENSION)})["id"]
        sw = chrome.attach(chrome.find_target(lambda t: t["type"] == "service_worker" and ext in t["url"])["targetId"])
        # The background adds Wilo to open tabs 1.5, 5 and 12 s after an install;
        # wait until that's over so no card gets swapped mid-picture.
        time.sleep(13)

        # 1. chrome://extensions: Developer mode and Load unpacked.
        settings = new_page(chrome, "chrome://extensions", width=1100, height=520)
        time.sleep(2)
        chrome.evaluate(settings, "chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode: true}).then(() => true)")
        time.sleep(1.5)
        shoot(chrome, settings, "1-extensions-page.png", {"x": 0, "y": 0, "width": 1100, "height": 112, "scale": 1})

        # 2. The popup, ready (status shown as testers see it once the model is in).
        chrome.evaluate(sw, "chrome.offscreen.closeDocument().catch(() => {}).then(() => chrome.storage.session.set({model: {state: 'ready', key: 'llama3.2-3b', gpu: true, gpuNote: ''}}))")
        popup = new_page(chrome, f"chrome-extension://{ext}/popup.html", width=352, height=1400)
        time.sleep(1.5)
        chrome.evaluate(sw, "chrome.storage.session.set({model: {state: 'ready', key: 'llama3.2-3b', gpu: true, gpuNote: ''}})")
        time.sleep(0.5)
        h = chrome.evaluate(popup, "document.querySelector('section').getBoundingClientRect().top")
        shoot(chrome, popup, "2-popup-ready.png", {"x": 0, "y": 0, "width": 352, "height": h - 4, "scale": 1})

        # 3. The first-time questions, then 4. the start screen.
        page = new_page(chrome, "https://www.instagram.com/", height=1500)  # tall, so the whole card fits
        wait_for(lambda: chrome.evaluate(page, page_js("return !!r && !!r.getElementById('sure');")), 30, every=0.5, what="onboarding")
        chrome.evaluate(sw, "chrome.storage.session.set({model: {state: 'ready', key: 'llama3.2-3b', gpu: true, gpuNote: ''}})")
        shoot(chrome, page, "3-get-to-know.png", card_clip(chrome, page, CARD))
        chrome.evaluate(page, page_js("r.getElementById('skip').click(); return true;"))
        wait_for(lambda: chrome.evaluate(page, page_js("return !!r.getElementById('intent');")), 10, every=0.3, what="start screen")
        chrome.evaluate(page, page_js("""const set = (id, v) => { const e = r.getElementById(id); e.value = v; e.dispatchEvent(new Event('input')); };
            set('intent', 'Reply to my friend'); r.querySelector('.chip[data-min="10"]').click(); set('next', 'Study session at 18:00'); return true;"""))
        time.sleep(0.3)
        shoot(chrome, page, "4-start.png", card_clip(chrome, page, CARD))

        # 4b. Wilo reviews a vague plan and asks (staged plan conversation).
        plan = {"app": "Instagram", "intent": "idk", "next": "", "minutes": 10, "turns": [{
            "id": "p0", "phase": "start", "says": None, "situation": "", "raw": "{}",
            "reply": {"assessment": "", "decision": "ask", "minutes": 10,
                      "message": "No plan yet? What would you like to do here? Even just relaxing is fine."}}]}
        chrome.evaluate(sw, f"chrome.storage.session.set({{plans: {{'www.instagram.com': {json.dumps(plan)}}}}}).then(() => true)")
        chrome.call("Page.reload", {}, page)
        wait_for(lambda: chrome.evaluate(page, page_js("return !!r && !!r.getElementById('plan-why');")), 20, every=0.5, what="plan chat")
        chrome.evaluate(page, page_js("const w = r.getElementById('plan-why'); w.value = 'Honestly just want to relax for a bit'; w.dispatchEvent(new Event('input')); return true;"))
        time.sleep(0.3)
        shoot(chrome, page, "4b-plan.png", card_clip(chrome, page, CARD))

        # 5. Time's up, with a short conversation.
        plan = {"app": "Instagram", "intent": "Reply to my friend", "next": "Study session at 18:00", "minutes": 10, "turns": []}
        chrome.evaluate(sw, f"chrome.storage.session.set({{plans: {{'www.instagram.com': {json.dumps(plan)}}}}}).then(() => wilo.handlers['plan-accept']({{site: 'www.instagram.com', minutes: 10}}))")
        time.sleep(1)
        turns = [{"id": f"t{i}", "says": t["says"], "situation": "", "raw": json.dumps(t["reply"]), "reply": t["reply"]} for i, t in enumerate(CONVERSATION)]
        chrome.evaluate(sw, f"""chrome.storage.session.get('sessions').then(({{sessions}}) => {{
            const s = sessions['www.instagram.com']; const back = 12 * 60000;
            s.startedAt -= back; s.endsAt -= back; s.turns = {json.dumps(turns)}; s.conversationFrom = 0;
            return chrome.storage.session.set({{sessions}}); }})""")
        chrome.call("Page.reload", {}, page)
        wait_for(lambda: chrome.evaluate(page, page_js("return !!r && !!r.getElementById('take');")), 20, every=0.5, what="time-up")
        time.sleep(0.5)
        shoot(chrome, page, "5-time-up.png", card_clip(chrome, page, CARD))

        # 6. Free time: the form on the start screen, and the note in the corner.
        chrome.evaluate(sw, "chrome.storage.session.set({sessions: {}}).then(() => chrome.storage.local.set({log: []}))")
        chrome.call("Page.reload", {}, page)
        wait_for(lambda: chrome.evaluate(page, page_js("return !!r && !!r.getElementById('free-open');")), 20, every=0.5, what="start screen")
        time.sleep(1.5)  # the start screen settles (status check) after the reload
        wait_for(lambda: chrome.evaluate(page, page_js("if (!r || !r.getElementById('free-open')) return false; r.getElementById('free-open').click(); r.getElementById('free-why').value = 'my break after lectures'; return true;")), 10, every=0.5, what="free-time form")
        time.sleep(0.3)
        free = "[...document.documentElement.children].find(e => e.shadowRoot && e.shadowRoot.getElementById('card')).shadowRoot.querySelector('.free')"
        shoot(chrome, page, "6-free-time-form.png", card_clip(chrome, page, free, pad=10))
        rule = {"days": "every day", "from": time.strftime("%H:%M", time.localtime(time.time() - 600)), "to": time.strftime("%H:%M", time.localtime(time.time() + 3600))}
        chrome.evaluate(sw, f"wilo.getProfile().then(p => chrome.storage.local.set({{profile: {{...p, onboarding: {{offered: true, answers: {{hobby: 'Reading'}}}}, rules: [{json.dumps(rule)}]}}}})).then(() => chrome.storage.session.set({{sessions: {{}}}}))")
        chrome.call("Page.reload", {}, page)
        toast = "[...document.documentElement.children].find(e => e.shadowRoot && e.shadowRoot.querySelector('.toast')).shadowRoot.querySelector('.toast')"
        wait_for(lambda: chrome.evaluate(page, f"!!([...document.documentElement.children].find(e => e.shadowRoot && e.shadowRoot.querySelector('.toast')))"), 20, every=0.5, what="free-time note")
        time.sleep(0.5)
        shoot(chrome, page, "7-free-time-note.png", card_clip(chrome, page, toast, pad=12))

        # 8. The popup's study section, with the send button.
        chrome.evaluate(sw, "chrome.storage.session.set({model: {state: 'ready', key: 'llama3.2-3b', gpu: true, gpuNote: ''}})")
        chrome.call("Page.reload", {}, popup)
        time.sleep(1.5)
        chrome.evaluate(popup, "document.querySelector('details').open = true; true")
        time.sleep(0.3)
        shoot(chrome, popup, "8-popup-study.png", card_clip(chrome, popup, "document.querySelector('details')", pad=8))
        errors = [l for l in chrome.console if "EXCEPTION" in l]
        print("errors:", errors or "none")
    finally:
        chrome.close()
        shutil.rmtree(profile, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
