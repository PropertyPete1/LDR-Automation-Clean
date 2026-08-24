"""Reconciling two lineages of the audit DB (issue #9).

state_sync.py detects that the `state` branch moved while a job was running;
state_merge.py is what makes that survivable instead of fatal. These tests are
about the reconciliation rules themselves, table by table:

  * append-only tables union, keyed on the payload and never on the autoincrement
    id, and merging the same pair twice inserts nothing;
  * a suppression clock never moves backwards, in EITHER merge direction — a
    regressed last_sent_at puts a lead back inside the cadence window and sends
    them a second copy of an email they already have, which is worse than the row
    loss this whole change exists to stop;
  * a merge is commutative, so the two writers in a race converge on the same
    file whichever of them lands second;
  * nothing is ever deleted, and a known value is never replaced by NULL.

test_every_table_in_the_schema_has_a_merge_rule is the one that will fail on
someone else's future branch: a new table with no rule here falls into a
union-everything fallback that cannot honour UPSERT semantics, so the rule has to
be added deliberately.
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from fub_automation import state_merge as sm  # noqa: E402

T1 = "2026-08-11T13:28:00+00:00"      # Daily Automation's 150 sends
T2 = "2026-08-11T21:28:23+00:00"      # the backfill's push
T3 = "2026-08-11T21:32:08+00:00"      # Reply Detection #459's push, which won


def full_schema(path: Path) -> None:
    """Every table a production DB carries: AuditDB's plus the ramp's.

    volume_ramp_state is created by ramp.ensure_schema, not AuditDB — which is
    exactly how it escaped the schema sweep below and ran without a merge rule.
    """
    from fub_automation import ramp

    conn = sqlite3.connect(path)
    with conn:
        ramp.ensure_schema(conn)
    conn.close()


@pytest.fixture()
def dbs(m, tmp_path):
    """Two lineages of the same schema: ours (the running job) and theirs (the
    branch). Returns their paths."""
    ours = tmp_path / "ours.sqlite3"
    theirs = tmp_path / "theirs.sqlite3"
    m.AuditDB(str(ours))
    m.AuditDB(str(theirs))
    full_schema(ours)
    full_schema(theirs)
    return ours, theirs


def execute(path: Path, sql: str, *params) -> None:
    conn = sqlite3.connect(path)
    with conn:
        conn.execute(sql, params)
    conn.close()


def rows(path: Path, sql: str, *params) -> list[tuple]:
    conn = sqlite3.connect(path)
    result = conn.execute(sql, params).fetchall()
    conn.close()
    return result


def dump(path: Path) -> dict:
    """Every row of every table, with autoincrement ids stripped.

    Ids are not identity here — the same logical row gets different ids in two
    lineages — so a comparison that included them would call two correct merges
    different.
    """
    conn = sqlite3.connect(path)
    out = {}
    for (table,) in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall():
        columns = [r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()
                   if r[1] != "id"]
        out[table] = sorted(
            conn.execute(f"SELECT {', '.join(columns)} FROM {table}").fetchall(), key=repr)
    conn.close()
    return out


def send(path: Path, person_id: int, created_at: str, details: str = "{}") -> None:
    execute(
        path,
        "INSERT INTO audit_log(created_at, person_id, action, status, details) "
        "VALUES (?, ?, 'pond_nurture', 'sent', ?)",
        created_at, person_id, details,
    )


# ── audit_log: the table the incident was measured in ───────────────────────


def test_both_sides_sends_survive_the_union(dbs):
    ours, theirs = dbs
    send(ours, 101, T1)
    send(theirs, 202, T2)

    sm.merge_databases(str(ours), str(theirs))

    assert {r[0] for r in rows(ours, "SELECT person_id FROM audit_log")} == {101, 202}


def test_the_union_does_not_key_on_the_autoincrement_id(dbs):
    """THE trap #9 calls out. audit_log has an autoincrement id and no uniqueness
    constraint, so the same logical row carries id 1 in one lineage and id 940 in
    another. Keying on the id would duplicate every row on every merge."""
    ours, theirs = dbs
    send(ours, 101, T1)
    execute(theirs, "INSERT INTO audit_log(id, created_at, person_id, action, status, details) "
                    "VALUES (940, ?, 101, 'pond_nurture', 'sent', '{}')", T1)
    send(theirs, 202, T2)

    sm.merge_databases(str(ours), str(theirs))

    assert rows(ours, "SELECT COUNT(*) FROM audit_log")[0][0] == 2
    assert sorted(r[0] for r in rows(ours, "SELECT person_id FROM audit_log")) == [101, 202]


def test_merging_the_same_pair_twice_inserts_nothing(dbs):
    ours, theirs = dbs
    send(ours, 101, T1)
    for person_id in (202, 303):
        send(theirs, person_id, T2)

    sm.merge_databases(str(ours), str(theirs))
    once = dump(ours)
    summary = sm.merge_databases(str(ours), str(theirs))

    assert dump(ours) == once
    assert summary == {}, f"a second merge changed something: {summary}"


def test_a_lineage_that_really_holds_two_identical_rows_keeps_both(dbs):
    """The union is multiset-aware. Two byte-identical audit rows are legal — a
    lead emailed twice in the same microsecond is not, but a duplicated INSERT is
    still real history, and collapsing it would understate the day."""
    ours, theirs = dbs
    send(ours, 101, T1)
    send(ours, 101, T1)
    send(theirs, 101, T1)

    sm.merge_databases(str(ours), str(theirs))

    assert rows(ours, "SELECT COUNT(*) FROM audit_log")[0][0] == 2


def test_the_details_json_is_part_of_a_rows_identity(dbs):
    """Two sends to one lead in the same second differ only in `details`; treating
    them as one row would drop a send from the day's count."""
    ours, theirs = dbs
    send(ours, 101, T1, '{"city": "Austin"}')
    send(theirs, 101, T1, '{"city": "San Antonio"}')

    sm.merge_databases(str(ours), str(theirs))

    assert rows(ours, "SELECT COUNT(*) FROM audit_log")[0][0] == 2


