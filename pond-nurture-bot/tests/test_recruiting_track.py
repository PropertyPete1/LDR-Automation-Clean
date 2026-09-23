"""The recruiting track — and the four pins Peter set for it.

FUB contacts from a recruiting source ("New Agent Inquiry", "Agent Scouting")
are licensed Texas agents answering recruiting posts, not leads. On 2026-09-20
an import of 1,590 Agent Scouting contacts went through speed-to-lead as buyer
leads — 1,771 timers, 179 agent alerts, 2,209 reassignments to Peter — because
only "New Agent Inquiry" was excluded, and only on five of the lead paths.

  1. a recruiting-source contact never receives buyer nurture;
  2. a buyer never receives recruiting;
  3. the three-week spacing holds;
  4. an unsubscribe stops both tracks.

Plus the rules the copy keeps (recruiting.py) and the reply lane: a recruit's
answer reaches the reply queue tagged "recruiting", never as a lead.
"""
from __future__ import annotations

import datetime as dt
import json

import pytest

from fub_automation import recruiting as rt
from fub_automation import telemetry
from fub_automation.mailbox import strip_quoted_reply

UTC = dt.timezone.utc
NOW = dt.datetime.now(UTC).replace(microsecond=0)
PHONE = "520.373.7839"


def person(pid, source, *, created_days_ago=2.0, **extra):
    record = {
        "id": pid,
        "firstName": f"Agent{pid}",
        "lastName": "Tester",
        "source": source,
        "stage": "Agent Scouting" if "scouting" in source.lower() else "Lead",
        "tags": [],
        "emails": [{"value": f"agent{pid}@example.com"}],
        "created": (NOW - dt.timedelta(days=created_days_ago)).isoformat(),
        "assignedUserId": 1,
    }
    record.update(extra)
    return record


@pytest.fixture()
def track(engine, monkeypatch):
    """The engine with FUB and SMTP stood in: `book` is FUB, `sent` the outbox."""
    sent: list = []
    book: dict = {}
    monkeypatch.setattr(
        engine.email, "send",
        lambda to, subject, body, **kw: sent.append({"to": to, "subject": subject, "body": body, **kw}))
    monkeypatch.setattr(engine.fub, "update_person", lambda *a, **k: {})
    monkeypatch.setattr(engine.fub, "add_note", lambda *a, **k: {})
    monkeypatch.setattr(engine, "user_cache_by_id", lambda: {})

    def get_people(**params):
        after = params.get("createdAfter")
        cutoff = dt.datetime.strptime(after, "%Y-%m-%d %H:%M:%S").replace(tzinfo=UTC) if after else None
        return [p for p in book.values()
                if cutoff is None or dt.datetime.fromisoformat(p["created"]) >= cutoff]

    monkeypatch.setattr(engine.fub, "get_people", get_people)
    monkeypatch.setattr(engine.fub, "get_person", lambda pid: book.get(int(pid)))
    engine.sent = sent
    engine.book = book
    return engine


def audit(db, action, since_days=60):
    return db.recent_audit_rows([action], NOW - dt.timedelta(days=since_days))


# ── Configuration ─────────────────────────────────────────────────────────────

def test_the_rules_file_names_both_sources_and_peters_number(rules):
    assert rules.recruiting_sources == ["new agent inquiry", "agent scouting"]
    assert rules.recruiting_track_enabled is True
    assert rules.recruiting_cadence_days == 21
    assert rules.recruiting_first_send_window_days == 30
    assert rules.recruiting_daily_cap_ramp == [50, 100, 150]
    assert rules.owner_phone == PHONE


def test_a_recruiting_source_is_matched_the_bots_contains_way(engine):
    for source in ("Agent Scouting", "New Agent Inquiry", "new agent inquiry - Facebook",
                   "LinkedIn Agent Scouting", "  AGENT SCOUTING  "):
        assert engine.recruiting_source({"source": source}), source
    for source in ("Zillow", "Realtor.com", "Agent", "Agent Inquiry", "", None):
        assert engine.recruiting_source({"source": source}) is None, source


