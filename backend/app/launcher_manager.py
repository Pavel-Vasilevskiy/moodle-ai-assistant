"""Safely manage only the backend process created by the desktop launcher."""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
BACKEND_HOST = "127.0.0.1"
BACKEND_PORT = 8000
BACKEND_URL = f"http://{BACKEND_HOST}:{BACKEND_PORT}"


class BackendProcessManager:
    """Start/stop one Uvicorn child without killing unrelated Python processes."""

    def __init__(
        self,
        python_executable: str = sys.executable,
        backend_dir: Path = BACKEND_DIR,
        host: str = BACKEND_HOST,
        port: int = BACKEND_PORT,
        health_check=None,
        popen=None,
    ) -> None:
        self.python_executable = python_executable
        self.backend_dir = Path(backend_dir)
        self.host = host
        self.port = port
        self.base_url = f"http://{host}:{port}"
        self.health_check = health_check or self._check_health
        self._popen = popen or subprocess.Popen
        self.process: subprocess.Popen | None = None
        self._lock = threading.Lock()
        self._log_lines: deque[str] = deque(maxlen=30)
        self._output_thread: threading.Thread | None = None

    def _check_health(self) -> bool:
        try:
            with urllib.request.urlopen(f"{self.base_url}/health", timeout=0.8) as response:
                return response.status == 200
        except (urllib.error.URLError, TimeoutError, OSError):
            return False

    def _read_output(self, process: subprocess.Popen) -> None:
        if process.stdout is None:
            return
        for line in process.stdout:
            self._log_lines.append(line.rstrip())

    def diagnostics(self) -> str:
        return "\n".join(self._log_lines)

    def start(self) -> str:
        """Return 'started', 'already_managed', or 'already_running' (external)."""
        with self._lock:
            if self.process is not None and self.process.poll() is None:
                return "already_managed"
            self.process = None
            if self.health_check():
                return "already_running"

            self._log_lines.clear()
            command = [
                self.python_executable,
                "-m", "uvicorn", "app.main:app",
                "--host", self.host,
                "--port", str(self.port),
            ]
            kwargs = {
                "cwd": self.backend_dir,
                "stdout": subprocess.PIPE,
                "stderr": subprocess.STDOUT,
                "text": True,
                "encoding": "utf-8",
                "errors": "replace",
                "bufsize": 1,
            }
            if os.name == "nt":
                kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            self.process = self._popen(command, **kwargs)
            self._output_thread = threading.Thread(target=self._read_output, args=(self.process,), daemon=True)
            self._output_thread.start()
            return "started"

    def wait_until_ready(self, timeout: float = 20.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            process = self.process
            if process is None or process.poll() is not None:
                if self._output_thread is not None:
                    self._output_thread.join(timeout=0.25)
                return False
            if self.health_check():
                return True
            time.sleep(0.2)
        return False

    def check_status(self) -> str:
        """Return running, running_external, stopped, or startup_failed."""
        if self.health_check():
            if self.process is not None and self.process.poll() is None:
                return "running"
            return "running_external"
        if self.process is not None:
            if self.process.poll() is None:
                return "starting"
            self.process = None
            return "startup_failed"
        return "stopped"

    def stop(self) -> bool:
        """Terminate only this manager's own child; external servers are untouched."""
        with self._lock:
            process = self.process
            if process is None or process.poll() is not None:
                self.process = None
                return False
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
            self.process = None
            return True
