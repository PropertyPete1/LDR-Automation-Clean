"""Note review memory: the skip check and the timeline check run once per
version of the notes they read (2026-09 cost audit).

Before this, both checks re-read every due lead's notes every morning. ~210
leads a day were re-skipped (97–99% the same people), each re-skip wrote
another "Pond Nurture Skipped" note, and every re-read was a fresh roll — 11
leads skipped at 85–95% were emailed one to three days later. Rechecked against
their human notes, none of those skips was real: seven leads had no human notes
at all and were skipped over the bot's own "Pond Nurture EMAIL Sent" logs, and
Janie Valdez (1992) was skipped for "she wants to just receive emails".
"""
from __future__ import annotations

import datetime as dt
import json
from types import SimpleNamespace

import pytest

from fub_automation import state_merge

UTC = dt.timezone.utc

HUMAN_NOTE = {"id": 1, "created": "2025-03-01T10:00:00Z", "subject": "",
              "body": "Called her, she said they closed on a house in May and are all set."}
BOT_SENT = {"id": 2, "created": "2026-09-01T16:00:00Z", "subject": "Pond Nurture EMAIL Sent",
            "body": "Automated two-week pond nurture outreach sent."}
BOT_SKIPPED = {"id": 3, "created": "2026-09-02T16:00:00Z", "subject": "🤖 Pond Nurture Skipped",
               "body": "Automated pond nurture email was skipped after reviewing recent FUB notes."}
BOT_REASSIGNED = {"id": 4, "created": "2026-08-01T16:00:00Z",
                  "subject": "🚨 Automation: Pond Lead Reassigned (Purchase Intent)", "body": "Reassigned."}
LIFESTYLE_SKIP = {"id": 5, "created": "2026-08-02T16:00:00Z", "subject": "",
                  "body": "[Lexi] Skipped automated follow-up. Reason: Notes indicate no follow-up needed"}
LIFESTYLE_SENT = {"id": 6, "created": "2026-08-03T16:00:00Z", "subject": "",
                  "body": "[Lexi] Follow-up email sent by Steven Smith on 8/3/2026"}
LIFESTYLE_SENT_OLD = {"id": 10, "created": "2026-06-22T16:00:00Z", "subject": "",
                      "body": "[Laila's Lifestyle Bot] Follow-up sent by Laila Maria on 6/22/2026. Subject: Checking on your search"}
CLICK_TO_TEXT = {"id": 11, "created": "2026-06-07T16:00:00Z", "subject": "Click-to-Text Follow-up Reminder Sent",
                 "body": "Automated click-to-text follow-up reminder sent to assigned agent (Laila)."}
COWORK = {"id": 7, "created": "2026-09-20T16:00:00Z", "subject": "[COWORK REENGAGE] Texted lead",
          "body": "[COWORK REENGAGE] Lead replied STOP. Tagged DNC-Text."}
OTHER_AUTOMATION = {"id": 8, "created": "2026-09-10T16:00:00Z",
                    "subject": "Automation: unverified inbound email — review",
                    "body": "Lead wrote back: we moved to Denver last month."}

COWORK_TAGS = ["Cowork-Reengage", "DNC-Text", "Opted Out", "Reengage-HOT",
               "Reengage-2027", "Reengage-Later", "Reengage-NoReply"]


# ── Which notes the checks read ──────────────────────────────────────────────


def test_bot_logs_and_cowork_notes_are_not_review_evidence(m):
    kept = m.notes_for_review([HUMAN_NOTE, BOT_SENT, BOT_SKIPPED, BOT_REASSIGNED,
                               LIFESTYLE_SKIP, LIFESTYLE_SENT, LIFESTYLE_SENT_OLD, CLICK_TO_TEXT,
                               COWORK, OTHER_AUTOMATION])
    assert [n["id"] for n in kept] == [1, 8], (
        "only what people wrote (and other automations' reports of what the lead "
        "said) may feed the skip and timeline checks"
    )


def test_fingerprint_ignores_the_bots_own_notes_and_cowork(m):
    base = m.note_review_fingerprint([HUMAN_NOTE])
    assert m.note_review_fingerprint([HUMAN_NOTE, BOT_SENT, BOT_SKIPPED]) == base
    assert m.note_review_fingerprint([COWORK, HUMAN_NOTE, LIFESTYLE_SKIP]) == base, (
        "Cowork texting notes must never count as 'notes changed' (owner's rule)"
    )


