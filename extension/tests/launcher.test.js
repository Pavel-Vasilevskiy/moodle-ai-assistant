"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.resolve(__dirname, "../test-launcher.js"),
  "utf8",
);

function setup(openResult = { focus() {} }) {
  const button = {
    listener: null,
    addEventListener(_event, callback) { this.listener = callback; },
    click() { this.listener(); },
  };
  const status = { textContent: "" };
  let openArgs;
  const window = {
    location: { href: "http://127.0.0.1:8765/test-launcher.html" },
    open(...args) { openArgs = args; return openResult; },
  };
  vm.runInNewContext(source, {
    document: { getElementById: (id) => id === "open-popup" ? button : status },
    window,
    URL,
  });
  return { button, status, getOpenArgs: () => openArgs };
}

test("opens the existing fixture with popup window features after a button click", () => {
  const popup = { focusCalled: false, focus() { this.focusCalled = true; } };
  const { button, status, getOpenArgs } = setup(popup);

  button.click();

  assert.deepEqual(getOpenArgs(), [
    "http://127.0.0.1:8765/test-page.html",
    "moodle-ai-assistant-test-quiz",
    "popup,width=980,height=760,resizable=yes,scrollbars=yes",
  ]);
  assert.equal(popup.focusCalled, true);
  assert.match(status.textContent, /separate window/);
});

test("explains that the browser blocked the popup", () => {
  const { button, status } = setup(null);

  button.click();

  assert.match(status.textContent, /blocked the popup/);
});