def test_the_150_send_case_end_to_end(dbs):
    """The shape of the real loss: our lineage holds a day of sends the branch has
    never seen, and the branch has ten minutes of reply-detection work ours has
    never seen. After the merge the day is whole and reply detection can see it."""
    ours, theirs = dbs
    for person_id in range(1000, 1150):
        send(ours, person_id, T1)
    for person_id in (77, 88):
        execute(theirs, "INSERT INTO audit_log(created_at, person_id, action, status, details) "
                        "VALUES (?, ?, 'reply_detected', 'sent', '{}')", T3, person_id)

    sm.merge_databases(str(ours), str(theirs))

    assert rows(ours, "SELECT COUNT(*) FROM audit_log WHERE action='pond_nurture'")[0][0] == 150
    assert rows(ours, "SELECT COUNT(*) FROM audit_log WHERE action='reply_detected'")[0][0] == 2


def test_the_merged_day_still_satisfies_the_stats_log_invariant(dbs, tmp_path):
    """The dashboard invariant in telemetry.py is what makes this class of loss
    visible; a merge that produced a day the invariant rejects would trade a
    silent bug for a stuck publish step."""
    from fub_automation import telemetry as tel

    ours, theirs = dbs
    for person_id in range(100, 120):
        send(ours, person_id, T1, '{"contact_name": "Jane Harper"}')
    for person_id in range(200, 210):
        send(theirs, person_id, T2, '{"contact_name": "Ray Ortiz"}')

    sm.merge_databases(str(ours), str(theirs))

    import datetime as dt
    written = tel.write_status(
        str(ours), str(tmp_path / "status"),
        now=dt.datetime.fromisoformat("2026-08-11T23:00:00+00:00"))
    tel.check_agreement(written["daily_stats"], written["activity_log"], "America/Chicago")
    assert written["daily_stats"]["emails_sent"] == 30


# ── Suppression clocks ──────────────────────────────────────────────────────


def test_a_cadence_clock_is_never_moved_backwards_merging_theirs_in(dbs):
    """The direction the incident took: our file is the stale one. Folding the
    branch in must adopt ITS newer clock, not keep ours."""
    ours, theirs = dbs
    _reengagement(ours, 55, T1)
    _reengagement(theirs, 55, T3)

    sm.merge_databases(str(ours), str(theirs))

    assert rows(ours, "SELECT last_sent_at FROM reengagement_log")[0][0] == T3


