"""The state DB has to survive two workflows running at once (issue #9).

Six workflows share one encrypted SQLite file on the `state` branch. Before this,
push was a whole-file overwrite with no compare-and-swap: a job that pulled before
a sibling's push and finished after it discarded everything the sibling wrote, and
BOTH pushes reported success. 2026-08-11 lost 150 pond sends that way, and then
lost the repair that rebuilt them to Reply Detection #459 four minutes after the
backfill said it was done.

So these tests are not unit tests of a merge function — they drive the real
protocol against real git repositories with real openssl encryption, in the exact
order the incident happened in:

    A pulls, B pulls, A writes X and pushes, B writes Y and pushes

and demand that both X and Y are on the branch afterwards. The one outcome that
must be impossible is the one that happened: a push that reports success while
throwing away rows it never saw.

test_the_pre_9_whole_file_push_is_what_lost_the_rows pins the old behaviour on the
same fixture, so the difference is visible in one file rather than in a changelog.
"""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from fub_automation import state_sync  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]          # pond-nurture-bot/
REPO_ROOT = ROOT.parent                             # repository root
WORKFLOWS = REPO_ROOT / ".github" / "workflows"
STATE_ACTION = REPO_ROOT / ".github" / "actions" / "state-sync" / "action.yml"
KEY = "test-state-encryption-key"

#: The six workflows that share the audit DB, with the timeout and cadence from
#: #9's table. The starvation argument below is arithmetic on these numbers.
SHARED_DB_WORKFLOWS = {
    "daily-automation.yml": {"timeout": 120, "cron": "0 12 * * *"},
    # 20 rather than 10 since the cancellation fix: the scan alone takes ~7
    # minutes over a ~1,050-lead watch list, and the timeout must leave room
    # for a slow FUB day plus the telemetry publish and state push after it.
    "reply-detection.yml": {"timeout": 20, "cron": "*/10 * * * *"},
    "speed-to-lead.yml": {"timeout": 10, "cron": "*/5 * * * *"},
    "nightly-health.yml": {"timeout": 20, "cron": "0 9 * * *"},
    "weekly-digest.yml": {"timeout": 10, "cron": "0 13 * * 1"},
    "backfill-reengagement.yml": {"timeout": 30, "cron": None},
    "reply-backfill.yml": {"timeout": 60, "cron": None},
    "ramp-repair.yml": {"timeout": 15, "cron": None},
}


# ── A workflow run, as far as the state DB is concerned ──────────────────────


def _git(repo: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", *args], cwd=str(repo), capture_output=True, text=True, check=True,
        env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
             "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"},
    )
    return proc.stdout.strip()


class Job:
    """One workflow run: its own checkout, its own DB, its own pull baseline.

    Runs are deliberately independent the way GitHub jobs are — separate
    machines, separate clones, and no way to see a sibling's file.
    """

    def __init__(self, m, origin: Path, workspace: Path, name: str):
        self.name = name
        self.repo = workspace / name
        _git(workspace, "clone", "--quiet", str(origin), name)
        self.db = self.repo / state_sync.DB_PATH
        self.baseline = workspace / f"{name}.baseline"
        self._m = m

    def pull(self) -> int:
        return state_sync.pull(self.repo, self.db, self.baseline)

    def push(self, attempts: int = state_sync.PUSH_ATTEMPTS) -> int:
        return state_sync.push(self.repo, self.db, self.baseline, attempts=attempts)

    def ensure_db(self):
        """The DB the automation would create for itself on a fresh runner."""
        self.db.parent.mkdir(parents=True, exist_ok=True)
        return self._m.AuditDB(str(self.db))

    def write_send(self, person_id: int, action: str = "pond_nurture") -> None:
        """One pond send, written the way main.py's AuditDB.log writes it."""
        self.ensure_db()
        conn = sqlite3.connect(self.db)
        with conn:
            conn.execute(
                "INSERT INTO audit_log(created_at, person_id, action, status, details) "
                "VALUES (?, ?, ?, 'sent', ?)",
                (f"2026-08-11T13:{person_id % 60:02d}:00+00:00", person_id, action,
                 json.dumps({"contact_name": f"Lead #{person_id}"})),
            )
        conn.close()

    def write_cadence_clock(self, person_id: int, last_sent_at: str) -> None:
        self.ensure_db()
        conn = sqlite3.connect(self.db)
        with conn:
            conn.execute(
                "INSERT INTO reengagement_log(person_id, last_sent_at, channel, city, message_hash) "
                "VALUES (?, ?, 'email', 'Austin', 'h') "
                "ON CONFLICT(person_id) DO UPDATE SET last_sent_at=excluded.last_sent_at",
                (person_id, last_sent_at),
            )
        conn.close()


