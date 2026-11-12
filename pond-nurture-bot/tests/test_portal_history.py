"""Candidate 4: synthetic own-history and native-only final-email refusals."""
import copy
import datetime as dt
import json

import pytest

from fub_automation import portal
from portal_history_fakes import complete_history
from test_portal_email_gate import PATHS, PID, invoke, sending  # noqa: F401
from test_portal_shared_contract import assert_no_delivery, prepare_sent_state, sent_state


def event(event_id=1, *, person_id=PID, source="Website Form", **extra):
    return {"id": event_id, "personId": person_id, "source": source, **extra}


def page(events=(), total=None, **metadata):
    return {"events": list(events), "_metadata": {
        "collection": "events", "total": len(events) if total is None else total, **metadata,
    }}


def scan(pages):
    requests = []
    values = iter(pages)
    def load(pid, **kwargs):
        requests.append({"personId": pid, "limit": 100, **kwargs})
        result = next(values)
        if isinstance(result, Exception):
            raise result
        return result
    return portal.scan_portal_event_history(PID, load), requests


def full(start=1, source="Website Form"):
    return [event(i, source=source) for i in range(start, start + 100)]


@pytest.mark.parametrize("record", [
    {"source": "Website Form", "isZillowPACLead": True},
    {"source": [], "isZillowPACLead": True},
    {"source": "Website Form", "original": {"isZillowPACLead": True}},
    {"source": "Website Form", "originalProvenance": {"isZillowPACLead": True}},
    {"source": "Website Form", "provenance": [{"isZillowPACLead": True}]},
])
def test_native_true_is_person_provenance_portal(record):
    assert portal.has_portal_provenance(record)
    requests = []
    result = portal.portal_email_gate(PID, lambda _: {"id": PID, **record},
                                      event_page_loader=lambda *a, **k: requests.append(True))
    assert result.reason == portal.PORTAL_EXCLUDED and not requests


@pytest.mark.parametrize("value", [False, None, "absent"])
def test_native_false_null_absent_requires_complete_history(value):
    record = {"id": PID, "source": "Website Form"}
    if value != "absent":
        record["isZillowPACLead"] = value
    assert portal.portal_email_gate(PID, lambda _: record,
                                   event_page_loader=complete_history).allowed
    assert portal.portal_email_gate(PID, lambda _: record).reason == portal.PORTAL_HISTORY_UNAVAILABLE


@pytest.mark.parametrize("value", ["true", "false", 0, 1, [], {}, [True]])
def test_native_malformed_defers_without_history_but_other_portal_wins(value):
    record = {"id": PID, "source": "Website Form", "isZillowPACLead": value}
    calls = []
    result = portal.portal_email_gate(PID, lambda _: record,
                                      event_page_loader=lambda *a, **k: calls.append(True))
    assert result.reason == portal.PORTAL_FRESH_UNAVAILABLE and calls == []
    record["originalSource"] = "Zillow"
    assert portal.portal_email_gate(PID, lambda _: record).reason == portal.PORTAL_EXCLUDED


class NativeThrows(dict):
    def __getitem__(self, key):
        if key == "isZillowPACLead":
            raise RuntimeError("synthetic inaccessible native")
        return super().__getitem__(key)


class Unreadable(dict):
    def __contains__(self, key):
        raise RuntimeError("synthetic inaccessible record")


def test_native_throwing_and_unreadable_records_fail_closed_portal_siblings_win():
    record = NativeThrows(id=PID, source="Website Form", isZillowPACLead=True)
    assert portal.portal_email_gate(PID, lambda _: record).reason == portal.PORTAL_FRESH_UNAVAILABLE
    record["source"] = "Zillow"
    assert portal.portal_email_gate(PID, lambda _: record).reason == portal.PORTAL_EXCLUDED
    loaded = (Unreadable(isZillowPACLead=True), {"isZillowPACLead": True})
    assert portal.portal_email_gate(PID, lambda _: {"id": PID, "source": "Website"}, loaded).reason == portal.PORTAL_EXCLUDED


@pytest.mark.parametrize("field", ["originalSource", "eventSource"])
def test_source_object_aliases_do_not_accept_native_field(field):
    record = {field: {"isZillowPACLead": True}}
    assert not portal.has_portal_provenance(record)
    assert not portal.provenance_metadata_usable(record)
    record[field]["name"] = "Website Form"
    assert portal.provenance_metadata_usable(record)


@pytest.mark.parametrize("pages", [
    [page()], [page([event(source=None)])], [page([event(source=" ")])],
    [page(full(), total=100)],
    [page([event()], total=2, next="cursor-A"), page([event(2)], total=2)],
    [page(full(), total=101), page([event(101)], total=101)],
    [page(full(i), total=500) for i in (1, 101, 201, 301, 401)],
])
def test_complete_api_accessible_history_authorizes(pages):
    result, requests = scan(pages)
    assert result.allowed and result.reason is None
    assert result.pages == len(pages) and len(requests) == len(pages)
    assert all(r["personId"] == PID and r["limit"] == 100 for r in requests)
    if len(pages) > 1 and len(pages[0]["events"]) == 100:
        assert requests[1]["offset"] == 100 and requests[1]["next_cursor"] is None


