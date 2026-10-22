"""Persistence and score-classification tests for completed Moodle attempts."""

import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import quiz_import_store, usage_store


@pytest.fixture
def client(monkeypatch, local_tmp_path):
    monkeypatch.setenv("MOODLE_ASSISTANT_DATA_DIR", str(local_tmp_path / "data"))
    with TestClient(app) as test_client:
        yield test_client


def payload(attempt="attempt:11", *, earned="0,50", maximum="1,50"):
    return {
        "source_origin": "https://distance.kuk.edu.ua",
        "attempt_identifier": attempt.split(":", 1)[-1],
        "attempt_key": f"https://distance.kuk.edu.ua|77256|{attempt}",
        "questions": [
            {
                "question_id": "question-10001-1",
                "question": "Демо-питання?",
                "options": [
                    {"text": "Обраний варіант", "selected": True, "mark": "unknown", "input_type": "radio"},
                    {"text": "Інший варіант", "selected": False, "mark": "unknown", "input_type": "radio"},
                ],
                "earned_score": earned,
                "max_score": maximum,
                "feedback": None,
            }
        ],
    }


@pytest.mark.parametrize(
    ("earned", "maximum", "expected"),
    [
        ("0", "5", "incorrect"),
        ("5,00", "5.00", "full"),
        ("0,50", "1,50", "partial"),
        ("1.25", "2.50", "partial"),
        ("1.000,25", "1.500,50", "partial"),
        (None, "5", "unknown"),
        ("bad", "5", "unknown"),
        ("6", "5", "unknown"),
        ("0", "0", "unknown"),
        ("-1", "5", "unknown"),
    ],
)
def test_decimal_score_classification(earned, maximum, expected):
    assert quiz_import_store.classify_score(earned, maximum) == expected


def test_import_endpoint_persists_question_options_selection_and_feedback(client, local_tmp_path):
    request = payload()
    request["questions"][0]["feedback"] = "Moodle feedback text"
    response = client.post("/api/quiz-import", json=request)

    assert response.status_code == 200
    assert response.json() == {
        "imported_count": 1,
        "duplicate": False,
        "message": "Збережено запитань: 1.",
    }
    assert client.get("/api/usage").json()["all_time"]["request_count"] == 0
    quiz_import_store.init_db()  # Initialization can safely be repeated.
    connection = sqlite3.connect(usage_store.database_path())
    try:
        attempt = connection.execute(
            "SELECT attempt_identifier, question_count FROM quiz_imports"
        ).fetchone()
        question = connection.execute(
            """SELECT original_question, options_json, selected_options_json,
                      earned_score, max_score, grading_status, feedback
               FROM quiz_import_questions"""
        ).fetchone()
    finally:
        connection.close()

    assert attempt == ("11", 1)
    assert question[0] == "Демо-питання?"
    assert [option["text"] for option in json.loads(question[1])] == [
        "Обраний варіант", "Інший варіант"
    ]
    assert json.loads(question[2]) == ["Обраний варіант"]
    assert question[3:6] == ("0,50", "1,50", "partial")
    assert question[6] == "Moodle feedback text"


def test_same_attempt_is_idempotent_but_a_distinct_attempt_is_preserved(client):
    first = payload("attempt:11")
    same = payload("attempt:11")
    different = payload("attempt:12")

    assert client.post("/api/quiz-import", json=first).json()["duplicate"] is False
    duplicate_response = client.post("/api/quiz-import", json=same)
    assert duplicate_response.status_code == 200
    assert duplicate_response.json()["duplicate"] is True
    assert duplicate_response.json()["imported_count"] == 0
    assert client.post("/api/quiz-import", json=different).json()["duplicate"] is False

    with sqlite3.connect(usage_store.database_path()) as connection:
        assert connection.execute("SELECT COUNT(*) FROM quiz_imports").fetchone()[0] == 2
        assert connection.execute("SELECT COUNT(*) FROM quiz_import_questions").fetchone()[0] == 2


