#!/usr/bin/env python3
"""
nightly_health.py — Unified 4am Morning Healer
Lifestyle Design Realty — FUB Automation Stack

Runs daily at 4:00 AM CT via Manus scheduled task.
Queries BOTH data sources:
  1. Local SQLite audit_log  — Python pond automation errors
  2. WebDev Dashboard API    — Node.js agent bot errors (6 bots + Lifestyle Bot)

Produces a single HTML morning report email to Peter and Steven covering:
  - Pond nurture / reassignment / agent reminder errors (auto-retry where safe)
  - All 6 agent bot run statuses (Lifestyle, Tiffany, Rue, Abby, Irma, Laila)
  - Infrastructure / crash errors
  - A clean "All systems green" section when everything ran fine

Auto-retry logic:
  - pond_nurture errors: re-queued in next daily run (no immediate retry needed)
  - agent_followup_reminder errors: flagged with actionable context
  - bot_crash (Node.js): reported with severity; no automatic retry (manual fix)
  - lead_error (Node.js): reported with count; individual leads retry next run

Usage:
  cd /home/ubuntu/fub_automation
  python3 nightly_health.py [--dry-run]

Environment variables (from .env):
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, EMAIL_FROM
  DASHBOARD_URL       — e.g. https://your-webdev-domain.manus.app
  HEALER_SECRET       — shared secret token for /api/healer/observations
  HEALER_REPORT_TO    — comma-separated email recipients (default: peter@lifestyledesignrealty.com,steven@lifestyledesignrealty.com)
  DATABASE_PATH       — path to SQLite DB (default: data/fub_automation.sqlite3)
  DRY_RUN             — if "true", prints report but does not send email
"""
from __future__ import annotations

import argparse
import datetime as dt
import email.message
import json
import logging
import os
import smtplib
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

import requests

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("nightly_health")

CT = ZoneInfo("America/Chicago")
UTC = dt.timezone.utc

# ── Known agent bots (source slug → display name) ────────────────────────────
AGENT_BOTS: Dict[str, str] = {
    "lifestyle_bot": "Lifestyle Bot (S&P500 / Peter)",
    "tiffany_bot": "Tiffany Bot",
    "rue_bot": "Rue Bot",
    "abby_bot": "Abby Bot",
    "irma_bot": "Irma Bot",
    "laila_bot": "Laila Bot",
}

# ── Python automation action types that can produce errors ───────────────────
PYTHON_ERROR_ACTIONS = [
    "pond_nurture",
    "stale_agent_pond_reassignment",
    "pond_keyword_reassignment",
    "agent_followup_reminder",
    "new_lead_timer",
    "new_lead_warning",
    "new_lead_reassigned",
    "phase2_daily_summary",
]


# ─────────────────────────────────────────────────────────────────────────────
# Config helpers
# ─────────────────────────────────────────────────────────────────────────────

def load_dotenv(path: str = ".env") -> None:
    env_path = Path(path)
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(errors="ignore").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if value.startswith("${") and value.endswith("}"):
            value = os.environ.get(value[2:-1], value)
        os.environ.setdefault(key, value)


def get_env(key: str, default: str = "") -> str:
    return os.environ.get(key, default).strip()


# ─────────────────────────────────────────────────────────────────────────────
# Section 1: Local SQLite audit_log queries
# ─────────────────────────────────────────────────────────────────────────────

def query_local_errors(db_path: str, since: dt.datetime) -> List[Dict[str, Any]]:
    """Return all error rows from audit_log since the given datetime."""
    if not os.path.exists(db_path):
        log.warning("SQLite DB not found at %s — skipping local audit", db_path)
        return []
    try:
        con = sqlite3.connect(db_path)
        con.row_factory = sqlite3.Row
        rows = con.execute(
            """
            SELECT created_at, person_id, action, status, details
            FROM audit_log
            WHERE status = 'error'
              AND created_at >= ?
            ORDER BY created_at DESC
            """,
            (since.isoformat(),),
        ).fetchall()
        con.close()
        return [dict(r) for r in rows]
    except Exception as exc:
        log.error("Failed to query local SQLite: %s", exc)
        return []


