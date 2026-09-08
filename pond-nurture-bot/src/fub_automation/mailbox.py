"""Mailbox reply reader — the words FUB hides.

FUB's API returns the literal '[content hidden]' for the subject and body of
every synced email on this account (main.FUB_HIDDEN_CONTENT; measured in the
field dumps of 2026-08-24/28 and pinned in tests/test_reply_detection.py).
The reply-detection keyword scan therefore cannot see a typed UNSUBSCRIBE:
Stephen Herrera's (2026-08-23) classified as a human reply and needed a
manual trash; Ka Cp's (2026-09-08) was paused as "awaiting a human" and
paged Peter as a hot lead.

The mailbox the bot sends from (SMTP_USER — team@ is an alias on it, and it
is the Reply-To) receives the very same reply, unmasked. This module reads
it there over IMAP with the credentials the bot already holds for SMTP, so
the existing classifier gets the lead's actual words.

SCOPE, STATED PLAINLY

It is only ever asked for ONE message: the one FUB already showed us as an
inbound email on a lead's record, identified by that lead's own address(es)
and the timestamp FUB stamped on it. It never lists a mailbox, never reads
mail from anyone but the lead in question, opens the folder read-only, and
returns only the unquoted top of that message. The quoted history is cut
deliberately: every reply quotes our own email, whose footer contains the
word "unsubscribe" — scanning it would trash every lead who ever wrote back.

FAIL-OPEN, LOUDLY

No credentials, an unreachable host, a refused login, or a message the
mailbox does not hold all return None and leave the caller on today's
behaviour (the hidden placeholder, a human classification, a review). The
reader records why (`disabled_reason`, `last_outcome`) so the scan summary
and the hot-lead alert can say the words were unreadable rather than pretend
they were read. A failed login disables the reader for the rest of the
process — one warning, not one per lead.
"""
from __future__ import annotations

import datetime as dt
import email
import email.policy
import html as html_lib
import imaplib
import logging
import os
import re
import socket
from dataclasses import dataclass
from email.utils import parseaddr, parsedate_to_datetime
from typing import Callable, Dict, Iterable, List, Optional, Tuple

LOGGER = logging.getLogger("fub_automation")

IMAP_TIMEOUT_SECONDS = 30
#: FUB stamps `created` when its sync ingests the message, which can trail
#: the message's own Date header by minutes and, after an outage, hours.
DEFAULT_TOLERANCE = dt.timedelta(hours=12)
#: Newest candidates read per lookup. One lead rarely writes more than a
#: handful of emails in a day; this bounds the fetch on a chatty thread.
MAX_CANDIDATES = 25
#: Consecutive connection failures before the reader stops trying for the
#: rest of the process — an unreachable host must not cost 30s per lead.
CONNECTION_FAILURES_TO_DISABLE = 2

_OFF_VALUES = {"0", "false", "no", "off"}
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun",
           "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def derive_imap_host(smtp_host: Optional[str]) -> Optional[str]:
    """The IMAP endpoint that pairs with a known SMTP host, or None."""
    host = (smtp_host or "").strip().lower()
    if not host:
        return None
    if "gmail" in host or "google" in host:
        return "imap.gmail.com"
    if "office365" in host or "outlook" in host:
        return "outlook.office365.com"
    if host.startswith("smtp."):
        return "imap." + host[len("smtp."):]
    return None


