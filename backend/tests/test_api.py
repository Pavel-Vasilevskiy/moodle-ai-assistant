"""HTTP-level tests for the API endpoints."""

import json
import sqlite3

import pytest
from types import SimpleNamespace
from fastapi.testclient import TestClient

from app.main import app, get_answer_generator
from app.schemas import AIAnswer
from app.services import ai_service, question_cache, usage_store
from app.services.ai_service import AIProviderTimeoutError


@pytest.fixture
def client(monkeypatch, local_tmp_path):
    monkeypatch.setenv("MOODLE_ASSISTANT_DATA_DIR", str(local_tmp_path / "app-data"))
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def test_health_returns_ok(client: TestClient) -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_usage_statistics_endpoint_returns_only_aggregates(client: TestClient, monkeypatch, local_tmp_path) -> None:
    monkeypatch.setenv("MOODLE_ASSISTANT_DATA_DIR", str(local_tmp_path / "app-data"))
    monkeypatch.setenv("OPENAI_MODEL", "test-model")
    monkeypatch.setattr(usage_store, "SESSION_ID", "test-session")

    response = client.get("/api/usage")

    assert response.status_code == 200
    payload = response.json()
    assert payload["model"] == "test-model"
    assert payload["session"] == {
        "input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
        "request_count": 0,
        "estimated_cost_usd": None,
    }
    assert payload["all_time"] == payload["session"]
    assert set(payload) == {"model", "session", "all_time"}


def test_answer_returns_structured_result_and_legacy_fields(client: TestClient) -> None:
    expected = AIAnswer(
        suggested_answer="Париж",
        explanation="Це столиця Франції.",
        confidence=0.95,
        needs_more_context=False,
    )
    app.dependency_overrides[get_answer_generator] = lambda: lambda question, options: expected

    response = client.post(
        "/api/answer",
        json={"question": "Яка столиця Франції?", "options": ["Париж", "Рим"]},
    )

    assert response.status_code == 200
    assert response.json() == {
        "suggested_answer": "Париж",
        "explanation": "Це столиця Франції.",
        "confidence": 0.95,
        "needs_more_context": False,
        "answer": "Париж",
        "message": "Це столиця Франції.",
        "source": "ai",
    }


def test_answer_cache_hit_preserves_contract_and_does_not_call_generator_twice(client: TestClient) -> None:
    calls = []
    expected = AIAnswer(
        suggested_answer="Париж",
        explanation="Це столиця Франції.",
        confidence=0.95,
        needs_more_context=False,
    )

    def generate(question: str, options: list[str]) -> AIAnswer:
        calls.append((question, options))
        return expected

    app.dependency_overrides[get_answer_generator] = lambda: generate
    payload = {"question": "Яка столиця Франції?", "options": ["Париж", "Рим"]}
    first = client.post("/api/answer", json=payload)
    second = client.post(
        "/api/answer",
        json={"question": " ЯКА   СТОЛИЦЯ Франції? ", "options": ["Рим", "Париж"]},
    )

    assert first.status_code == second.status_code == 200
    assert first.json()["source"] == "ai"
    assert second.json()["source"] == "cache"
    assert second.json()["suggested_answer"] == first.json()["suggested_answer"]
    assert set(second.json()) == {
        "suggested_answer", "explanation", "confidence", "needs_more_context",
        "answer", "message", "source",
    }
    assert len(calls) == 1
    assert client.get("/api/usage").json()["all_time"]["request_count"] == 0


def test_force_refresh_calls_generator_even_when_cache_has_a_match(client: TestClient) -> None:
    answers = iter([
        AIAnswer(suggested_answer="A", explanation="First", confidence=0.6, needs_more_context=False),
        AIAnswer(suggested_answer="A", explanation="Fresh", confidence=0.9, needs_more_context=False),
    ])
    calls = []

    def generate(question: str, options: list[str]) -> AIAnswer:
        calls.append((question, options))
        return next(answers)

    app.dependency_overrides[get_answer_generator] = lambda: generate
    payload = {"question": "Question?", "options": ["A", "B"]}
    assert client.post("/api/answer", json=payload).json()["source"] == "ai"

    refreshed = client.post("/api/answer", json={**payload, "force_refresh": True})

    assert refreshed.status_code == 200
    assert refreshed.json()["source"] == "ai"
    assert refreshed.json()["explanation"] == "Fresh"
    assert len(calls) == 2


