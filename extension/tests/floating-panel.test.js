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
    this.classList = { add: (name) => { this.className = `${this.className} ${name}`.trim(); } };
    this.id = "";
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
  getAttribute(name) { return this.attributes[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
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
    if (selector === ".grade") return this.grade || null;
    if ([".specificfeedback", ".generalfeedback", ".feedback"].includes(selector)) return this.feedback || null;
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

function reviewQuestion({ id, question, grade, options = [], feedback = null }) {
  const block = quizQuestion(question, options, { choiceInputs: true });
  block.id = id;
  block.grade = new Element("div", grade);
  block.feedback = feedback ? new Element("div", feedback) : null;
  block.answerArea.querySelectorAll = () => options.map((option) => {
    const label = new Element("div", option.text);
    label.id = option.id;
    const input = new Element("input");
    input.type = option.type || "radio";
    input.checked = option.selected === true;
    input.labels = [label];
    input.className = option.mark || "";
    return input;
  });
  return block;
}

function setup(blocks = [], sendMessage = async () => ({ ok: false, unavailable: true }), {
  bodyId = "page-mod-quiz-attempt",
  pageUrl = "https://distance.kuk.edu.ua/mod/quiz/attempt.php?attempt=33&cmid=12",
} = {}) {
  const body = new Element("body");
  body.id = bodyId;
  function findById(node, id) {
    if (node.id === id) return node;
    for (const child of node.children) {
      const found = findById(child, id);
      if (found) return found;
    }
    return null;
  }
  const document = {
    body,
    questionBlocks: blocks,
    getElementById: (id) => findById(body, id),
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
    URL,
    location: { href: pageUrl },
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
    importButton: content.children[1],
    importStatus: content.children[2],
    status: content.children[3],
    questionList: content.children[4],
    minimizeButton: controls.children[0],
    closeButton: controls.children[1],
    reopenButton: wrapper.children[1],
  };
  return {
    document, body, ui, scheduled, messageListeners,
    initialize: module.exports.initializeFloatingPanel,
    extractCompletedAttempt: module.exports.extractCompletedAttempt,
  };
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
  assert.match(ui.shadow.children[0].textContent, /:host\(\[hidden\]\)/);
  assert.equal(ui.panel.hidden, false);
  assert.equal(ui.reopenButton.hidden, true);
  assert.equal(byClass(ui.shadow, "title").textContent, "Moodle AI Assistant");
  assert.equal(byClass(ui.shadow, "read").textContent, "Зчитати запитання");
  assert.equal(ui.importButton.textContent, "Зберегти статистику");
  assert.equal(ui.importButton.hidden, true);
});

test("only completed review pages expose the statistics import action", () => {
  const active = setup([quizQuestion("Active question", ["A"])], undefined, { bodyId: "page-mod-quiz-attempt" });
  const review = setup([quizQuestion("Reviewed question", ["A"])], undefined, { bodyId: "page-mod-quiz-review" });
  const other = setup([], undefined, { bodyId: "page-course-view-topics" });

  assert.equal(active.ui.importButton.hidden, true);
  assert.equal(review.ui.importButton.hidden, false);
  assert.equal(other.ui.importButton.hidden, true);
});

test("extracts review question, options, selected choice, localized scores, and attempt ID", () => {
  const blocks = [reviewQuestion({
    id: "question-10001-3",
    question: "Демо-питання з дробовою оцінкою?",
    grade: "Балів 0,50 з 1,50",
    options: [
      { id: "choice-a", text: "Обраний варіант", selected: true, type: "checkbox" },
      { id: "choice-b", text: "Інший варіант", selected: true, type: "checkbox" },
    ],
    feedback: "Зворотний зв'язок Moodle",
  })];
  const { document, extractCompletedAttempt } = setup(blocks, undefined, {
    bodyId: "page-mod-quiz-review",
    pageUrl: "https://distance.kuk.edu.ua/mod/quiz/review.php?attempt=765932&cmid=77256",
  });

  const result = extractCompletedAttempt(document, "https://distance.kuk.edu.ua/mod/quiz/review.php?attempt=765932&cmid=77256");

  assert.equal(result.status, "ok");
  assert.equal(result.attempt_identifier, "765932");
  assert.match(result.attempt_key, /77256\|attempt:765932/);
  assert.deepEqual(JSON.parse(JSON.stringify(result.questions[0])), {
    question_id: "question-10001-3",
    question: "Демо-питання з дробовою оцінкою?",
    options: [
      { text: "Обраний варіант", selected: true, mark: "unknown", input_type: "checkbox" },
      { text: "Інший варіант", selected: true, mark: "unknown", input_type: "checkbox" },
    ],
    earned_score: "0,50",
    max_score: "1,50",
    feedback: "Зворотний зв'язок Moodle",
  });
});

test("records only explicit correctness classes and never infers them from the score", () => {
  const blocks = [reviewQuestion({
    id: "question-10001-1",
    question: "Question?",
    grade: "Балів 0,00 з 5,00",
    options: [
      { id: "selected", text: "Selected", selected: true },
      { id: "explicit", text: "Explicitly marked", selected: false, mark: "correct" },
    ],
  })];
  const { document, extractCompletedAttempt } = setup(blocks, undefined, {
    bodyId: "page-mod-quiz-review",
  });
  const result = extractCompletedAttempt(document, "https://distance.kuk.edu.ua/mod/quiz/review.php?attempt=1");

  assert.equal(result.questions[0].options[0].mark, "unknown");
  assert.equal(result.questions[0].options[1].mark, "correct");
  assert.equal(result.questions[0].earned_score, "0,00");
});

test("saves review statistics through the worker and reports success or duplicate", async () => {
  const sent = [];
  const responses = [
    { ok: true, payload: { imported_count: 1, duplicate: false } },
    { ok: true, payload: { imported_count: 0, duplicate: true, message: "Цю спробу вже збережено." } },
  ];
  const block = reviewQuestion({
    id: "question-10001-1", question: "Question?", grade: "Балів 1,00 з 1,00",
    options: [{ id: "opt", text: "Answer", selected: true }],
  });
  const { ui } = setup([block, quizQuestion(null)], async (message) => {
    sent.push(message);
    return responses.shift();
  }, { bodyId: "page-mod-quiz-review" });

  await ui.importButton.click();
  assert.match(ui.importStatus.textContent, /Імпортовано запитань: 1/);
  assert.match(ui.importStatus.textContent, /Непідтримуваних блоків пропущено: 1/);
  assert.equal(sent[0].type, "MOODLE_ASSISTANT_IMPORT_QUIZ_RESULTS");
  assert.equal(sent[0].attempt.questions[0].options[0].selected, true);
  await ui.importButton.click();
  assert.match(ui.importStatus.textContent, /вже збережено/);
  assert.equal(sent.length, 2);
});

test("reports unsupported review pages and backend errors without claiming import", async () => {
  const unsupported = setup([], undefined, { bodyId: "page-mod-quiz-review" });
  assert.equal(unsupported.ui.importButton.disabled, true);
  assert.match(unsupported.ui.importStatus.textContent, /формат не підтримується/);

  const failed = setup([reviewQuestion({
    id: "question-10001-1", question: "Question?", grade: "invalid",
    options: [],
  })], async () => ({ ok: false, status: 503, payload: { detail: "Локальна база недоступна." } }), {
    bodyId: "page-mod-quiz-review",
  });
  await failed.ui.importButton.click();
  assert.equal(failed.ui.importStatus.textContent, "Локальна база недоступна.");
  assert.equal(failed.ui.importStatus.dataset.kind, "error");

  const timeout = setup([reviewQuestion({
    id: "question-10001-1", question: "Question?", grade: "Балів 1,00 з 1,00",
  })], async () => ({ ok: false, timeout: true }), { bodyId: "page-mod-quiz-review" });
  await timeout.ui.importButton.click();
  assert.match(timeout.ui.importStatus.textContent, /Час очікування/);
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

test("toolbar toggle hides and restores the existing panel without creating another", () => {
  const { ui, body, messageListeners } = setup([quizQuestion("Question", ["A", "B"])]);
  const dispatchToggle = () => {
    let response;
    messageListeners[0]({ type: "MOODLE_ASSISTANT_TOGGLE_FLOATING_PANEL" }, {}, (value) => { response = value; });
    return response;
  };

  assert.deepEqual(JSON.parse(JSON.stringify(dispatchToggle())), { ok: true, visible: false });
  assert.equal(ui.host.hidden, true);
  assert.deepEqual(JSON.parse(JSON.stringify(dispatchToggle())), { ok: true, visible: true });
  assert.equal(ui.host.hidden, false);
  assert.equal(ui.panel.hidden, false);
  assert.equal(body.children.length, 1);
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
    source: "ai",
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
  const freshButton = card.children[3];
  const analysisStatus = card.children[4];
  const analysisOutput = card.children[5];

  await analyzeButton.click();

  assert.deepEqual(JSON.parse(JSON.stringify(sentMessages.filter((message) => message.type === "MOODLE_ASSISTANT_ANALYZE_QUESTION"))), [{
    type: "MOODLE_ASSISTANT_ANALYZE_QUESTION",
    question: "Яка планета червона?",
    options: ["Венера", "Марс"],
    selection_mode: "single",
    force_refresh: false,
  }]);
  assert.match(analysisStatus.textContent, /Отримано нову відповідь від AI/);
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
      const status = card.children[4];
      const output = card.children[5];
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
  const { ui, scheduled } = setup([quizQuestion("Question", ["A"])], (message) => {
    if (message.type !== "MOODLE_ASSISTANT_ANALYZE_QUESTION") return Promise.resolve({ ok: false });
    calls += 1;
    return new Promise((resolve) => { resolveRequest = resolve; });
  });
  ui.readButton.click();
  scheduled.shift()();
  const analyzeButton = ui.questionList.children[0].children[2];
  const firstRequest = analyzeButton.click();

  assert.equal(analyzeButton.disabled, true);
  assert.equal(ui.questionList.children[0].children[3].disabled, true);
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
  assert.equal(ui.questionList.children[0].children[3].disabled, false);
});

test("fresh-answer control bypasses the cache and reports the backend source", async () => {
  const sentMessages = [];
  const { ui, scheduled } = setup(
    [quizQuestion("Question", ["A", "B"])],
    async (message) => {
      sentMessages.push(message);
      return {
        ok: true,
        payload: {
          suggested_answer: "A",
          explanation: "Fresh explanation.",
          confidence: 0.8,
          needs_more_context: false,
          source: "ai",
        },
      };
    },
  );
  ui.readButton.click();
  scheduled.shift()();
  const card = ui.questionList.children[0];

  await card.children[3].click();

  assert.equal(sentMessages.find((message) => message.type === "MOODLE_ASSISTANT_ANALYZE_QUESTION").force_refresh, true);
  assert.match(card.children[4].textContent, /нову відповідь від AI/);
});

test("marks prior zero-score questions and sends feedback on either fresh-answer action", async () => {
  const messages = [];
  const { ui, scheduled } = setup([quizQuestion("Question", ["Bad", "Good"])], async (message) => {
    messages.push(message);
    if (message.type === "MOODLE_ASSISTANT_GET_QUESTION_HISTORY") {
      return { ok: true, payload: { results: [{
        question_index: 0,
        had_previous_zero_score: true,
        zero_score_attempts: 1,
        excluded_options: ["Bad"],
        exclusion_note: null,
      }] } };
    }
    return { ok: true, payload: {
      suggested_answer: "Good", explanation: "Reason", confidence: 0.8,
      needs_more_context: false, source: "ai",
    } };
  });
  ui.readButton.click();
  scheduled.shift()();
  await Promise.resolve();
  await Promise.resolve();
  const card = ui.questionList.children[0];
  const warning = card.children[6];
  const retry = card.children[7];
  assert.match(card.className, /has-previous-error/);
  assert.equal(warning.hidden, false);
  assert.match(warning.textContent, /0 балів/);
  assert.equal(retry.hidden, false);

  await card.children[3].click();
  const freshRequest = messages.find((message) => message.type === "MOODLE_ASSISTANT_ANALYZE_QUESTION");
  assert.equal(freshRequest.force_refresh, true);
  assert.deepEqual(JSON.parse(JSON.stringify(freshRequest.excluded_options)), ["Bad"]);

  await retry.click();
  const request = messages.filter((message) => message.type === "MOODLE_ASSISTANT_ANALYZE_QUESTION").at(-1);
  assert.equal(request.force_refresh, true);
  assert.deepEqual(JSON.parse(JSON.stringify(request.excluded_options)), ["Bad"]);
  assert.equal(card.children[4].textContent.includes("нову відповідь"), true);
});
