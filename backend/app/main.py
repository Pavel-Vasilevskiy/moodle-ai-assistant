"""FastAPI application entry point."""

from collections.abc import Callable

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException

from app.schemas import AIAnswer, AnswerRequest, AnswerResponse
from app.services.ai_service import AIServiceError, generate_answer

load_dotenv()

app = FastAPI(
    title="Moodle AI Assistant API",
    description="A local API that returns structured AI answer suggestions.",
    version="0.2.0",
)


def get_answer_generator() -> Callable[[str, list[str]], AIAnswer]:
    """Dependency provider so endpoint tests can replace the AI service."""
    return generate_answer


@app.get("/health")
def health() -> dict[str, str]:
    """Report that the API process is responding."""
    return {"status": "ok"}


@app.post("/api/answer", response_model=AnswerResponse)
def answer(
    request: AnswerRequest,
    answer_generator: Callable[[str, list[str]], AIAnswer] = Depends(
        get_answer_generator
    ),
) -> AnswerResponse:
    """Return a structured AI suggestion while preserving the original keys."""
    try:
        result = answer_generator(request.question, request.options)
    except AIServiceError as exc:
        raise HTTPException(
            status_code=exc.status_code, detail=exc.public_message
        ) from exc

    return AnswerResponse(
        **result.model_dump(),
        answer=result.suggested_answer,
        message=result.explanation,
    )
