"""
test_email_from_address.py
Asserts that all lead-facing email sends use:
  From: "AgentFirstName | Lifestyle Design Realty <team@lifestyledesignrealty.com>"
  Reply-To: peter@lifestyledesignrealty.com

Internal emails (nightly_health, weekly_digest, speed-to-lead alerts, reassignment notices)
are NOT changed and remain from peter@lifestyledesignrealty.com.
"""
import ast
import re
import os
import sys

# Add project root to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def test_rules_yaml_has_team_email():
    """rules.yaml must include team_email = team@lifestyledesignrealty.com"""
    import yaml
    rules_path = os.path.join(os.path.dirname(__file__), "..", "config", "rules.yaml")
    with open(rules_path) as f:
        rules = yaml.safe_load(f)
    assert "team_email" in rules, "rules.yaml must define team_email"
    assert rules["team_email"] == "team@lifestyledesignrealty.com"


def test_rules_dataclass_has_team_email():
    """The Rules dataclass must include a team_email field."""
    main_path = os.path.join(os.path.dirname(__file__), "..", "src", "fub_automation", "main.py")
    with open(main_path) as f:
        source = f.read()
    # Check the field exists in the dataclass
    assert "team_email: str" in source, "Rules dataclass must have team_email: str field"


def test_from_dict_loads_team_email():
    """The from_dict method must load team_email from config."""
    main_path = os.path.join(os.path.dirname(__file__), "..", "src", "fub_automation", "main.py")
    with open(main_path) as f:
        source = f.read()
    assert 'team_email=data.get("team_email"' in source, \
        "from_dict must load team_email from data"


def test_pond_nurture_send_uses_team_email():
    """The pond nurture outreach email must use team_email in From display."""
    main_path = os.path.join(os.path.dirname(__file__), "..", "src", "fub_automation", "main.py")
    with open(main_path) as f:
        source = f.read()
    # Find the pond nurture send block (around the "sent_channels = []" area)
    # It should have: from_display = f"Peter | Lifestyle Design Realty <{self.rules.team_email}>"
    pond_pattern = r'from_display\s*=\s*f"Peter \| Lifestyle Design Realty <\{self\.rules\.team_email\}>"'
    matches = re.findall(pond_pattern, source)
    assert len(matches) >= 1, \
        "Pond nurture send must use: Peter | Lifestyle Design Realty <{self.rules.team_email}>"


def test_closed_congrats_uses_team_email():
    """The closed congrats email must use team_email in From display."""
    main_path = os.path.join(os.path.dirname(__file__), "..", "src", "fub_automation", "main.py")
    with open(main_path) as f:
        source = f.read()
    # Find the closed_congrats send — it's near "Congratulations email sent"
    # The from_display should use team_email
    congrats_section = source[source.find("generate_congrats_email"):source.find("Congratulations email sent")]
    assert "self.rules.team_email" in congrats_section, \
        "closed_congrats send must use self.rules.team_email"
    assert "reply_to=self.rules.owner_email" in congrats_section, \
        "closed_congrats send must have reply_to=self.rules.owner_email"


def test_quarterly_checkin_uses_team_email():
    """The quarterly check-in (phase 3 closed drip) email must use team_email."""
    main_path = os.path.join(os.path.dirname(__file__), "..", "src", "fub_automation", "main.py")
    with open(main_path) as f:
        source = f.read()
    # Find the quarterly check-in send — near "Quarterly check-in email sent"
    checkin_section = source[source.find("closed_drip"):source.find("Quarterly check-in email sent")]
    assert "self.rules.team_email" in checkin_section, \
        "quarterly check-in send must use self.rules.team_email"
    assert "reply_to=self.rules.owner_email" in checkin_section, \
        "quarterly check-in send must have reply_to=self.rules.owner_email"


def test_long_term_nurture_uses_team_email():
    """The long-term nurture drip email must use team_email."""
    main_path = os.path.join(os.path.dirname(__file__), "..", "src", "fub_automation", "main.py")
    with open(main_path) as f:
        source = f.read()
    # Find the long-term nurture send — near "Long-term nurture drip email"
    nurture_section = source[source.find("long_term_nurture_drip"):source.find("Long-term nurture drip email")]
    assert "self.rules.team_email" in nurture_section, \
        "long-term nurture drip send must use self.rules.team_email"
    assert "reply_to=self.rules.owner_email" in nurture_section, \
        "long-term nurture drip send must have reply_to=self.rules.owner_email"


def test_welcome_email_uses_team_email():
    """The instant welcome email must use team_email in From display."""
    main_path = os.path.join(os.path.dirname(__file__), "..", "src", "fub_automation", "main.py")
    with open(main_path) as f:
        source = f.read()
    # Find the welcome email send
    welcome_section = source[source.find("send_instant_welcome_email"):]
    welcome_section = welcome_section[:welcome_section.find("Log a note in FUB")]
    assert "self.rules.team_email" in welcome_section, \
        "welcome email send must use self.rules.team_email"
    assert "reply_to=self.rules.owner_email" in welcome_section, \
        "welcome email send must have reply_to=self.rules.owner_email"


def test_agent_reminder_digest_uses_team_email():
    """The agent reminder digest (to agents) must also use team_email for consistency."""
    main_path = os.path.join(os.path.dirname(__file__), "..", "src", "fub_automation", "main.py")
    with open(main_path) as f:
        source = f.read()
    # The from_display in send_agent_reminder_digest should use team_email
    reminder_section = source[source.find("send_agent_reminder_digest"):]
    reminder_section = reminder_section[:reminder_section.find("bcc=")]
    assert "self.rules.team_email" in reminder_section, \
        "agent reminder digest must use self.rules.team_email in from_display"


def test_no_lead_facing_sends_use_owner_email_as_from():
    """No lead-facing send should use owner_email directly as from_email (only as reply_to)."""
    main_path = os.path.join(os.path.dirname(__file__), "..", "src", "fub_automation", "main.py")
    with open(main_path) as f:
        lines = f.readlines()

    # These are the INTERNAL sends that are allowed to use owner_email as from_email
    internal_functions = [
        "_send_speed_to_lead_agent_alert",
        "reassign_to_peter",
        "scan_reply_detection",
        "send_phase2_daily_summary",
    ]

    # Check that from_email=self.rules.owner_email only appears in internal functions
    for i, line in enumerate(lines):
        if "from_email=self.rules.owner_email" in line:
            # Find the enclosing method-level def (exactly 4-space indent, not nested)
            func_name = ""
            for j in range(i, -1, -1):
                if lines[j].startswith("    def "):
                    func_name = lines[j].strip()
                    break
            # Must be in an internal function
            is_internal = any(fn in func_name for fn in internal_functions)
            assert is_internal, \
                f"Line {i+1}: from_email=self.rules.owner_email found in non-internal function: {func_name}"


def test_syntax_valid():
    """The main.py file must have valid Python syntax after all changes."""
    main_path = os.path.join(os.path.dirname(__file__), "..", "src", "fub_automation", "main.py")
    with open(main_path) as f:
        source = f.read()
    try:
        ast.parse(source)
    except SyntaxError as e:
        raise AssertionError(f"main.py has syntax error: {e}")


if __name__ == "__main__":
    import pytest
    pytest.main([__file__, "-v"])
