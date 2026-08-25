"""
state_merge.py — reconcile two lineages of the shared audit DB.

Six workflows write one SQLite file that lives, encrypted, as a whole-file blob
on the `state` branch. Until #9 the sync was pull-at-start / push-at-end with no
merge and no compare-and-swap, so any workflow that pulled before a sibling's
push and finished after it overwrote everything the sibling had written. Twice on
2026-08-11: Daily Automation's 150 pond sends (rebuilt in #6 and #8), and then
the repair itself, clobbered by Reply Detection #459 four minutes after it
reported success.

state_sync.py detects the conflict (the blob moved since we pulled). This module
is what makes the conflict survivable: it folds the rows that appeared on the
branch while we were running INTO our file, so the push that follows carries both
sides. Nothing here talks to git or openssl — it takes two SQLite files.

─────────────────────────────────────────────────────────────────────────────
WHY A ROW-LEVEL MERGE IS SAFE HERE

Every table falls into one of two shapes, and neither needs a three-way base:

LEDGERS (append-only). `audit_log`, `reply_time_log`, and the two claim/bounce
    ledgers only ever grow. Merging is a union. audit_log carries an
    autoincrement `id` and no uniqueness constraint, so identity is the PAYLOAD
    — (created_at, person_id, action, status, details) — never the id: the same
    logical row gets different ids in two lineages, and keying on the id would
    duplicate every row on every merge. The union is multiset-aware (max of the
    two counts per key) so a lineage that legitimately holds two identical rows
    keeps both, and it is idempotent: merging the same pair again inserts
    nothing.

PERSON ROWS (UPSERT, one row per person_id). Reconciled field by field under
    three rules, chosen so a merge can only ever make a lead MORE protected:

      forward_only  — suppression clocks and send counters. Always the maximum
                      of the two sides. Regressing `last_sent_at` by even one
                      merge would put a lead back inside the cadence window and
                      send them a duplicate email; that is the one outcome worse
                      than losing the row.
      backward_only — "first observed at" stamps (created_at, enrolled_at).
                      Always the minimum: the earlier observation is the true
                      one, and moving one forward would restart a drip clock.
      reset_on      — a column whose change invalidates the rest of the row.
                      Only assignment_watch.assigned_user_id: a lead→agent
                      change deliberately restarts the untouched clock and
                      clears the alert suppression (upsert_assignment_watch uses
                      INSERT OR REPLACE for exactly that), so the side that saw
                      the newer pair wins the row whole rather than field-wise.

    Everything else — descriptive text like city, subject, tier, message_hash —
    comes from the side whose clock is newer, except that a known value is never
    replaced by NULL.

The result is commutative: merge(A, B) and merge(B, A) agree on every column,
which is what lets the two writers in a race reach the same file whichever of
them lands second. The tests in tests/test_state_merge.py assert that in both
directions, table by table.

A table the DB has and this module does not know about is NOT overwritten — it
falls back to a union that cannot lose a row (see UNCLASSIFIED_FALLBACK below)
and is reported as unclassified in the summary. test_state_merge.py fails if any
table AuditDB or ramp.ensure_schema creates ends up there, so the rule set has
to be extended deliberately rather than discovered in a run log. (The ramp half
of that check exists because volume_ramp_state DID slip through: it is created
by ramp.py rather than AuditDB, and the old AuditDB-only sweep never saw it.)
"""
from __future__ import annotations

import argparse
import datetime as dt
import sqlite3
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional, Sequence

# SQLite's own bookkeeping for AUTOINCREMENT columns. It is derived from the
# rows, so merging it would be meaningless; sqlite maintains it on INSERT.
INTERNAL_TABLES = {"sqlite_sequence"}


@dataclass(frozen=True)
class Ledger:
    """An append-only table. Merging is a union keyed on the payload."""

    name: str
    key: tuple[str, ...]
    #: Autoincrement surrogate key. Never part of identity, never copied.
    rowid_column: Optional[str] = None
    #: Columns outside the key where the EARLIER value wins. Both uses are
    #: suppression ledgers (a claim, a bounce): the first record is the true
    #: one, and a later timestamp would shorten the protection.
    earliest: tuple[str, ...] = ()


