"""Send-date grounding for every lead-facing email.

Why this exists (2026-11-06): the pond prompt was told "Today is upcoming
Veterans Day!" five days before the holiday, with no date attached, and 88 of
228 reviewed buyer emails told people Veterans Day was "this week" or "this
weekend" (it was Wednesday, November 11, the following week). The post-close
quarterly prompt carried no date at all, so in November it wrote "halfway
through the year" and "fantastic summer". And the pond prompt's "today" came
from UTC, so an evening Central run was dated tomorrow.

Everything date-shaped a prompt is told now comes from here, computed from the
actual send moment in the configured local time zone (America/Chicago), and
every generated email is checked against the same facts before it can leave.
"""
from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass
from typing import Dict, List, Optional
from zoneinfo import ZoneInfo

DEFAULT_TZ = "America/Chicago"

# How far ahead a holiday may be mentioned at all. Inside this window the
# prompt gets the exact weekday and date; outside it, no holiday is mentioned.
HOLIDAY_WINDOW_DAYS = 7


class DateGroundingError(ValueError):
    """A generated email still contradicts the send date after one rewrite.

    Callers must not send that email. What happens next differs by caller,
    and none of them is a guaranteed retry:
    - pond nurture, seller nurture, quarterly closed drip, long-term nurture:
      audit "deferred", no email, no FUB note, cadence untouched. The lead
      stays eligible, so a later run's normal scan may pick it up again if it
      still qualifies (caps, cadence and eligibility still apply).
    - congratulations: audit "deferred" with retry "not automatic". Discovery
      looks back only 26 hours, so it is usually NOT retried.
    - instant welcome (webhook): no specific handling. The generic error
      handler logs "error"; nothing is sent and there is no retry.
    """

    def __init__(self, problems: List[str]):
        super().__init__("; ".join(problems))
        self.problems = list(problems)


@dataclass(frozen=True)
class HolidayContext:
    name: str
    date: dt.date
    days_until: int

    @property
    def is_today(self) -> bool:
        return self.days_until == 0


def send_date(tz_name: str = DEFAULT_TZ, now: Optional[dt.datetime] = None) -> dt.date:
    """The calendar date the recipient's email is sent on, in local time."""
    tz = ZoneInfo(tz_name or DEFAULT_TZ)
    moment = now or dt.datetime.now(dt.timezone.utc)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=dt.timezone.utc)
    return moment.astimezone(tz).date()


def long_date(day: dt.date) -> str:
    """'Wednesday, November 11, 2026' — no leading zero, no locale surprises."""
    return f"{day.strftime('%A')}, {day.strftime('%B')} {day.day}, {day.year}"


def season(day: dt.date) -> str:
    """Meteorological season for Texas (Dec–Feb winter, Mar–May spring, ...)."""
    return {12: "winter", 1: "winter", 2: "winter",
            3: "spring", 4: "spring", 5: "spring",
            6: "summer", 7: "summer", 8: "summer",
            9: "fall", 10: "fall", 11: "fall"}[day.month]


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> dt.date:
    first = dt.date(year, month, 1)
    return first + dt.timedelta(days=(weekday - first.weekday()) % 7 + 7 * (n - 1))


def _last_weekday(year: int, month: int, weekday: int) -> dt.date:
    last = (dt.date(year, month + 1, 1) if month < 12 else dt.date(year + 1, 1, 1)) - dt.timedelta(days=1)
    return last - dt.timedelta(days=(last.weekday() - weekday) % 7)


def holidays_in(year: int) -> Dict[dt.date, str]:
    """The holidays the emails may acknowledge — the same set the bot has
    always used (sms_helpers.get_upcoming_holiday), computed per year."""
    return {
        dt.date(year, 1, 1): "New Year's Day",
        _last_weekday(year, 5, 0): "Memorial Day",
        dt.date(year, 7, 4): "the 4th of July",
        _nth_weekday(year, 9, 0, 1): "Labor Day",
        dt.date(year, 10, 31): "Halloween",
        dt.date(year, 11, 11): "Veterans Day",
        _nth_weekday(year, 11, 3, 4): "Thanksgiving",
        dt.date(year, 12, 24): "Christmas Eve",
        dt.date(year, 12, 25): "Christmas Day",
        dt.date(year, 12, 31): "New Year's Eve",
    }


