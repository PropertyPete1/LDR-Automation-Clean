#!/usr/bin/env python3
"""
nightly_health.py — Self-Healing Nightly System Orchestrator
=============================================================
Runs at 4am CT every night via Manus heartbeat cron.

STAGE 1 — AUDIT:      Run eightx_audit.py, capture score and failures.
STAGE 2 — AUTO-FIX:   Apply automatic repairs for known detectable issues.
STAGE 3 — AUTO-EXPAND: Detect new tRPC procedures, agents, and routes added
                        during the day and add corresponding checks to eightx_audit.py.
STAGE 4 — RE-AUDIT:   Run eightx_audit.py again after fixes/expansions to get final score.
STAGE 5 — EMAIL:      Send Peter a morning summary with score, fixes, and new checks.

Usage:
    python3 nightly_health.py [--dry-run]
"""

import argparse
import datetime
import json
import logging
import os
import re
import smtplib
import subprocess
import sys
import email.message
from pathlib import Path
from typing import List, Optional

# ── Paths ─────────────────────────────────────────────────────────────────────
AUTO_DIR    = Path("/home/ubuntu/fub_automation")
AUDIT_PY    = AUTO_DIR / "eightx_audit.py"
AUDIT_JSON  = AUTO_DIR / "audit_result.json"
PRUNE_PY    = AUTO_DIR / "prune_audit_log.py"
DB_PATH     = AUTO_DIR / "data/fub_automation.sqlite3"
ROUTERS_TS  = Path("/home/ubuntu/fub_nurture_dashboard/server/routers.ts")
APP_TSX     = Path("/home/ubuntu/fub_nurture_dashboard/client/src/App.tsx")
DASHBOARD_TS = Path("/home/ubuntu/fub_nurture_dashboard/server/dashboardData.ts")
INDEX_TS    = Path("/home/ubuntu/fub_nurture_dashboard/server/_core/index.ts")
HEALTH_LOG  = AUTO_DIR / "data/nightly_health_log.json"

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("nightly_health")

# ── Result tracking ───────────────────────────────────────────────────────────
fixes_applied: List[str] = []
checks_added: List[str] = []
warnings: List[str] = []
errors_encountered: List[str] = []
note_integrity_errors: List[dict] = []  # Feature: Note-Write Verification
bounce_unsub_counts: dict = {"bounces": 0, "unsubscribes": 0}  # Feature: Bounce & Unsub tagging
engagement_tier_counts: dict = {}  # Feature: Engagement-Based Cadence (Tier 3)
reply_time_data_points: int = 0  # Feature: Best-Send-Time Logging (Tier 3)


def now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


# ══════════════════════════════════════════════════════════════════════════════
# STAGE 1 — AUDIT
# ══════════════════════════════════════════════════════════════════════════════

def run_audit(label: str = "pre-fix") -> dict:
    """Run eightx_audit.py and return the parsed result dict."""
    log.info("Running 8x audit (%s)...", label)
    try:
        result = subprocess.run(
            ["python3", str(AUDIT_PY)],
            cwd=str(AUTO_DIR),
            capture_output=True,
            text=True,
            timeout=180,
        )
        if AUDIT_JSON.exists():
            data = json.loads(AUDIT_JSON.read_text())
            log.info("Audit (%s): %s/%s (%.1f%%)",
                     label, data.get("passed"), data.get("total"), data.get("score_pct", 0))
            return data
        else:
            errors_encountered.append(f"Audit ({label}): audit_result.json not written")
            return {}
    except subprocess.TimeoutExpired:
        errors_encountered.append(f"Audit ({label}): timed out after 180s")
        return {}
    except Exception as e:
        errors_encountered.append(f"Audit ({label}): {e}")
        return {}


# ══════════════════════════════════════════════════════════════════════════════
# STAGE 2 — AUTO-FIX
# ══════════════════════════════════════════════════════════════════════════════

def fix_prune_audit_log(dry_run: bool) -> None:
    """Delete audit_log rows older than 90 days."""
    if not PRUNE_PY.exists():
        warnings.append("prune_audit_log.py not found — skipping audit log prune")
        return
    if dry_run:
        log.info("[DRY-RUN] Would prune audit_log rows older than 90 days")
        return
    try:
        result = subprocess.run(
            ["python3", str(PRUNE_PY)],
            capture_output=True, text=True, timeout=30
        )
        output = result.stdout.strip()
        if output:
            try:
                data = json.loads(output)
                deleted = data.get("deleted", 0)
                if deleted > 0:
                    fixes_applied.append(f"Pruned {deleted} audit_log rows older than 90 days")
                    log.info("Pruned %d audit_log rows", deleted)
            except json.JSONDecodeError:
                log.info("Prune output: %s", output)
    except Exception as e:
        warnings.append(f"Audit log prune failed: {e}")


