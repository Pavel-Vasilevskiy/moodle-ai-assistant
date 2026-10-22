"""Small Windows Tkinter launcher for the existing local FastAPI backend."""

from __future__ import annotations

import json
import queue
import threading
import tkinter as tk
from tkinter import messagebox, ttk
import urllib.error
import urllib.request

from app.launcher_manager import BACKEND_URL, BackendProcessManager


class AssistantLauncher:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.manager = BackendProcessManager()
        self.messages: queue.Queue[tuple[str, object]] = queue.Queue()
        self.busy = False
        self.status = tk.StringVar(value="Stopped")
        self.address = tk.StringVar(value=BACKEND_URL)
        self.model = tk.StringVar(value="Not loaded")
        self.session = tk.StringVar(value="No session usage yet")
        self.all_time = tk.StringVar(value="No recorded usage yet")

        root.title("Moodle AI Assistant")
        root.geometry("540x430")
        root.minsize(480, 390)
        root.protocol("WM_DELETE_WINDOW", self.close)
        self._build_ui()
        root.after(100, self._poll_messages)
        self.check_status()

    def _build_ui(self) -> None:
        frame = ttk.Frame(self.root, padding=18)
        frame.pack(fill="both", expand=True)
        ttk.Label(frame, text="Moodle AI Assistant", font=("Segoe UI", 16, "bold")).pack(anchor="w")
        ttk.Label(frame, text="Local FastAPI service", foreground="#59665f").pack(anchor="w", pady=(0, 16))

        status_frame = ttk.LabelFrame(frame, text="Backend", padding=12)
        status_frame.pack(fill="x")
        ttk.Label(status_frame, text="Status:").grid(row=0, column=0, sticky="w")
        self.status_label = ttk.Label(status_frame, textvariable=self.status, font=("Segoe UI", 10, "bold"))
        self.status_label.grid(row=0, column=1, sticky="w", padx=(8, 0))
        ttk.Label(status_frame, text="Address:").grid(row=1, column=0, sticky="w", pady=(6, 0))
        ttk.Label(status_frame, textvariable=self.address).grid(row=1, column=1, sticky="w", padx=(8, 0), pady=(6, 0))
        buttons = ttk.Frame(status_frame)
        buttons.grid(row=2, column=0, columnspan=2, sticky="w", pady=(12, 0))
        self.start_button = ttk.Button(buttons, text="Start Assistant", command=self.start_backend)
        self.start_button.pack(side="left")
        self.check_button = ttk.Button(buttons, text="Check Status", command=self.check_status)
        self.check_button.pack(side="left", padx=8)
        self.stop_button = ttk.Button(buttons, text="Stop Assistant", command=self.stop_backend)
        self.stop_button.pack(side="left")

        stats = ttk.LabelFrame(frame, text="OpenAI usage", padding=12)
        stats.pack(fill="both", expand=True, pady=(14, 0))
        ttk.Label(stats, text="Configured model:").grid(row=0, column=0, sticky="w")
        ttk.Label(stats, textvariable=self.model).grid(row=0, column=1, sticky="w", padx=(8, 0))
        ttk.Label(stats, text="Current session:").grid(row=1, column=0, sticky="nw", pady=(10, 0))
        ttk.Label(stats, textvariable=self.session, justify="left").grid(row=1, column=1, sticky="w", padx=(8, 0), pady=(10, 0))
        ttk.Label(stats, text="All time:").grid(row=2, column=0, sticky="nw", pady=(10, 0))
        ttk.Label(stats, textvariable=self.all_time, justify="left").grid(row=2, column=1, sticky="w", padx=(8, 0), pady=(10, 0))
        self.refresh_button = ttk.Button(stats, text="Refresh Statistics", command=self.refresh_statistics)
        self.refresh_button.grid(row=3, column=0, columnspan=2, sticky="w", pady=(12, 0))
        ttk.Label(frame, text="Closing this window stops only a backend started by this Launcher.", foreground="#59665f").pack(anchor="w", pady=(10, 0))

    def _run_worker(self, task: str, function) -> None:
        if self.busy:
            return
        self.busy = True
        if task == "start":
            self.status.set("Starting…")
        elif task == "check":
            self.status.set("Checking status…")
        for button in (self.start_button, self.check_button, self.stop_button, self.refresh_button):
            button.configure(state="disabled")

        def run() -> None:
            try:
                self.messages.put((task, function()))
            except Exception as error:  # User-visible, sanitized operational message only.
                self.messages.put((task, error))

        threading.Thread(target=run, daemon=True).start()

    def start_backend(self) -> None:
        def start() -> tuple[str, str]:
            result = self.manager.start()
            if result == "already_running":
                return result, "A backend is already responding at this address. It was not started again."
            if result == "already_managed":
                return result, "The Launcher-managed backend is already running."
            if self.manager.wait_until_ready():
                return "running", "Backend is ready."
            detail = self.manager.diagnostics()
            self.manager.stop()
            return "startup_failed", detail or "Uvicorn exited before the health check succeeded."
        self._run_worker("start", start)

    def check_status(self) -> None:
        self._run_worker("check", self.manager.check_status)

    def stop_backend(self) -> None:
        self._run_worker("stop", self.manager.stop)

    def refresh_statistics(self) -> None:
        def fetch_stats() -> dict[str, object]:
            request = urllib.request.Request(f"{BACKEND_URL}/api/usage", headers={"Accept": "application/json"})
            with urllib.request.urlopen(request, timeout=3) as response:
                return json.loads(response.read().decode("utf-8"))
        self._run_worker("stats", fetch_stats)

    @staticmethod
    def _format_group(group: dict[str, object]) -> str:
        cost = group.get("estimated_cost_usd")
        cost_text = "Unknown" if cost is None else f"${float(cost):.6f}"
        return (
            f"Input: {group['input_tokens']:,}   Output: {group['output_tokens']:,}\n"
            f"Total: {group['total_tokens']:,}   Requests: {group['request_count']:,}\n"
            f"Estimated cost: {cost_text}"
        )

    def _poll_messages(self) -> None:
        try:
            while True:
                task, result = self.messages.get_nowait()
                self.busy = False
                for button in (self.start_button, self.check_button, self.stop_button, self.refresh_button):
                    button.configure(state="normal")
                if isinstance(result, Exception):
                    if task == "stats":
                        self.status.set("Backend unavailable")
                        self.model.set("Unavailable")
                        self.session.set("Statistics unavailable until backend responds")
                        self.all_time.set("Statistics unavailable until backend responds")
                    else:
                        self.status.set("Error")
                        messagebox.showerror("Moodle AI Assistant", str(result), parent=self.root)
                elif task == "start":
                    state, message = result
                    self.status.set("Running" if state in ("running", "already_managed", "already_running") else "Stopped")
                    if state == "running_external":
                        self.status.set("Running (external process)")
                    elif state in ("already_running", "startup_failed"):
                        messagebox.showinfo("Moodle AI Assistant", message, parent=self.root)
                        if state == "startup_failed":
                            self.status.set("Startup failed")
                    if state in ("running", "already_managed", "already_running"):
                        self.refresh_statistics()
                elif task == "check":
                    self.status.set({"running": "Running", "running_external": "Running (external process)", "starting": "Starting…", "startup_failed": "Stopped (startup failed)", "stopped": "Stopped"}.get(result, "Unknown"))
                    if result in ("running", "running_external"):
                        self.refresh_statistics()
                    else:
                        self.model.set("Unavailable")
                        self.session.set("Start the backend to view statistics")
                        self.all_time.set("No connection to the local statistics API")
                elif task == "stop":
                    self.status.set("Stopped" if result else "No Launcher-managed backend to stop")
                elif task == "stats":
                    self.model.set(result.get("model") or "Not configured")
                    self.session.set(self._format_group(result["session"]))
                    self.all_time.set(self._format_group(result["all_time"]))
        except queue.Empty:
            pass
        self.root.after(100, self._poll_messages)

    def close(self) -> None:
        # Never terminate a server this process did not create.
        self.manager.stop()
        self.root.destroy()


def main() -> None:
    root = tk.Tk()
    AssistantLauncher(root)
    root.mainloop()


if __name__ == "__main__":
    main()