def test_next_cursor_precedes_next_link_and_offset():
    result, requests = scan([
        page(full(), total=101, next="cursor-A", nextLink="https://evil.invalid/"),
        page([event(101)], total=101),
    ])
    assert result.allowed
    assert requests[1]["next_cursor"] == "cursor-A" and requests[1]["offset"] is None


@pytest.mark.parametrize("prefix", ["", "limit=100&"])
def test_next_link_is_validated_and_only_cursor_is_followed(prefix):
    link = f"https://api.followupboss.com/v1/events?personId={PID}&{prefix}next=cursor%2BA"
    result, requests = scan([page([event()], total=2, nextLink=link), page([event(2)], total=2)])
    assert result.allowed and requests[1]["next_cursor"] == "cursor+A"
    assert set(requests[1]) == {"personId", "limit", "next_cursor", "offset"}


@pytest.mark.parametrize("primary", [None, "", " \t"])
@pytest.mark.parametrize("terminal", [False, True])
def test_null_or_blank_primary_next_keeps_scoped_link_fallback_and_terminal_contradiction(primary, terminal):
    link = f"https://api.followupboss.com/v1/events?personId={PID}&limit=100&next=cursor%2BA"
    total = 1 if terminal else 2
    result, requests = scan([page([event()], total=total, next=primary, nextLink=link),
                             page([event(2)], total=2)])
    assert result.allowed is (not terminal)
    assert result.reason == (portal.PORTAL_HISTORY_INCOMPLETE if terminal else None)
    assert len(requests) == (1 if terminal else 2)
    if not terminal:
        assert requests[1]["next_cursor"] == "cursor+A" and requests[1]["offset"] is None


@pytest.mark.parametrize("link", [None, "", " \t\n"])
def test_null_or_whitespace_only_next_link_remains_blank_at_complete_terminal(link):
    result, requests = scan([page(nextLink=link)])
    assert result.allowed and result.reason is None and len(requests) == 1


@pytest.mark.parametrize("link", [
    "https://evil.invalid/v1/events?personId=990001&next=a",
    "http://api.followupboss.com/v1/events?personId=990001&next=a",
    "https://api.followupboss.com/v1/people?personId=990001&next=a",
    "https://api.followupboss.com/v1/x/../events?personId=990001&next=a",
    "https://api.followupboss.com:443/v1/events?personId=990001&next=a",
    "https://user@api.followupboss.com/v1/events?personId=990001&next=a",
    "https://api.followupboss.com/v1/events?personId=990002&next=a",
    "https://api.followupboss.com/v1/events?next=a",
    "https://api.followupboss.com/v1/events?personId=990001&limit=50&next=a",
    "https://api.followupboss.com/v1/events?personId=990001&next=a&source=Website",
    "https://api.followupboss.com/v1/events?personId=990001&next=a&type=Inquiry",
    "https://api.followupboss.com/v1/events?personId=990001&next=a&offset=100",
    "https://api.followupboss.com/v1/events?personId=990001&next=a&next=b",
    "https://api.followupboss.com/v1/events?personId=990001&next=",
    "https://api.followupboss.com/v1/events?personId=990001&next=%ZZ",
    "https://api.followupboss.com/v1/events?personId=990001&next=%GG",
    "https://api.followupboss.com/v1/events?personId=990001&next=%FF",
    "https://api.followupboss.com/v1/events?personId=990001&next=a#hidden",
    "//api.followupboss.com/v1/events?personId=990001&next=a", 42, {}, [],
])
def test_unsafe_or_filtered_next_link_defers_without_navigation(link):
    result, requests = scan([page([event()], total=2, nextLink=link)])
    assert result.reason == portal.PORTAL_HISTORY_INCOMPLETE and len(requests) == 1


@pytest.mark.parametrize("payload", [
    {}, [], {"events": {}}, {"events": [], "_metadata": {}},
    {"events": [], "_metadata": None},
    page([None]), page([42]), page([{}]), page([{"id": 1, "personId": PID}]),
    page([event(person_id=PID + 1, source="Zillow")]),
    page([{"id": 1, "source": "Zillow"}]),
    page([event(source={"name": "Zillow"})]), page([event(source=True)]),
    page([event()], total=0), page([], total=1), page([event()], total=2),
    page([], total=0, next="cursor-A"), page([], total=1, next="cursor-A"),
    page([event(), event()], total=2), page([event()], total=1, next="cursor-A"),
    page([event()], total=2, next=42), page([event()], total=2, next=[]),
    page([event()], collection="people"),
    page([Unreadable(id=1, personId=PID, source="Website")]),
])
def test_corrupt_or_incomplete_nonportal_history_defers(payload):
    result, requests = scan([payload])
    assert not result.allowed and result.reason == portal.PORTAL_HISTORY_INCOMPLETE
    assert len(requests) == 1


