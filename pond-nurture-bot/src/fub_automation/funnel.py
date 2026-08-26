"""
funnel.py — read-only funnel instrumentation over data the system already writes.

Answers one question: how many cold leads became warm and got handed to Peter?

READ-ONLY BY CONSTRUCTION. Every query here is a SELECT. This module never
sends, tags, suppresses, or writes a row — it reports on what the automation
already did. Nothing here may change what any lead receives.

─────────────────────────────────────────────────────────────────────────────
STAGE DEFINITIONS

Each stage counts DISTINCT person_id within the window, so a lead emailed three
times in one week is one CONTACTED, not three. Stages are independently
measured over the same window — a lead can appear in several, and the stages
are NOT nested subsets (see CAVEATS).

COLD — entered the automation during the window.
    audit_log where
      (action='new_lead_timer'                 AND status IN ('started','started_polling'))
      OR (action='stale_agent_pond_reassignment' AND status='completed')
    The two doors in: a brand-new lead starting the speed-to-lead clock, or an
    existing lead going stale on an agent and being moved to the Lead Pond.

CONTACTED — first bot EMAIL sent during the window.
    audit_log where action IN EMAIL_SEND_ACTIONS AND status IN ('sent','dry_run_sent')
    `_send_status` in main.py resolves to exactly 'sent', or 'dry_run_sent'
    under DRY_RUN, which is why both are accepted.
    Deliberately EXCLUDES:
      - status='completed'  — reassignments and trashings, not sends. (The
        existing "Email Sends" table in the digest counts these as sends, which
        is why the funnel's CONTACTED can read lower than that table's total.)
      - status='sms_sent'   — a real send, but SMS, and this stage is email.

ENGAGED — classified 'engaged' during the window.
    engagement_tier where tier='engaged' AND last_classified_at in window.
    'engaged' means any inbound activity (reply, text, or call) in the last 60
    days, which earns a 10-day cadence instead of 14.

WARM — replied to us, and did not reply to opt out.
    persons with action='reply_detected' in the window,
    MINUS persons with action='reply_intent_disqualification' in the window.
    The subtraction matters: an unsubscribe IS a reply, and counting it as warm
    would make a bad week look like a good one.

HANDED_OFF — surfaced to Peter for a human touch.
    audit_log where
      (action='reply_detected'           AND status='alert_sent')
      OR (action='pond_keyword_reassignment' AND status='completed')
    The hot-reply alert email, plus purchase-intent keyword hits that reassign
    the lead straight to Peter.

─────────────────────────────────────────────────────────────────────────────
CAVEATS — read these before trusting a rate

1. NO OPEN/CLICK DATA EXISTS. FUB does not expose email open or click tracking
   through its API, so there is no open rate here and there cannot be one
   without a different mail path. ENGAGED is an inbound-activity proxy.

2. ENGAGED IS A SNAPSHOT, NOT A TRANSITION. engagement_tier stores only the
   current tier plus last_classified_at — there is no history table — so this
   counts "was classified engaged during the window", NOT "moved into engaged
   during the window". A lead reclassified engaged twice still counts once, but
   a lead that was already engaged and got reclassified counts too.

3. STAGES ARE NOT A STRICT FUNNEL WITHIN ONE WINDOW. A lead contacted in March
   can reply this week, so it lands in WARM this week without being in this
   week's CONTACTED. Rates are therefore period ratios — "warm replies this
   week per email contacted this week" — not a cohort conversion. Reading them
   as cohort rates will overstate a slow week and understate a fast one.
"""
from __future__ import annotations

import datetime as dt
import sqlite3
from typing import Dict, Iterable, Optional, Set

# Actions whose 'sent' status means a real email left the building.
EMAIL_SEND_ACTIONS: tuple[str, ...] = (
    "pond_nurture",
    "closed_drip",
    "long_term_nurture_drip",
    "closed_congrats",
    "instant_welcome_email",
    "seller_nurture",
)

# _send_status in main.py is exactly one of these on success.
SENT_STATUSES: tuple[str, ...] = ("sent", "dry_run_sent")

STAGES: tuple[str, ...] = ("cold", "contacted", "engaged", "warm", "handed_off")

# Human labels for rendering.
STAGE_LABELS: Dict[str, str] = {
    "cold": "COLD — entered automation",
    "contacted": "CONTACTED — bot email sent",
    "engaged": "ENGAGED — inbound activity",
    "warm": "WARM — replied (not opt-out)",
    "handed_off": "HANDED OFF — surfaced to Peter",
}


