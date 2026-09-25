"""Batched pond drafts (cost fix 2): one Message Batch at half price, every
send-time check re-run on a fresh FUB record before each email, and an inline
fallback for anything the batch does not return in time.

The walk is unchanged — every lead passes the same checks in the same order.
What changes is WHEN the draft is made: after the walk, for all qualifying
leads at once. Minutes pass between a lead's checks and its send, so the checks
that can change in minutes (tags, pond, deals, the opt-out ledger, inbound
messages, the 3-day gap) run again right before it goes out.
"""
from __future__ import annotations

import datetime as dt
import json
from types import SimpleNamespace

import pytest

UTC = dt.timezone.utc


def _usage(i=4000, o=300):
    return SimpleNamespace(input_tokens=i, output_tokens=o,
                           cache_read_input_tokens=0, cache_creation_input_tokens=0)


def _message(text, usage=None):
    return SimpleNamespace(content=[SimpleNamespace(text=text)], usage=usage or _usage())


class FakeBatches:
    def __init__(self, state):
        self.state = state
        self.created, self.cancelled = [], []
        self.fail_create = False
        self.statuses = ["ended"]
        self.errored = set()

    def create(self, requests):
        if self.fail_create:
            raise RuntimeError("batches unavailable")
        self.created.append(list(requests))
        self.state.phase = "send"  # the walk is over; what happens now is "meanwhile"
        return SimpleNamespace(id="msgbatch_1", processing_status="in_progress")

    def retrieve(self, batch_id):
        status = self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]
        return SimpleNamespace(id=batch_id, processing_status=status)

    def results(self, batch_id):
        for req in self.created[-1]:
            cid = req["custom_id"]
            if cid in self.errored:
                yield SimpleNamespace(custom_id=cid, result=SimpleNamespace(type="errored"))
                continue
            text = json.dumps({"subject": f"Batch draft {cid}", "email_body": "Hello from the batch"})
            yield SimpleNamespace(custom_id=cid, result=SimpleNamespace(type="succeeded", message=_message(text)))

    def cancel(self, batch_id):
        self.cancelled.append(batch_id)


class FakeMessages:
    def __init__(self, state):
        self.sync_calls = []
        self.batches = FakeBatches(state)

    def create(self, **kwargs):
        self.sync_calls.append(kwargs)
        return _message(json.dumps({"subject": "Inline draft", "email_body": "Hello inline"}))


def _lead(pid):
    return {"id": pid, "firstName": f"Lead{pid}", "stage": "Lead", "tags": [], "assignedPondId": 2,
            "source": "Lifestyle Design Realty | San Antonio", "emails": [{"value": f"l{pid}@example.com"}]}


@pytest.fixture()
def run(engine, monkeypatch, m, fake_http):
    """A real RuleEngine walking three due pond leads, with FUB, SMTP and
    Anthropic faked. `s.fresh[pid]` is what FUB returns at send time;
    `s.at_send` holds per-lead send-time outcomes for the other checks."""
    s = SimpleNamespace(phase="walk", leads=[_lead(1), _lead(2), _lead(3)], fresh={},
                        at_send={}, sends=[], notes=[])
    s.fresh = {lead["id"]: dict(lead) for lead in s.leads}
    fake = FakeMessages(s)
    engine.content.client = SimpleNamespace(messages=fake)
    monkeypatch.setattr(m.time, "sleep", lambda secs: None)
    monkeypatch.delenv("POND_DRAFT_BATCH", raising=False)
    monkeypatch.delenv("POND_BATCH_MAX_WAIT_S", raising=False)
    monkeypatch.setenv("POND_DAILY_CAP", "300")
    monkeypatch.setattr(engine.fub, "get_people", lambda **params: [dict(lead) for lead in s.leads])

    def get_person(pid):
        value = s.fresh.get(pid)
        if isinstance(value, Exception):
            raise value
        return dict(value) if value else None

    def at_send(pid, check, walk_value):
        return s.at_send.get((pid, check), walk_value) if s.phase == "send" else walk_value

    monkeypatch.setattr(engine.fub, "get_person", get_person)
    monkeypatch.setattr(engine, "_has_any_deal", lambda pid: at_send(pid, "deal", False))
    monkeypatch.setattr(engine, "_is_lease_listing_silenced", lambda pid: False)
    monkeypatch.setattr(engine, "_classify_engagement", lambda p: ("standard", None, "test"))
    monkeypatch.setattr(engine.db, "get_last_reengagement", lambda pid: None)
    monkeypatch.setattr(engine, "safe_get_notes_deep", lambda pid: [])
    monkeypatch.setattr(engine, "safe_get_notes", lambda pid: [])  # customer_nurture_context re-reads empty notes
    monkeypatch.setattr(engine, "was_contacted_recently",
                        lambda p, days=3: at_send(int(p["id"]), "contacted", False))
    monkeypatch.setattr(engine, "_check_incoming_opt_out",
                        lambda pid, p: at_send(pid, "opt_out", None))
    monkeypatch.setattr(engine, "get_recent_email_thread", lambda pid, limit=5: "")
    monkeypatch.setattr(engine.email, "send", lambda to, subject, *a, **k: s.sends.append((to, subject)))
    monkeypatch.setattr(engine.fub, "add_note", lambda pid, subject, body: s.notes.append((pid, subject)))
    s.http = fake_http  # anything that still reaches FUB's HTTP layer is recorded, never sent
    return engine, s, fake


