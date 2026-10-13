"""FastAPI application entry point."""

from fastapi import FastAPI

from app.schemas import AnswerRequest, AnswerResponse

app = FastAPI(
    title="Moodle AI Assistant API",
    description="A minimal local API scaffold for the Moodle AI Assistant.",
    version="0.1.0",
)


@app.get("/health")
def health() -> dict[str, str]:
    """Report that the API process is responding."""
    return {"status": "ok"}


@app.post("/api/answer", response_model=AnswerResponse)
def answer(request: AnswerRequest) -> AnswerResponse:
    """Return a clear placeholder without guessing an answer."""
    return AnswerResponse(
        answer="",
        message="AI ще не підключений. Відповідь поки недоступна.",
    )
