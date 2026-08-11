"""Telemetry writer tests — status/daily_stats.json + status/activity_log.json.

Every test writes through the REAL AuditDB (its schema, its timestamp format,
its json.dumps of details) and reads back through the real writer. A fixture
that invented its own audit rows would pass while production wrote a shape
this module cannot parse, which is the whole failure this file exists to catch.

The assertions are on file CONTENT, not on "a file appeared" — an empty array
and a correct array both satisfy os.path.exists.
"""
from __future__ import annotations

import datetime as dt
import json
import sqlite3
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from fub_automation import telemetry as tel

CT = ZoneInfo("America/Chicago")
UTC = dt.timezone.utc


# ── Fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture()
def db(m, tmp_path):
    return m.AuditDB(str(tmp_path / "audit.sqlite3"))


@pytest.fixture()
def status_dir(tmp_path):
    return tmp_path / "status"


def at(db_obj, when: dt.datetime, action: str, status: str, person_id, details=None) -> None:
    """Insert an audit row stamped at `when`.

    AuditDB.log() always stamps now(), so backdating goes through the same
    INSERT by hand — same columns, same json.dumps(sort_keys=True) that log()
    uses, so the row is byte-identical to a real one apart from the clock.
    """
    with sqlite3.connect(db_obj.path) as con:
        con.execute(
            "INSERT INTO audit_log(created_at, person_id, action, status, details) VALUES (?, ?, ?, ?, ?)",
            (when.astimezone(UTC).isoformat(), person_id, action, status,
             json.dumps(details or {}, sort_keys=True)),
        )


def tier_at(db_obj, when: dt.datetime, person_id: int, tier: str = "standard") -> None:
    with sqlite3.connect(db_obj.path) as con:
        con.execute(
            "INSERT INTO engagement_tier(person_id, tier, last_classified_at, reason) VALUES (?, ?, ?, ?)",
            (person_id, tier, when.astimezone(UTC).isoformat(), "test"),
        )


def read(db_obj):
    return sqlite3.connect(db_obj.path)


# A fixed "now": mid-afternoon Central, well away from any day boundary.
NOW = dt.datetime(2026, 8, 10, 14, 3, 22, tzinfo=CT).astimezone(UTC)


# ── daily_stats.json ─────────────────────────────────────────────────────────


def test_stats_has_exactly_the_six_contract_keys_with_the_right_types(db):
    stats = tel.daily_stats(read(db), now=NOW)

    assert set(stats) == {
        "date", "emails_sent", "seller_drips_sent",
        "replies_needed", "leads_scored", "last_run_iso",
    }
    assert stats["date"] == "2026-08-10"
    assert stats["last_run_iso"] == "2026-08-10T19:03:22Z"
    for key in ("emails_sent", "seller_drips_sent", "replies_needed", "leads_scored"):
        assert isinstance(stats[key], int), key


def test_emails_sent_counts_every_track_and_seller_is_a_slice_of_it(db):
    at(db, NOW, "pond_nurture", "sent", 1)
    at(db, NOW, "pond_nurture", "sent", 2)
    at(db, NOW, "closed_drip", "sent", 3)
    at(db, NOW, "instant_welcome_email", "sent", 4)
    at(db, NOW, "seller_nurture", "sent", 5)
    at(db, NOW, "seller_nurture", "sent", 6)

    stats = tel.daily_stats(read(db), now=NOW)
    assert stats["emails_sent"] == 6, "seller drips are inside the headline, not beside it"
    assert stats["seller_drips_sent"] == 2


def test_emails_sent_counts_sends_not_people(db):
    """Two emails to one lead is two emails — unlike funnel.CONTACTED."""
    at(db, NOW, "pond_nurture", "sent", 42)
    at(db, NOW - dt.timedelta(hours=2), "closed_drip", "sent", 42)

    assert tel.daily_stats(read(db), now=NOW)["emails_sent"] == 2


def test_non_send_statuses_never_count_as_sent(db):
    for status in ("skipped", "suppressed", "error", "soi_silenced", "launch_cap_reached"):
        at(db, NOW, "pond_nurture", status, 1)

    assert tel.daily_stats(read(db), now=NOW)["emails_sent"] == 0