@pytest.mark.parametrize("value", [None, True, False, -1, 1.0, "1", [], {}, 9007199254740992])
def test_total_is_own_nonnegative_safe_integer(value):
    payload = page([event()])
    payload["_metadata"]["total"] = value
    result, _ = scan([payload])
    assert result.reason == portal.PORTAL_HISTORY_INCOMPLETE


@pytest.mark.parametrize("field", ["id", "personId"])
@pytest.mark.parametrize("value", [None, True, False, 0, -1, 1.0, "1", [], {}, 9007199254740992])
def test_event_identity_is_strict_positive_safe_integer(field, value):
    row = event()
    row[field] = value
    result, _ = scan([page([row])])
    assert result.reason == portal.PORTAL_HISTORY_INCOMPLETE


@pytest.mark.parametrize("flag", ["truncated", "incomplete", "restricted", "hasMore"])
@pytest.mark.parametrize("location", ["page", "metadata"])
@pytest.mark.parametrize("value", [True, "true", 1, []])
def test_explicit_partial_or_malformed_flags_cannot_authorize(flag, location, value):
    payload = page([event()])
    (payload if location == "page" else payload["_metadata"])[flag] = value
    result, _ = scan([payload])
    assert result.reason == portal.PORTAL_HISTORY_INCOMPLETE


@pytest.mark.parametrize("flag", ["truncated", "incomplete", "restricted", "hasMore"])
@pytest.mark.parametrize("location", ["page", "metadata"])
@pytest.mark.parametrize("continuation", [False, True])
def test_null_partial_signal_is_unknown_even_with_valid_continuation(flag, location, continuation):
    payload = (page([event()], total=2, next="cursor-A") if continuation else page())
    (payload if location == "page" else payload["_metadata"])[flag] = None
    result, requests = scan([payload, page([event(2)], total=2)])
    assert not result.allowed and result.reason == portal.PORTAL_HISTORY_INCOMPLETE
    assert result.pages == len(requests) == 1


@pytest.mark.parametrize("flag", ["truncated", "incomplete", "restricted", "hasMore"])
@pytest.mark.parametrize("location", ["page", "metadata"])
def test_missing_or_false_partial_flags_remain_safe(flag, location):
    assert scan([page()])[0].allowed
    payload = page()
    (payload if location == "page" else payload["_metadata"])[flag] = False
    result, requests = scan([payload])
    assert result.allowed and result.reason is None and len(requests) == 1


@pytest.mark.parametrize("flag", ["truncated", "incomplete", "restricted", "hasMore"])
@pytest.mark.parametrize("location", ["page", "metadata"])
def test_null_partial_signal_cannot_hide_readable_own_portal_source(flag, location):
    payload = page([event(source="Zillow")])
    (payload if location == "page" else payload["_metadata"])[flag] = None
    result, requests = scan([payload])
    assert result.reason == portal.PORTAL_EXCLUDED and len(requests) == 1


@pytest.mark.parametrize("location", ["page", "metadata"])
@pytest.mark.parametrize("continuation", ["cursor", "offset"])
def test_only_true_has_more_can_accompany_valid_continuation(location, continuation):
    payload = (page([event()], total=2, next="cursor-A") if continuation == "cursor" else
               page(full(), total=101))
    (payload if location == "page" else payload["_metadata"])["hasMore"] = True
    terminal = page([event(2 if continuation == "cursor" else 101)], total=payload["_metadata"]["total"])
    result, requests = scan([payload, terminal])
    assert result.allowed and result.reason is None and len(requests) == 2
    assert requests[1]["next_cursor"] == ("cursor-A" if continuation == "cursor" else None)
    assert requests[1]["offset"] == (100 if continuation == "offset" else None)


@pytest.mark.parametrize("flag", ["truncated", "incomplete", "restricted"])
@pytest.mark.parametrize("location", ["page", "metadata"])
def test_other_true_partial_flags_defer_even_with_valid_continuation(flag, location):
    payload = page([event()], total=2, next="cursor-A")
    (payload if location == "page" else payload["_metadata"])[flag] = True
    result, requests = scan([payload, page([event(2)], total=2)])
    assert result.reason == portal.PORTAL_HISTORY_INCOMPLETE and len(requests) == 1


@pytest.mark.parametrize("malformed", [
    None, {}, event(person_id=PID + 1, source="Zillow"), event(source=[]),
    {"id": 3, "source": "Zillow"}, Unreadable(id=4, personId=PID, source="Zillow"),
])
@pytest.mark.parametrize("portal_first", [False, True])
def test_matched_portal_source_wins_over_any_sibling_or_metadata_corruption(malformed, portal_first):
    good = event(2, source="Realtor.com - inquiry")
    events = [good, malformed] if portal_first else [malformed, good]
    result, _ = scan([{"events": events, "_metadata": None, "restricted": True}])
    assert result.reason == portal.PORTAL_EXCLUDED


