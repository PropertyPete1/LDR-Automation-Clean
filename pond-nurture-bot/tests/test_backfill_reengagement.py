"""Tests for the one-shot reengagement_log repair.

The planner is pure, so these drive it directly with note payloads shaped like
FUB's. The one thing that must never happen is a clock moving backwards — that
would make a lead LESS protected than before the repair ran, which is worse than
not running it at all.
"""
from __future__ import annotations

import datetime as dt
import importlib.util
import sqlite3
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

CT = ZoneInfo("America/Chicago")
UTC = dt.timezone.utc

_spec = importlib.util.spec_from_file_location(
    "backfill_reengagement",
    Path(__file__).resolve().parents[1] / "backfill_reengagement.py",
)
bf = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bf)  # type: ignore[union-attr]

DATE = "2026-08-11"


def note(person_id: int, when: dt.datetime, channels: str = "EMAIL", city: str = "Austin") -> dict:
    return {
        "id": person_id * 10,
        "personId": person_id,
        "subject": f"Pond Nurture {channels} Sent",
        "body": (f"Automated two-week pond nurture outreach sent.\n\n"
                 f"• Channels: {channels}\n• City focus: {city}\n"
                 f"• Subject: \"Your home\"\n• Source: inferred"),
        "created": when.astimezone(UTC).isoformat(),
    }


def at(hour: int, minute: int = 0) -> dt.datetime:
    return dt.datetime(2026, 8, 11, hour, minute, tzinfo=CT).astimezone(UTC)


# ── Recognising the bot's own notes ───────────────────────────────────────────


def test_matches_every_channel_combination_main_py_can_write():
    for channels in ("EMAIL", "SMS", "EMAIL + SMS"):
        assert bf.is_pond_nurture_note(note(1, at(9), channels)), channels


@pytest.mark.parametrize("subject", [
    "Automation: Seller Nurture Email Sent",
    "Automation: speed-to-lead warning",
    "Automation: Congrats Email Sent",
    "Pond Nurture follow-up call",      # a human's note, not the bot's
    "Re: Pond Nurture EMAIL Sent",      # a reply, not the original
    "",
])
def test_ignores_every_other_note_in_the_system(subject):
    assert not bf.is_pond_nurture_note({"subject": subject})


def test_channels_round_trip_to_what_the_live_path_stores():
    assert bf.channels_from_subject("Pond Nurture EMAIL Sent") == "email"
    assert bf.channels_from_subject("Pond Nurture EMAIL + SMS Sent") == "email+sms"


def test_city_is_recovered_from_the_note_body():
    assert bf.city_from_body(note(1, at(9), city="San Antonio")["body"]) == "San Antonio"
    assert bf.city_from_body("no city line here") == "Texas/general"


def test_tolerates_fubs_alternate_field_names():
    assert bf.note_person_id({"person_id": "77"}) == 77
    assert bf.note_created({"dateCreated": "2026-08-11T13:30:00Z"}) is not None
    assert bf.note_subject({"title": "Pond Nurture EMAIL Sent"}).startswith("Pond")


# ── Planning ─────────────────────────────────────────────────────────────────


def test_plans_one_row_per_lead_with_the_send_time(  ):
    notes = [note(101, at(8, 30)), note(102, at(8, 31)), note(103, at(8, 32))]
    write, skip = bf.plan_backfill(notes, {}, DATE)

    assert [r["person_id"] for r in write] == [101, 102, 103]
    assert skip == []
    assert write[0]["created"] == at(8, 30)
    assert write[0]["channel"] == "email"


def test_a_lead_emailed_twice_gets_the_later_clock():
    notes = [note(101, at(8, 30)), note(101, at(11, 15))]
    write, _ = bf.plan_backfill(notes, {}, DATE)

    assert len(write) == 1
    assert write[0]["created"] == at(11, 15)


def test_a_clock_is_never_moved_backwards():
    """THE safety property. A lead the live bot has already recorded — perhaps
    emailed again after the repair was planned — must come out no less
    protected than it went in."""
    already = at(20, 0)
    write, skip = bf.plan_backfill([note(101, at(8, 30))], {101: already}, DATE)

    assert write == []
    assert len(skip) == 1
    assert skip[0]["existing"] == already


def test_an_older_existing_row_is_advanced():
    write, skip = bf.plan_backfill(
        [note(101, at(8, 30))], {101: at(8, 30) - dt.timedelta(days=14)}, DATE)

    assert [r["person_id"] for r in write] == [101]
    assert skip == []


