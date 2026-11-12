"""Final-review closure using only synthetic loaders, state and transports."""
import datetime as dt
import json

import pytest

from fub_automation import portal
from portal_history_fakes import complete_history
from test_portal_email_gate import PATHS, PID, invoke, sending  # noqa: F401
from test_portal_shared_contract import assert_no_delivery, prepare_sent_state

BACKSLASH_URL_CASES = (
    (r"https://zillow.com\lead", True),
    (r"https://zillow.com:443\lead", True),
    (r"https://zillow.com\@example.invalid/lead", True),
    (r"https://example.invalid\@zillow.com/lead", False),
)
CONSERVATIVE_PORTAL_URLS = (
    "https:zillow.com/lead", "https:/zillow.com/lead",
    "//www.realtor.com/lead", "www.zillow.com/lead",
    "https://zillow.com:bad/lead", "https://zillow.com:65536/lead",
    "https://zillow.com../lead", "https://realtor.com../lead",
    "https://zillow%2ecom%2e%2e/lead", "https://zillow.com。./lead",
    "https:zillow.com./lead", "https:/zillow.com./lead", "//zillow.com/lead",
    "ftp://zillow.com/lead", "HTTPS:/%7Aillow.com.:bad/lead",
    "//Ｚｉｌｌｏｗ。com../lead",
)
UNREADABLE_URLS = (
    "https://", "/lead/zillow.com", "https://%ZZillow.com/lead",
    "https://%FFzillow.com/lead", "https://zillow.com%2F.example.invalid/lead",
    "https://zillow.com%5C.example.invalid/lead", "https://zillow.com%00/lead",
    "https://zillow.com%40example.invalid/lead", "https://zillow..com/lead",
    "https://[broken/lead", "https://zillow.com:443:bad/lead",
    "https://not a hostname/lead", "/zillow.com",
    "https://[::1]:443:bad/lead",
    "https://%09example.invalid/x", "https://ex%09ample.invalid/x",
    "https://%0Aexample.invalid/x",
)
ENCODED_PORTAL_URLS = (
    "https://%7Aillow.com/lead",
    "https://%72ealtor.com./lead",
    "https://Ｚｉｌｌｏｗ.com/lead",
    "https://zillow。com/lead",
)
MALFORMED_SELECTED_IDS = (True, PID + 0.5, float(PID), "0990001", "+990001")
INVALID_REQUESTED_IDS = (None, True, False, 0, -1, [], {}, PID + 0.5,
                         float(PID), "0990001", "+990001", "990001.0",
                         " 990001", "９９０００１", 9007199254740992)


@pytest.mark.parametrize("value", ENCODED_PORTAL_URLS + (
    "HTTPS://%7Aillow.com:443/lead", "https://sub.%72ealtor.com./lead",
    "https://zillow%2Ecom/lead", "https://%EF%BC%BAillow.com/lead",
))
def test_encoded_and_idna_real_portal_hosts_match(value):
    assert portal.portal_url(value)


@pytest.mark.parametrize("value", (
    "https://%7Aillow.com.example.invalid/lead",
    "https://evil%7Aillow.com/lead", "https://Ｚｉｌｌｏｗ.com.example.invalid/lead",
    "https://zillow。com.example.invalid/lead", "https://%7Aillow.com@example.invalid/lead",
    "https://example.invalid/%7Aillow.com/lead", "https://example.invalid/?host=zillow.com",
    "https://%ZZillow.com/lead", "https://%FFzillow.com/lead",
    "https://zillow.com%2F.example.invalid/lead", "https://zillow.com%00/lead",
    "https://zillow.com%40example.invalid/lead",
))
def test_malformed_urls_and_normalized_lookalikes_do_not_match(value):
    assert not portal.portal_url(value)


@pytest.mark.parametrize("value", CONSERVATIVE_PORTAL_URLS)
@pytest.mark.parametrize("surface", ("fresh", "already_loaded"))
def test_recoverable_portal_authority_blocks_despite_url_nonnavigability(value, surface):
    metadata = portal.inspect_portal_url(value)
    assert metadata.portal and metadata.usable
    evidence = {"sourceUrl": value}
    current = {"id": PID, "source": "Website", **evidence} if surface == "fresh" else {"id": PID, "source": "Website"}
    decision = portal.portal_email_gate(PID, lambda _: current, evidence if surface == "already_loaded" else None)
    assert not decision.allowed and decision.reason == portal.PORTAL_EXCLUDED


