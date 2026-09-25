"""Cost fix 5: the model is pinned in code, JSON replies are enforced by
schema, and every run reports its token use by call type.

- The LLM_MODEL GitHub secret used to pick the model. Its value cannot be read
  back, so nobody could say which model ran (the README said Sonnet 4.6; the
  code default and the response times said Haiku 4.5).
- 30 pond drafts failed json.loads in 14 days (trailing prose, broken quotes),
  each wasting three calls and delaying that lead's email a day.
- No run recorded what it spent, so a cost change could not be measured.
"""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent


class FakeMessages:
    """Records every messages.create call and answers with canned text + usage."""

    def __init__(self, text='{"should_skip": false, "intent_category": "none", "confidence": 5, '
                            '"evidence": "", "reason": "normal activity"}',
                 usage=(1000, 50, 0, 0)):
        self.calls = []
        self.text = text
        self.usage = usage

    def create(self, **kwargs):
        self.calls.append(kwargs)
        i, o, cr, cw = self.usage
        return SimpleNamespace(
            content=[SimpleNamespace(text=self.text)],
            usage=SimpleNamespace(input_tokens=i, output_tokens=o,
                                  cache_read_input_tokens=cr, cache_creation_input_tokens=cw),
        )


@pytest.fixture()
def gen(m, settings, rules):
    g = m.ContentGenerator(settings, rules)
    g.client = SimpleNamespace(messages=FakeMessages())
    return g


# ── The model is pinned in code ──────────────────────────────────────────────


def test_the_model_is_pinned_in_code_whatever_the_environment_says(m, settings, rules, monkeypatch):
    monkeypatch.setenv("LLM_MODEL", "claude-sonnet-4-6")
    monkeypatch.setenv("OPENAI_MODEL", "claude-opus-4-1")
    assert m.LLM_MODEL_ID == "claude-haiku-4-5-20251001"
    assert m.ContentGenerator(settings, rules).model == m.LLM_MODEL_ID
    assert m.Settings.from_env().openai_model == m.LLM_MODEL_ID


def test_every_call_sends_the_pinned_model(gen, m):
    gen.should_skip_lead_llm({"id": 1}, [{"body": "Called, she is still looking in Stone Oak"}])
    assert gen.client.messages.calls[0]["model"] == m.LLM_MODEL_ID


def test_no_workflow_passes_the_old_model_secret():
    for wf in (REPO / ".github" / "workflows").glob("*.yml"):
        assert "LLM_MODEL" not in wf.read_text(), f"{wf.name} still passes the LLM_MODEL secret"


# ── JSON replies are enforced by schema ──────────────────────────────────────


def _schema_of(call):
    return call.get("output_config", {}).get("format", {}).get("schema")


def test_the_skip_check_asks_for_its_schema(gen, m):
    gen.should_skip_lead_llm({"id": 1}, [{"body": "Called, she is still looking in Stone Oak"}])
    call = gen.client.messages.calls[0]
    assert call["output_config"]["format"]["type"] == "json_schema"
    assert _schema_of(call) == m.SKIP_CHECK_SCHEMA
    assert set(m.SKIP_CHECK_SCHEMA["required"]) >= {"should_skip", "intent_category", "confidence", "evidence"}


@pytest.mark.parametrize("method,args,purpose", [
    ("generate", ({"id": 7, "firstName": "Pat"}, "San Antonio", ""), "pond_draft"),
    ("generate_closed_drip_email", ({"id": 7, "firstName": "Pat"}, "1 Oak St", None, []), "closed_drip_draft"),
    ("generate_congrats_email", ({"id": 7, "firstName": "Pat"}, "1 Oak St"), "congrats_draft"),
    ("generate_welcome_email", ({"id": 7, "firstName": "Pat"}, "Austin"), "welcome_draft"),
    ("generate_long_term_nurture_email", ({"id": 7, "firstName": "Pat"}, 0, "", ""), "long_term_draft"),
])
def test_every_email_draft_asks_for_the_draft_schema(gen, m, method, args, purpose):
    gen.client.messages.text = '{"subject": "Hi Pat", "email_body": "Hello there"}'
    out = getattr(gen, method)(*args)
    assert out["subject"] == "Hi Pat"
    call = gen.client.messages.calls[0]
    assert _schema_of(call) == m.EMAIL_DRAFT_SCHEMA
    assert gen.usage[purpose]["calls"] == 1


def test_reply_intent_and_email_change_ask_for_their_schemas(gen, m):
    gen.client.messages.text = json.dumps({"intent": "none", "confidence": 10, "reason": "hi",
                                           "trigger_snippet": "", "source": "none"})
    gen.classify_lead_intent({"id": 1, "firstName": "Pat"},
                             [{"message": "hello?", "isIncoming": True}], [], [])
    assert _schema_of(gen.client.messages.calls[-1]) == m.REPLY_INTENT_SCHEMA
    gen.client.messages.text = json.dumps({"changed": False, "new_email": "", "confidence": 0,
                                           "reason": "none", "trigger_snippet": ""})
    gen.detect_email_change({"id": 1}, [{"isIncoming": True, "body": "Thanks for the info!"}])
    assert _schema_of(gen.client.messages.calls[-1]) == m.EMAIL_CHANGE_SCHEMA


