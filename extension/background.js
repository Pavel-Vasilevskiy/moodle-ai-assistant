"use strict";

const ANALYZE_QUESTION_MESSAGE = "MOODLE_ASSISTANT_ANALYZE_QUESTION";
const TEST_PAGE_ORIGIN = "http://127.0.0.1:8765";
const MOODLE_ORIGIN = "https://distance.kuk.edu.ua";

// The toolbar action opens the persistent extension side panel.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => {
    console.error("Could not enable the side panel toolbar action:", error);
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
  if (message?.type !== ANALYZE_QUESTION_MESSAGE) return false;
  if (!isAllowedPage(sender.url)) {
    sendResponse({ ok: false, error: "Запит із цієї сторінки не дозволений." });
    return false;
  }

  const question = message.question;
  const options = message.options;
  if (
    typeof question !== "string" ||
    !question.trim() ||
    question.length > 2000 ||
    !Array.isArray(options) ||
    options.length > 20 ||
    options.some((option) => typeof option !== "string" || option.length > 500)
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
    body: JSON.stringify({ question: question.trim(), options }),
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