@dataclass(frozen=True)
class PersonRow:
    """One row per person_id, written by UPSERT. Reconciled field by field."""

    name: str
    #: Columns tried in order for "which side is newer" — first non-null wins,
    #: i.e. COALESCE. Drip tables need it: last_sent_at is NULL until the first
    #: email goes out, and enrolled_at is the clock until then.
    clock: tuple[str, ...]
    key: tuple[str, ...] = ("person_id",)
    forward_only: tuple[str, ...] = ()
    backward_only: tuple[str, ...] = ()
    reset_on: tuple[str, ...] = ()


LEDGERS: tuple[Ledger, ...] = (
    # THE table the 2026-08-11 loss was measured in: reply detection builds its
    # watch set from the last 7 days of sends here, and telemetry counts the
    # day's emails from it.
    Ledger(
        name="audit_log",
        key=("created_at", "person_id", "action", "status", "details"),
        rowid_column="id",
    ),
    Ledger(
        name="reply_time_log",
        key=("person_id", "reply_hour", "reply_day_of_week", "detected_at"),
        rowid_column="id",
    ),
    # UNIQUE(person_id, email_address) upstream, so the union collapses to at
    # most one row per address and only the bounce time needs reconciling.
    Ledger(
        name="seller_bounced_emails",
        key=("person_id", "email_address"),
        rowid_column="id",
        earliest=("bounced_at",),
    ),
    # The crash-safe send ledger. Losing a claim double-sends; keeping a stale
    # one skips at most one email. So: never drop one, and on doubt keep the
    # earlier claim, which is the one the send was made under.
    Ledger(
        name="seller_send_claims",
        key=("person_id", "email_number"),
        earliest=("claimed_at",),
    ),
)

PERSON_ROWS: tuple[PersonRow, ...] = (
    PersonRow(
        name="reengagement_log",
        clock=("last_sent_at",),
        forward_only=("last_sent_at",),
    ),
    PersonRow(
        name="closed_drip_log",
        clock=("last_sent_at",),
        forward_only=("last_sent_at",),
    ),
    PersonRow(
        name="congrats_log",
        clock=("sent_at",),
        forward_only=("sent_at",),
    ),
    PersonRow(
        name="long_term_nurture_drip",
        clock=("last_sent_at", "enrolled_at"),
        # emails_sent indexes into the sequence — lowering it re-sends an email
        # the lead already has.
        forward_only=("last_sent_at", "emails_sent"),
        backward_only=("enrolled_at",),
    ),
    PersonRow(
        name="seller_nurture_drip",
        clock=("last_sent_at", "enrolled_at"),
        forward_only=("last_sent_at", "emails_sent"),
        backward_only=("enrolled_at",),
    ),
    PersonRow(
        name="engagement_tier",
        clock=("last_classified_at",),
        forward_only=("last_classified_at",),
    ),
    PersonRow(
        name="email_angle_log",
        clock=("sent_at",),
        forward_only=("sent_at",),
    ),
    PersonRow(
        name="purchase_window",
        # window_start is data the model extracted, not a clock; updated_at is
        # what says whose extraction is newer.
        clock=("updated_at",),
        forward_only=("updated_at",),
    ),
    PersonRow(
        name="new_lead_timers",
        # One row per timer GENERATION since the assignment watch re-arms
        # timers on reassignment: identity is (person_id, created_at), so two
        # generations merge as distinct rows instead of folding into one.
        # The most-progressed side describes a generation best, and every
        # milestone is forward_only as well, so a warning or a reassignment
        # recorded by either side survives whichever side that was.
        key=("person_id", "created_at"),
        clock=("reassigned_at", "canceled_at", "warned_at", "created_at"),
        forward_only=("warned_at", "reassigned_at", "canceled_at"),
    ),
    PersonRow(
        name="assignment_watch",
        clock=("first_seen_at",),
        forward_only=("last_alert_at",),
        backward_only=("first_seen_at",),
        reset_on=("assigned_user_id",),
    ),
    # Not a person — the volume ramp's singleton row (ramp.py, CHECK (id = 1))
    # — but exactly this reconciliation shape: one row per key, field by field.
    # It NEEDS a rule more than most: the unclassified fallback is a union, and
    # a union of two disagreeing versions of a CHECK(id=1) row INSERTs a second
    # row, which the constraint rejects — failing the whole merge and with it
    # the push. Six workflows pull this table and only the daily run writes it,
    # so the first advance would have made every sibling's push fail.
    #
    # The side that evaluated the ramp most recently wins the row (holding /
    # hold_reason describe its evaluation); the step and both clocks are
    # forward-only, so a recorded advance survives whichever side pushes last
    # and the ramp can never be walked backwards by a stale copy.
    PersonRow(
        name="volume_ramp_state",
        key=("id",),
        clock=("last_evaluated_at",),
        forward_only=("step_index", "last_advanced_at", "last_evaluated_at"),
    ),
)

