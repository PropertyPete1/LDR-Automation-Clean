"""Audit regressions (pre-scale audit, 2026-07). See ldr-audit/FINDINGS.md.

Every test here pins a defect that was live in the shipped volume upgrade.
No network, no SMTP, no FUB writes — mocks only.
"""
from __future__ import annotations

import datetime as dt
import re
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from fub_automation import seller_nurture as sn


# ── Compliance rails: TREC / CAN-SPAM on every seller email path ────────────

@pytest.fixture
def rules_stub():
    r = MagicMock()
    r.company_name = "Lifestyle Design Realty"
    r.company_address = "1209 S Saint Marys St #232, San Antonio, TX 78210"
    r.owner_email = "peter@lifestyledesignrealty.com"
    r.team_email = "team@lifestyledesignrealty.com"
    return r


def test_iabs_link_is_not_the_dead_2024_url():
    """Regression: IABS-2024.pdf returned 404 — a dead regulatory disclosure
    on every seller email. Verified 200 as IABS%201-2_1.pdf on 2026-07-24."""
    assert "IABS-2024.pdf" not in sn.TREC_IABS_URL
    assert sn.TREC_IABS_URL.startswith("https://www.trec.texas.gov/")
    assert sn.TREC_IABS_URL.endswith(".pdf")


def test_both_email_bodies_carry_trec_links_and_can_spam_footer(rules_stub):
    """HTML and plaintext must each carry both TREC links, the physical
    address, and unsubscribe instructions — not one or the other."""
    html = sn.build_seller_email_html("Hey there.\n\nHow's the house?", rules_stub)
    text = sn.build_seller_email_plaintext("Hey there.\n\nHow's the house?", rules_stub)
    for body in (html, text):
        assert sn.TREC_IABS_URL in body
        assert sn.TREC_CONSUMER_PROTECTION_URL in body
        assert rules_stub.company_address in body
        assert "UNSUBSCRIBE" in body.upper()


def test_plaintext_and_html_signatures_cannot_drift(rules_stub):
    """The plaintext signature used to hardcode its own copy of the TREC URLs,
    which is how the IABS link rotted in only one of the two versions."""
    text = sn.build_seller_email_plaintext("Body.", rules_stub)
    urls = set(re.findall(r"https://www\.trec\.texas\.gov/\S+", text))
    assert urls == {sn.TREC_IABS_URL, sn.TREC_CONSUMER_PROTECTION_URL}


def test_no_seller_copy_references_divorce_foreclosure_or_sourcing():
    """No prompt or template may hint at how the lead was found. The only
    permitted mentions are the negative constraints in the prompt itself."""
    source = Path(sn.__file__).read_text()
    banned = ("divorce", "foreclos", "probate", "distressed", "skip trace",
              "county record", "public record", "absentee")
    for line in source.splitlines():
        low = line.lower()
        for word in banned:
            if word in low:
                # allowed only as an explicit prohibition to the model
                assert ("never" in low or "not " in low or "no " in low), (
                    f"'{word}' appears in seller copy without a prohibition: {line}")


# ── Bounce / suppression rails ─────────────────────────────────────────────

def test_dnc_does_not_suppress_the_email_only_seller_track():
    """DNC blocks calling/texting, not email — the seller track is email-only."""
    assert "dnc" not in sn.SELLER_SUPPRESS_TAGS


def test_unsubscribe_reply_and_bounce_tags_all_suppress():
    for tag in ("unsubscribe", "unsubscribed", "email opt out", "do not email",
                "bounced", "seller-replied", "replied - paused", "do not contact"):
        assert tag in sn.SELLER_SUPPRESS_TAGS, f"{tag} must suppress the seller track"


def test_exhausted_bounce_rotation_returns_no_send_address():
    assert sn.select_send_address(["a@x.com", "b@x.com"], ["A@X.com", "b@x.com"]) is None
    assert sn.select_send_address(["a@x.com", "b@x.com"], ["a@x.com"]) == "b@x.com"