def test_forced_refresh_records_provider_usage_once(client: TestClient, monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("OPENAI_MODEL", "test-model")
    question_cache._save(
        "Question?", ["A", "B"],
        AIAnswer(suggested_answer="A", explanation="Cached", confidence=0.5, needs_more_context=False),
    )

    provider_response = SimpleNamespace(
        id="forced-refresh-response-id",
        model="test-model",
        usage=SimpleNamespace(
            input_tokens=17,
            output_tokens=5,
            total_tokens=22,
            input_tokens_details=SimpleNamespace(cached_tokens=0),
        ),
        output_parsed={
            "suggested_answer": "B",
            "explanation": "Fresh provider response.",
            "confidence": 0.8,
            "needs_more_context": False,
        },
    )

    class FakeResponses:
        def parse(self, **_kwargs):
            return provider_response

    class FakeClient:
        responses = FakeResponses()

        def close(self):
            pass

    monkeypatch.setattr(ai_service, "OpenAI", lambda **_kwargs: FakeClient())
    app.dependency_overrides[get_answer_generator] = lambda: ai_service.generate_answer

    response = client.post(
        "/api/answer",
        json={"question": "Question?", "options": ["A", "B"], "force_refresh": True},
    )
    usage = client.get("/api/usage").json()["all_time"]

    assert response.status_code == 200
    assert response.json()["source"] == "ai"
    assert response.json()["suggested_answer"] == "B"
    assert usage["input_tokens"] == 17
    assert usage["output_tokens"] == 5
    assert usage["request_count"] == 1


def test_answer_accepts_open_ended_question_without_options(client: TestClient) -> None:
    received: dict[str, object] = {}

    def fake_generate(question: str, options: list[str]) -> AIAnswer:
        received.update(question=question, options=options)
        return AIAnswer(
            suggested_answer="Коротка відповідь",
            explanation="Загальне пояснення.",
            confidence=0.7,
            needs_more_context=False,
        )

    app.dependency_overrides[get_answer_generator] = lambda: fake_generate
    response = client.post("/api/answer", json={"question": "Поясни фотосинтез"})

    assert response.status_code == 200
    assert received == {"question": "Поясни фотосинтез", "options": []}


def test_known_wrong_option_forces_ai_and_does_not_replace_general_cache(client: TestClient) -> None:
    imported = client.post("/api/quiz-import", json={
        "source_origin": "https://distance.kuk.edu.ua",
        "attempt_identifier": "123",
        "attempt_key": "course:attempt:123",
        "questions": [{
            "question": "Question?",
            "options": [
                {"text": "Bad", "selected": True, "mark": "unknown", "input_type": "radio"},
                {"text": "Good", "selected": False, "mark": "unknown", "input_type": "radio"},
            ],
            "earned_score": "0",
            "max_score": "1",
        }],
    })
    assert imported.status_code == 200
    question_cache._save(
        "Question?", ["Bad", "Good"],
        AIAnswer(suggested_answer="Bad", explanation="Cached", confidence=0.4, needs_more_context=False),
    )
    calls = []

    def generate(question: str, options: list[str], feedback: dict[str, object]) -> AIAnswer:
        calls.append((question, options, feedback))
        return AIAnswer(suggested_answer="Good", explanation="Fresh constrained answer", confidence=0.7, needs_more_context=False)

    app.dependency_overrides[get_answer_generator] = lambda: generate
    response = client.post("/api/answer", json={
        "question": "Question?", "options": ["Bad", "Good"], "selection_mode": "single",
    })
    normal_response = client.post("/api/answer", json={"question": "Question?", "options": ["Bad", "Good"]})

    assert response.status_code == 200
    assert response.json()["suggested_answer"] == "Good"
    assert response.json()["source"] == "ai"
    assert len(calls) == 2
    assert calls[0][2]["known_wrong_options"] == ["Bad"]
    assert "Bad" in calls[0][2]["known_wrong_options"]
    assert normal_response.json()["source"] == "ai"
    assert normal_response.json()["suggested_answer"] == "Good"
    assert question_cache._read("Question?", ["Bad", "Good"]).suggested_answer == "Bad"


def _import_wrong_radio_answer(client: TestClient, attempt: str = "retry-1") -> None:
    response = client.post("/api/quiz-import", json={
        "source_origin": "https://distance.kuk.edu.ua",
        "attempt_identifier": attempt,
        "attempt_key": f"course:{attempt}",
        "questions": [{
            "question": "Question?",
            "options": [
                {"text": "A", "selected": True, "mark": "unknown", "input_type": "radio"},
                {"text": "B", "selected": False, "mark": "unknown", "input_type": "radio"},
            ],
            "earned_score": "0",
            "max_score": "1",
            "feedback": "Moodle gave zero points.",
        }],
    })
    assert response.status_code == 200


def _mock_openai_sequence(monkeypatch, answers: list[str]):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("OPENAI_MODEL", "test-model")

    class Responses:
        def __init__(self):
            self.calls = []

        def parse(self, **kwargs):
            self.calls.append(kwargs)
            answer = answers.pop(0)
            call_number = len(self.calls)
            return SimpleNamespace(
                id=f"negative-feedback-{call_number}",
                model="test-model",
                usage=SimpleNamespace(input_tokens=10, output_tokens=4, total_tokens=14),
                output_parsed={
                    "suggested_answer": answer,
                    "explanation": "Model explanation.",
                    "confidence": 0.7,
                    "needs_more_context": False,
                },
            )

    class Client:
        def __init__(self):
            self.responses = Responses()

        def close(self):
            pass

    fake = Client()
    monkeypatch.setattr(ai_service, "OpenAI", lambda **_kwargs: fake)
    app.dependency_overrides[get_answer_generator] = lambda: ai_service.generate_answer
    return fake


def test_real_answer_path_rejects_stale_cache_and_counts_bounded_retry(client, monkeypatch):
    _import_wrong_radio_answer(client)
    question_cache._save(
        "Question?", ["A", "B"],
        AIAnswer(suggested_answer="A", explanation="Old cached answer", confidence=0.4, needs_more_context=False),
    )
    fake = _mock_openai_sequence(monkeypatch, ["A", "B"])

    response = client.post("/api/answer", json={
        "question": "Question?", "options": ["B", "A"], "selection_mode": "single",
    })

    assert response.status_code == 200
    assert response.json()["source"] == "ai"
    assert response.json()["suggested_answer"] == "B"
    assert len(fake.responses.calls) == 2
    first_input = json.loads(fake.responses.calls[0]["input"])
    assert first_input["negative_feedback"]["known_wrong_options"] == ["A"]
    assert first_input["negative_feedback"]["moodle_feedback"] == ["Moodle gave zero points."]
    assert "retry_note" in json.loads(fake.responses.calls[1]["input"])
    usage = client.get("/api/usage").json()["all_time"]
    assert usage["request_count"] == 2
    assert (usage["input_tokens"], usage["output_tokens"], usage["total_tokens"]) == (20, 8, 28)
    # The context-specific answer is returned but the general cache entry stays untouched.
    assert question_cache._read("Question?", ["A", "B"]).suggested_answer == "A"
    with sqlite3.connect(usage_store.database_path()) as connection:
        assert connection.execute("SELECT grading_status FROM quiz_import_questions").fetchone()[0] == "incorrect"


def test_repeated_wrong_provider_answer_returns_controlled_conflict(client, monkeypatch):
    _import_wrong_radio_answer(client, "retry-2")
    question_cache._save(
        "Question?", ["A", "B"],
        AIAnswer(suggested_answer="A", explanation="Old cached answer", confidence=0.4, needs_more_context=False),
    )
    _mock_openai_sequence(monkeypatch, ["A", "A"])

    response = client.post("/api/answer", json={
        "question": "Question?", "options": ["A", "B"], "selection_mode": "single",
    })

    assert response.status_code == 502
    assert "Moodle" in response.json()["detail"]
    usage = client.get("/api/usage").json()["all_time"]
    assert usage["request_count"] == 2
    assert (usage["input_tokens"], usage["output_tokens"], usage["total_tokens"]) == (20, 8, 28)
    assert question_cache._read("Question?", ["A", "B"]).suggested_answer == "A"
    with sqlite3.connect(usage_store.database_path()) as connection:
        assert connection.execute("SELECT grading_status FROM quiz_import_questions").fetchone()[0] == "incorrect"


def test_answer_maps_service_error_to_safe_http_response(client: TestClient) -> None:
    def timeout(question: str, options: list[str]) -> AIAnswer:
        raise AIProviderTimeoutError

    app.dependency_overrides[get_answer_generator] = lambda: timeout
    response = client.post("/api/answer", json={"question": "Питання?"})

    assert response.status_code == 504
    assert response.json() == {
        "detail": "The AI provider did not respond in time. Please try again."
    }


@pytest.mark.parametrize(
    "payload",
    [
        {"question": "   ", "options": ["Варіант"]},
        {"question": "Питання?", "options": [" "]},
        {"question": "Питання?", "options": [f"Варіант {i}" for i in range(21)]},
        {"question": "Питання?", "options": ["x" * 501]},
    ],
)
def test_answer_rejects_invalid_input(client: TestClient, payload: dict) -> None:
    response = client.post("/api/answer", json=payload)

    assert response.status_code == 422