@pytest.mark.parametrize("source", ["Zillow", "Realtor.com"])
def test_historical_portal_on_later_page_excludes(source):
    result, requests = scan([page(full(), total=101), page([event(101, source=source)], total=101)])
    assert result.reason == portal.PORTAL_EXCLUDED and len(requests) == 2


def test_duplicate_event_id_does_not_hide_own_portal_source():
    result, _ = scan([page([event()], total=2, next="cursor-A"), page([event(source="Zillow")], total=2)])
    assert result.reason == portal.PORTAL_EXCLUDED


@pytest.mark.parametrize("extra", [
    {"message": "Zillow", "sourceUrl": "https://zillow.com/", "tags": ["Zillow"]},
    {"isZillowPACLead": True, "property": {"source": "Zillow"}, "eventSource": "Zillow"},
])
def test_history_ignores_everything_except_explicit_event_source(extra):
    result, _ = scan([page([event(**extra)])])
    assert result.allowed


@pytest.mark.parametrize("pages", [
    [page([event()], total=2, next="cursor-A"), page([event(2)], total=3)],
    [page([event()], total=2, next="cursor-A"), page([event()], total=2)],
    [page([event()], total=3, next="cursor-A"), page([event(2)], total=3, next="cursor-A")],
    [page(full(i), total=501) for i in (1, 101, 201, 301, 401)],
    [page(full(i), total=1000, next=f"cursor-{i}") for i in (1, 101, 201, 301, 401)],
    [page([event()], total=2, next="cursor-A"), page([], total=2)],
])
def test_duplicate_total_change_repeated_cursor_and_pagecap_defer(pages):
    result, requests = scan(pages)
    assert result.reason == portal.PORTAL_HISTORY_INCOMPLETE
    assert len(requests) == len(pages) <= 5


@pytest.mark.parametrize("bad", [None, RuntimeError("synthetic private exception")])
def test_unavailable_history_uses_explicit_unavailable_reason(bad):
    result, _ = scan([bad])
    assert result.reason == portal.PORTAL_HISTORY_UNAVAILABLE


def test_missing_history_loader_has_no_fallback():
    result = portal.portal_email_gate(PID, lambda _: {"id": PID, "source": "Website"})
    assert not result.allowed and result.reason == portal.PORTAL_HISTORY_UNAVAILABLE


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("mode", ["history_zillow", "history_realtor", "history_bad", "history_unavailable",
                                 "history_later", "history_cap", "history_repeated", "native_fresh", "native_loaded"])
