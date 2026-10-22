"""Tests for exact question matching and persistent answer reuse."""

from __future__ import annotations

import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from threading import Lock

from app.schemas import AIAnswer
from app.services import question_cache


def configure_cache(monkeypatch, local_tmp_path):
    monkeypatch.setenv("MOODLE_ASSISTANT_DATA_DIR", str(local_tmp_path / "app-data"))
    monkeypatch.setenv("OPENAI_MODEL", "test-model")


def ai_answer(text="Option B") -> AIAnswer:
    return AIAnswer(
        suggested_answer=text,
        explanation="It matches the question.",
        confidence=0.8,
        needs_more_context=False,
    )


def test_normalizes_whitespace_lines_and_unicode_nfc():
    decomposed = "  Cafe\u0301\n\t question?  "
    composed = "CAFÉ question?"

    assert question_cache.normalize_question(decomposed) == question_cache.normalize_question(composed)


def test_key_uses_only_question_and_exact_normalized_text():
    first = question_cache.question_key(" Which answer? ")
    reordered_options_same_question = question_cache.question_key("which\nanswer?")

    assert first == reordered_options_same_question
    assert first != question_cache.question_key("Which answer!")
    assert first != question_cache.question_key("Which other answer?")


def test_cache_miss_generates_and_saves_then_hit_reuses_without_generator(monkeypatch, local_tmp_path):
    configure_cache(monkeypatch, local_tmp_path)
    calls = []

    def generate(question, options):
        calls.append((question, options))
        return ai_answer()

    first = question_cache.get_or_generate_answer(
        "Choose?", ["Option A", "Option B"], generate
    )
    second = question_cache.get_or_generate_answer(
        " choose? ", ["Option B", "Option A"],
        lambda *_: (_ for _ in ()).throw(AssertionError("cache should be used")),
    )

    assert first == second
    assert len(calls) == 1
    assert calls[0] == ("Choose?", ["Option A", "Option B"])
    with sqlite3.connect(question_cache.usage_store.database_path()) as connection:
        row = connection.execute(
            "SELECT usage_count, status, model, had_options FROM question_cache"
        ).fetchone()
    assert row == (1, "unverified", "test-model", 1)


def test_reinitialized_database_keeps_cached_response_and_updates_last_used(monkeypatch, local_tmp_path):
    configure_cache(monkeypatch, local_tmp_path)
    question_cache.get_or_generate_answer("Question?", [], lambda *_: ai_answer("Free answer"))
    with sqlite3.connect(question_cache.usage_store.database_path()) as connection:
        before = connection.execute(
            "SELECT last_used_at FROM question_cache"
        ).fetchone()[0]

    question_cache.init_db()
    result = question_cache.get_or_generate_answer(
        "Question?", [], lambda *_: (_ for _ in ()).throw(AssertionError("must hit cache"))
    )

    with sqlite3.connect(question_cache.usage_store.database_path()) as connection:
        usage_count, last_used = connection.execute(
            "SELECT usage_count, last_used_at FROM question_cache"
        ).fetchone()
    assert result.suggested_answer == "Free answer"
    assert usage_count == 1
    assert datetime.fromisoformat(last_used) >= datetime.fromisoformat(before)


def test_initialization_migrates_existing_cache_schema_idempotently(monkeypatch, local_tmp_path):
    configure_cache(monkeypatch, local_tmp_path)
    db_path = question_cache.usage_store.database_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            """CREATE TABLE question_cache (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                normalized_question TEXT NOT NULL UNIQUE,
                question_hash TEXT NOT NULL UNIQUE,
                original_question TEXT NOT NULL,
                response_json TEXT NOT NULL,
                model TEXT,
                had_options INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                last_used_at TEXT NOT NULL,
                usage_count INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'unverified'
            )"""
        )

    question_cache.init_db()
    question_cache.init_db()

    with sqlite3.connect(db_path) as connection:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(question_cache)")}
        assert {"last_refreshed_at", "refresh_count"}.issubset(columns)
        assert connection.execute(
            "SELECT COUNT(*) FROM question_cache_refreshes"
        ).fetchone()[0] == 0


def test_rejected_record_is_not_reused(monkeypatch, local_tmp_path):
    configure_cache(monkeypatch, local_tmp_path)
    question_cache.get_or_generate_answer("Question?", [], lambda *_: ai_answer("Old answer"))
    with sqlite3.connect(question_cache.usage_store.database_path()) as connection:
        connection.execute("UPDATE question_cache SET status = 'rejected'")

    calls = []
    result = question_cache.get_or_generate_answer(
        "Question?", [], lambda *_: calls.append(True) or ai_answer("Fresh answer"),
        force_refresh=True,
    )

    assert calls == [True]
    assert result.suggested_answer == "Fresh answer"
    with sqlite3.connect(question_cache.usage_store.database_path()) as connection:
        status = connection.execute("SELECT status FROM question_cache").fetchone()[0]
    assert status == "rejected"


