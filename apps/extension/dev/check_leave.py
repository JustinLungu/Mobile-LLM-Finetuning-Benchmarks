"""Check that Wilo logs when the user leaves a watched site on their own.

Usage (from the repository root, after `uv run apps/extension/setup.py`):
    uv run apps/extension/dev/check_leave.py

Opens real Instagram/YouTube tabs in headless Chrome and reads the log from
storage.local. Sessions and plans are started through the background's
handlers (wilo.handlers); the 2-minute grace is cut short by re-creating the
"wilo-gone:<site>" alarm to fire now (unpacked extensions have no alarm
minimum), so the real alarm path ends the session. Cases:
 1. Start screen, close the tab: leave (start-screen, closed-tab), no session-end.
 2. Session, close the only tab: leave (session) at once; after the grace,
    session-end (left, closed-tab, endedAt = leftAt).
 3. Two tabs of the site: closing one is no leave, closing both is.
 4. Reload and same-site navigation: no leave; going to example.com: navigated-away.
 5. Instagram -> YouTube in the same tab: Instagram leave.
 6. Back within the grace: return (awayS), the session continues.
 7. Time's up, with an unsaved turn, then close: leave (time-up, minutesOver,
    inConversation); after the grace, the conversation is saved as "left".
 8. Plan review, then close: leave (plan-review); after the grace, the plan
    conversation is saved as "left".
 9. "I'm done": no leave.
10. Closing the window: closed-window.
11. a) Chrome restart (storage.session cleared, tab gone, wilo.boot()):
    browser-closed leave (approx) then session-end.
    b) The same from the start screen: start-screen browser-closed leave.
    c) A tab with the same id still on the site, but its page is newer than
    its last check-in (reloaded while the copy was frozen), as after a restart
    that reuses tab ids: not the same page, so a leave, then a return.
    d) Extension reload with the tab still open: session restored, no leave.
    e) The same with the tab discarded (Memory Saver), so it can't be asked:
    still tracked, no leave.
No model is needed (Wilo's fallback replies are used, even if one is loaded).
"""

import json
import shutil
import sys
import tempfile
import time

from check_extension import EXTENSION, Chrome, page_js, wait_for

IG = "www.instagram.com"
YT = "www.youtube.com"
URL = {IG: "https://www.instagram.com/", YT: "https://www.youtube.com/"}
GRACE_MS = 2 * 60 * 1000


