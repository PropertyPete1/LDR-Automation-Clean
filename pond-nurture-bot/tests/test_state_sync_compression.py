"""The state DB is compressed at rest, and every older blob still reads (2026-11-09).

GitHub refuses any file over 100 MiB. The encrypted DB reached 104,763,424
bytes, 94 KB under that, and from then on every push that added real rows was
declined by GitHub's pre-receive hook: each Daily Automation run from at least
2026-10-30 to 2026-11-08 ended "State DB push failed after 6 attempts. This run's
rows were NOT persisted" (the 11-08 merged DB was 108,163,104 bytes), so the
day's sends, opt-out ledger rows and cadence clocks never reached the branch.

These drive the real protocol against real git repositories and real openssl,
like tests/test_state_sync.py, and pin:

- the push writes the gzip-then-encrypt form, and it is much smaller;
- a branch still holding the OLD (uncompressed) form pulls, merges and is
  carried forward — the switch needs no migration and rewrites nothing;
- every earlier commit on the branch stays a readable backup;
- an unreadable payload is refused and never replaces the DB;
- a blob over the safety limit fails in plain words before it is sent, and a
  size refusal by the remote is reported as one and not retried six times.
"""
from __future__ import annotations

import json
import os
import random
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fub_automation import state_sync  # noqa: E402
from test_state_sync import Job, KEY, _git, people_in_audit, state_blob  # noqa: E402


@pytest.fixture(autouse=True)
def _encryption_key(monkeypatch):
    monkeypatch.setenv("STATE_KEY", KEY)


@pytest.fixture()
def origin(tmp_path):
    bare = tmp_path / "origin.git"
    _git(tmp_path, "init", "--quiet", "--bare", "--initial-branch=main", str(bare))
    seed = tmp_path / "seed-checkout"
    _git(tmp_path, "init", "--quiet", "--initial-branch=main", str(seed))
    (seed / "README").write_text("seed\n")
    _git(seed, "add", "-A")
    _git(seed, "commit", "--quiet", "-m", "seed")
    _git(seed, "remote", "add", "origin", str(bare))
    _git(seed, "push", "--quiet", "origin", "main")
    return bare


@pytest.fixture()
def job(m, origin, tmp_path):
    workspace = tmp_path / "runs"
    workspace.mkdir()

    def factory(name: str) -> Job:
        return Job(m, origin, workspace, name)

    return factory


def _openssl(*args: str, data: bytes | None = None) -> bytes:
    proc = subprocess.run(
        ["openssl", "enc", *state_sync.ENCRYPT_ARGS, *args, "-pass", "env:STATE_KEY"],
        input=data, capture_output=True, check=True)
    return proc.stdout


def legacy_encrypt(db: Path, out: Path) -> None:
    """The pre-2026-11-09 form: the raw SQLite file, encrypted, no compression."""
    out.write_bytes(_openssl("-in", str(db)))


def plaintext_of(blob: bytes) -> bytes:
    return _openssl("-d", data=blob)


def push_legacy(run: Job) -> None:
    """What an OLD-code job's push put on the branch: its file, uncompressed,
    on the current tip (a normal fast-forward)."""
    enc = run.repo.parent / f"{run.name}.legacy.enc"
    legacy_encrypt(run.db, enc)
    tip = state_sync.fetch_state(run.repo)
    commit = state_sync._commit_blob(run.repo, enc, tip, "state: legacy uncompressed blob")
    rc, out = state_sync.git(run.repo, "push", "origin", f"{commit}:refs/heads/state", check=False)
    assert rc == 0, out
    enc.unlink()


@pytest.fixture()
def legacy_seeded(job, origin):
    """A branch exactly as production has it today: an uncompressed blob."""
    first = job("legacy-seed")
    first.ensure_db()
    first.write_send(1)
    push_legacy(first)
    assert plaintext_of(state_blob(origin)).startswith(state_sync.SQLITE_HEADER)
    return first


# ── the new form ─────────────────────────────────────────────────────────────


def test_a_push_writes_the_compressed_form_and_it_reads_back(job, origin):
    a = job("daily-automation")
    assert a.pull() == 0
    a.write_send(101)
    assert a.push() == 0

    raw = state_blob(origin)
    assert not raw.startswith(state_sync.SQLITE_HEADER), "plaintext on the branch"
    assert plaintext_of(raw).startswith(state_sync.GZIP_HEADER), "the push did not compress"

    reader = job("verifier")
    assert reader.pull() == 0
    assert people_in_audit(reader.db) == {101}


