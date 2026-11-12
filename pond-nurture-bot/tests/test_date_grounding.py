"""Send-date grounding and property-address checks (2026-11-06 defects).

Three emails from the Nov 6 run, reproduced without sending anything:
  1. "Veterans Day this week / this weekend" — Veterans Day 2026 is
     Wednesday, November 11, the week AFTER a Friday, November 6 send.
  2. A post-close check-in to Jordan: "halfway through the year", "fantastic
     summer" — sent in November.
  3. A post-close check-in to Alexandra: "your home at Alexandra Examplefamily" — the deal
     NAME was used as the property address.

Every test runs in dry-run with the LLM and FUB stubbed: no SMTP, and
requests.request is replaced by the recording fake (fake_http), so no HTTP.
"""
from __future__ import annotations

import datetime as dt
import json

import pytest

from portal_history_fakes import complete_history

from fub_automation import datecontext as dc
from fub_automation.addresses import property_address_or_blank

UTC = dt.timezone.utc
NOV6 = dt.date(2026, 11, 6)    # Friday — the day of the bad sends
NOV11 = dt.date(2026, 11, 11)  # Wednesday — Veterans Day


# ── 1. Holiday facts come with an exact date ─────────────────────────────────

def test_nov6_sees_veterans_day_five_days_out_not_today():
    h = dc.upcoming_holiday(NOV6)
    assert h == dc.HolidayContext("Veterans Day", NOV11, 5)
    assert not h.is_today


def test_nov11_is_veterans_day_itself():
    h = dc.upcoming_holiday(NOV11)
    assert h.name == "Veterans Day" and h.is_today


def test_grounding_block_on_nov6_gives_the_date_and_forbids_relative_words_and_early_wishes():
    block = dc.grounding_block(NOV6, "America/Chicago", dc.upcoming_holiday(NOV6))
    assert "Friday, November 6, 2026" in block
    assert "Veterans Day is on Wednesday, November 11, 2026, 5 days after this email is sent. It is NOT today." in block
    assert "Do not wish them a happy Veterans Day yet" in block
    assert "'this weekend', 'this week'" in block
    assert "It is fall in Texas" in block


def test_grounding_block_on_nov11_allows_a_brief_wish():
    block = dc.grounding_block(NOV11, "America/Chicago", dc.upcoming_holiday(NOV11))
    assert "Today (Wednesday, November 11, 2026) is Veterans Day" in block


def test_no_holiday_in_window_means_no_holiday_mention():
    block = dc.grounding_block(dt.date(2026, 10, 14), "America/Chicago", dc.upcoming_holiday(dt.date(2026, 10, 14)))
    assert "Do not mention any holiday" in block


def test_year_boundary_sees_new_years_day():
    assert dc.upcoming_holiday(dt.date(2026, 12, 31)).name == "New Year's Eve"
    assert dc.upcoming_holiday(dt.date(2027, 1, 1)).name == "New Year's Day"


# ── 2. The send date is the LOCAL date, never UTC ───────────────────────────

def test_an_evening_central_run_is_still_the_same_day():
    # 9:30 PM Central on Nov 6 is 03:30 UTC on Nov 7.
    assert dc.send_date("America/Chicago", dt.datetime(2026, 11, 7, 3, 30, tzinfo=UTC)) == NOV6


# ── 3. The checker catches the Nov 6 wording and leaves correct wording alone ─

@pytest.mark.parametrize("text", [
    "Hope you have a great Veterans Day this weekend! 🇺🇸",
    "With Veterans Day this week, we wanted to say thank you.",
    "Happy Veterans Day from all of us!",
    "Veterans Day is Tuesday, November 11 this year.",
    # independent review counterexamples (all previously ACCEPTED):
    "Veterans Day is Thursday, November 12, 2026.",
    "Veterans Day is on November 12.",
    "It is summer in Texas.",
    "It's summer here and the pools are open.",
])
def test_nov6_bad_holiday_wording_is_rejected(text):
    assert dc.date_language_problems(text, NOV6)


def test_happy_veterans_day_the_day_before_is_rejected():
    # review counterexample: Nov 10 accepted "Happy Veterans Day!"
    assert dc.date_language_problems("Happy Veterans Day!", dt.date(2026, 11, 10))
    assert dc.date_language_problems("Happy early Veterans Day!", dt.date(2026, 11, 10)) == []


