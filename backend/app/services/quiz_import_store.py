"""Persistent storage for Moodle completed-attempt review imports."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

from app.schemas import QuestionHistoryRequest, QuizAttemptImportRequest
from app.services.question_cache import normalize_question
from app.services import usage_store

def _connect() -> sqlite3.Connection:
    path = usage_store.database_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout = 10000")
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def init_db() -> None:
    """Create separate attempt/question tables in the existing local database."""
    usage_store.init_db()
    with _connect() as connection:
        connection.execute(
            """CREATE TABLE IF NOT EXISTS quiz_imports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_origin TEXT NOT NULL,
                attempt_key_hash TEXT NOT NULL,
                attempt_identifier TEXT,
                imported_at TEXT NOT NULL,
                question_count INTEGER NOT NULL CHECK(question_count > 0),
                UNIQUE(source_origin, attempt_key_hash)
            )"""
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS quiz_import_questions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                import_id INTEGER NOT NULL,
                position INTEGER NOT NULL CHECK(position >= 0),
                question_id TEXT,
                original_question TEXT NOT NULL,
                normalized_question TEXT NOT NULL,
                options_json TEXT NOT NULL,
                selected_options_json TEXT NOT NULL,
                option_marks_json TEXT NOT NULL,
                earned_score TEXT,
                max_score TEXT,
                grading_status TEXT NOT NULL CHECK(
                    grading_status IN ('incorrect', 'full', 'partial', 'unknown')
                ),
                feedback TEXT,
                FOREIGN KEY(import_id) REFERENCES quiz_imports(id) ON DELETE CASCADE,
                UNIQUE(import_id, position)
            )"""
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS quiz_import_questions_normalized "
            "ON quiz_import_questions(normalized_question)"
        )


def _parse_score(value: str | None) -> Decimal | None:
    """Parse a localized decimal score without passing through binary float."""
    if value is None:
        return None
    text = value.strip().replace("\u00a0", "").replace("\u202f", "")
    text = "".join(text.split())
    if not text:
        return None
    if "," in text and "." in text:
        # Whichever separator occurs last is the decimal separator; the other
        # is treated as a grouping separator (e.g. 1.234,50 or 1,234.50).
        decimal_separator = "," if text.rfind(",") > text.rfind(".") else "."
        grouping_separator = "." if decimal_separator == "," else ","
        text = text.replace(grouping_separator, "")
        if decimal_separator == ",":
            text = text.replace(",", ".")
    elif "," in text:
        text = text.replace(",", ".")
    try:
        score = Decimal(text)
    except InvalidOperation:
        return None
    return score if score.is_finite() else None


def classify_score(earned_value: str | None, max_value: str | None) -> str:
    """Classify only complete, consistent score pairs; preserve uncertainty."""
    earned = _parse_score(earned_value)
    maximum = _parse_score(max_value)
    if earned is None or maximum is None or maximum <= 0 or earned < 0 or earned > maximum:
        return "unknown"
    if earned == 0:
        return "incorrect"
    if earned == maximum:
        return "full"
    return "partial"


def _normalize_question(question: str) -> str:
    return normalize_question(question)


def get_question_history(request: QuestionHistoryRequest) -> list[dict[str, object]]:
    """Return prior zero-score warnings and only safe radio exclusions.

    Excluding an option is safe only when an earlier incorrect attempt used one
    radio choice and its complete option set exactly matches this question.
    A zero-scored checkbox selection describes a combination, not each option.
    """
    init_db()
    results: list[dict[str, object]] = []
    with _connect() as connection:
        for index, item in enumerate(request.questions):
            normalized = _normalize_question(item.question)
            rows = connection.execute(
                """SELECT q.import_id, q.options_json, q.selected_options_json
                   FROM quiz_import_questions AS q
                   WHERE q.normalized_question = ? AND q.grading_status = 'incorrect'
                   ORDER BY q.id""",
                (normalized,),
            ).fetchall()
            exclusions: set[str] = set()
            exact_options = sorted(item.options)
            if item.selection_mode == "single" and exact_options:
                for row in rows:
                    try:
                        stored_options = json.loads(row["options_json"])
                        selected = json.loads(row["selected_options_json"])
                    except (TypeError, ValueError):
                        continue
                    if (
                        len(selected) == 1
                        and all(option.get("input_type") == "radio" for option in stored_options)
                        and sorted(option.get("text", "") for option in stored_options) == exact_options
                        and selected[0] in item.options
                        and item.options.count(selected[0]) == 1
                    ):
                        exclusions.add(selected[0])
            note = None
            if rows and item.selection_mode in {"multiple", "mixed", "unknown"}:
                note = "У минулій спробі Moodle поставив 0 балів. Для checkbox це стосується комбінації, тому окремі варіанти не виключено."
            elif rows and item.selection_mode == "single" and not exclusions:
                note = "У минулій спробі Moodle поставив 0 балів, але варіант не можна безпечно зіставити з поточним набором."
            elif rows and item.selection_mode == "open":
                note = "У минулій спробі Moodle поставив 0 балів за це питання."
            results.append({
                "question_index": index,
                "had_previous_zero_score": bool(rows),
                "zero_score_attempts": len({row["import_id"] for row in rows}),
                "excluded_options": sorted(exclusions),
                "exclusion_note": note,
            })
    return results