@pytest.mark.parametrize("value", UNREADABLE_URLS)
@pytest.mark.parametrize("surface", ("fresh", "already_loaded"))
def test_nonblank_unreadable_url_defers_but_readable_portal_sibling_wins(value, surface):
    metadata = portal.inspect_portal_url(value)
    assert not metadata.portal and not metadata.usable
    evidence = {"sourceUrl": value}
    current = {"id": PID, "source": "Website", **evidence} if surface == "fresh" else {"id": PID, "source": "Website"}
    loaded = evidence if surface == "already_loaded" else None
    assert portal.portal_email_gate(PID, lambda _: current, loaded).reason == portal.PORTAL_FRESH_UNAVAILABLE
    current["originalSource"] = {"name": "Zillow"}
    assert portal.portal_email_gate(PID, lambda _: current, loaded).reason == portal.PORTAL_EXCLUDED


@pytest.mark.parametrize("value", (
    "https://zillow.com@example.invalid/lead", "https://zillow.com.example.invalid/lead",
    "https://evilzillow.com/lead", "https://zillow.co/lead", "https://realtor.community/lead",
    "https://example.invalid/zillow.com/lead", "https://example.invalid/?host=zillow.com",
    "https://example.invalid/#realtor.com", r"https://example.invalid\@zillow.com/lead",
    "https://example.invalid:bad/zillow.com/lead", "https:/example.invalid/zillow.com",
))
def test_recognizable_nonportal_host_controls_remain_usable_and_sendable(value):
    assert portal.inspect_portal_url(value) == portal.ProvenanceMetadata(False, True)
    assert portal.portal_email_gate(PID, lambda _: {"id": PID, "source": "Website", "sourceUrl": value}, event_page_loader=complete_history).allowed


@pytest.mark.parametrize("value", (None, "", "  "))
def test_absent_url_metadata_is_usable(value):
    assert portal.inspect_portal_url(value) == portal.ProvenanceMetadata(False, True)


@pytest.mark.parametrize("value", (True, 42, [], {}, {"url": "https://zillow.com"}))
def test_wrong_type_url_metadata_is_unusable(value):
    assert portal.inspect_portal_url(value) == portal.ProvenanceMetadata(False, False)


@pytest.mark.parametrize("value,expected_portal", BACKSLASH_URL_CASES)
@pytest.mark.parametrize("surface", ("fresh", "already_loaded"))
def test_backslash_canonical_host_pure_gate(value, expected_portal, surface):
    evidence = {"source": "Website", "sourceUrl": value}
    current = {"id": PID, **evidence} if surface == "fresh" else {"id": PID, "source": "Website"}
    loaded = evidence if surface == "already_loaded" else None
    reads = []
    def load(pid):
        reads.append(pid)
        return current
    assert portal.portal_url(value) is expected_portal
    assert portal.provenance_metadata_usable(evidence)
    decision = portal.portal_email_gate(PID, load, loaded, event_page_loader=complete_history)
    assert decision.allowed is (not expected_portal)
    assert decision.reason == (portal.PORTAL_EXCLUDED if expected_portal else None)
    assert reads == [PID]


@pytest.mark.parametrize("value,expected_portal", BACKSLASH_URL_CASES)
@pytest.mark.parametrize("surface", ("fresh", "already_loaded"))
@pytest.mark.parametrize("path", PATHS)
def test_every_actual_contact_path_backslash_host_and_reverse_control(sending, monkeypatch, path, surface, value, expected_portal):
    engine, calls, current = sending
    before = prepare_sent_state(engine)
    evidence = {"sourceUrl": value}
    fresh = {"id": PID, "source": "Website", **(evidence if surface == "fresh" else {})}
    if path == "welcome":
        initial = {"id": PID, "source": "Website", "tags": [],
                   "emails": [{"value": "synthetic@example.invalid"}]}
        values = iter([initial, fresh])
        def load(_):
            calls["fresh"] += 1
            return next(values)
        monkeypatch.setattr(engine.fub, "get_person", load)
        monkeypatch.setattr(engine.db, "recent_audit_rows", lambda *a: [])
    else:
        current["value"] = fresh
    result = invoke(engine, path, evidence if surface == "already_loaded" else {})
    assert result == ("suppressed" if expected_portal else "dry_run_sent")
    if expected_portal:
        assert_no_delivery(engine, calls, before)
        if path == "seller":
            assert engine.db.claim_seller_send(PID, 0)
            engine.db.release_seller_send_claim(PID, 0)
        if path == "recruiting":
            assert engine.db.claim_recruiting_send(PID, 1)
            engine.db.release_recruiting_send_claim(PID, 1)
    else:
        # A resolved canned sender, not a real SMTP call, proves the reverse
        # userinfo control is actually eligible on each existing contact path.
        assert calls["send"] == 1
        assert calls["note"] == (0 if path == "recruiting" else 1)
        with engine.db.connect() as con:
            assert con.execute("SELECT COUNT(*) FROM audit_log WHERE status='dry_run_sent'").fetchone()[0] == 1
    # Loaded portals may stop at selection; fresh portals must reach the final
    # reread. Welcome always has a distinct initial person-selection read.
    assert calls["fresh"] == ((1 if path == "welcome" else 0)
                              if surface == "already_loaded" and expected_portal
                              else (2 if path == "welcome" else 1))


