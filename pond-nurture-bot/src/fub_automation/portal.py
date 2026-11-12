"""Portal-only email suppression; never inspect communication content.

The loader is injected so callers and tests use the same gate without coupling
matching to a network transport. Only explicitly named provenance is considered.
"""
from dataclasses import dataclass
import ipaddress
import re
from typing import Callable, Optional
from urllib.parse import parse_qsl, unquote, urlsplit

PORTAL_SOURCES = ("zillow", "realtor.com")
PORTAL_TAGS = ("zillow", "realtor.com", "realtor com", "realtordotcom", "realtor dot com")
PORTAL_EXCLUDED = "portal_source_excluded"
PORTAL_FRESH_UNAVAILABLE = "portal_fresh_person_unavailable"
PORTAL_PERSON_ID_UNUSABLE = "portal_person_id_unusable"
PORTAL_HISTORY_UNAVAILABLE = "portal_history_unavailable"
PORTAL_HISTORY_INCOMPLETE = "portal_history_incomplete"
_REALTOR_FORM = r"(?:realtor com|realtordotcom|realtor dot com)\b"
_SCALAR_FIELDS = ("originalSource", "eventSource")
_OBJECT_FIELDS = ("original", "event", "originalProvenance", "eventProvenance")
_ARRAY_FIELDS = ("events", "provenance")
_MAX_SAFE_PERSON_ID = 9007199254740991
_MISSING = object()
_UNREADABLE = object()


def normalize_source(value: object) -> str:
    if not isinstance(value, str):
        return ""
    value = value.lower().translate(str.maketrans("", "", "™®℠"))
    return re.sub(r"[\W_]+", " ", value).strip()


def portal_source(value: object) -> bool:
    normalized = normalize_source(value)
    return "zillow" in normalized or bool(re.search(_REALTOR_FORM, normalized))


def portal_tag(value: object) -> bool:
    normalized = normalize_source(value)
    return normalized.startswith("zillow") or bool(re.match(_REALTOR_FORM, normalized))


@dataclass(frozen=True)
class ProvenanceMetadata:
    portal: bool
    usable: bool


def inspect_portal_url(value: object) -> ProvenanceMetadata:
    """Classify provenance hosts, not navigability; never inspect URL content.

    A clear portal authority cannot be hidden by noncanonical scheme slashes
    or a bad port. An unreadable nonblank host is unusable, never safe evidence.
    Raw backslashes delimit HTTP-style authority before userinfo is considered;
    percent-encoded host separators remain invalid after strict decoding.
    """
    if value is None or (isinstance(value, str) and not value.strip()):
        return ProvenanceMetadata(False, True)
    if not isinstance(value, str):
        return ProvenanceMetadata(False, False)
    value = value.strip().replace("\\", "/")
    http_scheme = re.match(r"^https?:", value, re.IGNORECASE)
    other_scheme = re.match(r"^[a-z][a-z0-9+.-]*://", value, re.IGNORECASE)
    if http_scheme:
        value = value[http_scheme.end():].lstrip("/")
    elif other_scheme:
        value = value[other_scheme.end():].lstrip("/")
    elif value.startswith("//"):
        value = value.lstrip("/")
    authority = re.split(r"[/?#]", value, maxsplit=1)[0].rsplit("@", 1)[-1]
    if not authority or re.search(r"\s|[\x00-\x1f\x7f]", authority):
        return ProvenanceMetadata(False, False)
    if authority.startswith("["):
        bracketed = re.fullmatch(r"\[([^\[\]]+)\](?::[^:]*)?", authority)
        if bracketed:
            try:
                ipaddress.IPv6Address(bracketed.group(1))
                return ProvenanceMetadata(False, True)
            except ValueError:
                pass
        return ProvenanceMetadata(False, False)
    if authority.count(":") > 1 or "[" in authority or "]" in authority:
        return ProvenanceMetadata(False, False)
    host = authority.split(":", 1)[0]
    try:
        if re.search(r"%(?![0-9a-fA-F]{2})", host):
            return ProvenanceMetadata(False, False)
        host = unquote(host, encoding="utf-8", errors="strict")
        # IDNA treats these Unicode dots as DNS separators. Strip repeated
        # root dots conservatively without deleting any internal punctuation.
        host = host.translate(str.maketrans({"。": ".", "．": ".", "｡": "."})).rstrip(".")
        host = host.encode("idna").decode("ascii").lower()
        labels = host.split(".")
        if len(host) > 253 or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                                  for label in labels):
            return ProvenanceMetadata(False, False)
        if len(labels) < 2 and host != "localhost":
            return ProvenanceMetadata(False, False)
    except (ValueError, UnicodeError):
        return ProvenanceMetadata(False, False)
    matched = any(host == domain or host.endswith("." + domain)
                  for domain in ("zillow.com", "realtor.com"))
    return ProvenanceMetadata(matched, True)


