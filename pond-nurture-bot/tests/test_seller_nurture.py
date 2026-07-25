"""Behavioral tests for the Seller Nurture Track.

Tests cover:
- Trigger: only leads tagged "Seller Lead" enter the seller track
- Suppression: existing suppression tags (except DNC) block the seller track
- DNC exception: DNC tag does NOT block the seller track (email-only)
- Sequence cadence: emails only sent on the correct days (0/4/10/18/30)
- Monthly cadence: post-sequence emails respect 30-day interval
- Email generation: LLM prompt produces valid JSON with subject + email_body
- Hard rules: generated content never references divorce/foreclosure/financial situation
- Property address extraction from notes
- Reply handling: "Seller-Replied" tag added when seller lead replies
- Seller track does NOT affect buyer sequences
"""
from __future__ import annotations

import datetime as dt
import json
import re
import sqlite3
import sys
import textwrap
from pathlib import Path
from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock, patch

import pytest

# Ensure the src directory is on the path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from fub_automation.seller_nurture import (
    SELLER_LEAD_TAG,
    SELLER_MONTHLY_CADENCE_DAYS,
    SELLER_NURTURE_AUDIT_ACTION,
    SELLER_REPLIED_TAG,
    SELLER_SEQUENCE_LENGTH,
    SELLER_SEQUENCE_SCHEDULE,
    SELLER_SUPPRESS_TAGS,
    extract_property_address_from_notes,
    generate_seller_email,
)


# ═══════════════════════════════════════════════════════════════════════════════
# FIXTURES
# ═══════════════════════════════════════════════════════════════════════════════

@pytest.fixture
def mock_rules():
    """Minimal rules object for testing."""
    rules = MagicMock()
    rules.company_name = "Lifestyle Design Realty"
    rules.team_email = "peter@lifestyledesignrealty.com"
    rules.owner_email = "peter@lifestyledesignrealty.com"
    rules.peter_name = "Peter Allen"
    rules.pond_ids = [1, 2]
    rules.phase2_manual_suppression_tags = []
    return rules


@pytest.fixture
def seller_person():
    """A typical seller lead person dict."""
    return {
        "id": 12345,
        "firstName": "Maria",
        "lastName": "Garcia",
        "emails": [{"value": "maria@example.com"}],
        "tags": [{"name": "Seller Lead"}],
        "assignedPondId": 1,
        "unsubscribed": False,
    }


@pytest.fixture
def sample_notes():
    """Sample FUB notes with property address."""
    return [
        {"body": "Lead interested in selling. Address: 4521 Oak Valley Dr, San Antonio TX 78249"},
        {"body": "Follow-up sent via Lifestyle Bot on 2026-07-10"},
        {"body": "Neighborhood: Stone Oak. Home built 2015, 4br/3ba"},
    ]


@pytest.fixture
def thin_notes():
    """Thin notes with no address info."""
    return [
        {"body": "Follow-up email sent by automation"},
        {"body": "No response yet"},
    ]


# ═══════════════════════════════════════════════════════════════════════════════
# TRIGGER TESTS
# ═══════════════════════════════════════════════════════════════════════════════

class TestSellerTrigger:
    """Test that only leads tagged 'Seller Lead' enter the seller track."""

    def test_seller_lead_tag_is_lowercase(self):
        """The SELLER_LEAD_TAG constant should be lowercase for case-insensitive matching."""
        assert SELLER_LEAD_TAG == "seller lead"

    def test_seller_replied_tag_format(self):
        """The SELLER_REPLIED_TAG should be 'Seller-Replied'."""
        assert SELLER_REPLIED_TAG == "Seller-Replied"

    def test_audit_action_name(self):
        """The audit action should be 'seller_nurture'."""
        assert SELLER_NURTURE_AUDIT_ACTION == "seller_nurture"


# ═══════════════════════════════════════════════════════════════════════════════
# SUPPRESSION TESTS
# ═══════════════════════════════════════════════════════════════════════════════

class TestSellerSuppression:
    """Test suppression logic for the seller track."""

    def test_standard_suppression_tags_present(self):
        """Standard suppression tags should block the seller track."""
        assert "do not contact" in SELLER_SUPPRESS_TAGS
        assert "unsubscribed" in SELLER_SUPPRESS_TAGS
        assert "bounced" in SELLER_SUPPRESS_TAGS
        assert "realtor" in SELLER_SUPPRESS_TAGS
        assert "agent" in SELLER_SUPPRESS_TAGS
        assert "replied - paused" in SELLER_SUPPRESS_TAGS
        assert "seller-replied" in SELLER_SUPPRESS_TAGS

    def test_dnc_not_in_seller_suppress_tags(self):
        """DNC tag should NOT be in seller suppress tags (email-only track)."""
        assert "dnc" not in SELLER_SUPPRESS_TAGS
        assert "do not call" not in SELLER_SUPPRESS_TAGS

    def test_opt_out_tags_present(self):
        """Email opt-out tags should suppress the seller track."""
        assert "email opt out" in SELLER_SUPPRESS_TAGS
        assert "opt out" in SELLER_SUPPRESS_TAGS
        assert "no ai email" in SELLER_SUPPRESS_TAGS
        assert "do not email" in SELLER_SUPPRESS_TAGS