def test_dry_run_sends_are_not_reported_as_delivered_mail(db):
    """The panel says "mail Peter's leads received". A dry run delivers none.

    funnel.py's CONTACTED accepts dry_run_sent on purpose; this must not, or a
    DRY_RUN=true day puts a fake number on THE FLOOR.
    """
    for pid in range(1, 6):
        at(db, NOW, "pond_nurture", "dry_run_sent", pid)
    at(db, NOW, "seller_nurture", "dry_run_sent", 9)

    stats = tel.daily_stats(read(db), now=NOW)
    assert stats["emails_sent"] == 0
    assert stats["seller_drips_sent"] == 0
    assert stats["last_run_iso"] == "2026-08-10T19:03:22Z", "the bot is still visibly alive"


def test_counts_are_todays_not_lifetime(db):
    at(db, NOW, "pond_nurture", "sent", 1)
    at(db, NOW - dt.timedelta(days=1), "pond_nurture", "sent", 2)
    at(db, NOW - dt.timedelta(days=30), "pond_nurture", "sent", 3)

    assert tel.daily_stats(read(db), now=NOW)["emails_sent"] == 1


def test_the_day_boundary_is_central_not_utc(db):
    """19:00 CT on the 10th is 00:00 UTC on the 11th. A UTC-based day would
    file the evening's sends under tomorrow and show Peter a near-empty panel
    every evening."""
    evening = dt.datetime(2026, 8, 10, 19, 30, tzinfo=CT)
    at(db, evening, "pond_nurture", "sent", 1)

    stats = tel.daily_stats(read(db), now=evening.astimezone(UTC))
    assert stats["date"] == "2026-08-10"
    assert stats["emails_sent"] == 1

    # ...and the same event is excluded once the local day rolls over.
    next_morning = dt.datetime(2026, 8, 11, 8, 0, tzinfo=CT)
    later = tel.daily_stats(read(db), now=next_morning.astimezone(UTC))
    assert later["date"] == "2026-08-11"
    assert later["emails_sent"] == 0


def test_leads_scored_counts_distinct_people_tiered_today(db):
    tier_at(db, NOW, 1, "engaged")
    tier_at(db, NOW - dt.timedelta(hours=3), 2, "cold")
    tier_at(db, NOW - dt.timedelta(days=2), 3, "standard")  # yesterday's classification

    assert tel.daily_stats(read(db), now=NOW)["leads_scored"] == 2


# ── replies_needed — the number that pushes a phone notification ─────────────


def test_replies_needed_counts_open_threads(db):
    at(db, NOW - dt.timedelta(hours=6), "reply_detected", "alert_sent", 11)
    at(db, NOW - dt.timedelta(days=3), "reply_detected", "alert_sent", 12)

    assert tel.count_replies_needed(read(db), NOW) == 2


def test_replies_needed_is_a_backlog_not_a_per_run_count(db):
    """The spurious-notification case: a run where nothing new happens must
    report the same standing number, not drop to 0 and spike again."""
    at(db, NOW - dt.timedelta(days=4), "reply_detected", "alert_sent", 11)
    at(db, NOW - dt.timedelta(days=4), "reply_detected", "alert_sent", 12)

    quiet_run = NOW + dt.timedelta(hours=1)
    assert tel.count_replies_needed(read(db), quiet_run) == 2


def test_a_second_reply_from_the_same_lead_is_still_one_open_thread(db):
    at(db, NOW - dt.timedelta(days=2), "reply_detected", "alert_sent", 11)
    at(db, NOW - dt.timedelta(hours=1), "reply_detected", "alert_sent", 11)

    assert tel.count_replies_needed(read(db), NOW) == 1


def test_a_later_bot_send_closes_the_thread(db):
    """Reply detection tags "Replied - Paused", which suppresses all sending.
    A send after the reply therefore proves a human cleared the tag."""
    at(db, NOW - dt.timedelta(days=5), "reply_detected", "alert_sent", 11)
    at(db, NOW - dt.timedelta(days=1), "pond_nurture", "sent", 11)

    assert tel.count_replies_needed(read(db), NOW) == 0


