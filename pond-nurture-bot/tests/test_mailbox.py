"""The mailbox bridge (mailbox.py): reading a lead's reply out of the sending
mailbox when FUB hides its content. No network — a fake IMAP client stands in
for imaplib, built from the shapes imaplib actually returns.
"""
from __future__ import annotations

import datetime as dt
import email.message
import imaplib
import sys
from email.utils import format_datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from fub_automation import mailbox as mb  # noqa: E402

UTC = dt.timezone.utc
NOW = dt.datetime(2026, 9, 8, 17, 30, tzinfo=UTC)

OUR_EMAIL = """Hey Ka,

Hope the week is treating you well! Austin inventory is finally loosening up a bit.

Is a fall move still on the table for you?

Cheers,
The LDR Team

--
LIFESTYLE DESIGN REALTY

The Lifestyle Design Realty Team
team@lifestyledesignrealty.com
lifestyledesignrealty.com

Information About Brokerage Services: https://www.trec.texas.gov/x
TREC Consumer Protection Notice: https://www.trec.texas.gov/y
1212 Chicon St, Suite 101, Austin, TX 78702

If you no longer want market updates from us, reply UNSUBSCRIBE and we will remove you from future marketing emails.
"""


def quoted(text: str) -> str:
    return "\n".join("> " + line for line in text.splitlines())


# ── strip_quoted_reply ───────────────────────────────────────────────────────

def test_gmail_quote_header_and_quoted_history_are_cut():
    reply = ("Unsubscribe\n\nOn Tue, Sep 8, 2026 at 11:50 AM Lifestyle Design Realty "
             "<team@lifestyledesignrealty.com> wrote:\n" + quoted(OUR_EMAIL))
    assert mb.strip_quoted_reply(reply) == "Unsubscribe"


def test_a_wrapped_on_wrote_header_is_still_a_cut():
    reply = ("Yes, still looking!\n\nOn Tue, Sep 8, 2026 at 11:50 AM Lifestyle Design Realty <\n"
             "team@lifestyledesignrealty.com> wrote:\n" + quoted(OUR_EMAIL))
    assert mb.strip_quoted_reply(reply) == "Yes, still looking!"


def test_outlook_header_block_is_cut():
    reply = ("Please stop.\n\n________________________________\nFrom: Lifestyle Design Realty\n"
             "Sent: Tuesday, September 8, 2026 11:50 AM\nTo: ka@example.com\n"
             "Subject: Your next home in Austin\n\n" + OUR_EMAIL)
    assert mb.strip_quoted_reply(reply) == "Please stop."


def test_our_footer_quoted_without_any_marker_is_still_cut():
    """The trap this exists for: OUR footer says 'reply UNSUBSCRIBE'. A client
    that quotes without '>' or a header must not turn every reply into an
    opt-out."""
    reply = "Thanks, is the Elm house still available?\n\n" + OUR_EMAIL
    top = mb.strip_quoted_reply(reply)
    assert top.startswith("Thanks, is the Elm house still available?")
    # Without a marker the quoted prose is indistinguishable from the lead's;
    # the footer, which is what carries the dangerous word, must still go.
    assert "unsubscribe" not in top.lower()
    assert "brokerage services" not in top.lower()


def test_signature_delimiter_and_original_message_rule_cut():
    assert mb.strip_quoted_reply("Stop\n-- \nKa\n") == "Stop"
    assert mb.strip_quoted_reply("Stop\n\n-----Original Message-----\nFrom: x\n") == "Stop"


def test_plain_text_without_a_quote_is_returned_whole():
    assert mb.strip_quoted_reply("  Unsubscribe  \r\n") == "Unsubscribe"
    assert mb.strip_quoted_reply("") == ""


def test_html_bodies_lose_gmail_blockquotes_before_the_text_scan():
    markup = ('<div dir="ltr">Unsubscribe</div><br><div class="gmail_quote">'
              '<div dir="ltr" class="gmail_attr">On Tue, Sep 8, 2026 at 11:50 AM '
              'Lifestyle Design Realty &lt;<a href="mailto:team@x">team@x</a>&gt; wrote:<br></div>'
              '<blockquote class="gmail_quote"><p>Hey Ka,</p><p>reply UNSUBSCRIBE and we will</p>'
              '</blockquote></div>')
    text = mb.html_to_text(markup)
    assert "Hey Ka" not in text
    assert mb.strip_quoted_reply(text) == "Unsubscribe"