def portal_url(value: object) -> bool:
    """Retain the public boolean matcher; inspectors also use URL usability."""
    return inspect_portal_url(value).portal


def _read(record: dict, key: str) -> object:
    """Read one whitelisted property, never enumerate arbitrary customer data."""
    try:
        return record[key] if key in record else _MISSING
    except Exception:
        return _UNREADABLE


def inspect_provenance_metadata(provenance: object) -> ProvenanceMetadata:
    """Inspect only source metadata; malformed siblings cannot hide portal proof.

    Missing/null and unrelated top-level snapshots are absent; explicitly named
    nested provenance records and source objects must have a known shape.
    Only originalSource/eventSource source objects permit a `name` property;
    a person's own name and all communication/payload fields are never read.
    """
    seen = set()
    found_portal = False
    usable = True

    def scalar(value: object, matcher: Callable[[object], bool]) -> None:
        nonlocal found_portal, usable
        if value is _MISSING or value is None:
            return
        if not isinstance(value, str):
            usable = False
            return
        try:
            found_portal = matcher(value) or found_portal
        except Exception:
            usable = False

    def source_object(value: object) -> None:
        nonlocal usable
        if value is _MISSING or value is None:
            return
        if isinstance(value, str):
            scalar(value, portal_source)
            return
        if not isinstance(value, dict):
            usable = False
            return
        known = False
        # `name` is safe ONLY within an explicitly identified source object.
        for key in ("name", "source", "leadSource"):
            field = _read(value, key)
            known = known or field is not _MISSING
            scalar(field, portal_source)
        if not known:
            usable = False

    def visit(record: object, *, require_shape: bool = False) -> None:
        nonlocal found_portal, usable
        if not isinstance(record, dict):
            usable = False
            return
        identity = (id(record), require_shape)
        if identity in seen:
            return
        seen.add(identity)
        known = False
        native = _read(record, "isZillowPACLead")
        known = native is not _MISSING
        if native is True:
            found_portal = True
        elif native is not _MISSING and native is not None and native is not False:
            usable = False
        for key in ("source", "leadSource", "sourceUrl"):
            value = _read(record, key)
            known = known or value is not _MISSING
            if key == "sourceUrl" and value is not _MISSING:
                try:
                    url_metadata = inspect_portal_url(value)
                    found_portal = url_metadata.portal or found_portal
                    usable = url_metadata.usable and usable
                except Exception:
                    usable = False
            else:
                scalar(value, portal_source)
        tags = _read(record, "tags")
        known = known or tags is not _MISSING
        if tags is not _MISSING and tags is not None:
            if not isinstance(tags, (list, tuple)):
                usable = False
            else:
                try:
                    for tag in tags:
                        if isinstance(tag, dict):
                            name = _read(tag, "name")
                            if not isinstance(name, str):
                                usable = False
                            scalar(name, portal_tag)
                        elif isinstance(tag, str):
                            scalar(tag, portal_tag)
                        else:
                            usable = False
                except Exception:
                    usable = False
        for key in _SCALAR_FIELDS:
            value = _read(record, key)
            known = known or value is not _MISSING
            source_object(value)
        for key in _OBJECT_FIELDS:
            value = _read(record, key)
            known = known or value is not _MISSING
            if value is not _MISSING and value is not None:
                visit(value, require_shape=True)
        for key in _ARRAY_FIELDS:
            value = _read(record, key)
            known = known or value is not _MISSING
            if value is _MISSING or value is None:
                continue
            if not isinstance(value, (list, tuple)):
                usable = False
                continue
            try:
                for item in value:
                    visit(item, require_shape=True)
            except Exception:
                usable = False
        if require_shape and not known:
            usable = False

    if isinstance(provenance, (list, tuple)):
        # Top-level lists are explicit caller snapshots, not customer payloads.
        snapshots_seen = set()
        def snapshots(values: object) -> None:
            nonlocal usable
            if id(values) in snapshots_seen:
                return
            snapshots_seen.add(id(values))
            try:
                for value in values:
                    if isinstance(value, (list, tuple)):
                        snapshots(value)
                    elif value is not None:
                        visit(value)
            except Exception:
                usable = False
        snapshots(provenance)
    elif provenance is not None:
        visit(provenance)
    return ProvenanceMetadata(found_portal, usable)


