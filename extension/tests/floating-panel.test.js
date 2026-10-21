"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../content.js"), "utf8");

class Element {
  constructor(tagName = "div", text = "") {
    this.tagName = tagName.toUpperCase();
    this.textContent = text;
    this.innerText = text;
    this.className = "";
    this.children = [];
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.attributes = {};
    this.dataset = {};
    this.parentElement = null;
    this.labels = [];
  }

  addEventListener(type, callback) { this.listeners[type] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  attachShadow() { this.shadowRoot = new Element("shadow-root"); return this.shadowRoot; }
  getClientRects() { return [{}]; }
  querySelector(selector) {
    if (selector === ".qtext") return this.questionText || null;
    if (selector === ".answer") return this.answerArea || null;
    return null;
  }
  querySelectorAll(selector) {
    if (selector === ".que") return this.questionBlocks || [];
    if (selector.startsWith('input[type="radio"]')) return this.inputs || [];
    return [];
  }
  click() { return this.listeners.click?.(); }
}

function quizQuestion(question, options = [], { choiceInputs = options.length > 0 } = {}) {
  const block = new Element("section");
  block.questionText = question ? new Element("p", question) : null;
  block.answerArea = new Element("div");
  block.answerArea.querySelectorAll = () => options.map((text) => {
    const label = new Element("label", text);
    const input = new Element("input");
    input.type = choiceInputs ? "radio" : "textarea";
    input.labels = choiceInputs ? [label] : [];
    return input;
  });
  return block;
}

function setup(blocks = [], sendMessage = async () => ({ ok: false, unavailable: true })) {
  const body = new Element("body");
  const document = {
    body,
    questionBlocks: blocks,
    getElementById: (id) => body.children.find((child) => child.id === id) || null,
    createElement: (tag) => new Element(tag),
    querySelectorAll: (selector) => selector === ".que" ? blocks : [],
  };
  const messageListeners = [];
  const scheduled = [];
  const chrome = { runtime: {
    onMessage: { addListener: (listener) => messageListeners.push(listener) },
    sendMessage,
  } };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    chrome,
    document,
    module,
    setTimeout: (callback) => scheduled.push(callback),
  });
  const host = body.children[0];
  const shadow = host.shadowRoot;
  const wrapper = shadow.children[1];
  const panel = wrapper.children[0];
  const content = panel.children[1];
  const controls = panel.children[0].children[1];
  const ui = {
    host,
    shadow,
    panel,
    content,
    readButton: content.children[0],
    status: content.children[1],
    questionList: content.children[2],
    minimizeButton: controls.children[0],
    closeButton: controls.children[1],
    reopenButton: wrapper.children[1],
  };
  return { document, body, ui, scheduled, messageListeners, initialize: module.exports.initializeFloatingPanel };
}

function byClass(root, name) {
  if (root.className === name) return root;
  for (const child of root.children) {
    const found = byClass(child, name);
    if (found) return found;
  }
  return null;
}

test("initializes one floating Shadow DOM panel without changing the page layout", () => {
  const { body, ui, document, initialize } = setup();

  assert.equal(body.children.length, 1);
  assert.equal(initialize(document), null);
  assert.equal(ui.host.id, "moodle-ai-assistant-floating-host");
  assert.equal(ui.shadow.children[0].tagName, "STYLE");
  assert.equal(ui.panel.hidden, false);
  assert.equal(ui.reopenButton.hidden, true);
  assert.equal(byClass(ui.shadow, "title").textContent, "Moodle AI Assistant");
  assert.equal(byClass(ui.shadow, "read").textContent, "Зчитати запитання");
});

test("minimizes, restores, closes, and reopens without removing the quiz window", () => {
  const { ui } = setup();

  ui.minimizeButton.click();
  assert.equal(ui.content.hidden, true);
  assert.equal(ui.minimizeButton.attributes["aria-label"], "Розгорнути панель");
  ui.minimizeButton.click();
  assert.equal(ui.content.hidden, false);

  ui.closeButton.click();
  assert.equal(ui.panel.hidden, true);
  assert.equal(ui.reopenButton.hidden, false);
  ui.reopenButton.click();
  assert.equal(ui.panel.hidden, false);
  assert.equal(ui.reopenButton.hidden, true);
});