def people_in_audit(db: Path) -> set[int]:
    conn = sqlite3.connect(db)
    rows = conn.execute("SELECT person_id FROM audit_log").fetchall()
    conn.close()
    return {row[0] for row in rows}


@pytest.fixture(autouse=True)
def _encryption_key(monkeypatch):
    """The runner hands the passphrase to openssl through the environment; so do
    the tests, which is also how the real key stays out of any argv."""
    monkeypatch.setenv("STATE_KEY", KEY)


@pytest.fixture()
def origin(tmp_path):
    """A bare repo standing in for GitHub, with main published.

    main carries .github/ and status/ on purpose: the old push checked out the
    `state` branch, which holds neither, and both of those absences caused real
    incidents.
    """
    bare = tmp_path / "origin.git"
    _git(tmp_path, "init", "--quiet", "--bare", "--initial-branch=main", str(bare))
    seed = tmp_path / "seed-checkout"
    _git(tmp_path, "init", "--quiet", "--initial-branch=main", str(seed))
    (seed / ".github" / "actions" / "state-sync").mkdir(parents=True)
    (seed / ".github" / "actions" / "state-sync" / "action.yml").write_text("name: state-sync\n")
    (seed / "status").mkdir()
    (seed / "status" / "daily_stats.json").write_text('{"emails_sent": 0}\n')
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


@pytest.fixture()
def seeded(job):
    """A `state` branch that already holds one send — the lineage both racing
    writers start from."""
    first = job("seed-run")
    assert first.pull() == 0
    first.write_send(1)
    assert first.push() == 0
    return first


def state_blob(origin: Path) -> bytes:
    return subprocess.run(
        ["git", "cat-file", "blob", f"refs/heads/state:{state_sync.BLOB_PATH}"],
        cwd=str(origin), capture_output=True, check=True).stdout


# ── THE acceptance case: two overlapping writers ─────────────────────────────


def test_two_overlapping_writers_cannot_discard_each_others_rows(job, seeded, origin):
    """The 2026-08-11 sequence exactly: A pulls, B pulls, A writes and pushes,
    B writes and pushes. Both rows must be on the branch afterwards.

    A push that reports success while dropping A's row is the outcome that has to
    be impossible — that is what published `emails_sent: 0` on a day 150 emails
    went out, and what made the 150 leads invisible to reply detection.
    """
    a, b = job("daily-automation"), job("speed-to-lead")
    assert a.pull() == 0
    assert b.pull() == 0                       # B's lineage predates A's write

    a.write_send(101)
    assert a.push() == 0
    b.write_send(202)
    assert b.push() == 0, "the second writer must not have to fail to be correct"

    after = job("verifier")
    assert after.pull() == 0
    assert people_in_audit(after.db) == {1, 101, 202}


def test_the_pre_9_whole_file_push_is_what_lost_the_rows(job, seeded):
    """The same fixture, driven by the push this repo shipped BEFORE #9.

    That push encrypted whatever the job happened to hold and committed it as a
    whole-file blob on the current tip — no compare-and-swap, no merge. It
    succeeded, and A's row was gone. This test is what the test above would look
    like against the old implementation, and it is here so the defect and the fix
    stay legible side by side.
    """
    a, b = job("daily-automation"), job("speed-to-lead")
    a.pull()
    b.pull()
    a.write_send(101)
    assert a.push() == 0
    b.write_send(202)
    assert _whole_file_push(b) == 0, "the old push reported success"

    after = job("verifier")
    after.pull()
    survivors = people_in_audit(after.db)
    assert survivors == {1, 202}, "B's whole file, exactly as B held it"
    assert 101 not in survivors, "this is the defect #9 describes"