# ── configuration ─────────────────────────────────────────────────────────────

def test_config_derives_the_imap_host_from_the_smtp_host():
    assert mb.derive_imap_host("smtp.gmail.com") == "imap.gmail.com"
    assert mb.derive_imap_host("smtp-relay.gmail.com") == "imap.gmail.com"
    assert mb.derive_imap_host("smtp.office365.com") == "outlook.office365.com"
    assert mb.derive_imap_host("smtp.example.com") == "imap.example.com"
    assert mb.derive_imap_host("mail.example.com") is None
    assert mb.derive_imap_host(None) is None


def test_config_is_off_without_credentials_and_says_why():
    cfg = mb.MailboxConfig.from_env({}, smtp_host="smtp.gmail.com")
    assert not cfg.enabled and "credentials" in cfg.disabled_reason


def test_config_shares_the_smtp_credentials_by_default():
    cfg = mb.MailboxConfig.from_env({}, smtp_host="smtp.gmail.com",
                                    smtp_user="peter@x.com", smtp_password="app-pw")
    assert cfg.enabled
    assert (cfg.host, cfg.port, cfg.user, cfg.password) == ("imap.gmail.com", 993, "peter@x.com", "app-pw")


def test_config_can_be_switched_off_and_overridden():
    off = mb.MailboxConfig.from_env({"MAILBOX_REPLY_READ": "false"},
                                    smtp_host="smtp.gmail.com", smtp_user="u", smtp_password="p")
    assert not off.enabled and "MAILBOX_REPLY_READ" in off.disabled_reason
    over = mb.MailboxConfig.from_env(
        {"IMAP_HOST": "imap.other.com", "IMAP_PORT": "1993", "IMAP_USER": "bot@x", "IMAP_PASSWORD": "s",
         "IMAP_MAILBOX": "Replies"},
        smtp_host="smtp.gmail.com", smtp_user="u", smtp_password="p")
    assert (over.host, over.port, over.user, over.password, over.mailbox) == \
        ("imap.other.com", 1993, "bot@x", "s", "Replies")


def test_config_without_a_derivable_host_is_off():
    cfg = mb.MailboxConfig.from_env({}, smtp_host="mail.example.com", smtp_user="u", smtp_password="p")
    assert not cfg.enabled and "IMAP_HOST" in cfg.disabled_reason


def test_a_reader_without_config_never_touches_the_network():
    reader = mb.MailboxReplyReader(mb.MailboxConfig.from_env({}),
                                   connector=lambda cfg: pytest.fail("must not connect"))
    assert not reader.enabled
    assert reader.find_reply(["ka@example.com"], NOW) is None
    assert reader.last_outcome == "disabled"


# ── the reader against a fake IMAP server ────────────────────────────────────

def _raw(from_addr, when, body, subject="Re: Your next home in Austin", html=None):
    msg = email.message.EmailMessage()
    msg["From"] = f"Katryna <{from_addr}>"
    msg["To"] = "team@lifestyledesignrealty.com"
    msg["Subject"] = subject
    msg["Date"] = format_datetime(when)
    msg["Message-ID"] = f"<{abs(hash((from_addr, when, body)))}@example.com>"
    if html is None:
        msg.set_content(body)
    else:
        msg.set_content(body)
        msg.add_alternative(html, subtype="html")
    return msg.as_bytes()


class FakeImap:
    """Just enough of imaplib.IMAP4_SSL, returning imaplib's real shapes."""

    def __init__(self, messages, *, folders=None, login_error=None, search_error=None):
        # messages: list of (uid, from_addr, raw_bytes)
        self.messages = messages
        self.folders = folders if folders is not None else [
            b'(\\HasNoChildren) "/" "INBOX"',
            b'(\\All \\HasNoChildren) "/" "[Gmail]/All Mail"',
        ]
        self.login_error = login_error
        self.search_error = search_error
        self.selected = None
        self.readonly = None
        self.logged_out = False
        self.commands = []

    def login(self, user, password):
        self.commands.append(("login", user))
        if self.login_error:
            raise imaplib.IMAP4.error(self.login_error)
        return "OK", [b"Logged in"]

    def list(self):
        return "OK", list(self.folders)

    def select(self, mailbox, readonly=False):
        self.selected, self.readonly = mailbox, readonly
        return "OK", [b"3"]

    def uid(self, command, *args):
        self.commands.append((command, args))
        if command == "SEARCH":
            if self.search_error:
                raise self.search_error
            wanted = args[args.index("FROM") + 1].strip('"').lower()
            hits = [uid for uid, addr, _ in self.messages if wanted in addr.lower()]
            return "OK", [" ".join(hits).encode()]
        if command == "FETCH":
            uid = args[0]
            for candidate, _, raw in self.messages:
                if candidate == uid:
                    return "OK", [(f"{uid} (UID {uid} BODY[] {{{len(raw)}}}".encode(), raw), b")"]
            return "OK", [None]
        raise AssertionError(command)

    def logout(self):
        self.logged_out = True
        return "BYE", [b""]