def test_fingerprint_moves_when_a_human_note_is_added_or_edited(m):
    base = m.note_review_fingerprint([HUMAN_NOTE])
    added = {"id": 9, "created": "2026-09-22T10:00:00Z", "subject": "", "body": "Back in the market!"}
    assert m.note_review_fingerprint([HUMAN_NOTE, added]) != base
    edited = dict(HUMAN_NOTE, body=HUMAN_NOTE["body"] + " Actually they backed out.")
    assert m.note_review_fingerprint([edited]) != base


def test_fingerprint_moves_when_the_review_prompts_change(m, monkeypatch):
    base = m.note_review_fingerprint([HUMAN_NOTE])
    monkeypatch.setattr(m, "NOTE_REVIEW_VERSION", m.NOTE_REVIEW_VERSION + "-next")
    assert m.note_review_fingerprint([HUMAN_NOTE]) != base


# ── Channel preferences never become a skip ──────────────────────────────────


@pytest.mark.parametrize("text", [
    "Nov 10, 2024: she said she wants to just receive emails",
    "Lead explicitly requested email-only contact, indicating preference to limit outreach "
    "channels. Sending automated emails respects this boundary.",
    "text only",
    "Prefers texting over calls",
])
def test_a_channel_preference_is_recognised(m, text):
    assert m.is_channel_preference_only(text)


@pytest.mark.parametrize("text", [
    "Lauren explicitly asked to stop texting. Clear opt-out request.",
    "prefers email, do not call",
    "Email only. Actually please unsubscribe me.",
    "just no more emails please",
    "Lead asked to be removed from the list",
    "Called: wants to buy in the spring",
])
def test_anything_asking_us_to_stop_is_not_a_mere_preference(m, text):
    assert not m.is_channel_preference_only(text)


def test_evidence_must_be_in_the_notes(m):
    notes = "1. Called her, she said they closed on a house in May and are all set."
    assert m.evidence_in_notes("she said they closed on a house in May", notes)
    assert m.evidence_in_notes("…closed on a house in May!", notes), "trimmed/re-punctuated quotes still count"
    assert not m.evidence_in_notes("They purchased a home last spring", notes), "a paraphrase is not a quote"
    assert not m.evidence_in_notes("May", notes), "too short to prove anything"


# ── The skip check's refusals ────────────────────────────────────────────────


def _gen_answering(m, settings, rules, monkeypatch, payload):
    gen = m.ContentGenerator(settings, rules)
    calls = []

    def fake(**kw):
        calls.append(kw)
        return json.dumps(payload) if isinstance(payload, dict) else payload

    monkeypatch.setattr(gen, "_llm_call", fake)
    return gen, calls


def test_janie_valdez_email_only_note_is_not_a_skip(m, settings, rules, monkeypatch):
    """The real 2026-09-15 answer: intent C, 85%, reasoning that says emailing
    respects the boundary — and should_skip true anyway."""
    gen, _ = _gen_answering(m, settings, rules, monkeypatch, {
        "should_skip": True, "intent_category": "C", "confidence": 85,
        "evidence": "she said she wants to just receive emails",
        "reason": "Lead explicitly requested email-only contact, indicating preference to limit "
                  "outreach channels. Sending automated emails respects this boundary.",
    })
    should_skip, _ = gen.should_skip_lead_llm(
        {"id": 1992}, [{"created": "2024-11-10", "body": "she said she wants to just receive emails"}])
    assert should_skip is False


def test_a_skip_without_a_named_intent_is_no_skip(m, settings, rules, monkeypatch):
    """John Gorafe (1782): 'SKIP (intent=none, confidence=85%)'."""
    gen, _ = _gen_answering(m, settings, rules, monkeypatch, {
        "should_skip": True, "intent_category": "none", "confidence": 85,
        "evidence": "this is a sales office", "reason": "Lead is a sales office."})
    assert gen.should_skip_lead_llm({"id": 1782}, [{"body": "this is a sales office"}])[0] is False


def test_bought_or_moved_needs_a_real_quote(m, settings, rules, monkeypatch):
    note = [{"body": "Called her, she said they closed on a house in May and are all set."}]
    invented = {"should_skip": True, "intent_category": "A", "confidence": 90,
                "evidence": "Lead has already received multiple automated emails", "reason": "redundant"}
    gen, _ = _gen_answering(m, settings, rules, monkeypatch, invented)
    assert gen.should_skip_lead_llm({"id": 2179}, note)[0] is False
    real = dict(invented, evidence="she said they closed on a house in May", reason="Bought in May")
    gen, _ = _gen_answering(m, settings, rules, monkeypatch, real)
    assert gen.should_skip_lead_llm({"id": 2179}, note) == (True, "Bought in May")