def _whole_file_push(run: Job) -> int:
    """The pre-#9 algorithm: encrypt this job's file, commit it on the current
    tip, push. Kept to one helper, used only by the test above."""
    enc = run.repo / "whole-file.enc"
    state_sync.encrypt(run.db, enc)
    tip = state_sync.fetch_state(run.repo)
    commit = state_sync._commit_blob(run.repo, enc, tip, "state: whole-file overwrite")
    rc, _ = state_sync.git(run.repo, "push", "origin", f"{commit}:refs/heads/state", check=False)
    enc.unlink()
    return rc


def test_a_three_way_pileup_keeps_every_row(job, seeded):
    """Three workflows can be in flight at once — daily (120 min) trivially
    overlaps both of the ten-minute cadences."""
    runs = [job("daily-automation"), job("reply-detection"), job("speed-to-lead")]
    for run in runs:
        assert run.pull() == 0
    for n, run in enumerate(runs, start=1):
        run.write_send(100 * n)
        assert run.push() == 0

    after = job("verifier")
    after.pull()
    assert people_in_audit(after.db) == {1, 100, 200, 300}


def test_a_push_that_loses_the_race_at_the_last_instant_still_keeps_both(job, seeded, monkeypatch):
    """Compare-and-swap cannot be only a check before the push: the branch can
    move between the fetch and the push itself. Git's fast-forward rejection is
    what catches that window, and the retry re-merges on top of the newer state.

    The sibling here pushes AFTER our fetch has already read the old tip, which
    is precisely that window.
    """
    a, b = job("daily-automation"), job("speed-to-lead")
    a.pull()
    b.pull()
    a.write_send(101)

    real_fetch = state_sync.fetch_state
    fired = []

    def fetch_then_let_the_sibling_in(repo):
        tip = real_fetch(repo)
        if repo == a.repo and not fired:
            fired.append(True)
            b.write_send(202)
            assert b.push() == 0
        return tip

    with monkeypatch.context() as patched:
        patched.setattr(state_sync, "fetch_state", fetch_then_let_the_sibling_in)
        assert a.push() == 0
    assert fired, "the race was never triggered — the test proves nothing"

    after = job("verifier")
    after.pull()
    assert people_in_audit(after.db) == {1, 101, 202}


def test_a_push_that_cannot_land_fails_loudly_instead_of_forcing(job, seeded, origin, capsys):
    """The old push force-pushed after three failures, which is the silent-loss
    path itself. A push that cannot land must fail the step.

    A pre-receive hook that rejects everything stands in for "the branch keeps
    moving": the run's rows are lost either way, but now something says so.
    """
    hook = origin / "hooks" / "pre-receive"
    hook.write_text("#!/bin/sh\nexit 1\n")
    hook.chmod(0o755)

    a = job("daily-automation")
    a.pull()
    a.write_send(101)
    assert a.push(attempts=2) == 1

    out = capsys.readouterr().out
    assert "::error::" in out and "NOT persisted" in out
    hook.unlink()

    survivor = job("verifier")
    survivor.pull()
    assert people_in_audit(survivor.db) == {1}, "the branch must be exactly as it was"


def test_a_push_that_cannot_read_the_branch_does_not_replace_it(job, seeded, monkeypatch, capsys):
    """A commit built without the branch's tip as its parent can only land by
    forcing. If the branch cannot be read, the answer is to fail — not to push a
    file that was never reconciled with it."""
    a = job("daily-automation")
    a.pull()
    a.write_send(101)

    with monkeypatch.context() as patched:
        patched.setattr(state_sync, "fetch_state", lambda repo: None)
        assert a.push(attempts=2) == 1
    assert "does not descend from it" in capsys.readouterr().out

    after = job("verifier")
    after.pull()
    assert people_in_audit(after.db) == {1}