def has_portal_provenance(provenance: object) -> bool:
    return inspect_provenance_metadata(provenance).portal


def provenance_metadata_usable(provenance: object) -> bool:
    """Validate current or explicitly loaded provenance without identity inference."""
    return inspect_provenance_metadata(provenance).usable


@dataclass(frozen=True)
class PortalSendDecision:
    allowed: bool
    reason: Optional[str] = None


def valid_person_id(value: object) -> Optional[int]:
    """Accept positive integral IDs or canonical decimal strings, never coerce."""
    if type(value) is int:
        return value if 0 < value <= _MAX_SAFE_PERSON_ID else None
    if isinstance(value, str) and re.fullmatch(r"[1-9][0-9]{0,15}", value):
        parsed = int(value)
        return parsed if parsed <= _MAX_SAFE_PERSON_ID else None
    return None


_valid_person_id = valid_person_id


def selected_person_identity_usable(person: object, person_id: object) -> bool:
    """Validate the selected PERSON's original identity, never an event identity."""
    pid = valid_person_id(person_id)
    return (pid is not None and isinstance(person, dict)
            and valid_person_id(_read(person, "id")) == pid)


def current_person_metadata_usable(person: object, person_id: object) -> bool:
    """Require matching genuine identity and a present source/leadSource field."""
    pid = _valid_person_id(person_id)
    if pid is None or not isinstance(person, dict):
        return False
    if _valid_person_id(_read(person, "id")) != pid:
        return False
    if all(_read(person, key) is _MISSING for key in ("source", "leadSource")):
        return False
    return provenance_metadata_usable(person)


# Keep the pre-existing private helper available for local callers/tests.
_usable_current_person = current_person_metadata_usable


@dataclass(frozen=True)
class PortalHistoryDecision(PortalSendDecision):
    pages: int = 0
    rows: int = 0


def _safe_integer(value: object, *, positive: bool = False) -> bool:
    return (type(value) is int and (1 if positive else 0) <= value
            <= _MAX_SAFE_PERSON_ID)


def _history_link_cursor(value: str, person_id: int) -> Optional[str]:
    """Extract a cursor only; never navigate a server-supplied URL."""
    try:
        if re.search(r"[\s\\\x00-\x1f\x7f]|%(?![0-9a-fA-F]{2})", value):
            return None
        link = urlsplit(value)
        if (link.scheme != "https" or link.netloc != "api.followupboss.com"
                or link.path != "/v1/events" or link.fragment):
            return None
        pairs = parse_qsl(link.query, keep_blank_values=True, strict_parsing=True,
                          encoding="utf-8", errors="strict")
        params = dict(pairs)
        if (len(params) != len(pairs) or set(params) - {"personId", "limit", "next"}
                or params.get("personId") != str(person_id)
                or ("limit" in params and params["limit"] != "100")):
            return None
        cursor = params.get("next")
        return cursor if isinstance(cursor, str) and cursor.strip() else None
    except Exception:
        return None