def query_local_run_summary(db_path: str, since: dt.datetime) -> Dict[str, Any]:
    """Return counts of key actions from today's run for the summary section."""
    if not os.path.exists(db_path):
        return {}
    try:
        con = sqlite3.connect(db_path)
        con.row_factory = sqlite3.Row
        rows = con.execute(
            """
            SELECT action, status, COUNT(*) as cnt
            FROM audit_log
            WHERE created_at >= ?
            GROUP BY action, status
            ORDER BY action, status
            """,
            (since.isoformat(),),
        ).fetchall()
        con.close()
        summary: Dict[str, Dict[str, int]] = {}
        for r in rows:
            summary.setdefault(r["action"], {})[r["status"]] = r["cnt"]
        return summary
    except Exception as exc:
        log.error("Failed to query local run summary: %s", exc)
        return {}


# ─────────────────────────────────────────────────────────────────────────────
# Section 2: WebDev Dashboard API queries
# ─────────────────────────────────────────────────────────────────────────────

def fetch_dashboard_observations(
    dashboard_url: str,
    healer_secret: str,
    max_retries: int = 3,
    retry_delay: float = 5.0,
) -> Optional[Dict[str, Any]]:
    """
    Call GET /api/healer/observations on the WebDev dashboard.
    Returns the parsed JSON response, or None if all retries fail.
    """
    if not dashboard_url or not healer_secret:
        log.warning(
            "DASHBOARD_URL or HEALER_SECRET not set — skipping WebDev bot data"
        )
        return None

    url = dashboard_url.rstrip("/") + "/api/healer/observations"
    headers = {"x-healer-token": healer_secret, "Accept": "application/json"}

    for attempt in range(1, max_retries + 1):
        try:
            resp = requests.get(url, headers=headers, timeout=15)
            if resp.status_code == 200:
                data = resp.json()
                log.info(
                    "Dashboard API returned %d observations, %d run_status entries",
                    len(data.get("observations", [])),
                    len(data.get("run_status", [])),
                )
                return data
            elif resp.status_code == 401:
                log.error(
                    "Dashboard API returned 401 Unauthorized — check HEALER_SECRET"
                )
                return None  # No point retrying auth failures
            else:
                log.warning(
                    "Dashboard API attempt %d/%d returned HTTP %d: %s",
                    attempt, max_retries, resp.status_code, resp.text[:200],
                )
        except requests.exceptions.ConnectionError as exc:
            log.warning(
                "Dashboard API attempt %d/%d — connection error: %s",
                attempt, max_retries, exc,
            )
        except requests.exceptions.Timeout:
            log.warning(
                "Dashboard API attempt %d/%d — timed out after 15s",
                attempt, max_retries,
            )
        except Exception as exc:
            log.warning(
                "Dashboard API attempt %d/%d — unexpected error: %s",
                attempt, max_retries, exc,
            )

        if attempt < max_retries:
            log.info("Retrying in %.0fs...", retry_delay)
            time.sleep(retry_delay)

    log.error(
        "All %d attempts to reach Dashboard API failed — bot data will be missing from report",
        max_retries,
    )
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Section 2b: Healer heartbeat write-back
# ─────────────────────────────────────────────────────────────────────────────

