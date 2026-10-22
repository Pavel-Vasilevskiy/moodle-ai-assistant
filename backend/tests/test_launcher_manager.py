"""Safe process-lifecycle tests for the Windows GUI launcher's manager."""

from app.launcher_manager import BackendProcessManager


class FakeProcess:
    stdout = None

    def __init__(self):
        self.running = True
        self.terminated = False

    def poll(self):
        return None if self.running else 0

    def terminate(self):
        self.terminated = True
        self.running = False

    def wait(self, timeout=None):
        return 0


def test_manager_starts_once_and_stops_only_its_child(local_tmp_path):
    process = FakeProcess()
    commands = []

    def fake_popen(command, **kwargs):
        commands.append((command, kwargs))
        return process

    manager = BackendProcessManager(
        python_executable="python-test",
        backend_dir=local_tmp_path,
        health_check=lambda: False,
        popen=fake_popen,
    )

    assert manager.start() == "started"
    assert manager.start() == "already_managed"
    assert len(commands) == 1
    assert commands[0][0][1:4] == ["-m", "uvicorn", "app.main:app"]
    assert commands[0][1]["cwd"] == local_tmp_path
    assert manager.stop()
    assert process.terminated
    assert not manager.stop()


def test_manager_does_not_duplicate_or_stop_an_external_backend(local_tmp_path):
    commands = []
    manager = BackendProcessManager(
        backend_dir=local_tmp_path,
        health_check=lambda: True,
        popen=lambda *args, **kwargs: commands.append(args),
    )

    assert manager.start() == "already_running"
    assert manager.process is None
    assert not manager.stop()
    assert commands == []