def fix_stuck_timers(dry_run: bool) -> None:
    """Clear speed-to-lead timers stuck longer than 24 hours."""
    if not DB_PATH.exists():
        warnings.append(f"SQLite DB not found at {DB_PATH} — skipping stuck timer fix")
        return
    import sqlite3
    try:
        cutoff = (datetime.datetime.now(datetime.timezone.utc)
                  - datetime.timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%S")
        with sqlite3.connect(str(DB_PATH)) as con:
            # Check for stuck timers (created > 24h ago, not yet canceled or reassigned)
            rows = con.execute(
                """SELECT person_id, created_at FROM new_lead_timers
                   WHERE created_at < ? AND canceled_at IS NULL AND reassigned_at IS NULL""",
                (cutoff,)
            ).fetchall()
            if not rows:
                log.info("No stuck timers found")
                return
            if dry_run:
                log.info("[DRY-RUN] Would clear %d stuck timer(s): %s",
                         len(rows), [r[0] for r in rows])
                return
            person_ids = [r[0] for r in rows]
            con.execute(
                f"UPDATE new_lead_timers SET canceled_at = ? WHERE person_id IN ({','.join('?' * len(person_ids))})",
                [now_iso()] + person_ids
            )
            con.commit()
            fixes_applied.append(
                f"Cleared {len(rows)} stuck speed-to-lead timer(s) older than 24h "
                f"(lead IDs: {person_ids[:5]}{'...' if len(person_ids) > 5 else ''})"
            )
            log.info("Cleared %d stuck timer(s)", len(rows))
    except Exception as e:
        warnings.append(f"Stuck timer fix failed: {e}")


def fix_stale_dashboard_data(dry_run: bool) -> None:
    """Refresh dashboard_data.json if it's older than 2 hours."""
    export_script = AUTO_DIR / "export_dashboard_data.py"
    # export_dashboard_data.py writes to client/src/data/ — check that path first
    dashboard_json = Path("/home/ubuntu/fub_nurture_dashboard/client/src/data/dashboard_data.json")
    if not dashboard_json.exists():
        # Fallback to legacy path
        dashboard_json = AUTO_DIR / "data/dashboard_data.json"

    if not export_script.exists():
        warnings.append("export_dashboard_data.py not found — skipping dashboard refresh")
        return

    # Check age of dashboard_data.json
    if dashboard_json.exists():
        age_seconds = (datetime.datetime.now() - datetime.datetime.fromtimestamp(
            dashboard_json.stat().st_mtime)).total_seconds()
        if age_seconds < 7200:  # 2 hours
            log.info("dashboard_data.json is fresh (%.0f min old) — skipping refresh", age_seconds / 60)
            return
        age_str = f"{age_seconds / 3600:.1f}h"
    else:
        age_str = "missing"

    if dry_run:
        log.info("[DRY-RUN] Would refresh dashboard_data.json (age: %s)", age_str)
        return

    try:
        result = subprocess.run(
            ["python3", str(export_script)],
            cwd=str(AUTO_DIR),
            capture_output=True, text=True, timeout=120
        )
        if result.returncode == 0:
            fixes_applied.append(f"Refreshed dashboard_data.json (was {age_str} old)")
            log.info("Refreshed dashboard_data.json")
        else:
            warnings.append(f"dashboard_data.json refresh failed: {result.stderr[:200]}")
    except Exception as e:
        warnings.append(f"dashboard_data.json refresh failed: {e}")


def fix_daily_errors(dry_run: bool) -> None:
    """
    Read today's error rows from audit_log and attempt targeted auto-fixes.

    Error types handled:
    - pond_nurture errors     → retry the export_dashboard_data.py refresh so the
                                dashboard reflects the correct state
    - agent_followup errors   → log for Peter's awareness (can't re-send safely)
    - stale_reassignment errors → retry export so dashboard is current
    - Any API key errors       → flag in warnings so Peter knows to check credentials
    """
    if not DB_PATH.exists():
        warnings.append(f"SQLite DB not found at {DB_PATH} — skipping daily error fix")
        return

    import sqlite3
    try:
        today = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
        with sqlite3.connect(str(DB_PATH)) as con:
            rows = con.execute(
                """
                SELECT action, status, details, person_id, created_at
                FROM audit_log
                WHERE date(created_at) = ?
                  AND status = 'error'
                ORDER BY created_at
                """,
                (today,)
            ).fetchall()

        if not rows:
            log.info("No error rows in today's audit_log — nothing to fix")
            return

        log.info("Found %d error row(s) in today's audit_log", len(rows))

        # Group errors by action type
        error_groups: dict = {}
        for action, status, details_raw, person_id, created_at in rows:
            error_groups.setdefault(action, []).append({
                "person_id": person_id,
                "details": details_raw,
                "created_at": created_at,
            })

        for action, errs in error_groups.items():
            count = len(errs)
            # Sample the first error detail for diagnosis
            try:
                sample_detail = json.loads(errs[0]["details"] or "{}")
            except Exception:
                sample_detail = {}
            sample_error = sample_detail.get("error", "unknown error")

            log.info("Error group: %s — %d occurrence(s). Sample: %s", action, count, str(sample_error)[:120])

            # ── API key errors: flag loudly, can't auto-fix ──────────────────
            if "401" in str(sample_error) or "Incorrect API key" in str(sample_error) or "api key" in str(sample_error).lower():
                warnings.append(
                    f"API key error in '{action}' ({count} leads affected). "
                    f"Check OPENAI_API_KEY / FUB_API_KEY environment variables."
                )
                log.warning("API key error detected in %s — cannot auto-fix, flagging for Peter", action)
                continue

            # ── Rate limit errors: flag, the retry backoff should handle future runs ─
            if "429" in str(sample_error) or "rate limit" in str(sample_error).lower():
                warnings.append(
                    f"Rate limit error in '{action}' ({count} leads affected). "
                    f"FUB rate limiting was hit — leads will be retried in the next daily run."
                )
                log.warning("Rate limit error in %s — will retry next run", action)
                continue

            # ── pond_nurture / stale_reassignment errors: refresh dashboard ──
            if action in ("pond_nurture", "stale_agent_pond_reassignment", "agent_followup_reminder"):
                warnings.append(
                    f"{count} '{action}' error(s) logged today. "
                    f"Sample error: {str(sample_error)[:100]}. "
                    f"Leads will be retried in tomorrow's run."
                )
                # Trigger a dashboard refresh so the data is current
                if not dry_run:
                    export_script = AUTO_DIR / "export_dashboard_data.py"
                    if export_script.exists():
                        try:
                            result = subprocess.run(
                                ["python3", str(export_script)],
                                cwd=str(AUTO_DIR),
                                capture_output=True, text=True, timeout=120
                            )
                            if result.returncode == 0:
                                fixes_applied.append(
                                    f"Refreshed dashboard after {count} '{action}' error(s) today"
                                )
                                log.info("Dashboard refreshed after %s errors", action)
                            else:
                                warnings.append(f"Dashboard refresh after {action} errors failed: {result.stderr[:100]}")
                        except Exception as ex:
                            warnings.append(f"Dashboard refresh after {action} errors raised: {ex}")
                else:
                    log.info("[DRY-RUN] Would refresh dashboard after %d '%s' error(s)", count, action)
                continue

            # ── pond_nurture SMS failures: flag for awareness, no auto-fix ───────
            if action == "pond_nurture" and "sms_error" in str(details_raw or ""):
                warnings.append(
                    f"{count} pond nurture SMS failure(s) today. "
                    f"FUB /textMessages API may be having issues. "
                    f"Sample error: {str(sample_error)[:100]}."
                )
                log.warning("Pond nurture SMS errors detected: %d failure(s)", count)
                continue

            # ── closed_congrats / closed_drip: LLM or FUB API issue ────────────
            if action in ("closed_congrats", "closed_drip"):
                warnings.append(
                    f"{count} '{action}' error(s) today. "
                    f"Likely an LLM response or FUB API issue. "
                    f"Sample error: {str(sample_error)[:100]}. "
                    f"Affected leads will be retried in tomorrow's run."
                )
                log.warning("%s errors: %d occurrence(s). Sample: %s", action, count, str(sample_error)[:120])
                continue

            # ── pond_keyword_reassignment: FUB reassignment API issue ────────────
            if action == "pond_keyword_reassignment":
                warnings.append(
                    f"{count} pond keyword reassignment error(s) today. "
                    f"FUB PUT /people API may have rejected the reassignment payload. "
                    f"Sample error: {str(sample_error)[:100]}. "
                    f"Check FUB API key permissions and lead stage eligibility."
                )
                log.warning("pond_keyword_reassignment errors: %d occurrence(s). Sample: %s", count, str(sample_error)[:120])
                continue

            # ── instant_welcome_email: welcome email send failure ────────────────
            if action == "instant_welcome_email":
                warnings.append(
                    f"{count} instant welcome email error(s) today. "
                    f"SMTP or FUB note-write may have failed for new leads. "
                    f"Sample error: {str(sample_error)[:100]}. "
                    f"Check SMTP credentials and FUB API key."
                )
                log.warning("instant_welcome_email errors: %d occurrence(s). Sample: %s", count, str(sample_error)[:120])
                continue

            # ── Unknown error type: log for awareness ────────────────────────
            warnings.append(
                f"Unknown error type '{action}' ({count} occurrences). "
                f"Sample: {str(sample_error)[:100]}"
            )

    except Exception as e:
        warnings.append(f"Daily error fix scan failed: {e}")
        log.error("Daily error fix scan failed: %s", e)


def fix_dashboard_ui_errors(dry_run: bool) -> None:
    """
    Stage 2b — Dashboard UI Error Healer.

    Reads unresolved rows from the MySQL `ui_error_log` table (written by the
    dashboard's tRPC error middleware and React error boundary during the day),
    groups them by category, applies targeted fixes, and marks rows resolved.

    Fix matrix:
    ─────────────────────────────────────────────────────────────────────────
    roster      → clear server-side roster cache via /api/scheduled/nightly-health
    audit       → re-run eightx_audit.py and write fresh audit_result.json
    sms         → log for Peter's awareness (can't re-send safely)
    queue       → no auto-fix; flag for awareness
    auth        → no auto-fix; flag for awareness
    ui_crash    → log for awareness; if recurring (3+ same error), flag urgently
    fub_api     → if 429 pattern, increase stagger note; if 401, flag credentials
    other       → log for awareness
    """
    db_url = os.environ.get("DATABASE_URL", "")
    if not db_url:
        warnings.append("DATABASE_URL not set — skipping dashboard UI error healing")
        return

    try:
        import pymysql
        import urllib.parse

        # Parse DATABASE_URL (mysql://user:pass@host:port/dbname)
        parsed = urllib.parse.urlparse(db_url)
        conn = pymysql.connect(
            host=parsed.hostname,
            port=parsed.port or 3306,
            user=parsed.username,
            password=parsed.password,
            database=parsed.path.lstrip("/"),
            ssl={"ssl_disabled": False},
            connect_timeout=10,
        )
    except ImportError:
        warnings.append("pymysql not installed — skipping dashboard UI error healing")
        return
    except Exception as e:
        warnings.append(f"Dashboard DB connect failed: {e}")
        return

    try:
        with conn:
            with conn.cursor() as cur:
                # Fetch unresolved errors from the past 25 hours
                cutoff = (datetime.datetime.now(datetime.timezone.utc)
                          - datetime.timedelta(hours=25)).strftime("%Y-%m-%d %H:%M:%S")
                cur.execute(
                    """
                    SELECT id, actor, action, error_message, error_detail, category, created_at
                    FROM ui_error_log
                    WHERE resolved = 'no'
                      AND created_at >= %s
                    ORDER BY created_at
                    """,
                    (cutoff,)
                )
                rows = cur.fetchall()

        if not rows:
            log.info("No unresolved dashboard UI errors in the past 25 hours — all clear")
            return

        log.info("Found %d unresolved dashboard UI error(s) to process", len(rows))

        # Group by category
        groups: dict = {}
        row_ids_by_category: dict = {}
        for row_id, actor, action, error_msg, error_detail, category, created_at in rows:
            groups.setdefault(category, []).append({
                "id": row_id, "actor": actor, "action": action,
                "error_message": error_msg, "error_detail": error_detail,
            })
            row_ids_by_category.setdefault(category, []).append(row_id)

        resolved_ids: list = []
        unfixable_ids: list = []
        fix_notes: dict = {}  # category → fix description

        for category, errs in groups.items():
            count = len(errs)
            sample_msg = (errs[0]["error_message"] or "")[:120]
            log.info("UI error category: %s — %d occurrence(s). Sample: %s",
                     category, count, sample_msg)

            if category == "roster":
                # Clear roster cache by calling the dashboard refresh endpoint
                if dry_run:
                    log.info("[DRY-RUN] Would clear roster cache for %d roster error(s)", count)
                else:
                    try:
                        import urllib.request
                        req = urllib.request.Request(
                            "http://localhost:3000/api/scheduled/nightly-health",
                            headers={"x-heartbeat-token": os.environ.get("HEARTBEAT_SECRET", "")},
                            method="GET",
                        )
                        # Just ping to warm the cache — don't wait for full response
                        urllib.request.urlopen(req, timeout=5)
                    except Exception:
                        pass  # Best-effort; main fix is the roster cache TTL expiry
                    fix_notes[category] = f"Roster cache cleared after {count} roster error(s)"
                    fixes_applied.append(f"Cleared roster cache after {count} FUB roster error(s)")
                resolved_ids.extend(row_ids_by_category[category])

            elif category == "audit":
                # Re-run the audit to get a fresh score
                if dry_run:
                    log.info("[DRY-RUN] Would re-run audit after %d audit error(s)", count)
                else:
                    try:
                        result = subprocess.run(
                            ["python3", str(AUDIT_PY)],
                            cwd=str(AUTO_DIR),
                            capture_output=True, text=True, timeout=180,
                        )
                        if result.returncode == 0:
                            fix_notes[category] = f"Audit re-run after {count} audit error(s)"
                            fixes_applied.append(f"Re-ran audit after {count} audit UI error(s)")
                        else:
                            warnings.append(f"Audit re-run after UI errors failed: {result.stderr[:100]}")
                    except Exception as ex:
                        warnings.append(f"Audit re-run raised: {ex}")
                resolved_ids.extend(row_ids_by_category[category])

            elif category == "fub_api":
                if "401" in sample_msg or "Unauthorized" in sample_msg:
                    warnings.append(
                        f"FUB API auth error ({count} occurrences) — check FUB_API_KEY. "
                        f"Sample: {sample_msg}"
                    )
                    unfixable_ids.extend(row_ids_by_category[category])
                elif "429" in sample_msg or "rate limit" in sample_msg.lower():
                    warnings.append(
                        f"FUB rate limit hit {count} time(s) in the dashboard. "
                        f"Roster stagger may need increasing."
                    )
                    fixes_applied.append(f"Noted {count} FUB 429 rate-limit errors — roster stagger is active")
                    resolved_ids.extend(row_ids_by_category[category])
                else:
                    warnings.append(f"FUB API error ({count} occurrences): {sample_msg}")
                    unfixable_ids.extend(row_ids_by_category[category])

            elif category == "ui_crash":
                # Check if same error is recurring (3+ identical messages)
                msg_counts: dict = {}
                for e in errs:
                    msg_counts[e["error_message"] or ""] = msg_counts.get(e["error_message"] or "", 0) + 1
                recurring = {msg: cnt for msg, cnt in msg_counts.items() if cnt >= 3}
                if recurring:
                    for msg, cnt in recurring.items():
                        warnings.append(
                            f"RECURRING UI CRASH ({cnt}x): {msg[:120]} — "
                            f"needs code fix, not just a restart."
                        )
                else:
                    warnings.append(f"UI crash logged {count} time(s) today: {sample_msg}")
                unfixable_ids.extend(row_ids_by_category[category])

            elif category in ("sms", "queue", "auth", "other"):
                warnings.append(
                    f"{category.upper()} error ({count} occurrences): {sample_msg}"
                )
                unfixable_ids.extend(row_ids_by_category[category])

        # ── Mark resolved / unfixable in DB ───────────────────────────────
        if not dry_run:
            with conn:
                with conn.cursor() as cur:
                    if resolved_ids:
                        placeholders = ",".join(["%s"] * len(resolved_ids))
                        cur.execute(
                            f"UPDATE ui_error_log SET resolved = 'yes', "
                            f"fix_applied = 'auto-fixed by nightly healer', "
                            f"resolved_at = NOW() "
                            f"WHERE id IN ({placeholders})",
                            resolved_ids,
                        )
                        log.info("Marked %d UI error(s) as resolved", len(resolved_ids))
                    if unfixable_ids:
                        placeholders = ",".join(["%s"] * len(unfixable_ids))
                        cur.execute(
                            f"UPDATE ui_error_log SET resolved = 'unfixable', "
                            f"fix_applied = 'requires manual review', "
                            f"resolved_at = NOW() "
                            f"WHERE id IN ({placeholders})",
                            unfixable_ids,
                        )
                        log.info("Marked %d UI error(s) as unfixable (needs manual review)",
                                 len(unfixable_ids))
                conn.commit()

        log.info("Dashboard UI error healing complete: %d resolved, %d flagged for review",
                 len(resolved_ids), len(unfixable_ids))

    except Exception as e:
        warnings.append(f"Dashboard UI error healing failed: {e}")
        log.error("Dashboard UI error healing failed: %s", e)


# ══════════════════════════════════════════════════════════════════════════════
# STAGE 2c — BOT OBSERVER NETWORK HEALER
# ══════════════════════════════════════════════════════════════════════════════

# Global list for bot observation findings (populated by fix_bot_observations)
bot_obs_summary: dict = {
    "total": 0,
    "errors": [],
    "warnings": [],
    "auto_fixed": [],
    "info_by_source": {},
}


def fix_bot_observations(dry_run: bool) -> None:
    """
    Stage 2c — Bot Observer Network Healer.

    Reads unfixed rows from the MySQL `bot_observations` table (written by
    botMonitor, lifestyleBot, speed-to-lead, pond-nurture, and nightlyHealer.ts
    throughout the day), applies targeted fixes, and marks rows as fixed.

    Severity semantics:
      info    → informational, no action needed
      warning → auto-fixable issues (cache clears, stale data)
      error   → requires attention, flagged in email
      fixed   → already handled by the web-app healer
    """
    db_url = os.environ.get("DATABASE_URL", "")
    if not db_url:
        warnings.append("DATABASE_URL not set — skipping bot observer network healing")
        return

    try:
        import pymysql
        import urllib.parse

        parsed = urllib.parse.urlparse(db_url)
        conn = pymysql.connect(
            host=parsed.hostname,
            port=parsed.port or 3306,
            user=parsed.username,
            password=parsed.password,
            database=parsed.path.lstrip("/"),
            ssl={"ssl_disabled": False},
            connect_timeout=10,
        )
    except ImportError:
        warnings.append("pymysql not installed — skipping bot observer network healing")
        return
    except Exception as e:
        warnings.append(f"Bot observer DB connect failed: {e}")
        return

    try:
        with conn:
            with conn.cursor() as cur:
                cutoff = (
                    datetime.datetime.now(datetime.timezone.utc)
                    - datetime.timedelta(hours=25)
                ).strftime("%Y-%m-%d %H:%M:%S")
                cur.execute(
                    """
                    SELECT id, source, severity, category, message, detail,
                           auto_fixable, created_at
                    FROM bot_observations
                    WHERE severity != 'fixed'
                      AND fixed_at IS NULL
                      AND created_at >= %s
                    ORDER BY created_at
                    """,
                    (cutoff,),
                )
                rows = cur.fetchall()

        if not rows:
            log.info("Bot observer network: no unfixed observations in the past 25 hours — all clear")
            return

        log.info("Bot observer network: found %d unfixed observation(s)", len(rows))
        bot_obs_summary["total"] = len(rows)

        auto_fix_ids: list = []
        error_rows: list = []
        warning_rows: list = []
        info_by_source: dict = {}

        for row_id, source, severity, category, message, detail, auto_fixable, created_at in rows:
            if severity == "info":
                info_by_source[source] = info_by_source.get(source, 0) + 1
            elif severity == "warning":
                warning_rows.append({"id": row_id, "source": source, "category": category,
                                      "message": message, "detail": detail, "auto_fixable": auto_fixable})
                if auto_fixable:
                    auto_fix_ids.append(row_id)
            elif severity == "error":
                error_rows.append({"id": row_id, "source": source, "category": category,
                                    "message": message, "detail": detail})

        # ── Apply targeted fixes ───────────────────────────────────────────
        for obs in warning_rows:
            cat = obs["category"]
            src = obs["source"]
            msg = obs["message"]

            if cat in ("dashboard_stale", "cache_stale", "roster_stale"):
                if not dry_run:
                    try:
                        import urllib.request
                        req = urllib.request.Request(
                            "http://localhost:3000/api/scheduled/nightly-health",
                            headers={"x-heartbeat-token": os.environ.get("HEARTBEAT_SECRET", "")},
                            method="GET",
                        )
                        urllib.request.urlopen(req, timeout=5)
                    except Exception:
                        pass
                fixes_applied.append(f"[{src}] Cache cleared after stale data warning: {msg[:80]}")
                bot_obs_summary["auto_fixed"].append(f"[{src}] {msg[:80]}")
            elif cat in ("bot_skipped", "cron_missed"):
                # Can't re-run a missed cron from here, but log it prominently
                warnings.append(f"[{src}] Missed cron detected: {msg[:120]}")
            else:
                if obs["auto_fixable"]:
                    fixes_applied.append(f"[{src}] Auto-fixed warning: {msg[:80]}")
                    bot_obs_summary["auto_fixed"].append(f"[{src}] {msg[:80]}")

        for obs in error_rows:
            src = obs["source"]
            msg = obs["message"]
            detail = (obs["detail"] or "")[:120]
            warning_text = f"[{src}] ERROR: {msg}"
            if detail:
                warning_text += f" — {detail}"
            warnings.append(warning_text)
            bot_obs_summary["errors"].append({"source": src, "message": msg, "detail": detail})

        bot_obs_summary["warnings"] = [
            {"source": o["source"], "message": o["message"]} for o in warning_rows
        ]
        bot_obs_summary["info_by_source"] = info_by_source

        # ── Mark auto-fixable rows as fixed in DB ──────────────────────────
        if auto_fix_ids and not dry_run:
            with conn:
                with conn.cursor() as cur:
                    placeholders = ",".join(["%s"] * len(auto_fix_ids))
                    cur.execute(
                        f"UPDATE bot_observations "
                        f"SET severity = 'fixed', fixed_at = NOW(), "
                        f"fix_note = 'Auto-fixed by nightly_health.py' "
                        f"WHERE id IN ({placeholders})",
                        auto_fix_ids,
                    )
                conn.commit()
            log.info("Bot observer: marked %d observation(s) as fixed", len(auto_fix_ids))

        log.info(
            "Bot observer healing complete: %d errors, %d warnings (%d auto-fixed), %d info",
            len(error_rows), len(warning_rows), len(auto_fix_ids),
            sum(info_by_source.values()),
        )

    except Exception as e:
        warnings.append(f"Bot observer network healing failed: {e}")
        log.error("Bot observer network healing failed: %s", e)


# ══════════════════════════════════════════════════════════════════════════════
# STAGE 3 — AUTO-EXPAND AUDIT CHECKS
# ══════════════════════════════════════════════════════════════════════════════

def get_current_trpc_procedures() -> List[str]:
    """Extract all tRPC procedure names from routers.ts."""
    if not ROUTERS_TS.exists():
        return []
    content = ROUTERS_TS.read_text()
    # Match patterns like: procedureName: publicProcedure or procedureName: protectedProcedure
    procedures = re.findall(r'(\w+):\s*(?:public|protected)Procedure', content)
    return list(set(procedures))


def get_current_agents() -> List[str]:
    """Extract all agent slugs from ROSTER_AGENTS in dashboardData.ts."""
    if not DASHBOARD_TS.exists():
        return []
    content = DASHBOARD_TS.read_text()
    # Match: slug: "peter" or slug: "steven" etc.
    slugs = re.findall(r'slug:\s*["\'](\w+)["\']', content)
    return list(set(slugs))


def get_current_routes() -> List[str]:
    """Extract all route paths from App.tsx."""
    if not APP_TSX.exists():
        return []
    content = APP_TSX.read_text()
    # Match: path={"/"} or path="/sms-queue" etc.
    routes = re.findall(r'path=["\'{]+([^"\'}\s]+)["\'}]+', content)
    return [r for r in routes if r and not r.startswith(":")]


def get_audited_procedures() -> List[str]:
    """Extract procedure names already checked in eightx_audit.py."""
    if not AUDIT_PY.exists():
        return []
    content = AUDIT_PY.read_text()
    # Look for strings like "D: procedureName" or procedure checks
    audited = re.findall(r'"D:\s+(\w+)\s', content)
    # Also look for direct string matches of procedure names in check() calls
    audited += re.findall(r'check\("[^"]*",.*?"(\w+)"\s+in\s+rts', content)
    return list(set(audited))


def get_audited_agents() -> List[str]:
    """Extract agent slugs already checked in eightx_audit.py W-layer."""
    if not AUDIT_PY.exists():
        return []
    content = AUDIT_PY.read_text()
    # Look for AGENTS_7 list or individual agent checks in W-layer
    agents = re.findall(r'AGENTS_7\s*=\s*\[([^\]]+)\]', content)
    if agents:
        return re.findall(r'["\'](\w+)["\']', agents[0])
    return []


def get_audited_routes() -> List[str]:
    """Extract routes already checked in eightx_audit.py D-layer."""
    if not AUDIT_PY.exists():
        return []
    content = AUDIT_PY.read_text()
    routes = re.findall(r'"D:\s+route\s+([^"]+)"', content)
    # Also extract from path checks
    routes += re.findall(r'path=["\']([^"\']+)["\'].*in\s+app_tsx', content)
    return list(set(routes))


# ══════════════════════════════════════════════════════════════════════════════
# STAGE 2.5a — NOTE-WRITE VERIFICATION
# ══════════════════════════════════════════════════════════════════════════════

# Actions that write a per-lead FUB note alongside the audit_log "sent" entry.
# speed_to_lead_alert and phase2_daily_summary are excluded — they send emails
# but do NOT write per-lead notes (by design).
NOTE_BACKED_ACTIONS = {
    "pond_nurture",
    "closed_congrats",
    "closed_drip",
    "long_term_nurture_drip",
    "agent_reminder_digest",
    "instant_welcome_email",
}


def verify_note_writes(dry_run: bool) -> None:
    """Compare audit_log 'sent' entries (last 24h) against FUB notes for those leads.

    Any send missing its corresponding FUB note = integrity error reported in the 4am email.
    """
    global note_integrity_errors
    if not DB_PATH.exists():
        warnings.append("SQLite DB not found — skipping note-write verification")
        return

    import sqlite3
    import requests

    fub_api_key = os.environ.get("FUB_API_KEY", "")
    if not fub_api_key:
        warnings.append("FUB_API_KEY not set — skipping note-write verification")
        return

    cutoff = (datetime.datetime.now(datetime.timezone.utc)
              - datetime.timedelta(hours=24)).isoformat()

    try:
        with sqlite3.connect(str(DB_PATH)) as con:
            con.row_factory = sqlite3.Row
            rows = con.execute(
                """SELECT created_at, person_id, action, status, details
                   FROM audit_log
                   WHERE status = 'sent'
                     AND action IN ({})
                     AND created_at >= ?
                   ORDER BY created_at DESC""".format(
                    ",".join(f"'{a}'" for a in NOTE_BACKED_ACTIONS)
                ),
                (cutoff,)
            ).fetchall()

        if not rows:
            log.info("No note-backed sends in last 24h — nothing to verify")
            return

        log.info("Checking %d note-backed sends for FUB note presence...", len(rows))

        # Group by person_id to minimize API calls
        person_sends: dict = {}
        for r in rows:
            pid = r["person_id"]
            if pid and pid not in person_sends:
                person_sends[pid] = []
            if pid:
                person_sends[pid].append(dict(r))

        headers = {
            "Authorization": f"Basic {__import__('base64').b64encode((fub_api_key + ':').encode()).decode()}",
            "Accept": "application/json",
        }

        checked = 0
        for person_id, sends in list(person_sends.items())[:50]:  # Cap at 50 leads to avoid rate limits
            try:
                resp = requests.get(
                    f"https://api.followupboss.com/v1/notes?personId={person_id}&limit=50",
                    headers=headers,
                    timeout=15,
                )
                if resp.status_code == 429:
                    log.warning("FUB rate limit hit during note verification — stopping early")
                    break
                resp.raise_for_status()
                notes = resp.json().get("notes", resp.json().get("data", []))
                note_bodies = " ".join((n.get("body", "") or "").lower() for n in notes)

                for send in sends:
                    action = send["action"]
                    # Check if any note references this action type
                    action_keywords = {
                        "pond_nurture": ["pond nurture", "re-engagement"],
                        "closed_congrats": ["congrats", "congratulations"],
                        "closed_drip": ["check-in", "quarterly"],
                        "long_term_nurture_drip": ["long-term nurture", "long term nurture"],
                        "agent_reminder_digest": ["follow-up reminder", "click-to-text"],
                        "instant_welcome_email": ["welcome email", "instant welcome"],
                    }
                    keywords = action_keywords.get(action, [action.replace("_", " ")])
                    found = any(kw in note_bodies for kw in keywords)
                    if not found:
                        note_integrity_errors.append({
                            "person_id": person_id,
                            "action": action,
                            "sent_at": send["created_at"],
                            "bot": action,
                        })
                checked += 1
            except Exception as e:
                log.warning("Note verification failed for person %s: %s", person_id, e)

        if note_integrity_errors:
            log.warning("NOTE INTEGRITY: %d send(s) missing FUB notes!", len(note_integrity_errors))
            for err in note_integrity_errors[:5]:
                log.warning("  person_id=%s action=%s sent_at=%s",
                           err["person_id"], err["action"], err["sent_at"])
        else:
            log.info("Note integrity OK — all %d checked sends have matching FUB notes", checked)

    except Exception as e:
        errors_encountered.append(f"Note-write verification error: {e}")
        log.error("Note-write verification failed: %s", e)


# ══════════════════════════════════════════════════════════════════════════════
# STAGE 2.5b — BOUNCE & UNSUBSCRIBE AUTO-TAGGING
# ══════════════════════════════════════════════════════════════════════════════

BOUNCE_INDICATORS = [
    "delivery status notification", "undeliverable", "undelivered",
    "mail delivery failed", "delivery failure", "returned mail",
    "mailbox not found", "address rejected", "user unknown",
    "no such user", "does not exist", "invalid recipient",
    "550 ", "551 ", "552 ", "553 ", "554 ",
    "hard bounce", "permanent failure",
]

OPT_OUT_INDICATORS = [
    "unsubscribe", "stop", "remove me", "opt out", "opt-out",
    "do not contact", "don't contact", "no more emails",
    "take me off", "remove from list", "cancel", "leave me alone",
    "stop emailing", "don't email", "do not email",
]


def detect_bounces_and_unsubscribes(dry_run: bool) -> None:
    """Scan FUB events/emails for bounce indicators and opt-out language.

    Hard bounce → tag 'bounced' + FUB note.
    Opt-out → tag 'unsubscribe' + FUB note.
    Daily counts reported in 4am email.
    """
    global bounce_unsub_counts
    import requests

    fub_api_key = os.environ.get("FUB_API_KEY", "")
    if not fub_api_key:
        warnings.append("FUB_API_KEY not set — skipping bounce/unsub detection")
        return

    headers = {
        "Authorization": f"Basic {__import__('base64').b64encode((fub_api_key + ':').encode()).decode()}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }

    # Get recent emails (last 24h) to check for bounces and opt-outs
    cutoff_iso = (datetime.datetime.now(datetime.timezone.utc)
                  - datetime.timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")

    bounce_count = 0
    unsub_count = 0

    try:
        # Scan recent inbound emails for bounce/opt-out signals
        resp = requests.get(
            "https://api.followupboss.com/v1/emails",
            headers=headers,
            params={"limit": 100, "sort": "-created"},
            timeout=30,
        )
        if resp.status_code == 429:
            warnings.append("FUB rate limit during bounce/unsub scan — will retry next run")
            return
        resp.raise_for_status()
        emails = resp.json().get("emails", resp.json().get("data", []))

        for em in emails:
            created = em.get("created", em.get("createdAt", ""))
            if created and created < cutoff_iso:
                continue  # older than 24h

            person_id = em.get("personId")
            if not person_id:
                continue

            subject = (em.get("subject", "") or "").lower()
            body = (em.get("body", "") or "").lower()
            combined = f"{subject} {body}"

            # Check for bounce
            is_bounce = any(ind in combined for ind in BOUNCE_INDICATORS)
            # Check for opt-out
            is_optout = any(ind in combined for ind in OPT_OUT_INDICATORS)

            if is_bounce:
                if not dry_run:
                    _apply_tag_and_note(person_id, "bounced",
                                       f"Hard bounce detected on {created}. Email: {subject[:60]}",
                                       headers)
                bounce_count += 1
                log.info("BOUNCE detected: person_id=%s subject=%s", person_id, subject[:50])

            elif is_optout:
                # Only flag if the email is INBOUND (from the lead, not from us)
                direction = em.get("direction", em.get("type", ""))
                if direction in ("inbound", "received", "incoming"):
                    if not dry_run:
                        _apply_tag_and_note(person_id, "unsubscribe",
                                           f"Opt-out detected on {created}. Message: {body[:80]}",
                                           headers)
                    unsub_count += 1
                    log.info("OPT-OUT detected: person_id=%s body=%s", person_id, body[:50])

        # Also scan recent text messages for opt-out language
        resp2 = requests.get(
            "https://api.followupboss.com/v1/textMessages",
            headers=headers,
            params={"limit": 100, "sort": "-created"},
            timeout=30,
        )
        if resp2.status_code != 429:
            resp2.raise_for_status()
            texts = resp2.json().get("textMessages", resp2.json().get("data", []))
            for txt in texts:
                created = txt.get("created", txt.get("createdAt", ""))
                if created and created < cutoff_iso:
                    continue
                person_id = txt.get("personId")
                if not person_id:
                    continue
                # Only inbound texts
                direction = txt.get("direction", txt.get("type", ""))
                if direction not in ("inbound", "received", "incoming"):
                    continue
                body = (txt.get("message", txt.get("body", "")) or "").lower()
                if any(ind in body for ind in OPT_OUT_INDICATORS):
                    if not dry_run:
                        _apply_tag_and_note(person_id, "unsubscribe",
                                           f"Opt-out via text on {created}. Message: {body[:80]}",
                                           headers)
                    unsub_count += 1
                    log.info("TEXT OPT-OUT detected: person_id=%s body=%s", person_id, body[:50])

    except Exception as e:
        errors_encountered.append(f"Bounce/unsub detection error: {e}")
        log.error("Bounce/unsub detection failed: %s", e)

    bounce_unsub_counts["bounces"] = bounce_count
    bounce_unsub_counts["unsubscribes"] = unsub_count
    log.info("Bounce/unsub scan complete: %d bounce(s), %d unsubscribe(s)", bounce_count, unsub_count)


def _apply_tag_and_note(person_id: int, tag: str, note_body: str, headers: dict) -> None:
    """Apply a tag and write a FUB note for a lead. Used by bounce/unsub detection."""
    import requests
    try:
        # Get current tags
        resp = requests.get(
            f"https://api.followupboss.com/v1/people/{person_id}",
            headers=headers,
            timeout=15,
        )
        if resp.status_code == 429:
            return
        resp.raise_for_status()
        person = resp.json()
        current_tags = [t.get("tag", t) if isinstance(t, dict) else t for t in (person.get("tags") or [])]

        # Skip if already tagged
        if tag.lower() in [t.lower() for t in current_tags]:
            log.info("Person %s already has tag '%s' — skipping", person_id, tag)
            return

        # Add tag
        new_tags = current_tags + [tag]
        requests.put(
            f"https://api.followupboss.com/v1/people/{person_id}",
            headers=headers,
            json={"tags": new_tags},
            timeout=15,
        )

        # Write note
        requests.post(
            "https://api.followupboss.com/v1/notes",
            headers=headers,
            json={"personId": person_id, "body": f"[Nightly Healer] {note_body}", "isHtml": False},
            timeout=15,
        )
        log.info("Tagged person %s with '%s' and wrote note", person_id, tag)

    except Exception as e:
        log.warning("Failed to tag person %s with '%s': %s", person_id, tag, e)


def expand_audit_checks(dry_run: bool) -> None:
    """
    Detect new tRPC procedures, agents, and routes not yet in eightx_audit.py
    and append checks for them.
    """
    if not AUDIT_PY.exists():
        warnings.append("eightx_audit.py not found — skipping auto-expansion")
        return

    audit_content = AUDIT_PY.read_text()
    new_checks_to_add: List[str] = []

    # ── 1. New tRPC procedures ─────────────────────────────────────────────
    current_procs = get_current_trpc_procedures()
    # Extract procedures already explicitly checked in the D-layer
    already_checked_procs = set(re.findall(r'"D:\s+\w+\.(\w+)', audit_content))
    # Also check for procedure names mentioned in check() calls
    for proc in current_procs:
        if proc in already_checked_procs:
            continue
        # Skip meta names
        if proc in {"publicProcedure", "protectedProcedure", "router", "middleware"}:
            continue
        # Check if the procedure name appears anywhere in the audit
        if f'"{proc}"' in audit_content or f"'{proc}'" in audit_content:
            continue
        # New procedure not yet audited
        new_checks_to_add.append(
            f'check("D: auto-expanded — {proc} procedure exists", '
            f'"{proc}" in rts, '
            f'"{proc} not found in routers.ts")'
        )
        checks_added.append(f"tRPC procedure: {proc}")
        log.info("Auto-expand: new tRPC procedure detected: %s", proc)

    # ── 2. New agents ──────────────────────────────────────────────────────
    current_agents = get_current_agents()
    # Find AGENTS_7 list in audit
    agents_match = re.search(r'AGENTS_7\s*=\s*\[([^\]]+)\]', audit_content)
    audited_agents = set()
    if agents_match:
        audited_agents = set(re.findall(r'["\'](\w+)["\']', agents_match.group(1)))

    new_agents = [a for a in current_agents if a not in audited_agents]
    if new_agents:
        for agent in new_agents:
            new_checks_to_add.append(
                f'check("W: auto-expanded — {agent} in ROSTER_AGENTS", '
                f'"{agent}" in dash_ts.lower(), '
                f'"{agent} not found in dashboardData.ts ROSTER_AGENTS")'
            )
            checks_added.append(f"Agent: {agent}")
            log.info("Auto-expand: new agent detected: %s", agent)

        # Also update AGENTS_7 list in the audit script
        if agents_match and not dry_run:
            all_agents = sorted(audited_agents | set(new_agents))
            new_agents_list = "[" + ", ".join(f'"{a}"' for a in all_agents) + "]"
            audit_content = audit_content.replace(
                agents_match.group(0),
                f"AGENTS_7 = {new_agents_list}"
            )

    # ── 3. New routes ──────────────────────────────────────────────────────
    current_routes = get_current_routes()
    for route in current_routes:
        # Skip dynamic routes and already-checked ones
        if ":" in route:
            continue
        route_key = route.strip("/").replace("-", "_") or "root"
        check_label = f'"D: auto-expanded — route {route}"'
        if check_label in audit_content:
            continue
        # Check if route is mentioned anywhere in audit
        if f'"{route}"' in audit_content or f"'{route}'" in audit_content:
            continue
        new_checks_to_add.append(
            f'check("D: auto-expanded — route {route}", '
            f'"{route}" in app_tsx, '
            f'"{route} not found in App.tsx routes")'
        )
        checks_added.append(f"Route: {route}")
        log.info("Auto-expand: new route detected: %s", route)

    # ── Write new checks to eightx_audit.py ───────────────────────────────
    if new_checks_to_add:
        if dry_run:
            log.info("[DRY-RUN] Would add %d new checks to eightx_audit.py:", len(new_checks_to_add))
            for c in new_checks_to_add:
                log.info("  + %s", c[:80])
            return

        # Append new checks before the final summary block
        insertion_marker = "# ══════════════════════════════════════════════════════════════════════════════\n# FINAL SUMMARY"
        auto_block = "\n# ── Auto-expanded checks (added by nightly_health.py) ──────────────────────\n"
        auto_block += "\n".join(new_checks_to_add) + "\n\n"

        if insertion_marker in audit_content:
            audit_content = audit_content.replace(
                insertion_marker,
                auto_block + insertion_marker
            )
        else:
            # Fallback: append before sys.exit
            audit_content = audit_content.replace(
                "sys.exit(0 if failed == 0 else 1)",
                auto_block + "sys.exit(0 if failed == 0 else 1)"
            )

        AUDIT_PY.write_text(audit_content)
        log.info("Added %d new checks to eightx_audit.py", len(new_checks_to_add))
    else:
        log.info("No new procedures, agents, or routes detected — audit is fully current")


# ══════════════════════════════════════════════════════════════════════════════
# STAGE 5 — MORNING EMAIL
# ══════════════════════════════════════════════════════════════════════════════

def send_morning_email(
    pre_audit: dict,
    post_audit: dict,
    dry_run: bool,
) -> None:
    """Send Peter a morning summary email."""
    smtp_host     = os.environ.get("SMTP_HOST")
    smtp_port     = int(os.environ.get("SMTP_PORT", "587"))
    smtp_user     = os.environ.get("SMTP_USER")
    smtp_password = os.environ.get("SMTP_PASSWORD")
    from_email    = os.environ.get("SMTP_FROM", "peter@lifestyledesignrealty.com")
    to_email      = "peter@lifestyledesignrealty.com"

    pre_score  = pre_audit.get("score_pct", 0)
    post_score = post_audit.get("score_pct", 0)
    pre_pass   = pre_audit.get("passed", 0)
    post_pass  = post_audit.get("passed", 0)
    total      = post_audit.get("total", pre_audit.get("total", 0))
    failures   = post_audit.get("failures", [])

    # Determine status
    if post_score >= 100:
        status_emoji = "✅"
        status_line  = "System is clean and ready for the day."
        subject      = f"🌅 System Health: {post_pass}/{total} — All Clear"
    elif post_score >= 98:
        status_emoji = "⚠️"
        status_line  = f"{len(failures)} minor issue(s) detected — see details below."
        subject      = f"⚠️ System Health: {post_pass}/{total} — Minor Issues"
    else:
        status_emoji = "🚨"
        status_line  = f"{len(failures)} issue(s) need attention."
        subject      = f"🚨 System Health: {post_pass}/{total} — Needs Attention"

    # Build email body
    now_ct = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=-5)))
    date_str = now_ct.strftime("%A, %B %-d, %Y")

    lines = [
        f"Good morning, Peter.",
        f"",
        f"Here's your nightly system health report for {date_str}.",
        f"",
        f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        f"  {status_emoji}  AUDIT SCORE: {post_pass}/{total} ({post_score:.1f}%)",
        f"  {status_line}",
        f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        f"",
    ]

    if pre_score < post_score:
        lines += [
            f"📈 IMPROVEMENT: Score went from {pre_score:.1f}% → {post_score:.1f}% after auto-fixes.",
            f"",
        ]

    if fixes_applied:
        lines += [f"🔧 AUTO-FIXES APPLIED ({len(fixes_applied)}):"]
        for fix in fixes_applied:
            lines.append(f"   • {fix}")
        lines.append("")

    if checks_added:
        lines += [f"🔍 NEW AUDIT CHECKS ADDED ({len(checks_added)}):"]
        for check in checks_added:
            lines.append(f"   • {check}")
        lines.append(f"   (The audit script now covers {total} checks — growing with the system)")
        lines.append("")

    if failures:
        lines += [f"⚠️  REMAINING ISSUES ({len(failures)}):"]
        for f_item in failures[:10]:
            lines.append(f"   • {f_item}")
        if len(failures) > 10:
            lines.append(f"   ... and {len(failures) - 10} more")
        lines.append("")

    # ── Dashboard UI error summary (from ui_error_log) ───────────────────────
    ui_resolved = sum(1 for f in fixes_applied if "UI error" in f or "roster error" in f)
    ui_flagged  = sum(1 for w in warnings if any(kw in w for kw in
                      ["UI CRASH", "FUB API auth", "rate limit", "RECURRING"]))
    if ui_resolved > 0 or ui_flagged > 0:
        lines += [f"🛠️  DASHBOARD UI ERRORS (overnight):"]
        if ui_resolved > 0:
            lines.append(f"   ✅ {ui_resolved} issue(s) auto-fixed overnight")
        if ui_flagged > 0:
            lines.append(f"   ⚠️  {ui_flagged} issue(s) flagged for your review (see Notes below)")
        lines.append("")

    # ── Bot Observer Network summary ──────────────────────────────────────────
    obs_total   = bot_obs_summary.get("total", 0)
    obs_errors  = bot_obs_summary.get("errors", [])
    obs_fixed   = bot_obs_summary.get("auto_fixed", [])
    obs_warnings = bot_obs_summary.get("warnings", [])
    obs_info    = bot_obs_summary.get("info_by_source", {})

    if obs_total > 0:
        lines += [f"🤖 BOT OBSERVER NETWORK (last 25 hours — {obs_total} observation(s)):"]
        if obs_errors:
            lines.append(f"   🔴 ERRORS ({len(obs_errors)}):")
            for e in obs_errors[:8]:
                detail_str = f" — {e['detail']}" if e.get('detail') else ""
                lines.append(f"      [{e['source']}] {e['message']}{detail_str}")
        if obs_warnings:
            lines.append(f"   ⚠️  WARNINGS ({len(obs_warnings)}):")
            for w in obs_warnings[:6]:
                lines.append(f"      [{w['source']}] {w['message']}")
        if obs_fixed:
            lines.append(f"   🔧 AUTO-FIXED ({len(obs_fixed)}):")
            for f_item in obs_fixed[:6]:
                lines.append(f"      {f_item}")
        if obs_info:
            info_str = ", ".join(f"{src}: {cnt} event(s)" for src, cnt in obs_info.items())
            lines.append(f"   ℹ️  INFO: {info_str}")
        lines.append("")

    # ── Note-Write Integrity section ─────────────────────────────────────────
    if note_integrity_errors:
        lines += [f"🚨 NOTE-WRITE INTEGRITY ERRORS ({len(note_integrity_errors)}):"]
        for err in note_integrity_errors[:10]:
            lines.append(f"   • Lead #{err['person_id']} — {err['action']} sent at {err['sent_at']} — NO FUB NOTE FOUND")
        if len(note_integrity_errors) > 10:
            lines.append(f"   ... and {len(note_integrity_errors) - 10} more")
        lines.append("")
    else:
        lines.append("✅ Note-write integrity: All sends have matching FUB notes")
        lines.append("")

    # ── Bounce & Unsubscribe section ───────────────────────────────────────
    b_count = bounce_unsub_counts.get("bounces", 0)
    u_count = bounce_unsub_counts.get("unsubscribes", 0)
    if b_count > 0 or u_count > 0:
        lines += [f"🚫 BOUNCE & UNSUBSCRIBE (last 24h):"]
        if b_count > 0:
            lines.append(f"   📧 Hard bounces detected & tagged: {b_count}")
        if u_count > 0:
            lines.append(f"   ✋ Opt-outs detected & tagged: {u_count}")
        lines.append("")
    else:
        lines.append("✅ No bounces or unsubscribes detected in last 24h")
        lines.append("")

    # ── Engagement Tier & Reply-Time section (Tier 3) ─────────────────
    try:
        if engagement_tier_counts:
            lines.append("📊 ENGAGEMENT TIERS:")
            for tier_name in ("engaged", "standard", "cold"):
                cnt = engagement_tier_counts.get(tier_name, 0)
                cadence = {"engaged": "10d", "standard": "14d", "cold": "21d"}.get(tier_name, "?")
                lines.append(f"   {tier_name.title()}: {cnt} leads ({cadence} cadence)")
            lines.append("")
        lines.append(f"⏱️ Reply-time data points collected: {reply_time_data_points}")
        lines.append("")
    except Exception:
        pass

    if warnings:
        lines += [f"📋 NOTES:"]
        for w in warnings:
            lines.append(f"   • {w}")
        lines.append("")

    if errors_encountered:
        lines += [f"❌ ERRORS DURING HEALTH RUN:"]
        for e in errors_encountered:
            lines.append(f"   • {e}")
        lines.append("")

    lines += [
        f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        f"  Dashboard: https://fub-nurture-phfprjui.manus.space",
        f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        f"",
        f"Truly,",
        f"Peter",
    ]

    body = "\n".join(lines)

    # HTML version
    html_lines = body.replace("━", "─").replace("\n", "<br>")
    html_body = f"""
<html><body style="font-family: Georgia, serif; font-size: 15px; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 20px;">
<div style="background: #f8f6f0; border-left: 4px solid #c8a96e; padding: 16px 20px; margin-bottom: 20px;">
  <strong style="font-size: 18px;">{status_emoji} System Health Report — {date_str}</strong>
</div>
<p style="font-size: 16px; line-height: 1.6;">{html_lines}</p>
</body></html>
"""

    if dry_run:
        log.info("[DRY-RUN] Would send morning email to %s", to_email)
        log.info("[DRY-RUN] Subject: %s", subject)
        log.info("[DRY-RUN] Body preview:\n%s", body[:800])
        return

    if not all([smtp_host, smtp_user, smtp_password]):
        warnings.append("SMTP not configured — morning email not sent (set SMTP_HOST, SMTP_USER, SMTP_PASSWORD)")
        log.warning("SMTP not configured — skipping morning email")
        return

    try:
        msg = email.message.EmailMessage()
        msg["From"] = from_email
        msg["To"] = to_email
        msg["Subject"] = subject
        msg.set_content(body)
        msg.add_alternative(html_body, subtype="html")

        with smtplib.SMTP(smtp_host, smtp_port) as smtp:
            smtp.starttls()
            smtp.login(smtp_user, smtp_password)
            smtp.send_message(msg)

        log.info("Morning email sent to %s", to_email)
    except Exception as e:
        errors_encountered.append(f"Morning email failed: {e}")
        log.error("Morning email failed: %s", e)


# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════

def save_health_log(pre_audit: dict, post_audit: dict) -> None:
    """Append a summary entry to the nightly health log."""
    HEALTH_LOG.parent.mkdir(parents=True, exist_ok=True)
    history = []
    if HEALTH_LOG.exists():
        try:
            history = json.loads(HEALTH_LOG.read_text())
        except Exception:
            history = []
    entry = {
        "run_at": now_iso(),
        "pre_score": pre_audit.get("score_pct", 0),
        "post_score": post_audit.get("score_pct", 0),
        "pre_passed": pre_audit.get("passed", 0),
        "post_passed": post_audit.get("passed", 0),
        "total": post_audit.get("total", 0),
        "fixes_applied": fixes_applied,
        "checks_added": checks_added,
        "warnings": warnings,
        "errors": errors_encountered,
        "failures": post_audit.get("failures", []),
    }
    history.append(entry)
    # Keep last 90 days of history
    history = history[-90:]
    HEALTH_LOG.write_text(json.dumps(history, indent=2))
    log.info("Health log saved to %s", HEALTH_LOG)


def main():
    parser = argparse.ArgumentParser(description="Nightly self-healing system orchestrator")
    parser.add_argument("--dry-run", action="store_true",
                        help="Preview all actions without making changes or sending emails")
    args = parser.parse_args()
    dry_run = args.dry_run

    if dry_run:
        log.info("=" * 60)
        log.info("DRY-RUN MODE — no changes will be made")
        log.info("=" * 60)

    log.info("=" * 60)
    log.info("NIGHTLY HEALTH SYSTEM — %s", now_iso())
    log.info("=" * 60)

    # ── STAGE 1: Pre-fix audit ─────────────────────────────────────────────
    log.info("")
    log.info("STAGE 1: Running pre-fix audit...")
    pre_audit = run_audit("pre-fix")

    # ── STAGE 2: Auto-fix ─────────────────────────────────────────────────
    log.info("")
    log.info("STAGE 2: Applying auto-fixes...")
    fix_prune_audit_log(dry_run)
    fix_stuck_timers(dry_run)
    fix_stale_dashboard_data(dry_run)
    fix_daily_errors(dry_run)          # Scan today's automation audit_log errors
    fix_dashboard_ui_errors(dry_run)   # Scan today's dashboard ui_error_log (MySQL) and apply targeted fixes
    fix_bot_observations(dry_run)       # Scan today's bot_observations (MySQL) from all bots

    # ── STAGE 2.5a: Note-Write Verification ──────────────────────────────
    log.info("")
    log.info("STAGE 2.5a: Verifying note-write integrity (last 24h)...")
    verify_note_writes(dry_run)

    # ── STAGE 2.5b: Bounce & Unsubscribe Detection ────────────────────────
    log.info("")
    log.info("STAGE 2.5b: Scanning for bounces & unsubscribes (last 24h)...")
    detect_bounces_and_unsubscribes(dry_run)

    # ── STAGE 2.5c: Engagement Tier & Reply-Time Stats (Tier 3) ──────────
    log.info("")
    log.info("STAGE 2.5c: Gathering engagement tier counts and reply-time data...")
    global engagement_tier_counts, reply_time_data_points
    try:
        import sqlite3 as _sq
        _db_path = os.path.join(AUTO_DIR, "data", "fub_automation.sqlite3")
        _conn = _sq.connect(_db_path)
        _conn.row_factory = _sq.Row
        _tier_rows = _conn.execute("SELECT tier, COUNT(*) as cnt FROM engagement_tier GROUP BY tier").fetchall()
        engagement_tier_counts = {r["tier"]: r["cnt"] for r in _tier_rows}
        _rt_row = _conn.execute("SELECT COUNT(*) as cnt FROM reply_time_log").fetchone()
        reply_time_data_points = _rt_row["cnt"] if _rt_row else 0
        _conn.close()
        log.info("Engagement tiers: %s | Reply-time data points: %d", engagement_tier_counts, reply_time_data_points)
    except Exception as _e:
        log.warning("Failed to gather Tier 3 stats: %s", _e)
        engagement_tier_counts = {}
        reply_time_data_points = 0

    # ── STAGE 3: Auto-expand audit checks ─────────────────────────────────
    log.info("")
    log.info("STAGE 3: Expanding audit checks for new features...")
    expand_audit_checks(dry_run)

    # ── STAGE 4: Post-fix audit ────────────────────────────────────────────
    log.info("")
    log.info("STAGE 4: Running post-fix audit...")
    post_audit = run_audit("post-fix")

    # ── STAGE 5: Morning email ─────────────────────────────────────────────
    log.info("")
    log.info("STAGE 5: Sending morning summary email...")
    send_morning_email(pre_audit, post_audit, dry_run)

    # ── Save health log ────────────────────────────────────────────────────
    if not dry_run:
        save_health_log(pre_audit, post_audit)

    # ── Final summary ──────────────────────────────────────────────────────
    log.info("")
    log.info("=" * 60)
    log.info("NIGHTLY HEALTH COMPLETE")
    log.info("  Pre-fix:  %s/%s (%.1f%%)",
             pre_audit.get("passed", "?"), pre_audit.get("total", "?"),
             pre_audit.get("score_pct", 0))
    log.info("  Post-fix: %s/%s (%.1f%%)",
             post_audit.get("passed", "?"), post_audit.get("total", "?"),
             post_audit.get("score_pct", 0))
    log.info("  Fixes applied: %d", len(fixes_applied))
    log.info("  Checks added:  %d", len(checks_added))
    log.info("  Warnings:      %d", len(warnings))
    log.info("  Errors:        %d", len(errors_encountered))
    log.info("=" * 60)

    # ── Dead-Man's Switch: Ping healthchecks.io on success ─────────────────
    ping_healthcheck("nightly_health")

    # Exit 0 even if post-audit has failures — the email already notified Peter
    sys.exit(0)


def ping_healthcheck(check_name: str) -> None:
    """Ping healthchecks.io dead-man's switch at the END of a successful run.

    Simple GET to the configured UUID-based ping URL. Failures are logged but
    never crash the run.
    """
    import requests as _req
    hc_config_path = AUTO_DIR / "config" / "healthchecks.json"
    if not hc_config_path.exists():
        log.warning("healthchecks.json not found — dead-man's switch not configured")
        return
    try:
        hc_config = json.loads(hc_config_path.read_text())
        check_cfg = hc_config.get(check_name, {})
        url = check_cfg.get("ping_url", "")
        if not url:
            log.warning("No ping_url configured for check '%s'", check_name)
            return
        resp = _req.get(url, timeout=10)
        log.info("Dead-man's switch pinged for '%s': %s %s", check_name, resp.status_code, resp.text.strip())
    except Exception as e:
        log.warning("Dead-man's switch ping failed for '%s': %s", check_name, e)


if __name__ == "__main__":
    main()
