"""Request and response models for the API."""

from pydantic import BaseModel, Field, field_validator


class AnswerRequest(BaseModel):
    """Question and its available answer options."""

    question: str = Field(min_length=1, max_length=2000)
    options: list[str] = Field(min_length=1, max_length=20)

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
    """Placeholder response while AI integration is not available."""

    answer: str
    message: str