class Check:
    def __init__(self):
        self.profile = tempfile.mkdtemp(prefix="wilo-chrome-")
        self.chrome = Chrome(self.profile)
        self.sw = None
        self.old_workers = set()
        self.results = []

    # --- service worker -------------------------------------------------------
    def attach_worker(self, ext):
        t = self.chrome.find_target(lambda t: t["type"] == "service_worker" and ext in t["url"] and t["targetId"] not in self.old_workers)
        self.old_workers.add(t["targetId"])
        self.sw = self.chrome.attach(t["targetId"])

    def js(self, expr):
        return self.chrome.evaluate(self.sw, expr)

    def log_len(self):
        return self.js("chrome.storage.local.get('log').then(x => (x.log || []).length)")

    def entries(self, since, kinds=("leave", "return", "session-end", "conversation")):
        """New log entries since index `since`, without the long fields."""
        return self.js(f"""chrome.storage.local.get('log').then(x => (x.log || []).slice({since})
            .filter(e => {json.dumps(list(kinds))}.includes(e.kind))
            .map(({{system, memoryNote, turns, version, ...e}}) => ({{...e, turns: turns && turns.length}})))""")

    def wait_entry(self, since, pred, what, timeout=20):
        return wait_for(lambda: next((e for e in self.entries(since) if pred(e)), None), timeout, every=0.3, what=what)

    def tracked(self, site):
        return self.js(f"wilo.getTabSites().then(t => Object.values(t).filter(s => s === {site!r}).length)")

    def state(self, site):
        return self.js(f"""Promise.all([chrome.storage.session.get(['sessions', 'plans']), chrome.alarms.get('wilo-gone:{site}')])
            .then(([s, a]) => ({{session: (s.sessions || {{}})[{site!r}] || null, plan: (s.plans || {{}})[{site!r}] || null, alarm: a ? a.scheduledTime : null}}))""")

    def fire(self, site):
        """The grace period is over now: the real onAlarm path runs."""
        self.js(f"chrome.alarms.create('wilo-gone:{site}', {{when: Date.now()}}).then(() => true)")

    def start(self, site, minutes=10, intent="Check DMs"):
        return self.js(f"wilo.handlers.start({{site: {site!r}, intent: {intent!r}, minutes: {minutes}, next: 'Sleep'}}).then(r => r.session)")

    def without_model(self, call):
        """Run a handler with Wilo's fallback reply (deterministic: never a grant)."""
        return self.js(f"""chrome.storage.session.get('model').then(async ({{model}}) => {{
            await chrome.storage.session.set({{model: {{state: 'off for check_leave'}}}});
            try {{ return await {call}; }} finally {{ await chrome.storage.session.set({{model}}); }} }})""")

    def reset(self):
        """Test-only cleanup between cases (not through the extension's logic)."""
        self.js("chrome.alarms.clearAll().then(() => chrome.storage.session.set({sessions: {}, plans: {}})).then(() => true)")

    # --- tabs -----------------------------------------------------------------
    def open(self, site, new_window=False):
        params = {"url": URL[site]}
        if new_window:
            params["newWindow"] = True
        target = self.chrome.call("Target.createTarget", params)["targetId"]
        return target, self.chrome.attach(target)

    def close(self, target):
        self.chrome.call("Target.closeTarget", {"targetId": target})

    def wait_mirror(self, site):
        """The copy in storage.local has a checked-in tab of this site."""
        wait_for(lambda: self.js(f"""chrome.storage.local.get('openState').then(({{openState: o}}) => !!o && !!o.tabSeen
            && Object.keys(o.tabSites).some(id => o.tabSites[id] === {site!r} && o.tabSeen[id]))"""), 10, every=0.3, what="mirror")

    def restart(self, site):
        """Simulated Chrome restart: in one step, empty storage.session and close
        the site's tab (so no check-in in between). Returns the old copy."""
        return self.js(f"""chrome.storage.local.get('openState').then(async ({{openState}}) => {{
            const [t] = await chrome.tabs.query({{url: 'https://{site}/*'}});
            await chrome.storage.session.clear(); await chrome.tabs.remove(t.id); return openState; }})""")

    def wait_tracked(self, site, n, timeout=40):
        # A tab is tracked from its first check-in (when the page has loaded).
        wait_for(lambda: self.tracked(site) == n, timeout, every=0.5, what=f"{n} tracked {site} tab(s)")

    # --- results --------------------------------------------------------------
    def ok(self, case, cond, detail):
        self.results.append((case, bool(cond)))
        print(f"   [{'ok' if cond else 'FAIL'}] {detail}")
        return cond


def leaves(entries, site=None):
    return [e for e in entries if e["kind"] == "leave" and (site is None or e["site"] == site)]


def ends(entries):
    return [e for e in entries if e["kind"] == "session-end"]


