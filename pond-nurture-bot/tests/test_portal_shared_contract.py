"""Parent-owned shared fixture and synthetic execution-confirmed regressions."""
import ast
import copy
import datetime as dt
import hashlib
import json
from pathlib import Path
import types

import pytest

from fub_automation import portal
from portal_history_fakes import complete_history
from test_portal_email_gate import PATHS, PID, invoke, sending  # noqa: F401

ROOT = Path(__file__).resolve().parents[1]
MATRIX = json.loads((ROOT / "tests/fixtures/portal_provenance.json").read_text())


def test_shared_matrix_cardinality():
    assert len(MATRIX) == 137


@pytest.mark.parametrize("case", MATRIX, ids=lambda case: case["name"])
def test_shared_provenance_matcher_matrix(case):
    assert portal.has_portal_provenance(case["record"]) is case["portal"]
    assert portal.provenance_metadata_usable(case["record"]) is case["metadataUsable"]


@pytest.mark.parametrize("case", MATRIX, ids=lambda case: case["name"])
@pytest.mark.parametrize("surface", ["fresh", "already_loaded"])
def test_shared_provenance_gate_matrix(case, surface):
    # Fixture records describe provenance, not fresh-person identity. An unrelated
    # webhook snapshot may have its own id; it cannot overwrite this scaffold.
    fresh = {"source": "Website", **case["record"], "id": 900001}
    loaded = None
    if surface == "already_loaded":
        loaded = case["record"]
        fresh = {"id": 900001, "source": "Website"}
    verdict = portal.portal_email_gate(900001, lambda _: fresh, loaded, event_page_loader=complete_history)
    assert verdict.allowed is (not case["portal"] and case["metadataUsable"])
    assert verdict.reason == (portal.PORTAL_EXCLUDED if case["portal"] else
                              portal.PORTAL_FRESH_UNAVAILABLE if not case["metadataUsable"] else None)


class UnreadableSource(dict):
    def __contains__(self, key):
        raise RuntimeError("synthetic unreadable metadata")


class IrrelevantFieldsMustNeverBeRead(dict):
    def __getitem__(self, key):
        if key in {"name", "notes", "emails", "body", "text", "subject", "data", "sourceId"}:
            raise AssertionError("irrelevant customer field inspected")
        return super().__getitem__(key)


@pytest.mark.parametrize("field", ["originalSource", "eventSource", "original", "event",
                                   "originalProvenance", "eventProvenance"])
@pytest.mark.parametrize("surface", ["fresh", "already_loaded"])
def test_unreadable_explicit_metadata_defers_and_other_portal_wins(field, surface):
    bad = {"source": "Website", field: UnreadableSource(name="Zillow", source="Zillow")}
    current = {"id": PID, **bad} if surface == "fresh" else {"id": PID, "source": "Website"}
    loaded = bad if surface == "already_loaded" else None
    assert portal.portal_email_gate(PID, lambda _: current, loaded).reason == portal.PORTAL_FRESH_UNAVAILABLE
    current["leadSource"] = "Zillow"
    assert portal.portal_email_gate(PID, lambda _: current, loaded).reason == portal.PORTAL_EXCLUDED


def test_customer_name_and_communication_fields_are_never_inspected():
    record = IrrelevantFieldsMustNeverBeRead(id=PID, source="Website", name="Zillow",
                                           notes={"source": "Zillow"}, emails="Zillow", text="Zillow")
    assert portal.portal_email_gate(PID, lambda _: record, event_page_loader=complete_history).allowed
    assert not portal.has_portal_provenance(record)


@pytest.mark.parametrize("loaded", [42, True])
def test_explicit_loaded_wrong_shape_defers(loaded):
    assert portal.portal_email_gate(PID, lambda _: {"id": PID, "source": "Website"}, loaded).reason == portal.PORTAL_FRESH_UNAVAILABLE


@pytest.mark.parametrize("loaded", [{}, {"unknown": "Zillow"}, [{"unknown": "Zillow"}]])
def test_unrelated_top_level_loaded_snapshots_are_absent(loaded):
    assert portal.portal_email_gate(PID, lambda _: {"id": PID, "source": "Website"}, loaded, event_page_loader=complete_history).allowed


def sent_state(engine):
    """Exact persistent delivery/cadence/claim/counter state, not just audit totals."""
    tables = ("reengagement_log", "closed_drip_log", "congrats_log", "long_term_nurture_drip",
              "email_angle_log", "seller_nurture_drip", "seller_send_claims", "recruiting_drip",
              "recruiting_send_claims", "new_lead_timers", "assignment_watch", "seller_bounced_emails")
    with engine.db.connect() as con:
        return {table: [tuple(row) for row in con.execute(f'SELECT * FROM "{table}" ORDER BY 1')]
                for table in tables}


