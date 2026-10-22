"""A project-local temporary fixture avoids restricted system temp directories."""

from __future__ import annotations

import shutil
from pathlib import Path
from collections.abc import Iterator
from uuid import uuid4

import pytest


@pytest.fixture
def local_tmp_path() -> Iterator[Path]:
    root = Path(__file__).resolve().parents[1] / ".test-runtime"
    root.mkdir(parents=True, exist_ok=True)
    path = root / uuid4().hex
    path.mkdir()
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)
