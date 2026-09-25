#!/usr/bin/env python3
"""DIAG BRANCH ONLY (diag/skip-recheck) — never merge.

Pre-merge preflight for fix 1 (fix/remember-note-checks): for every lead the
daily run skipped on 2026-09-24, show the notes fix 1 would still let the skip
check read (human notes and any note it does not recognise as a bot log), how
many notes FUB holds beyond the first 100, and the lead's tags — so the owner
can see which leads would start receiving pond email once the bot stops reading
its own skip/send/reassignment logs.

READ-ONLY: FUB GETs only, DRY_RUN pinned, state DB never pushed.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

PIDS = [113,152,194,211,311,329,332,339,383,394,395,421,427,444,487,493,547,583,690,761,783,821,931,955,981,1006,1015,1056,1077,1119,1193,1251,1271,1283,1285,1300,1301,1389,1406,1449,1464,1535,1572,1575,1579,1590,1636,1723,1752,1755,1759,1797,1807,1820,1821,1839,1856,1883,1885,1900,1927,1933,1963,1965,1972,1975,2003,2019,2030,2039,2055,2131,2135,2182,2209,2210,2252,2275,2297,2357,2476,2493,2508,2580,2605,2618,2625,2641,2655,2664,2667,2722,2741,2763,2786,2795,2800,2806,2823,2873,2893,2898,2914,2995,3023,3038,3060,3068,3072,3083,3095,3114,3115,3125,3131,3139,3140,3147,3150,3179,3190,3191,3193,3203,3206,3252,3259,3267,3284,3298,3322,3324,3353,3355,3361,3368,3385,3426,3452,3453,3476,3499,3520,3578,3606,3630,3650,3677,3682,3688,3696,3710,3711,3725,3743,3748,3763,3775,3802,3827,3853,3883,3903,3914,3917,3961,3971,3994,4017,4019,4034,4082,4396,4398,4452,4461,4504,4505,4509,4513,4556,4559,4562,4575,4584,4600,4603,4604,4621,4664,4778,4779,4804,4819,4822,4834,4875,4918,4942,4976,4993,4994,5019,5041,5071,5075,5103,5107,5125,5138,5848,5855,5869,5951,5986,6053,6208,6215,6217]

FIX1_MARKERS = ("pond nurture", "check-in email sent", "long-term nurture email sent",
    "welcome email sent", "seller nurture email sent", "reassigned to lead pond",
    "pond lead reassigned", "moved to lead pond", "speed-to-lead warning",
    "untouched assignment warning")
FIX1_LIFESTYLE = re.compile(r"^\s*\[[^\]]{1,60}\]\s*(?:skipped automated follow-up|follow-up email sent)", re.I)


def _p(line: str = "") -> None:
    print(line, flush=True)


def _clean(text, limit):
    text = re.sub(r"<[^>]+>", " ", str(text or ""))
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= limit else text[:limit] + "…"


def fix1_hides(note):
    subject = str(note.get("subject") or "").lower()
    body = re.sub(r"<[^>]+>", " ", str(note.get("body") or ""))
    if any(m in subject for m in FIX1_MARKERS) or FIX1_LIFESTYLE.match(body):
        return True
    return "[cowork reengage]" in subject or "[cowork reengage]" in body.lower()


def main(argv=None) -> int:
    argparse.ArgumentParser().parse_known_args(argv)
    os.environ["DRY_RUN"] = "true"
    os.environ.setdefault("FUB_DISABLE_SCHEDULER", "true")
    from fub_automation.main import FollowUpBossClient, Settings

    settings = Settings.from_env()
    if not settings.fub_api_key:
        _p("FUB_API_KEY missing")
        return 2
    fub = FollowUpBossClient(settings)
    for pid in PIDS:
        try:
            person = fub.get_person(pid) or {}
            page1 = fub._request("GET", "/notes", params={"personId": pid, "limit": 100}).get("notes", [])
            beyond = []
            if len(page1) == 100:
                for offset in (100, 200):
                    more = fub._request("GET", "/notes", params={"personId": pid, "limit": 100, "offset": offset}).get("notes", [])
                    beyond.extend(more)
                    if len(more) < 100:
                        break
        except Exception as exc:  # noqa: BLE001
            _p(f"LEAD {pid} ERROR {exc}")
            continue
        name = f"{person.get('firstName', '')} {person.get('lastName', '')}".strip()
        tags = [t.get("name") if isinstance(t, dict) else t for t in (person.get("tags") or [])]
        kept = [n for n in page1 if not fix1_hides(n)]
        kept_beyond = [n for n in beyond if not fix1_hides(n)]
        _p(f"LEAD {pid} | {name} | stage={person.get('stage')} | pond={person.get('assignedPondId')} "
           f"| assigned={person.get('assignedTo')} | notes={len(page1)}+{len(beyond)} | kept={len(kept)}+{len(kept_beyond)} | tags={tags}")
        for n in (kept + kept_beyond)[:6]:
            _p(f"    [{str(n.get('created') or '')[:10]}] by={n.get('createdBy')} | {_clean(n.get('subject'), 60)} | {_clean(n.get('body'), 260)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
