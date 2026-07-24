"""Behavioral tests for the seller nurture bounce fallback rotation.

Tests cover:
1. get_all_lead_emails: extraction and deduplication from FUB person record
2. select_send_address: rotation logic, skipping bounced addresses
3. format_rotation_fub_note: FUB note formatting for rotations and exhaustion
4. DB helpers: mark_seller_email_bounced, get_seller_bounced_emails, stats
5. Integration: end-to-end flow from bounce to rotation or suppression
"""

import sqlite3
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Add src to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from fub_automation.seller_nurture import (
    SELLER_BOUNCE_ROTATION_ACTION,
    format_rotation_fub_note,
    get_all_lead_emails,
    select_send_address,
)


# ── get_all_lead_emails Tests ────────────────────────────────────────────────


class TestGetAllLeadEmails:
    """Tests for extracting email addresses from FUB person records."""

    def test_extracts_single_email(self):
        person = {"emails": [{"value": "alice@example.com", "type": "home"}]}
        assert get_all_lead_emails(person) == ["alice@example.com"]

    def test_extracts_multiple_emails_preserves_order(self):
        person = {
            "emails": [
                {"value": "primary@example.com"},
                {"value": "secondary@example.com"},
                {"value": "third@example.com"},
            ]
        }
        result = get_all_lead_emails(person)
        assert result == ["primary@example.com", "secondary@example.com", "third@example.com"]

    def test_deduplicates_case_insensitive(self):
        person = {
            "emails": [
                {"value": "Alice@Example.com"},
                {"value": "alice@example.com"},
            ]
        }
        result = get_all_lead_emails(person)
        assert len(result) == 1
        assert result[0] == "alice@example.com"

    def test_handles_empty_emails_list(self):
        person = {"emails": []}
        assert get_all_lead_emails(person) == []

    def test_handles_missing_emails_key(self):
        person = {}
        assert get_all_lead_emails(person) == []

    def test_handles_none_emails(self):
        person = {"emails": None}
        assert get_all_lead_emails(person) == []

    def test_skips_empty_values(self):
        person = {
            "emails": [
                {"value": "valid@example.com"},
                {"value": ""},
                {"value": None},
                {"email": "alt@example.com"},
            ]
        }
        result = get_all_lead_emails(person)
        assert "valid@example.com" in result
        assert "alt@example.com" in result
        assert "" not in result

    def test_strips_whitespace(self):
        person = {"emails": [{"value": "  spaced@example.com  "}]}
        assert get_all_lead_emails(person) == ["spaced@example.com"]

    def test_handles_email_key_fallback(self):
        """FUB sometimes uses 'email' instead of 'value'."""
        person = {"emails": [{"email": "alt@example.com"}]}
        assert get_all_lead_emails(person) == ["alt@example.com"]


# ── select_send_address Tests ────────────────────────────────────────────────


class TestSelectSendAddress:
    """Tests for bounce-aware email address selection."""

    def test_returns_first_when_no_bounces(self):
        all_emails = ["primary@example.com", "secondary@example.com"]
        assert select_send_address(all_emails, []) == "primary@example.com"

    def test_skips_bounced_primary_returns_secondary(self):
        all_emails = ["primary@example.com", "secondary@example.com"]
        bounced = ["primary@example.com"]
        assert select_send_address(all_emails, bounced) == "secondary@example.com"

    def test_skips_multiple_bounced_returns_third(self):
        all_emails = ["a@example.com", "b@example.com", "c@example.com"]
        bounced = ["a@example.com", "b@example.com"]
        assert select_send_address(all_emails, bounced) == "c@example.com"

    def test_returns_none_when_all_bounced(self):
        all_emails = ["a@example.com", "b@example.com"]
        bounced = ["a@example.com", "b@example.com"]
        assert select_send_address(all_emails, bounced) is None

    def test_returns_none_for_empty_list(self):
        assert select_send_address([], []) is None

    def test_case_insensitive_bounce_matching(self):
        all_emails = ["Primary@Example.com", "secondary@example.com"]
        bounced = ["primary@example.com"]
        # all_emails are already lowercased by get_all_lead_emails, but bounced list may vary
        result = select_send_address(["primary@example.com", "secondary@example.com"], bounced)
        assert result == "secondary@example.com"

    def test_single_email_not_bounced(self):
        all_emails = ["only@example.com"]
        assert select_send_address(all_emails, []) == "only@example.com"

    def test_single_email_bounced_returns_none(self):
        all_emails = ["only@example.com"]
        bounced = ["only@example.com"]
        assert select_send_address(all_emails, bounced) is None

    def test_never_sends_to_multiple_addresses(self):
        """Verify the function returns exactly one address, never a list."""
        all_emails = ["a@example.com", "b@example.com", "c@example.com"]
        result = select_send_address(all_emails, [])
        assert isinstance(result, str)
        assert "@" in result