def test_a_cadence_clock_is_never_moved_backwards_merging_ours_over(dbs):
    """And the other direction: ours is the newer one, and folding a stale branch
    in must not undo it. Both directions matter because either writer can be the
    one that lands second."""
    ours, theirs = dbs
    _reengagement(ours, 55, T3)
    _reengagement(theirs, 55, T1)

    sm.merge_databases(str(ours), str(theirs))

    assert rows(ours, "SELECT last_sent_at FROM reengagement_log")[0][0] == T3


def test_a_clock_written_with_a_Z_suffix_still_compares_as_an_instant(dbs):
    """now_iso() writes '+00:00' and FUB writes 'Z'. Comparing those as strings
    puts every Z timestamp after every offset one, which would let a merge move a
    clock eight hours backwards while looking like it moved it forwards."""
    ours, theirs = dbs
    _reengagement(ours, 55, "2026-08-11T21:28:23Z")
    _reengagement(theirs, 55, "2026-08-11T13:28:00+00:00")

    sm.merge_databases(str(ours), str(theirs))

    assert rows(ours, "SELECT last_sent_at FROM reengagement_log")[0][0] == "2026-08-11T21:28:23Z"


def _reengagement(path: Path, person_id: int, last_sent_at: str, city: str = "Austin") -> None:
    execute(
        path,
        "INSERT INTO reengagement_log(person_id, last_sent_at, channel, city, message_hash) "
        "VALUES (?, ?, 'email', ?, 'h')",
        person_id, last_sent_at, city,
    )


def _table_info(path: Path, table: str) -> list[tuple]:
    conn = sqlite3.connect(path)
    info = conn.execute(f"PRAGMA table_info({table})").fetchall()
    conn.close()
    return info


@pytest.mark.parametrize("spec", sm.PERSON_ROWS, ids=lambda s: s.name)
def test_no_forward_only_column_in_any_table_ever_regresses(spec, m, dbs, tmp_path):
    """Swept across every person-keyed table, both directions.

    Several of these are suppression clocks (last_sent_at, last_alert_at,
    warned_at) and one is a sequence position (emails_sent); regressing any of
    them re-sends mail. Rather than trust the per-table tests below to stay
    complete, this drives whatever is declared forward_only in the spec.
    """
    ours, theirs = dbs
    info = _table_info(ours, spec.name)
    older = _synthetic_row(spec, info, when=T1, counter=1, marker="older")
    newer = _synthetic_row(spec, info, when=T3, counter=9, marker="newer")

    _insert_row(ours, spec.name, older)
    _insert_row(theirs, spec.name, newer)
    sm.merge_databases(str(ours), str(theirs))
    forwards = _read_row(ours, spec)

    # The same pair again with the sides swapped: either writer can be the one
    # that lands second, so both orders have to come out the same.
    ours2, theirs2 = tmp_path / "swapped-ours.sqlite3", tmp_path / "swapped-theirs.sqlite3"
    m.AuditDB(str(ours2))
    m.AuditDB(str(theirs2))
    full_schema(ours2)
    full_schema(theirs2)
    _insert_row(ours2, spec.name, newer)
    _insert_row(theirs2, spec.name, older)
    sm.merge_databases(str(ours2), str(theirs2))
    backwards = _read_row(ours2, spec)

    for column in spec.forward_only:
        assert forwards[column] == newer[column], f"{spec.name}.{column} regressed"
        assert backwards[column] == newer[column], f"{spec.name}.{column} regressed"
    for column in spec.backward_only:
        assert forwards[column] == older[column], f"{spec.name}.{column} moved forward"
        assert backwards[column] == older[column], f"{spec.name}.{column} moved forward"
    assert forwards == backwards, f"{spec.name}: the merge is not commutative"