def post_healer_heartbeat(
    fub_nurture_url: str,
    healer_secret: str,
    local_errors: int,
    dashboard_ok: bool,
    dry_run: bool = False,
) -> bool:
    """
    POST a nightly_healer observation to the fub-nurture WebDev dashboard
    at POST /api/healer/write.  This clears the botMonitor
    "Nightly healer last ran" warning by confirming the healer completed.

    Returns True on success, False on any failure (non-fatal).
    """
    if not fub_nurture_url or not healer_secret:
        log.warning(
            "FUB_NURTURE_URL or HEALER_SECRET not set — skipping heartbeat write-back"
        )
        return False
    if dry_run:
        log.info("[DRY RUN] Would POST nightly_healer heartbeat to %s", fub_nurture_url)
        return True
    url = fub_nurture_url.rstrip("/") + "/api/healer/write"
    severity = "info" if local_errors == 0 and dashboard_ok else "warning"
    detail_parts = []
    if local_errors > 0:
        detail_parts.append(f"Python audit_log: {local_errors} error(s) found")
    else:
        detail_parts.append("Python audit_log: 0 errors")
    detail_parts.append(
        "WebDev observations: fetched successfully" if dashboard_ok
        else "WebDev observations: fetch failed"
    )
    payload = {
        "source": "nightly_healer",
        "severity": severity,
        "category": "healer_run",
        "message": "Nightly health check completed",
        "detail": ". ".join(detail_parts),
        "autoFixable": 0,
    }
    headers = {
        "Content-Type": "application/json",
        "x-healer-token": healer_secret,
    }
    try:
        resp = requests.post(url, json=payload, headers=headers, timeout=15)
        if resp.status_code == 200:
            try:
                body = resp.json()
                if body.get("ok"):
                    log.info("Healer heartbeat written to fub-nurture dashboard (ok)")
                    return True
                else:
                    log.warning("Healer heartbeat POST returned ok=false: %s", body)
                    return False
            except Exception:
                # 200 but not JSON — endpoint may not exist yet
                log.warning(
                    "Healer heartbeat POST returned HTTP 200 but non-JSON body — "
                    "POST /api/healer/write endpoint may not be deployed yet"
                )
                return False
        elif resp.status_code == 401:
            log.error(
                "Healer heartbeat POST returned 401 — check HEALER_SECRET matches "
                "FUB_NURTURE_URL dashboard env var"
            )
            return False
        else:
            log.warning(
                "Healer heartbeat POST returned HTTP %d: %s",
                resp.status_code, resp.text[:200],
            )
            return False
    except Exception as exc:
        log.warning("Healer heartbeat POST failed: %s", exc)
        return False


# ─────────────────────────────────────────────────────────────────────────────
# Section 3: Auto-retry logic
# ─────────────────────────────────────────────────────────────────────────────

def attempt_auto_fixes(
    local_errors: List[Dict[str, Any]],
    db_path: str,
    dry_run: bool,
) -> List[Dict[str, Any]]:
    """
    For specific transient error types, attempt an automatic fix and return
    a list of fix result dicts: {action, description, success, detail}.

    Current auto-fix strategies:
    - agent_followup_reminder + "No module named 'reportlab'" -> pip install
    - pond_nurture + OpenAI API key error -> flag (cannot auto-fix credentials)
    - All others -> flag for manual review
    """
    fixes: List[Dict[str, Any]] = []
    if not local_errors:
        return fixes

    from collections import defaultdict
    by_action: Dict[str, List[str]] = defaultdict(list)
    for row in local_errors:
        try:
            details = json.loads(row.get("details") or "{}")
        except json.JSONDecodeError:
            details = {}
        err_msg = details.get("error", "")
        by_action[row["action"]].append(err_msg)

    # ── Fix 1: Missing reportlab package ─────────────────────────────────────
    reportlab_errors = [
        e for e in by_action.get("agent_followup_reminder", [])
        if "reportlab" in e.lower()
    ]
    if reportlab_errors:
        if dry_run:
            fixes.append({
                "action": "agent_followup_reminder",
                "description": "Auto-install missing 'reportlab' package",
                "success": None,
                "detail": "DRY RUN — would run: pip3 install reportlab",
            })
        else:
            import subprocess
            try:
                result = subprocess.run(
                    ["pip3", "install", "reportlab", "-q"],
                    capture_output=True, text=True, timeout=60,
                )
                if result.returncode == 0:
                    fixes.append({
                        "action": "agent_followup_reminder",
                        "description": "Auto-installed missing 'reportlab' package",
                        "success": True,
                        "detail": "pip3 install reportlab succeeded. Tomorrow's run should succeed.",
                    })
                    log.info("Auto-fix: reportlab installed successfully")
                else:
                    fixes.append({
                        "action": "agent_followup_reminder",
                        "description": "Auto-install 'reportlab' failed",
                        "success": False,
                        "detail": result.stderr[:300],
                    })
            except Exception as exc:
                fixes.append({
                    "action": "agent_followup_reminder",
                    "description": "Auto-install 'reportlab' threw exception",
                    "success": False,
                    "detail": str(exc)[:300],
                })

    # ── Fix 2: OpenAI API key error ───────────────────────────────────────────
    openai_errors = [
        e for e in by_action.get("pond_nurture", [])
        if "invalid_api_key" in e.lower() or "incorrect api key" in e.lower()
    ]
    if openai_errors:
        fixes.append({
            "action": "pond_nurture",
            "description": "OpenAI API key invalid — manual fix required",
            "success": False,
            "detail": (
                "The OPENAI_API_KEY in /home/ubuntu/fub_automation/.env appears "
                "to be invalid or expired. Update it with a valid key from "
                "https://platform.openai.com/account/api-keys"
            ),
        })

    return fixes