# ── Ramp cap + long-tail rotation ──────────────────────────────────────────

def test_ramp_cap_advances_weekly_then_holds():
    ramp = [25, 25, 50, 50]
    anchor = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
    def cap_on(day):
        return sn.ramp_daily_cap(ramp, anchor, anchor + dt.timedelta(days=day))
    assert cap_on(0) == 25 and cap_on(6) == 25      # week 0
    assert cap_on(7) == 25                           # week 1
    assert cap_on(14) == 50 and cap_on(21) == 50     # weeks 2-3
    assert cap_on(400) == 50                         # holds at the last value
    assert sn.ramp_daily_cap(ramp, None) == 25       # no anchor yet


def test_longtail_angles_never_repeat_back_to_back():
    seen = [sn.longtail_angle_for(n) for n in range(sn.SELLER_SEQUENCE_LENGTH,
                                                    sn.SELLER_SEQUENCE_LENGTH + 12)]
    assert all(a != b for a, b in zip(seen, seen[1:]))
    assert set(seen) == set(sn.LONGTAIL_ANGLES)


# ── Idempotency: the send claim ledger ─────────────────────────────────────

@pytest.fixture()
def db(m, tmp_path):
    return m.AuditDB(str(tmp_path / "audit.sqlite3"))


def test_send_claim_is_granted_once_per_email(db):
    assert db.claim_seller_send(101, 0) is True
    assert db.claim_seller_send(101, 0) is False   # same email — refused
    assert db.claim_seller_send(101, 1) is True    # next email in sequence — ok
    assert db.claim_seller_send(102, 0) is True    # different lead — ok


def test_released_claim_can_be_retried(db):
    """A send that RAISED never left the building, so it must be retryable."""
    assert db.claim_seller_send(103, 2) is True
    db.release_seller_send_claim(103, 2)
    assert db.claim_seller_send(103, 2) is True


def test_crashed_send_is_not_repeated(m, db, monkeypatch, rules_stub):
    """The core idempotency guarantee: the drip row is bumped AFTER the send,
    so a crash in between must not re-send the same email on the next run."""
    engine = MagicMock()
    engine.db = db
    person_id = 555

    # Run 1: claim succeeds, then the process dies before upsert_seller_nurture_drip.
    assert db.claim_seller_send(person_id, 0) is True
    # (simulated crash — no drip row written, no release)

    # Run 2 sees emails_sent == 0 again and would re-send email #1.
    assert db.get_seller_nurture_enrollment(person_id) is None
    assert db.claim_seller_send(person_id, 0) is False, (
        "a crash after SMTP handoff must not allow the same email to go out twice")


def test_send_failure_releases_claim_and_does_not_advance_drip(m, db):
    """An SMTP exception must leave the lead exactly where it started."""
    person_id = 556
    assert db.claim_seller_send(person_id, 0) is True
    db.release_seller_send_claim(person_id, 0)
    assert db.get_seller_nurture_enrollment(person_id) is None
    assert db.claim_seller_send(person_id, 0) is True


# ── Daily cap is a DAY cap, not a per-run cap ──────────────────────────────

def test_daily_cap_counts_sends_already_made_today(m, db):
    """Regression: sent_count started at 0 every run, so a second dispatch on
    the same day handed out a whole second cap."""
    today = dt.datetime.now(dt.timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0).isoformat()
    assert db.count_seller_sends_since(today) == 0
    for pid in range(600, 605):
        db.log(sn.SELLER_NURTURE_AUDIT_ACTION, "sent", pid, {"email_number": 1})
    assert db.count_seller_sends_since(today) == 5
    # suppressed/skipped rows must not consume cap
    db.log(sn.SELLER_NURTURE_AUDIT_ACTION, "suppressed", 606, {"reason": "no email"})
    db.log(sn.SELLER_NURTURE_AUDIT_ACTION, "skipped", 607, {"reason": "cadence"})
    assert db.count_seller_sends_since(today) == 5