def test_new_years_eve_is_not_mistaken_for_new_years_day():
    # review counterexample: Dec 31 REJECTED "New Year's Eve is today"
    dec31 = dt.date(2026, 12, 31)
    assert dc.date_language_problems("New Year's Eve is today, so cheers!", dec31) == []
    assert dc.date_language_problems("New Year\u2019s Eve is today.", dec31) == []
    assert dc.date_language_problems("New Year's Day is tomorrow, Friday, January 1.", dec31) == []
    assert dc.date_language_problems("New Year's Day is today.", dec31)


def test_explicit_years_are_honoured_in_weekday_checks():
    # review counterexamples: correct 2027 date was rejected, wrong one accepted
    assert dc.date_language_problems("Thursday, November 11, 2027 works for us.", NOV6) == []
    assert dc.date_language_problems("Wednesday, November 11, 2027 works for us.", NOV6)
    assert dc.date_language_problems("We could meet Wednesday, Nov. 11.", NOV6) == []


@pytest.mark.parametrize("text", [
    "With Veterans Day coming up on Wednesday, November 11, thank you to everyone who served.",
    "Veterans Day is next week, on Wednesday, November 11.",
    "Are you still hoping to move before the end of the year?",
    "You mentioned wanting to start looking next summer.",
    "If you want to be settled in by this spring, now is a good time to plan.",
])
def test_nov6_correct_wording_passes(text):
    assert dc.date_language_problems(text, NOV6) == []


def test_happy_veterans_day_is_fine_on_the_day():
    assert dc.date_language_problems("Happy Veterans Day! Thank you to everyone who served.", NOV11) == []


@pytest.mark.parametrize("text", [
    "We're already halfway through the year!",
    "Hope you're having a fantastic summer in the new place! ☀️",
    "Hope you enjoyed this summer at the new house.",
])
def test_jordan_stale_season_wording_is_rejected_in_november(text):
    assert dc.date_language_problems(text, NOV6)


def test_summer_wording_is_fine_in_july():
    assert dc.date_language_problems("Hope you're having a fantastic summer!", dt.date(2026, 7, 15)) == []


# ── 4. grounded_json: one rewrite, then refuse ───────────────────────────────

class _ScriptedLLM:
    def __init__(self, drafts):
        self.drafts = list(drafts)
        self.prompts = []

    def __call__(self, messages, temperature=0.7, json_mode=True):
        self.prompts.append(messages[-1]["content"])
        return json.dumps(self.drafts.pop(0))


@pytest.fixture()
def content(engine, monkeypatch, fake_http):
    monkeypatch.setattr(engine.content, "send_day", lambda now=None: NOV6)
    return engine.content


def test_a_bad_draft_is_rewritten_once(content, monkeypatch):
    llm = _ScriptedLLM([
        {"subject": "Veterans Day weekend", "email_body": "Hey Sam,\nHappy Veterans Day this weekend!"},
        {"subject": "Quick question", "email_body": "Hey Sam,\nAre you still looking in Boerne?"},
    ])
    monkeypatch.setattr(content, "_llm_call", llm)
    out = content.grounded_json("PROMPT", 0.86, day=NOV6)
    assert out["subject"] == "Quick question"
    assert len(llm.prompts) == 2
    assert "REJECTED" in llm.prompts[1] and "Do not mention any holiday, season" in llm.prompts[1]


def test_the_real_wrapper_rejects_a_wrong_holiday_date(content, monkeypatch):
    """Review counterexample: grounded_json ACCEPTED "Veterans Day is Thursday,
    November 12, 2026". End to end through the wrapper, not just the helper."""
    wrong = {"subject": "Thank you", "email_body": "Hey Sam,\nVeterans Day is Thursday, November 12, 2026. Thank you!"}
    good = {"subject": "Quick question", "email_body": "Hey Sam,\nStill looking in Boerne?"}
    llm = _ScriptedLLM([wrong, good])
    monkeypatch.setattr(content, "_llm_call", llm)
    assert content.grounded_json("PROMPT", 0.86, day=NOV6) == good
    assert "gives Veterans Day the wrong date" in llm.prompts[1]
    monkeypatch.setattr(content, "_llm_call", _ScriptedLLM([wrong, wrong]))
    with pytest.raises(dc.DateGroundingError):
        content.grounded_json("PROMPT", 0.86, day=NOV6)