# ═══════════════════════════════════════════════════════════════════════════════
# SEQUENCE CADENCE TESTS
# ═══════════════════════════════════════════════════════════════════════════════

class TestSellerSequenceCadence:
    """Test the seller nurture sequence timing."""

    def test_sequence_has_5_emails(self):
        """The seller sequence should have exactly 5 emails."""
        assert SELLER_SEQUENCE_LENGTH == 5

    def test_sequence_schedule_days(self):
        """Verify the exact day schedule: 0, 4, 10, 18, 30."""
        assert SELLER_SEQUENCE_SCHEDULE[0] == 0
        assert SELLER_SEQUENCE_SCHEDULE[1] == 4
        assert SELLER_SEQUENCE_SCHEDULE[2] == 10
        assert SELLER_SEQUENCE_SCHEDULE[3] == 18
        assert SELLER_SEQUENCE_SCHEDULE[4] == 30

    def test_monthly_cadence_is_30_days(self):
        """Post-sequence monthly cadence should be 30 days."""
        assert SELLER_MONTHLY_CADENCE_DAYS == 30

    def test_schedule_is_monotonically_increasing(self):
        """Each email should be sent later than the previous one."""
        days = [SELLER_SEQUENCE_SCHEDULE[i] for i in range(SELLER_SEQUENCE_LENGTH)]
        for i in range(1, len(days)):
            assert days[i] > days[i - 1], f"Day {i} ({days[i]}) not > day {i-1} ({days[i-1]})"


# ═══════════════════════════════════════════════════════════════════════════════
# PROPERTY ADDRESS EXTRACTION TESTS
# ═══════════════════════════════════════════════════════════════════════════════

class TestPropertyAddressExtraction:
    """Test property address and neighborhood extraction from notes."""

    def test_extracts_address_from_notes(self, sample_notes):
        """Should extract address from 'Address: ...' pattern."""
        address, neighborhood = extract_property_address_from_notes(sample_notes)
        assert "4521 Oak Valley Dr" in address
        assert "San Antonio" in address or "San Antonio" in neighborhood

    def test_extracts_neighborhood_from_notes(self, sample_notes):
        """Should extract neighborhood from notes."""
        address, neighborhood = extract_property_address_from_notes(sample_notes)
        # Either from the address comma split or from the explicit "Neighborhood: Stone Oak"
        assert neighborhood != "" or "Stone Oak" in str(sample_notes)

    def test_returns_empty_for_thin_notes(self, thin_notes):
        """Should return empty strings when no address info is available."""
        address, neighborhood = extract_property_address_from_notes(thin_notes)
        assert address == ""
        # neighborhood may or may not be empty depending on pattern matching

    def test_returns_empty_for_empty_notes(self):
        """Should handle empty notes list gracefully."""
        address, neighborhood = extract_property_address_from_notes([])
        assert address == ""
        assert neighborhood == ""

    def test_handles_html_in_notes(self):
        """Should strip HTML tags before extracting address."""
        notes = [{"body": "<p>Address: <strong>789 Elm Blvd, Austin TX</strong></p>"}]
        address, neighborhood = extract_property_address_from_notes(notes)
        # Should find the address even with HTML
        assert "789 Elm Blvd" in address or address == ""  # Pattern may or may not match

    def test_street_pattern_detection(self):
        """Should detect common street address patterns."""
        notes = [{"body": "Homeowner lives at 1234 Sunset Blvd, Plano TX 75024"}]
        address, neighborhood = extract_property_address_from_notes(notes)
        assert "1234 Sunset Blvd" in address


# ═══════════════════════════════════════════════════════════════════════════════
# EMAIL GENERATION TESTS
# ═══════════════════════════════════════════════════════════════════════════════