#: How an unknown table is merged: union on every column except an
#: autoincrement `id`, keeping both sides' rows. It cannot preserve UPSERT
#: semantics — two versions of one person's row would both survive — but it
#: cannot lose a write either, which is the failure this module exists to stop.
UNCLASSIFIED_FALLBACK = "union-all-columns"


class MergeError(RuntimeError):
    """Raised when the two files cannot be reconciled. Fails the push loudly."""


# ── Ordering ─────────────────────────────────────────────────────────────────


def _order_key(value) -> tuple:
    """Total order over the values these columns actually hold.

    NULL sorts below everything, so max() never picks "no value" over a value
    and min() never picks it over a real timestamp (callers drop NULLs before
    calling min). Timestamps are compared as INSTANTS, not as strings: the same
    moment is written "…+00:00" by now_iso() and "…Z" by FUB, and a lexical
    compare puts the Z form after every offset form.
    """
    if value is None:
        return (0,)
    if isinstance(value, bool):
        return (1, float(value))
    if isinstance(value, (int, float)):
        return (1, float(value))
    text = str(value)
    parsed = _parse_instant(text)
    if parsed is not None:
        return (2, parsed)
    return (3, text)


def _parse_instant(text: str) -> Optional[float]:
    try:
        parsed = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.timestamp()


def _newest(values: Iterable) -> Optional[object]:
    present = [v for v in values if v is not None]
    return max(present, key=_order_key) if present else None


def _oldest(values: Iterable) -> Optional[object]:
    present = [v for v in values if v is not None]
    return min(present, key=_order_key) if present else None


def _clock_value(row: dict, spec: PersonRow):
    for column in spec.clock:
        value = row.get(column)
        if value is not None:
            return value
    return None


def _row_rank(row: dict, spec: PersonRow, columns: Sequence[str]) -> tuple:
    """Sort key deciding which side's row is "newer".

    The clock decides it. The full row is the tie-break, and it is there for
    commutativity rather than for meaning: two sides holding different rows with
    the same clock must reduce to the SAME row no matter which one is merging,
    or the two writers in a race would push different files.
    """
    return (
        _order_key(_clock_value(row, spec)),
        tuple(_order_key(row.get(c)) for c in columns),
    )


# ── Schema inspection ────────────────────────────────────────────────────────