def _synthetic_row(spec, info: list[tuple], *, when: str, counter: int, marker: str) -> dict:
    """One row of `spec`'s table, aged consistently.

    Columns that carry an instant get `when`; counters get `counter`; anything
    reset_on is held EQUAL between the two rows on purpose, since a difference
    there means "this is a different assignment" and takes the wholesale path
    tested separately.
    """
    timestamps = set(spec.clock) | set(spec.forward_only) | set(spec.backward_only)
    row = {}
    for _, name, decl_type, _, _, _ in info:
        if name in spec.key:
            # 1 rather than an arbitrary id: volume_ramp_state is CHECK (id = 1)
            # and every person-keyed table is equally happy with person_id 1.
            row[name] = 1
        elif name in timestamps and str(decl_type).upper() == "INTEGER":
            row[name] = counter
        elif name in timestamps:
            row[name] = when
        elif str(decl_type).upper() == "INTEGER":
            row[name] = 42                      # reset_on columns land here
        else:
            row[name] = marker
    return row


def _insert_row(path: Path, table: str, row: dict) -> None:
    # OR REPLACE because volume_ramp_state already holds its default singleton
    # row (ensure_schema seeds id=1); every other table here starts empty, so
    # for them this is a plain INSERT.
    execute(
        path,
        f"INSERT OR REPLACE INTO {table}({', '.join(row)}) "
        f"VALUES ({', '.join('?' for _ in row)})",
        *row.values(),
    )


def _read_row(path: Path, spec) -> dict:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    row = conn.execute(f"SELECT * FROM {spec.name}").fetchone()
    conn.close()
    return dict(row)


# ── Per-table rules that the sweep above cannot express ─────────────────────


def test_a_drip_counter_never_counts_down(dbs):
    """emails_sent indexes into the seller sequence. Lowering it re-sends an
    email the lead already has; raising it skips one. The safe direction is up."""
    ours, theirs = dbs
    execute(ours, "INSERT INTO seller_nurture_drip(person_id, enrolled_at, last_sent_at, "
                  "emails_sent, subject) VALUES (7, ?, ?, 4, 'ours')", T1, T3)
    execute(theirs, "INSERT INTO seller_nurture_drip(person_id, enrolled_at, last_sent_at, "
                    "emails_sent, subject) VALUES (7, ?, ?, 2, 'theirs')", T1, T1)

    sm.merge_databases(str(ours), str(theirs))

    assert rows(ours, "SELECT emails_sent, last_sent_at FROM seller_nurture_drip")[0] == (4, T3)


def test_the_earlier_enrollment_wins_so_a_drip_clock_does_not_restart(dbs):
    ours, theirs = dbs
    execute(ours, "INSERT INTO long_term_nurture_drip(person_id, enrolled_at, last_sent_at, "
                  "emails_sent) VALUES (7, ?, NULL, 0)", T3)
    execute(theirs, "INSERT INTO long_term_nurture_drip(person_id, enrolled_at, last_sent_at, "
                    "emails_sent) VALUES (7, ?, NULL, 0)", T1)

    sm.merge_databases(str(ours), str(theirs))

    assert rows(ours, "SELECT enrolled_at FROM long_term_nurture_drip")[0][0] == T1


def test_a_send_claim_is_never_dropped_by_a_merge(dbs):
    """Losing a claim double-sends; keeping a stale one skips at most one email.
    So the union keeps every claim either side holds, and the earlier claimed_at —
    the one the send was actually made under."""
    ours, theirs = dbs
    execute(ours, "INSERT INTO seller_send_claims(person_id, email_number, claimed_at) "
                  "VALUES (7, 3, ?)", T3)
    execute(theirs, "INSERT INTO seller_send_claims(person_id, email_number, claimed_at) "
                    "VALUES (7, 3, ?)", T1)
    execute(theirs, "INSERT INTO seller_send_claims(person_id, email_number, claimed_at) "
                    "VALUES (8, 1, ?)", T2)

    sm.merge_databases(str(ours), str(theirs))

    assert sorted(rows(ours, "SELECT person_id, email_number, claimed_at FROM seller_send_claims")) \
        == [(7, 3, T1), (8, 1, T2)]