test("shows processing state, extracted questions, options, and unsupported count", () => {
  const { ui, scheduled } = setup([
    quizQuestion("Яка планета відома як Червона планета?", ["Венера", "Марс"]),
    quizQuestion("Поясніть, що робить API.", [], { choiceInputs: false }),
    quizQuestion(null),
  ]);
  ui.readButton.click();
  assert.equal(ui.readButton.disabled, true);
  assert.match(ui.status.textContent, /Зчитую/);
  scheduled.shift()();

  assert.equal(ui.readButton.disabled, false);
  assert.match(ui.status.textContent, /Зчитано запитань: 2/);
  assert.match(ui.status.textContent, /Непідтримуваних блоків: 1/);
  assert.equal(ui.questionList.children.length, 2);
  assert.equal(ui.questionList.children[0].children[0].textContent, "Яка планета відома як Червона планета?");
  assert.deepEqual(ui.questionList.children[0].children[1].children.map((item) => item.textContent), ["Венера", "Марс"]);
  assert.equal(ui.questionList.children[1].children[1].textContent, "Відкрите питання без варіантів відповіді.");
});

test("shows clear messages for pages with no questions or only unsupported questions", () => {
  const empty = setup();
  const emptyUi = empty.ui;
  emptyUi.readButton.click();
  empty.scheduled.shift()();
  assert.match(emptyUi.status.textContent, /не знайдено підтримуваних/);
  assert.equal(emptyUi.questionList.children.length, 0);

  const unsupported = setup([quizQuestion(null)]);
  const unsupportedUi = unsupported.ui;
  unsupportedUi.readButton.click();
  unsupported.scheduled.shift()();
  assert.match(unsupportedUi.status.textContent, /формат не підтримується/);
});

test("sends the selected question to the extension worker and safely renders an AI answer", async () => {
  const sentMessages = [];
  const answer = {
    suggested_answer: "Марс",
    explanation: "Умовою вказано характерний червоний колір планети.",
    confidence: 0.84,
    needs_more_context: true,
  };
  const { ui, scheduled } = setup(
    [quizQuestion("Яка планета червона?", ["Венера", "Марс"])],
    async (message) => {
      sentMessages.push(message);
      return { ok: true, status: 200, payload: answer };
    },
  );
  ui.readButton.click();
  scheduled.shift()();
  const card = ui.questionList.children[0];
  const analyzeButton = card.children[2];
  const analysisStatus = card.children[3];
  const analysisOutput = card.children[4];

  await analyzeButton.click();

  assert.deepEqual(JSON.parse(JSON.stringify(sentMessages)), [{
    type: "MOODLE_ASSISTANT_ANALYZE_QUESTION",
    question: "Яка планета червона?",
    options: ["Венера", "Марс"],
  }]);
  assert.match(analysisStatus.textContent, /Відповідь отримано/);
  assert.equal(analysisOutput.hidden, false);
  assert.equal(analysisOutput.children[0].children[1].textContent, "Марс");
  assert.equal(analysisOutput.children[1].children[1].textContent, answer.explanation);
  assert.match(analysisOutput.children[2].children[1].textContent, /84%/);
  assert.match(analysisOutput.children[3].children[1].textContent, /бракувати інформації/);
});

test("shows safe errors without rendering a fake answer for backend failures or invalid JSON", async (t) => {
  const cases = [
    [{ ok: false, status: 503, payload: { detail: "AI backend is not configured." } }, /AI backend is not configured/, false],
    [{ ok: false, status: 429, payload: null }, /ліміт запитів AI/, false],
    [{ ok: true, status: 200, payload: { suggested_answer: "wrong shape" } }, /неочікувану відповідь/, false],
    [{ ok: false, unavailable: true }, /Не вдалося з'єднатися з backend/, false],
  ];
  for (const [result, expectedMessage, shouldShow] of cases) {
    await t.test(expectedMessage.toString(), async () => {
      const { ui, scheduled } = setup([quizQuestion("Question", ["A", "B"])], async () => result);
      ui.readButton.click();
      scheduled.shift()();
      const card = ui.questionList.children[0];
      const analyzeButton = card.children[2];
      const status = card.children[3];
      const output = card.children[4];
      await analyzeButton.click();

      assert.match(status.textContent, expectedMessage);
      assert.equal(output.hidden, !shouldShow);
      assert.equal(output.children.length, 0);
    });
  }
});

test("prevents duplicate AI requests while one question is being analyzed", async () => {
  let calls = 0;
  let resolveRequest;
  const { ui, scheduled } = setup([quizQuestion("Question", ["A"])], () => {
    calls += 1;
    return new Promise((resolve) => { resolveRequest = resolve; });
  });
  ui.readButton.click();
  scheduled.shift()();
  const analyzeButton = ui.questionList.children[0].children[2];
  const firstRequest = analyzeButton.click();

  assert.equal(analyzeButton.disabled, true);
  await analyzeButton.click();
  assert.equal(calls, 1);
  resolveRequest({
    ok: true,
    payload: {
      suggested_answer: "A",
      explanation: "Reason.",
      confidence: 0.5,
      needs_more_context: false,
    },
  });
  await firstRequest;
  assert.equal(analyzeButton.disabled, false);
});
