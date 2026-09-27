"""cleanup_speed_to_lead_gate.py — undoing what the Peter-only gate forbids.

History is judged only on the fields FUB never rewrites (createdVia /
createdById): an agent's own contact armed at discovery FAILS for certain;
anything routed after creation is UNDETERMINED because the bounce itself —
written on Peter's key — overwrote the last-editor stamp. Restores happen
only for leads still sitting with Peter, unedited since the bounce.

No network: the FUB client is a recording stub.
"""
from __future__ import annotations

import datetime as dt
import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "cleanup_speed_to_lead_gate",
    Path(__file__).resolve().parents[1] / "cleanup_speed_to_lead_gate.py",
)
cleanup = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cleanup)  # type: ignore[union-attr]

UTC = dt.timezone.utc
PETER = 2
STEVEN = 1
LAILA = 35
BOUNCED = dt.datetime(2026, 9, 27, 17, 10, 21, tzinfo=UTC)
USERS = {
    1: {"id": 1, "name": "Steven Van Orden", "status": "Active"},
    2: {"id": 2, "name": "Peter Allen", "status": "Active"},
    16: {"id": 16, "name": "Luke Durbin", "status": "Active"},
    35: {"id": 35, "name": "Laila Maria", "status": "Active"},
}


def _import(pid=9601, **overrides):
    """Today's bounce as measured: Steven's own import, now with Peter."""
    person = {
        "id": pid, "createdVia": "Import", "createdById": STEVEN,
        "created": "2026-09-27T05:33:35Z", "updated": "2026-09-27T17:10:24Z",
        "updatedById": PETER, "assignedUserId": PETER, "assignedPondId": None,
        "source": "SOI", "tags": [{"name": "FRBO Scout"}, {"name": "auto-reassigned-speed-to-lead"}],
    }
    person.update(overrides)
    return person


def _verdict(**overrides):
    v = {"person_id": 9601, "agent_id": STEVEN, "kinds": {"started_polling"},
         "warned_at": BOUNCED, "bounced_at": BOUNCED, "punished_at": BOUNCED,
         "latest_routing": True, "already_cleaned": False, "why": "agent's own contact"}
    v.update(overrides)
    return v


class _FubStub:
    def __init__(self, person):
        self.person = person
        self.writes = []

    def get_person(self, pid):
        return self.person

    def update_person(self, pid, payload, merge_tags=False):
        self.writes.append(("update_person", pid, payload))
        return {}

    def add_note(self, pid, subject, body):
        self.writes.append(("add_note", pid, subject, body))
        return {}


# ── judging history ────────────────────────────────────────────────────────────

def test_an_agents_own_import_armed_at_discovery_fails_the_gate():
    verdict, why = cleanup.judge_history(_import(), STEVEN, {"started_polling"}, PETER)
    assert (verdict, why) == (cleanup.FAILS, "agent's own contact")


def test_a_lead_peter_added_passes_the_gate():
    person = _import(createdVia="Manually", createdById=PETER)
    verdict, _ = cleanup.judge_history(person, LAILA, {"started_polling"}, PETER)
    assert verdict == cleanup.PASSES


def test_a_reassignment_timer_is_undetermined_not_guessed():
    """The router's last-editor stamp was overwritten by the bounce."""
    verdict, why = cleanup.judge_history(
        _import(), STEVEN, {"started_assignment_change"}, PETER)
    assert verdict == cleanup.UNDETERMINED and "not recoverable" in why


def test_a_portal_lead_is_undetermined():
    person = _import(createdVia="API", createdById=PETER)
    verdict, why = cleanup.judge_history(person, LAILA, {"started_polling"}, PETER)
    assert verdict == cleanup.UNDETERMINED and "lead source" in why


def test_the_arm_row_names_the_trigger():
    t = dt.datetime(2026, 9, 20, 21, 59, 21, tzinfo=UTC)
    rows = {7: [(t + dt.timedelta(seconds=1), "started_polling")]}
    assert cleanup.arm_kind(rows, 7, t.isoformat()) == "started_polling"
    assert cleanup.arm_kind(rows, 7, (t + dt.timedelta(hours=1)).isoformat()) == "unknown"


# ── what --commit would do ───────────────────────────────────────────────────

def test_a_bounced_own_contact_still_with_peter_is_restored():
    status, detail = cleanup.plan_restore(_import(), _verdict(), PETER, USERS, [])
    assert status == "restore" and "Steven Van Orden" in detail


def test_a_lead_rerouted_by_hand_since_the_bounce_is_left_alone():
    status, _ = cleanup.plan_restore(_import(assignedUserId=LAILA), _verdict(), PETER, USERS, [])
    assert status == "skip_rerouted_since_bounce"


def test_a_lead_edited_since_the_bounce_is_left_alone():
    person = _import(updated="2026-09-27T19:00:00Z", updatedById=PETER)
    status, _ = cleanup.plan_restore(person, _verdict(), PETER, USERS, [])
    assert status == "skip_edited_since_bounce"


def test_our_own_later_write_does_not_count_as_an_edit_by_hand():
    person = _import(updated="2026-09-27T19:00:00Z", updatedById=PETER)
    ours = [dt.datetime(2026, 9, 27, 19, 0, 30, tzinfo=UTC)]
    status, _ = cleanup.plan_restore(person, _verdict(), PETER, USERS, ours)
    assert status == "restore"


def test_a_warning_that_never_bounced_is_listed_only():
    status, _ = cleanup.plan_restore(_import(), _verdict(bounced_at=None), PETER, USERS, [])
    assert status == "list_only_warned"


def test_a_lead_is_never_handed_back_to_an_excluded_agent():
    status, _ = cleanup.plan_restore(_import(), _verdict(agent_id=16), PETER, USERS, [],
                                     frozenset({16}))
    assert status == "skip_agent_excluded"


def test_restore_returns_the_agent_strips_the_tag_and_explains(tmp_db):
    fub = _FubStub(_import())
    status = cleanup.apply_restore(tmp_db, fub, _verdict(), PETER, "Steven Van Orden",
                                   "Steven Van Orden (Import, source SOI)", approved=False)
    assert status == "restored"
    assert fub.writes[0] == ("update_person", 9601, {"assignedUserId": STEVEN})
    assert fub.writes[1] == ("update_person", 9601, {"tags": ["FRBO Scout"]})
    kind, pid, subject, body = fub.writes[2]
    assert subject == "Automation: speed-to-lead gate cleanup", \
        "the Automation: prefix keeps the note from counting as a touch"
    assert "returned to Steven Van Orden" in body and "never routed by Peter" in body
    assert tmp_db.get_assignment_watch(9601)["assigned_user_id"] == STEVEN
    rows = tmp_db.recent_audit_rows(["speed_to_lead_gate_cleanup"],
                                    dt.datetime.now(UTC) - dt.timedelta(minutes=5))
    assert [r["status"] for r in rows] == ["restored"]


def test_restore_rechecks_and_never_overwrites_a_fresh_reroute(tmp_db):
    fub = _FubStub(_import(assignedUserId=LAILA))
    status = cleanup.apply_restore(tmp_db, fub, _verdict(), PETER, "Steven Van Orden",
                                   "Steven Van Orden (Import)", approved=False)
    assert status == "restore_skipped_rerouted"
    assert fub.writes == []