def test_a_send_before_the_reply_does_not_close_it(db):
    """Ordering matters: every reply is preceded by the email it answered."""
    at(db, NOW - dt.timedelta(days=6), "pond_nurture", "sent", 11)
    at(db, NOW - dt.timedelta(days=5), "reply_detected", "alert_sent", 11)

    assert tel.count_replies_needed(read(db), NOW) == 1


def test_opting_out_closes_the_thread(db):
    at(db, NOW - dt.timedelta(days=2), "reply_detected", "alert_sent", 11)
    at(db, NOW - dt.timedelta(days=2, minutes=-5), "reply_intent_disqualification", "opt_out_trashed", 11)

    assert tel.count_replies_needed(read(db), NOW) == 0


def test_replies_older_than_the_backlog_window_age_out(db):
    at(db, NOW - dt.timedelta(days=tel.REPLY_BACKLOG_DAYS + 1), "reply_detected", "alert_sent", 11)
    at(db, NOW - dt.timedelta(days=1), "reply_detected", "alert_sent", 12)

    assert tel.count_replies_needed(read(db), NOW) == 1


def test_errored_reply_detection_does_not_open_a_thread(db):
    """reply_detected/error means the scan blew up, not that a lead wrote in."""
    at(db, NOW - dt.timedelta(hours=1), "reply_detected", "error", 11, {"error": "boom"})

    assert tel.count_replies_needed(read(db), NOW) == 0


def test_run_level_rows_with_no_person_never_inflate_a_count(db):
    at(db, NOW, "reply_detected", "alert_sent", None)
    at(db, NOW, "pond_nurture", "launch_cap_reached", None, {"cap": 40})

    stats = tel.daily_stats(read(db), now=NOW)
    assert stats["replies_needed"] == 0
    assert stats["emails_sent"] == 0


# ── activity_log.json ────────────────────────────────────────────────────────


def test_every_entry_matches_the_ticker_contract(db):
    at(db, NOW, "pond_nurture", "sent", 1, {"contact_name": "Jane Harper", "city": "Austin"})
    at(db, NOW, "seller_nurture", "sent", 2, {"contact_name": "Ray Ortiz", "email_number": 3})
    at(db, NOW, "reply_detected", "alert_sent", 3, {"contact_name": "Dana Kim", "reply_channel": "email"})
    at(db, NOW, "pond_keyword_reassignment", "completed", 4, {"contact_name": "Sam Poe"})

    entries = tel.activity_entries(read(db), since=NOW - dt.timedelta(days=1))
    assert len(entries) == 4

    for entry in entries:
        assert set(entry) == {"ts", "type", "contact_name", "detail"}
        assert entry["type"] in tel.ACTIVITY_TYPES
        assert entry["ts"].endswith("Z")
        assert len(entry["detail"]) < 60, entry["detail"]
        assert entry["contact_name"] not in entry["detail"], "the ticker prints the name itself"

    by_type = {e["type"]: e for e in entries}
    assert set(by_type) == {"sent", "drip", "needs_reply", "heating_up"}
    assert by_type["drip"]["contact_name"] == "Ray Ortiz"
    assert "3" in by_type["drip"]["detail"]


def test_seller_sends_are_drips_and_other_tracks_are_sent(db):
    at(db, NOW, "seller_nurture", "sent", 1, {"contact_name": "A"})
    at(db, NOW, "long_term_nurture_drip", "sent", 2, {"contact_name": "B", "email_number": 2})
    at(db, NOW, "closed_congrats", "sent", 3, {"contact_name": "C"})

    types = {e["contact_name"]: e["type"] for e in tel.activity_entries(read(db), NOW - dt.timedelta(days=1))}
    assert types == {"A": "drip", "B": "sent", "C": "sent"}


def test_a_row_written_without_a_name_still_renders(db):
    """Rows predating the contact_name field must not vanish from the ticker."""
    at(db, NOW, "pond_nurture", "sent", 507, {"city": "Austin"})

    entries = tel.activity_entries(read(db), NOW - dt.timedelta(days=1))
    assert entries[0]["contact_name"] == "Lead #507"


