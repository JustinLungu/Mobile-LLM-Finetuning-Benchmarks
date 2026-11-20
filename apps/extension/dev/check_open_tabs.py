"""Check that Wilo works in tabs that were already open before an install or update.

Usage (from the repository root, after `uv run apps/extension/setup.py`):
    uv run apps/extension/dev/check_open_tabs.py

Opens Instagram and YouTube, then installs the extension, then reloads it twice exactly
like the reload button on chrome://extensions (chrome.developerPrivate.reload).
After each step, Wilo's start screen must be shown in the open tab, and
starting a session must work, without reloading the tab, and Chrome must
record no errors for the extension. No model is needed.
"""

import shutil
import sys
import tempfile
import time

from check_extension import EXTENSION, Chrome, wait_for

# Wilo's first screen: the onboarding offer the first time, the start form after.
VISIBLE = ("[...document.querySelectorAll('[data-wilo-overlay]')]"
           ".filter(e => e.style.display === 'block' && e.shadowRoot && (e.shadowRoot.getElementById('intent') || e.shadowRoot.getElementById('sure'))).length")
START = """(async () => { const r = [...document.querySelectorAll('[data-wilo-overlay]')].find(e => e.style.display === 'block').shadowRoot;
    if (r.getElementById('skip')) { r.getElementById('skip').click(); await new Promise(x => setTimeout(x, 300)); }
    const i = r.getElementById('intent'); i.value = 'check DMs'; i.dispatchEvent(new Event('input'));
    r.querySelector('.chip[data-min="5"]').click(); r.getElementById('go').click();
    for (let i = 0; i < 40 && !r.getElementById('go-now'); i++) await new Promise(x => setTimeout(x, 250));
    r.getElementById('go-now').click(); return true; })()"""


COUNT = "document.querySelectorAll('[data-wilo-overlay]').length"
SITES = ["https://www.instagram.com/", "https://www.youtube.com/"]


def main() -> int:
    profile = tempfile.mkdtemp(prefix="wilo-chrome-")
    chrome = Chrome(profile)
    ok = True
    try:
        chrome.call("Target.setDiscoverTargets", {"discover": True})
        pages = {url: chrome.attach(chrome.call("Target.createTarget", {"url": url})["targetId"]) for url in SITES}
        time.sleep(6)
        ext_id = chrome.call("Extensions.loadUnpacked", {"path": str(EXTENSION)})["id"]
        settings = chrome.attach(chrome.call("Target.createTarget", {"url": "chrome://extensions"})["targetId"])
        time.sleep(2)
        chrome.evaluate(settings, "chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode: true}).then(() => true)")

        for step in ["install", "reload 1", "reload 2"]:
            if step != "install":
                chrome.evaluate(settings, f"chrome.developerPrivate.reload({ext_id!r}, {{failQuietly: true}}).then(() => true)")
            time.sleep(15)  # the background checks open tabs 1.5, 5 and 12 s after an install or update
            for url, page in pages.items():
                shown = wait_for(lambda: chrome.evaluate(page, VISIBLE), 20, every=0.5, what=f"start screen on {url} after {step}")
                count = chrome.evaluate(page, COUNT)
                print(f"{step}: {url}: start screen shown, {count} overlay(s)")
                ok &= shown == 1 and count == 1
        for url, page in pages.items():
            chrome.evaluate(page, START)
            time.sleep(3)
            started = chrome.evaluate(page, VISIBLE) == 0
            print(f"{url}: starting a session works: {started}")
            ok &= started
        errors = chrome.evaluate(settings, f"chrome.developerPrivate.getExtensionInfo({ext_id!r}).then(i => i.runtimeErrors.map(e => e.message + ' @ ' + e.contextUrl))")
        print(f"errors recorded by Chrome: {errors or 'none'}")
        ok &= not errors
    finally:
        chrome.close()
        shutil.rmtree(profile, ignore_errors=True)
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