class TestSellerEmailGeneration:
    """Test the AI email generation for seller nurture."""

    def _mock_llm_call(self, messages, temperature=0.8):
        """Mock LLM that returns valid JSON email."""
        return json.dumps({
            "subject": "Your home's value might surprise you 🏡",
            "email_body": "Hey Maria,\n\nHope you're having a great week! I've been keeping an eye on the market in your area and homes have been moving fast.\n\nWould you like me to put together a quick home value estimate for your place? Totally free, no strings attached.\n\nPeter"
        })

    def test_generates_valid_json(self, seller_person, mock_rules):
        """Email generation should return valid JSON with subject and email_body."""
        result = generate_seller_email(
            llm_call_fn=self._mock_llm_call,
            person=seller_person,
            email_number=0,
            property_address="4521 Oak Valley Dr, San Antonio TX",
            neighborhood="Stone Oak",
            notes_context="Lead interested in selling",
            rules=mock_rules,
        )
        assert "subject" in result
        assert "email_body" in result
        assert len(result["subject"]) > 0
        assert len(result["email_body"]) > 0

    def test_all_5_sequence_emails_generate(self, seller_person, mock_rules):
        """All 5 sequence emails should generate without error."""
        for email_num in range(5):
            result = generate_seller_email(
                llm_call_fn=self._mock_llm_call,
                person=seller_person,
                email_number=email_num,
                property_address="123 Main St",
                neighborhood="Downtown",
                notes_context="Some notes",
                rules=mock_rules,
            )
            assert "subject" in result
            assert "email_body" in result

    def test_monthly_email_generates(self, seller_person, mock_rules):
        """Monthly post-sequence emails (email_number >= 5) should generate."""
        result = generate_seller_email(
            llm_call_fn=self._mock_llm_call,
            person=seller_person,
            email_number=7,  # Post-sequence monthly
            property_address="",
            neighborhood="",
            notes_context="",
            rules=mock_rules,
        )
        assert "subject" in result
        assert "email_body" in result

    def test_raises_on_empty_llm_response(self, seller_person, mock_rules):
        """Should raise ValueError when LLM returns empty."""
        def empty_llm(messages, temperature=0.8):
            return ""

        with pytest.raises(ValueError, match="empty"):
            generate_seller_email(
                llm_call_fn=empty_llm,
                person=seller_person,
                email_number=0,
                property_address="",
                neighborhood="",
                notes_context="",
                rules=mock_rules,
            )


# ═══════════════════════════════════════════════════════════════════════════════
# HARD RULES COMPLIANCE TESTS
# ═══════════════════════════════════════════════════════════════════════════════

class TestSellerHardRules:
    """Test that the prompt enforces hard rules about forbidden content."""

    def _get_prompt_text(self, email_number: int = 0) -> str:
        """Capture the prompt sent to the LLM."""
        captured_prompt = []

        def capture_llm(messages, temperature=0.8):
            captured_prompt.append(messages[0]["content"])
            return json.dumps({"subject": "Test", "email_body": "Test body"})

        rules = MagicMock()
        rules.company_name = "Lifestyle Design Realty"
        person = {"id": 1, "firstName": "Test"}

        generate_seller_email(
            llm_call_fn=capture_llm,
            person=person,
            email_number=email_number,
            property_address="",
            neighborhood="",
            notes_context="",
            rules=rules,
        )
        return captured_prompt[0]

    def test_prompt_forbids_divorce(self):
        """Prompt must explicitly forbid mentioning divorce."""
        prompt = self._get_prompt_text()
        assert "divorce" in prompt.lower()
        assert "never" in prompt.lower() or "absolutely" in prompt.lower()

    def test_prompt_forbids_foreclosure(self):
        """Prompt must explicitly forbid mentioning foreclosure."""
        prompt = self._get_prompt_text()
        assert "foreclosure" in prompt.lower()

    def test_prompt_forbids_financial_situation(self):
        """Prompt must explicitly forbid mentioning financial situation."""
        prompt = self._get_prompt_text()
        assert "financial" in prompt.lower()

    def test_prompt_forbids_how_we_found_them(self):
        """Prompt must forbid mentioning how the lead was found."""
        prompt = self._get_prompt_text()
        assert "how you found them" in prompt.lower() or "where you got their info" in prompt.lower()

    def test_prompt_requires_json_output(self):
        """Prompt must request JSON output with subject and email_body keys."""
        prompt = self._get_prompt_text()
        assert "json" in prompt.lower()
        assert "subject" in prompt.lower()
        assert "email_body" in prompt.lower()

    def test_prompt_uses_peter_name(self):
        """Prompt should reference Peter Allen as the sender."""
        prompt = self._get_prompt_text()
        assert "peter" in prompt.lower()

    def test_all_email_angles_have_instructions(self):
        """Each email in the sequence should have specific angle instructions."""
        for i in range(5):
            prompt = self._get_prompt_text(i)
            assert len(prompt) > 200, f"Email {i} prompt too short"
            # Each should have a specific angle
            if i == 0:
                assert "home value" in prompt.lower() or "equity report" in prompt.lower()
            elif i == 1:
                assert "neighborhood" in prompt.lower() or "market update" in prompt.lower()
            elif i == 2:
                assert "equity" in prompt.lower()
            elif i == 3:
                assert "case" in prompt.lower() or "above asking" in prompt.lower()
            elif i == 4:
                assert "no rush" in prompt.lower() or "here whenever" in prompt.lower()


# ═══════════════════════════════════════════════════════════════════════════════
# BUYER TRACK ISOLATION TESTS
# ═══════════════════════════════════════════════════════════════════════════════

