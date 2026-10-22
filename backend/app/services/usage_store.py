"""Persistent, prompt-free accounting for successful OpenAI responses."""

from __future__ import annotations

import json
import math
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

SESSION_ID = str(uuid4())
PRICING_PATH = Path(__file__).resolve().parents[2] / "pricing.json"


def database_path() -> Path:
    """Use a per-user data directory, with an override for tests and portable setups."""
    configured = os.getenv("MOODLE_ASSISTANT_DATA_DIR")
    if configured:
        return Path(configured).expanduser() / "usage.sqlite3"
    local_app_data = os.getenv("LOCALAPPDATA")
    root = Path(local_app_data) if local_app_data else Path.home() / ".local" / "share"
    return root / "MoodleAIAssistant" / "usage.sqlite3"


def _connect() -> sqlite3.Connection:
    path = database_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout = 10000")
    return connection


def init_db() -> None:
    """Create the small usage table and index safely on every call."""
    with _connect() as connection:
        connection.execute(
            """CREATE TABLE IF NOT EXISTS usage_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                occurred_at TEXT NOT NULL,
                session_id TEXT NOT NULL,
                provider_response_id TEXT UNIQUE,
                model TEXT NOT NULL,
                input_tokens INTEGER NOT NULL CHECK(input_tokens >= 0),
                output_tokens INTEGER NOT NULL CHECK(output_tokens >= 0),
                total_tokens INTEGER NOT NULL CHECK(total_tokens >= 0),
                cached_input_tokens INTEGER NOT NULL CHECK(cached_input_tokens >= 0),
                estimated_cost_usd REAL
            )"""
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS usage_records_session ON usage_records(session_id)"
        )


def _pricing_for(model: str) -> dict[str, float] | None:
    try:
        data = json.loads(PRICING_PATH.read_text(encoding="utf-8"))
        pricing = data.get("models", {}).get(model)
        if not isinstance(pricing, dict):
            return None
        keys = ("input_per_million_usd", "output_per_million_usd")
        if any(
            isinstance(pricing.get(key), bool)
            or not isinstance(pricing.get(key), (int, float))
            or not math.isfinite(pricing[key])
            or pricing[key] < 0
            for key in keys
        ):
            return None
        cached = pricing.get("cached_input_per_million_usd")
        if cached is not None and (
            isinstance(cached, bool)
            or not isinstance(cached, (int, float))
            or not math.isfinite(cached)
            or cached < 0
        ):
            return None
        return {key: float(value) for key, value in pricing.items() if isinstance(value, (int, float))}
    except (OSError, json.JSONDecodeError, AttributeError, OverflowError):
        return None


def estimate_cost_usd(
    model: str, input_tokens: int, output_tokens: int, cached_input_tokens: int = 0
) -> float | None:
    """Estimate standard-tier cost; cached tokens are already included in input_tokens."""
    pricing = _pricing_for(model)
    if not pricing or cached_input_tokens > input_tokens:
        return None
    cached_rate = pricing.get("cached_input_per_million_usd")
    if cached_input_tokens and cached_rate is None:
        return None
    regular_input = input_tokens - cached_input_tokens
    cost = (
        regular_input * pricing["input_per_million_usd"]
        + cached_input_tokens * (cached_rate or 0.0)
        + output_tokens * pricing["output_per_million_usd"]
    ) / 1_000_000
    return round(cost, 12)


def _nonnegative_int(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def record_response_usage(response: object, model: str | None = None) -> bool:
    """Persist actual SDK usage once. Return False when usage is absent or invalid."""
    usage = getattr(response, "usage", None)
    input_tokens = _nonnegative_int(getattr(usage, "input_tokens", None))
    output_tokens = _nonnegative_int(getattr(usage, "output_tokens", None))
    total_tokens = _nonnegative_int(getattr(usage, "total_tokens", None))
    response_model = getattr(response, "model", None) or model
    if (
        usage is None
        or input_tokens is None
        or output_tokens is None
        or total_tokens is None
        or not isinstance(response_model, str)
        or not response_model.strip()
        or len(response_model.strip()) > 256
    ):
        return False

    input_details = getattr(usage, "input_tokens_details", None)
    cached_value = getattr(input_details, "cached_tokens", 0)
    cached_input_tokens = _nonnegative_int(cached_value)
    cached_usage_valid = cached_input_tokens is not None and cached_input_tokens <= input_tokens
    if not cached_usage_valid:
        cached_input_tokens = 0
    response_id = getattr(response, "id", None)
    if not isinstance(response_id, str) or not response_id:
        response_id = None
    now = datetime.now(timezone.utc).isoformat()
    cost = estimate_cost_usd(response_model.strip(), input_tokens, output_tokens, cached_input_tokens) if cached_usage_valid else None
    init_db()
    with _connect() as connection:
        cursor = connection.execute(
            """INSERT OR IGNORE INTO usage_records
               (occurred_at, session_id, provider_response_id, model, input_tokens,
                output_tokens, total_tokens, cached_input_tokens, estimated_cost_usd)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (now, SESSION_ID, response_id, response_model.strip(), input_tokens,
             output_tokens, total_tokens, cached_input_tokens, cost),
        )
        return cursor.rowcount == 1


def _aggregate(connection: sqlite3.Connection, session_id: str | None) -> dict[str, object]:
    where = " WHERE session_id = ?" if session_id else ""
    args = (session_id,) if session_id else ()
    row = connection.execute(
        f"""SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
                   COALESCE(SUM(output_tokens), 0) AS output_tokens,
                   COALESCE(SUM(total_tokens), 0) AS total_tokens,
                   COUNT(*) AS request_count,
                   SUM(estimated_cost_usd) AS cost_sum,
                   SUM(CASE WHEN estimated_cost_usd IS NULL THEN 1 ELSE 0 END) AS unknown_costs
            FROM usage_records{where}""",
        args,
    ).fetchone()
    cost = None if row["unknown_costs"] else float(row["cost_sum"] or 0)
    return {
        "input_tokens": int(row["input_tokens"]),
        "output_tokens": int(row["output_tokens"]),
        "total_tokens": int(row["total_tokens"]),
        "request_count": int(row["request_count"]),
        "estimated_cost_usd": cost,
    }


def get_statistics(model: str | None) -> dict[str, object]:
    """Return aggregates only; never return question text or provider payloads."""
    init_db()
    with _connect() as connection:
        session = _aggregate(connection, SESSION_ID)
        all_time = _aggregate(connection, None)
        if model and _pricing_for(model) is None:
            if session["request_count"] == 0:
                session["estimated_cost_usd"] = None
            if all_time["request_count"] == 0:
                all_time["estimated_cost_usd"] = None
        return {
            "model": model or None,
            "session": session,
            "all_time": all_time,
        }