def test_every_shared_suppression_copy_excludes_agent_scouting():
    from pathlib import Path
    root = Path(__file__).resolve().parents[2]
    for copy in ("pond-nurture-bot", "lifestyle-bot-dashboard", "nurture-dashboard"):
        shared = json.loads((root / copy / "config" / "suppression_tags.json").read_text())
        assert "Agent Scouting" in shared["excluded_sources"], copy


# ── Pin 1: a recruit never receives buyer nurture ────────────────────────────

def test_the_central_gate_refuses_a_recruit_however_clean(engine):
    recruit = person(7, "Agent Scouting")
    assert engine.is_excluded(recruit) is True
    assert engine._is_excluded_source(recruit)
    assert engine.is_excluded(person(8, "Zillow")) is False


def test_pond_nurture_never_emails_a_recruit(track):
    recruit = person(7, "Agent Scouting", assignedPondId=2)
    recruit.pop("assignedUserId")
    assert track.process_reengagement_candidate(recruit) == "suppressed"
    assert track.sent == []


def test_seller_nurture_never_emails_a_recruit(track):
    recruit = person(7, "New Agent Inquiry", assignedPondId=2, tags=["Seller Lead"])
    assert track.process_seller_nurture_candidate(recruit) == "suppressed"
    assert track.sent == []


def test_the_closed_drip_congrats_and_long_term_nurture_never_email_a_recruit(track, tmp_db):
    closed = person(7, "Agent Scouting", stage="Closed")
    assert track.process_closed_drip_candidate(closed) in ("suppressed", "skipped")
    assert track.process_congrats_candidate(closed) == "suppressed"
    long_term = person(8, "Agent Scouting", tags=["long-term-nurture"], stage="Nurture")
    assert track.process_long_term_nurture_candidate(long_term) == "suppressed"
    assert track.sent == []
    reasons = [json.loads(r["details"]).get("reason", "") for r in audit(tmp_db, "closed_congrats")]
    assert reasons == ["recruiting source: Agent Scouting"]


def test_the_welcome_email_never_goes_to_a_recruit(track):
    track.book[7] = person(7, "Agent Scouting")
    assert track.send_instant_welcome_email(7) == "skipped"
    assert track.sent == []


def test_speed_to_lead_never_arms_a_timer_for_a_recruit(track, tmp_db):
    """The 2026-09-20 import: a recruit assigned to Steven looked like a new buyer lead."""
    track.book[7] = person(7, "Agent Scouting", created_days_ago=0.01)
    track.book[8] = person(8, "Zillow", created_days_ago=0.01)
    track.poll_new_leads()
    armed = {int(r["person_id"]) for r in tmp_db.active_new_lead_timers()}
    assert 8 in armed, "control: the buyer created beside him IS timed"
    assert 7 not in armed


def test_a_timer_armed_before_this_fix_is_cancelled_never_reassigned(track, tmp_db, monkeypatch):
    """1,771 of these were armed on 2026-09-20/21."""
    writes = []
    monkeypatch.setattr(track.fub, "update_person", lambda pid, payload, **k: writes.append((pid, payload)) or {})
    monkeypatch.setattr(track.fub, "create_task", lambda *a, **k: writes.append(("task", a)) or {}, raising=False)
    track.book[7] = person(7, "Agent Scouting")
    tmp_db.add_new_lead_timer(7, 1)
    with tmp_db.connect() as con:  # well past the 60-minute reassignment
        con.execute("UPDATE new_lead_timers SET created_at=?", ((NOW - dt.timedelta(days=2)).isoformat(),))
    track.process_new_lead_timers()
    assert writes == [], "no reassignment, no warning task, no tag"
    assert track.sent == [], "no 'Lead Reassigned' email to Peter"
    assert [r["status"] for r in audit(tmp_db, "new_lead_timer")] == ["canceled_recruiting_source"]
    assert tmp_db.active_new_lead_timers() == []


def test_the_stale_agent_sweep_never_moves_a_recruit_into_the_nurture_pond(track, monkeypatch):
    moves = []
    monkeypatch.setattr(track.fub, "update_person", lambda pid, payload, **k: moves.append(payload) or {})
    recruit = person(7, "Agent Scouting", created_days_ago=45)
    assert track.process_stale_agent_no_note_candidate(recruit) in ("suppressed", "soi_protected")
    assert moves == []