@pytest.mark.parametrize("wrong", [
    # revision-2 review counterexamples, run through the REAL wrapper
    "Veterans Day is Thursday, Nov. 12, 2026.",
    "Veterans Day is on November 12, but I can meet on November 11.",
    "November 12 is Veterans Day.",
])
def test_the_wrapper_rejects_a_wrong_holiday_date_however_it_is_written(content, monkeypatch, wrong):
    good = {"subject": "Quick question", "email_body": "Hey Sam,\nStill looking in Boerne?"}
    llm = _ScriptedLLM([{"subject": "Hi", "email_body": "Hey Sam,\n" + wrong}, good])
    monkeypatch.setattr(content, "_llm_call", llm)
    assert content.grounded_json("PROMPT", 0.86, day=NOV6) == good
    assert len(llm.prompts) == 2 and "gives Veterans Day the wrong date" in llm.prompts[1]


@pytest.mark.parametrize("valid", [
    # revision-2 review: these were falsely REJECTED
    "We could meet Friday, November 13, after Veterans Day.",
    "Thanksgiving is Thursday, November 25, 2027.",
    "Meet at 123 Oak St. on Nov. 13? Veterans Day is Nov. 11.",
    "Veterans Day (Nov. 11) is next week.",
])
def test_the_wrapper_accepts_correct_dates_near_a_holiday(content, monkeypatch, valid):
    draft = {"subject": "Hi", "email_body": "Hey Sam,\n" + valid}
    llm = _ScriptedLLM([draft])
    monkeypatch.setattr(content, "_llm_call", llm)
    assert content.grounded_json("PROMPT", 0.86, day=NOV6) == draft
    assert len(llm.prompts) == 1, "no rewrite was needed"


def test_two_bad_drafts_raise_so_nothing_is_sent(content, monkeypatch):
    bad = {"subject": "Happy Veterans Day", "email_body": "Hey Sam,\nHappy Veterans Day this week!"}
    monkeypatch.setattr(content, "_llm_call", _ScriptedLLM([bad, bad]))
    with pytest.raises(dc.DateGroundingError):
        content.grounded_json("PROMPT", 0.86, day=NOV6)


def test_pond_prompt_on_nov6_carries_the_exact_holiday_date_and_local_date(content, monkeypatch):
    llm = _ScriptedLLM([{"subject": "Boerne", "email_body": "Hey Sam,\nStill thinking about Boerne?"}])
    monkeypatch.setattr(content, "_llm_call", llm)
    content.generate({"id": 7, "firstName": "Sam"}, "Boerne", "", holiday=dc.upcoming_holiday(NOV6))
    prompt = llm.prompts[0]
    assert "Today is upcoming" not in prompt and "HOLIDAY CONTEXT: Today is" not in prompt
    assert "Veterans Day is on Wednesday, November 11, 2026" in prompt
    assert "Today's date is 2026-11-06" in prompt  # existing CRITICAL DATE AWARENESS rule, now local


def test_pond_prompt_still_accepts_the_legacy_string_holiday(content, monkeypatch):
    llm = _ScriptedLLM([{"subject": "Boerne", "email_body": "Hey Sam,\nStill thinking about Boerne?"}])
    monkeypatch.setattr(content, "_llm_call", llm)
    content.generate({"id": 7, "firstName": "Sam"}, "Boerne", "", holiday="upcoming Veterans Day")
    assert "Veterans Day is on Wednesday, November 11, 2026" in llm.prompts[0]


def test_closed_drip_prompt_is_dated_and_has_no_address_without_one(content, monkeypatch):
    llm = _ScriptedLLM([{"subject": "How's the house?", "email_body": "Hey Jordan,\nHow's the house treating you?"}])
    monkeypatch.setattr(content, "_llm_call", llm)
    content.generate_closed_drip_email({"id": 9, "firstName": "Jordan"}, "", "2026-04-10", [])
    prompt = llm.prompts[0]
    assert "this email is sent on Friday, November 6, 2026" in prompt
    assert "It is fall in Texas" in prompt
    assert "do not mention a street, address, or property name" in prompt
    assert "new restaurants" not in prompt  # no unsubstantiated "new" spots


# ── 5. Property address from the deal name ───────────────────────────────────

ALEXANDRA = {"id": 501, "firstName": "Alexandra", "lastName": "Examplefamily"}


