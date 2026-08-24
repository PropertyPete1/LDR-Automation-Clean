"""diagnose_reply_surfaces.py — the read-only surface probe.

Light coverage on purpose: the script is a printer over GETs. What matters is
that its output can be pasted into a chat or an issue without leaking contact
details, and that it stays read-only.
"""
from __future__ import annotations

import ast
import importlib.util
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "diagnose_reply_surfaces.py"

_spec = importlib.util.spec_from_file_location("diagnose_reply_surfaces", SCRIPT)
drs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(drs)  # type: ignore[union-attr]


def test_redaction_masks_emails_and_phones():
    body = ("Please reach me at joe_munoz@att.net or 512-555-0142 instead — "
            "and my office line is (512) 555 0100.")
    out = drs.clip_and_redact(body, 200)
    assert "att.net" not in out
    assert "0142" not in out and "0100" not in out
    assert "[email]" in out and "[phone]" in out


def test_redaction_clips_and_flattens():
    out = drs.clip_and_redact("line one\nline two\t\tspaced", 100)
    assert "\n" not in out and "\t" not in out
    assert drs.clip_and_redact("x" * 500, 100) == "x" * 100
    assert drs.clip_and_redact(None) == ""


def test_the_script_never_writes_to_fub():
    """Every fub._request in this file is a GET — enforced structurally, so a
    future edit cannot quietly add a write to a 'read-only' diagnostic."""
    tree = ast.parse(SCRIPT.read_text())
    methods = [
        node.args[0].value
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute) and node.func.attr == "_request"
        and node.args and isinstance(node.args[0], ast.Constant)
    ]
    assert methods, "expected _request calls to inspect"
    assert set(methods) == {"GET"}, f"non-GET FUB calls in a read-only script: {methods}"
