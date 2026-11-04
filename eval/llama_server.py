"""Start a llama-server for one model and talk to it over its local HTTP API.

Used by the smoke test and the benchmarks:

    with LlamaServer(gguf_path("qwen3.5-2b"), build="cuda") as server:
        reply = server.chat([{"role": "user", "content": "Hello"}])

The server only listens on 127.0.0.1, so nothing leaves the machine.
"""

import json
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
LLAMA_CPP_DIR = REPO_ROOT / "third_party" / "llama.cpp"
LOG_DIR = REPO_ROOT / "results" / "logs"

# models/ is not a package, so make its registry loader importable.
sys.path.insert(0, str(REPO_ROOT / "models"))
from download import load_registry  # noqa: E402

# Benchmarks set every option explicitly so results don't depend on llama.cpp
# defaults that change between versions or adapt to the machine.
# context size: 4,096 tokens, which is about 3,000 English words.
DEFAULT_CTX_SIZE = 4096


class ServerError(Exception):
    """llama-server failed to start or answer."""


def available_builds() -> list[str]:
    """The llama.cpp builds produced by eval/build_llama_cpp.sh."""
    builds = []
    for build in ("cpu", "cuda"):
        server_binary = LLAMA_CPP_DIR / f"build-{build}" / "bin" / "llama-server"
        if server_binary.exists():
            builds.append(build)
    return builds


def gguf_path(key: str) -> Path:
    """Where models/download.py stores a model's GGUF file."""
    model = load_registry()[key]
    return REPO_ROOT / "models" / key / model["gguf"]["file"]


def free_port() -> int:
    """Ask the operating system for an unused port."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class LlamaServer:
    def __init__(self, model: Path, build: str = "cpu", ctx_size: int = DEFAULT_CTX_SIZE):
        self.model = model
        self.build = build
        self.ctx_size = ctx_size
        self.port = free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        self.process: subprocess.Popen | None = None
        self.load_time_s: float | None = None
        self.log_path = LOG_DIR / f"server-{model.stem}-{build}.log"

    def command(self) -> list[str]:
        binary = LLAMA_CPP_DIR / f"build-{self.build}" / "bin" / "llama-server"
        return [
            str(binary),
            "--model", str(self.model),
            "--host", "127.0.0.1",
            "--port", str(self.port),
            "--ctx-size", str(self.ctx_size),
            # All layers on the GPU for the CUDA build, none for the CPU build.
            "--n-gpu-layers", "all" if self.build == "cuda" else "0",
            # Don't let llama.cpp silently change settings to fit memory.
            "--fit", "off",
            # One request at a time, like a phone app.
            "--parallel", "1",
            # Thinking mode off, through each model's own chat template. (The
            # blunter --reasoning-budget 0 cuts thinking off mid-way, and Gemma
            # then writes its reasoning into the answer instead.) Templates
            # without this switch, like Llama's, ignore it.
            "--chat-template-kwargs", json.dumps({"enable_thinking": False}),
        ]

    def start(self, timeout_s: float = 300) -> float:
        """Start the server and wait until the model is loaded. Returns the load time in seconds."""
        if not self.model.exists():
            raise ServerError(f"{self.model} not found. Download it with models/download.py.")
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        started = time.perf_counter()
        # The server keeps its own handle to the log, so ours can close right away.
        with self.log_path.open("w") as log:
            self.process = subprocess.Popen(self.command(), stdout=log, stderr=subprocess.STDOUT)

        # /health answers 503 while the model is loading and 200 once it is ready.
        while time.perf_counter() - started < timeout_s:
            if self.process.poll() is not None:
                raise ServerError(f"llama-server exited with code {self.process.returncode}. See {self.log_path}")
            try:
                with urllib.request.urlopen(f"{self.url}/health", timeout=1) as r:
                    if r.status == 200:
                        self.load_time_s = time.perf_counter() - started
                        return self.load_time_s
            except (urllib.error.URLError, ConnectionError, TimeoutError):
                pass  # not listening yet, or still loading
            time.sleep(0.1)
        self.stop()
        raise ServerError(f"llama-server did not become ready within {timeout_s:.0f} s. See {self.log_path}")

    def chat(self, messages: list[dict], max_tokens: int = 64, timeout_s: float = 300) -> dict:
        """Send one chat request and return the full JSON response."""
        body = json.dumps({
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": 0,  # always pick the most likely token: repeatable output
            "seed": 0,
        }).encode()
        request = urllib.request.Request(
            f"{self.url}/v1/chat/completions", data=body, headers={"Content-Type": "application/json"}
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout_s) as r:
                return json.load(r)
        except (urllib.error.URLError, TimeoutError) as e:
            raise ServerError(f"chat request failed: {e}. See {self.log_path}") from e

    def stop(self) -> None:
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()

    def __enter__(self) -> "LlamaServer":
        self.start()
        return self

    def __exit__(self, *exc) -> None:
        self.stop()
