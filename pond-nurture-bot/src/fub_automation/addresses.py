"""Which FUB deal text may be used as a client's home address in an email.

2026-11-06: a quarterly check-in told Alexandra Examplefamily her home was "at Alexandra
Examplefamily". The congrats and quarterly paths took the Buyers deal's `name` field
as the property address with no check, and agents often name a deal after the
client. The same unchecked string was also sent to Google Places to find
"spots near their home".

Rule: personalise with an address only when the text is shaped like a street
address and does not contain the client's own name. Anything uncertain is
dropped and the email falls back to general past-client language.
"""
from __future__ import annotations

import re
from typing import Iterable, Tuple

# This is a SYNTACTIC check only: "does this text look like a street address
# and nothing else?". It does not verify that the client owns or bought that
# property — FUB's deal name is free text and nothing here checks it against a
# property record. Callers say so in the FUB note ("from the deal name").
#
# Accepted shape: house number, street words ending in a street type, an
# optional unit, then optional ", City", ", TX", ", ZIP" parts. Anything after
# the street type that is not a unit or a city/state/zip part — deal or title
# text like "- Purchase", "(Buyer)", "Smith closing" — rejects the whole text.
_STREET_TYPES = {
    "st", "street", "dr", "drive", "rd", "road", "ave", "avenue", "ln", "lane", "ct", "court",
    "blvd", "boulevard", "way", "trl", "trail", "cir", "circle", "pl", "place", "pkwy",
    "parkway", "loop", "path", "run", "cv", "cove", "pass", "bnd", "bend", "xing", "crossing",
    "ter", "terrace", "hwy", "highway", "sq", "square", "pt", "point", "rdg", "ridge", "row",
    "walk", "holw", "hollow", "vw", "view", "gln", "glen", "hl", "hill", "hls", "hills",
    "mdw", "meadow", "mdws", "meadows", "crk", "creek", "spgs", "springs", "grv", "grove",
    "pk", "park", "aly", "alley", "fwy", "freeway", "lndg", "landing", "vly", "valley",
}
_STREET = re.compile(
    r"^(?P<num>\d{1,6}[A-Za-z]?)\s+(?:(?:N|S|E|W|NE|NW|SE|SW)\.?\s+)?"
    r"(?P<name>(?:[A-Za-z0-9.']+\s+){0,5}?)(?P<type>[A-Za-z]+)\.?"
    r"(?:\s+(?:N|S|E|W|NE|NW|SE|SW)\.?)?"
    r"(?:\s+(?:unit|apt|apartment|suite|ste|bldg|#)\s*[A-Za-z0-9-]+|\s+#[A-Za-z0-9-]+)?$",
    re.IGNORECASE,
)
_CITY_PART = re.compile(r"^[A-Za-z][A-Za-z .']{1,40}$")
_STATE_ZIP = re.compile(r"^(?:TX|Texas)(?:\s+\d{5}(?:-\d{4})?)?$|^\d{5}(?:-\d{4})?$", re.IGNORECASE)
_DEAL_WORDS = re.compile(
    r"\b(?:purchase|sale|sold|listing|buyer|seller|lease|rental|closed|closing|contract|offer|rep|deal|"
    r"refi|refinance|commission|lot|tbd|new build|construction)\b", re.IGNORECASE)


def _name_tokens(person: dict) -> Iterable[str]:
    for key in ("firstName", "lastName", "name"):
        for token in re.split(r"[\s,]+", str(person.get(key) or "")):
            token = token.strip(".'").lower()
            if len(token) >= 3:
                yield token


def property_address_or_blank(raw: object, person: dict) -> Tuple[str, str]:
    """(address, reason). address is "" unless the text is ONLY a street address.

    reason is "" for an accepted (syntactically plausible, unverified) address,
    else: empty, not_street_shaped, no_street_type, extra_text, contains_client_name.
    """
    text = re.sub(r"\s+", " ", str(raw or "")).strip()
    if not text:
        return "", "empty"
    if re.search(r"[@|/()\[\]:;]| - | – | — ", text) or _DEAL_WORDS.search(text):
        return "", "extra_text"
    parts = [p.strip() for p in text.split(",")]
    street = _STREET.match(parts[0])
    if not street:
        return "", ("not_street_shaped" if not re.match(r"^\d", parts[0]) else "extra_text")
    if street.group("type").lower().rstrip(".") not in _STREET_TYPES:
        return "", "no_street_type"
    # After the street: ", City", then only state/ZIP parts ("TX", "TX 78230", "78230").
    extras = parts[1:]
    if len(extras) > 3:
        return "", "extra_text"
    for i, extra in enumerate(extras):
        if _STATE_ZIP.match(extra or ""):
            continue
        if i == 0 and _CITY_PART.match(extra or "") and len(extra.split()) <= 3:
            continue
        return "", "extra_text"
    lowered = text.lower()
    for token in _name_tokens(person):
        if re.search(rf"\b{re.escape(token)}\b", lowered):
            return "", "contains_client_name"
    return text[:200], ""

