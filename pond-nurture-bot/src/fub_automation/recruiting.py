"""Recruiting track — one email every three weeks to licensed agents.

FUB contacts whose source is a recruiting source (rules.yaml
`recruiting_sources`: "New Agent Inquiry", "Agent Scouting") are licensed
Texas agents answering recruiting posts. They are NEVER leads — every lead path
refuses them (RuleEngine.is_excluded) — and this is the only email they get.

Hard rules, each pinned in tests/test_recruiting_track.py:
  - From Peter, plain text, Peter's voice: short, direct.
  - ONE angle per email, rotating through ANGLES; never the same angle twice
    in a row for a contact.
  - Subject under 8 words.
  - Exactly one question, and it is the body's last sentence before the close.
  - The active-Texas-license requirement is said once, in the FIRST email only.
  - Every email closes "Reply here or text me at <Peter's number>" — the
    number comes from rules.yaml `owner_phone`, never from this file.
  - The footer carries the TREC notices and a reply-UNSUBSCRIBE line; the
    mailbox bridge (mailbox.py) cuts a quoted reply at its first line, so an
    agent's "stop" is read and our own footer never is.

The copy is fixed text, not generated: a recruiting email that invented a
split, a cap or a bonus would be a promise the brokerage never made. Edit the
angles here; the tests hold the rules above for whatever the words become.

Replies, opt-outs and the three-week clock are the engine's (main.py
`scan_recruiting_track`, the reply scans, the opt-out ledger); this module is
pure — no I/O, no clock of its own.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Optional

# The audit action every recruiting send writes, and the reply scans watch.
RECRUITING_AUDIT_ACTION = "recruiting_email"

# The telemetry feed's word for a recruit's event (activity_log `track`) —
# lifestyle-brain's ActivityEvent.track, which keeps it off every lead count.
RECRUITING_TRACK = "recruiting"


@dataclass(frozen=True)
class Angle:
    key: str
    subject: str
    #: The pitch — short sentences, no question.
    pitch: str
    #: The one question the email ends on.
    question: str


ANGLES: tuple[Angle, ...] = (
    Angle(
        key="lease_commissions",
        subject="Lease commissions paid upfront",
        pitch=(
            "We pay lease commissions in advance, so you're not waiting "
            "months to get paid on a lease."
        ),
        question="How long are you waiting on lease money right now?",
    ),
    Angle(
        key="warm_leads",
        subject="Warm buyer leads, handed to you",
        pitch=(
            "Our agents get warm buyer leads handed to them. You spend your "
            "time working buyers, not hunting for them."
        ),
        question="What would a steady stream of warm buyers do for your year?",
    ),
    Angle(
        key="agent_accelerator",
        subject="Earning in your first 30 days",
        pitch=(
            "Our Agent Accelerator is built to get you earning in your first "
            "30 days, not month six."
        ),
        question="What would a first-month paycheck change for you?",
    ),
    Angle(
        key="apartment_locating",
        subject="Locating income while buyers warm up",
        pitch=(
            "Buyers take time. Apartment locating pays you in the meantime, "
            "so you earn while you nurture your buyers toward a purchase."
        ),
        question="Have you ever added apartment locating to your business?",
    ),
    Angle(
        key="broker_access",
        subject="Real support, not a 1-800 number",
        pitch=(
            "When a deal gets messy, you get direct broker access. Real "
            "support, not a 1-800 number."
        ),
        question="Who do you call today when a deal goes sideways?",
    ),
    Angle(
        key="boutique",
        subject="Boutique brokerage, Austin and San Antonio",
        pitch=(
            "We're a small boutique brokerage in Austin and San Antonio. "
            "Small enough that you're a name here, not a number."
        ),
        question="Is a smaller brokerage something you'd consider?",
    ),
)

ANGLE_KEYS: tuple[str, ...] = tuple(angle.key for angle in ANGLES)

#: Said once, in the first email only.
LICENSE_LINE = "One requirement: you'll need an active Texas real estate license."

#: The words every email closes on, before Peter's number.
CLOSING_LEAD = "Reply here or text me at"

# Footer lines. The first two are markers mailbox.strip_quoted_reply cuts at
# ("--" and "LIFESTYLE DESIGN REALTY"), so a quoted recruiting email can never
# make its own UNSUBSCRIBE line look like the agent's words.
FOOTER_UNSUBSCRIBE = (
    "If you'd rather not hear about joining us, reply UNSUBSCRIBE and I'll "
    "take you off this list."
)


def angle_for(person_id: int, emails_sent: int) -> Angle:
    """The angle for a contact's next email.

    Strict rotation from a per-person starting point, so the office's first
    wave does not all land on one angle the same morning, and consecutive
    emails to one contact can never repeat an angle (six angles, one step
    per send).
    """
    return ANGLES[(int(person_id) + int(emails_sent)) % len(ANGLES)]


def compose_recruiting_email(
    first_name: str, angle: Angle, email_number: int, phone: str
) -> tuple[str, str]:
    """(subject, body) for one recruiting email, footer NOT included.

    `email_number` is 1 for a contact's first recruiting email — the only one
    that says the license requirement. `phone` is Peter's number from config;
    an empty one is refused rather than sent without a way to reach him.
    """
    phone = (phone or "").strip()
    if not phone:
        raise ValueError("owner_phone is not configured — a recruiting email must close with Peter's number")
    greeting = f"Hi {first_name or 'there'},"
    paragraphs = [greeting, "Peter here with Lifestyle Design Realty.", angle.pitch]
    if int(email_number) == 1:
        paragraphs.append(LICENSE_LINE)
    paragraphs.append(angle.question)
    paragraphs.append(f"{CLOSING_LEAD} {phone}.")
    paragraphs.append("Peter Allen")
    return angle.subject, "\n\n".join(paragraphs)


def recruiting_footer(company_address: str, iabs_url: str, consumer_url: str) -> str:
    """The plain-text footer: TREC notices, the address, the way off the list."""
    return "\n".join(
        [
            "--",
            "LIFESTYLE DESIGN REALTY",
            "Peter Allen",
            f"Information About Brokerage Services: {iabs_url}",
            f"TREC Consumer Protection Notice: {consumer_url}",
            company_address,
            "",
            FOOTER_UNSUBSCRIBE,
        ]
    )


def is_due(
    last_sent_at: Optional[dt.datetime], cadence_days: int, now: dt.datetime
) -> bool:
    """Whether a contact's next recruiting email may go out.

    Never emailed (None): due. Otherwise only once a full `cadence_days` has
    passed since the last send — the three-week spacing is a floor. A caller
    holding a clock that will not parse passes `now`, never None: an unknown
    last send is "just sent", not "overdue".
    """
    if last_sent_at is None:
        return True
    return now - last_sent_at >= dt.timedelta(days=int(cadence_days))
