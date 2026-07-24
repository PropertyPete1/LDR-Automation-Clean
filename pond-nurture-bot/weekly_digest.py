#!/usr/bin/env python3
"""Weekly Performance Digest — Monday 8am CT email to Peter.

Summarizes the past week's activity across all bots:
- Sends per bot (pond + agent bots)
- Replies detected
- Hot-lead alerts fired
- Speed-to-lead stats (avg first-response time per agent, 60-min misses)
- Bounces/unsubscribes
- Pond size
- Leads reassigned
- Engagement tier breakdown
- Comparison vs. previous week where available
"""

import datetime as dt
import json
import logging
import os
import smtplib
import sqlite3
import sys
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
LOGGER = logging.getLogger("weekly_digest")

# ── Configuration ──
CT = ZoneInfo("America/Chicago")
AUTO_DIR = Path(os.environ.get("AUTO_DIR", str(Path(__file__).parent)))
DB_PATH = AUTO_DIR / "data" / "fub_automation.sqlite3"

OWNER_EMAIL = os.environ.get("OWNER_EMAIL", "peter@lifestyledesignrealty.com")
SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", OWNER_EMAIL)
SMTP_PASS = os.environ.get("SMTP_PASS", os.environ.get("SMTP_PASSWORD", ""))

# Power Queue dashboard URL for weekly stats endpoint
FUB_NURTURE_DASHBOARD_URL = os.environ.get("FUB_NURTURE_DASHBOARD_URL", "")


def get_db():
    """Connect to the audit SQLite database."""
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def query_seller_nurture_stats(conn, start: dt.datetime, end: dt.datetime) -> dict:
    """Query seller nurture track stats for the digest period."""
    start_iso = start.isoformat()
    end_iso = end.isoformat()
    stats = {}

    # Seller nurture emails sent
    sent = conn.execute(
        """SELECT COUNT(*) as cnt FROM audit_log
           WHERE created_at >= ? AND created_at < ?
           AND action = 'seller_nurture'
           AND status IN ('sent', 'email_sent', 'completed')""",
        (start_iso, end_iso),
    ).fetchone()["cnt"]
    stats["seller_emails_sent"] = sent

    # Seller leads enrolled (total in drip table)
    try:
        enrolled = conn.execute(
            "SELECT COUNT(*) as cnt FROM seller_nurture_drip"
        ).fetchone()["cnt"]
    except Exception:
        enrolled = 0
    stats["seller_enrolled_total"] = enrolled

    # Seller replies this week
    seller_reply_rows = conn.execute(
        """SELECT DISTINCT a.person_id, a.details FROM audit_log a
           WHERE a.created_at >= ? AND a.created_at < ?
           AND a.action = 'reply_detected'
           AND a.status = 'alert_sent'
           AND a.person_id IN (
               SELECT DISTINCT person_id FROM audit_log
               WHERE action = 'seller_nurture'
               AND status IN ('sent', 'email_sent', 'completed')
           )""",
        (start_iso, end_iso),
    ).fetchall()
    stats["seller_replies"] = []
    for row in seller_reply_rows:
        detail = {}
        try:
            detail = json.loads(row["details"]) if row["details"] else {}
        except Exception:
            pass
        stats["seller_replies"].append({
            "person_id": row["person_id"],
            "reply_snippet": detail.get("reply_snippet", ""),
            "reply_channel": detail.get("reply_channel", "unknown"),
        })
    stats["seller_replies_count"] = len(stats["seller_replies"])

    # Seller nurture errors
    errors = conn.execute(
        """SELECT COUNT(*) as cnt FROM audit_log
           WHERE created_at >= ? AND created_at < ?
           AND action = 'seller_nurture' AND status = 'error'""",
        (start_iso, end_iso),
    ).fetchone()["cnt"]
    stats["seller_errors"] = errors

    return stats