def upcoming_holiday(day: dt.date, window_days: int = HOLIDAY_WINDOW_DAYS) -> Optional[HolidayContext]:
    """The nearest holiday on or after `day` within the window, or None.

    Looks into next year too, so Dec 28 sees New Year's Day.
    """
    candidates = {**holidays_in(day.year), **holidays_in(day.year + 1)}
    for when in sorted(candidates):
        delta = (when - day).days
        if 0 <= delta <= window_days:
            return HolidayContext(candidates[when], when, delta)
    return None


def grounding_block(day: dt.date, tz_name: str = DEFAULT_TZ,
                    holiday: Optional[HolidayContext] = None) -> str:
    """The date facts every lead-facing prompt carries, verbatim."""
    lines = [
        f"SEND DATE (ground truth): this email is sent on {long_date(day)} "
        f"({tz_name.replace('_', ' ')} time). It is {season(day)} in Texas.",
        "DATE RULES: Any reference to the current day, week, month, season, or point in the year must "
        "agree with the send date above. Do not mention summer, spring, winter, the middle of the year, "
        "or any other season or part of the year unless it matches the send date. When unsure, leave "
        "date and season references out entirely.",
        "Never call a holiday or event 'today', 'tomorrow', 'this weekend', 'this week', or "
        "'next week'. If you mention a date at all, use its exact weekday and date as given here.",
    ]
    if holiday is None:
        lines.append("HOLIDAYS: No holiday falls within the next week. Do not mention any holiday.")
    elif holiday.is_today:
        lines.append(
            f"HOLIDAY: Today ({long_date(holiday.date)}) is {holiday.name}. You may open with one short, "
            f"sincere {holiday.name} wish, then get to the point. Keep it brief, not festive filler.")
    else:
        lines.append(
            f"HOLIDAY: {holiday.name} is on {long_date(holiday.date)}, {holiday.days_until} day"
            f"{'s' if holiday.days_until != 1 else ''} after this email is sent. It is NOT today. "
            f"You may mention it once using that exact weekday and date (for example \"with "
            f"{holiday.name} coming up on {holiday.date.strftime('%A')}, {holiday.date.strftime('%B')} "
            f"{holiday.date.day}\"), or leave it out. Do not wish them a happy {holiday.name} yet.")
    return "\n".join(lines)


# ── Post-generation check ─────────────────────────────────────────────────────
#
# Revised 2026-11-06 after independent review found these accepted or wrongly
# rejected: "Veterans Day is Thursday, November 12, 2026" and "It is summer in
# Texas" (Nov 6), "Happy Veterans Day!" (Nov 10), "New Year's Eve is today"
# rejected as New Year's Day (Dec 31), and explicit years ignored in weekday
# checks. Each is a regression test in tests/test_date_grounding.py.

_HOLIDAY_PATTERNS = {
    "New Year's Day": r"new year'?s(?: day)?(?! eve)",
    "Memorial Day": r"memorial day",
    "the 4th of July": r"(?:4th|fourth) of july|july (?:4th|4|fourth)\b|independence day",
    "Labor Day": r"labor day",
    "Halloween": r"halloween",
    "Veterans Day": r"veterans'? day",
    "Thanksgiving": r"thanksgiving",
    "Christmas Eve": r"christmas eve",
    "Christmas Day": r"christmas(?! eve)(?: day)?",
    "New Year's Eve": r"new year'?s eve",
}

_RELATIVE = {
    "today": r"\btoday\b",
    "tonight": r"\btonight\b",
    "tomorrow": r"\btomorrow\b",
    "this weekend": r"\bthis (?:coming )?weekend\b",
    "this week": r"\bthis week\b(?!end)",
    "next week": r"\bnext week\b(?!end)",
}

_MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august",
                "september", "october", "november", "december"]