# ─────────────────────────────────────────────────────────────────────────────
# Section 4: Report generation
# ─────────────────────────────────────────────────────────────────────────────

def _format_local_errors_html(
    local_errors: List[Dict[str, Any]],
    run_summary: Dict[str, Any],
    fixes: List[Dict[str, Any]],
) -> str:
    """Build the HTML section for Python automation errors."""
    if not local_errors and not run_summary:
        return "<p style='color:#22c55e;'>No Python automation errors in the past 24 hours.</p>"

    from collections import defaultdict
    by_action: Dict[str, List[Dict]] = defaultdict(list)
    for row in local_errors:
        by_action[row["action"]].append(row)

    html_parts = []

    # Run summary table
    if run_summary:
        html_parts.append("<h3 style='margin:16px 0 8px;'>Python Automation Run Summary</h3>")
        html_parts.append(
            "<table style='border-collapse:collapse;width:100%;font-size:13px;'>"
            "<tr style='background:#f3f4f6;'>"
            "<th style='padding:6px 10px;text-align:left;border:1px solid #e5e7eb;'>Action</th>"
            "<th style='padding:6px 10px;text-align:left;border:1px solid #e5e7eb;'>Statuses</th>"
            "</tr>"
        )
        for action, statuses in sorted(run_summary.items()):
            status_str = ", ".join(
                f"{s}: {c}" for s, c in sorted(statuses.items())
            )
            has_error = "error" in statuses
            row_bg = "#fef2f2" if has_error else "#fff"
            html_parts.append(
                f"<tr style='background:{row_bg};'>"
                f"<td style='padding:6px 10px;border:1px solid #e5e7eb;font-family:monospace;'>{action}</td>"
                f"<td style='padding:6px 10px;border:1px solid #e5e7eb;'>{status_str}</td>"
                "</tr>"
            )
        html_parts.append("</table>")

    # Error details
    if local_errors:
        html_parts.append("<h3 style='margin:16px 0 8px;color:#ef4444;'>Python Automation Errors</h3>")
        for action, rows in sorted(by_action.items()):
            html_parts.append(
                f"<div style='margin:8px 0;padding:10px;background:#fef2f2;"
                f"border-left:4px solid #ef4444;border-radius:4px;'>"
                f"<strong>{action}</strong> — {len(rows)} error(s)"
                f"<ul style='margin:6px 0 0;padding-left:20px;font-size:12px;'>"
            )
            for r in rows[:5]:
                try:
                    details = json.loads(r.get("details") or "{}")
                except json.JSONDecodeError:
                    details = {}
                err_msg = details.get("error", r.get("status", "unknown"))[:200]
                ts = r.get("created_at", "")[:19].replace("T", " ")
                html_parts.append(f"<li>{ts} — {err_msg}</li>")
            if len(rows) > 5:
                html_parts.append(f"<li>... and {len(rows) - 5} more</li>")
            html_parts.append("</ul></div>")

    # Auto-fix results
    if fixes:
        html_parts.append("<h3 style='margin:16px 0 8px;color:#3b82f6;'>Auto-Fix Results</h3>")
        for fix in fixes:
            icon = "OK" if fix["success"] is True else ("PENDING" if fix["success"] is None else "FAILED")
            bg = "#f0fdf4" if fix["success"] is True else ("#eff6ff" if fix["success"] is None else "#fef2f2")
            border = "#22c55e" if fix["success"] is True else ("#3b82f6" if fix["success"] is None else "#ef4444")
            html_parts.append(
                f"<div style='margin:8px 0;padding:10px;background:{bg};"
                f"border-left:4px solid {border};border-radius:4px;'>"
                f"<strong>[{icon}] {fix['description']}</strong><br>"
                f"<span style='font-size:12px;color:#374151;'>{fix['detail']}</span>"
                "</div>"
            )

    return "\n".join(html_parts)


