"""Request and response models for the API."""

from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class AnswerRequest(BaseModel):
    """Question and its available answer options."""

    question: str = Field(min_length=1, max_length=2000)
    # An empty list supports open-ended questions; existing clients can still send options.
    options: list[str] = Field(default_factory=list, max_length=20)
    force_refresh: bool = False
    # Context-specific exclusions from a previously zero-scored radio choice.
    excluded_options: list[str] = Field(default_factory=list, max_length=20)

    @field_validator("question", mode="before")
    @classmethod
    def strip_question(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("options", mode="before")
    @classmethod
    def strip_options(cls, value: object) -> object:
        if isinstance(value, list):
            return [option.strip() if isinstance(option, str) else option for option in value]
        return value

    @field_validator("options")
    @classmethod
    def validate_option_lengths(cls, options: list[str]) -> list[str]:
        if any(not option or len(option) > 500 for option in options):
            raise ValueError("Кожен варіант має містити від 1 до 500 символів")
        return options

    @field_validator("excluded_options", mode="before")
    @classmethod
    def strip_excluded_options(cls, value: object) -> object:
        if isinstance(value, list):
            return [item.strip() if isinstance(item, str) else item for item in value]
        return value

    @model_validator(mode="after")
    def validate_excluded_options(self) -> "AnswerRequest":
        if (
            len(set(self.excluded_options)) != len(self.excluded_options)
            or any(not item or item not in self.options for item in self.excluded_options)
        ):
            raise ValueError("Excluded options must be unique options in the request")
        return self


class AnswerResponse(BaseModel):
    """Structured AI result plus the original response fields for compatibility."""

    suggested_answer: str
    explanation: str
    confidence: float = Field(ge=0, le=1)
    needs_more_context: bool

    # Keep the original response keys so existing clients do not break.
    answer: str
    message: str
    # Additive metadata tells clients whether this came from SQLite or the AI API.
    source: Literal["cache", "ai"]


class AIAnswer(BaseModel):
    """The structured result requested from the AI provider."""

    suggested_answer: str = Field(max_length=2000)
    explanation: str = Field(max_length=4000)
    confidence: float = Field(ge=0, le=1)
    needs_more_context: bool


class UsageTotals(BaseModel):
    """Sanitized aggregate usage values exposed to the local Launcher."""

    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    total_tokens: int = Field(ge=0)
    request_count: int = Field(ge=0)
    estimated_cost_usd: float | None = Field(default=None, ge=0)


class UsageStatistics(BaseModel):
    """Aggregate-only response; it contains no request or prompt contents."""

    model: str | None = Field(default=None, max_length=128)
    session: UsageTotals
    all_time: UsageTotals


class QuizImportOption(BaseModel):
    """One answer option as visibly rendered on a completed attempt page."""

    text: str = Field(min_length=1, max_length=5000)
    selected: bool = False
    # Only explicit DOM markers may produce a non-unknown value.
    mark: Literal["correct", "incorrect", "partial", "unknown"] = "unknown"
    input_type: Literal["radio", "checkbox"] | None = None

    @field_validator("text", mode="before")
    @classmethod
    def validate_option_text(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            raise ValueError("Option text cannot be empty")
        return value


class QuizImportQuestion(BaseModel):
    """A question result captured from Moodle's attempt review page."""

    question_id: str | None = Field(default=None, max_length=256)
    question: str = Field(min_length=1, max_length=10000)
    options: list[QuizImportOption] = Field(default_factory=list, max_length=100)
    earned_score: str | None = Field(default=None, max_length=64)
    max_score: str | None = Field(default=None, max_length=64)
    feedback: str | None = Field(default=None, max_length=10000)

    @field_validator("question", mode="before")
    @classmethod
    def validate_question_text(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            raise ValueError("Question text cannot be empty")
        return value


class QuizAttemptImportRequest(BaseModel):
    """Structured, visible result data; never accepts page HTML or scripts."""

    source_origin: Literal["https://distance.kuk.edu.ua", "http://127.0.0.1:8765"]
    attempt_identifier: str | None = Field(default=None, max_length=256)
    attempt_key: str = Field(min_length=1, max_length=512)
    questions: list[QuizImportQuestion] = Field(min_length=1, max_length=200)


class QuizAttemptImportResponse(BaseModel):
    imported_count: int = Field(ge=0)
    duplicate: bool
    message: str = Field(max_length=300)


class QuestionHistoryItem(BaseModel):
    """A question and current choice mode for looking up prior zero scores."""

    question: str = Field(min_length=1, max_length=10000)
    options: list[str] = Field(default_factory=list, max_length=100)
    selection_mode: Literal["single", "multiple", "open", "mixed", "unknown"]

    @field_validator("question", mode="before")
    @classmethod
    def validate_nonblank_question(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            raise ValueError("Question text cannot be empty")
        return value


class QuestionHistoryRequest(BaseModel):
    questions: list[QuestionHistoryItem] = Field(min_length=1, max_length=200)


class QuestionHistoryResult(BaseModel):
    question_index: int = Field(ge=0)
    had_previous_zero_score: bool
    zero_score_attempts: int = Field(ge=0)
    excluded_options: list[str] = Field(default_factory=list, max_length=100)
    exclusion_note: str | None = Field(default=None, max_length=300)


class QuestionHistoryResponse(BaseModel):
    results: list[QuestionHistoryResult]