def test_a_bounced_address_stays_suppressed_and_keeps_its_first_bounce(dbs):
    ours, theirs = dbs
    execute(ours, "INSERT INTO seller_bounced_emails(person_id, email_address, bounced_at) "
                  "VALUES (7, 'a@example.com', ?)", T3)
    execute(theirs, "INSERT INTO seller_bounced_emails(person_id, email_address, bounced_at) "
                    "VALUES (7, 'a@example.com', ?)", T1)
    execute(theirs, "INSERT INTO seller_bounced_emails(person_id, email_address, bounced_at) "
                    "VALUES (7, 'b@example.com', ?)", T2)

    sm.merge_databases(str(ours), str(theirs))

    assert sorted(rows(ours, "SELECT email_address, bounced_at FROM seller_bounced_emails")) \
        == [("a@example.com", T1), ("b@example.com", T2)]


def test_a_new_lead_timer_keeps_every_milestone_either_side_recorded(dbs):
    """Speed-to-Lead warns at 30 minutes and reassigns at 60, and the two can be
    written by different runs. A merge that dropped either would warn or reassign
    the same lead twice."""
    ours, theirs = dbs
    execute(ours, "INSERT INTO new_lead_timers(person_id, created_at, assigned_user_id, "
                  "warned_at) VALUES (7, ?, 42, ?)", T1, T2)
    execute(theirs, "INSERT INTO new_lead_timers(person_id, created_at, assigned_user_id, "
                    "reassigned_at) VALUES (7, ?, 42, ?)", T1, T3)

    sm.merge_databases(str(ours), str(theirs))

    assert rows(ours, "SELECT warned_at, reassigned_at, created_at FROM new_lead_timers")[0] \
        == (T2, T3, T1)


def test_an_assignment_change_replaces_the_watch_row_whole(dbs):
    """upsert_assignment_watch uses INSERT OR REPLACE on purpose: a new agent
    restarts the untouched clock AND clears the alert suppression. A field-wise
    merge would keep the old agent's last_alert_at and silence the new pair."""
    ours, theirs = dbs
    execute(ours, "INSERT INTO assignment_watch(person_id, assigned_user_id, first_seen_at, "
                  "last_alert_at) VALUES (7, 42, ?, ?)", T1, T2)
    execute(theirs, "INSERT INTO assignment_watch(person_id, assigned_user_id, first_seen_at, "
                    "last_alert_at) VALUES (7, 99, ?, NULL)", T3)

    sm.merge_databases(str(ours), str(theirs))

    assert rows(ours, "SELECT assigned_user_id, first_seen_at, last_alert_at FROM assignment_watch")[0] \
        == (99, T3, None)


def test_the_same_pair_keeps_the_earliest_sighting_and_the_latest_alert(dbs):
    """Unchanged pair: the earlier sighting is the true assignment age, and the
    later alert is the suppression that stops a second alert going out."""
    ours, theirs = dbs
    execute(ours, "INSERT INTO assignment_watch(person_id, assigned_user_id, first_seen_at, "
                  "last_alert_at) VALUES (7, 42, ?, ?)", T1, T2)
    execute(theirs, "INSERT INTO assignment_watch(person_id, assigned_user_id, first_seen_at, "
                    "last_alert_at) VALUES (7, 42, ?, ?)", T2, T3)

    sm.merge_databases(str(ours), str(theirs))

    assert rows(ours, "SELECT first_seen_at, last_alert_at FROM assignment_watch")[0] == (T1, T3)


def test_a_known_value_is_never_replaced_by_null(dbs):
    ours, theirs = dbs
    _reengagement(ours, 55, T1, city="San Antonio")
    execute(theirs, "INSERT INTO reengagement_log(person_id, last_sent_at, channel, city, "
                    "message_hash) VALUES (55, ?, 'email', NULL, 'h')", T3)

    sm.merge_databases(str(ours), str(theirs))

    assert rows(ours, "SELECT last_sent_at, city FROM reengagement_log")[0] == (T3, "San Antonio")


def test_a_person_only_the_branch_knows_about_is_carried_over(dbs):
    ours, theirs = dbs
    _reengagement(ours, 55, T1)
    _reengagement(theirs, 66, T2)

    sm.merge_databases(str(ours), str(theirs))

    assert sorted(r[0] for r in rows(ours, "SELECT person_id FROM reengagement_log")) == [55, 66]