def test_actual_seven_callers_history_native_refusals_preserve_state_and_retry(sending, monkeypatch, path, mode):
    engine, calls, current = sending
    before = prepare_sent_state(engine)
    initial = {"id": PID, "source": "Website Form", "isZillowPACLead": False,
               "tags": [], "emails": [{"value": "synthetic@example.invalid"}]}
    fresh = {"id": PID, "source": "Website Form", "isZillowPACLead": mode == "native_fresh"}
    current["value"] = fresh
    if path == "welcome":
        values = iter([initial, fresh])
        monkeypatch.setattr(engine.fub, "get_person", lambda _: next(values))
        monkeypatch.setattr(engine.db, "recent_audit_rows", lambda *a: [])
    def history(pid, **kw):
        calls["history"] += 1
        if mode == "history_unavailable":
            return None
        if mode == "history_bad":
            return page([event(person_id=PID + 1, source="Zillow")])
        if mode == "history_cap":
            return page(full(1 + 100 * (calls["history"] - 1)), total=501)
        if mode == "history_later":
            return (page([event()], total=2, next="cursor-A") if calls["history"] == 1 else
                    page([event(2, source="Zillow")], total=2))
        if mode == "history_repeated":
            return page([event(calls["history"])], total=3, next="cursor-A")
        return page([event(source="Zillow" if mode == "history_zillow" else "Realtor.com")])
    monkeypatch.setattr(engine.fub, "get_email_portal_event_page", history)
    evidence = {"isZillowPACLead": True} if mode == "native_loaded" else {}
    if mode == "native_loaded" and path == "welcome":
        initial["isZillowPACLead"] = True
    result = invoke(engine, path, evidence)
    incomplete = mode in {"history_bad", "history_cap", "history_repeated"}
    assert result == ("deferred" if incomplete or mode == "history_unavailable" else "suppressed")
    assert calls["history"] == (0 if mode.startswith("native") else 5 if mode == "history_cap" else
                                2 if mode in {"history_later", "history_repeated"} else 1)
    assert_no_delivery(engine, calls, before)
    with engine.db.connect() as con:
        rows = con.execute("SELECT details FROM audit_log WHERE action='portal_email_gate'").fetchall()
    expected_reason = (portal.PORTAL_HISTORY_INCOMPLETE if incomplete else
                       portal.PORTAL_HISTORY_UNAVAILABLE if mode == "history_unavailable" else portal.PORTAL_EXCLUDED)
    assert all(json.loads(row[0]) == {"reason": expected_reason} for row in rows)
    if path == "seller":
        assert engine.db.claim_seller_send(PID, 0)
        engine.db.release_seller_send_claim(PID, 0)
    if path == "recruiting":
        assert engine.db.claim_recruiting_send(PID, 1)
        engine.db.release_recruiting_send_claim(PID, 1)
    monkeypatch.setattr(engine.fub, "get_email_portal_event_page", complete_history)
    current["value"] = {"id": PID, "source": "Website Form", "isZillowPACLead": False}
    monkeypatch.setattr(engine.fub, "get_person", lambda _: {**initial, **current["value"]})
    assert invoke(engine, path) == "dry_run_sent"
    assert calls["send"] == 1


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("flag", ["truncated", "incomplete", "restricted", "hasMore"])
@pytest.mark.parametrize("location", ["page", "metadata"])
def test_all_seven_callers_null_partial_flags_defer_without_delivery_and_remain_eligible(
        sending, m, monkeypatch, path, flag, location):
    engine, calls, current = sending
    before = prepare_sent_state(engine)
    since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=1)).isoformat()
    count_before = engine.db.count_recruiting_sends_since(since)
    initial = {"id": PID, "source": "Website Form", "isZillowPACLead": None,
               "tags": [], "emails": [{"value": "synthetic@example.invalid"}]}
    current["value"] = initial
    monkeypatch.setattr(engine.db, "recent_audit_rows", lambda *a: [])
    smtp_attempts = []
    def smtp(*a, **kw):
        smtp_attempts.append(True)
        raise AssertionError("synthetic SMTP boundary unexpectedly reached")
    monkeypatch.setattr(m.smtplib, "SMTP", smtp)
    payload = page()
    (payload if location == "page" else payload["_metadata"])[flag] = None
    def history(pid, **kw):
        calls["history"] += 1
        assert pid == PID and kw == {"next_cursor": None, "offset": None}
        return copy.deepcopy(payload)
    monkeypatch.setattr(engine.fub, "get_email_portal_event_page", history)
    assert invoke(engine, path, {"isZillowPACLead": None}) == "deferred"
    assert calls["history"] == 1 and calls["fresh"] == (2 if path == "welcome" else 1)
    assert smtp_attempts == []
    assert_no_delivery(engine, calls, before)
    assert engine.db.count_recruiting_sends_since(since) == count_before == 0
    with engine.db.connect() as con:
        rows = con.execute("SELECT details FROM audit_log WHERE action='portal_email_gate'").fetchall()
        assert con.execute("SELECT COUNT(*) FROM seller_send_claims").fetchone()[0] == 0
        assert con.execute("SELECT COUNT(*) FROM recruiting_send_claims").fetchone()[0] == 0
    assert [json.loads(row[0]) for row in rows] == [{"reason": portal.PORTAL_HISTORY_INCOMPLETE}]
    if path == "seller":
        assert engine.db.claim_seller_send(PID, 0)
        engine.db.release_seller_send_claim(PID, 0)
    if path == "recruiting":
        assert engine.db.claim_recruiting_send(PID, 1)
        engine.db.release_recruiting_send_claim(PID, 1)
    def clean_history(pid, **kw):
        calls["history"] += 1
        return complete_history(pid, **kw)
    monkeypatch.setattr(engine.fub, "get_email_portal_event_page", clean_history)
    assert invoke(engine, path, {"isZillowPACLead": None}) == "dry_run_sent"
    assert calls["send"] == 1 and calls["history"] == 2 and smtp_attempts == []


@pytest.mark.parametrize("kind", ["first", "due"])
@pytest.mark.parametrize("flag", ["truncated", "incomplete", "restricted", "hasMore"])
@pytest.mark.parametrize("location", ["page", "metadata"])
def test_recruit_queue_null_partial_flags_preserve_count_cap_claim_and_retry(
        sending, monkeypatch, kind, flag, location):
    engine, calls, current = sending
    now = dt.datetime.now(dt.timezone.utc)
    initial = {"id": PID, "source": "New Agent Inquiry", "created": now.isoformat(), "tags": [],
               "isZillowPACLead": None, "emails": [{"value": "synthetic@example.invalid"}]}
    engine.db.enroll_recruit(PID, "New Agent Inquiry", (now - dt.timedelta(days=31)).isoformat())
    before = sent_state(engine)
    payload = page()
    (payload if location == "page" else payload["_metadata"])[flag] = None
    monkeypatch.setattr(engine.fub, "get_people", lambda **kw: [initial] if kind == "first" else [])
    monkeypatch.setattr(engine.fub, "get_person", lambda _: initial)
    def history(pid, **kw):
        calls["history"] += 1
        return copy.deepcopy(payload)
    monkeypatch.setattr(engine.fub, "get_email_portal_event_page", history)
    counts = engine.scan_recruiting_track(now)
    assert counts["sent"] == counts["capped"] == counts["errors"] == 0
    assert counts[kind] == 1 and calls["history"] == 1
    assert_no_delivery(engine, calls, before)
    assert engine.db.count_recruiting_sends_since((now - dt.timedelta(days=1)).isoformat()) == 0
    with engine.db.connect() as con:
        rows = con.execute("SELECT details FROM audit_log WHERE action='portal_email_gate'").fetchall()
        assert con.execute("SELECT COUNT(*) FROM recruiting_send_claims").fetchone()[0] == 0
    assert [json.loads(row[0]) for row in rows] == [{"reason": portal.PORTAL_HISTORY_INCOMPLETE}]
    assert engine.db.claim_recruiting_send(PID, 1)
    engine.db.release_recruiting_send_claim(PID, 1)
    monkeypatch.setattr(engine.fub, "get_email_portal_event_page", complete_history)
    assert engine._send_recruiting_email(initial, engine.db.recruiting_enrollments()[PID], now) == "dry_run_sent"
    assert calls["send"] == 1