@dataclass
class MailboxConfig:
    host: Optional[str] = None
    port: int = 993
    user: Optional[str] = None
    password: Optional[str] = None
    #: Folder to search. None = the server's \All folder when it advertises
    #: one (Gmail's "[Gmail]/All Mail", so an archived reply still counts),
    #: else INBOX.
    mailbox: Optional[str] = None
    disabled_reason: Optional[str] = None

    @property
    def enabled(self) -> bool:
        return not self.disabled_reason

    @classmethod
    def from_env(
        cls,
        env: Optional[Dict[str, str]] = None,
        *,
        smtp_host: Optional[str] = None,
        smtp_user: Optional[str] = None,
        smtp_password: Optional[str] = None,
    ) -> "MailboxConfig":
        env = os.environ if env is None else env
        if str(env.get("MAILBOX_REPLY_READ", "true")).strip().lower() in _OFF_VALUES:
            return cls(disabled_reason="MAILBOX_REPLY_READ is off")
        user = env.get("IMAP_USER") or smtp_user
        password = env.get("IMAP_PASSWORD") or smtp_password
        if not user or not password:
            return cls(disabled_reason=(
                "no mailbox credentials (set IMAP_USER/IMAP_PASSWORD, or "
                "SMTP_USER/SMTP_PASSWORD which the reader shares)"))
        host = env.get("IMAP_HOST") or derive_imap_host(smtp_host)
        if not host:
            return cls(disabled_reason="IMAP_HOST not set and not derivable from SMTP_HOST")
        try:
            port = int(env.get("IMAP_PORT") or 993)
        except ValueError:
            port = 993
        return cls(host=host, port=port, user=user, password=password,
                   mailbox=env.get("IMAP_MAILBOX") or None)


@dataclass
class FetchedReply:
    """One message read from the mailbox: the lead's own words."""

    subject: str
    #: The unquoted top of the message — what the lead typed.
    text: str
    date: Optional[dt.datetime]
    from_address: str
    message_id: str = ""
    in_reply_to: str = ""
    uid: str = ""
    full_text_length: int = 0
    folder: str = ""


# ── quote stripping ───────────────────────────────────────────────────────────

_QUOTE_HEADER_ENDINGS = (
    "wrote:", "a écrit :", "a écrit:", "schrieb:", "escribió:", "ha scritto:",
    "skrev:", "schreef:",
)
_QUOTE_HEADER_STARTS = ("On ", "Le ", "Am ", "El ", "Il ", "Den ", "Op ")
_SEPARATOR_PATTERNS = (
    re.compile(r"^-{2,}\s*(Original|Forwarded|Reply)?\s*(Message|message)?\s*-{2,}$", re.I),
    re.compile(r"^_{5,}$"),
    re.compile(r"^-{5,}$"),
)
_HEADER_BLOCK_START = re.compile(r"^(From|De|Von|Da|Van)\s*:\s*\S", re.I)
_HEADER_BLOCK_FOLLOW = re.compile(
    r"^(Sent|Date|To|Subject|Envoyé|À|Objet|Gesendet|An|Betreff|Enviado|Para|Asunto|Inviato|A|Oggetto)\s*:",
    re.I)
#: Our own plain-text footer, in case a client quotes without any marker.
_OWN_FOOTER_MARKERS = (
    "lifestyle design realty team",
    "information about brokerage services",
    "trec consumer protection notice",
    "if you no longer want market updates",
)


