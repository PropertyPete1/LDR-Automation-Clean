"""Schema guarantees added by the 2026-08 engineering audit.

audit_log is append-only and never pruned, and every run filters it on
action+created_at (recent_audit_rows) or scans it by person_id — full-table
scans on the hottest table in the DB until the indexes below existed. These
tests pin that ANY DB opened by AuditDB — fresh, or a pulled state blob from
before the indexes shipped — comes out indexed.
"""
import sqlite3


def _index_names(db_path):
    con = sqlite3.connect(db_path)
    try:
        return {r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_log'")}
    finally:
        con.close()


def test_a_fresh_db_carries_the_audit_log_indexes(m, tmp_path):
    db = m.AuditDB(str(tmp_path / "fresh.sqlite3"))
    names = _index_names(db.path)
    assert "idx_audit_log_action_created" in names
    assert "idx_audit_log_person" in names


def test_a_pre_index_state_db_is_indexed_on_open(m, tmp_path):
    """A pulled state blob predates the indexes — opening it must add them
    without touching the rows."""
    path = tmp_path / "legacy.sqlite3"
    con = sqlite3.connect(path)
    con.execute(
        "CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "created_at TEXT NOT NULL, person_id INTEGER, action TEXT NOT NULL, "
        "status TEXT NOT NULL, details TEXT)")
    con.execute(
        "INSERT INTO audit_log(created_at, person_id, action, status, details) "
        "VALUES ('2026-08-01T00:00:00+00:00', 42, 'pond_nurture', 'sent', '{}')")
    con.commit()
    con.close()

    m.AuditDB(str(path))

    assert "idx_audit_log_action_created" in _index_names(path)
    con = sqlite3.connect(path)
    rows = con.execute("SELECT person_id, action, status FROM audit_log").fetchall()
    con.close()
    assert rows == [(42, "pond_nurture", "sent")], "indexing must not touch rows"


def test_recent_audit_rows_uses_the_action_created_index(m, tmp_path):
    db = m.AuditDB(str(tmp_path / "plan.sqlite3"))
    con = sqlite3.connect(db.path)
    plan = con.execute(
        "EXPLAIN QUERY PLAN SELECT created_at FROM audit_log "
        "WHERE action IN ('pond_nurture') AND created_at >= '2026-01-01'").fetchall()
    con.close()
    assert any("idx_audit_log_action_created" in str(row) for row in plan), plan
