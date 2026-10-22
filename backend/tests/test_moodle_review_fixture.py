"""Validate the sanitized saved-page fixture still reflects Moodle's DOM contract."""

from html.parser import HTMLParser
from pathlib import Path


FIXTURE = Path(__file__).parents[2] / "extension" / "tests" / "fixtures" / "moodle-review-sample.html"


class ReviewFixtureParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack: list[tuple[str, dict[str, str | None]]] = []
        self.body_id = None
        self.question_count = 0
        self.grade_text = []
        self.label_ids = set()
        self.checked_count = 0
        self.current_grade_depth = None

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        classes = (values.get("class") or "").split()
        if tag == "body":
            self.body_id = values.get("id")
        if tag == "div" and "que" in classes:
            self.question_count += 1
        if "grade" in classes:
            self.current_grade_depth = len(self.stack)
        if values.get("data-region") == "answer-label" and values.get("id"):
            self.label_ids.add(values["id"])
        if tag == "input" and "checked" in values:
            self.checked_count += 1
        self.stack.append((tag, values))

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                self.stack = self.stack[:index]
                break
        if self.current_grade_depth is not None and len(self.stack) <= self.current_grade_depth:
            self.current_grade_depth = None

    def handle_data(self, data):
        if self.current_grade_depth is not None:
            self.grade_text.append(data)


def test_sanitized_fixture_uses_saved_moodle_review_selectors_and_scores():
    parser = ReviewFixtureParser()
    parser.feed(FIXTURE.read_text(encoding="utf-8"))

    assert parser.body_id == "page-mod-quiz-review"
    assert parser.question_count == 2
    assert "Балів 5,00 з 5,00" in "".join(parser.grade_text)
    assert "Балів 0,50 з 1,50" in "".join(parser.grade_text)
    assert {"q1a0", "q1a1", "q2a0", "q2a1"} <= parser.label_ids
    assert parser.checked_count == 2