@pytest.mark.parametrize("raw,reason", [
    ("Alexandra Examplefamily", "not_street_shaped"),
    ("Examplefamily, Alexandra - Purchase", "extra_text"),
    ("123 Examplefamily Ln", "contains_client_name"),
    ("Lot 12 Heritage Woods", "extra_text"),
    ("1200 Broadway", "no_street_type"),
    ("", "empty"),
    # review: trailing deal/title text after a street must not pass
    ("4510 Oak Bend Dr - Purchase", "extra_text"),
    ("4510 Oak Bend Dr Purchase", "extra_text"),
    ("123 Main St (Buyer)", "extra_text"),
    ("88 Oak Hollow Dr Buyer Rep", "extra_text"),
    ("123 Main St Smith", "no_street_type"),
    ("123 Main St, San Antonio, TX 78230, USA extra", "extra_text"),
])
def test_untrusted_deal_names_are_not_addresses(raw, reason):
    assert property_address_or_blank(raw, ALEXANDRA) == ("", reason)


@pytest.mark.parametrize("raw", [
    "4510 Oak Bend Dr, San Antonio, TX 78230",
    "12B Elm Ct",
    "12 Elm Ct #4, Austin, TX",
    "5 N Main St",
    "500 Bluebonnet Trl, Boerne, Texas",
])
def test_a_plain_street_address_is_kept(raw):
    # Syntactically plausible only — the notes say it came from the deal name, unverified.
    assert property_address_or_blank(raw, ALEXANDRA) == (raw, "")


@pytest.fixture()
def closed_engine(engine, monkeypatch, fake_http):
    """Closed-drip / congrats with FUB, Places and the LLM stubbed."""
    calls = {"notes": [], "spots": [], "generated_with": [], "sent": []}
    monkeypatch.setattr(engine.fub, "get_deals_for_person", lambda pid: [
        {"name": "Alexandra Examplefamily", "pipelineName": "Buyers", "stageName": "Closed", "projectedCloseDate": "2026-05-20"}])
    monkeypatch.setattr(engine.fub, "add_note", lambda pid, subj, body: calls["notes"].append((subj, body)) or {})
    monkeypatch.setattr(engine, "_fetch_local_spots", lambda addr: calls["spots"].append(addr) or [])
    monkeypatch.setattr(engine, "_has_closed_purchase_deal", lambda pid: True)
    monkeypatch.setattr(engine, "_is_lease_listing_silenced", lambda pid: False)
    monkeypatch.setattr(engine.email, "send", lambda *a, **k: calls["sent"].append((a, k)))

    def fake_drip(person, deal_address, close_date, local_spots):
        calls["generated_with"].append(deal_address)
        return {"subject": "How's the house?", "email_body": "Hey Alexandra,\nHow's the house?"}

    def fake_congrats(person, deal_address):
        calls["generated_with"].append(deal_address)
        return {"subject": "Congrats!", "email_body": "Hey Alexandra,\nCongrats on the new home!"}

    monkeypatch.setattr(engine.content, "generate_closed_drip_email", fake_drip)
    monkeypatch.setattr(engine.content, "generate_congrats_email", fake_congrats)
    engine._calls = calls
    monkeypatch.setattr(engine.fub, "get_person", lambda pid: {"id": pid, "source": "", "tags": []})
    monkeypatch.setattr(engine.fub, "get_email_portal_event_page", complete_history)
    return engine


def _alexandra(**extra):
    return {"id": 501, "firstName": "Alexandra", "lastName": "Examplefamily", "stage": "Closed", "tags": [],
            "emails": [{"value": "alexandra@example.com"}], **extra}


def test_alexandra_quarterly_check_in_never_uses_her_name_as_an_address(closed_engine, tmp_db):
    status = closed_engine.process_closed_drip_candidate(_alexandra())
    calls = closed_engine._calls
    assert status == "dry_run_sent"
    assert calls["generated_with"] == [""], "the deal name must not reach the prompt as an address"
    assert calls["spots"] == [], "and must not be sent to Google Places"
    # The existing FUB note is still written, and now says no address was used.
    (subject, body), = calls["notes"]
    assert subject == "Quarterly Check-In Email Sent"
    assert "Property: not mentioned (the deal name is not a street address)" in body
    rows = tmp_db.recent_audit_rows(["closed_drip"], dt.datetime.now(UTC) - dt.timedelta(days=1))
    assert {r["status"] for r in rows} == {"address_omitted", "dry_run_sent"}