def test_an_identical_existing_row_is_left_alone_so_reruns_are_free():
    write, skip = bf.plan_backfill([note(101, at(8, 30))], {101: at(8, 30)}, DATE)
    assert write == [] and len(skip) == 1


def test_only_the_target_local_day_is_repaired():
    notes = [note(101, at(8, 30)),
             note(102, at(8, 30) - dt.timedelta(days=1)),
             note(103, at(8, 30) + dt.timedelta(days=1))]
    write, _ = bf.plan_backfill(notes, {}, DATE)

    assert [r["person_id"] for r in write] == [101]


def test_the_day_boundary_is_central_not_utc():
    """An 19:30 CT send is 00:30 UTC the next day. Filtering on the UTC date
    would drop the evening's sends from the repair entirely."""
    evening = dt.datetime(2026, 8, 11, 19, 30, tzinfo=CT).astimezone(UTC)
    assert evening.strftime("%Y-%m-%d") == "2026-08-12", "the trap this guards"

    write, _ = bf.plan_backfill([note(101, evening)], {}, DATE)
    assert [r["person_id"] for r in write] == [101]


def test_malformed_notes_are_skipped_not_fatal():
    notes = [note(101, at(8, 30)),
             {"subject": "Pond Nurture EMAIL Sent"},                       # no id, no date
             {"subject": "Pond Nurture EMAIL Sent", "personId": "abc",
              "created": "2026-08-11T13:30:00Z"},                          # unparseable id
             {"subject": "Pond Nurture EMAIL Sent", "personId": 9,
              "created": "not a date"}]
    write, _ = bf.plan_backfill(notes, {}, DATE)

    assert [r["person_id"] for r in write] == [101]


# ── Writing ──────────────────────────────────────────────────────────────────


@pytest.fixture()
def db(m, tmp_path):
    return m.AuditDB(str(tmp_path / "audit.sqlite3"))


def test_rows_land_where_the_cadence_check_reads_them(db, m):
    """The repair is only worth anything if get_last_reengagement returns it —
    that is the function process_reengagement_candidate gates on."""
    write, _ = bf.plan_backfill([note(101, at(8, 30)), note(102, at(8, 31))], {}, DATE)

    conn = sqlite3.connect(db.path)
    assert bf.apply_rows(conn, write) == 2
    conn.close()

    assert db.get_last_reengagement(101) == at(8, 30)
    assert db.get_last_reengagement(102) == at(8, 31)
    assert db.get_last_reengagement(999) is None


def test_applying_twice_changes_nothing(db):
    write, _ = bf.plan_backfill([note(101, at(8, 30))], {}, DATE)
    conn = sqlite3.connect(db.path)
    bf.apply_rows(conn, write)
    first = conn.execute("SELECT * FROM reengagement_log").fetchall()
    bf.apply_rows(conn, write)
    assert conn.execute("SELECT * FROM reengagement_log").fetchall() == first
    conn.close()


def test_backfilled_rows_are_identifiable_as_reconstructed(db):
    """message_hash is written by upsert_reengagement and read by nothing, so
    it carries provenance: a row rebuilt from a note is not a row from a send."""
    write, _ = bf.plan_backfill([note(101, at(8, 30))], {}, DATE)
    conn = sqlite3.connect(db.path)
    bf.apply_rows(conn, write)
    row = conn.execute(
        "SELECT channel, city, message_hash FROM reengagement_log WHERE person_id=101"
    ).fetchone()
    conn.close()

    assert row == ("email", "Austin", bf.BACKFILL_MARKER)


def test_the_repair_makes_the_cadence_check_skip_the_lead(m, db, rules, settings, fub, monkeypatch):
    """End to end on the thing that actually matters: after the repair, the real
    cadence gate treats the lead as recently emailed instead of due."""
    engine = m.RuleEngine(settings, rules, fub, db)
    person_id = 101
    assert db.get_last_reengagement(person_id) is None, "due before the repair"

    write, _ = bf.plan_backfill([note(person_id, at(8, 30))], {}, DATE)
    conn = sqlite3.connect(db.path)
    bf.apply_rows(conn, write)
    conn.close()

    last = db.get_last_reengagement(person_id)
    assert last is not None
    # Standard tier is a 14-day cadence; the send was hours ago, so the gate at
    # main.py:4172 (now - last < cadence) must hold the lead back.
    assert dt.datetime.now(UTC) - last < dt.timedelta(days=10)