def _reader(fake):
    cfg = mb.MailboxConfig(host="imap.gmail.com", user="peter@x.com", password="pw")
    return mb.MailboxReplyReader(cfg, connector=lambda c: fake)


def test_finds_the_leads_reply_by_address_and_timestamp_and_returns_only_her_words():
    reply_at = NOW - dt.timedelta(minutes=3)
    reply_text = ("Unsubscribe\n\nOn Tue, Sep 8, 2026 at 11:50 AM Lifestyle Design Realty "
                  "<team@lifestyledesignrealty.com> wrote:\n" + quoted(OUR_EMAIL))
    fake = FakeImap([
        ("7", "ka@example.com", _raw("ka@example.com", reply_at - dt.timedelta(days=20), "old thread")),
        ("9", "ka@example.com", _raw("ka@example.com", reply_at, reply_text)),
        ("10", "lender@bank.com", _raw("lender@bank.com", reply_at, "rates attached")),
    ])
    reader = _reader(fake)

    found = reader.find_reply(["ka@example.com"], NOW)

    assert found is not None
    assert found.text == "Unsubscribe"
    assert found.subject == "Re: Your next home in Austin"
    assert found.uid == "9" and found.folder == "[Gmail]/All Mail"
    assert reader.last_outcome == "revealed" and reader.stats["revealed"] == 1
    # Read-only, in the \All folder; the connection is kept for the next
    # lookup and logged out on close().
    assert fake.readonly is True and fake.selected == '"[Gmail]/All Mail"'
    assert fake.logged_out is False
    reader.close()
    assert fake.logged_out is True
    reader.close()  # idempotent
    # BODY.PEEK so reading never marks Peter's mail as read.
    assert any(cmd == "FETCH" and "(BODY.PEEK[])" in args for cmd, args in fake.commands)


def test_the_closest_message_inside_the_tolerance_wins():
    fake = FakeImap([
        ("1", "ka@example.com", _raw("ka@example.com", NOW - dt.timedelta(hours=5), "earlier note")),
        ("2", "ka@example.com", _raw("ka@example.com", NOW - dt.timedelta(minutes=2), "STOP")),
    ])
    found = _reader(fake).find_reply(["ka@example.com"], NOW)
    assert found is not None and found.text == "STOP"


def test_nothing_inside_the_tolerance_is_not_found_not_an_error():
    fake = FakeImap([
        ("1", "ka@example.com", _raw("ka@example.com", NOW - dt.timedelta(days=2), "old")),
    ])
    reader = _reader(fake)
    assert reader.find_reply(["ka@example.com"], NOW) is None
    assert reader.last_outcome == "not_found" and reader.stats["not_found"] == 1
    assert reader.enabled, "a miss must not switch the reader off"


def test_a_fuzzy_server_match_from_someone_else_is_rejected():
    """Gmail's FROM search is a substring match; ours is exact."""
    fake = FakeImap([
        ("1", "ka@example.com.evil.net", _raw("ka@example.com.evil.net", NOW, "Unsubscribe")),
    ])
    assert _reader(fake).find_reply(["ka@example.com"], NOW) is None


def test_html_only_replies_are_read_through_html_to_text():
    html = ('<div>Please stop emailing me</div><div class="gmail_quote">On Tue wrote:<br>'
            '<blockquote>reply UNSUBSCRIBE</blockquote></div>')
    fake = FakeImap([("1", "ka@example.com", _raw("ka@example.com", NOW, "Please stop emailing me", html=html))])
    found = _reader(fake).find_reply(["Ka@Example.com"], NOW)
    assert found is not None and found.text == "Please stop emailing me"