_MONTH_ALIASES = {**{m: i for i, m in enumerate(_MONTH_NAMES, start=1)},
                  **{m[:3]: i for i, m in enumerate(_MONTH_NAMES, start=1)}, "sept": 9}
_MONTH_RE = r"(january|february|march|april|may|june|july|august|september|october|november|december|" \
            r"jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\.?"
_WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
_WEEKDAY_RE = r"(monday|tuesday|wednesday|thursday|friday|saturday|sunday)"
# "[Weekday,] Month D[st|nd|rd|th][, YYYY]"
_DATE_RE = re.compile(
    rf"(?:\b{_WEEKDAY_RE},?\s+)?\b{_MONTH_RE}\s+(\d{{1,2}})(?:st|nd|rd|th)?\b(?:,?\s+(\d{{4}}))?")

_POSITIVE = r"(?:fantastic|great|amazing|wonderful|awesome|lovely|nice|beautiful|fun|good|relaxing|busy)"
_SEASON_CLAIMS = {
    "summer": (6, 7, 8),
    "spring": (3, 4, 5),
    "fall": (9, 10, 11),
    "autumn": (9, 10, 11),
    "winter": (12, 1, 2),
}
# Last month of each season, for "this <season>": upcoming is fine, past is not.
_SEASON_END = {"spring": 5, "summer": 8, "fall": 11, "autumn": 11}


def _normalise(text: str) -> str:
    return (text or "").replace("\u2019", "'").replace("\u2018", "'").lower()


def _season_already_over(word: str, day: dt.date) -> bool:
    if word == "winter":
        return 3 <= day.month <= 9  # Oct/Nov: "this winter" is still ahead
    return day.month > _SEASON_END[word]


def _claims_current_season(lowered: str, word: str, day: dt.date) -> bool:
    """Does the text speak of `word` as the season we are in right now?"""
    def _qualified(start: int) -> bool:
        before = lowered[max(0, start - 14):start]
        return bool(re.search(r"(?:\bnext|\blast|\bpast|\bhad a|\bhad an|\bby|\buntil|\bbefore|\bthis coming) $", before))

    for match in re.finditer(rf"\b{_POSITIVE} {word}\b", lowered):
        if not _qualified(match.start()):
            return True
    current = [
        rf"\b(?:enjoying|having|soaking up) (?:a |the |your |this )?(?:\w+ )?{word}\b",
        rf"\b{word} (?:is|has) (?:here|arrived|sprung|flying by|in full swing)\b",
        rf"\b(?:it is|it's|its|now that it's|now that it is|since it's|since it is) (?:now |already |officially )?"
        rf"(?:the middle of |mid-?|late |early )?{word}\b",
        rf"\bhappy {word}\b",
        rf"\b{word} (?:weather|heat|days) (?:is|are) here\b",
    ]
    if any(re.search(c, lowered) for c in current):
        return True
    if _season_already_over(word, day) and re.search(rf"(?<!by )(?<!until )(?<!before )\bthis {word}\b", lowered):
        return True
    return False


# "The middle of the year" as a claim about TODAY ("we're already halfway
# through the year", "it's mid-year", "this year is half over", "your mid-year
# check-in"). A past event that happened mid-year ("you mentioned a mid-year
# move in June") is not a claim about today and is not judged (rev2 review:
# that sentence was falsely rejected).
_MIDYEAR = (r"(?:halfway (?:through|into|done with) (?:the|this) year|(?:the )?middle of (?:the|this) year|"
            r"mid-?year|(?:the )?halfway (?:point|mark) of (?:the|this) year)")
_MIDYEAR_NOW = re.compile(
    rf"\b(?:we're|we are|it's|it is|its|here we are|we've hit|we've reached|we have hit|we have reached|"
    rf"we've made it to|we made it to|now that it's|now that we're)"
    rf"(?: (?:now|already|officially|almost|nearly|just about|right|about|at|in|past|to|through))*"
    rf" {_MIDYEAR}\b"
    rf"|\b(?:already|almost|nearly) {_MIDYEAR}\b"
    rf"|\b(?:can you believe|hard to believe|crazy to think)\b[^.!?\n]{{0,30}}\b{_MIDYEAR}\b"
    rf"|\bas we (?:hit|reach|head into|pass|approach|cross) (?:the )?{_MIDYEAR}\b"
    rf"|\b(?:the|this) year is (?:already |almost |nearly |more than )?half (?:over|done|gone)\b"
    rf"|\bhappy mid-?year\b"
    rf"|\b(?:this|our|my|your|a quick|quick) mid-?year (?:check[- ]?in|update|note|hello|reminder|touch[- ]?base)\b")


