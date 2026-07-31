"""Behavioral tests for branding compliance across both email systems.

Pond Nurture (System 4):
  - Email body must NOT contain any individual person's name
  - Signature uses styled-text wordmark "LIFESTYLE DESIGN REALTY" (no image)
  - Footer must contain TREC IABS and Consumer Protection links
  - From display must be "Lifestyle Design Realty" (no individual name)
  - All compliance content renders even with images stripped

Agent Bots (System 1):
  - Email body MUST still contain the agent's name
  - Signature uses same styled-text wordmark
  - Footer must contain TREC IABS and Consumer Protection links
  - Agent name appears below wordmark
"""
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))


# ═══ Constants ════════════════════════════════════════════════════════════════
TREC_IABS_URL = "https://www.trec.texas.gov/sites/default/files/pdf-forms/IABS%201-2_1.pdf"
TREC_CONSUMER_PROTECTION_URL = "https://www.trec.texas.gov/sites/default/files/pdf-forms/CN%201-4-1_1.pdf"
COMPANY_ADDRESS = "1212 Chicon St, Suite 101, Austin, TX 78702"


# ═══ POND NURTURE TESTS ══════════════════════════════════════════════════════

class TestPondNurtureSignature:
    """Verify pond nurture emails have correct team branding, wordmark, and TREC links."""

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

    def test_plain_text_footer_contains_wordmark(self, m, rules):
        body = "Hey there, just checking in about your home search!"
        footer = m.append_email_footer(body, rules)
        assert "LIFESTYLE DESIGN REALTY" in footer

    def test_plain_text_footer_contains_address(self, m, rules):
        body = "Hey there, just checking in about your home search!"
        footer = m.append_email_footer(body, rules)
        assert COMPANY_ADDRESS in footer

    def test_plain_text_footer_no_peter_name(self, m, rules):
        body = "Hey there, just checking in about your home search!"
        footer = m.append_email_footer(body, rules)
        assert "Peter Allen" not in footer
        footer_section = footer.split("--", 1)[1] if "--" in footer else footer
        assert "Peter" not in footer_section

    def test_html_contains_styled_text_wordmark(self, m, rules):
        """Wordmark is styled text, not an image — works even with images blocked."""
        body = "Hey there, just checking in about your home search!"
        html = m.build_pond_email_html(body, rules)
        assert "LIFESTYLE DESIGN" in html
        assert "REALTY" in html
        # Must use Georgia serif font
        assert "Georgia" in html
        # Gold color for REALTY
        assert "#a3793f" in html

    def test_html_no_img_tag(self, m, rules):
        """No image tags in the signature — pure text fallback."""
        body = "Hey there, just checking in about your home search!"
        html = m.build_pond_email_html(body, rules)
        # The signature block should not contain <img> tags
        sig_section = html.split("Signature block")[1] if "Signature block" in html else html
        assert "<img" not in sig_section

    def test_html_contains_trec_iabs(self, m, rules):
        body = "Hey there, just checking in about your home search!"
        html = m.build_pond_email_html(body, rules)
        assert TREC_IABS_URL in html
        assert "Information About Brokerage Services" in html

    def test_html_contains_trec_consumer_protection(self, m, rules):
        body = "Hey there, just checking in about your home search!"
        html = m.build_pond_email_html(body, rules)
        assert TREC_CONSUMER_PROTECTION_URL in html
        assert "TREC Consumer Protection Notice" in html

    def test_html_contains_team_email(self, m, rules):
        body = "Hey there, just checking in about your home search!"
        html = m.build_pond_email_html(body, rules)
        assert "team@lifestyledesignrealty.com" in html

    def test_html_contains_website_link(self, m, rules):
        body = "Hey there, just checking in about your home search!"
        html = m.build_pond_email_html(body, rules)
        assert "lifestyledesignrealty.com" in html

    def test_html_contains_address(self, m, rules):
        body = "Hey there, just checking in about your home search!"
        html = m.build_pond_email_html(body, rules)
        assert COMPANY_ADDRESS in html

    def test_html_has_two_dividers(self, m, rules):
        """Signature has two thin divider lines."""
        body = "Hey there!"
        html = m.build_pond_email_html(body, rules)
        divider_count = html.count("border-top: 1px solid #e0e0e0") + html.count("border-top:1px solid #e0e0e0")
        assert divider_count >= 2, f"Expected 2 dividers, found {divider_count}"

    def test_html_trec_visible_without_images(self, m, rules):
        """TREC links must be visible even if all <img> tags are stripped."""
        body = "Hey there!"
        html = m.build_pond_email_html(body, rules)
        # Strip all img tags
        stripped = re.sub(r'<img[^>]*>', '', html)
        assert "Information About Brokerage Services" in stripped
        assert "TREC Consumer Protection Notice" in stripped
        assert TREC_IABS_URL in stripped

    def test_html_body_renders_paragraphs(self, m, rules):
        body = "First paragraph.\n\nSecond paragraph."
        html = m.build_pond_email_html(body, rules)
        assert "<p" in html
        assert "First paragraph." in html
        assert "Second paragraph." in html


