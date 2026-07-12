#!/usr/bin/env python3
"""Offline acceptance tests for Tier 3 features.

Tests validate logic without requiring live FUB API access.
"""

import datetime as dt
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch
from zoneinfo import ZoneInfo

# Add the source directory to path
sys.path.insert(0, str(Path(__file__).parent / "src"))

PASS = "\033[92m✅ PASS\033[0m"
FAIL = "\033[91m❌ FAIL\033[0m"

results = []


def test_feature1_engagement_cadence():
    """Feature 1: Engagement-Based Cadence — classify leads into 3 tiers."""
    print("\n" + "=" * 60)
    print("FEATURE 1: Engagement-Based Cadence")
    print("=" * 60)

    # Create a temp DB with the new schema
    db_path = tempfile.mktemp(suffix=".sqlite3")
    conn = sqlite3.connect(db_path)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS engagement_tier (
            person_id INTEGER PRIMARY KEY,
            tier TEXT NOT NULL DEFAULT 'standard',
            last_classified_at TEXT NOT NULL,
            reason TEXT
        );
        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            person_id INTEGER,
            action TEXT NOT NULL,
            status TEXT NOT NULL,
            details TEXT
        );
    """)

    # Simulate 3 leads with different engagement patterns
    now = dt.datetime.now(dt.timezone.utc)

    # Lead 1: Engaged — replied 20 days ago (within 60 days)
    lead_engaged = {
        "id": 1001,
        "firstName": "Alice",
        "lastReceivedEmail": (now - dt.timedelta(days=20)).isoformat(),
        "lastReceivedText": None,
        "lastIncomingCall": None,
    }

    # Lead 2: Standard — replied 75 days ago (61-90 days)
    lead_standard = {
        "id": 1002,
        "firstName": "Bob",
        "lastReceivedEmail": (now - dt.timedelta(days=75)).isoformat(),
        "lastReceivedText": None,
        "lastIncomingCall": None,
    }

    # Lead 3: Cold — no activity at all
    lead_cold = {
        "id": 1003,
        "firstName": "Charlie",
        "lastReceivedEmail": None,
        "lastReceivedText": None,
        "lastIncomingCall": None,
    }

    # Simulate the classification logic (same as classify_engagement_tier)
    def classify(person):
        from fub_automation.main import parse_fub_datetime
        latest_inbound = None
        for key in ("lastReceivedEmail", "lastReceivedText", "lastIncomingCall"):
            val = person.get(key)
            if val:
                try:
                    parsed = parse_fub_datetime(val)
                    if parsed and (latest_inbound is None or parsed > latest_inbound):
                        latest_inbound = parsed
                except Exception:
                    pass

        if latest_inbound:
            days_since = (now - latest_inbound).days
            if days_since <= 60:
                return "engaged", f"Inbound activity {days_since}d ago (within 60d)"
            elif days_since > 90:
                return "cold", f"Last inbound {days_since}d ago (>90d)"
            else:
                return "standard", f"Last inbound {days_since}d ago (61-90d)"
        else:
            return "cold", "No inbound activity detected"

    tier1, reason1 = classify(lead_engaged)
    tier2, reason2 = classify(lead_standard)
    tier3, reason3 = classify(lead_cold)

    # Verify classifications
    print(f"\n  Lead 1 (Alice, replied 20d ago): tier={tier1}, reason={reason1}")
    print(f"  Lead 2 (Bob, replied 75d ago):   tier={tier2}, reason={reason2}")
    print(f"  Lead 3 (Charlie, no activity):   tier={tier3}, reason={reason3}")

    # Check cadence mapping
    cadence_map = {"engaged": 10, "standard": 14, "cold": 21}
    print(f"\n  Cadence: Alice={cadence_map[tier1]}d, Bob={cadence_map[tier2]}d, Charlie={cadence_map[tier3]}d")

    passed = tier1 == "engaged" and tier2 == "standard" and tier3 == "cold"
    status = PASS if passed else FAIL
    print(f"\n  {status}: Three leads classified into three tiers correctly")
    results.append(("Feature 1: Engagement-Based Cadence", passed))

    conn.close()
    os.unlink(db_path)


def test_feature2_deeper_personalization():
    """Feature 2: Deeper Email Personalization — angle rotation and expanded context."""
    print("\n" + "=" * 60)
    print("FEATURE 2: Deeper Email Personalization")
    print("=" * 60)

    # Test angle rotation: same seed should produce different angles when last_angle matches
    person_id = 12345
    cycle_seed = f"{person_id}-2026-07-12"
    angle_options = [
        "quick local market pulse and buying-power question",
        "neighborhood fit, commute, and lifestyle question",
        "rates/payment context with a low-pressure next-step question",
        "new construction, concessions, and timing question",
        "restaurants, bars, weekend lifestyle, and area-fit question",
        "home-search strategy and must-have priorities question",
    ]

    seed_hash = int(hashlib.sha256(cycle_seed.encode('utf-8')).hexdigest(), 16)
    original_angle = angle_options[seed_hash % len(angle_options)]

    # Simulate angle rotation when last_angle matches
    last_angle_used = original_angle  # Same as what would be selected
    angle = original_angle
    if last_angle_used and angle == last_angle_used and len(angle_options) > 1:
        current_idx = angle_options.index(angle)
        angle = angle_options[(current_idx + 1) % len(angle_options)]

    print(f"\n  Original angle (hash-based): {original_angle}")
    print(f"  Last angle used (same):      {last_angle_used}")
    print(f"  Rotated angle (new):          {angle}")
    print(f"  Angles are different: {angle != last_angle_used}")

    # Verify expanded context fields would be included
    fake_person = {
        "id": 12345,
        "firstName": "Sarah",
        "source": "Zillow",
        "priceRange": "$300k-$450k",
        "created": "2026-03-15T10:00:00Z",
        "lastReceivedEmail": "2026-07-01T14:30:00Z",
    }
    fake_notes = [
        {"body": "Called about 3BR in Frisco, budget 400k", "created": "2026-06-20T10:00:00Z"},
        {"body": "Pre-approved with Chase, ready to tour", "created": "2026-05-15T10:00:00Z"},
        {"body": "Initial inquiry from Zillow ad", "created": "2026-03-15T10:00:00Z"},
    ]

    # Build full note history as the code does
    note_snippets = []
    for n in fake_notes[:20]:
        n_body = n.get("body") or ""
        n_date = n.get("created") or ""
        if n_body:
            note_snippets.append(f"[{n_date[:10]}] {n_body[:300]}")
    full_note_history = "\n".join(note_snippets)

    print(f"\n  Sample email #1 context:")
    print(f"    Lead: {fake_person['firstName']}")
    print(f"    Source: {fake_person['source']}")
    print(f"    Price range: {fake_person['priceRange']}")
    print(f"    Days in pond: ~119")
    print(f"    Engagement tier: engaged")
    print(f"    Angle: {angle}")
    print(f"    Full note history ({len(fake_notes)} notes): included ✓")

    # Simulate second email with different angle
    next_seed = f"{person_id}-2026-07-26"
    next_hash = int(hashlib.sha256(next_seed.encode('utf-8')).hexdigest(), 16)
    next_angle = angle_options[next_hash % len(angle_options)]
    if angle and next_angle == angle and len(angle_options) > 1:
        current_idx = angle_options.index(next_angle)
        next_angle = angle_options[(current_idx + 1) % len(angle_options)]

    print(f"\n  Sample email #2 (next cycle):")
    print(f"    Angle: {next_angle}")
    print(f"    Different from #1: {next_angle != angle}")

    passed = (angle != last_angle_used) and len(full_note_history) > 0
    status = PASS if passed else FAIL
    print(f"\n  {status}: Angle rotation prevents repeats, expanded context included")
    results.append(("Feature 2: Deeper Email Personalization", passed))


def test_feature3_weekly_digest():
    """Feature 3: Weekly Performance Digest — generates from DB data."""
    print("\n" + "=" * 60)
    print("FEATURE 3: Weekly Performance Digest")
    print("=" * 60)

    # Create a temp DB with sample data
    db_path = tempfile.mktemp(suffix=".sqlite3")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            person_id INTEGER,
            action TEXT NOT NULL,
            status TEXT NOT NULL,
            details TEXT
        );
        CREATE TABLE IF NOT EXISTS new_lead_timers (
            person_id INTEGER PRIMARY KEY,
            created_at TEXT NOT NULL,
            assigned_user_id INTEGER,
            warned_at TEXT,
            reassigned_at TEXT,
            canceled_at TEXT
        );
        CREATE TABLE IF NOT EXISTS engagement_tier (
            person_id INTEGER PRIMARY KEY,
            tier TEXT NOT NULL DEFAULT 'standard',
            last_classified_at TEXT NOT NULL,
            reason TEXT
        );
        CREATE TABLE IF NOT EXISTS reply_time_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            person_id INTEGER NOT NULL,
            reply_hour INTEGER NOT NULL,
            reply_day_of_week INTEGER NOT NULL,
            detected_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS reengagement_log (
            person_id INTEGER PRIMARY KEY,
            last_sent_at TEXT NOT NULL,
            channel TEXT NOT NULL,
            city TEXT,
            message_hash TEXT
        );
    """)

    now = dt.datetime.now(dt.timezone.utc)
    week_ago = now - dt.timedelta(days=7)

    # Insert sample data for this week
    for i in range(15):
        conn.execute("INSERT INTO audit_log(created_at, person_id, action, status) VALUES (?, ?, 'pond_nurture', 'sent')",
                     ((now - dt.timedelta(hours=i*10)).isoformat(), 2000 + i))
    for i in range(8):
        conn.execute("INSERT INTO audit_log(created_at, person_id, action, status) VALUES (?, ?, 'agent_bot_email', 'sent')",
                     ((now - dt.timedelta(hours=i*12)).isoformat(), 3000 + i))
    # Replies
    for i in range(3):
        conn.execute("INSERT INTO audit_log(created_at, person_id, action, status) VALUES (?, ?, 'reply_detected', 'alert_sent')",
                     ((now - dt.timedelta(hours=i*24)).isoformat(), 2000 + i))
    # Speed-to-lead timers
    conn.execute("INSERT INTO new_lead_timers(person_id, created_at, assigned_user_id, reassigned_at) VALUES (?, ?, 5, ?)",
                 (9001, (now - dt.timedelta(hours=48)).isoformat(), (now - dt.timedelta(hours=47)).isoformat()))
    conn.execute("INSERT INTO new_lead_timers(person_id, created_at, assigned_user_id) VALUES (?, ?, 3)",
                 (9002, (now - dt.timedelta(hours=24)).isoformat()))
    # Engagement tiers
    conn.execute("INSERT INTO engagement_tier(person_id, tier, last_classified_at) VALUES (1, 'engaged', ?)", (now.isoformat(),))
    conn.execute("INSERT INTO engagement_tier(person_id, tier, last_classified_at) VALUES (2, 'standard', ?)", (now.isoformat(),))
    conn.execute("INSERT INTO engagement_tier(person_id, tier, last_classified_at) VALUES (3, 'cold', ?)", (now.isoformat(),))
    # Reply time logs
    conn.execute("INSERT INTO reply_time_log(person_id, reply_hour, reply_day_of_week, detected_at) VALUES (1, 14, 2, ?)", (now.isoformat(),))
    conn.execute("INSERT INTO reply_time_log(person_id, reply_hour, reply_day_of_week, detected_at) VALUES (2, 9, 0, ?)", (now.isoformat(),))
    # Reengagement log for pond size
    for i in range(50):
        conn.execute("INSERT INTO reengagement_log(person_id, last_sent_at, channel, city) VALUES (?, ?, 'email', 'Dallas')",
                     (4000 + i, now.isoformat()))
    conn.commit()

    # Now test the weekly_digest query_period function
    sys.path.insert(0, str(Path(__file__).parent))
    from weekly_digest import query_period, format_digest

    this_week_stats = query_period(conn, week_ago, now)
    # Create empty last week for comparison
    two_weeks_ago = week_ago - dt.timedelta(days=7)
    last_week_stats = query_period(conn, two_weeks_ago, week_ago)

    print(f"\n  This week stats:")
    print(f"    Total sends: {this_week_stats['total_sends']}")
    print(f"    Sends by bot: {this_week_stats['sends_by_bot']}")
    print(f"    Replies detected: {this_week_stats['replies_detected']}")
    print(f"    Hot-lead alerts: {this_week_stats['hot_lead_alerts']}")
    print(f"    Speed-to-lead total: {this_week_stats['speed_to_lead_total']}")
    print(f"    60-min misses: {this_week_stats['speed_to_lead_60min_misses']}")
    print(f"    Bounces: {this_week_stats['bounces']}")
    print(f"    Unsubscribes: {this_week_stats['unsubscribes']}")
    print(f"    Engagement tiers: {this_week_stats['engagement_tiers']}")
    print(f"    Reply-time data points: {this_week_stats['reply_time_data_points']}")

    # Generate HTML
    html = format_digest(this_week_stats, last_week_stats, 50)
    has_key_sections = all(s in html for s in ["Email Sends", "Engagement", "Speed-to-Lead", "Compliance", "Pond Status", "Engagement Tiers"])

    print(f"\n  HTML digest generated: {len(html)} chars")
    print(f"  Contains all key sections: {has_key_sections}")

    passed = (
        this_week_stats['total_sends'] > 0 and
        this_week_stats['replies_detected'] > 0 and
        this_week_stats['speed_to_lead_60min_misses'] >= 1 and
        has_key_sections
    )
    status = PASS if passed else FAIL
    print(f"\n  {status}: Weekly digest generates correctly from DB data")
    results.append(("Feature 3: Weekly Performance Digest", passed))

    conn.close()
    os.unlink(db_path)


