#!/usr/bin/env python3
"""Read-only: which KEYS FUB returns on the assignment-change walk's exact call
(GET /people sort=-updated limit=100, no `fields`). Key names only — no values."""
import collections, os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))
os.environ["DRY_RUN"] = "true"
from fub_automation.main import FollowUpBossClient, Settings
fub = FollowUpBossClient(Settings.from_env())
data = fub._request("GET", "/people", params={"sort": "-updated", "limit": 100})
people = data.get("people", [])
keys = collections.Counter(k for p in people for k in p.keys())
print(f"people on the page: {len(people)}")
print(f"records carrying 'source': {keys.get('source', 0)} | 'tags': {keys.get('tags', 0)} | 'stage': {keys.get('stage', 0)}")
print("all keys:", ", ".join(sorted(keys)))