@pytest.mark.parametrize("value,expected_portal", BACKSLASH_URL_CASES)
@pytest.mark.parametrize("queue_kind", ("first", "due"))
def test_recruiting_queue_backslash_refusal_does_not_consume_cap_or_retry(sending, monkeypatch, queue_kind, value, expected_portal):
    engine, calls, current = sending
    now = dt.datetime.now(dt.timezone.utc)
    initial = {"id": PID, "source": "New Agent Inquiry", "created": now.isoformat(), "tags": [],
               "emails": [{"value": "synthetic@example.invalid"}]}
    before = prepare_sent_state(engine)
    fresh = {"id": PID, "source": "New Agent Inquiry", "sourceUrl": value}
    monkeypatch.setattr(engine.fub, "get_people", lambda **kw: [initial] if queue_kind == "first" else [])
    if queue_kind == "due":
        values = iter([initial, fresh])
        def load(_):
            calls["fresh"] += 1
            return next(values)
        monkeypatch.setattr(engine.fub, "get_person", load)
    else:
        current["value"] = fresh
    counts = engine.scan_recruiting_track(now)
    assert counts["sent"] == int(not expected_portal)
    assert counts["suppressed"] == int(expected_portal)
    assert counts["capped"] == 0 and counts["errors"] == 0
    assert counts[queue_kind] == 1
    if expected_portal:
        assert_no_delivery(engine, calls, before)
        assert engine.db.count_recruiting_sends_since((now - dt.timedelta(days=1)).isoformat()) == 0
        current["value"] = {"id": PID, "source": "New Agent Inquiry"}
        monkeypatch.setattr(engine.fub, "get_person", lambda _: current["value"])
        assert engine._send_recruiting_email(initial, engine.db.recruiting_enrollments()[PID], now) == "dry_run_sent"
    assert calls["send"] == 1


@pytest.mark.parametrize("evidence,expected", (
    ({"sourceUrl": "https:zillow.com/lead"}, "suppressed"),
    ({"sourceUrl": "https:/zillow.com/lead"}, "suppressed"),
    ({"sourceUrl": "//www.realtor.com/lead"}, "suppressed"),
    ({"sourceUrl": "www.zillow.com/lead"}, "suppressed"),
    ({"sourceUrl": "https://zillow.com:bad/lead"}, "suppressed"),
    ({"sourceUrl": "https://%ZZillow.com/lead"}, "deferred"),
    ({"sourceUrl": "https://zillow.com%5C.example.invalid/lead"}, "deferred"),
))
@pytest.mark.parametrize("path", PATHS)
def test_every_actual_contact_path_conservative_or_unreadable_url_refusal(sending, monkeypatch, path, evidence, expected):
    engine, calls, current = sending
    before = prepare_sent_state(engine)
    fresh = {"id": PID, "source": "Website", **evidence}
    if path == "welcome":
        initial = {"id": PID, "source": "Website", "tags": [],
                   "emails": [{"value": "synthetic@example.invalid"}]}
        values = iter([initial, fresh])
        def load(_):
            calls["fresh"] += 1
            return next(values)
        monkeypatch.setattr(engine.fub, "get_person", load)
        monkeypatch.setattr(engine.db, "recent_audit_rows", lambda *a: [])
    else:
        current["value"] = fresh
    assert invoke(engine, path) == expected
    assert calls["fresh"] == (2 if path == "welcome" else 1)
    assert_no_delivery(engine, calls, before)