def test_compression_takes_a_realistic_db_far_under_the_limit(job, origin, tmp_path):
    """Audit rows are repetitive JSON. A DB of them must shrink several-fold, which
    is what turns 108 MB back into a fraction of GitHub's 100 MiB limit."""
    writer = job("bulk")
    assert writer.pull() == 0
    writer.ensure_db()
    rng = random.Random(7)
    conn = sqlite3.connect(writer.db)
    with conn:
        conn.executemany(
            "INSERT INTO audit_log(created_at, person_id, action, status, details) VALUES (?,?,?,?,?)",
            [(f"2026-11-0{1 + n % 8}T1{n % 10}:{n % 60:02d}:00+00:00", 10_000 + rng.randrange(3_000),
              rng.choice(["pond_nurture", "seller_nurture", "speed_to_lead", "reply_detected"]),
              rng.choice(["sent", "suppressed", "skipped", "deferred"]),
              json.dumps({"reason": rng.choice(["excluded stage/tag or manual suppression tag",
                                                "not in configured pond", "contacted recently",
                                                "cadence not due"]),
                          "contact_name": f"Lead #{n}", "city": rng.choice(["Austin", "San Antonio"])}))
             for n in range(40_000)])
    conn.close()

    legacy = tmp_path / "legacy.enc"
    legacy_encrypt(writer.db, legacy)
    compressed = tmp_path / "new.enc"
    state_sync.encrypt(writer.db, compressed)
    assert compressed.stat().st_size * 4 < legacy.stat().st_size, (
        compressed.stat().st_size, legacy.stat().st_size)

    assert writer.push() == 0
    reader = job("verifier")
    assert reader.pull() == 0
    conn = sqlite3.connect(reader.db)
    assert conn.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0] == 40_000
    conn.close()


# ── backward compatibility with today's branch ──────────────────────────────


def test_a_branch_holding_the_old_uncompressed_blob_still_pulls(job, legacy_seeded):
    reader = job("new-code-reader")
    assert reader.pull() == 0
    assert people_in_audit(reader.db) == {1}


def test_the_first_new_push_carries_the_old_rows_forward_compressed(job, legacy_seeded, origin):
    a = job("daily-automation")
    assert a.pull() == 0
    a.write_send(101)
    assert a.push() == 0
    assert plaintext_of(state_blob(origin)).startswith(state_sync.GZIP_HEADER)

    reader = job("verifier")
    assert reader.pull() == 0
    assert people_in_audit(reader.db) == {1, 101}


def test_an_old_code_sibling_pushing_uncompressed_mid_run_is_merged_not_lost(job, legacy_seeded):
    """During the switch an in-flight job still running the old code can push an
    uncompressed blob after a new-code job pulled. The new push must decrypt that
    legacy blob, merge it, and keep everyone's rows."""
    new, old = job("daily-automation"), job("reply-detection-old-code")
    assert new.pull() == 0
    assert old.pull() == 0
    old.write_send(202)
    push_legacy(old)

    new.write_send(101)
    assert new.push() == 0
    reader = job("verifier")
    assert reader.pull() == 0
    assert people_in_audit(reader.db) == {1, 101, 202}


# ── recovery ─────────────────────────────────────────────────────────────────


def test_every_earlier_state_commit_stays_a_readable_backup(job, legacy_seeded, origin, tmp_path):
    """Nothing is rewritten: each commit on the branch, old form or new, decrypts
    to a DB with the rows it held — so any of them can be restored from."""
    for n in (2, 3):
        writer = job(f"writer-{n}")
        assert writer.pull() == 0
        writer.write_send(n * 100)
        assert writer.push() == 0

    commits = _git(origin, "rev-list", "--reverse", "refs/heads/state").splitlines()
    assert len(commits) == 3
    seen = []
    for i, commit in enumerate(commits):
        blob = subprocess.run(["git", "cat-file", "blob", f"{commit}:{state_sync.BLOB_PATH}"],
                              cwd=str(origin), capture_output=True, check=True).stdout
        enc, out = tmp_path / f"c{i}.enc", tmp_path / f"c{i}.sqlite3"
        enc.write_bytes(blob)
        state_sync.decrypt(enc, out)
        seen.append(people_in_audit(out))
    assert seen == [{1}, {1, 200}, {1, 200, 300}]
    forms = [plaintext_of(subprocess.run(
        ["git", "cat-file", "blob", f"{c}:{state_sync.BLOB_PATH}"],
        cwd=str(origin), capture_output=True, check=True).stdout)[:2] for c in commits]
    assert forms[0] == state_sync.SQLITE_HEADER[:2] and forms[1:] == [state_sync.GZIP_HEADER] * 2


def test_an_unreadable_payload_is_refused_and_never_replaces_the_db(job, legacy_seeded, tmp_path, capsys):
    reader = job("reader")
    assert reader.pull() == 0
    before = reader.db.read_bytes()

    junk = tmp_path / "junk.enc"
    junk.write_bytes(_openssl(data=os.urandom(4096)))
    with pytest.raises(state_sync.StateSyncError, match="refusing to use it"):
        state_sync.decrypt(junk, reader.db)
    assert reader.db.read_bytes() == before

    bad_gzip = tmp_path / "bad.enc"
    bad_gzip.write_bytes(_openssl(data=state_sync.GZIP_HEADER + os.urandom(4096)))
    with pytest.raises(state_sync.StateSyncError):
        state_sync.decrypt(bad_gzip, reader.db)
    assert reader.db.read_bytes() == before


# ── the size guard and honest failure messages ──────────────────────────────