def _tables(conn: sqlite3.Connection) -> dict[str, str]:
    rows = conn.execute(
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    return {name: sql for name, sql in rows if name not in INTERNAL_TABLES}


def _columns(conn: sqlite3.Connection, table: str) -> list[str]:
    return [row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()]


def _read_rows(conn: sqlite3.Connection, table: str, columns: Sequence[str]) -> list[dict]:
    cols = ", ".join(f'"{c}"' for c in columns)
    return [
        dict(zip(columns, row))
        for row in conn.execute(f'SELECT {cols} FROM "{table}"').fetchall()
    ]


# ── Table merges ─────────────────────────────────────────────────────────────


def _insert(conn: sqlite3.Connection, table: str, row: dict) -> None:
    cols = list(row)
    conn.execute(
        f'INSERT INTO "{table}" ({", ".join(chr(34) + c + chr(34) for c in cols)}) '
        f'VALUES ({", ".join("?" for _ in cols)})',
        [row[c] for c in cols],
    )


def merge_ledger(
    ours: sqlite3.Connection,
    theirs: sqlite3.Connection,
    spec: Ledger,
    columns: Sequence[str],
) -> dict:
    """Union an append-only table. Never updates identity, never deletes."""
    payload = [c for c in columns if c != spec.rowid_column]

    def key_of(row: dict) -> tuple:
        return tuple(row[c] for c in spec.key)

    our_rows = _read_rows(ours, spec.name, payload)
    their_rows = _read_rows(theirs, spec.name, payload)

    our_counts = Counter(key_of(r) for r in our_rows)
    inserted = 0
    for key, their_count in Counter(key_of(r) for r in their_rows).items():
        # max of the two counts, so a lineage holding two byte-identical rows
        # keeps both AND a second merge of the same pair inserts nothing.
        missing = their_count - our_counts.get(key, 0)
        if missing <= 0:
            continue
        template = next(r for r in their_rows if key_of(r) == key)
        for _ in range(missing):
            _insert(ours, spec.name, template)
        inserted += missing

    updated = 0
    if spec.earliest:
        ours_by_key = {key_of(r): r for r in our_rows}
        for their_row in their_rows:
            our_row = ours_by_key.get(key_of(their_row))
            if our_row is None:
                continue  # just inserted verbatim above
            changes = {
                column: _oldest([our_row.get(column), their_row.get(column)])
                for column in spec.earliest
            }
            changes = {c: v for c, v in changes.items() if v != our_row.get(c)}
            if not changes:
                continue
            assignments = ", ".join(f'"{c}"=?' for c in changes)
            where = " AND ".join(f'"{c}" IS ?' for c in spec.key)
            ours.execute(
                f'UPDATE "{spec.name}" SET {assignments} WHERE {where}',
                [*changes.values(), *key_of(their_row)],
            )
            updated += 1

    return {"inserted": inserted, "updated": updated}


def reconcile_person_row(ours: dict, theirs: dict, spec: PersonRow, columns: Sequence[str]) -> dict:
    """Field-by-field reconciliation of one person's row. Pure; the tests drive
    it directly, in both argument orders."""
    ranked = sorted([ours, theirs], key=lambda r: _row_rank(r, spec, columns))
    older, newer = ranked[0], ranked[1]

    if spec.reset_on and any(ours.get(c) != theirs.get(c) for c in spec.reset_on):
        # The pair changed. The newer observation replaces the row wholesale —
        # including a NULL last_alert_at, which is the suppression reset that
        # upsert_assignment_watch performs on purpose.
        return dict(newer)

    merged = dict(newer)
    for column in columns:
        if column in spec.forward_only:
            merged[column] = _newest([ours.get(column), theirs.get(column)])
        elif column in spec.backward_only:
            merged[column] = _oldest([ours.get(column), theirs.get(column)])
        elif merged.get(column) is None:
            # Never let a merge replace a value with "unknown".
            merged[column] = older.get(column)
    return merged


def merge_person_table(
    ours: sqlite3.Connection,
    theirs: sqlite3.Connection,
    spec: PersonRow,
    columns: Sequence[str],
) -> dict:
    def key_of(row: dict) -> tuple:
        return tuple(row[c] for c in spec.key)

    our_rows = {key_of(r): r for r in _read_rows(ours, spec.name, columns)}
    inserted = updated = 0
    for their_row in _read_rows(theirs, spec.name, columns):
        key = key_of(their_row)
        our_row = our_rows.get(key)
        if our_row is None:
            _insert(ours, spec.name, their_row)
            inserted += 1
            continue
        merged = reconcile_person_row(our_row, their_row, spec, columns)
        if merged == our_row:
            continue
        payload = [c for c in columns if c not in spec.key]
        where = " AND ".join(f'"{c}" IS ?' for c in spec.key)
        ours.execute(
            f'UPDATE "{spec.name}" SET {", ".join(chr(34) + c + chr(34) + "=?" for c in payload)} '
            f"WHERE {where}",
            [*(merged[c] for c in payload), *key],
        )
        updated += 1
    return {"inserted": inserted, "updated": updated}


def merge_unclassified(
    ours: sqlite3.Connection,
    theirs: sqlite3.Connection,
    table: str,
    columns: Sequence[str],
) -> dict:
    """Safety net for a table added to the schema without a rule here."""
    rowid_column = _autoincrement_column(ours, table)
    spec = Ledger(
        name=table,
        key=tuple(c for c in columns if c != rowid_column),
        rowid_column=rowid_column,
    )
    result = merge_ledger(ours, theirs, spec, columns)
    result["unclassified"] = UNCLASSIFIED_FALLBACK
    return result


def _autoincrement_column(conn: sqlite3.Connection, table: str) -> Optional[str]:
    for row in conn.execute(f"PRAGMA table_info({table})").fetchall():
        _, name, decl_type, _, _, pk = row
        if pk and str(decl_type).upper() == "INTEGER":
            return name
    return None


def rule_for(table: str):
    for ledger in LEDGERS:
        if ledger.name == table:
            return ledger
    for person in PERSON_ROWS:
        if person.name == table:
            return person
    return None


# ── The whole file ───────────────────────────────────────────────────────────


def merge_databases(ours_path: str, theirs_path: str) -> dict:
    """Fold `theirs` into `ours`, in place. Returns a per-table summary.

    `ours` is the running job's file — the one about to be pushed. `theirs` is
    what is currently on the `state` branch. Nothing is ever deleted from
    either, so the result is a superset of both, and running it twice with the
    same inputs changes nothing the second time.

    All of it is one transaction: a merge that raises leaves `ours` exactly as
    it was, and state_sync turns that into a failed push rather than a push of
    half a merge.
    """
    ours = sqlite3.connect(ours_path)
    theirs = sqlite3.connect(f"{Path(theirs_path).resolve().as_uri()}?mode=ro", uri=True)
    try:
        summary: dict = {}
        with ours:  # commit on success, roll back on any exception
            our_tables = _tables(ours)
            their_tables = _tables(theirs)

            for table, create_sql in their_tables.items():
                if table not in our_tables and create_sql:
                    # Their lineage ran newer code. Take the table rather than
                    # dropping every row in it.
                    ours.execute(create_sql)
                    our_tables[table] = create_sql
                    summary.setdefault(table, {})["created"] = True

            for table in sorted(their_tables):
                our_columns = _columns(ours, table)
                their_columns = _columns(theirs, table)
                shared = [c for c in our_columns if c in their_columns]
                if not shared:
                    raise MergeError(f"{table}: the two schemas share no columns")

                rule = rule_for(table)
                if isinstance(rule, Ledger):
                    result = merge_ledger(ours, theirs, rule, shared)
                elif isinstance(rule, PersonRow):
                    result = merge_person_table(ours, theirs, rule, shared)
                else:
                    result = merge_unclassified(ours, theirs, table, shared)

                dropped = [c for c in their_columns if c not in our_columns]
                if dropped:
                    # Their lineage has a column we cannot store. Say so; the
                    # rows still land, minus that field.
                    result["columns_ignored"] = dropped
                if any(result.get(k) for k in ("inserted", "updated", "columns_ignored")):
                    summary.setdefault(table, {}).update(result)
    except sqlite3.Error as exc:
        raise MergeError(f"merge failed: {exc}") from exc
    finally:
        theirs.close()
        ours.close()
    return summary


def format_summary(summary: dict) -> str:
    if not summary:
        return "nothing to reconcile — the two lineages already agree"
    parts = []
    for table in sorted(summary):
        detail = summary[table]
        bits = [f"+{detail.get('inserted', 0)}"]
        if detail.get("updated"):
            bits.append(f"~{detail['updated']}")
        if detail.get("created"):
            bits.append("new table")
        if detail.get("unclassified"):
            bits.append("no merge rule")
        if detail.get("columns_ignored"):
            bits.append("dropped " + ",".join(detail["columns_ignored"]))
        parts.append(f"{table} {' '.join(bits)}")
    return "; ".join(parts)


# ── CLI ──────────────────────────────────────────────────────────────────────


def main(argv: Optional[Sequence[str]] = None) -> int:
    """`python -m fub_automation.state_merge --ours A --theirs B`.

    Exit codes:
      0 — merged (possibly a no-op).
      1 — could not merge. The caller must NOT push: `ours` is unchanged, and
          pushing it would discard whatever is in `theirs`.
    """
    parser = argparse.ArgumentParser(
        description="Fold the state branch's audit DB into this run's copy.")
    parser.add_argument("--ours", required=True, help="This run's DB. Merged in place.")
    parser.add_argument("--theirs", required=True, help="The DB currently on the state branch.")
    args = parser.parse_args(argv)

    for path in (args.ours, args.theirs):
        if not Path(path).exists():
            print(f"[state-merge] {path} does not exist", file=sys.stderr)
            return 1
    try:
        summary = merge_databases(args.ours, args.theirs)
    except MergeError as exc:
        print(f"[state-merge] REFUSING TO PUSH — {exc}", file=sys.stderr)
        return 1
    print(f"[state-merge] {format_summary(summary)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