def _format_bot_observations_html(
    dashboard_data: Optional[Dict[str, Any]],
    report_time: dt.datetime,
) -> str:
    """Build the HTML section for Node.js agent bot observations."""
    if dashboard_data is None:
        return (
            "<div style='padding:10px;background:#fef3c7;border-left:4px solid #f59e0b;"
            "border-radius:4px;'>"
            "<strong>Dashboard API Unreachable</strong><br>"
            "<span style='font-size:12px;'>Could not fetch agent bot data from the WebDev dashboard. "
            "Check DASHBOARD_URL and HEALER_SECRET in .env, and verify the dashboard is running.</span>"
            "</div>"
        )

    observations = dashboard_data.get("observations", [])
    run_status = dashboard_data.get("run_status", [])

    # Build per-bot run status map
    bot_run_map: Dict[str, Dict[str, Any]] = {}
    for entry in run_status:
        src = entry.get("source", "")
        cat = entry.get("category", "")
        if src in AGENT_BOTS:
            if cat == "run_complete":
                bot_run_map.setdefault(src, {})["run_complete"] = entry
            elif cat == "run_start":
                bot_run_map.setdefault(src, {})["run_start"] = entry

    from collections import defaultdict
    obs_by_source: Dict[str, List[Dict]] = defaultdict(list)
    for obs in observations:
        obs_by_source[obs.get("source", "unknown")].append(obs)

    html_parts = []
    html_parts.append("<h3 style='margin:16px 0 8px;'>Agent Bot Run Status</h3>")
    html_parts.append(
        "<table style='border-collapse:collapse;width:100%;font-size:13px;'>"
        "<tr style='background:#f3f4f6;'>"
        "<th style='padding:6px 10px;text-align:left;border:1px solid #e5e7eb;'>Bot</th>"
        "<th style='padding:6px 10px;text-align:left;border:1px solid #e5e7eb;'>Status</th>"
        "<th style='padding:6px 10px;text-align:left;border:1px solid #e5e7eb;'>Last Run</th>"
        "<th style='padding:6px 10px;text-align:left;border:1px solid #e5e7eb;'>Errors/Warnings</th>"
        "</tr>"
    )

    current_utc_hour = report_time.astimezone(UTC).hour

    for slug, display_name in AGENT_BOTS.items():
        run_info = bot_run_map.get(slug, {})
        run_complete = run_info.get("run_complete")
        errors = obs_by_source.get(slug, [])
        error_count = len([o for o in errors if o.get("severity") == "error"])
        warning_count = len([o for o in errors if o.get("severity") == "warning"])

        if run_complete:
            status_label = "RAN"
            status_color = "#22c55e" if error_count == 0 else "#f59e0b"
            last_run = run_complete.get("createdAt", "")[:19].replace("T", " ") + " UTC"
        elif current_utc_hour < 15:
            status_label = "PENDING"
            status_color = "#6b7280"
            last_run = "Not yet (expected 10am CT)"
        else:
            status_label = "MISSING"
            status_color = "#ef4444"
            last_run = "No run recorded today"

        err_str = ""
        if error_count > 0:
            err_str += f"<span style='color:#ef4444;font-weight:bold;'>{error_count} error(s)</span> "
        if warning_count > 0:
            err_str += f"<span style='color:#f59e0b;'>{warning_count} warning(s)</span>"
        if not err_str:
            err_str = "<span style='color:#22c55e;'>Clean</span>"

        html_parts.append(
            f"<tr>"
            f"<td style='padding:6px 10px;border:1px solid #e5e7eb;font-weight:bold;'>{display_name}</td>"
            f"<td style='padding:6px 10px;border:1px solid #e5e7eb;'>"
            f"<span style='background:{status_color};color:#fff;padding:2px 8px;"
            f"border-radius:4px;font-size:11px;font-weight:bold;'>{status_label}</span></td>"
            f"<td style='padding:6px 10px;border:1px solid #e5e7eb;font-size:12px;'>{last_run}</td>"
            f"<td style='padding:6px 10px;border:1px solid #e5e7eb;'>{err_str}</td>"
            "</tr>"
        )

    html_parts.append("</table>")

    if observations:
        html_parts.append(
            "<h3 style='margin:16px 0 8px;color:#ef4444;'>Agent Bot Observations (Errors and Warnings)</h3>"
        )
        for obs in observations[:20]:
            sev = obs.get("severity", "info")
            sev_color = "#ef4444" if sev == "error" else "#f59e0b"
            ts = obs.get("createdAt", "")[:19].replace("T", " ")
            source = obs.get("source", "unknown")
            category = obs.get("category", "")
            message = obs.get("message", "")[:200]
            detail = obs.get("detail", "")
            resolved = obs.get("resolved", False)
            resolved_str = " (resolved)" if resolved else ""
            html_parts.append(
                f"<div style='margin:6px 0;padding:8px 12px;background:#fef2f2;"
                f"border-left:4px solid {sev_color};border-radius:4px;font-size:12px;'>"
                f"<strong>{sev.upper()}</strong> [{source} / {category}]{resolved_str} — {ts}<br>"
                f"{message}"
                + (f"<br><span style='color:#6b7280;'>{detail[:150]}</span>" if detail else "")
                + "</div>"
            )
        if len(observations) > 20:
            html_parts.append(
                f"<p style='font-size:12px;color:#6b7280;'>... and {len(observations) - 20} more observations.</p>"
            )
    else:
        html_parts.append(
            "<p style='color:#22c55e;'>No agent bot errors or warnings in the past 24 hours.</p>"
        )

    return "\n".join(html_parts)