def scan_portal_event_history(person_id: object,
                             event_page_loader: Optional[Callable[..., object]]) -> PortalHistoryDecision:
    """Validate at most five own-person, unfiltered API event pages.

    Only explicit scalar event source is evidence. Pagination completeness is
    limited to API-accessible events: FUB documents additional UI-only events.
    No cache, transport, persistence, exception text or identifier logging.
    The loader receives fixed person scope and only a cursor OR an offset.
    """
    pid = valid_person_id(person_id)
    if pid is None or not callable(event_page_loader):
        return PortalHistoryDecision(False, PORTAL_HISTORY_UNAVAILABLE)
    seen_ids = set()
    seen_cursors = set()
    total = None
    cursor = None
    offset = None
    pages = rows = 0

    def decision(reason: Optional[str]) -> PortalHistoryDecision:
        return PortalHistoryDecision(reason is None, reason, pages, rows)

    for _ in range(5):
        try:
            page = event_page_loader(pid, next_cursor=cursor, offset=offset)
        except Exception:
            return decision(PORTAL_HISTORY_UNAVAILABLE)
        pages += 1
        if page is None:
            return decision(PORTAL_HISTORY_UNAVAILABLE)
        if not isinstance(page, dict):
            return decision(PORTAL_HISTORY_INCOMPLETE)
        events = _read(page, "events")
        if not isinstance(events, list):
            return decision(PORTAL_HISTORY_INCOMPLETE)
        try:
            event_count = len(events)
            malformed = event_count > 100
        except Exception:
            event_count = None
            malformed = True
        found_portal = False
        try:
            for event in events:
                rows += 1
                if not isinstance(event, dict):
                    malformed = True
                    continue
                event_id = _read(event, "id")
                event_pid = _read(event, "personId")
                source = _read(event, "source")
                own_person = _safe_integer(event_pid, positive=True) and event_pid == pid
                # A malformed sibling or event ID cannot hide readable own-person
                # portal source. A missing/mismatched person ID is never evidence.
                if own_person and isinstance(source, str):
                    try:
                        found_portal = portal_source(source) or found_portal
                    except Exception:
                        malformed = True
                if (not _safe_integer(event_id, positive=True) or not own_person
                        or (source is not None and not isinstance(source, str))):
                    malformed = True
                    continue
                if event_id in seen_ids:
                    malformed = True
                seen_ids.add(event_id)
        except Exception:
            malformed = True
        if found_portal:
            return decision(PORTAL_EXCLUDED)
        if malformed:
            return decision(PORTAL_HISTORY_INCOMPLETE)
        metadata = _read(page, "_metadata")
        if not isinstance(metadata, dict):
            return decision(PORTAL_HISTORY_INCOMPLETE)
        collection = _read(metadata, "collection")
        page_total = _read(metadata, "total")
        if (not isinstance(collection, str) or collection != "events"
                or not _safe_integer(page_total)
                or (total is not None and page_total != total)):
            return decision(PORTAL_HISTORY_INCOMPLETE)
        total = page_total
        has_more = False
        for record in (page, metadata):
            for flag in ("truncated", "incomplete", "restricted", "hasMore"):
                value = _read(record, flag)
                # Explicit null is an unknown partial-read signal, not absence.
                if value is _MISSING or value is False:
                    continue
                if value is not True or flag != "hasMore":
                    return decision(PORTAL_HISTORY_INCOMPLETE)
                has_more = True
        next_cursor = _read(metadata, "next")
        if next_cursor is not _MISSING and next_cursor is not None and not isinstance(next_cursor, str):
            return decision(PORTAL_HISTORY_INCOMPLETE)
        next_cursor = (next_cursor if isinstance(next_cursor, str) and next_cursor.strip()
                       else None)
        if next_cursor is None:
            link = _read(metadata, "nextLink")
            if link is not _MISSING and link is not None:
                if not isinstance(link, str):
                    return decision(PORTAL_HISTORY_INCOMPLETE)
                if link.strip():
                    next_cursor = _history_link_cursor(link, pid)
                    if next_cursor is None:
                        return decision(PORTAL_HISTORY_INCOMPLETE)
        if len(seen_ids) > total:
            return decision(PORTAL_HISTORY_INCOMPLETE)
        if next_cursor is not None:
            if (event_count == 0 or len(seen_ids) == total or next_cursor in seen_cursors):
                return decision(PORTAL_HISTORY_INCOMPLETE)
            seen_cursors.add(next_cursor)
            cursor, offset = next_cursor, None
        elif len(seen_ids) < total:
            if event_count != 100:
                return decision(PORTAL_HISTORY_INCOMPLETE)
            cursor, offset = None, len(seen_ids)
        elif has_more:
            return decision(PORTAL_HISTORY_INCOMPLETE)
        else:
            return decision(None)
    return decision(PORTAL_HISTORY_INCOMPLETE)


def portal_email_gate(person_id: object, current_person_loader: Callable[[int], object],
                      already_loaded_provenance: object = None, *,
                      selected_person: object = _MISSING,
                      event_page_loader: Optional[Callable[..., object]] = None) -> PortalSendDecision:
    """Read CURRENT person for every contact email; refuse portal/unusable reads.

    No caching, writes, claims, sent records, notes, or transport-success sentinel.
    Caller must return before email bookkeeping on refusal and release any claim.
    """
    loaded = inspect_provenance_metadata(already_loaded_provenance)
    pid = _valid_person_id(person_id)
    if (pid is None or (selected_person is not _MISSING
                       and not selected_person_identity_usable(selected_person, pid))):
        return PortalSendDecision(False, PORTAL_EXCLUDED if loaded.portal
                                  else PORTAL_PERSON_ID_UNUSABLE)
    try:
        current = current_person_loader(pid)
    except Exception:
        current = None
    fresh = inspect_provenance_metadata(current)
    if fresh.portal or loaded.portal:
        return PortalSendDecision(False, PORTAL_EXCLUDED)
    if not current_person_metadata_usable(current, pid) or not loaded.usable:
        return PortalSendDecision(False, PORTAL_FRESH_UNAVAILABLE)
    return scan_portal_event_history(pid, event_page_loader)