def test_yesterdays_sends_do_not_consume_todays_cap(m, db):
    old = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=2)).isoformat()
    with db.connect() as con:
        con.execute(
            "INSERT INTO audit_log(created_at, person_id, action, status, details) "
            "VALUES (?,?,?,?,?)",
            (old, 700, sn.SELLER_NURTURE_AUDIT_ACTION, "sent", "{}"))
    today = dt.datetime.now(dt.timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0).isoformat()
    assert db.count_seller_sends_since(today) == 0


# ── SMTP must not hang the run ─────────────────────────────────────────────

def test_smtp_send_uses_an_explicit_timeout(m, monkeypatch):
    """Without a timeout, one hung SMTP connection stalls the whole daily run
    until the 120-minute job timeout and every remaining lead goes unsent."""
    captured = {}

    class FakeSMTP:
        def __init__(self, host, port, timeout=None):
            captured["timeout"] = timeout
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def starttls(self):
            pass
        def login(self, u, p):
            pass
        def send_message(self, msg):
            captured["msg"] = msg

    monkeypatch.setattr(m.smtplib, "SMTP", FakeSMTP)
    s = m.Settings.from_env()
    s.dry_run = False
    s.smtp_host, s.smtp_port = "smtp.example", 587
    s.smtp_user, s.smtp_password = "u", "p"
    s.email_from = "peter@lifestyledesignrealty.com"
    m.EmailSender(s).send("lead@example.com", "Subj", "Body")
    assert captured["timeout"] == m.SMTP_TIMEOUT_SECONDS
    assert isinstance(captured["timeout"], (int, float)) and captured["timeout"] > 0


def test_bcc_header_is_not_transmitted(m, monkeypatch):
    """send_message strips Bcc — verify we rely on that and never leak the
    lead's other addresses (or Peter's) into a visible header."""
    sent = {}

    class FakeSMTP:
        def __init__(self, *a, **k):
            pass
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def starttls(self):
            pass
        def login(self, u, p):
            pass
        def send_message(self, msg):
            sent["to"] = msg["To"]
            sent["bcc"] = msg["Bcc"]

    monkeypatch.setattr(m.smtplib, "SMTP", FakeSMTP)
    s = m.Settings.from_env()
    s.dry_run = False
    s.smtp_host, s.smtp_port = "smtp.example", 587
    s.smtp_user, s.smtp_password = "u", "p"
    s.email_from = "peter@lifestyledesignrealty.com"
    m.EmailSender(s).send("lead@example.com", "Subj", "Body",
                          bcc=["other@example.com", "peter@lifestyledesignrealty.com"])
    # smtplib.send_message() is what removes Bcc before transmission; assert we
    # set it (so recipients are resolved) and that To stays the single lead.
    assert sent["to"] == "lead@example.com"
    assert "other@example.com" in (sent["bcc"] or "")


# ── End-to-end: the real send path, not just the ledger primitives ─────────

@pytest.fixture()
def seller_engine(m, engine, monkeypatch):
    """A real RuleEngine wired so process_seller_nurture_candidate can run
    end-to-end with no network: stub LLM, stub notes, recording email sender."""
    engine.sent = []

    def fake_send(to_email, subject, body, **kwargs):
        engine.sent.append({"to": to_email, "subject": subject, "body": body,
                            "kwargs": kwargs})
    monkeypatch.setattr(engine.email, "send", fake_send)
    monkeypatch.setattr(engine, "safe_get_notes", lambda pid: [])
    monkeypatch.setattr(engine, "_is_soi_silenced", lambda person: None)
    monkeypatch.setattr(engine.content, "should_skip_lead_llm", lambda p, n: (False, ""))
    monkeypatch.setattr(
        engine.content, "_llm_call",
        lambda **kw: '{"subject": "Your home", "email_body": "Hey there. Curious?"}')
    monkeypatch.setattr(engine.fub, "add_note", lambda *a, **k: None)
    return engine