def test_no_push_path_ever_forces_or_switches_branches(job, seeded, monkeypatch):
    """Guard on every git command the push actually runs.

    --force is the silent-loss path itself. `checkout`/`switch`/`reset` are the
    other half: the old push checked out the 'state' branch, which is why a step
    after it could not load a local composite action and why one modified tracked
    file could refuse the whole thing.
    """
    seen: list[tuple[str, ...]] = []
    real_git = state_sync.git

    def recording(repo, *args, **kwargs):
        seen.append(args)
        return real_git(repo, *args, **kwargs)

    monkeypatch.setattr(state_sync, "git", recording)
    a = job("daily-automation")
    a.pull()
    a.write_send(101)
    assert a.push() == 0

    pushes = [args for args in seen if args and args[0] == "push"]
    assert pushes, "nothing was pushed"
    for args in seen:
        assert not any(a in ("--force", "-f", "--force-with-lease") for a in args), args
        assert args[0] not in ("checkout", "switch", "reset", "clean", "rm", "config"), args


# ── What the branch is allowed to contain ───────────────────────────────────


def test_the_state_branch_holds_nothing_but_the_encrypted_blob(job, seeded, origin):
    """Encrypted at rest, and only the DB: no working tree, no .github/, no
    plaintext. A DB pushed in the clear would put every lead's history in a
    public branch."""
    paths = _git(origin, "ls-tree", "-r", "--name-only", "refs/heads/state").splitlines()
    assert paths == [state_sync.BLOB_PATH]

    raw = state_blob(origin)
    assert not raw.startswith(b"SQLite format 3"), "the state DB is on the branch in the clear"
    assert b"pond_nurture" not in raw


def test_what_is_pushed_decrypts_back_to_the_same_rows(job, seeded, tmp_path, origin):
    """The round trip, through openssl both ways — the pull side has to be able
    to read what the push side wrote."""
    reader = job("verifier")
    assert reader.pull() == 0
    assert people_in_audit(reader.db) == {1}
    assert reader.baseline.read_text().strip() == _git(
        origin, "rev-parse", f"refs/heads/state:{state_sync.BLOB_PATH}")


def test_the_push_never_switches_branches_or_dirties_the_tree(job, seeded):
    """Why the `Restore the checkout after the state push` workaround can go.

    The old push did `git checkout -f state`, which left the job standing on a
    branch holding only the encrypted blob — no .github/, so no local composite
    action could load after it — and discarded local modifications to get there.
    This one builds the commit with plumbing and touches neither HEAD nor the
    tree.
    """
    a = job("daily-automation")
    a.pull()
    a.write_send(101)

    head_before = _git(a.repo, "rev-parse", "HEAD")
    branch_before = _git(a.repo, "rev-parse", "--abbrev-ref", "HEAD")
    # A modified tracked file is exactly what refused the old checkout and broke
    # state persistence for sixteen hours on 2026-08-11.
    (a.repo / "status" / "daily_stats.json").write_text('{"emails_sent": 41}\n')

    assert a.push() == 0

    assert _git(a.repo, "rev-parse", "HEAD") == head_before
    assert _git(a.repo, "rev-parse", "--abbrev-ref", "HEAD") == branch_before == "main"
    assert (a.repo / ".github" / "actions" / "state-sync" / "action.yml").exists()
    assert json.loads((a.repo / "status" / "daily_stats.json").read_text())["emails_sent"] == 41


def test_the_push_writes_nothing_into_the_checkout(job, seeded):
    """The pull baseline and the ciphertext both live outside the working tree:
    an untracked file under the checkout is one `git status --porcelain` away
    from breaking the next thing that reads it."""
    a = job("daily-automation")
    a.pull()
    a.write_send(101)
    before = _git(a.repo, "status", "--porcelain")
    assert a.push() == 0
    assert _git(a.repo, "status", "--porcelain") == before
    assert a.baseline.exists() and not a.baseline.is_relative_to(a.repo)


# ── Pulling ─────────────────────────────────────────────────────────────────