def test_person_name_key_is_accepted_too(db):
    """reply_intent_disqualification already used "person_name"; the reader
    takes either rather than dropping the name."""
    at(db, NOW, "pond_nurture", "sent", 1, {"person_name": "Ada Reyes"})

    assert tel.activity_entries(read(db), NOW - dt.timedelta(days=1))[0]["contact_name"] == "Ada Reyes"


def test_entries_are_newest_first(db):
    at(db, NOW - dt.timedelta(hours=5), "pond_nurture", "sent", 1, {"contact_name": "Oldest"})
    at(db, NOW - dt.timedelta(hours=1), "pond_nurture", "sent", 2, {"contact_name": "Newest"})
    at(db, NOW - dt.timedelta(hours=3), "pond_nurture", "sent", 3, {"contact_name": "Middle"})

    names = [e["contact_name"] for e in tel.activity_entries(read(db), NOW - dt.timedelta(days=1))]
    assert names == ["Newest", "Middle", "Oldest"]


def test_suppressed_and_dry_run_rows_never_reach_the_ticker(db):
    at(db, NOW, "pond_nurture", "suppressed", 1, {"contact_name": "Nope"})
    at(db, NOW, "pond_nurture", "dry_run_sent", 2, {"contact_name": "Also nope"})

    assert tel.activity_entries(read(db), NOW - dt.timedelta(days=1)) == []


def test_long_details_are_clipped_under_the_ticker_limit(db):
    at(db, NOW, "pond_nurture", "sent", 1,
       {"contact_name": "X", "city": "A" * 200})

    detail = tel.activity_entries(read(db), NOW - dt.timedelta(days=1))[0]["detail"]
    assert len(detail) <= tel.DETAIL_MAX_CHARS


# ── merge / trim ─────────────────────────────────────────────────────────────


def test_merge_keeps_only_the_hundred_most_recent(db):
    for i in range(150):
        at(db, NOW - dt.timedelta(minutes=i), "pond_nurture", "sent", i, {"contact_name": f"Lead {i}"})

    merged = tel.merge_activity([], tel.activity_entries(read(db), NOW - dt.timedelta(days=1)))
    assert len(merged) == tel.MAX_ACTIVITY_ENTRIES == 100
    assert merged[0]["contact_name"] == "Lead 0", "newest survives the trim"


def test_rerunning_does_not_duplicate_entries(db, status_dir):
    """The publish step regenerates after the bot already wrote. Twice must
    look exactly like once."""
    at(db, NOW, "pond_nurture", "sent", 1, {"contact_name": "Jane Harper"})
    at(db, NOW, "seller_nurture", "sent", 2, {"contact_name": "Ray Ortiz", "email_number": 1})

    first = tel.write_status(db.path, str(status_dir), now=NOW)["activity_log"]
    second = tel.write_status(db.path, str(status_dir), now=NOW + dt.timedelta(minutes=5))["activity_log"]

    assert first == second
    assert len(second) == 2


def test_two_events_in_one_second_both_survive(db, status_dir):
    """ts is second-precision by contract. A lead who gets a welcome email and
    a pond nurture email inside the same second must show as two ticker lines,
    not one — found by seeding a realistic day and publishing 69 of 70 events.
    """
    at(db, NOW, "pond_nurture", "sent", 1, {"contact_name": "Jane Harper"})
    at(db, NOW, "instant_welcome_email", "sent", 1, {"contact_name": "Jane Harper"})

    entries = tel.write_status(db.path, str(status_dir), now=NOW)["activity_log"]
    assert len(entries) == 2
    assert {e["detail"] for e in entries} == {"pond nurture email", "instant welcome email"}

    # ...and republishing still must not duplicate them.
    again = tel.write_status(db.path, str(status_dir), now=NOW)["activity_log"]
    assert again == entries


def test_history_older_than_the_db_survives_on_disk(db, status_dir):
    """The state DB is re-pulled every run; the file is the longer memory."""
    status_dir.mkdir(parents=True)
    (status_dir / tel.ACTIVITY_FILENAME).write_text(json.dumps([
        {"ts": "2026-08-09T12:00:00Z", "type": "sent",
         "contact_name": "From yesterday", "detail": "pond nurture email"},
    ]))
    at(db, NOW, "pond_nurture", "sent", 1, {"contact_name": "From today"})

    entries = tel.write_status(db.path, str(status_dir), now=NOW)["activity_log"]
    assert [e["contact_name"] for e in entries] == ["From today", "From yesterday"]


