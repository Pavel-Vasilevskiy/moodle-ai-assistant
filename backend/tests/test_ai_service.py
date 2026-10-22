"""Unit tests for OpenAI integration; no real provider requests are made."""

from types import SimpleNamespace

import pytest

from app import schemas
from app.services import ai_service
from app.services.ai_service import (
    AIConfigurationError,
    AIAnswerConflictError,
    AIProviderRateLimitError,
    AIProviderTimeoutError,
    AIResponseError,
    AIServiceError,
)


class FakeResponses:
    def __init__(self, parsed: object = None, error: Exception | None = None, usage=None) -> None:
        self.parsed = parsed
        self.error = error
        self.usage = usage
        self.model = "test-model"
        self.id = "resp_usage_test"
        self.arguments: dict[str, object] = {}

    def parse(self, **kwargs):
        self.arguments = kwargs
        if self.error:
            raise self.error
        self.response = SimpleNamespace(
            output_parsed=self.parsed,
            usage=self.usage,
            model=self.model,
            id=self.id,
        )
        return self.response


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


def test_generate_answer_passes_real_response_usage_to_store(monkeypatch) -> None:
    response = FakeResponses(
        parsed={
            "suggested_answer": "Варіант А",
            "explanation": "Пояснення.",
            "confidence": 0.8,
            "needs_more_context": False,
        },
        usage=SimpleNamespace(input_tokens=120, output_tokens=34, total_tokens=154),
    )
    configure_fake_client(monkeypatch, response)
    saved = []
    monkeypatch.setattr(ai_service.usage_store, "record_response_usage", lambda value, model: saved.append((value, model)))

    ai_service.generate_answer("Питання?", ["Варіант А"])

    assert saved == [(response.response, "test-model")]


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


def test_generate_answer_supplies_known_wrong_option_to_model(monkeypatch) -> None:
    response = FakeResponses(parsed={
        "suggested_answer": "Безпечний варіант",
        "explanation": "Пояснення.",
        "confidence": 0.7,
        "needs_more_context": False,
    })
    configure_fake_client(monkeypatch, response)

    ai_service.generate_answer("Питання?", ["Неправильний", "Безпечний варіант"], {
        "known_wrong_options": ["Неправильний"],
        "incorrect_combinations": [],
        "moodle_feedback": ["Moodle: спроба отримала нуль."],
    })

    assert '"known_wrong_options": ["Неправильний"]' in response.arguments["input"]
    assert '"moodle_feedback": ["Moodle: спроба отримала нуль."]' in response.arguments["input"]
    assert "Never repeat a listed single-choice option" in response.arguments["instructions"]


def test_generate_answer_rejects_model_suggestion_marked_known_wrong(monkeypatch) -> None:
    configure_fake_client(monkeypatch, FakeResponses(parsed={
        "suggested_answer": "Неправильний",
        "explanation": "Пояснення.",
        "confidence": 0.7,
        "needs_more_context": False,
    }))

    with pytest.raises(AIResponseError):
        ai_service.generate_answer("Питання?", ["Неправильний", "Безпечний"], {
            "known_wrong_options": ["Неправильний"],
        })


def test_generate_answer_retries_once_with_feedback_then_maps_normalized_option(monkeypatch):
    class SequenceResponses:
        def __init__(self):
            self.calls = []
            self.answers = ["A", "  b  "]

        def parse(self, **kwargs):
            self.calls.append(kwargs)
            answer = self.answers.pop(0)
            return SimpleNamespace(
                id=f"retry-{len(self.calls)}",
                model="test-model",
                usage=SimpleNamespace(input_tokens=11, output_tokens=3, total_tokens=14),
                output_parsed={
                    "suggested_answer": answer,
                    "explanation": "Пояснення.",
                    "confidence": 0.7,
                    "needs_more_context": False,
                },
            )

    response = SequenceResponses()
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("OPENAI_MODEL", "test-model")
    client = FakeClient(response)
    monkeypatch.setattr(ai_service, "OpenAI", lambda **_kwargs: client)
    recorded = []
    monkeypatch.setattr(ai_service.usage_store, "record_response_usage", lambda item, model: recorded.append(item.id))

    answer = ai_service.generate_answer("Question?", ["A", "B"], {
        "known_wrong_options": ["A"],
        "incorrect_combinations": [],
        "unclassified_selections": [],
        "moodle_feedback": ["0 / 1"],
    })

    assert answer.suggested_answer == "B"
    assert len(response.calls) == 2
    assert "retry_note" in response.calls[1]["input"]
    assert "previous_conflicting_suggestion" in response.calls[1]["input"]
    assert recorded == ["retry-1", "retry-2"]
    assert client.closed


def test_generate_answer_returns_controlled_conflict_after_one_retry(monkeypatch):
    class AlwaysWrongResponses:
        def __init__(self):
            self.calls = 0

        def parse(self, **_kwargs):
            self.calls += 1
            return SimpleNamespace(
                id=f"wrong-{self.calls}", model="test-model", usage=None,
                output_parsed={
                    "suggested_answer": "A", "explanation": "reason",
                    "confidence": 0.4, "needs_more_context": False,
                },
            )

    response = AlwaysWrongResponses()
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("OPENAI_MODEL", "test-model")
    client = FakeClient(response)
    monkeypatch.setattr(ai_service, "OpenAI", lambda **_kwargs: client)
    with pytest.raises(AIAnswerConflictError):
        ai_service.generate_answer("Question?", ["A", "B"], {"known_wrong_options": ["A"]})
    assert response.calls == 2
    assert "0 балів" in AIAnswerConflictError.public_message
    assert client.closed


def test_zero_scored_checkbox_combination_does_not_block_each_member(monkeypatch):
    response = FakeResponses(parsed={
        "suggested_answer": "A",
        "explanation": "One option is considered in context.",
        "confidence": 0.6,
        "needs_more_context": False,
    })
    configure_fake_client(monkeypatch, response)

    result = ai_service.generate_answer("Choose all that apply", ["A", "B", "C"], {
        "known_wrong_options": [],
        "incorrect_combinations": [["A", "B"]],
        "unclassified_selections": [],
        "moodle_feedback": [],
        "selection_mode": "multiple",
    })

    assert result.suggested_answer == "A"
    assert '"incorrect_combinations": [["A", "B"]]' in response.arguments["input"]


def test_generate_answer_maps_unknown_model_to_configuration_error(monkeypatch) -> None:
    class FakeNotFound(Exception):
        pass

    monkeypatch.setattr(ai_service, "NotFoundError", FakeNotFound)
    configure_fake_client(monkeypatch, FakeResponses(error=FakeNotFound()))

    with pytest.raises(AIConfigurationError):
        ai_service.generate_answer("Питання?", [])
