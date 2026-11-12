"""One shared synthetic API-visible history contract; no client or transport."""
import copy
import json
from pathlib import Path

import pytest
from fub_automation import portal

SHARED = json.loads((Path(__file__).parent / "fixtures" / "portal_history_parity.json").read_text())


def test_history_fixture_cardinality():
    assert len(SHARED["cases"]) == 90
    assert len({case["name"] for case in SHARED["cases"]}) == 90


@pytest.mark.parametrize("case", SHARED["cases"], ids=lambda case: case["name"])
def test_common_api_visible_history_contract(case):
    requests = []
    pages = iter(copy.deepcopy(case["pages"]))

    def loader(person_id, *, next_cursor=None, offset=None):
        requests.append((person_id, next_cursor, offset))
        if case["error"]:
            raise RuntimeError("SYNTHETIC_HISTORY_FAILURE")
        return next(pages)

    result = portal.scan_portal_event_history(SHARED["personId"], loader)
    classification = "allow" if result.allowed else "block" if result.reason == portal.PORTAL_EXCLUDED else "defer"
    assert classification == case["expected"]
    assert len(requests) <= 5
    assert all(person_id == SHARED["personId"] for person_id, _, _ in requests)
    if case["name"] in {"nextLink_invalid_percent", "nextLink_invalid_utf8", "nextLink_traversal", "null_primary_terminal_link_contradiction"}:
        assert len(requests) == 1
        assert result.reason == portal.PORTAL_HISTORY_INCOMPLETE