def _next_occurrence(name: str, day: dt.date) -> dt.date:
    for year in (day.year, day.year + 1):
        for when, holiday in holidays_in(year).items():
            if holiday == name and when >= day:
                return when
    raise KeyError(name)  # pragma: no cover — every name recurs yearly


def _relative_is_true(phrase: str, day: dt.date, when: dt.date) -> bool:
    delta = (when - day).days
    same_week = when.isocalendar()[:2] == day.isocalendar()[:2]
    if phrase in ("today", "tonight"):
        return delta == 0
    if phrase == "tomorrow":
        return delta == 1
    if phrase == "this week":
        return same_week and delta >= 0
    if phrase == "next week":
        nxt = day + dt.timedelta(days=7)
        return when.isocalendar()[:2] == nxt.isocalendar()[:2]
    if phrase == "this weekend":
        # The holiday itself is on the coming Sat/Sun, or it is the Monday of a
        # long weekend that starts within the next three days.
        if when.weekday() >= 5 and 0 <= delta <= 6 and same_week:
            return True
        return when.weekday() == 0 and 0 <= delta <= 3
    return False


# Abbreviations whose "." does not end a sentence ("Nov. 12", "Oak St.").
_ABBREVIATIONS = re.compile(
    r"\b(jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|"
    r"st|dr|ave|blvd|rd|ln|mr|mrs|ms|jr|sr|no|approx|etc)\.", re.IGNORECASE)


def _sentences(text: str) -> List[str]:
    protected = _ABBREVIATIONS.sub(lambda m: m.group(1) + "\u2024", text)  # one-dot leader, restored below
    parts = re.split(r"(?<=[.!?])\s+|\n+", protected)
    return [p.replace("\u2024", ".") for p in parts if p.strip()]


def _resolve_date(month: int, dom: int, year: Optional[int], day: dt.date) -> Optional[dt.date]:
    """The calendar date a written "Month D[, YYYY]" refers to. Without a
    year: the next occurrence on/after the send date (or within 60 days
    before it, for a recent past date)."""
    try:
        if year:
            return dt.date(year, month, dom)
        for y in (day.year, day.year + 1):
            candidate = dt.date(y, month, dom)
            if candidate >= day - dt.timedelta(days=60):
                return candidate
    except ValueError:
        return None
    return None


_MONTH_MAX_DAYS = {1: 31, 2: 29, 3: 31, 4: 30, 5: 31, 6: 30, 7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31}


def _impossible_date(month: int, dom: int, year: Optional[int]) -> bool:
    """A written date no calendar has: "November 31", "February 30",
    "February 29, 2027". Numbers above 31 are not treated as dates at all
    ("may 45" is not a date), and "February 29" with no year is left alone."""
    if dom > 31 or dom < 1:
        return False
    if dom > _MONTH_MAX_DAYS[month]:
        return True
    if year:
        try:
            dt.date(year, month, dom)
        except ValueError:
            return True
    return False


def _written_dates(sentence: str, day: dt.date):
    """Yield (start, end, weekday_or_None, resolved_date_or_None, year_or_None, impossible_label_or_None)."""
    for m in _DATE_RE.finditer(sentence):
        weekday, month_word, dom, year = m.group(1), m.group(2), int(m.group(3)), m.group(4)
        month = _MONTH_ALIASES.get(month_word.rstrip("."))
        if not month:
            continue
        yr = int(year) if year else None
        impossible = (f"{_MONTH_NAMES[month - 1].title()} {dom}{', ' + str(yr) if yr else ''}"
                      if _impossible_date(month, dom, yr) else None)
        yield m.start(), m.end(), weekday, _resolve_date(month, dom, yr, day), yr, impossible