def test_asked_to_stop_is_honoured_even_with_a_paraphrased_quote(m, settings, rules, monkeypatch):
    """Compliance side: a C (or B) skip never depends on quote matching."""
    gen, _ = _gen_answering(m, settings, rules, monkeypatch, {
        "should_skip": True, "intent_category": "C", "confidence": 92,
        "evidence": "asked us to stop contacting him", "reason": "Asked to stop all contact"})
    should_skip, _ = gen.should_skip_lead_llm({"id": 5}, [{"body": "He said: quit calling and emailing me."}])
    assert should_skip is True


def test_a_lead_with_only_bot_notes_is_never_sent_to_the_model(m, settings, rules, monkeypatch):
    """The seven 'already received multiple automated emails' skips."""
    gen, calls = _gen_answering(m, settings, rules, monkeypatch, {
        "should_skip": True, "intent_category": "A", "confidence": 85,
        "evidence": "", "reason": "Already received multiple automated emails"})
    assert gen.should_skip_lead_llm({"id": 1868}, [BOT_SENT, BOT_SKIPPED, BOT_SENT]) == (False, "")
    assert gen.extract_purchase_window({"id": 1868}, [BOT_SENT, BOT_SKIPPED]) is None
    assert calls == [], "no human notes means nothing to review — and nothing to pay for"


def test_the_skip_prompt_carries_the_new_do_not_skip_rules(m, settings, rules, monkeypatch):
    gen, calls = _gen_answering(m, settings, rules, monkeypatch, '{"should_skip": false}')
    gen.should_skip_lead_llm({"id": 1, "firstName": "Pat"}, [HUMAN_NOTE])
    prompt = calls[0]["messages"][0]["content"]
    assert "preferred channel" in prompt and "never a reason to skip" in prompt
    assert "Peter Allen" in prompt and "our own team" in prompt
    assert "earlier emails from us" in prompt
    assert "evidence" in prompt


# ── The pond path: remembered checks, free checks first ──────────────────────


@pytest.fixture()
def pond(engine, monkeypatch):
    """A real RuleEngine with its FUB/SMTP edges and the model stubbed."""
    s = SimpleNamespace(notes=[HUMAN_NOTE], skip=(True, "Closed on a house in May"),
                        skip_calls=0, window_calls=0, drafts=0, note_fetches=0,
                        fub_notes=[], sends=0, last_sent=None, contacted=False,
                        opt_out=None, add_note_fails=False, notes_unreadable=False)
    monkeypatch.setattr(engine, "_has_any_deal", lambda pid: False)
    monkeypatch.setattr(engine, "_is_lease_listing_silenced", lambda pid: False)
    monkeypatch.setattr(engine, "_classify_engagement", lambda p: ("standard", None, "test"))
    monkeypatch.setattr(engine.db, "get_last_reengagement", lambda pid: s.last_sent)
    monkeypatch.setattr(engine, "was_contacted_recently", lambda p, days=3: s.contacted)
    monkeypatch.setattr(engine, "_check_incoming_opt_out", lambda pid, p: s.opt_out)
    monkeypatch.setattr(engine, "get_recent_email_thread", lambda pid, limit=5: "")

    def fetch(pid):
        s.note_fetches += 1
        return None if s.notes_unreadable else list(s.notes)

    def skip(person, notes):
        s.skip_calls += 1
        return s.skip

    def window(person, notes):
        s.window_calls += 1
        return None

    def draft(*a, **k):
        s.drafts += 1
        return {"subject": "Hi", "email_body": "Hello there", "freshness_angle": "x"}

    def add_note(pid, subject, body):
        if s.add_note_fails:
            raise RuntimeError("FUB 503")
        s.fub_notes.append(subject)
        return {}

    def send(*a, **k):
        s.sends += 1

    monkeypatch.setattr(engine, "safe_get_notes_deep", fetch)
    monkeypatch.setattr(engine.content, "should_skip_lead_llm", skip)
    monkeypatch.setattr(engine.content, "extract_purchase_window", window)
    monkeypatch.setattr(engine.content, "generate", draft)
    monkeypatch.setattr(engine.fub, "add_note", add_note)
    monkeypatch.setattr(engine.email, "send", send)
    return engine, s


LEAD = {"id": 501, "firstName": "Pat", "stage": "Lead", "tags": [], "assignedPondId": 2,
        "source": "Lifestyle Design Realty | San Antonio", "emails": [{"value": "pat@example.com"}]}