def strip_quoted_reply(text: str) -> str:
    """The lead's own words: everything above the quoted history.

    Cuts at the first of: a '>'-quoted line; an "On <date>, <who> wrote:"
    header (also when a client wraps it over two or three lines, and in the
    common non-English forms); an Outlook "From:/Sent:" header block; a
    separator rule; a '--' signature delimiter; or our own footer text. What
    is above the cut is returned with blank runs collapsed.
    """
    lines = (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    cut = len(lines)
    for index, raw in enumerate(lines):
        line = raw.strip()
        if not line:
            continue
        if line.startswith(">"):
            cut = index
            break
        if line == "--" or line == "-- ":
            cut = index
            break
        if any(pattern.match(line) for pattern in _SEPARATOR_PATTERNS):
            cut = index
            break
        lowered = line.lower()
        if lowered.upper().startswith("LIFESTYLE DESIGN REALTY") or any(
                marker in lowered for marker in _OWN_FOOTER_MARKERS):
            cut = index
            break
        if _HEADER_BLOCK_START.match(line):
            following = [l.strip() for l in lines[index + 1:index + 4]]
            if any(_HEADER_BLOCK_FOLLOW.match(f) for f in following):
                cut = index
                break
        if line.startswith(_QUOTE_HEADER_STARTS):
            window = line
            joined = [window]
            for extra in lines[index + 1:index + 3]:
                window = (window + " " + extra.strip()).strip()
                joined.append(window)
            if any(w.rstrip().endswith(_QUOTE_HEADER_ENDINGS) for w in joined):
                cut = index
                break
    top = "\n".join(lines[:cut]).strip()
    return re.sub(r"\n{3,}", "\n\n", top)


_BLOCKQUOTE = re.compile(r"<blockquote\b.*?</blockquote>", re.I | re.S)
_DROP_BLOCKS = re.compile(r"<(style|script|head)\b.*?</\1>", re.I | re.S)
_BREAKS = re.compile(r"<\s*(br|/p|/div|/tr|/li|/h[1-6]|/blockquote)\b[^>]*>", re.I)
_TAGS = re.compile(r"<[^>]+>")


def html_to_text(markup: str) -> str:
    """Plain text from an HTML body. Blockquotes go first: Gmail wraps the
    quoted history in one, so dropping them removes most of the quote before
    strip_quoted_reply sees the text."""
    body = _DROP_BLOCKS.sub(" ", markup or "")
    body = _BLOCKQUOTE.sub("\n", body)
    body = _BREAKS.sub("\n", body)
    body = _TAGS.sub(" ", body)
    body = html_lib.unescape(body)
    lines = [re.sub(r"[ \t\xa0]+", " ", line).strip() for line in body.split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def message_text(message: "email.message.EmailMessage") -> str:
    """The readable body of a parsed message, plain part preferred."""
    try:
        part = message.get_body(preferencelist=("plain", "html"))
    except Exception:  # noqa: BLE001 — a malformed part must not lose the reply
        part = None
    if part is None:
        candidates = [message] if not message.is_multipart() else list(message.walk())
        for candidate in candidates:
            if candidate.get_content_type() in ("text/plain", "text/html"):
                part = candidate
                break
    if part is None:
        return ""
    try:
        content = part.get_content()
    except Exception:  # noqa: BLE001
        payload = part.get_payload(decode=True) or b""
        content = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
    if not isinstance(content, str):
        content = str(content)
    if part.get_content_type() == "text/html":
        return html_to_text(content)
    return content


def imap_quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def imap_date(when: dt.datetime) -> str:
    """dd-Mon-yyyy with English month names whatever the locale."""
    return f"{when.day:02d}-{_MONTHS[when.month - 1]}-{when.year}"


def _parse_list_line(line: bytes) -> Tuple[set, str]:
    """('\\All \\HasNoChildren') "/" "[Gmail]/All Mail" -> flags, name."""
    text = line.decode("utf-8", errors="replace") if isinstance(line, bytes) else str(line)
    match = re.match(r'^\((?P<flags>[^)]*)\)\s+(?P<delim>"[^"]*"|NIL)\s+(?P<name>.+)$', text)
    if not match:
        return set(), ""
    flags = {f.lower() for f in match.group("flags").split()}
    name = match.group("name").strip()
    if name.startswith('"') and name.endswith('"'):
        name = name[1:-1].replace('\\"', '"').replace("\\\\", "\\")
    return flags, name


def default_connector(config: MailboxConfig):
    return imaplib.IMAP4_SSL(config.host, config.port, timeout=IMAP_TIMEOUT_SECONDS)


class _LoginRefused(Exception):
    """The server answered the login with NO — credentials, not connectivity."""


class MailboxReplyReader:
    """Reads one lead's reply out of the sending mailbox. See module doc."""

    def __init__(self, config: MailboxConfig,
                 connector: Optional[Callable[[MailboxConfig], object]] = None):
        self.config = config
        self.connector = connector or default_connector
        self.disabled_reason: Optional[str] = config.disabled_reason
        #: 'revealed' | 'not_found' | 'error' | 'disabled' for the last call.
        self.last_outcome: str = "disabled" if self.disabled_reason else "idle"
        self.last_error: Optional[str] = None
        self.stats: Dict[str, int] = {"lookups": 0, "revealed": 0, "not_found": 0, "errors": 0,
                                      "connections": 0}
        self._connection_failures = 0
        self._warned = False
        #: One connection per process, reused across lookups: the daily run
        #: asks for hundreds of leads' replies, and a login per lookup would
        #: trip Gmail's connection and login limits. Dropped and re-opened on
        #: any error (idle IMAP sessions get closed server-side).
        self._client = None
        self._folder: Optional[str] = None

    @classmethod
    def from_settings(cls, settings, env: Optional[Dict[str, str]] = None) -> "MailboxReplyReader":
        config = MailboxConfig.from_env(
            env,
            smtp_host=getattr(settings, "smtp_host", None),
            smtp_user=getattr(settings, "smtp_user", None),
            smtp_password=getattr(settings, "smtp_password", None),
        )
        return cls(config)

    @property
    def enabled(self) -> bool:
        return not self.disabled_reason

    def describe(self) -> str:
        if self.disabled_reason:
            return f"mailbox reader off: {self.disabled_reason}"
        # Host and folder only: this line ends up in run logs, and the repo is
        # public — the mailbox address stays out of it.
        return (f"mailbox reader on: {self.config.host}:{self.config.port} "
                f"({self.config.mailbox or 'auto folder'})")

    # ── the one operation ────────────────────────────────────────────────────
    def find_reply(
        self,
        addresses: Iterable[str],
        around: dt.datetime,
        tolerance: dt.timedelta = DEFAULT_TOLERANCE,
    ) -> Optional[FetchedReply]:
        """The message one of `addresses` sent closest to `around`, or None.

        `around` is FUB's `created` for the hidden inbound email. Candidates
        are the lead's messages since the day before it; the closest by Date
        header inside `tolerance` wins.
        """
        addresses = [a.strip().lower() for a in addresses if a and "@" in str(a)]
        if self.disabled_reason:
            self.last_outcome = "disabled"
            return None
        if not addresses:
            self.last_outcome = "not_found"
            self.last_error = "lead record carries no email address"
            return None
        self.stats["lookups"] += 1
        if around.tzinfo is None:
            around = around.replace(tzinfo=dt.timezone.utc)

        # A cached connection may have been closed server-side since the last
        # lookup; one retry on a fresh connection covers that without turning
        # a genuine outage into a loop.
        attempts = 2 if self._client is not None else 1
        for attempt in range(attempts):
            fresh = self._client is None
            try:
                return self._lookup(addresses, around, tolerance)
            except (imaplib.IMAP4.error, OSError, socket.timeout) as exc:
                self._drop_client()
                if not fresh and attempt == 0:
                    continue
                self.stats["errors"] += 1
                self.last_outcome = "error"
                self.last_error = f"{type(exc).__name__}: {exc}"
                self._connection_failures += 1
                if self._connection_failures >= CONNECTION_FAILURES_TO_DISABLE:
                    self._disable(f"mailbox unreachable ({self.last_error})")
                elif not self._warned:
                    LOGGER.warning("Mailbox reply reader: %s", self.last_error)
                    self._warned = True
                return None
            except _LoginRefused as exc:
                # A refused login will be refused for every lead: stop asking.
                self._drop_client()
                self._disable(f"IMAP login refused: {exc}")
                self.stats["errors"] += 1
                self.last_outcome = "error"
                self.last_error = self.disabled_reason
                return None
        return None

    def close(self) -> None:
        """Log out of the cached connection, if any. Safe to call repeatedly."""
        self._drop_client()

    def _drop_client(self) -> None:
        client, self._client, self._folder = self._client, None, None
        if client is not None:
            try:
                client.logout()
            except Exception:  # noqa: BLE001 — best effort
                pass

    def _connected(self):
        if self._client is None:
            client = self.connector(self.config)
            try:
                client.login(self.config.user, self.config.password)
            except imaplib.IMAP4.error as exc:
                try:
                    client.logout()
                except Exception:  # noqa: BLE001
                    pass
                raise _LoginRefused(str(exc)) from exc
            self.stats["connections"] += 1
            self._connection_failures = 0
            self._client = client
            self._folder = self._select_folder(client)
        return self._client, self._folder or "INBOX"

    def _lookup(self, addresses: List[str], around: dt.datetime,
                tolerance: dt.timedelta) -> Optional[FetchedReply]:
        client, folder = self._connected()
        candidates = self._search(client, addresses, around - dt.timedelta(days=1))
        best: Optional[Tuple[dt.timedelta, FetchedReply]] = None
        for uid in candidates[-MAX_CANDIDATES:]:
            fetched = self._fetch(client, uid, folder)
            if fetched is None:
                continue
            if fetched.from_address not in addresses:
                continue  # the server's FROM search is fuzzy; ours is exact
            if fetched.date is None:
                continue
            distance = abs(fetched.date - around)
            if distance > tolerance:
                continue
            if best is None or distance < best[0]:
                best = (distance, fetched)
        if best is None:
            self.stats["not_found"] += 1
            self.last_outcome = "not_found"
            self.last_error = (f"no message from the lead within "
                               f"{tolerance} of {around.isoformat()} in {folder}")
            return None
        self.stats["revealed"] += 1
        self.last_outcome = "revealed"
        self.last_error = None
        return best[1]

    # ── pieces ───────────────────────────────────────────────────────────────
    def _disable(self, reason: str) -> None:
        self.disabled_reason = reason
        LOGGER.warning("Mailbox reply reader disabled for this run: %s", reason)

    def _select_folder(self, client) -> str:
        name = self.config.mailbox
        if not name:
            name = "INBOX"
            try:
                typ, lines = client.list()
                if typ == "OK":
                    for line in lines or []:
                        flags, folder = _parse_list_line(line)
                        if "\\all" in flags and folder:
                            name = folder
                            break
            except (imaplib.IMAP4.error, OSError):
                name = "INBOX"
        typ, _ = client.select(imap_quote(name), readonly=True)
        if typ != "OK" and name != "INBOX":
            client.select(imap_quote("INBOX"), readonly=True)
            name = "INBOX"
        return name

    def _search(self, client, addresses: List[str], since: dt.datetime) -> List[str]:
        uids: List[str] = []
        seen = set()
        for address in addresses:
            typ, data = client.uid("SEARCH", "SINCE", imap_date(since), "FROM", imap_quote(address))
            if typ != "OK" or not data:
                continue
            for chunk in data:
                if not chunk:
                    continue
                text = chunk.decode() if isinstance(chunk, bytes) else str(chunk)
                for uid in text.split():
                    if uid not in seen:
                        seen.add(uid)
                        uids.append(uid)
        # Numeric UIDs ascend with arrival; keep that order so the tail is newest.
        return sorted(uids, key=lambda u: int(u) if u.isdigit() else 0)

    def _fetch(self, client, uid: str, folder: str) -> Optional[FetchedReply]:
        typ, data = client.uid("FETCH", uid, "(BODY.PEEK[])")
        if typ != "OK" or not data:
            return None
        raw = b""
        for item in data:
            if isinstance(item, tuple) and len(item) >= 2 and isinstance(item[1], (bytes, bytearray)):
                raw = bytes(item[1])
                break
        if not raw:
            return None
        message = email.message_from_bytes(raw, policy=email.policy.default)
        date: Optional[dt.datetime] = None
        try:
            parsed = parsedate_to_datetime(message.get("Date") or "")
            if parsed is not None:
                date = parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.timezone.utc)
                date = date.astimezone(dt.timezone.utc)
        except (TypeError, ValueError):
            date = None
        full = message_text(message)
        return FetchedReply(
            subject=str(message.get("Subject") or "").strip(),
            text=strip_quoted_reply(full),
            date=date,
            from_address=parseaddr(str(message.get("From") or ""))[1].strip().lower(),
            message_id=str(message.get("Message-ID") or "").strip(),
            in_reply_to=str(message.get("In-Reply-To") or "").strip(),
            uid=str(uid),
            full_text_length=len(full),
            folder=folder,
        )


__all__ = [
    "DEFAULT_TOLERANCE", "FetchedReply", "MailboxConfig", "MailboxReplyReader",
    "derive_imap_host", "html_to_text", "imap_date", "imap_quote", "message_text",
    "strip_quoted_reply",
]
