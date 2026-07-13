"""SMS helper utilities for FUB automation.

Reconstructed from compiled bytecode — contains:
- get_upcoming_holiday: returns the name of an upcoming holiday within ~7 days
- generate_personalized_sms: generates a day/holiday-aware SMS text for a lead
- make_sms_uri: builds a dashboard-hosted SMS redirect URL for email-safe tap-to-text
"""

from __future__ import annotations

import datetime
import hashlib
import urllib.parse
from typing import Optional


def get_upcoming_holiday(date: datetime.date) -> Optional[str]:
    """Return the name of an upcoming holiday if one is within ~7 days, else None."""
    year = date.year

    holidays = {
        datetime.date(year, 1, 1): "New Year's Day",
        datetime.date(year, 7, 4): "the 4th of July",
        datetime.date(year, 10, 31): "Halloween",
        datetime.date(year, 11, 11): "Veterans Day",
        datetime.date(year, 12, 24): "Christmas Eve",
        datetime.date(year, 12, 25): "Christmas Day",
        datetime.date(year, 12, 31): "New Year's Eve",
    }

    # Memorial Day — last Monday of May
    last_day_of_may = datetime.date(year, 5, 31)
    memorial_day = last_day_of_may - datetime.timedelta(days=(last_day_of_may.weekday() - 0) % 7)
    holidays[memorial_day] = "Memorial Day"

    # Labor Day — first Monday of September
    first_of_sep = datetime.date(year, 9, 1)
    labor_day = first_of_sep + datetime.timedelta(days=(0 - first_of_sep.weekday()) % 7)
    holidays[labor_day] = "Labor Day"

    # Thanksgiving — fourth Thursday of November
    first_of_nov = datetime.date(year, 11, 1)
    first_thursday = first_of_nov + datetime.timedelta(days=(3 - first_of_nov.weekday()) % 7)
    thanksgiving = first_thursday + datetime.timedelta(weeks=3)
    holidays[thanksgiving] = "Thanksgiving"

    for holiday_date, name in sorted(holidays.items()):
        delta = (holiday_date - date).days
        if 0 <= delta <= 7:
            prefix = "upcoming " if delta > 0 else ""
            return f"{prefix}{name}"

    return None