def test_a_skip_is_decided_once_and_noted_once(pond):
    engine, s = pond
    assert engine.process_reengagement_candidate(dict(LEAD)) == "suppressed"
    assert (s.skip_calls, s.window_calls, s.fub_notes) == (1, 1, ["🤖 Pond Nurture Skipped"])

    # Tomorrow: FUB now also holds yesterday's skip note — the bot's own words.
    s.notes.append(BOT_SKIPPED)
    assert engine.process_reengagement_candidate(dict(LEAD)) == "suppressed"
    assert (s.skip_calls, s.window_calls) == (1, 1), "same notes: no re-read, no fresh roll"
    assert s.fub_notes == ["🤖 Pond Nurture Skipped"], "one FUB note per decision, not per day"
    rows = engine.db.recent_audit_rows(["pond_nurture"], dt.datetime.now(UTC) - dt.timedelta(days=1))
    assert [r["status"] for r in rows].count("suppressed") == 2, "every day still leaves an audit row"
    assert any("decided_at" in json.loads(r["details"]) for r in rows)
    assert engine.review_stats["pond"]["skip_remembered"] == 1


def test_a_new_human_note_reopens_the_decision(pond):
    engine, s = pond
    engine.process_reengagement_candidate(dict(LEAD))
    s.notes.append({"id": 20, "created": "2026-09-23T10:00:00Z", "subject": "",
                    "body": "Talked to Pat — the house fell through, looking again in Stone Oak."})
    s.skip = (False, "")
    assert engine.process_reengagement_candidate(dict(LEAD)) == "dry_run_sent"
    assert (s.skip_calls, s.window_calls, s.drafts) == (2, 2, 1)


def test_cowork_notes_do_not_reopen_the_decision(pond):
    engine, s = pond
    engine.process_reengagement_candidate(dict(LEAD))
    s.notes.append(COWORK)
    engine.process_reengagement_candidate(dict(LEAD))
    assert s.skip_calls == 1, "Cowork's texting notes never count as a notes change"


def test_an_emailed_lead_is_not_re_reviewed_on_unchanged_notes(pond):
    engine, s = pond
    s.skip = (False, "")
    assert engine.process_reengagement_candidate(dict(LEAD)) == "dry_run_sent"
    assert (s.skip_calls, s.window_calls, s.drafts) == (1, 1, 1)
    # Next cycle: due again, only the bot's own send log was added to FUB.
    s.last_sent = dt.datetime.now(UTC) - dt.timedelta(days=15)
    s.notes.append(BOT_SENT)
    assert engine.process_reengagement_candidate(dict(LEAD)) == "dry_run_sent"
    assert (s.skip_calls, s.window_calls) == (1, 1), "no human change: both checks are remembered"
    assert s.drafts == 2, "every email is still drafted fresh"


def test_a_failed_skip_note_is_retried_then_never_repeated(pond):
    engine, s = pond
    s.add_note_fails = True
    engine.process_reengagement_candidate(dict(LEAD))
    assert s.fub_notes == []
    s.add_note_fails = False
    engine.process_reengagement_candidate(dict(LEAD))
    engine.process_reengagement_candidate(dict(LEAD))
    assert s.fub_notes == ["🤖 Pond Nurture Skipped"]
    assert s.skip_calls == 1


def test_no_email_address_costs_no_ai_call(pond):
    engine, s = pond
    lead = dict(LEAD, emails=[])
    assert engine.process_reengagement_candidate(lead) == "suppressed"
    assert (s.note_fetches, s.window_calls, s.skip_calls) == (0, 0, 0)


def test_contacted_in_the_last_three_days_costs_no_ai_call(pond):
    engine, s = pond
    s.contacted = True
    assert engine.process_reengagement_candidate(dict(LEAD)) == "skipped"
    assert (s.window_calls, s.skip_calls) == (0, 0)


def test_an_opt_out_is_caught_before_any_ai_call(pond):
    engine, s = pond
    s.opt_out = "opt_out_trashed"
    assert engine.process_reengagement_candidate(dict(LEAD)) == "opt_out_trashed"
    assert (s.window_calls, s.skip_calls) == (0, 0)


def test_unreadable_notes_skip_the_day_instead_of_emailing_blind(pond):
    """A FUB hiccup must not make a remembered skip invisible for a day."""
    engine, s = pond
    engine.process_reengagement_candidate(dict(LEAD))  # remembered: skip
    s.notes_unreadable = True
    assert engine.process_reengagement_candidate(dict(LEAD)) == "skipped"
    assert (s.skip_calls, s.drafts, s.sends) == (1, 0, 0)