def main() -> int:
    c = Check()
    chrome = c.chrome
    try:
        chrome.call("Target.setDiscoverTargets", {"discover": True})
        ext = chrome.call("Extensions.loadUnpacked", {"path": str(EXTENSION)})["id"]
        c.attach_worker(ext)
        # No onboarding or check-in questions on the start screen.
        c.js("chrome.storage.local.set({profile: {onboarding: {offered: true, answers: {}}, facts: [], asked: {}, noQuestions: true}}).then(() => true)")

        # 1. Start screen, close the tab.
        print("1. Start screen, close the tab")
        n = c.log_len()
        tab, _ = c.open(IG)
        c.wait_tracked(IG, 1)
        c.close(tab)
        e = c.wait_entry(n, lambda e: e["kind"] == "leave", "leave from the start screen")
        c.ok(1, e["stage"] == "start-screen" and e["how"] == "closed-tab" and e["leftAt"], f"leave: stage={e['stage']} how={e['how']}")
        time.sleep(1.5)
        st = c.state(IG)
        c.ok(1, not ends(c.entries(n)) and not st["alarm"], f"no session-end, no grace alarm ({st['alarm']})")

        # 2. Session running, close the only tab; then the grace runs out.
        print("2. Session, close the only tab")
        c.reset()
        tab, _ = c.open(IG)
        c.wait_tracked(IG, 1)
        c.start(IG)
        n = c.log_len()
        c.close(tab)
        e = c.wait_entry(n, lambda e: e["kind"] == "leave", "leave mid-session", timeout=5)
        st = c.state(IG)
        c.ok(2, e["stage"] == "session" and e["how"] == "closed-tab" and e["intent"] == "Check DMs" and e["agreedMin"] == 10,
             f"leave right away: stage={e['stage']} how={e['how']} usedMin={e['usedMin']} inConversation={e['inConversation']}")
        c.ok(2, st["session"] and st["session"].get("leftAt") == e["leftAt"] and st["alarm"] == e["leftAt"] + GRACE_MS,
             f"session kept with leftAt; alarm at leftAt + 2 min ({st['alarm'] and (st['alarm'] - e['leftAt']) / 1000} s)")
        time.sleep(1)
        c.ok(2, not ends(c.entries(n)), "no session-end during the grace")
        c.fire(IG)
        end = c.wait_entry(n, lambda e: e["kind"] == "session-end", "session-end after the grace")
        c.ok(2, end["reason"] == "left" and end["how"] == "closed-tab" and end["endedAt"] == e["leftAt"],
             f"session-end: reason={end['reason']} how={end['how']} endedAt==leftAt: {end['endedAt'] == e['leftAt']}")
        c.ok(2, not c.state(IG)["session"], "session gone")

        # 3. Two tabs of the same site.
        print("3. Two Instagram tabs")
        c.reset()
        c.start(IG)
        t1, _ = c.open(IG)
        t2, _ = c.open(IG)
        c.wait_tracked(IG, 2)
        n = c.log_len()
        c.close(t1)
        wait_for(lambda: c.tracked(IG) == 1, 5, every=0.3, what="first tab untracked")
        time.sleep(1)
        c.ok(3, not leaves(c.entries(n)), "closing one of two tabs: no leave")
        c.close(t2)
        e = c.wait_entry(n, lambda e: e["kind"] == "leave", "leave after the second tab")
        c.ok(3, e["how"] == "closed-tab" and e["stage"] == "session" and len(leaves(c.entries(n))) == 1, f"closing the second: leave {e['how']}")
        c.fire(IG)
        c.wait_entry(n, lambda e: e["kind"] == "session-end", "cleanup session-end")

        # 4. Reload and same-site navigation, then another site.
        print("4. Reload, same-site navigation, then example.com")
        c.reset()
        c.start(IG)
        tab, page = c.open(IG)
        c.wait_tracked(IG, 1)
        n = c.log_len()
        chrome.call("Page.reload", {}, page)
        time.sleep(5)
        chrome.call("Page.navigate", {"url": "https://www.instagram.com/explore/"}, page)
        time.sleep(5)
        c.wait_tracked(IG, 1)
        c.ok(4, not leaves(c.entries(n)), f"reload + same-site navigation: no leave, tab still tracked")
        chrome.call("Page.navigate", {"url": "https://example.com/"}, page)
        e = c.wait_entry(n, lambda e: e["kind"] == "leave", "leave to example.com")
        c.ok(4, e["how"] == "navigated-away" and e["site"] == IG and e["stage"] == "session", f"example.com: leave how={e['how']}")
        c.ok(4, c.tracked(IG) == 0, "tab no longer tracked")
        c.close(tab)
        time.sleep(1)
        c.ok(4, len(leaves(c.entries(n))) == 1, "closing the example.com tab: no second leave")
        c.fire(IG)
        c.wait_entry(n, lambda e: e["kind"] == "session-end", "cleanup session-end")

        # 5. Instagram -> YouTube in the same tab.
        print("5. Instagram -> YouTube in the same tab")
        c.reset()
        c.start(IG)
        tab, page = c.open(IG)
        c.wait_tracked(IG, 1)
        n = c.log_len()
        chrome.call("Page.navigate", {"url": URL[YT]}, page)
        e = c.wait_entry(n, lambda e: e["kind"] == "leave", "Instagram leave")
        c.ok(5, e["site"] == IG and e["how"] == "navigated-away" and e["stage"] == "session", f"leave: site={e['site']} how={e['how']}")
        c.wait_tracked(YT, 1)
        c.ok(5, not leaves(c.entries(n), YT) and c.tracked(IG) == 0, "YouTube tracked in the same tab, no YouTube leave")
        c.close(tab)
        c.wait_entry(n, lambda e: e["kind"] == "leave" and e["site"] == YT, "YouTube start-screen leave")
        c.fire(IG)
        c.wait_entry(n, lambda e: e["kind"] == "session-end", "cleanup session-end")

        # 6. Back within the grace.
        print("6. Reopen within the grace")
        c.reset()
        c.start(IG)
        tab, _ = c.open(IG)
        c.wait_tracked(IG, 1)
        n = c.log_len()
        c.close(tab)
        c.wait_entry(n, lambda e: e["kind"] == "leave", "leave")
        time.sleep(2)
        tab, _ = c.open(IG)
        r = c.wait_entry(n, lambda e: e["kind"] == "return", "return", timeout=40)
        st = c.state(IG)
        c.ok(6, r["site"] == IG and r["awayS"] >= 2, f"return: awayS={r['awayS']}")
        c.ok(6, st["session"] and "leftAt" not in st["session"] and not st["alarm"], "session continues, leftAt and alarm cleared")
        c.fire(IG)  # a stale alarm must not end it
        time.sleep(2)
        c.ok(6, not ends(c.entries(n)) and c.state(IG)["session"], "no session-end (also after a stale alarm)")
        c.close(tab)
        wait_for(lambda: len(leaves(c.entries(n))) == 2, 20, every=0.3, what="cleanup leave")
        c.fire(IG)
        c.wait_entry(n, lambda e: e["kind"] == "session-end", "cleanup session-end")

        # 7. Time's up mid-conversation, then close.
        print("7. Time's up with an unsaved turn, then close")
        c.reset()
        c.start(IG)
        tab, _ = c.open(IG)
        c.wait_tracked(IG, 1)
        c.js("wilo.handlers['time-up-now']()")
        reply = c.without_model(f"wilo.handlers.ask({{site: {IG!r}, text: 'I need five more minutes'}})")
        print(f"   Wilo (fallback={reply.get('fallback')}): {reply['reply']['decision']}")
        n = c.log_len()
        time.sleep(3)
        c.close(tab)
        e = c.wait_entry(n, lambda e: e["kind"] == "leave", "leave at time-up")
        c.ok(7, e["stage"] == "time-up" and isinstance(e.get("minutesOver"), int) and e["minutesOver"] >= 0 and e["inConversation"] is True and e["fastForwarded"],
             f"leave: stage={e['stage']} minutesOver={e.get('minutesOver')} inConversation={e['inConversation']}")
        c.fire(IG)
        end = c.wait_entry(n, lambda e: e["kind"] == "session-end", "session-end")
        conv = [x for x in c.entries(n) if x["kind"] == "conversation"]
        c.ok(7, len(conv) == 1 and conv[0]["outcome"] == "left" and conv[0]["turns"] == 1 and not conv[0].get("phase"),
             f"conversation: {[(x['outcome'], x['turns']) for x in conv]}")
        c.ok(7, end["reason"] == "left" and end["endedAt"] == e["leftAt"], f"session-end: reason={end['reason']} how={end['how']}")

        # 8. Plan review, then close.
        print("8. Plan review, then close")
        c.reset()
        tab, _ = c.open(IG)
        c.wait_tracked(IG, 1)
        c.without_model(f"wilo.handlers.plan({{site: {IG!r}, intent: 'Watch one reel', minutes: 15, next: ''}})")
        plan = c.state(IG)["plan"]
        n = c.log_len()
        c.close(tab)
        e = c.wait_entry(n, lambda e: e["kind"] == "leave", "leave during the plan review")
        c.ok(8, e["stage"] == "plan-review" and e["plannedMin"] == 15 and e["planTurns"] == len(plan["turns"]) == 1,
             f"leave: stage={e['stage']} plannedMin={e.get('plannedMin')} planTurns={e.get('planTurns')}")
        c.ok(8, c.state(IG)["plan"].get("leftAt") == e["leftAt"], "plan kept with leftAt during the grace")
        c.fire(IG)
        conv = c.wait_entry(n, lambda e: e["kind"] == "conversation", "plan conversation")
        time.sleep(1)
        c.ok(8, conv["phase"] == "start" and conv["outcome"] == "left" and conv["turns"] == 1 and not c.state(IG)["plan"] and not ends(c.entries(n)),
             f"plan conversation: phase={conv['phase']} outcome={conv['outcome']}; plan dropped; no session-end")

        # 9. "I'm done".
        print("9. I'm done")
        c.reset()
        c.start(IG)
        tab, page = c.open(IG)
        c.wait_tracked(IG, 1)
        c.js("wilo.handlers['time-up-now']()")
        n = c.log_len()
        wait_for(lambda: chrome.evaluate(page, page_js("const d = r && r.getElementById('done'); if (d) d.click(); return !!d;")), 20, every=0.3, what="I'm done button")
        end = c.wait_entry(n, lambda e: e["kind"] == "session-end", "session-end (done)")
        wait_for(lambda: c.tracked(IG) == 0, 10, every=0.3, what="tab gone")
        time.sleep(1.5)
        c.ok(9, end["reason"] == "done" and end["how"] is None and not leaves(c.entries(n)), f"session-end reason={end['reason']} how={end['how']}, no leave")

        # 10. Closing the window.
        print("10. Close the window")
        c.reset()
        c.start(IG)
        tab, _ = c.open(IG, new_window=True)
        c.wait_tracked(IG, 1)
        n = c.log_len()
        c.js(f"chrome.tabs.query({{url: 'https://{IG}/*'}}).then(([t]) => chrome.windows.remove(t.windowId)).then(() => true)")
        e = c.wait_entry(n, lambda e: e["kind"] == "leave", "leave on window close")
        c.ok(10, e["how"] == "closed-window", f"leave how={e['how']}")
        c.fire(IG)
        end = c.wait_entry(n, lambda e: e["kind"] == "session-end", "session-end")
        c.ok(10, end["how"] == "closed-window", f"session-end how={end['how']}")

        # 11a. Chrome restart: storage.session emptied, the tab is gone, then boot.
        print("11a. Simulated Chrome restart")
        c.reset()
        c.start(IG)
        tab, _ = c.open(IG)
        c.wait_tracked(IG, 1)
        c.wait_mirror(IG)
        n = c.log_len()
        mirror = c.restart(IG)
        time.sleep(1.5)
        c.ok(11, not leaves(c.entries(n)), "tab closed while Wilo's session storage is empty: nothing logged yet")
        c.js("wilo.boot()")
        e = c.wait_entry(n, lambda e: e["kind"] == "leave", "browser-closed leave")
        last_seen = mirror["sessions"][IG]["lastSeen"]
        c.ok(11, e["how"] == "browser-closed" and e.get("approx") is True and e["stage"] == "session" and e["leftAt"] == last_seen,
             f"leave: how={e['how']} approx={e.get('approx')} stage={e['stage']} leftAt==lastSeen: {e['leftAt'] == last_seen}")
        st = c.state(IG)
        if st["alarm"]:  # left less than 2 min ago: rest of the grace
            print(f"   grace alarm in {(st['alarm'] - time.time() * 1000) / 1000:.0f} s; firing it now")
            c.fire(IG)
        end = c.wait_entry(n, lambda e: e["kind"] == "session-end", "session-end after restart")
        c.ok(11, end["reason"] == "left" and end["how"] == "browser-closed" and end["endedAt"] == e["leftAt"],
             f"session-end: reason={end['reason']} how={end['how']} endedAt==leftAt: {end['endedAt'] == e['leftAt']}")
        c.ok(11, c.js("chrome.storage.session.get('booted').then(x => !!x.booted)"), "booted again")

        # 11b. Chrome restart while on the start screen (no session, no plan).
        print("11b. Simulated Chrome restart from the start screen")
        c.reset()
        tab, _ = c.open(IG)
        c.wait_tracked(IG, 1)
        c.wait_mirror(IG)
        n = c.log_len()
        mirror = c.restart(IG)
        time.sleep(1.5)
        c.js("wilo.boot()")
        e = c.wait_entry(n, lambda e: e["kind"] == "leave", "start-screen browser-closed leave")
        seen = max(mirror["tabSeen"].values())
        c.ok(11, e["stage"] == "start-screen" and e["how"] == "browser-closed" and e.get("approx") is True and e["leftAt"] == seen,
             f"leave: stage={e['stage']} how={e['how']} approx={e.get('approx')} leftAt==last check-in: {e['leftAt'] == seen}")
        time.sleep(1)
        st = c.state(IG)
        c.ok(11, len(leaves(c.entries(n))) == 1 and not ends(c.entries(n)) and not st["alarm"], "one leave, no session-end, no grace alarm")

        # 11c. Same tab id, same site, but a newer page than its last check-in.
        print("11c. Same tab id and site, newer page")
        c.reset()
        c.start(IG)
        tab, page = c.open(IG)
        c.wait_tracked(IG, 1)
        c.wait_mirror(IG)
        # Freeze the copy (no "booted": changes aren't copied), then reload the
        # tab: its new page checks in, but the copy keeps the old check-in time.
        c.js("chrome.storage.session.remove('booted').then(() => true)")
        mirror = c.js("chrome.storage.local.get('openState').then(x => x.openState)")
        chrome.call("Page.reload", {}, page)
        wait_for(lambda: c.js("chrome.storage.session.get('tabSeen').then(({tabSeen = {}}) => Math.max(0, ...Object.values(tabSeen)))") > max(mirror["tabSeen"].values()),
                 40, every=0.5, what="check-in from the reloaded page")
        n = c.log_len()
        c.js("chrome.storage.session.clear().then(() => wilo.boot()).then(() => true)")
        e = c.wait_entry(n, lambda e: e["kind"] == "leave", "leave for the newer page")
        c.ok(11, e["how"] == "browser-closed" and e["stage"] == "session" and e.get("approx") is True,
             f"not the same page: leave how={e['how']} stage={e['stage']} approx={e.get('approx')}")
        r = c.wait_entry(n, lambda e: e["kind"] == "return", "return at the page's next check-in", timeout=45)
        st = c.state(IG)
        c.ok(11, st["session"] and "leftAt" not in st["session"] and not ends(c.entries(n)), f"then return (awayS={r['awayS']}), session continues")
        c.close(tab)
        wait_for(lambda: len(leaves(c.entries(n))) == 2, 20, every=0.3, what="cleanup leave")
        c.fire(IG)
        c.wait_entry(n, lambda e: e["kind"] == "session-end", "cleanup session-end")

        # 11d. Extension reload with the tab still open.
        print("11d. Extension reload with the tab open")
        c.reset()
        c.start(IG, intent="Reply to Sam")
        tab, _ = c.open(IG)
        c.wait_tracked(IG, 1)
        c.wait_mirror(IG)
        n = c.log_len()
        settings = chrome.attach(chrome.call("Target.createTarget", {"url": "chrome://extensions"})["targetId"])
        time.sleep(2)
        chrome.evaluate(settings, "chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode: true}).then(() => true)")
        chrome.evaluate(settings, f"chrome.developerPrivate.reload({ext!r}, {{failQuietly: true}}).then(() => true)")
        time.sleep(3)
        c.attach_worker(ext)
        wait_for(lambda: c.js("chrome.storage.session.get('booted').then(x => !!x.booted)"), 20, every=0.5, what="boot after reload")
        time.sleep(2)
        st = c.state(IG)
        c.ok(11, st["session"] and st["session"]["intent"] == "Reply to Sam" and "leftAt" not in st["session"] and c.tracked(IG) == 1,
             f"session restored ({st['session'] and st['session']['intent']}), tab tracked: {c.tracked(IG)}")
        c.ok(11, not leaves(c.entries(n)) and not ends(c.entries(n)), "no leave, no session-end")

        # 11e. Extension update while the tab is discarded: it can't run a script.
        print("11e. Extension update with the tab discarded")
        n = c.log_len()
        chrome.call("Target.createTarget", {"url": "about:blank"})  # the Instagram tab goes to the background
        time.sleep(1)
        gone = c.js(f"chrome.tabs.query({{url: 'https://{IG}/*'}}).then(([t]) => chrome.tabs.discard(t.id)).then(t => t.id)")
        wait_for(lambda: c.js(f"chrome.storage.local.get('openState').then(({{openState: o}}) => o.tabSites[{gone}] === {IG!r})"),
                 10, every=0.3, what="discarded tab in the copy")
        c.js("chrome.storage.session.clear().then(() => wilo.boot()).then(() => true)")
        time.sleep(3)
        st = c.state(IG)
        discarded = c.js(f"chrome.tabs.get({gone}).then(t => t.discarded)")
        c.ok(11, discarded and st["session"] and "leftAt" not in st["session"] and c.tracked(IG) == 1 and not st["alarm"],
             f"discarded={discarded}: session kept, tab tracked: {c.tracked(IG)}, no grace alarm")
        c.ok(11, not leaves(c.entries(n)) and not ends(c.entries(n)), "no leave, no session-end")

        errors =[l for l in chrome.console if "EXCEPTION" in l]
        errors += chrome.evaluate(settings, f"chrome.developerPrivate.getExtensionInfo({ext!r}).then(i => i.runtimeErrors.map(e => e.message + ' @ ' + e.contextUrl))")
        print("errors:", errors or "none")
        c.ok(0, not errors, "no errors")
    finally:
        chrome.close()
        shutil.rmtree(c.profile, ignore_errors=True)
    failed = sorted({case for case, good in c.results if not good})
    print("PASS" if not failed else f"FAIL (cases {failed})")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