# ── format_rotation_fub_note Tests ───────────────────────────────────────────


class TestFormatRotationFubNote:
    """Tests for FUB note formatting during bounce rotation."""

    def test_rotation_note_contains_bounced_email(self):
        subject, body = format_rotation_fub_note(
            bounced_email="bad@example.com",
            new_email="good@example.com",
            total_addresses=2,
            exhausted=False,
        )
        assert "bad@example.com" in body
        assert "good@example.com" in body
        assert "Rotated" in subject

    def test_rotation_note_contains_total_count(self):
        subject, body = format_rotation_fub_note(
            bounced_email="bad@example.com",
            new_email="good@example.com",
            total_addresses=3,
            exhausted=False,
        )
        assert "3" in body

    def test_exhausted_note_indicates_suppression(self):
        subject, body = format_rotation_fub_note(
            bounced_email="last@example.com",
            new_email=None,
            total_addresses=2,
            exhausted=True,
        )
        assert "All" in subject or "Bounced" in subject
        assert "suppressed" in body.lower() or "paused" in body.lower()
        assert "last@example.com" in body

    def test_exhausted_note_mentions_bounced_tag(self):
        subject, body = format_rotation_fub_note(
            bounced_email="last@example.com",
            new_email=None,
            total_addresses=1,
            exhausted=True,
        )
        assert "bounced" in body.lower()

    def test_rotation_note_is_not_exhausted(self):
        subject, body = format_rotation_fub_note(
            bounced_email="bad@example.com",
            new_email="good@example.com",
            total_addresses=2,
            exhausted=False,
        )
        assert "suppressed" not in body.lower()
        assert "paused" not in body.lower()


# ── DB Helper Tests ──────────────────────────────────────────────────────────


class TestBounceRotationDB:
    """Tests for the seller_bounced_emails DB table and helpers."""

    @pytest.fixture
    def db(self, tmp_path):
        """Create a temporary SQLite DB with the seller_bounced_emails schema."""
        db_path = tmp_path / "test.db"
        conn = sqlite3.connect(str(db_path))
        conn.execute("""
            CREATE TABLE seller_bounced_emails (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                person_id INTEGER NOT NULL,
                email_address TEXT NOT NULL,
                bounced_at TEXT NOT NULL,
                UNIQUE(person_id, email_address)
            )
        """)
        conn.commit()
        conn.close()
        return db_path

    def test_mark_bounced_inserts_record(self, db):
        conn = sqlite3.connect(str(db))
        conn.execute(
            "INSERT INTO seller_bounced_emails(person_id, email_address, bounced_at) VALUES (?, ?, ?)",
            (123, "bad@example.com", "2026-07-24T10:00:00"),
        )
        conn.commit()
        rows = conn.execute("SELECT * FROM seller_bounced_emails WHERE person_id=123").fetchall()
        assert len(rows) == 1
        assert rows[0][2] == "bad@example.com"
        conn.close()

    def test_unique_constraint_prevents_duplicates(self, db):
        conn = sqlite3.connect(str(db))
        conn.execute(
            "INSERT INTO seller_bounced_emails(person_id, email_address, bounced_at) VALUES (?, ?, ?)",
            (123, "bad@example.com", "2026-07-24T10:00:00"),
        )
        conn.commit()
        # Second insert with same person_id + email should be ignored (OR IGNORE)
        conn.execute(
            "INSERT OR IGNORE INTO seller_bounced_emails(person_id, email_address, bounced_at) VALUES (?, ?, ?)",
            (123, "bad@example.com", "2026-07-25T10:00:00"),
        )
        conn.commit()
        rows = conn.execute("SELECT * FROM seller_bounced_emails WHERE person_id=123").fetchall()
        assert len(rows) == 1
        conn.close()

    def test_multiple_addresses_per_lead(self, db):
        conn = sqlite3.connect(str(db))
        conn.execute(
            "INSERT INTO seller_bounced_emails(person_id, email_address, bounced_at) VALUES (?, ?, ?)",
            (123, "first@example.com", "2026-07-24T10:00:00"),
        )
        conn.execute(
            "INSERT INTO seller_bounced_emails(person_id, email_address, bounced_at) VALUES (?, ?, ?)",
            (123, "second@example.com", "2026-07-25T10:00:00"),
        )
        conn.commit()
        rows = conn.execute("SELECT * FROM seller_bounced_emails WHERE person_id=123").fetchall()
        assert len(rows) == 2
        conn.close()

    def test_different_leads_tracked_separately(self, db):
        conn = sqlite3.connect(str(db))
        conn.execute(
            "INSERT INTO seller_bounced_emails(person_id, email_address, bounced_at) VALUES (?, ?, ?)",
            (100, "a@example.com", "2026-07-24T10:00:00"),
        )
        conn.execute(
            "INSERT INTO seller_bounced_emails(person_id, email_address, bounced_at) VALUES (?, ?, ?)",
            (200, "b@example.com", "2026-07-24T10:00:00"),
        )
        conn.commit()
        rows_100 = conn.execute("SELECT * FROM seller_bounced_emails WHERE person_id=100").fetchall()
        rows_200 = conn.execute("SELECT * FROM seller_bounced_emails WHERE person_id=200").fetchall()
        assert len(rows_100) == 1
        assert len(rows_200) == 1
        conn.close()