def _iso(value: dt.datetime) -> str:
    return value.isoformat()


def _distinct_people(
    conn: sqlite3.Connection,
    sql: str,
    params: Iterable,
) -> Set[int]:
    """Run a SELECT returning person_id and collect the non-null ids.

    Rows with a NULL person_id are run-level bookkeeping (a cap notice, a
    summary) rather than a lead, and must never inflate a lead count.
    """
    rows = conn.execute(sql, tuple(params)).fetchall()
    out: Set[int] = set()
    for row in rows:
        pid = row[0]
        if pid is not None:
            out.add(int(pid))
    return out


def cold_people(conn, start: dt.datetime, end: dt.datetime) -> Set[int]:
    return _distinct_people(
        conn,
        """SELECT DISTINCT person_id FROM audit_log
           WHERE created_at >= ? AND created_at < ?
             AND ( (action = 'new_lead_timer' AND status IN ('started','started_polling'))
                OR (action = 'stale_agent_pond_reassignment' AND status = 'completed') )""",
        (_iso(start), _iso(end)),
    )


def contacted_people(conn, start: dt.datetime, end: dt.datetime) -> Set[int]:
    action_ph = ",".join("?" for _ in EMAIL_SEND_ACTIONS)
    status_ph = ",".join("?" for _ in SENT_STATUSES)
    return _distinct_people(
        conn,
        f"""SELECT DISTINCT person_id FROM audit_log
            WHERE created_at >= ? AND created_at < ?
              AND action IN ({action_ph})
              AND status IN ({status_ph})""",
        (_iso(start), _iso(end), *EMAIL_SEND_ACTIONS, *SENT_STATUSES),
    )


def engaged_people(conn, start: dt.datetime, end: dt.datetime) -> Set[int]:
    """See CAVEAT 2 — snapshot of classification, not a transition."""
    return _distinct_people(
        conn,
        """SELECT DISTINCT person_id FROM engagement_tier
           WHERE tier = 'engaged'
             AND last_classified_at >= ? AND last_classified_at < ?""",
        (_iso(start), _iso(end)),
    )


def warm_people(conn, start: dt.datetime, end: dt.datetime) -> Set[int]:
    """Replied — minus the ones who replied in order to leave."""
    replied = _distinct_people(
        conn,
        """SELECT DISTINCT person_id FROM audit_log
           WHERE created_at >= ? AND created_at < ?
             AND action = 'reply_detected'""",
        (_iso(start), _iso(end)),
    )
    disqualified = _distinct_people(
        conn,
        """SELECT DISTINCT person_id FROM audit_log
           WHERE created_at >= ? AND created_at < ?
             AND action = 'reply_intent_disqualification'""",
        (_iso(start), _iso(end)),
    )
    return replied - disqualified


def handed_off_people(conn, start: dt.datetime, end: dt.datetime) -> Set[int]:
    return _distinct_people(
        conn,
        """SELECT DISTINCT person_id FROM audit_log
           WHERE created_at >= ? AND created_at < ?
             AND ( (action = 'reply_detected' AND status = 'alert_sent')
                OR (action = 'pond_keyword_reassignment' AND status = 'completed') )""",
        (_iso(start), _iso(end)),
    )


def rate(numerator: int, denominator: int) -> Optional[float]:
    """Percentage, or None when the denominator is zero.

    None rather than 0.0 on purpose: "no leads were contacted" and "leads were
    contacted and none went warm" are different weeks and must not render the
    same. Callers print '—' for None.
    """
    if denominator <= 0:
        return None
    return round(numerator * 100.0 / denominator, 1)


def query_funnel(conn: sqlite3.Connection, start: dt.datetime, end: dt.datetime) -> dict:
    """Compute every stage count and rate for [start, end).

    Half-open interval so consecutive weeks tile exactly: an event at the
    boundary belongs to the later week only, and can never be counted twice.
    """
    cold = cold_people(conn, start, end)
    contacted = contacted_people(conn, start, end)
    engaged = engaged_people(conn, start, end)
    warm = warm_people(conn, start, end)
    handed = handed_off_people(conn, start, end)

    counts = {
        "cold": len(cold),
        "contacted": len(contacted),
        "engaged": len(engaged),
        "warm": len(warm),
        "handed_off": len(handed),
    }

    return {
        "counts": counts,
        "rates": {
            # The headline: of the leads we emailed, how many wrote back?
            "contacted_to_warm": rate(counts["warm"], counts["contacted"]),
            "cold_to_contacted": rate(counts["contacted"], counts["cold"]),
            "contacted_to_engaged": rate(counts["engaged"], counts["contacted"]),
            "warm_to_handed_off": rate(counts["handed_off"], counts["warm"]),
        },
        "window": {"start": _iso(start), "end": _iso(end)},
    }


