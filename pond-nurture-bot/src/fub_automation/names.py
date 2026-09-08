"""Greeting-safe first names.

FUB's firstName is whatever the lead source wrote there. On 2026-09-08 a pond
nurture email opened "Hey Ka," because the record read firstName "Ka",
lastName "Cp" — a fragment of Katryna that the form or import that created
her had already truncated before the bot ever saw it. The bot greeted the
fragment faithfully: every email track passed the field straight into the
prompt with "there" as the only fallback, and only for an EMPTY field.

greeting_first_name() is the one place that decides whether a stored first
name is fit to open an email or a text with. It is deliberately conservative:
a real two-letter name (Al, Jo, Bo, Ed, Ty) survives as long as the record
also carries a real surname; a record that is initials or fragments on both
sides ("Ka Cp", "J D", "K."), a name with no vowel, a placeholder ("Unknown",
"Test"), or anything with digits or an @ in it greets "there" instead —
which is what a person would write when they are not sure of the name.
"""
from __future__ import annotations

from typing import Optional

#: What every greeting falls back to. The prompts already say "Hey there,"
#: for an empty first name; this keeps that one convention.
NEUTRAL_GREETING_NAME = "there"

#: Values that are placeholders, not people. Lower-cased, whole-field match.
PLACEHOLDER_NAMES = frozenset({
    "unknown", "n/a", "na", "none", "null", "nil", "test", "testing", "lead",
    "buyer", "seller", "homeowner", "owner", "client", "customer", "user",
    "guest", "friend", "no name", "noname", "name", "first", "first name",
    "firstname", "anonymous", "prospect", "contact", "resident", "occupant",
    "sir", "madam", "mr", "mrs", "ms", "dr", "info", "admin", "hello",
})

_VOWELS = set("aeiouy")


def _alpha(text: str) -> str:
    return "".join(ch for ch in text if ch.isalpha())


def _is_fragment_token(token: str) -> bool:
    """A token that reads as an initial or a fragment rather than a name:
    one or two letters, or an initial with its period ("K.")."""
    letters = _alpha(token)
    return len(letters) <= 2 or token.rstrip(".") != token and len(letters) <= 3


def _normalise_case(token: str) -> str:
    """"KATRYNA" -> "Katryna", "katryna" -> "Katryna", "McKenna" untouched.

    Hyphenated and apostrophe'd parts are capitalised separately
    ("mary-ann" -> "Mary-Ann", "o'neil" -> "O'Neil") only when the whole
    token arrived in one case; a deliberately mixed-case name is the lead's
    own spelling and is kept as is.
    """
    if not (token.isupper() or token.islower()):
        return token

    def cap(part: str) -> str:
        return part[:1].upper() + part[1:].lower() if part else part

    return "-".join("'".join(cap(p) for p in piece.split("'")) for piece in token.split("-"))


def greeting_first_name(person: dict, first_token_only: bool = False) -> str:
    """The first name to open an email or text with, or "there".

    `first_token_only` is for the SMS templates and the agent digest, which
    have always used the first word only ("Mary Ann" texts as "Mary"); the
    email prompts receive the whole field so a two-word first name survives.
    """
    raw = str(person.get("firstName") or "").strip()
    last = str(person.get("lastName") or "").strip()
    if not raw:
        return NEUTRAL_GREETING_NAME
    if "@" in raw or any(ch.isdigit() for ch in raw):
        return NEUTRAL_GREETING_NAME
    if raw.lower().strip(".") in PLACEHOLDER_NAMES:
        return NEUTRAL_GREETING_NAME

    tokens = raw.split()
    if first_token_only:
        tokens = tokens[:1]
    else:
        # "Katryna C." / "Mary A" — a trailing initial is not part of the
        # first name, whichever field it was typed into.
        while len(tokens) > 1 and _is_fragment_token(tokens[-1]):
            tokens.pop()
    candidate = " ".join(tokens)
    letters = _alpha(candidate)
    if not letters:
        return NEUTRAL_GREETING_NAME
    if candidate.lower().strip(".") in PLACEHOLDER_NAMES:
        return NEUTRAL_GREETING_NAME
    if not (_VOWELS & set(letters.lower())):
        return NEUTRAL_GREETING_NAME          # "Cp", "Kt", "Mr"
    if len(letters) == 1:
        return NEUTRAL_GREETING_NAME          # "K", "K."
    if len(letters) <= 2 and (len(_alpha(last)) <= 2 or not _VOWELS & set(_alpha(last).lower())):
        # "Ka Cp", "Jo" with no surname, "Al X": initials or fragments on
        # both sides. "Al Smith" keeps his name.
        return NEUTRAL_GREETING_NAME
    if candidate.rstrip(".") != candidate and len(letters) <= 3:
        return NEUTRAL_GREETING_NAME          # "Kat." — an abbreviation
    return " ".join(_normalise_case(tok) for tok in candidate.split())


def looks_like_fragment(person: dict) -> Optional[str]:
    """Why a record would NOT be greeted by name, for logs and audits; None
    when the stored first name is usable as is."""
    raw = str(person.get("firstName") or "").strip()
    if not raw:
        return "empty first name"
    if greeting_first_name(person) == NEUTRAL_GREETING_NAME:
        return f"first name {raw!r} reads as a fragment, initial or placeholder"
    return None

