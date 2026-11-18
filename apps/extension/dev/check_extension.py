"""End-to-end check of the Wilo extension in a real (headless) Chrome.

Usage (from the repository root, after `uv run apps/extension/setup.py`):
    uv run apps/extension/dev/check_extension.py [--model qwen3.5-2b] [--say TEXT ...] [--intent TEXT] [--next TEXT] [--flaky-mb N] [--dark] [--from-hf]

What it does:
1. Serves the local GGUF files from models/ on http://127.0.0.1:8765, so the
   check doesn't download the model from Hugging Face.
2. Starts Chrome with a fresh profile and loads apps/extension/ unpacked.
3. Opens Instagram, fills in Wilo's start screen, then jumps the clock to
   "time's up" and asks Wilo for more time.
4. Prints Wilo's reply and the log entry, and saves a screenshot to
   results/extension/ (git-ignored).

Needs Google Chrome. Uses Chrome's DevTools protocol over a pipe; loading an
unpacked extension this way needs --enable-unsafe-extension-debugging.
"""

import argparse
import base64
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
EXTENSION = HERE.parent
REPO_ROOT = EXTENSION.parent.parent
PORT = 8765
REASON = "My study group just sent the notes and I still need to answer two questions."


class Chrome:
    """Minimal DevTools-protocol client over --remote-debugging-pipe."""

    def __init__(self, profile: str):
        r_in, w_in = os.pipe()  # we write, Chrome reads on fd 3
        r_out, w_out = os.pipe()  # Chrome writes on fd 4, we read

        def child_fds():
            os.dup2(r_in, 3)
            os.dup2(w_out, 4)

        self.proc = subprocess.Popen(
            ["google-chrome", "--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
             f"--user-data-dir={profile}", "--no-first-run", "--window-size=1280,900", "about:blank"],
            pass_fds=(3, 4), preexec_fn=child_fds, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        os.close(r_in)
        os.close(w_out)
        self.out = os.fdopen(w_in, "wb", buffering=0)
        self.inp = os.fdopen(r_out, "rb", buffering=0)
        self.next_id = 0
        self.pending = {}
        self.targets = {}
        self.console = []
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        buf = b""
        while chunk := self.inp.read(1 << 16):
            buf += chunk
            while b"\0" in buf:
                raw, buf = buf.split(b"\0", 1)
                msg = json.loads(raw)
                if "id" in msg and msg["id"] in self.pending:
                    self.pending[msg["id"]][1] = msg
                    self.pending[msg["id"]][0].set()
                elif msg.get("method") in ("Target.targetCreated", "Target.targetInfoChanged"):
                    info = msg["params"]["targetInfo"]
                    self.targets[info["targetId"]] = info
                elif msg.get("method") == "Runtime.consoleAPICalled":
                    args = msg["params"]["args"]
                    self.console.append(" ".join(str(a.get("value", a.get("description", ""))) for a in args))
                elif msg.get("method") == "Runtime.exceptionThrown":
                    self.console.append("EXCEPTION " + msg["params"]["exceptionDetails"].get("exception", {}).get("description", "")[:400])

    def call(self, method, params=None, session=None, timeout=60):
        self.next_id += 1
        msg = {"id": self.next_id, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        event = threading.Event()
        self.pending[self.next_id] = [event, None]
        self.out.write(json.dumps(msg).encode() + b"\0")
        if not event.wait(timeout):
            raise TimeoutError(method)
        reply = self.pending.pop(msg["id"])[1]
        if "error" in reply:
            raise RuntimeError(f"{method}: {reply['error']}")
        return reply["result"]

    def attach(self, target_id):
        session = self.call("Target.attachToTarget", {"targetId": target_id, "flatten": True})["sessionId"]
        self.call("Runtime.enable", session=session)
        return session

    def evaluate(self, session, expression, timeout=60):
        result = self.call("Runtime.evaluate", {"expression": expression, "awaitPromise": True, "returnByValue": True}, session, timeout)
        if "exceptionDetails" in result:
            raise RuntimeError(result["exceptionDetails"].get("exception", {}).get("description", result["exceptionDetails"]))
        return result["result"].get("value")

    def find_target(self, predicate, timeout=30):
        deadline = time.time() + timeout
        while time.time() < deadline:
            for info in list(self.targets.values()):
                if predicate(info):
                    return info
            time.sleep(0.2)
        raise TimeoutError("target not found")

    def close(self):
        self.proc.kill()


def serve_models(flaky_mb: int = 0):
    """Serve models/ with Range support, like Hugging Face. With flaky_mb, drop
    every response after that many MB, to test that downloads resume."""
    root = REPO_ROOT / "models"

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_HEAD(self):
            self.respond(body=False)

        def do_GET(self):
            self.respond(body=True)

        def respond(self, body):
            path = (root / self.path.lstrip("/")).resolve()
            if root not in path.parents or not path.is_file():
                self.send_error(404)
                return
            size = path.stat().st_size
            start = 0
            ranged = self.headers.get("Range", "")
            if ranged.startswith("bytes="):
                start = int(ranged[6:].split("-")[0] or 0)
            self.send_response(206 if ranged else 200)
            self.send_header("Content-Length", str(size - start))
            self.send_header("Accept-Ranges", "bytes")
            if ranged:
                self.send_header("Content-Range", f"bytes {start}-{size - 1}/{size}")
            self.end_headers()
            if not body:
                return
            limit = flaky_mb * 1024 * 1024 if flaky_mb else size
            with open(path, "rb") as f:
                f.seek(start)
                sent = 0
                try:
                    while sent < limit and (chunk := f.read(1 << 20)):
                        self.wfile.write(chunk)
                        sent += len(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    pass
            self.close_connection = True

    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def wait_for(fn, timeout, every=1.0, what="condition"):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = fn()
        if value:
            return value
        time.sleep(every)
    raise TimeoutError(what)


# JavaScript run inside the page: find Wilo's overlay (an open shadow root).
OVERLAY = "[...document.documentElement.children].find(e => e.shadowRoot && e.shadowRoot.getElementById('card'))"


def page_js(body):
    return f"(async () => {{ const host = {OVERLAY}; const r = host && host.shadowRoot; {body} }})()"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", default="qwen3.5-2b")
    parser.add_argument("--say", action="append", help="what the user tells Wilo at time-up; repeat for a conversation")
    parser.add_argument("--intent", default="Reply to messages from my study group")
    parser.add_argument("--next", default="Workout at 18:30", help="what's planned after ('' for nothing)")
    parser.add_argument("--flaky-mb", type=int, default=0, help="test server drops each download after this many MB")
    parser.add_argument("--dark", action="store_true", help="show the pages in dark mode")
    parser.add_argument("--from-hf", action="store_true", help="download the default model from Hugging Face, as testers do")
    args = parser.parse_args()

    sys.path.insert(0, str(REPO_ROOT / "eval"))
    from llama_server import gguf_path  # noqa: E402

    gguf = gguf_path(args.model)
    model_url = f"http://127.0.0.1:{PORT}/{gguf.relative_to(REPO_ROOT / 'models').as_posix()}"
    if not (EXTENSION / "vendor" / "wllama.wasm").exists():
        print("error: run `uv run apps/extension/setup.py` first", file=sys.stderr)
        return 1

    server = serve_models(args.flaky_mb)
    profile = tempfile.mkdtemp(prefix="wilo-chrome-")
    chrome = Chrome(profile)
    ok = False
    try:
        chrome.call("Target.setDiscoverTargets", {"discover": True})
        ext_id = chrome.call("Extensions.loadUnpacked", {"path": str(EXTENSION)})["id"]
        print(f"Extension loaded ({ext_id})")
        worker = chrome.find_target(lambda t: t["type"] == "service_worker" and ext_id in t["url"])
        sw = chrome.attach(worker["targetId"])

        # Use the local model file instead of downloading from Hugging Face.
        url = "" if args.from_hf else model_url
        chrome.evaluate(sw, f"chrome.storage.local.set({{settings: {{customModelUrl: {json.dumps(url)}}}}}).then(() => wilo.restartModel())")
        t0 = time.time()

        def model_state():
            m = chrome.evaluate(sw, "chrome.storage.session.get('model').then(x => x.model || null)")
            return m if m and m.get("state") in ("ready", "error") else None

        model = wait_for(model_state, 1200 if args.from_hf else 300, what="model to load")
        print(f"Model: {model['state']} after {time.time() - t0:.1f} s {json.dumps(model)}")
        if model["state"] != "ready":
            return 1

        # Open Instagram: the start screen should appear.
        tab = chrome.call("Target.createTarget", {"url": "https://www.instagram.com/"})["targetId"]
        page = chrome.attach(tab)
        if args.dark:
            chrome.call("Emulation.setEmulatedMedia", {"features": [{"name": "prefers-color-scheme", "value": "dark"}]}, page)
        out = REPO_ROOT / "results" / "extension"
        out.mkdir(parents=True, exist_ok=True)
        theme = "dark" if args.dark else "light"

        def screenshot(name):
            shot = chrome.call("Page.captureScreenshot", {"format": "png"}, page)
            path = out / f"{name}_{theme}.png"
            path.write_bytes(base64.b64decode(shot["data"]))
            print(f"Screenshot: {path}")
        wait_for(lambda: chrome.evaluate(page, page_js("return !!r && host.style.display === 'block' && !!r.getElementById('intent');")), 60, what="start screen")
        print("Start screen shown")
        chrome.evaluate(page, page_js("r.querySelector('.chip[data-min=\"10\"]').click(); return true;"))
        screenshot("start")
        chrome.evaluate(page, page_js(f"""
            const set = (id, v) => {{ const el = r.getElementById(id); el.value = v; el.dispatchEvent(new Event('input')); }};
            set('intent', {json.dumps(args.intent)});
            r.querySelector('.chip[data-min="10"]').click();
            set('next', {json.dumps(args.next)});
            r.getElementById('go').click();
            return true;"""))
        wait_for(lambda: chrome.evaluate(page, page_js("return host.style.display === 'none';")), 10, every=0.3, what="start screen to close")
        session = chrome.evaluate(sw, "chrome.storage.session.get('sessions').then(x => x.sessions)")
        print(f"Session started: {json.dumps(session)}")

        # Jump to "time's up": pretend the session started 13 minutes ago.
        chrome.evaluate(sw, """chrome.storage.session.get('sessions').then(({sessions}) => {
            const s = sessions['www.instagram.com']; const back = 13 * 60000;
            s.startedAt -= back; s.endsAt -= back; return chrome.storage.session.set({sessions}); })""")
        wait_for(lambda: chrome.evaluate(page, page_js("return !!r.getElementById('why');")), 15, every=0.3, what="time-up screen")
        print("Time-up screen shown")

        # Say each message in turn: one conversation, so Wilo should remember.
        for n, text in enumerate(args.say or [REASON], 1):
            # After a counter-offer, "Explain more instead" brings the text box back.
            chrome.evaluate(page, page_js("const a = r.getElementById('argue'); if (a) a.click(); return true;"))
            wait_for(lambda: chrome.evaluate(page, page_js("const a = r.getElementById('ask'); return !!a;")), 5, every=0.3, what="text box")
            # A wait after repeated declines: let it run out.
            wait_for(lambda: chrome.evaluate(page, page_js("return r.getElementById('wait').textContent === '';")), 120, every=0.5, what="wait to end")
            before = chrome.evaluate(page, page_js("return r.querySelectorAll('.bubble.wilo:not(.thinking)').length;"))
            chrome.evaluate(page, page_js(f"""
                const why = r.getElementById('why'); why.value = {json.dumps(text)}; why.dispatchEvent(new Event('input'));
                r.getElementById('ask').click(); return true;"""))
            t0 = time.time()
            reply = wait_for(lambda: chrome.evaluate(page, page_js(
                f"const b = [...r.querySelectorAll('.bubble.wilo:not(.thinking)')]; "
                f"return b.length > {before} ? {{message: b[b.length - 1].firstChild.textContent, "
                f"tag: b[b.length - 1].querySelector('.tag').textContent, actions: r.getElementById('actions').innerText}} : null;")),
                180, every=0.5, what="Wilo's reply")
            print(f"\n[{n}] User: {text}\n    Wilo ({time.time() - t0:.1f} s, {reply['tag']}): {reply['message']}")
            print(f"    Buttons: {reply['actions']!r}")
            if reply["tag"].startswith("✅"):
                break

        screenshot("time_up")
        log = chrome.evaluate(sw, "chrome.storage.local.get('log').then(x => x.log)")
        negotiations = [e for e in log if e["kind"] == "negotiation"]
        print(f"\nLast reply in the log (Wilo saw {negotiations[-1]['historyTurns']} earlier exchanges):")
        print(json.dumps(negotiations[-1]["reply"], indent=2, ensure_ascii=False))
        conversations = [e for e in log if e["kind"] == "conversation"]
        if conversations:
            c = conversations[-1]
            print(f"Conversation saved: {len(c['turns'])} exchanges, outcome {c['outcome']!r}, {c['minutes']} min")
        ok = all(e.get("error") is None for e in negotiations)
    finally:
        errors = [line for line in chrome.console if "EXCEPTION" in line or "rror" in line]
        if errors:
            print("Console errors:\n  " + "\n  ".join(errors[:20]))
        chrome.close()
        server.shutdown()
        shutil.rmtree(profile, ignore_errors=True)
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
