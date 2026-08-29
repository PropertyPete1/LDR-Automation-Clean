"""Follow Up Boss automation service.

This package is a production-ready starter scaffold for the requested FUB workflows:
- stale / pond / unresponsive lead re-engagement every 14 days;
- assigned-agent no-follow-up reminders after 14 days;
- new-lead 30-minute warning and 60-minute reassignment to Peter Allen;
- OpenAI-generated city market update email drafts;
- compliance gates, audit logging, and FUB notes/tasks/tags.

It intentionally does not hard-code credentials or account-specific stage/tag names.
Configure those in environment variables and config/rules.yaml.
"""

from __future__ import annotations

import base64
import datetime as dt
from datetime import timezone
import email.message
import hashlib
import hmac
import html
import json
import logging
import os
import re
import smtplib
import sqlite3
import textwrap
import time
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Tuple
from zoneinfo import ZoneInfo

import requests
import yaml
from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Request
from anthropic import Anthropic
from pydantic import BaseModel

from .seller_nurture import (
    SELLER_BOUNCE_ROTATION_ACTION,
    SELLER_LEAD_TAG,
    SELLER_MONTHLY_CADENCE_DAYS,
    SELLER_NURTURE_AUDIT_ACTION,
    SELLER_REPLIED_TAG,
    SELLER_SEQUENCE_LENGTH,
    SELLER_SEQUENCE_SCHEDULE,
    SELLER_SUPPRESS_TAGS,
    build_seller_email_html,
    build_seller_email_plaintext,
    extract_property_address_from_notes,
    format_rotation_fub_note,
    generate_seller_email,
    get_all_lead_emails,
    longtail_angle_for,
    ramp_daily_cap,
    select_send_address,
)

LOGGER = logging.getLogger("fub_automation")
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

UTC = dt.timezone.utc


@dataclass
class Settings:
    fub_api_key: str
    fub_system_name: Optional[str]
    fub_system_key: Optional[str]
    openai_model: str
    database_path: str
    rules_path: str
    base_url: str
    dry_run: bool
    smtp_host: Optional[str]
    smtp_port: int
    smtp_user: Optional[str]
    smtp_password: Optional[str]
    email_from: Optional[str]
    twilio_account_sid: Optional[str]
    twilio_auth_token: Optional[str]
    twilio_from_number: Optional[str]

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            fub_api_key=os.environ.get("FUB_API_KEY", ""),
            fub_system_name=os.environ.get("FUB_SYSTEM_NAME"),
            fub_system_key=os.environ.get("FUB_SYSTEM_KEY"),
            openai_model=os.environ.get("LLM_MODEL") or os.environ.get("OPENAI_MODEL", "claude-haiku-4-5-20251001"),
            database_path=os.environ.get("DATABASE_PATH", "data/fub_automation.sqlite3"),
            rules_path=os.environ.get("RULES_PATH", "config/rules.yaml"),
            base_url=os.environ.get("BASE_URL", "http://localhost:8080"),
            dry_run=os.environ.get("DRY_RUN", "true").lower() in {"1", "true", "yes"},
            smtp_host=os.environ.get("SMTP_HOST"),
            smtp_port=int(os.environ.get("SMTP_PORT", "587")),
            smtp_user=os.environ.get("SMTP_USER"),
            smtp_password=os.environ.get("SMTP_PASSWORD"),
            email_from=os.environ.get("EMAIL_FROM"),
            twilio_account_sid=os.environ.get("TWILIO_ACCOUNT_SID"),
            twilio_auth_token=os.environ.get("TWILIO_AUTH_TOKEN"),
            twilio_from_number=os.environ.get("TWILIO_FROM_NUMBER"),
        )


@dataclass
class Rules:
    stale_stages: List[str]
    stale_tags: List[str]
    unresponsive_tags: List[str]
    excluded_stages: List[str]
    excluded_tags: List[str]
    excluded_sources: List[str]
    sms_consent_tags: List[str]
    email_opt_out_tags: List[str]
    sms_opt_out_tags: List[str]
    target_cities: List[str]
    peter_user_id: Optional[int]
    peter_name: str
    owner_email: str
    team_email: str  # Lead-facing From address (verified alias on peter@ GWS)
    company_name: str
    company_address: str
    default_agent_reminder_cc: Optional[str]
    agent_reminder_emails_enabled: bool
    agent_reminder_broadcast_mode_enabled: bool
    agent_reminder_cc_owner: bool
    agent_reminder_delivery_mode: str
    customer_reengagement_emails_enabled: bool
    agent_followup_days: int
    stale_no_contact_days: int
    reengagement_cadence_days: int
    new_lead_warning_minutes: int
    new_lead_reassign_minutes: int
    new_lead_warning_enabled: bool
    new_lead_reassignment_enabled: bool
    new_lead_timer_mode: str
    business_hours_start: str
    business_hours_end: str
    business_hours_days: List[int]
    local_timezone: str
    email_outreach_enabled: bool
    sms_outreach_enabled: bool
    use_agent_sender_for_assigned_leads: bool
    email_sender_domain: str
    pond_nurture_only: bool
    pond_ids: List[int]
    stale_agent_no_note_reassignment_enabled: bool
    stale_agent_no_note_days: int
    stale_agent_reassign_pond_id: Optional[int]
    customer_nurture_note_city_lookup_enabled: bool
    customer_nurture_log_note_enabled: bool
    phase2_daily_summary_enabled: bool
    phase2_daily_summary_email: str
    phase2_max_customer_emails_per_run: int
    phase2_max_reassignments_per_run: int
    phase2_manual_suppression_tags: List[str]
    stale_reassignment_excluded_stages: List[str]
    excluded_user_ids: List[int]
    # Phase 3 — Closed/Past Client/Sphere quarterly drip
    phase3_closed_drip_enabled: bool
    phase3_cadence_days: int
    phase3_max_emails_per_run: int
    phase3_eligible_stages: List[str]
    phase3_daily_summary_enabled: bool
    # Pond nurture SMS (FUB native SMS alongside the daily pond emails)
    pond_nurture_sms_enabled: bool
    pond_nurture_sms_daily_cap: int
    pond_nurture_sms_from_number: str
    # Long-term nurture reply handler — future-timeline leads moved to Nurture stage + 60-day AI drip
    long_term_nurture_enabled: bool
    long_term_nurture_cadence_days: int
    long_term_nurture_max_emails_per_run: int
    long_term_nurture_stage: str
    long_term_nurture_suppression_tag: str
    # Email address update scanner — detects "I changed my email" replies and updates FUB automatically
    email_address_update_scan_enabled: bool
    # Seller nurture volume ramp + long-tail cadence (LDR-Seller-Finder volume upgrade)
    seller_daily_cap_ramp: List[int]      # e.g. [25, 25, 50, 50] — advances weekly, holds at last value
    seller_longtail_cadence_days: int     # post-sequence cadence (was monthly/30; now every 3 weeks/21)
    # Assignment safety net — daily untouched-assignment alerts (covers the gap
    # speed-to-lead can't: leads REASSIGNED to an agent long after creation)
    untouched_assignment_alert_enabled: bool
    untouched_assignment_hours: int
    untouched_assignment_realert_hours: int
    untouched_assignment_max_alerts_per_run: int

    @classmethod
    def load(cls, path: str) -> "Rules":
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        # ── Shared Suppression List: merge tags from the single source of truth ──
        suppression_json_path = os.path.join(os.path.dirname(path), "suppression_tags.json")
        shared_suppression_tags: List[str] = []
        if os.path.exists(suppression_json_path):
            try:
                with open(suppression_json_path, "r", encoding="utf-8") as sf:
                    shared_data = json.loads(sf.read())
                    shared_suppression_tags = shared_data.get("tags", [])
                LOGGER.info("Loaded %d shared suppression tags from %s", len(shared_suppression_tags), suppression_json_path)
            except Exception as e:
                LOGGER.warning("Failed to load shared suppression_tags.json: %s", e)
        # Merge shared tags into excluded_tags (deduplicating, case-insensitive)
        yaml_excluded = data.get("excluded_tags", ["do not contact", "past client", "closed"])
        merged_excluded = list({t.lower() for t in yaml_excluded + shared_suppression_tags})
        # Load excluded_sources from the shared suppression JSON
        shared_excluded_sources: List[str] = []
        if os.path.exists(suppression_json_path):
            try:
                with open(suppression_json_path, "r", encoding="utf-8") as sf2:
                    shared_data2 = json.loads(sf2.read())
                    shared_excluded_sources = [s.lower() for s in shared_data2.get("excluded_sources", [])]
                LOGGER.info("Loaded %d excluded sources from %s", len(shared_excluded_sources), suppression_json_path)
            except Exception as e:
                LOGGER.warning("Failed to load excluded_sources from suppression_tags.json: %s", e)
        if not shared_excluded_sources:
            shared_excluded_sources = ["new agent inquiry", "botm newsletter", "zillow rentals", "lease listing inquiry"]
        return cls(
            stale_stages=data.get("stale_stages", ["Stale", "Cold", "Long Term Nurture"]),
            stale_tags=data.get("stale_tags", ["stale", "cold", "long-term"]),
            unresponsive_tags=data.get("unresponsive_tags", ["unresponsive", "no response"]),
            excluded_stages=data.get("excluded_stages", ["Trash", "Closed", "Under Contract"]),
            excluded_tags=merged_excluded,
            excluded_sources=shared_excluded_sources,
            sms_consent_tags=data.get("sms_consent_tags", ["sms opt in", "text consent"]),
            email_opt_out_tags=data.get("email_opt_out_tags", ["email opt out", "unsubscribe"]),
            sms_opt_out_tags=data.get("sms_opt_out_tags", ["sms opt out", "stop texting"]),
            target_cities=data.get("target_cities", []),
            peter_user_id=data.get("peter_user_id"),
            peter_name=data.get("peter_name", "Peter Allen"),
            owner_email=data.get("owner_email", "peter@lifestyledesignrealty.com"),
            team_email=data.get("team_email", "team@lifestyledesignrealty.com"),
            company_name=data.get("company_name", "Lifestyle Design Realty"),
            company_address=data.get("company_address", "Configure company postal address"),
            default_agent_reminder_cc=data.get("default_agent_reminder_cc"),
            agent_reminder_emails_enabled=bool(data.get("agent_reminder_emails_enabled", True)),
            agent_reminder_broadcast_mode_enabled=bool(data.get("agent_reminder_broadcast_mode_enabled", True)),
            agent_reminder_cc_owner=bool(data.get("agent_reminder_cc_owner", True)),
            agent_reminder_delivery_mode=data.get("agent_reminder_delivery_mode", "daily_digest"),
            customer_reengagement_emails_enabled=bool(data.get("customer_reengagement_emails_enabled", False)),
            agent_followup_days=int(data.get("agent_followup_days", 14)),
            stale_no_contact_days=int(data.get("stale_no_contact_days", 30)),
            reengagement_cadence_days=int(data.get("reengagement_cadence_days", 14)),
            new_lead_warning_minutes=int(data.get("new_lead_warning_minutes", 30)),
            new_lead_reassign_minutes=int(data.get("new_lead_reassign_minutes", 60)),
            new_lead_warning_enabled=bool(data.get("new_lead_warning_enabled", True)),
            new_lead_reassignment_enabled=bool(data.get("new_lead_reassignment_enabled", True)),
            new_lead_timer_mode=data.get("new_lead_timer_mode", "business_hours"),
            business_hours_start=data.get("business_hours_start", "10:00"),
            business_hours_end=data.get("business_hours_end", "18:00"),
            business_hours_days=[int(day) for day in data.get("business_hours_days", [0, 1, 2, 3, 4, 5, 6])],
            local_timezone=data.get("local_timezone", "America/Chicago"),
            email_outreach_enabled=bool(data.get("email_outreach_enabled", True)),
            sms_outreach_enabled=bool(data.get("sms_outreach_enabled", False)),
            use_agent_sender_for_assigned_leads=bool(data.get("use_agent_sender_for_assigned_leads", True)),
            email_sender_domain=data.get("email_sender_domain", "lifestyledesignrealty.com"),
            pond_nurture_only=bool(data.get("pond_nurture_only", True)),
            pond_ids=[int(p.get("id")) for p in data.get("ponds", []) if isinstance(p, dict) and p.get("id") is not None],
            stale_agent_no_note_reassignment_enabled=bool(data.get("stale_agent_no_note_reassignment_enabled", False)),
            stale_agent_no_note_days=int(data.get("stale_agent_no_note_days", 20)),
            stale_agent_reassign_pond_id=data.get("stale_agent_reassign_pond_id"),
            customer_nurture_note_city_lookup_enabled=bool(data.get("customer_nurture_note_city_lookup_enabled", True)),
            customer_nurture_log_note_enabled=bool(data.get("customer_nurture_log_note_enabled", False)),
            phase2_daily_summary_enabled=bool(data.get("phase2_daily_summary_enabled", True)),
            phase2_daily_summary_email=data.get("phase2_daily_summary_email") or data.get("owner_email", "peter@lifestyledesignrealty.com"),
            phase2_max_customer_emails_per_run=int(data.get("phase2_max_customer_emails_per_run", 25)),
            phase2_max_reassignments_per_run=int(data.get("phase2_max_reassignments_per_run", 25)),
            phase2_manual_suppression_tags=data.get("phase2_manual_suppression_tags", ["Do Not Nurture", "No AI Email"]),
            stale_reassignment_excluded_stages=data.get("stale_reassignment_excluded_stages", ["Hot Prospect", "Active Client", "Pending", "Closed", "Past Client", "Sphere", "Trash"]),
            excluded_user_ids=[int(uid) for uid in data.get("excluded_user_ids", [])],
            # pond_intent_keywords removed — intent detection is now fully AI-powered
            phase3_closed_drip_enabled=bool(data.get("phase3_closed_drip_enabled", False)),
            phase3_cadence_days=int(data.get("phase3_cadence_days", 90)),
            phase3_max_emails_per_run=int(data.get("phase3_max_emails_per_run", 20)),
            phase3_eligible_stages=data.get("phase3_eligible_stages", ["Closed", "Past Client", "Sphere"]),
            phase3_daily_summary_enabled=bool(data.get("phase3_daily_summary_enabled", True)),
            pond_nurture_sms_enabled=bool(data.get("pond_nurture_sms_enabled", False)),
            pond_nurture_sms_daily_cap=int(data.get("pond_nurture_sms_daily_cap", 300)),
            pond_nurture_sms_from_number=data.get("pond_nurture_sms_from_number", "5203737839"),
            long_term_nurture_enabled=bool(data.get("long_term_nurture_enabled", False)),
            long_term_nurture_cadence_days=int(data.get("long_term_nurture_cadence_days", 60)),
            long_term_nurture_max_emails_per_run=int(data.get("long_term_nurture_max_emails_per_run", 20)),
            long_term_nurture_stage=data.get("long_term_nurture_stage", "Nurture"),
            long_term_nurture_suppression_tag=data.get("long_term_nurture_suppression_tag", "long-term-nurture"),
            # long_term_nurture_future_keywords removed — future-timeline detection is now AI-powered
            email_address_update_scan_enabled=bool(data.get("email_address_update_scan_enabled", True)),
            seller_daily_cap_ramp=[int(c) for c in data.get("seller_daily_cap_ramp", [25, 25, 50, 50])] or [25],
            seller_longtail_cadence_days=int(data.get("seller_longtail_cadence_days", 21)),
            untouched_assignment_alert_enabled=bool(data.get("untouched_assignment_alert_enabled", True)),
            untouched_assignment_hours=int(data.get("untouched_assignment_hours", 24)),
            untouched_assignment_realert_hours=int(data.get("untouched_assignment_realert_hours", 72)),
            untouched_assignment_max_alerts_per_run=int(data.get("untouched_assignment_max_alerts_per_run", 10)),
        )


class AuditDB:
    def __init__(self, path: str):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.path = path
        self._init()

    def connect(self):
        return sqlite3.connect(self.path)

    def _init(self) -> None:
        with self.connect() as con:
            con.executescript(
                """
                CREATE TABLE IF NOT EXISTS audit_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    created_at TEXT NOT NULL,
                    person_id INTEGER,
                    action TEXT NOT NULL,
                    status TEXT NOT NULL,
                    details TEXT
                );
                CREATE TABLE IF NOT EXISTS reengagement_log (
                    person_id INTEGER PRIMARY KEY,
                    last_sent_at TEXT NOT NULL,
                    channel TEXT NOT NULL,
                    city TEXT,
                    message_hash TEXT
                );
                CREATE TABLE IF NOT EXISTS new_lead_timers (
                    person_id INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    assigned_user_id INTEGER,
                    warned_at TEXT,
                    reassigned_at TEXT,
                    canceled_at TEXT,
                    PRIMARY KEY (person_id, created_at)
                );
                CREATE TABLE IF NOT EXISTS closed_drip_log (
                    person_id INTEGER PRIMARY KEY,
                    last_sent_at TEXT NOT NULL,
                    deal_address TEXT,
                    subject TEXT,
                    message_hash TEXT
                );
                CREATE TABLE IF NOT EXISTS congrats_log (
                    person_id INTEGER PRIMARY KEY,
                    sent_at TEXT NOT NULL,
                    deal_address TEXT,
                    subject TEXT
                );
                CREATE TABLE IF NOT EXISTS long_term_nurture_drip (
                    person_id INTEGER PRIMARY KEY,
                    enrolled_at TEXT NOT NULL,
                    last_sent_at TEXT,
                    emails_sent INTEGER NOT NULL DEFAULT 0,
                    trigger_snippet TEXT,
                    subject TEXT,
                    message_hash TEXT
                );
                CREATE TABLE IF NOT EXISTS engagement_tier (
                    person_id INTEGER PRIMARY KEY,
                    tier TEXT NOT NULL DEFAULT 'standard',
                    last_classified_at TEXT NOT NULL,
                    reason TEXT
                );
                CREATE TABLE IF NOT EXISTS email_angle_log (
                    person_id INTEGER PRIMARY KEY,
                    last_angle TEXT NOT NULL,
                    sent_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS reply_time_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    person_id INTEGER NOT NULL,
                    reply_hour INTEGER NOT NULL,
                    reply_day_of_week INTEGER NOT NULL,
                    detected_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS purchase_window (
                    person_id INTEGER PRIMARY KEY,
                    window_start TEXT NOT NULL,
                    raw_text TEXT,
                    detected_from_note_date TEXT,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS seller_nurture_drip (
                    person_id INTEGER PRIMARY KEY,
                    enrolled_at TEXT NOT NULL,
                    last_sent_at TEXT,
                    emails_sent INTEGER NOT NULL DEFAULT 0,
                    property_address TEXT,
                    neighborhood TEXT,
                    subject TEXT,
                    message_hash TEXT
                );
                """
            )
            con.execute(
                """
                CREATE TABLE IF NOT EXISTS seller_bounced_emails (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    person_id INTEGER NOT NULL,
                    email_address TEXT NOT NULL,
                    bounced_at TEXT NOT NULL,
                    UNIQUE(person_id, email_address)
                );
                """
            )
            # Crash-safe send ledger. The drip row (emails_sent) is only bumped
            # AFTER the SMTP handoff, so a crash between "email delivered" and
            # "drip updated" used to make the next run re-send the very same
            # email to the same lead. A claim is written here BEFORE the send
            # and rolled back only if the send itself raises; a hard crash
            # leaves the claim standing, which fails safe (never double-send).
            con.execute(
                """
                CREATE TABLE IF NOT EXISTS seller_send_claims (
                    person_id    INTEGER NOT NULL,
                    email_number INTEGER NOT NULL,
                    claimed_at   TEXT NOT NULL,
                    PRIMARY KEY (person_id, email_number)
                );
                """
            )
            # Assignment safety net. FUB's people API exposes no "assigned at"
            # timestamp, so assignment age is approximated by when THIS job
            # first observed the current lead→agent pair. A pair change resets
            # both the clock and the alert suppression.
            con.execute(
                """
                CREATE TABLE IF NOT EXISTS assignment_watch (
                    person_id        INTEGER PRIMARY KEY,
                    assigned_user_id INTEGER NOT NULL,
                    first_seen_at    TEXT NOT NULL,
                    last_alert_at    TEXT
                );
                """
            )
            # Read-path indexes (2026-08-26). audit_log is append-only and never
            # pruned; recent_audit_rows filters on action+created_at and several
            # consumers scan by person_id — both were full-table scans. Indexes
            # are schema-only: state_merge reconciles rows per table and never
            # copies index objects, so merging with an un-indexed sibling is fine.
            con.execute(
                "CREATE INDEX IF NOT EXISTS idx_audit_log_action_created "
                "ON audit_log(action, created_at)")
            con.execute(
                "CREATE INDEX IF NOT EXISTS idx_audit_log_person "
                "ON audit_log(person_id)")
            self._migrate_new_lead_timers(con)
            # 2026-08-29: the touch anchor is separate from the budget anchor.
            # created_at keeps the 30/60-minute clock at DETECTION time; the
            # touch check honours the assigned agent's work from when the
            # assignment actually became theirs — Sunny Chamadia (6343) was
            # called 24 minutes after creation and still bounced because
            # detection lagged by ~2h and the anchor was detection.
            timer_cols = [r[1] for r in con.execute(
                "PRAGMA table_info(new_lead_timers)").fetchall()]
            if "touch_anchor_at" not in timer_cols:
                con.execute(
                    "ALTER TABLE new_lead_timers ADD COLUMN touch_anchor_at TEXT")

    @staticmethod
    def _migrate_new_lead_timers(con: sqlite3.Connection) -> None:
        """Legacy DBs: one timer per person, ever (PRIMARY KEY person_id).

        The assignment watch re-arms timers when a lead is REASSIGNED, so a
        person can legitimately hold several timer generations — identity is
        (person_id, created_at). CREATE IF NOT EXISTS skips existing tables,
        so a pulled state DB keeps the legacy shape until this rebuild runs.
        Idempotent: the rebuilt table no longer matches the legacy signature.
        """
        row = con.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='new_lead_timers'"
        ).fetchone()
        if not row or "person_id INTEGER PRIMARY KEY" not in (row[0] or ""):
            return
        con.executescript(
            """
            ALTER TABLE new_lead_timers RENAME TO new_lead_timers_legacy;
            CREATE TABLE new_lead_timers (
                person_id INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                assigned_user_id INTEGER,
                warned_at TEXT,
                reassigned_at TEXT,
                canceled_at TEXT,
                PRIMARY KEY (person_id, created_at)
            );
            INSERT INTO new_lead_timers
                SELECT person_id, created_at, assigned_user_id,
                       warned_at, reassigned_at, canceled_at
                FROM new_lead_timers_legacy;
            DROP TABLE new_lead_timers_legacy;
            """
        )

    def log(self, action: str, status: str, person_id: Optional[int] = None, details: Optional[dict] = None) -> None:
        with self.connect() as con:
            con.execute(
                "INSERT INTO audit_log(created_at, person_id, action, status, details) VALUES (?, ?, ?, ?, ?)",
                (now_iso(), person_id, action, status, json.dumps(details or {}, sort_keys=True)),
            )

    def recent_audit_rows(self, actions: Iterable[str], since: dt.datetime) -> List[dict]:
        placeholders = ",".join("?" for _ in actions)
        if not placeholders:
            return []
        query = f"SELECT created_at, person_id, action, status, details FROM audit_log WHERE action IN ({placeholders}) AND created_at >= ? ORDER BY created_at DESC"
        with self.connect() as con:
            con.row_factory = sqlite3.Row
            rows = con.execute(query, [*actions, since.isoformat()]).fetchall()
        return [dict(row) for row in rows]

    def get_last_reengagement(self, person_id: int) -> Optional[dt.datetime]:
        with self.connect() as con:
            row = con.execute("SELECT last_sent_at FROM reengagement_log WHERE person_id=?", (person_id,)).fetchone()
        return parse_dt(row[0]) if row else None

    def upsert_reengagement(self, person_id: int, channel: str, city: str, message: str) -> None:
        digest = hashlib.sha256(message.encode("utf-8")).hexdigest()
        with self.connect() as con:
            con.execute(
                """
                INSERT INTO reengagement_log(person_id, last_sent_at, channel, city, message_hash)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(person_id) DO UPDATE SET
                    last_sent_at=excluded.last_sent_at,
                    channel=excluded.channel,
                    city=excluded.city,
                    message_hash=excluded.message_hash
                """,
                (person_id, now_iso(), channel, city, digest),
            )

    def get_last_closed_drip(self, person_id: int) -> Optional[dt.datetime]:
        with self.connect() as con:
            row = con.execute("SELECT last_sent_at FROM closed_drip_log WHERE person_id=?", (person_id,)).fetchone()
        return parse_fub_datetime(row[0]) if row else None

    def upsert_closed_drip(self, person_id: int, deal_address: str, subject: str, message: str) -> None:
        digest = hashlib.sha256(message.encode("utf-8")).hexdigest()
        with self.connect() as con:
            con.execute(
                """
                INSERT INTO closed_drip_log(person_id, last_sent_at, deal_address, subject, message_hash)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(person_id) DO UPDATE SET
                    last_sent_at=excluded.last_sent_at,
                    deal_address=excluded.deal_address,
                    subject=excluded.subject,
                    message_hash=excluded.message_hash
                """,
                (person_id, now_iso(), deal_address, subject, digest),
            )

    def get_congrats_sent(self, person_id: int) -> Optional[dt.datetime]:
        """Return the datetime the congrats email was sent, or None if never sent."""
        with self.connect() as con:
            row = con.execute("SELECT sent_at FROM congrats_log WHERE person_id=?", (person_id,)).fetchone()
        return parse_dt(row[0]) if row else None

    def upsert_congrats(self, person_id: int, deal_address: str, subject: str) -> None:
        with self.connect() as con:
            con.execute(
                """
                INSERT INTO congrats_log(person_id, sent_at, deal_address, subject)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(person_id) DO UPDATE SET
                    sent_at=excluded.sent_at,
                    deal_address=excluded.deal_address,
                    subject=excluded.subject
                """,
                (person_id, now_iso(), deal_address, subject),
            )

    def enroll_long_term_nurture(self, person_id: int, trigger_snippet: str) -> None:
        """Enroll a lead in the long-term nurture drip. INSERT OR IGNORE so re-detection is safe."""
        with self.connect() as con:
            con.execute(
                """
                INSERT OR IGNORE INTO long_term_nurture_drip(person_id, enrolled_at, trigger_snippet)
                VALUES (?, ?, ?)
                """,
                (person_id, now_iso(), trigger_snippet[:500] if trigger_snippet else ""),
            )

    def get_long_term_nurture_enrollment(self, person_id: int) -> Optional[dict]:
        """Return the drip row for person_id, or None if not enrolled."""
        with self.connect() as con:
            con.row_factory = sqlite3.Row
            row = con.execute(
                "SELECT * FROM long_term_nurture_drip WHERE person_id=?", (person_id,)
            ).fetchone()
        return dict(row) if row else None

    def upsert_long_term_nurture_drip(self, person_id: int, subject: str, message: str) -> None:
        """Update drip record after each email send: bump emails_sent, update last_sent_at."""
        digest = hashlib.sha256(message.encode("utf-8")).hexdigest()
        with self.connect() as con:
            con.execute(
                """
                INSERT INTO long_term_nurture_drip(person_id, enrolled_at, last_sent_at, emails_sent, subject, message_hash)
                VALUES (?, ?, ?, 1, ?, ?)
                ON CONFLICT(person_id) DO UPDATE SET
                    last_sent_at=excluded.last_sent_at,
                    emails_sent=emails_sent + 1,
                    subject=excluded.subject,
                    message_hash=excluded.message_hash
                """,
                (person_id, now_iso(), now_iso(), subject, digest),
            )

    # ── Seller Nurture Drip DB Helpers ──────────────────────────────────────────
    def enroll_seller_nurture(self, person_id: int, property_address: str = "", neighborhood: str = "") -> None:
        """Enroll a lead in the seller nurture drip. INSERT OR IGNORE so re-detection is safe."""
        with self.connect() as con:
            con.execute(
                """
                INSERT OR IGNORE INTO seller_nurture_drip(person_id, enrolled_at, property_address, neighborhood)
                VALUES (?, ?, ?, ?)
                """,
                (person_id, now_iso(), property_address[:500] if property_address else "", neighborhood[:200] if neighborhood else ""),
            )

    def get_seller_nurture_enrollment(self, person_id: int) -> Optional[dict]:
        """Return the seller drip row for person_id, or None if not enrolled."""
        with self.connect() as con:
            con.row_factory = sqlite3.Row
            row = con.execute(
                "SELECT * FROM seller_nurture_drip WHERE person_id=?", (person_id,)
            ).fetchone()
        return dict(row) if row else None

    def upsert_seller_nurture_drip(self, person_id: int, subject: str, message: str, property_address: str = "", neighborhood: str = "") -> None:
        """Update seller drip record after each email send: bump emails_sent, update last_sent_at."""
        digest = hashlib.sha256(message.encode("utf-8")).hexdigest()
        with self.connect() as con:
            con.execute(
                """
                INSERT INTO seller_nurture_drip(person_id, enrolled_at, last_sent_at, emails_sent, property_address, neighborhood, subject, message_hash)
                VALUES (?, ?, ?, 1, ?, ?, ?, ?)
                ON CONFLICT(person_id) DO UPDATE SET
                    last_sent_at=excluded.last_sent_at,
                    emails_sent=emails_sent + 1,
                    property_address=COALESCE(NULLIF(excluded.property_address, ''), property_address),
                    neighborhood=COALESCE(NULLIF(excluded.neighborhood, ''), neighborhood),
                    subject=excluded.subject,
                    message_hash=excluded.message_hash
                """,
                (person_id, now_iso(), now_iso(), property_address, neighborhood, subject, digest),
            )

    def claim_seller_send(self, person_id: int, email_number: int) -> bool:
        """Reserve (person_id, email_number) before sending. False = already claimed.

        The PRIMARY KEY does the work: a second attempt at the same email for
        the same lead — whether from a crash-resumed run or an accidental
        re-dispatch — inserts 0 rows and is refused.
        """
        with self.connect() as con:
            cur = con.execute(
                "INSERT OR IGNORE INTO seller_send_claims(person_id, email_number, claimed_at) "
                "VALUES (?, ?, ?)",
                (person_id, email_number, now_iso()),
            )
            return cur.rowcount > 0

    def release_seller_send_claim(self, person_id: int, email_number: int) -> None:
        """Undo a claim when the send raised — the email never left, so retry.

        Only call this on a caught send exception. A hard crash deliberately
        leaves the claim in place: skipping one email beats sending it twice.
        """
        with self.connect() as con:
            con.execute(
                "DELETE FROM seller_send_claims WHERE person_id=? AND email_number=?",
                (person_id, email_number),
            )

    def count_seller_sends_since(self, since_iso: str) -> int:
        """Seller nurture emails actually sent since `since_iso` (audit log).

        Used for the daily ramp cap. A per-run counter is not a daily cap: a
        manual workflow_dispatch, or a re-run of a failed job, would grant a
        second full cap on the same calendar day.
        """
        with self.connect() as con:
            row = con.execute(
                "SELECT COUNT(*) FROM audit_log WHERE action=? "
                "AND status IN ('sent','dry_run_sent') AND created_at >= ?",
                (SELLER_NURTURE_AUDIT_ACTION, since_iso),
            ).fetchone()
        return int(row[0] or 0)

    def get_seller_first_send_at(self) -> Optional[dt.datetime]:
        """Return the timestamp of the first seller nurture email ever sent.

        Used as the anchor for the weekly cap ramp. Falls back to the earliest
        enrollment if last_sent_at is missing. Returns None if no seller
        nurture activity exists yet (ramp week 0).
        """
        with self.connect() as con:
            row = con.execute(
                "SELECT MIN(COALESCE(last_sent_at, enrolled_at)) FROM seller_nurture_drip "
                "WHERE emails_sent > 0 OR last_sent_at IS NOT NULL"
            ).fetchone()
        raw = row[0] if row else None
        if not raw:
            return None
        try:
            parsed = dt.datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=dt.timezone.utc)
            return parsed
        except ValueError:
            return None

    def get_seller_longtail_send_count(self, since: Optional[str] = None) -> int:
        """Count long-tail seller sends (email #6+) from the audit log.

        Used by the Monday digest. `since` is an ISO timestamp lower bound.
        """
        with self.connect() as con:
            q = (
                "SELECT COUNT(*) FROM audit_log WHERE action=? AND status IN ('sent','dry_run_sent') "
                "AND CAST(json_extract(details, '$.email_number') AS INTEGER) > ?"
            )
            params: list = [SELLER_NURTURE_AUDIT_ACTION, SELLER_SEQUENCE_LENGTH]
            if since:
                q += " AND created_at >= ?"
                params.append(since)
            row = con.execute(q, params).fetchone()
        return int(row[0] or 0)

    def get_all_seller_nurture_enrollments(self) -> List[dict]:
        """Return all seller nurture enrollments for stats/digest purposes."""
        with self.connect() as con:
            con.row_factory = sqlite3.Row
            rows = con.execute("SELECT * FROM seller_nurture_drip").fetchall()
        return [dict(row) for row in rows]

    # ── Seller Bounce Rotation DB Helpers ─────────────────────────────────────
    def get_seller_bounced_emails(self, person_id: int) -> List[str]:
        """Return all bounced email addresses for a given seller lead."""
        with self.connect() as con:
            rows = con.execute(
                "SELECT email_address FROM seller_bounced_emails WHERE person_id=?",
                (person_id,)
            ).fetchall()
        return [row[0] for row in rows]

    def mark_seller_email_bounced(self, person_id: int, email_address: str) -> None:
        """Record that an email address bounced for a seller lead."""
        with self.connect() as con:
            con.execute(
                "INSERT OR IGNORE INTO seller_bounced_emails(person_id, email_address, bounced_at) VALUES (?, ?, ?)",
                (person_id, email_address.lower().strip(), now_iso()),
            )

    def get_seller_bounce_rotation_stats(self, since: Optional[str] = None) -> dict:
        """Return bounce rotation stats for the digest.

        Returns dict with keys:
          - total_bounced_addresses: total unique bounced addresses
          - leads_with_bounces: number of unique leads that have had bounces
          - rotations_this_period: bounces recorded since `since` (ISO string)
          - leads_exhausted: leads where ALL addresses have bounced (fully suppressed)
        """
        with self.connect() as con:
            total = con.execute("SELECT COUNT(*) FROM seller_bounced_emails").fetchone()[0]
            leads = con.execute("SELECT COUNT(DISTINCT person_id) FROM seller_bounced_emails").fetchone()[0]
            if since:
                rotations = con.execute(
                    "SELECT COUNT(*) FROM seller_bounced_emails WHERE bounced_at >= ?", (since,)
                ).fetchone()[0]
            else:
                rotations = total
            # Leads exhausted: leads in seller_bounced_emails whose bounced count >= their email count in drip
            # We approximate by counting leads with 2+ bounces (most leads have 1-2 emails)
            exhausted = con.execute(
                "SELECT COUNT(DISTINCT person_id) FROM seller_bounced_emails "
                "GROUP BY person_id HAVING COUNT(*) >= 2"
            ).fetchall()
            exhausted_count = len(exhausted)
        return {
            "total_bounced_addresses": total,
            "leads_with_bounces": leads,
            "rotations_this_period": rotations,
            "leads_exhausted": exhausted_count,
        }

    def add_new_lead_timer(self, person_id: int, assigned_user_id: Optional[int], created_at: Optional[str] = None,
                           touch_anchor_at: Optional[str] = None) -> None:
        created_time = created_at if created_at else now_iso()
        with self.connect() as con:
            con.execute(
                """
                INSERT OR IGNORE INTO new_lead_timers(person_id, created_at, assigned_user_id, touch_anchor_at)
                VALUES (?, ?, ?, ?)
                """,
                (person_id, created_time, assigned_user_id, touch_anchor_at),
            )

    def last_assignment_observation(self) -> Optional[str]:
        """observed_at of the most recent assignment-change walk that covered
        its WHOLE window. A truncated walk (page cap hit with changed records
        left unread) proves only a slice was observed, so it is logged with
        status 'truncated' and never advances the touch anchor — otherwise a
        bulk sweep that keeps 500+ records above a lead in the -updated sort
        would let the anchor postdate the agent's real first touch, the exact
        Sunny Chamadia class again. The stamp is the walk's START, not the
        log time, so the anchor can never postdate an observation."""
        with self.connect() as con:
            row = con.execute(
                "SELECT details FROM audit_log WHERE action='assignment_scan' "
                "AND status='completed' ORDER BY created_at DESC LIMIT 1").fetchone()
        if not row or not row[0]:
            return None
        try:
            return json.loads(row[0]).get("observed_at")
        except ValueError:
            return None

    def active_new_lead_timers(self) -> List[dict]:
        with self.connect() as con:
            con.row_factory = sqlite3.Row
            rows = con.execute(
                "SELECT * FROM new_lead_timers WHERE canceled_at IS NULL AND reassigned_at IS NULL"
            ).fetchall()
        return [dict(row) for row in rows]

    # Milestone updates hit only the ACTIVE generation: a person can hold
    # several timer rows once reassignment re-arming exists, and warning a
    # long-completed generation would be recorded on the wrong incident.
    def mark_warned(self, person_id: int) -> None:
        with self.connect() as con:
            con.execute(
                "UPDATE new_lead_timers SET warned_at=? WHERE person_id=? "
                "AND canceled_at IS NULL AND reassigned_at IS NULL",
                (now_iso(), person_id))

    def mark_reassigned(self, person_id: int) -> None:
        with self.connect() as con:
            con.execute(
                "UPDATE new_lead_timers SET reassigned_at=? WHERE person_id=? "
                "AND canceled_at IS NULL AND reassigned_at IS NULL",
                (now_iso(), person_id))

    def cancel_timer(self, person_id: int, assigned_user_id: Optional[int] = None) -> None:
        """Cancel the person's active generation(s) — optionally only those
        armed for one agent, so a repair for agent A cannot silence a
        legitimate timer running for agent B."""
        query = ("UPDATE new_lead_timers SET canceled_at=? WHERE person_id=? "
                 "AND canceled_at IS NULL AND reassigned_at IS NULL")
        args: list = [now_iso(), person_id]
        if assigned_user_id is not None:
            query += " AND assigned_user_id=?"
            args.append(int(assigned_user_id))
        with self.connect() as con:
            con.execute(query, args)

    # ── Assignment safety net (untouched-assignment watch) ──
    def get_assignment_watch(self, person_id: int) -> Optional[dict]:
        with self.connect() as con:
            con.row_factory = sqlite3.Row
            row = con.execute("SELECT * FROM assignment_watch WHERE person_id=?", (person_id,)).fetchone()
        return dict(row) if row else None

    def delete_assignment_watch(self, person_id: int) -> None:
        with self.connect() as con:
            con.execute("DELETE FROM assignment_watch WHERE person_id=?", (person_id,))

    def all_assignment_watch_rows(self) -> List[dict]:
        with self.connect() as con:
            con.row_factory = sqlite3.Row
            rows = con.execute(
                "SELECT * FROM assignment_watch ORDER BY first_seen_at").fetchall()
        return [dict(row) for row in rows]

    def upsert_assignment_watch(self, person_id: int, assigned_user_id: int, first_seen_at: Optional[str] = None) -> None:
        """Record the current lead→agent pair. REPLACE semantics on purpose:
        an assignment change restarts the untouched clock and clears the
        last_alert_at suppression for the new pair."""
        with self.connect() as con:
            con.execute(
                "INSERT OR REPLACE INTO assignment_watch(person_id, assigned_user_id, first_seen_at, last_alert_at) VALUES (?, ?, ?, NULL)",
                (person_id, assigned_user_id, first_seen_at or now_iso()),
            )

    def mark_assignment_alerted(self, person_id: int) -> None:
        with self.connect() as con:
            con.execute("UPDATE assignment_watch SET last_alert_at=? WHERE person_id=?", (now_iso(), person_id))

    # ── Engagement Tier (Tier 3 Feature 1) ──
    def upsert_engagement_tier(self, person_id: int, tier: str, reason: str) -> None:
        with self.connect() as con:
            con.execute(
                """
                INSERT INTO engagement_tier(person_id, tier, last_classified_at, reason)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(person_id) DO UPDATE SET
                    tier=excluded.tier,
                    last_classified_at=excluded.last_classified_at,
                    reason=excluded.reason
                """,
                (person_id, tier, now_iso(), reason),
            )

    def get_engagement_tier(self, person_id: int) -> Optional[str]:
        with self.connect() as con:
            row = con.execute("SELECT tier FROM engagement_tier WHERE person_id=?", (person_id,)).fetchone()
        return row[0] if row else None

    def get_engagement_tier_counts(self) -> dict:
        with self.connect() as con:
            rows = con.execute("SELECT tier, COUNT(*) as cnt FROM engagement_tier GROUP BY tier").fetchall()
        return {row[0]: row[1] for row in rows}

    # ── Email Angle Log (Tier 3 Feature 2) ──
    def get_last_email_angle(self, person_id: int) -> Optional[str]:
        with self.connect() as con:
            row = con.execute("SELECT last_angle FROM email_angle_log WHERE person_id=?", (person_id,)).fetchone()
        return row[0] if row else None

    def upsert_email_angle(self, person_id: int, angle: str) -> None:
        with self.connect() as con:
            con.execute(
                """
                INSERT INTO email_angle_log(person_id, last_angle, sent_at)
                VALUES (?, ?, ?)
                ON CONFLICT(person_id) DO UPDATE SET
                    last_angle=excluded.last_angle,
                    sent_at=excluded.sent_at
                """,
                (person_id, angle, now_iso()),
            )

    # ── Purchase Window (Timeline-Aware Cadence) ──
    def get_purchase_window(self, person_id: int) -> Optional[dict]:
        with self.connect() as con:
            row = con.execute("SELECT window_start, raw_text, detected_from_note_date FROM purchase_window WHERE person_id=?", (person_id,)).fetchone()
        if not row:
            return None
        return {"window_start": row[0], "raw_text": row[1], "detected_from_note_date": row[2]}

    def upsert_purchase_window(self, person_id: int, window_start: str, raw_text: Optional[str] = None, detected_from_note_date: Optional[str] = None) -> None:
        with self.connect() as con:
            con.execute(
                """
                INSERT INTO purchase_window(person_id, window_start, raw_text, detected_from_note_date, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(person_id) DO UPDATE SET
                    window_start=excluded.window_start,
                    raw_text=excluded.raw_text,
                    detected_from_note_date=excluded.detected_from_note_date,
                    updated_at=excluded.updated_at
                """,
                (person_id, window_start, raw_text, detected_from_note_date, now_iso()),
            )

    def count_timeline_adjusted_leads(self) -> dict:
        """Return count and avg days-out for leads with active purchase windows."""
        with self.connect() as con:
            rows = con.execute("SELECT window_start FROM purchase_window").fetchall()
        if not rows:
            return {"count": 0, "avg_days_out": 0}
        today = dt.date.today()
        days_out = []
        for row in rows:
            try:
                ws = dt.date.fromisoformat(row[0][:10])
                delta = (ws - today).days
                if delta > 0:
                    days_out.append(delta)
            except (ValueError, TypeError):
                pass
        return {"count": len(days_out), "avg_days_out": int(sum(days_out) / len(days_out)) if days_out else 0}

    # ── Reply Time Log (Tier 3 Feature 4) ──
    def log_reply_time(self, person_id: int, reply_hour: int, reply_day_of_week: int) -> None:
        with self.connect() as con:
            con.execute(
                "INSERT INTO reply_time_log(person_id, reply_hour, reply_day_of_week, detected_at) VALUES (?, ?, ?, ?)",
                (person_id, reply_hour, reply_day_of_week, now_iso()),
            )

    def get_reply_time_count(self) -> int:
        with self.connect() as con:
            row = con.execute("SELECT COUNT(*) FROM reply_time_log").fetchone()
        return row[0] if row else 0


class FollowUpBossClient:
    BASE = "https://api.followupboss.com/v1"

    def __init__(self, settings: Settings):
        self.settings = settings
        if not settings.fub_api_key:
            LOGGER.warning("FUB_API_KEY is empty. API calls will fail unless DRY_RUN avoids them.")

    def _headers(self, registered: bool = False) -> Dict[str, str]:
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if registered and self.settings.fub_system_name and self.settings.fub_system_key:
            headers["X-System"] = self.settings.fub_system_name
            headers["X-System-Key"] = self.settings.fub_system_key
        return headers

    def _request(self, method: str, path: str, *, params: Optional[dict] = None, json_body: Optional[dict] = None, registered: bool = False) -> dict:
        url = f"{self.BASE}{path}"
        max_retries = 5
        for attempt in range(max_retries):
            try:
                response = requests.request(
                    method,
                    url,
                    params=params,
                    json=json_body,
                    headers=self._headers(registered=registered),
                    auth=(self.settings.fub_api_key, ""),
                    timeout=60,
                )
            except (requests.exceptions.ReadTimeout, requests.exceptions.ConnectionError) as e:
                wait = 2 ** (attempt + 1)
                LOGGER.warning("FUB API timeout/connection error on %s %s — retrying in %ss (attempt %s/%s): %s",
                               method, path, wait, attempt + 1, max_retries, str(e)[:100])
                time.sleep(wait)
                continue
            if response.status_code == 429:
                # FUB rate limit hit — back off exponentially (2s, 4s, 8s, 16s, 32s)
                wait = 2 ** (attempt + 1)
                LOGGER.warning("FUB API rate limit (429) on %s %s — retrying in %ss (attempt %s/%s)",
                               method, path, wait, attempt + 1, max_retries)
                time.sleep(wait)
                continue
            if response.status_code >= 400:
                raise RuntimeError(f"FUB API {method} {path} failed {response.status_code}: {response.text[:500]}")
            if not response.text:
                return {}
            return response.json()
        raise RuntimeError(f"FUB API {method} {path} failed after {max_retries} retries (timeout/rate-limit)")

    def get_people(self, **params: Any) -> List[dict]:
        # If offset or limit are explicitly set, don't auto-paginate to respect custom requests
        if "offset" in params or "limit" in params:
            data = self._request("GET", "/people", params=params)
            return data.get("people", data.get("data", []))
            
        # Otherwise, auto-paginate to fetch ALL matching records in the FUB system using cursor-based pagination
        all_people = []
        params["limit"] = 100
        current_next = None
        while True:
            if current_next:
                params["next"] = current_next
            else:
                params.pop("next", None)
            data = self._request("GET", "/people", params=params)
            people = data.get("people", data.get("data", []))
            if not people:
                break
            all_people.extend(people)
            page_num = len(all_people) // 100 + (1 if len(all_people) % 100 > 0 else 0)
            LOGGER.info("Fetched page %s (%s people total)...", page_num, len(all_people))
            # Check if there is a next cursor in metadata
            metadata = data.get("_metadata", {})
            current_next = metadata.get("next")
            if not current_next:
                break
        return all_people

    def get_person(self, person_id: int) -> Optional[dict]:
        people = self.get_people(id=str(person_id), fields="allFields")
        return people[0] if people else None

    def update_person(self, person_id: int, payload: dict, merge_tags: bool = False) -> dict:
        params = {"mergeTags": "true"} if merge_tags else None
        if self.settings.dry_run:
            LOGGER.info("DRY_RUN update_person %s keys=%s", person_id, list(payload.keys()))
            return {"dry_run": True}
        return self._request("PUT", f"/people/{person_id}", params=params, json_body=payload)

    def add_note(self, person_id: int, subject: str, body: str) -> dict:
        payload = {"personId": person_id, "subject": subject, "body": body, "isHtml": False}
        if self.settings.dry_run:
            LOGGER.info("DRY_RUN add_note %s %s", person_id, subject)
            return {"dry_run": True}
        return self._request("POST", "/notes", json_body=payload)

    def create_task(self, person_id: int, assigned_user_id: int, name: str, task_type: str = "Follow Up", due_minutes: int = 15) -> dict:
        due = dt.datetime.now(UTC) + dt.timedelta(minutes=due_minutes)
        payload = {
            "personId": person_id,
            "assignedUserId": assigned_user_id,
            "name": name,
            "type": task_type,
            "isCompleted": False,
            "dueDateTime": due.isoformat(),
            "remindSecondsBefore": 0,
        }
        if self.settings.dry_run:
            LOGGER.info("DRY_RUN create_task %s", person_id)
            return {"dry_run": True}
        return self._request("POST", "/tasks", json_body=payload)

    def users(self, **params: Any) -> List[dict]:
        params.setdefault("limit", 100)
        data = self._request("GET", "/users", params=params)
        return data.get("users", data.get("data", []))

    def get_notes(self, person_id: int, limit: int = 100) -> List[dict]:
        data = self._request("GET", "/notes", params={"personId": person_id, "limit": min(limit, 100)})
        return data.get("notes", data.get("data", []))

    def get_events(self, person_id: int, limit: int = 100) -> List[dict]:
        data = self._request("GET", "/events", params={"personId": person_id, "limit": min(limit, 100)})
        return data.get("events", data.get("data", []))

    def get_text_messages(self, person_id: int, limit: int = 100) -> List[dict]:
        data = self._request("GET", "/textMessages", params={"personId": person_id, "limit": min(limit, 100)})
        return data.get("textMessages", data.get("data", []))

    def get_emails(self, person_id: int, limit: int = 100) -> List[dict]:
        data = self._request("GET", "/emails", params={"personId": person_id, "limit": min(limit, 100)})
        return data.get("emails", data.get("data", []))

    def get_calls(self, person_id: int, limit: int = 100) -> List[dict]:
        data = self._request("GET", "/calls", params={"personId": person_id, "limit": min(limit, 100)})
        return data.get("calls", data.get("data", []))

    def assign_to_pond(self, person_id: int, pond_id: int) -> dict:
        payload = {"assignedPondId": int(pond_id)}
        if self.settings.dry_run:
            LOGGER.info("DRY_RUN assign_to_pond %s %s", person_id, payload)
            return {"dry_run": True}
        return self.update_person(person_id, payload)

    def get_deals_for_person(self, person_id: int) -> List[dict]:
        """Return all deals associated with a person from FUB."""
        data = self._request("GET", "/deals", params={"personId": person_id, "limit": 25})
        return data.get("deals", data.get("data", []))

    def log_text_message(self, person_id: int, message: str, to_number: str, from_number: str) -> dict:
        payload = {
            "personId": person_id,
            "message": message,
            "toNumber": to_number,
            "fromNumber": from_number,
            "isIncoming": False,
            "externalLabel": "AI re-engagement automation",
        }
        if self.settings.dry_run:
            LOGGER.info("DRY_RUN log_text_message %s", person_id)
            return {"dry_run": True}
        return self._request("POST", "/textMessages", json_body=payload, registered=True)


class ContentGenerator:
    def __init__(self, settings: Settings, rules: Rules):
        api_key = os.getenv("ANTHROPIC_API_KEY") or os.getenv("OPENAI_API_KEY") or ""
        self.client = Anthropic(api_key=api_key, timeout=120.0)
        self.model = os.getenv("LLM_MODEL") or settings.openai_model or "claude-haiku-4-5-20251001"
        self.rules = rules

    def _llm_call(self, messages: list, temperature: float = 0.7, json_mode: bool = True) -> str:
        """Unified LLM call via Anthropic SDK. Returns raw content string."""
        # Separate system message from user messages
        system_text = ""
        user_messages = []
        for m in messages:
            if m["role"] == "system":
                system_text = m["content"]
            else:
                user_messages.append(m)
        if not user_messages:
            user_messages = [{"role": "user", "content": "Please respond."}]

        kwargs = {
            "model": self.model,
            "max_tokens": 4096,
            "temperature": temperature,
            "messages": user_messages,
        }
        if system_text:
            kwargs["system"] = system_text

        response = self.client.messages.create(**kwargs)
        content = response.content[0].text if response.content else ""
        # Strip markdown code fences if present (common with Claude JSON output)
        if content.startswith("```"):
            lines = content.split("\n")
            # Remove first and last lines (```json and ```)
            lines = [l for l in lines[1:] if l.strip() != "```"]
            content = "\n".join(lines)
        return content

    @staticmethod
    def extract_json_object(content: str) -> str:
        """Return just the first complete JSON object in `content`.

        The fence-stripper above handles ```json wrappers but not the other
        common shape: a valid JSON object followed by a sentence or two of
        commentary. json.loads() rejects that with "Extra data: line N", and on
        2026-08-05 that error hit 53 of 90 pond skip checks — 59%.

        That was not merely wasted tokens. should_skip_lead_llm() treats any
        exception as "do not skip", so for 59% of leads the LLM skip gate was
        silently absent: notes saying the lead had bought a house, signed with
        another agent, or asked to be left alone stopped being read at all.
        Raising the daily cap would have multiplied exactly that population.

        Scans with a brace counter that ignores braces inside strings, so a
        reason field containing '}' cannot truncate the object early. Returns
        the input unchanged when no object is found, letting the caller's own
        error handling report a genuinely unparseable response.
        """
        if not content:
            return content
        start = content.find("{")
        if start == -1:
            return content
        depth = 0
        in_string = False
        escaped = False
        for i in range(start, len(content)):
            ch = content[i]
            if in_string:
                if escaped:
                    escaped = False
                elif ch == "\\":
                    escaped = True
                elif ch == '"':
                    in_string = False
                continue
            if ch == '"':
                in_string = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return content[start : i + 1]
        return content

    def should_skip_lead_llm(self, person: dict, notes: List[dict]) -> Tuple[bool, str]:
        if not notes:
            return False, ""
        rendered_notes: List[str] = []
        for idx, note in enumerate(notes[:25], 1):
            raw = str(note.get("body") or note.get("text") or note.get("note") or note.get("subject") or "")
            cleaned = re.sub(r"<[^>]+>", " ", raw)
            cleaned = re.sub(r"\s+", " ", cleaned).strip()
            if cleaned:
                rendered_notes.append(f"{idx}. {cleaned[:700]}")
        if not rendered_notes:
            return False, ""
        first_name = person.get("firstName") or "there"
        prompt = f"""
        You are a senior real estate CRM analyst reviewing Follow Up Boss notes for a lead named {first_name}.
        Your job is to decide whether this lead should be skipped for an automated two-week pond nurture email.

        Your decision must be based on the OVERALL INTENT of the notes, not on any specific words or phrases.
        People write notes in many different ways. Focus on what they actually mean, not how they say it.

        SKIP the lead if the notes, taken together, clearly communicate any of the following underlying intents:

        INTENT A — The lead is no longer available as a potential buyer or seller:
        This includes any way of saying they bought a home, are under contract, closed on a property,
        are renting instead, decided not to buy, put their search on indefinite hold, or are no longer
        in the market. The phrasing could be casual, indirect, or shorthand (e.g. "they went with someone",
        "signed lease", "off the market", "not looking anymore", "put it on pause", "deal fell through
        and they gave up", "not ready for years", etc.).

        INTENT B — The lead is being served by someone else:
        This includes any indication they are working with, have committed to, or have signed with another
        agent, broker, or real estate professional. This could be phrased as "going with KW", "their cousin
        is an agent", "already has representation", "signed a buyer agreement elsewhere", "referred to
        another agent", "using a friend who is a realtor", etc.

        INTENT C — The lead has explicitly asked to stop receiving outreach:
        This includes any form of opt-out, do not contact, stop texting, unsubscribe, remove from list,
        or expressed frustration about being contacted. Even indirect signals count, like "they seemed
        annoyed", "asked to be left alone for now", "said to stop reaching out", etc.

        INTENT D — The lead has permanently relocated away from the target market:
        This includes moving out of state, moving internationally, relocating for a job to a different
        region, or any indication they are no longer geographically relevant to Texas real estate.

        DO NOT SKIP the lead if:
        - The notes only show normal sales activity: calls made, listings sent, showings scheduled,
          pre-approval discussed, financing questions answered, follow-ups logged, price ranges discussed,
          or general check-ins with no response.
        - The notes show the lead is temporarily paused but still interested (e.g. "waiting until spring",
          "needs 3 more months to save", "watching rates", "not ready until after the holidays").
        - The notes are vague, sparse, or could be interpreted either way. When in doubt, do NOT skip.
        - The most recent note is old and there is no clear disqualifying intent in the full history.

        CONFIDENCE REQUIREMENT:
        Only set should_skip to true if you are highly confident (80% or more) that the notes communicate
        one of the four skip intents above. If you are uncertain, default to should_skip = false.
        It is always safer to send the email than to incorrectly suppress a lead.

        Return strict JSON with exactly these keys:
        - should_skip: boolean
        - intent_category: one of "A", "B", "C", "D", or "none" (which intent triggered the skip, or none)
        - confidence: integer from 0 to 100 representing your confidence in the skip decision
        - reason: plain-English explanation of your reasoning, maximum 25 words

        Notes to review (newest first):
        {chr(10).join(rendered_notes)}
        """
        try:
            content = self._llm_call(messages=[{"role": "user", "content": textwrap.dedent(prompt).strip()}], temperature=0.1)
            if not content:
                return False, ""
            parsed = json.loads(self.extract_json_object(content))
            should_skip = bool(parsed.get("should_skip"))
            confidence = int(parsed.get("confidence") or 0)
            reason = str(parsed.get("reason") or "").strip()
            intent_cat = str(parsed.get("intent_category") or "none").strip()
            # Enforce confidence gate: only skip if LLM is at least 80% confident
            if should_skip and confidence < 80:
                LOGGER.info(
                    "LLM skip check for person %s: low confidence (%s%%) — overriding to not skip. Reason: %s",
                    person.get("id"), confidence, reason,
                )
                return False, ""
            if should_skip:
                LOGGER.info(
                    "LLM skip check for person %s: SKIP (intent=%s, confidence=%s%%) — %s",
                    person.get("id"), intent_cat, confidence, reason,
                )
            return should_skip, reason
        except Exception as exc:  # noqa: BLE001
            LOGGER.warning("LLM skip check failed for person %s: %s", person.get("id"), exc)
            return False, ""

    def extract_purchase_window(self, person: dict, notes: List[dict]) -> Optional[dict]:
        """Extract a future purchase timeline window from notes using Anthropic.
        Returns {window_start: 'YYYY-MM-DD', raw_text: str, source_note_date: str} or None.
        Re-extracts every cycle — newer notes override older windows."""
        if not notes:
            return None
        # Build compact note summary (most recent 10)
        sorted_notes = sorted(notes, key=lambda n: n.get("created") or n.get("createdAt") or "", reverse=True)[:10]
        notes_summary = "\n".join(
            f"Note {i+1} ({n.get('created') or n.get('createdAt') or 'unknown'}): {(n.get('body') or '')[:300]}"
            for i, n in enumerate(sorted_notes)
        )
        today_str = dt.date.today().isoformat()
        prompt = f"""You are a real estate CRM assistant. Today's date is {today_str}.

Analyze these lead notes and extract any FUTURE purchase timeline or window:
{notes_summary}

Look for:
- Explicit dates: "buying in January", "moving in August", "closing in March"
- Relative timeframes: "in 6 months", "next spring", "not until fall"
- Life events with dates: "lease ends in August", "job starts in September", "baby due in October"
- Builder timelines: "orders expected Jan-March", "completion in Q2"
- Seasonal: "after the holidays", "next summer", "when school starts"

If you find a purchase window, respond EXACTLY:
WINDOW: YYYY-MM-DD | SOURCE_NOTE_DATE: YYYY-MM-DD | RAW: <the exact phrase>

The WINDOW date should be your best estimate of when they plan to buy/move (use the 1st of the month if only a month is given).
SOURCE_NOTE_DATE is the date of the note containing the timeline info.

If NO timeline is found, respond exactly:
NO_WINDOW"""
        try:
            content = self._llm_call(
                messages=[{"role": "user", "content": prompt}],
                temperature=0.1,
                json_mode=False,
            )
            if not content or content.strip().startswith("NO_WINDOW"):
                return None
            import re
            match = re.match(
                r"WINDOW:\s*(\d{4}-\d{2}-\d{2})\s*\|\s*SOURCE_NOTE_DATE:\s*(\d{4}-\d{2}-\d{2})\s*\|\s*RAW:\s*(.+)",
                content.strip(), re.IGNORECASE,
            )
            if not match:
                return None
            return {
                "window_start": match.group(1),
                "raw_text": match.group(3).strip(),
                "source_note_date": match.group(2),
            }
        except Exception as exc:
            LOGGER.warning("extract_purchase_window failed for person %s: %s", person.get("id"), exc)
            return None

    def generate(self, person: dict, city: str, market_context: str, lead_context: str = "", recent_note_text: str = "", recent_email_thread: str = "", holiday: str = "", engagement_tier: str = "standard", full_note_history: str = "", last_angle_used: str = "", is_value_led: bool = False) -> dict:
        first_name = person.get("firstName") or "there"
        person_id = int(person.get("id") or 0)
        cycle_seed = f"{person_id}-{dt.datetime.now(timezone.utc).strftime('%Y-%m-%d')}"
        angle_options = [
            "quick local market pulse and buying-power question",
            "neighborhood fit, commute, and lifestyle question",
            "rates/payment context with a low-pressure next-step question",
            "new construction, concessions, and timing question",
            "restaurants, bars, weekend lifestyle, and area-fit question",
            "home-search strategy and must-have priorities question",
        ]
        seed_hash = int(hashlib.sha256(cycle_seed.encode('utf-8')).hexdigest(), 16)
        angle = angle_options[seed_hash % len(angle_options)]
        # ── Tier 3 Feature 2: Angle Rotation — never repeat the same angle twice in a row ──
        if last_angle_used and angle == last_angle_used and len(angle_options) > 1:
            # Pick the next angle in the list
            current_idx = angle_options.index(angle)
            angle = angle_options[(current_idx + 1) % len(angle_options)]

        ask_referral = (seed_hash % 4 == 0)
        referral_instruction = ""
        if ask_referral:
            referral_instruction = (
                "ADDITIONAL REQUIREMENT: Warmly ask if they know anyone else looking to buy or sell a home in Texas. "
                "Mention that you'd love to connect with their friends or family and help them get a great deal. "
                "Keep this ask extremely friendly, casual, and low-pressure, integrated naturally into the message."
            )
        city_instruction = (
            f"The lead appears interested in {city}. Tailor the note to that city or area."
            if city and city.lower() not in {"texas", "your area", "any city in texas", "texas/general"}
            else "No reliable city is known. Speak broadly about helping them find the right home anywhere in Texas."
        )
        safe_lead_context = lead_context or "No safe lead-specific note context is available beyond the first name and city guidance."
        safe_recent_note = recent_note_text or "No recent note was available."
        today_str = dt.datetime.now(timezone.utc).strftime('%Y-%m-%d')

        # Holiday-aware email generation
        holiday_instruction = ""
        if holiday:
            holiday_instruction = (
                f"HOLIDAY CONTEXT: Today is {holiday}! This is a holiday, so the email should "
                f"warmly acknowledge {holiday} in the opening or subject line. Wish them a happy {holiday} "
                f"and keep the tone celebratory and festive. The email should still be about real estate "
                f"and their home search, but lead with the holiday greeting. Make it feel like "
                f"the team is sending a quick personal holiday note to a friend, not a mass blast."
            )

        # Thread-aware email generation: if there's a recent email thread, prioritize continuing it
        thread_section = ""
        thread_instruction = ""
        if recent_email_thread:
            thread_section = f"\n        Recent email thread (chronological, most recent at bottom):\n        {recent_email_thread}\n"
            thread_instruction = (
                "\n        CRITICAL THREAD CONTINUATION RULES:\n"
                "        - There is an active email thread with this lead shown above. You MUST continue that conversation naturally.\n"
                "        - Reference what was last asked or said in the thread and follow up on it directly.\n"
                f"        - CRITICAL: Only reference actions that are EXPLICITLY documented in the thread or FUB notes. NEVER claim you sent listings, options, properties, or resources unless the thread or notes explicitly confirm it. If the previous emails discussed the market generally, continue that general conversation - do NOT escalate to claiming you sent specific things.\n"
                f"        - CRITICAL DATE AWARENESS: Today's date is {today_str}. Notes include dates. If a note is more than 30 days old, treat it as HISTORICAL - never reference old meetings, calls, or conversations as if they are current or upcoming. Old notes with phrases like 'this Friday' or 'next week' refer to dates that have LONG PASSED.\n"
                "        - Do NOT start a new unrelated topic or ignore the existing thread.\n"
                "        - If Peter asked a question in the last email, follow up on THAT question (e.g. 'Just checking in, did you get a chance to think about your timeline?').\n"
                "        - If the lead replied with information, acknowledge it and advance the conversation.\n"
                "        - Keep the same conversational tone as the thread. This should feel like the next natural message in an ongoing chat.\n"
                "        - The subject line should relate to the thread topic, not introduce a random new angle.\n"
                "        - IGNORE the freshness angle below when a thread exists. The thread topic IS your angle.\n"
            )

        # ── Tier 3 Feature 2: Expanded context for deeper personalization ──
        lead_source = person.get("source") or person.get("leadSource") or "Unknown"
        price_range = person.get("priceRange") or person.get("price") or ""
        # Calculate days in pond from created date
        created_str = person.get("created") or person.get("createdAt") or ""
        days_in_pond = ""
        if created_str:
            try:
                created_dt = parse_fub_datetime(created_str)
                if created_dt:
                    days_in_pond = str((dt.datetime.now(UTC) - created_dt).days)
            except Exception:
                pass
        safe_full_notes = full_note_history or safe_lead_context

        prompt = f"""
        You are writing on behalf of the Lifestyle Design Realty team.
        Draft a warm, personal two-week nurture email to a real estate lead in a Follow Up Boss pond.

        Lead first name: {first_name}
        Lead source: {lead_source}
        Price range (if known): {price_range or 'Not specified'}
        Days in pond: {days_in_pond or 'Unknown'}
        Engagement tier: {engagement_tier} ({'highly responsive, keep momentum' if engagement_tier == 'engaged' else 'cold/unresponsive, try to re-spark interest' if engagement_tier == 'cold' else 'standard cadence'})
        City or area guidance: {city_instruction}
        Full FUB note history (use strategically, most recent first): {safe_full_notes}
        Most recent FUB note: {safe_recent_note}
        Freshness angle for this cycle: {angle}
        IMPORTANT: Do NOT use the same angle as last time. Last angle was: {last_angle_used or 'none/first email'}
        Local or market context: {market_context or 'Use general, non-fabricated language. You may mention broad themes like inventory, rates, neighborhood fit, local restaurants, coffee shops, weekend events, and lifestyle, but do not invent specific openings, exact statistics, named businesses, or rate numbers unless provided in the context.'}
        {thread_section}
        {thread_instruction}
        {holiday_instruction}
        {f'''VALUE-LED EMAIL (Timeline-stretched cadence): This lead has a purchase window far in the future, so emails are less frequent. This email MUST be VALUE-LED — provide genuinely useful content:
        - Market updates, rate changes, or incentive programs for their stated price range/city
        - New builder deals, inventory updates, or community developments in their target area
        - Practical prep steps (VA pre-qualification, credit optimization, down payment programs)
        - Neighborhood insights, school ratings, or lifestyle info for their target area
        NEVER write a generic "just checking in" — every stretched-cadence email must deliver tangible value.''' if is_value_led else ''}
        Requirements:
        - CRITICAL (anti-phantom): NEVER reference a previous email, message, call, attachment, or conversation unless it appears explicitly in the provided FUB notes. Real prior outreach always appears in the notes (every automated email logs one). If the notes show no prior outreach, write as a natural FIRST touch — do not imply any earlier contact existed.
        - Make this feel like a one-off email someone on the team just wrote on their phone, not a drip, newsletter, campaign, or transactional automation.
        - Write in a highly personal, warm, casual, and human tone. Think real estate advisor talking to a friend, not marketing copywriter.
        - Avoid run-on sentences. Break the text into very short, punchy, engaging paragraphs, maximum 2 to 3 sentences per paragraph.
        - Use emojis naturally throughout the email to make it visually engaging and friendly, aim for 2 to 4 emojis.
        - CRITICAL STYLE RESTRICTION: Do not use dashes anywhere in the subject or body of the email. Use commas, parentheses, or a new sentence instead.
        - CRITICAL STYLE RESTRICTION: Do not use bullet points, numbered lists, or list structures of any kind. Keep it strictly conversational prose.
        - Write exactly ONE greeting line at the top, for example "Hey Matthew,". Use only the first name. Do not repeat the name in the opening sentence.
        - Read the most recent FUB note and reference it naturally when helpful, without sounding creepy or quoting it directly.
        - CRITICAL DATE AWARENESS: Today's date is {today_str}. Notes include their dates in brackets like [2024-10-15]. If a note is more than 30 days old, treat it as HISTORICAL context only. NEVER reference events, meetings, conversations, or actions from old notes as if they are current or upcoming. For example, if an 8-month-old note says "this Friday" or "setting a time," those events are LONG PAST — do not mention them. If the most recent note is very old (60+ days), acknowledge the time gap naturally (e.g., "It's been a while" or "Wanted to reach back out") rather than pretending there's an active ongoing conversation.
        - TEMPORAL REASONING: Extract any dates or time-bound life events mentioned in notes (lease ending, job start, baby due, "not until spring", "moving in August", "closing in March"). Calculate their relationship to today's date ({today_str}) and reference them naturally and strategically. For example: a March note saying "lease ends in August" should produce, in July: "your lease is coming up next month, right?" A note from January saying "not ready until summer" should produce, in June: "you mentioned wanting to start looking around summer, is now a good time?" A note saying "baby due in September" should produce, in August: "with the baby coming soon, have you thought about how much space you'll need?" This makes emails feel eerily personal and well-timed.
        - ONLY reference listings, options, or properties being sent if the FUB notes EXPLICITLY state that listings/options were sent to this specific lead. If no note confirms it, NEVER claim you sent them anything. This is critical — hallucinating that you sent listings when you did not will destroy trust with the lead.
        - If the notes DO confirm listings were sent, naturally ask "Did you get a chance to look at those?"
        - If the most recent note says the lead is pre-approved, reference that naturally in the body.
        - Use the safe lead context only if it helps; do not over-reference old notes.
        - CRITICAL: Do NOT state where the lead is relocating FROM as a fact (e.g. "hope the move from Minnesota is going well"). Notes may contain inaccurate third-party data. Only reference the DESTINATION city/area. If you want to reference a move, say something generic like "how's the move going" or "hope the transition is smooth" without naming the origin state or city.
        - CRITICAL: Do NOT invent or assume personal details about the lead (family status, job, hobbies, pets) unless explicitly stated in the notes. When in doubt, keep it general.
        - Vary the angle naturally using the freshness angle, so each two-week cycle has a different subject, opening, and question.
        - Tailor to the detected city when known. If no city is known, emphasize that we help clients across Texas and can narrow the right city together.
        - Discuss useful topics such as market feel, rates or payment context, neighborhoods, lifestyle, commute, restaurants, bars, weekend events, or home-search strategy.
        - Do not invent exact statistics, new bar openings, rates, named businesses, or specific local events unless they are provided in the local or market context.
        - Do not claim you personally toured a property, spoke with the lead, or know private facts unless provided.
        - The subject line must be dynamic and specific to this lead's context. Do not use generic subjects like "Checking in" or "Just following up".
        - {referral_instruction}
        - Keep it concise, 120 to 190 words, plain text, friendly, and specific enough to invite a reply.
        - Ask exactly one simple question that makes it easy for the lead to respond.
        - Never end with any question about automating an agent's workflow or anything internal. This is a client email only.
        - End with a warm team sign-off such as "Cheers,\nThe LDR Team" or "Talk soon,\nYour friends at Lifestyle Design Realty". NEVER use any individual person's name. Do not add the company address, legal disclaimer, or unsubscribe language, because the system adds the footer separately.
        - Return strict JSON with exactly these keys: subject, email_body.
        """
        content = self._llm_call(messages=[{"role": "user", "content": textwrap.dedent(prompt).strip()}], temperature=0.86)
        LOGGER.debug("LLM Response content: %s", content[:200])
        if not content:
            LOGGER.error("LLM returned empty content")
            raise ValueError("LLM returned empty content")
        generated = json.loads(content)
        generated["freshness_angle"] = angle
        generated["asked_referral"] = ask_referral
        return generated

    def generate_closed_drip_email(
        self,
        person: dict,
        deal_address: str,
        close_date: Optional[str],
        local_spots: List[dict],
    ) -> dict:
        """Generate a warm quarterly check-in email for a closed/past-client lead.

        Signed 'Truly, Peter' — never the agent name.
        Includes 2-3 hyper-local spots near the home address.
        Ends with a soft referral ask.
        """
        first_name = person.get("firstName") or "there"
        close_year = ""
        if close_date:
            try:
                close_year = str(parse_fub_datetime(close_date).year)
            except Exception:
                pass

        # Format local spots into a natural sentence
        spot_lines = []
        for spot in local_spots[:3]:
            name = spot.get("name", "")
            vicinity = spot.get("vicinity") or spot.get("formatted_address", "")
            # Strip the street number to keep it casual
            vicinity_short = ", ".join(vicinity.split(",")[1:]).strip() if "," in vicinity else vicinity
            if name:
                spot_lines.append(f"{name}" + (f" ({vicinity_short})" if vicinity_short else ""))

        spots_context = (
            "Recent local spots near their home: " + "; ".join(spot_lines)
            if spot_lines
            else "No specific local spots available — use warm, general neighborhood language."
        )
        close_context = (
            f"They closed on their home at {deal_address}" + (f" in {close_year}" if close_year else "") + "."
            if deal_address
            else "They are a past client of Lifestyle Design Realty."
        )

        prompt = f"""
        You are writing on behalf of the Lifestyle Design Realty team.
        Draft a warm, personal quarterly check-in email to a past real estate client.

        Client first name: {first_name}
        Context: {close_context}
        {spots_context}

        Requirements:
        - CRITICAL (anti-phantom): NEVER reference a previous email, message, call, attachment, or conversation unless it appears explicitly in the provided FUB notes. Real prior outreach always appears in the notes (every automated email logs one). If the notes show no prior outreach, write as a natural FIRST touch — do not imply any earlier contact existed.
        - Make this feel like a one-off email someone on the team just wrote on their phone, not a drip or newsletter.
        - Write in a highly personal, warm, casual, and human tone. Think "real estate advisor checking in on a friend," not "marketing copywriter."
        - Avoid run-on sentences. Break up the text into very short, punchy paragraphs (maximum 2-3 sentences per paragraph).
        - Use emojis naturally (aim for 2 to 4 emojis such as 🏡, ☕, 🍕, 🌮, 🎉, ✨, etc.).
        - CRITICAL STYLE RESTRICTION: Do NOT use dashes (- or --) anywhere in the subject or body.
        - CRITICAL STYLE RESTRICTION: Do NOT use bullet points, numbered lists, or list structures. Keep it strictly conversational prose.
        - Open with a genuine "how's the home?" style question.
        - Naturally mention 1-2 of the local spots near their home (new restaurants, bars, coffee shops, parks). Make it feel like a neighbor tip, not a list.
        - Include a warm, low-pressure referral ask: something like "If you ever know anyone looking to buy or sell, I'd love to help them the way I helped you."
        - End with EXACTLY: "Warmly,\nThe Lifestyle Design Realty Team" — no individual name, no address, no unsubscribe language (the system adds the footer separately).
        - Keep it concise: 130 to 200 words.
        - Return strict JSON with keys: subject, email_body.
        """
        content = self._llm_call(messages=[{"role": "user", "content": textwrap.dedent(prompt).strip()}], temperature=0.86)
        if not content:
            raise ValueError("LLM returned empty closed drip email choices")
        return json.loads(content)

    def generate_congrats_email(self, person: dict, deal_address: str) -> dict:
        """Generate a warm, personal congratulations email for a newly closed deal.

        Signed 'Truly, Peter'. Celebrates the milestone, mentions the address naturally,
        sets up the relationship for future referrals. No local spots — this is a pure
        celebration email sent the same day the deal closes.
        """
        first_name = person.get("firstName") or "there"
        address_context = (
            f"They just closed on their new home at {deal_address}."
            if deal_address
            else "They just closed on their new home."
        )

        prompt = f"""
        You are writing on behalf of the Lifestyle Design Realty team.
        Draft a warm, personal congratulations email to a client who just closed on their home today.

        Client first name: {first_name}
        Context: {address_context}

        Requirements:
        - This is a genuine celebration email — make it feel like the team just heard the news and is genuinely excited.
        - Warm, casual, human tone. Short punchy paragraphs (2-3 sentences max).
        - Use 2-3 emojis naturally (🏡 🎉 🥂 ✨ 🔑 are all great).
        - CRITICAL: Do NOT use dashes (- or --) anywhere.
        - CRITICAL: No bullet points or lists — strictly conversational prose.
        - Celebrate the milestone genuinely. Mention how exciting this moment is.
        - If the address is provided, reference it naturally (e.g. "your new place on Oak Ave").
        - One warm line about being there for them if they ever need anything — repairs, recommendations, anything.
        - Soft, natural close: "And when you're ready — or if any friends are thinking about buying or selling — I'd love to be the first call."
        - End with EXACTLY: "Warmly,\nThe Lifestyle Design Realty Team" — no individual name, no title, no unsubscribe language.
        - Keep it concise: 100 to 160 words.
        - Return strict JSON with keys: subject, email_body.
        """
        content = self._llm_call(messages=[{"role": "user", "content": textwrap.dedent(prompt).strip()}], temperature=0.88)
        if not content:
            raise ValueError("LLM returned empty congrats email choices")
        return json.loads(content)

    def generate_welcome_email(self, person: dict, city: str) -> dict:
        first_name = person.get("firstName") or "there"
        city_instruction = (
            f"The lead appears interested in {city}. Tailor the welcome to that city/area."
            if city and city.lower() not in {"texas", "your area", "any city in texas", "texas/general"}
            else "Speak broadly about helping them find the right home anywhere in Texas."
        )
        prompt = f"""
        You are writing on behalf of the Lifestyle Design Realty team.
        Draft a warm, personal, and highly engaging welcome email to a new real estate lead who just registered or arrived in our system.

        Lead first name: {first_name}
        City/area guidance: {city_instruction}

        Requirements:
        - CRITICAL (anti-phantom): NEVER reference a previous email, message, call, attachment, or conversation unless it appears explicitly in the provided FUB notes. Real prior outreach always appears in the notes (every automated email logs one). If the notes show no prior outreach, write as a natural FIRST touch — do not imply any earlier contact existed.
        - Make this feel like a one-off email someone on the team just wrote on their phone, not a drip, newsletter, or transactional welcome.
        - Write in a highly personal, warm, casual, and human tone. Think "real estate advisor welcoming a friend," not "marketing copywriter."
        - Avoid run-on sentences. Break up the text into very short, punchy, and engaging paragraphs (maximum 2-3 sentences per paragraph).
        - Use emojis naturally throughout the email to make it visually engaging and friendly (aim for 2 to 4 emojis per email, such as 👋, 🏡, ✨, ☕, etc.).
        - CRITICAL STYLE RESTRICTION: Do NOT use dashes (- or --) anywhere in the subject or body of the email.
        - CRITICAL STYLE RESTRICTION: Do NOT use bullet points, numbered lists, or list structures of any kind. Keep it strictly conversational prose.
        - Tailor to the detected city when known. If no city is known, emphasize that we help clients across Texas and can narrow the right city together.
        - Keep it concise: 100 to 150 words, plain text, friendly, and specific enough to invite a reply.
        - Ask exactly one simple question that makes it easy for the lead to respond (e.g., about their timeline, must-have priorities, or if they are looking for a specific neighborhood).
        - End with a warm team sign-off such as "Cheers,\nThe LDR Team" or "Talk soon,\nYour friends at Lifestyle Design Realty". NEVER use any individual person's name. Do not add the company address, legal disclaimer, or unsubscribe language; the system adds the compliance footer separately.
        - Email must include a subject and body.
        - Return strict JSON with keys: subject, email_body.
        """
        content = self._llm_call(messages=[{"role": "user", "content": textwrap.dedent(prompt).strip()}], temperature=0.86)
        if not content:
            raise ValueError("LLM returned empty welcome email choices")
        generated = json.loads(content)
        return generated


    def generate_long_term_nurture_email(
        self,
        person: dict,
        emails_sent: int,
        trigger_snippet: str,
        notes_context: str,
    ) -> dict:
        """Generate a 60-day AI drip email for a lead who replied with a future-timeline intent.

        Rotates between three content types based on emails_sent count:
          0, 3, 6, ... → thinking-of-you + market update
          1, 4, 7, ... → referral ask ("Know anyone looking?")
          2, 5, 8, ... → lifestyle content relevant to their move
        Each email is AI-written fresh — no templates, no repeats.
        """
        first_name = person.get("firstName") or "there"
        person_id = int(person.get("id") or 0)

        # Rotate content type based on how many emails have been sent so far
        content_type = emails_sent % 3  # 0=market, 1=referral, 2=lifestyle

        # Seed a freshness angle to prevent subject/opening repetition
        cycle_seed = f"{person_id}-ltn-{emails_sent}-{dt.datetime.now(timezone.utc).strftime('%Y-%m')}"
        seed_hash = int(hashlib.sha256(cycle_seed.encode('utf-8')).hexdigest(), 16)

        market_angles = [
            "current mortgage rates and what they mean for buyers",
            "local inventory trends and whether now is a good time to buy",
            "how home values in Texas have shifted recently",
            "new construction vs resale — what makes sense for their timeline",
            "how to get pre-approved and what to expect in the process",
        ]
        lifestyle_angles = [
            "what it’s like to live in their target area — restaurants, commute, vibe",
            "tips for making the most of their remaining time before moving",
            "how to start narrowing down neighborhoods for their future move",
            "what questions to ask before choosing a neighborhood",
            "a quick checklist of things to think about before buying",
        ]
        referral_angles = [
            "a warm ask if they know anyone looking to buy or sell in Texas right now",
            "mentioning that referrals are the lifeblood of the business and asking if anyone comes to mind",
            "a casual check-in with a soft ask about friends or family who might be in the market",
        ]

        if content_type == 0:
            angle = market_angles[seed_hash % len(market_angles)]
            content_instruction = (
                f"Focus on a market update angle: {angle}. "
                "Share useful, honest context about the current real estate market in Texas. "
                "Keep it educational and low-pressure. Reference their future move naturally."
            )
        elif content_type == 1:
            angle = referral_angles[seed_hash % len(referral_angles)]
            content_instruction = (
                f"This email should include a warm referral ask: {angle}. "
                "Make the referral ask feel completely natural and friendly, not transactional. "
                "Keep the main body warm and personal, with the referral ask woven in naturally."
            )
        else:
            angle = lifestyle_angles[seed_hash % len(lifestyle_angles)]
            content_instruction = (
                f"Focus on lifestyle content: {angle}. "
                "Help them imagine what their life will look like when they’re ready to move. "
                "Keep it inspiring, warm, and low-pressure."
            )

        safe_notes = notes_context or "No recent notes available."
        safe_trigger = trigger_snippet or "They mentioned they’re not quite ready yet."

        prompt = f"""
        You are writing on behalf of the Lifestyle Design Realty team.
        Draft a warm, personal long-term nurture email to a real estate lead who has indicated they are
        planning to move but are not ready yet.

        Lead first name: {first_name}
        What they said (trigger): {safe_trigger}
        Recent FUB notes context: {safe_notes}
        Email number in drip: {emails_sent + 1} (so this is not the first email they’ve received)
        Content focus for this email: {content_instruction}

        Requirements:
        - CRITICAL (anti-phantom): NEVER reference a previous email, message, call, attachment, or conversation unless it appears explicitly in the provided FUB notes. Real prior outreach always appears in the notes (every automated email logs one). If the notes show no prior outreach, write as a natural FIRST touch — do not imply any earlier contact existed.
        - Make this feel like a one-off email someone on the team just wrote on their phone, not a drip or newsletter.
        - Write in a highly personal, warm, casual, and human tone. Think real estate advisor staying in touch with a friend.
        - Avoid run-on sentences. Break the text into very short, punchy paragraphs (maximum 2-3 sentences per paragraph).
        - Use emojis naturally (aim for 2 to 4 emojis such as 🏡, ✨, ☕, 💪, 🙌, etc.).
        - CRITICAL STYLE RESTRICTION: Do NOT use dashes (- or --) anywhere in the subject or body.
        - CRITICAL STYLE RESTRICTION: Do NOT use bullet points, numbered lists, or list structures. Keep it strictly conversational prose.
        - Write exactly ONE greeting line at the top, for example "Hey {first_name},". Use only the first name.
        - Reference their future timeline naturally and warmly — acknowledge they’re not ready yet without making them feel pressured.
        - Do NOT reference the trigger snippet directly or quote it. Just let it inform the tone.
        - The subject line must be specific and personal. Do not use generic subjects like "Checking in" or "Just following up".
        - Keep it concise: 100 to 160 words, plain text, friendly, and specific enough to invite a reply.
        - Ask exactly one simple, low-pressure question that makes it easy for them to respond.
        - End with a warm team sign-off such as "Cheers,\nThe LDR Team" or "Talk soon,\nYour friends at Lifestyle Design Realty". NEVER use any individual person's name. Do not add the company address, legal disclaimer, or unsubscribe language.
        - Return strict JSON with exactly these keys: subject, email_body.
        """
        content = self._llm_call(messages=[{"role": "user", "content": textwrap.dedent(prompt).strip()}], temperature=0.86)
        if not content:
            raise ValueError("LLM returned empty long-term nurture email choices")
        return json.loads(content)


    def classify_lead_intent(
        self,
        person: dict,
        texts: List[dict],
        emails: List[dict],
        notes: List[dict],
    ) -> dict:
        """Use AI to classify the intent of a lead's most recent inbound communications.

        Returns a dict with keys:
          - intent: one of 'buying_intent' | 'future_timeline' | 'opt_out' | 'none'
          - confidence: int 0-100
          - reason: short plain-English explanation (max 30 words)
          - trigger_snippet: the raw text that triggered the classification (max 300 chars)
          - source: 'Inbound SMS' | 'Inbound Email' | 'Sync Note' | 'none'

        Falls back to {'intent': 'none', 'confidence': 0, 'reason': 'AI unavailable', ...}
        on any error so the caller is never blocked.
        """
        first_name = person.get("firstName") or "the lead"

        # Collect inbound communications into a single context block
        comm_lines: List[str] = []
        for t in texts[:5]:
            if t.get("isIncoming") or t.get("direction") == "inbound":
                body = str(t.get("message") or t.get("body") or "").strip()
                if body:
                    comm_lines.append(f"[Inbound SMS] {body[:400]}")
        for e in emails[:5]:
            if e.get("isIncoming") or e.get("direction") == "inbound":
                body = str(e.get("body") or e.get("subject") or "").strip()
                if body:
                    comm_lines.append(f"[Inbound Email] {body[:400]}")
        for n in notes[:5]:
            raw = str(n.get("body") or n.get("text") or n.get("note") or "").lower()
            if any(marker in raw for marker in ("reply", "inbound", "received", "responded", "texted back")):
                body = str(n.get("body") or n.get("text") or n.get("note") or "").strip()
                if body:
                    comm_lines.append(f"[Sync Note] {body[:400]}")

        if not comm_lines:
            return {"intent": "none", "confidence": 0, "reason": "No inbound communications found", "trigger_snippet": "", "source": "none"}

        communications_block = "\n".join(comm_lines)

        prompt = f"""
        You are a senior real estate CRM analyst working for {self.rules.company_name} in Texas.
        Your job is to read a lead's recent inbound communications and classify their intent into exactly one category.

        Lead first name: {first_name}

        Recent inbound communications (newest first):
        {communications_block}

        CLASSIFICATION TASK:
        Read all communications above and determine the lead's PRIMARY intent. Choose exactly one:

        "opt_out" — The lead wants to stop receiving messages. This includes any form of:
          unsubscribe, stop, opt out, remove me, stop texting, stop emailing, leave me alone,
          I'm not interested (combined with stop/remove language), expressed frustration about
          being contacted, or any clear signal they do not want further outreach.
          IMPORTANT: Assign this ONLY when the intent to stop contact is clear. A lead saying
          "not interested right now" without stop/remove language is NOT an opt-out.

        "buying_intent" — The lead is actively interested in buying or selling NOW or very soon.
          This includes: expressing readiness, asking about price/listings/tours/schedule,
          saying yes to follow-up, asking how much something costs, requesting a call,
          asking about specific properties, asking about the process, or any signal that
          they are ready to engage with an agent immediately.

        "future_timeline" — The lead is genuinely interested in buying or selling but NOT ready yet.
          They have a real estate goal but it is weeks, months, or a year or more away.
          This includes: "not ready yet", "maybe next year", "saving up", "after the holidays",
          "still planning", "a few months away", "next spring", "need more time",
          "not moving yet but will", or any signal of real intent with a delayed timeline.
          IMPORTANT: This is NOT the same as opt-out. The lead still wants to buy/sell — just later.

        "no_longer_looking" — The lead is NO LONGER looking to move to Texas or buy/sell in your area.
          They have moved away, relocated, are no longer in the market, or have explicitly stated
          they are not planning to move to Texas anymore. This is DIFFERENT from opt-out (they are
          not angry or asking to be removed — they are politely informing you of a life change).
          Examples: "I am no longer living in Texas", "I moved to another state", "I've decided
          not to relocate", "we ended up buying somewhere else", "no longer in the market",
          "we moved to Florida", "not planning to move to Texas anymore".
          IMPORTANT: This is NOT opt-out. They may still be a referral source. They just don't
          need your services personally anymore.

        "none" — The communication does not clearly fit any of the above. Examples: a generic
          greeting, a question about something unrelated, a message that is ambiguous, or
          a communication that is outbound (from the agent), not inbound (from the lead).

        CONFIDENCE REQUIREMENT:
        Only assign buying_intent, future_timeline, no_longer_looking, or opt_out if you are at least 75% confident.
        If you are unsure, assign "none".

        Return strict JSON with exactly these keys:
        - intent: one of "opt_out", "buying_intent", "future_timeline", "no_longer_looking", "none"
        - confidence: integer 0-100
        - reason: plain-English explanation of your reasoning, maximum 30 words
        - trigger_snippet: the exact text from the communication that most strongly signals the intent (max 200 chars, empty string if none)
        - source: the channel of the trigger communication: "Inbound SMS", "Inbound Email", "Sync Note", or "none"
        """
        try:
            content = self._llm_call(messages=[{"role": "user", "content": textwrap.dedent(prompt).strip()}], temperature=0.05)
            if not content:
                return {"intent": "none", "confidence": 0, "reason": "Empty AI response", "trigger_snippet": "", "source": "none"}
            parsed = json.loads(content)
            intent = str(parsed.get("intent") or "none").strip().lower()
            confidence = int(parsed.get("confidence") or 0)
            reason = str(parsed.get("reason") or "").strip()
            trigger_snippet = str(parsed.get("trigger_snippet") or "").strip()[:300]
            source = str(parsed.get("source") or "none").strip()
            # Enforce confidence gate
            if intent != "none" and confidence < 75:
                LOGGER.info(
                    "AI intent classifier for person %s: low confidence (%s%%) on '%s' — overriding to 'none'. Reason: %s",
                    person.get("id"), confidence, intent, reason,
                )
                return {"intent": "none", "confidence": confidence, "reason": f"Low confidence ({confidence}%): {reason}", "trigger_snippet": trigger_snippet, "source": source}
            LOGGER.info(
                "AI intent classifier for person %s: intent='%s' confidence=%s%% source='%s' — %s",
                person.get("id"), intent, confidence, source, reason,
            )
            return {"intent": intent, "confidence": confidence, "reason": reason, "trigger_snippet": trigger_snippet, "source": source}
        except Exception as exc:  # noqa: BLE001
            LOGGER.warning("AI intent classifier failed for person %s: %s", person.get("id"), exc)
            return {"intent": "none", "confidence": 0, "reason": f"AI error: {exc}", "trigger_snippet": "", "source": "none"}

    def detect_email_change(self, person: dict, emails: List[dict]) -> dict:
        """AI-powered email address change detector.

        Scans inbound emails for messages where the lead says they have changed
        their email address and provides a new one.  Returns a structured result::

            {
              "changed": bool,
              "new_email": str,          # extracted new address, or ""
              "confidence": int,         # 0-100
              "reason": str,             # plain-English explanation
              "trigger_snippet": str,    # exact excerpt that triggered detection
            }

        A confidence gate of 85 is applied — only very clear, unambiguous
        email-change messages are acted on automatically.
        """
        # Only look at inbound messages
        inbound = [e for e in emails if e.get("isIncoming") or e.get("direction") == "incoming"]
        if not inbound:
            return {"changed": False, "new_email": "", "confidence": 0, "reason": "No inbound emails", "trigger_snippet": ""}

        # Build a compact text block from the most recent 5 inbound emails
        snippets: List[str] = []
        for e in inbound[-5:]:
            body = (e.get("body") or e.get("message") or "").strip()[:600]
            subj = (e.get("subject") or "").strip()
            if body:
                snippets.append(f"[Subject: {subj}]\n{body}" if subj else body)
        if not snippets:
            return {"changed": False, "new_email": "", "confidence": 0, "reason": "No readable inbound email bodies", "trigger_snippet": ""}

        combined = "\n\n---\n\n".join(snippets)
        person_name = f"{person.get('firstName', '')} {person.get('lastName', '')}".strip()

        prompt = f"""
            You are an AI assistant for a real estate CRM.  Your only job right now is to
            detect whether the lead has informed the agent that they have a NEW email address.

            Lead name: {person_name}

            === INBOUND EMAIL TEXT ===
            {combined}
            === END ===

            Carefully read the text above.  Determine:
            1. Did the lead explicitly state they have a new or changed email address?
            2. If yes, what is the new email address they provided?

            Common patterns to detect:
            - "I am no longer using this email. Please contact me at [new email]"
            - "My new email is [new email]"
            - "Please use [new email] going forward"
            - "I changed my email to [new email]"
            - "You can reach me at [new email] instead"
            - "Contact me at [new email]"

            Rules:
            - Only return changed=true if the lead EXPLICITLY provides a new email address.
            - Do NOT infer or guess an email address — it must be clearly stated in the text.
            - The new_email field must be a valid email format (contains @ and a domain).
            - If you are not 85%+ confident, return changed=false.
            - Do NOT flag opt-out messages as email changes.

            Respond ONLY with valid JSON in this exact format:
            {{
              "changed": true or false,
              "new_email": "the.new@email.com or empty string if none",
              "confidence": 0-100,
              "reason": "one sentence explanation",
              "trigger_snippet": "the exact phrase from the email that contains the new address"
            }}
        """
        try:
            content = self._llm_call(messages=[{"role": "user", "content": textwrap.dedent(prompt).strip()}], temperature=0.0)
            if not content:
                return {"changed": False, "new_email": "", "confidence": 0, "reason": "Empty AI response", "trigger_snippet": ""}
            parsed = json.loads(content)
            changed = bool(parsed.get("changed", False))
            new_email = str(parsed.get("new_email") or "").strip().lower()
            confidence = int(parsed.get("confidence") or 0)
            reason = str(parsed.get("reason") or "").strip()
            trigger_snippet = str(parsed.get("trigger_snippet") or "").strip()[:300]
            # Validate email format minimally
            if changed and ("@" not in new_email or "." not in new_email.split("@")[-1]):
                LOGGER.warning(
                    "detect_email_change: AI returned invalid email format for person %s — ignoring",
                    person.get("id"),
                )
                return {"changed": False, "new_email": "", "confidence": confidence,
                        "reason": f"Invalid email format returned by AI: {new_email}", "trigger_snippet": trigger_snippet}
            # Confidence gate: 85% required for auto-update
            if changed and confidence < 85:
                LOGGER.info(
                    "detect_email_change: low confidence (%s%%) for person %s — not acting",
                    confidence, person.get("id"),
                )
                return {"changed": False, "new_email": new_email, "confidence": confidence,
                        "reason": f"Low confidence ({confidence}%): {reason}", "trigger_snippet": trigger_snippet}
            if changed:
                LOGGER.info(
                    "detect_email_change: person %s detected change confidence=%s%%",
                    person.get("id"), confidence,
                )
            return {"changed": changed, "new_email": new_email, "confidence": confidence,
                    "reason": reason, "trigger_snippet": trigger_snippet}
        except Exception as exc:  # noqa: BLE001
            LOGGER.warning("detect_email_change failed for person %s: %s", person.get("id"), exc)
            return {"changed": False, "new_email": "", "confidence": 0,
                    "reason": f"AI error: {exc}", "trigger_snippet": ""}


SMTP_TIMEOUT_SECONDS = 60


class EmailSender:
    def __init__(self, settings: Settings):
        self.settings = settings

    def send(
        self,
        to_email: str,
        subject: str,
        body: str,
        from_email: Optional[str] = None,
        reply_to: Optional[str] = None,
        cc: Optional[List[str]] = None,
        html_body: Optional[str] = None,
        bcc: Optional[List[str]] = None,
    ) -> None:
        selected_from = from_email or self.settings.email_from
        cc = [addr for addr in (cc or []) if addr]
        bcc = [addr for addr in (bcc or []) if addr]
        if self.settings.dry_run:
            LOGGER.info("DRY_RUN email dispatched (subject_len=%d, cc_count=%d, bcc_count=%d)", len(subject), len(cc), len(bcc))
            return
        if not all([self.settings.smtp_host, self.settings.smtp_user, self.settings.smtp_password, selected_from]):
            raise RuntimeError("SMTP settings are incomplete")
        msg = email.message.EmailMessage()
        msg["From"] = selected_from
        if reply_to:
            msg["Reply-To"] = reply_to
        msg["To"] = to_email
        if cc:
            msg["Cc"] = ", ".join(cc)
        if bcc:
            msg["Bcc"] = ", ".join(bcc)
        msg["Subject"] = subject
        # cte="base64" is load-bearing, not a style choice.
        #
        # Left to itself, set_content() picks quoted-printable for these bodies
        # (they carry emoji, and the Tap-to-Text URLs blow past the 78-column
        # line limit). QP is only safe if every reader honours it exactly: the
        # '=' in "?lead_id=1970" goes on the wire as "=3D", and long URLs get
        # soft-wrapped with a trailing '='. Any hop that decodes QP against a
        # body it should have left alone eats the literal '=' plus the two
        # characters after it, and the daily summary's links arrive destroyed:
        #
        #     lead_id=1970  ->  lead_id\x1970     ('=19' read as one octet)
        #     lead_id=694   ->  lead_idi4         ('=69' -> 'i')
        #     lead_id=2159  ->  lead_id!59        ('=21' -> '!')
        #
        # Note which '=' is lost: the structural one between the query key and
        # its value. make_sms_uri() already percent-encodes every param VALUE,
        # so no amount of extra URL-encoding can save that character — it has
        # to stop appearing literally in the transmitted body. base64 does
        # exactly that: the payload is an opaque alphanumeric blob, so a URL's
        # '=' is never on the wire as '=' and there is nothing for a stray QP
        # decode to consume. It is 7-bit clean and universally supported; the
        # ~33% size cost is nothing against links that silently do not work.
        msg.set_content(body, cte="base64")
        if html_body:
            msg.add_alternative(html_body, subtype="html", cte="base64")
        # timeout is REQUIRED: without it smtplib inherits the OS socket
        # default, so a hung SMTP connection stalls the whole daily run until
        # the 120-minute job timeout and every remaining lead goes unsent.
        with smtplib.SMTP(self.settings.smtp_host, self.settings.smtp_port,
                          timeout=SMTP_TIMEOUT_SECONDS) as smtp:
            smtp.starttls()
            smtp.login(self.settings.smtp_user, self.settings.smtp_password)
            smtp.send_message(msg)


class SmsSender:
    def __init__(self, settings: Settings):
        self.settings = settings

    def send(self, to_number: str, body: str) -> str:
        if self.settings.dry_run:
            LOGGER.info("DRY_RUN sms dispatched (body_len=%d)", len(body))
            return "dry-run"
        if not all([self.settings.twilio_account_sid, self.settings.twilio_auth_token, self.settings.twilio_from_number]):
            raise RuntimeError("Twilio settings are incomplete")
        url = f"https://api.twilio.com/2010-04-01/Accounts/{self.settings.twilio_account_sid}/Messages.json"
        response = requests.post(
            url,
            data={"To": to_number, "From": self.settings.twilio_from_number, "Body": body},
            auth=(self.settings.twilio_account_sid, self.settings.twilio_auth_token),
            timeout=30,
        )
        if response.status_code >= 400:
            raise RuntimeError(f"Twilio send failed {response.status_code}: {response.text[:500]}")
        return response.json().get("sid", "sent")


class MarketContextProvider:
    """Simple provider using local static market notes.

    Replace this with MLS, Redfin Data Center imports, RentCast, or a Google Sheet.
    The generator is instructed not to invent precise stats if no context exists.
    """

    def __init__(self, path: str = "config/market_context.json"):
        self.path = path
        self.data: Dict[str, str] = {}
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                self.data = json.load(f)

    def get(self, city: str) -> str:
        return self.data.get(city, self.data.get(city.lower(), ""))


class DealCheckUnavailable(RuntimeError):
    """FUB deals API could not be reached after retry.

    Send-blocking deal checks resolve this in the DO-NOT-SEND direction rather
    than assuming the person has no deals. Mirrors DealCheckUnavailable in
    botHelpers.ts so both languages fail the same way.
    """


_DEAL_FETCH_ATTEMPTS = 2          # initial try + one retry
_DEAL_RETRY_BACKOFF_SECONDS = 1.5
_DEAL_FETCH_FAILED = object()     # cache sentinel — never confuse with []


class RuleEngine:
    def __init__(self, settings: Settings, rules: Rules, fub: FollowUpBossClient, db: AuditDB):
        self.settings = settings
        self.rules = rules
        self.fub = fub
        self.db = db
        self.content = ContentGenerator(settings, rules)
        self.email = EmailSender(settings)
        self.sms = None  # SMS intentionally disabled by owner; email-only automation.
        self.market = MarketContextProvider()
        self._user_cache_by_id: Optional[Dict[int, dict]] = None

    def _fetch_local_spots(self, address: str) -> List[dict]:
        """Use the Manus Maps proxy (Google Places API) to find new/popular spots near the property address.

        Returns up to 5 places (restaurants, bars, cafes, parks) sorted by rating.
        Falls back to empty list on any error so Phase 3 still sends without local data.
        """
        forge_url = os.getenv("BUILT_IN_FORGE_API_URL", "").rstrip("/")
        forge_key = os.getenv("BUILT_IN_FORGE_API_KEY", "")
        if not forge_url or not forge_key:
            LOGGER.warning("Phase 3: BUILT_IN_FORGE_API_URL or BUILT_IN_FORGE_API_KEY not set; skipping local spots lookup")
            return []
        try:
            # Step 1: Geocode the address to get lat/lng
            geo_resp = requests.get(
                f"{forge_url}/v1/maps/proxy/maps/api/geocode/json",
                params={"address": address},
                headers={"Authorization": f"Bearer {forge_key}"},
                timeout=15,
            )
            geo_data = geo_resp.json()
            results = geo_data.get("results", [])
            if not results:
                LOGGER.info("Phase 3: Geocode returned no results for person address")
                return []
            location = results[0]["geometry"]["location"]
            lat, lng = location["lat"], location["lng"]

            # Step 2: Nearby search for restaurants, bars, cafes within 2 miles (~3200m)
            all_spots: List[dict] = []
            for place_type in ["restaurant", "bar", "cafe", "park"]:
                nb_resp = requests.get(
                    f"{forge_url}/v1/maps/proxy/maps/api/place/nearbysearch/json",
                    params={
                        "location": f"{lat},{lng}",
                        "radius": 3200,
                        "type": place_type,
                        "rankby": "prominence",
                    },
                    headers={"Authorization": f"Bearer {forge_key}"},
                    timeout=15,
                )
                spots = nb_resp.json().get("results", [])
                # Filter to only well-rated places (4.0+) with enough reviews
                good_spots = [
                    s for s in spots
                    if s.get("rating", 0) >= 4.0 and s.get("user_ratings_total", 0) >= 10
                ]
                all_spots.extend(good_spots[:3])

            # Deduplicate by place_id, sort by rating desc, return top 5
            seen_ids: set = set()
            unique_spots: List[dict] = []
            for spot in sorted(all_spots, key=lambda x: x.get("rating", 0), reverse=True):
                pid = spot.get("place_id", spot.get("name", ""))
                if pid not in seen_ids:
                    seen_ids.add(pid)
                    unique_spots.append(spot)
                if len(unique_spots) >= 5:
                    break
            LOGGER.info("Phase 3: Found %s local spots for drip email", len(unique_spots))
            return unique_spots
        except Exception as exc:  # noqa: BLE001
            LOGGER.warning("Phase 3: Failed to fetch local spots: %s", exc)
            return []

    def scan_new_closed_leads(self) -> None:
        """Phase 3b: Same-day congratulations email when a lead moves to Closed.

        Runs daily. Fetches all Closed-stage leads whose FUB 'updated' timestamp
        is within the last 26 hours (buffer for timezone drift and late-night closes).
        Skips anyone who already received a congrats email. Signed 'Truly, Peter'.
        """
        if not self.rules.phase3_closed_drip_enabled:
            LOGGER.info("Phase 3b congrats scan is disabled (phase3_closed_drip_enabled: false)")
            return

        LOGGER.info("Phase 3b: Scanning for leads newly moved to Closed in the last 26 hours...")
        cutoff = dt.datetime.now(UTC) - dt.timedelta(hours=26)

        try:
            closed_leads = self.fub.get_people(stage="Closed", fields="allFields", sort="updated", direction="desc", limit=100)
        except Exception as exc:  # noqa: BLE001
            LOGGER.warning("Phase 3b: Failed to fetch recently closed leads: %s", exc)
            return

        sent_count = 0
        for person in closed_leads:
            # FUB returns most-recently-updated first; stop once we're past the 26h window
            updated_raw = person.get("updated") or person.get("updatedAt") or ""
            if updated_raw:
                updated_dt = parse_fub_datetime(updated_raw)
                if updated_dt and updated_dt < cutoff:
                    break  # Sorted desc — everything after this is older
            try:
                result = self.process_congrats_candidate(person)
                if result in ("sent", "dry_run_sent"):
                    sent_count += 1
            except Exception as exc:  # noqa: BLE001
                LOGGER.exception("Phase 3b congrats failed for person %s", person.get("id"))
                self.db.log("closed_congrats", "error", person.get("id"), {"error": str(exc)})
        LOGGER.info("Phase 3b: Completed. Congrats emails sent=%s", sent_count)

    def process_congrats_candidate(self, person: dict) -> str:
        """Send a same-day congratulations email to a newly closed lead."""
        person_id = int(person["id"])

        # Already sent a congrats email to this person
        if self.db.get_congrats_sent(person_id) is not None:
            self.db.log("closed_congrats", "skipped", person_id, {"reason": "already sent"})
            return "skipped"

        # Suppression checks (same as Phase 3 — tag-based only, not stage-based)
        hard_suppress_tags = {
            "do not contact", "dnc", "do not nurture", "no ai email", "do not email",
            "email opt out", "unsubscribe", "unsubscribed", "bounced", "manual review",
            "opt out", "spam", "realtor", "agent", "annual nurture only", "replied - paused",
        }
        all_suppress = hard_suppress_tags.union({t.lower() for t in self.rules.phase2_manual_suppression_tags})
        if self.has_any_tag(person, all_suppress):
            self.db.log("closed_congrats", "suppressed", person_id, {"reason": "suppression tag"})
            return "suppressed"
        if (
            person.get("unsubscribed") or person.get("emailOptOut")
            or person.get("unsubscribedEmail") or person.get("isUnsubscribed")
        ):
            self.db.log("closed_congrats", "suppressed", person_id, {"reason": "FUB unsubscribed flag"})
            return "suppressed"

        # Must have an email address
        emails = [e.get("value") for e in (person.get("emails") or []) if e.get("value")]
        if not emails:
            self.db.log("closed_congrats", "skipped", person_id, {"reason": "no email address"})
            return "skipped"
        to_email = emails[0]

        # Try to get the property address from the Buyers deal room
        deal_address = ""
        try:
            deals = self.fub.get_deals_for_person(person_id)
            buyers_deals = [
                d for d in deals
                if "buyer" in str(d.get("pipelineName") or "").lower()
                or "purchase" in str(d.get("pipelineName") or "").lower()
            ]
            if buyers_deals:
                # Use the most recently updated deal's name as the address
                buyers_deals.sort(key=lambda d: d.get("updated") or d.get("updatedAt") or "", reverse=True)
                deal_address = str(buyers_deals[0].get("name") or "").strip()
        except Exception as exc:  # noqa: BLE001
            LOGGER.warning("Phase 3b: Could not fetch deals for person %s: %s", person_id, exc)

        # Generate the congratulations email
        generated = self.content.generate_congrats_email(person, deal_address)
        subject = generated.get("subject", "Congratulations on your new home! 🏡")
        email_body = generated.get("email_body", "")
        if not email_body:
            self.db.log("closed_congrats", "error", person_id, {"reason": "empty LLM response"})
            return "error"
        full_body = append_email_footer(email_body, self.rules)
        from_display = f"Lifestyle Design Realty <{self.rules.team_email}>"
        self.email.send(
            to_email=to_email,
            subject=subject,
            body=full_body,
            from_email=from_display,
            reply_to=self.rules.owner_email,
            html_body=build_pond_email_html(email_body, self.rules),
        )
        # Log the note in FUB
        note_body = f"Congratulations email sent to {to_email}"
        if deal_address:
            note_body += f" re: {deal_address}"
        self.fub.add_note(person_id, "Automation: Congrats Email Sent", note_body)

        # Record in audit DB so we never send twice
        self.db.upsert_congrats(person_id, deal_address, subject)
        _send_status = "dry_run_sent" if self.settings.dry_run else "sent"
        self.db.log("closed_congrats", _send_status, person_id, {"to": to_email, "subject": subject, "deal_address": deal_address, "contact_name": person_name(person)})
        LOGGER.info("Phase 3b: Congrats email sent for person %s", person_id)
        return _send_status

    def scan_closed_drip(self) -> None:
        """Phase 3: Quarterly check-in email for Closed, Past Client, and Sphere leads.

        Pulls the property address from the FUB Buyers deal room, fetches nearby spots
        via Google Places, generates a hyper-local LLM email, and sends it every 90 days.
        Signed 'Truly, Peter' always. Respects all suppression tags.
        """
        if not self.rules.phase3_closed_drip_enabled:
            LOGGER.info("Phase 3 closed drip is disabled by rules.yaml (phase3_closed_drip_enabled: false)")
            return

        # Fetch all people in eligible stages
        candidates: List[dict] = []
        for stage in self.rules.phase3_eligible_stages:
            try:
                stage_people = self.fub.get_people(stage=stage, fields="allFields")
                candidates.extend(stage_people)
                LOGGER.info("Phase 3: Fetched %s leads in stage '%s'", len(stage_people), stage)
            except Exception as exc:  # noqa: BLE001
                LOGGER.warning("Phase 3: Failed to fetch leads for stage '%s': %s", stage, exc)

        # Deduplicate by person_id
        seen_ids: set = set()
        unique_candidates: List[dict] = []
        for p in candidates:
            pid = p.get("id")
            if pid and pid not in seen_ids:
                seen_ids.add(pid)
                unique_candidates.append(p)

        LOGGER.info("Phase 3: %s unique candidates across all eligible stages", len(unique_candidates))

        sent_count = 0
        cap = max(0, int(self.rules.phase3_max_emails_per_run))

        for person in unique_candidates:
            if cap and sent_count >= cap:
                self.db.log("closed_drip", "launch_cap_reached", None, {"cap": cap})
                LOGGER.info("Phase 3: Daily cap of %s reached", cap)
                break
            try:
                status = self.process_closed_drip_candidate(person)
                if status in ("sent", "dry_run_sent"):
                    sent_count += 1
            except Exception as exc:  # noqa: BLE001
                LOGGER.exception("Phase 3 closed drip failed for person %s", person.get("id"))
                self.db.log("closed_drip", "error", person.get("id"), {"error": str(exc)})
        LOGGER.info("Phase 3: Completed. Sent=%s", sent_count)

    def process_closed_drip_candidate(self, person: dict) -> str:
        """Process a single closed/past-client lead for Phase 3 quarterly drip."""
        person_id = int(person["id"])
        stage = str(person.get("stage", ""))

        # Rule C: Lease listing silenced leads get TOTAL SILENCE — no Phase 3 drip
        if self._is_lease_listing_silenced(person_id):
            self.db.log("closed_drip", "suppressed", person_id, {"reason": "lease listing silenced (closed Residential Lease Listing, no purchase deal)"})
            return "suppressed"
        # Source-based exclusion (cheap local check)
        excluded_src = self._is_excluded_source(person)
        if excluded_src:
            self.db.log("closed_drip", "suppressed", person_id, {"reason": f"excluded source: {excluded_src}"})
            return "suppressed"
        # SOI Total Silence (cheap local check)
        soi_rule = self._is_soi_silenced(person)
        if soi_rule:
            self.db.log("closed_drip", "soi_silenced", person_id, {"reason": f"soi_silenced (rule matched: {soi_rule})"})
            return "suppressed"

        # Suppression checks — Phase 3 intentionally targets Closed/Past Client/Sphere stages,
        # so we do NOT call is_excluded() (which blocks those stages for pond reassignment).
        # Instead we check only the tags that should suppress email outreach.
        hard_suppress_tags = {
            "do not contact", "dnc", "do not nurture", "no ai email", "do not email",
            "email opt out", "unsubscribe", "unsubscribed", "bounced", "manual review",
            "opt out", "spam", "realtor", "agent", "annual nurture only", "replied - paused",
        }
        all_suppress = hard_suppress_tags.union({t.lower() for t in self.rules.phase2_manual_suppression_tags})
        if self.has_any_tag(person, all_suppress):
            self.db.log("closed_drip", "suppressed", person_id, {"reason": "manual suppression tag", "stage": stage})
            return "suppressed"
        # Also respect FUB's built-in unsubscribe fields
        if (
            person.get("unsubscribed") or person.get("emailOptOut")
            or person.get("unsubscribedEmail") or person.get("isUnsubscribed")
        ):
            self.db.log("closed_drip", "suppressed", person_id, {"reason": "FUB unsubscribed flag", "stage": stage})
            return "suppressed"

        # Rule B: Deal-based Phase 3 eligibility (OR with stage-based)
        # Person qualifies if they're in an eligible stage OR have a closed purchase deal
        has_eligible_stage = stage.lower() in {s.lower() for s in self.rules.phase3_eligible_stages}
        has_purchase_deal = self._has_closed_purchase_deal(person_id)
        if not has_eligible_stage and not has_purchase_deal:
            self.db.log("closed_drip", "suppressed", person_id, {"reason": f"stage '{stage}' not eligible and no closed purchase deal"})
            return "suppressed"

        # Cadence check: only send every 90 days
        last_sent = self.db.get_last_closed_drip(person_id)
        if last_sent and dt.datetime.now(UTC) - last_sent < dt.timedelta(days=self.rules.phase3_cadence_days):
            days_since = (dt.datetime.now(UTC) - last_sent).days
            self.db.log("closed_drip", "skipped", person_id, {"reason": f"cadence cap ({days_since}d < {self.rules.phase3_cadence_days}d)"})
            return "skipped"

        # Must have an email address
        emails = person.get("emails") or []
        if not self.rules.email_outreach_enabled or not emails:
            self.db.log("closed_drip", "suppressed", person_id, {"reason": "no email or email outreach disabled"})
            return "suppressed"

        if self.has_any_tag(person, self.rules.email_opt_out_tags):
            self.db.log("closed_drip", "suppressed", person_id, {"reason": "email opt-out tag"})
            return "suppressed"

        # Pull the property address from FUB Buyers pipeline deals
        deal_address = ""
        close_date = None
        try:
            deals = self.fub.get_deals_for_person(person_id)
            # Prefer Buyers pipeline closed deals; fall back to any deal with an address-like name
            buyers_closed = [
                d for d in deals
                if "buyer" in d.get("pipelineName", "").lower()
                and d.get("stageName", "").lower() == "closed"
            ]
            if buyers_closed:
                best_deal = sorted(buyers_closed, key=lambda d: d.get("projectedCloseDate") or "", reverse=True)[0]
                deal_address = best_deal.get("name", "")
                close_date = best_deal.get("projectedCloseDate")
            elif deals:
                # Fallback: use the most recent deal name that looks like an address (starts with a number)
                address_deals = [d for d in deals if re.match(r"^\d", d.get("name", ""))]
                if address_deals:
                    deal_address = address_deals[0].get("name", "")
                    close_date = address_deals[0].get("projectedCloseDate")
        except Exception as exc:  # noqa: BLE001
            LOGGER.warning("Phase 3: Could not fetch deals for person %s: %s", person_id, exc)

        # Fetch local spots near the property address
        local_spots: List[dict] = []
        if deal_address:
            local_spots = self._fetch_local_spots(deal_address)

        # Generate the email
        generated = self.content.generate_closed_drip_email(
            person=person,
            deal_address=deal_address,
            close_date=close_date,
            local_spots=local_spots,
        )

        to_email = emails[0].get("value") or emails[0].get("email") if emails else None
        if not to_email:
            self.db.log("closed_drip", "suppressed", person_id, {"reason": "no valid email address"})
            return "suppressed"

        self.email.send(
            to_email,
            generated["subject"],
            append_email_footer(generated["email_body"], self.rules),
            from_email=f"Lifestyle Design Realty <{self.rules.team_email}>",
            reply_to=self.rules.owner_email,
            html_body=build_pond_email_html(generated["email_body"], self.rules),
        )
        # Log a note in FUB
        try:
            note_body = (
                f"Quarterly check-in email sent via Phase 3 automation.\n\n"
                f"Subject: \"{generated.get('subject', '')}\"\n"
                f"Property: {deal_address or 'N/A'}\n"
                f"Local spots featured: {', '.join(s.get('name','') for s in local_spots[:3]) or 'None'}"
            )
            self.fub.add_note(person_id, "Quarterly Check-In Email Sent", note_body)
        except Exception as note_exc:  # noqa: BLE001
            LOGGER.warning("Phase 3: Failed to log FUB note for person %s: %s", person_id, note_exc)

        self.db.upsert_closed_drip(person_id, deal_address, generated["subject"], generated["email_body"])
        _send_status = "dry_run_sent" if self.settings.dry_run else "sent"
        self.db.log("closed_drip", _send_status, person_id, {
            "stage": stage,
            "deal_address": deal_address,
            "subject": generated.get("subject"),
            "local_spots_count": len(local_spots),
            "contact_name": person_name(person),
        })
        LOGGER.info("Phase 3: Sent quarterly drip to person %s (stage=%s)", person_id, stage)
        return _send_status

    def scan_long_term_nurture_drip(self) -> None:
        """Long-Term Nurture Drip: Send a personalized AI email every 60 days to leads tagged
        'long-term-nurture' (i.e., leads who replied with a future-timeline intent).

        Fetches all leads with the suppression/enrollment tag from FUB, checks the 60-day
        cadence, generates a fresh AI email (rotating between market update, referral ask,
        and lifestyle content), sends it, and logs the send to the audit DB and FUB notes.
        """
        if not self.rules.long_term_nurture_enabled:
            LOGGER.info("Long-term nurture drip is disabled by rules.yaml (long_term_nurture_enabled: false)")
            return

        LOGGER.info("Long-term nurture drip: fetching leads tagged '%s'...", self.rules.long_term_nurture_suppression_tag)

        try:
            candidates = self.fub.get_people(
                tags=self.rules.long_term_nurture_suppression_tag,
                fields="allFields",
            )
        except Exception as exc:  # noqa: BLE001
            LOGGER.warning("Long-term nurture drip: failed to fetch candidates: %s", exc)
            return

        LOGGER.info("Long-term nurture drip: %s candidate(s) found.", len(candidates))

        sent_count = 0
        cap = max(0, int(self.rules.long_term_nurture_max_emails_per_run))

        for person in candidates:
            if cap and sent_count >= cap:
                self.db.log("long_term_nurture_drip", "launch_cap_reached", None, {"cap": cap})
                LOGGER.info("Long-term nurture drip: daily cap of %s reached.", cap)
                break
            try:
                status = self.process_long_term_nurture_candidate(person)
                if status in ("sent", "dry_run_sent"):
                    sent_count += 1
            except Exception as exc:  # noqa: BLE001
                LOGGER.exception("Long-term nurture drip failed for person %s", person.get("id"))
                self.db.log("long_term_nurture_drip", "error", person.get("id"), {"error": str(exc)})
        LOGGER.info("Long-term nurture drip: completed. Sent=%s", sent_count)

    def process_long_term_nurture_candidate(self, person: dict) -> str:
        """Process a single long-term nurture lead for the 60-day AI drip."""
        person_id = int(person["id"])

        # Suppression checks — tag-based only (stage is intentionally 'Nurture', not excluded)
        hard_suppress_tags = {
            "do not contact", "dnc", "do not nurture", "no ai email", "do not email",
            "email opt out", "unsubscribe", "unsubscribed", "bounced", "manual review",
            "opt out", "spam", "realtor", "agent", "annual nurture only", "replied - paused",
        }
        all_suppress = hard_suppress_tags.union({t.lower() for t in self.rules.phase2_manual_suppression_tags})
        if self.has_any_tag(person, all_suppress):
            self.db.log("long_term_nurture_drip", "suppressed", person_id, {"reason": "suppression tag"})
            return "suppressed"

        # Respect FUB built-in unsubscribe fields
        if (
            person.get("unsubscribed") or person.get("emailOptOut")
            or person.get("unsubscribedEmail") or person.get("isUnsubscribed")
        ):
            self.db.log("long_term_nurture_drip", "suppressed", person_id, {"reason": "FUB unsubscribed flag"})
            return "suppressed"

        # Must have an email address
        email_list = person.get("emails") or []
        if not self.rules.email_outreach_enabled or not email_list:
            self.db.log("long_term_nurture_drip", "suppressed", person_id, {"reason": "no email or email outreach disabled"})
            return "suppressed"

        to_email = email_list[0].get("value") or email_list[0].get("email") if email_list else None
        if not to_email:
            self.db.log("long_term_nurture_drip", "suppressed", person_id, {"reason": "no valid email address"})
            return "suppressed"

        # Cadence check: only send every long_term_nurture_cadence_days (default 60)
        enrollment = self.db.get_long_term_nurture_enrollment(person_id)
        emails_sent = int((enrollment or {}).get("emails_sent") or 0)
        last_sent_raw = (enrollment or {}).get("last_sent_at")
        if last_sent_raw:
            last_sent_dt = parse_dt(last_sent_raw)
            if last_sent_dt and dt.datetime.now(UTC) - last_sent_dt < dt.timedelta(days=self.rules.long_term_nurture_cadence_days):
                days_since = (dt.datetime.now(UTC) - last_sent_dt).days
                self.db.log("long_term_nurture_drip", "skipped", person_id, {
                    "reason": f"cadence cap ({days_since}d < {self.rules.long_term_nurture_cadence_days}d)"
                })
                return "skipped"

        # Fetch recent notes for AI context
        notes = self.safe_get_notes(person_id)
        notes_context_parts: List[str] = []
        for idx, note in enumerate(notes[:10], 1):
            raw = str(note.get("body") or note.get("text") or note.get("note") or "")
            cleaned = re.sub(r"<[^>]+>", " ", raw)
            cleaned = re.sub(r"\s+", " ", cleaned).strip()
            if cleaned:
                notes_context_parts.append(f"{idx}. {cleaned[:400]}")
        notes_context = "\n".join(notes_context_parts) if notes_context_parts else ""

        trigger_snippet = (enrollment or {}).get("trigger_snippet") or ""

        # Generate the AI email
        generated = self.content.generate_long_term_nurture_email(
            person=person,
            emails_sent=emails_sent,
            trigger_snippet=trigger_snippet,
            notes_context=notes_context,
        )
        subject = generated.get("subject", "Thinking of you 🏡")
        email_body = generated.get("email_body", "")
        if not email_body:
            self.db.log("long_term_nurture_drip", "error", person_id, {"reason": "empty LLM response"})
            return "error"

        # Send the email
        self.email.send(
            to_email,
            subject,
            append_email_footer(email_body, self.rules),
            from_email=f"Lifestyle Design Realty <{self.rules.team_email}>",
            reply_to=self.rules.owner_email,
            html_body=build_pond_email_html(email_body, self.rules),
        )
        # Log a FUB note
        try:
            fub_note = (
                f"Long-term nurture drip email #{emails_sent + 1} sent.\n\n"
                f"Subject: \"{subject}\"\n"
                f"Sent to: {to_email}"
            )
            self.fub.add_note(person_id, "Long-Term Nurture Email Sent", fub_note)
        except Exception as note_exc:  # noqa: BLE001
            LOGGER.warning("Long-term nurture drip: failed to log FUB note for person %s: %s", person_id, note_exc)

        # Update drip log
        self.db.upsert_long_term_nurture_drip(person_id, subject, email_body)
        _send_status = "dry_run_sent" if self.settings.dry_run else "sent"
        self.db.log("long_term_nurture_drip", _send_status, person_id, {
            "to": to_email,
            "subject": subject,
            "email_number": emails_sent + 1,
            "contact_name": person_name(person),
        })
        LOGGER.info(
            "Long-term nurture drip: sent email #%s to person %s (%s)",
            emails_sent + 1, person_id, to_email
        )
        return _send_status

    # ══════════════════════════════════════════════════════════════════════════════
    # SELLER NURTURE TRACK
    # ══════════════════════════════════════════════════════════════════════════════

    def scan_seller_nurture(self) -> None:
        """Seller Nurture Track: Send personalized AI emails to pond leads tagged 'Seller Lead'.

        5-email sequence (days 0/4/10/18/30) then monthly market updates.
        Email only — no texting. Uses same sending conventions as all other bots.
        """
        LOGGER.info("Seller nurture: scanning GLOBALLY for leads tagged '%s'...", SELLER_LEAD_TAG)

        # Fetch ALL leads tagged "Seller Lead" globally — not pond-restricted.
        # LDR-Seller-Finder creates FUB people without pond assignment, so we must
        # search by tag alone to capture all seller leads regardless of pond status.
        all_seller_candidates = []
        try:
            leads = self.fub.get_people(tags=SELLER_LEAD_TAG, fields="allFields")
            all_seller_candidates.extend(leads)
        except Exception as exc:  # noqa: BLE001
            LOGGER.warning("Seller nurture: failed to fetch seller leads globally: %s", exc)

        # Deduplicate by person_id
        seen_ids = set()
        candidates = []
        for p in all_seller_candidates:
            pid = int(p.get("id", 0))
            if pid and pid not in seen_ids:
                seen_ids.add(pid)
                candidates.append(p)

        LOGGER.info("Seller nurture: %s candidate(s) found with tag '%s' globally.", len(candidates), SELLER_LEAD_TAG)

        # Daily cap ramps weekly from rules.seller_daily_cap_ramp (e.g. [25,25,50,50]),
        # anchored to the first seller nurture send ever, then holds at the last value.
        first_send_at = self.db.get_seller_first_send_at()
        cap = ramp_daily_cap(self.rules.seller_daily_cap_ramp, first_send_at)
        # Seed from what has ALREADY gone out today rather than starting at 0.
        # A local per-run counter is not a daily cap — a manual dispatch or a
        # re-run of a failed job would hand out a second full cap the same day.
        day_start = dt.datetime.now(UTC).replace(
            hour=0, minute=0, second=0, microsecond=0).isoformat()
        already_sent_today = self.db.count_seller_sends_since(day_start)
        sent_count = already_sent_today
        LOGGER.info(
            "Seller nurture: today's daily cap = %s (ramp %s, anchor %s, already sent today %s)",
            cap, self.rules.seller_daily_cap_ramp,
            first_send_at.isoformat() if first_send_at else "none (week 0)",
            already_sent_today,
        )

        for person in candidates:
            if sent_count >= cap:
                self.db.log(SELLER_NURTURE_AUDIT_ACTION, "daily_cap_reached", None, {
                    "cap": cap, "ramp": self.rules.seller_daily_cap_ramp,
                    "already_sent_today": already_sent_today,
                })
                LOGGER.info("Seller nurture: daily cap of %s reached (%s already sent today).",
                            cap, already_sent_today)
                break
            try:
                status = self.process_seller_nurture_candidate(person)
                if status in ("sent", "dry_run_sent"):
                    sent_count += 1
            except Exception as exc:  # noqa: BLE001
                LOGGER.exception("Seller nurture failed for person %s", person.get("id"))
                self.db.log(SELLER_NURTURE_AUDIT_ACTION, "error", person.get("id"), {"error": str(exc)})

        LOGGER.info("Seller nurture: completed. Sent this run=%s (today total=%s, cap=%s)",
                    sent_count - already_sent_today, sent_count, cap)

    def process_seller_nurture_candidate(self, person: dict) -> str:
        """Process a single seller lead for the nurture drip.

        Returns: 'sent', 'dry_run_sent', 'skipped', 'suppressed', or 'error'
        """
        person_id = int(person["id"])

        # ── Suppression checks ──
        # Seller track suppression: all standard tags EXCEPT 'dnc' (email-only track, DNC only blocks non-email)
        all_suppress = SELLER_SUPPRESS_TAGS.union({t.lower() for t in self.rules.phase2_manual_suppression_tags})
        if self.has_any_tag(person, all_suppress):
            self.db.log(SELLER_NURTURE_AUDIT_ACTION, "suppressed", person_id, {"reason": "suppression tag"})
            return "suppressed"

        # Respect FUB built-in unsubscribe fields
        if (
            person.get("unsubscribed") or person.get("emailOptOut")
            or person.get("unsubscribedEmail") or person.get("isUnsubscribed")
        ):
            self.db.log(SELLER_NURTURE_AUDIT_ACTION, "suppressed", person_id, {"reason": "FUB unsubscribed flag"})
            return "suppressed"

        # Check for unsubscribed emails in the emails list
        emails_list = person.get("emails") or []
        for email_dict in emails_list:
            if isinstance(email_dict, dict):
                if email_dict.get("unsubscribed") or email_dict.get("isUnsubscribed") or email_dict.get("optOut"):
                    self.db.log(SELLER_NURTURE_AUDIT_ACTION, "suppressed", person_id, {"reason": "email unsubscribed"})
                    return "suppressed"

        # Source-based exclusion (e.g. Zillow Rentals — never touch, stays on Steven)
        excluded_src = self._is_excluded_source(person)
        if excluded_src:
            self.db.log(SELLER_NURTURE_AUDIT_ACTION, "suppressed", person_id, {"reason": f"excluded source: {excluded_src}"})
            return "suppressed"

        # SOI silence check
        soi_reason = self._is_soi_silenced(person)
        if soi_reason:
            self.db.log(SELLER_NURTURE_AUDIT_ACTION, "suppressed", person_id, {"reason": f"SOI silenced: {soi_reason}"})
            return "suppressed"

        # Must have an email address — with bounce fallback rotation
        all_emails = get_all_lead_emails(person)
        if not all_emails:
            self.db.log(SELLER_NURTURE_AUDIT_ACTION, "suppressed", person_id, {"reason": "no email"})
            return "suppressed"
        bounced_addresses = self.db.get_seller_bounced_emails(person_id)
        to_email = select_send_address(all_emails, bounced_addresses)
        if not to_email:
            # All addresses exhausted — suppress as bounced
            self.db.log(SELLER_NURTURE_AUDIT_ACTION, "suppressed", person_id, {
                "reason": "all email addresses bounced",
                "bounced_addresses": bounced_addresses,
                "total_on_record": len(all_emails),
            })
            return "suppressed"

        # ── Enrollment & cadence check ──
        enrollment = self.db.get_seller_nurture_enrollment(person_id)
        if enrollment:
            emails_sent = int(enrollment.get("emails_sent") or 0)
            enrolled_at_str = enrollment.get("enrolled_at")
            last_sent_raw = enrollment.get("last_sent_at")
        else:
            emails_sent = 0
            enrolled_at_str = None
            last_sent_raw = None

        # Determine which email to send next
        if emails_sent < SELLER_SEQUENCE_LENGTH:
            # Still in the 5-email sequence
            if enrolled_at_str:
                enrolled_dt = parse_fub_datetime(enrolled_at_str)
                if enrolled_dt:
                    days_since_enrollment = (dt.datetime.now(UTC) - enrolled_dt).days
                    required_days = SELLER_SEQUENCE_SCHEDULE.get(emails_sent, 999)
                    if days_since_enrollment < required_days:
                        self.db.log(SELLER_NURTURE_AUDIT_ACTION, "skipped", person_id, {
                            "reason": f"cadence: day {days_since_enrollment} < required day {required_days} for email #{emails_sent + 1}"
                        })
                        return "skipped"
            # First email (not yet enrolled) — enroll now
            if not enrollment:
                notes = self.safe_get_notes(person_id)
                prop_addr, neighborhood = extract_property_address_from_notes(notes)
                self.db.enroll_seller_nurture(person_id, prop_addr, neighborhood)
                enrollment = self.db.get_seller_nurture_enrollment(person_id)
        else:
            # Post-sequence long-tail: every rules.seller_longtail_cadence_days
            # (default 21 = every 3 weeks), with rotating angles.
            longtail_days = int(getattr(self.rules, "seller_longtail_cadence_days", SELLER_MONTHLY_CADENCE_DAYS) or SELLER_MONTHLY_CADENCE_DAYS)
            if last_sent_raw:
                last_sent_dt = parse_fub_datetime(last_sent_raw)
                if last_sent_dt and dt.datetime.now(UTC) - last_sent_dt < dt.timedelta(days=longtail_days):
                    days_since = (dt.datetime.now(UTC) - last_sent_dt).days
                    self.db.log(SELLER_NURTURE_AUDIT_ACTION, "skipped", person_id, {
                        "reason": f"long-tail cadence: {days_since}d < {longtail_days}d"
                    })
                    return "skipped"

        # ── Fetch notes for AI context ──
        notes = self.safe_get_notes(person_id)
        notes_context_parts: List[str] = []
        for idx, note in enumerate(notes[:10], 1):
            raw = str(note.get("body") or note.get("text") or note.get("note") or "")
            cleaned = re.sub(r"<[^>]+>", " ", raw)
            cleaned = re.sub(r"\s+", " ", cleaned).strip()
            if cleaned:
                notes_context_parts.append(f"{idx}. {cleaned[:400]}")
        notes_context = "\n".join(notes_context_parts) if notes_context_parts else ""

        # Get property address from enrollment or extract fresh
        prop_addr = (enrollment or {}).get("property_address") or ""
        neighborhood = (enrollment or {}).get("neighborhood") or ""
        if not prop_addr and not neighborhood:
            prop_addr, neighborhood = extract_property_address_from_notes(notes)

        # ── LLM skip check (same as buyer track) ──
        should_skip, skip_reason = self.content.should_skip_lead_llm(person, notes)
        if should_skip:
            self.db.log(SELLER_NURTURE_AUDIT_ACTION, "skipped", person_id, {"reason": f"LLM skip: {skip_reason}"})
            return "skipped"

        # ── Generate the AI email ──
        generated = generate_seller_email(
            llm_call_fn=self.content._llm_call,
            person=person,
            email_number=emails_sent,
            property_address=prop_addr,
            neighborhood=neighborhood,
            notes_context=notes_context,
            rules=self.rules,
        )
        subject = generated.get("subject", "Your home's value \U0001f3e1")
        email_body = generated.get("email_body", "")
        if not email_body:
            self.db.log(SELLER_NURTURE_AUDIT_ACTION, "error", person_id, {"reason": "empty LLM response"})
            return "error"

        # ── Send the email (with Peter Allen signature block) ──
        seller_plaintext = build_seller_email_plaintext(email_body, self.rules)
        seller_html = build_seller_email_html(email_body, self.rules)
        # BCC every other live (non-bounced) address on the FUB record so all of
        # the lead's inboxes receive the same single message (per Peter), plus
        # Peter's standing BCC copy. One To: address, one send, no duplicates.
        _bounced_lower = {b.lower() for b in bounced_addresses}
        _seen_bcc = {to_email.lower(), self.rules.owner_email.lower()}
        extra_bcc: list[str] = []
        for addr in all_emails:
            addr_l = addr.lower()
            if addr_l in _seen_bcc or addr_l in _bounced_lower:
                continue
            _seen_bcc.add(addr_l)
            extra_bcc.append(addr)
        bcc_list = extra_bcc + (
            [self.rules.owner_email] if to_email.lower() != self.rules.owner_email.lower() else []
        )
        # Claim this exact (lead, email #) BEFORE handing off to SMTP. The drip
        # row is only bumped after the send returns, so without this a crash in
        # between makes the next run re-send the same email to the same person.
        if not self.db.claim_seller_send(person_id, emails_sent):
            self.db.log(SELLER_NURTURE_AUDIT_ACTION, "skipped", person_id, {
                "reason": f"email #{emails_sent + 1} already claimed — a previous run "
                          "sent it (or crashed after sending); not re-sending",
            })
            LOGGER.warning(
                "Seller nurture: email #%s for person %s already claimed — skipping "
                "to avoid a duplicate send", emails_sent + 1, person_id)
            return "skipped"
        try:
            self.email.send(
                to_email,
                subject,
                seller_plaintext,
                from_email=f"Lifestyle Design Realty <{self.rules.team_email}>",
                reply_to=self.rules.owner_email,
                html_body=seller_html,
                bcc=bcc_list,
            )
        except Exception:
            # The send raised, so nothing was delivered — release the claim so
            # this email is retried. (A hard crash keeps the claim on purpose.)
            self.db.release_seller_send_claim(person_id, emails_sent)
            raise

        # ── Log FUB note ──
        try:
            fub_note = (
                f"\U0001f3e0 Seller Nurture email #{emails_sent + 1} sent.\n\n"
                f"Subject: \"{subject}\"\n"
                f"Sent to: {to_email}\n"
                + (f"BCC'd (lead's other addresses): {', '.join(extra_bcc)}\n" if extra_bcc else "")
                + f"Track: Seller Nurture (5-email sequence + monthly)"
            )
            self.fub.add_note(person_id, "Automation: Seller Nurture Email Sent", fub_note)
        except Exception as note_exc:  # noqa: BLE001
            LOGGER.warning("Seller nurture: failed to log FUB note for person %s: %s", person_id, note_exc)

        # ── Update drip log ──
        self.db.upsert_seller_nurture_drip(person_id, subject, email_body, prop_addr, neighborhood)
        _send_status = "dry_run_sent" if self.settings.dry_run else "sent"
        _audit_details = {
            "to": to_email,
            "subject": subject,
            "email_number": emails_sent + 1,
            "property_address": prop_addr,
            "neighborhood": neighborhood,
            "contact_name": person_name(person),
        }
        if emails_sent >= SELLER_SEQUENCE_LENGTH:
            _audit_details["longtail_angle"] = longtail_angle_for(emails_sent)
        self.db.log(SELLER_NURTURE_AUDIT_ACTION, _send_status, person_id, _audit_details)
        LOGGER.info(
            "Seller nurture: sent email #%s to person %s (%s)",
            emails_sent + 1, person_id, to_email
        )
        return _send_status

    def handle_seller_bounce(self, person_id: int, bounced_email: str) -> str:
        """Handle a bounce for a seller nurture lead.

        Called by the bounce handler when a seller nurture email bounces.
        Marks the address as dead, rotates to the next address if available,
        logs a FUB note, and suppresses if all addresses are exhausted.

        Returns: 'rotated', 'exhausted', or 'error'
        """
        try:
            # Mark this address as bounced
            self.db.mark_seller_email_bounced(person_id, bounced_email)
            LOGGER.info("Seller bounce rotation: marked %s as bounced for person %s", bounced_email, person_id)

            # Fetch the person to see all available addresses
            person = self.fub.get_person(person_id)
            if not person:
                self.db.log(SELLER_BOUNCE_ROTATION_ACTION, "error", person_id, {
                    "reason": "person not found in FUB",
                    "bounced_email": bounced_email,
                })
                return "error"

            all_emails = get_all_lead_emails(person)
            bounced_addresses = self.db.get_seller_bounced_emails(person_id)
            next_email = select_send_address(all_emails, bounced_addresses)

            exhausted = next_email is None
            note_subject, note_body = format_rotation_fub_note(
                bounced_email=bounced_email,
                new_email=next_email,
                total_addresses=len(all_emails),
                exhausted=exhausted,
            )

            # Log FUB note documenting the rotation
            try:
                self.fub.add_note(person_id, note_subject, note_body)
            except Exception as note_exc:  # noqa: BLE001
                LOGGER.warning("Seller bounce rotation: failed to log FUB note for person %s: %s", person_id, note_exc)

            if exhausted:
                # All addresses dead — tag as bounced for suppression
                try:
                    current_tags = person.get("tags") or []
                    if "bounced" not in [t.lower() for t in current_tags]:
                        self.fub.update_person(person_id, {"tags": current_tags + ["bounced"]})
                except Exception as tag_exc:  # noqa: BLE001
                    LOGGER.warning("Seller bounce rotation: failed to add bounced tag for person %s: %s", person_id, tag_exc)
                self.db.log(SELLER_BOUNCE_ROTATION_ACTION, "exhausted", person_id, {
                    "bounced_email": bounced_email,
                    "all_bounced": bounced_addresses,
                    "total_on_record": len(all_emails),
                })
                LOGGER.info("Seller bounce rotation: ALL addresses exhausted for person %s. Suppressed.", person_id)
                return "exhausted"
            else:
                self.db.log(SELLER_BOUNCE_ROTATION_ACTION, "rotated", person_id, {
                    "bounced_email": bounced_email,
                    "next_email": next_email,
                    "total_on_record": len(all_emails),
                    "total_bounced": len(bounced_addresses),
                })
                LOGGER.info(
                    "Seller bounce rotation: rotated person %s from %s to %s",
                    person_id, bounced_email, next_email
                )
                return "rotated"
        except Exception as exc:  # noqa: BLE001
            LOGGER.exception("Seller bounce rotation failed for person %s", person_id)
            self.db.log(SELLER_BOUNCE_ROTATION_ACTION, "error", person_id, {
                "bounced_email": bounced_email,
                "error": str(exc),
            })
            return "error"

    def run_daily_scans(self) -> None:
        # Safeguard: Check if daily scans have already completed successfully today in the local timezone
        try:
            from zoneinfo import ZoneInfo
            local_tz = ZoneInfo(self.rules.local_timezone)
        except Exception:
            from zoneinfo import ZoneInfo
            local_tz = ZoneInfo("UTC")
            
        local_today_start = dt.datetime.now(local_tz).replace(hour=0, minute=0, second=0, microsecond=0)
        utc_today_start = local_today_start.astimezone(UTC)
        
        recent_summaries = self.db.recent_audit_rows(["phase2_daily_summary"], utc_today_start)
        successful_summaries = [r for r in recent_summaries if r.get("status") == "sent"]
        if successful_summaries:
            LOGGER.warning("Daily scans have already completed successfully today at %s. Skipping duplicate run.", successful_summaries[0].get("created_at"))
            return

        self.scan_all_leads_for_disqualification()  # Reply Intent Handler
        self.scan_stale_agent_no_note_reassignment()
        self.scan_stale_leads()
        self.scan_seller_nurture()  # Seller nurture track (tag: "Seller Lead")
        self.scan_agent_followup()
        self.scan_email_address_updates()
        self.send_phase2_daily_summary()

    def scan_stale_leads(self) -> None:
        if not self.rules.customer_reengagement_emails_enabled:
            LOGGER.info("Customer pond nurture email scan is disabled by rules.yaml")
            return
        params = {"fields": "allFields"}
        if self.rules.pond_nurture_only:
            # If pond_nurture_only is enabled, filter by the first configured pond directly in the API call
            if self.rules.pond_ids:
                params["pondId"] = self.rules.pond_ids[0]
        else:
            cutoff = (dt.datetime.now(UTC) - dt.timedelta(days=self.rules.stale_no_contact_days)).strftime("%Y-%m-%d %H:%M:%S")
            params["lastActivityBefore"] = cutoff
        candidates = self.fub.get_people(**params)
        
        # Load existing sent count from database for today to enforce cap across restarts
        try:
            from zoneinfo import ZoneInfo
            local_tz = ZoneInfo(self.rules.local_timezone)
        except Exception:
            from zoneinfo import ZoneInfo
            local_tz = ZoneInfo("UTC")
        local_today_start = dt.datetime.now(local_tz).replace(hour=0, minute=0, second=0, microsecond=0)
        utc_today_start = local_today_start.astimezone(UTC)
        recent_nurtures = self.db.recent_audit_rows(["pond_nurture"], utc_today_start)
        sent_count = sum(1 for r in recent_nurtures if r.get("status") in ("sent", "dry_run_sent"))
        
        # Ramped daily cap. Resolution order: POND_DAILY_CAP env override, then
        # the stored ramp step, then the rules.yaml value as a floor-of-last-
        # resort if the state DB is unreadable. The cap only bounds HOW MANY of
        # the already-filtered candidates get an email — every suppression check
        # lives inside process_reengagement_candidate below and is untouched by it.
        cap = max(0, int(self.rules.phase2_max_customer_emails_per_run))
        cap_source = "rules.yaml fallback"
        try:
            from .ramp import env_cap_override, resolve_daily_cap

            with self.db.connect() as _con:
                cap = max(0, int(resolve_daily_cap(_con)))
            cap_source = "manual override" if env_cap_override() is not None else "ramp"
            LOGGER.info("Pond nurture daily cap resolved to %s", cap)
        except Exception as _cap_exc:  # noqa: BLE001
            LOGGER.warning(
                "Ramp cap unavailable (%s) — falling back to rules.yaml cap %s", _cap_exc, cap
            )

        # PRIMARY's config/controls.json (repo root, written by the voice
        # console after Peter approves out loud) can LOWER this cap, never
        # raise it: effective = min(voice-set target, the cap resolved above).
        # A missing or broken file leaves today exactly as yesterday, and the
        # log lines plus the audit row are the honest record of which number
        # actually governed. See controls.py for the rules.
        _governed_by = cap_source
        _controls_sha = None
        try:
            from .controls import resolve_effective_cap

            # One assignment: the clamp consumes the cap and produces the
            # (never higher) cap — phrased this way deliberately, so the ramp
            # safety invariant that audits every use of `cap` reads it as
            # exactly what it is.
            cap = (_resolution := resolve_effective_cap(cap, cap_source)).cap
            _governed_by = _resolution.governed_by
            _controls_sha = _resolution.controls_sha
            for _line in _resolution.log_lines:
                LOGGER.info("%s", _line)
            self.db.log(
                "daily_cap_resolution",
                _resolution.governed_by,
                None,
                {
                    "cap": _resolution.cap,
                    "base_cap": _resolution.base_cap,
                    "base_source": cap_source,
                    "daily_email_target": _resolution.control_value,
                    "controls_sha": _resolution.controls_sha,
                },
            )
        except Exception as _controls_exc:  # noqa: BLE001
            LOGGER.warning("controls.json could not be applied (%s) — the daily cap stands", _controls_exc)
        for person in candidates:
            # Skip leads not in the configured pond immediately to avoid clogging database with logs
            if self.rules.pond_nurture_only and self.rules.pond_ids:
                assigned_pond_id = person.get("assignedPondId")
                if not assigned_pond_id or int(assigned_pond_id) not in [int(pid) for pid in self.rules.pond_ids]:
                    continue
                    
            if cap and sent_count >= cap:
                self.db.log("pond_nurture", "launch_cap_reached", None, {"cap": cap, "governed_by": _governed_by})
                if _governed_by == "controls":
                    LOGGER.info("[controls] send blocked: daily cap %s reached (daily_email_target from controls.json@%s)", cap, (_controls_sha or "unknown")[:7])
                break
            try:
                status = self.process_reengagement_candidate(person)
                if status in ("sent", "dry_run_sent"):
                    sent_count += 1
            except Exception as exc:  # noqa: BLE001
                LOGGER.exception("pond nurture failed for person %s", person.get("id"))
                self.db.log("pond_nurture", "error", person.get("id"), {"error": str(exc)})

    def scan_stale_agent_no_note_reassignment(self) -> None:
        if not self.rules.stale_agent_no_note_reassignment_enabled:
            LOGGER.info("20-day stale-agent pond reassignment is disabled by rules.yaml")
            return
        if not self.rules.stale_agent_reassign_pond_id:
            LOGGER.warning("20-day stale-agent pond reassignment requested but stale_agent_reassign_pond_id is missing")
            return
        cutoff = (dt.datetime.now(UTC) - dt.timedelta(days=self.rules.stale_agent_no_note_days)).strftime("%Y-%m-%d %H:%M:%S")
        candidates = self.fub.get_people(lastActivityBefore=cutoff, fields="allFields")
        
        # Load existing reassigned count from database for today to enforce cap across restarts
        try:
            from zoneinfo import ZoneInfo
            local_tz = ZoneInfo(self.rules.local_timezone)
        except Exception:
            from zoneinfo import ZoneInfo
            local_tz = ZoneInfo("UTC")
        local_today_start = dt.datetime.now(local_tz).replace(hour=0, minute=0, second=0, microsecond=0)
        utc_today_start = local_today_start.astimezone(UTC)
        recent_reassignments = self.db.recent_audit_rows(["stale_agent_pond_reassignment"], utc_today_start)
        reassigned_count = sum(1 for r in recent_reassignments if r.get("status") == "completed")
        
        cap = max(0, int(self.rules.phase2_max_reassignments_per_run))
        excluded_agent_ids: set = set(getattr(self.rules, "excluded_user_ids", []))
        for person in candidates:
            # Skip leads already in a pond or without an assigned agent immediately to avoid clogging database with logs
            if person.get("assignedPondId") or not person.get("assignedUserId"):
                continue
            # Skip leads assigned to excluded agents (e.g. fired agents still Active in FUB)
            if int(person.get("assignedUserId", 0)) in excluded_agent_ids:
                continue
                
            if cap and reassigned_count >= cap:
                self.db.log("stale_agent_pond_reassignment", "launch_cap_reached", None, {"cap": cap})
                break
            try:
                status = self.process_stale_agent_no_note_candidate(person)
                if status == "completed":
                    reassigned_count += 1
            except Exception as exc:  # noqa: BLE001
                LOGGER.exception("stale-agent reassignment check failed for person %s", person.get("id"))
                self.db.log("stale_agent_pond_reassignment", "error", person.get("id"), {"error": str(exc)})

    def scan_pond_responses_for_intent(self) -> None:
        """Scans recent inbound messages/emails from leads currently in the configured Lead Pond (ID: 2) for purchase-intent keywords.
        
        When a match is found, reassigns the lead to Peter Allen and logs a detailed FUB note explaining what keyword triggered it.
        """
        if not self.rules.pond_ids:
            LOGGER.info("No pond IDs configured; skipping pond response scan.")
            return
            
        pond_id = self.rules.pond_ids[0]
        LOGGER.info("Scanning recent responses for pond ID %s for purchase intent keywords...", pond_id)
        
        # Optimize: Sort candidates by -updated so we can break early once we reach older leads
        # We remove fields="allFields" here to make the list fetch 10x faster (FUB default payload is tiny)
        # We also pass limit=100 so that we only fetch the first page of most recently updated leads instantly
        LOGGER.info("Fetching pond leads sorted by most recently updated first (first 100)...")
        candidates = self.fub.get_people(pondId=pond_id, sort="-updated", limit=100)
        
        reassigned_count = 0
        cap = max(0, int(self.rules.phase2_max_reassignments_per_run))
        
        cutoff_dt = dt.datetime.now(UTC) - dt.timedelta(days=2)
        scanned_count = 0
        
        for person in candidates:
            person_id = int(person["id"])
            
            # Check the updated timestamp of the lead
            updated_str = person.get("updated")
            if updated_str:
                updated_at = parse_fub_datetime(updated_str)
                if updated_at and updated_at < cutoff_dt:
                    LOGGER.info("Reached lead %s updated at %s (older than 2 days). Breaking scan loop early!", person_id, updated_str)
                    break
            
            scanned_count += 1
            if self.is_excluded(person):
                continue
                
            if cap and reassigned_count >= cap:
                self.db.log("pond_keyword_reassignment", "launch_cap_reached", None, {"cap": cap})
                break
                
            try:
                # Fetch recent incoming text messages and emails (limit to last 10)
                texts = self.fub.get_text_messages(person_id, limit=10)
                emails = self.fub.get_emails(person_id, limit=10)
                
                # We also check notes/events just in case some sync logs incoming texts as notes/activities
                notes = self.safe_get_notes(person_id)
                
                # AI-powered intent classification — single call covers opt-out, buying intent, and future-timeline
                classification = self.content.classify_lead_intent(person, texts, emails, notes)
                intent = classification.get("intent", "none")
                ai_confidence = classification.get("confidence", 0)
                ai_reason = classification.get("reason", "")
                trigger_snippet = classification.get("trigger_snippet", "")
                ai_source = classification.get("source", "none")

                if intent == "opt_out":
                    # AI detected opt-out intent — immediately move to Trash and suppress
                    LOGGER.info(
                        "Lead %s AI-classified as opt_out (confidence=%s%%) via %s. Moving to Trash. Reason: %s",
                        person_id, ai_confidence, ai_source, ai_reason,
                    )
                    self.fub.update_person(person_id, {"stage": "Trash", "assignedPondId": None})
                    self.fub.update_person(person_id, {"tags": ["unsubscribed", "opt-out-auto-trash"]}, merge_tags=True)

                    note_title = "\U0001f6ab Automation: Lead Opted Out & Moved to Trash"
                    note_body = (
                        f"Lead automatically unsubscribed and moved to **Trash** stage.\n\n"
                        f"\U0001f6d1 Trigger: AI detected opt-out intent (confidence: {ai_confidence}%)\n"
                        f"\u2022 Source channel: {ai_source}\n"
                        f"\u2022 AI reasoning: {ai_reason}\n"
                        f"\u2022 Trigger snippet: \"{trigger_snippet[:200]}\"\n\n"
                        f"This lead has been unsubscribed in Follow Up Boss and will no longer receive automated emails."
                    )
                    self.fub.add_note(person_id, note_title, note_body)
                    self.db.log("pond_opt_out_trash", "completed", person_id, {
                        "ai_reason": ai_reason,
                        "confidence": ai_confidence,
                        "source": ai_source,
                        "snippet": trigger_snippet[:200],
                    })
                    continue

                elif intent == "buying_intent":
                    # AI detected active purchase intent — reassign to Peter Allen immediately
                    LOGGER.info(
                        "Lead %s AI-classified as buying_intent (confidence=%s%%) via %s. Reassigning to Peter Allen. Reason: %s",
                        person_id, ai_confidence, ai_source, ai_reason,
                    )
                    payload = {"assignedUserId": self.rules.peter_user_id} if self.rules.peter_user_id else {"assignedTo": self.rules.peter_name}
                    payload["assignedPondId"] = None
                    self.fub.update_person(person_id, payload)
                    self.fub.update_person(person_id, {"tags": ["pond-intent-reassigned"]}, merge_tags=True)

                    note_title = "\U0001f6a8 Automation: Pond Lead Reassigned (Purchase Intent)"
                    note_body = (
                        f"Lead automatically reassigned to {self.rules.peter_name} from Lead Pond.\n\n"
                        f"\U0001f3af Trigger: AI detected active purchase intent (confidence: {ai_confidence}%)\n"
                        f"\u2022 Source channel: {ai_source}\n"
                        f"\u2022 AI reasoning: {ai_reason}\n"
                        f"\u2022 Trigger snippet: \"{trigger_snippet[:200]}\"\n\n"
                        f"Please follow up with this lead immediately!"
                    )
                    self.fub.add_note(person_id, note_title, note_body)
                    self.db.log("pond_keyword_reassignment", "completed", person_id, {
                        "ai_reason": ai_reason,
                        "confidence": ai_confidence,
                        "source": ai_source,
                        "reassigned_to": self.rules.peter_name,
                        "snippet": trigger_snippet[:200],
                        "contact_name": person_name(person),
                    })
                    reassigned_count += 1

                elif intent == "future_timeline" and self.rules.long_term_nurture_enabled:
                    # AI detected future-timeline intent — enroll in 60-day long-term nurture drip
                    existing = self.db.get_long_term_nurture_enrollment(person_id)
                    if existing:
                        LOGGER.info(
                            "Lead %s already enrolled in long-term nurture drip (enrolled %s). Skipping.",
                            person_id, existing.get("enrolled_at"),
                        )
                    else:
                        LOGGER.info(
                            "Lead %s AI-classified as future_timeline (confidence=%s%%) via %s. Enrolling in long-term nurture. Reason: %s",
                            person_id, ai_confidence, ai_source, ai_reason,
                        )
                        self.fub.update_person(person_id, {
                            "stage": self.rules.long_term_nurture_stage,
                            "assignedPondId": None,
                        })
                        self.fub.update_person(
                            person_id,
                            {"tags": [self.rules.long_term_nurture_suppression_tag]},
                            merge_tags=True,
                        )
                        fub_note_body = (
                            f"Lead automatically moved to {self.rules.long_term_nurture_stage} stage and enrolled in 60-day AI email drip.\n\n"
                            f"\U0001f4c5 Trigger: AI detected future-timeline intent (confidence: {ai_confidence}%)\n"
                            f"\u2022 Source channel: {ai_source}\n"
                            f"\u2022 AI reasoning: {ai_reason}\n"
                            f"\u2022 Trigger snippet: \"{trigger_snippet[:200]}\"\n\n"
                            f"This lead will receive a personalized AI email every 60 days until they are ready to move."
                        )
                        self.fub.add_note(
                            person_id,
                            "\U0001f4c5 Automation: Long-Term Nurture Enrollment",
                            fub_note_body,
                        )
                        self.db.enroll_long_term_nurture(person_id, trigger_snippet[:200])
                        self.db.log("long_term_nurture_enrollment", "enrolled", person_id, {
                            "ai_reason": ai_reason,
                            "confidence": ai_confidence,
                            "source": ai_source,
                            "snippet": trigger_snippet[:200],
                        })

                elif intent == "no_longer_looking":
                    # AI detected the lead is no longer looking to move to Texas
                    # Move to annual nurture (1 email/year) instead of full suppression
                    LOGGER.info(
                        "Lead %s AI-classified as no_longer_looking (confidence=%s%%) via %s. Moving to annual nurture. Reason: %s",
                        person_id, ai_confidence, ai_source, ai_reason,
                    )
                    # Tag the lead and move to Nurture stage (not Trash)
                    self.fub.update_person(person_id, {
                        "stage": "Nurture",
                        "assignedPondId": None,
                    })
                    self.fub.update_person(
                        person_id,
                        {"tags": ["Annual Nurture Only"]},
                        merge_tags=True,
                    )

                    note_title = "\U0001f4c5 Automation: Annual Nurture Enrolled (No Longer Looking)"
                    note_body = (
                        f"Lead automatically moved to Annual Nurture cadence (1 email per year).\n\n"
                        f"\U0001f4cb Trigger: AI detected lead is no longer looking to move to Texas (confidence: {ai_confidence}%)\n"
                        f"\u2022 Source channel: {ai_source}\n"
                        f"\u2022 AI reasoning: {ai_reason}\n"
                        f"\u2022 Trigger snippet: \"{trigger_snippet[:200]}\"\n\n"
                        f"Actions taken:\n"
                        f"\u2022 Tagged \"Annual Nurture Only\"\n"
                        f"\u2022 Removed from active email nurture\n"
                        f"\u2022 Will receive ONE friendly check-in email per year\n\n"
                        f"This lead is NOT opted out \u2014 they may still be a referral source."
                    )
                    self.fub.add_note(person_id, note_title, note_body)
                    self.db.log("annual_nurture_enrollment", "enrolled", person_id, {
                        "ai_reason": ai_reason,
                        "confidence": ai_confidence,
                        "source": ai_source,
                        "snippet": trigger_snippet[:200],
                    })

            except Exception as exc:
                LOGGER.exception("Failed to scan responses for pond lead %s", person_id)
                self.db.log("pond_keyword_reassignment", "error", person_id, {"error": str(exc)})
        LOGGER.info("Pond response scan complete. Scanned %s active candidates, reassigned %s leads.", scanned_count, reassigned_count)
        
    def scan_all_leads_for_disqualification(self) -> None:
        """Scans ALL leads (assigned AND unassigned) with recent inbound activity for disqualification signals.
        
        When a lead replies indicating they have relocated out of Texas, bought a home elsewhere,
        or are otherwise permanently disqualified from the market, this handler:
          1. Moves the lead to Trash stage
          2. Adds suppression tags (bot_suppress, relocated_out_of_market)
          3. Logs a detailed FUB note explaining the AI's reasoning
          4. Logs the event in the audit DB
        
        This covers the gap where assigned leads (not in Pond) were previously not scanned
        for disqualification signals from their replies.
        """
        LOGGER.info("=== REPLY INTENT HANDLER: Scanning ALL leads with recent inbound activity for disqualification ===")
        
        # Fetch leads sorted by most recently updated, limit to 200 most active
        # This catches both assigned and unassigned leads who have replied recently
        candidates = self.fub.get_people(sort="-updated", limit=200)
        
        trashed_count = 0
        scanned_count = 0
        cutoff_dt = dt.datetime.now(UTC) - dt.timedelta(days=3)  # Look at last 3 days of activity
        
        for person in candidates:
            person_id = int(person["id"])
            
            # Skip if already excluded (trash, opt-out, suppressed, etc.)
            if self.is_excluded(person):
                continue
            
            # Skip leads already in Pond — those are handled by scan_pond_responses_for_intent
            assigned_pond_id = person.get("assignedPondId")
            if assigned_pond_id and int(assigned_pond_id) in {int(pid) for pid in self.rules.pond_ids}:
                continue
            
            # ── FIX: The list endpoint does NOT return lastReceivedEmail/Text/IncomingCall.
            # We must call get_person(id) individually to get these fields.
            # Use the 'updated' field from the list response as a pre-filter: if the lead
            # hasn't been updated in the last 3 days, skip the expensive individual fetch.
            updated_str = person.get("updated")
            if updated_str:
                updated_dt = parse_fub_datetime(updated_str)
                if updated_dt and updated_dt < cutoff_dt:
                    # Lead not updated recently — skip (sorted by -updated so all remaining are older)
                    LOGGER.debug("Stopping disqualification scan at person %s (updated %s, older than cutoff)", person_id, updated_str)
                    break
            
            # Fetch individual person details to get real inbound activity fields
            try:
                person_detail = self.fub.get_person(person_id)
            except Exception as fetch_exc:
                LOGGER.debug("Could not fetch person detail for %s: %s", person_id, fetch_exc)
                continue
            if not person_detail:
                continue
            
            # Now check for recent INBOUND activity using the individual endpoint data
            has_recent_inbound = False
            for key in ("lastReceivedEmail", "lastReceivedText", "lastIncomingCall"):
                val = person_detail.get(key)
                if val:
                    try:
                        parsed = parse_fub_datetime(val)
                        if parsed and parsed > cutoff_dt:
                            has_recent_inbound = True
                            break
                    except Exception:
                        pass
            
            if not has_recent_inbound:
                continue
            
            scanned_count += 1
            person_name = f"{person_detail.get('firstName', '')} {person_detail.get('lastName', '')}".strip()
            
            try:
                # Fetch recent inbound communications
                texts = self.fub.get_text_messages(person_id, limit=10)
                emails = self.fub.get_emails(person_id, limit=10)
                notes = self.safe_get_notes(person_id)
                
                # Run AI intent classification
                classification = self.content.classify_lead_intent(person, texts, emails, notes)
                intent = classification.get("intent", "none")
                ai_confidence = classification.get("confidence", 0)
                ai_reason = classification.get("reason", "")
                trigger_snippet = classification.get("trigger_snippet", "")
                ai_source = classification.get("source", "none")
                
                if intent == "no_longer_looking" and ai_confidence >= 75:
                    # Lead has permanently relocated or bought elsewhere — move to Trash
                    LOGGER.info(
                        "DISQUALIFIED: Lead %s (%s) AI-classified as no_longer_looking (confidence=%s%%) via %s. Moving to Trash. Reason: %s",
                        person_id, person_name, ai_confidence, ai_source, ai_reason,
                    )
                    if not self.settings.dry_run:
                        self.fub.update_person(person_id, {"stage": "Trash", "assignedPondId": None, "assignedUserId": None})
                        self.fub.update_person(person_id, {"tags": ["bot_suppress", "relocated_out_of_market"]}, merge_tags=True)
                    
                    note_title = "\U0001f6ab Automation: Lead Disqualified & Trashed (Relocated/Bought Elsewhere)"
                    note_body = (
                        f"Lead automatically moved to **Trash** stage — permanently disqualified.\n\n"
                        f"\U0001f6d1 Trigger: AI detected lead is no longer in the Texas market (confidence: {ai_confidence}%)\n"
                        f"\u2022 Source channel: {ai_source}\n"
                        f"\u2022 AI reasoning: {ai_reason}\n"
                        f"\u2022 Trigger snippet: \"{trigger_snippet[:200]}\"\n\n"
                        f"Actions taken:\n"
                        f"\u2022 Stage → Trash\n"
                        f"\u2022 Tagged \"bot_suppress\" + \"relocated_out_of_market\"\n"
                        f"\u2022 Unassigned from agent\n"
                        f"\u2022 All automated outreach permanently stopped\n\n"
                        f"This lead confirmed they have relocated out of the Texas market or purchased a home elsewhere."
                    )
                    self.fub.add_note(person_id, note_title, note_body)
                    self.db.log("reply_intent_disqualification", "trashed", person_id, {
                        "ai_reason": ai_reason,
                        "confidence": ai_confidence,
                        "source": ai_source,
                        "snippet": trigger_snippet[:200],
                        "person_name": person_name,
                        "dry_run": self.settings.dry_run,
                    })
                    trashed_count += 1
                    
                elif intent == "opt_out" and ai_confidence >= 75:
                    # Lead wants to stop receiving messages — also move to Trash
                    LOGGER.info(
                        "OPT-OUT: Lead %s (%s) AI-classified as opt_out (confidence=%s%%) via %s. Moving to Trash. Reason: %s",
                        person_id, person_name, ai_confidence, ai_source, ai_reason,
                    )
                    if not self.settings.dry_run:
                        self.fub.update_person(person_id, {"stage": "Trash", "assignedPondId": None, "assignedUserId": None})
                        self.fub.update_person(person_id, {"tags": ["unsubscribed", "opt-out-auto-trash", "bot_suppress"]}, merge_tags=True)
                    
                    note_title = "\U0001f6ab Automation: Lead Opted Out & Moved to Trash"
                    note_body = (
                        f"Lead automatically unsubscribed and moved to **Trash** stage.\n\n"
                        f"\U0001f6d1 Trigger: AI detected opt-out intent (confidence: {ai_confidence}%)\n"
                        f"\u2022 Source channel: {ai_source}\n"
                        f"\u2022 AI reasoning: {ai_reason}\n"
                        f"\u2022 Trigger snippet: \"{trigger_snippet[:200]}\"\n\n"
                        f"Actions taken:\n"
                        f"\u2022 Stage → Trash\n"
                        f"\u2022 Tagged \"unsubscribed\" + \"opt-out-auto-trash\" + \"bot_suppress\"\n"
                        f"\u2022 Unassigned from agent\n"
                        f"\u2022 All automated outreach permanently stopped"
                    )
                    self.fub.add_note(person_id, note_title, note_body)
                    self.db.log("reply_intent_disqualification", "opt_out_trashed", person_id, {
                        "ai_reason": ai_reason,
                        "confidence": ai_confidence,
                        "source": ai_source,
                        "snippet": trigger_snippet[:200],
                        "person_name": person_name,
                        "dry_run": self.settings.dry_run,
                    })
                    trashed_count += 1
                    
            except Exception as exc:
                LOGGER.exception("Reply intent scan failed for person %s", person_id)
                self.db.log("reply_intent_disqualification", "error", person_id, {"error": str(exc)})
        
        LOGGER.info(
            "Reply intent disqualification scan complete. Scanned %s leads with recent inbound activity, trashed %s.",
            scanned_count, trashed_count,
        )

    def scan_email_address_updates(self) -> None:
        """Scans recent inbound emails from ALL non-excluded leads for email address change notifications.

        When a lead replies saying "I no longer use this email, please contact me at [new]",
        the system:
          1. Adds the new email address to the lead's FUB profile (prepended as primary).
          2. Logs a detailed FUB note with the AI's reasoning and the trigger snippet.
          3. Tags the lead with 'email-updated-auto' for visibility.
          4. Logs the event in the audit DB.

        Runs daily as part of run_daily_scans().  Scans the 200 most recently updated leads
        to keep the run fast — email address changes are rare and almost always come from
        recently active leads.
        """
        if not self.rules.email_address_update_scan_enabled:
            LOGGER.info("Email address update scan is disabled by rules.yaml (email_address_update_scan_enabled: false)")
            return

        LOGGER.info("Scanning recent inbound emails for email address change notifications...")
        candidates = self.fub.get_people(sort="-updated", limit=200)
        updated_count = 0

        for person in candidates:
            person_id = int(person["id"])
            if self.is_excluded(person):
                continue
            try:
                emails = self.fub.get_emails(person_id, limit=15)
                if not emails:
                    continue

                result = self.content.detect_email_change(person, emails)
                if not result.get("changed"):
                    continue

                new_email = result["new_email"]
                confidence = result["confidence"]
                reason = result["reason"]
                trigger_snippet = result["trigger_snippet"]

                # Check if this email is already on the lead's profile to avoid duplicates
                existing_emails = [e.get("value", "").strip().lower() for e in (person.get("emails") or [])]
                if new_email in existing_emails:
                    LOGGER.info(
                        "Email address update: person %s already has %s on file — skipping.",
                        person_id, new_email,
                    )
                    continue

                person_name = f"{person.get('firstName', '')} {person.get('lastName', '')}".strip()
                LOGGER.info(
                    "Email address update: person %s (%s) — adding new email '%s' (confidence=%s%%)",
                    person_id, person_name, new_email, confidence,
                )

                if not self.settings.dry_run:
                    # Prepend the new email to the existing list so it becomes primary
                    updated_email_list = [{"value": new_email}] + [
                        {"value": e} for e in existing_emails if e
                    ]
                    self.fub.update_person(person_id, {"emails": updated_email_list})
                    self.fub.update_person(person_id, {"tags": ["email-updated-auto"]}, merge_tags=True)

                note_title = "✉️ Automation: Email Address Updated"
                note_body = (
                    f"Lead provided a new email address and it has been automatically added to their profile.\n\n"
                    f"• **New email added:** {new_email}\n"
                    f"• AI confidence: {confidence}%\n"
                    f"• AI reasoning: {reason}\n"
                    f"• Trigger snippet: \"{trigger_snippet[:250]}\"\n\n"
                    f"The new address has been prepended as the primary email. Please verify and remove the old address if no longer valid."
                )
                self.fub.add_note(person_id, note_title, note_body)
                self.db.log("email_address_update", "updated", person_id, {
                    "new_email": new_email,
                    "confidence": confidence,
                    "reason": reason,
                    "snippet": trigger_snippet[:200],
                    "dry_run": self.settings.dry_run,
                })
                updated_count += 1

            except Exception as exc:  # noqa: BLE001
                LOGGER.exception("Email address update scan failed for person %s", person_id)
                self.db.log("email_address_update", "error", person_id, {"error": str(exc)})

        LOGGER.info("Email address update scan complete. Updated %s lead(s).", updated_count)

    def has_recent_omnichannel_touch(self, person: dict, days: int) -> bool:
        """Checks if the LEAD has responded (inbound only) within the specified days.
        
        Only checks INBOUND activity from the lead:
        - lastReceivedEmail: lead sent an email
        - lastReceivedText: lead sent a text
        - lastIncomingCall: lead called in
        
        Does NOT check outbound (lastSentEmail, lastSentText, lastCall) because
        bot/agent outreach should NOT reset the stale timer. The lead must actually
        RESPOND for the agent to keep them.
        """
        cutoff_dt = dt.datetime.now(UTC) - dt.timedelta(days=days)
        
        # Only check INBOUND activity from the lead
        for key in ("lastReceivedEmail", "lastReceivedText", "lastIncomingCall"):
            val = person.get(key)
            if val:
                try:
                    parsed = parse_fub_datetime(val)
                    if parsed and parsed > cutoff_dt:
                        return True
                except Exception:
                    pass
        
        return False

    def scan_agent_followup(self) -> None:
        if not self.rules.agent_reminder_emails_enabled:
            LOGGER.info("Agent reminder email scan is disabled by rules.yaml")
            return
        # ── FIXED: Use createdAfter/createdBefore to only include leads CREATED 1-20 days ago ──
        # Previously used lastActivityBefore which pulled ALL leads (even years old) whose
        # lastActivity was stale. This caused inflated counts (e.g. Steven showing 212 leads
        # when only 11 were actually fresh). Now matches the Power Queue logic exactly.
        now = dt.datetime.now(UTC)
        created_after = (now - dt.timedelta(days=20)).strftime("%Y-%m-%dT%H:%M:%SZ")
        created_before = (now - dt.timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
        LOGGER.info("Agent followup scan: fetching leads created between %s and %s", created_after, created_before)
        candidates = self.fub.get_people(createdAfter=created_after, createdBefore=created_before)
        LOGGER.info("Agent followup scan: %s candidates found in 1-20 day window", len(candidates))
        reminders_by_agent: Dict[int, List[dict]] = {}
        _excluded_agent_ids: set = set(getattr(self.rules, "excluded_user_ids", []))
        for person in candidates:
            if self.is_excluded(person) or person.get("assignedPondId"):
                continue
            assigned_user_id = person.get("assignedUserId")
            if not assigned_user_id:
                continue
            # Skip leads assigned to excluded agents (e.g. fired agents still Active in FUB)
            if int(assigned_user_id) in _excluded_agent_ids:
                continue
            reminders_by_agent.setdefault(int(assigned_user_id), []).append(person)

        # Load existing sent digests for today to prevent duplicates
        try:
            from zoneinfo import ZoneInfo
            local_tz = ZoneInfo(self.rules.local_timezone)
        except Exception:
            from zoneinfo import ZoneInfo
            local_tz = ZoneInfo("UTC")
        local_today_start = dt.datetime.now(local_tz).replace(hour=0, minute=0, second=0, microsecond=0)
        utc_today_start = local_today_start.astimezone(UTC)
        recent_digests = self.db.recent_audit_rows(["agent_followup_reminder"], utc_today_start)
        sent_agent_ids = set()
        for r in recent_digests:
            if r.get("status") == "email_digest_sent":
                try:
                    details = json.loads(r.get("details") or "{}")
                    u_id_logged = details.get("assignedUserId")
                    if u_id_logged:
                        sent_agent_ids.add(int(u_id_logged))
                except Exception:
                    pass

        # Agents excluded from ALL automation (e.g. fired agents still Active in FUB)
        excluded_ids: set = set(getattr(self.rules, "excluded_user_ids", []))

        # Broadcast Mode: Send to all active agents, even if they have 0 stale leads
        if getattr(self.rules, "agent_reminder_broadcast_mode_enabled", False):
            try:
                active_users = [u for u in self.fub.users() if u.get("status") == "Active"]
                LOGGER.info("Broadcast Mode active. Sending daily deal + follow-up digest to %s active users.", len(active_users))
                for user in active_users:
                    u_id = int(user["id"])
                    if u_id in excluded_ids:
                        LOGGER.info("User %s is in excluded_user_ids — skipping digest email.", u_id)
                        continue
                    if u_id in sent_agent_ids:
                        LOGGER.info("Agent reminder digest already sent to user %s today. Skipping.", u_id)
                        continue
                    people = reminders_by_agent.get(u_id, [])
                    try:
                        self.send_agent_reminder_digest(u_id, people)
                    except Exception as exc:
                        LOGGER.exception("agent reminder digest failed for user %s", u_id)
                        self.db.log("agent_followup_reminder", "error", None, {"assignedUserId": u_id, "error": str(exc)})
            except Exception as users_exc:
                LOGGER.exception("Failed to fetch users for broadcast mode: %s", users_exc)
                # Fallback to only sending to agents who actually have reminders
                for assigned_user_id, people in reminders_by_agent.items():
                    if int(assigned_user_id) in excluded_ids:
                        LOGGER.info("User %s is in excluded_user_ids — skipping digest email.", assigned_user_id)
                        continue
                    if int(assigned_user_id) in sent_agent_ids:
                        LOGGER.info("Agent reminder digest already sent to user %s today. Skipping.", assigned_user_id)
                        continue
                    try:
                        self.send_agent_reminder_digest(assigned_user_id, people)
                    except Exception as exc:
                        LOGGER.exception("agent reminder digest failed for user %s", assigned_user_id)
                        self.db.log("agent_followup_reminder", "error", None, {"assignedUserId": assigned_user_id, "error": str(exc)})
        else:
            for assigned_user_id, people in reminders_by_agent.items():
                if int(assigned_user_id) in excluded_ids:
                    LOGGER.info("User %s is in excluded_user_ids — skipping digest email.", assigned_user_id)
                    continue
                try:
                    self.send_agent_reminder_digest(assigned_user_id, people)
                except Exception as exc:  # noqa: BLE001
                    LOGGER.exception("agent reminder digest failed for user %s", assigned_user_id)
                    self.db.log("agent_followup_reminder", "error", None, {"assignedUserId": assigned_user_id, "error": str(exc)})

    def send_agent_reminder_digest(self, assigned_user_id: int, people: List[dict]) -> None:
        user = self.user_cache_by_id().get(int(assigned_user_id), {})
        to_email = user.get("email") or user.get("emailAddress")
        if not to_email:
            self.db.log("agent_followup_reminder", "suppressed", None, {"assignedUserId": assigned_user_id, "reason": "missing agent email"})
            return
        agent_name = user.get("name") or user.get("firstName") or "there"
        first_name = str(agent_name).split()[0] if str(agent_name).split() else "there"
        lead_count = len(people)
        lead_word = "lead" if lead_count == 1 else "leads"
        local_today = dt.datetime.now(ZoneInfo(self.rules.local_timezone)).date().isoformat()
        seed_material = f"{local_today}:{assigned_user_id}:{lead_count}".encode("utf-8")
        variant_seed = int(hashlib.sha256(seed_material).hexdigest(), 16)

        def pick(options: List[str], offset: int = 0) -> str:
            return options[(variant_seed + offset) % len(options)]

        # ── One-time personal app launch date ──────────────────────────────────
        LAUNCH_DATE = "2026-06-12"  # Rescheduled to June 12 — launch email missed on June 11
        is_launch_day = (local_today == LAUNCH_DATE)
        # ────────────────────────────────────────────────────────────────────

        if is_launch_day:
            subject = f"🚀 Now Introducing: The Lifestyle Command Center, {first_name}"
        elif lead_count == 0:
            subject = pick([
                f"🏡 {first_name.upper()} — You're All Caught Up! Pipeline Looking Clean",
                f"✅ ZERO STALE LEADS: Great work keeping FUB clean, {first_name}!",
                f"⚡ {first_name.upper()} — Pipeline Clear, Keep the Momentum Going!",
                f"📈 ALL CAUGHT UP: Your follow-up game is on point today",
                f"🌟 {first_name.upper()} — Clean Pipeline Report",
            ])
        else:
            subject = pick([
                f"📲 DAILY LEADS TO TEXT — {lead_count} {lead_word.upper()} WAITING",
                f"🔥 ACTION REQUIRED: Tap to Text Your Daily Leads ({lead_count} {lead_word.upper()})",
                f"⚡ QUICK TOUCH: 1-Click Text Your Stale Leads ({lead_count} {lead_word.upper()})",
                f"📈 PIPELINE BOOST: Click-to-Text Daily Follow-ups — {lead_count} {lead_word.upper()}",
                f"🏡 {first_name.upper()} — Your Daily Click-to-Text Checklist ({lead_count} {lead_word.upper()})",
            ])
        cc = [self.rules.default_agent_reminder_cc] if self.rules.agent_reminder_cc_owner else []
        cc = [addr for addr in cc if addr and addr.lower() != str(to_email).lower()]

        stage_counts: Dict[str, int] = {}
        for person in people:
            stage = person.get("stage") or "Unknown stage"
            stage_counts[stage] = stage_counts.get(stage, 0) + 1
        top_stages = sorted(stage_counts.items(), key=lambda item: (-item[1], item[0]))[:3]
        if top_stages:
            stage_summary = ", ".join(f"{stage} ({count})" for stage, count in top_stages)
        else:
            stage_summary = "a few different stages"

        if lead_count == 0:
            intro = "I checked your pipeline this morning, and you are completely up to date with zero stale leads requiring immediate follow-up! Incredible work keeping FUB clean."
            focus = ""
            ask = "Since your pipeline is in great shape, keep the momentum going — check in on any hot prospects, update your notes, and stay proactive. You're crushing it."
        else:
            intro = pick([
                f"I’m working through follow-up this morning and these are the {lead_word} assigned to you that look like they need a touch in FUB.",
                f"I pulled your follow-up list for today. These are the {lead_word} I’d like you to review and clean up before the day gets away from us.",
                f"I’m doing a database cleanup pass today, and these are the people on your list that jumped out as needing attention.",
                f"I took a look at the follow-up queue and wanted to send these over so they do not sit too long without activity.",
                f"Here is your follow-up list for today. Please take a look and either make the next touch or update FUB if you already handled them.",
            ], 7)
            focus = pick([
                f"Most of what I’m seeing here is around: {stage_summary}.",
                f"The main stages showing up on this list are: {stage_summary}.",
                f"This batch is mostly concentrated in: {stage_summary}.",
                f"For context, the biggest buckets are: {stage_summary}.",
            ], 13)
            ask = pick([
                "If you can, please knock these out today and leave a quick note/activity in FUB so the record is clean.",
                "A quick call, text, email, or clean note in FUB is enough as long as the next step is clear.",
                "Please work through these and make sure FUB shows what happened so we have a clean record.",
                "If any of these are already handled, just update the activity/note so they stop showing up as stale.",
            ], 19)
        closing = pick([
            "Thanks for jumping on this. I appreciate it.",
            "Thank you — this kind of follow-up discipline makes a big difference.",
            "Appreciate you tightening this up today.",
            "Thanks. Let’s keep the pipeline clean and moving.",
            "I appreciate you taking care of these.",
        ], 29)

        from .sms_helpers import get_upcoming_holiday, generate_personalized_sms, make_sms_uri

        local_date = dt.datetime.now(ZoneInfo(self.rules.local_timezone)).date()
        holiday = get_upcoming_holiday(local_date)

        # (A city-focus computation lived here until 2026-08-26. Nothing read its
        # result, and it burned one FUB notes GET per lead in the digest.)

        # Build both HTML and Plain Text bodies for the email
        if lead_count == 0:
            lines = [
                f"Hi {first_name},",
                "",
                intro,
                "",
                ask,
            ]
            html_lines = [
                f"<p>Hi {first_name},</p>",
                f"<p>{intro}</p>",
                f"<p>{ask}</p>",
            ]
        else:
            # ── REMOVED: Power Queue tap-to-text digest email ──
            # Agents already receive their AI bot clock-in email which includes the Power Queue button.
            # This digest was redundant. Only the Clean Pipeline (0 stale leads) email is kept.
            # Skip sending for agents who have leads — their AI bot handles it.
            return
            # Base URL of the live dashboard where the queue is hosted
            dashboard_base_url = "https://fub-nurture-phfprjui.manus.space"
            queue_url = f"{dashboard_base_url}/agent/{first_name.lower()}"

            # Beautiful call-to-action button for the single-page Power Queue
            if is_launch_day:
                # ── ONE-TIME LAUNCH EMAIL (June 11 only) ─────────────────────────────────
                queue_html_banner = f"""
<div style="margin: 24px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">

  <!-- Hero header -->
  <div style="background: linear-gradient(135deg, #0C0A07 0%, #1a1508 50%, #0C0A07 100%); border-radius: 14px 14px 0 0; padding: 32px 28px 24px; border: 1px solid #3d3010; border-bottom: none; text-align: center;">
    <div style="display: inline-block; background: linear-gradient(135deg, #d4af37, #f5d060, #d4af37); border-radius: 50%; width: 56px; height: 56px; line-height: 56px; font-size: 28px; margin-bottom: 14px;">&#9889;</div>
    <p style="margin: 0 0 6px; font-size: 11px; font-weight: 300; letter-spacing: 0.3em; color: #b8922a; text-transform: uppercase;">Lifestyle Technologies &bull; Lifestyle Design Realty</p>
    <h1 style="margin: 0 0 8px; font-size: 26px; font-weight: 700; color: #ffffff; letter-spacing: -0.5px; line-height: 1.2;">Introducing the Lifestyle<br/>Command Center, {first_name}.</h1>
    <p style="margin: 0; font-size: 14px; color: #a89060; font-weight: 300; line-height: 1.6;">Your private command center that knows your leads,<br/>your pipeline, and your priorities &mdash; every single morning.</p>
  </div>

  <!-- Main CTA -->
  <div style="background: #111008; border-left: 1px solid #3d3010; border-right: 1px solid #3d3010; padding: 28px;">
    <div style="text-align: center; margin-bottom: 28px;">
      <a href="{queue_url}" style="display: inline-block; padding: 16px 40px; background: linear-gradient(135deg, #d4af37, #f5d060); color: #0C0A07; text-decoration: none; border-radius: 8px; font-weight: 800; font-size: 16px; letter-spacing: 0.02em; box-shadow: 0 8px 24px rgba(212,175,55,0.35);" target="_blank">
        &#9889;&nbsp; Open My Dashboard &nbsp;&#8594;
      </a>
      <p style="margin: 10px 0 0; font-size: 11px; color: #5a4a20; letter-spacing: 0.1em; text-transform: uppercase;">fub-nurture-phfprjui.manus.space/agent/{first_name.lower()}</p>
    </div>

    <!-- Feature pills -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 24px;">
      <tr>
        <td width="33%" style="padding: 4px;">
          <div style="background: rgba(212,175,55,0.07); border: 1px solid rgba(212,175,55,0.15); border-radius: 8px; padding: 14px 10px; text-align: center;">
            <div style="font-size: 20px; margin-bottom: 6px;">&#128308;</div>
            <div style="font-size: 11px; font-weight: 700; color: #f87171; margin-bottom: 3px;">DO NOW</div>
            <div style="font-size: 10px; color: #6b5a30; line-height: 1.4;">Urgent leads<br/>14&ndash;20 days stale</div>
          </div>
        </td>
        <td width="33%" style="padding: 4px;">
          <div style="background: rgba(212,175,55,0.07); border: 1px solid rgba(212,175,55,0.15); border-radius: 8px; padding: 14px 10px; text-align: center;">
            <div style="font-size: 20px; margin-bottom: 6px;">&#128293;</div>
            <div style="font-size: 11px; font-weight: 700; color: #fbbf24; margin-bottom: 3px;">HOT PROSPECTS</div>
            <div style="font-size: 10px; color: #6b5a30; line-height: 1.4;">FUB stage:<br/>Hot Prospect</div>
          </div>
        </td>
        <td width="33%" style="padding: 4px;">
          <div style="background: rgba(212,175,55,0.07); border: 1px solid rgba(212,175,55,0.15); border-radius: 8px; padding: 14px 10px; text-align: center;">
            <div style="font-size: 20px; margin-bottom: 6px;">&#128101;</div>
            <div style="font-size: 11px; font-weight: 700; color: #34d399; margin-bottom: 3px;">YOUR LEADS</div>
            <div style="font-size: 10px; color: #6b5a30; line-height: 1.4;">All your assigned<br/>active leads</div>
          </div>
        </td>
      </tr>
    </table>

    <!-- Pin to tab instructions -->
    <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(212,175,55,0.12); border-radius: 10px; padding: 20px 22px;">
      <p style="margin: 0 0 12px; font-size: 13px; font-weight: 700; color: #d4af37; letter-spacing: 0.05em; text-transform: uppercase;">&#128204;&nbsp; Pin This to Your Browser &mdash; Takes 5 Seconds</p>
      <p style="margin: 0 0 14px; font-size: 12px; color: #8a7040; line-height: 1.6;">Pin your dashboard as a tab so it&rsquo;s always one click away &mdash; every morning when you open your computer, your leads are already waiting.</p>
      <table width="100%" cellpadding="0" cellspacing="8">
        <tr>
          <td style="vertical-align: top; padding: 6px 0;">
            <div style="display: flex; align-items: flex-start; gap: 10px;">
              <div style="background: #d4af37; color: #0C0A07; border-radius: 50%; width: 20px; height: 20px; min-width: 20px; font-size: 11px; font-weight: 800; text-align: center; line-height: 20px;">1</div>
              <div style="font-size: 12px; color: #c8a84a; line-height: 1.5; padding-left: 8px;"><strong style="color: #e8c96a;">Open the link above</strong> in Chrome or Edge on your computer.</div>
            </div>
          </td>
        </tr>
        <tr>
          <td style="vertical-align: top; padding: 6px 0;">
            <div style="display: flex; align-items: flex-start; gap: 10px;">
              <div style="background: #d4af37; color: #0C0A07; border-radius: 50%; width: 20px; height: 20px; min-width: 20px; font-size: 11px; font-weight: 800; text-align: center; line-height: 20px;">2</div>
              <div style="font-size: 12px; color: #c8a84a; line-height: 1.5; padding-left: 8px;"><strong style="color: #e8c96a;">Right-click the tab</strong> at the top of your browser (the little tab with the page title).</div>
            </div>
          </td>
        </tr>
        <tr>
          <td style="vertical-align: top; padding: 6px 0;">
            <div style="display: flex; align-items: flex-start; gap: 10px;">
              <div style="background: #d4af37; color: #0C0A07; border-radius: 50%; width: 20px; height: 20px; min-width: 20px; font-size: 11px; font-weight: 800; text-align: center; line-height: 20px;">3</div>
              <div style="font-size: 12px; color: #c8a84a; line-height: 1.5; padding-left: 8px;"><strong style="color: #e8c96a;">Click &ldquo;Pin Tab&rdquo;</strong> from the menu. The tab shrinks to a small icon and stays pinned even when you close and reopen Chrome.</div>
            </div>
          </td>
        </tr>
        <tr>
          <td style="vertical-align: top; padding: 6px 0;">
            <div style="display: flex; align-items: flex-start; gap: 10px;">
              <div style="background: #d4af37; color: #0C0A07; border-radius: 50%; width: 20px; height: 20px; min-width: 20px; font-size: 11px; font-weight: 800; text-align: center; line-height: 20px;">4</div>
              <div style="font-size: 12px; color: #c8a84a; line-height: 1.5; padding-left: 8px;"><strong style="color: #e8c96a;">Done.</strong> Every morning, click the pinned icon and your personal lead list loads instantly &mdash; no login, no searching.</div>
            </div>
          </td>
        </tr>
      </table>
    </div>
  </div>

  <!-- Footer strip -->
  <div style="background: linear-gradient(135deg, #0C0A07, #1a1508); border-radius: 0 0 14px 14px; padding: 16px 28px; border: 1px solid #3d3010; border-top: 1px solid rgba(212,175,55,0.15); text-align: center;">
    <p style="margin: 0; font-size: 10px; color: #4a3a10; letter-spacing: 0.2em; text-transform: uppercase;">Lifestyle Command Center &bull; Built exclusively for Lifestyle Design Realty agents</p>
  </div>

</div>
"""
            else:
                # ── Normal queue banner (all other days) ──────────────────────────────
                queue_html_banner = f"""
            <div style="margin: 20px 0; padding: 20px; background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-radius: 10px; border: 1px solid #334155; color: white; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
                <p style="margin: 0 0 8px 0; font-size: 16px; font-weight: bold; color: #f8fafc; text-align: center;">⚡ Your Daily Tap-to-Text Power Queue</p>
                <p style="margin: 0 0 16px 0; font-size: 13px; color: #94a3b8; text-align: center; line-height: 1.5;">
                    Text <strong>all</strong> your stale leads from a single, high-speed page.
                </p>
                <div style="background-color: rgba(255,255,255,0.05); border-radius: 6px; padding: 12px; margin-bottom: 16px; font-size: 12px; color: #cbd5e1; line-height: 1.6;">
                    <strong>💡 How it works:</strong><br/>
                    1. Click the green button below to launch your personal queue.<br/>
                    2. Tap <strong>"Text Lead"</strong> for the first lead — it pre-fills the message in your native Messages app.<br/>
                    3. Press <strong>"Send"</strong>, then swipe back to your browser. The lead is marked "Texted" automatically, and you can instantly tap the next one!
                </div>
                <div style="text-align: center;">
                    <a href="{queue_url}" style="display: inline-block; padding: 12px 24px; background-color: #22c55e; color: white; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 14px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);" target="_blank">🚀 Launch Your Power Queue Now</a>
                </div>
            </div>
            """

            if is_launch_day:
                lines = [
                    f"Hi {first_name},",
                    "",
                    "🚀 INTRODUCING: THE LIFESTYLE COMMAND CENTER",
                    f"Your private command center that knows your leads, your pipeline, and your priorities — every single morning.",
                    f"Open it here: {queue_url}",
                    "",
                    "📌 PIN IT TO YOUR BROWSER (takes 5 seconds):",
                    "1. Open the link above in Chrome or Edge on your computer.",
                    "2. Right-click the tab at the top of your browser.",
                    "3. Click 'Pin Tab' from the menu. It shrinks to a small icon and stays pinned.",
                    "4. Done. Every morning, click the pinned icon and your leads load instantly.",
                    "",
                    intro,
                    "",
                    focus,
                    ask,
                    "",
                    "Here's what I'm seeing (tap the link next to each lead to instantly text them from your phone!):",
                    "",
                ]
            else:
                lines = [
                    f"Hi {first_name},",
                    "",
                    f"⚡ Launch Your Daily Tap-to-Text Power Queue: {queue_url}",
                    "",
                    intro,
                    "",
                    focus,
                    ask,
                    "",
                    "Here's what I'm seeing (tap the link next to each lead to instantly text them from your phone!):",
                    "",
                ]
            if is_launch_day:
                html_lines = [
                    f"<p>Hi {first_name},</p>",
                    queue_html_banner,
                    f"<p>{intro}</p>",
                    f"<p>{focus} {ask}</p>",
                    "<p><strong>Here's what I'm seeing below — tap any lead to instantly text them from your phone:</strong></p>",
                    "<ul>"
                ]
            else:
                html_lines = [
                    f"<p>Hi {first_name},</p>",
                    queue_html_banner,
                    f"<p>{intro}</p>",
                    f"<p>{focus} {ask}</p>",
                    "<p><strong>Here's what I'm seeing (tap the link next to each lead to instantly text them from your phone!):</strong></p>",
                    "<ul>"
                ]

        if lead_count > 0:
            for person in sorted(people, key=lambda p: person_name(p).lower())[:100]:
                name = person_name(person)
                stage = person.get("stage") or "Unknown stage"
                lead_id = person.get("id")
                raw_fn = (person.get("firstName") or "").strip(); person_first_name = raw_fn.split()[0].capitalize() if raw_fn.split() else "there"
                
                # Determine city focus
                city, _, _ = self.customer_nurture_context(person)
                
                # Determine days stale
                created_at_str = person.get("created") or person.get("createdAt")
                days_stale = 14 # default fallback
                if created_at_str:
                    try:
                        created_dt = parse_fub_datetime(created_at_str)
                        if created_dt:
                            days_stale = (dt.datetime.now(UTC) - created_dt).days
                    except Exception:
                        pass

                # ── Thread-Aware Context: Fetch recent email thread for this lead ──
                thread_summary = ""
                try:
                    thread_raw = self.get_recent_email_thread(lead_id, limit=3, max_age_days=30)
                    if thread_raw:
                        # Extract just the last exchange for a compact summary
                        last_exchange = thread_raw.strip().split("\n\n")[-1] if thread_raw else ""
                        # Truncate to keep the email manageable
                        thread_summary = last_exchange[:200].strip()
                except Exception:
                    pass

                # Generate SMS text
                sms_body = generate_personalized_sms(
                    first_name=person_first_name,
                    city=city or "Texas",
                    days_stale=days_stale,
                    holiday=holiday,
                    direct_ask=(days_stale > 7),
                    lead_id=str(lead_id)
                )

                # Check if phone number is available
                phones = person.get("phones") or []
                phone_val = phones[0].get("value") or phones[0].get("phone") if phones else None
                
                # Build thread context snippet for display
                thread_html_snippet = ""
                thread_text_snippet = ""
                if thread_summary:
                    thread_text_snippet = f"  └─ Last conversation: {thread_summary}"
                    thread_html_snippet = (
                        f"<br/><span style='color: #4a5568; font-size: 11px; background: #f7fafc; "
                        f"padding: 3px 6px; border-radius: 3px; border-left: 2px solid #667eea;'>"
                        f"💬 Last: {thread_summary}</span>"
                    )

                if phone_val:
                    sms_link = make_sms_uri(phone_val, sms_body, agent_name=first_name, lead_id=str(lead_id))
                    # Plain text line
                    lines.append(f"- {name} ({stage}) — FUB ID {lead_id} ➤ [Tap to Text]: {sms_link}")
                    if thread_text_snippet:
                        lines.append(thread_text_snippet)
                    # HTML line with a beautiful clickable button + thread context
                    html_lines.append(
                        f"<li style='margin-bottom: 12px; list-style-type: none;'>"
                        f"📱 <strong>{name}</strong> ({stage}) — "
                        f"<a href='{sms_link}' style='display: inline-block; padding: 4px 10px; background-color: #25D366; color: white; text-decoration: none; border-radius: 4px; font-weight: bold; font-size: 13px;'>📲 Tap to Text</a>"
                        f"{thread_html_snippet}"
                        f"<br/><span style='color: #666; font-size: 12px; font-style: italic;'>Suggested: \"{sms_body}\"</span>"
                        f"</li>"
                    )
                    
                    # Log a note in Follow Up Boss for the agent on the lead
                    try:
                        note_title = "Click-to-Text Follow-up Reminder Sent"
                        note_body = (
                            f"Automated click-to-text follow-up reminder sent to assigned agent ({first_name}).\n\n"
                            f"Suggested text message:\n\"{sms_body}\""
                        )
                        if thread_summary:
                            note_body += f"\n\nThread context: {thread_summary}"
                        self.fub.add_note(lead_id, note_title, note_body)
                    except Exception as note_exc:
                        LOGGER.warning("Failed to log click-to-text FUB note for person %s: %s", lead_id, note_exc)
                else:
                    lines.append(f"- {name} ({stage}) — FUB ID {lead_id} (No phone number on file)")
                    if thread_text_snippet:
                        lines.append(thread_text_snippet)
                    html_lines.append(
                        f"<li style='margin-bottom: 12px; list-style-type: none;'>📱 <strong>{name}</strong> ({stage}) — "
                        f"<span style='color: #999;'>No phone number on file</span>"
                        f"{thread_html_snippet}"
                        f"</li>"
                    )

        if lead_count > 0:
            if len(people) > 100:
                lines.append(f"- Plus {len(people) - 100} more that are not shown here so the email stays manageable.")
                html_lines.append(f"<li>Plus {len(people) - 100} more that are not shown here so the email stays manageable.</li>")
            html_lines.append("</ul>")

        lines.extend([
            "",
            closing,
            "",
            "Peter",
        ])
        
        html_lines.extend([
            f"<p>{closing}</p>",
            "<p>Best,<br/><strong>Peter Allen</strong></p>"
        ])

        # Send both plain text and HTML versions
        # Per-bot From-name: "AgentFirstName | Lifestyle Design Realty"
        from_display = f"{first_name} | Lifestyle Design Realty <{self.rules.team_email}>"
        self.email.send(
            to_email=to_email,
            subject=subject,
            body="\n".join(lines),
            from_email=from_display,
            reply_to=self.rules.owner_email,
            cc=cc,
            html_body="".join(html_lines),
            bcc=[self.rules.owner_email] if to_email.lower() != self.rules.owner_email.lower() else [],
        )
        if lead_count > 0:
            for person in people:
                self.db.log("agent_followup_reminder", "email_digest_sent", int(person["id"]), {"assignedUserId": assigned_user_id, "to": to_email})
        else:
            self.db.log("agent_followup_reminder", "email_digest_sent", 0, {"assignedUserId": assigned_user_id, "to": to_email, "note": "broadcast_mode_no_leads"})

    def most_recent_note_text(self, notes: List[dict]) -> str:
        if not notes:
            return ""
        note = notes[0]
        raw = str(note.get("body") or note.get("text") or note.get("note") or note.get("subject") or "")
        cleaned = re.sub(r"<[^>]+>", " ", raw)
        cleaned = re.sub(r"https?://\S+", "[link]", cleaned)
        cleaned = re.sub(r"\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b", "[email]", cleaned)
        cleaned = re.sub(r"\b\d{3}[-.)\ s]*\d{3}[-.\s]*\d{4}\b", "[phone]", cleaned)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()[:500]
        # Include the note date so the AI knows how old it is
        note_date = note.get("created") or note.get("date") or note.get("createdAt") or ""
        if note_date:
            return f"[Note dated {note_date[:10]}]: {cleaned}"
        return cleaned

    def was_contacted_recently(self, person: dict, days: int = 3) -> bool:
        """Check if the lead has been contacted recently (within `days` days).
        
        Checks three sources:
        1. Our own database (last bot email sent)
        2. FUB person-level inbound fields (lastReceivedEmail, etc.)
        3. FUB emails API timeline (catches synced Gmail, manual emails, replies)
        """
        person_id = int(person["id"])
        cutoff = dt.datetime.now(UTC) - dt.timedelta(days=days)
        last = self.db.get_last_reengagement(person_id)
        if last and last >= cutoff:
            return True
        if self.has_recent_omnichannel_touch(person, days):
            return True
        # Also check FUB emails API — person-level fields are unreliable for synced emails
        try:
            emails = self.fub.get_emails(person_id, limit=5)
            for e in emails:
                created = e.get("created", "")
                if created:
                    try:
                        email_dt = parse_fub_datetime(created)
                        if email_dt and email_dt >= cutoff:
                            return True
                    except Exception:
                        pass
        except Exception as exc:
            LOGGER.debug("Failed to check FUB emails API for person %s: %s", person_id, exc)
        return False

    def process_reengagement_candidate(self, person: dict) -> str:
        person_id = int(person["id"])
        # ── CHEAP LOCAL CHECKS FIRST (no API calls) ──────────────────────────────
        # These eliminate the majority of candidates without touching the FUB API,
        # keeping the run fast and well under the workflow timeout.
        if self.is_excluded(person) or self.has_any_tag(person, self.rules.phase2_manual_suppression_tags):
            self.db.log("pond_nurture", "suppressed", person_id, {"reason": "excluded stage/tag or manual suppression tag"})
            return "suppressed"
        if not self.qualifies_for_reengagement(person):
            self.db.log("pond_nurture", "suppressed", person_id, {"reason": "not in configured pond"})
            return "suppressed"
        # Source-based exclusion (cheap local check)
        excluded_src = self._is_excluded_source(person)
        if excluded_src:
            self.db.log("pond_nurture", "suppressed", person_id, {"reason": f"excluded source: {excluded_src}"})
            return "suppressed"
        # SOI Total Silence (cheap local check)
        soi_rule = self._is_soi_silenced(person)
        if soi_rule:
            self.db.log("pond_nurture", "soi_silenced", person_id, {"reason": f"soi_silenced (rule matched: {soi_rule})"})
            return "suppressed"

        # ── DEAL PROTECTION (API call, but cached per-run) ────────────────────────
        # Only checked for leads that pass all cheap conditions above.
        # Rule A: ANY deal in FUB deal room → total protection from pond nurture
        if self._has_any_deal(person_id):
            deal_info = self._describe_deals(person_id)
            self.db.log("pond_nurture", "suppressed", person_id, {"reason": f"has deal in FUB deal room ({deal_info}) — protected from all automation"})
            return "suppressed"
        # Rule C: Lease listing silenced leads get TOTAL SILENCE — no pond nurture
        if self._is_lease_listing_silenced(person_id):
            self.db.log("pond_nurture", "suppressed", person_id, {"reason": "lease listing silenced (closed Residential Lease Listing, no purchase deal)"})
            return "suppressed"
        last = self.db.get_last_reengagement(person_id)
        # ── Engagement-Based Cadence (Tier 3) ──
        tier, latest_inbound, _tier_reason = self._classify_engagement(person)
        cadence_days = {"engaged": 10, "standard": 14, "cold": 21}.get(tier, self.rules.reengagement_cadence_days)

        # ── Never-engaged tightening (volume ramp, 2026-08) ──
        # 'cold' holds two populations that deserve different treatment:
        #
        #   LAPSED       replied/called once, but >90 days ago  -> keep 21 days.
        #                They have engaged before, so a slower touch is a
        #                considered choice, not neglect.
        #   NEVER ENGAGED no inbound signal has EVER been recorded -> 14 days.
        #                Nothing about a 21-day gap is working for them, and a
        #                lead who has never responded cannot be annoyed by a
        #                cadence they have never reacted to.
        #
        # Only the second group tightens, and only down to the standard 14 —
        # never below it. Leads with any reply history keep their existing
        # cadence, and the timeline-window override below still STRETCHES from
        # whatever this resolves to, so a lead with a stated future window is
        # unaffected by this branch.
        if tier == "cold" and latest_inbound is None:
            cadence_days = min(cadence_days, self.rules.reengagement_cadence_days)

        # ── EARLY CADENCE GATE (runtime) ─────────────────────────────────────
        # The timeline override below costs a FUB notes fetch plus an Anthropic
        # call, and it used to run for EVERY candidate — including the ~13 in 14
        # that a 14-day cadence means are not due today. Those leads were then
        # discarded a few lines later by the very same gate.
        #
        # On 2026-08-05 that waste dominated the run: 2130 Anthropic calls at
        # ~2.5s each accounted for essentially the entire 91 minutes, and the
        # job was killed by the workflow's 90-minute timeout mid-pond.
        #
        # Gating here is EQUIVALENT, not an approximation. Every timeline branch
        # below applies max(cadence_days, N) — it can only ever lengthen the
        # interval, never shorten it (that is the documented contract, and the
        # never-engaged tightening above has already been applied). So the value
        # of cadence_days at this point is a LOWER BOUND on its final value: a
        # lead too recent for this bound is too recent for any stretched bound,
        # and would have been skipped below regardless. The lead is logged with
        # the same reason and status either way.
        if last and dt.datetime.now(UTC) - last < dt.timedelta(days=cadence_days):
            self.db.log(
                "pond_nurture",
                "skipped",
                person_id,
                {"reason": f"{tier}-tier cadence cap ({cadence_days}d)"},
            )
            return "skipped"

        # ── Timeline-Aware Cadence Override (stretches cadence, never shortens) ──
        is_value_led = False
        notes_for_timeline = self.safe_get_notes(person_id)
        window_result = self.content.extract_purchase_window(person, notes_for_timeline)
        if window_result:
            self.db.upsert_purchase_window(
                person_id,
                window_result["window_start"],
                window_result.get("raw_text"),
                window_result.get("source_note_date"),
            )
        # Check stored window (may be from this cycle or previous)
        stored_window = self.db.get_purchase_window(person_id) if not window_result else window_result
        if stored_window:
            try:
                ws_date = dt.date.fromisoformat(stored_window["window_start"][:10])
                days_until_window = (ws_date - dt.date.today()).days
                if days_until_window > 120:
                    cadence_days = max(cadence_days, 30)  # 30-day cadence for >120 days out
                    is_value_led = True
                    LOGGER.info("Timeline cadence: person %s window %sd out, 30-day cadence", person_id, days_until_window)
                elif days_until_window > 60:
                    cadence_days = max(cadence_days, 21)  # 21-day cadence for 60-120 days out
                    is_value_led = True
                    LOGGER.info("Timeline cadence: person %s window %sd out, 21-day cadence", person_id, days_until_window)
                # <60 days: normal engagement-tier cadence (no override)
            except (ValueError, TypeError) as e:
                LOGGER.warning("Timeline cadence parse error for person %s: %s", person_id, e)

        if last and dt.datetime.now(UTC) - last < dt.timedelta(days=cadence_days):
            self.db.log("pond_nurture", "skipped", person_id, {"reason": f"{tier}-tier cadence cap ({cadence_days}d){' [timeline-adjusted]' if is_value_led else ''}"})
            return "skipped"
        emails = person.get("emails") or []
        if not self.rules.email_outreach_enabled or not emails:
            self.db.log("pond_nurture", "suppressed", person_id, {"reason": "no eligible email channel or email outreach disabled"})
            return "suppressed"

        notes = self.safe_get_notes(person_id)
        should_skip, skip_reason = self.content.should_skip_lead_llm(person, notes)
        if should_skip:
            try:
                self.fub.add_note(
                    person_id,
                    "🤖 Pond Nurture Skipped",
                    "Automated pond nurture email was skipped after reviewing recent FUB notes.\n\n"
                    f"Reason: {skip_reason or 'Recent notes indicate this lead should not receive automated pond nurture right now.'}\n\n"
                    "No email was sent."
                )
            except Exception as note_exc:
                LOGGER.warning("Failed to log LLM pond nurture skip note for person %s: %s", person_id, note_exc)
            self.db.log("pond_nurture", "suppressed", person_id, {"reason": skip_reason or "LLM note review skip"})
            return "suppressed"

        if self.was_contacted_recently(person, days=3):
            self.db.log("pond_nurture", "skipped", person_id, {"reason": "contacted within last 3 days"})
            return "skipped"

        # ── CRITICAL: Check for opt-out replies BEFORE sending any email ──
        # This catches leads who replied "unsubscribe"/"stop" to a previous email.
        # Without this check, leads who opted out would continue receiving emails
        # because the tag-based check only works AFTER the disqualification scan runs.
        opt_out_result = self._check_incoming_opt_out(person_id, person)
        if opt_out_result:
            return opt_out_result

        city, lead_context, city_source = self.customer_nurture_context(person, notes=notes)
        market_context = self.market.get(city) if city else ""
        recent_note_text = self.most_recent_note_text(notes)
        # Fetch recent email thread for thread-aware follow-ups
        recent_email_thread = self.get_recent_email_thread(person_id, limit=5)
        if recent_email_thread:
            LOGGER.info("Thread-aware mode: found email thread for person %s, will continue conversation", person_id)
        # Detect holiday for holiday-aware emails
        from .sms_helpers import get_upcoming_holiday as _get_holiday
        _today_holiday = _get_holiday(dt.datetime.now(ZoneInfo(self.rules.local_timezone)).date()) or ""
        # ── Tier 3 Feature 2: Gather expanded context for deeper personalization ──
        last_angle_used = self.db.get_last_email_angle(person_id) or ""
        # Build full note history (up to 20 notes, chronological)
        full_note_history = ""
        if notes:
            note_snippets = []
            for n in notes[:20]:
                n_body = n.get("body") or n.get("note") or ""
                n_date = n.get("created") or n.get("dateCreated") or ""
                if n_body:
                    note_snippets.append(f"[{n_date[:10]}] {n_body[:300]}")
            full_note_history = "\n".join(note_snippets)
        generated = self.content.generate(
            person, city or "Texas", market_context, lead_context,
            recent_note_text=recent_note_text,
            recent_email_thread=recent_email_thread,
            holiday=_today_holiday,
            engagement_tier=tier,
            full_note_history=full_note_history,
            last_angle_used=last_angle_used,
            is_value_led=is_value_led,
        )
        sent_channels = []
        if self.rules.email_outreach_enabled and emails and not self.has_any_tag(person, self.rules.email_opt_out_tags):
            from_display = f"Lifestyle Design Realty <{self.rules.team_email}>"
            to_email = emails[0].get("value") or emails[0].get("email")
            if to_email:
                self.email.send(
                    to_email,
                    generated["subject"],
                    append_email_footer(generated["email_body"], self.rules),
                    from_email=from_display,
                    reply_to=self.rules.owner_email,
                    html_body=build_pond_email_html(generated["email_body"], self.rules),
                )
                sent_channels.append("email")
        if self.rules.pond_nurture_sms_enabled and not self.has_any_tag(person, self.rules.sms_opt_out_tags):
            phones = person.get("phones") or []
            to_number = None
            for ph in phones:
                val = ph.get("value") or ph.get("phone") or ""
                if val:
                    to_number = re.sub(r"[^\d]", "", val)
                    break
            if to_number and len(to_number) >= 10:
                already_texted = self._check_mysql_sms_today(person_id)
                if not already_texted:
                    sms_body = (
                        generated.get("sms_body")
                        or f"Hi, it's Peter with Lifestyle Design Realty! {generated.get('subject', 'Checking in on your real estate goals')}. Reply anytime — I'm here to help!"
                    )
                    try:
                        self.fub.log_text_message(person_id, sms_body, to_number, self.rules.pond_nurture_sms_from_number)
                        sent_channels.append("sms")
                        self.db.log("pond_nurture", "sms_sent", person_id, {"to_last4": to_number[-4:]})
                    except Exception as sms_exc:
                        LOGGER.warning("Pond nurture SMS failed for person %s: %s", person_id, sms_exc)
                        self.db.log("pond_nurture", "sms_error", person_id, {"error": str(sms_exc)[:300]})
        if sent_channels:
            note_channels = " + ".join(c.upper() for c in sent_channels)
            try:
                self.fub.add_note(
                    person_id,
                    f"Pond Nurture {note_channels} Sent",
                    f"Automated two-week pond nurture outreach sent.\n\n"
                    f"• Channels: {note_channels}\n"
                    f"• City focus: {city or 'Texas/general'}\n"
                    f"• Subject: \"{generated.get('subject')}\"\n"
                    f"• Source: {city_source}"
                )
            except Exception as note_exc:
                LOGGER.warning("Failed to log pond nurture FUB note for person %s: %s", person_id, note_exc)
            self.db.upsert_reengagement(person_id, "+".join(sent_channels), city or "Texas/general", json.dumps(generated))
            _send_status = "dry_run_sent" if self.settings.dry_run else "sent"
            self.db.log("pond_nurture", _send_status, person_id, {
                "channels": sent_channels,
                "city": city or "Texas/general",
                "city_source": city_source,
                "freshness_angle": generated.get("freshness_angle"),
                "subject": generated.get("subject"),
                "engagement_tier": tier,
                "contact_name": person_name(person),
            })
            # Tier 3 Feature 2: Track which angle was used for this lead
            used_angle = generated.get("freshness_angle") or ""
            if used_angle:
                self.db.upsert_email_angle(person_id, used_angle)
            return _send_status
        self.db.log("pond_nurture", "suppressed", person_id, {"reason": "no eligible email channel or email outreach disabled"})
        return "suppressed"


    def _check_mysql_sms_today(self, person_id: int) -> bool:
        """Check if Lifestyle Bot already texted this lead today via MySQL sms_sent_today table.

        Returns True if already texted (skip), False if safe to text.
        Falls back to False (allow text) if MySQL is unavailable.
        """
        try:
            import mysql.connector
            from urllib.parse import urlparse
            db_url = os.environ.get("DATABASE_URL", "")
            if not db_url:
                return False
            parsed = urlparse(db_url)
            # Determine today's date in CT timezone
            try:
                from zoneinfo import ZoneInfo
                ct_tz = ZoneInfo("America/Chicago")
            except Exception:
                ct_tz = None
            if ct_tz:
                today_ct = dt.datetime.now(ct_tz).strftime("%Y-%m-%d")
            else:
                today_ct = dt.datetime.utcnow().strftime("%Y-%m-%d")
            conn = mysql.connector.connect(
                host=parsed.hostname,
                port=parsed.port or 3306,
                user=parsed.username,
                password=parsed.password,
                database=parsed.path.lstrip("/"),
                connect_timeout=5,
            )
            try:
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT 1 FROM sms_sent_today WHERE lead_id = %s AND sent_date = %s LIMIT 1",
                    (person_id, today_ct),
                )
                row = cursor.fetchone()
                return row is not None
            finally:
                conn.close()
        except Exception as exc:
            LOGGER.debug("_check_mysql_sms_today: MySQL unavailable, allowing text for person %s: %s", person_id, exc)
            return False

    # ── Unsubscribe / Opt-Out Detection (pre-send check) ──────────────────────────
    # Keywords that indicate a lead wants to stop receiving messages.
    # Checked against incoming emails and texts BEFORE sending each pond nurture email.
    _OPT_OUT_KEYWORDS = [
        "unsubscribe", "stop emailing", "stop texting", "remove me", "opt out",
        "opt-out", "take me off", "don't email", "don't text", "do not email",
        "do not text", "do not contact", "leave me alone", "stop contacting",
        "stop sending", "no more emails", "no more texts", "cancel subscription",
        "remove from list", "remove from your list", "stop messaging",
    ]

    def _check_incoming_opt_out(self, person_id: int, person: dict) -> Optional[str]:
        """Check if the lead has sent any incoming emails or texts with opt-out language.

        This is the CRITICAL pre-send check that prevents emailing leads who have
        already replied with unsubscribe/stop language. It fetches recent incoming
        communications from the FUB API and scans for opt-out keywords.

        Returns:
            - "opt_out_trashed" if an opt-out was detected and the lead was trashed
            - None if no opt-out detected (safe to proceed with sending)
        """
        try:
            # Fetch recent emails for this person (limit to 10 most recent)
            emails = self.fub.get_emails(person_id, limit=10)
            # Fetch recent texts for this person
            texts = self.fub.get_text_messages(person_id, limit=10)
        except Exception as exc:
            LOGGER.warning("_check_incoming_opt_out: Failed to fetch communications for person %s: %s", person_id, exc)
            # Fail OPEN — if we can't check, allow the email (don't block the entire run)
            return None

        # Check incoming emails for opt-out language
        trigger_snippet = ""
        trigger_source = ""
        for e in emails:
            if not (e.get("isIncoming") or e.get("direction") == "incoming"):
                continue
            body = str(e.get("body") or e.get("subject") or "").lower().strip()
            subject = str(e.get("subject") or "").lower().strip()
            combined = f"{subject} {body}"
            for keyword in self._OPT_OUT_KEYWORDS:
                if keyword in combined:
                    trigger_snippet = (e.get("body") or e.get("subject") or "")[:200]
                    trigger_source = "Inbound Email"
                    break
            if trigger_snippet:
                break

        # Check incoming texts for opt-out language
        if not trigger_snippet:
            for t in texts:
                if not (t.get("isIncoming") or t.get("direction") == "inbound"):
                    continue
                body = str(t.get("message") or t.get("body") or "").lower().strip()
                # Standard keyword check
                for keyword in self._OPT_OUT_KEYWORDS:
                    if keyword in body:
                        trigger_snippet = (t.get("message") or t.get("body") or "")[:200]
                        trigger_source = "Inbound SMS"
                        break
                # Special case: standalone "STOP" is the standard SMS opt-out keyword
                # Only trigger if the entire message is just "stop" (with optional punctuation)
                if not trigger_snippet and body.rstrip('!. ') == 'stop':
                    trigger_snippet = (t.get("message") or t.get("body") or "")[:200]
                    trigger_source = "Inbound SMS"
                if trigger_snippet:
                    break

        if not trigger_snippet:
            return None  # No opt-out detected — safe to send

        # ── OPT-OUT DETECTED: Trash the lead immediately ──
        person_name = f"{person.get('firstName', '')} {person.get('lastName', '')}".strip()
        LOGGER.warning(
            "PRE-SEND OPT-OUT DETECTED: Lead %s has opt-out language in %s. Trashing immediately.",
            person_id, trigger_source,
        )

        if not self.settings.dry_run:
            self.fub.update_person(person_id, {"stage": "Trash", "assignedPondId": None, "assignedUserId": None})
            self.fub.update_person(person_id, {"tags": ["unsubscribed", "opt-out-auto-trash", "bot_suppress"]}, merge_tags=True)

        note_title = "\U0001f6ab Automation: Lead Opted Out & Moved to Trash (Pre-Send Check)"
        note_body = (
            f"Lead automatically unsubscribed and moved to **Trash** stage.\n\n"
            f"\U0001f6d1 Trigger: Opt-out keyword detected in {trigger_source} BEFORE sending pond nurture email\n"
            f"\u2022 Trigger snippet: \"{trigger_snippet[:200]}\"\n\n"
            f"Actions taken:\n"
            f"\u2022 Stage \u2192 Trash\n"
            f"\u2022 Tagged \"unsubscribed\" + \"opt-out-auto-trash\" + \"bot_suppress\"\n"
            f"\u2022 Unassigned from agent\n"
            f"\u2022 All automated outreach permanently stopped\n\n"
            f"This lead replied with opt-out language and was caught by the pre-send safety check."
        )
        try:
            self.fub.add_note(person_id, note_title, note_body)
        except Exception as note_exc:
            LOGGER.warning("Failed to add opt-out note for person %s: %s", person_id, note_exc)

        self.db.log("pond_nurture", "opt_out_trashed", person_id, {
            "trigger_source": trigger_source,
            "trigger_snippet": trigger_snippet[:200],
            "person_name": person_name,
            "dry_run": self.settings.dry_run,
        })
        return "opt_out_trashed"

    def process_stale_agent_no_note_candidate(self, person: dict) -> str:
        person_id = int(person["id"])
        stage = str(person.get("stage", ""))
        if stage.lower() in {s.lower() for s in self.rules.stale_reassignment_excluded_stages}:
            self.db.log("stale_agent_pond_reassignment", "suppressed", person_id, {"reason": "protected stage", "stage": stage})
            return "suppressed"
        if self.is_excluded(person) or self.has_any_tag(person, self.rules.phase2_manual_suppression_tags) or person.get("assignedPondId"):
            self.db.log("stale_agent_pond_reassignment", "suppressed", person_id, {"reason": "excluded/manual suppression/already in pond"})
            return "suppressed"
        if not person.get("assignedUserId"):
            self.db.log("stale_agent_pond_reassignment", "suppressed", person_id, {"reason": "no assigned agent"})
            return "suppressed"
        # Source-based exclusion (cheap local check)
        excluded_src = self._is_excluded_source(person)
        if excluded_src:
            self.db.log("stale_agent_pond_reassignment", "suppressed", person_id, {"reason": f"excluded source: {excluded_src}"})
            return "suppressed"
        # SOI Total Silence (centralized check — replaces inline SOI logic)
        soi_rule = self._is_soi_silenced(person)
        if soi_rule:
            self.db.log("stale_agent_pond_reassignment", "soi_silenced", person_id, {"reason": f"soi_silenced (rule matched: {soi_rule})"})
            return "soi_protected"
        # Legacy fallback: also protect import-sourced leads
        source = str(person.get("source") or "").lower()
        created_via = str(person.get("createdVia") or "").lower()
        created_by_id = int(person.get("createdById") or 0)
        if source == "import" or created_via == "import":
            self.db.log("stale_agent_pond_reassignment", "soi_protected", person_id, {
                "reason": "protected: agent SOI",
                "rule_matched": f"import (source={source}, createdVia={created_via})",
                "source": source,
                "createdVia": created_via,
                "createdById": created_by_id,
            })
            return "soi_protected"
        # CRITICAL: Never reassign leads that have ANY deal in any pipeline (Deal Room)
        if self._has_any_deal(person_id):
            deal_info = self._describe_deals(person_id)
            self.db.log("stale_agent_pond_reassignment", "suppressed", person_id, {"reason": f"suppressed: has deal ({deal_info})"})
            return "suppressed"
            
        # Omnichannel Touch Detection: Skip if lead had any call, text, email, or activity within 20 days
        if self.has_recent_omnichannel_touch(person, self.rules.stale_agent_no_note_days):
            self.db.log("stale_agent_pond_reassignment", "suppressed", person_id, {"reason": "recent omnichannel communication detected"})
            return "suppressed"
            
        pond_id = int(self.rules.stale_agent_reassign_pond_id)
        self.fub.assign_to_pond(person_id, pond_id)
        
        # Peter requested notes on EVERYTHING to lead by example
        try:
            prev_agent = "Unknown"
            if person.get("assignedUserId"):
                user_info = self.user_cache_by_id().get(int(person.get("assignedUserId")), {})
                prev_agent = user_info.get("name") or user_info.get("email") or "Unknown"
            self.fub.add_note(
                person_id,
                "🚨 Automation: Reassigned to Lead Pond",
                f"Lead had NO inbound response (no texts, emails, or calls from the lead) for {self.rules.stale_agent_no_note_days}+ days while assigned to {prev_agent}.\n\n"
                f"Automatically reassigned to Lead Pond for automated re-engagement nurturing. Will auto-reassign back if buying intent detected."
            )
        except Exception as note_exc:
            LOGGER.warning("Failed to log stale agent reassignment FUB note for person %s: %s", person_id, note_exc)
            
        self.db.log("stale_agent_pond_reassignment", "completed", person_id, {
            "assignedPondId": pond_id,
            "days_without_note": self.rules.stale_agent_no_note_days,
            "reason": f"No inbound response from lead in {self.rules.stale_agent_no_note_days}+ days; reassigned to Lead Pond by approved Phase 2 automation.",
            "previous_assigned_user_id": person.get("assignedUserId"),
            "stage": stage,
        })
        return "completed"

    # ─── Deal-Based Protection System ────────────────────────────────────────────
    # Pipeline constants (from live FUB API discovery)
    PURCHASE_PIPELINE_IDS = {1, 2}  # Buyers, Sellers
    LEASE_LISTING_PIPELINE_ID = 5   # Residential Lease Listings

    def _get_person_deals(self, person_id: int, _attempt: int = 1) -> List[dict]:
        """Fetch and cache all deals for a person. Cache lasts for the entire run.

        FAIL-CLOSED. This used to swallow the error and return [] — which every
        caller reads as "this person has no deals", silently disabling the
        strongest do-not-email guard in the system. One FUB hiccup and a lead
        mid-transaction gets a nurture email.

        Now: retry once after a short backoff, and if it still fails, raise
        DealCheckUnavailable. Each rule catches it and resolves in whichever
        direction means DO NOT SEND (see _has_any_deal / _has_closed_purchase_deal
        / _is_lease_listing_silenced). A delayed nurture email is cheap; emailing
        someone mid-deal is not.
        """
        if not hasattr(self, "_deal_cache"):
            self._deal_cache: dict = {}
        if person_id in self._deal_cache:
            cached = self._deal_cache[person_id]
            if cached is _DEAL_FETCH_FAILED:
                # Already failed this run — don't re-hit the API per rule.
                raise DealCheckUnavailable(f"deals unavailable for person {person_id} (cached failure)")
            return cached
        try:
            resp = self.fub._request("GET", "/deals", params={"personId": person_id, "limit": 25})
            deals = resp.get("deals", resp.get("data", []))
            self._deal_cache[person_id] = deals
            return deals
        except Exception as exc:  # noqa: BLE001
            if _attempt < _DEAL_FETCH_ATTEMPTS:
                LOGGER.warning("Deals fetch failed for person %s (attempt %d/%d): %s — retrying",
                               person_id, _attempt, _DEAL_FETCH_ATTEMPTS, exc)
                time.sleep(_DEAL_RETRY_BACKOFF_SECONDS)
                return self._get_person_deals(person_id, _attempt + 1)
            # Exhausted. Cache the FAILURE (never []) so the other rules in this
            # run fail closed too instead of seeing a false "no deals".
            LOGGER.error("Deals fetch FAILED for person %s after %d attempts: %s — failing CLOSED",
                         person_id, _DEAL_FETCH_ATTEMPTS, exc)
            self._deal_cache[person_id] = _DEAL_FETCH_FAILED
            self._deal_check_failed_closed = getattr(self, "_deal_check_failed_closed", 0) + 1
            try:
                self.db.log("deal_check_failed_closed", "suppressed", person_id,
                            {"reason": "FUB deals API unavailable after retry — treating as HAS-DEAL",
                             "attempts": _DEAL_FETCH_ATTEMPTS, "error": str(exc)[:200]})
            except Exception:  # noqa: BLE001 — logging must never mask the raise
                pass
            raise DealCheckUnavailable(
                f"deals unavailable for person {person_id} after {_DEAL_FETCH_ATTEMPTS} attempts"
            ) from exc

    def _describe_deals(self, person_id: int) -> str:
        """Human-readable deal summary for a suppression log line.

        Safe to call after a fail-closed block: _has_any_deal may have returned
        True *because* the fetch failed, in which case re-fetching would raise
        and abort the run. Never raises — the description is cosmetic, the
        suppression decision has already been made."""
        try:
            deals = self._get_person_deals(person_id)
        except DealCheckUnavailable:
            return "deal check unavailable — failed closed"
        return ", ".join(
            d.get("pipelineName", "?") + "/" + d.get("stageName", "?") for d in deals[:3]
        ) or "unknown"

    def _has_any_deal(self, person_id: int) -> bool:
        """Rule A: Person has ANY deal (any pipeline, any stage, open or closed).
        If True, suppress pond reassignment entirely.

        Fail-closed: if the deals API is unavailable, treat the person as HAVING
        a deal so nothing is sent."""
        try:
            deals = self._get_person_deals(person_id)
        except DealCheckUnavailable:
            LOGGER.warning("Person %s: deal check unavailable — failing CLOSED (treating as has-deal)", person_id)
            return True
        if deals:
            pipelines = ", ".join(set(d.get("pipelineName", "?") + "/" + d.get("stageName", "?") for d in deals))
            LOGGER.info("Person %s has %d deal(s) [%s] — protected from pond reassignment", person_id, len(deals), pipelines)
        return len(deals) > 0

    def _has_closed_purchase_deal(self, person_id: int) -> bool:
        """Rule B: Person has a CLOSED deal in Buyers (1) or Sellers (2) pipeline.
        These leads get Phase 3 quarterly drip.

        Fail-closed here means returning FALSE, not True: this rule grants
        ELIGIBILITY to send, so an unknown answer must withhold it. (The other
        two rules block by returning True — all three converge on DO NOT SEND.)"""
        try:
            deals = self._get_person_deals(person_id)
        except DealCheckUnavailable:
            LOGGER.warning("Person %s: deal check unavailable — failing CLOSED (not Phase-3 eligible)", person_id)
            return False
        for deal in deals:
            pipeline_id = int(deal.get("pipelineId") or 0)
            is_closed = bool(deal.get("closedStage")) or str(deal.get("stageName", "")).lower() == "closed"
            if pipeline_id in self.PURCHASE_PIPELINE_IDS and is_closed:
                return True
        return False

    def _is_lease_listing_silenced(self, person_id: int) -> bool:
        """Rule C: Person has a closed deal in Residential Lease Listings (pipeline 5)
        AND does NOT have a closed purchase deal. Total silence — no pond, no reassignment,
        no Phase 3, no agent-bot emails, no pond nurture.
        If they have BOTH a closed lease listing AND a closed purchase deal, purchase wins.

        Fail-closed: unavailable deals API means SILENCE."""
        try:
            deals = self._get_person_deals(person_id)
        except DealCheckUnavailable:
            LOGGER.warning("Person %s: deal check unavailable — failing CLOSED (silencing)", person_id)
            return True
        has_closed_lease = False
        has_closed_purchase = False
        for deal in deals:
            pipeline_id = int(deal.get("pipelineId") or 0)
            is_closed = bool(deal.get("closedStage")) or str(deal.get("stageName", "")).lower() in ("closed", "lease listing - closed")
            if pipeline_id == self.LEASE_LISTING_PIPELINE_ID and is_closed:
                has_closed_lease = True
            if pipeline_id in self.PURCHASE_PIPELINE_IDS and is_closed:
                has_closed_purchase = True
        # Purchase deal wins over lease listing
        if has_closed_lease and not has_closed_purchase:
            LOGGER.info("Person %s is LEASE LISTING SILENCED (closed lease, no purchase deal)", person_id)
            return True
        return False

    def _has_active_deal(self, person_id: int) -> bool:
        """Legacy compat: now returns True if person has ANY deal (upgraded from active-only)."""
        return self._has_any_deal(person_id)

    def customer_nurture_context(self, person: dict, notes: Optional[List[dict]] = None) -> Tuple[str, str, str]:
        loaded_notes: List[dict] = list(notes or [])
        note_text = ""
        note_city = ""
        if self.rules.customer_nurture_note_city_lookup_enabled:
            if not loaded_notes:
                loaded_notes = self.safe_get_notes(int(person["id"]))
            note_text = " ".join(str(n.get("body") or n.get("text") or n.get("note") or "") for n in loaded_notes[:25])
            note_city = infer_city_from_text(note_text, self.rules.target_cities)
        field_city = infer_city(person, self.rules.target_cities)
        city = note_city or field_city
        city_source = "fub_notes" if note_city else ("lead_fields" if field_city else "texas_fallback")
        lead_context = summarize_lead_context_from_notes(loaded_notes, city, self.rules.target_cities)
        return city, lead_context, city_source

    def city_for_customer_nurture(self, person: dict) -> str:
        city, _, _ = self.customer_nurture_context(person)
        return city

    def safe_get_notes(self, person_id: int) -> List[dict]:
        try:
            return self.fub.get_notes(person_id)
        except Exception as exc:  # noqa: BLE001
            LOGGER.warning("Could not fetch FUB notes for person %s: %s", person_id, exc)
            return []

    def get_recent_email_thread(self, person_id: int, limit: int = 5, max_age_days: int = 30) -> str:
        """Fetch the most recent emails for a lead and format them as a readable thread.

        Returns a formatted string showing the last few email exchanges (who sent what,
        when, subject) so the AI can continue the conversation naturally.
        Returns empty string if no emails found, all are older than max_age_days, or on error.

        Args:
            person_id: FUB person ID
            limit: Max number of emails to fetch from API
            max_age_days: Ignore emails older than this many days (default 30).
                          Prevents the bot from referencing stale conversations.
        """
        try:
            emails = self.fub.get_emails(person_id, limit=limit)
        except Exception as exc:  # noqa: BLE001
            LOGGER.debug("Could not fetch FUB emails for thread context, person %s: %s", person_id, exc)
            return ""
        if not emails:
            return ""

        # Filter out emails older than max_age_days (staleness threshold)
        staleness_cutoff = dt.datetime.now(UTC) - dt.timedelta(days=max_age_days)
        fresh_emails = []
        for e in emails:
            created = e.get("created") or e.get("createdAt") or ""
            parsed = parse_fub_datetime(created)
            if parsed and parsed >= staleness_cutoff:
                fresh_emails.append(e)
            elif not parsed:
                # If we can't parse the date, include it (benefit of the doubt)
                fresh_emails.append(e)

        if not fresh_emails:
            LOGGER.debug("All emails for person %s are older than %d days, ignoring thread", person_id, max_age_days)
            return ""

        # Sort by created date ascending (oldest first) so the thread reads chronologically
        def email_sort_key(e: dict):
            created = e.get("created") or e.get("createdAt") or ""
            parsed = parse_fub_datetime(created)
            return parsed or dt.datetime.min.replace(tzinfo=UTC)

        sorted_emails = sorted(fresh_emails, key=email_sort_key)

        thread_lines: List[str] = []
        for e in sorted_emails:
            is_incoming = e.get("isIncoming") or e.get("direction") == "incoming"
            direction_label = "LEAD REPLIED" if is_incoming else "PETER SENT"
            subject = (e.get("subject") or "").strip()
            body = (e.get("body") or e.get("message") or "").strip()
            created = e.get("created") or e.get("createdAt") or ""

            # Sanitize body: strip HTML, redact sensitive info, truncate
            body = re.sub(r"<[^>]+>", " ", body)
            body = re.sub(r"https?://\S+", "[link]", body)
            body = re.sub(r"\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b", "[email]", body)
            body = re.sub(r"\b\d{3}[-.)\ s]*\d{3}[-.\s]*\d{4}\b", "[phone]", body)
            body = re.sub(r"\s+", " ", body).strip()[:400]

            # Format the date nicely
            date_str = ""
            parsed_dt = parse_fub_datetime(created)
            if parsed_dt:
                date_str = parsed_dt.strftime("%b %d, %Y %I:%M %p")

            entry = f"[{direction_label}] ({date_str})"
            if subject:
                entry += f" Subject: {subject}"
            if body:
                entry += f"\n  {body}"
            thread_lines.append(entry)

        if not thread_lines:
            return ""

        return "\n\n".join(thread_lines)

    def has_recent_note(self, notes: List[dict], within_days: int) -> bool:
        cutoff = dt.datetime.now(UTC) - dt.timedelta(days=within_days)
        for note in notes:
            value = note.get("created") or note.get("createdAt") or note.get("createdDate") or note.get("updated") or note.get("updatedAt")
            parsed = parse_dt(value) if value else None
            if parsed and parsed >= cutoff:
                return True
        return False

    def sender_email_for_person(self, person: dict) -> str:
        """Return Peter by default, or assigned agent first-name email when configured.

        Gmail must be configured to allow the authenticated sender to send as this address.
        """
        if not self.rules.use_agent_sender_for_assigned_leads:
            return self.rules.owner_email
        assigned = person.get("assignedUser") or person.get("assignedUserName") or person.get("assignedTo") or ""
        if isinstance(assigned, dict):
            assigned = assigned.get("name") or assigned.get("firstName") or ""
        if not assigned and person.get("assignedUserId"):
            try:
                assigned_user = self.user_cache_by_id().get(int(person.get("assignedUserId")))
                assigned = assigned_user.get("name") or assigned_user.get("firstName") or "" if assigned_user else ""
            except Exception:  # noqa: BLE001
                assigned = ""
        first_name = str(assigned).strip().split()[0] if str(assigned).strip() else ""
        if not first_name or first_name.lower() == "peter":
            return self.rules.owner_email
        safe_first = "".join(ch for ch in first_name.lower() if ch.isalnum())
        return f"{safe_first}@{self.rules.email_sender_domain}" if safe_first else self.rules.owner_email

    def user_cache_by_id(self) -> Dict[int, dict]:
        if self._user_cache_by_id is None:
            self._user_cache_by_id = {int(u["id"]): u for u in self.fub.users() if u.get("id") is not None}
        return self._user_cache_by_id

    # How far back an unanswered reply stays on the daily NEEDS A REPLY list.
    # Matches the retro-repair window: nothing older can have a backfilled row.
    NEEDS_REPLY_BACKLOG_DAYS = 14

    def _collect_needs_reply(self, backlog_days: int = NEEDS_REPLY_BACKLOG_DAYS) -> List[dict]:
        """Every lead who wrote back and has not been written back to.

        Candidates are the reply_detected rows (live alerts and the retro
        repair's 'backfilled' rows). A lead leaves the list when:
          - a disqualification row follows the reply — they replied to leave;
          - FUB shows ANY outbound message after their reply. "Replied -
            Paused" blocks the bot from mailing them, so an outbound message
            after the reply is a human answering — including Peter replying
            from Gmail, which FUB's mailbox sync logs to the lead's timeline.
        If FUB cannot be asked, the lead STAYS listed: showing an already-
        answered lead costs a glance, dropping a waiting one costs the lead.
        """
        now = dt.datetime.now(UTC)
        since = now - dt.timedelta(days=backlog_days)
        # Alerts the repair sweep voided as false positives (a third party's
        # email, not the lead's) — those leads are not waiting on anyone.
        voided = set()
        for row in self.db.recent_audit_rows(["reply_false_positive_cleared"], since):
            pid = row.get("person_id")
            if not pid:
                continue
            try:
                cleared_reply_at = json.loads(row.get("details") or "{}").get("reply_at")
            except Exception:  # noqa: BLE001
                cleared_reply_at = None
            if cleared_reply_at:
                voided.add((int(pid), cleared_reply_at))
        candidates: Dict[int, dict] = {}
        for row in self.db.recent_audit_rows(["reply_detected"], since):
            if row.get("status") not in ("alert_sent", "backfilled"):
                continue
            pid = row.get("person_id")
            if not pid:
                continue
            pid = int(pid)
            try:
                details = json.loads(row.get("details") or "{}")
            except Exception:  # noqa: BLE001
                details = {}
            reply_at = parse_fub_datetime(details.get("reply_at")) \
                or parse_fub_datetime(row.get("created_at"))
            if not reply_at:
                continue
            if (pid, str(details.get("reply_at"))) in voided:
                continue
            entry = {
                "person_id": pid,
                "name": (details.get("contact_name") or "").strip() or f"Lead #{pid}",
                "snippet": details.get("reply_snippet") or details.get("snippet") or "",
                "channel": details.get("reply_channel") or "email",
                "reply_at": reply_at,
            }
            prev = candidates.get(pid)
            if prev is None or reply_at > prev["reply_at"]:
                candidates[pid] = entry

        if not candidates:
            return []

        # They replied to leave, or their FUB record no longer exists — either
        # way nobody owes them an answer (lead_deleted rows come from the
        # daily deleted-lead sweep; Stephen Herrera haunted this list for a
        # day after his record was deleted).
        for row in self.db.recent_audit_rows(
                ["reply_intent_disqualification", "pond_opt_out_trash", "lead_deleted"],
                since):
            pid = row.get("person_id")
            if pid:
                candidates.pop(int(pid), None)

        # The bot's own sends, so an automated email can never read as a human
        # answering. Going forward "Replied - Paused" stops the bot the moment
        # a reply is detected, but the backfilled fortnight predates the tag —
        # the bot kept mailing some of those repliers, and those sends must
        # not silently clear them from this list.
        bot_sends: Dict[int, List[dt.datetime]] = {}
        try:
            from .funnel import EMAIL_SEND_ACTIONS as _SEND_ACTIONS
            from .funnel import SENT_STATUSES as _SENT_STATUSES

            for row in self.db.recent_audit_rows(_SEND_ACTIONS, since):
                pid = row.get("person_id")
                if not pid or row.get("status") not in _SENT_STATUSES:
                    continue
                sent_ts = parse_fub_datetime(row.get("created_at"))
                if sent_ts:
                    bot_sends.setdefault(int(pid), []).append(sent_ts)
        except Exception as exc:  # noqa: BLE001
            LOGGER.warning("NEEDS A REPLY: could not load bot send times: %s", exc)

        def _is_bot_send(pid: int, ts: dt.datetime) -> bool:
            # FUB's logged copy and our audit row disagree by sync latency, so
            # match on proximity rather than equality.
            return any(abs((ts - bot_ts).total_seconds()) <= 300
                       for bot_ts in bot_sends.get(pid, []))

        needs: List[dict] = []
        for pid, entry in candidates.items():
            answered = False
            try:
                messages = [
                    *self.fub.get_emails(pid, limit=10),
                    *self.fub.get_text_messages(pid, limit=10),
                ]
                for msg in messages:
                    if is_inbound_message(msg):
                        continue
                    sent_ts = message_timestamp(msg)
                    if sent_ts and sent_ts > entry["reply_at"] and not _is_bot_send(pid, sent_ts):
                        answered = True
                        break
            except Exception as exc:  # noqa: BLE001
                LOGGER.warning(
                    "NEEDS A REPLY: could not verify lead %s against FUB (%s) — "
                    "keeping them on the list", pid, exc)
            if not answered:
                entry["hours_waiting"] = max(
                    0.0, (now - entry["reply_at"]).total_seconds() / 3600.0)
                needs.append(entry)

        # Longest-waiting first: the top of the list is the person most owed.
        needs.sort(key=lambda e: e["reply_at"])
        return needs

    def send_phase2_daily_summary(self) -> None:
        if not self.rules.phase2_daily_summary_enabled:
            return
        if not (self.rules.customer_reengagement_emails_enabled or self.rules.stale_agent_no_note_reassignment_enabled):
            return
        # Use today midnight CT (not 24h rolling window) to avoid double-counting across days
        from zoneinfo import ZoneInfo
        _ct = ZoneInfo('America/Chicago')
        _local_today_start = dt.datetime.now(_ct).replace(hour=0, minute=0, second=0, microsecond=0)
        since = _local_today_start.astimezone(UTC)
        rows = self.db.recent_audit_rows(["pond_nurture", "stale_agent_pond_reassignment"], since)
        # Leads skipped today because the FUB deals API was unreachable and the
        # send-blocking check failed CLOSED. Without this line a FUB outage looks
        # like a quiet day rather than a suppressed run.
        deal_failed_rows = self.db.recent_audit_rows(["deal_check_failed_closed"], since)
        deal_failed_closed_today = len(deal_failed_rows)

        # Untouched-assignment alerts fired today (assignment safety net)
        untouched_alerts: List[dict] = []
        for _ua_row in self.db.recent_audit_rows(["untouched_assignment_alert"], since):
            if _ua_row.get("status") in {"created", "dry_run_created"}:
                try:
                    _ua_details = json.loads(_ua_row.get("details") or "{}")
                except Exception:  # noqa: BLE001
                    _ua_details = {}
                _ua_details["person_id"] = _ua_row.get("person_id")
                untouched_alerts.append(_ua_details)

        # NEEDS A REPLY — collected before the quiet-day gate below, because an
        # unanswered lead makes the day worth an email even when nothing sent.
        # A collection failure must cost the section, never the summary: the
        # error is rendered in its place, so absence always means a bug.
        needs_reply: List[dict] = []
        needs_reply_error: Optional[str] = None
        try:
            needs_reply = self._collect_needs_reply()
        except Exception as _nr_exc:  # noqa: BLE001
            needs_reply_error = str(_nr_exc)
            LOGGER.warning("NEEDS A REPLY collection failed: %s", _nr_exc)

        # Auto-replies classified in the window — one FYI count line, so the
        # filtered-out messages are visible without paging anyone over them.
        auto_replies_recent = 0
        try:
            auto_replies_recent = len({
                r.get("person_id")
                for r in self.db.recent_audit_rows(
                    ["auto_reply_detected"],
                    dt.datetime.now(UTC) - dt.timedelta(days=self.NEEDS_REPLY_BACKLOG_DAYS))
            })
        except Exception:  # noqa: BLE001
            pass

        # Unverified inbound — email on a lead's record that the thread-
        # lineage gate refused to treat as a reply (third-party mail, or a
        # genuine reply on a brand-new thread). Listed by name so a human
        # reviews each one; never paged, never tagged, never counted WARM.
        # Last 24h only: nothing acknowledges these, so a wider window would
        # re-list the same lender email every day until it aged out — the
        # FUB note on the record is the durable pointer, this line is news.
        unverified_inbound: List[dict] = []
        try:
            seen_unverified = set()
            for r in self.db.recent_audit_rows(
                    ["unverified_inbound"],
                    dt.datetime.now(UTC) - dt.timedelta(days=1)):
                pid = r.get("person_id")
                if not pid or int(pid) in seen_unverified:
                    continue
                seen_unverified.add(int(pid))
                try:
                    _uv_details = json.loads(r.get("details") or "{}")
                except Exception:  # noqa: BLE001
                    _uv_details = {}
                unverified_inbound.append({
                    "person_id": int(pid),
                    "name": (_uv_details.get("contact_name") or "").strip()
                            or f"Lead #{pid}",
                })
        except Exception as _uv_exc:  # noqa: BLE001
            LOGGER.warning("Unverified-inbound collection failed: %s", _uv_exc)

        if not rows and not deal_failed_closed_today and not untouched_alerts \
                and not needs_reply and not needs_reply_error \
                and not unverified_inbound:
            return

        # Warm leads today — the one funnel number worth seeing daily rather than
        # waiting a week for. Same WARM definition the weekly digest uses (a
        # reply that was not an opt-out), imported from funnel.py so the daily
        # and weekly numbers can never drift apart. Read-only, and wrapped
        # because instrumentation must never cost Peter the summary itself.
        new_warm_today_count = 0
        try:
            from .funnel import new_warm_today as _new_warm_today

            with self.db.connect() as _con:
                new_warm_today_count = _new_warm_today(_con, since, dt.datetime.now(UTC))
        except Exception as _funnel_exc:  # noqa: BLE001
            LOGGER.warning("Daily funnel count unavailable: %s", _funnel_exc)

        # Volume-ramp footer: which cap ran today, which step it came from, and
        # whether the guardrails are holding it. Degrades to a plain line rather
        # than vanishing, so its absence always means a bug and never a hold.
        ramp_status_line = "Cap: unavailable"
        try:
            from .ramp import status_line as _ramp_status

            with self.db.connect() as _con:
                ramp_status_line = _ramp_status(_con)
        except Exception as _ramp_exc:  # noqa: BLE001
            LOGGER.warning("Ramp status unavailable: %s", _ramp_exc)
        counts: Dict[Tuple[str, str], int] = {}
        examples: List[str] = []
        reassigned_leads_for_peter: List[dict] = []
        
        # Load SMS helpers (package-relative; degrades if unavailable)
        try:
            from .sms_helpers import generate_personalized_sms, make_sms_uri, get_upcoming_holiday
        except ModuleNotFoundError:
            # sms_helpers not available — skip SMS-specific summary content
            generate_personalized_sms = None
            make_sms_uri = None
            def get_upcoming_holiday(d): return None
        holiday = get_upcoming_holiday(dt.date.today())

        for row in rows:
            key = (str(row.get("action")), str(row.get("status")))
            counts[key] = counts.get(key, 0) + 1
            status = row.get("status")
            action = row.get("action")
            person_id = row.get("person_id")
            
            if len(examples) < 20 and status in {"sent", "dry_run_sent", "completed", "error", "launch_cap_reached"}:
                try:
                    details = json.loads(row.get("details") or "{}")
                except Exception:  # noqa: BLE001
                    details = {}
                pid = person_id or "run"
                summary_bits = []
                for name in ("city", "city_source", "freshness_angle", "reason", "stage"):
                    val = details.get(name)
                    if val:
                        # Clean up formatting for easier reading
                        clean_name = name.replace("_", " ").title()
                        summary_bits.append(f"{clean_name}: {val}")
                examples.append(f"• FUB ID {pid} ({status})" + (f" ➔ {', '.join(summary_bits)}" if summary_bits else ""))
            
            # If this is a lead that was successfully reassigned back to the Lead Pond, collect it for Peter's text list
            if action == "stale_agent_pond_reassignment" and status == "completed" and person_id:
                try:
                    person = self.fub.get_person(int(person_id))
                    if person:
                        reassigned_leads_for_peter.append(person)
                except Exception as p_exc:
                    LOGGER.warning("Failed to fetch reassigned lead details for Peter's text list: %s", p_exc)
        
        # Format the counts to be beautifully readable
        counts_formatted = []
        for (action, status), count in sorted(counts.items()):
            # Translate technical action/status into beautiful human text
            clean_action = action.replace("_", " ").title()
            clean_status = status.replace("_", " ").title()
            
            # Choose appropriate emoji based on status
            emoji = "✅"
            if status == "error":
                emoji = "❌"
            elif status == "dry_run_sent":
                emoji = "🧪"
            elif status == "launch_cap_reached":
                emoji = "⚠️"
            elif "reassignment" in action:
                emoji = "🔄"
            elif "nurture" in action:
                emoji = "✉️"
                
            counts_formatted.append(f" {emoji}  {clean_action} ({clean_status}): {count}")

        # ── NEEDS A REPLY — rendered right under the header because it is the
        # one section Peter opens this email for. Both formats are built here,
        # once, so the plain and HTML emails can never disagree.
        nr_plain: List[str] = []
        nr_html: List[str] = []
        if needs_reply_error:
            nr_plain += [f"⚠️ NEEDS A REPLY — could not be computed: {needs_reply_error}", ""]
            nr_html.append(
                f'<p style="color:#b45309;"><strong>⚠️ NEEDS A REPLY</strong> — '
                f"could not be computed: {needs_reply_error}</p>")
        elif not needs_reply:
            nr_plain += ["📬 NEEDS A REPLY — none. Every reply has an answer.", ""]
            nr_html.append(
                '<p style="color:#166534;"><strong>📬 NEEDS A REPLY — none.</strong> '
                "Every reply has an answer.</p>")
        else:
            nr_plain += [
                f"📬 NEEDS A REPLY — {len(needs_reply)} lead(s) waiting on a human",
                "----------------------------------------",
            ]
            nr_html.append(
                f'<h3 style="color:#b91c1c;">📬 NEEDS A REPLY — {len(needs_reply)} '
                "lead(s) waiting on a human</h3>"
                "<p>Real replies with no answer yet, longest-waiting first "
                "(auto-replies already filtered out):</p>")
            nr_html.append("<ul style='padding-left: 0;'>")
            for entry in needs_reply[:30]:
                fub_url = f"https://www.followupboss.com/2/people/view/{entry['person_id']}"
                wait = format_hours_waiting(entry["hours_waiting"])
                snippet = (entry["snippet"] or "(no text captured)")[:160]
                nr_plain.append(
                    f"• {entry['name']} — waiting {wait} — \"{snippet}\" → {fub_url}")
                _wait_colour = "#b91c1c" if entry["hours_waiting"] >= 24 else "#b45309"
                nr_html.append(
                    f"<li style='margin-bottom: 10px; list-style-type: none; "
                    f"border-left: 3px solid {_wait_colour}; padding-left: 10px;'>"
                    f"<strong>{entry['name']}</strong> "
                    f"<span style='color:{_wait_colour};font-weight:bold;'>waiting {wait}</span> "
                    f"({entry['channel']})<br/>"
                    f"<span style='color:#444;font-style:italic;'>&ldquo;{snippet}&rdquo;</span><br/>"
                    f"<a href='{fub_url}' style='font-size:13px;'>Open in FUB →</a>"
                    f"</li>")
            nr_html.append("</ul>")
            if len(needs_reply) > 30:
                nr_plain.append(f"…and {len(needs_reply) - 30} more.")
                nr_html.append(f"<p>…and {len(needs_reply) - 30} more.</p>")
            nr_plain.append("")
        if auto_replies_recent:
            nr_plain += [
                f"🤖 {auto_replies_recent} auto-repl{'y' if auto_replies_recent == 1 else 'ies'} "
                "classified in the last 14 days (out-of-office etc.) — filtered out, "
                "not counted warm.",
                "",
            ]
            nr_html.append(
                f'<p style="color:#6b7280;font-size:0.9em;">🤖 {auto_replies_recent} '
                f"auto-repl{'y' if auto_replies_recent == 1 else 'ies'} classified in the "
                "last 14 days (out-of-office etc.) — filtered out, not counted warm.</p>")
        if unverified_inbound:
            _uv_names = ", ".join(
                f"{e['name']} (https://www.followupboss.com/2/people/view/{e['person_id']})"
                for e in unverified_inbound[:10])
            nr_plain += [
                f"❓ UNVERIFIED INBOUND — {len(unverified_inbound)} lead(s) received "
                "email on a thread the automation never started (third-party mail, "
                f"or a reply on a brand-new thread). Review: {_uv_names}",
                "",
            ]
            nr_html.append(
                f'<p style="color:#92400e;font-size:0.9em;">❓ '
                f"<strong>UNVERIFIED INBOUND — {len(unverified_inbound)}</strong> "
                "lead(s) received email on a thread the automation never started "
                "(third-party mail, or a reply on a brand-new thread). Review: "
                + ", ".join(
                    f"<a href='https://www.followupboss.com/2/people/view/{e['person_id']}'>"
                    f"{e['name']}</a>"
                    for e in unverified_inbound[:10])
                + ".</p>")

        # Plain text lines
        lines = [
            "Hi Peter! 👋",
            "",
            "Here is your clean, organized Phase 2 automation update from the last 24 hours. 🚀",
            "",
            *nr_plain,
            "📊 QUICK METRICS SUMMARY",
            "----------------------------------------",
            *counts_formatted,
            "",
            # Funnel one-liner: warm leads should surface the day they go warm,
            # not sit until Monday's digest.
            f"📈 FUNNEL — {new_warm_today_count} new WARM lead(s) today "
            "(replied, not an opt-out). Full funnel in Monday's digest.",
            "",
            ramp_status_line,
            "",
        ]
        # Fail-closed deal checks: leads we deliberately did NOT touch today
        # because FUB's deals API was unreachable. Surfaced so a silent outage
        # reads as "suppressed", not as "quiet day".
        if deal_failed_closed_today:
            lines += [
                f"⚠️  {deal_failed_closed_today} lead(s) skipped — FUB deals API unavailable "
                "(deal check failed CLOSED, so nothing was sent).",
                "",
            ]

        # HTML lines
        html_lines = [
            "<p>Hi Peter! 👋</p>",
            "<p>Here is your clean, organized Phase 2 automation update from the last 24 hours. 🚀</p>",
            *nr_html,
            "<h3>📊 QUICK METRICS SUMMARY</h3>",
            "<ul>"
        ]
        for c_fmt in counts_formatted:
            html_lines.append(f"<li>{c_fmt}</li>")
        html_lines.append("</ul>")
        # Funnel one-liner — green when there is something to celebrate, muted
        # when there is not, so a zero does not read as an alert.
        _warm_colour = "#166534" if new_warm_today_count else "#6b7280"
        html_lines.append(
            f'<p style="color:{_warm_colour};"><strong>📈 FUNNEL — '
            f"{new_warm_today_count} new WARM lead(s) today</strong> "
            "(replied, not an opt-out). Full funnel in Monday's digest.</p>"
        )
        _ramp_colour = "#b45309" if "HELD" in ramp_status_line else "#6b7280"
        html_lines.append(
            f'<p style="color:{_ramp_colour};font-size:0.9em;">🚦 {ramp_status_line}</p>'
        )
        if deal_failed_closed_today:
            html_lines.append(
                f'<p style="color:#b45309;"><strong>⚠️ {deal_failed_closed_today} lead(s) skipped</strong> — '
                "FUB deals API unavailable (deal check failed CLOSED, so nothing was sent).</p>")

        # Add Peter's direct Tap-to-Text section if we have reassigned leads
        if reassigned_leads_for_peter:
            lines.append("📲 REASSIGNED LEADS WAITING (Tap to Text)")
            lines.append("----------------------------------------")
            lines.append("These leads went untouched for 20+ days, were reassigned back to the Lead Pond, and are now getting your auto-emails every 2 weeks. Tap below to text them directly from your phone to speed up re-engagement:")
            
            html_lines.append("<h3>📲 REASSIGNED LEADS WAITING (Tap to Text)</h3>")
            html_lines.append("<p>These leads went untouched for 20+ days, were reassigned back to the Lead Pond, and are now getting your auto-emails every 2 weeks. <strong>Tap below to text them directly from your phone to speed up re-engagement:</strong></p>")
            html_lines.append("<ul style='padding-left: 0;'>")
            
            for person in reassigned_leads_for_peter[:50]: # Limit to 50 for email size
                name = person_name(person)
                stage = person.get("stage") or "Unknown stage"
                lead_id = person.get("id")
                raw_fn = (person.get("firstName") or "").strip(); person_first_name = raw_fn.split()[0].capitalize() if raw_fn.split() else "there"
                city, _, _ = self.customer_nurture_context(person)
                
                # Determine days stale (should be 20+ since they were reassigned)
                created_at_str = person.get("created") or person.get("createdAt")
                days_stale = 20
                if created_at_str:
                    try:
                        created_dt = parse_fub_datetime(created_at_str)
                        if created_dt:
                            days_stale = (dt.datetime.now(UTC) - created_dt).days
                    except Exception:
                        pass
                
                # Generate Peter's direct, holiday-aware SMS text
                sms_body = generate_personalized_sms(
                    first_name=person_first_name,
                    city=city or "Texas",
                    days_stale=days_stale,
                    holiday=holiday,
                    direct_ask=True
                )
                
                phones = person.get("phones") or []
                phone_val = phones[0].get("value") or phones[0].get("phone") if phones else None
                
                if phone_val:
                    sms_link = make_sms_uri(phone_val, sms_body, agent_name="Peter", lead_id=str(lead_id))
                    lines.append(f"- {name} ({stage}) — FUB ID {lead_id} ➔ [Tap to Text]: {sms_link}")
                    html_lines.append(
                        f"<li style='margin-bottom: 12px; list-style-type: none; border-left: 3px solid #25D366; padding-left: 10px;'>"
                        f"📱 <strong>{name}</strong> ({stage}) — "
                        f"<a href='{sms_link}' style='display: inline-block; padding: 4px 10px; background-color: #25D366; color: white; text-decoration: none; border-radius: 4px; font-weight: bold; font-size: 13px;'>📲 Tap to Text</a>"
                        f"<br/><span style='color: #666; font-size: 12px; font-style: italic;'>Suggested SMS: \"{sms_body}\"</span>"
                        f"</li>"
                    )
                else:
                    lines.append(f"- {name} ({stage}) — FUB ID {lead_id} (No phone number)")
                    html_lines.append(f"<li style='margin-bottom: 12px; list-style-type: none; border-left: 3px solid #ccc; padding-left: 10px;'>📱 <strong>{name}</strong> ({stage}) — <span style='color: #999;'>No phone number</span></li>")
            
            lines.append("")
            html_lines.append("</ul>")

        # Fetch up to 5 random/recently active leads inside the Pond for general outreach
        try:
            pond_candidates = self.fub.get_people(assignedPondId=2)
            # Filter out excluded/unsubscribed leads
            pond_eligible = [p for p in pond_candidates if not self.is_excluded(p)]
            if pond_eligible:
                # Select up to 5 candidates (prioritizing recently active or random)
                import random
                sample_candidates = random.sample(pond_eligible, min(5, len(pond_eligible)))
                
                lines.append("🌊 LEAD POND RE-ENGAGEMENT OPPORTUNITIES")
                lines.append("----------------------------------------")
                lines.append("These are active leads currently inside your Lead Pond. Tap below to text them directly from your phone to start a conversation:")
                
                html_lines.append("<h3>🌊 LEAD POND RE-ENGAGEMENT OPPORTUNITIES</h3>")
                html_lines.append("<p>These are active leads currently inside your Lead Pond. <strong>Tap below to text them directly from your phone to start a conversation:</strong></p>")
                html_lines.append("<ul style='padding-left: 0;'>")
                
                for person in sample_candidates:
                    name = person_name(person)
                    stage = person.get("stage") or "Pond"
                    lead_id = person.get("id")
                    raw_fn = (person.get("firstName") or "").strip(); person_first_name = raw_fn.split()[0].capitalize() if raw_fn.split() else "there"
                    city, _, _ = self.customer_nurture_context(person)
                    
                    # Generate a casual, direct ask re-engagement SMS
                    sms_body = generate_personalized_sms(
                        first_name=person_first_name,
                        city=city or "Texas",
                        days_stale=30,
                        holiday=holiday,
                        direct_ask=True
                    )
                    
                    phones = person.get("phones") or []
                    phone_val = phones[0].get("value") or phones[0].get("phone") if phones else None
                    
                    if phone_val:
                        sms_link = make_sms_uri(phone_val, sms_body, agent_name="Peter", lead_id=str(lead_id))
                        lines.append(f"- {name} ({stage}) — FUB ID {lead_id} ➔ [Tap to Text]: {sms_link}")
                        html_lines.append(
                            f"<li style='margin-bottom: 12px; list-style-type: none; border-left: 3px solid #25D366; padding-left: 10px;'>"
                            f"📱 <strong>{name}</strong> ({stage}) — "
                            f"<a href='{sms_link}' style='display: inline-block; padding: 4px 10px; background-color: #25D366; color: white; text-decoration: none; border-radius: 4px; font-weight: bold; font-size: 13px;'>📲 Tap to Text</a>"
                            f"<br/><span style='color: #666; font-size: 12px; font-style: italic;'>Suggested SMS: \"{sms_body}\"</span>"
                            f"</li>"
                        )
                    else:
                        lines.append(f"- {name} ({stage}) — FUB ID {lead_id} (No phone number)")
                        html_lines.append(f"<li style='margin-bottom: 12px; list-style-type: none; border-left: 3px solid #ccc; padding-left: 10px;'>📱 <strong>{name}</strong> ({stage}) — <span style='color: #999;'>No phone number</span></li>")
                
                lines.append("")
                html_lines.append("</ul>")
        except Exception as pond_exc:
            LOGGER.warning("Failed to fetch pond re-engagement opportunities for Peter's text list: %s", pond_exc)

        # ── Timeline-Aware Cadence Reporting ──
        timeline_stats = self.db.count_timeline_adjusted_leads()
        if timeline_stats["count"] > 0:
            lines.append(f"📅 TIMELINE-ADJUSTED LEADS: {timeline_stats['count']} (avg window {timeline_stats['avg_days_out']}d out)")
            lines.append("----------------------------------------")
            lines.append("")
            html_lines.append(f"<h3>📅 Timeline-Adjusted Leads: {timeline_stats['count']} (avg window {timeline_stats['avg_days_out']}d out)</h3>")

        # ── Assignment Safety Net: untouched assignments flagged today ──
        if untouched_alerts:
            lines.append(f"⚠️ UNTOUCHED ASSIGNMENTS: {len(untouched_alerts)}")
            lines.append("----------------------------------------")
            html_lines.append(f"<h3>⚠️ UNTOUCHED ASSIGNMENTS: {len(untouched_alerts)}</h3>")
            html_lines.append("<ul>")
            for ua in untouched_alerts:
                ua_lead = ua.get("lead_name") or f"FUB ID {ua.get('person_id')}"
                ua_agent = ua.get("agent_name") or f"user {ua.get('assigned_user_id')}"
                ua_hours = ua.get("hours_untouched", "?")
                lines.append(f"- {ua_lead} — {ua_agent} — {ua_hours}h untouched (FUB ID {ua.get('person_id')})")
                html_lines.append(
                    f"<li style='margin-bottom: 8px; border-left: 3px solid #f59e0b; padding-left: 10px;'>"
                    f"<strong>{ua_lead}</strong> — {ua_agent} — <strong>{ua_hours}h</strong> untouched"
                    f"</li>"
                )
            lines.append("")
            html_lines.append("</ul>")

        # Add recent notable actions
        lines.append("🔍 RECENT NOTABLE ACTIONS")
        lines.append("----------------------------------------")
        html_lines.append("<h3>🔍 RECENT NOTABLE ACTIONS</h3><ul>")
        
        if examples:
            lines.extend(examples)
            for ex in examples:
                html_lines.append(f"<li>{ex}</li>")
        else:
            lines.append("No notable events recorded in this window.")
            html_lines.append("<li>No notable events recorded in this window.</li>")
            
        lines.append("")
        html_lines.append("</ul>")

        # Footer & status info. The email cap is the LIVE ramp value, not the
        # rules.yaml fallback — the footer said "Capped at 150" for a day
        # while the ramp was actually running the pond at 200.
        live_cap = self.rules.phase2_max_customer_emails_per_run
        try:
            from .ramp import resolve_daily_cap as _resolve_cap

            with self.db.connect() as _cap_con:
                live_cap = _resolve_cap(_cap_con)
        except Exception as _cap_exc:  # noqa: BLE001
            LOGGER.warning("Footer cap fell back to rules.yaml: %s", _cap_exc)
        footer_lines = [
            "⚙️ AUTOMATION SETTINGS STATUS",
            "----------------------------------------",
            "📱 SMS outreach: 🚫 Disabled",
            "🔒 Active exclusions: Only 'Trash' stage is excluded (ALL other stages eligible for daily agent follow-up warnings & 20-day pond reassignments)",
            "🏷️ Manual suppression tags: 'Do Not Nurture' & 'No AI Email' are fully respected",
            f"📈 Launch safety caps: Capped at {live_cap} emails (ramp-controlled) & {self.rules.phase2_max_reassignments_per_run} reassignments per daily run",
            "",
            "Let me know if you need any adjustments to these rules! Have an awesome day! ✨",
            "",
            "Truly,",
            "Lifestyle Design Automation Bot 🤖",
        ]
        lines.extend(footer_lines)
        
        html_lines.append("<h3>⚙️ AUTOMATION SETTINGS STATUS</h3>")
        html_lines.append("<ul>")
        html_lines.append("<li>📱 SMS outreach: 🚫 Disabled</li>")
        html_lines.append("<li>🔒 Active exclusions: Only 'Trash' stage is excluded (ALL other stages eligible for daily agent follow-up warnings & 20-day pond reassignments)</li>")
        html_lines.append("<li>🏷️ Manual suppression tags: 'Do Not Nurture' & 'No AI Email' are fully respected</li>")
        html_lines.append(f"<li>📈 Launch safety caps: Capped at {live_cap} emails (ramp-controlled) & {self.rules.phase2_max_reassignments_per_run} reassignments per daily run</li>")
        html_lines.append("</ul>")
        html_lines.append("<p>Let me know if you need any adjustments to these rules! Have an awesome day! ✨</p>")
        html_lines.append("<p>Truly,<br/><strong>Lifestyle Design Automation Bot 🤖</strong></p>")

        self.email.send(
            to_email=self.rules.phase2_daily_summary_email,
            subject="📊 Phase 2 FUB Automation Daily Update",
            body="\n".join(lines),
            from_email=self.rules.owner_email,
            reply_to=self.rules.owner_email,
            html_body="".join(html_lines)
        )
        _summary_status = "dry_run_sent" if self.settings.dry_run else "sent"
        self.db.log("phase2_daily_summary", _summary_status, None, {"to": self.rules.phase2_daily_summary_email, "row_count": len(rows)})

    def business_minutes_elapsed(self, start_utc: dt.datetime, end_utc: dt.datetime) -> float:
        """Return elapsed timer minutes, counting only the configured business-hours window.

        If new_lead_timer_mode is set to "24_7", this returns raw wall-clock minutes.
        Otherwise, it counts only minutes within business_hours_start/business_hours_end
        in the configured local timezone and business_hours_days, where Monday is 0.
        """
        if self.rules.new_lead_timer_mode.lower() in {"24_7", "24/7", "always", "wall_clock"}:
            return max(0.0, (end_utc - start_utc).total_seconds() / 60)

        tz = ZoneInfo(self.rules.local_timezone)
        start_local = start_utc.astimezone(tz)
        end_local = end_utc.astimezone(tz)
        if end_local <= start_local:
            return 0.0

        start_time = dt.time.fromisoformat(self.rules.business_hours_start)
        end_time = dt.time.fromisoformat(self.rules.business_hours_end)
        if end_time <= start_time:
            raise ValueError("business_hours_end must be after business_hours_start")

        total = 0.0
        current_day = start_local.date()
        while current_day <= end_local.date():
            if current_day.weekday() in set(self.rules.business_hours_days):
                window_start = dt.datetime.combine(current_day, start_time, tzinfo=tz)
                window_end = dt.datetime.combine(current_day, end_time, tzinfo=tz)
                overlap_start = max(start_local, window_start)
                overlap_end = min(end_local, window_end)
                if overlap_end > overlap_start:
                    total += (overlap_end - overlap_start).total_seconds() / 60
            current_day += dt.timedelta(days=1)
        return total

    def process_new_lead_timers(self) -> None:
        now = dt.datetime.now(UTC)
        # A lead the false-positive repair just touched must hold NO timer for
        # a day: the scan's repair_suppressed guard stops re-ARMING, but a
        # racing tick that pulled state before the repair pushed can already
        # have armed one — this cancels it before any warning can fire.
        recently_repaired: set = set()
        for row in self.db.recent_audit_rows(
                ["speed_to_lead_repair"], now - dt.timedelta(hours=24)):
            if row.get("person_id"):
                recently_repaired.add(int(row["person_id"]))
        # A person can hold duplicate ACTIVE generations when two overlapping
        # runs both armed (the 2026-08-28 state-pull race gave Sunny Chamadia
        # two started_polling rows) — mark_warned/mark_reassigned stamp every
        # active row, but this loop iterates a snapshot, so without collapsing
        # them the second generation warned and reassigned the same lead
        # again. Duplicates merge to ONE judgement per person: the OLDEST
        # budget clock (the first detection is the promise made to the lead)
        # and the EARLIEST touch clock (a legacy NULL-anchor duplicate must
        # not mask a sibling row that knows the real assignment moment).
        merged: Dict[int, dict] = {}
        for row in self.db.active_new_lead_timers():
            pid = int(row["person_id"])
            cur = merged.get(pid)
            if cur is None:
                merged[pid] = dict(row)
                continue
            row_touch = parse_dt(row.get("touch_anchor_at") or "") or parse_dt(row["created_at"])
            cur_touch = parse_dt(cur.get("touch_anchor_at") or "") or parse_dt(cur["created_at"])
            row_created = parse_dt(row["created_at"])
            cur_created = parse_dt(cur["created_at"])
            if row_created and cur_created and row_created < cur_created:
                cur["created_at"] = row["created_at"]
            if row_touch and cur_touch and row_touch < cur_touch:
                cur["touch_anchor_at"] = row.get("touch_anchor_at") or row["created_at"]
            if row.get("warned_at") and not cur.get("warned_at"):
                cur["warned_at"] = row["warned_at"]
            if row.get("assigned_user_id") and not cur.get("assigned_user_id"):
                cur["assigned_user_id"] = row["assigned_user_id"]
        for timer in merged.values():
            person_id = int(timer["person_id"])
            if person_id in recently_repaired:
                self.db.cancel_timer(person_id)
                self.db.log("new_lead_timer", "canceled_repair_suppressed", person_id)
                continue
            created = parse_dt(timer["created_at"])
            age_min = self.business_minutes_elapsed(created, now)
            person = self.fub.get_person(person_id)
            if not person:
                self.db.cancel_timer(person_id)
                continue
            # created_at anchors the 30/60-minute BUDGET at detection time.
            # The TOUCH check anchors at touch_anchor_at — when the assignment
            # actually became the agent's (lead creation for polling timers,
            # the previous scan observation for assignment-change timers) —
            # because detection can lag the real assignment by hours and work
            # done in that gap is legitimate first touch (Sunny Chamadia,
            # 2026-08-29). Rows armed before the column existed fall back to
            # created_at, the 2026-08-26 policy anchor. Only the ASSIGNED
            # AGENT's own activity ever cancels, exactly as before.
            touch_anchor = parse_dt(timer.get("touch_anchor_at") or "") or created
            assigned_for_touch = person.get("assignedUserId") or timer.get("assigned_user_id")
            if assigned_for_touch and self.lead_touched_after_creation(
                    person, touch_anchor, assigned_user_id=int(assigned_for_touch)):
                self.db.cancel_timer(person_id)
                self.db.log("new_lead_timer", "canceled_touched", person_id)
                continue
            if self.rules.new_lead_reassignment_enabled and age_min >= self.rules.new_lead_reassign_minutes:
                # If the warning was never sent, send it now before reassigning
                # so the agent knows why the lead was taken back
                if self.rules.new_lead_warning_enabled and not timer.get("warned_at"):
                    assigned_user_id_r = person.get("assignedUserId") or timer.get("assigned_user_id")
                    agent_name_r = ""
                    if assigned_user_id_r:
                        users_map_r = self.user_cache_by_id()
                        agent_user_r = users_map_r.get(int(assigned_user_id_r))
                        if agent_user_r:
                            agent_name_r = agent_user_r.get("name") or ""
                    mention_r = f"@{agent_name_r} " if agent_name_r else ""
                    late_warning = (
                        f"{mention_r}🚨 **SPEED-TO-LEAD: LEAD BEING REASSIGNED** 🚨\n\n"
                        f"This new lead was assigned to you but no first touch was detected after "
                        f"**{self.rules.new_lead_reassign_minutes} business minutes**.\n\n"
                        f"⚠️ This lead has been automatically returned to {self.rules.peter_name} for reassignment."
                    )
                    try:
                        self.fub.add_note(person_id, "Automation: speed-to-lead reassignment", late_warning)
                        self.db.mark_warned(person_id)
                        self.db.log("new_lead_warning", "created_at_reassignment", person_id, {"agent_name": agent_name_r})
                    except Exception as warn_exc:
                        LOGGER.warning("Failed to add late warning note for person %s: %s", person_id, warn_exc)
                self.reassign_to_peter(person)
                self.db.mark_reassigned(person_id)
                continue
            if self.rules.new_lead_warning_enabled and age_min >= self.rules.new_lead_warning_minutes and not timer.get("warned_at"):
                assigned_user_id = person.get("assignedUserId") or timer.get("assigned_user_id")
                agent_name = ""
                if assigned_user_id:
                    assigned_user_id = int(assigned_user_id)
                    users_map = self.user_cache_by_id()
                    agent_user = users_map.get(assigned_user_id)
                    if agent_user:
                        agent_name = agent_user.get("name") or ""
                    
                    self.fub.create_task(
                        person_id,
                        assigned_user_id,
                        f"URGENT: touch this new lead within {self.rules.new_lead_warning_minutes} business-time minutes or it will be reassigned to {self.rules.peter_name}",
                        task_type="Call",
                        due_minutes=1,
                    )
                
                # Format a highly visible @mention warning note to trigger native FUB mobile/email alerts
                mention_prefix = f"@{agent_name} " if agent_name else ""
                warning_body = (
                    f"{mention_prefix}🚨 **URGENT SPEED-TO-LEAD WARNING** 🚨\n\n"
                    f"This new lead was assigned to you, but no first touch (call, text, or email) has been detected after **{self.rules.new_lead_warning_minutes} business minutes**.\n\n"
                    f"⚠️ **Action Required**: Please contact this lead immediately!\n"
                    f"⏰ **Fallback Reassignment**: If no contact is logged within the next **{self.rules.new_lead_reassign_minutes - self.rules.new_lead_warning_minutes} minutes**, "
                    f"this lead will be automatically returned to {self.rules.peter_name} for reassignment."
                )
                
                self.fub.add_note(person_id, "Automation: speed-to-lead warning", warning_body)
                self.db.mark_warned(person_id)
                self.db.log("new_lead_warning", "created", person_id, {"agent_name": agent_name, "assigned_user_id": assigned_user_id})

    def scan_untouched_assignments(self) -> None:
        """Assignment safety net: flag agent-assigned, non-pond leads with zero
        agent touch for 24+ hours after their current assignment was first seen.

        Exists because speed-to-lead timers only ever start for leads CREATED in
        the last 24h — a lead manually reassigned to an agent months after
        creation had no net at all until the 14-day agent-followup digest.
        Alerts are a FUB task + @mention note to the agent (never a message to
        the lead) and a section in Peter's daily summary.
        """
        if not self.rules.untouched_assignment_alert_enabled:
            LOGGER.info("Untouched-assignment safety net is disabled by rules.yaml")
            return
        now = dt.datetime.now(UTC)
        threshold = dt.timedelta(hours=self.rules.untouched_assignment_hours)
        realert_window = dt.timedelta(hours=self.rules.untouched_assignment_realert_hours)
        cap = max(0, int(self.rules.untouched_assignment_max_alerts_per_run))

        # Server-side prefilter: a lead untouched for 24h+ necessarily has a
        # stale lastActivity. (Limitation: automated emails can bump
        # lastActivity and hide a lead from this net until they quiet down.)
        cutoff = (now - threshold).strftime("%Y-%m-%dT%H:%M:%SZ")
        try:
            candidates = self.fub.get_people(lastActivityBefore=cutoff, fields="allFields")
        except Exception as exc:  # noqa: BLE001
            LOGGER.exception("Untouched-assignment scan failed to fetch candidates: %s", exc)
            self.db.log("untouched_assignment_scan", "error", None, {"error": str(exc)})
            return
        # Longest-neglected first, so the per-run cap always spends its budget
        # on the worst offenders.
        candidates.sort(key=lambda p: parse_dt(p.get("lastActivity") or "") or now)
        LOGGER.info("Untouched-assignment scan: %s candidates with lastActivity before %s", len(candidates), cutoff)

        try:
            users_map = self.user_cache_by_id()
        except Exception as exc:  # noqa: BLE001
            LOGGER.exception("Untouched-assignment scan failed to fetch users: %s", exc)
            self.db.log("untouched_assignment_scan", "error", None, {"error": str(exc)})
            return
        excluded_agent_ids: set = set(getattr(self.rules, "excluded_user_ids", []))
        skip_counts: Dict[str, int] = {}
        alerts_sent = 0
        cap_logged = False

        def _skip(reason: str) -> None:
            skip_counts[reason] = skip_counts.get(reason, 0) + 1

        for person in candidates:
            person_id = int(person["id"])
            if person.get("assignedPondId"):
                _skip("in_pond")
                continue
            assigned_user_id = person.get("assignedUserId")
            if not assigned_user_id:
                _skip("unassigned")
                continue
            assigned_user_id = int(assigned_user_id)
            if self.rules.peter_user_id is not None and assigned_user_id == int(self.rules.peter_user_id):
                _skip("assigned_to_peter")
                continue
            if assigned_user_id in excluded_agent_ids:
                _skip("excluded_agent")
                continue
            agent_user = users_map.get(assigned_user_id)
            if not agent_user or agent_user.get("status") != "Active":
                _skip("inactive_agent")
                continue
            if self.is_excluded(person):
                _skip("excluded_lead")
                continue

            watch = self.db.get_assignment_watch(person_id)
            if not watch or int(watch["assigned_user_id"]) != assigned_user_id:
                # First sighting of THIS lead→agent pair — start the clock now.
                self.db.upsert_assignment_watch(person_id, assigned_user_id)
                _skip("watch_started")
                continue

            first_seen = parse_dt(watch["first_seen_at"]) or now
            hours_untouched = (now - first_seen).total_seconds() / 3600
            if now - first_seen < threshold:
                _skip("under_threshold")
                continue

            last_alert = parse_dt(watch.get("last_alert_at") or "")
            if last_alert and now - last_alert < realert_window:
                _skip("realert_suppressed")
                self.db.log(
                    "untouched_assignment_skip", "realert_suppressed", person_id,
                    {"assigned_user_id": assigned_user_id, "last_alert_at": watch.get("last_alert_at")},
                )
                continue

            if cap and alerts_sent >= cap:
                # Cheap check BEFORE the touch check so a capped run stops
                # burning notes-API calls; these leads stay unmarked and get
                # first claim on tomorrow's budget (sort is oldest-first).
                if not cap_logged:
                    self.db.log("untouched_assignment_alert", "cap_reached", None, {"cap": cap})
                    cap_logged = True
                _skip("cap_deferred")
                self.db.log("untouched_assignment_skip", "cap_deferred", person_id, {"assigned_user_id": assigned_user_id})
                continue

            if self.lead_touched_after_creation(person, first_seen):
                _skip("touched")
                self.db.log(
                    "untouched_assignment_skip", "touched", person_id,
                    {"assigned_user_id": assigned_user_id, "first_seen_at": watch["first_seen_at"]},
                )
                continue

            agent_name = agent_user.get("name") or ""
            lead_name = f"{person.get('firstName', '')} {person.get('lastName', '')}".strip() or f"Lead #{person_id}"
            mention = f"@{agent_name} " if agent_name else ""
            # Same visual format as the speed-to-lead warning note so agents
            # recognize it instantly. Subject MUST keep the "Automation:"
            # prefix — that is what stops this note from counting as a touch.
            warning_body = (
                f"{mention}🚨 **URGENT UNTOUCHED ASSIGNMENT WARNING** 🚨\n\n"
                f"This lead was assigned to you, but no first touch (call, text, or email) has been detected "
                f"after **{int(hours_untouched)} hours**.\n\n"
                f"⚠️ **Action Required**: Please contact this lead today!\n"
                f"⏰ This lead is also being reported to {self.rules.peter_name} in the daily automation summary."
            )
            try:
                self.fub.create_task(
                    person_id,
                    assigned_user_id,
                    f"URGENT: assigned lead untouched for {int(hours_untouched)}+ hours — contact today",
                    task_type="Call",
                    due_minutes=60,
                )
                self.fub.add_note(person_id, "Automation: untouched assignment warning", warning_body)
            except Exception as exc:  # noqa: BLE001
                # Leave the watch row unmarked so the next run retries.
                LOGGER.exception("Untouched-assignment alert failed for person %s", person_id)
                self.db.log("untouched_assignment_alert", "error", person_id, {"error": str(exc)})
                continue
            self.db.mark_assignment_alerted(person_id)
            alerts_sent += 1
            _alert_status = "dry_run_created" if self.settings.dry_run else "created"
            self.db.log(
                "untouched_assignment_alert", _alert_status, person_id,
                {
                    "lead_name": lead_name,
                    "agent_name": agent_name,
                    "assigned_user_id": assigned_user_id,
                    "hours_untouched": round(hours_untouched, 1),
                },
            )
            LOGGER.info(
                "Untouched-assignment alert for lead %s (%s) — agent %s, %.1fh untouched",
                person_id, lead_name, agent_name, hours_untouched,
            )

        # One aggregate row per run records EVERY skip reason without writing
        # thousands of per-lead rows for structural skips (pond/unassigned/...).
        self.db.log(
            "untouched_assignment_scan", "completed", None,
            {"candidates": len(candidates), "alerts": alerts_sent, "skips": skip_counts},
        )

    #: Audit actions that mean the AUTOMATION moved a lead. A diff hit within
    #: ASSIGNMENT_AUTOMATION_WINDOW_MIN of one of these is our own doing —
    #: pond promotion, 20-day reassignment, speed-to-lead return — and must
    #: not start a timer or page an agent.
    ASSIGNMENT_AUTOMATION_ACTIONS = (
        "stale_agent_pond_reassignment",
        "pond_keyword_reassignment",
        "new_lead_reassigned",
        "speed_to_lead_repair",
    )
    ASSIGNMENT_AUTOMATION_WINDOW_MIN = 30
    #: More than this many detected moves in one run reads as a manual bulk
    #: distribution: one digest to Peter instead of paging every agent.
    ASSIGNMENT_BULK_THRESHOLD = 5
    #: How far back the -updated walk looks for record changes. Wider than the
    #: 5-minute cadence on purpose: ticks arrive 30–50 minutes apart under
    #: GitHub's cron delays, and a re-observed change is deduplicated by the
    #: watch table anyway.
    ASSIGNMENT_SCAN_WINDOW_HOURS = 24
    ASSIGNMENT_SCAN_MAX_PAGES = 5

    #: Ghost sweep budget: get_person costs one API call per row checked.
    DELETED_LEAD_SCAN_CAP = 300

    def scan_deleted_leads(self) -> None:
        """Ghosts: state rows pointing at FUB records that no longer resolve.

        Stephen Herrera's record was deleted on 2026-08-24 and his NEEDS A
        REPLY entry lived on — nothing ever re-checked that the person still
        existed. Once a day this resolves every person the state still watches
        (needs-reply candidates, assignment-watch rows, active timers); a lead
        FUB no longer returns gets ONE audit row (action='lead_deleted') that
        the needs-reply collector honours as a closing event, its watch row is
        deleted and any active timer cancelled.
        """
        now = dt.datetime.now(UTC)
        since = now - dt.timedelta(days=self.NEEDS_REPLY_BACKLOG_DAYS)
        candidates: set = set()
        for row in self.db.recent_audit_rows(["reply_detected"], since):
            if row.get("status") in ("alert_sent", "backfilled") and row.get("person_id"):
                candidates.add(int(row["person_id"]))
        for watch in self.db.all_assignment_watch_rows():
            candidates.add(int(watch["person_id"]))
        for timer in self.db.active_new_lead_timers():
            candidates.add(int(timer["person_id"]))
        # Already marked — never pay for the same ghost twice.
        for row in self.db.recent_audit_rows(["lead_deleted"], now - dt.timedelta(days=90)):
            candidates.discard(int(row.get("person_id") or 0))

        checked = ghosts = 0
        for person_id in sorted(candidates):
            if checked >= self.DELETED_LEAD_SCAN_CAP:
                LOGGER.info("Deleted-lead sweep: cap (%s) reached; the rest wait "
                            "for tomorrow.", self.DELETED_LEAD_SCAN_CAP)
                break
            checked += 1
            try:
                person = self.fub.get_person(person_id)
            except Exception as exc:  # noqa: BLE001
                LOGGER.warning("Deleted-lead sweep: could not resolve %s (%s) — "
                               "keeping their rows", person_id, exc)
                continue
            if person:
                continue
            ghosts += 1
            LOGGER.info("Deleted-lead sweep: FUB no longer resolves person %s — "
                        "clearing their rows", person_id)
            self.db.log("lead_deleted", "cleared", person_id, {
                "sources": "needs_reply/assignment_watch/new_lead_timers",
            })
            self.db.delete_assignment_watch(person_id)
            self.db.cancel_timer(person_id)
        LOGGER.info("Deleted-lead sweep complete: %s checked, %s ghosts cleared.",
                    checked, ghosts)

    def scan_assignment_changes(self) -> None:
        """Option A from the Aug 9 investigation: timers for REASSIGNED leads.

        poll_new_leads only watches leads CREATED in the last 24h, so a lead
        distributed to an agent later — Jose Reyes, created 07:57 on
        2026-08-25, assigned to Laila around 15:55, never alerted — had no
        net at all until the next day's untouched-assignment sweep. This scan
        walks every person whose record changed inside the window (an
        assignment change is a record edit, proven by the 2026-08-25 probe),
        diffs assignedUserId against the stored assignment_watch pair, and on
        a change to a non-Peter agent starts a speed-to-lead timer anchored
        at DETECTION time plus the same instant agent alert new leads get.

        Guards, from the Aug 9 report:
          - automation-initiated moves are skipped (audit actions within
            ASSIGNMENT_AUTOMATION_WINDOW_MIN, moves into a pond, moves to
            Peter);
          - a person can hold repeat timers — each detection is a new
            (person_id, created_at) generation;
          - more than ASSIGNMENT_BULK_THRESHOLD moves in one run is a manual
            bulk distribution: timers still start, but Peter gets ONE digest
            instead of every agent getting paged;
          - the bot's own nurture sends never count as first touch
            (lead_touched_after_creation ignores them).

        First sight of a pair is a BASELINE, not a change: with no stored row
        there is nothing to diff against, so the pair is recorded silently and
        the next change is caught. The daily untouched-assignment sweep has
        been seeding this table since 2026-08-10.
        """
        if not self.rules.new_lead_warning_enabled and not self.rules.new_lead_reassignment_enabled:
            return
        now = dt.datetime.now(UTC)
        window_start = now - dt.timedelta(hours=self.ASSIGNMENT_SCAN_WINDOW_HOURS)
        automation_window = now - dt.timedelta(minutes=self.ASSIGNMENT_AUTOMATION_WINDOW_MIN)

        # FUB keeps no "assigned at" timestamp, so the assignment became
        # current somewhere between the PREVIOUS whole-window walk (when the
        # old pair was last provably still stored) and this detection. That is
        # the touch anchor: the agent's own work inside the detection gap —
        # ticks arrive 30–50 minutes apart under GitHub's cron delays, or
        # overnight when a change lands after business hours — is legitimate
        # first touch, not something to warn about. Truncated walks never
        # advance the anchor (see last_assignment_observation). Before the
        # first completed row exists, fall back to the scan window itself: a
        # change detected by a covering walk is at most that old.
        prev_observation = parse_dt(self.db.last_assignment_observation() or "") \
            or (now - dt.timedelta(hours=self.ASSIGNMENT_SCAN_WINDOW_HOURS))

        recently_moved_by_us = set()
        for row in self.db.recent_audit_rows(
                list(self.ASSIGNMENT_AUTOMATION_ACTIONS), automation_window):
            pid = row.get("person_id")
            if pid:
                recently_moved_by_us.add(int(pid))

        # A lead the false-positive repair just restored must not be re-armed
        # for a day: the repair window is wider than the 30-minute automation
        # window because the restore itself is an assignment change.
        recently_repaired = set()
        for row in self.db.recent_audit_rows(
                ["speed_to_lead_repair"], now - dt.timedelta(hours=24)):
            pid = row.get("person_id")
            if pid:
                recently_repaired.add(int(pid))

        active_timer_people = {int(t["person_id"]) for t in self.db.active_new_lead_timers()}
        excluded_agent_ids = set(getattr(self.rules, "excluded_user_ids", []))

        changes: List[Tuple[dict, int]] = []
        walked = 0
        params: Dict[str, Any] = {"sort": "-updated", "limit": 100}
        pages = 0
        stop = False
        truncated = False
        while pages < self.ASSIGNMENT_SCAN_MAX_PAGES and not stop:
            data = self.fub._request("GET", "/people", params=dict(params))
            people = data.get("people", data.get("data", []))
            if not people:
                break
            for stub in people:
                updated = parse_fub_datetime(stub.get("updated"))
                if updated and updated < window_start:
                    stop = True
                    break
                walked += 1
                person_id = int(stub["id"])
                assigned = stub.get("assignedUserId")
                watch = self.db.get_assignment_watch(person_id)

                if not assigned:
                    continue
                assigned = int(assigned)

                if watch is None:
                    # Baseline: record the pair so the NEXT change diffs.
                    if not stub.get("assignedPondId") and not self.is_excluded(stub):
                        self.db.upsert_assignment_watch(person_id, assigned)
                    continue
                if int(watch["assigned_user_id"]) == assigned:
                    continue

                # ── The pair changed. Decide whether it deserves a timer. ──
                self.db.upsert_assignment_watch(person_id, assigned)
                reason = None
                if person_id in recently_moved_by_us:
                    reason = "automation_move"
                elif person_id in recently_repaired:
                    reason = "repair_suppressed"
                elif stub.get("assignedPondId"):
                    reason = "moved_into_pond"
                elif self.rules.peter_user_id is not None and assigned == int(self.rules.peter_user_id):
                    reason = "assigned_to_peter"
                elif assigned in excluded_agent_ids:
                    reason = "excluded_agent"
                elif self.is_excluded(stub):
                    reason = "excluded_stage_or_tag"
                elif person_id in active_timer_people:
                    reason = "timer_already_active"
                if reason:
                    self.db.log("assignment_change", "skipped", person_id, {
                        "reason": reason, "new_assigned_user_id": assigned})
                    continue
                changes.append((stub, assigned))
            pages += 1
            cursor = data.get("_metadata", {}).get("next")
            if not cursor or stop:
                break
            if pages >= self.ASSIGNMENT_SCAN_MAX_PAGES:
                # More changed records exist beyond the page cap: this walk
                # observed only a slice of the window, and its stamp must not
                # become anyone's touch anchor.
                truncated = True
                break
            params["next"] = cursor

        if not changes:
            LOGGER.info("Assignment-change scan: walked %s changed records, no new "
                        "agent assignments to arm.", walked)
            # The completion row IS the next run's touch anchor — it must land
            # on every covering walk, changes or none, or the anchor drifts
            # back to the last eventful run and over-forgives. observed_at is
            # the walk's START; a page-capped walk logs 'truncated' instead
            # and advances nothing.
            self.db.log("assignment_scan", "truncated" if truncated else "completed",
                        None, {"walked": walked, "armed": 0,
                               "observed_at": now.isoformat()})
            return

        bulk = len(changes) > self.ASSIGNMENT_BULK_THRESHOLD
        users = self.user_cache_by_id()
        armed = 0
        for stub, assigned in changes:
            person_id = int(stub["id"])
            # If the agent already touched the lead inside the detection gap,
            # there is nothing to warn about — don't arm, don't page. The list
            # stub lacks the lastX stamps the touch check gates on, so check
            # the full record; a fetch failure falls back to the stub, which
            # can only miss touches (fail closed: the timer still arms and the
            # stored anchor lets a later tick see the same touch).
            try:
                full = self.fub.get_person(person_id) or stub
            except Exception as exc:  # noqa: BLE001
                LOGGER.warning("Assignment change: could not fetch person %s for the "
                               "at-arm touch check: %s", person_id, exc)
                full = stub
            if self.lead_touched_after_creation(
                    full, prev_observation, assigned_user_id=int(assigned)):
                self.db.log("new_lead_timer", "skipped_already_touched", person_id, {
                    "assignedUserId": assigned,
                    "touch_anchor": prev_observation.isoformat(),
                })
                LOGGER.info("Assignment change: lead %s already touched by agent %s "
                            "since the previous observation — no timer.",
                            person_id, assigned)
                continue
            self.db.add_new_lead_timer(person_id, assigned,
                                       touch_anchor_at=prev_observation.isoformat())
            self.db.log("new_lead_timer", "started_assignment_change", person_id, {
                "assignedUserId": assigned,
                "bulk": bulk,
            })
            armed += 1
            LOGGER.info("Assignment change: timer armed for lead %s (agent %s)%s",
                        person_id, assigned, " [bulk]" if bulk else "")
            if not bulk:
                self._send_speed_to_lead_agent_alert(stub, assigned)

        if bulk:
            self._send_bulk_assignment_digest(changes, users)
        self.db.log("assignment_scan", "truncated" if truncated else "completed",
                    None, {"walked": walked, "armed": armed,
                           "changes": len(changes), "observed_at": now.isoformat()})
        LOGGER.info("Assignment-change scan complete: walked %s, armed %s of %s%s%s.",
                    walked, armed, len(changes), " (bulk digest)" if bulk else "",
                    " [TRUNCATED at page cap]" if truncated else "")

    def _send_bulk_assignment_digest(self, changes: List[Tuple[dict, int]],
                                     users: Dict[int, dict]) -> None:
        """One email to Peter for a bulk distribution, instead of paging every
        agent individually. The timers are still armed — the 30/60 escalation
        runs regardless — this only swaps N instant alerts for one summary."""
        lines = [f"{len(changes)} leads were reassigned in one sweep — reading this "
                 "as a manual distribution, so agents were not paged individually. "
                 "Every lead still has its 30/60-minute timer armed.", ""]
        html_rows = ""
        for stub, assigned in changes:
            name = f"{stub.get('firstName', '')} {stub.get('lastName', '')}".strip() \
                or f"Lead #{stub['id']}"
            agent = (users.get(assigned, {}) or {}).get("name") or f"user {assigned}"
            link = f"https://www.followupboss.com/2/people/view/{stub['id']}"
            lines.append(f"  • {name} → {agent} — {link}")
            html_rows += (f"<li><strong>{html.escape(name)}</strong> → "
                          f"{html.escape(str(agent))} — <a href='{link}'>Open in FUB</a></li>")
        try:
            self.email.send(
                self.rules.owner_email,
                f"📦 Bulk distribution detected: {len(changes)} leads reassigned",
                "\n".join(lines),
                from_email=self.rules.owner_email,
                html_body=(f"<p>{len(changes)} leads were reassigned in one sweep — "
                           "agents were not paged individually; every lead still has "
                           f"its 30/60-minute timer armed.</p><ul>{html_rows}</ul>"),
            )
            self.db.log("assignment_bulk_digest", "sent", None, {"count": len(changes)})
        except Exception as exc:  # noqa: BLE001
            LOGGER.warning("Bulk assignment digest failed: %s", exc)

    def poll_new_leads(self) -> None:
        if not self.rules.new_lead_warning_enabled and not self.rules.new_lead_reassignment_enabled:
            LOGGER.info("Speed-to-lead workflow is disabled. Skipping API polling.")
            return
        # Query FUB for leads created in the last 24 hours to capture all recent manual assignments
        cutoff = (dt.datetime.now(UTC) - dt.timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
        try:
            recent_leads = self.fub.get_people(createdAfter=cutoff)
            LOGGER.info("API Polling: Found %s recent leads created in the last 24 hours.", len(recent_leads))
        except Exception as exc:
            LOGGER.exception("API Polling failed to fetch recent leads: %s", exc)
            return

        active_timers = {int(t["person_id"]) for t in self.db.active_new_lead_timers()}

        # Also load canceled or completed timers from the last 24 hours to avoid double-processing
        with self.db.connect() as con:
            con.row_factory = sqlite3.Row
            past_rows = con.execute("SELECT person_id FROM new_lead_timers WHERE canceled_at IS NOT NULL OR reassigned_at IS NOT NULL").fetchall()
            processed_timers = {int(r["person_id"]) for r in past_rows}
        # A lead skipped because the agent had already touched it leaves no
        # timer row — remember the skip so every later tick doesn't re-spend
        # the API calls re-proving the same touch.
        for row in self.db.recent_audit_rows(
                ["new_lead_timer"], dt.datetime.now(UTC) - dt.timedelta(hours=24)):
            if row.get("status") == "skipped_already_touched" and row.get("person_id"):
                processed_timers.add(int(row["person_id"]))

        for person in recent_leads:
            person_id = int(person["id"])
            if person_id in active_timers or person_id in processed_timers:
                continue
            if self.is_excluded(person):
                continue
            # Source-based exclusion (cheap local check)
            excluded_src = self._is_excluded_source(person)
            if excluded_src:
                LOGGER.debug("Speed-to-lead: skipping person %s — excluded source: %s", person_id, excluded_src)
                continue
            # SOI Total Silence
            soi_rule = self._is_soi_silenced(person)
            if soi_rule:
                LOGGER.debug("Speed-to-lead: skipping person %s — soi_silenced (rule matched: %s)", person_id, soi_rule)
                continue
                
            assigned_user_id = person.get("assignedUserId")
            # If the lead is assigned to an agent (and NOT Peter Allen himself), start the speed-to-lead timer!
            if assigned_user_id and int(assigned_user_id) != self.rules.peter_user_id:
                assigned_int = int(assigned_user_id)
                # The 30/60-minute BUDGET anchors at DETECTION time (now) —
                # polling can lag, and a lead created yesterday afternoon must
                # not start its timer already past the 60-minute line. The
                # TOUCH clock is different: the agent has the lead from its
                # creation/assignment, so their work between creation and our
                # discovery is legitimate first touch. Sunny Chamadia (6343)
                # was called 24 minutes after creation, discovered ~2h later,
                # and bounced because the touch anchor was detection.
                fub_created = parse_fub_datetime(person.get("created")) or dt.datetime.now(UTC)
                full = None
                try:
                    # The list stub lacks the lastX stamps the touch check
                    # gates its channel queries on — check the full record.
                    full = self.fub.get_person(person_id)
                except Exception as exc:  # noqa: BLE001
                    LOGGER.warning("API Polling: could not fetch person %s for the "
                                   "at-arm touch check: %s", person_id, exc)
                if self.lead_touched_after_creation(
                        full or person, fub_created, assigned_user_id=assigned_int):
                    self.db.log("new_lead_timer", "skipped_already_touched", person_id, {
                        "assignedUserId": assigned_int,
                        "touch_anchor": fub_created.isoformat(),
                        "fub_created_at": person.get("created"),
                    })
                    LOGGER.info("API Polling: Lead %s already touched by agent %s since "
                                "creation — no timer.", person_id, assigned_int)
                    continue
                self.db.add_new_lead_timer(person_id, assigned_int,
                                           touch_anchor_at=fub_created.isoformat())
                self.db.log("new_lead_timer", "started_polling", person_id, {"assignedUserId": assigned_user_id, "fub_created_at": person.get("created")})
                LOGGER.info("API Polling: Started speed-to-lead timer for Lead %s (Assigned to Agent %s)", person_id, assigned_user_id)
                # Send immediate email notification to the agent with click-to-text link
                self._send_speed_to_lead_agent_alert(person, assigned_int)

    def _send_speed_to_lead_agent_alert(self, person: dict, assigned_user_id: int) -> None:
        """Send an immediate email to the assigned agent when a new lead is assigned.
        Includes a click-to-text link for instant mobile engagement."""
        try:
            users_map = self.user_cache_by_id()
            agent_user = users_map.get(assigned_user_id)
            if not agent_user:
                LOGGER.warning("Speed-to-lead alert: could not find agent user %s", assigned_user_id)
                return
            agent_email = agent_user.get("email")
            agent_name = agent_user.get("name") or "Agent"
            if not agent_email:
                return
            lead_name = f"{person.get('firstName', '')} {person.get('lastName', '')}".strip() or f"Lead #{person['id']}"
            # Get lead phone for click-to-text link
            lead_phone = ""
            phones = person.get("phones") or []
            for ph in phones:
                if isinstance(ph, dict):
                    lead_phone = ph.get("value") or ph.get("number") or ""
                    if lead_phone:
                        break
                elif isinstance(ph, str) and ph:
                    lead_phone = ph
                    break
            # Build click-to-text link via the dashboard's HTTPS sms-redirect —
            # Gmail's mobile apps ignore raw sms: hrefs in email, so the link
            # has to be a normal https URL that bounces into the SMS app.
            from .sms_helpers import generate_personalized_sms, get_upcoming_holiday, make_sms_uri

            agent_first = agent_name.split()[0] if agent_name.split() else "Agent"
            sms_link = ""
            sms_body = ""
            if lead_phone:
                raw_fn = (person.get("firstName") or "").strip()
                lead_first = raw_fn.split()[0].capitalize() if raw_fn.split() else "there"
                city = infer_city(person, self.rules.target_cities)
                sms_body = generate_personalized_sms(
                    first_name=lead_first,
                    city=city or "Texas",
                    days_stale=0,
                    holiday=get_upcoming_holiday(dt.date.today()),
                    lead_id=str(person["id"]),
                )
                sms_link = make_sms_uri(lead_phone, sms_body, agent_name=agent_first, lead_id=str(person["id"]))
            phone_display = lead_phone or "(no phone on file)"
            source = display_source(person)
            subject = f"\U0001f6a8 NEW LEAD ASSIGNED: {lead_name} — Contact within 30 min!"
            html_body = (
                f"<h2>\U0001f6a8 New Lead Assigned to You</h2>"
                f"<p>Hi {html.escape(agent_first)},</p>"
                f"<p>A new lead has been assigned to you. Please make first contact within <strong>30 minutes</strong> "
                f"or the lead will be reassigned to {html.escape(self.rules.peter_name)}.</p>"
                f"<table style='border-collapse:collapse;margin:16px 0;'>"
                f"<tr><td style='padding:4px 12px;font-weight:bold;'>Name:</td><td style='padding:4px 12px;'>{html.escape(lead_name)}</td></tr>"
                f"<tr><td style='padding:4px 12px;font-weight:bold;'>Phone:</td><td style='padding:4px 12px;'>{html.escape(phone_display)}</td></tr>"
                f"<tr><td style='padding:4px 12px;font-weight:bold;'>Source:</td><td style='padding:4px 12px;'>{html.escape(source)}</td></tr>"
                f"</table>"
            )
            if sms_link:
                html_body += (
                    f"<p style='margin:20px 0;'>"
                    f"<a href='{sms_link}' style='display:inline-block;padding:12px 24px;background:#22c55e;color:white;"
                    f"text-decoration:none;border-radius:8px;font-weight:bold;font-size:16px;'>\U0001f4f1 Tap to Text {html.escape(lead_name.split()[0])}</a>"
                    f"</p>"
                    f"<p style='color:#666;font-size:12px;font-style:italic;'>Suggested: \"{html.escape(sms_body)}\"</p>"
                )
            html_body += (
                f"<p style='color:#666;font-size:12px;'>\u23f0 Timer: 30-min warning \u2192 60-min auto-reassignment to {self.rules.peter_name}</p>"
            )
            plain_body = f"New lead assigned: {lead_name}\nPhone: {phone_display}\nSource: {source}\n\nPlease make first contact within 30 minutes or the lead will be reassigned to {self.rules.peter_name}."
            if sms_link:
                plain_body += f"\n\nTap to Text: {sms_link}\nSuggested: \"{sms_body}\""
            self.email.send(
                agent_email,
                subject,
                plain_body,
                from_email=self.rules.owner_email,
                cc=[self.rules.owner_email],
                html_body=html_body,
            )
            _alert_status = "dry_run_sent" if self.settings.dry_run else "sent"
            self.db.log("speed_to_lead_alert", _alert_status, int(person["id"]), {"agent_email": agent_email, "agent_name": agent_name})
            LOGGER.info("Speed-to-lead agent alert sent for lead %s", person["id"])
        except Exception as exc:
            LOGGER.warning("Failed to send speed-to-lead agent alert for lead %s: %s", person.get("id"), exc)

    def reassign_to_peter(self, person: dict) -> None:
        person_id = int(person["id"])
        payload = {"assignedUserId": self.rules.peter_user_id} if self.rules.peter_user_id else {"assignedTo": self.rules.peter_name}
        self.fub.update_person(person_id, payload)
        self.fub.update_person(person_id, {"tags": ["auto-reassigned-speed-to-lead"]}, merge_tags=True)
        self.fub.add_note(person_id, "Automation: reassigned for no first touch", f"No assigned-agent touch detected within {self.rules.new_lead_reassign_minutes} business-time minutes. Lead reassigned to {self.rules.peter_name}.")
        self.db.log("new_lead_reassigned", "completed", person_id, payload)
        # Send reassignment notification email to Peter
        lead_name = f"{person.get('firstName', '')} {person.get('lastName', '')}".strip() or f"Lead #{person_id}"
        prev_agent_id = person.get("assignedUserId")
        prev_agent_name = "Unknown Agent"
        if prev_agent_id:
            users_map = self.user_cache_by_id()
            prev_user = users_map.get(int(prev_agent_id))
            if prev_user:
                prev_agent_name = prev_user.get("name") or "Unknown Agent"
        try:
            reassign_subject = f"\u26a0\ufe0f Lead Reassigned: {lead_name} (no agent contact in {self.rules.new_lead_reassign_minutes} min)"
            reassign_source = display_source(person)
            reassign_html = (
                f"<h2>\u26a0\ufe0f Speed-to-Lead Reassignment</h2>"
                f"<p><strong>{html.escape(lead_name)}</strong> has been automatically reassigned to you.</p>"
                f"<p><strong>Reason:</strong> {html.escape(prev_agent_name)} did not make first contact within "
                f"{self.rules.new_lead_reassign_minutes} business minutes.</p>"
                f"<p><strong>Source:</strong> {html.escape(reassign_source)}</p>"
                f"<p>Please review and reassign or contact this lead.</p>"
            )
            reassign_plain = f"Lead Reassigned: {lead_name}\nReason: {prev_agent_name} did not make first contact within {self.rules.new_lead_reassign_minutes} business minutes.\nSource: {reassign_source}\n\nPlease review and reassign or contact this lead."
            self.email.send(
                self.rules.owner_email,
                reassign_subject,
                reassign_plain,
                from_email=self.rules.owner_email,
                html_body=reassign_html,
            )
        except Exception as mail_exc:
            LOGGER.warning("Failed to send reassignment email to Peter for lead %s: %s", person_id, mail_exc)

    def is_excluded(self, person: dict) -> bool:
        # 1. Check FUB built-in unsubscribe/opt-out fields
        if person.get("unsubscribed") or person.get("emailOptOut") or person.get("unsubscribedEmail") or person.get("isUnsubscribed"):
            return True
            
        # Also check within nested email dictionaries if available
        emails = person.get("emails") or []
        for email_dict in emails:
            if isinstance(email_dict, dict):
                if email_dict.get("unsubscribed") or email_dict.get("isUnsubscribed") or email_dict.get("optOut"):
                    return True

        # 2. Check FUB stage exclusions
        stage = str(person.get("stage", "")).lower()
        # Exclude trash/opt-out stages
        if stage in {s.lower() for s in self.rules.excluded_stages}:
            return True
        # Exclude active/under-contract/protected stages from any automation outreach
        if stage in {s.lower() for s in self.rules.stale_reassignment_excluded_stages}:
            return True
            
        # 3. Check tag exclusions (including standard unsubscribe and opt-out terms)
        unsubscribe_tags = {
            "unsubscribe", "unsubscribed", "email opt out", "opt out", "do not email", 
            "do not contact", "dnc", "bounced", "realtor", "agent", "do not nurture",
            "manual review", "no ai email", "spam", "annual nurture only", "replied - paused"
        }
        # Merge with rules.excluded_tags to be absolutely thorough
        all_excluded_tags = unsubscribe_tags.union({t.lower() for t in self.rules.excluded_tags})
        return self.has_any_tag(person, all_excluded_tags)

    def _is_excluded_source(self, person: dict) -> Optional[str]:
        """Check if a lead's source is in the excluded_sources list (case-insensitive CONTAINS).

        CONTAINS, not equality. FUB sources carry channel/campaign suffixes
        ("Lease Listing Inquiry - Web", "Zillow Rentals - Austin"), and exact
        matching silently let every one of those variants through.

        Direction is load-bearing: `excluded in source`, never the reverse.
        "zillow" does NOT contain "zillow rentals", so the legit Zillow buyer
        source stays unsuppressed, while "Zillow Rentals - Austin" is caught.

        Returns the matched source string or None."""
        source = str(person.get("source") or person.get("leadSource") or "").lower().strip()
        if not source:
            return None
        for excluded in self.rules.excluded_sources:
            if excluded and excluded in source:
                return person.get("source") or person.get("leadSource") or source
        return None

    def _is_soi_silenced(self, person: dict) -> Optional[str]:
        """Check if a lead is SOI-silenced (total silence from ALL automation).
        A lead is SOI if ANY of:
          1. createdById != Peter (user_id 2) AND createdVia == "Manually"
          2. Any tag starting with "SOI" (case-insensitive)
          3. Source CONTAINS "SOI" (case-insensitive)
        Returns the matched rule description or None."""
        peter_id = int(self.rules.peter_user_id or 2)

        # Rule 3: source CONTAINS "SOI" (case-insensitive) — catches "Theo's SOI", "Tiffany SOI", etc.
        source = str(person.get("source") or person.get("leadSource") or "").lower()
        if "soi" in source:
            return f'source contains SOI: "{person.get("source") or person.get("leadSource")}"'

        # Rule 2: any tag starting with "SOI" (case-insensitive)
        raw_tags = person.get("tags") or []
        for t in raw_tags:
            tag_name = str(t.get("name") if isinstance(t, dict) else t or "").strip()
            if tag_name.lower().startswith("soi"):
                return f'tag starts with SOI: "{tag_name}"'

        # Rule 1: createdById != Peter AND createdVia == "Manually"
        created_via = str(person.get("createdVia") or "").lower()
        created_by_id = int(person.get("createdById") or 0)
        if created_via == "manually" and created_by_id != 0 and created_by_id != peter_id:
            return f"manually created by non-Peter user (createdById={created_by_id}, createdVia=Manually)"

        return None

    def classify_engagement_tier(self, person: dict) -> str:
        """Public tier for a pond lead. See _classify_engagement for detail."""
        tier, _, _ = self._classify_engagement(person)
        return tier

    def _classify_engagement(self, person: dict) -> Tuple[str, Optional[dt.datetime], str]:
        """Classify a pond lead into engagement tiers based on inbound activity.

        Tiers:
          - 'engaged': Any reply/inbound activity in last 60 days → 10-day cadence
          - 'cold': Zero inbound activity in 90+ days → 21-day cadence
          - 'standard': Everyone else → 14-day cadence (current default)

        Data source: FUB person fields (lastReceivedEmail, lastReceivedText, lastIncomingCall)
        + our audit_log reply_detected entries. FUB does NOT expose email open/click
        tracking via API, so we use replies + inbound activity as the engagement signal.

        Returns (tier, latest_inbound, reason). latest_inbound is what separates
        the two very different populations inside 'cold':

          latest_inbound is None -> NEVER engaged. No reply, text or call, ever.
          latest_inbound is set  -> LAPSED. They did engage once; it was >90d ago.

        Cadence treats those differently (see the call site), so the caller needs
        the distinction rather than just the tier label. The tier vocabulary is
        deliberately unchanged so the digest breakdown, the funnel's ENGAGED
        stage and the LLM prompt all keep working.
        """
        person_id = int(person["id"])
        now = dt.datetime.now(UTC)

        # Check FUB person-level inbound fields
        latest_inbound: Optional[dt.datetime] = None
        for key in ("lastReceivedEmail", "lastReceivedText", "lastIncomingCall"):
            val = person.get(key)
            if val:
                try:
                    parsed = parse_fub_datetime(val)
                    if parsed and (latest_inbound is None or parsed > latest_inbound):
                        latest_inbound = parsed
                except Exception:
                    pass

        # Also check our own reply_detected audit log for this lead
        try:
            since_90 = now - dt.timedelta(days=90)
            reply_rows = self.db.recent_audit_rows(["reply_detected"], since_90)
            for row in reply_rows:
                if row.get("person_id") == person_id:
                    row_dt = parse_dt(row["created_at"])
                    if row_dt and (latest_inbound is None or row_dt > latest_inbound):
                        latest_inbound = row_dt
        except Exception:
            pass

        # Classify
        if latest_inbound:
            days_since = (now - latest_inbound).days
            if days_since <= 60:
                tier = "engaged"
                reason = f"Inbound activity {days_since}d ago (within 60d)"
            elif days_since > 90:
                tier = "cold"
                reason = f"Last inbound {days_since}d ago (>90d)"
            else:
                tier = "standard"
                reason = f"Last inbound {days_since}d ago (61-90d)"
        else:
            tier = "cold"
            reason = "No inbound activity detected"

        # Persist tier classification
        self.db.upsert_engagement_tier(person_id, tier, reason)
        return tier, latest_inbound, reason

    def qualifies_for_reengagement(self, person: dict) -> bool:
        # Strictly restrict automated re-engagement emails to leads currently inside a configured Pond
        assigned_pond_id = person.get("assignedPondId")
        if not assigned_pond_id:
            return False
        
        # Verify the pond is in our configured list of ponds (e.g., Lead Pond ID: 2)
        valid_pond_ids = {int(pid) for pid in self.rules.pond_ids}
        return int(assigned_pond_id) in valid_pond_ids

    def send_instant_welcome_email(self, person_id: int) -> str:
        """Immediately generates and sends a personalized welcome email to a newly created lead."""
        try:
            person = self.fub.get_person(person_id)
            if not person:
                LOGGER.warning("Could not fetch FUB details for welcome email: lead %s not found", person_id)
                return "skipped"
                
            if self.is_excluded(person):
                LOGGER.info("Welcome email skipped for lead %s: lead is excluded (trash/active/under-contract/unsubscribed)", person_id)
                self.db.log("instant_welcome_email", "skipped", person_id, {"reason": "excluded stage, tag, or unsubscribe"})
                return "skipped"
                
            emails = person.get("emails") or []
            if not emails:
                LOGGER.info("Welcome email skipped for lead %s: no email address found", person_id)
                self.db.log("instant_welcome_email", "skipped", person_id, {"reason": "no email address"})
                return "skipped"
                
            # Check if we already sent a welcome email to prevent double-sends
            recent = self.db.recent_audit_rows("instant_welcome_email", person_id)
            if recent:
                LOGGER.info("Welcome email skipped for lead %s: already sent recently", person_id)
                return "skipped"
                
            # Infer city for personalization
            city = self.city_for_customer_nurture(person)
            
            # Generate personalized welcome email
            generated = self.content.generate_welcome_email(person, city or "Texas")
            
            sender_email = self.sender_email_for_person(person)
            to_email = emails[0].get("value") or emails[0].get("email")
            
            from_display = f"Lifestyle Design Realty <{self.rules.team_email}>"
            if to_email:
                self.email.send(
                    to_email,
                    generated["subject"],
                    append_email_footer(generated["email_body"], self.rules),
                    from_email=from_display,
                    reply_to=self.rules.owner_email,
                    html_body=build_pond_email_html(generated["email_body"], self.rules),
                    bcc=[self.rules.owner_email] if to_email.lower() != self.rules.owner_email.lower() else [],
                )
                # Log a note in FUB so agents can see the welcome email went out
                # Peter requested notes on EVERYTHING to lead by example
                try:
                    self.fub.add_note(
                        person_id, 
                        "Instant Welcome Email Sent", 
                        f"Sent instant welcome email to new lead.\n\n"
                        f"• Subject: \"{generated['subject']}\"\n"
                        f"• City focus: {city or 'Texas/general'}"
                    )
                except Exception as note_exc:
                    LOGGER.warning("Failed to log instant welcome email FUB note for person %s: %s", person_id, note_exc)
                    
                _send_status = "dry_run_sent" if self.settings.dry_run else "sent"
                self.db.log("instant_welcome_email", _send_status, person_id, {
                    "to": to_email,
                    "subject": generated["subject"],
                    "city": city or "Texas/general",
                    "sender": sender_email,
                    "contact_name": person_name(person),
                })
                LOGGER.info("Instant welcome email successfully sent to lead %s", person_id)
                return _send_status
                
        except Exception as exc:  # noqa: BLE001
            LOGGER.exception("Failed to send instant welcome email to lead %s", person_id)
            self.db.log("instant_welcome_email", "error", person_id, {"error": str(exc)})
            return "error"
        return "skipped"

    def has_any_tag(self, person: dict, tags: Iterable[str]) -> bool:
        raw_tags = person.get("tags") or []
        contact_tags = set()
        for t in raw_tags:
            if isinstance(t, dict):
                # FUB returns tags as {"name": "Do Not Nurture", ...}
                name = t.get("name") or t.get("tag") or t.get("label") or ""
                contact_tags.add(str(name).lower())
            else:
                contact_tags.add(str(t).lower())
        return bool(contact_tags.intersection({t.lower() for t in tags}))

    def lead_touched_after_creation(self, person: dict, created: dt.datetime,
                                    assigned_user_id: Optional[int] = None) -> bool:
        """Return True only if a HUMAN agent touched this lead after `created`.

        Two modes:

        - assigned_user_id given (speed-to-lead timers — new-lead AND
          assignment-change, policy of 2026-08-26): ONLY activity by that
          agent, timestamped AT OR AFTER `created` (the timer's anchor),
          counts. Notes/calls/texts from anyone else, or from before the
          timer existed, never cancel — the Jose Brito timer (armed 13:57)
          was killed by a 13:23 note under the old any-human rule.

        - assigned_user_id None (untouched-assignment daily sweep): any
          human touch after the anchor counts, as before.

        In both modes, automation-generated notes (subject starts with
        'Automation:') and the bot's own audit-logged sends are excluded so
        they cannot satisfy the first-touch requirement.

        IMPORTANT: FUB does NOT reliably bump lastCommunication/lastActivity for
        manual notes or unlogged calls. Therefore we ALWAYS check notes directly
        via the API, regardless of lastX field values.
        """
        person_id = int(person.get("id", 0))
        # Use a 15-second buffer (not 60s) — a real agent note written seconds
        # after assignment is a legitimate first touch.
        buffer = dt.timedelta(seconds=15)

        # The bot's own sends are NOT touches. A pond-nurture or drip email
        # syncs into FUB and bumps lastSentEmail exactly like an agent's mail,
        # so an outbound clock landing within a few minutes of one of our own
        # audit-logged sends is the automation talking, not the agent.
        bot_send_times: List[dt.datetime] = []
        try:
            from .funnel import EMAIL_SEND_ACTIONS as _SEND_ACTIONS
            from .funnel import SENT_STATUSES as _SENT_STATUSES

            for row in self.db.recent_audit_rows(list(_SEND_ACTIONS), created):
                if int(row.get("person_id") or 0) != person_id:
                    continue
                if row.get("status") not in _SENT_STATUSES:
                    continue
                sent_ts = parse_dt(row.get("created_at") or "")
                if sent_ts:
                    bot_send_times.append(sent_ts)
        except Exception as _bs_exc:  # noqa: BLE001
            LOGGER.debug("lead_touched_after_creation: bot-send lookup failed: %s", _bs_exc)

        def _is_bot_send(ts: dt.datetime) -> bool:
            return any(abs((ts - bot_ts).total_seconds()) <= 300 for bot_ts in bot_send_times)

        if assigned_user_id is not None:
            return self._touched_by_assigned_agent(
                person, person_id, created, int(assigned_user_id), _is_bot_send)

        # 1. Fast-path: Real call or outbound text/email — human-initiated,
        #    unless the timestamp matches one of the bot's own sends.
        for key in ("lastSentEmail", "lastSentText", "lastCall"):
            value = person.get(key)
            if value:
                parsed = parse_dt(value)
                if parsed and parsed > created + buffer and not _is_bot_send(parsed):
                    return True

        # 2. Fast-path: lastCommunication / lastActivity moved — if it moved AND
        #    there are human notes, we can return True immediately.
        for key in ("lastCommunication", "lastActivity"):
            value = person.get(key)
            if value:
                parsed = parse_dt(value)
                if parsed and parsed > created + buffer:
                    try:
                        recent_notes = self.fub.get_notes(person_id, limit=5)
                        human_notes = [
                            n for n in recent_notes
                            if not str(n.get("subject") or n.get("title") or "").startswith("Automation:")
                            and parse_dt(n.get("createdAt") or n.get("created") or "") is not None
                            and (parse_dt(n.get("createdAt") or n.get("created") or "") or created) > created + buffer
                        ]
                        if human_notes:
                            return True
                        # lastActivity moved but only automation notes — fall through to ungated check
                        LOGGER.info("lead_touched_after_creation: person %s lastActivity moved but automation-only, checking notes directly", person_id)
                    except Exception as exc:
                        LOGGER.warning("lead_touched_after_creation: could not fetch notes for person %s (fast-path): %s", person_id, exc)
                        # On API error, fall back to trusting the timestamp (safe default)
                        return True
                    # Already fetched notes in this branch — skip the ungated check below
                    # since we just verified there are no human notes
                    return False

        # 3. UNGATED notes check — FUB does NOT reliably bump lastX fields for
        #    manual notes or unlogged calls. Always query notes directly.
        try:
            recent_notes = self.fub.get_notes(person_id, limit=10)
            human_notes = [
                n for n in recent_notes
                if not str(n.get("subject") or n.get("title") or "").startswith("Automation:")
                and parse_dt(n.get("createdAt") or n.get("created") or "") is not None
                and (parse_dt(n.get("createdAt") or n.get("created") or "") or created) > created + buffer
            ]
            if human_notes:
                LOGGER.info("lead_touched_after_creation: person %s has %d human note(s) post-creation (ungated check)", person_id, len(human_notes))
                return True
        except Exception as exc:
            LOGGER.warning("lead_touched_after_creation: could not fetch notes for person %s (ungated): %s", person_id, exc)
            # On API error, be safe — assume touched to avoid false reassignment
            return True

        # NOTE: Do NOT use person.get("contacted") as a fallback here.
        # FUB sets contacted=true whenever ANY note is added to a lead, including
        # automation-generated warning notes. Using it as a fallback would cancel
        # the 60-min reassignment timer the moment the 30-min warning note is posted,
        # preventing reassignment from ever firing. Only explicit human actions
        # (calls, texts, emails, non-automation notes) count as a qualifying touch.
        return False

    def _touched_by_assigned_agent(self, person: dict, person_id: int,
                                   anchor: dt.datetime, agent_id: int,
                                   is_bot_send) -> bool:
        """Strict touch check for speed-to-lead timers (policy 2026-08-26).

        A timer is cancelled ONLY by activity that is provably the assigned
        agent's own — a note they created, a text/email they sent, a call
        they were on — timestamped at or after the timer's anchor. The
        person-level lastX stamps carry no author, so they gate which channel
        APIs are worth querying but can never prove a touch by themselves.
        Anything unattributable, from anyone else, or from before the anchor
        contributes nothing; so does an API error (fail closed — an outage
        must not cancel a timer, per the ONLY in the policy).
        """
        def _row_ts(row: dict) -> Optional[dt.datetime]:
            return parse_dt(row.get("created") or row.get("createdAt") or "")

        def _stamp_at_or_after(*keys: str) -> bool:
            for key in keys:
                value = person.get(key)
                if value:
                    parsed = parse_dt(value)
                    if parsed and parsed >= anchor:
                        return True
            return False

        # Outbound texts — /textMessages rows carry the sending agent's userId.
        if _stamp_at_or_after("lastSentText"):
            try:
                for msg in self.fub.get_text_messages(person_id, limit=20):
                    ts = _row_ts(msg)
                    if ts is None or ts < anchor or is_inbound_message(msg):
                        continue
                    if int(msg.get("userId") or 0) != agent_id or is_bot_send(ts):
                        continue
                    LOGGER.info("touched_by_assigned_agent: person %s — agent %s text at %s",
                                person_id, agent_id, ts.isoformat())
                    return True
            except Exception as exc:  # noqa: BLE001
                LOGGER.warning("touched_by_assigned_agent: text lookup failed for person %s: %s",
                               person_id, exc)

        # Outbound emails — /emails rows carry userId too (the bot's own synced
        # sends carry the API-key user's id and are additionally excluded by the
        # audit-log time match in is_bot_send).
        if _stamp_at_or_after("lastSentEmail"):
            try:
                for mail in self.fub.get_emails(person_id, limit=20):
                    ts = _row_ts(mail)
                    if ts is None or ts < anchor or is_inbound_message(mail):
                        continue
                    if int(mail.get("userId") or 0) != agent_id or is_bot_send(ts):
                        continue
                    LOGGER.info("touched_by_assigned_agent: person %s — agent %s email at %s",
                                person_id, agent_id, ts.isoformat())
                    return True
            except Exception as exc:  # noqa: BLE001
                LOGGER.warning("touched_by_assigned_agent: email lookup failed for person %s: %s",
                               person_id, exc)

        # Calls the agent was on — either direction is the agent working the lead.
        if _stamp_at_or_after("lastCall", "lastIncomingCall"):
            try:
                for call in self.fub.get_calls(person_id, limit=20):
                    ts = _row_ts(call)
                    if ts is None or ts < anchor:
                        continue
                    if int(call.get("userId") or 0) != agent_id:
                        continue
                    LOGGER.info("touched_by_assigned_agent: person %s — agent %s call at %s",
                                person_id, agent_id, ts.isoformat())
                    return True
            except Exception as exc:  # noqa: BLE001
                LOGGER.warning("touched_by_assigned_agent: call lookup failed for person %s: %s",
                               person_id, exc)

        # Notes — ALWAYS checked: FUB does not reliably bump any lastX stamp
        # for a manually written note.
        try:
            for note in self.fub.get_notes(person_id, limit=10):
                ts = _row_ts(note)
                if ts is None or ts < anchor:
                    continue
                if str(note.get("subject") or note.get("title") or "").startswith("Automation:"):
                    continue
                if int(note.get("createdById") or 0) != agent_id:
                    continue
                LOGGER.info("touched_by_assigned_agent: person %s — agent %s note at %s",
                            person_id, agent_id, ts.isoformat())
                return True
        except Exception as exc:  # noqa: BLE001
            LOGGER.warning("touched_by_assigned_agent: note lookup failed for person %s: %s",
                           person_id, exc)

        return False

    def scan_reply_detection(self) -> None:
        """Scans leads that received a bot email in the last 7 days for incoming replies.

        Every inbound message after the send is classified (classify_reply):
          opt-out  — trashed + tagged immediately, logged as
                     reply_intent_disqualification. Never counts WARM, never
                     alerts: the only correct response to "UNSUBSCRIBE" is
                     silence.
          auto     — within AUTO_REPLY_WINDOW_SECONDS of the send or carrying
                     an AUTO_REPLY_MARKERS phrase. Logged as
                     auto_reply_detected and nothing else — no tag, no alert,
                     no WARM.
          human    — 1. Tags the lead "Replied - Paused" to suppress automation
                     2. Alerts the owning agent (or Peter for pond leads)
                     3. Logs a FUB note and a reply_detected/alert_sent row,
                        which is what WARM and NEEDS-A-REPLY count.
        Runs every 10 minutes via scheduler.
        """
        LOGGER.info("Reply detection scan starting...")
        since = dt.datetime.now(UTC) - dt.timedelta(days=7)
        # Get all leads that received any bot email in the last 7 days
        email_actions = ["pond_nurture", "agent_bot_email", "closed_congrats", "closed_drip",
                         "long_term_nurture_drip", "instant_welcome_email", "seller_nurture"]
        recent_sends = self.db.recent_audit_rows(email_actions, since)
        # Filter to only real sends — exclude dry_run_sent (no email was actually delivered)
        sent_rows = [r for r in recent_sends if r.get("status") in ("sent", "email_sent", "completed")]
        # Deduplicate by person_id — keep the most recent send per lead
        latest_send_by_person: Dict[int, str] = {}
        for row in sent_rows:
            pid = row.get("person_id")
            if pid and pid not in latest_send_by_person:
                latest_send_by_person[int(pid)] = row["created_at"]
        # Thread-lineage anchors over the wide sweep's 60-day horizon, NOT
        # the 7-day watch window: a lead answers whichever of our emails
        # sits in their inbox, and on normal cadence that anchor's audit
        # row is routinely 8+ days old — bounding it to the watch window
        # downgraded those genuine replies to review.
        send_times_by_person: Dict[int, List[dt.datetime]] = {}
        for row in self.db.recent_audit_rows(
                email_actions,
                dt.datetime.now(UTC) - dt.timedelta(
                    days=self.WIDE_SWEEP_SEND_LOOKBACK_DAYS)):
            pid = row.get("person_id")
            if not pid or row.get("status") not in ("sent", "email_sent", "completed"):
                continue
            sent_ts = parse_fub_datetime(row.get("created_at"))
            if sent_ts:
                send_times_by_person.setdefault(int(pid), []).append(sent_ts)
        if not latest_send_by_person:
            LOGGER.info("Reply detection: no recent bot emails found in last 7 days. Nothing to scan.")
            return
        LOGGER.info("Reply detection: checking %s leads that received bot emails in last 7 days.", len(latest_send_by_person))
        # Check which leads already have the "Replied - Paused" tag (skip them)
        # Leads already alerted on inside the same 7-day window as the sends —
        # one reply is one alert, however many times the scan runs over it.
        #
        # Only status="alert_sent" counts. The per-lead handler at the bottom of
        # the loop writes reply_detected/"error" rows too, and while those were
        # in this set a single transient FUB error suppressed reply detection for
        # that lead for a full week — the failure silencing the retry.
        prior_detections = self.db.recent_audit_rows(["reply_detected"], since)
        already_alerted = self._unvoided_alert_pids(prior_detections, since)
        # Leads whose reply already got them trashed as an opt-out — their tags
        # would make is_excluded skip them anyway, but checking here saves the
        # get_person call.
        prior_disqualified = self.db.recent_audit_rows(
            ["reply_intent_disqualification", "pond_opt_out_trash"], since)
        already_disqualified = {
            int(r["person_id"]) for r in prior_disqualified if r.get("person_id")
        }
        # Auto-replies already classified, keyed by the reply's own timestamp:
        # the same out-of-office must not be re-logged every ten minutes, but a
        # NEW inbound message from the same lead must still be looked at —
        # Ingrid's autoresponder today must not eat her real answer tomorrow.
        auto_logged: Dict[int, set] = {}
        for r in self.db.recent_audit_rows(["auto_reply_detected"], since):
            pid = r.get("person_id")
            if not pid:
                continue
            try:
                logged_at = json.loads(r.get("details") or "{}").get("reply_at")
            except Exception:  # noqa: BLE001
                logged_at = None
            if logged_at:
                auto_logged.setdefault(int(pid), set()).add(logged_at)
        # Unverified inbound already recorded, keyed like auto_logged: the
        # same lender email must not be re-logged every ten minutes, but it
        # must NOT suppress the lead either — a verified reply arriving after
        # third-party mail still alerts.
        unverified_logged = self._unverified_inbound_logged(since)
        alerts_sent = 0
        cap = 20  # Max alerts per scan to avoid flooding
        for person_id, send_time_str in latest_send_by_person.items():
            if alerts_sent >= cap:
                LOGGER.info("Reply detection: alert cap (%s) reached. Stopping.", cap)
                break
            if person_id in already_alerted or person_id in already_disqualified:
                continue
            try:
                person = self.fub.get_person(person_id)
                if not person:
                    continue
                # Skip if already tagged
                if self.has_any_tag(person, ["Replied - Paused"]):
                    continue
                if self.is_excluded(person):
                    continue
                # Parse the send time to compare against incoming emails
                send_dt = parse_fub_datetime(send_time_str)
                if not send_dt:
                    continue
                # EVERY inbound message after the send, both channels, oldest
                # first — not just the first match. One lead can hold an
                # autoresponder AND a real answer, and acting on whichever came
                # first would let the machine's reply hide the person's.
                # 25 emails, not 10: the lineage anchor (the synced copy of
                # our send) must be IN the fetch, and busy records — exactly
                # the ones accumulating third-party mail — push it out.
                emails = self.fub.get_emails(person_id, limit=25)
                texts = self.fub.get_text_messages(person_id, limit=10)
                inbound: List[Tuple[dt.datetime, dict]] = []
                for msg in [*emails, *texts]:
                    if not is_inbound_message(msg):
                        continue
                    msg_dt = parse_fub_datetime(
                        msg.get("dateCreated") or msg.get("created") or msg.get("date"))
                    if msg_dt and msg_dt > send_dt:
                        inbound.append((msg_dt, msg))
                if not inbound:
                    continue
                inbound.sort(key=lambda item: item[0])

                classified = [
                    (when, msg, classify_reply(msg, send_dt, when, self._OPT_OUT_KEYWORDS))
                    for when, msg in inbound
                ]
                opt_outs = [(w, m) for w, m, kind in classified if kind == "opt_out"]
                humans = [(w, m) for w, m, kind in classified if kind == "human"]
                autos = [(w, m) for w, m, kind in classified if kind == "auto_reply"]

                # Thread lineage: only an inbound on a thread we started may
                # tag, page, trash, or count WARM. Third-party mail FUB
                # attached to the record (the 2026-08-28 lender false
                # positive) fails this and is surfaced for review instead.
                # Opt-outs are gated too — FUB's `unsubscribed` flag rides
                # on synced third-party mail, and trashing the LEAD off a
                # stranger's unsubscribe click would be strictly worse than
                # the false page this fix exists to prevent. Texts and
                # unsubscribes from our own threads still trash.
                messages = [*emails, *texts]
                bot_sends = send_times_by_person.get(person_id, [])
                verified_opt_outs = [
                    (w, m) for w, m in opt_outs
                    if reply_thread_verified(m, messages, bot_sends)
                ]
                if verified_opt_outs:
                    # Compliance path: trash + tag, no hot-lead alert, and no
                    # reply_detected row — an unsubscribe must never count WARM.
                    self._trash_opt_out_reply(person_id, person, *verified_opt_outs[-1])
                    continue
                verified = [
                    (w, m) for w, m in humans
                    if reply_thread_verified(m, messages, bot_sends)
                ]
                unverified = sorted(
                    [(w, m) for w, m in [*humans, *opt_outs]
                     if not reply_thread_verified(m, messages, bot_sends)],
                    key=lambda item: item[0])

                if not verified and unverified:
                    self._handle_unverified_inbound(
                        person_id, person, *unverified[-1],
                        already_logged=unverified_logged)
                    continue
                humans = verified

                if not humans:
                    # Machine mail only. Recorded so the backlog maths and the
                    # daily summary can see it happened, but no tag, no alert,
                    # and no WARM: nobody is waiting for an answer.
                    auto_at, auto_msg = autos[-1]
                    if auto_at.isoformat() not in auto_logged.get(person_id, set()):
                        LOGGER.info("Auto-reply classified for lead %s (%.0fs after send)",
                                    person_id, (auto_at - send_dt).total_seconds())
                        self.db.log("auto_reply_detected", "classified", person_id, {
                            "reply_at": auto_at.isoformat(),
                            "reply_snippet": reply_display_snippet(auto_msg)[:200],
                            "seconds_after_send": round((auto_at - send_dt).total_seconds(), 1),
                            "contact_name": (f"{person.get('firstName', '')} "
                                             f"{person.get('lastName', '')}").strip(),
                        })
                    continue

                reply_at, reply_found = humans[-1]
                self._handle_human_reply(person_id, person, reply_at, reply_found)
                alerts_sent += 1
            except Exception as exc:
                LOGGER.exception("Reply detection: error processing lead %s: %s", person_id, exc)
                self.db.log("reply_detected", "error", person_id, {"error": str(exc)})
        LOGGER.info("Reply detection scan complete. Alerts sent: %s", alerts_sent)
        # Dead-man's switch. The reply-detection workflow runs an inline
        # `python3 -c` block rather than a script file, so there is no entrypoint
        # to hang the ping on — it lives at the end of the scan itself.
        # No-op unless HEALTHCHECK_URL_REPLY_DETECTION is set.
        try:
            from .healthcheck import ping as _hc_ping
            _hc_ping("reply_detection")
        except Exception as _hc_exc:  # noqa: BLE001 — never break the scan
            LOGGER.warning("healthcheck ping skipped: %s", _hc_exc)

    def _handle_human_reply(
        self, person_id: int, person: dict, reply_at: dt.datetime, reply_found: dict
    ) -> None:
        """A real person answered: tag, note, hot-lead alert, audit row.

        Shared by the 10-minute scan and the daily wide sweep so the two can
        never drift apart on what a detected reply does.
        """
        # REPLY DETECTED — take action
        reply_body = reply_display_snippet(reply_found)
        reply_snippet = reply_body[:300]
        reply_channel = "email" if reply_found.get("subject") is not None or "email" in str(reply_found.get("type", "")).lower() else "text"
        LOGGER.info("Reply detected for lead %s via %s", person_id, reply_channel)
        # 1. Tag the lead
        tags_to_add = ["Replied - Paused"]
        # If this is a seller lead, also add "Seller-Replied" tag for Monday digest
        if self.has_any_tag(person, [SELLER_LEAD_TAG]):
            tags_to_add.append(SELLER_REPLIED_TAG)
            LOGGER.info("Reply detected for SELLER lead %s — adding '%s' tag", person_id, SELLER_REPLIED_TAG)
        self.fub.update_person(person_id, {"tags": tags_to_add}, merge_tags=True)
        # 2. Add FUB note
        note_title = "\U0001f525 Automation: Lead Replied — All Automation Paused"
        note_body = (
            f"This lead replied to an automated email. All automation has been **paused** until an agent reviews.\n\n"
            f"\U0001f4e8 Reply channel: {reply_channel}\n"
            f"\U0001f4ac Reply snippet: \"{reply_snippet}\"\n\n"
            f"\u2705 Action required: Review the reply and either:\n"
            f"  \u2022 Continue the conversation manually\n"
            f"  \u2022 Remove the \"Replied - Paused\" tag to resume automation\n"
            f"  \u2022 Move to Trash if the reply is an opt-out"
        )
        self.fub.add_note(person_id, note_title, note_body)
        # 3. Send alert email to owning agent (or Peter for pond leads)
        assigned_user_id = person.get("assignedUserId")
        agent_email = None
        agent_name = "Agent"
        if assigned_user_id:
            user_info = self.user_cache_by_id().get(int(assigned_user_id))
            if user_info:
                agent_email = user_info.get("email")
                agent_name = user_info.get("name") or "Agent"
        # For pond leads or if agent email not found, alert Peter
        if not agent_email or person.get("assignedPondId"):
            agent_email = self.rules.owner_email
            agent_name = self.rules.peter_name
        lead_name = f"{person.get('firstName', '')} {person.get('lastName', '')}".strip() or f"Lead #{person_id}"
        alert_subject = f"\U0001f525 HOT LEAD REPLY: {lead_name} responded!"
        alert_html = (
            f"<h2>\U0001f525 Lead Reply Detected</h2>"
            f"<p><strong>{lead_name}</strong> replied to an automated email.</p>"
            f"<p><strong>Channel:</strong> {reply_channel}</p>"
            f"<p><strong>Reply:</strong></p>"
            f"<blockquote>{reply_snippet}</blockquote>"
            f"<p><strong>Action:</strong> Review the conversation in FUB and respond personally.</p>"
            f"<p>All automation for this lead has been paused (tagged \"Replied - Paused\").</p>"
            f"<p>To resume automation later, simply remove the tag.</p>"
        )
        alert_plain = f"Lead Reply Detected: {lead_name} replied to an automated email.\nChannel: {reply_channel}\nReply: {reply_snippet}\n\nAction: Review the conversation in FUB and respond personally.\nAll automation for this lead has been paused (tagged 'Replied - Paused').\nTo resume automation later, simply remove the tag."
        try:
            self.email.send(
                agent_email,
                alert_subject,
                alert_plain,
                from_email=self.rules.owner_email,
                cc=[self.rules.owner_email] if agent_email != self.rules.owner_email else [],
                html_body=alert_html,
            )
        except Exception as mail_exc:
            LOGGER.warning("Reply detection: failed to send alert email for lead %s: %s", person_id, mail_exc)
        # 4. Log to audit DB. reply_at is the lead's own timestamp, not
        # the detection time — "hours waiting" in the daily summary is
        # measured from when they wrote, not from when we noticed.
        self.db.log("reply_detected", "alert_sent", person_id, {
            "reply_channel": reply_channel,
            "reply_snippet": reply_snippet[:200],
            "reply_at": reply_at.isoformat(),
            "agent_email": agent_email,
            "agent_name": agent_name,
            "contact_name": lead_name,
        })
        # 5. Best-Send-Time Logging (Tier 3 Feature 4) — log reply hour/day
        try:
            from zoneinfo import ZoneInfo
            local_reply = reply_at.astimezone(ZoneInfo(self.rules.local_timezone))
            self.db.log_reply_time(person_id, local_reply.hour, local_reply.weekday())
        except Exception as rt_exc:
            LOGGER.debug("Reply time logging failed for person %s: %s", person_id, rt_exc)

    def _handle_unverified_inbound(
        self,
        person_id: int,
        person: dict,
        reply_at: dt.datetime,
        msg: dict,
        already_logged: Optional[Dict[int, set]] = None,
    ) -> None:
        """Inbound email on a thread we never started: review, never HOT.

        The 2026-08-28 false positive — a lender's email FUB attached to
        Angie Gonzalez's record — paged Peter, tagged her 'Replied - Paused'
        and counted her WARM off a message she never wrote. This path is
        what that email gets instead: an audit row (the daily summary reads
        it), one FUB note per thread, and nothing else. No tag, no hot-lead
        alert, no reply_detected row, so it can never count WARM or pause
        automation.

        A genuine reply that starts a brand-new thread lands here too — the
        documented cost of the lineage gate. It stays visible to a human;
        it just cannot page one.
        """
        already_logged = already_logged if already_logged is not None else {}
        reply_key = reply_at.isoformat()
        if reply_key in already_logged.get(person_id, set()):
            return
        thread_id = msg.get("threadId")
        contact_name = (f"{person.get('firstName', '')} "
                        f"{person.get('lastName', '')}").strip() or f"Lead #{person_id}"
        LOGGER.info("Unverified inbound for lead %s (thread %s) — review, not HOT",
                    person_id, thread_id)
        # One note per thread: the rows carry thread_id, so a second email on
        # the same lender thread adds a row but not another note.
        noted_threads = self._unverified_noted_threads(person_id)
        self.db.log("unverified_inbound", "review", person_id, {
            "reply_at": reply_key,
            "thread_id": str(thread_id) if thread_id is not None else None,
            "reply_snippet": reply_display_snippet(msg)[:200],
            "contact_name": contact_name,
        })
        already_logged.setdefault(person_id, set()).add(reply_key)
        if str(thread_id) not in noted_threads:
            self.fub.add_note(
                person_id,
                "Automation: unverified inbound email — review",
                ("An email arrived on this lead's record on a thread the "
                 "automation never started (it may be third-party "
                 "correspondence, or a reply on a brand-new thread). "
                 "Automation was NOT paused and no hot-lead alert was sent.\n\n"
                 f"\U0001f4e8 Thread: {thread_id}\n"
                 f"\U0001f4ac Snippet: \"{reply_display_snippet(msg)[:300]}\"\n\n"
                 "✅ If this is really the lead replying, respond "
                 "personally and add the \"Replied - Paused\" tag by hand."),
            )

    def _unverified_noted_threads(self, person_id: int) -> set:
        """Threads already carrying an 'unverified inbound' note, read from
        this lead's unverified_inbound rows — cheaper than paging FUB notes.

        Backfilled rows don't count: the backfill writes rows without notes,
        and treating them as noted would silently turn 'one note per thread'
        into zero notes for any thread the backfill saw first."""
        since = dt.datetime.now(UTC) - dt.timedelta(days=60)
        threads = set()
        for r in self.db.recent_audit_rows(["unverified_inbound"], since):
            if r.get("person_id") and int(r["person_id"]) == person_id:
                try:
                    details = json.loads(r.get("details") or "{}")
                except Exception:  # noqa: BLE001
                    details = {}
                thread = details.get("thread_id")
                if thread is not None and not details.get("backfilled"):
                    threads.add(str(thread))
        return threads

    def _unverified_inbound_logged(self, since: dt.datetime) -> Dict[int, set]:
        """reply_at timestamps already recorded per lead, auto_logged-style."""
        logged: Dict[int, set] = {}
        for r in self.db.recent_audit_rows(["unverified_inbound"], since):
            pid = r.get("person_id")
            if not pid:
                continue
            try:
                logged_at = json.loads(r.get("details") or "{}").get("reply_at")
            except Exception:  # noqa: BLE001
                logged_at = None
            if logged_at:
                logged.setdefault(int(pid), set()).add(logged_at)
        return logged

    def _unvoided_alert_pids(self, rows: List[dict], since: dt.datetime) -> set:
        """People whose reply alert still stands.

        A reply_false_positive_cleared row (the repair sweep's undo) names
        the reply_at of the alert it voided. Without this, a cleared lead
        stayed in already_alerted for the whole dedup window — blind to a
        genuine reply arriving right after the false one was cleaned up.
        """
        voided = set()
        for r in self.db.recent_audit_rows(["reply_false_positive_cleared"], since):
            pid = r.get("person_id")
            if not pid:
                continue
            try:
                reply_at = json.loads(r.get("details") or "{}").get("reply_at")
            except Exception:  # noqa: BLE001
                reply_at = None
            if reply_at:
                voided.add((int(pid), reply_at))
        alerted = set()
        for r in rows:
            pid = r.get("person_id")
            if not pid or r.get("status") not in ("alert_sent", "backfilled"):
                continue
            try:
                reply_at = json.loads(r.get("details") or "{}").get("reply_at")
            except Exception:  # noqa: BLE001
                reply_at = None
            if reply_at and (int(pid), reply_at) in voided:
                continue
            alerted.add(int(pid))
        return alerted

    def _trash_opt_out_reply(
        self, person_id: int, person: dict, reply_at: dt.datetime, message: dict
    ) -> None:
        """A reply that says unsubscribe: trash + tag, note, one audit row.

        Same FUB writes as the AI opt-out path in
        scan_all_leads_for_disqualification, and the same audit action
        (reply_intent_disqualification / opt_out_trashed) so the funnel's WARM
        subtraction and the ramp's opt-out guardrail both see it exactly once.
        Deliberately NOT a reply_detected row: an unsubscribe is a reply, but
        counting it warm would make a bad week look like a good one.
        """
        person_name_str = f"{person.get('firstName', '')} {person.get('lastName', '')}".strip()
        snippet = reply_display_snippet(message)[:200]
        channel = "email" if message.get("subject") is not None else "text"
        LOGGER.warning(
            "REPLY OPT-OUT: lead %s (%s) replied with opt-out language via %s. Trashing.",
            person_id, person_name_str, channel,
        )
        self.fub.update_person(
            person_id, {"stage": "Trash", "assignedPondId": None, "assignedUserId": None})
        self.fub.update_person(
            person_id, {"tags": ["unsubscribed", "opt-out-auto-trash", "bot_suppress"]},
            merge_tags=True)
        note_title = "\U0001f6ab Automation: Lead Opted Out & Moved to Trash (Reply Detection)"
        note_body = (
            f"Lead replied to a bot email with opt-out language and was automatically "
            f"unsubscribed and moved to **Trash** stage.\n\n"
            f"\U0001f6d1 Trigger snippet: \"{snippet}\"\n"
            f"• Channel: {channel}\n"
            f"• Replied at: {reply_at.isoformat()}\n\n"
            f"Actions taken:\n"
            f"• Stage → Trash\n"
            f"• Tagged \"unsubscribed\" + \"opt-out-auto-trash\" + \"bot_suppress\"\n"
            f"• Unassigned from agent\n"
            f"• All automated outreach permanently stopped"
        )
        try:
            self.fub.add_note(person_id, note_title, note_body)
        except Exception as note_exc:  # noqa: BLE001
            LOGGER.warning("Failed to add opt-out note for person %s: %s", person_id, note_exc)
        self.db.log("reply_intent_disqualification", "opt_out_trashed", person_id, {
            "trigger": "reply_detection_keyword",
            "reply_at": reply_at.isoformat(),
            "snippet": snippet,
            "channel": channel,
            "person_name": person_name_str,
            "dry_run": self.settings.dry_run,
        })

    #: How far back the daily wide sweep looks. Two days overlaps consecutive
    #: daily runs, so a reply can never fall between them.
    WIDE_SWEEP_DAYS = 2

    #: Pages of 100 in the -updated walk. 15 (1,500 leads) is several times the
    #: busiest observed day; a runaway walk must not eat the API.
    WIDE_SWEEP_MAX_PAGES = 15

    #: The audit actions whose sends put a lead on a reply-watch surface —
    #: the same list scan_reply_detection builds its 7-day watch from.
    SWEEP_SEND_ACTIONS = ("pond_nurture", "agent_bot_email", "closed_congrats",
                          "closed_drip", "long_term_nurture_drip",
                          "instant_welcome_email", "seller_nurture")
    SWEEP_SEND_STATUSES = ("sent", "email_sent", "completed")

    #: The old-thread rotation: every lead emailed 7–60 days ago is re-read at
    #: least once per this many days (person_id modulus picks today's slice),
    #: bounding the daily cost to ~a tenth of that population.
    WIDE_SWEEP_ROTATION_DAYS = 10
    WIDE_SWEEP_SEND_LOOKBACK_DAYS = 60

    def scan_wide_reply_sweep(self, days: int = WIDE_SWEEP_DAYS) -> None:
        """Replies to OLD threads — the miss class the 10-minute scan cannot see.

        That scan only watches leads we emailed in the last 7 days, so a lead
        answering a month-old thread (Joe Muñoz, 2026-08-22, answering a July 4
        email) was invisible to it, and stayed invisible however many scans
        ran. Once a day this checks two surfaces with the same classifier, the
        same actions and the same dedup rows as the 10-minute scan:

        1. Every person FUB says was updated in the last `days` days. CHEAP
           but narrow: the first backfill dry run (2026-08-24, run
           32757820303) proved FUB does NOT bump `updated` for synced email —
           65 records in a fortnight that provably contained four replies —
           so this only catches activity that also touched the record.
        2. The audit-log rotation: every lead WE emailed 7–60 days ago (our
           own send record, which cannot lie), one deterministic tenth per
           day, message histories read directly. This is the surface that
           actually finds a reply to an old thread — within at most
           WIDE_SWEEP_ROTATION_DAYS of it arriving.
        """
        LOGGER.info("Wide reply sweep starting (leads updated in last %s days)...", days)
        now = dt.datetime.now(UTC)
        window_start = now - dt.timedelta(days=days)
        lookback = now - dt.timedelta(days=14)

        already_alerted = self._unvoided_alert_pids(
            self.db.recent_audit_rows(["reply_detected"], lookback), lookback)
        already_disqualified = {
            int(r["person_id"]) for r in self.db.recent_audit_rows(
                ["reply_intent_disqualification", "pond_opt_out_trash"], lookback)
            if r.get("person_id")
        }
        auto_logged: Dict[int, set] = {}
        for r in self.db.recent_audit_rows(["auto_reply_detected"], lookback):
            pid = r.get("person_id")
            if not pid:
                continue
            try:
                logged_at = json.loads(r.get("details") or "{}").get("reply_at")
            except Exception:  # noqa: BLE001
                logged_at = None
            if logged_at:
                auto_logged.setdefault(int(pid), set()).add(logged_at)
        unverified_logged = self._unverified_inbound_logged(lookback)

        # Every bot send in the rotation lookback, per lead: the rotation's
        # floor AND both surfaces' thread-lineage anchors, so it is built
        # once, before either surface runs.
        latest_send: Dict[int, dt.datetime] = {}
        send_times: Dict[int, List[dt.datetime]] = {}
        for row in self.db.recent_audit_rows(
                list(self.SWEEP_SEND_ACTIONS),
                now - dt.timedelta(days=self.WIDE_SWEEP_SEND_LOOKBACK_DAYS)):
            if row.get("status") not in self.SWEEP_SEND_STATUSES:
                continue
            pid = row.get("person_id")
            sent_ts = parse_fub_datetime(row.get("created_at"))
            if not pid or not sent_ts:
                continue
            pid = int(pid)
            send_times.setdefault(pid, []).append(sent_ts)
            if pid not in latest_send or sent_ts > latest_send[pid]:
                latest_send[pid] = sent_ts

        alerts_sent = 0
        cap = 20
        walked = detailed = 0
        params: Dict[str, Any] = {"sort": "-updated", "limit": 100}
        pages = 0
        stop = False
        while pages < self.WIDE_SWEEP_MAX_PAGES and not stop:
            data = self.fub._request("GET", "/people", params=dict(params))
            people = data.get("people", data.get("data", []))
            if not people:
                break
            for person_stub in people:
                updated = parse_fub_datetime(person_stub.get("updated"))
                if updated and updated < window_start:
                    stop = True
                    break
                walked += 1
                person_id = int(person_stub["id"])
                if person_id in already_alerted or person_id in already_disqualified:
                    continue
                if self.is_excluded(person_stub):
                    continue
                if alerts_sent >= cap:
                    LOGGER.info("Wide reply sweep: alert cap (%s) reached. Stopping.", cap)
                    stop = True
                    break
                try:
                    # The list payload has no lastReceivedEmail/Text — only the
                    # individual endpoint carries the inbound clocks.
                    person = self.fub.get_person(person_id)
                    if not person:
                        continue
                    detailed += 1
                    has_fresh_inbound = False
                    for key in ("lastReceivedEmail", "lastReceivedText"):
                        parsed = parse_fub_datetime(person.get(key))
                        if parsed and parsed > window_start:
                            has_fresh_inbound = True
                            break
                    if not has_fresh_inbound:
                        continue
                    if self.has_any_tag(person, ["Replied - Paused"]):
                        continue
                    if self.is_excluded(person):
                        continue

                    if self._sweep_classify_and_act(
                            person_id, window_start, auto_logged, person=person,
                            bot_sends=send_times.get(person_id, []),
                            unverified_logged=unverified_logged) == "alerted":
                        alerts_sent += 1
                except Exception as exc:  # noqa: BLE001
                    LOGGER.exception("Wide reply sweep: error processing lead %s: %s",
                                     person_id, exc)
                    self.db.log("reply_detected", "error", person_id, {"error": str(exc)})
            pages += 1
            next_cursor = data.get("_metadata", {}).get("next")
            if not next_cursor:
                break
            params["next"] = next_cursor

        # ── Surface 2: the audit-log rotation over old threads ───────────────
        # Everyone we emailed inside the lookback but outside the 10-minute
        # scan's 7-day watch, sliced deterministically by person_id so each
        # lead is re-read at least every WIDE_SWEEP_ROTATION_DAYS. Message
        # histories are read directly; nothing here trusts a FUB clock.
        rotation_checked = 0
        recent_cutoff = now - dt.timedelta(days=7)
        slot = now.timetuple().tm_yday % self.WIDE_SWEEP_ROTATION_DAYS
        for person_id in sorted(latest_send):
            sent_at = latest_send[person_id]
            if sent_at > recent_cutoff:
                continue  # the 10-minute scan owns the last 7 days
            if person_id % self.WIDE_SWEEP_ROTATION_DAYS != slot:
                continue
            if person_id in already_alerted or person_id in already_disqualified:
                continue
            if alerts_sent >= cap:
                LOGGER.info("Wide reply sweep: alert cap (%s) reached in rotation. "
                            "Stopping.", cap)
                break
            rotation_checked += 1
            try:
                # Inbound floor is the lead's own last send: a reply to it is a
                # reply, however long ago that send was.
                if self._sweep_classify_and_act(
                        person_id, sent_at, auto_logged,
                        bot_sends=send_times.get(person_id, []),
                        unverified_logged=unverified_logged) == "alerted":
                    alerts_sent += 1
            except Exception as exc:  # noqa: BLE001
                LOGGER.exception("Wide reply sweep: error processing lead %s: %s",
                                 person_id, exc)
                self.db.log("reply_detected", "error", person_id, {"error": str(exc)})

        LOGGER.info(
            "Wide reply sweep complete. Walked %s recently-updated leads "
            "(%s detail fetches), rotation checked %s old-thread leads, "
            "alerts sent: %s", walked, detailed, rotation_checked, alerts_sent)

    def _sweep_classify_and_act(
        self,
        person_id: int,
        inbound_floor: dt.datetime,
        auto_logged: Dict[int, set],
        person: Optional[dict] = None,
        bot_sends: Optional[List[dt.datetime]] = None,
        unverified_logged: Optional[Dict[int, set]] = None,
    ) -> str:
        """Read one lead's messages, classify inbound after `inbound_floor`,
        act. Returns 'alerted' | 'opt_out' | 'auto' | 'unverified' | 'none'.

        When `person` is None (the rotation path) the messages are fetched
        FIRST and the person record only when inbound is actually found —
        most rotation leads have nothing and cost exactly two calls.

        `bot_sends` are the lead's audit-logged send times, the
        thread-lineage anchors (reply_thread_verified): a human-classified
        inbound on a thread none of our sends belongs to is surfaced as
        unverified instead of alerting.
        """
        messages = [
            *self.fub.get_emails(person_id, limit=25),
            *self.fub.get_text_messages(person_id, limit=10),
        ]
        classified = []
        for when, msg in inbound_messages_since(messages, inbound_floor):
            anchor = latest_outbound_before(messages, when)
            # No outbound in the fetched history (an old thread): anchor far
            # in the past so the timing heuristic cannot fire; keywords and
            # markers still can.
            send_dt = anchor or (when - dt.timedelta(days=3650))
            classified.append(
                (when, msg, classify_reply(msg, send_dt, when, self._OPT_OUT_KEYWORDS)))
        if not classified:
            return "none"

        if person is None:
            person = self.fub.get_person(person_id)
            if not person:
                return "none"
            if self.has_any_tag(person, ["Replied - Paused"]) or self.is_excluded(person):
                return "none"

        opt_outs = [(w, m) for w, m, kind in classified if kind == "opt_out"]
        humans = [(w, m) for w, m, kind in classified if kind == "human"]
        autos = [(w, m) for w, m, kind in classified if kind == "auto_reply"]

        anchors = bot_sends or []
        # Opt-outs need lineage too: FUB's `unsubscribed` flag rides on
        # synced third-party mail, and trashing the LEAD off a stranger's
        # unsubscribe click is the worst version of the Angie incident.
        # Texts and genuine unsubscribes from our own threads still trash.
        verified_opt_outs = [(w, m) for w, m in opt_outs
                             if reply_thread_verified(m, messages, anchors)]
        if verified_opt_outs:
            self._trash_opt_out_reply(person_id, person, *verified_opt_outs[-1])
            return "opt_out"
        verified = [(w, m) for w, m in humans
                    if reply_thread_verified(m, messages, anchors)]
        unverified = sorted(
            [(w, m) for w, m in [*humans, *opt_outs]
             if not reply_thread_verified(m, messages, anchors)],
            key=lambda item: item[0])
        if not verified and unverified:
            self._handle_unverified_inbound(
                person_id, person, *unverified[-1],
                already_logged=unverified_logged)
            return "unverified"
        if verified:
            reply_at, reply_found = verified[-1]
            self._handle_human_reply(person_id, person, reply_at, reply_found)
            return "alerted"
        auto_at, auto_msg = autos[-1]
        if auto_at.isoformat() not in auto_logged.get(person_id, set()):
            auto_anchor = latest_outbound_before(messages, auto_at)
            self.db.log("auto_reply_detected", "classified", person_id, {
                "reply_at": auto_at.isoformat(),
                "reply_snippet": reply_display_snippet(auto_msg)[:200],
                "seconds_after_send": (
                    round((auto_at - auto_anchor).total_seconds(), 1)
                    if auto_anchor else None),
                "contact_name": (f"{person.get('firstName', '')} "
                                 f"{person.get('lastName', '')}").strip(),
            })
        return "auto"


class WebhookPayload(BaseModel):
    eventId: str
    eventCreated: str
    event: str
    resourceIds: List[int]
    uri: Optional[str] = None
    data: Optional[Dict[str, Any]] = None


def load_dotenv_helper(path: str = '.env') -> None:
    from pathlib import Path
    env_path = Path(path)
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(errors='ignore').splitlines():
        line = raw_line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if value.startswith('${') and value.endswith('}'):
            value = os.environ.get(value[2:-1], value)
        os.environ[key] = value

def create_app() -> FastAPI:
    load_dotenv_helper()
    settings = Settings.from_env()
    rules = Rules.load(settings.rules_path)
    db = AuditDB(settings.database_path)
    fub = FollowUpBossClient(settings)
    engine = RuleEngine(settings, rules, fub, db)

    app = FastAPI(title="Follow Up Boss Automation Service")

    scheduler = None
    if os.getenv("FUB_DISABLE_SCHEDULER", "false").lower() not in {"1", "true", "yes"}:
        scheduler = BackgroundScheduler(timezone="UTC")
        scheduler.add_job(engine.run_daily_scans, "cron", hour=7, minute=0, id="daily_scans", replace_existing=True)
        # Poll for newly created/assigned leads every 5 minutes
        scheduler.add_job(engine.poll_new_leads, "interval", minutes=5, id="poll_new_leads", replace_existing=True)
        # Process existing speed-to-lead timers every 5 minutes
        scheduler.add_job(engine.process_new_lead_timers, "interval", minutes=5, id="new_lead_timers", replace_existing=True)
        # Reply detection: scan for incoming replies every 10 minutes
        scheduler.add_job(engine.scan_reply_detection, "interval", minutes=10, id="reply_detection", replace_existing=True)
        scheduler.start()

    @app.get("/health")
    def health() -> dict:
        return {"ok": True, "dry_run": settings.dry_run, "time": now_iso()}

    @app.post("/webhooks/fub")
    async def fub_webhook(
        payload: WebhookPayload,
        request: Request,
        background_tasks: BackgroundTasks,
        fub_signature: Optional[str] = Header(default=None, alias="FUB-Signature"),
    ) -> dict:
        raw = await request.body()
        if settings.fub_system_key and fub_signature and not verify_fub_signature(raw, settings.fub_system_key, fub_signature):
            raise HTTPException(status_code=401, detail="Invalid FUB signature")
        db.log("webhook", "received", None, payload.model_dump())
        if payload.event == "peopleCreated":
            for person_id in payload.resourceIds:
                person = fub.get_person(int(person_id))
                db.add_new_lead_timer(int(person_id), person.get("assignedUserId") if person else None)
                db.log("new_lead_timer", "started", int(person_id))
                
                # Queue immediate welcome email background task
                background_tasks.add_task(engine.send_instant_welcome_email, int(person_id))
        elif payload.event in {"callsCreated", "emailsCreated", "textMessagesCreated", "notesCreated", "tasksCreated", "peopleUpdated"}:
            for person_id in payload.resourceIds:
                # For notesCreated: skip canceling if the note was written by the automation
                # (subject starts with "Automation:"). This prevents the system's own warning
                # notes from accidentally canceling the 60-min reassignment timer.
                if payload.event == "notesCreated":
                    try:
                        recent_notes = fub.get_notes(int(person_id), limit=3)
                        latest_note = recent_notes[0] if recent_notes else None
                        if latest_note:
                            subj = str(latest_note.get("subject") or latest_note.get("title") or "")
                            if subj.startswith("Automation:"):
                                db.log("new_lead_timer", "skip_cancel_automation_note", int(person_id),
                                       {"note_subject": subj})
                                LOGGER.info("Webhook: skipping timer cancel for person %s — automation note: %s",
                                            person_id, subj)
                                continue
                    except Exception as note_exc:
                        LOGGER.warning("Webhook: could not fetch notes for person %s to check subject: %s",
                                       person_id, note_exc)
                db.cancel_timer(int(person_id))
        return {"ok": True}

    @app.post("/jobs/daily-scans")
    def trigger_daily_scans(background_tasks: BackgroundTasks) -> dict:
        background_tasks.add_task(engine.run_daily_scans)
        return {"queued": True}

    @app.post("/jobs/new-lead-timers")
    def trigger_new_lead_timers(background_tasks: BackgroundTasks) -> dict:
        background_tasks.add_task(engine.process_new_lead_timers)
        return {"queued": True}

    return app


def now_iso() -> str:
    return dt.datetime.now(UTC).isoformat()


def parse_dt(value: str) -> Optional[dt.datetime]:
    return parse_fub_datetime(value)


def is_inbound_message(message: dict) -> bool:
    """Did this FUB message come FROM the lead?

    THE field that matters — measured, not documented, twice over. The
    2026-08-24 diagnostics dumped this account's real email objects: they
    carry NO isIncoming, direction or type at all, and `status` is stamped
    'Received' on EVERYTHING the mailbox sync ingests — the bot's own
    outbound sends included (run 32777950427: Stephen's genuine reply id
    52004 and our own send to him id 51937 both read status='Received'; only
    relatedPeople[].sentByPerson differs, True on his, False on ours). A
    status-based predicate classified every synced send as a reply and filled
    a whole dry-run plan with the bot answering itself.

        relatedPeople = [{'sentByPerson': True}]   ← sent BY the lead

    is therefore the ONE inbound signal for this account. The docs'
    `isIncoming` and the older legacy spellings stay accepted below — we POST
    isIncoming ourselves in log_text_message, other FUB accounts may return
    it, and none of them can match a synced send.

    History of getting this wrong, kept as a warning: `isReceived` (never
    sent by FUB) → six blind weeks; `isIncoming` (documented, never sent by
    THIS account) → would have been blind forever; `status='Received'`
    (sent on everything) → would have alerted on our own mail. Only field
    dumps of BOTH directions settled it.
    """
    for related in message.get("relatedPeople") or []:
        if isinstance(related, dict) and related.get("sentByPerson"):
            return True
    if message.get("isIncoming") or message.get("isReceived"):
        return True
    # Spelled "incoming" at some call sites and "inbound" at others; accept
    # both rather than guess.
    if str(message.get("direction") or "").lower() in ("incoming", "inbound"):
        return True
    return str(message.get("type") or "").lower() == "received"


# Sync latency between our audit row and FUB's copy of the same send. The
# same ±300s _collect_needs_reply already uses to prove "this outbound was
# the bot" — one constant so the two proofs can never drift apart.
BOT_SEND_MATCH_SECONDS = 300


def reply_thread_verified(
    message: dict,
    messages: List[dict],
    bot_sends: List[dt.datetime],
    tolerance_seconds: int = BOT_SEND_MATCH_SECONDS,
) -> bool:
    """Does this inbound email sit on a thread WE started with this lead?

    sentByPerson alone cannot be trusted: the 2026-08-28 false positive
    (Angie Gonzalez, person 6340, run 33218198212) was a LENDER's email on
    the lead's record — 'Re: Lender Intro Irene and Angie', a thread between
    third parties that FUB attached to the lead and stamped
    relatedPeople=[{personId: 6340, sentByPerson: True}], indistinguishable
    field-for-field from a genuine reply. addresses{} is empty and
    subject/body are '[content hidden]' on this account, so counterpart
    addresses and subject lineage are unreadable through the API.

    What IS readable, measured on both directions: threadId (never hidden)
    and created timestamps (never hidden). A genuine reply shares its
    threadId with the synced copy of our own send (Stephen Herrera's reply
    52004 and our send 51937, both thread 48666), and our synced sends land
    within seconds of their audit rows. So: an inbound email is a verified
    lead reply only when its thread also holds a non-inbound email whose
    timestamp matches an audit-logged bot send within `tolerance_seconds`.

    Messages with no threadId are exempt (returns True): text messages, and
    any account whose emails carry real direction flags but no threads —
    for those the gate would only remove signal it cannot replace.

    The cost, stated plainly: a genuine reply that starts a BRAND-NEW
    thread (or whose anchor send never synced back to FUB) fails this and
    is surfaced as "unverified inbound — review" instead of HOT LEAD. That
    is the chosen direction to be wrong in: it still reaches a human, it
    just cannot page one or pause automation on a stranger's email.
    """
    thread = message.get("threadId")
    if thread is None:
        return True
    for other in messages:
        if other is message:
            continue
        if str(other.get("threadId")) != str(thread):
            continue
        if is_inbound_message(other):
            continue
        sent = message_timestamp(other)
        if not sent:
            continue
        if any(abs((sent - bot_ts).total_seconds()) <= tolerance_seconds
               for bot_ts in bot_sends):
            return True
    return False


# What FUB returns in place of subject/body when the account's email-content
# sharing setting hides them from the API user. A literal string, so keyword
# and marker scans can never match on it — classification then rests on
# timing and the `unsubscribed` flag alone, and snippets must say so instead
# of printing the placeholder as if it were the lead's words.
FUB_HIDDEN_CONTENT = "[content hidden]"


def message_content_hidden(message: dict) -> bool:
    return any(
        str(message.get(key) or "").strip().lower() == FUB_HIDDEN_CONTENT
        for key in ("subject", "body", "bodyExcerpt")
    )


def reply_display_snippet(message: dict) -> str:
    """What to show a human as 'the reply': the text when FUB shares it, an
    honest pointer when the account's privacy setting hides it."""
    if message_content_hidden(message):
        return "(email content hidden by FUB settings — open the thread in FUB)"
    return reply_message_body(message) or "(no body)"


# A reply that lands this close to the send is a machine answering, not a
# person: the real cases this was built from (2026-08-23) arrived 2–3 seconds
# after the pond email. A human COULD reply inside 90 seconds; the cost of
# reading them as auto is no alert and no pause — they surface in the daily
# summary's auto-reply line rather than vanish — which is the recoverable
# direction to be wrong in.
AUTO_REPLY_WINDOW_SECONDS = 90

# Subject/body phrases that mark machine-generated mail. Deliberately narrow:
# a marker here silences the hot-lead alert for that message, so each phrase
# needs to be something a person answering a question would never type.
AUTO_REPLY_MARKERS = (
    "automatic reply",
    "auto-reply",
    "autoreply",
    "auto reply",
    "automated response",
    "auto-response",
    "autoresponder",
    "this is an automated",
    "out of office",
    "out of the office",
    "away from the office",
    "away from my email",
    "on vacation until",
    "vacation response",
    "do not reply to this email",
    "delivery status notification",
    "mail delivery failed",
    "undeliverable",
)


def reply_message_body(message: dict) -> str:
    """The text of a FUB email or text message, whichever field it arrived in."""
    return str(message.get("body") or message.get("message") or message.get("text") or "")


def classify_reply(
    message: dict,
    send_dt: dt.datetime,
    reply_dt: dt.datetime,
    opt_out_keywords: Iterable[str],
) -> str:
    """'opt_out' | 'auto_reply' | 'human' for one inbound message.

    Opt-out is checked FIRST, before the auto-reply heuristics: an unsubscribe
    must be honoured however fast it arrived (a compliance obligation, and the
    safe direction to over-trigger in), so the timing heuristic below must not
    be able to shadow it.

    KNOWN LIMIT while the account hides email content from the API
    (message_content_hidden): subject and body are the literal placeholder,
    so the keyword and marker scans cannot fire — an "UNSUBSCRIBE" typed in
    the body classifies as human and reaches Peter as a NEEDS-A-REPLY entry
    rather than being auto-trashed. FUB's own `unsubscribed` flag (their
    unsubscribe link) is honoured below regardless. Restoring body access is
    an FUB admin setting, not a code change.
    """
    # FUB's own unsubscribe-link flag on the email object — content sharing
    # cannot hide it.
    if message.get("unsubscribed"):
        return "opt_out"

    subject = str(message.get("subject") or "").lower().strip()
    body = reply_message_body(message).lower().strip()
    combined = f"{subject} {body}"

    for keyword in opt_out_keywords:
        if keyword in combined:
            return "opt_out"
    # Standalone STOP is the SMS-standard opt-out; only when it is the whole
    # message, same as the pre-send check (_check_incoming_opt_out).
    if message.get("subject") is None and body.rstrip("!. ") == "stop":
        return "opt_out"

    if (reply_dt - send_dt).total_seconds() <= AUTO_REPLY_WINDOW_SECONDS:
        return "auto_reply"
    if any(marker in combined for marker in AUTO_REPLY_MARKERS):
        return "auto_reply"
    return "human"


def format_hours_waiting(hours: float) -> str:
    """'41h' under two days, '3d 7h' from there — for the NEEDS A REPLY list."""
    if hours < 48:
        return f"{hours:.0f}h"
    return f"{int(hours // 24)}d {int(hours % 24)}h"


def message_timestamp(message: dict) -> Optional[dt.datetime]:
    """When a FUB email or text happened, whichever field carries it."""
    return parse_fub_datetime(
        message.get("dateCreated") or message.get("created") or message.get("date"))


def inbound_messages_since(
    messages: List[dict], since: dt.datetime
) -> List[Tuple[dt.datetime, dict]]:
    """Every inbound message strictly after `since`, oldest first."""
    out: List[Tuple[dt.datetime, dict]] = []
    for msg in messages:
        if not is_inbound_message(msg):
            continue
        when = message_timestamp(msg)
        if when and when > since:
            out.append((when, msg))
    out.sort(key=lambda item: item[0])
    return out


def latest_outbound_before(messages: List[dict], when: dt.datetime) -> Optional[dt.datetime]:
    """Our most recent send before `when` — what the auto-reply timing
    heuristic measures from. None when the history holds no outbound, in which
    case timing cannot fire and only the marker/keyword rules apply."""
    best: Optional[dt.datetime] = None
    for msg in messages:
        if is_inbound_message(msg):
            continue
        sent = message_timestamp(msg)
        if sent and sent < when and (best is None or sent > best):
            best = sent
    return best


def parse_fub_datetime(value: Any) -> Optional[dt.datetime]:
    if not value:
        return None
    if isinstance(value, dict):
        value = value.get("date") or value.get("updated") or value.get("created")
        if not value:
            return None
    try:
        normalized = str(value).replace("Z", "+00:00")
        parsed = dt.datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return parsed.astimezone(UTC)
    except Exception:  # noqa: BLE001
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
            try:
                return dt.datetime.strptime(value[:19], fmt).replace(tzinfo=UTC)
            except ValueError:
                pass
    return None


def person_name(person: dict) -> str:
    return person.get("name") or " ".join([person.get("firstName", ""), person.get("lastName", "")]).strip() or f"Lead {person.get('id')}"


def display_source(person: dict) -> str:
    """FUB reports a missing lead source as the literal string "<unspecified>",
    which an email client parses as an HTML tag and renders as nothing."""
    raw = str(person.get("source") or "").strip()
    if not raw or raw.strip("<>").strip().lower() == "unspecified":
        return "Unspecified"
    return raw


def infer_city_from_text(text: str, target_cities: List[str]) -> Optional[str]:
    haystack = (text or "").lower()
    for city in target_cities:
        if city.lower() in haystack:
            return city
    return None


def summarize_lead_context_from_notes(notes: List[dict], city: str, target_cities: List[str]) -> str:
    """Return a short, safe personalization hint from recent notes.

    The output is used only to guide copy tone and relevance. It intentionally
    removes direct contact details and avoids long verbatim note excerpts.
    """
    snippets: List[str] = []
    seen: set[str] = set()
    useful_terms = [
        city,
        *target_cities,
        "buy",
        "buyer",
        "sell",
        "seller",
        "relocat",
        "move",
        "moving",
        "lease",
        "rent",
        "new build",
        "new construction",
        "school",
        "commute",
        "investment",
        "price",
        "budget",
        "preapproved",
        "pre-approved",
    ]
    for note in notes[:10]:
        raw = str(note.get("body") or note.get("text") or note.get("note") or "")
        if not raw.strip():
            continue
        cleaned = re.sub(r"<[^>]+>", " ", raw)
        cleaned = re.sub(r"https?://\S+", "[link]", cleaned)
        cleaned = re.sub(r"\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b", "[email]", cleaned)
        cleaned = re.sub(r"\b\d{3}[-.)\s]*\d{3}[-.\s]*\d{4}\b", "[phone]", cleaned)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        if not cleaned:
            continue
        lowered = cleaned.lower()
        if not any(term and term.lower() in lowered for term in useful_terms):
            continue
        snippet = cleaned[:180]
        if snippet.lower() in seen:
            continue
        seen.add(snippet.lower())
        # Include note date for AI date-awareness
        note_date = note.get("created") or note.get("date") or note.get("createdAt") or ""
        date_prefix = f"[{note_date[:10]}] " if note_date else ""
        snippets.append(f"{date_prefix}{snippet}")
        if len(snippets) >= 3:
            break
    if not snippets:
        return ""
    return "FUB notes (with dates): " + " | ".join(snippets)


def infer_city(person: dict, target_cities: List[str]) -> str:
    haystack = json.dumps(person).lower()
    for city in target_cities:
        if city.lower() in haystack:
            return city
    addresses = person.get("addresses") or []
    for address in addresses:
        if address.get("city"):
            return address["city"]
    return target_cities[0] if target_cities else "your area"


# ── Shared branding constants for pond nurture emails ──
TREC_IABS_URL = "https://www.trec.texas.gov/sites/default/files/pdf-forms/IABS%201-2_1.pdf"
TREC_CONSUMER_PROTECTION_URL = "https://www.trec.texas.gov/sites/default/files/pdf-forms/CN%201-4-1_1.pdf"


def append_email_footer(body: str, rules: Rules) -> str:
    """Plain-text footer for pond nurture emails (team-branded, TREC compliant)."""
    return f"""{body.strip()}

--
LIFESTYLE DESIGN REALTY

The Lifestyle Design Realty Team
team@lifestyledesignrealty.com
lifestyledesignrealty.com

Information About Brokerage Services: {TREC_IABS_URL}
TREC Consumer Protection Notice: {TREC_CONSUMER_PROTECTION_URL}
{rules.company_address}

If you no longer want market updates from us, reply UNSUBSCRIBE and we will remove you from future marketing emails.
"""


def build_pond_email_html(body: str, rules: Rules) -> str:
    """HTML version of pond nurture emails with styled-text wordmark, TREC links, and team branding.

    Uses pure styled text for the wordmark (no image) so it renders correctly
    even when email clients block images. TREC compliance links are never hidden.
    """
    # Convert plain-text body paragraphs to HTML
    paragraphs = [p.strip() for p in body.strip().split("\n") if p.strip()]
    body_html = "\n".join(f'<p style="margin:0 0 12px 0;">{p}</p>' for p in paragraphs)

    return f"""<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;color:#333;line-height:1.6;">
  <div style="max-width:600px;margin:0 auto;padding:20px;">
    {body_html}
    <!-- Signature block -->
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px;">
      <!-- Divider 1 -->
      <tr><td style="border-top:1px solid #e0e0e0;font-size:0;line-height:0;height:1px;" colspan="1">&nbsp;</td></tr>
      <!-- Wordmark (styled text, no image dependency) -->
      <tr>
        <td style="padding-top:16px;padding-bottom:12px;">
          <span style="font-family:Georgia,'Times New Roman',serif;font-size:17px;letter-spacing:2px;color:#333;">LIFESTYLE DESIGN</span><!--
          --><span style="font-family:Georgia,'Times New Roman',serif;font-size:17px;letter-spacing:2px;color:#a3793f;"> REALTY</span>
        </td>
      </tr>
      <!-- Contact info -->
      <tr>
        <td style="font-size:13px;color:#555;line-height:1.5;padding-bottom:14px;">
          <strong style="color:#333;">The Lifestyle Design Realty Team</strong><br/>
          <a href="mailto:team@lifestyledesignrealty.com" style="color:#555;text-decoration:none;">team@lifestyledesignrealty.com</a><br/>
          <a href="https://lifestyledesignrealty.com" style="color:#a3793f;text-decoration:none;">lifestyledesignrealty.com</a>
        </td>
      </tr>
      <!-- Divider 2 -->
      <tr><td style="border-top:1px solid #e0e0e0;font-size:0;line-height:0;height:1px;">&nbsp;</td></tr>
      <!-- TREC compliance + address -->
      <tr>
        <td style="padding-top:10px;font-size:10.5px;color:#999;line-height:1.6;">
          <a href="{TREC_IABS_URL}" style="color:#999;text-decoration:none;">Information About Brokerage Services</a> |
          <a href="{TREC_CONSUMER_PROTECTION_URL}" style="color:#999;text-decoration:none;">TREC Consumer Protection Notice</a><br/>
          {rules.company_address}
        </td>
      </tr>
      <!-- Unsubscribe -->
      <tr>
        <td style="padding-top:10px;font-size:10.5px;color:#bbb;">
          If you no longer want market updates from us, reply UNSUBSCRIBE and we will remove you from future marketing emails.
        </td>
      </tr>
    </table>
  </div>
</body>
</html>"""


def verify_fub_signature(raw_body: bytes, system_key: str, provided_signature: str) -> bool:
    digest = hmac.new(system_key.encode("utf-8"), raw_body, hashlib.sha256).digest()
    expected = base64.b64encode(digest).decode("utf-8")
    return hmac.compare_digest(expected, provided_signature)


app = create_app()