def _statuses(engine):
    rows = engine.db.recent_audit_rows(["pond_nurture"], dt.datetime.now(UTC) - dt.timedelta(hours=1))
    return {r["person_id"]: (r["status"], json.loads(r["details"] or "{}")) for r in rows}


# ── The happy path ───────────────────────────────────────────────────────────


def test_due_leads_are_drafted_in_one_batch_and_sent(run, m):
    engine, s, fake = run
    engine.scan_stale_leads()
    assert len(fake.batches.created) == 1, "one batch for the whole pond"
    assert [r["custom_id"] for r in fake.batches.created[0]] == ["pond-1", "pond-2", "pond-3"]
    assert fake.sync_calls == [], "nothing drafted inline when the batch returns everything"
    assert sorted(to for to, _ in s.sends) == ["l1@example.com", "l2@example.com", "l3@example.com"]
    assert all(subject.startswith("Batch draft pond-") for _, subject in s.sends)
    assert {status for status, _ in _statuses(engine).values()} == {"dry_run_sent"}
    assert s.http.calls == [], "the walk, the batch and the re-check are all stubbed — no stray FUB call"


def test_the_batched_request_is_the_inline_request(run, m):
    """Same model, prompt, temperature, schema and limits — only the price differs."""
    engine, s, fake = run
    engine.scan_stale_leads()
    batched = fake.batches.created[0][0]["params"]
    job_kwargs = dict(person=_lead(1), city="San Antonio", market_context="", lead_context="x",
                      recent_note_text="", recent_email_thread="", holiday="", engagement_tier="standard",
                      full_note_history="", last_angle_used="", is_value_led=False)
    assert batched["model"] == m.LLM_MODEL_ID
    assert batched["temperature"] == m.POND_DRAFT_TEMPERATURE
    assert batched["output_config"] == {"format": {"type": "json_schema", "schema": m.EMAIL_DRAFT_SCHEMA}}
    engine.content.generate(**job_kwargs)
    inline = fake.sync_calls[-1]
    assert set(inline) == set(batched)
    assert {k: v for k, v in inline.items() if k != "messages"} == {k: v for k, v in batched.items() if k != "messages"}


def test_batch_tokens_are_priced_at_half(run):
    engine, s, fake = run
    engine.scan_stale_leads()
    usage = engine.content.usage_summary()["by_type"]["pond_draft_batch"]
    assert usage["calls"] == 3
    assert usage["est_usd"] == pytest.approx(0.5 * 3 * (4000e-6 + 300 * 5e-6), abs=1e-4)


# ── Every send-time check runs again ─────────────────────────────────────────