def test_deep_notes_read_past_the_first_hundred(m, fub, fake_http):
    """Long daily-skip loops pushed human notes past FUB's first page."""
    page1 = [{"id": i, "subject": "🤖 Pond Nurture Skipped", "body": "skipped"} for i in range(100)]
    page2 = [{"id": 500, "subject": "", "body": "Lead asked us to stop all contact."}]
    fake_http.responses = [(200, {"notes": page1}), (200, {"notes": page2})]
    notes = fub.get_notes_deep(42)
    assert len(notes) == 101 and notes[-1]["id"] == 500
    assert [c.params.get("offset") for c in fake_http.calls] == [0, 100]
    assert [n["id"] for n in m.notes_for_review(notes)] == [500], "the buried human note is back in view"


def test_deep_notes_stop_if_the_api_ignores_offset(fub, fake_http):
    same = [{"id": i, "subject": "", "body": f"note {i}"} for i in range(100)]
    fake_http.responses = [(200, {"notes": same})]  # repeats forever
    assert len(fub.get_notes_deep(42)) == 100
    assert len(fake_http.calls) == 2, "a page with nothing new ends the walk"


# ── The seller track remembers too ───────────────────────────────────────────


def test_seller_skip_is_decided_once(engine, monkeypatch):
    calls = []
    monkeypatch.setattr(engine, "safe_get_notes", lambda pid: [HUMAN_NOTE])
    monkeypatch.setattr(engine, "safe_get_notes_deep", lambda pid: [HUMAN_NOTE])
    monkeypatch.setattr(engine.content, "should_skip_lead_llm",
                        lambda person, notes: calls.append(1) or (True, "Sold already"))
    seller = {"id": 777, "firstName": "Sam", "tags": [{"name": "Seller Lead"}],
              "source": "Seller Finder", "emails": [{"value": "sam@example.com"}]}
    assert engine.process_seller_nurture_candidate(dict(seller)) == "skipped"
    assert engine.process_seller_nurture_candidate(dict(seller)) == "skipped"
    assert len(calls) == 1
    assert engine.review_stats["seller"] == {"skip_fresh": 1, "skip_remembered": 1}


# ── Cowork's tags never suppress email ───────────────────────────────────────


def test_no_cowork_tag_suppresses_email(engine, rules):
    """Owner's rule (2026-09-24): Cowork texts pond leads from Peter's FUB
    number and tags them; none of those tags may stop the bot's email."""
    from fub_automation.seller_nurture import SELLER_SUPPRESS_TAGS

    lead = dict(LEAD, tags=[{"name": t} for t in COWORK_TAGS])
    assert engine.is_excluded(lead) is False
    assert engine.has_any_tag(lead, rules.phase2_manual_suppression_tags) is False
    assert engine.has_any_tag(lead, rules.email_opt_out_tags) is False
    assert engine.has_any_tag(lead, SELLER_SUPPRESS_TAGS) is False
    assert engine._is_soi_silenced(lead) is None


# ── The state DB merge keeps a verdict on the notes it read ──────────────────


def _review_row(**fields):
    row = {"person_id": 501, "fingerprint": "f1", "skip_checked_at": None, "should_skip": None,
           "skip_reason": None, "skip_note_at": None, "timeline_checked_at": None,
           "reviewed_at": "2026-09-25T10:00:00+00:00"}
    row.update(fields)
    return row


def test_merge_never_carries_a_verdict_onto_other_notes():
    spec = next(s for s in state_merge.PERSON_ROWS if s.name == "note_review")
    columns = list(_review_row())
    old = _review_row(fingerprint="f1", skip_checked_at="2026-09-25T10:00:00+00:00", should_skip=1,
                      skip_reason="Bought", reviewed_at="2026-09-25T10:00:00+00:00")
    new = _review_row(fingerprint="f2", timeline_checked_at="2026-09-25T11:00:00+00:00",
                      reviewed_at="2026-09-25T11:00:00+00:00")
    for a, b in ((old, new), (new, old)):
        merged = state_merge.reconcile_person_row(a, b, spec, columns)
        assert merged["fingerprint"] == "f2"
        assert merged["should_skip"] is None, "a skip reached on other notes must not ride along"


def test_merge_joins_the_two_halves_of_one_review():
    spec = next(s for s in state_merge.PERSON_ROWS if s.name == "note_review")
    columns = list(_review_row())
    skip_half = _review_row(skip_checked_at="2026-09-25T10:00:00+00:00", should_skip=0,
                            reviewed_at="2026-09-25T10:00:00+00:00")
    timeline_half = _review_row(timeline_checked_at="2026-09-25T10:05:00+00:00",
                                reviewed_at="2026-09-25T10:05:00+00:00")
    for a, b in ((skip_half, timeline_half), (timeline_half, skip_half)):
        merged = state_merge.reconcile_person_row(a, b, spec, columns)
        assert merged["should_skip"] == 0 and merged["timeline_checked_at"] is not None
