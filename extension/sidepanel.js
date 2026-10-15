"use strict";

// Keep the API origin in one place: manifest.json's single host permission.
const apiHostPattern = chrome.runtime
  .getManifest()
  .host_permissions.find((pattern) => pattern.endsWith("/*"));
const apiBaseUrl = apiHostPattern?.replace(/\/\*$/, "");
const answerEndpoint = apiBaseUrl ? `${apiBaseUrl}/api/answer` : null;

const form = document.getElementById("answer-form");
const questionInput = document.getElementById("question");
const optionsInput = document.getElementById("options");
const readQuestionButton = document.getElementById("read-question-button");
const readStatus = document.getElementById("read-status");
const questionList = document.getElementById("question-list");
const analyzeButton = document.getElementById("analyze-button");
const clearButton = document.getElementById("clear-button");
const loadingStatus = document.getElementById("loading-status");
const errorMessage = document.getElementById("error-message");
const readyMessage = document.getElementById("ready-message");
const resultSection = document.getElementById("result-section");
const suggestedAnswer = document.getElementById("suggested-answer");
const explanation = document.getElementById("explanation");
const confidence = document.getElementById("confidence");
const contextNotice = document.getElementById("context-notice");

let isLoading = false;
let isReading = false;

function setLoading(loading) {
  isLoading = loading;
  analyzeButton.disabled = loading;
  clearButton.disabled = loading;
  readQuestionButton.disabled = loading;
  loadingStatus.hidden = !loading;
  readyMessage.hidden = loading;
}

function setReading(reading) {
  isReading = reading;
  readQuestionButton.disabled = reading;
  analyzeButton.disabled = reading;
  clearButton.disabled = reading;
}

function setReadStatus(message, isError = false) {
  readStatus.textContent = message;
  readStatus.className = isError ? "read-status read-error" : "read-status";
  readStatus.hidden = !message;
}

function clearReadState() {
  setReadStatus("");
  questionList.replaceChildren();
  questionList.hidden = true;
}

function fillQuestionFields(item) {
  questionInput.value = item.question;
  optionsInput.value = item.options.join("\n");
}

function questionChoiceLabel(item, index) {
  const excerpt = item.question.length > 90
    ? `${item.question.slice(0, 87)}…`
    : item.question;
  const kind = item.hasChoiceInputs
    ? `${item.options.length} readable option${item.options.length === 1 ? "" : "s"}`
    : "open-ended or no choices";
  return `Question ${index + 1} · ${kind}: ${excerpt}`;
}

function showQuestionChoices(questions) {
  questionList.replaceChildren();
  questions.forEach((item, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "question-choice";
    button.textContent = questionChoiceLabel(item, index);
    button.addEventListener("click", () => {
      fillQuestionFields(item);
      const choiceMessage = item.options.length > 0
        ? "Review the question and options below, then select Analyze when ready."
        : item.hasChoiceInputs
          ? "Question loaded, but its option labels could not be read. Review the text and add options if needed."
          : "Question loaded with no answer choices. It may be open-ended; review the text before Analyze.";
      setReadStatus(choiceMessage);
    });
    questionList.append(button);
  });
  questionList.hidden = false;
}

async function readQuestionFromPage() {
  if (isLoading || isReading) return;
  clearReadState();
  hideError();
  clearResult();
  readyMessage.hidden = false;
  setReadStatus("Looking for visible questions on the active page…");
  setReading(true);

  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (typeof activeTab?.id !== "number") {
      setReadStatus("No active browser page is available to read.", true);
      return;
    }

    const result = await chrome.tabs.sendMessage(activeTab.id, {
      type: "MOODLE_ASSISTANT_READ_QUESTIONS",
    });
    if (!result || result.status === "not-found") {
      setReadStatus("No supported question was found on this page.", true);
      return;
    }
    if (result.status === "unsupported") {
      setReadStatus("Question blocks were found, but their format is not supported by this reader.", true);
      return;
    }
    if (result.status !== "ok" || !Array.isArray(result.questions) || result.questions.length === 0) {
      setReadStatus("The page returned an empty or unexpected result. You can enter the question manually.", true);
      return;
    }

    const { questions, unsupportedCount = 0 } = result;
    const candidateCount = Number.isInteger(result.candidateCount)
      ? result.candidateCount
      : questions.length;
    if (questions.length === 1 && candidateCount === 1) {
      const item = questions[0];
      fillQuestionFields(item);
      if (item.options.length > 0) {
        setReadStatus("Question loaded for review. Edit it below if needed, then select Analyze.");
      } else if (item.hasChoiceInputs) {
        setReadStatus("Question loaded, but its option labels could not be read. Review the text and add options if needed.");
      } else {
        setReadStatus("Question loaded with no answer choices. It may be open-ended; review the text before Analyze.");
      }
    } else {
      const skipped = unsupportedCount > 0
        ? ` ${unsupportedCount} unsupported question block(s) were skipped.`
        : "";
      setReadStatus(`Found ${candidateCount} question blocks and ${questions.length} readable question(s). Choose one below; none was selected automatically.${skipped}`);
      showQuestionChoices(questions);
    }
  } catch {
    setReadStatus(
      "This page is not enabled for reading yet, or the page reader could not be reached. You can still enter a question manually.",
      true,
    );
  } finally {
    setReading(false);
  }
}