def _assert_blocked(engine, s, pid, status, reason_part, fake):
    assert f"l{pid}@example.com" not in [to for to, _ in s.sends]
    got_status, details = _statuses(engine)[pid]
    assert got_status == status
    assert reason_part in details.get("reason", "")
    assert fake.sync_calls == [], "a lead that fails the re-check costs no inline draft"


def test_a_suppression_tag_added_meanwhile_stops_the_send(run):
    engine, s, fake = run
    s.fresh[2]["tags"] = [{"name": "Do Not Email"}]
    engine.scan_stale_leads()
    _assert_blocked(engine, s, 2, "suppressed", "send-time re-check", fake)
    assert len(s.sends) == 2


def test_an_opt_out_recorded_meanwhile_stops_the_send(run):
    engine, s, fake = run
    original = fake.batches.create

    def create_and_opt_out(requests):
        batch = original(requests)
        engine.db.record_opt_out(1, dt.datetime.now(UTC).isoformat(), "email", "reply_detection_keyword", "Unsubscribe")
        return batch

    fake.batches.create = create_and_opt_out
    engine.scan_stale_leads()
    _assert_blocked(engine, s, 1, "suppressed", "opt-out ledger", fake)


def test_an_inbound_stop_meanwhile_stops_the_send(run):
    engine, s, fake = run
    s.at_send[(3, "opt_out")] = "opt_out_trashed"
    engine.scan_stale_leads()
    assert "l3@example.com" not in [to for to, _ in s.sends]
    assert len(s.sends) == 2


def test_a_lead_moved_out_of_the_pond_meanwhile_is_not_sent(run):
    engine, s, fake = run
    s.fresh[2]["assignedPondId"] = None
    engine.scan_stale_leads()
    _assert_blocked(engine, s, 2, "suppressed", "no longer in the configured pond", fake)


def test_a_deal_opened_meanwhile_stops_the_send(run):
    engine, s, fake = run
    s.at_send[(1, "deal")] = True
    engine.scan_stale_leads()
    _assert_blocked(engine, s, 1, "suppressed", "deal", fake)


def test_contact_in_the_last_three_days_meanwhile_stops_the_send(run):
    engine, s, fake = run
    s.at_send[(2, "contacted")] = True
    engine.scan_stale_leads()
    _assert_blocked(engine, s, 2, "skipped", "contacted within last 3 days", fake)


def test_an_unreadable_fub_record_skips_the_lead_for_today(run):
    engine, s, fake = run
    s.fresh[3] = RuntimeError("FUB 503")
    engine.scan_stale_leads()
    _assert_blocked(engine, s, 3, "skipped", "FUB record unavailable", fake)


def test_the_send_uses_the_fresh_record(run):
    engine, s, fake = run
    s.fresh[1]["emails"] = [{"value": "new-address@example.com"}]
    engine.scan_stale_leads()
    assert "new-address@example.com" in [to for to, _ in s.sends]


# ── The inline fallback ──────────────────────────────────────────────────────


def test_a_failed_batch_falls_back_to_inline_drafts(run):
    engine, s, fake = run
    fake.batches.fail_create = True
    engine.scan_stale_leads()
    assert len(fake.sync_calls) == 3
    assert len(s.sends) == 3