# ── volume_ramp_state: the singleton the ramp lives in ──────────────────────


def _ramp_row(path: Path, *, step: int, advanced: str | None, evaluated: str | None,
              holding: int = 0, reason: str | None = None) -> None:
    execute(path, "UPDATE volume_ramp_state SET step_index=?, last_advanced_at=?, "
                  "last_evaluated_at=?, holding=?, hold_reason=? WHERE id=1",
            step, advanced, evaluated, holding, reason)


def test_a_ramp_advance_survives_a_stale_siblings_push(dbs):
    """THE ramp race. The daily run advances the step and pushes; a reply-
    detection run that pulled before the advance pushes four minutes later
    still holding the old row. Whichever side merges, the advance survives —
    this is the write path that being unclassified would have turned into a
    failed push (a union INSERTs a second row; CHECK (id = 1) refuses it)."""
    ours, theirs = dbs
    # ours: the stale sibling. theirs (the branch): the daily run's advance.
    _ramp_row(ours, step=0, advanced=None, evaluated=T1)
    _ramp_row(theirs, step=1, advanced=T3, evaluated=T3)

    sm.merge_databases(str(ours), str(theirs))

    assert rows(ours, "SELECT COUNT(*) FROM volume_ramp_state")[0][0] == 1
    assert rows(
        ours, "SELECT step_index, last_advanced_at, last_evaluated_at FROM volume_ramp_state"
    )[0] == (1, T3, T3)


def test_a_ramp_advance_survives_when_the_advancer_pushes_second(dbs):
    """The same race with the daily run landing second: its step must not be
    walked back by the older row it merges in."""
    ours, theirs = dbs
    _ramp_row(ours, step=1, advanced=T3, evaluated=T3)
    _ramp_row(theirs, step=0, advanced=None, evaluated=T1)

    sm.merge_databases(str(ours), str(theirs))

    assert rows(
        ours, "SELECT step_index, last_advanced_at, last_evaluated_at FROM volume_ramp_state"
    )[0] == (1, T3, T3)


def test_the_newer_evaluations_hold_verdict_wins_the_row(dbs):
    """holding/hold_reason describe an evaluation, so the side that evaluated
    most recently speaks for them — a fresh hold is not erased by a sibling
    still carrying last week's green."""
    ours, theirs = dbs
    _ramp_row(ours, step=1, advanced=T1, evaluated=T1, holding=0, reason=None)
    _ramp_row(theirs, step=1, advanced=T1, evaluated=T3, holding=1,
              reason="bounce/failure 3.1% (limit 2.0%)")

    sm.merge_databases(str(ours), str(theirs))

    assert rows(ours, "SELECT holding, hold_reason FROM volume_ramp_state")[0] == (
        1, "bounce/failure 3.1% (limit 2.0%)")


# ── Whole-file properties ───────────────────────────────────────────────────


def test_the_merge_is_commutative_across_the_whole_schema(dbs, m, tmp_path):
    """The property the race depends on: whichever writer lands second, the file
    that ends up on the branch is the same one."""
    ours, theirs = dbs
    _populate(ours, marker="ours", when=T1)
    _populate(theirs, marker="theirs", when=T3)

    mirror_ours = tmp_path / "mirror-ours.sqlite3"
    mirror_theirs = tmp_path / "mirror-theirs.sqlite3"
    m.AuditDB(str(mirror_ours))
    m.AuditDB(str(mirror_theirs))
    full_schema(mirror_ours)
    full_schema(mirror_theirs)
    _populate(mirror_theirs, marker="ours", when=T1)
    _populate(mirror_ours, marker="theirs", when=T3)

    sm.merge_databases(str(ours), str(theirs))
    sm.merge_databases(str(mirror_ours), str(mirror_theirs))

    assert dump(ours) == dump(mirror_ours)


def test_a_merge_never_deletes_a_row_we_already_had(dbs):
    ours, theirs = dbs
    _populate(ours, marker="ours", when=T1)
    before = dump(ours)
    _populate(theirs, marker="theirs", when=T3)

    sm.merge_databases(str(ours), str(theirs))
    after = dump(ours)

    for table, rows_before in before.items():
        assert len(after[table]) >= len(rows_before), table
    assert rows(ours, "SELECT COUNT(*) FROM audit_log")[0][0] == 2


