"""FastAPI application entry point."""

import logging
import os
import sqlite3
from collections.abc import Callable

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException

from app.schemas import (
    AIAnswer,
    AnswerRequest,
    AnswerResponse,
    QuestionHistoryRequest,
    QuestionHistoryResponse,
    QuizAttemptImportRequest,
    QuizAttemptImportResponse,
    UsageStatistics,
)
from app.services.ai_service import AIServiceError, generate_answer
from app.services.quiz_import_store import (
    get_negative_feedback,
    get_question_history,
    save_attempt,
)
from app.services.question_cache import get_answer_with_source
from app.services.usage_store import get_statistics

load_dotenv()

app = FastAPI(
    title="Moodle AI Assistant API",
    description="A local API that returns structured AI answer suggestions.",
    version="0.2.0",
)

logger = logging.getLogger(__name__)


def get_answer_generator() -> Callable[..., AIAnswer]:
    """Dependency provider so endpoint tests can replace the AI service."""
    return generate_answer


@app.get("/health")
def health() -> dict[str, str]:
    """Report that the API process is responding."""
    return {"status": "ok"}


@app.get("/api/usage", response_model=UsageStatistics)
def usage_statistics() -> UsageStatistics:
    """Expose aggregate token counts and costs without request contents."""
    model = os.getenv("OPENAI_MODEL", "").strip()
    if len(model) > 128:
        model = ""
    return UsageStatistics.model_validate(get_statistics(model))


@app.post("/api/quiz-import", response_model=QuizAttemptImportResponse)
def import_quiz_attempt(request: QuizAttemptImportRequest) -> QuizAttemptImportResponse:
    """Save structured data captured from a completed Moodle attempt review."""
    try:
        return QuizAttemptImportResponse.model_validate(save_attempt(request))
    except (sqlite3.Error, OSError):
        logger.warning("Could not persist Moodle quiz attempt import.")
        raise HTTPException(
            status_code=503,
            detail="Не вдалося зберегти статистику тесту. Перевірте доступність локальної бази.",
        ) from None


@app.post("/api/quiz-import/history", response_model=QuestionHistoryResponse)
def question_history(request: QuestionHistoryRequest) -> QuestionHistoryResponse:
    """Return scoped prior zero-score information for current questions."""
    try:
        return QuestionHistoryResponse(results=get_question_history(request))
    except (sqlite3.Error, OSError):
        logger.warning("Could not read Moodle quiz attempt history.")
        raise HTTPException(
            status_code=503,
            detail="Не вдалося прочитати локальну історію тестів.",
        ) from None


@app.post("/api/answer", response_model=AnswerResponse)
def answer(
    request: AnswerRequest,
    answer_generator: Callable[..., AIAnswer] = Depends(
        get_answer_generator
    ),
) -> AnswerResponse:
    """Return a structured AI suggestion while preserving the original keys."""
    try:
        negative_feedback = get_negative_feedback(
            request.question, request.options, request.selection_mode
        )
    except (sqlite3.Error, OSError):
        # A history database outage should not disable ordinary answer analysis.
        logger.warning("Could not load negative Moodle feedback for this question.")
        negative_feedback = {
            "has_negative_feedback": False,
            "incorrect_options": [],
            "incorrect_combinations": [],
            "unclassified_selections": [],
            "moodle_feedback": [],
            "selection_mode": request.selection_mode,
        }

    try:
        result, source = get_answer_with_source(
            request.question,
            request.options,
            answer_generator,
            force_refresh=request.force_refresh,
            excluded_options=request.excluded_options,
            negative_feedback=negative_feedback,
        )
    except AIServiceError as exc:
        raise HTTPException(
            status_code=exc.status_code, detail=exc.public_message
        ) from exc

    return AnswerResponse(
        **result.model_dump(),
        answer=result.suggested_answer,
        message=result.explanation,
        source=source,
    )