def test_a_real_street_address_still_personalises_the_check_in(closed_engine, monkeypatch):
    monkeypatch.setattr(closed_engine.fub, "get_deals_for_person", lambda pid: [
        {"name": "4510 Oak Bend Dr", "pipelineName": "Buyers", "stageName": "Closed", "projectedCloseDate": "2026-05-20"}])
    assert closed_engine.process_closed_drip_candidate(_alexandra()) == "dry_run_sent"
    assert closed_engine._calls["generated_with"] == ["4510 Oak Bend Dr"]
    assert closed_engine._calls["spots"] == ["4510 Oak Bend Dr"]
    assert "Property: 4510 Oak Bend Dr (from the FUB deal name; not verified)" in closed_engine._calls["notes"][0][1]


def test_alexandra_congrats_email_never_uses_her_name_as_an_address(closed_engine):
    assert closed_engine.process_congrats_candidate(_alexandra()) == "dry_run_sent"
    assert closed_engine._calls["generated_with"] == [""]
    (subject, body), = closed_engine._calls["notes"]
    assert subject == "Automation: Congrats Email Sent"
    assert "no property address mentioned" in body and 'Subject: "Congrats!"' in body


def test_a_date_grounding_failure_defers_the_check_in_without_sending_or_noting(closed_engine, monkeypatch, tmp_db):
    def refuse(**kwargs):
        raise dc.DateGroundingError(["says it is the middle of the year"])
    monkeypatch.setattr(closed_engine.content, "generate_closed_drip_email", refuse)
    assert closed_engine.process_closed_drip_candidate(_alexandra()) == "deferred"
    assert closed_engine._calls["sent"] == [] and closed_engine._calls["notes"] == []
    assert tmp_db.get_last_closed_drip(501) is None, "cadence clock untouched: the client stays due"
    rows = tmp_db.recent_audit_rows(["closed_drip"], dt.datetime.now(UTC) - dt.timedelta(days=1))
    deferred = [r for r in rows if r["status"] == "deferred"]
    assert deferred and json.loads(deferred[0]["details"])["reason"] == "date_grounding_failed"


# ── 6. Seller generation goes through the same grounding (review finding) ────

def test_seller_generation_is_grounded_end_to_end(engine, monkeypatch, fake_http):
    from fub_automation.seller_nurture import generate_seller_email
    monkeypatch.setattr(engine.content, "send_day", lambda now=None: NOV6)
    llm = _ScriptedLLM([
        {"subject": "Your home", "email_body": "Hey Pat,\nHappy Veterans Day this weekend! Curious what your home is worth?"},
        {"subject": "Your home", "email_body": "Hey Pat,\nCurious what your home is worth? Happy to run a free report."},
    ])
    monkeypatch.setattr(engine.content, "_llm_call", llm)
    block = engine.content.date_grounding(NOV6)
    out = engine.content.grounded_generate(lambda extra: generate_seller_email(
        llm_call_fn=engine.content._llm_call, person={"id": 3, "firstName": "Pat"}, email_number=0,
        property_address="", neighborhood="", notes_context="", rules=engine.rules,
        today_str=NOV6.isoformat(), date_block=block + ("\n" + extra if extra else "")), NOV6)
    assert "Veterans Day" not in out["email_body"]
    assert "Today's date: 2026-11-06" in llm.prompts[0] and "Veterans Day is on Wednesday, November 11, 2026" in llm.prompts[0]
    assert "REJECTED" in llm.prompts[1]


def test_the_seller_call_site_uses_the_wrapper():
    import inspect
    from fub_automation import main
    src = inspect.getsource(main.RuleEngine.process_seller_nurture_candidate)
    assert "grounded_generate" in src and "date_block=" in src and "today_str=" in src


def test_every_lead_email_generator_is_grounded():
    """Call-site coverage, so "every email" is a checked claim. Recruiting is
    deliberately excluded (Peter: no recruiting changes); SMS templates are
    not LLM output; classifier prompts produce no email."""
    import inspect
    from fub_automation import main
    gen = main.ContentGenerator
    for name in ("generate", "generate_closed_drip_email", "generate_congrats_email",
                 "generate_welcome_email", "generate_long_term_nurture_email"):
        assert "grounded_json" in inspect.getsource(getattr(gen, name)), name
    assert "recruiting" not in inspect.getsource(gen.grounded_generate).lower()



