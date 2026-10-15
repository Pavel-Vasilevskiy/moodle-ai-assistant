"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const extensionDir = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
const source = fs.readFileSync(path.join(extensionDir, "sidepanel.js"), "utf8");
const expectedResult = {
  suggested_answer: "Paris",
  explanation: "Paris is the capital of France.",
  confidence: 0.92,
  needs_more_context: false,
};

class Element {
  constructor() {
    this.value = "";
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.listeners = {};
    this.focused = false;
    this.children = [];
  }

  addEventListener(event, callback) {
    this.listeners[event] = callback;
  }

  async fire(event, payload = {}) {
    return this.listeners[event]?.({ preventDefault() {}, ...payload });
  }

  focus() {
    this.focused = true;
  }

  replaceChildren(...children) {
    this.children = children;
  }

  append(child) {
    this.children.push(child);
  }
}

function harness(
  fetchImpl,
  pageResult = { status: "not-found", questions: [] },
  sendPageMessage = async () => pageResult,
) {
  const ids = [
    "answer-form", "question", "options", "read-question-button", "read-status",
    "question-list", "analyze-button", "clear-button",
    "loading-status", "error-message", "ready-message", "result-section",
    "suggested-answer", "explanation", "confidence", "context-notice",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new Element()]));
  elements["loading-status"].hidden = true;
  elements["error-message"].hidden = true;
  elements["result-section"].hidden = true;
  elements["context-notice"].hidden = true;
  elements["read-status"].hidden = true;
  elements["question-list"].hidden = true;
  elements["answer-form"].reset = () => {
    elements.question.value = "";
    elements.options.value = "";
  };
  const context = {
    document: {
      getElementById: (id) => elements[id],
      createElement: () => new Element(),
    },
    chrome: {
      runtime: { getManifest: () => manifest },
      tabs: {
        query: async () => [{ id: 17 }],
        sendMessage: sendPageMessage,
      },
    },
    fetch: fetchImpl,
    TypeError,
    Error,
    console: { error() {} },
  };
  vm.runInNewContext(source, context);
  return { elements };
}

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

test("manifest defines Side Panel and limits access to backend and local fixture", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
  assert.deepEqual(manifest.permissions, ["sidePanel"]);
  assert.deepEqual(manifest.host_permissions, [
    "http://127.0.0.1:8000/*",
    "http://127.0.0.1:8765/*",
  ]);
  assert.equal(manifest.background.service_worker, "background.js");
  assert.deepEqual(manifest.content_scripts[0].matches, ["http://127.0.0.1:8765/*"]);
  assert.deepEqual(manifest.content_scripts[0].js, ["content.js"]);
});

test("loads a single page question into editable fields without analyzing it", async () => {
  let analyzeCalls = 0;
  const result = {
    status: "ok",
    questions: [{
      question: "Which planet is red?",
      options: ["Venus", "Mars"],
      hasChoiceInputs: true,
    }],
  };
  const { elements } = harness(async () => {
    analyzeCalls += 1;
    return jsonResponse(expectedResult);
  }, result);
  elements["result-section"].hidden = false;
  elements["suggested-answer"].textContent = "Old result";

  await elements["read-question-button"].fire("click");

  assert.equal(elements.question.value, "Which planet is red?");
  assert.equal(elements.options.value, "Venus\nMars");
  assert.match(elements["read-status"].textContent, /loaded for review/);
  assert.equal(analyzeCalls, 0);
  assert.equal(elements["result-section"].hidden, true);
  assert.equal(elements["suggested-answer"].textContent, "");
});

test("requires an explicit choice when multiple questions are found", async () => {
  const result = {
    status: "ok",
    questions: [
      { question: "First question", options: ["A", "B"], hasChoiceInputs: true },
      { question: "Second question", options: [], hasChoiceInputs: false },
    ],
  };
  const { elements } = harness(async () => jsonResponse(expectedResult), result);
  elements.question.value = "Keep my manual question until I choose";

  await elements["read-question-button"].fire("click");

  assert.match(elements["read-status"].textContent, /none was selected automatically/);
  assert.equal(elements["question-list"].children.length, 2);
  assert.equal(elements.question.value, "Keep my manual question until I choose");
  await elements["question-list"].children[1].fire("click");
  assert.equal(elements.question.value, "Second question");
  assert.equal(elements.options.value, "");
  assert.match(elements["read-status"].textContent, /It may be open-ended/);
});

test("does not auto-select the only readable question when the page has other blocks", async () => {
  const { elements } = harness(async () => jsonResponse(expectedResult), {
    status: "ok",
    candidateCount: 2,
    unsupportedCount: 1,
    questions: [{
      question: "<img src=x onerror=alert(1)>",
      options: [],
      hasChoiceInputs: false,
    }],
  });

  await elements["read-question-button"].fire("click");

  assert.equal(elements.question.value, "");
  assert.equal(elements["question-list"].hidden, false);
  assert.equal(elements["question-list"].children.length, 1);
  assert.match(elements["question-list"].children[0].textContent, /<img src=x/);
  await elements["question-list"].children[0].fire("click");
  assert.equal(elements.question.value, "<img src=x onerror=alert(1)>");
});

