"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { extractQuestions } = require("../content.js");

function element({
  tag = "div",
  classes = [],
  text = "",
  type = "",
  labels = [],
  children = [],
  visible = true,
  id = "",
  attributes = {},
} = {}) {
  const current = {
    tagName: tag.toUpperCase(),
    className: classes.join(" "),
    innerText: text,
    textContent: text,
    type,
    labels,
    id,
    getAttribute(name) { return attributes[name] ?? null; },
    children,
    getClientRects: () => visible ? [{}] : [],
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      const matches = [];
      const visit = (parent) => {
        for (const child of parent.children) {
          if (matchesSelector(child, selector)) matches.push(child);
          visit(child);
        }
      };
      visit(this);
      return matches;
    },
  };
  return current;
}

function matchesSelector(candidate, selector) {
  return selector.split(",").some((part) => {
    const clause = part.trim();
    if (clause.startsWith(".")) {
      return candidate.className.split(/\s+/).includes(clause.slice(1));
    }
    if (clause.includes('input[type="radio"]')) {
      return candidate.tagName === "INPUT" && candidate.type === "radio";
    }
    if (clause.includes('input[type="checkbox"]')) {
      return candidate.tagName === "INPUT" && candidate.type === "checkbox";
    }
    return false;
  });
}

function questionBlock(questionText, choices = [], { visible = true, hasQuestionText = true } = {}) {
  const answerChildren = [];
  for (const { type = "radio", text } of choices) {
    const label = element({ tag: "label", text });
    answerChildren.push(element({ tag: "input", type, labels: [label] }), label);
  }
  const qtext = hasQuestionText
    ? element({ classes: ["qtext"], text: questionText })
    : element({ classes: ["prompt"], text: questionText });
  return element({
    classes: ["que", "question"],
    visible,
    children: [qtext, element({ classes: ["answer"], children: answerChildren })],
  });
}

function page(...questions) {
  const root = element({ children: questions });
  function findById(parent, id) {
    for (const child of parent.children) {
      if (child.id === id) return child;
      const match = findById(child, id);
      if (match) return match;
    }
    return null;
  }
  return {
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    getElementById: (id) => findById(root, id),
  };
}

test("reads a radio question and its visible option labels", () => {
  const result = extractQuestions(page(questionBlock("Pick one", [
    { type: "radio", text: "North" },
    { type: "radio", text: "South" },
  ])));

  assert.equal(result.status, "ok");
  assert.deepEqual(result.questions[0], {
    question: "Pick one",
    options: ["North", "South"],
    hasChoiceInputs: true,
  });
  assert.equal(result.candidateCount, 1);
});

test("reads checkbox options without reading checked state or values", () => {
  const block = questionBlock("Pick all", [
    { type: "checkbox", text: "First" },
    { type: "checkbox", text: "Second" },
  ]);
  block.children[1].children[0].value = "secret-choice-value";
  block.children[1].children[0].checked = true;
  const result = extractQuestions(page(block));

  assert.deepEqual(result.questions[0].options, ["First", "Second"]);
  assert.equal("value" in result.questions[0], false);
  assert.equal("checked" in result.questions[0], false);
});

test("reads Moodle options connected through aria-labelledby instead of label elements", () => {
  const optionLabels = [
    element({ id: "answer-label-0", classes: ["d-flex", "w-auto"], text: "First real option" }),
    element({ id: "answer-label-1", classes: ["d-flex", "w-auto"], text: "Second real option" }),
  ];
  const inputs = optionLabels.map((label) => element({
    tag: "input",
    type: "radio",
    attributes: { "aria-labelledby": label.id },
  }));
  const block = element({
    classes: ["que", "multichoice"],
    children: [
      element({ classes: ["qtext"], text: "Choose one option." }),
      element({ classes: ["answer"], children: [...inputs, ...optionLabels] }),
    ],
  });

  const result = extractQuestions(page(block));

  assert.deepEqual(result.questions[0].options, ["First real option", "Second real option"]);
});

test("supports an open text question and never reads the response field", () => {
  const responseField = element({ tag: "textarea", text: "private typed response" });
  const block = element({
    classes: ["que", "essay"],
    children: [
      element({ classes: ["qtext"], text: "Explain the idea." }),
      element({ classes: ["answer"], children: [responseField] }),
    ],
  });

  assert.deepEqual(extractQuestions(page(block)).questions[0], {
    question: "Explain the idea.",
    options: [],
    hasChoiceInputs: false,
  });
});

test("reports no question when the page has no question containers", () => {
  assert.deepEqual(extractQuestions(page()), {
    status: "not-found",
    questions: [],
    candidateCount: 0,
  });
});

test("returns every supported question and does not silently choose one", () => {
  const result = extractQuestions(page(
    questionBlock("First", [{ type: "radio", text: "A" }]),
    questionBlock("Second", [{ type: "checkbox", text: "B" }]),
    questionBlock("Unsupported structure", [], { hasQuestionText: false }),
  ));

  assert.equal(result.status, "ok");
  assert.deepEqual(result.questions.map((item) => item.question), ["First", "Second"]);
  assert.equal(result.candidateCount, 3);
  assert.equal(result.unsupportedCount, 1);
});

test("ignores hidden question blocks and reports an unsupported empty structure", () => {
  assert.deepEqual(extractQuestions(page(
    questionBlock("Hidden", [{ type: "radio", text: "Invisible" }], { visible: false }),
  )), { status: "not-found", questions: [], candidateCount: 0 });

  assert.deepEqual(extractQuestions(page(
    questionBlock("No readable question", [], { hasQuestionText: false }),
  )), { status: "unsupported", questions: [], candidateCount: 1 });
});
