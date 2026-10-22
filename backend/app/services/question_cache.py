"""Persistent exact-match cache for question answer suggestions."""

from __future__ import annotations

import hashlib
import logging
import os
import sqlite3
import threading
import unicodedata
from collections.abc import Callable
from datetime import datetime, timezone

from app.schemas import AIAnswer
from app.services import usage_store

logger = logging.getLogger(__name__)

# Fixed stripes keep per-question request coordination bounded in memory. The
# lock is held across lookup and generation, but no SQLite transaction is.
_QUESTION_LOCKS = tuple(threading.Lock() for _ in range(64))


def normalize_question(question: str) -> str:
    """Normalize typography, whitespace, and case while preserving punctuation."""
    normalized = unicodedata.normalize("NFC", question)
    normalized = " ".join(normalized.split()).casefold()
    return unicodedata.normalize("NFC", normalized)


def question_key(question: str) -> str:
    """Stable SHA-256 key derived only from normalized question text."""
    normalized = normalize_question(question)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _connect() -> sqlite3.Connection:
    # The cache shares the per-user SQLite file already used by token usage.
    path = usage_store.database_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout = 10000")
    return connection


def init_db() -> None:
    """Create the cache table and indexes safely on every use."""
    usage_store.init_db()
    with _connect() as connection:
        connection.execute(
            """CREATE TABLE IF NOT EXISTS question_cache (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                normalized_question TEXT NOT NULL UNIQUE,
                question_hash TEXT NOT NULL UNIQUE,
                original_question TEXT NOT NULL,
                response_json TEXT NOT NULL,
                model TEXT,
                had_options INTEGER NOT NULL CHECK(had_options IN (0, 1)),
                created_at TEXT NOT NULL,
                last_used_at TEXT NOT NULL,
                usage_count INTEGER NOT NULL DEFAULT 0 CHECK(usage_count >= 0),
                last_refreshed_at TEXT,
                refresh_count INTEGER NOT NULL DEFAULT 0 CHECK(refresh_count >= 0),
                status TEXT NOT NULL DEFAULT 'unverified'
                    CHECK(status IN ('unverified', 'verified', 'rejected'))
            )"""
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS question_cache_status ON question_cache(status)"
        )
        columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(question_cache)")
        }
        if "last_refreshed_at" not in columns:
            connection.execute(
                "ALTER TABLE question_cache ADD COLUMN last_refreshed_at TEXT"
            )
        if "refresh_count" not in columns:
            connection.execute(
                "ALTER TABLE question_cache ADD COLUMN refresh_count "
                "INTEGER NOT NULL DEFAULT 0 CHECK(refresh_count >= 0)"
            )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS question_cache_refreshes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cache_record_id INTEGER NOT NULL,
                refreshed_at TEXT NOT NULL,
                previous_response_json TEXT NOT NULL,
                new_response_json TEXT NOT NULL,
                model TEXT,
                FOREIGN KEY(cache_record_id) REFERENCES question_cache(id)
            )"""
        )


def _compatible_response(row: sqlite3.Row, options: list[str]) -> AIAnswer | None:
    """Return a cached result only when its answer fits this request safely."""
    if bool(row["had_options"]) != bool(options):
        return None
    try:
        answer = AIAnswer.model_validate_json(row["response_json"])
    except (ValueError, TypeError):
        return None

    suggestion = answer.suggested_answer
    if options and suggestion:
        # Never carry an answer position across attempts. Reuse only if the
        # stored text occurs exactly once in the current option list.
        if options.count(suggestion) != 1:
            return None
    return answer


def _read(
    question: str, options: list[str], excluded_options: list[str] | None = None
) -> AIAnswer | None:
    normalized = normalize_question(question)
    if not normalized:
        return None
    init_db()
    with _connect() as connection:
        row = connection.execute(
            """SELECT * FROM question_cache
               WHERE normalized_question = ? AND question_hash = ?""",
            (normalized, hashlib.sha256(normalized.encode("utf-8")).hexdigest()),
        ).fetchone()
        if row is None or row["status"] == "rejected":
            return None
        result = _compatible_response(row, options)
        if result is None:
            return None
        excluded_keys = {normalize_question(option) for option in excluded_options or []}
        if excluded_keys and normalize_question(result.suggested_answer) in excluded_keys:
            # The old cache entry conflicts with a verified zero-score choice.
            # Leave it untouched and let the caller obtain a fresh analysis.
            return None
        connection.execute(
            """UPDATE question_cache SET usage_count = usage_count + 1,
                   last_used_at = ? WHERE id = ? AND status != 'rejected'""",
            (datetime.now(timezone.utc).isoformat(), row["id"]),
        )
        return result


def _save(question: str, options: list[str], result: AIAnswer) -> None:
    normalized = normalize_question(question)
    if not normalized:
        return
    now = datetime.now(timezone.utc).isoformat()
    model = os.getenv("OPENAI_MODEL", "").strip() or None
    init_db()
    with _connect() as connection:
        # Lock writers for this short DB-only operation. No network call is made
        # while a SQLite transaction is open.
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT id, response_json, status FROM question_cache "
            "WHERE normalized_question = ?",
            (normalized,),
        ).fetchone()
        new_response = result.model_dump_json()
        question_digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
        if row is None:
            connection.execute(
                """INSERT INTO question_cache
                   (normalized_question, question_hash, original_question, response_json,
                    model, had_options, created_at, last_used_at, usage_count, status)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'unverified')""",
                (
                    normalized, question_digest, question, new_response, model,
                    int(bool(options)), now, now,
                ),
            )
            return

        # Verified and rejected entries remain untouched. The AI result is still
        # returned to the caller, but replacing these records needs explicit review.
        if row["status"] != "unverified":
            return

        connection.execute(
            """INSERT INTO question_cache_refreshes
               (cache_record_id, refreshed_at, previous_response_json,
                new_response_json, model)
               VALUES (?, ?, ?, ?, ?)""",
            (row["id"], now, row["response_json"], new_response, model),
        )
        connection.execute(
            """UPDATE question_cache SET response_json = ?, model = ?,
                   had_options = ?, original_question = ?, last_refreshed_at = ?,
                   refresh_count = refresh_count + 1
               WHERE id = ? AND status = 'unverified'""",
            (new_response, model, int(bool(options)), question, now, row["id"]),
        )


def get_answer_with_source(
    question: str,
    options: list[str],
    answer_generator: Callable[..., AIAnswer],
    force_refresh: bool = False,
    excluded_options: list[str] | None = None,
    negative_feedback: dict[str, object] | None = None,
) -> tuple[AIAnswer, str]:
    """Use a non-conflicting cache result or call AI with scoped feedback."""
    normalized = normalize_question(question)
    digest_prefix = hashlib.sha256(normalized.encode("utf-8")).digest()[:2]
    lock_index = int.from_bytes(digest_prefix, "big") % len(_QUESTION_LOCKS)
    lock = _QUESTION_LOCKS[lock_index]
    with lock:
        feedback = dict(negative_feedback or {})
        combined_exclusions = list(dict.fromkeys([
            *(feedback.get("incorrect_options", []) or []),
            *(excluded_options or []),
        ]))
        feedback["known_wrong_options"] = combined_exclusions
        feedback["incorrect_combinations"] = feedback.get("incorrect_combinations", []) or []
        feedback["unclassified_selections"] = feedback.get("unclassified_selections", []) or []
        feedback["moodle_feedback"] = feedback.get("moodle_feedback", []) or []
        constrained = bool(
            combined_exclusions
            or feedback["incorrect_combinations"]
            or feedback["unclassified_selections"]
            or feedback.get("has_negative_feedback")
        )
        if not force_refresh:
            try:
                cached = _read(question, options, combined_exclusions)
            except (sqlite3.Error, OSError):
                # A database outage must not prevent the existing AI flow.
                logger.warning("Question cache lookup failed; using the AI provider.")
                cached = None
            if cached is not None:
                return cached, "cache"

        result = answer_generator(question, options, feedback) if constrained else answer_generator(question, options)
        # This response is bound to a specific past failure and option set. Do
        # not replace or create the general-purpose question cache entry.
        if constrained:
            return result, "ai"
        try:
            _save(question, options, result)
        except (sqlite3.Error, OSError):
            # Keep the successful answer available even if persistence fails.
            logger.warning("Question cache write failed; the answer was not cached.")
        return result, "ai"


def get_or_generate_answer(
    question: str,
    options: list[str],
    answer_generator: Callable[..., AIAnswer],
    force_refresh: bool = False,
) -> AIAnswer:
    """Compatibility helper returning only the answer model."""
    result, _source = get_answer_with_source(
        question, options, answer_generator, force_refresh
    )
    return result