# A written date is the holiday's OWN date only when the text says so: right
# after the name with just linking words between ("Veterans Day is on
# Wednesday, November 11", "Veterans Day (Nov. 11)"), or right before it
# ("November 11 is Veterans Day"). Dates joined by "after", "before", "but",
# "meet" etc. are other dates and are not judged against the holiday.
_AFTER_LINK = re.compile(
    r"^(?:[\s,(]|is|was|falls|lands|comes|will|be|this|year|coming|up|on|next|week|which|it's|its|-)*$")
_BEFORE_LINK = re.compile(r"^(?:[\s,(]|is|was|marks|will|be|-)*$")


def _holiday_in_year(name: str, year: int) -> Optional[dt.date]:
    for when, holiday in holidays_in(year).items():
        if holiday == name:
            return when
    return None


def date_language_problems(text: str, day: dt.date) -> List[str]:
    """What in `text` contradicts the send date. Empty list = consistent.

    Flags claims that are checkably wrong: a holiday given the wrong date or
    placed in the wrong week, a "happy <holiday>" before the day, a weekday
    that does not match its date (explicit years honoured), and a season or
    point in the year that is not the current one. Plans ("next summer",
    "by spring") are left alone.
    """
    problems: List[str] = []
    lowered = _normalise(text)

    for sentence in _sentences(lowered):
        written = list(_written_dates(sentence, day))
        for name, pattern in _HOLIDAY_PATTERNS.items():
            mentions = list(re.finditer(rf"\b(?:{pattern})", sentence))
            if not mentions:
                continue
            when = _next_occurrence(name, day)
            for phrase, rel in _RELATIVE.items():
                if re.search(rel, sentence) and not _relative_is_true(phrase, day, when):
                    problems.append(
                        f"says {name} is '{phrase}' but it is {long_date(when)} "
                        f"and the email is sent {long_date(day)}")
            delta = (when - day).days
            if delta >= 1 and re.search(rf"\bhappy (?!early\b)(?:upcoming )?(?:{pattern})", sentence):
                problems.append(f"wishes a happy {name} {delta} day{'s' if delta != 1 else ''} early ({long_date(when)})")
            # A date the text ties to the holiday must be that holiday's date
            # in the year written (or the next occurrence when no year is).
            for mention in mentions:
                for start, end, _w, resolved, year, _impossible in written:
                    if resolved is None:
                        continue
                    if start >= mention.end():
                        tied = len(sentence[mention.end():start]) <= 45 and _AFTER_LINK.match(sentence[mention.end():start])
                    elif end <= mention.start():
                        tied = len(sentence[end:mention.start()]) <= 20 and _BEFORE_LINK.match(sentence[end:mention.start()])
                    else:
                        tied = False
                    if not tied:
                        continue
                    target = _holiday_in_year(name, year) if year else when
                    if target and resolved != target:
                        problems.append(f"gives {name} the wrong date ({resolved.strftime('%B')} {resolved.day}"
                                        f"{', ' + str(resolved.year) if year else ''}); it is {long_date(target)}")

        for _start, _end, weekday, resolved, _year, impossible in written:
            if impossible:
                # Review counterexample (rev2): "Friday, November 31, 2026" resolved
                # to None and was silently ignored.
                problems.append(f"gives a date that does not exist ({impossible})")
                continue
            if weekday and resolved and _WEEKDAYS[resolved.weekday()] != weekday:
                problems.append(f"calls {resolved.strftime('%B')} {resolved.day}, {resolved.year} a "
                                f"{weekday.title()} but it is a {_WEEKDAYS[resolved.weekday()].title()}")

    for word, months in _SEASON_CLAIMS.items():
        if day.month in months:
            continue
        if _claims_current_season(lowered, word, day):
            problems.append(f"talks about {word} as the current season; it is {season(day)} ({long_date(day)})")

    if day.month not in (6, 7) and _MIDYEAR_NOW.search(lowered):
        problems.append(f"says it is the middle of the year; it is {long_date(day)}")

    return problems
