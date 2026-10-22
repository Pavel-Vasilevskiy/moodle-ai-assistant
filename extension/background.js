"use strict";

const ANALYZE_QUESTION_MESSAGE = "MOODLE_ASSISTANT_ANALYZE_QUESTION";
const TOGGLE_PANEL_MESSAGE = "MOODLE_ASSISTANT_TOGGLE_FLOATING_PANEL";
const IMPORT_RESULTS_MESSAGE = "MOODLE_ASSISTANT_IMPORT_QUIZ_RESULTS";
const QUESTION_HISTORY_MESSAGE = "MOODLE_ASSISTANT_GET_QUESTION_HISTORY";
const TEST_PAGE_ORIGIN = "http://127.0.0.1:8765";
const MOODLE_ORIGIN = "https://distance.kuk.edu.ua";

function setActionFeedback(tabId, title, badge) {
  const operations = [chrome.action.setTitle({ tabId, title })];
  if (badge !== undefined) {
    operations.push(chrome.action.setBadgeText({ tabId, text: badge }));
    if (badge) operations.push(chrome.action.setBadgeBackgroundColor({ tabId, color: "#a83232" }));
  }
  return Promise.all(operations).catch(() => {});
}

// The toolbar click toggles the in-page panel on supported pages.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !isAllowedPage(tab.url)) {
    await setActionFeedback(tab?.id, "Open Moodle AI Assistant on a supported Moodle page", "!");
    return;
  }

  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: TOGGLE_PANEL_MESSAGE });
    if (!result?.ok) throw new Error("Content script did not respond");
    await setActionFeedback(tab.id, "Toggle Moodle AI Assistant", "");
  } catch {
    await setActionFeedback(tab.id, "Refresh this supported page, then try again", "!");
  }
});

function getBackendEndpoint() {
  const backendPermission = chrome.runtime
    .getManifest()
    .host_permissions.find((pattern) => pattern.startsWith("http://127.0.0.1:8000/"));
  if (!backendPermission) return null;
  return `${backendPermission.replace(/\*$/, "")}api/answer`;
}