def test_verified_record_is_not_overwritten_after_incompatible_options(monkeypatch, local_tmp_path):
    configure_cache(monkeypatch, local_tmp_path)
    question_cache.get_or_generate_answer(
        "Question?", ["Option A", "Option B"], lambda *_: ai_answer()
    )
    with sqlite3.connect(question_cache.usage_store.database_path()) as connection:
        connection.execute("UPDATE question_cache SET status = 'verified'")

    question_cache.get_or_generate_answer(
        "Question?", ["Option A", "Option C"], lambda *_: ai_answer("Option C")
    )
    with sqlite3.connect(question_cache.usage_store.database_path()) as connection:
        status, answer = connection.execute(
            "SELECT status, response_json FROM question_cache"
        ).fetchone()
    assert status == "verified"
    assert AIAnswer.model_validate_json(answer).suggested_answer == "Option B"


def test_forced_refresh_returns_new_answer_but_preserves_verified_record(monkeypatch, local_tmp_path):
    configure_cache(monkeypatch, local_tmp_path)
    question_cache.get_or_generate_answer(
        "Question?", ["Option A", "Option B"], lambda *_: ai_answer()
    )
    with sqlite3.connect(question_cache.usage_store.database_path()) as connection:
        connection.execute("UPDATE question_cache SET status = 'verified'")

    fresh, source = question_cache.get_answer_with_source(
        "Question?", ["Option A", "Option B"],
        lambda *_: ai_answer("Option A"), force_refresh=True,
    )

    with sqlite3.connect(question_cache.usage_store.database_path()) as connection:
        status, stored_json = connection.execute(
            "SELECT status, response_json FROM question_cache"
        ).fetchone()
        refresh_count = connection.execute(
            "SELECT COUNT(*) FROM question_cache_refreshes"
        ).fetchone()[0]
    assert source == "ai"
    assert fresh.suggested_answer == "Option A"
    assert status == "verified"
    assert AIAnswer.model_validate_json(stored_json).suggested_answer == "Option B"
    assert refresh_count == 0


def test_forced_refresh_audits_update_to_unverified_record(monkeypatch, local_tmp_path):
    configure_cache(monkeypatch, local_tmp_path)
    question_cache.get_or_generate_answer(
        "Question?", ["Option A", "Option B"], lambda *_: ai_answer()
    )

    fresh, source = question_cache.get_answer_with_source(
        "Question?", ["Option A", "Option B"],
        lambda *_: ai_answer("Option A"), force_refresh=True,
    )

    with sqlite3.connect(question_cache.usage_store.database_path()) as connection:
        answer_json, status, refresh_count = connection.execute(
            "SELECT response_json, status, refresh_count FROM question_cache"
        ).fetchone()
        history_count = connection.execute(
            "SELECT COUNT(*) FROM question_cache_refreshes"
        ).fetchone()[0]
    assert source == "ai"
    assert fresh.suggested_answer == "Option A"
    assert AIAnswer.model_validate_json(answer_json).suggested_answer == "Option A"
    assert status == "unverified"
    assert refresh_count == 1
    assert history_count == 1


def test_option_mapping_requires_unique_exact_text_and_matching_question_kind(monkeypatch, local_tmp_path):
    configure_cache(monkeypatch, local_tmp_path)
    question_cache.get_or_generate_answer(
        "Question?", ["Option A", "Option B"], lambda *_: ai_answer()
    )
    calls = []

    duplicate = question_cache.get_or_generate_answer(
        "Question?", ["Option B", "Option B"],
        lambda *_: calls.append("duplicate") or ai_answer("New answer"),
    )
    assert duplicate.suggested_answer == "New answer"
    assert calls == ["duplicate"]

    # Cache now contains the refreshed result; a transition to an open question
    # is not considered a safe match for an answer that came from options.
    open_answer = question_cache.get_or_generate_answer(
        "Question?", [], lambda *_: calls.append("open") or ai_answer("Free answer")
    )
    assert open_answer.suggested_answer == "Free answer"
    assert calls == ["duplicate", "open"]


def test_concurrent_identical_requests_generate_once_and_create_one_record(monkeypatch, local_tmp_path):
    configure_cache(monkeypatch, local_tmp_path)
    call_count = 0
    call_lock = Lock()

    def generate(*_):
        nonlocal call_count
        with call_lock:
            call_count += 1
        return ai_answer()

    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(
            lambda _: question_cache.get_or_generate_answer(
                "Concurrent question?", ["Option A", "Option B"], generate
            ),
            range(8),
        ))

    assert all(item == results[0] for item in results)
    assert call_count == 1
    with sqlite3.connect(question_cache.usage_store.database_path()) as connection:
        rows, usage_count = connection.execute(
            "SELECT COUNT(*), MAX(usage_count) FROM question_cache"
        ).fetchone()
    assert rows == 1
    assert usage_count == 7


def test_cache_database_failures_fall_back_to_ai(monkeypatch, local_tmp_path):
    configure_cache(monkeypatch, local_tmp_path)
    monkeypatch.setattr(
        question_cache, "_read",
        lambda *_: (_ for _ in ()).throw(sqlite3.OperationalError("database unavailable")),
    )
    monkeypatch.setattr(
        question_cache, "_save",
        lambda *_: (_ for _ in ()).throw(sqlite3.OperationalError("database unavailable")),
    )

    result = question_cache.get_or_generate_answer("Question?", [], lambda *_: ai_answer("AI answer"))

    assert result.suggested_answer == "AI answer"