def save_attempt(request: QuizAttemptImportRequest) -> dict[str, object]:
    """Store one attempt atomically; return an idempotent duplicate result."""
    init_db()
    key_hash = hashlib.sha256(request.attempt_key.encode("utf-8")).hexdigest()
    imported_at = datetime.now(timezone.utc).isoformat()
    with _connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        existing = connection.execute(
            "SELECT id FROM quiz_imports WHERE source_origin = ? AND attempt_key_hash = ?",
            (request.source_origin, key_hash),
        ).fetchone()
        if existing:
            # Older imports did not persist input type. Re-importing the exact
            # same attempt may safely enrich that metadata without changing its
            # score, selected answers, feedback, or attempt identity.
            for position, question in enumerate(request.questions):
                stored = connection.execute(
                    "SELECT options_json, selected_options_json FROM quiz_import_questions "
                    "WHERE import_id = ? AND position = ?",
                    (existing["id"], position),
                ).fetchone()
                if stored is None:
                    continue
                try:
                    old_options = json.loads(stored["options_json"])
                    old_selected = json.loads(stored["selected_options_json"])
                except (TypeError, ValueError):
                    continue
                new_selected = [option.text for option in question.options if option.selected]
                if (
                    old_selected == new_selected
                    and [option.get("text") for option in old_options]
                    == [option.text for option in question.options]
                    and any(not option.get("input_type") for option in old_options)
                ):
                    for old_option, new_option in zip(old_options, question.options):
                        if not old_option.get("input_type"):
                            old_option["input_type"] = new_option.input_type
                    connection.execute(
                        "UPDATE quiz_import_questions SET options_json = ? WHERE import_id = ? AND position = ?",
                        (json.dumps(old_options, ensure_ascii=False), existing["id"], position),
                    )
            return {
                "imported_count": 0,
                "duplicate": True,
                "message": "Цю спробу вже збережено; повторних записів не створено.",
            }

        cursor = connection.execute(
            """INSERT INTO quiz_imports
               (source_origin, attempt_key_hash, attempt_identifier, imported_at, question_count)
               VALUES (?, ?, ?, ?, ?)""",
            (
                request.source_origin,
                key_hash,
                request.attempt_identifier,
                imported_at,
                len(request.questions),
            ),
        )
        import_id = cursor.lastrowid
        for position, question in enumerate(request.questions):
            option_data = [option.model_dump() for option in question.options]
            selected = [option.text for option in question.options if option.selected]
            marks = [
                {"text": option.text, "mark": option.mark}
                for option in question.options
                if option.mark != "unknown"
            ]
            connection.execute(
                """INSERT INTO quiz_import_questions
                   (import_id, position, question_id, original_question,
                    normalized_question, options_json, selected_options_json,
                    option_marks_json, earned_score, max_score, grading_status, feedback)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    import_id,
                    position,
                    question.question_id,
                    question.question,
                    _normalize_question(question.question),
                    json.dumps(option_data, ensure_ascii=False),
                    json.dumps(selected, ensure_ascii=False),
                    json.dumps(marks, ensure_ascii=False),
                    question.earned_score,
                    question.max_score,
                    classify_score(question.earned_score, question.max_score),
                    question.feedback,
                ),
            )
        return {
            "imported_count": len(request.questions),
            "duplicate": False,
            "message": f"Збережено запитань: {len(request.questions)}.",
        }
