"""The NEW LEAD ASSIGNED alert must be tappable from a real inbox.

Two shipped defects, both caught on the 2026-08-18 19:21 UTC alert for lead
"Valerie Lodze":

1. The Tap-to-Text button carried href="sms:2102644907". Gmail's mobile apps
   do not open raw sms: links from email, so the button did nothing. The daily
   summary already solved this with an HTTPS redirect through the fub-nurture
   dashboard (make_sms_uri); the alert has to ride the same rail.

2. FUB reports a missing lead source as the literal string "<unspecified>".
   Interpolated unescaped into the HTML body, an email client parses it as a
   tag and the Source row renders blank.

Mocked email transport only — no live calls, no secrets.
"""
from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

ROOT = Path(__file__).resolve().parents[1]

STEVEN = {"id": 35, "email": "steven@example.com", "name": "Steven Smith"}

REDIRECT_HOST = "fub-nurture-phfprjui.manus.space"


def _person(source="Zillow", phone="2102644907", pid=4242):
    p = {
        "id": pid,
        "firstName": "Valerie",
        "lastName": "Lodze",
        "stage": "Lead",
        "assignedUserId": STEVEN["id"],
        "phones": [{"value": phone}] if phone else [],
        "emails": [{"value": "valerie@example.com"}],
    }
    if source is not None:
        p["source"] = source
    return p


@pytest.fixture()
def sent(engine, monkeypatch):
    """Fire the alert and capture exactly what EmailSender.send was given."""
    captured = []
    monkeypatch.setattr(engine, "user_cache_by_id", lambda: {STEVEN["id"]: STEVEN})
    monkeypatch.setattr(
        engine.email,
        "send",
        lambda to_email, subject, body, **kw: captured.append(
            {"to": to_email, "subject": subject, "plain": body, "html": kw.get("html_body", "")}
        ),
    )

    def fire(person):
        captured.clear()
        engine._send_speed_to_lead_agent_alert(person, STEVEN["id"])
        assert captured, "alert did not send an email at all"
        return captured[0]

    return fire


# ── 1. the button is an https redirect, never a raw sms: link ────────────────

def test_no_sms_scheme_anywhere_in_the_alert(sent):
    msg = sent(_person())
    for flavour in ("html", "plain"):
        assert "sms:" not in msg[flavour], (
            f"raw sms: link in the {flavour} body — Gmail mobile ignores these"
        )


def test_button_href_is_the_dashboard_redirect(sent):
    msg = sent(_person())
    hrefs = re.findall(r"href='([^']+)'", msg["html"])
    assert hrefs, "no Tap-to-Text button rendered for a lead with a phone"
    parts = urlsplit(hrefs[0])
    assert parts.scheme == "https"
    assert parts.netloc == REDIRECT_HOST
    assert parts.path == "/sms-redirect"


def test_redirect_round_trips_phone_lead_id_agent_and_body(sent):
    msg = sent(_person(phone="2102644907", pid=4242))
    href = re.search(r"href='([^']+)'", msg["html"]).group(1)
    params = parse_qs(urlsplit(href).query)
    assert params["phone"] == ["+12102644907"], "phone must arrive E.164"
    assert params["lead_id"] == ["4242"]
    assert params["agent"] == ["Steven"]
    # The prefilled first-touch text the daily summary sends — a real message,
    # not empty, and addressed to the lead by first name.
    assert params["body"][0].strip()
    assert "Valerie" in params["body"][0]


def test_plain_text_body_carries_the_same_link(sent):
    msg = sent(_person())
    assert f"https://{REDIRECT_HOST}/sms-redirect?" in msg["plain"]


def test_no_phone_means_no_button_and_no_dead_link(sent):
    msg = sent(_person(phone=None))
    assert "sms:" not in msg["html"]
    assert REDIRECT_HOST not in msg["html"]
    assert "(no phone on file)" in msg["html"]


# ── 2. a missing source renders visibly ──────────────────────────────────────

@pytest.mark.parametrize("source", ["<unspecified>", "", None])
def test_missing_source_renders_as_the_word_unspecified(sent, source):
    msg = sent(_person(source=source))
    assert "<unspecified>" not in msg["html"], (
        "FUB's placeholder went out unescaped — an email client eats it as a tag"
    )
    assert re.search(r"Source:</td><td[^>]*>Unspecified</td>", msg["html"])
    assert "Source: Unspecified" in msg["plain"]


def test_real_source_still_shows_and_is_escaped(sent):
    msg = sent(_person(source="Zillow <flex>"))
    assert "Zillow &lt;flex&gt;" in msg["html"]
    assert "<flex>" not in msg["html"]


def test_lead_and_agent_names_are_escaped_in_html(sent):
    person = _person()
    person["firstName"], person["lastName"] = "Valerie <script>", "Lodze & Co"
    msg = sent(person)
    assert "<script>" not in msg["html"]
    assert "Valerie &lt;script&gt; Lodze &amp; Co" in msg["html"]


# ── 3. no email template anywhere builds a raw sms: link ─────────────────────

def test_no_source_file_constructs_a_raw_sms_link():
    """Pins the sweep: the only way to build a tap-to-text link is make_sms_uri.

    Matches the two constructions that actually shipped — f"sms:{phone}" and
    "sms:" + phone — without tripping on prose mentions of the scheme.
    """
    raw_sms_construction = re.compile(r"""["']sms:(\{|["']\s*\+)""")
    offenders = []
    for path in [ROOT / "export_dashboard_data.py", *(ROOT / "src").rglob("*.py")]:
        for lineno, line in enumerate(path.read_text().splitlines(), 1):
            if raw_sms_construction.search(line):
                offenders.append(f"{path.relative_to(ROOT)}:{lineno}: {line.strip()}")
    assert not offenders, "raw sms: link construction found:\n" + "\n".join(offenders)