def test_the_first_ever_run_starts_fresh_and_creates_the_branch(job, origin):
    a = job("daily-automation")
    assert a.pull() == 0
    assert not a.db.exists(), "nothing to decrypt, and nothing invented"
    a.write_send(101)
    assert a.push() == 0
    assert _git(origin, "rev-parse", "--verify", "refs/heads/state")


def test_a_pull_that_cannot_reach_an_existing_branch_refuses_to_start_fresh(job, seeded, monkeypatch):
    """"Start fresh" is only correct when there is demonstrably nothing there.

    A run that starts from an empty DB while the branch holds a full one believes
    no lead has ever been emailed — every cadence and suppression gate in main.py
    reads these tables — so it would re-send to everyone. That must be a failed
    step, not a fresh start.
    """
    monkeypatch.setattr(state_sync, "fetch_state", lambda repo: None)
    a = job("daily-automation")
    assert state_sync.main(["pull", "--repo", str(a.repo), "--baseline", str(a.baseline)]) == 1
    assert not a.db.exists()


def test_a_push_with_no_pull_baseline_merges_instead_of_overwriting(job, seeded):
    """The push step runs with `if: always()`, so it can run after a failed pull.

    With no record of what this run started from, the branch has to be treated as
    moved — the alternative is overwriting a lineage this job may never have seen,
    which is the bug.
    """
    orphan = job("speed-to-lead")
    orphan.write_send(202)                     # a DB that never pulled anything
    assert not orphan.baseline.exists()
    assert orphan.push() == 0

    after = job("verifier")
    after.pull()
    assert people_in_audit(after.db) == {1, 202}


def test_a_repeated_push_of_the_same_file_is_a_no_op_for_the_rows(job, seeded):
    """Pushing twice (a rerun, or the backfill's push-then-verify) must not
    duplicate the day. audit_log has no unique key, so this is not free."""
    a = job("daily-automation")
    a.pull()
    a.write_send(101)
    assert a.push() == 0
    assert a.push() == 0

    after = job("verifier")
    after.pull()
    conn = sqlite3.connect(after.db)
    assert conn.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0] == 2
    conn.close()


def test_a_conflicting_push_never_moves_a_suppression_clock_backwards(job, seeded):
    """The merge direction that matters in the wild: A pulled at 13:00 and holds
    a stale clock for a lead B has since emailed. A's push must not hand the lead
    back to the cadence gate."""
    a, b = job("daily-automation"), job("speed-to-lead")
    a.pull()
    b.pull()
    a.write_cadence_clock(55, "2026-08-11T13:00:00+00:00")
    b.write_cadence_clock(55, "2026-08-11T21:00:00+00:00")
    assert b.push() == 0
    assert a.push() == 0                       # A lands second, with the older clock

    after = job("verifier")
    after.pull()
    conn = sqlite3.connect(after.db)
    clock = conn.execute("SELECT last_sent_at FROM reengagement_log WHERE person_id=55").fetchone()[0]
    conn.close()
    assert clock == "2026-08-11T21:00:00+00:00"


# ── The wiring the workflows actually use ───────────────────────────────────


def test_the_action_runs_the_module_the_way_production_will(job, seeded):
    """The command in action.yml, in a clean interpreter with only PYTHONPATH set
    — the arrangement test_import_paths.py exists to keep honest."""
    a = job("daily-automation")
    a.pull()
    a.write_send(101)
    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    env.update({"PYTHONPATH": str(ROOT / "src"), "STATE_KEY": KEY,
                "RUNNER_TEMP": str(a.baseline.parent)})
    proc = subprocess.run(
        [sys.executable, "-m", "fub_automation.state_sync", "push"],
        cwd=str(a.repo), env=env, capture_output=True, text=True, timeout=180)
    assert proc.returncode == 0, proc.stderr[-3000:]

    after = job("verifier")
    after.pull()
    assert people_in_audit(after.db) == {1, 101}


@pytest.mark.parametrize("mode", ["pull", "push"])
def test_the_action_yaml_and_the_module_cannot_drift(mode):
    action = yaml.safe_load(STATE_ACTION.read_text())
    steps = action["runs"]["steps"]
    step = next(s for s in steps if f"inputs.mode == '{mode}'" in s["if"])
    assert f"fub_automation.state_sync {mode}" in step["run"]
    assert "PYTHONPATH=pond-nurture-bot/src" in step["run"]
    # The passphrase reaches openssl through the environment, never argv.
    assert step["env"]["STATE_KEY"] == "${{ inputs.encryption_key }}"


