"""Request and response models for the API."""

from pydantic import BaseModel, Field, field_validator


class AnswerRequest(BaseModel):
    """Question and its available answer options."""

    question: str = Field(min_length=1, max_length=2000)
    # An empty list supports open-ended questions; existing clients can still send options.
    options: list[str] = Field(default_factory=list, max_length=20)

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


class AnswerResponse(BaseModel):
    """Structured AI result plus the original response fields for compatibility."""

    suggested_answer: str
    explanation: str
    confidence: float = Field(ge=0, le=1)
    needs_more_context: bool

    # Keep the original response keys so existing clients do not break.
    answer: str
    message: str


class AIAnswer(BaseModel):
    """The structured result requested from the AI provider."""

    suggested_answer: str = Field(max_length=2000)
    explanation: str = Field(max_length=4000)
    confidence: float = Field(ge=0, le=1)
    needs_more_context: bool