def test_a_corrupt_activity_file_is_replaced_not_propagated(db, status_dir):
    status_dir.mkdir(parents=True)
    (status_dir / tel.ACTIVITY_FILENAME).write_text("{ this is not json")
    at(db, NOW, "pond_nurture", "sent", 1, {"contact_name": "Jane Harper"})

    entries = tel.write_status(db.path, str(status_dir), now=NOW)["activity_log"]
    assert [e["contact_name"] for e in entries] == ["Jane Harper"]


def test_entries_with_an_illegal_type_are_dropped_on_the_way_in(db, status_dir):
    status_dir.mkdir(parents=True)
    (status_dir / tel.ACTIVITY_FILENAME).write_text(json.dumps([
        {"ts": "2026-08-09T12:00:00Z", "type": "explosion", "contact_name": "Bad", "detail": "x"},
        {"ts": "2026-08-09T12:00:00Z", "type": "sent", "contact_name": "Good", "detail": "x"},
        "not even a dict",
    ]))

    entries = tel.write_status(db.path, str(status_dir), now=NOW)["activity_log"]
    assert [e["contact_name"] for e in entries] == ["Good"]


# ── the files themselves ─────────────────────────────────────────────────────


def test_write_status_produces_both_files_and_they_parse(db, status_dir):
    at(db, NOW, "pond_nurture", "sent", 1, {"contact_name": "Jane Harper"})
    tel.write_status(db.path, str(status_dir), now=NOW)

    stats = json.loads((status_dir / tel.STATS_FILENAME).read_text())
    activity = json.loads((status_dir / tel.ACTIVITY_FILENAME).read_text())

    assert stats["date"] == "2026-08-10"
    assert stats["emails_sent"] == 1
    assert isinstance(activity, list)
    assert activity[0]["contact_name"] == "Jane Harper"


def test_files_are_written_whole_or_not_at_all(db, status_dir, monkeypatch):
    """A partial write leaves LIFESTYLE parsing invalid JSON. Kill the write
    mid-flight and the previous good file must still be intact."""
    at(db, NOW, "pond_nurture", "sent", 1, {"contact_name": "Jane Harper"})
    tel.write_status(db.path, str(status_dir), now=NOW)
    good = (status_dir / tel.STATS_FILENAME).read_text()

    real_replace = tel.os.replace

    def explode(src, dst):
        raise OSError("runner died mid-rename")

    monkeypatch.setattr(tel.os, "replace", explode)
    with pytest.raises(OSError):
        tel.write_status(db.path, str(status_dir), now=NOW + dt.timedelta(hours=1))
    monkeypatch.setattr(tel.os, "replace", real_replace)

    assert (status_dir / tel.STATS_FILENAME).read_text() == good
    assert json.loads(good)["emails_sent"] == 1
    leftovers = [p.name for p in status_dir.iterdir() if p.name.endswith(".tmp")]
    assert not leftovers, f"temp files left behind: {leftovers}"


def test_writer_never_mutates_the_audit_db(db, status_dir):
    """Read-only by construction — the connection is opened mode=ro, so a
    stray write raises instead of corrupting state the bot depends on."""
    at(db, NOW, "pond_nurture", "sent", 1, {"contact_name": "Jane Harper"})
    before = Path(db.path).read_bytes()

    tel.write_status(db.path, str(status_dir), now=NOW)

    assert Path(db.path).read_bytes() == before


def test_published_files_are_world_readable(db, status_dir):
    """mkstemp defaults to 0600 and the rename carries the mode across. These
    are dashboard files, not secrets."""
    tel.write_status(db.path, str(status_dir), now=NOW)

    for name in (tel.STATS_FILENAME, tel.ACTIVITY_FILENAME):
        mode = (status_dir / name).stat().st_mode & 0o777
        assert mode == 0o644, f"{name} is {oct(mode)}"