def _workflow(name: str) -> dict:
    return yaml.safe_load((WORKFLOWS / name).read_text())


def _triggers(workflow: dict) -> dict:
    """YAML 1.1 reads a bare `on:` as the boolean True, so a workflow's triggers
    land under either key depending on the loader."""
    return workflow.get("on", workflow.get(True, {}))


def _state_sync_modes(workflow: dict) -> list[str]:
    modes = []
    for job_def in workflow["jobs"].values():
        for step in job_def["steps"]:
            if step.get("uses") == "./.github/actions/state-sync":
                modes.append(step["with"]["mode"])
    return modes


@pytest.mark.parametrize("name", sorted(SHARED_DB_WORKFLOWS))
def test_every_workflow_still_pulls_before_it_pushes(name):
    """A workflow that pushes without pulling would push a DB built from nothing.
    The merge would save the branch's rows, but the run would still have made
    every decision blind."""
    modes = _state_sync_modes(_workflow(name))
    assert modes, f"{name} no longer syncs the state DB at all"
    assert modes[0] == "pull"
    assert "push" in modes


def test_speed_to_leads_cadence_is_untouched():
    """#9's candidate fix 1 — one shared concurrency group for all six — is
    rejected here. GitHub queues at most one pending run per group and cancels
    the rest, so the 120-minute daily run would suspend Speed-to-Lead for two
    hours: the 30/60-minute new-lead promise, traded for a data bug fix it does
    not need.
    """
    wf = _workflow("speed-to-lead.yml")
    assert _triggers(wf)["schedule"] == [{"cron": "*/5 * * * *"}]
    assert wf["jobs"]["speed-to-lead"]["timeout-minutes"] == 10
    assert wf["concurrency"]["cancel-in-progress"] is True


def test_reply_detection_queues_rather_than_cancels_itself():
    """With cancel-in-progress: true, every delayed cron tick killed the
    still-running ~7-minute scan mid-list — 17 of 17 runs on 2026-08-24 ended
    'cancelled', taking the telemetry publish and state push with them. A new
    tick must QUEUE behind the running scan (GitHub keeps at most one pending
    run per group, so ticks coalesce rather than pile up)."""
    wf = _workflow("reply-detection.yml")
    assert wf["concurrency"]["cancel-in-progress"] is False


def test_no_two_scheduled_workflows_share_a_concurrency_group():
    """The starvation proof, as arithmetic rather than prose: a group is only
    ever held by one workflow, so the longest anything can wait for it is that
    workflow's own timeout — never the daily run's 120 minutes.

    A manual workflow may share a group (a one-shot repair has no cadence to
    starve), so only the scheduled six are checked here.
    """
    holders: dict[str, list[str]] = {}
    for name, facts in SHARED_DB_WORKFLOWS.items():
        if facts["cron"] is None:
            continue
        wf = _workflow(name)
        group = wf["concurrency"]["group"]
        assert "${{" not in group, f"{name}: a templated group can collide unpredictably"
        holders.setdefault(group, []).append(name)

    shared = {group: names for group, names in holders.items() if len(names) > 1}
    assert not shared, (
        "scheduled workflows sharing a concurrency group will queue behind each "
        f"other's timeouts: {shared}")


def test_the_crons_and_timeouts_the_starvation_argument_rests_on_are_still_true():
    """If the daily run's timeout or Speed-to-Lead's cadence changes, the
    reasoning above needs redoing — so pin the inputs to it."""
    for name, facts in SHARED_DB_WORKFLOWS.items():
        wf = _workflow(name)
        job_def = next(iter(wf["jobs"].values()))
        assert job_def["timeout-minutes"] == facts["timeout"], name
        schedule = _triggers(wf).get("schedule")
        assert (schedule[0]["cron"] if schedule else None) == facts["cron"], name
