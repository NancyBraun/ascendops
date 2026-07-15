#!/usr/bin/env python3
"""Tests for the mmrag persistence-point SSN scrub (scrub_ssn).

Mirror-of-record for src/utils/ssn-redaction.ts on the KB ingest surface.
Run standalone: `python3 test_scrub_ssn.py` (also pytest-discoverable).
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mmrag import scrub_ssn  # noqa: E402

P = "[REDACTED-SSN]"


def test_formatted_variants():
    assert scrub_ssn("123-45-6789") == P
    assert scrub_ssn("123 45 6789") == P
    assert scrub_ssn("123.45.6789") == P          # dotted (F1/F5 parity)
    assert scrub_ssn("Tenant SSN 123-45-6789 ok") == f"Tenant SSN {P} ok"


def test_context_keyed_bare9():
    assert scrub_ssn("SSN: 987654321") == f"SSN: {P}"
    assert scrub_ssn("tax id: 123456789") == f"tax id: {P}"
    assert scrub_ssn("social security 987654321") == f"social security {P}"
    assert scrub_ssn("987654321 is the SSN") == f"{P} is the SSN"


def test_conservative_keeps_bare9_and_phones():
    assert scrub_ssn("order 987654321 shipped") == "order 987654321 shipped"
    assert scrub_ssn("Call Alex at 423-555-0142") == "Call Alex at 423-555-0142"
    assert scrub_ssn("423.555.0142 ip 192.168.10.1") == "423.555.0142 ip 192.168.10.1"


def test_horizontal_separator_only():
    # three unrelated numbers across lines must NOT match (horizontal sep only)
    assert scrub_ssn("123\n45\n6789") == "123\n45\n6789"
    assert scrub_ssn("123\r\n45\r\n6789") == "123\r\n45\r\n6789"
    # ...but a tab-separated single-line SSN IS caught (parity with JS)
    assert scrub_ssn("123\t45\t6789") == P


def test_aggressive_env_flag():
    os.environ["SSN_REDACT_AGGRESSIVE"] = "1"
    try:
        assert scrub_ssn("order 987654321 shipped") == f"order {P} shipped"
    finally:
        del os.environ["SSN_REDACT_AGGRESSIVE"]
    # default conservative again
    assert scrub_ssn("order 987654321 shipped") == "order 987654321 shipped"


def test_empty_and_none():
    assert scrub_ssn("") == ""
    assert scrub_ssn(None) is None


def test_shared_corpus():
    """Assert the SAME corpus the JS test uses, so the two redactors stay in
    lockstep. Pins exact output AND idempotency for every matcher case."""
    import json
    corpus_path = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "ssn-corpus.json"
    cases = json.loads(corpus_path.read_text())["cases"]
    assert len(cases) >= 20, "corpus shrank unexpectedly"
    for c in cases:
        got = scrub_ssn(c["input"])
        assert got == c["expect"], f"{c['name']}: {got!r} != {c['expect']!r}"
        assert scrub_ssn(got) == got, f"{c['name']}: not idempotent ({got!r})"


def _load_fixture(name):
    import json
    path = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / name
    return [tuple(r) for r in json.loads(path.read_text())["ranges"]]


def test_invis_set_parity():
    """Non-circular drift-guard via the SHARED fixture. mmrag._INVIS_RANGES (python
    has no \\p{}) must equal tests/fixtures/invis-ranges.json — the SAME fixture the
    JS test re-derives the LIVE Node \\p{Cf}\\p{Default_Ignorable} against. So
    live-Node == fixture (JS test) == python (here), transitively; a drift on either
    side fails. (Earlier this asserted a hardcoded list against itself = circular;
    the shared fixture closes that.)"""
    import mmrag
    assert mmrag._INVIS_RANGES == _load_fixture("invis-ranges.json"), \
        "mmrag _INVIS_RANGES desynced from the shared invis-ranges.json fixture"


def test_label_sep_parity():
    """mmrag._LABEL_SEP must be built exactly from tests/fixtures/label-sep-ranges.json
    (= JS \\s UNION python \\s + underscore), the SAME fixture the JS LABEL_SEP test
    pins against — so the explicit label separator is char-for-char identical in both
    runtimes (JS \\s and python \\s are INCOMPARABLE, so neither runtime's \\s alone
    is safe). Also asserts the fixture is a SUPERSET of live python \\s (no
    regression: every whitespace python used to match is still in the class)."""
    import re as _re
    import mmrag
    ranges = _load_fixture("label-sep-ranges.json")

    def _u(cp):
        return "\\u%04x" % cp
    expected = "[" + "".join(_u(a) if a == b else _u(a) + "-" + _u(b) for a, b in ranges) + "]"
    assert mmrag._LABEL_SEP == expected, "mmrag _LABEL_SEP desynced from label-sep-ranges.json"
    # fixture ⊇ live python \s
    for cp in range(0x110000):
        if _re.match(r"\s", chr(cp)):
            assert any(a <= cp <= b for a, b in ranges), f"python \\s U+{cp:04X} missing from LABEL_SEP fixture"


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except AssertionError as e:
                failures += 1
                print(f"FAIL {name}: {e}")
    print("ALL PASS" if failures == 0 else f"{failures} FAILED")
    sys.exit(1 if failures else 0)
