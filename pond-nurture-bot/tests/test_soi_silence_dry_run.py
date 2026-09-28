"""soi_silence_dry_run.py — the read-only tool behind Peter's 2026-09-28 rule.

The tool compares the LIVE SOI rule with the legacy Manually-only rule frozen
inside it, so what it lists is exactly the gap the rule change closes. No
network: the pieces are exercised directly, the audit look-up on a temp DB.
"""
from __future__ import annotations

import datetime as dt
import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "soi_silence_dry_run", Path(__file__).resolve().parents[1] / "soi_silence_dry_run.py")
dry = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dry)  # type: ignore[union-attr]

UTC = dt.timezone.utc
STEVEN, PETER = 1, 2


def _now_iso() -> str:
    return dt.datetime.now(UTC).isoformat()


# ── the frozen legacy rule is the gap, spelled out ────────────────────────────

def test_legacy_rule_silenced_manual_adds_but_not_imports():
    assert dry.legacy_soi_rule({"createdVia": "Manually", "createdById": STEVEN}, PETER)
    assert dry.legacy_soi_rule({"createdVia": "Import", "createdById": STEVEN}, PETER) is None
    assert dry.legacy_soi_rule({"createdVia": "Manually", "createdById": PETER}, PETER) is None
    assert dry.legacy_soi_rule({"source": "Theo's SOI"}, PETER)
    assert dry.legacy_soi_rule({"tags": [{"name": "SOI - Church"}]}, PETER)


def test_the_live_rule_newly_silences_an_agents_import_and_frees_nobody(engine):
    steven_import = {"id": 1, "createdVia": "Import", "createdById": STEVEN, "source": "<unspecified>"}
    assert dry.legacy_soi_rule(steven_import, PETER) is None
    assert engine._is_soi_silenced(steven_import)
    # Everything the legacy rule silenced, the live rule still silences.
    for person in ({"id": 2, "createdVia": "Manually", "createdById": STEVEN},
                   {"id": 3, "source": "Tiffany SOI list"},
                   {"id": 4, "tags": ["soi friends"]}):
        assert dry.legacy_soi_rule(person, PETER) and engine._is_soi_silenced(person)


# ── FUB spells a blank source "<unspecified>" ────────────────────────────────

def test_source_label_treats_fubs_unspecified_as_blank():
    assert dry.source_label({"source": "<unspecified>"}) == "<blank>"
    assert dry.source_label({"source": ""}) == "<blank>"
    assert dry.source_label({}) == "<blank>"
    assert dry.source_label({"source": "Agent Scouting"}) == "Agent Scouting"


# ── which FUB notes count as a bot email ─────────────────────────────────────

def test_note_classification():
    since = dt.datetime.now(UTC) - dt.timedelta(days=30)
    fresh = (dt.datetime.now(UTC) - dt.timedelta(days=3)).isoformat()
    stale = (dt.datetime.now(UTC) - dt.timedelta(days=40)).isoformat()
    sent = {"created": fresh, "body": "[Laila Bot] Follow-up email sent by Laila Maria on 9/25/2026.\nSubject: hi"}
    assert dry.classify_note(sent, since) == ("agent-bot email", fresh[:10])
    skipped = {"created": fresh, "body": "[Laila Bot] Skipped automated follow-up. Reason: soi_silenced"}
    assert dry.classify_note(skipped, since) is None
    assert dry.classify_note(dict(sent, created=stale), since) is None
    pond = {"created": fresh, "body": "Automated two-week pond nurture outreach sent to lead."}
    assert dry.classify_note(pond, since) == ("ts pond nurture email", fresh[:10])
    seller = {"created": fresh, "subject": "Automation: Seller Nurture Email Sent", "body": "..."}
    assert dry.classify_note(seller, since) == ("automation email note", fresh[:10])
    human = {"created": fresh, "body": "Called, left voicemail"}
    assert dry.classify_note(human, since) is None


# ── the automation's own sends, from the audit log ───────────────────────────

def test_audit_sends_counts_real_sends_inside_the_window_only(tmp_db):
    tmp_db.log("pond_nurture", "sent", 101, {})
    tmp_db.log("recruiting_email", "sent", 102, {})
    tmp_db.log("pond_nurture", "dry_run_sent", 103, {})      # a rehearsal, not an email
    tmp_db.log("pond_nurture", "soi_silenced", 104, {})      # a refusal, not an email
    tmp_db.log("new_lead_reassigned", "sent", 105, {})       # not an email to the contact
    since = dt.datetime.now(UTC) - dt.timedelta(days=30)
    sends = dry.audit_sends(tmp_db.path, {101, 102, 103, 104, 105, 106}, since)
    assert set(sends) == {101, 102}
    assert sends[101][0][0] == "pond_nurture"
    assert sends[102][0][0] == "recruiting_email"
    # A person outside the asked-for set is never returned
    assert dry.audit_sends(tmp_db.path, {999}, since) == {}
    # And nothing before the window
    assert dry.audit_sends(tmp_db.path, {101}, dt.datetime.now(UTC) + dt.timedelta(days=1)) == {}


def test_recruiting_is_a_bot_send_action():
    assert "recruiting_email" in dry.BOT_SEND_ACTIONS
    assert "pond_nurture" in dry.BOT_SEND_ACTIONS
