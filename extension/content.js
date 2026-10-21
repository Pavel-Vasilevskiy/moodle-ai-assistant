"use strict";

const READ_QUESTIONS_MESSAGE = "MOODLE_ASSISTANT_READ_QUESTIONS";
const FLOATING_HOST_ID = "moodle-ai-assistant-floating-host";

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
        const associatedLabelText = labels.filter(isVisible).map(visibleText).filter(Boolean);
        if (associatedLabelText.length > 0) return associatedLabelText.join(" ");

        const wrappingLabelText = visibleText(input.closest?.("label"));
        if (wrappingLabelText) return wrappingLabelText;

        // Moodle may expose the visible option text through ARIA instead of a <label for="...">.
        const labelledBy = input.getAttribute?.("aria-labelledby") || "";
        return labelledBy
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => pageDocument.getElementById?.(id))
          .filter(isVisible)
          .map(visibleText)
          .filter(Boolean)
          .join(" ");
      })
      .map((option) => option.replace(/\s+/g, " ").trim())
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

function initializeFloatingPanel(pageDocument, schedule = setTimeout) {
  if (!pageDocument.body || pageDocument.getElementById(FLOATING_HOST_ID)) return null;

  const host = pageDocument.createElement("div");
  host.id = FLOATING_HOST_ID;
  const shadow = host.attachShadow({ mode: "open" });
  const style = pageDocument.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .host { position: fixed; z-index: 2147483647; right: 16px; bottom: 16px; font: 14px/1.45 "Segoe UI", Arial, sans-serif; color: #182522; }
    .panel { display: flex; flex-direction: column; width: min(390px, calc(100vw - 32px)); max-height: min(620px, calc(100vh - 32px)); overflow: hidden; border: 1px solid #d7e3dc; border-radius: 14px; background: #fff; box-shadow: 0 12px 38px rgb(16 45 34 / 24%); }
    .header { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 48px; padding: 0 12px 0 16px; background: #16745a; color: #fff; }
    .title { margin: 0; font-size: 14px; font-weight: 700; }
    .controls { display: flex; gap: 6px; }
    .control { width: 30px; height: 30px; border: 0; border-radius: 7px; background: rgb(255 255 255 / 15%); color: #fff; font: inherit; font-size: 18px; cursor: pointer; }
    .control:hover, .control:focus-visible { background: rgb(255 255 255 / 28%); outline: 2px solid #fff; outline-offset: 1px; }
    .content { overflow: auto; padding: 14px; }
    .read { width: 100%; min-height: 40px; border: 0; border-radius: 9px; background: #16745a; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
    .read:hover:not(:disabled) { background: #105943; }
    .read:disabled { cursor: wait; opacity: .65; }
    .status { margin: 10px 0 0; color: #53655d; font-size: 12px; }
    .status[data-kind="error"] { color: #9d3434; }
    .questions { display: grid; gap: 10px; margin-top: 12px; }
    .question { border: 1px solid #dfe8e4; border-radius: 9px; padding: 10px; }
    .question-title { margin: 0 0 7px; font-size: 13px; font-weight: 650; white-space: pre-wrap; overflow-wrap: anywhere; }
    .options { margin: 0; padding-left: 20px; color: #53655d; font-size: 12px; }
    .options li { margin: 3px 0; }
    .analyze { width: 100%; min-height: 38px; margin-top: 10px; border: 0; border-radius: 8px; padding: 7px 10px; background: #16745a; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
    .analyze:hover:not(:disabled) { background: #105943; }
    .analyze:disabled { cursor: wait; opacity: .65; }
    .analysis-output { display: grid; gap: 8px; margin-top: 10px; }
    .analysis-field { border-radius: 8px; padding: 9px; background: #f2f7f4; }
    .analysis-label { display: block; margin-bottom: 3px; color: #53655d; font-size: 11px; font-weight: 700; }
    .analysis-value { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
    .reopen { border: 0; border-radius: 999px; padding: 11px 16px; background: #16745a; color: #fff; box-shadow: 0 5px 20px rgb(16 45 34 / 28%); font: inherit; font-weight: 700; cursor: pointer; }
    .reopen:hover, .reopen:focus-visible { background: #105943; outline: 3px solid #8bd2b6; }
    [hidden] { display: none !important; }
    @media (max-width: 420px) { .host { right: 8px; bottom: 8px; } .panel { width: calc(100vw - 16px); max-height: calc(100vh - 16px); } }
  `;

  const wrapper = pageDocument.createElement("div");
  wrapper.className = "host";
  const panel = pageDocument.createElement("section");
  panel.className = "panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Moodle AI Assistant");

  const header = pageDocument.createElement("header");
  header.className = "header";
  const title = pageDocument.createElement("h2");
  title.className = "title";
  title.textContent = "Moodle AI Assistant";
  const controls = pageDocument.createElement("div");
  controls.className = "controls";
  const minimizeButton = pageDocument.createElement("button");
  minimizeButton.className = "control";
  minimizeButton.type = "button";
  minimizeButton.textContent = "−";
  minimizeButton.setAttribute("aria-label", "Згорнути панель");
  const closeButton = pageDocument.createElement("button");
  closeButton.className = "control";
  closeButton.type = "button";
  closeButton.textContent = "×";
  closeButton.setAttribute("aria-label", "Закрити панель");
  controls.append(minimizeButton, closeButton);
  header.append(title, controls);

  const content = pageDocument.createElement("div");
  content.className = "content";
  const readButton = pageDocument.createElement("button");
  readButton.className = "read";
  readButton.type = "button";
  readButton.textContent = "Зчитати запитання";
  const status = pageDocument.createElement("p");
  status.className = "status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const questionList = pageDocument.createElement("div");
  questionList.className = "questions";
  content.append(readButton, status, questionList);
  panel.append(header, content);

  const reopenButton = pageDocument.createElement("button");
  reopenButton.className = "reopen";
  reopenButton.type = "button";
  reopenButton.textContent = "Відкрити Moodle AI Assistant";
  reopenButton.setAttribute("aria-label", "Відкрити Moodle AI Assistant");
  reopenButton.hidden = true;
  wrapper.append(panel, reopenButton);
  shadow.append(style, wrapper);
  pageDocument.body.append(host);

  let minimized = false;
  minimizeButton.addEventListener("click", () => {
    minimized = !minimized;
    content.hidden = minimized;
    minimizeButton.textContent = minimized ? "□" : "−";
    minimizeButton.setAttribute("aria-label", minimized ? "Розгорнути панель" : "Згорнути панель");
  });
  closeButton.addEventListener("click", () => {
    panel.hidden = true;
    reopenButton.hidden = false;
  });
  reopenButton.addEventListener("click", () => {
    panel.hidden = false;
    reopenButton.hidden = true;
  });

  function renderResult(result) {
    questionList.replaceChildren();
    status.dataset.kind = "";

    if (result.status === "not-found") {
      status.textContent = "На сторінці не знайдено підтримуваних запитань.";
      status.dataset.kind = "error";
      return;
    }
    if (result.status === "unsupported") {
      status.textContent = `Знайдено блоків: ${result.candidateCount}. Їхній формат не підтримується.`;
      status.dataset.kind = "error";
      return;
    }
    if (result.status !== "ok" || !Array.isArray(result.questions)) {
      throw new Error("Неочікуваний результат зчитування.");
    }

    const unsupportedCount = Number.isInteger(result.unsupportedCount) ? result.unsupportedCount : 0;
    const supportedCount = result.questions.length;
    status.textContent = `Зчитано запитань: ${supportedCount}. Непідтримуваних блоків: ${unsupportedCount}.`;
    if (supportedCount === 0) {
      status.textContent = "На сторінці не знайдено підтримуваних запитань.";
      status.dataset.kind = "error";
      return;
    }

    for (const item of result.questions) {
      const card = pageDocument.createElement("article");
      card.className = "question";
      const question = pageDocument.createElement("h3");
      question.className = "question-title";
      question.textContent = item.question;
      card.append(question);
      if (item.options.length) {
        const options = pageDocument.createElement("ul");
        options.className = "options";
        for (const optionText of item.options) {
          const option = pageDocument.createElement("li");
          option.textContent = optionText;
          options.append(option);
        }
        card.append(options);
      } else {
        const note = pageDocument.createElement("p");
        note.className = "status";
        note.textContent = item.hasChoiceInputs
          ? "Варіанти відповіді не вдалося зчитати."
          : "Відкрите питання без варіантів відповіді.";
        card.append(note);
      }

      const analyzeButton = pageDocument.createElement("button");
      analyzeButton.className = "analyze";
      analyzeButton.type = "button";
      analyzeButton.textContent = "Отримати відповідь AI";
      const analysisStatus = pageDocument.createElement("p");
      analysisStatus.className = "status";
      analysisStatus.setAttribute("role", "status");
      analysisStatus.setAttribute("aria-live", "polite");
      const analysisOutput = pageDocument.createElement("div");
      analysisOutput.className = "analysis-output";
      analysisOutput.hidden = true;

      function addAnalysisField(labelText, valueText) {
        const field = pageDocument.createElement("section");
        field.className = "analysis-field";
        const label = pageDocument.createElement("span");
        label.className = "analysis-label";
        label.textContent = labelText;
        const value = pageDocument.createElement("p");
        value.className = "analysis-value";
        value.textContent = valueText;
        field.append(label, value);
        analysisOutput.append(field);
      }

      analyzeButton.addEventListener("click", async () => {
        if (analyzeButton.disabled) return;
        analyzeButton.disabled = true;
        analysisOutput.replaceChildren();
        analysisOutput.hidden = true;
        analysisStatus.dataset.kind = "";
        analysisStatus.textContent = "Надсилаю запит до AI…";

        try {
          const response = await chrome.runtime.sendMessage({
            type: "MOODLE_ASSISTANT_ANALYZE_QUESTION",
            question: item.question,
            options: item.options,
          });

          if (!response || response.unavailable) {
            analysisStatus.textContent = "Не вдалося з'єднатися з backend. Перевірте, чи він запущений.";
            analysisStatus.dataset.kind = "error";
            return;
          }
          if (response.timeout) {
            analysisStatus.textContent = "AI не відповів вчасно. Спробуйте ще раз.";
            analysisStatus.dataset.kind = "error";
            return;
          }
          if (response.status === 429) {
            analysisStatus.textContent = "Перевищено ліміт запитів AI. Спробуйте пізніше.";
            analysisStatus.dataset.kind = "error";
            return;
          }
          if (!response.ok) {
            analysisStatus.textContent = typeof response.payload?.detail === "string"
              ? response.payload.detail
              : `Backend повернув помилку (HTTP ${response.status || "невідомо"}).`;
            analysisStatus.dataset.kind = "error";
            return;
          }

          const result = response.payload;
          if (
            !result ||
            typeof result.suggested_answer !== "string" ||
            typeof result.explanation !== "string" ||
            typeof result.confidence !== "number" ||
            !Number.isFinite(result.confidence) ||
            result.confidence < 0 || result.confidence > 1 ||
            typeof result.needs_more_context !== "boolean"
          ) {
            analysisStatus.textContent = "Backend повернув неочікувану відповідь. Спробуйте ще раз.";
            analysisStatus.dataset.kind = "error";
            return;
          }

          addAnalysisField("Запропонована відповідь", result.suggested_answer);
          addAnalysisField("Пояснення", result.explanation);
          addAnalysisField("Впевненість (оцінка AI)", `${Math.round(result.confidence * 100)}%`);
          addAnalysisField(
            "Контекст",
            result.needs_more_context ? "Може бракувати інформації для надійної відповіді." : "Наданого контексту достатньо за оцінкою AI.",
          );
          analysisOutput.hidden = false;
          analysisStatus.textContent = "Відповідь отримано. Перевірте її самостійно.";
        } catch {
          analysisStatus.textContent = "Не вдалося з'єднатися з backend. Перевірте, чи він запущений.";
          analysisStatus.dataset.kind = "error";
        } finally {
          analyzeButton.disabled = false;
        }
      });

      card.append(analyzeButton, analysisStatus, analysisOutput);
      questionList.append(card);
    }
  }

  readButton.addEventListener("click", () => {
    readButton.disabled = true;
    status.dataset.kind = "";
    status.textContent = "Зчитую видимі запитання зі сторінки…";
    schedule(() => {
      try {
        renderResult(extractQuestions(pageDocument));
      } catch {
        status.textContent = "Не вдалося зчитати запитання. Оновіть сторінку й спробуйте ще раз.";
        status.dataset.kind = "error";
      } finally {
        readButton.disabled = false;
      }
    }, 0);
  });

  return { host, shadow, panel, content, readButton, status, questionList, minimizeButton, closeButton, reopenButton };
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== READ_QUESTIONS_MESSAGE) return false;

    sendResponse(extractQuestions(document));
    return false;
  });
  initializeFloatingPanel(document);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { extractQuestions, initializeFloatingPanel };
}