def test_the_timeline_check_keeps_its_text_format_but_is_counted(gen):
    gen.client.messages.text = "NO_WINDOW"
    assert gen.extract_purchase_window({"id": 1}, [{"body": "Lease ends in August", "created": "2026-03-01"}]) is None
    assert "output_config" not in gen.client.messages.calls[0]
    assert gen.usage["timeline"]["calls"] == 1


@pytest.mark.parametrize("name", ["SKIP_CHECK_SCHEMA", "EMAIL_DRAFT_SCHEMA",
                                  "REPLY_INTENT_SCHEMA", "EMAIL_CHANGE_SCHEMA"])
def test_schemas_use_only_what_structured_outputs_accept(m, name):
    schema = getattr(m, name)
    assert schema["type"] == "object" and schema["additionalProperties"] is False
    assert set(schema["required"]) == set(schema["properties"]), "every property required"
    text = json.dumps(schema)
    for unsupported in ("minimum", "maximum", "minLength", "maxLength", "multipleOf"):
        assert unsupported not in text


def test_the_seller_draft_goes_through_the_draft_schema(engine, m, monkeypatch):
    """seller_nurture.py keeps its plain llm_call_fn(messages, temperature)
    contract; main.py binds the schema and the call type onto it."""
    fake = FakeMessages(text='{"subject": "Your home", "email_body": "Hey Sam, quick question."}')
    engine.content.client = SimpleNamespace(messages=fake)
    monkeypatch.setattr(engine, "safe_get_notes", lambda pid: [])
    monkeypatch.setattr(engine, "safe_get_notes_deep", lambda pid: [])
    monkeypatch.setattr(engine.email, "send", lambda *a, **k: None)
    monkeypatch.setattr(engine.fub, "add_note", lambda *a, **k: None)
    seller = {"id": 778, "firstName": "Sam", "tags": [{"name": "Seller Lead"}],
              "source": "Seller Finder", "emails": [{"value": "sam@example.com"}]}
    assert engine.process_seller_nurture_candidate(seller) == "dry_run_sent"
    assert _schema_of(fake.calls[-1]) == m.EMAIL_DRAFT_SCHEMA
    assert engine.content.usage["seller_draft"]["calls"] == 1


# ── Every run reports its token use by call type ─────────────────────────────


def test_usage_is_tallied_per_call_type_with_list_price_cost(gen):
    gen.client.messages.usage = (3000, 100, 0, 0)
    gen.should_skip_lead_llm({"id": 1}, [{"body": "Still looking in Stone Oak"}])
    gen.should_skip_lead_llm({"id": 2}, [{"body": "Pre-approved, touring in May"}])
    gen.client.messages.text = '{"subject": "Hi", "email_body": "Hello"}'
    gen.client.messages.usage = (4000, 300, 0, 0)
    gen.generate({"id": 7, "firstName": "Pat"}, "Austin", "")
    summary = gen.usage_summary()
    skip = summary["by_type"]["skip_check"]
    assert (skip["calls"], skip["input_tokens"], skip["output_tokens"]) == (2, 6000, 200)
    assert skip["est_usd"] == pytest.approx(6000 * 1e-6 + 200 * 5e-6)
    assert summary["by_type"]["pond_draft"]["calls"] == 1
    assert summary["totals"]["calls"] == 3
    assert summary["totals"]["est_usd"] == pytest.approx(0.007 + 0.0055)
    assert summary["model"] == "claude-haiku-4-5-20251001"


def test_cache_tokens_are_priced_at_their_own_rates(gen):
    gen.client.messages.usage = (100, 10, 4000, 5000)
    gen.should_skip_lead_llm({"id": 1}, [{"body": "Still looking"}])
    est = gen.usage_summary()["by_type"]["skip_check"]["est_usd"]
    assert est == pytest.approx(100e-6 + 10 * 5e-6 + 4000 * 0.10e-6 + 5000 * 1.25e-6, abs=1e-4)


def test_a_run_logs_its_usage_and_keeps_an_audit_row(engine, tmp_db):
    import datetime as dt

    engine.content.client = SimpleNamespace(messages=FakeMessages())
    engine.content.should_skip_lead_llm({"id": 1}, [{"body": "Still looking"}])
    summary = engine.log_llm_usage()
    assert summary["totals"]["calls"] == 1
    rows = tmp_db.recent_audit_rows(["llm_usage"], dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=1))
    assert rows and json.loads(rows[0]["details"])["by_type"]["skip_check"]["calls"] == 1


def test_a_run_with_no_calls_writes_no_usage_row(engine, tmp_db):
    import datetime as dt

    engine.log_llm_usage()
    assert tmp_db.recent_audit_rows(["llm_usage"], dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=1)) == []


def test_both_daily_entrypoints_report_usage(m):
    import inspect

    assert "self.log_llm_usage()" in inspect.getsource(m.RuleEngine.run_daily_scans)
    runner = (ROOT / "run_approved_daily_automation.py").read_text()
    assert "engine.log_llm_usage()" in runner
    assert runner.index("engine.log_llm_usage()") > runner.index("engine.scan_wide_reply_sweep()"), (
        "the summary must come after the last scan that can call the model"
    )