def test_a_blob_over_the_safety_limit_is_refused_before_it_is_sent(job, legacy_seeded, origin, monkeypatch, capsys):
    tip_before = _git(origin, "rev-parse", "refs/heads/state")
    a = job("daily-automation")
    assert a.pull() == 0
    a.write_send(101)
    monkeypatch.setattr(state_sync, "MAX_BLOB_BYTES", 10)
    assert a.push() == 1
    out = capsys.readouterr().out
    assert "safety limit" in out and "NOT persisted" in out and "Nothing was overwritten" in out
    assert _git(origin, "rev-parse", "refs/heads/state") == tip_before


def test_a_size_refusal_by_the_remote_is_named_and_not_retried(job, legacy_seeded, origin, capsys):
    """What GitHub said on 2026-11-08 six times over, each logged as "the branch
    moved again". It is not a race: say what it is, once, and stop."""
    hook = origin / "hooks" / "pre-receive"
    hook.write_text(
        "#!/bin/sh\n"
        "echo 'error: GH001: Large files detected.' >&2\n"
        "echo 'error: File pond-nurture-bot/data/fub_automation.sqlite3.enc is 103.15 MB; "
        "this exceeds the file size limit of 100.00 MB' >&2\n"
        "exit 1\n")
    hook.chmod(0o755)

    a = job("daily-automation")
    assert a.pull() == 0
    a.write_send(101)
    assert a.push(attempts=6) == 1
    out = capsys.readouterr().out
    hook.unlink()

    assert "not a lost race" in out and "GH001" in out and "file size limit" in out
    assert "attempt 2" not in out, "a size refusal was retried as if it were a race"
    assert "the branch moved again" not in out
    assert "NOT persisted" in out

    reader = job("verifier")
    assert reader.pull() == 0
    assert people_in_audit(reader.db) == {1}, "the branch must be exactly as it was"


def test_a_lost_race_is_still_retried(job, legacy_seeded, monkeypatch):
    """The CAS retry for genuine races is unchanged: a sibling lands between our
    fetch and our push, we re-merge and land on the next attempt."""
    a, b = job("daily-automation"), job("speed-to-lead")
    assert a.pull() == 0
    assert b.pull() == 0
    a.write_send(101)
    b.write_send(202)

    real_commit = state_sync._commit_blob
    raced = {"done": False}

    def commit_then_lose_the_race(repo, enc, parent, message):
        commit = real_commit(repo, enc, parent, message)
        if repo == a.repo and not raced["done"]:
            raced["done"] = True
            assert b.push() == 0          # B lands first
        return commit

    monkeypatch.setattr(state_sync, "_commit_blob", commit_then_lose_the_race)
    assert a.push() == 0
    reader = job("verifier")
    assert reader.pull() == 0
    assert people_in_audit(reader.db) == {1, 101, 202}


# ── a run killed mid-write by the job timeout ───────────────────────────────


def test_a_db_left_mid_transaction_by_a_killed_run_is_rolled_back_before_pushing(job, legacy_seeded):
    """The push runs under `if: always()`, also after the job timeout killed the
    automation. Here a child process starts a write, spills pages into the main
    file and is killed before committing, leaving a hot journal. The push must
    push the last COMMITTED state, intact — not the half-written file."""
    a = job("daily-automation")
    assert a.pull() == 0
    a.write_send(101)                                   # committed

    child = (
        "import os, sqlite3, sys\n"
        "conn = sqlite3.connect(sys.argv[1], isolation_level=None)\n"
        "conn.execute('PRAGMA cache_size=1')\n"
        "conn.execute('BEGIN IMMEDIATE')\n"
        "for n in range(3000):\n"
        "    conn.execute(\"INSERT INTO audit_log(created_at, person_id, action, status, details) \"\n"
        "                 \"VALUES ('2026-11-08T19:42:00+00:00', ?, 'pond_nurture', 'sent', ?)\", (50000 + n, 'x' * 300))\n"
        "os._exit(0)\n"                                  # killed: no commit, no rollback
    )
    subprocess.run([sys.executable, "-c", child, str(a.db)], check=True)
    journal = a.db.with_name(a.db.name + "-journal")
    assert journal.exists() and journal.stat().st_size > 0, "precondition: a hot journal"

    assert a.push() == 0
    reader = job("verifier")
    assert reader.pull() == 0
    assert people_in_audit(reader.db) == {1, 101}, "uncommitted rows leaked, or committed rows lost"
    conn = sqlite3.connect(reader.db)
    assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    conn.close()


def test_a_corrupt_local_db_is_refused_and_the_branch_is_untouched(job, legacy_seeded, origin, capsys):
    tip_before = _git(origin, "rev-parse", "refs/heads/state")
    a = job("daily-automation")
    assert a.pull() == 0
    a.db.write_bytes(b"this is not a database" * 1000)
    assert state_sync.main(["push", "--repo", str(a.repo), "--baseline", str(a.baseline)]) == 1
    assert "refusing to push it" in capsys.readouterr().out
    assert _git(origin, "rev-parse", "refs/heads/state") == tip_before
