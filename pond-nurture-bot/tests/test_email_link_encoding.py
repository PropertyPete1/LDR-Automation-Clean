"""The daily summary's Tap-to-Text links must survive the trip to the inbox.

Regression cover for links arriving mangled: the message body was going out
quoted-printable, and a hop that QP-decoded it consumed the '=' between each
query key and its value, plus the two characters behind it.

    lead_id=1970  ->  lead_id\\x1970
    lead_id=694   ->  lead_idi4
    lead_id=2159  ->  lead_id!59

Those are the three that were actually reported. The '=' that goes missing is
the structural key/value separator, so percent-encoding the param values (which
make_sms_uri already does) cannot reach it — the character has to stop appearing
literally in the transmitted body at all.
"""
from __future__ import annotations

import base64
import email
import email.policy
import io
import quopri
from email.generator import BytesGenerator

import pytest

from fub_automation.sms_helpers import make_sms_uri

# The exact ids from the reported breakage. Each one decodes to a different
# flavour of damage under a stray QP pass ('=19' -> a control byte, '=69' -> a
# letter, '=21' -> punctuation), so all three are worth pinning.
REPORTED_LEAD_IDS = ("1970", "694", "2159")


def _summary_bodies(lead_ids=REPORTED_LEAD_IDS):
    """A plain/HTML pair shaped like send_phase2_daily_summary()'s output.

    Emoji and over-long lines are the point, not decoration: together they are
    what pushed set_content() into choosing quoted-printable.
    """
    lines = ["\U0001f4f2 REASSIGNED LEADS WAITING (Tap to Text)",
             "----------------------------------------"]
    html = ["<h3>\U0001f4f2 REASSIGNED LEADS WAITING (Tap to Text)</h3><ul>"]
    for lead_id in lead_ids:
        link = make_sms_uri(
            "2105551212",
            "Hey Sam, still looking in Boerne? \U0001f3e1",
            agent_name="Peter",
            lead_id=lead_id,
        )
        lines.append(f"- Sam Jones (Lead) — FUB ID {lead_id} ➔ [Tap to Text]: {link}")
        html.append(f"<li>\U0001f4f1 <a href='{link}'>\U0001f4f2 Tap to Text</a></li>")
    html.append("</ul>")
    return "\n".join(lines), "".join(html)


@pytest.fixture()
def transmitted(m, monkeypatch):
    """Send one summary and hand back exactly what went onto the wire.

    smtplib.send_message() is what serialises the message, so the test
    serialises it the same way (BytesGenerator, CRLF) rather than trusting
    as_string() to behave identically.
    """
    captured = {}

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
            captured["msg"] = msg
            buf = io.BytesIO()
            BytesGenerator(buf).flatten(msg, linesep="\r\n")
            captured["raw"] = buf.getvalue()

    monkeypatch.setattr(m.smtplib, "SMTP", FakeSMTP)
    settings = m.Settings.from_env()
    settings.dry_run = False
    settings.smtp_host, settings.smtp_port = "smtp.example", 587
    settings.smtp_user, settings.smtp_password = "u", "p"
    settings.email_from = "peter@lifestyledesignrealty.com"

    body, html_body = _summary_bodies()
    m.EmailSender(settings).send(
        to_email="peter@lifestyledesignrealty.com",
        subject="\U0001f4ca Phase 2 FUB Automation Daily Update",
        body=body,
        html_body=html_body,
    )
    return captured


def _decoded(raw: bytes, flavour: str) -> str:
    parsed = email.message_from_bytes(raw, policy=email.policy.default)
    return parsed.get_body(preferencelist=(flavour,)).get_content()


@pytest.mark.parametrize("flavour", ["plain", "html"])
def test_lead_id_round_trips_intact_through_the_message_body(transmitted, flavour):
    """A reader that decodes the message correctly gets the link back whole."""
    decoded = _decoded(transmitted["raw"], flavour)
    for lead_id in REPORTED_LEAD_IDS:
        assert f"lead_id={lead_id}" in decoded, (
            f"lead_id={lead_id} did not survive the {flavour} part"
        )


@pytest.mark.parametrize("flavour", ["plain", "html"])
def test_none_of_the_reported_corruptions_can_reappear(transmitted, flavour):
    """The literal damaged strings from the bug report, pinned by name."""
    decoded = _decoded(transmitted["raw"], flavour)
    for corrupted in ("lead_id\x1970", "lead_idi4", "lead_id!59"):
        assert corrupted not in decoded


def test_the_key_value_separator_never_travels_as_a_literal_equals(transmitted):
    """The actual invariant: no '=' from a URL is on the wire to be eaten.

    Round-tripping is necessary but not sufficient — quoted-printable also
    round-trips for a well-behaved reader, and that is precisely what shipped
    broken. What makes the links safe is that the payload carries no literal
    '=' from the URL for a stray decoder to misread, in either spelling: raw
    ('lead_id=1970') or QP-escaped ('lead_id=3D1970').
    """
    raw = transmitted["raw"]
    for lead_id in REPORTED_LEAD_IDS:
        assert f"lead_id={lead_id}".encode() not in raw
        assert f"lead_id=3D{lead_id}".encode() not in raw


def test_body_parts_are_base64_not_quoted_printable(transmitted):
    """Guards the fix itself: falling back to QP re-opens the whole hole."""
    ctes = {
        part.get_content_type(): part.get("Content-Transfer-Encoding")
        for part in transmitted["msg"].walk()
        if part.get_content_maintype() == "text"
    }
    assert ctes == {"text/plain": "base64", "text/html": "base64"}


def test_a_spurious_quoted_printable_decode_no_longer_damages_the_links(transmitted):
    """The failure mode itself, re-enacted against the new wire format.

    Run the hop that broke the old emails — a QP decode over a part body that
    was never quoted-printable — and the links still come out whole. Under the
    old encoding this is the step that turned "lead_id=694" into "lead_idi4".
    """
    for part in transmitted["msg"].walk():
        if part.get_content_maintype() != "text":
            continue
        assert part.get("Content-Transfer-Encoding") == "base64", (
            "this re-enactment assumes a base64 payload — if that changed, see "
            "test_body_parts_are_base64_not_quoted_printable first"
        )
        blob = quopri.decodestring(part.get_payload().encode())
        # A base64 blob gives QP nothing to chew on except the trailing '='
        # padding, which any reader restores from the length. Do that here so
        # the assertion speaks to the text, which is what was being destroyed.
        blob = blob.replace(b"\r", b"").replace(b"\n", b"").rstrip(b"=")
        blob += b"=" * (-len(blob) % 4)
        decoded = base64.b64decode(blob).decode("utf-8")
        for lead_id in REPORTED_LEAD_IDS:
            assert f"lead_id={lead_id}" in decoded, (
                f"lead_id={lead_id} lost in the {part.get_content_type()} part "
                "after a stray QP decode"
            )