# ── Pin 2: a buyer never receives recruiting ─────────────────────────────────

def test_a_buyer_is_never_enrolled_or_emailed_by_the_recruiting_track(track, tmp_db):
    track.book[5] = person(5, "Zillow")
    track.book[6] = person(6, "Realtor.com")
    track.book[7] = person(7, "Agent Scouting")
    counts = track.scan_recruiting_track(now=NOW)
    assert [mail["to"] for mail in track.sent] == ["agent7@example.com"]
    assert set(tmp_db.recruiting_enrollments()) == {7}
    assert counts["sent"] == 1


def test_a_send_to_someone_whose_source_is_no_longer_recruiting_is_refused(track):
    assert track._send_recruiting_email(person(5, "Zillow"), {}, NOW) == "suppressed"
    assert track.sent == []


# ── Pin 3: the three-week spacing holds ──────────────────────────────────────

def test_one_email_every_three_weeks_never_sooner(track, tmp_db):
    track.book[7] = person(7, "Agent Scouting", created_days_ago=1)
    track.scan_recruiting_track(now=NOW)
    track.scan_recruiting_track(now=NOW + dt.timedelta(hours=3))   # a re-run the same day
    track.scan_recruiting_track(now=NOW + dt.timedelta(days=20, hours=23))
    assert len(track.sent) == 1, "nothing before a full 21 days"
    track.scan_recruiting_track(now=NOW + dt.timedelta(days=21))
    assert len(track.sent) == 2
    row = tmp_db.recruiting_enrollments()[7]
    assert row["emails_sent"] == 2
    first_angle, second_angle = [json.loads(r["details"])["angle"]
                                 for r in sorted(audit(tmp_db, rt.RECRUITING_AUDIT_ACTION),
                                                 key=lambda r: json.loads(r["details"])["email_number"])]
    assert first_angle != second_angle


def test_a_claimed_email_is_never_sent_twice(track, tmp_db):
    """A crash after the SMTP handoff leaves the claim: the retry refuses."""
    tmp_db.enroll_recruit(7, "Agent Scouting", NOW.isoformat())
    assert tmp_db.claim_recruiting_send(7, 1) is True
    status = track._send_recruiting_email(person(7, "Agent Scouting"), {"emails_sent": 0}, NOW)
    assert status == "skipped" and track.sent == []


def test_the_daily_cap_ramps_and_the_rest_wait_their_turn(track, tmp_db):
    for pid in range(100, 160):
        track.book[pid] = person(pid, "Agent Scouting", created_days_ago=1)
    counts = track.scan_recruiting_track(now=NOW)
    assert counts["sent"] == 50 and counts["capped"] == 10
    assert len(tmp_db.recruiting_enrollments()) == 60, "all enrolled on sight, whatever the cap"
    track.scan_recruiting_track(now=NOW + dt.timedelta(days=1))
    assert len(track.sent) == 60
    assert len({mail["to"] for mail in track.sent}) == 60, "each recruit's first email exactly once"


def test_the_first_send_window_is_thirty_days_and_an_enrolled_recruit_stays_owed(track, tmp_db):
    track.book[7] = person(7, "Agent Scouting", created_days_ago=31)
    track.scan_recruiting_track(now=NOW)
    assert track.sent == [] and tmp_db.recruiting_enrollments() == {}
    # Enrolled inside the window, first send deferred past it: still owed.
    tmp_db.enroll_recruit(8, "Agent Scouting", (NOW - dt.timedelta(days=40)).isoformat())
    track.book[8] = person(8, "Agent Scouting", created_days_ago=45)
    track.scan_recruiting_track(now=NOW)
    assert [mail["to"] for mail in track.sent] == ["agent8@example.com"]


def test_an_agent_or_realtor_tag_never_stops_the_recruiting_email(track):
    """Every lead gate treats those tags as 'never email' — on a recruit they are
    simply what he is. Every other suppression still applies."""
    track.book[7] = person(7, "Agent Scouting", tags=["Agent", "Realtor", "import"])
    track.book[8] = person(8, "Agent Scouting", tags=["Agent", "Do Not Email"])
    track.book[9] = person(9, "Agent Scouting", tags=["Replied - Paused"])
    track.scan_recruiting_track(now=NOW)
    assert [mail["to"] for mail in track.sent] == ["agent7@example.com"]