@pytest.mark.parametrize("snapshot", ({}, {"id": 1, "firstName": "Synthetic"}, {"unknown": "Zillow"}))
def test_unrelated_top_level_snapshots_are_absent_without_relaxing_fresh_person(snapshot):
    assert portal.inspect_provenance_metadata(snapshot) == portal.ProvenanceMetadata(False, True)
    assert portal.inspect_provenance_metadata((snapshot,)) == portal.ProvenanceMetadata(False, True)
    assert portal.portal_email_gate(PID, lambda _: {"id": PID, "source": "Website"}, snapshot, event_page_loader=complete_history).allowed
    assert portal.portal_email_gate(PID, lambda _: {"id": PID}, snapshot).reason == portal.PORTAL_FRESH_UNAVAILABLE


@pytest.mark.parametrize("snapshot", ({}, {"id": 1, "firstName": "Synthetic"}, {"unknown": "Zillow"}))
@pytest.mark.parametrize("field", ("original", "event", "originalProvenance", "eventProvenance", "originalSource", "eventSource"))
def test_explicitly_named_nested_unknown_snapshots_still_defer(snapshot, field):
    loaded = {field: snapshot}
    assert not portal.provenance_metadata_usable(loaded)
    assert portal.portal_email_gate(PID, lambda _: {"id": PID, "source": "Website"}, loaded).reason == portal.PORTAL_FRESH_UNAVAILABLE


@pytest.mark.parametrize("snapshot", ({}, {"id": 1, "firstName": "Synthetic"}, {"unknown": "Zillow"}))
@pytest.mark.parametrize("value,expected_portal", ((None, False),) + BACKSLASH_URL_CASES)
def test_actual_welcome_unrelated_webhook_snapshot_does_not_falsely_defer_or_hide_portal(sending, monkeypatch, snapshot, value, expected_portal):
    engine, calls, current = sending
    before = prepare_sent_state(engine)
    initial = {"id": PID, "source": "Website", "tags": [],
               "emails": [{"value": "synthetic@example.invalid"}]}
    fresh = {"id": PID, "source": "Website", "sourceUrl": value}
    values = iter([initial, fresh])
    def load(_):
        calls["fresh"] += 1
        return next(values)
    monkeypatch.setattr(engine.fub, "get_person", load)
    monkeypatch.setattr(engine.db, "recent_audit_rows", lambda *a: [])
    assert engine.send_instant_welcome_email(PID, snapshot) == ("suppressed" if expected_portal else "dry_run_sent")
    assert calls["fresh"] == 2
    if expected_portal:
        assert_no_delivery(engine, calls, before)
    else:
        assert calls["send"] == 1 and calls["note"] == 1


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("snapshot", ({}, {"id": 1, "firstName": "Synthetic"}, {"unknown": "Zillow"}))
def test_each_existing_path_wrapper_ignores_only_unrelated_tuple_snapshot(sending, path, snapshot):
    engine, calls, current = sending
    selected = {"id": PID, "source": "New Agent Inquiry" if path == "recruiting" else "Website"}
    assert engine._send_contact_email(PID, (selected, snapshot), "synthetic@example.invalid", "synthetic", "synthetic").allowed
    assert calls["fresh"] == 1 and calls["send"] == 1


@pytest.mark.parametrize("value", ENCODED_PORTAL_URLS)
@pytest.mark.parametrize("path", PATHS)
def test_every_actual_contact_path_encoded_portal_blocks_final_sender(sending, monkeypatch, path, value):
    engine, calls, current = sending
    before = prepare_sent_state(engine)
    fresh = {"id": PID, "source": "Website", "sourceUrl": value}
    if path == "welcome":
        initial = {"id": PID, "source": "Website", "tags": [],
                   "emails": [{"value": "synthetic@example.invalid"}]}
        values = iter([initial, fresh])
        def load(_):
            calls["fresh"] += 1
            return next(values)
        monkeypatch.setattr(engine.fub, "get_person", load)
        monkeypatch.setattr(engine.db, "recent_audit_rows", lambda *a: [])
    else:
        current["value"] = fresh
    assert invoke(engine, path) == "suppressed"
    assert calls["fresh"] == (2 if path == "welcome" else 1)
    assert_no_delivery(engine, calls, before)


