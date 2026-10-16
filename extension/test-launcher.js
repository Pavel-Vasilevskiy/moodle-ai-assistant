"use strict";

const openButton = document.getElementById("open-popup");
const status = document.getElementById("status");

openButton.addEventListener("click", () => {
  const quizUrl = new URL("test-page.html", window.location.href).href;
  const popup = window.open(
    quizUrl,
    "moodle-ai-assistant-test-quiz",
    "popup,width=980,height=760,resizable=yes,scrollbars=yes",
  );

  if (!popup) {
    status.textContent = "The browser blocked the popup. Allow popups for this local test page and try again.";
    return;
  }

  popup.focus();
  status.textContent = "Test quiz opened in a separate window. Browser chrome depends on Chrome settings.";
});