def build_html_report(
    report_time: dt.datetime,
    local_errors: List[Dict[str, Any]],
    run_summary: Dict[str, Any],
    fixes: List[Dict[str, Any]],
    dashboard_data: Optional[Dict[str, Any]],
    dashboard_url: str,
) -> str:
    """Assemble the full HTML morning report."""
    ct_time = report_time.astimezone(CT)
    date_str = ct_time.strftime("%A, %B %-d, %Y at %-I:%M %p CT")

    has_local_errors = len(local_errors) > 0
    has_bot_errors = False
    has_bot_missing = False
    if dashboard_data:
        obs = dashboard_data.get("observations", [])
        has_bot_errors = any(o.get("severity") == "error" for o in obs)
        run_status = dashboard_data.get("run_status", [])
        ran_bots = {e["source"] for e in run_status if e.get("category") == "run_complete"}
        current_utc_hour = report_time.astimezone(UTC).hour
        if current_utc_hour >= 15:
            has_bot_missing = any(slug not in ran_bots for slug in AGENT_BOTS)

    dashboard_unreachable = dashboard_data is None

    if not has_local_errors and not has_bot_errors and not has_bot_missing and not dashboard_unreachable:
        health_banner_color = "#22c55e"
        health_banner_text = "All Systems Green — No Issues Detected"
    elif has_bot_errors or has_local_errors or has_bot_missing:
        health_banner_color = "#ef4444"
        health_banner_text = "Issues Detected — Review Required"
    else:
        health_banner_color = "#f59e0b"
        health_banner_text = "Partial Data — Dashboard Unreachable"

    local_section = _format_local_errors_html(local_errors, run_summary, fixes)
    bot_section = _format_bot_observations_html(dashboard_data, report_time)

    dashboard_link = (
        f'<a href="{dashboard_url}" style="color:#3b82f6;">{dashboard_url}</a>'
        if dashboard_url else "Dashboard URL not configured"
    )

    html = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LDR Morning Health Report</title>