# ── Pin 4: an unsubscribe stops both tracks ──────────────────────────────────

def test_one_ledger_row_stops_the_recruiting_track_and_every_lead_path(track, tmp_db):
    tmp_db.record_opt_out(7, NOW.isoformat(), "email", "reply_detection_keyword", "UNSUBSCRIBE")
    track._opted_out_cache = None
    track.book[7] = person(7, "Agent Scouting")
    track.scan_recruiting_track(now=NOW)
    assert track.sent == []
    assert json.loads(audit(tmp_db, rt.RECRUITING_AUDIT_ACTION)[0]["details"])["reason"] == "opted out (ledger)"
    # The same row closes the buyer side for the same person, whatever the source says.
    assert track.is_excluded(person(7, "Zillow")) is True
    assert track.process_congrats_candidate(person(7, "Zillow")) == "suppressed"
    assert track.process_long_term_nurture_candidate(person(7, "Zillow")) == "suppressed"


def _seed_recruiting_send(db, pid, when):
    db.log(rt.RECRUITING_AUDIT_ACTION, "sent", pid, {"email_number": 1, "angle": "boutique"})
    with db.connect() as con:
        con.execute("UPDATE audit_log SET created_at=? WHERE person_id=? AND action=?",
                    (when.isoformat(), pid, rt.RECRUITING_AUDIT_ACTION))


def _inbound(pid, body, when):
    return {"id": 1, "personId": pid, "isIncoming": True, "subject": "Re: Lease commissions paid upfront",
            "body": body, "created": when.isoformat()}


def test_a_recruits_unsubscribe_reply_is_written_to_the_shared_ledger(track, tmp_db, fake_http):
    sent_at = NOW - dt.timedelta(hours=5)
    _seed_recruiting_send(tmp_db, 7, sent_at)
    track.book[7] = person(7, "Agent Scouting")
    fake_http.responses = [  # get_person reads the book; FUB answers emails, then texts
        (200, {"emails": [_inbound(7, "UNSUBSCRIBE", sent_at + dt.timedelta(hours=2))]}),
        (200, {"textMessages": []}),
    ]
    track.scan_reply_detection()
    assert 7 in tmp_db.opted_out_ids(), "the recruit's opt-out reaches the ledger both tracks read"
    track._opted_out_cache = None
    assert track.recruiting_suppressed(person(7, "Agent Scouting")) == "opted out (ledger)"


# ── The reply lane: tagged "recruiting", never a lead ────────────────────────

def test_a_recruits_reply_reaches_the_queue_tagged_recruiting_with_no_lead_alert(track, tmp_db, fake_http, monkeypatch):
    tags = []
    monkeypatch.setattr(track.fub, "update_person",
                        lambda pid, payload, **k: tags.extend(payload.get("tags") or []) or {})
    sent_at = NOW - dt.timedelta(hours=5)
    _seed_recruiting_send(tmp_db, 7, sent_at)
    track.book[7] = person(7, "Agent Scouting")
    fake_http.responses = [  # get_person reads the book; FUB answers emails, then texts
        (200, {"emails": [_inbound(7, "Maybe — what's the split?", sent_at + dt.timedelta(hours=2))]}),
        (200, {"textMessages": []}),
    ]
    track.scan_reply_detection()
    alerts = [r for r in audit(tmp_db, "reply_detected") if r["status"] == "alert_sent"]
    assert len(alerts) == 1
    details = json.loads(alerts[0]["details"])
    assert details["track"] == "recruiting" and details["recruiting_source"] == "Agent Scouting"
    assert "agent_email" not in details
    assert track.sent == [], "no HOT LEAD REPLY email for a recruit"
    assert "Replied - Paused" in tags, "the pause stops the recruiting emails until someone answers"
    assert track._collect_needs_reply() == [], "never in the daily summary's lead list"