def test_concurrent_imports_of_one_attempt_create_one_record(client):
    from app.schemas import QuizAttemptImportRequest

    request = QuizAttemptImportRequest.model_validate(payload("attempt:concurrent"))
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda _index: quiz_import_store.save_attempt(request), range(12)))

    assert sum(not result["duplicate"] for result in results) == 1
    assert sum(result["duplicate"] for result in results) == 11
    with sqlite3.connect(usage_store.database_path()) as connection:
        assert connection.execute("SELECT COUNT(*) FROM quiz_imports").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM quiz_import_questions").fetchone()[0] == 1


def test_unknown_score_does_not_lose_available_question_data(client, local_tmp_path):
    data = payload(earned="not available", maximum=None)
    assert client.post("/api/quiz-import", json=data).status_code == 200
    with sqlite3.connect(usage_store.database_path()) as connection:
        row = connection.execute(
            "SELECT earned_score, max_score, grading_status FROM quiz_import_questions"
        ).fetchone()
    assert row == ("not available", None, "unknown")


def test_zero_score_marks_the_selected_combination_not_each_option(client):
    request = payload(earned="0", maximum="5")
    request["questions"][0]["options"][1]["selected"] = True
    assert client.post("/api/quiz-import", json=request).status_code == 200
    with sqlite3.connect(usage_store.database_path()) as connection:
        row = connection.execute(
            "SELECT selected_options_json, option_marks_json, grading_status "
            "FROM quiz_import_questions"
        ).fetchone()

    assert json.loads(row[0]) == ["Обраний варіант", "Інший варіант"]
    assert json.loads(row[1]) == []
    assert row[2] == "incorrect"


def test_invalid_import_payload_is_rejected(client):
    request = payload()
    request["questions"][0]["question"] = " "
    assert client.post("/api/quiz-import", json=request).status_code == 422

    request = payload()
    request["source_origin"] = "https://not-allowed.example"
    assert client.post("/api/quiz-import", json=request).status_code == 422


def test_history_marks_zero_score_and_excludes_only_matching_single_radio_option(client):
    request = payload(earned="0", maximum="1")
    assert client.post("/api/quiz-import", json=request).status_code == 200

    response = client.post("/api/quiz-import/history", json={"questions": [{
        "question": " ДЕМО-питання? ",
        "options": ["Інший варіант", "Обраний варіант"],
        "selection_mode": "single",
    }]})

    assert response.status_code == 200
    assert response.json()["results"][0] == {
        "question_index": 0,
        "had_previous_zero_score": True,
        "zero_score_attempts": 1,
        "excluded_options": ["Обраний варіант"],
        "exclusion_note": None,
    }


def test_history_does_not_exclude_checkbox_combination_or_changed_option_set(client):
    request = payload(earned="0", maximum="1")
    request["questions"][0]["options"][0]["input_type"] = "checkbox"
    request["questions"][0]["options"][1]["input_type"] = "checkbox"
    assert client.post("/api/quiz-import", json=request).status_code == 200
    answers = [
        {"question": "Демо-питання?", "options": ["Обраний варіант", "Інший варіант"], "selection_mode": "multiple"},
        {"question": "Демо-питання?", "options": ["Обраний варіант", "Інший варіант", "Новий"], "selection_mode": "single"},
    ]

    results = client.post("/api/quiz-import/history", json={"questions": answers}).json()["results"]

    assert results[0]["had_previous_zero_score"] is True
    assert results[0]["excluded_options"] == []
    assert "комбінації" in results[0]["exclusion_note"]
    assert results[1]["excluded_options"] == []


def test_duplicate_import_only_backfills_missing_input_type(client):
    old_attempt = payload(earned="0", maximum="1")
    for option in old_attempt["questions"][0]["options"]:
        option.pop("input_type")
    assert client.post("/api/quiz-import", json=old_attempt).status_code == 200

    updated_attempt = payload(earned="1", maximum="1")
    response = client.post("/api/quiz-import", json=updated_attempt)

    assert response.json()["duplicate"] is True
    with sqlite3.connect(usage_store.database_path()) as connection:
        options = json.loads(connection.execute("SELECT options_json FROM quiz_import_questions").fetchone()[0])
        score = connection.execute("SELECT earned_score, grading_status FROM quiz_import_questions").fetchone()
    assert [option["input_type"] for option in options] == ["radio", "radio"]
    assert score == ("0", "incorrect")
