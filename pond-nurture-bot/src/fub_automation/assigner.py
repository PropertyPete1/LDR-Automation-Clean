"""Who made a lead's CURRENT assignment — the speed-to-lead gate's evidence.

Peter's rule (2026-09-27): a speed-to-lead timer arms ONLY when Peter Allen
(FUB user 2) assigned the lead to an agent — when he adds a lead and assigns
it, or when he reassigns an existing lead. An agent adding a contact
themselves, or any non-Peter user making the assignment, never arms. When the
assigner cannot be determined, nothing arms either, and the skip is audited
as reason "assigner_unknown" so it is counted, never silent.

What FUB actually exposes (read-only probe, Actions run 36337892501,
2026-09-27 — see the PR for the payloads):

  - There is NO assigner field. FUB rejects assignedById / assignedBy /
    assignedAt / lastAssigned as invalid `fields` names (400). The timeline,
    where the web UI shows "Assigned to X by Y", is GET /timeline — it answers
    403 "You do not have access to this API endpoint" for this key (an admin
    key, not the account owner's). /events holds only lead-source events.
  - createdVia + createdById say who ADDED the lead. The human channels
    ("Manually", "Import") name the person. API-created leads carry the API
    key's user — Peter, because the automation's key is his — and Email
    Parsing carries -1, so on those channels createdById names no person.
  - updated + updatedById are the record's LAST edit and who made it. An
    assignment is a record edit, so updatedById names the assigner exactly
    when the assignment is the latest edit. Logged activity does not move
    it: on the measured lead, lastActivity ran 7 minutes past `updated`.
  - The automation writes on Peter's key too, so its own edits (bounces,
    tags, restores) also stamp updatedById=2. Those are told apart by our
    own audit rows.
  - All of these need fields=allFields: the default /people list payload
    omits createdById and updatedById.

resolve_assigner() turns those fields into a verdict and is deliberately
conservative: PETER only when the fields name Peter as the one who routed
the lead; OTHER only when they positively name a non-Peter origin (an
agent's own contact, a lead source routing on arrival); every ambiguity is
UNKNOWN (no timer, audited as assigner_unknown).

Known blind spot, inherent to a last-editor field: an edit made after the
assignment and before we look masks the assigner. Someone else editing after
Peter routed reads UNKNOWN (a missed timer, counted); Peter editing after
someone else routed reads PETER. The second is the costly direction, so the
automation's own writes (on Peter's key) are excluded by audit time.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, Optional

UTC = dt.timezone.utc

PETER = "peter"
OTHER = "other"
UNKNOWN = "unknown"

#: Audit reasons (the `reason` detail on skip rows).
REASON_UNKNOWN = "assigner_unknown"
REASON_NOT_PETER = "assigned_by_non_peter"

#: createdVia values whose createdById is the PERSON who added the lead.
HUMAN_CREATED_VIA = frozenset({"manually", "import"})

#: An edit this close to creation is part of the creation itself: the UI's
#: add-and-assign stamps `updated` a few seconds after `created` (4 s on the
#: measured lead), an import stamps the same second.
CREATION_EDIT_TOLERANCE = dt.timedelta(seconds=15)

#: Allowed disagreement between FUB's clock and ours.
CLOCK_SKEW = dt.timedelta(minutes=2)

#: An automation write this close to FUB's last-edit stamp may BE that edit.
AUTOMATION_EDIT_WINDOW = dt.timedelta(minutes=5)

#: Audit actions recorded when the automation itself writes a FUB person
#: record (assignment, pond, stage or tags) — on Peter's key, so FUB stamps
#: those edits updatedById=Peter. Statuses in NON_WRITE_STATUSES are
#: evaluations that wrote nothing.
AUTOMATION_PERSON_WRITE_ACTIONS = (
    "stale_agent_pond_reassignment",
    "pond_keyword_reassignment",
    "pond_opt_out_trash",
    "pond_nurture",                   # opt_out_trashed only (see statuses)
    "reply_intent_disqualification",
    "email_address_update",
    "long_term_nurture_enrollment",
    "annual_nurture_enrollment",
    "reply_detected",                 # tags the lead when a reply lands
    "new_lead_reassigned",
    "speed_to_lead_repair",
    "speed_to_lead_gate_cleanup",
)
NON_WRITE_STATUSES = frozenset({
    "error", "suppressed", "skipped", "launch_cap_reached", "soi_silenced",
    "soi_protected", "sent", "dry_run_sent", "sms_sent", "sms_error",
    "listed", "dry_run",
})

#: The fields every verdict rests on — logged with it as evidence.
EVIDENCE_KEYS = ("createdVia", "createdById", "created", "updated",
                 "updatedById", "assignedUserId")


@dataclass(frozen=True)
class AssignerVerdict:
    kind: str                     # PETER | OTHER | UNKNOWN
    why: str                      # the specific rule that decided it
    assigner_id: Optional[int]    # the user the fields name, when they name one
    evidence: Dict[str, Any] = field(default_factory=dict)

    @property
    def arms(self) -> bool:
        return self.kind == PETER

    @property
    def reason(self) -> Optional[str]:
        """The audit reason for a skip; None when the timer arms."""
        if self.kind == PETER:
            return None
        return REASON_UNKNOWN if self.kind == UNKNOWN else REASON_NOT_PETER

    def details(self) -> Dict[str, Any]:
        """Audit-row details: the verdict plus the raw fields behind it."""
        out: Dict[str, Any] = {"why": self.why, "assigner_id": self.assigner_id,
                               "evidence": dict(self.evidence)}
        if self.reason:
            out["reason"] = self.reason
        return out


def parse_stamp(value: Any) -> Optional[dt.datetime]:
    """FUB / audit timestamp → aware UTC datetime (same rules as main.py's
    parse_fub_datetime, duplicated so this module imports nothing from it)."""
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        try:
            parsed = dt.datetime.strptime(str(value)[:19], "%Y-%m-%d %H:%M:%S")
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _user_id(value: Any) -> Optional[int]:
    try:
        return int(value) if value is not None and value != "" else None
    except (TypeError, ValueError):
        return None


def automation_write_times(rows: Iterable[dict], person_id: int) -> list:
    """Timestamps of the automation's own FUB person writes for one person,
    from audit rows (any order). Evaluation rows that wrote nothing are
    ignored; for pond_nurture only the opt-out trash writes."""
    times = []
    for row in rows:
        if int(row.get("person_id") or 0) != int(person_id):
            continue
        if row.get("action") not in AUTOMATION_PERSON_WRITE_ACTIONS:
            continue
        status = str(row.get("status") or "")
        if status in NON_WRITE_STATUSES:
            continue
        if row.get("action") == "pond_nurture" and status != "opt_out_trashed":
            continue
        ts = parse_stamp(row.get("created_at"))
        if ts is not None:
            times.append(ts)
    return times


def resolve_assigner(person: dict, peter_user_id: int, *,
                     since: Optional[dt.datetime] = None,
                     automation_edits: Iterable[dt.datetime] = ()) -> AssignerVerdict:
    """Who made `person`'s CURRENT assignment, from FUB's actor fields.

    person           — the FULL record (fields=allFields).
    since            — the earliest moment the current assignment can have
                       been made: the lead's creation for the new-lead poll,
                       the previous completed scan for an assignment change.
    automation_edits — when the automation itself wrote this person record
                       (automation_write_times) — those edits carry Peter's id.
    """
    peter = int(peter_user_id)
    evidence = {key: person.get(key) for key in EVIDENCE_KEYS}
    assignee = _user_id(person.get("assignedUserId"))
    created = parse_stamp(person.get("created"))
    updated = parse_stamp(person.get("updated"))
    via = str(person.get("createdVia") or "").strip().lower()
    created_by = _user_id(person.get("createdById"))
    updated_by = _user_id(person.get("updatedById"))

    def verdict(kind: str, why: str, who: Optional[int]) -> AssignerVerdict:
        return AssignerVerdict(kind, why, who, evidence)

    if not assignee:
        return verdict(UNKNOWN, "no_assignee", None)
    if (created is None or updated is None or "createdById" not in person
            or "updatedById" not in person):
        # The list payload lacks these — only the full record can answer.
        return verdict(UNKNOWN, "actor_fields_missing", None)

    added_by_person = via in HUMAN_CREATED_VIA and created_by is not None and created_by > 0

    # A contact still sitting with the person who added it is that person's
    # own contact — whatever was edited since, nobody routed it to them.
    if added_by_person and created_by != peter and assignee == created_by:
        return verdict(OTHER, "added_by_agent_themselves", created_by)

    # 1. Never edited since creation: the assignment came with the lead.
    if updated - created <= CREATION_EDIT_TOLERANCE:
        if added_by_person:
            if created_by == peter:
                return verdict(PETER, "added_and_assigned_by_peter", peter)
            return verdict(OTHER, "added_and_assigned_by_non_peter", created_by)
        if via in HUMAN_CREATED_VIA:
            return verdict(UNKNOWN, "creator_not_recorded", created_by)
        if not via:
            return verdict(UNKNOWN, "created_via_missing", None)
        # API / Email Parsing / integrations: the lead source or FUB's lead
        # flow placed it on arrival. createdById names the API key (Peter's)
        # or -1 — not a person routing a lead.
        return verdict(OTHER, "routed_on_arrival_by_lead_source", None)

    # 2. Edited since creation: FUB names only the LAST editor.
    if since is not None and updated < since - CLOCK_SKEW:
        # The assignment became current after `since`, so it must have moved
        # the last-edit stamp past it — the fields contradict the diff.
        return verdict(UNKNOWN, "last_edit_predates_assignment", updated_by)
    if updated_by is None or updated_by <= 0:
        return verdict(UNKNOWN, "last_edit_by_system", updated_by)
    if updated_by != peter:
        # The latest edit is someone else's: they made the assignment, or
        # they edited after whoever did. The fields cannot say which, so
        # this is unknown — not proof of a non-Peter assignment.
        return verdict(UNKNOWN, "last_edit_by_non_peter", updated_by)
    if any(abs(updated - ts) <= AUTOMATION_EDIT_WINDOW for ts in automation_edits):
        # Peter's id, but the automation wrote this record at that moment —
        # the stamp may be ours, not his.
        return verdict(UNKNOWN, "last_edit_may_be_automation", peter)
    return verdict(PETER, "routed_by_peter", peter)