def prepare_sent_state(engine):
    # Existing enrollment is allowed; neither refusal nor a missing address may
    # mutate its sent timestamp/count/angle or retain a delivery claim.
    engine.db.enroll_seller_nurture(PID, "", "")
    engine.db.enroll_recruit(PID, "New Agent Inquiry", dt.datetime.now(dt.timezone.utc).isoformat())
    return sent_state(engine)


def assert_no_delivery(engine, calls, before):
    assert calls["send"] == 0
    assert calls["note"] == 0
    assert sent_state(engine) == before
    with engine.db.connect() as con:
        assert con.execute("SELECT COUNT(*) FROM audit_log WHERE status IN ('sent','dry_run_sent','email_sent','sms_sent')").fetchone()[0] == 0


@pytest.mark.parametrize("path", PATHS)
def regression_a_trailing_dot_blocks_final_sender(sending, monkeypatch, path):
    engine, calls, current = sending
    before = prepare_sent_state(engine)
    initial = {"id": PID, "source": "Website", "emails": [{"value": "synthetic@example.invalid"}], "tags": []}
    fresh = {"id": PID, "source": "Website", "sourceUrl": "https://zillow.com./lead"}
    if path == "welcome":
        values = iter([initial, fresh])
        monkeypatch.setattr(engine.fub, "get_person", lambda _: next(values))
        monkeypatch.setattr(engine.db, "recent_audit_rows", lambda *a: [])
    else:
        current["value"] = fresh
    assert invoke(engine, path) == "suppressed"
    assert_no_delivery(engine, calls, before)


# Pytest's default collection requires the `test_` prefix while preserving the
# user-required regression name in the callable and execution node ID.
test_regression_a_trailing_dot_blocks_final_sender = regression_a_trailing_dot_blocks_final_sender


def test_regression_b_local_realtor_committee_is_nonportal(engine, m, tmp_path):
    record = {"id": PID, "source": "Local Realtor Committee", "tags": []}
    assert not portal.has_portal_provenance(record)
    assert not portal.portal_tag(record["source"])
    assert portal.portal_email_gate(PID, lambda _: record, event_page_loader=complete_history).allowed
    for case in ("missing", "malformed", "empty"):
        (tmp_path / "rules.yaml").write_text("{}\n")
        config = tmp_path / "suppression_tags.json"
        if config.exists():
            config.unlink()
        if case == "malformed":
            config.write_text("{invalid")
        elif case == "empty":
            config.write_text("{}")
        engine.rules = m.Rules.load(str(tmp_path / "rules.yaml"))
        assert not engine.is_excluded(record)
        assert engine._is_excluded_source(record) is None
        assert engine._never_a_lead_email(record) is None
        assert not engine.is_excluded(record, portal_exclusion=False)


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("surface", ["fresh", "already_loaded"])
@pytest.mark.parametrize("evidence,expected", [
    ({"originalSource": {"name": "Zillow"}}, "suppressed"),
    ({"eventSource": {"name": "Realtor.com"}}, "suppressed"),
    ({"originalSource": 42}, "deferred"),
    ({"eventSource": {"unknown": "Zillow"}}, "deferred"),
    ({"original": {"eventProvenance": {"source": []}}}, "deferred"),
    ({"provenance": [42]}, "deferred"),
])
def test_seven_paths_exact_refusal_side_effects(sending, monkeypatch, path, surface, evidence, expected):
    engine, calls, current = sending
    before = prepare_sent_state(engine)
    initial = {"id": PID, "source": "Website", "emails": [{"value": "synthetic@example.invalid"}], "tags": []}
    fresh = {"id": PID, "source": "Website", **(evidence if surface == "fresh" else {})}
    if path == "welcome":
        values = iter([initial, fresh])
        monkeypatch.setattr(engine.fub, "get_person", lambda _: next(values))
        monkeypatch.setattr(engine.db, "recent_audit_rows", lambda *a: [])
    else:
        current["value"] = fresh
    assert invoke(engine, path, evidence if surface == "already_loaded" else {}) == expected
    assert_no_delivery(engine, calls, before)