@pytest.mark.parametrize("kind", ["first", "due"])
@pytest.mark.parametrize("payload", [page([event(source="Zillow")]), page([event(person_id=PID + 1)]), None])
def test_recruit_queue_history_refusal_does_not_consume_count_cap_or_claim(sending, monkeypatch, kind, payload):
    engine, calls, current = sending
    now = dt.datetime.now(dt.timezone.utc)
    initial = {"id": PID, "source": "New Agent Inquiry", "created": now.isoformat(), "tags": [],
               "emails": [{"value": "synthetic@example.invalid"}]}
    before = prepare_sent_state(engine)
    monkeypatch.setattr(engine.fub, "get_people", lambda **kw: [initial] if kind == "first" else [])
    monkeypatch.setattr(engine.fub, "get_person", lambda _: initial)
    monkeypatch.setattr(engine.fub, "get_email_portal_event_page", lambda *a, **kw: copy.deepcopy(payload))
    counts = engine.scan_recruiting_track(now)
    assert counts["sent"] == counts["capped"] == counts["errors"] == 0
    assert counts[kind] == 1
    assert_no_delivery(engine, calls, before)
    assert engine.db.count_recruiting_sends_since((now - dt.timedelta(days=1)).isoformat()) == 0
    monkeypatch.setattr(engine.fub, "get_email_portal_event_page", complete_history)
    assert engine._send_recruiting_email(initial, engine.db.recruiting_enrollments()[PID], now) == "dry_run_sent"
    assert calls["send"] == 1


def test_no_negative_history_cache(sending, monkeypatch):
    engine, calls, current = sending
    selected = {"id": PID, "source": "Website Form"}
    assert engine._send_contact_email(PID, selected, "synthetic", "synthetic", "synthetic").allowed
    after_first = sent_state(engine)
    def history(*a, **kw):
        calls["history"] += 1
        return page([event(source="Zillow")])
    monkeypatch.setattr(engine.fub, "get_email_portal_event_page", history)
    assert engine._send_contact_email(PID, selected, "synthetic", "synthetic", "synthetic").reason == portal.PORTAL_EXCLUDED
    assert calls["send"] == 1 and calls["fresh"] == calls["history"] == 2
    assert calls["note"] == 0 and sent_state(engine) == after_first


@pytest.mark.parametrize("continuation", [None, "cursor-A", 100])
def test_email_loader_single_attempt_scope_timeout_no_redirects(fub, m, monkeypatch, continuation):
    requests = []
    closed = []
    class Response:
        status_code = 200
        def json(self):
            return page()
        def close(self):
            closed.append(True)
    def request(method, url, **kwargs):
        requests.append((method, url, kwargs))
        return Response()
    monkeypatch.setattr(m.requests, "request", request)
    monkeypatch.setattr(fub, "_request", lambda *a, **kw: pytest.fail("generic retry called"))
    kwargs = {"next_cursor": continuation} if isinstance(continuation, str) else {"offset": continuation}
    result = fub.get_email_portal_event_page(PID, **kwargs)
    assert result == page() and len(requests) == len(closed) == 1
    method, url, sent = requests[0]
    assert method == "GET" and url == "https://api.followupboss.com/v1/events"
    params = {"personId": PID, "limit": 100}
    if isinstance(continuation, str):
        params["next"] = continuation
    elif continuation is not None:
        params["offset"] = continuation
    assert sent["params"] == params and sent["timeout"] == 15 and sent["allow_redirects"] is False


@pytest.mark.parametrize("failure", ["http400", "http429", "http429_retry_after", "http500", "redirect",
                                     "timeout", "network_exception", "invalid_json", "elapsed"])