function isAllowedPage(senderUrl) {
  try {
    const url = new URL(senderUrl);
    return (
      (url.origin === TEST_PAGE_ORIGIN && url.pathname === "/test-page.html") ||
      url.origin === MOODLE_ORIGIN
    );
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === QUESTION_HISTORY_MESSAGE) {
    if (!isAllowedPage(sender.url)) {
      sendResponse({ ok: false, status: 403 });
      return false;
    }
    const questions = message.questions;
    if (!Array.isArray(questions) || questions.length < 1 || questions.length > 200 ||
        questions.some((item) => !item || typeof item.question !== "string" || !item.question.trim() ||
          item.question.length > 10000 || !Array.isArray(item.options) || item.options.length > 100 ||
          item.options.some((option) => typeof option !== "string" || option.length > 5000) ||
          !["single", "multiple", "open", "mixed", "unknown"].includes(item.selection_mode))) {
      sendResponse({ ok: false, status: 422, payload: { detail: "Некоректні дані запитань." } });
      return false;
    }
    const permission = chrome.runtime.getManifest().host_permissions
      .find((pattern) => pattern.startsWith("http://127.0.0.1:8000/"));
    if (!permission) {
      sendResponse({ ok: false, error: "Адресу backend не налаштовано в manifest.json." });
      return false;
    }
    fetch(`${permission.replace(/\*$/, "")}api/quiz-import/history`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questions }),
      signal: AbortSignal.timeout(30000),
    }).then(async (response) => {
      let payload = null;
      try { payload = await response.json(); } catch { /* status is still useful */ }
      sendResponse({ ok: response.ok, status: response.status, payload });
    }).catch((error) => sendResponse({
      ok: false,
      timeout: error?.name === "TimeoutError",
      unavailable: error?.name !== "TimeoutError",
    }));
    return true;
  }

  if (message?.type === IMPORT_RESULTS_MESSAGE) {
    if (!isAllowedPage(sender.url)) {
      sendResponse({ ok: false, status: 403, payload: { detail: "Імпорт із цієї сторінки не дозволений." } });
      return false;
    }

    const attempt = message.attempt;
    let senderOrigin = "";
    try { senderOrigin = new URL(sender.url).origin; } catch { /* handled by allowlist above */ }
    if (
      !attempt ||
      attempt.source_origin !== senderOrigin ||
      typeof attempt.attempt_key !== "string" ||
      !attempt.attempt_key ||
      attempt.attempt_key.length > 512 ||
      !Array.isArray(attempt.questions) ||
      attempt.questions.length < 1 ||
      attempt.questions.length > 200 ||
      attempt.questions.some((question) =>
        !question ||
        typeof question.question !== "string" ||
        !question.question.trim() ||
        question.question.length > 10000 ||
        !Array.isArray(question.options) ||
        question.options.length > 100 ||
        question.options.some((option) =>
          !option || typeof option.text !== "string" || option.text.length > 5000 ||
          typeof option.selected !== "boolean" ||
          !["correct", "incorrect", "partial", "unknown"].includes(option.mark)
        ) ||
        (question.earned_score !== null && question.earned_score !== undefined &&
          (typeof question.earned_score !== "string" || question.earned_score.length > 64)) ||
        (question.max_score !== null && question.max_score !== undefined &&
          (typeof question.max_score !== "string" || question.max_score.length > 64))
      )
    ) {
      sendResponse({ ok: false, status: 422, payload: { detail: "Дані результатів неповні або мають непідтримуваний формат." } });
      return false;
    }

    const backendPermission = chrome.runtime.getManifest().host_permissions
      .find((pattern) => pattern.startsWith("http://127.0.0.1:8000/"));
    if (!backendPermission) {
      sendResponse({ ok: false, error: "Адресу backend не налаштовано в manifest.json." });
      return false;
    }
    const endpoint = `${backendPermission.replace(/\*$/, "")}api/quiz-import`;
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(attempt),
      signal: AbortSignal.timeout(30000),
    })
      .then(async (response) => {
        let payload = null;
        try { payload = await response.json(); } catch { /* status remains useful */ }
        sendResponse({ ok: response.ok, status: response.status, payload });
      })
      .catch((error) => sendResponse({
        ok: false,
        timeout: error?.name === "TimeoutError",
        unavailable: error?.name !== "TimeoutError",
      }));
    return true;
  }

  if (message?.type !== ANALYZE_QUESTION_MESSAGE) return false;
  if (!isAllowedPage(sender.url)) {
    sendResponse({ ok: false, error: "Запит із цієї сторінки не дозволений." });
    return false;
  }

  const question = message.question;
  const options = message.options;
  const excludedOptions = message.excluded_options ?? [];
  if (
    typeof question !== "string" ||
    !question.trim() ||
    question.length > 2000 ||
    !Array.isArray(options) ||
    options.length > 20 ||
    options.some((option) => typeof option !== "string" || option.length > 500) ||
    !Array.isArray(excludedOptions) || excludedOptions.length > 20 ||
    new Set(excludedOptions).size !== excludedOptions.length ||
    excludedOptions.some((option) => typeof option !== "string" || !options.includes(option)) ||
    (message.selection_mode !== undefined &&
      !["single", "multiple", "open", "mixed", "unknown"].includes(message.selection_mode))
  ) {
    sendResponse({ ok: false, status: 422, error: "Перевірте запитання та варіанти відповіді." });
    return false;
  }

  const endpoint = getBackendEndpoint();
  if (!endpoint) {
    sendResponse({ ok: false, error: "Адресу backend не налаштовано в manifest.json." });
    return false;
  }

  fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: question.trim(),
      options,
      ...(message.selection_mode ? { selection_mode: message.selection_mode } : {}),
      ...(message.force_refresh === true || excludedOptions.length ? { force_refresh: true } : {}),
      ...(excludedOptions.length ? { excluded_options: excludedOptions } : {}),
    }),
    signal: AbortSignal.timeout(30000),
  })
    .then(async (response) => {
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        // Return status only; the content script will show a safe format error.
      }
      sendResponse({ ok: response.ok, status: response.status, payload });
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        timeout: error?.name === "TimeoutError",
        unavailable: error?.name !== "TimeoutError",
      });
    });

  return true;
});