def test_status_dir_is_created_if_missing(db, status_dir):
    assert not status_dir.exists()
    tel.write_status(db.path, str(status_dir), now=NOW)
    assert (status_dir / tel.STATS_FILENAME).exists()


def test_empty_db_reports_zeroes_rather_than_failing(db, status_dir):
    """First run after a state reset. Zeroes and a fresh last_run_iso, not a
    crash and not a missing file."""
    written = tel.write_status(db.path, str(status_dir), now=NOW)

    assert written["daily_stats"] == {
        "date": "2026-08-10",
        "emails_sent": 0,
        "seller_drips_sent": 0,
        "replies_needed": 0,
        "leads_scored": 0,
        "last_run_iso": "2026-08-10T19:03:22Z",
    }
    assert json.loads((status_dir / tel.ACTIVITY_FILENAME).read_text()) == []


# ── the wiring that actually feeds it ────────────────────────────────────────


def test_send_sites_record_the_contact_name(m):
    """The ticker's names come from audit details. If a send site stops writing
    contact_name, every entry silently degrades to "Lead #123" — a change no
    other test in this repo would notice."""
    source = Path(m.__file__).read_text()

    for marker in (
        '"pond_nurture", _send_status',
        '"closed_drip", _send_status',
        '"long_term_nurture_drip", _send_status',
        '"closed_congrats", _send_status',
        '"instant_welcome_email", _send_status',
        '"reply_detected", "alert_sent"',
        '"pond_keyword_reassignment", "completed"',
    ):
        start = source.index(marker)
        call = source[start:start + 700]
        assert "contact_name" in call, f"{marker} no longer records contact_name"

    # The seller track builds its details dict a few lines above the log call.
    seller = source.index("_audit_details = {")
    assert "contact_name" in source[seller:seller + 400]


@pytest.fixture()
def live_engine(m, engine, monkeypatch):
    """A real RuleEngine that can complete a send with no network — same
    arrangement as test_audit_regressions.seller_engine."""
    engine.sent = []
    monkeypatch.setattr(engine.email, "send",
                        lambda to, subject, body, **kw: engine.sent.append(to))
    monkeypatch.setattr(engine, "safe_get_notes", lambda pid: [])
    monkeypatch.setattr(engine, "_is_soi_silenced", lambda person: None)
    monkeypatch.setattr(engine.content, "should_skip_lead_llm", lambda p, n: (False, ""))
    monkeypatch.setattr(engine.content, "_llm_call",
                        lambda **kw: '{"subject": "Your home", "email_body": "Hey there."}')
    monkeypatch.setattr(engine.fub, "add_note", lambda *a, **k: None)
    return engine


def test_a_real_send_reaches_the_ticker_with_the_leads_name(live_engine, status_dir, tmp_path):
    """End to end through the production code path, not a hand-written row.

    This is the test that fails if the audit details ever stop carrying the
    name: nothing else here proves the writer and the sender agree about the
    shape of a row.
    """
    live_engine.settings.dry_run = False
    person = {"id": 9101, "firstName": "Dana", "lastName": "Lee",
              "tags": ["Seller Lead"], "emails": [{"value": "dana@example.com"}]}

    assert live_engine.process_seller_nurture_candidate(person) == "sent"
    assert live_engine.sent == ["dana@example.com"], "the email really went out"

    written = tel.write_status(live_engine.db.path, str(status_dir))

    assert written["daily_stats"]["emails_sent"] == 1
    assert written["daily_stats"]["seller_drips_sent"] == 1
    entry = written["activity_log"][0]
    assert entry["contact_name"] == "Dana Lee"
    assert entry["type"] == "drip"
    assert "1" in entry["detail"]


def test_the_daily_runner_imports_telemetry_the_way_production_resolves_it(m):
    """Guards the ModuleNotFoundError-swallowed-by-except trap: the bare
    `fub_automation.` form does not resolve from run_approved_daily_automation.py,
    and the failure would only ever surface as a printed warning."""
    runner = Path(m.__file__).resolve().parents[2] / "run_approved_daily_automation.py"
    text = runner.read_text()

    assert "from src.fub_automation.telemetry import" in text
    assert "from fub_automation.telemetry import" not in text
    assert "finally:" in text and "write_run_telemetry()" in text