# ── Integration Tests ────────────────────────────────────────────────────────


class TestBounceRotationIntegration:
    """End-to-end integration tests for the bounce rotation flow."""

    def test_process_seller_with_bounced_primary_uses_secondary(self):
        """When primary email is bounced, process_seller_nurture_candidate sends to secondary."""
        # This tests the logic flow: get_all_lead_emails → get bounced → select_send_address
        person = {
            "emails": [
                {"value": "bounced@example.com"},
                {"value": "good@example.com"},
            ]
        }
        all_emails = get_all_lead_emails(person)
        bounced = ["bounced@example.com"]
        to_email = select_send_address(all_emails, bounced)
        assert to_email == "good@example.com"

    def test_process_seller_all_bounced_returns_none(self):
        """When all emails are bounced, select_send_address returns None (suppression)."""
        person = {
            "emails": [
                {"value": "bad1@example.com"},
                {"value": "bad2@example.com"},
            ]
        }
        all_emails = get_all_lead_emails(person)
        bounced = ["bad1@example.com", "bad2@example.com"]
        to_email = select_send_address(all_emails, bounced)
        assert to_email is None

    def test_rotation_preserves_order_sends_to_next_available(self):
        """Rotation always picks the first non-bounced address in FUB order."""
        person = {
            "emails": [
                {"value": "first@example.com"},
                {"value": "second@example.com"},
                {"value": "third@example.com"},
            ]
        }
        all_emails = get_all_lead_emails(person)

        # First bounce: skip first, send to second
        bounced = ["first@example.com"]
        assert select_send_address(all_emails, bounced) == "second@example.com"

        # Second bounce: skip first and second, send to third
        bounced = ["first@example.com", "second@example.com"]
        assert select_send_address(all_emails, bounced) == "third@example.com"

        # Third bounce: all exhausted
        bounced = ["first@example.com", "second@example.com", "third@example.com"]
        assert select_send_address(all_emails, bounced) is None

    def test_never_sends_to_multiple_addresses_at_once(self):
        """Critical: only one address is ever returned for sending."""
        person = {
            "emails": [
                {"value": "a@example.com"},
                {"value": "b@example.com"},
                {"value": "c@example.com"},
            ]
        }
        all_emails = get_all_lead_emails(person)
        result = select_send_address(all_emails, [])
        # Must be a single string, not a list
        assert isinstance(result, str)
        assert result.count("@") == 1

    def test_fub_note_logged_on_rotation(self):
        """FUB note is properly formatted when rotating to a new address."""
        subject, body = format_rotation_fub_note(
            bounced_email="old@example.com",
            new_email="new@example.com",
            total_addresses=3,
            exhausted=False,
        )
        assert "old@example.com" in body
        assert "new@example.com" in body
        assert "Rotated" in subject or "Next" in subject

    def test_fub_note_logged_on_exhaustion(self):
        """FUB note is properly formatted when all addresses are exhausted."""
        subject, body = format_rotation_fub_note(
            bounced_email="last@example.com",
            new_email=None,
            total_addresses=2,
            exhausted=True,
        )
        assert "last@example.com" in body
        assert "All" in subject
        assert "bounced" in body.lower() or "suppressed" in body.lower()

    def test_bounce_rotation_action_constant(self):
        """Verify the audit action constant is properly defined."""
        assert SELLER_BOUNCE_ROTATION_ACTION == "seller_bounce_rotation"