_BASE = "552c0c510aba1534aaf869ba5f17f39aba954ded"
# Exact bytes of pond-nurture-bot/src/fub_automation/main.py at _BASE, pinned by
# SHA-256. CI checks out a single commit, so the base revision is not available
# through git there; the pinned snapshot keeps the comparison identical.
_BASE_FIXTURE = Path(__file__).resolve().parent / "fixtures" / "base_main_552c0c5.py.txt"
_BASE_SHA256 = "39b7d0fcb79f9211c823e1cc95b64e1a35a1ece33b2ce40af37ccb37b5652936"
_BASE_SOURCE = None


@pytest.fixture(autouse=True)
def count_synthetic_smtp_attempts(m, monkeypatch):
    attempts = []
    def forbidden_smtp(*args, **kwargs):
        attempts.append(True)
        raise AssertionError("synthetic SMTP boundary unexpectedly reached")
    monkeypatch.setattr(m.smtplib, "SMTP", forbidden_smtp)
    yield attempts
    assert attempts == []


def base_methods(m):
    global _BASE_SOURCE
    if _BASE_SOURCE is None:
        raw = _BASE_FIXTURE.read_bytes()
        assert hashlib.sha256(raw).hexdigest() == _BASE_SHA256, "base snapshot does not match pinned SHA-256"
        _BASE_SOURCE = raw.decode("utf-8")
    tree = ast.parse(_BASE_SOURCE)
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "RuleEngine")
    wanted = {"process_congrats_candidate", "process_closed_drip_candidate", "process_long_term_nurture_candidate",
              "process_seller_nurture_candidate", "process_reengagement_candidate", "send_instant_welcome_email",
              "_send_recruiting_email"}
    nodes = [n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name in wanted]
    namespace = dict(vars(m))
    # Execute only extracted method definitions, never BASE app startup, network
    # setup, scheduler, or module entry points. Existing synthetic engine mocks
    # supply every dependency at execution time.
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "synthetic_base_methods", "exec"), namespace)
    return {name: namespace[name] for name in wanted}


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("emails", [[], None, [{"value": ""}]])
@pytest.mark.parametrize("revision", ["base", "current"])
def test_python_no_email_paths_skip_without_sent_bookkeeping(sending, m, monkeypatch, path, emails, revision):
    engine, calls, current = sending
    before = prepare_sent_state(engine)
    if revision == "base":
        for name, method in base_methods(m).items():
            monkeypatch.setattr(engine, name, types.MethodType(method, engine))
    current["emails"] = emails
    monkeypatch.setattr(engine.db, "recent_audit_rows", lambda *a: [])
    if revision == "base" and path == "welcome":
        result = engine.send_instant_welcome_email(PID)
    else:
        result = invoke(engine, path, {"emails": emails})
    assert result in {"skipped", "suppressed"}
    assert calls["history"] == 0
    assert_no_delivery(engine, calls, before)


def test_regression_c_missing_contact_identity_never_silently_bypasses_python_gate(sending):
    engine, calls, current = sending
    before = prepare_sent_state(engine)
    decision = engine._send_contact_email(None, {"source": "Website"}, "synthetic", "synthetic", "synthetic")
    assert decision.reason == portal.PORTAL_PERSON_ID_UNUSABLE
    assert calls["fresh"] == 0
    assert_no_delivery(engine, calls, before)


@pytest.mark.parametrize("config", [None, "", "{invalid", "{}", "[]", "null",
                                   '{"tags": [], "excluded_sources": []}',
                                   '{"tags": "zillow", "excluded_sources": "zillow"}',
                                   '{"tags": [42], "excluded_sources": [42]}'])
def test_missing_malformed_empty_json_fallback_has_no_portal_or_unrelated_list_drift(m, tmp_path, config):
    path = tmp_path / "rules.yaml"
    path.write_text("{}\n")
    if config is not None:
        (tmp_path / "suppression_tags.json").write_text(config)
    fallback = m.Rules.load(str(path))
    shared = json.loads((ROOT / "config/suppression_tags.json").read_text())
    assert set(fallback.excluded_tags) == {t.lower() for t in shared["tags"]} | {"past client", "closed"}
    assert set(fallback.excluded_sources) == {s.lower() for s in shared["excluded_sources"]}
    assert set(portal.PORTAL_TAGS) == set(shared["portal_source_names"])
    assert portal.portal_url("https://zillow.com./lead")
    assert not portal.portal_source("Local Realtor Committee")


@pytest.mark.parametrize("queue_kind", ["first", "due"])
@pytest.mark.parametrize("fresh", [{"id": PID, "source": "Zillow"},
                                   {"id": PID, "source": "New Agent Inquiry", "eventSource": 42},
                                   {"id": PID, "tags": []}])