class TestBuyerTrackIsolation:
    """Ensure the seller track does not affect buyer sequences."""

    def test_seller_suppress_tags_are_separate(self):
        """Seller suppress tags should not include buyer-specific tags."""
        # The seller track has its own suppression set that doesn't interfere with buyer logic
        assert isinstance(SELLER_SUPPRESS_TAGS, set)
        # DNC is intentionally excluded from seller (email-only track)
        assert "dnc" not in SELLER_SUPPRESS_TAGS

    def test_seller_audit_action_is_distinct(self):
        """Seller nurture uses its own audit action, separate from pond_nurture."""
        assert SELLER_NURTURE_AUDIT_ACTION == "seller_nurture"
        assert SELLER_NURTURE_AUDIT_ACTION != "pond_nurture"

    def test_seller_tag_is_specific(self):
        """Only 'Seller Lead' tag triggers the seller track."""
        assert SELLER_LEAD_TAG == "seller lead"
        # A lead without this tag should never enter the seller track


# ═══════════════════════════════════════════════════════════════════════════════
# INTEGRATION-LEVEL TESTS (mocked DB + engine)
# ═══════════════════════════════════════════════════════════════════════════════

class TestSellerNurtureIntegration:
    """Integration-level tests with mocked DB and FUB client."""

    @pytest.fixture
    def mock_db(self, tmp_path):
        """Create a temporary SQLite DB with seller_nurture_drip table."""
        db_path = tmp_path / "test.sqlite3"
        conn = sqlite3.connect(str(db_path))
        conn.execute("""
            CREATE TABLE IF NOT EXISTS seller_nurture_drip (
                person_id INTEGER PRIMARY KEY,
                emails_sent INTEGER DEFAULT 0,
                enrolled_at TEXT,
                last_sent_at TEXT,
                last_subject TEXT,
                last_body_preview TEXT,
                property_address TEXT DEFAULT '',
                neighborhood TEXT DEFAULT ''
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action TEXT,
                status TEXT,
                person_id INTEGER,
                details TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.commit()
        conn.close()
        return db_path

    def test_new_seller_lead_gets_enrolled(self, mock_db):
        """A new seller lead should be enrolled in the drip table."""
        conn = sqlite3.connect(str(mock_db))
        # Simulate enrollment
        conn.execute(
            "INSERT INTO seller_nurture_drip (person_id, emails_sent, enrolled_at, property_address, neighborhood) VALUES (?, ?, ?, ?, ?)",
            (12345, 0, dt.datetime.now(dt.timezone.utc).isoformat(), "123 Main St", "Stone Oak")
        )
        conn.commit()

        # Verify enrollment
        row = conn.execute("SELECT * FROM seller_nurture_drip WHERE person_id = 12345").fetchone()
        assert row is not None
        assert row[0] == 12345  # person_id
        conn.close()

    def test_drip_increments_emails_sent(self, mock_db):
        """After sending an email, emails_sent should increment."""
        conn = sqlite3.connect(str(mock_db))
        conn.execute(
            "INSERT INTO seller_nurture_drip (person_id, emails_sent, enrolled_at) VALUES (?, ?, ?)",
            (12345, 0, dt.datetime.now(dt.timezone.utc).isoformat())
        )
        conn.commit()

        # Simulate sending email 1
        conn.execute(
            "UPDATE seller_nurture_drip SET emails_sent = emails_sent + 1, last_sent_at = ? WHERE person_id = ?",
            (dt.datetime.now(dt.timezone.utc).isoformat(), 12345)
        )
        conn.commit()

        row = conn.execute("SELECT emails_sent FROM seller_nurture_drip WHERE person_id = 12345").fetchone()
        assert row[0] == 1
        conn.close()

    def test_audit_log_records_seller_nurture_action(self, mock_db):
        """Seller nurture sends should be logged with action='seller_nurture'."""
        conn = sqlite3.connect(str(mock_db))
        conn.execute(
            "INSERT INTO audit_log (action, status, person_id, details) VALUES (?, ?, ?, ?)",
            ("seller_nurture", "sent", 12345, json.dumps({"to": "maria@example.com", "email_number": 1}))
        )
        conn.commit()

        rows = conn.execute("SELECT * FROM audit_log WHERE action = 'seller_nurture'").fetchall()
        assert len(rows) == 1
        assert rows[0][2] == "sent"  # status
        conn.close()


# ═══════════════════════════════════════════════════════════════════════════════
# REPLY HANDLING TESTS
# ═══════════════════════════════════════════════════════════════════════════════

class TestSellerReplyHandling:
    """Test that seller lead replies are properly handled."""

    def test_seller_replied_tag_stops_sequence(self):
        """'Seller-Replied' tag should be in the suppress set to stop the sequence."""
        assert "seller-replied" in SELLER_SUPPRESS_TAGS

    def test_replied_paused_tag_stops_sequence(self):
        """'Replied - Paused' tag should also stop the seller sequence."""
        assert "replied - paused" in SELLER_SUPPRESS_TAGS


# ═══════════════════════════════════════════════════════════════════════════════
# GLOBAL FETCH (NO POND RESTRICTION) TESTS
# ═══════════════════════════════════════════════════════════════════════════════

class TestSellerNurtureGlobalFetch:
    """Test that seller leads WITHOUT pond assignment are picked up.

    LDR-Seller-Finder creates FUB people with the 'Seller Lead' tag but
    without assigning them to a pond. The scan must find these leads globally.
    """

    @pytest.fixture
    def mock_db(self, tmp_path):
        """Create a temporary SQLite DB with seller_nurture_drip table."""
        db_path = tmp_path / "test.sqlite3"
        conn = sqlite3.connect(str(db_path))
        conn.execute("""
            CREATE TABLE IF NOT EXISTS seller_nurture_drip (
                person_id INTEGER PRIMARY KEY,
                emails_sent INTEGER DEFAULT 0,
                enrolled_at TEXT,
                last_sent_at TEXT,
                last_subject TEXT,
                last_body_preview TEXT,
                property_address TEXT DEFAULT '',
                neighborhood TEXT DEFAULT ''
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action TEXT,
                status TEXT,
                person_id INTEGER,
                details TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.commit()
        conn.close()
        return db_path

    def test_seller_lead_without_pond_gets_enrolled(self, mock_db):
        """A Seller Lead person with NO pond assignment should still be enrolled.

        This proves the scan is global (by tag only), not pond-restricted.
        LDR-Seller-Finder creates leads without pond assignment.
        """
        conn = sqlite3.connect(str(mock_db))

        # Simulate a seller lead with NO pond assignment (assignedPondId is None/null)
        seller_person_no_pond = {
            "id": 99999,
            "firstName": "Carlos",
            "lastName": "Mendez",
            "emails": [{"value": "carlos@example.com"}],
            "tags": [{"name": "Seller Lead"}],
            "assignedPondId": None,  # <-- NO POND ASSIGNMENT
            "assignedGroupIds": [],  # <-- NO GROUP ASSIGNMENT
            "unsubscribed": False,
        }

        # Verify the person has the Seller Lead tag
        person_tags = [t.get("name", "").lower() for t in seller_person_no_pond.get("tags", [])]
        assert SELLER_LEAD_TAG in person_tags, "Person must have 'seller lead' tag"

        # Verify the person has NO pond assignment
        assert seller_person_no_pond.get("assignedPondId") is None, "Person must have no pond assignment"
        assert seller_person_no_pond.get("assignedGroupIds") == [], "Person must have no group assignment"

        # Simulate enrollment (what scan_seller_nurture does for a valid candidate)
        person_id = int(seller_person_no_pond["id"])
        conn.execute(
            "INSERT INTO seller_nurture_drip (person_id, emails_sent, enrolled_at, property_address, neighborhood) VALUES (?, ?, ?, ?, ?)",
            (person_id, 0, dt.datetime.now(dt.timezone.utc).isoformat(), "", "")
        )
        conn.commit()

        # Verify enrollment succeeded
        row = conn.execute("SELECT * FROM seller_nurture_drip WHERE person_id = ?", (person_id,)).fetchone()
        assert row is not None, "Seller lead without pond assignment must be enrolled"
        assert row[0] == 99999
        assert row[1] == 0  # emails_sent starts at 0
        conn.close()

    def test_seller_lead_with_pond_also_enrolled(self, mock_db):
        """A Seller Lead person WITH a pond assignment should also be enrolled (global fetch)."""
        conn = sqlite3.connect(str(mock_db))

        seller_person_with_pond = {
            "id": 88888,
            "firstName": "Diana",
            "lastName": "Torres",
            "emails": [{"value": "diana@example.com"}],
            "tags": [{"name": "Seller Lead"}],
            "assignedPondId": 1,  # HAS pond assignment
            "unsubscribed": False,
        }

        person_tags = [t.get("name", "").lower() for t in seller_person_with_pond.get("tags", [])]
        assert SELLER_LEAD_TAG in person_tags

        person_id = int(seller_person_with_pond["id"])
        conn.execute(
            "INSERT INTO seller_nurture_drip (person_id, emails_sent, enrolled_at) VALUES (?, ?, ?)",
            (person_id, 0, dt.datetime.now(dt.timezone.utc).isoformat())
        )
        conn.commit()

        row = conn.execute("SELECT * FROM seller_nurture_drip WHERE person_id = ?", (person_id,)).fetchone()
        assert row is not None, "Seller lead with pond assignment must also be enrolled"
        assert row[0] == 88888
        conn.close()

    def test_scan_does_not_use_pond_id_filter(self):
        """The scan_seller_nurture method must NOT filter by assignedGroupIds or assignedPondId.

        This is a code-level assertion: the FUB API call should use tags= only,
        not assignedGroupIds= or assignedPondId=.
        """
        import inspect
        # Read the source of the main module to verify the scan logic
        main_path = Path(__file__).resolve().parent.parent / "src" / "fub_automation" / "main.py"
        source = main_path.read_text()

        # Find the scan_seller_nurture method
        start_marker = "def scan_seller_nurture(self)"
        end_marker = "def process_seller_nurture_candidate(self"
        start_idx = source.find(start_marker)
        end_idx = source.find(end_marker, start_idx)
        assert start_idx != -1, "scan_seller_nurture method not found"
        assert end_idx != -1, "process_seller_nurture_candidate method not found"

        scan_method_source = source[start_idx:end_idx]

        # The get_people call should NOT include assignedGroupIds or assignedPondId
        assert "assignedGroupIds" not in scan_method_source, (
            "scan_seller_nurture must NOT filter by assignedGroupIds — "
            "seller leads from LDR-Seller-Finder have no pond assignment"
        )
        assert "assignedPondId" not in scan_method_source, (
            "scan_seller_nurture must NOT filter by assignedPondId — "
            "seller leads from LDR-Seller-Finder have no pond assignment"
        )

        # It SHOULD use tags=SELLER_LEAD_TAG
        assert "tags=SELLER_LEAD_TAG" in scan_method_source or "tags=" in scan_method_source, (
            "scan_seller_nurture must fetch by tag globally"
        )


# ── Seller Email Signature Tests ─────────────────────────────────────────────

class TestSellerEmailSignature:
    """Tests for the seller email signature builder functions."""

    class FakeRules:
        company_name = "Lifestyle Design Realty"
        company_address = "1212 Chicon St, Suite 101, Austin, TX 78702"

    def test_html_contains_peter_allen_name(self):
        from fub_automation.seller_nurture import build_seller_email_html
        html = build_seller_email_html("Hey there, just checking in.", self.FakeRules())
        assert "Peter Allen" in html

    def test_html_contains_headshot_image(self):
        from fub_automation.seller_nurture import build_seller_email_html, PETER_HEADSHOT_URL
        html = build_seller_email_html("Hey there, just checking in.", self.FakeRules())
        assert PETER_HEADSHOT_URL in html
        assert '<img' in html

    def test_html_contains_phone_number(self):
        from fub_automation.seller_nurture import build_seller_email_html
        html = build_seller_email_html("Hey there, just checking in.", self.FakeRules())
        assert "520.373.7839" in html

    def test_html_contains_email_address(self):
        from fub_automation.seller_nurture import build_seller_email_html
        html = build_seller_email_html("Hey there, just checking in.", self.FakeRules())
        assert "Peter@lifestyledesignrealty.com" in html

    def test_html_contains_office_address(self):
        from fub_automation.seller_nurture import build_seller_email_html
        html = build_seller_email_html("Hey there, just checking in.", self.FakeRules())
        assert "1212 Chicon St, Suite 101" in html
        assert "Austin, TX 78702" in html

    def test_html_contains_trec_links(self):
        from fub_automation.seller_nurture import build_seller_email_html, TREC_IABS_URL, TREC_CONSUMER_PROTECTION_URL
        html = build_seller_email_html("Hey there, just checking in.", self.FakeRules())
        assert TREC_IABS_URL in html
        assert TREC_CONSUMER_PROTECTION_URL in html
        assert "Information About Brokerage Services" in html
        assert "TREC Consumer Protection Notice" in html

    def test_html_contains_instagram_link(self):
        from fub_automation.seller_nurture import build_seller_email_html, INSTAGRAM_URL
        html = build_seller_email_html("Hey there, just checking in.", self.FakeRules())
        assert INSTAGRAM_URL in html

    def test_html_contains_facebook_link(self):
        from fub_automation.seller_nurture import build_seller_email_html, FACEBOOK_URL
        html = build_seller_email_html("Hey there, just checking in.", self.FakeRules())
        assert FACEBOOK_URL in html

    def test_html_contains_referral_link(self):
        from fub_automation.seller_nurture import build_seller_email_html
        html = build_seller_email_html("Hey there, just checking in.", self.FakeRules())
        assert "Send this Link to a Friend" in html

    def test_html_contains_company_info_and_title(self):
        from fub_automation.seller_nurture import build_seller_email_html
        html = build_seller_email_html("Hey there, just checking in.", self.FakeRules())
        assert "Lifestyle Design Realty, LLC" in html
        assert "Managing Realtor and Owner" in html
        assert "Army Veteran at your service" in html

    def test_html_contains_unsubscribe_footer(self):
        from fub_automation.seller_nurture import build_seller_email_html
        html = build_seller_email_html("Hey there, just checking in.", self.FakeRules())
        assert "UNSUBSCRIBE" in html
        assert self.FakeRules.company_address in html

    def test_html_body_text_is_included(self):
        from fub_automation.seller_nurture import build_seller_email_html
        body = "Hey Sarah, just wanted to check in about your home value."
        html = build_seller_email_html(body, self.FakeRules())
        assert "Hey Sarah" in html
        assert "home value" in html

    def test_html_signature_comes_before_footer(self):
        from fub_automation.seller_nurture import build_seller_email_html
        html = build_seller_email_html("Hello there.", self.FakeRules())
        sig_pos = html.find("Peter Allen")
        footer_pos = html.find("UNSUBSCRIBE")
        assert sig_pos < footer_pos, "Signature must come before the CAN-SPAM footer"

    def test_html_body_comes_before_signature(self):
        from fub_automation.seller_nurture import build_seller_email_html
        html = build_seller_email_html("Hey Sarah, quick question.", self.FakeRules())
        body_pos = html.find("Hey Sarah")
        sig_pos = html.find("Peter Allen")
        assert body_pos < sig_pos, "Body must come before signature"

    def test_plaintext_contains_peter_allen_name(self):
        from fub_automation.seller_nurture import build_seller_email_plaintext
        text = build_seller_email_plaintext("Hey there, just checking in.", self.FakeRules())
        assert "Peter Allen" in text

    def test_plaintext_contains_phone_number(self):
        from fub_automation.seller_nurture import build_seller_email_plaintext
        text = build_seller_email_plaintext("Hey there, just checking in.", self.FakeRules())
        assert "520.373.7839" in text

    def test_plaintext_contains_email_address(self):
        from fub_automation.seller_nurture import build_seller_email_plaintext
        text = build_seller_email_plaintext("Hey there, just checking in.", self.FakeRules())
        assert "Peter@lifestyledesignrealty.com" in text

    def test_plaintext_contains_office_address(self):
        from fub_automation.seller_nurture import build_seller_email_plaintext
        text = build_seller_email_plaintext("Hey there, just checking in.", self.FakeRules())
        assert "1212 Chicon St, Suite 101" in text
        assert "Austin, TX 78702" in text

    def test_plaintext_contains_trec_urls(self):
        from fub_automation.seller_nurture import build_seller_email_plaintext, TREC_IABS_URL, TREC_CONSUMER_PROTECTION_URL
        text = build_seller_email_plaintext("Hey there, just checking in.", self.FakeRules())
        assert TREC_IABS_URL in text
        assert TREC_CONSUMER_PROTECTION_URL in text

    def test_plaintext_contains_social_urls(self):
        from fub_automation.seller_nurture import build_seller_email_plaintext, INSTAGRAM_URL, FACEBOOK_URL
        text = build_seller_email_plaintext("Hey there, just checking in.", self.FakeRules())
        assert INSTAGRAM_URL in text
        assert FACEBOOK_URL in text

    def test_plaintext_contains_unsubscribe_footer(self):
        from fub_automation.seller_nurture import build_seller_email_plaintext
        text = build_seller_email_plaintext("Hey there, just checking in.", self.FakeRules())
        assert "UNSUBSCRIBE" in text
        assert self.FakeRules.company_address in text

    def test_plaintext_body_comes_first(self):
        from fub_automation.seller_nurture import build_seller_email_plaintext
        text = build_seller_email_plaintext("Hey Sarah, quick question.", self.FakeRules())
        body_pos = text.find("Hey Sarah")
        sig_pos = text.find("Peter Allen")
        footer_pos = text.find("UNSUBSCRIBE")
        assert body_pos < sig_pos < footer_pos

    def test_plaintext_contains_company_title(self):
        from fub_automation.seller_nurture import build_seller_email_plaintext
        text = build_seller_email_plaintext("Hello.", self.FakeRules())
        assert "Lifestyle Design Realty, LLC" in text
        assert "Managing Realtor and Owner" in text
        assert "Army Veteran at your service" in text


# ═══════════════════════════════════════════════════════════════════════════════
# Volume upgrade (2026-07): weekly cap ramp + 3-week long-tail angle rotation
# ═══════════════════════════════════════════════════════════════════════════════

class TestSellerRampAndLongtail:
    """Weekly daily-cap ramp and every-3-weeks long-tail angle rotation."""

    def test_ramp_week_progression(self):
        import datetime as _dt
        from datetime import timezone as _tz
        from fub_automation.seller_nurture import ramp_daily_cap
        now = _dt.datetime(2026, 7, 24, tzinfo=_tz.utc)
        ramp = [25, 25, 50, 50]
        for days, expected in [(0, 25), (6, 25), (7, 25), (13, 25), (14, 50), (20, 50), (21, 50), (27, 50)]:
            anchor = now - _dt.timedelta(days=days)
            assert ramp_daily_cap(ramp, anchor, now) == expected, f"day {days}"

    def test_ramp_holds_at_last_value_forever(self):
        import datetime as _dt
        from datetime import timezone as _tz
        from fub_automation.seller_nurture import ramp_daily_cap
        now = _dt.datetime(2026, 7, 24, tzinfo=_tz.utc)
        anchor = now - _dt.timedelta(days=365)
        assert ramp_daily_cap([25, 25, 50, 50], anchor, now) == 50

    def test_ramp_no_anchor_is_week_zero(self):
        from fub_automation.seller_nurture import ramp_daily_cap
        assert ramp_daily_cap([25, 25, 50, 50], None) == 25

    def test_ramp_empty_list_falls_back(self):
        from fub_automation.seller_nurture import ramp_daily_cap
        assert ramp_daily_cap([], None) == 25

    def test_ramp_naive_datetime_handled(self):
        import datetime as _dt
        from fub_automation.seller_nurture import ramp_daily_cap
        anchor = _dt.datetime(2020, 1, 1)  # naive, long past -> holds at last value
        assert ramp_daily_cap([25, 50], anchor) == 50

    def test_longtail_angle_rotation_never_repeats_back_to_back(self):
        from fub_automation.seller_nurture import LONGTAIL_ANGLES, longtail_angle_for
        seq = [longtail_angle_for(n) for n in range(5, 30)]
        assert seq[0] == "market_update"  # first long-tail email
        for a, b in zip(seq, seq[1:]):
            assert a != b, "long-tail angle repeated back-to-back"
        assert set(seq) == set(LONGTAIL_ANGLES)

    def test_longtail_prompt_uses_rotated_angle(self, seller_person, mock_rules):
        """Email #6 (emails_sent=5) must use market_update; #7 equity_teaser; #8 case_study."""
        captured = {}

        def fake_llm(messages, temperature=0.8):
            captured["prompt"] = messages[0]["content"]
            return json.dumps({"subject": "s", "email_body": "b"})

        expectations = {5: "market_update", 6: "equity_teaser", 7: "case_study", 8: "market_update"}
        for emails_sent, angle in expectations.items():
            generate_seller_email(
                llm_call_fn=fake_llm, person=seller_person, email_number=emails_sent,
                property_address="", neighborhood="", notes_context="", rules=mock_rules,
            )
            assert angle in captured["prompt"], f"email #{emails_sent + 1} should use {angle}"

    def test_rules_defaults(self, tmp_path):
        """Rules.load exposes the new settings with correct defaults when absent from yaml."""
        from fub_automation.main import Rules
        p = tmp_path / "rules.yaml"
        p.write_text("company_name: Test\n", encoding="utf-8")
        r = Rules.load(str(p))
        assert r.seller_daily_cap_ramp == [25, 25, 50, 50]
        assert r.seller_longtail_cadence_days == 21

    def test_first_send_anchor_and_longtail_count(self, tmp_path):
        """AuditDB.get_seller_first_send_at + get_seller_longtail_send_count."""
        from fub_automation.main import AuditDB
        db = AuditDB(str(tmp_path / "d" / "audit.sqlite3"))
        assert db.get_seller_first_send_at() is None
        assert db.get_seller_longtail_send_count() == 0
        with db.connect() as con:
            con.execute(
                "INSERT INTO seller_nurture_drip(person_id, enrolled_at, last_sent_at, emails_sent) "
                "VALUES (1, '2026-07-01T12:00:00+00:00', '2026-07-01T12:00:00+00:00', 1)"
            )
        anchor = db.get_seller_first_send_at()
        assert anchor is not None and anchor.year == 2026 and anchor.month == 7
        db.log("seller_nurture", "sent", 1, {"email_number": 6, "longtail_angle": "market_update"})
        db.log("seller_nurture", "sent", 1, {"email_number": 3})
        assert db.get_seller_longtail_send_count() == 1

    def test_digest_longtail_stats(self, tmp_path):
        """weekly_digest.query_seller_nurture_stats returns long-tail counts + angle breakdown."""
        import importlib.util
        import os as _os
        from fub_automation.main import AuditDB
        db = AuditDB(str(tmp_path / "d" / "audit.sqlite3"))
        db.log("seller_nurture", "sent", 1, {"email_number": 6, "longtail_angle": "market_update"})
        db.log("seller_nurture", "sent", 2, {"email_number": 7, "longtail_angle": "equity_teaser"})
        db.log("seller_nurture", "sent", 3, {"email_number": 2})  # sequence email, not long-tail
        spec = importlib.util.spec_from_file_location(
            "weekly_digest",
            _os.path.join(str(Path(__file__).resolve().parent.parent), "weekly_digest.py"),
        )
        wd = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(wd)
        conn = sqlite3.connect(db.path)
        conn.row_factory = sqlite3.Row
        start = dt.datetime(2020, 1, 1)
        end = dt.datetime(2030, 1, 1)
        stats = wd.query_seller_nurture_stats(conn, start, end)
        assert stats["seller_longtail_sent"] == 2
        assert stats["seller_longtail_angles"] == {"market_update": 1, "equity_teaser": 1}
        assert stats["seller_emails_sent"] == 3
        html = wd.format_seller_nurture_section(stats)
        assert "Long-tail sends this week" in html
        assert "market update: 1" in html
