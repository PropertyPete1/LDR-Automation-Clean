"""The "Hey Ka," defect (2026-09-08): a pond nurture email greeted a lead by
the two-letter fragment FUB held as her first name (firstName "Ka", lastName
"Cp" — Katryna, truncated before the bot ever saw the record). Every email
track passed FUB's field straight into the prompt; only an EMPTY field fell
back to "there". These tests pin the one helper that now decides.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from fub_automation.names import greeting_first_name, looks_like_fragment  # noqa: E402


def _p(first, last=""):
    return {"id": 1931, "firstName": first, "lastName": last}


def test_the_ka_cp_record_greets_there():
    """The live case, field for field."""
    assert greeting_first_name(_p("Ka", "Cp")) == "there"
    assert greeting_first_name(_p("Ka", "Cp"), first_token_only=True) == "there"
    assert "fragment" in looks_like_fragment(_p("Ka", "Cp"))


def test_a_full_first_name_is_used_as_written():
    assert greeting_first_name(_p("Katryna", "Cp")) == "Katryna"
    assert greeting_first_name(_p("Katryna", "")) == "Katryna"
    assert looks_like_fragment(_p("Katryna", "Cp")) is None


@pytest.mark.parametrize("first, last", [
    ("Al", "Smith"), ("Jo", "Reyes"), ("Bo", "Nguyen"), ("Ed", "Ochoa"), ("Ty", "Lee"),
])
def test_real_two_letter_names_survive_when_the_surname_is_real(first, last):
    assert greeting_first_name(_p(first, last)) == first


@pytest.mark.parametrize("first, last", [
    ("Jo", ""),        # two letters and nothing else on the record
    ("Al", "X"),       # initials on both sides
    ("J", "D"),
    ("K.", "Cp"),
    ("Cp", "Ka"),      # no vowel at all
    ("Mr", "Smith"),
    ("K", "Smith"),
])
def test_fragments_and_initials_greet_there(first, last):
    assert greeting_first_name(_p(first, last)) == "there"


@pytest.mark.parametrize("first", [
    "", None, "Unknown", "N/A", "test", "Lead", "Homeowner", "info",
    "katryna@example.com", "Lead 4471", "12345",
])
def test_placeholders_and_non_names_greet_there(first):
    assert greeting_first_name(_p(first, "Cp")) == "there"


def test_case_is_normalised_only_when_the_field_is_one_case():
    assert greeting_first_name(_p("KATRYNA", "CP")) == "Katryna"
    assert greeting_first_name(_p("katryna", "cp")) == "Katryna"
    assert greeting_first_name(_p("McKenna", "Ross")) == "McKenna"
    assert greeting_first_name(_p("DeAndre", "Hill")) == "DeAndre"
    assert greeting_first_name(_p("mary-ann", "cole")) == "Mary-Ann"
    assert greeting_first_name(_p("o'neil", "b")) == "O'Neil"


def test_two_word_first_names_keep_both_words_for_email_and_one_for_sms():
    assert greeting_first_name(_p("Mary Ann", "Cole")) == "Mary Ann"
    assert greeting_first_name(_p("Mary Ann", "Cole"), first_token_only=True) == "Mary"


def test_a_trailing_initial_in_the_first_name_field_is_dropped():
    assert greeting_first_name(_p("Katryna C.", "")) == "Katryna"
    assert greeting_first_name(_p("Katryna Cp", "")) == "Katryna"


def test_surrounding_whitespace_and_tags_shapes_do_not_matter():
    assert greeting_first_name(_p("  Katryna  ", " Cp ")) == "Katryna"
    assert greeting_first_name({"firstName": None, "lastName": None}) == "there"
    assert greeting_first_name({}) == "there"