def test_email_loader_failure_is_single_attempt_unavailable_no_sensitive_logging(fub, m, monkeypatch, failure, caplog):
    requests = []
    class Response:
        status_code = {"http400": 400, "http429": 429, "http429_retry_after": 429,
                       "http500": 500, "redirect": 302}.get(failure, 200)
        headers = {"Retry-After": "120"} if failure == "http429_retry_after" else {}
        def json(self):
            if failure == "invalid_json":
                raise ValueError("synthetic-private-json")
            return page()
        def close(self):
            pass
    def request(*args, **kwargs):
        requests.append(True)
        if failure == "timeout":
            raise m.requests.exceptions.ReadTimeout("synthetic-private-timeout")
        if failure == "network_exception":
            raise m.requests.exceptions.ConnectionError("synthetic-private-network")
        return Response()
    monkeypatch.setattr(m.requests, "request", request)
    if failure == "elapsed":
        clock = iter([0, 15.01])
        monkeypatch.setattr(m.time, "monotonic", lambda: next(clock))
    result = portal.scan_portal_event_history(PID, fub.get_email_portal_event_page)
    assert result.reason == portal.PORTAL_HISTORY_UNAVAILABLE and len(requests) == 1
    assert "synthetic-private" not in caplog.text


@pytest.mark.parametrize("evidence", [{"source": "Zillow"}, {"isZillowPACLead": True}])
def test_internal_email_sender_never_checks_history(engine, monkeypatch, evidence):
    # Staff-only mail stays identity-free; the contact seam is not involved.
    monkeypatch.setattr(engine.fub, "get_email_portal_event_page", lambda *a, **k: pytest.fail("internal history"))
    monkeypatch.setattr(engine.fub, "get_person", lambda *a, **k: pytest.fail("internal fresh read"))
    sends = []
    monkeypatch.setattr(engine.email, "send", lambda *a, **k: sends.append(True))
    monkeypatch.setattr(engine, "user_cache_by_id", lambda: {
        35: {"id": 35, "name": "Synthetic Agent", "email": "synthetic@example.invalid"},
    })
    # Existing lead-containing digest returns without sending. The existing
    # clean-pipeline staff digest still uses identity-free direct transport.
    engine.send_agent_reminder_digest(35, [{"id": PID, "source": "Website", **evidence}])
    engine.send_agent_reminder_digest(35, [])
    assert len(sends) == 1


class FreeEventFieldsPoison(dict):
    forbidden = {"message", "description", "note", "notes", "pageTitle", "pageUrl", "property",
                 "sourceUrl", "tags", "isZillowPACLead", "type", "body", "text"}
    reads = None

    def __contains__(self, key):
        if key in self.forbidden:
            raise AssertionError("free event field membership inspected")
        return super().__contains__(key)

    def __getitem__(self, key):
        if key in self.forbidden:
            raise AssertionError("free event field read")
        self.reads.append(key)
        return super().__getitem__(key)


def test_free_event_fields_are_never_read_even_when_they_contain_portal_mentions():
    row = FreeEventFieldsPoison(event(message="Zillow", description="Realtor.com", note="Zillow",
                                    pageTitle="Zillow", pageUrl="https://zillow.com/", type="Inquiry"))
    row.reads = []
    result, requests = scan([page([row])])
    assert result.allowed and len(requests) == 1
    assert row.reads == ["id", "personId", "source"]


@pytest.mark.parametrize("remaining", [False, True])
def test_missing_next_terminates_only_when_total_is_satisfied(remaining):
    result, requests = scan([page([event()], total=2 if remaining else 1)])
    assert result.reason == (portal.PORTAL_HISTORY_INCOMPLETE if remaining else None)
    assert result.allowed is (not remaining) and len(requests) == 1


def test_oversized_event_page_is_incomplete_not_clean():
    result, requests = scan([page(full() + [event(101)], total=101)])
    assert result.reason == portal.PORTAL_HISTORY_INCOMPLETE and len(requests) == 1


def test_page_cap_continuation_keeps_own_portal_on_last_page_as_excluded():
    pages = [page(full(i), total=501) for i in (1, 101, 201, 301, 401)]
    pages[-1]["events"][-1]["source"] = "Zillow"
    result, requests = scan(pages)
    assert result.reason == portal.PORTAL_EXCLUDED and len(requests) == 5


@pytest.mark.parametrize("failure", ["http400", "http429", "http429_retry_after", "timeout",
                                     "network_exception", "invalid_json"])