</head>
<body style="font-family:system-ui,-apple-system,sans-serif;max-width:800px;margin:0 auto;padding:20px;color:#111827;">

  <div style="background:#1e3a5f;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0;">
    <h1 style="margin:0;font-size:20px;">Lifestyle Design Realty</h1>
    <p style="margin:4px 0 0;font-size:14px;opacity:0.85;">Daily System Health Report — {date_str}</p>
  </div>

  <div style="background:{health_banner_color};color:#fff;padding:12px 24px;font-weight:bold;font-size:15px;">
    {health_banner_text}
  </div>

  <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 8px 8px;">

    <h2 style="margin:0 0 12px;font-size:16px;border-bottom:2px solid #e5e7eb;padding-bottom:8px;">
      Quick Summary
    </h2>
    <table style="border-collapse:collapse;width:100%;font-size:13px;margin-bottom:20px;">
      <tr style="background:#f3f4f6;">
        <th style="padding:6px 10px;text-align:left;border:1px solid #e5e7eb;">System</th>
        <th style="padding:6px 10px;text-align:left;border:1px solid #e5e7eb;">Status</th>
        <th style="padding:6px 10px;text-align:left;border:1px solid #e5e7eb;">Detail</th>
      </tr>
      <tr>
        <td style="padding:6px 10px;border:1px solid #e5e7eb;">Python Pond Automation</td>
        <td style="padding:6px 10px;border:1px solid #e5e7eb;">
          <span style="background:{'#ef4444' if has_local_errors else '#22c55e'};color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:bold;">{'ERRORS' if has_local_errors else 'OK'}</span>
        </td>
        <td style="padding:6px 10px;border:1px solid #e5e7eb;">{len(local_errors)} error(s) in audit_log</td>
      </tr>
      <tr>
        <td style="padding:6px 10px;border:1px solid #e5e7eb;">Agent Bots (6 bots)</td>
        <td style="padding:6px 10px;border:1px solid #e5e7eb;">
          <span style="background:{'#ef4444' if has_bot_errors else ('#f59e0b' if (has_bot_missing or dashboard_unreachable) else '#22c55e')};color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:bold;">{'ERRORS' if has_bot_errors else ('MISSING' if has_bot_missing else ('UNREACHABLE' if dashboard_unreachable else 'OK'))}</span>
        </td>
        <td style="padding:6px 10px;border:1px solid #e5e7eb;">
          {'Dashboard unreachable' if dashboard_unreachable else str(len(dashboard_data.get('observations', []))) + ' observation(s) in bot_observations'}
        </td>
      </tr>
      <tr>
        <td style="padding:6px 10px;border:1px solid #e5e7eb;">Auto-Fix Actions</td>
        <td style="padding:6px 10px;border:1px solid #e5e7eb;">
          <span style="background:{'#3b82f6' if fixes else '#6b7280'};color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:bold;">{'APPLIED' if fixes else 'NONE'}</span>
        </td>
        <td style="padding:6px 10px;border:1px solid #e5e7eb;">{len(fixes)} fix(es) attempted</td>
      </tr>
    </table>

    <h2 style="margin:20px 0 12px;font-size:16px;border-bottom:2px solid #e5e7eb;padding-bottom:8px;">
      Python Pond Automation (SQLite audit_log)
    </h2>
    {local_section}

    <h2 style="margin:20px 0 12px;font-size:16px;border-bottom:2px solid #e5e7eb;padding-bottom:8px;">
      Agent Bots (WebDev Dashboard — bot_observations)
    </h2>
    {bot_section}

    <hr style="margin:24px 0;border:none;border-top:1px solid #e5e7eb;">
    <p style="font-size:11px;color:#9ca3af;margin:0;">
      Generated by nightly_health.py on {date_str}<br>
      Dashboard: {dashboard_link}<br>
      Cloud computer: Peter Allen's Cloud PC 2 (34.148.93.161)<br>
      Database: /home/ubuntu/fub_automation/data/fub_automation.sqlite3
    </p>
  </div>