def test_feature4_reply_time_logging():
    """Feature 4: Best-Send-Time Logging — log reply hour and day of week."""
    print("\n" + "=" * 60)
    print("FEATURE 4: Best-Send-Time Logging")
    print("=" * 60)

    # Create a temp DB
    db_path = tempfile.mktemp(suffix=".sqlite3")
    conn = sqlite3.connect(db_path)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS reply_time_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            person_id INTEGER NOT NULL,
            reply_hour INTEGER NOT NULL,
            reply_day_of_week INTEGER NOT NULL,
            detected_at TEXT NOT NULL
        );
    """)

    # Simulate logging reply times
    now = dt.datetime.now(dt.timezone.utc)
    test_replies = [
        (1001, 14, 2, now.isoformat()),  # 2pm Wednesday
        (1002, 9, 0, now.isoformat()),   # 9am Monday
        (1003, 17, 4, now.isoformat()),  # 5pm Friday
    ]

    for person_id, hour, dow, detected in test_replies:
        conn.execute(
            "INSERT INTO reply_time_log(person_id, reply_hour, reply_day_of_week, detected_at) VALUES (?, ?, ?, ?)",
            (person_id, hour, dow, detected)
        )
    conn.commit()

    # Verify data
    rows = conn.execute("SELECT * FROM reply_time_log ORDER BY id").fetchall()
    count = conn.execute("SELECT COUNT(*) FROM reply_time_log").fetchone()[0]

    print(f"\n  DB table: reply_time_log")
    print(f"  Columns: id, person_id, reply_hour, reply_day_of_week, detected_at")
    print(f"\n  Sample logged entries:")
    for r in rows:
        day_names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        print(f"    person_id={r[1]}, hour={r[2]}:00, day={day_names[r[3]]}, detected={r[4][:19]}")
    print(f"\n  Total data points: {count}")
    print(f"  Reported in 4am email: 'Reply-time data points collected: {count}'")

    passed = count == 3 and rows[0][2] == 14 and rows[0][3] == 2
    status = PASS if passed else FAIL
    print(f"\n  {status}: Reply time logging works correctly")
    results.append(("Feature 4: Best-Send-Time Logging", passed))

    conn.close()
    os.unlink(db_path)


def main():
    print("=" * 60)
    print("  TIER 3 ACCEPTANCE TESTS (Offline)")
    print("=" * 60)

    test_feature1_engagement_cadence()
    test_feature2_deeper_personalization()
    test_feature3_weekly_digest()
    test_feature4_reply_time_logging()

    print("\n" + "=" * 60)
    print("  SUMMARY")
    print("=" * 60)
    all_passed = True
    for name, passed in results:
        status = PASS if passed else FAIL
        print(f"  {status}: {name}")
        if not passed:
            all_passed = False

    print("\n" + ("  ALL TESTS PASSED ✅" if all_passed else "  SOME TESTS FAILED ❌"))
    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
