"""HTTP-level tests for the API endpoints."""

import pytest
from fastapi.testclient import TestClient

from app.main import app, get_answer_generator
from app.schemas import AIAnswer
from app.services.ai_service import AIProviderTimeoutError


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def test_health_returns_ok(client: TestClient) -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


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
    }


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