def format_seller_nurture_section(seller_stats: dict) -> str:
    """Format the Seller Nurture Track section as HTML for the digest email."""
    sent = seller_stats.get("seller_emails_sent", 0)
    enrolled = seller_stats.get("seller_enrolled_total", 0)
    replies_count = seller_stats.get("seller_replies_count", 0)
    errors = seller_stats.get("seller_errors", 0)
    replies = seller_stats.get("seller_replies", [])

    # Seller Replies section for round-robin assignment
    replies_html = ""
    if replies:
        reply_rows = ""
        for r in replies:
            snippet = r.get("reply_snippet", "")[:150]
            channel = r.get("reply_channel", "unknown")
            pid = r.get("person_id", "?")
            reply_rows += (
                f"<tr>"
                f"<td style='padding:6px;'>#{pid}</td>"
                f"<td style='padding:6px;'>{channel}</td>"
                f"<td style='padding:6px; font-style:italic;'>\"{snippet}\"</td>"
                f"</tr>\n"
            )
        replies_html = f"""
        <h3>\U0001f4e8 Seller Replies (for round-robin assignment)</h3>
        <p style="color: #6b7280; font-size: 0.85em;">These seller leads replied this week. Assign to an agent for follow-up.</p>
        <table style="border-collapse: collapse; width: 100%;">
        <tr style="background: #f3f4f6;"><th style="text-align:left; padding:8px;">Lead ID</th><th style="padding:8px;">Channel</th><th style="padding:8px;">Reply Snippet</th></tr>
        {reply_rows}
        </table>
        """

    return f"""
    <h2>\U0001f3e0 Seller Nurture Track</h2>
    <table style="border-collapse: collapse; width: 100%;">
    <tr><td style="padding:6px;">Seller emails sent this week</td><td style="padding:6px;"><strong>{sent}</strong></td></tr>
    <tr><td style="padding:6px;">Total enrolled seller leads</td><td style="padding:6px;"><strong>{enrolled}</strong></td></tr>
    <tr><td style="padding:6px;">Seller replies this week</td><td style="padding:6px;"><strong>{replies_count}</strong></td></tr>
    <tr><td style="padding:6px;">Errors</td><td style="padding:6px;"><strong>{errors}</strong></td></tr>
    </table>
    {replies_html}
    """


def query_period(conn, start: dt.datetime, end: dt.datetime):
    """Query audit_log for a given period and return stats dict."""
    start_iso = start.isoformat()
    end_iso = end.isoformat()

    stats = {}

    # Sends by action (bot type)
    rows = conn.execute(
        """SELECT action, COUNT(*) as cnt FROM audit_log
           WHERE created_at >= ? AND created_at < ?
           AND status IN ('sent', 'email_sent', 'completed')
           GROUP BY action""",
        (start_iso, end_iso),
    ).fetchall()
    stats["sends_by_bot"] = {row["action"]: row["cnt"] for row in rows}
    stats["total_sends"] = sum(stats["sends_by_bot"].values())

    # Replies detected
    reply_count = conn.execute(
        """SELECT COUNT(*) as cnt FROM audit_log
           WHERE created_at >= ? AND created_at < ?
           AND action = 'reply_detected'""",
        (start_iso, end_iso),
    ).fetchone()["cnt"]
    stats["replies_detected"] = reply_count

    # Hot-lead alerts (reply_detected with status alert_sent)
    hot_alerts = conn.execute(
        """SELECT COUNT(*) as cnt FROM audit_log
           WHERE created_at >= ? AND created_at < ?
           AND action = 'reply_detected' AND status = 'alert_sent'""",
        (start_iso, end_iso),
    ).fetchone()["cnt"]
    stats["hot_lead_alerts"] = hot_alerts

    # Speed-to-lead stats
    timers = conn.execute(
        """SELECT * FROM new_lead_timers
           WHERE created_at >= ? AND created_at < ?""",
        (start_iso, end_iso),
    ).fetchall()
    stats["speed_to_lead_total"] = len(timers)
    misses_by_agent = {}
    for t in timers:
        if t["reassigned_at"]:
            agent_id = t["assigned_user_id"] or "unknown"
            misses_by_agent[agent_id] = misses_by_agent.get(agent_id, 0) + 1
    stats["speed_to_lead_60min_misses"] = sum(misses_by_agent.values())
    stats["misses_by_agent"] = misses_by_agent

    # Bounces and unsubscribes
    bounces = conn.execute(
        """SELECT COUNT(*) as cnt FROM audit_log
           WHERE created_at >= ? AND created_at < ?
           AND action = 'bounce_detected'""",
        (start_iso, end_iso),
    ).fetchone()["cnt"]
    unsubs = conn.execute(
        """SELECT COUNT(*) as cnt FROM audit_log
           WHERE created_at >= ? AND created_at < ?
           AND action = 'unsubscribe_detected'""",
        (start_iso, end_iso),
    ).fetchone()["cnt"]
    stats["bounces"] = bounces
    stats["unsubscribes"] = unsubs

    # Leads reassigned (from speed-to-lead)
    reassigned = conn.execute(
        """SELECT COUNT(*) as cnt FROM new_lead_timers
           WHERE reassigned_at >= ? AND reassigned_at < ?""",
        (start_iso, end_iso),
    ).fetchone()["cnt"]
    stats["leads_reassigned"] = reassigned

    # Engagement tier breakdown
    tiers = conn.execute(
        "SELECT tier, COUNT(*) as cnt FROM engagement_tier GROUP BY tier"
    ).fetchall()
    stats["engagement_tiers"] = {row["tier"]: row["cnt"] for row in tiers}

    # Reply time data points
    reply_time_count = conn.execute(
        "SELECT COUNT(*) as cnt FROM reply_time_log"
    ).fetchone()["cnt"]
    stats["reply_time_data_points"] = reply_time_count

    return stats