test("reports an unsupported page reader without changing manual input", async () => {
  const { elements } = harness(async () => jsonResponse(expectedResult), {
    status: "unsupported",
    questions: [],
  });
  elements.question.value = "Manual fallback";

  await elements["read-question-button"].fire("click");

  assert.match(elements["read-status"].textContent, /format is not supported/);
  assert.equal(elements.question.value, "Manual fallback");
});

test("reports a page with no question and preserves manual entry", async () => {
  const { elements } = harness(async () => jsonResponse(expectedResult));
  elements.question.value = "Manual fallback";

  await elements["read-question-button"].fire("click");

  assert.match(elements["read-status"].textContent, /No supported question was found/);
  assert.equal(elements.question.value, "Manual fallback");
});

test("reports communication failures safely and keeps manual entry available", async () => {
  const { elements } = harness(
    async () => jsonResponse(expectedResult),
    undefined,
    async () => { throw new Error("internal tab details"); },
  );
  elements.question.value = "Manual fallback";

  await elements["read-question-button"].fire("click");

  assert.match(elements["read-status"].textContent, /page reader could not be reached/);
  assert.doesNotMatch(elements["read-status"].textContent, /internal tab details/);
  assert.equal(elements.question.value, "Manual fallback");
});

test("sends the expected JSON and presents a successful API response", async () => {
  let request;
  const { elements } = harness(async (url, options) => {
    request = { url, options };
    return jsonResponse(expectedResult);
  });
  elements.question.value = "What is the capital of France?";
  elements.options.value = "Paris\n Rome \n\n";

  await elements["answer-form"].fire("submit");

  assert.equal(request.url, "http://127.0.0.1:8000/api/answer");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(request.options.body), {
    question: "What is the capital of France?",
    options: ["Paris", "Rome"],
  });
  assert.equal(elements["suggested-answer"].textContent, "Paris");
  assert.equal(elements.explanation.textContent, expectedResult.explanation);
  assert.equal(elements.confidence.textContent, "92%");
  assert.equal(elements["result-section"].hidden, false);
  assert.equal(elements["context-notice"].hidden, true);
  assert.equal(elements["error-message"].hidden, true);
});

test("rejects an empty question without making a request", async () => {
  let calls = 0;
  const { elements } = harness(async () => { calls += 1; return jsonResponse(expectedResult); });

  await elements["answer-form"].fire("submit");

  assert.equal(calls, 0);
  assert.match(elements["error-message"].textContent, /Enter a question/);
  assert.equal(elements.question.focused, true);
  assert.equal(elements["result-section"].hidden, true);
});

for (const status of [422, 500]) {
  test(`shows a safe HTTP ${status} error without presenting a result`, async () => {
    const { elements } = harness(async () => jsonResponse({ detail: "Request failed" }, status));
    elements.question.value = "Question?";

    await elements["answer-form"].fire("submit");

    assert.match(elements["error-message"].textContent, /Request failed/);
    assert.equal(elements["result-section"].hidden, true);
  });
}

test("reports backend unavailable when fetch cannot connect", async () => {
  const { elements } = harness(async () => { throw new TypeError("Failed to fetch"); });
  elements.question.value = "Question?";

  await elements["answer-form"].fire("submit");

  assert.match(elements["error-message"].textContent, /Could not reach the backend/);
  assert.equal(elements["result-section"].hidden, true);
});

test("rejects malformed JSON and unexpected successful response shapes", async (t) => {
  await t.test("invalid JSON", async () => {
    const { elements } = harness(async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }));
    elements.question.value = "Question?";
    await elements["answer-form"].fire("submit");
    assert.match(elements["error-message"].textContent, /empty or invalid JSON/);
    assert.equal(elements["result-section"].hidden, true);
  });
  await t.test("unexpected result shape", async () => {
    const { elements } = harness(async () => jsonResponse({ answer: "something" }));
    elements.question.value = "Question?";
    await elements["answer-form"].fire("submit");
    assert.match(elements["error-message"].textContent, /unexpected response format/);
    assert.equal(elements["result-section"].hidden, true);
  });
});

test("prevents duplicate submissions while the request is in progress", async () => {
  let calls = 0;
  let resolveFetch;
  const { elements } = harness(() => {
    calls += 1;
    return new Promise((resolve) => { resolveFetch = resolve; });
  });
  elements.question.value = "Question?";

  const firstRequest = elements["answer-form"].fire("submit");
  assert.equal(elements["analyze-button"].disabled, true);
  assert.equal(elements["clear-button"].disabled, true);
  assert.equal(elements["loading-status"].hidden, false);
  await elements["answer-form"].fire("submit");
  assert.equal(calls, 1);

  resolveFetch(jsonResponse(expectedResult));
  await firstRequest;
  assert.equal(elements["analyze-button"].disabled, false);
  assert.equal(elements["loading-status"].hidden, true);
});

test("Clear resets the form and removes the previous result", async () => {
  const { elements } = harness(async () => jsonResponse(expectedResult));
  elements.question.value = "Question?";
  await elements["answer-form"].fire("submit");
  await elements["clear-button"].fire("click");

  assert.equal(elements.question.value, "");
  assert.equal(elements.options.value, "");
  assert.equal(elements["result-section"].hidden, true);
  assert.equal(elements["error-message"].hidden, true);
  assert.equal(elements["ready-message"].hidden, false);
  assert.equal(elements["read-status"].hidden, true);
  assert.equal(elements["question-list"].children.length, 0);
});
