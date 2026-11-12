"""Synthetic event-page payloads; no gate replacement or default authorization."""


def complete_history(person_id, *, next_cursor=None, offset=None):
    assert type(person_id) is int and person_id > 0
    assert next_cursor is None and offset is None
    return {"events": [], "_metadata": {"collection": "events", "total": 0}}