# ── 7. A deferred congrats is NOT automatically retried by this patch ────────

def test_a_deferred_congrats_is_recorded_as_not_automatically_retried(closed_engine, monkeypatch, tmp_db):
    """Narrow patch: discovery is unchanged (26 hours). A congrats deferred on
    a date-grounding failure is recorded with retry "not automatic"; the retry
    path is a separate, unapproved proposal."""
    def refuse(person, deal_address):
        raise dc.DateGroundingError(["wishes a happy Veterans Day 5 days early"])
    monkeypatch.setattr(closed_engine.content, "generate_congrats_email", refuse)
    assert closed_engine.process_congrats_candidate(_alexandra()) == "deferred"
    assert closed_engine._calls["sent"] == [] and closed_engine._calls["notes"] == []
    row = [r for r in tmp_db.recent_audit_rows(["closed_congrats"], dt.datetime.now(UTC) - dt.timedelta(days=1))
           if r["status"] == "deferred"][0]
    assert json.loads(row["details"])["retry"] == "not automatic"
    import inspect
    from fub_automation import main
    assert "_retry_deferred_congrats" not in inspect.getsource(main.RuleEngine.scan_new_closed_leads)


# ── 9. Revision 4: two more rev2 review cases, and the welcome path ─────────

@pytest.mark.parametrize("valid", [
    # rev2 review: a past event that happened mid-year was falsely REJECTED as
    # saying it is mid-year today.
    "You mentioned a mid-year move in June.",
    "Your mid-year bonus came through in July.",
    "Halfway through the year we closed on the house.",
])
def test_the_wrapper_accepts_past_mid_year_events(content, monkeypatch, valid):
    draft = {"subject": "Hi", "email_body": "Hey Sam,\n" + valid}
    llm = _ScriptedLLM([draft])
    monkeypatch.setattr(content, "_llm_call", llm)
    assert content.grounded_json("PROMPT", 0.86, day=NOV6) == draft
    assert len(llm.prompts) == 1, "no rewrite was needed"


@pytest.mark.parametrize("claim", [
    "We're already halfway through the year!",
    "Already halfway through the year!",
    "It's mid-year, time for a check-in.",
    "Hard to believe it's the middle of the year.",
    "This year is almost half over.",
    "Here is your mid-year check-in.",
])
def test_mid_year_claims_about_today_are_still_rejected_in_november(claim):
    assert dc.date_language_problems(claim, NOV6)
    assert dc.date_language_problems(claim, dt.date(2026, 6, 30)) == []


@pytest.mark.parametrize("wrong", [
    # rev2 review: the impossible date resolved to None and was ignored.
    "We could meet Friday, November 31, 2026.",
    "We could meet November 31.",
    "Your closing on February 30 went smoothly.",
    "February 29, 2027 works for us.",
])
def test_the_wrapper_rejects_a_date_that_does_not_exist(content, monkeypatch, wrong):
    bad = {"subject": "Hi", "email_body": "Hey Sam,\n" + wrong}
    good = {"subject": "Quick question", "email_body": "Hey Sam,\nStill looking in Boerne?"}
    llm = _ScriptedLLM([bad, good])
    monkeypatch.setattr(content, "_llm_call", llm)
    assert content.grounded_json("PROMPT", 0.86, day=NOV6) == good
    assert "does not exist" in llm.prompts[1]
    monkeypatch.setattr(content, "_llm_call", _ScriptedLLM([bad, bad]))
    with pytest.raises(dc.DateGroundingError):
        content.grounded_json("PROMPT", 0.86, day=NOV6)


def test_real_dates_and_non_dates_are_not_called_impossible():
    assert dc.date_language_problems("February 29 works for us.", NOV6) == []      # no year: left alone
    assert dc.date_language_problems("February 29, 2028 works for us.", NOV6) == []  # leap year
    assert dc.date_language_problems("November 30 works for us.", NOV6) == []
    assert dc.date_language_problems("It may 45 minutes.", NOV6) == []              # not a date


class _NoSmtp:
    """Stands in for smtplib.SMTP: records any attempt to open a connection."""
    opened: list = []

    def __init__(self, *a, **k):
        _NoSmtp.opened.append((a, k))
        raise AssertionError("SMTP must not be reached")


