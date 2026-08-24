"""backfill_missed_replies.py — the retroactive repair of the blind fortnight.

Drives the same classifier the live scanner uses over canned FUB message
histories shaped like the real misses: Joe Muñoz (two real replies to a July
thread), Stephen Herrera ("UNSUBSCRIBE"), and the same-second autoresponders.

No network: engine.fub methods are monkeypatched per test.
"""
from __future__ import annotations

import datetime as dt
import importlib.util
import json
from pathlib import Path

import pytest

UTC = dt.timezone.utc

_spec = importlib.util.spec_from_file_location(
    "backfill_missed_replies",
    Path(__file__).resolve().parents[1] / "backfill_missed_replies.py",
)
bmr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bmr)  # type: ignore[union-attr]

NOW = dt.datetime.now(UTC)
WINDOW_START = NOW - dt.timedelta(days=14)


def _email(when, *, inbound, body, subject="Re: your home search", **extra):
    return {"isIncoming": inbound, "subject": subject, "body": body,
            "created": when.isoformat(), **extra}


def _person(pid=42, name=("Joe", "Muñoz"), tags=()):
    return {"id": pid, "firstName": name[0], "lastName": name[1],
            "tags": list(tags), "stage": "Lead"}


@pytest.fixture()
def wired(engine, tmp_db, monkeypatch):
    """Engine with recorded FUB writes and a place to hang canned reads."""
    calls = {"update_person": [], "add_note": [], "emails": [], "texts": []}
    monkeypatch.setattr(engine.fub, "update_person",
                        lambda pid, payload, **kw: calls["update_person"].append((pid, payload)) or {})
    monkeypatch.setattr(engine.fub, "add_note",
                        lambda pid, subject, body: calls["add_note"].append((pid, subject)) or {})
    monkeypatch.setattr(engine.fub, "get_emails", lambda pid, limit=25: calls["emails"])
    monkeypatch.setattr(engine.fub, "get_text_messages", lambda pid, limit=25: calls["texts"])
    engine._calls = calls
    return engine


# ── the pieces ───────────────────────────────────────────────────────────────

def test_latest_outbound_before_anchors_the_timing_heuristic():
    send1 = NOW - dt.timedelta(days=3)
    send2 = NOW - dt.timedelta(days=1)
    reply = NOW - dt.timedelta(hours=1)
    messages = [
        _email(send1, inbound=False, body="checking in"),
        _email(send2, inbound=False, body="still looking?"),
        _email(reply, inbound=True, body="yes"),
    ]
    assert bmr.latest_outbound_before(messages, reply) == send2
    assert bmr.latest_outbound_before(messages, send2) == send1
    assert bmr.latest_outbound_before([_email(reply, inbound=True, body="x")], reply) is None


def test_classify_window_reproduces_all_three_miss_shapes(wired):
    send = NOW - dt.timedelta(days=2)
    messages = [
        _email(send, inbound=False, body="pond email"),
        _email(send + dt.timedelta(seconds=2), inbound=True,
               body="Thanks, I'll reply soon"),                       # Ingrid/Claudette
        _email(send + dt.timedelta(hours=25), inbound=True,
               body="UNSUBSCRIBE"),                                   # Stephen
        _email(send + dt.timedelta(hours=30), inbound=True,
               body="Actually yes — what's on Elm street?"),          # Joe
    ]
    kinds = [kind for _, _, kind in bmr.classify_window(wired, messages, WINDOW_START)]
    assert kinds == ["auto_reply", "opt_out", "human"]


def test_a_reply_with_no_outbound_in_history_cannot_be_timing_classified(wired):
    """Joe's July 4 send is outside the fetched history: no anchor, so the
    2-second heuristic must not fire on an arbitrary epoch."""
    reply = NOW - dt.timedelta(days=2)
    messages = [_email(reply, inbound=True, body="Is the Elm house still available?")]
    kinds = [kind for _, _, kind in bmr.classify_window(wired, messages, WINDOW_START)]
    assert kinds == ["human"]


# ── processing one person ────────────────────────────────────────────────────

def test_a_missed_human_reply_is_tagged_and_backdated(wired, tmp_db):
    reply_at = NOW - dt.timedelta(days=2, hours=7)
    wired._calls["emails"] = [
        _email(reply_at - dt.timedelta(days=1), inbound=False, body="pond email"),
        _email(reply_at, inbound=True, body="Yes! Still looking. Call me."),
    ]

    outcome = bmr.process_person(wired, tmp_db, _person(), WINDOW_START, commit=True)

    assert outcome["kind"] == "human"
    tags = [p.get("tags") for _, p in wired._calls["update_person"] if p.get("tags")]
    assert any("Replied - Paused" in t for t in tags)
    rows = tmp_db.recent_audit_rows(["reply_detected"], WINDOW_START - dt.timedelta(days=1))
    assert len(rows) == 1 and rows[0]["status"] == "backfilled"
    # Backdated: the row lives at the reply's own moment so WARM lands in the
    # week the person actually wrote.
    stored = dt.datetime.fromisoformat(rows[0]["created_at"])
    assert abs((stored - reply_at).total_seconds()) < 1
    assert json.loads(rows[0]["details"])["backfilled"] is True