def test_a_slow_batch_is_cancelled_and_drafted_inline(run, m, monkeypatch):
    engine, s, fake = run
    clock = [0.0]
    monkeypatch.setattr(m.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(m.time, "sleep", lambda secs: clock.__setitem__(0, clock[0] + secs))
    engine._run_started = 0.0
    monkeypatch.setenv("POND_BATCH_MAX_WAIT_S", "90")
    fake.batches.statuses = ["in_progress"]  # never ends
    engine.scan_stale_leads()
    assert fake.batches.cancelled == ["msgbatch_1"]
    assert len(fake.sync_calls) == 3
    assert len(s.sends) == 3


def test_one_errored_result_is_drafted_inline_and_the_rest_come_from_the_batch(run):
    engine, s, fake = run
    fake.batches.errored = {"pond-2"}
    engine.scan_stale_leads()
    assert len(fake.sync_calls) == 1
    assert sorted(subject for _, subject in s.sends) == ["Batch draft pond-1", "Batch draft pond-3", "Inline draft"]


def test_no_time_left_in_the_run_means_no_batch(run, m):
    engine, s, fake = run
    engine._run_started = m.time.monotonic() - engine.POND_PHASE_BUDGET_S
    engine.scan_stale_leads()
    assert fake.batches.created == []
    assert len(fake.sync_calls) == 3 and len(s.sends) == 3


def test_the_wait_leaves_room_for_an_all_inline_fallback(engine, m, monkeypatch):
    monkeypatch.delenv("POND_BATCH_MAX_WAIT_S", raising=False)
    engine._run_started = m.time.monotonic() - 50 * 60  # 50 minutes into the run
    wait = engine._pond_batch_wait_s(queued=100)
    assert wait == pytest.approx(engine.POND_PHASE_BUDGET_S - 50 * 60 - 100 * engine.POND_FALLBACK_S_PER_LEAD, abs=2)
    assert engine._pond_batch_wait_s(queued=10_000) == 0


# ── Cap and kill switch ──────────────────────────────────────────────────────


def test_queued_drafts_count_against_the_daily_cap(run, monkeypatch):
    engine, s, fake = run
    monkeypatch.setenv("POND_DAILY_CAP", "2")
    engine.scan_stale_leads()
    assert [r["custom_id"] for r in fake.batches.created[0]] == ["pond-1", "pond-2"]
    assert len(s.sends) == 2


def test_the_kill_switch_drafts_inline_as_before(run, monkeypatch):
    engine, s, fake = run
    monkeypatch.setenv("POND_DRAFT_BATCH", "off")
    engine.scan_stale_leads()
    assert fake.batches.created == []
    assert len(fake.sync_calls) == 3 and len(s.sends) == 3


def test_a_direct_call_still_drafts_and_sends_inline(run):
    """Only scan_stale_leads batches; process_reengagement_candidate alone is
    the old synchronous path."""
    engine, s, fake = run
    assert engine.process_reengagement_candidate(_lead(1)) == "dry_run_sent"
    assert len(fake.sync_calls) == 1 and fake.batches.created == []


def test_a_deal_opened_meanwhile_is_seen_through_the_run_cache(run, monkeypatch):
    """The real deal check caches per run. The re-check must ask FUB again."""
    engine, s, fake = run
    # Restore the real deal guard; every other stub stays.
    monkeypatch.setattr(engine, "_has_any_deal", type(engine)._has_any_deal.__get__(engine))
    deal = {"id": 9, "pipelineName": "Buyers", "stageName": "Under Contract"}
    # Walk: no deals for any lead. Send time: lead 1 now has one.
    s.http.responses = [(200, {"deals": []})] * 3 + [(200, {"deals": [deal]})] + [(200, {"deals": []})]
    engine.scan_stale_leads()
    assert "l1@example.com" not in [to for to, _ in s.sends]
    assert _statuses(engine)[1][0] == "suppressed"
    assert len(s.sends) == 2


def test_a_lead_the_batch_missed_is_re_checked_before_any_inline_draft(run):
    """No draft came back for lead 2 AND it was tagged meanwhile: it must be
    blocked without paying for an inline draft first."""
    engine, s, fake = run
    fake.batches.errored = {"pond-2"}
    s.fresh[2]["tags"] = [{"name": "Do Not Email"}]
    engine.scan_stale_leads()
    assert fake.sync_calls == [], "the re-check comes before the inline fallback"
    assert "l2@example.com" not in [to for to, _ in s.sends]
    assert len(s.sends) == 2


def test_a_walk_that_breaks_off_still_sends_what_qualified_and_leaves_batch_mode(run, monkeypatch):
    engine, s, fake = run

    def two_then_crash(**params):
        yield _lead(1)
        yield _lead(2)
        raise RuntimeError("FUB paging broke mid-walk")

    monkeypatch.setattr(engine.fub, "get_people", two_then_crash)
    with pytest.raises(RuntimeError):
        engine.scan_stale_leads()
    assert sorted(to for to, _ in s.sends) == ["l1@example.com", "l2@example.com"]
    assert engine._pond_draft_queue is None, "later calls must draft inline again"