@pytest.fixture()
def no_smtp(monkeypatch):
    from fub_automation import main
    _NoSmtp.opened = []
    monkeypatch.setattr(main.smtplib, "SMTP", _NoSmtp)
    if hasattr(main.smtplib, "SMTP_SSL"):
        monkeypatch.setattr(main.smtplib, "SMTP_SSL", _NoSmtp)
    return _NoSmtp


def test_quarterly_with_two_impossible_date_drafts_defers_with_no_send(closed_engine, monkeypatch, no_smtp, tmp_db):
    """End to end with the REAL generator and wrapper: both drafts carry a
    date that does not exist, so the check-in is deferred. No email, no SMTP,
    no FUB note, no Places lookup for the deal name."""
    from fub_automation import main
    content = closed_engine.content
    monkeypatch.setattr(content, "generate_closed_drip_email",
                        main.ContentGenerator.generate_closed_drip_email.__get__(content))
    monkeypatch.setattr(content, "send_day", lambda now=None: NOV6)
    bad = {"subject": "Checking in", "email_body": "Hey Alexandra,\nWant to grab coffee Friday, November 31, 2026?"}
    monkeypatch.setattr(content, "_llm_call", _ScriptedLLM([bad, bad]))
    assert closed_engine.process_closed_drip_candidate(_alexandra()) == "deferred"
    calls = closed_engine._calls
    assert calls["sent"] == [] and calls["notes"] == [] and calls["spots"] == []
    assert no_smtp.opened == []
    row = [r for r in tmp_db.recent_audit_rows(["closed_drip"], dt.datetime.now(UTC) - dt.timedelta(days=1))
           if r["status"] == "deferred"][0]
    assert "does not exist" in row["details"]


def _welcome_engine(engine, monkeypatch):
    calls = {"generated": 0, "sent": [], "notes": []}
    person = {"id": 777, "firstName": "Sam", "stage": "Lead", "tags": [], "emails": [{"value": "sam@example.com"}]}
    monkeypatch.setattr(engine.fub, "get_person", lambda pid: person)
    monkeypatch.setattr(engine.fub, "add_note", lambda pid, subj, body: calls["notes"].append(subj) or {})
    monkeypatch.setattr(engine, "is_excluded", lambda p: False)
    monkeypatch.setattr(engine, "city_for_customer_nurture", lambda p: "Boerne")
    monkeypatch.setattr(engine.email, "send", lambda *a, **k: calls["sent"].append((a, k)))
    return calls


def test_welcome_retained_behaviour_base_duplicate_check_fails_before_generation(engine, monkeypatch, no_smtp, tmp_db):
    """Inherited, NOT changed by this patch (documented, not fixed): the
    welcome path's duplicate check calls recent_audit_rows(action, person_id)
    against a (actions, since) signature, raises, and the generic handler
    logs "error". So on base and on this patch the welcome email is never
    generated or sent. If that check is fixed later, update this test."""
    calls = _welcome_engine(engine, monkeypatch)

    def generate(person, city):
        calls["generated"] += 1
        return {"subject": "Welcome", "email_body": "Hey Sam,\nWelcome!"}
    monkeypatch.setattr(engine.content, "generate_welcome_email", generate)
    assert engine.send_instant_welcome_email(777) == "error"
    assert calls == {"generated": 0, "sent": [], "notes": []}
    assert no_smtp.opened == []
    row, = tmp_db.recent_audit_rows(["instant_welcome_email"], dt.datetime.now(UTC) - dt.timedelta(days=1))
    assert row["status"] == "error"
    assert "'int' object has no attribute 'isoformat'" in row["details"]