def fetch_power_queue_stats() -> list | None:
    """Fetch weekly Power Queue activity stats from the dashboard endpoint.

    Returns a list of per-agent stats dicts, or None if unavailable.
    """
    if not FUB_NURTURE_DASHBOARD_URL:
        LOGGER.info("FUB_NURTURE_DASHBOARD_URL not set — skipping Power Queue stats")
        return None
    url = f"{FUB_NURTURE_DASHBOARD_URL.rstrip('/')}/api/power-queue/weekly-stats"
    try:
        resp = requests.get(url, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        if data.get("success") and data.get("stats"):
            return data["stats"]
        LOGGER.warning("Power Queue stats response missing data: %s", data)
        return None
    except Exception as exc:
        LOGGER.warning("Failed to fetch Power Queue stats: %s", exc)
        return None


def format_power_queue_section(stats: list | None) -> str:
    """Format the Power Queue Activity section as HTML for the digest email."""
    if not stats:
        return ""

    rows = ""
    for agent in sorted(stats, key=lambda a: a.get("totalActions", 0), reverse=True):
        name = agent.get("agentName", "Unknown")
        total = agent.get("totalActions", 0)
        hot = agent.get("hotLeadsResponded", 0)
        avg_days = agent.get("avgDaysStale", 0)
        texted = agent.get("texted", 0)
        called = agent.get("called", 0)
        snoozed = agent.get("snoozed", 0)
        rows += (
            f"<tr>"
            f"<td style='padding:6px;'>{name}</td>"
            f"<td style='padding:6px; text-align:center;'>{total}</td>"
            f"<td style='padding:6px; text-align:center;'>{texted}</td>"
            f"<td style='padding:6px; text-align:center;'>{called}</td>"
            f"<td style='padding:6px; text-align:center;'>{hot}</td>"
            f"<td style='padding:6px; text-align:center;'>{avg_days}</td>"
            f"<td style='padding:6px; text-align:center;'>{snoozed}</td>"
            f"</tr>\n"
        )

    total_actions = sum(a.get("totalActions", 0) for a in stats)
    total_hot = sum(a.get("hotLeadsResponded", 0) for a in stats)

    return f"""
    <h2>\U0001f4f1 Power Queue Activity</h2>
    <p style="color: #6b7280; font-size: 0.85em;">Agent texting queue — leads actioned this week via the mobile Power Queue.</p>
    <table style="border-collapse: collapse; width: 100%;">
    <tr style="background: #f3f4f6;">
      <th style="text-align:left; padding:8px;">Agent</th>
      <th style="padding:8px;">Total</th>
      <th style="padding:8px;">Texted</th>
      <th style="padding:8px;">Called</th>
      <th style="padding:8px;">Hot \U0001f525</th>
      <th style="padding:8px;">Avg Days</th>
      <th style="padding:8px;">Snoozed</th>
    </tr>
    {rows}
    <tr style="font-weight:bold; border-top: 2px solid #d1d5db;">
      <td style="padding:8px;">TOTAL</td>
      <td style="padding:8px; text-align:center;">{total_actions}</td>
      <td colspan="3"></td>
      <td style="padding:8px; text-align:center;">—</td>
      <td></td>
    </tr>
    </table>
    <p style="color: #6b7280; font-size: 0.85em;">Hot = leads tagged "Replied - Paused" that were called/texted. Avg Days = how stale leads were when actioned.</p>
    """


def format_digest(this_week: dict, last_week: dict, pond_size: int) -> str:
    """Format the weekly digest as HTML email."""

    def delta(current, previous, label=""):
        """Show +/- vs last week."""
        diff = current - previous
        if diff > 0:
            return f'<span style="color:#22c55e">▲ +{diff}</span>'
        elif diff < 0:
            return f'<span style="color:#ef4444">▼ {diff}</span>'
        return '<span style="color:#6b7280">— same</span>'

    # Sends breakdown
    sends_rows = ""
    all_bots = set(list(this_week["sends_by_bot"].keys()) + list(last_week.get("sends_by_bot", {}).keys()))
    for bot in sorted(all_bots):
        curr = this_week["sends_by_bot"].get(bot, 0)
        prev = last_week.get("sends_by_bot", {}).get(bot, 0)
        sends_rows += f"<tr><td>{bot}</td><td>{curr}</td><td>{delta(curr, prev)}</td></tr>\n"

    # Engagement tiers
    tier_rows = ""
    for tier_name in ("engaged", "standard", "cold"):
        cnt = this_week.get("engagement_tiers", {}).get(tier_name, 0)
        tier_rows += f"<tr><td>{tier_name.title()}</td><td>{cnt}</td></tr>\n"

    # Speed-to-lead misses by agent
    misses_rows = ""
    for agent_id, count in this_week.get("misses_by_agent", {}).items():
        misses_rows += f"<tr><td>Agent #{agent_id}</td><td>{count}</td></tr>\n"

    html = f"""
    <html>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1f2937;">
    <h1 style="color: #1e40af; border-bottom: 2px solid #1e40af; padding-bottom: 10px;">📊 Weekly Performance Digest</h1>
    <p style="color: #6b7280;">Week ending {dt.datetime.now(CT).strftime('%B %d, %Y')}</p>

    <h2>📬 Email Sends</h2>
    <table style="border-collapse: collapse; width: 100%;">
    <tr style="background: #f3f4f6;"><th style="text-align:left; padding:8px;">Bot</th><th style="padding:8px;">Count</th><th style="padding:8px;">vs Last Week</th></tr>
    {sends_rows}
    <tr style="font-weight:bold; border-top: 2px solid #d1d5db;"><td style="padding:8px;">TOTAL</td><td style="padding:8px;">{this_week['total_sends']}</td><td style="padding:8px;">{delta(this_week['total_sends'], last_week.get('total_sends', 0))}</td></tr>
    </table>

    <h2>🔥 Engagement</h2>
    <table style="border-collapse: collapse; width: 100%;">
    <tr><td style="padding:6px;">Replies detected</td><td style="padding:6px;"><strong>{this_week['replies_detected']}</strong> {delta(this_week['replies_detected'], last_week.get('replies_detected', 0))}</td></tr>
    <tr><td style="padding:6px;">Hot-lead alerts fired</td><td style="padding:6px;"><strong>{this_week['hot_lead_alerts']}</strong> {delta(this_week['hot_lead_alerts'], last_week.get('hot_lead_alerts', 0))}</td></tr>
    </table>

    <h2>⚡ Speed-to-Lead</h2>
    <table style="border-collapse: collapse; width: 100%;">
    <tr><td style="padding:6px;">New leads this week</td><td style="padding:6px;"><strong>{this_week['speed_to_lead_total']}</strong></td></tr>
    <tr><td style="padding:6px;">60-min misses (reassigned)</td><td style="padding:6px;"><strong>{this_week['speed_to_lead_60min_misses']}</strong> {delta(this_week['speed_to_lead_60min_misses'], last_week.get('speed_to_lead_60min_misses', 0))}</td></tr>
    </table>
    {'<h3>Misses by Agent</h3><table style="border-collapse: collapse;">' + misses_rows + '</table>' if misses_rows else ''}

    <h2>🚫 Compliance</h2>
    <table style="border-collapse: collapse; width: 100%;">
    <tr><td style="padding:6px;">Bounces</td><td style="padding:6px;"><strong>{this_week['bounces']}</strong> {delta(this_week['bounces'], last_week.get('bounces', 0))}</td></tr>
    <tr><td style="padding:6px;">Unsubscribes</td><td style="padding:6px;"><strong>{this_week['unsubscribes']}</strong> {delta(this_week['unsubscribes'], last_week.get('unsubscribes', 0))}</td></tr>
    </table>

    <h2>🏊 Pond Status</h2>
    <table style="border-collapse: collapse; width: 100%;">
    <tr><td style="padding:6px;">Pond size (total leads)</td><td style="padding:6px;"><strong>{pond_size}</strong></td></tr>
    <tr><td style="padding:6px;">Leads reassigned this week</td><td style="padding:6px;"><strong>{this_week['leads_reassigned']}</strong></td></tr>
    </table>

    <h2>📈 Engagement Tiers</h2>
    <table style="border-collapse: collapse; width: 100%;">
    <tr style="background: #f3f4f6;"><th style="text-align:left; padding:8px;">Tier</th><th style="padding:8px;">Leads</th></tr>
    {tier_rows}
    </table>
    <p style="color: #6b7280; font-size: 0.85em;">Engaged = 10-day cadence | Standard = 14-day | Cold = 21-day</p>

    {format_power_queue_section(this_week.get('power_queue_stats'))}

    {format_seller_nurture_section(this_week.get('seller_nurture_stats', {}))}

    <h2>📊 Best-Send-Time Data</h2>
    <p>Reply-time data points collected: <strong>{this_week['reply_time_data_points']}</strong></p>
    <p style="color: #6b7280; font-size: 0.85em;">After 8+ weeks we'll use this data to optimize send windows.</p>

    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
    <p style="color: #9ca3af; font-size: 0.8em;">Automated weekly digest from LDR Automation System</p>
    </body>
    </html>
    """
    return html


def get_pond_size():
    """Get approximate pond size from the reengagement_log table."""
    try:
        conn = get_db()
        count = conn.execute("SELECT COUNT(DISTINCT person_id) as cnt FROM reengagement_log").fetchone()["cnt"]
        conn.close()
        return count
    except Exception:
        return 0


def send_email(subject: str, html_body: str, to_email: str):
    """Send the digest email via SMTP."""
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = OWNER_EMAIL
    msg["To"] = to_email
    msg.attach(MIMEText(html_body, "html"))

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as server:
            server.starttls()
            server.login(SMTP_USER, SMTP_PASS)
            server.sendmail(OWNER_EMAIL, [to_email], msg.as_string())
        LOGGER.info("Weekly digest sent successfully")
        return True
    except Exception as exc:
        LOGGER.error("Failed to send weekly digest: %s", exc)
        return False


def main():
    """Generate and send the weekly performance digest."""
    dry_run = os.environ.get("DRY_RUN", "").lower() in {"1", "true", "yes"}
    if dry_run:
        LOGGER.info("DRY_RUN mode — will generate digest but not send email")
    LOGGER.info("Generating weekly performance digest...")

    now = dt.datetime.now(CT)
    # This week: Monday 00:00 to now (or full 7 days back)
    this_week_end = now
    this_week_start = now - dt.timedelta(days=7)
    last_week_end = this_week_start
    last_week_start = last_week_end - dt.timedelta(days=7)

    conn = get_db()

    this_week_stats = query_period(conn, this_week_start, this_week_end)
    last_week_stats = query_period(conn, last_week_start, last_week_end)

    # Seller nurture stats
    seller_stats = query_seller_nurture_stats(conn, this_week_start, this_week_end)
    this_week_stats["seller_nurture_stats"] = seller_stats

    conn.close()

    pond_size = get_pond_size()

    # Fetch Power Queue activity stats from the dashboard
    pq_stats = fetch_power_queue_stats()
    this_week_stats["power_queue_stats"] = pq_stats

    html = format_digest(this_week_stats, last_week_stats, pond_size)
    subject = f"📊 Weekly Performance Digest — {now.strftime('%b %d, %Y')}"
    if dry_run:
        LOGGER.info("[DRY-RUN] Would send digest: %s", subject)
        LOGGER.info("[DRY-RUN] Digest HTML length: %d chars", len(html))
        # HTML content not printed to avoid PII in public logs
        return True
    success = send_email(subject, html, OWNER_EMAIL)
    if success:
        LOGGER.info("Weekly digest delivered successfully.")
    else:
        LOGGER.error("Weekly digest delivery failed.")
    return success


if __name__ == "__main__":
    main()
