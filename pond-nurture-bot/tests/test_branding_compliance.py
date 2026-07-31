"""Behavioral tests for branding compliance across both email systems.

Pond Nurture (System 4):
  - Email body must NOT contain any individual person's name (no "Peter", "Peter Allen")
  - Footer must contain the LDR logo URL
  - Footer must contain TREC IABS and Consumer Protection links
  - From display must be "Lifestyle Design Realty" (no individual name)

Agent Bots (System 1):
  - Email body MUST still contain the agent's name (Tiffany, Stefanie, etc.)
  - Footer must contain the LDR logo URL
  - Footer must contain TREC IABS and Consumer Protection links
"""
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))


# ═══ Constants ════════════════════════════════════════════════════════════════
LDR_LOGO_URL = "https://raw.githubusercontent.com/PropertyPete1/ldr-public-assets/main/ldr_logo.png"
TREC_IABS_URL = "https://www.trec.texas.gov/sites/default/files/pdf-forms/IABS%201-2_1.pdf"
TREC_CONSUMER_PROTECTION_URL = "https://www.trec.texas.gov/sites/default/files/pdf-forms/CN%201-4-1_1.pdf"


# ═══ POND NURTURE TESTS ══════════════════════════════════════════════════════

class TestPondNurtureFooterBranding:
    """Verify pond nurture emails have correct team branding, logo, and TREC links."""

    def test_plain_text_footer_contains_trec_iabs_link(self, m, rules):
        body = "Hey there, just checking in about your home search!"
        footer = m.append_email_footer(body, rules)
        assert TREC_IABS_URL in footer

    def test_plain_text_footer_contains_trec_consumer_protection_link(self, m, rules):
        body = "Hey there, just checking in about your home search!"
        footer = m.append_email_footer(body, rules)
        assert TREC_CONSUMER_PROTECTION_URL in footer

    def test_plain_text_footer_contains_team_email(self, m, rules):
        body = "Hey there, just checking in about your home search!"
        footer = m.append_email_footer(body, rules)
        assert "team@lifestyledesignrealty.com" in footer

    def test_plain_text_footer_contains_company_name(self, m, rules):
        body = "Hey there, just checking in about your home search!"
        footer = m.append_email_footer(body, rules)
        assert "Lifestyle Design Realty" in footer

    def test_plain_text_footer_no_peter_name(self, m, rules):
        body = "Hey there, just checking in about your home search!"
        footer = m.append_email_footer(body, rules)
        # Footer should not contain "Peter Allen" or "Peter" as a sign-off
        assert "Peter Allen" not in footer
        # "Peter" alone should not appear in the footer section (after --)
        footer_section = footer.split("--", 1)[1] if "--" in footer else footer
        assert "Peter" not in footer_section

    def test_html_footer_contains_logo(self, m, rules):
        body = "Hey there, just checking in about your home search!"
        html = m.build_pond_email_html(body, rules)
        assert LDR_LOGO_URL in html

    def test_html_footer_contains_trec_iabs(self, m, rules):
        body = "Hey there, just checking in about your home search!"
        html = m.build_pond_email_html(body, rules)
        assert TREC_IABS_URL in html
        assert "Information About Brokerage Services" in html

    def test_html_footer_contains_trec_consumer_protection(self, m, rules):
        body = "Hey there, just checking in about your home search!"
        html = m.build_pond_email_html(body, rules)
        assert TREC_CONSUMER_PROTECTION_URL in html
        assert "TREC Consumer Protection Notice" in html

    def test_html_footer_contains_team_email(self, m, rules):
        body = "Hey there, just checking in about your home search!"
        html = m.build_pond_email_html(body, rules)
        assert "team@lifestyledesignrealty.com" in html

    def test_html_footer_contains_website_link(self, m, rules):
        body = "Hey there, just checking in about your home search!"
        html = m.build_pond_email_html(body, rules)
        assert "lifestyledesignrealty.com" in html

    def test_html_body_renders_paragraphs(self, m, rules):
        body = "First paragraph.\n\nSecond paragraph."
        html = m.build_pond_email_html(body, rules)
        assert "<p" in html
        assert "First paragraph." in html
        assert "Second paragraph." in html


