"""Tests for persistent usage totals, pricing, and safe missing-data handling."""

import json
import sqlite3
from types import SimpleNamespace
from datetime import datetime

from app.services import usage_store


def set_pricing(monkeypatch, tmp_path, models):
    path = tmp_path / "pricing.json"
    path.write_text(json.dumps({"models": models}), encoding="utf-8")
    monkeypatch.setattr(usage_store, "PRICING_PATH", path)


def response(response_id="resp-1", model="priced-model", input_tokens=100, output_tokens=20, cached=0):
    return SimpleNamespace(
        id=response_id,
        model=model,
        usage=SimpleNamespace(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=input_tokens + output_tokens,
            input_tokens_details=SimpleNamespace(cached_tokens=cached),
        ),
    )


def configure_db(monkeypatch, tmp_path):
    monkeypatch.setenv("MOODLE_ASSISTANT_DATA_DIR", str(tmp_path / "app-data"))
    monkeypatch.setattr(usage_store, "SESSION_ID", "session-A")


def test_records_actual_usage_and_cost_with_cached_input_without_double_counting(monkeypatch, local_tmp_path):
    configure_db(monkeypatch, local_tmp_path)
    set_pricing(monkeypatch, local_tmp_path, {
        "priced-model": {
            "input_per_million_usd": 1,
            "cached_input_per_million_usd": 0.1,
            "output_per_million_usd": 2,
        }
    })

    assert usage_store.record_response_usage(response(input_tokens=100, output_tokens=20, cached=40))
    stats = usage_store.get_statistics("priced-model")
    assert stats["session"] == stats["all_time"]
    assert stats["all_time"] == {
        "input_tokens": 100,
        "output_tokens": 20,
        "total_tokens": 120,
        "request_count": 1,
        "estimated_cost_usd": 0.000104,
    }
    with sqlite3.connect(usage_store.database_path()) as connection:
        stored = connection.execute(
            "SELECT occurred_at, model, provider_response_id FROM usage_records"
        ).fetchone()
    assert datetime.fromisoformat(stored[0]).utcoffset().total_seconds() == 0
    assert stored[1:] == ("priced-model", "resp-1")


def test_missing_or_invalid_usage_does_not_create_a_zero_record(monkeypatch, local_tmp_path):
    configure_db(monkeypatch, local_tmp_path)
    missing = SimpleNamespace(id="resp-no-usage", model="priced-model", usage=None)
    invalid = response(input_tokens=-1)

    assert not usage_store.record_response_usage(missing)
    assert not usage_store.record_response_usage(invalid)
    assert usage_store.get_statistics("priced-model")["all_time"]["request_count"] == 0


def test_statistics_survive_reinitialization_and_are_split_by_process_session(monkeypatch, local_tmp_path):
    configure_db(monkeypatch, local_tmp_path)
    set_pricing(monkeypatch, local_tmp_path, {})
    usage_store.record_response_usage(response(response_id="resp-A", input_tokens=7, output_tokens=3))

    usage_store.init_db()
    monkeypatch.setattr(usage_store, "SESSION_ID", "session-B")
    stats = usage_store.get_statistics("priced-model")

    assert stats["session"]["request_count"] == 0
    assert stats["all_time"]["input_tokens"] == 7
    assert stats["all_time"]["output_tokens"] == 3
    assert stats["all_time"]["request_count"] == 1
    assert stats["all_time"]["estimated_cost_usd"] is None


def test_provider_response_id_prevents_duplicate_accounting(monkeypatch, local_tmp_path):
    configure_db(monkeypatch, local_tmp_path)
    set_pricing(monkeypatch, local_tmp_path, {})
    provider_response = response(response_id="same-id")

    assert usage_store.record_response_usage(provider_response)
    assert not usage_store.record_response_usage(provider_response)
    assert usage_store.get_statistics("priced-model")["all_time"]["request_count"] == 1


def test_unknown_model_price_is_unknown_and_configured_price_uses_token_counts(monkeypatch, local_tmp_path):
    set_pricing(monkeypatch, local_tmp_path, {
        "priced-model": {"input_per_million_usd": 1.5, "output_per_million_usd": 3.0}
    })

    assert usage_store.estimate_cost_usd("unpriced", 1000, 1000) is None
    assert usage_store.estimate_cost_usd("priced-model", 1_000_000, 2_000_000) == 7.5