def test_recruiting_queued_refusal_preserves_sent_count_cap_and_retry(sending, monkeypatch, queue_kind, fresh):
    engine, calls, current = sending
    now = dt.datetime.now(dt.timezone.utc)
    initial = {"id": PID, "source": "New Agent Inquiry", "created": now.isoformat(), "tags": [],
               "emails": [{"value": "synthetic@example.invalid"}]}
    engine.db.enroll_recruit(PID, "New Agent Inquiry", (now - dt.timedelta(days=31)).isoformat())
    before = sent_state(engine)
    monkeypatch.setattr(engine.fub, "get_people", lambda **kw: [initial] if queue_kind == "first" else [])
    if queue_kind == "due":
        values = iter([initial, fresh])
        monkeypatch.setattr(engine.fub, "get_person", lambda _: next(values))
    else:
        current["value"] = fresh
    counts = engine.scan_recruiting_track(now)
    assert counts["sent"] == 0 and counts["capped"] == 0 and counts["errors"] == 0
    assert counts[queue_kind] == 1
    assert_no_delivery(engine, calls, before)
    assert engine.db.count_recruiting_sends_since((now - dt.timedelta(days=1)).isoformat()) == 0
    current["value"] = {"id": PID, "source": "New Agent Inquiry"}
    monkeypatch.setattr(engine.fub, "get_person", lambda _: current["value"])
    assert engine._send_recruiting_email(initial, engine.db.recruiting_enrollments()[PID], now) == "dry_run_sent"
    assert calls["send"] == 1


@pytest.mark.parametrize("source", ["Zillow", "Realtor.com", "Zillow Rentals - Austin",
                                    "New Agent Inquiry - channel", "Website", "Local Realtor Committee"])
@pytest.mark.parametrize("tag", [None, "zillow", "realtor dot com", "unsubscribe", "agent", "bounced"])
def test_nonemail_generic_exclusions_are_exact_base(engine, m, source, tag):
    base_methods(m)  # Source-only extraction; no BASE module execution.
    old_tree = ast.parse(_BASE_SOURCE)
    cls = next(n for n in old_tree.body if isinstance(n, ast.ClassDef) and n.name == "RuleEngine")
    wanted = {"is_excluded", "_is_excluded_source", "recruiting_suppressed"}
    nodes = [n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name in wanted]
    namespace = dict(vars(m))
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "synthetic_base_exclusions", "exec"), namespace)
    old_engine = copy.copy(engine)
    old_engine.rules = copy.copy(engine.rules)
    old_engine.rules.excluded_tags = [t for t in engine.rules.excluded_tags if t not in portal.PORTAL_TAGS]
    old_engine.rules.excluded_sources = [s for s in engine.rules.excluded_sources if s not in portal.PORTAL_TAGS]
    for name in wanted:
        setattr(old_engine, name, types.MethodType(namespace[name], old_engine))
    record = {"id": PID, "source": source, "stage": "Lead", "tags": [tag] if tag else []}
    for name in wanted:
        assert getattr(engine, name)(record, portal_exclusion=False) == getattr(old_engine, name)(record)


def test_inbound_bounce_and_staff_transport_functions_are_exact_base(m):
    base_methods(m)
    old_tree = ast.parse(_BASE_SOURCE)
    current_tree = ast.parse((ROOT / "src/fub_automation/main.py").read_text())
    names = {"send", "has_any_tag", "_is_soi_silenced", "handle_seller_bounce",
             "_check_incoming_opt_out", "_send_speed_to_lead_agent_alert", "reassign_to_peter", "_handle_human_reply"}
    before = {n.name: ast.dump(n) for n in ast.walk(old_tree) if isinstance(n, ast.FunctionDef) and n.name in names}
    after = {n.name: ast.dump(n) for n in ast.walk(current_tree) if isinstance(n, ast.FunctionDef) and n.name in names}
    assert set(before) == names
    assert after == before


def test_crosssystem_portal_fields_are_exact_parent_shared_json():
    # Read-only static seam checks are authorized; sibling applications are
    # never imported, executed or edited by this Python test.
    paths = [ROOT.parent / runtime / "config/suppression_tags.json"
             for runtime in ("pond-nurture-bot", "lifestyle-bot-dashboard", "nurture-dashboard")]
    loaded = [json.loads(path.read_text()) for path in paths]
    for config in loaded:
        assert config == loaded[0]
        assert set(config["portal_source_names"]) == set(portal.PORTAL_TAGS)
        assert set(config["portal_source_hosts"]) == {"zillow.com", "realtor.com"}
