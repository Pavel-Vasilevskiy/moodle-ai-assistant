"""HTTP-level tests for the API endpoints."""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_returns_ok() -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_answer_returns_placeholder_without_guessing() -> None:
    response = client.post(
        "/api/answer",
        json={"question": "Яка столиця Франції?", "options": ["Париж", "Рим"]},
    )

    assert response.status_code == 200
    assert response.json() == {
        "answer": "",
        "message": "AI ще не підключений. Відповідь поки недоступна.",
    }


def test_answer_rejects_empty_question() -> None:
    response = client.post(
        "/api/answer", json={"question": "   ", "options": ["Варіант"]}
    )

    assert response.status_code == 422


def test_answer_rejects_too_many_options() -> None:
    response = client.post(
        "/api/answer",
        json={"question": "Питання?", "options": [f"Варіант {i}" for i in range(21)]},
    )

    assert response.status_code == 422


def test_answer_rejects_empty_option() -> None:
    response = client.post(
        "/api/answer", json={"question": "Питання?", "options": ["  "]}
    )

    assert response.status_code == 422