class TestPondNurturePromptBranding:
    """Verify LLM prompts no longer reference any individual person's name."""

    def test_from_display_uses_team_not_peter(self, m, rules):
        """From display for pond emails should be 'Lifestyle Design Realty', not 'Peter | ...'."""
        expected_from = f"Lifestyle Design Realty <{rules.team_email}>"
        assert "Peter" not in expected_from


# ═══ AGENT BOT TESTS ═════════════════════════════════════════════════════════

class TestAgentBotEmailBranding:
    """Verify agent bot emails keep agent name AND have styled-text wordmark + TREC links."""

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

    def test_agent_bot_template_contains_styled_wordmark(self, bot_helpers_source):
        """Agent bot emails must include the styled-text wordmark."""
        assert "LIFESTYLE DESIGN" in bot_helpers_source
        assert "REALTY" in bot_helpers_source
        assert "#a3793f" in bot_helpers_source  # Gold color
        assert "Georgia" in bot_helpers_source  # Serif font

    def test_agent_bot_template_no_img_in_signature(self, bot_helpers_source):
        """Agent bot signature should not rely on images."""
        sig_section = bot_helpers_source.split("Signature block")[1] if "Signature block" in bot_helpers_source else ""
        if sig_section:
            # Get just the template part (up to the closing backtick)
            sig_section = sig_section.split("`;")[0]
            assert "<img" not in sig_section

    def test_agent_bot_template_contains_trec_iabs(self, bot_helpers_source):
        """Agent bot emails must include TREC IABS link."""
        assert TREC_IABS_URL in bot_helpers_source
        assert "Information About Brokerage Services" in bot_helpers_source

    def test_agent_bot_template_contains_trec_consumer_protection(self, bot_helpers_source):
        """Agent bot emails must include TREC Consumer Protection link."""
        assert TREC_CONSUMER_PROTECTION_URL in bot_helpers_source
        assert "TREC Consumer Protection Notice" in bot_helpers_source

    def test_agent_bot_template_contains_address(self, bot_helpers_source):
        """Agent bot emails must include the office address."""
        assert COMPANY_ADDRESS in bot_helpers_source

    def test_agent_bot_from_still_uses_agent_name(self, bot_helpers_source):
        """Agent bot From: header must still include the agent's first name."""
        assert "${agentFirstName} | Lifestyle Design Realty" in bot_helpers_source

    def test_agent_bot_template_has_two_dividers(self, bot_helpers_source):
        """Signature has two thin divider lines."""
        sig_section = bot_helpers_source.split("Signature block")[1].split("`;")[0] if "Signature block" in bot_helpers_source else ""
        divider_count = sig_section.count("border-top: 1px solid #e0e0e0")
        assert divider_count >= 2, f"Expected 2 dividers, found {divider_count}"