def new_warm_today(conn: sqlite3.Connection, day_start: dt.datetime, day_end: dt.datetime) -> int:
    """Count for the daily email — warm leads that appeared today."""
    return len(warm_people(conn, day_start, day_end))


# ── Rendering ────────────────────────────────────────────────────────────────


def _fmt_rate(value: Optional[float]) -> str:
    return "—" if value is None else f"{value}%"


def _delta_text(current: int, previous: int) -> str:
    diff = current - previous
    if diff > 0:
        return f"+{diff}"
    if diff < 0:
        return str(diff)
    return "same"


def format_funnel_text(this_week: dict, last_week: dict) -> str:
    """Plain-text funnel block (used in tests and any text email body)."""
    c, p = this_week["counts"], last_week.get("counts", {})
    lines = ["📈 FUNNEL — THIS WEEK", "-" * 40]
    for stage in STAGES:
        curr = c.get(stage, 0)
        prev = p.get(stage, 0)
        lines.append(f"{STAGE_LABELS[stage]:<38} {curr:>5}  ({_delta_text(curr, prev)} vs last week)")
    r = this_week["rates"]
    lines += [
        "",
        f"Contacted → Warm (headline): {_fmt_rate(r['contacted_to_warm'])}",
        f"Cold → Contacted:            {_fmt_rate(r['cold_to_contacted'])}",
        f"Warm → Handed off:           {_fmt_rate(r['warm_to_handed_off'])}",
    ]
    return "\n".join(lines)


def format_funnel_html(this_week: dict, last_week: dict) -> str:
    """HTML funnel section for the weekly digest."""
    c, p = this_week["counts"], last_week.get("counts", {})
    r = this_week["rates"]
    lw_rates = last_week.get("rates", {})

    def delta_html(current: int, previous: int) -> str:
        diff = current - previous
        if diff > 0:
            return f'<span style="color:#22c55e">▲ +{diff}</span>'
        if diff < 0:
            return f'<span style="color:#ef4444">▼ {diff}</span>'
        return '<span style="color:#6b7280">— same</span>'

    rows = ""
    for stage in STAGES:
        curr = c.get(stage, 0)
        prev = p.get(stage, 0)
        rows += (
            f'<tr><td style="padding:6px;">{STAGE_LABELS[stage]}</td>'
            f'<td style="padding:6px;"><strong>{curr}</strong></td>'
            f'<td style="padding:6px;">{delta_html(curr, prev)}</td></tr>\n'
        )

    def rate_row(label: str, key: str, emphasise: bool = False) -> str:
        curr = _fmt_rate(r.get(key))
        prev = _fmt_rate(lw_rates.get(key))
        weight = ' style="font-weight:bold;background:#f0f9ff;"' if emphasise else ""
        return (
            f"<tr{weight}><td style=\"padding:6px;\">{label}</td>"
            f'<td style="padding:6px;">{curr}</td>'
            f'<td style="padding:6px;color:#6b7280;">was {prev}</td></tr>\n'
        )

    rate_rows = (
        rate_row("Contacted → Warm (headline)", "contacted_to_warm", emphasise=True)
        + rate_row("Cold → Contacted", "cold_to_contacted")
        + rate_row("Contacted → Engaged", "contacted_to_engaged")
        + rate_row("Warm → Handed off", "warm_to_handed_off")
    )

    return f"""
    <h2>📈 FUNNEL — THIS WEEK</h2>
    <table style="border-collapse: collapse; width: 100%;">
    <tr style="background: #f3f4f6;"><th style="text-align:left; padding:8px;">Stage</th><th style="padding:8px;">Leads</th><th style="padding:8px;">vs Last Week</th></tr>
    {rows}
    </table>

    <h3 style="margin-top:14px;">Conversion</h3>
    <table style="border-collapse: collapse; width: 100%;">
    {rate_rows}
    </table>
    <p style="color: #6b7280; font-size: 0.85em;">
      Distinct leads per stage, counted once per week. Stages are measured over the
      same week rather than followed as a cohort, so a lead emailed in March that
      replies this week counts as WARM here without appearing in CONTACTED —
      read these as period ratios, not cohort conversion.
      WARM excludes replies that were opt-outs. No open/click rate is shown because
      FUB does not expose that data.
    </p>
    """
