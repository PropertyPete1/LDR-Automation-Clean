"""The speed-to-lead gate's evidence — who made a lead's CURRENT assignment.

Peter's rule (2026-09-27): a timer arms ONLY when Peter assigned the lead.
FUB has no assigner field (it rejects assignedById & co.; the timeline that
shows "Assigned to X by Y" answers 403 for this key), so resolve_assigner()
reads the actor fields FUB does expose — createdVia/createdById (who added
the lead) and updated/updatedById (the record's last edit) — in the shapes
the 2026-09-27 read-only probe measured. No network.
"""
from __future__ import annotations

import datetime as dt

from fub_automation import assigner as a

UTC = dt.timezone.utc
PETER = 2
STEVEN = 1
LAILA = 35
T0 = dt.datetime(2026, 9, 27, 16, 43, 29, tzinfo=UTC)


def _iso(t: dt.datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def _person(**overrides):
    """Lead 9661 as measured: Peter added it by hand and assigned it to
    Steven; FUB stamped the edit 4 seconds after creation, by Peter."""
    base = {
        "id": 9661,
        "created": _iso(T0),
        "updated": _iso(T0 + dt.timedelta(seconds=4)),
        "createdVia": "Manually",
        "createdById": PETER,
        "updatedById": PETER,
        "assignedUserId": STEVEN,
    }
    base.update(overrides)
    return base


def test_peter_adding_and_assigning_a_lead_arms():
    v = a.resolve_assigner(_person(), PETER, since=T0)
    assert v.arms and v.kind == a.PETER
    assert v.why == "added_and_assigned_by_peter"
    assert v.reason is None, "an arming verdict carries no skip reason"


def test_peter_reassigning_an_existing_lead_arms():
    """A portal lead (createdById is the API key's user) that Peter routed to
    Laila days later: the last edit is his and nothing of ours is near it."""
    since = T0 + dt.timedelta(days=3)
    p = _person(createdVia="API", assignedUserId=LAILA,
                updated=_iso(since + dt.timedelta(minutes=10)), updatedById=PETER)
    v = a.resolve_assigner(p, PETER, since=since)
    assert v.arms and v.why == "routed_by_peter"


def test_an_agents_own_import_never_arms():
    """Leads 9599-9604: Steven imported his own contacts, assigned to himself."""
    p = _person(createdVia="Import", createdById=STEVEN, updatedById=STEVEN,
                assignedUserId=STEVEN, updated=_iso(T0))
    v = a.resolve_assigner(p, PETER, since=T0)
    assert not v.arms and v.kind == a.OTHER
    assert v.reason == a.REASON_NOT_PETER and v.assigner_id == STEVEN


def test_an_agents_own_contact_stays_theirs_after_a_later_edit_on_peters_key():
    """Still with the agent who added it — a later Peter-id edit (e.g. our
    own bot's tag on his key) does not make Peter its router."""
    p = _person(createdById=LAILA, assignedUserId=LAILA,
                updated=_iso(T0 + dt.timedelta(hours=2)), updatedById=PETER)
    v = a.resolve_assigner(p, PETER, since=T0)
    assert not v.arms and v.why == "added_by_agent_themselves"


def test_a_non_peter_reassignment_never_arms_and_is_counted_unknown():
    """Steven (a Broker) moved the lead: FUB names him as the last editor. The
    field cannot prove he routed it rather than edited after Peter did, so
    the verdict is assigner_unknown — never a timer."""
    since = T0 + dt.timedelta(days=3)
    p = _person(assignedUserId=LAILA, updated=_iso(since + dt.timedelta(minutes=10)),
                updatedById=STEVEN)
    v = a.resolve_assigner(p, PETER, since=since)
    assert not v.arms and v.kind == a.UNKNOWN
    assert v.reason == a.REASON_UNKNOWN and v.why == "last_edit_by_non_peter"
    assert v.assigner_id == STEVEN


def test_a_lead_source_arrival_is_not_peters_routing():
    """API-created leads carry the API key's user (Peter) as createdById — the
    lead source / lead flow placed it, not Peter by hand."""
    p = _person(createdVia="API", assignedUserId=LAILA,
                updated=_iso(T0 + dt.timedelta(seconds=2)))
    v = a.resolve_assigner(p, PETER, since=T0)
    assert not v.arms and v.kind == a.OTHER
    assert v.why == "routed_on_arrival_by_lead_source"


def test_an_email_parsing_arrival_is_not_peters_routing():
    p = _person(createdVia="Email Parsing", createdById=-1, updatedById=-1,
                updated=_iso(T0))
    assert a.resolve_assigner(p, PETER, since=T0).kind == a.OTHER


def test_the_automations_own_write_on_peters_key_is_not_peter():
    """The bot writes with Peter's key, so its own edit stamps updatedById=2.
    An audit row of ours at that moment makes the stamp unprovable."""
    since = T0 + dt.timedelta(days=1)
    edit = since + dt.timedelta(minutes=20)
    p = _person(createdVia="Import", createdById=STEVEN, assignedUserId=LAILA,
                updated=_iso(edit), updatedById=PETER)
    v = a.resolve_assigner(p, PETER, since=since,
                           automation_edits=[edit + dt.timedelta(seconds=3)])
    assert not v.arms and v.why == "last_edit_may_be_automation"
    assert v.reason == a.REASON_UNKNOWN


def test_the_default_list_payload_is_unknown_not_a_guess():
    """GET /people without fields=allFields omits createdById/updatedById."""
    p = _person()
    del p["createdById"], p["updatedById"]
    v = a.resolve_assigner(p, PETER, since=T0)
    assert not v.arms and v.why == "actor_fields_missing"


def test_a_last_edit_before_the_assignment_window_contradicts_the_diff():
    since = T0 + dt.timedelta(days=5)
    p = _person(assignedUserId=LAILA, updated=_iso(T0 + dt.timedelta(days=1)))
    v = a.resolve_assigner(p, PETER, since=since)
    assert not v.arms and v.why == "last_edit_predates_assignment"


def test_a_system_last_edit_is_unknown():
    p = _person(assignedUserId=LAILA, updated=_iso(T0 + dt.timedelta(hours=1)),
                updatedById=-1)
    v = a.resolve_assigner(p, PETER, since=T0)
    assert not v.arms and v.why == "last_edit_by_system"


def test_details_carry_the_reason_and_the_raw_evidence():
    p = _person(createdVia="Import", createdById=STEVEN, assignedUserId=STEVEN)
    d = a.resolve_assigner(p, PETER, since=T0).details()
    assert d["reason"] == "assigned_by_non_peter"
    assert d["evidence"]["createdVia"] == "Import"
    assert d["evidence"]["createdById"] == STEVEN
    assert set(d["evidence"]) == set(a.EVIDENCE_KEYS)


def test_automation_write_times_keep_only_real_person_writes():
    rows = [
        {"person_id": 5, "action": "new_lead_reassigned", "status": "completed",
         "created_at": "2026-09-27T17:10:21+00:00"},
        {"person_id": 5, "action": "pond_nurture", "status": "sent",
         "created_at": "2026-09-27T12:00:00+00:00"},
        {"person_id": 5, "action": "pond_nurture", "status": "opt_out_trashed",
         "created_at": "2026-09-27T12:05:00+00:00"},
        {"person_id": 5, "action": "stale_agent_pond_reassignment", "status": "suppressed",
         "created_at": "2026-09-27T12:06:00+00:00"},
        {"person_id": 6, "action": "new_lead_reassigned", "status": "completed",
         "created_at": "2026-09-27T17:10:22+00:00"},
    ]
    times = sorted(a.automation_write_times(rows, 5))
    assert [t.isoformat() for t in times] == [
        "2026-09-27T12:05:00+00:00", "2026-09-27T17:10:21+00:00"]