def _seller_person(pid=9001):
    return {"id": pid, "firstName": "Dana", "lastName": "Lee",
            "tags": ["Seller Lead"], "emails": [{"value": "dana@example.com"}]}


def test_first_seller_email_sends_once(seller_engine):
    person = _seller_person()
    status = seller_engine.process_seller_nurture_candidate(person)
    assert status in ("sent", "dry_run_sent")
    assert len(seller_engine.sent) == 1
    assert seller_engine.sent[0]["to"] == "dana@example.com"


def test_crash_after_send_does_not_resend_on_next_run(seller_engine, monkeypatch):
    """THE regression: the drip row is bumped only after the send returns. Kill
    the process in between and the next run must not mail the lead again."""
    person = _seller_person(9002)

    def send_then_die(*a, **k):
        seller_engine.sent.append({"to": a[0]})
        raise KeyboardInterrupt("runner killed mid-send")   # not an Exception

    monkeypatch.setattr(seller_engine.email, "send", send_then_die)
    with pytest.raises(KeyboardInterrupt):
        seller_engine.process_seller_nurture_candidate(person)
    assert len(seller_engine.sent) == 1
    # The drip row was never written — the old code would resend email #1 here.
    assert seller_engine.db.get_seller_nurture_enrollment(9002)["emails_sent"] == 0

    delivered = []
    monkeypatch.setattr(seller_engine.email, "send",
                        lambda *a, **k: delivered.append(a[0]))
    status = seller_engine.process_seller_nurture_candidate(person)
    assert status == "skipped"
    assert delivered == [], "email #1 was sent twice after a crash"


def test_smtp_failure_is_retried_on_the_next_run(seller_engine, monkeypatch):
    """A raised send delivered nothing, so it must be retried — the claim is
    released. This is the counterpart to the crash case above."""
    person = _seller_person(9003)

    monkeypatch.setattr(seller_engine.email, "send",
                        lambda *a, **k: (_ for _ in ()).throw(OSError("smtp down")))
    with pytest.raises(OSError):
        seller_engine.process_seller_nurture_candidate(person)

    delivered = []
    monkeypatch.setattr(seller_engine.email, "send",
                        lambda *a, **k: delivered.append(a[0]))
    status = seller_engine.process_seller_nurture_candidate(person)
    assert status in ("sent", "dry_run_sent")
    assert delivered == ["dana@example.com"], "a failed send must be retried"


def test_cadence_still_blocks_the_second_email_same_day(seller_engine):
    """Guard against over-correction: normal cadence must be untouched."""
    person = _seller_person(9004)
    assert seller_engine.process_seller_nurture_candidate(person) in ("sent", "dry_run_sent")
    assert len(seller_engine.sent) == 1
    # Email #2 is day 4 — a same-day rerun must be a cadence skip, not a send.
    assert seller_engine.process_seller_nurture_candidate(person) == "skipped"
    assert len(seller_engine.sent) == 1


def test_suppressed_lead_never_claims_or_sends(seller_engine):
    """Suppression must short-circuit before the claim, or an unsubscribed lead
    would burn its email number and silently skip it later."""
    person = _seller_person(9005)
    person["tags"] = ["Seller Lead", "unsubscribe"]
    assert seller_engine.process_seller_nurture_candidate(person) == "suppressed"
    assert seller_engine.sent == []
    assert seller_engine.db.claim_seller_send(9005, 0) is True  # never claimed


def test_every_sent_seller_email_carries_the_compliance_footer(seller_engine):
    person = _seller_person(9006)
    seller_engine.process_seller_nurture_candidate(person)
    body = seller_engine.sent[0]["body"]
    html = seller_engine.sent[0]["kwargs"]["html_body"]
    for doc in (body, html):
        assert sn.TREC_IABS_URL in doc
        assert sn.TREC_CONSUMER_PROTECTION_URL in doc
        assert seller_engine.rules.company_address in doc
        assert "UNSUBSCRIBE" in doc.upper()