def test_an_unsubscribe_is_trashed_via_the_live_path(wired, tmp_db):
    reply_at = NOW - dt.timedelta(days=1)
    wired._calls["emails"] = [
        _email(reply_at - dt.timedelta(days=1), inbound=False, body="pond email"),
        _email(reply_at, inbound=True, body="UNSUBSCRIBE"),
    ]

    outcome = bmr.process_person(
        wired, tmp_db, _person(name=("Stephen", "Herrera")), WINDOW_START, commit=True)

    assert outcome["kind"] == "opt_out"
    stages = [p.get("stage") for _, p in wired._calls["update_person"]]
    assert "Trash" in stages
    disq = tmp_db.recent_audit_rows(
        ["reply_intent_disqualification"], WINDOW_START - dt.timedelta(days=1))
    assert len(disq) == 1 and disq[0]["status"] == "opt_out_trashed"


def test_autoresponders_are_classified_and_nothing_else(wired, tmp_db):
    send = NOW - dt.timedelta(days=1)
    wired._calls["emails"] = [
        _email(send, inbound=False, body="pond email"),
        _email(send + dt.timedelta(seconds=3), inbound=True, body="Auto: thanks!"),
    ]

    outcome = bmr.process_person(wired, tmp_db, _person(name=("Ingrid", "R")), WINDOW_START, commit=True)

    assert outcome["kind"] == "auto_reply"
    assert wired._calls["update_person"] == [], "an auto-reply must not tag anyone"
    autos = tmp_db.recent_audit_rows(["auto_reply_detected"], WINDOW_START - dt.timedelta(days=1))
    assert len(autos) == 1
    assert json.loads(autos[0]["details"])["seconds_after_send"] == 3.0


def test_dry_run_reports_but_writes_nothing(wired, tmp_db):
    reply_at = NOW - dt.timedelta(days=2)
    wired._calls["emails"] = [
        _email(reply_at - dt.timedelta(days=1), inbound=False, body="pond email"),
        _email(reply_at, inbound=True, body="Yes please!"),
    ]

    outcome = bmr.process_person(wired, tmp_db, _person(), WINDOW_START, commit=False)

    assert outcome["kind"] == "human"
    assert wired._calls["update_person"] == []
    assert wired._calls["add_note"] == []
    assert tmp_db.recent_audit_rows(["reply_detected"], WINDOW_START - dt.timedelta(days=1)) == []


def test_the_repair_is_idempotent(wired, tmp_db):
    reply_at = NOW - dt.timedelta(days=2)
    wired._calls["emails"] = [
        _email(reply_at - dt.timedelta(days=1), inbound=False, body="pond email"),
        _email(reply_at, inbound=True, body="Yes please!"),
    ]

    first = bmr.process_person(wired, tmp_db, _person(), WINDOW_START, commit=True)
    second = bmr.process_person(wired, tmp_db, _person(), WINDOW_START, commit=True)

    assert first["kind"] == "human"
    assert second is None, "the same reply must not be processed twice"
    rows = tmp_db.recent_audit_rows(["reply_detected"], WINDOW_START - dt.timedelta(days=1))
    assert len(rows) == 1


def test_a_lead_already_paused_by_the_live_scanner_is_skipped(wired, tmp_db):
    reply_at = NOW - dt.timedelta(days=2)
    wired._calls["emails"] = [
        _email(reply_at - dt.timedelta(days=1), inbound=False, body="pond email"),
        _email(reply_at, inbound=True, body="Yes please!"),
    ]

    person = _person(tags=("Replied - Paused",))
    assert bmr.process_person(wired, tmp_db, person, WINDOW_START, commit=True) is None


# ── the candidate walk ───────────────────────────────────────────────────────

class _PagingFub:
    """Stands in for FollowUpBossClient._request over /people."""

    def __init__(self, pages):
        self.pages = pages
        self.requests = []

    def _request(self, method, path, params=None):
        self.requests.append(dict(params or {}))
        index = len(self.requests) - 1
        people = self.pages[index] if index < len(self.pages) else []
        meta = {"next": f"cur{index + 1}"} if index + 1 < len(self.pages) else {}
        return {"people": people, "_metadata": meta}


def test_the_walk_stops_at_the_window_edge():
    inside = {"id": 1, "updated": (NOW - dt.timedelta(days=2)).isoformat()}
    edge = {"id": 2, "updated": (NOW - dt.timedelta(days=13)).isoformat()}
    outside = {"id": 3, "updated": (NOW - dt.timedelta(days=40)).isoformat()}
    fub = _PagingFub([[inside], [edge, outside], [{"id": 4}]])

    walked = list(bmr.iter_recently_updated_people(fub, WINDOW_START))

    assert [p["id"] for p in walked] == [1, 2], "the walk must stop at the first stale lead"
    assert len(fub.requests) == 2, "no page beyond the window may be fetched"