</body>
</html>"""
    return html


# ─────────────────────────────────────────────────────────────────────────────
# Section 5: Email delivery
# ─────────────────────────────────────────────────────────────────────────────

def send_report_email(
    subject: str,
    html_body: str,
    recipients: List[str],
    smtp_host: str,
    smtp_port: int,
    smtp_user: str,
    smtp_password: str,
    email_from: str,
    dry_run: bool,
) -> bool:
    """Send the HTML report via SMTP. Returns True on success."""
    if dry_run:
        log.info("DRY RUN — would send email to: %s", ", ".join(recipients))
        log.info("Subject: %s", subject)
        print("\n" + "=" * 70)
        print("DRY RUN — Email would be sent to:", ", ".join(recipients))
        print("Subject:", subject)
        print("=" * 70)
        import re
        text_preview = re.sub(r"<[^>]+>", "", html_body)
        text_preview = re.sub(r"\n{3,}", "\n\n", text_preview).strip()
        print(text_preview[:3000])
        print("=" * 70 + "\n")
        return True

    if not all([smtp_host, smtp_user, smtp_password, email_from]):
        log.error("SMTP settings incomplete — cannot send email")
        return False

    msg = email.message.EmailMessage()
    msg["From"] = email_from
    msg["To"] = ", ".join(recipients)
    msg["Subject"] = subject
    msg.set_content(
        "This report requires an HTML-capable email client. "
        "Please view it in an HTML-enabled email reader."
    )
    msg.add_alternative(html_body, subtype="html")

    try:
        with smtplib.SMTP(smtp_host, smtp_port) as smtp:
            smtp.starttls()
            smtp.login(smtp_user, smtp_password)
            smtp.send_message(msg)
        log.info("Report email sent to: %s", ", ".join(recipients))
        return True
    except Exception as exc:
        log.error("Failed to send report email: %s", exc)
        return False


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Unified 4am morning healer — queries both Python audit_log and WebDev bot_observations."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print report to stdout instead of sending email",
    )
    parser.add_argument(
        "--window-hours",
        type=int,
        default=24,
        help="How many hours back to look for errors (default: 24)",
    )
    args = parser.parse_args()

    load_dotenv(".env")
    dry_run = args.dry_run or get_env("DRY_RUN", "false").lower() in {"1", "true", "yes"}

    smtp_host = get_env("SMTP_HOST", "smtp.gmail.com")
    smtp_port = int(get_env("SMTP_PORT", "587"))
    smtp_user = get_env("SMTP_USER")
    smtp_password = get_env("SMTP_PASSWORD")
    email_from = get_env("EMAIL_FROM", smtp_user)
    db_path = get_env("DATABASE_PATH", "data/fub_automation.sqlite3")
    dashboard_url = get_env("DASHBOARD_URL", "")
    healer_secret = get_env("HEALER_SECRET", "")
    fub_nurture_url = get_env("FUB_NURTURE_URL", "")
    report_to_raw = get_env(
        "HEALER_REPORT_TO",
        "peter@lifestyledesignrealty.com,steven@lifestyledesignrealty.com",
    )
    recipients = [r.strip() for r in report_to_raw.split(",") if r.strip()]

    report_time = dt.datetime.now(UTC)
    since = report_time - dt.timedelta(hours=args.window_hours)

    log.info(
        "Starting unified nightly health check. window=%dh, dry_run=%s",
        args.window_hours,
        dry_run,
    )

    log.info("Querying local SQLite audit_log since %s", since.isoformat())
    local_errors = query_local_errors(db_path, since)
    run_summary = query_local_run_summary(db_path, since)
    log.info("Found %d local errors", len(local_errors))

    log.info("Fetching bot observations from WebDev dashboard: %s", dashboard_url or "(not configured)")
    dashboard_data = fetch_dashboard_observations(dashboard_url, healer_secret)

    log.info("Running auto-fix logic on %d local errors", len(local_errors))
    fixes = attempt_auto_fixes(local_errors, db_path, dry_run)

    log.info("Building HTML report")
    html_report = build_html_report(
        report_time=report_time,
        local_errors=local_errors,
        run_summary=run_summary,
        fixes=fixes,
        dashboard_data=dashboard_data,
        dashboard_url=dashboard_url,
    )

    has_issues = (
        len(local_errors) > 0
        or (dashboard_data and any(
            o.get("severity") == "error"
            for o in dashboard_data.get("observations", [])
        ))
        or dashboard_data is None
    )
    ct_date = report_time.astimezone(CT).strftime("%b %-d")
    if has_issues:
        subject = f"LDR Morning Health Report - {ct_date} - Issues Detected"
    else:
        subject = f"LDR Morning Health Report - {ct_date} - All Systems Green"

    success = send_report_email(
        subject=subject,
        html_body=html_report,
        recipients=recipients,
        smtp_host=smtp_host,
        smtp_port=smtp_port,
        smtp_user=smtp_user,
        smtp_password=smtp_password,
        email_from=email_from,
        dry_run=dry_run,
    )

    if success:
        log.info("Nightly health check complete.")
        # Write heartbeat observation to fub-nurture dashboard so botMonitor
        # clears the "Nightly healer last ran" warning automatically.
        post_healer_heartbeat(
            fub_nurture_url=fub_nurture_url,
            healer_secret=healer_secret,
            local_errors=len(local_errors),
            dashboard_ok=(dashboard_data is not None),
            dry_run=dry_run,
        )
        return 0
    else:
        log.error("Nightly health check completed but email delivery failed.")
        # Still attempt heartbeat even on email failure so botMonitor knows healer ran
        post_healer_heartbeat(
            fub_nurture_url=fub_nurture_url,
            healer_secret=healer_secret,
            local_errors=len(local_errors),
            dashboard_ok=(dashboard_data is not None),
            dry_run=dry_run,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