def test_one_connection_serves_many_lookups_and_a_stale_one_is_replaced():
    """The daily run asks for hundreds of leads' replies: one login, not
    one per lead. A connection the server dropped in between is replaced
    once, transparently."""
    connections = []

    class Flaky(FakeImap):
        def __init__(self, *a, **k):
            super().__init__(*a, **k)
            self.searches = 0

        def uid(self, command, *args):
            if command == "SEARCH":
                self.searches += 1
                if self.fail_next_search:
                    self.fail_next_search = False
                    raise imaplib.IMAP4.abort("socket error: EOF")
            return super().uid(command, *args)

    def connector(cfg):
        fake = Flaky([("1", "ka@example.com", _raw("ka@example.com", NOW, "Unsubscribe"))])
        fake.fail_next_search = False
        connections.append(fake)
        return fake

    cfg = mb.MailboxConfig(host="imap.gmail.com", user="u", password="p")
    reader = mb.MailboxReplyReader(cfg, connector=connector)
    assert reader.find_reply(["ka@example.com"], NOW).text == "Unsubscribe"
    assert reader.find_reply(["ka@example.com"], NOW).text == "Unsubscribe"
    assert len(connections) == 1 and reader.stats["connections"] == 1

    connections[0].fail_next_search = True          # the server dropped us
    assert reader.find_reply(["ka@example.com"], NOW).text == "Unsubscribe"
    assert len(connections) == 2, "one retry on a fresh connection"
    assert connections[0].logged_out is True
    assert reader.stats["errors"] == 0 and reader.enabled

    reader.close()
    assert connections[1].logged_out is True


def test_a_refused_login_disables_the_reader_for_the_process_after_one_warning():
    fake = FakeImap([], login_error="[AUTHENTICATIONFAILED] Invalid credentials")
    reader = _reader(fake)
    assert reader.find_reply(["ka@example.com"], NOW) is None
    assert reader.last_outcome == "error"
    assert not reader.enabled and "login refused" in reader.disabled_reason
    assert fake.logged_out is True, "the refused connection is not kept around"
    # The second lead must not even try to connect.
    reader.connector = lambda c: pytest.fail("must not reconnect after a refused login")
    assert reader.find_reply(["jo@example.com"], NOW) is None
    assert reader.last_outcome == "disabled"


def test_an_unreachable_host_trips_the_breaker_after_two_failures():
    calls = []

    def connector(cfg):
        calls.append(1)
        raise OSError("connection timed out")

    cfg = mb.MailboxConfig(host="imap.gmail.com", user="u", password="p")
    reader = mb.MailboxReplyReader(cfg, connector=connector)
    assert reader.find_reply(["a@x"], NOW) is None and reader.enabled
    assert reader.find_reply(["a@x"], NOW) is None and not reader.enabled
    assert reader.find_reply(["a@x"], NOW) is None
    assert len(calls) == 2, "the third lookup must not dial out"
    assert reader.stats["errors"] == 2


def test_a_lead_without_an_address_is_a_miss_without_a_connection():
    reader = _reader(FakeImap([]))
    reader.connector = lambda c: pytest.fail("no address, no connection")
    assert reader.find_reply([], NOW) is None
    assert reader.last_outcome == "not_found"


def test_folder_falls_back_to_inbox_when_the_server_advertises_no_all_folder():
    fake = FakeImap([("1", "ka@example.com", _raw("ka@example.com", NOW, "Unsubscribe"))],
                    folders=[b'(\\HasNoChildren) "/" "INBOX"'])
    found = _reader(fake).find_reply(["ka@example.com"], NOW)
    assert found is not None and fake.selected == '"INBOX"'


def test_imap_date_uses_english_months_whatever_the_locale():
    assert mb.imap_date(dt.datetime(2026, 9, 7, tzinfo=UTC)) == "07-Sep-2026"
    assert mb.imap_date(dt.datetime(2026, 12, 25, tzinfo=UTC)) == "25-Dec-2026"


def test_from_settings_reads_the_bots_smtp_settings():
    class S:
        smtp_host = "smtp.gmail.com"
        smtp_user = "peter@x.com"
        smtp_password = "pw"

    reader = mb.MailboxReplyReader.from_settings(S(), env={})
    assert reader.enabled and reader.config.host == "imap.gmail.com"
    assert "peter@x.com" not in reader.describe(), "describe() is for logs — never the mailbox address"