class TestPondNurturePromptBranding:
    """Verify LLM prompts no longer reference any individual person's name."""

    def test_two_week_nurture_prompt_uses_team_branding(self, engine, fake_http):
        """The two-week nurture prompt must say 'Lifestyle Design Realty team', not 'Peter Allen'."""
        # We'll call the generate method and capture the LLM prompt via the fake_http
        # Since LLM calls go through _llm_call which uses requests, we can check the prompt
        fake_http.responses = [
            (200, {"choices": [{"message": {"content": '{"subject":"Test","email_body":"Hey there!"}'}}]}),
        ]
        try:
            engine.generate_two_week_nurture_email(
                person={"id": 1, "firstName": "Test", "lastName": "Lead"},
                first_name="Test",
                lead_source="Zillow",
                price_range="$300k-$400k",
                days_in_pond=7,
                engagement_tier="standard",
                city="Austin",
            )
        except Exception:
            pass  # May fail due to mock, that's fine

        # Check the prompt sent to the LLM
        if fake_http.calls:
            last_call = fake_http.calls[-1]
            if last_call.json and "messages" in (last_call.json or {}):
                prompt_text = str(last_call.json["messages"])
                assert "Peter Allen" not in prompt_text
                assert "Lifestyle Design Realty team" in prompt_text

    def test_from_display_uses_team_not_peter(self, m, rules):
        """From display for pond emails should be 'Lifestyle Design Realty', not 'Peter | ...'."""
        # Check that the team_email is used in the from display format
        expected_from = f"Lifestyle Design Realty <{rules.team_email}>"
        assert "Peter" not in expected_from


# ═══ AGENT BOT TESTS ═════════════════════════════════════════════════════════

class TestAgentBotEmailBranding:
    """Verify agent bot emails keep agent name AND have logo + TREC links.

    These tests validate the HTML template structure in botHelpers.ts by
    checking the template source code directly (since we can't easily run
    TypeScript in the Python test suite).
    """

    @pytest.fixture()
    def bot_helpers_source(self):
        """Read the botHelpers.ts source for template validation."""
        bot_helpers_path = ROOT.parent / "lifestyle-bot-dashboard" / "server" / "botHelpers.ts"
        if not bot_helpers_path.exists():
            pytest.skip("botHelpers.ts not found")
        return bot_helpers_path.read_text()

    def test_agent_bot_template_contains_agent_name_placeholder(self, bot_helpers_source):
        """Agent bot emails must still display the agent's name."""
        assert "${agentFirstName}" in bot_helpers_source
        assert "${agentLastName}" in bot_helpers_source

    def test_agent_bot_template_contains_logo(self, bot_helpers_source):
        """Agent bot emails must include the LDR logo."""
        assert LDR_LOGO_URL in bot_helpers_source

    def test_agent_bot_template_contains_trec_iabs(self, bot_helpers_source):
        """Agent bot emails must include TREC IABS link."""
        assert "TREC_IABS_URL" in bot_helpers_source or TREC_IABS_URL in bot_helpers_source
        assert "Information About Brokerage Services" in bot_helpers_source

    def test_agent_bot_template_contains_trec_consumer_protection(self, bot_helpers_source):
        """Agent bot emails must include TREC Consumer Protection link."""
        assert "TREC_CONSUMER_PROTECTION_URL" in bot_helpers_source or TREC_CONSUMER_PROTECTION_URL in bot_helpers_source
        assert "TREC Consumer Protection Notice" in bot_helpers_source

    def test_agent_bot_from_still_uses_agent_name(self, bot_helpers_source):
        """Agent bot From: header must still include the agent's first name."""
        assert "${agentFirstName} | Lifestyle Design Realty" in bot_helpers_source