def generate_personalized_sms(
    first_name: str,
    city: str,
    days_stale: int,
    holiday: Optional[str] = None,
    direct_ask: bool = False,
    lead_id: Optional[int] = None,
) -> str:
    """Generate a highly dynamic, warm, and engaging SMS text message for a lead.

    Tailored to the day of the week, holidays, and rotates through variations to
    prevent repetition. Uses direct ask only for highly stale leads (days_stale > 20)
    or when specifically requested.
    """
    first_name_cap = first_name.strip().split(":")[0].title() if first_name else "there"
    city_cap = city.title() if city and city.lower() not in {"texas", "texas/general", "your area"} else "Texas"

    # Deterministic seed so the same lead gets the same template per day
    seed_str = f"{lead_id or 0}{first_name_cap}{city_cap}"
    seed = int(hashlib.sha256(seed_str.encode("utf-8")).hexdigest()[:16], 16)

    today = datetime.date.today()
    weekday = today.weekday()  # 0=Mon … 6=Sun

    # Holiday override
    if holiday:
        holiday_label = holiday.replace("upcoming ", "")
        return (
            f"Hey {first_name_cap}, happy {holiday_label}! "
            f"Hope you are having an amazing day. ☀️ Just wanted to send a quick check-in "
            f"about your home search in {city_cap} whenever you get a free sec! 🏡"
        )

    # Direct ask for very stale leads
    if direct_ask or days_stale > 20:
        return f"Hey {first_name_cap}, are you still looking to purchase a home? 🏡"

    # Day-of-week templates (3 variants each, rotated by seed)
    day_templates = {
        0: [  # Monday
            f"Hey {first_name_cap}, happy Monday! Hope you had an amazing weekend. ☀️ Are you still looking at homes in {city_cap} or has your timeline shifted?",
            f"Hey {first_name_cap}, hope your week is starting off great! Just wanted to check in and see if you are still thinking about finding a place in {city_cap}? 🏡☕",
            f"Hey {first_name_cap}, happy Monday! Starting the week fresh, just wanted to see if you got a free sec to chat about homes in {city_cap} sometime soon? 😊",
        ],
        1: [  # Tuesday
            f"Hey {first_name_cap}, hope you're having a great Tuesday! Are you still looking for a place in {city_cap} or are you holding off for now? 🏡☀️",
            f"Hey {first_name_cap}, hope your week is going well! Just checking in to see if you had any questions about the {city_cap} market or any specific homes? 😊",
            f"Hey {first_name_cap}, happy Tuesday! Just wanted to send a quick text to see if you are still looking at homes in {city_cap}? 🏡✨",
        ],
        2: [  # Wednesday
            f"Hey {first_name_cap}, happy hump day! Hope your week is going great. Just wanted to see if you are still looking at homes in {city_cap} or if you've already found something? 😊",
            f"Hey {first_name_cap}, happy Wednesday! Just checking in to see if you got a chance to look over those homes in {city_cap} lately? 🏡☕",
            f"Hey {first_name_cap}, hope your week is going awesome! Are you still thinking about finding a home in {city_cap} or has your timeline changed? ✨",
        ],
        3: [  # Thursday
            f"Hey {first_name_cap}, hope you're having a great Thursday! Just wanted to reach out and see if you are still thinking about finding a place in {city_cap}?",
            f"Hey {first_name_cap}, hope your week has been great! Are you still looking to buy a home in {city_cap} sometime soon, or is your timeline further out? 😊",
            f"Hey {first_name_cap}, happy Thursday! Just sending a quick check-in to see if you are still looking at homes in {city_cap} or if your plans have shifted? 🏡☕",
        ],
        4: [  # Friday
            f"Hey {first_name_cap}, happy Friday! Hope you have an amazing weekend ahead. ☀️ Are you still looking for a home in {city_cap}?",
            f"Hey {first_name_cap}, happy Friday! Hope you've had a great week. Just wanted to see if you have any free time this weekend to look at some homes in {city_cap}?",
            f"Hey {first_name_cap}, happy Friday! Just wanted to send a quick text to see if you are still thinking about finding a place in {city_cap}? Hope you have a wonderful weekend! 😊",
        ],
        5: [  # Saturday
            f"Hey {first_name_cap}, hope you're having a wonderful Saturday! ☀️ Just wanted to check in and see if you're still looking for a home in {city_cap} or if you are all set?",
            f"Hey {first_name_cap}, happy weekend! Hope you're having an amazing Saturday. Just wanted to see if you are still thinking about finding a place in {city_cap}?",
            f"Hey {first_name_cap}, hope you're having a great weekend! ☀️ Are you still looking at homes in {city_cap} or has your timeline changed a bit?",
        ],
        6: [  # Sunday
            f"Hey {first_name_cap}, hope you are having a peaceful Sunday! ☕ Just sending a quick text to see if you are still looking to buy a home in {city_cap} sometime soon?",
            f"Hey {first_name_cap}, hope you're having a wonderful weekend! Just checking in to see if you are still looking for a place in {city_cap} or if your plans have shifted? 😊",
            f"Hey {first_name_cap}, happy Sunday! Hope you have a great day. Just wanted to see if you are still thinking about finding a home in {city_cap}?",
        ],
    }

    templates = day_templates.get(weekday, day_templates[0])
    selected_template = templates[seed % len(templates)]
    return selected_template


def make_sms_uri(
    phone: str,
    body: str,
    agent_name: str = "",
    lead_id: Optional[int] = None,
) -> str:
    """Create a highly compatible, email-safe SMS redirect link hosted on the dashboard.

    This prevents email clients like Gmail and Outlook from stripping "sms:" links.
    """
    clean_phone = "".join(c for c in phone if c.isdigit())
    if len(clean_phone) == 10:
        clean_phone = "+1" + clean_phone
    elif not clean_phone.startswith("+"):
        clean_phone = "+" + clean_phone

    encoded_phone = urllib.parse.quote(clean_phone)
    encoded_body = urllib.parse.quote(body)
    url = (
        f"https://fub-nurture-phfprjui.manus.space/sms-redirect"
        f"?phone={encoded_phone}&body={encoded_body}"
    )
    if agent_name:
        url += f"&agent={urllib.parse.quote(str(agent_name))}"
    if lead_id is not None:
        url += f"&lead_id={urllib.parse.quote(str(lead_id))}"
    return url
