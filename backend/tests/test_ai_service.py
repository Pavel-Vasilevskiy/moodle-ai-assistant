"""Unit tests for OpenAI integration; no real provider requests are made."""

from types import SimpleNamespace

import pytest

from app import schemas
from app.services import ai_service
from app.services.ai_service import (
    AIConfigurationError,
    AIProviderRateLimitError,
    AIProviderTimeoutError,
    AIResponseError,
    AIServiceError,
)


class FakeResponses:
    def __init__(self, parsed: object = None, error: Exception | None = None) -> None:
        self.parsed = parsed
        self.error = error
        self.arguments: dict[str, object] = {}

    def parse(self, **kwargs):
        self.arguments = kwargs
        if self.error:
            raise self.error
        return SimpleNamespace(output_parsed=self.parsed)


class FakeClient:
    def __init__(self, response: FakeResponses) -> None:
        self.responses = response
        self.closed = False

    def close(self) -> None:
        self.closed = True


def configure_fake_client(monkeypatch, response: FakeResponses) -> FakeClient:
    monkeypatch.setenv("OPENAI_API_KEY", "test-key-not-a-real-secret")
    monkeypatch.setenv("OPENAI_MODEL", "test-model")
    fake_client = FakeClient(response)

    def fake_openai(**kwargs):
        assert kwargs["api_key"] == "test-key-not-a-real-secret"
        assert kwargs["timeout"] == 30.0
        assert kwargs["max_retries"] == 0
        return fake_client

    monkeypatch.setattr(ai_service, "OpenAI", fake_openai)
    return fake_client


def test_generate_answer_returns_pydantic_model(monkeypatch) -> None:
    response = FakeResponses(
        parsed={
            "suggested_answer": "Варіант А",
            "explanation": "Він відповідає умові.",
            "confidence": 0.8,
            "needs_more_context": False,
        }
    )
    fake_client = configure_fake_client(monkeypatch, response)

    result = ai_service.generate_answer("Питання?", ["Варіант А", "Варіант Б"])

    assert isinstance(result, schemas.AIAnswer)
    assert result.suggested_answer == "Варіант А"
    assert response.arguments["model"] == "test-model"
    assert response.arguments["text_format"] is schemas.AIAnswer
    assert response.arguments["instructions"] == ai_service.SYSTEM_PROMPT
    assert '"options": ["Варіант А", "Варіант Б"]' in response.arguments["input"]
    assert fake_client.closed


def test_generate_answer_rejects_missing_api_key(monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_MODEL", "test-model")

    with pytest.raises(AIConfigurationError):
        ai_service.generate_answer("Питання?", [])


def test_generate_answer_rejects_missing_model(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.delenv("OPENAI_MODEL", raising=False)

    with pytest.raises(AIConfigurationError):
        ai_service.generate_answer("Питання?", [])


def test_generate_answer_maps_provider_timeout(monkeypatch) -> None:
    class FakeTimeout(Exception):
        pass

    monkeypatch.setattr(ai_service, "APITimeoutError", FakeTimeout)
    fake_client = configure_fake_client(monkeypatch, FakeResponses(error=FakeTimeout()))

    with pytest.raises(AIProviderTimeoutError):
        ai_service.generate_answer("Питання?", [])
    assert fake_client.closed


def test_generate_answer_maps_provider_rate_limit(monkeypatch) -> None:
    class FakeRateLimit(Exception):
        pass

    monkeypatch.setattr(ai_service, "RateLimitError", FakeRateLimit)
    configure_fake_client(monkeypatch, FakeResponses(error=FakeRateLimit()))

    with pytest.raises(AIProviderRateLimitError):
        ai_service.generate_answer("Питання?", [])


def test_generate_answer_maps_provider_failure(monkeypatch) -> None:
    class FakeStatusError(Exception):
        pass

    monkeypatch.setattr(ai_service, "APIStatusError", FakeStatusError)
    configure_fake_client(monkeypatch, FakeResponses(error=FakeStatusError()))

    with pytest.raises(AIServiceError) as error:
        ai_service.generate_answer("Питання?", [])
    assert error.value.public_message == "The AI service could not complete the request."


def test_generate_answer_handles_missing_or_invalid_structured_output(monkeypatch) -> None:
    configure_fake_client(monkeypatch, FakeResponses(parsed=None))

    with pytest.raises(AIResponseError):
        ai_service.generate_answer("Питання?", [])


def test_generate_answer_handles_invalid_pydantic_data(monkeypatch) -> None:
    configure_fake_client(
        monkeypatch,
        FakeResponses(
            parsed={
                "suggested_answer": "відповідь",
                "explanation": "пояснення",
                "confidence": 2,
                "needs_more_context": False,
            }
        ),
    )

    with pytest.raises(AIResponseError):
        ai_service.generate_answer("Питання?", [])


def test_generate_answer_rejects_suggestion_not_in_options(monkeypatch) -> None:
    configure_fake_client(
        monkeypatch,
        FakeResponses(
            parsed={
                "suggested_answer": "Варіант В",
                "explanation": "пояснення",
                "confidence": 0.6,
                "needs_more_context": False,
            }
        ),
    )

    with pytest.raises(AIResponseError):
        ai_service.generate_answer("Питання?", ["Варіант А", "Варіант Б"])


def test_generate_answer_maps_unknown_model_to_configuration_error(monkeypatch) -> None:
    class FakeNotFound(Exception):
        pass

    monkeypatch.setattr(ai_service, "NotFoundError", FakeNotFound)
    configure_fake_client(monkeypatch, FakeResponses(error=FakeNotFound()))

    with pytest.raises(AIConfigurationError):
        ai_service.generate_answer("Питання?", [])