def test_final_contact_transport_never_reached_after_email_history_http_failure(sending, m, monkeypatch, failure):
    engine, calls, current = sending
    before = prepare_sent_state(engine)
    attempts = []
    class Response:
        status_code = 429 if failure.startswith("http429") else 400 if failure == "http400" else 200
        headers = {"Retry-After": "120"} if failure == "http429_retry_after" else {}
        def json(self):
            if failure == "invalid_json":
                raise ValueError("synthetic-private-json")
            return page()
        def close(self):
            pass
    def request(*a, **kw):
        attempts.append(True)
        if failure == "timeout":
            raise m.requests.exceptions.ReadTimeout("synthetic-private-timeout")
        if failure == "network_exception":
            raise m.requests.exceptions.ConnectionError("synthetic-private-network")
        return Response()
    monkeypatch.setattr(m.requests, "request", request)
    monkeypatch.setattr(engine.fub, "get_email_portal_event_page",
                        m.FollowUpBossClient.get_email_portal_event_page.__get__(engine.fub))
    result = engine._send_contact_email(PID, {"id": PID, "source": "Website Form"},
                                        "synthetic", "synthetic", "synthetic")
    assert result.reason == portal.PORTAL_HISTORY_UNAVAILABLE and attempts == [True]
    assert_no_delivery(engine, calls, before)


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("value", [False, None, "absent"])
def test_native_nonportal_values_still_need_and_use_history_on_every_caller(sending, path, value, monkeypatch):
    engine, calls, current = sending
    evidence = {} if value == "absent" else {"isZillowPACLead": value}
    initial = {"id": PID, "source": "Website Form", "tags": [],
               "emails": [{"value": "synthetic@example.invalid"}], **evidence}
    current.update(evidence)
    if path == "welcome":
        monkeypatch.setattr(engine.fub, "get_person", lambda _: initial)
        monkeypatch.setattr(engine.db, "recent_audit_rows", lambda *a: [])
    assert invoke(engine, path, evidence) == "dry_run_sent"
    assert calls["send"] == calls["history"] == 1


@pytest.mark.parametrize("path", PATHS)
def test_missing_history_implementation_refuses_every_caller_and_releases_claims(sending, monkeypatch, path):
    engine, calls, current = sending
    before = prepare_sent_state(engine)
    if path == "welcome":
        current["emails"] = [{"value": "synthetic@example.invalid"}]
        monkeypatch.setattr(engine.db, "recent_audit_rows", lambda *a: [])
    monkeypatch.setattr(engine.fub, "get_email_portal_event_page", None)
    assert invoke(engine, path) == "deferred"
    assert calls["history"] == 0
    assert_no_delivery(engine, calls, before)
    with engine.db.connect() as con:
        rows = con.execute("SELECT details FROM audit_log WHERE action='portal_email_gate'").fetchall()
    assert [json.loads(row[0]) for row in rows] == [{"reason": portal.PORTAL_HISTORY_UNAVAILABLE}]
    if path == "seller":
        assert engine.db.claim_seller_send(PID, 0)
        engine.db.release_seller_send_claim(PID, 0)
    if path == "recruiting":
        assert engine.db.claim_recruiting_send(PID, 1)
        engine.db.release_recruiting_send_claim(PID, 1)


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("value", ["true", "false", 0, 1, -1, 1.0, [], {}, [True]])
def test_actual_callers_malformed_native_defers_before_history_send_or_sent_state(sending, monkeypatch, path, value):
    engine, calls, current = sending
    before = prepare_sent_state(engine)
    fresh = {"id": PID, "source": "Website Form", "isZillowPACLead": value}
    current["value"] = fresh
    if path == "welcome":
        initial = {"id": PID, "source": "Website Form", "tags": [],
                   "emails": [{"value": "synthetic@example.invalid"}], "isZillowPACLead": False}
        values = iter([initial, fresh])
        monkeypatch.setattr(engine.fub, "get_person", lambda _: next(values))
        monkeypatch.setattr(engine.db, "recent_audit_rows", lambda *a: [])
    assert invoke(engine, path) == "deferred"
    assert calls["history"] == 0
    assert_no_delivery(engine, calls, before)


def test_recording_fake_http_requires_explicit_complete_history_payload(fub, fake_http):
    fake_http.responses = [(200, page([event()]))]
    assert portal.scan_portal_event_history(PID, fub.get_email_portal_event_page).allowed
    assert len(fake_http.calls) == 1
    assert fake_http.calls[0].params == {"personId": PID, "limit": 100}
    fake_http.responses = [(200, {})]
    assert portal.scan_portal_event_history(PID, fub.get_email_portal_event_page).reason == portal.PORTAL_HISTORY_INCOMPLETE


def test_no_negative_cache_orders_every_read_and_preserves_second_attempt_state(sending, monkeypatch):
    engine, calls, current = sending
    trace = []
    def fresh(_):
        trace.append("fresh")
        return {"id": PID, "source": "Website Form", "isZillowPACLead": False}
    def history(pid, **kw):
        trace.append("history")
        return page([event(source="Website Form" if len(trace) == 2 else "Zillow")])
    monkeypatch.setattr(engine.fub, "get_person", fresh)
    monkeypatch.setattr(engine.fub, "get_email_portal_event_page", history)
    monkeypatch.setattr(engine.email, "send", lambda *a, **kw: trace.append("transport"))
    selected = {"id": PID, "source": "Website Form"}
    assert engine._send_contact_email(PID, selected, "synthetic", "synthetic", "synthetic").allowed
    after_first = sent_state(engine)
    assert engine._send_contact_email(PID, selected, "synthetic", "synthetic", "synthetic").reason == portal.PORTAL_EXCLUDED
    assert trace == ["fresh", "history", "transport", "fresh", "history"]
    assert sent_state(engine) == after_first and calls["note"] == 0
