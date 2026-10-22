"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../background.js"), "utf8");
const ANSWER_MESSAGE = "MOODLE_ASSISTANT_ANALYZE_QUESTION";

function setup(
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ suggested_answer: "A" }) }),
  sendTabMessage = async () => ({ ok: true, visible: true }),
) {
  const listeners = [];
  const actionListeners = [];
  const sentMessages = [];
  const actionCalls = [];
  const chrome = {
    sidePanel: { setPanelBehavior: async () => {} },
    action: {
      onClicked: { addListener: (listener) => actionListeners.push(listener) },
      setTitle: async (value) => actionCalls.push(["title", value]),
      setBadgeText: async (value) => actionCalls.push(["badge", value]),
      setBadgeBackgroundColor: async (value) => actionCalls.push(["color", value]),
    },
    tabs: {
      sendMessage: async (tabId, message) => {
        sentMessages.push({ tabId, message });
        return sendTabMessage(tabId, message);
      },
    },
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
    actionListener: actionListeners[0],
    sentMessages,
    actionCalls,
    sender: { url: "http://127.0.0.1:8765/test-page.html" },
    message: { type: ANSWER_MESSAGE, question: "Question?", options: ["A", "B"] },
  };
}

test("toolbar action sends one toggle message to a supported Moodle tab", async () => {
  const { actionListener, sentMessages, actionCalls } = setup();
  await actionListener({ id: 42, url: "https://distance.kuk.edu.ua/mod/quiz/attempt.php" });

  assert.deepEqual(JSON.parse(JSON.stringify(sentMessages)), [{
    tabId: 42,
    message: { type: "MOODLE_ASSISTANT_TOGGLE_FLOATING_PANEL" },
  }]);
  assert.equal(actionCalls.some(([kind, value]) => kind === "badge" && value.text === ""), true);
});

test("toolbar action keeps supporting the local test page", async () => {
  const { actionListener, sentMessages } = setup();
  await actionListener({ id: 7, url: "http://127.0.0.1:8765/test-page.html" });
  assert.equal(sentMessages.length, 1);
});

test("unsupported tab and missing content script get graceful feedback", async (t) => {
  await t.test("unsupported URL", async () => {
    const { actionListener, sentMessages, actionCalls } = setup();
    await actionListener({ id: 3, url: "chrome://extensions" });
    assert.equal(sentMessages.length, 0);
    assert.equal(actionCalls.some(([kind, value]) => kind === "badge" && value.text === "!"), true);
  });
  await t.test("content script unavailable", async () => {
    const { actionListener, actionCalls } = setup(undefined, async () => {
      throw new Error("no receiver");
    });
    await actionListener({ id: 4, url: "https://distance.kuk.edu.ua/" });
    assert.equal(actionCalls.some(([kind, value]) => kind === "badge" && value.text === "!"), true);
  });
});

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

test("service worker forwards the detected single or multiple-choice mode", async () => {
  let request;
  const { listener, sender, message } = setup(async (_url, options) => {
    request = options;
    return { ok: true, status: 200, json: async () => ({ source: "ai" }) };
  });

  await dispatch(listener, { ...message, selection_mode: "single" }, sender);

  assert.equal(JSON.parse(request.body).selection_mode, "single");
});

test("service worker forwards force_refresh only for an explicit fresh request", async () => {
  let request;
  const { listener, sender, message } = setup(async (_url, options) => {
    request = options;
    return { ok: true, status: 200, json: async () => ({ source: "ai" }) };
  });

  await dispatch(listener, { ...message, force_refresh: true }, sender);

  assert.deepEqual(JSON.parse(request.body), {
    question: "Question?",
    options: ["A", "B"],
    force_refresh: true,
  });
});

test("service worker forwards known wrong options as a forced AI request", async () => {
  let request;
  const { listener, sender, message } = setup(async (_url, options) => {
    request = options;
    return { ok: true, status: 200, json: async () => ({ source: "ai" }) };
  });

  await dispatch(listener, { ...message, excluded_options: ["A"] }, sender);

  assert.deepEqual(JSON.parse(request.body), {
    question: "Question?", options: ["A", "B"], force_refresh: true, excluded_options: ["A"],
  });
});

test("service worker queries history through the dedicated local API route", async () => {
  let request;
  const { listener } = setup(async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => ({ results: [] }) };
  });

  const response = await dispatch(listener, {
    type: "MOODLE_ASSISTANT_GET_QUESTION_HISTORY",
    questions: [{ question: "Question?", options: ["A", "B"], selection_mode: "single" }],
  }, { url: "https://distance.kuk.edu.ua/mod/quiz/attempt.php" });

  assert.equal(response.ok, true);
  assert.equal(request.url, "http://127.0.0.1:8000/api/quiz-import/history");
  assert.deepEqual(JSON.parse(request.options.body), { questions: [{ question: "Question?", options: ["A", "B"], selection_mode: "single" }] });
});

test("service worker sends structured attempt results only to the local import API", async () => {
  let request;
  const { listener, sender } = setup(async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => ({ imported_count: 1, duplicate: false }) };
  });
  const attempt = {
    source_origin: "http://127.0.0.1:8765",
    attempt_identifier: "attempt-1",
    attempt_key: "fixture-attempt-1",
    questions: [{
      question: "Question?",
      question_id: "question-1-1",
      options: [{ text: "Choice", selected: true, mark: "unknown" }],
      earned_score: "0,50",
      max_score: "1,50",
      feedback: null,
    }],
  };
  const result = await dispatch(listener, {
    type: "MOODLE_ASSISTANT_IMPORT_QUIZ_RESULTS", attempt,
  }, sender);

  assert.equal(result.ok, true);
  assert.equal(request.url, "http://127.0.0.1:8000/api/quiz-import");
  assert.equal(request.options.method, "POST");
  assert.deepEqual(JSON.parse(request.options.body), attempt);
});

test("service worker refuses result imports from an unsupported origin or malformed payload", async (t) => {
  let fetchCalls = 0;
  const { listener, sender } = setup(async () => { fetchCalls += 1; });
  const attempt = {
    source_origin: "https://distance.kuk.edu.ua",
    attempt_key: "attempt-key",
    questions: [{ question: "Question?", options: [] }],
  };

  await t.test("origin mismatch", async () => {
    const result = await dispatch(listener, {
      type: "MOODLE_ASSISTANT_IMPORT_QUIZ_RESULTS",
      attempt: { ...attempt, source_origin: "https://not-allowed.example" },
    }, { url: "https://not-allowed.example/" });
    assert.equal(result.status, 403);
  });
  await t.test("malformed options", async () => {
    const result = await dispatch(listener, {
      type: "MOODLE_ASSISTANT_IMPORT_QUIZ_RESULTS",
      attempt: { ...attempt, source_origin: "http://127.0.0.1:8765", questions: [{
        question: "Question?", options: [{ text: "A", selected: "yes", mark: "guess" }],
      }] },
    }, sender);
    assert.equal(result.status, 422);
  });
  assert.equal(fetchCalls, 0);
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