def test_welcome_date_grounding_failure_is_logged_as_error_not_deferred_and_never_sends(engine, monkeypatch, no_smtp, tmp_db):
    """Retained behaviour if generation IS reached (duplicate check bypassed
    here only to get there): a DateGroundingError from the real wrapper lands
    in the generic handler. Audit status "error", not "deferred"; no retry is
    recorded; no email, no SMTP, no FUB note."""
    calls = _welcome_engine(engine, monkeypatch)
    monkeypatch.setattr(engine.db, "recent_audit_rows", lambda *a, **k: [])
    monkeypatch.setattr(engine.content, "send_day", lambda now=None: NOV6)
    bad = {"subject": "Welcome", "email_body": "Hey Sam,\nHappy Veterans Day this weekend!"}
    monkeypatch.setattr(engine.content, "_llm_call", _ScriptedLLM([bad, bad]))
    assert engine.send_instant_welcome_email(777) == "error"
    assert calls["sent"] == [] and calls["notes"] == []
    assert no_smtp.opened == []
    with tmp_db.connect() as con:
        rows = con.execute("SELECT status, details FROM audit_log WHERE action='instant_welcome_email'").fetchall()
    assert [r[0] for r in rows] == ["error"]
    assert "Veterans Day" in rows[0][1] and "retry" not in rows[0][1]


# ── 2026-11-09: a midweek holiday makes no holiday weekend ───────────────────
#
# Sent on Monday Nov 9, 2026 with Veterans Day on Wednesday Nov 11. The first
# was caught by the "this weekend" rule; the next two passed the check and went
# out at 22:59 UTC. All three, and the cross-sentence form, must be refused.

NOV9 = dt.date(2026, 11, 9)

NOV9_SENT = [
    "Wanted to send a warm note ahead of Veterans Day this weekend.",
    "Wanted to send a quick note as we head into Veterans Day weekend. Hope you get some time to relax and reflect!",
    "Wanted to send a quick note ahead of Veterans Day to say thanks for your service, if that applies to you, "
    "and to wish you a peaceful long weekend ahead.",
    "Thinking of you ahead of Veterans Day. Enjoy the long weekend!",
    "Hope you enjoy the Veterans Day holiday weekend.",
    "Wishing you a restful three-day weekend for Veterans Day.",
]


@pytest.mark.parametrize("sent", NOV9_SENT)
def test_a_midweek_holiday_is_never_a_weekend(sent):
    assert dc.date_language_problems("Hey Sam,\n" + sent, NOV9), sent


@pytest.mark.parametrize("sent", NOV9_SENT)
def test_the_wrapper_refuses_the_nov9_holiday_weekend_wording(engine, monkeypatch, fake_http, sent):
    """Through the REAL wrapper every buyer email is generated with: one
    rewrite is requested, and two bad drafts raise, so nothing is sent."""
    monkeypatch.setattr(engine.content, "send_day", lambda now=None: NOV9)
    bad = {"subject": "A quick note", "email_body": "Hey Sam,\n" + sent + " Still looking in Boerne?"}
    good = {"subject": "A quick note", "email_body": "Hey Sam,\nWith Veterans Day coming up on Wednesday, "
            "November 11, thank you to everyone who served. Still looking in Boerne?"}
    llm = _ScriptedLLM([bad, good])
    monkeypatch.setattr(engine.content, "_llm_call", llm)
    assert engine.content.grounded_json("PROMPT", 0.86) == good
    assert len(llm.prompts) == 2 and "REJECTED" in llm.prompts[1]
    monkeypatch.setattr(engine.content, "_llm_call", _ScriptedLLM([bad, bad]))
    with pytest.raises(dc.DateGroundingError):
        engine.content.grounded_json("PROMPT", 0.86)


@pytest.mark.parametrize("day,valid", [
    (NOV9, "With Veterans Day coming up on Wednesday, November 11, thank you to everyone who served."),
    (NOV9, "Any plans this weekend? I have two homes in Boerne worth a look."),
    (NOV9, "Are you free the weekend of November 14 to tour a few homes?"),
    (dt.date(2026, 11, 23), "Hope you have a great Thanksgiving weekend ahead."),
    (dt.date(2026, 9, 3), "Enjoy the long Labor Day weekend coming up."),
    (dt.date(2026, 5, 21), "Enjoy the Memorial Day long weekend."),
])
def test_real_weekends_and_real_holiday_weekends_still_pass(day, valid):
    assert dc.date_language_problems("Hey Sam,\n" + valid, day) == []


def test_the_prompt_says_a_midweek_holiday_has_no_weekend():
    block = dc.grounding_block(NOV9, holiday=dc.upcoming_holiday(NOV9))
    assert "Veterans Day falls on a Wednesday this year" in block and "long weekend" in block
    labor = dt.date(2026, 9, 3)
    assert "long weekend" not in dc.grounding_block(labor, holiday=dc.upcoming_holiday(labor))
