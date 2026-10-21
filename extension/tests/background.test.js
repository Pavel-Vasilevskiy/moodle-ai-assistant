"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../background.js"), "utf8");
const ANSWER_MESSAGE = "MOODLE_ASSISTANT_ANALYZE_QUESTION";

function setup(fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ suggested_answer: "A" }) })) {
  const listeners = [];
  const chrome = {
    sidePanel: { setPanelBehavior: async () => {} },
    runtime: {
      onMessage: { addListener: (listener) => listeners.push(listener) },
      getManifest: () => ({ host_permissions: ["http://127.0.0.1:8000/*"] }),
    },
  };
  vm.runInNewContext(source, {
    chrome,
    fetch: fetchImpl,
    URL,
    AbortSignal,
    JSON,
    Promise,
    console: { error() {} },
  });
  return {
    listener: listeners[0],
    sender: { url: "http://127.0.0.1:8765/test-page.html" },
    message: { type: ANSWER_MESSAGE, question: "Question?", options: ["A", "B"] },
  };
}

function dispatch(listener, message, sender) {
  return new Promise((resolve) => {
    const keepChannelOpen = listener(message, sender, resolve);
    if (keepChannelOpen !== true) resolve(undefined);
  });
}

test("service worker sends the quiz question to the configured backend", async () => {
  let request;
  const { listener, sender, message } = setup(async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => ({ suggested_answer: "A" }) };
  });

  const responsePromise = dispatch(listener, message, sender);
  const response = await responsePromise;

  assert.equal(response.ok, true);
  assert.equal(request.url, "http://127.0.0.1:8000/api/answer");
  assert.equal(request.options.method, "POST");
  assert.deepEqual(JSON.parse(request.options.body), { question: "Question?", options: ["A", "B"] });
});

test("service worker rejects pages outside the local fixture and configured Moodle origin", async () => {
  let fetchCalls = 0;
  const { listener, message } = setup(async () => { fetchCalls += 1; });

  const result = await dispatch(listener, message, { url: "http://127.0.0.1:8765/test-launcher.html" });

  assert.equal(result.ok, false);
  assert.match(result.error, /не дозволений/);
  assert.equal(fetchCalls, 0);
});

test("service worker accepts the exact Moodle origin for explicit analysis", async () => {
  let fetchCalls = 0;
  const { listener, message } = setup(async () => {
    fetchCalls += 1;
    return { ok: true, status: 200, json: async () => ({ suggested_answer: "A" }) };
  });

  const result = await dispatch(listener, message, { url: "https://distance.kuk.edu.ua/mod/quiz/attempt.php" });

  assert.equal(result.ok, true);
  assert.equal(fetchCalls, 1);
});

test("service worker validates question bounds before sending a request", async () => {
  let fetchCalls = 0;
  const { listener, sender, message } = setup(async () => { fetchCalls += 1; });

  const result = await dispatch(listener, { ...message, question: "  " }, sender);

  assert.equal(result.status, 422);
  assert.match(result.error, /Перевірте запитання/);
  assert.equal(fetchCalls, 0);
});

test("service worker returns safe timeout and network failure statuses", async (t) => {
  await t.test("timeout", async () => {
    const { listener, sender, message } = setup(async () => {
      const error = new Error("secret internal details");
      error.name = "TimeoutError";
      throw error;
    });

    const result = await dispatch(listener, message, sender);

    assert.equal(result.ok, false);
    assert.equal(result.timeout, true);
    assert.equal(result.unavailable, false);
    assert.equal("message" in result, false);
  });

  await t.test("unavailable backend", async () => {
    const { listener, sender, message } = setup(async () => {
      throw new TypeError("secret network details");
    });

    const result = await dispatch(listener, message, sender);

    assert.equal(result.ok, false);
    assert.equal(result.unavailable, true);
    assert.equal("message" in result, false);
  });
});