@pytest.mark.parametrize("selected_id", MALFORMED_SELECTED_IDS)
@pytest.mark.parametrize("path", PATHS)
def test_every_actual_contact_path_rejects_original_malformed_selected_identity(sending, monkeypatch, path, selected_id):
    engine, calls, current = sending
    requested = int(selected_id)  # Reproduce the actual six caller conversions.
    if requested != PID:
        engine.db.enroll_seller_nurture(requested, "", "")
    before = prepare_sent_state(engine)
    # A valid DIFFERENT fresh person must not launder the invalid selected ID.
    current["value"] = {"id": requested, "source": "Website"}
    if path == "welcome":
        initial = {"id": selected_id, "source": "Website", "tags": [],
                   "emails": [{"value": "synthetic@example.invalid"}]}
        def load(_):
            calls["fresh"] += 1
            return initial if calls["fresh"] == 1 else current["value"]
        monkeypatch.setattr(engine.fub, "get_person", load)
        monkeypatch.setattr(engine.db, "recent_audit_rows", lambda *a: [])
    assert invoke(engine, path, {"id": selected_id}) == "deferred"
    # Welcome's initial selection read is separate; its hard gate never rereads.
    assert calls["fresh"] == (1 if path == "welcome" else 0)
    assert_no_delivery(engine, calls, before)
    with engine.db.connect() as con:
        rows = con.execute("SELECT details FROM audit_log WHERE action='portal_email_gate'").fetchall()
    assert [json.loads(row[0]) for row in rows] == [{"reason": portal.PORTAL_PERSON_ID_UNUSABLE}]
    if path == "seller":
        assert engine.db.claim_seller_send(requested, 0)
        engine.db.release_seller_send_claim(requested, 0)
    if path == "recruiting":
        assert engine.db.claim_recruiting_send(requested, 1)
        engine.db.release_recruiting_send_claim(requested, 1)


@pytest.mark.parametrize("requested_id", INVALID_REQUESTED_IDS)
@pytest.mark.parametrize("loaded", (
    {"source": "Zillow"},
    ({"source": "Website"}, {"id": "synthetic-event", "eventSource": "Realtor.com"}),
    {"source": [], "originalSource": {"name": "Zillow"}},
))
def test_direct_gate_invalid_requested_identity_keeps_known_portal_reason_without_loader(requested_id, loaded):
    reads = []
    def load(pid):
        reads.append(pid)
        return {"id": PID, "source": "Website"}
    decision = portal.portal_email_gate(requested_id, load, loaded)
    assert decision.reason == portal.PORTAL_EXCLUDED
    assert not decision.allowed and reads == []


@pytest.mark.parametrize("selected_id", MALFORMED_SELECTED_IDS + (None, PID + 1))
@pytest.mark.parametrize("tuple_snapshot", (False, True))
def test_wrapper_original_selected_identity_not_replaced_by_event_identity(sending, selected_id, tuple_snapshot):
    engine, calls, current = sending
    before = prepare_sent_state(engine)
    selected = {"id": selected_id, "source": "Website"}
    loaded = (selected, {"id": PID, "source": "Website"}) if tuple_snapshot else selected
    decision = engine._send_contact_email(PID, loaded, "synthetic", "synthetic", "synthetic")
    assert decision.reason == portal.PORTAL_PERSON_ID_UNUSABLE
    assert calls["fresh"] == 0
    assert_no_delivery(engine, calls, before)


@pytest.mark.parametrize("loaded", (
    {"id": True, "source": "Zillow"},
    ({"id": PID + 0.5, "source": "Website"}, {"id": PID, "source": "Realtor.com"}),
))
@pytest.mark.parametrize("requested_id", (PID, True))
def test_wrapper_known_portal_wins_over_invalid_selected_or_requested_identity(sending, loaded, requested_id):
    engine, calls, current = sending
    before = prepare_sent_state(engine)
    decision = engine._send_contact_email(requested_id, loaded, "synthetic", "synthetic", "synthetic")
    assert decision.reason == portal.PORTAL_EXCLUDED
    assert calls["fresh"] == 0
    assert_no_delivery(engine, calls, before)


@pytest.mark.parametrize("selected_id", (PID, str(PID)))
@pytest.mark.parametrize("event_id", (True, PID + 1, "synthetic-event"))
def test_valid_selected_person_proceeds_without_treating_event_id_as_person_id(sending, selected_id, event_id):
    engine, calls, current = sending
    loaded = ({"id": selected_id, "source": "Website"}, {"id": event_id, "eventSource": None})
    assert engine._send_contact_email(PID, loaded, "synthetic", "synthetic", "synthetic").allowed
    assert calls["fresh"] == 1 and calls["send"] == 1


@pytest.mark.parametrize("value,expected", (
    (PID, PID), (str(PID), PID), (True, None), (PID + 0.5, None),
    (float(PID), None), ("0990001", None), ("+990001", None),
    ([], None), (9007199254740992, None),
))
def test_exported_strict_identity_helper(value, expected):
    assert portal.valid_person_id(value) == expected
    assert portal.selected_person_identity_usable({"id": value}, PID) is (expected == PID)