def _populate(path: Path, *, marker: str, when: str) -> None:
    """One row in every table this schema has, so the whole-file properties are
    not quietly measured over two tables."""
    send(path, 101 if marker == "ours" else 202, when)
    execute(path, "INSERT INTO reply_time_log(person_id, reply_hour, reply_day_of_week, "
                  "detected_at) VALUES (55, 9, 2, ?)", when)
    _reengagement(path, 55, when, city=marker)
    execute(path, "INSERT INTO closed_drip_log(person_id, last_sent_at, deal_address, subject, "
                  "message_hash) VALUES (55, ?, ?, ?, 'h')", when, marker, marker)
    execute(path, "INSERT INTO congrats_log(person_id, sent_at, deal_address, subject) "
                  "VALUES (55, ?, ?, ?)", when, marker, marker)
    execute(path, "INSERT INTO long_term_nurture_drip(person_id, enrolled_at, last_sent_at, "
                  "emails_sent, subject) VALUES (55, ?, ?, 1, ?)", when, when, marker)
    execute(path, "INSERT INTO seller_nurture_drip(person_id, enrolled_at, last_sent_at, "
                  "emails_sent, subject) VALUES (55, ?, ?, 1, ?)", when, when, marker)
    execute(path, "INSERT INTO engagement_tier(person_id, tier, last_classified_at, reason) "
                  "VALUES (55, ?, ?, ?)", marker, when, marker)
    execute(path, "INSERT INTO email_angle_log(person_id, last_angle, sent_at) "
                  "VALUES (55, ?, ?)", marker, when)
    execute(path, "INSERT INTO purchase_window(person_id, window_start, raw_text, "
                  "detected_from_note_date, updated_at) VALUES (55, ?, ?, ?, ?)",
            when, marker, when, when)
    execute(path, "INSERT INTO new_lead_timers(person_id, created_at, assigned_user_id, "
                  "warned_at) VALUES (55, ?, 42, ?)", when, when)
    execute(path, "INSERT INTO assignment_watch(person_id, assigned_user_id, first_seen_at, "
                  "last_alert_at) VALUES (55, 42, ?, ?)", when, when)
    execute(path, "INSERT INTO seller_bounced_emails(person_id, email_address, bounced_at) "
                  "VALUES (55, ?, ?)", f"{marker}@example.com", when)
    execute(path, "INSERT INTO seller_send_claims(person_id, email_number, claimed_at) "
                  "VALUES (55, ?, ?)", 1 if marker == "ours" else 2, when)
    # UPDATE, not INSERT: ensure_schema seeded the singleton, and a second row
    # is exactly what the CHECK (id = 1) constraint exists to refuse.
    execute(path, "UPDATE volume_ramp_state SET step_index=?, last_advanced_at=?, "
                  "last_evaluated_at=?, holding=0, hold_reason=? WHERE id=1",
            1 if marker == "ours" else 2, when, when, marker)


