"use strict";

const READ_QUESTIONS_MESSAGE = "MOODLE_ASSISTANT_READ_QUESTIONS";
const TOGGLE_PANEL_MESSAGE = "MOODLE_ASSISTANT_TOGGLE_FLOATING_PANEL";
const IMPORT_RESULTS_MESSAGE = "MOODLE_ASSISTANT_IMPORT_QUIZ_RESULTS";
const QUESTION_HISTORY_MESSAGE = "MOODLE_ASSISTANT_GET_QUESTION_HISTORY";
const FLOATING_HOST_ID = "moodle-ai-assistant-floating-host";
let pageInstanceKey = null;

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
    const inputTypes = new Set(inputs.map((input) => input.type));
    const selectionMode = inputTypes.size > 1
      ? "mixed"
      : inputTypes.has("radio")
        ? "single"
        : inputTypes.has("checkbox")
          ? "multiple"
          : "open";

    questions.push({
      question: questionText,
      options,
      hasChoiceInputs: inputs.length > 0,
      selectionMode,
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

function extractScorePair(text) {
  const numbers = String(text || "").match(/[-+]?(?:\d{1,3}(?:[ .\u00a0\u202f]\d{3})+|\d+)(?:[,.]\d+)?/g) || [];
  if (numbers.length !== 2) return { earned_score: null, max_score: null };
  return { earned_score: numbers[0].replace(/[ \u00a0\u202f]/g, ""), max_score: numbers[1].replace(/[ \u00a0\u202f]/g, "") };
}

function explicitOptionMark(input, label) {
  const evidence = [input, label, input?.parentElement].filter(Boolean);
  const classes = evidence.flatMap((element) => String(element.className || "").split(/\s+/));
  if (classes.includes("correct")) return "correct";
  if (classes.includes("incorrect") || classes.includes("wrong")) return "incorrect";
  if (classes.includes("partiallycorrect")) return "partial";
  return "unknown";
}

function getOptionLabelElement(input, pageDocument) {
  const labels = input.labels ? Array.from(input.labels) : [];
  const fromLabels = labels.find((label) => isVisible(label) && visibleText(label));
  if (fromLabels) return fromLabels;
  const wrappingLabel = input.closest?.("label");
  if (isVisible(wrappingLabel) && visibleText(wrappingLabel)) return wrappingLabel;
  const labelledBy = input.getAttribute?.("aria-labelledby") || "";
  return labelledBy.trim().split(/\s+/).filter(Boolean)
    .map((id) => pageDocument.getElementById?.(id))
    .find((label) => isVisible(label) && visibleText(label)) || null;
}

function getOptionText(input, pageDocument) {
  return visibleText(getOptionLabelElement(input, pageDocument))
    .replace(/\s+/g, " ").trim();
}

function extractCompletedAttempt(pageDocument, pageUrl = "") {
  const bodyId = pageDocument.body?.id || "";
  const reviewMarker = bodyId === "page-mod-quiz-review";
  if (!reviewMarker) return { status: "not-review", questions: [] };

  const containers = Array.from(pageDocument.querySelectorAll(".que")).filter(isVisible);
  if (!containers.length) return { status: "unsupported", questions: [], candidateCount: 0 };
  let unsupportedCount = 0;
  const questions = [];

  for (const container of containers) {
    const question = visibleText(container.querySelector(".qtext"));
    if (!question) {
      unsupportedCount += 1;
      continue;
    }
    const answer = container.querySelector(".answer");
    const inputs = answer ? Array.from(answer.querySelectorAll(
      'input[type="radio"], input[type="checkbox"]',
    )) : [];
    const options = inputs.map((input) => {
      const label = getOptionLabelElement(input, pageDocument);
      const text = getOptionText(input, pageDocument);
      return text ? {
        text,
        selected: input.checked === true || input.hasAttribute?.("checked") === true,
        mark: explicitOptionMark(input, label),
        input_type: ["radio", "checkbox"].includes(input.type) ? input.type : null,
      } : null;
    }).filter(Boolean);
    const grade = visibleText(container.querySelector(".grade"));
    const scorePair = extractScorePair(grade);
    const feedback = [".specificfeedback", ".generalfeedback", ".feedback"]
      .map((selector) => visibleText(container.querySelector(selector)))
      .filter((text, index, all) => text && all.indexOf(text) === index)
      .join("\n") || null;
    questions.push({
      question_id: container.id || null,
      question,
      options,
      ...scorePair,
      feedback,
    });
  }

  if (!questions.length) return {
    status: "unsupported", questions, candidateCount: containers.length,
  };

  let origin = "";
  let attemptIdentifier = null;
  let attemptKey = "";
  try {
    const url = new URL(pageUrl);
    origin = url.origin;
    const attempt = url.searchParams.get("attempt");
    const cmid = url.searchParams.get("cmid") || "";
    const usageId = questions.map((item) => item.question_id?.match(/^question-(\d+)-/i)?.[1]).find(Boolean);
    attemptIdentifier = attempt || usageId || null;
    if (attemptIdentifier) {
      attemptKey = `${origin}|${cmid}|${attempt ? `attempt:${attempt}` : `usage:${usageId}`}`;
    } else {
      // Without a Moodle attempt/usage identifier, only repeat clicks in this
      // loaded document can be deduplicated reliably.
      pageInstanceKey ||= `document:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      attemptKey = `${origin}|${cmid}|${pageInstanceKey}`;
    }
  } catch {
    return { status: "unsupported", questions, candidateCount: containers.length };
  }

  return {
    status: "ok",
    source_origin: origin,
    attempt_identifier: attemptIdentifier,
    attempt_key: attemptKey,
    questions,
    unsupportedCount,
    candidateCount: containers.length,
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
    :host([hidden]) { display: none !important; }
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
    .import-results { width: 100%; min-height: 36px; margin-top: 8px; border: 1px solid #cbd9d1; border-radius: 8px; padding: 6px 10px; background: #f4f8f5; color: #275b48; font: inherit; font-weight: 650; cursor: pointer; }
    .import-results:hover:not(:disabled) { background: #e8f1eb; }
    .import-results:disabled { cursor: wait; opacity: .65; }
    .status { margin: 10px 0 0; color: #53655d; font-size: 12px; }
    .status[data-kind="error"] { color: #9d3434; }
    .questions { display: grid; gap: 10px; margin-top: 12px; }
    .question { border: 1px solid #dfe8e4; border-radius: 9px; padding: 10px; }
    .question.has-previous-error { border-color: #c74242; background: #fffafa; box-shadow: inset 3px 0 #c74242; }
    .history-warning { margin: 9px 0 0; border-radius: 7px; padding: 8px; background: #fff0f0; color: #922f2f; font-size: 12px; }
    .exclude-known-wrong { width: 100%; min-height: 36px; margin-top: 6px; border: 1px solid #d7a1a1; border-radius: 8px; padding: 6px 9px; background: #fff5f5; color: #8f3030; font: inherit; font-weight: 650; cursor: pointer; }
    .exclude-known-wrong:hover:not(:disabled) { background: #ffe8e8; }
    .exclude-known-wrong:disabled { cursor: wait; opacity: .65; }
    .question-title { margin: 0 0 7px; font-size: 13px; font-weight: 650; white-space: pre-wrap; overflow-wrap: anywhere; }
    .options { margin: 0; padding-left: 20px; color: #53655d; font-size: 12px; }
    .options li { margin: 3px 0; }
    .analyze { width: 100%; min-height: 38px; margin-top: 10px; border: 0; border-radius: 8px; padding: 7px 10px; background: #16745a; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
    .analyze:hover:not(:disabled) { background: #105943; }
    .analyze.fresh { margin-top: 6px; border: 1px solid #cbd9d1; background: #f4f8f5; color: #275b48; }
    .analyze.fresh:hover:not(:disabled) { background: #e8f1eb; }
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
  const importButton = pageDocument.createElement("button");
  importButton.className = "import-results";
  importButton.type = "button";
  importButton.textContent = "Зберегти статистику";
  importButton.hidden = true;
  const importStatus = pageDocument.createElement("p");
  importStatus.className = "status";
  importStatus.setAttribute("role", "status");
  importStatus.setAttribute("aria-live", "polite");
  const status = pageDocument.createElement("p");
  status.className = "status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const questionList = pageDocument.createElement("div");
  questionList.className = "questions";
  content.append(readButton, importButton, importStatus, status, questionList);
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

    const historyCards = [];
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
      const freshButton = pageDocument.createElement("button");
      freshButton.className = "analyze fresh";
      freshButton.type = "button";
      freshButton.textContent = "Запросити свіжу відповідь від AI";
      const analysisStatus = pageDocument.createElement("p");
      analysisStatus.className = "status";
      analysisStatus.setAttribute("role", "status");
      analysisStatus.setAttribute("aria-live", "polite");
      const analysisOutput = pageDocument.createElement("div");
      analysisOutput.className = "analysis-output";
      analysisOutput.hidden = true;
      const historyWarning = pageDocument.createElement("p");
      historyWarning.className = "history-warning";
      historyWarning.hidden = true;
      historyWarning.setAttribute("role", "status");
      const excludeWrongButton = pageDocument.createElement("button");
      excludeWrongButton.className = "exclude-known-wrong";
      excludeWrongButton.type = "button";
      excludeWrongButton.textContent = "Спробувати без відомого неправильного варіанта";
      excludeWrongButton.hidden = true;
      let knownWrongOptions = [];

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

      async function requestAnswer(forceRefresh, excludedOptions = knownWrongOptions) {
        if (analyzeButton.disabled || freshButton.disabled || excludeWrongButton.disabled) return;
        analyzeButton.disabled = true;
        freshButton.disabled = true;
        excludeWrongButton.disabled = true;
        analysisOutput.replaceChildren();
        analysisOutput.hidden = true;
        analysisStatus.dataset.kind = "";
        analysisStatus.textContent = forceRefresh
          ? "Запитую нову відповідь без використання кешу…"
          : "Перевіряю кеш і за потреби надсилаю запит до AI…";

        try {
          const response = await chrome.runtime.sendMessage({
            type: "MOODLE_ASSISTANT_ANALYZE_QUESTION",
            question: item.question,
            options: item.options,
            selection_mode: item.selectionMode || "unknown",
            force_refresh: forceRefresh,
            ...(excludedOptions.length ? { excluded_options: excludedOptions } : {}),
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
            typeof result.needs_more_context !== "boolean" ||
            (excludedOptions.length > 0 && excludedOptions.includes(result.suggested_answer))
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
          analysisStatus.textContent = result.source === "cache"
            ? "Відповідь отримано з локального кешу. Перевірте її самостійно."
            : result.source === "ai"
              ? "Отримано нову відповідь від AI. Перевірте її самостійно."
              : "Відповідь отримано. Перевірте її самостійно.";
        } catch {
          analysisStatus.textContent = "Не вдалося з'єднатися з backend. Перевірте, чи він запущений.";
          analysisStatus.dataset.kind = "error";
        } finally {
          analyzeButton.disabled = false;
          freshButton.disabled = false;
          excludeWrongButton.disabled = false;
        }
      }

      analyzeButton.addEventListener("click", () => requestAnswer(false));
      freshButton.addEventListener("click", () => requestAnswer(true));
      excludeWrongButton.addEventListener("click", () => {
        try {
          requestAnswer(true, JSON.parse(excludeWrongButton.dataset.options || "[]"));
        } catch {
          analysisStatus.textContent = "Не вдалося прочитати дані попередньої спроби.";
          analysisStatus.dataset.kind = "error";
        }
      });

      card.append(analyzeButton, freshButton, analysisStatus, analysisOutput, historyWarning, excludeWrongButton);
      questionList.append(card);
      historyCards.push({
        item, card, historyWarning, excludeWrongButton,
        setFeedback: (options) => { knownWrongOptions = options; },
      });
    }

    let isMoodlePage = false;
    try { isMoodlePage = new URL(location.href).origin === "https://distance.kuk.edu.ua"; } catch { /* history is optional */ }
    if (isMoodlePage) {
      chrome.runtime.sendMessage({
        type: QUESTION_HISTORY_MESSAGE,
        questions: result.questions.map((item) => ({
          question: item.question,
          options: item.options,
          selection_mode: item.selectionMode || "unknown",
        })),
      }).then((response) => {
        if (!response?.ok || !Array.isArray(response.payload?.results)) return;
        for (const history of response.payload.results) {
          const target = historyCards[history.question_index];
          if (!target || !history.had_previous_zero_score) continue;
          target.card.classList?.add("has-previous-error");
          target.historyWarning.hidden = false;
          target.historyWarning.textContent = history.exclusion_note ||
            `У попередній спробі Moodle поставив цьому питанню 0 балів (${history.zero_score_attempts} раз.).`;
          if (Array.isArray(history.excluded_options) && history.excluded_options.length) {
            target.excludeWrongButton.dataset.options = JSON.stringify(history.excluded_options);
            target.setFeedback(history.excluded_options);
            target.excludeWrongButton.hidden = false;
          }
        }
      }).catch(() => {
        // History is supplementary and must not block question reading.
      });
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

  const pageKind = classifyCompletedPage(pageDocument);
  importButton.hidden = pageKind !== "review";
  if (pageKind === "unsupported-review") {
    importButton.hidden = false;
    importButton.disabled = true;
    importStatus.textContent = "Сторінку перегляду спроби знайдено, але її формат не підтримується.";
  }

  importButton.addEventListener("click", async () => {
    if (importButton.disabled) return;
    importButton.disabled = true;
    importStatus.dataset.kind = "";
    importStatus.textContent = "Зчитую результати завершеної спроби…";
    try {
      const attempt = extractCompletedAttempt(pageDocument, typeof location !== "undefined" ? location.href : "");
      if (attempt.status !== "ok" || !attempt.questions.length) {
        importStatus.textContent = "Не вдалося розпізнати результати тесту на цій сторінці.";
        importStatus.dataset.kind = "error";
        return;
      }
      importStatus.textContent = "Зберігаю статистику локально…";
      const response = await chrome.runtime.sendMessage({
        type: IMPORT_RESULTS_MESSAGE,
        attempt,
      });
      if (!response || response.unavailable) {
        importStatus.textContent = "Backend недоступний. Перевірте, чи запущений локальний сервер.";
        importStatus.dataset.kind = "error";
      } else if (response.timeout) {
        importStatus.textContent = "Час очікування відповіді backend вичерпано. Спробуйте ще раз.";
        importStatus.dataset.kind = "error";
      } else if (!response.ok) {
        importStatus.textContent = typeof response.payload?.detail === "string"
          ? response.payload.detail
          : `Не вдалося зберегти статистику (HTTP ${response.status || "?"}).`;
        importStatus.dataset.kind = "error";
      } else if (response.payload?.duplicate) {
        importStatus.textContent = response.payload.message || "Цю спробу вже збережено.";
      } else if (Number.isInteger(response.payload?.imported_count)) {
        const skipped = Number.isInteger(attempt.unsupportedCount) ? attempt.unsupportedCount : 0;
        importStatus.textContent = `Імпортовано запитань: ${response.payload.imported_count}.${skipped ? ` Непідтримуваних блоків пропущено: ${skipped}.` : ""}`;
      } else {
        importStatus.textContent = "Backend повернув неочікувану відповідь про імпорт.";
        importStatus.dataset.kind = "error";
      }
    } catch {
      importStatus.textContent = "Не вдалося прочитати або зберегти результати тесту.";
      importStatus.dataset.kind = "error";
    } finally {
      importButton.disabled = false;
    }
  });

  return { host, shadow, panel, content, readButton, importButton, importStatus, status, questionList, minimizeButton, closeButton, reopenButton };
}

function classifyCompletedPage(pageDocument) {
  if (pageDocument.body?.id === "page-mod-quiz-attempt") return "active";
  if (pageDocument.body?.id !== "page-mod-quiz-review") return "other";
  const questions = Array.from(pageDocument.querySelectorAll(".que")).filter(isVisible);
  if (!questions.length) return "unsupported-review";
  return "review";
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  let floatingPanel = initializeFloatingPanel(document);
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === TOGGLE_PANEL_MESSAGE) {
      floatingPanel ||= initializeFloatingPanel(document);
      if (!floatingPanel) {
        sendResponse({ ok: false });
        return false;
      }
      const visible = floatingPanel.host.hidden;
      floatingPanel.host.hidden = !visible;
      if (visible) {
        floatingPanel.panel.hidden = false;
        floatingPanel.reopenButton.hidden = true;
      }
      sendResponse({ ok: true, visible });
      return false;
    }
    if (message?.type !== READ_QUESTIONS_MESSAGE) return false;

    sendResponse(extractQuestions(document));
    return false;
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    classifyCompletedPage,
    extractCompletedAttempt,
    extractQuestions,
    extractScorePair,
    initializeFloatingPanel,
  };
}