def test_telemetry_carries_the_track_and_keeps_replies_needed_leads_only(tmp_db):
    tmp_db.log("reply_detected", "alert_sent", 7,
               {"contact_name": "Sam Scout", "reply_channel": "email", "track": "recruiting"})
    tmp_db.log("reply_detected", "alert_sent", 8, {"contact_name": "Bella Buyer", "reply_channel": "email"})
    import sqlite3
    con = sqlite3.connect(tmp_db.path)
    try:
        entries = telemetry.activity_entries(con, NOW - dt.timedelta(days=1))
        assert telemetry.count_replies_needed(con, dt.datetime.now(UTC)) == 1
    finally:
        con.close()
    by_name = {e["contact_name"]: e for e in entries}
    assert by_name["Sam Scout"]["track"] == "recruiting"
    assert "track" not in by_name["Bella Buyer"]
    merged = telemetry.merge_activity([], entries)
    assert {e["contact_name"]: e.get("track") for e in merged} == {"Sam Scout": "recruiting", "Bella Buyer": None}


# ── The copy's rules ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("angle", rt.ANGLES, ids=lambda a: a.key)
@pytest.mark.parametrize("number", [1, 2, 7])
def test_every_email_keeps_the_rules(angle, number):
    subject, body = rt.compose_recruiting_email("Maria", angle, number, PHONE)
    assert len(subject.split()) < 8, subject
    assert body.count("?") == 1, "exactly one question"
    lines = [line for line in body.split("\n\n") if line]
    assert lines[-3].endswith("?"), "the question is the last thing asked, right before the close"
    assert lines[-2] == f"Reply here or text me at {PHONE}."
    assert (rt.LICENSE_LINE in body) is (number == 1), "the license requirement, once, in the first email"
    assert lines[0] == "Hi Maria,"


def test_the_rotation_never_repeats_an_angle_back_to_back_and_uses_all_six():
    for pid in range(0, 50):
        keys = [rt.angle_for(pid, n).key for n in range(12)]
        assert all(a != b for a, b in zip(keys, keys[1:]))
        assert set(keys[:6]) == set(rt.ANGLE_KEYS)


def test_the_sent_email_is_from_peter_with_his_number_and_a_footer_the_bridge_cuts(track):
    track.book[7] = person(7, "Agent Scouting")
    track.scan_recruiting_track(now=NOW)
    (mail,) = track.sent
    assert mail["from_email"] == "Peter Allen <peter@lifestyledesignrealty.com>"
    assert mail["reply_to"] == "peter@lifestyledesignrealty.com"
    assert f"Reply here or text me at {PHONE}." in mail["body"]
    assert "Information About Brokerage Services" in mail["body"] and "reply UNSUBSCRIBE" in mail["body"]
    # A reply quoting us with no marker at all is still cut at our footer, so
    # OUR unsubscribe line can never read as the agent's own words.
    for quoted in (f"Tell me more\n\n{mail['body']}", f"Sounds good\n{mail['body']}"):
        top = strip_quoted_reply(quoted)
        assert "unsubscribe" not in top.lower()
        assert "Information About Brokerage Services" not in top
    gmail = f"Tell me more\n\nOn Tue, Sep 23, 2026 at 7:05 AM Peter Allen wrote:\n> {mail['body']}"
    assert strip_quoted_reply(gmail) == "Tell me more"


def test_no_number_in_config_means_nothing_is_sent(track, tmp_db):
    track.rules.owner_phone = ""
    track.book[7] = person(7, "Agent Scouting")
    track.scan_recruiting_track(now=NOW)
    assert track.sent == []
    assert [r["status"] for r in audit(tmp_db, rt.RECRUITING_AUDIT_ACTION)] == ["refused"]


def test_the_number_comes_from_config(track):
    track.rules.owner_phone = "512-555-0100"
    track.book[7] = person(7, "Agent Scouting")
    track.scan_recruiting_track(now=NOW)
    assert "Reply here or text me at 512-555-0100." in track.sent[0]["body"]


def test_the_daily_runner_runs_the_recruiting_track():
    from pathlib import Path
    runner = (Path(__file__).resolve().parents[1] / "run_approved_daily_automation.py").read_text()
    assert "engine.scan_recruiting_track()" in runner