def test_every_table_in_the_schema_has_a_merge_rule(m, tmp_path):
    """A table with no rule falls back to a union that cannot honour UPSERT
    semantics — two versions of one person's row would both survive. That is safe
    against loss but wrong against a suppression clock, so the fallback is a net,
    not a plan: adding a table to AuditDB means adding its rule to state_merge."""
    db = m.AuditDB(str(tmp_path / "schema.sqlite3"))
    full_schema(Path(db.path))
    conn = sqlite3.connect(db.path)
    tables = {row[0] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
    conn.close()

    unruled = sorted(t for t in tables if sm.rule_for(t) is None)
    assert not unruled, (
        "these tables have no merge rule in state_merge.py and would be reconciled "
        f"by the union fallback: {unruled}")


def test_the_rules_only_name_columns_that_exist(m, tmp_path):
    """A typo in a rule is silent otherwise: a forward_only column that does not
    exist simply never protects anything."""
    db = m.AuditDB(str(tmp_path / "schema.sqlite3"))
    full_schema(Path(db.path))
    conn = sqlite3.connect(db.path)
    for spec in (*sm.LEDGERS, *sm.PERSON_ROWS):
        columns = {r[1] for r in conn.execute(f"PRAGMA table_info({spec.name})").fetchall()}
        assert columns, f"{spec.name} is not in the schema at all"
        named = set(spec.key)
        if isinstance(spec, sm.Ledger):
            named |= set(spec.earliest) | ({spec.rowid_column} if spec.rowid_column else set())
        else:
            named |= set(spec.clock) | set(spec.forward_only) | set(spec.backward_only) \
                | set(spec.reset_on)
        assert named <= columns, f"{spec.name}: unknown columns {sorted(named - columns)}"
    conn.close()


def test_a_table_with_no_rule_is_unioned_rather_than_overwritten(dbs):
    """The net itself. A future table must not be silently truncated to whichever
    side happened to push last — that is the bug this module exists to fix."""
    ours, theirs = dbs
    for path in (ours, theirs):
        execute(path, "CREATE TABLE future_thing (id INTEGER PRIMARY KEY AUTOINCREMENT, "
                      "person_id INTEGER, note TEXT)")
    execute(ours, "INSERT INTO future_thing(person_id, note) VALUES (1, 'ours')")
    execute(theirs, "INSERT INTO future_thing(person_id, note) VALUES (2, 'theirs')")

    summary = sm.merge_databases(str(ours), str(theirs))

    assert sorted(r[0] for r in rows(ours, "SELECT note FROM future_thing")) == ["ours", "theirs"]
    assert summary["future_thing"]["unclassified"] == sm.UNCLASSIFIED_FALLBACK


def test_a_table_only_the_branch_has_is_created_not_dropped(dbs):
    """Their lineage may be running newer code than ours — a rollback, or a
    workflow that has not picked up main yet."""
    ours, theirs = dbs
    execute(theirs, "CREATE TABLE newer_code (person_id INTEGER PRIMARY KEY, note TEXT)")
    execute(theirs, "INSERT INTO newer_code(person_id, note) VALUES (1, 'theirs')")

    summary = sm.merge_databases(str(ours), str(theirs))

    assert rows(ours, "SELECT note FROM newer_code") == [("theirs",)]
    assert summary["newer_code"]["created"] is True


def test_a_failed_merge_leaves_our_file_exactly_as_it_was(dbs, monkeypatch):
    """One transaction. A half-merged file must never be what gets pushed — and
    state_sync turns the raise into a failed push rather than a partial one."""
    ours, theirs = dbs
    send(ours, 101, T1)
    send(theirs, 202, T2)
    _reengagement(theirs, 55, T2)
    before = dump(ours)

    def explode(*_args, **_kwargs):
        raise sqlite3.OperationalError("disk I/O error")

    monkeypatch.setattr(sm, "_insert", explode)
    with pytest.raises(sm.MergeError):
        sm.merge_databases(str(ours), str(theirs))

    assert dump(ours) == before


def test_the_branch_copy_is_opened_read_only(dbs):
    """A merge must not write to the file it is reading: state_sync decrypts the
    branch's DB into a temp dir, and a stray write there would be a merge that
    quietly disagrees with what it merged."""
    ours, theirs = dbs
    send(ours, 101, T1)
    send(theirs, 202, T2)
    before = theirs.read_bytes()

    sm.merge_databases(str(ours), str(theirs))

    assert theirs.read_bytes() == before


# ── CLI ─────────────────────────────────────────────────────────────────────


def test_the_cli_merges_and_reports_what_it_did(dbs, capsys):
    ours, theirs = dbs
    send(ours, 101, T1)
    send(theirs, 202, T2)

    assert sm.main(["--ours", str(ours), "--theirs", str(theirs)]) == 0

    assert "audit_log +1" in capsys.readouterr().out
    assert rows(ours, "SELECT COUNT(*) FROM audit_log")[0][0] == 2


def test_the_cli_refuses_rather_than_pretend_when_a_file_is_missing(dbs, tmp_path, capsys):
    ours, _ = dbs
    assert sm.main(["--ours", str(ours), "--theirs", str(tmp_path / "gone.sqlite3")]) == 1
    assert "does not exist" in capsys.readouterr().err
