"use strict";

const READ_QUESTIONS_MESSAGE = "MOODLE_ASSISTANT_READ_QUESTIONS";

function isVisible(element) {
  if (!element || (typeof element.getClientRects === "function" && !element.getClientRects().length)) {
    return false;
  }

  if (typeof getComputedStyle === "function") {
    for (let current = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        Number(style.opacity) === 0
      ) {
        return false;
      }
    }
  }

  return true;
}

function visibleText(element) {
  if (!isVisible(element)) return "";
  return (element.innerText || element.textContent || "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractQuestions(pageDocument) {
  const containers = Array.from(pageDocument.querySelectorAll(".que")).filter(
    isVisible,
  );
  const questions = [];
  let unsupportedCount = 0;

  for (const container of containers) {
    const questionText = visibleText(container.querySelector(".qtext"));
    if (!questionText) {
      unsupportedCount += 1;
      continue;
    }

    const answerArea = container.querySelector(".answer");
    const inputs = answerArea
      ? Array.from(
          answerArea.querySelectorAll(
            'input[type="radio"], input[type="checkbox"]',
          ),
        )
      : [];
    const options = inputs
      .map((input) => {
        const labels = input.labels ? Array.from(input.labels) : [];
        const label = labels.find(isVisible) || input.closest?.("label");
        return visibleText(label);
      })
      .filter(Boolean);

    questions.push({
      question: questionText,
      options,
      hasChoiceInputs: inputs.length > 0,
    });
  }

  if (questions.length === 0) {
    return {
      status: containers.length === 0 ? "not-found" : "unsupported",
      questions,
      candidateCount: containers.length,
    };
  }

  return {
    status: "ok",
    questions,
    candidateCount: containers.length,
    unsupportedCount,
  };
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== READ_QUESTIONS_MESSAGE) return false;

    sendResponse(extractQuestions(document));
    return false;
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { extractQuestions };
}