function clearResult() {
  resultSection.hidden = true;
  suggestedAnswer.textContent = "";
  explanation.textContent = "";
  confidence.textContent = "";
  contextNotice.hidden = true;
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = false;
}

function hideError() {
  errorMessage.textContent = "";
  errorMessage.hidden = true;
}

function getOptions() {
  return optionsInput.value
    .split(/\r?\n/)
    .map((option) => option.trim())
    .filter(Boolean);
}

function validateResponse(payload) {
  return (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    typeof payload.suggested_answer === "string" &&
    typeof payload.explanation === "string" &&
    typeof payload.confidence === "number" &&
    Number.isFinite(payload.confidence) &&
    payload.confidence >= 0 &&
    payload.confidence <= 1 &&
    typeof payload.needs_more_context === "boolean"
  );
}

function validationMessage(detail) {
  if (typeof detail === "string") return detail;
  if (!Array.isArray(detail)) return "Check the question and answer options.";

  const messages = detail
    .map((item) => (typeof item?.msg === "string" ? item.msg : ""))
    .filter(Boolean);
  return messages.length
    ? `Please check your input: ${messages.join("; ")}`
    : "Check the question and answer options.";
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    throw new Error("The backend returned an empty or invalid JSON response.");
  }
}

function presentResult(payload) {
  suggestedAnswer.textContent = payload.suggested_answer || "No reliable answer was suggested.";
  explanation.textContent = payload.explanation;
  confidence.textContent = `${Math.round(payload.confidence * 100)}%`;
  contextNotice.hidden = !payload.needs_more_context;
  resultSection.hidden = false;
}

async function analyze(event) {
  event.preventDefault();
  if (isLoading || isReading) return;

  const question = questionInput.value.trim();
  const options = getOptions();

  hideError();
  clearResult();

  if (!question) {
    showError("Enter a question before analyzing.");
    questionInput.focus();
    return;
  }
  if (question.length > 2000) {
    showError("The question must be 2,000 characters or fewer.");
    return;
  }
  if (options.length > 20) {
    showError("Enter no more than 20 answer options.");
    return;
  }
  if (options.some((option) => option.length > 500)) {
    showError("Each answer option must be 500 characters or fewer.");
    return;
  }
  if (!answerEndpoint) {
    showError("The backend URL is not configured in manifest.json.");
    return;
  }

  setLoading(true);
  try {
    const response = await fetch(answerEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, options }),
    });
    const payload = await readJson(response);

    if (!response.ok) {
      if (response.status === 422) {
        throw new Error(validationMessage(payload?.detail));
      }
      const detail = typeof payload?.detail === "string" ? payload.detail : "";
      if (response.status >= 500) {
        throw new Error(detail || `The backend could not complete the request (HTTP ${response.status}).`);
      }
      throw new Error(detail || `The request was rejected (HTTP ${response.status}).`);
    }

    if (!validateResponse(payload)) {
      throw new Error("The backend returned an unexpected response format.");
    }
    presentResult(payload);
  } catch (error) {
    if (error instanceof TypeError) {
      showError(`Could not reach the backend at ${apiBaseUrl}. Make sure it is running.`);
    } else {
      showError(error instanceof Error ? error.message : "An unexpected error occurred.");
    }
  } finally {
    setLoading(false);
  }
}

function clearForm() {
  if (isLoading || isReading) return;
  form.reset();
  clearReadState();
  hideError();
  clearResult();
  readyMessage.hidden = false;
  questionInput.focus();
}

readQuestionButton.addEventListener("click", readQuestionFromPage);
form.addEventListener("submit", analyze);
clearButton.addEventListener("click", clearForm);
