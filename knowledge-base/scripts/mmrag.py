#!/usr/bin/env python3
"""
mmrag - Multimodal RAG Knowledge Base CLI

Ingest videos, images, audio, documents into a local ChromaDB vector database
using Gemini Embedding 2 for multimodal embeddings and Gemini Flash for
generating text descriptions of non-text media.

Usage:
    mmrag.py ingest <path> [<path>...] [--collection NAME]
    mmrag.py query <question> [--top-k N] [--threshold F] [--max-tokens N] [--collection NAME] [--json] [--full]
    mmrag.py status [--collection NAME]
    mmrag.py list [--collection NAME]
    mmrag.py collections
    mmrag.py delete <path> [--collection NAME]
    mmrag.py reset --confirm
"""

import argparse
import hashlib
import json
import mimetypes
import os
import subprocess
import sys
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
# cortextOS env-var overrides (set by kb-*.sh scripts)
MMRAG_DIR = Path(os.environ.get("MMRAG_DIR", str(Path.home() / ".mmrag")))
CONFIG_FILE = Path(os.environ.get("MMRAG_CONFIG", str(MMRAG_DIR / "config.json")))
CHROMADB_DIR = Path(os.environ.get("MMRAG_CHROMADB_DIR", str(MMRAG_DIR / "chromadb")))
MEDIA_DIR = MMRAG_DIR / "media"
LOG_DIR = MMRAG_DIR / "logs"

VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}
AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".ogg", ".flac"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
DOC_EXTS = {".pdf", ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls"}
TEXT_EXTS = {".txt", ".md", ".csv", ".json", ".py", ".js", ".ts", ".go",
             ".rs", ".java", ".cpp", ".c", ".sh", ".yaml", ".yml", ".toml",
             ".html", ".css", ".sql", ".rb", ".swift", ".kt", ".r", ".lua"}

# Defaults
DEFAULT_TEXT_CHUNK_SIZE = 1500
DEFAULT_TEXT_CHUNK_OVERLAP = 200
DEFAULT_VIDEO_CHUNK_SECONDS = 60
DEFAULT_VIDEO_OVERLAP_SECONDS = 15
DEFAULT_AUDIO_CHUNK_SECONDS = 60
DEFAULT_AUDIO_OVERLAP_SECONDS = 10
DEFAULT_EMBEDDING_DIMENSIONS = 768
DEFAULT_SIMILARITY_THRESHOLD = 0.0  # return everything by default, let caller filter
DEFAULT_MAX_TOKENS = 0  # 0 = unlimited
DEFAULT_PREVIEW_CHARS = 300
DEFAULT_RERANK_ENABLED = False
DEFAULT_RERANK_MODEL = "cross-encoder/ms-marco-MiniLM-L-6-v2"
DEFAULT_RERANK_OVERFETCH = 5

# Pricing (per 1M tokens)
EMBEDDING_PRICE_PER_M = 0.20
FLASH_INPUT_PRICE_PER_M = 0.15
FLASH_OUTPUT_PRICE_PER_M = 0.60

# Retry classifier for the Gemini generate_content call inside ingest_pdf.
# Module-level so a fault-injection test client can reference the same set.
TRANSIENT_HTTP_CODES = {429, 500, 503}
TRANSIENT_STATUS_NAMES = {"UNAVAILABLE", "RESOURCE_EXHAUSTED"}

USAGE_FILE = MMRAG_DIR / "usage.json"

# ---------------------------------------------------------------------------
# Usage Tracker
# ---------------------------------------------------------------------------
_tracker = None  # module-level, set by cmd_ingest/cmd_query
_reranker = None
_reranker_model_name = None


class UsageTracker:
    def __init__(self, operation="unknown"):
        self.session = {
            "embedding_tokens": 0,
            "embedding_calls": 0,
            "generation_input_tokens": 0,
            "generation_output_tokens": 0,
            "generation_calls": 0,
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "operation": operation,
        }

    def track_embedding(self, content):
        self.session["embedding_calls"] += 1
        if isinstance(content, str):
            self.session["embedding_tokens"] += int(len(content.split()) * 1.3)
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, str):
                    self.session["embedding_tokens"] += int(len(part.split()) * 1.3)
                else:
                    try:
                        self.session["embedding_tokens"] += max(256, len(part.data) // 4)
                    except Exception:
                        self.session["embedding_tokens"] += 256

    def track_generation(self, response):
        self.session["generation_calls"] += 1
        um = getattr(response, "usage_metadata", None)
        if um:
            self.session["generation_input_tokens"] += getattr(um, "prompt_token_count", 0) or 0
            self.session["generation_output_tokens"] += getattr(um, "candidates_token_count", 0) or 0

    def cost(self):
        emb = (self.session["embedding_tokens"] / 1_000_000) * EMBEDDING_PRICE_PER_M
        gen_in = (self.session["generation_input_tokens"] / 1_000_000) * FLASH_INPUT_PRICE_PER_M
        gen_out = (self.session["generation_output_tokens"] / 1_000_000) * FLASH_OUTPUT_PRICE_PER_M
        return {
            "embedding": round(emb, 6),
            "generation_input": round(gen_in, 6),
            "generation_output": round(gen_out, 6),
            "total": round(emb + gen_in + gen_out, 6),
        }

    def persist(self):
        MMRAG_DIR.mkdir(parents=True, exist_ok=True)
        self.session["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        self.session["cost"] = self.cost()

        data = {"cumulative": {}, "sessions": []}
        if USAGE_FILE.exists():
            try:
                with open(USAGE_FILE) as f:
                    data = json.load(f)
            except (json.JSONDecodeError, KeyError):
                data = {"cumulative": {}, "sessions": []}

        data.setdefault("sessions", []).append(self.session)

        c = data.get("cumulative", {})
        for key in ["embedding_tokens", "embedding_calls",
                     "generation_input_tokens", "generation_output_tokens",
                     "generation_calls"]:
            c[key] = c.get(key, 0) + self.session[key]

        c["total_cost"] = round(sum(
            s.get("cost", {}).get("total", 0) for s in data["sessions"]
        ), 6)
        data["cumulative"] = c

        with open(USAGE_FILE, "w") as f:
            json.dump(data, f, indent=2)

    def summary_line(self):
        c = self.cost()
        return (f"  Tokens: {self.session['embedding_tokens']:,} embedding, "
                f"{self.session['generation_input_tokens']:,} gen-input, "
                f"{self.session['generation_output_tokens']:,} gen-output | "
                f"Cost: ${c['total']:.4f}")


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
def load_config():
    if not CONFIG_FILE.exists():
        print("ERROR: Config not found. Run setup first:")
        print(f"  bash {Path(__file__).parent / 'setup.sh'}")
        sys.exit(1)
    with open(CONFIG_FILE) as f:
        config = json.load(f)
    config.setdefault("rerank_enabled", DEFAULT_RERANK_ENABLED)
    config.setdefault("rerank_model", DEFAULT_RERANK_MODEL)
    config.setdefault("rerank_overfetch", DEFAULT_RERANK_OVERFETCH)
    return config


def get_api_key(config):
    key = os.environ.get("GEMINI_API_KEY") or config.get("gemini_api_key")
    if not key:
        print("ERROR: No Gemini API key. Set GEMINI_API_KEY or run setup.")
        sys.exit(1)
    return key

# ---------------------------------------------------------------------------
# Gemini clients
# ---------------------------------------------------------------------------
def _load_factory(dotted_path):
    """Resolve a dotted import path to a callable.

    Accepts 'pkg.mod.attr' or 'pkg.mod:attr'. The colon form is unambiguous when
    the attribute name collides with a submodule name, so it is preferred.
    """
    if ":" in dotted_path:
        module_path, _, attr_path = dotted_path.partition(":")
    else:
        module_path, _, attr_path = dotted_path.rpartition(".")
    if not module_path or not attr_path:
        raise ValueError(
            f"MMRAG_GEMINI_CLIENT_FACTORY {dotted_path!r} must be 'module.attr' or 'module:attr'"
        )
    import importlib
    obj = importlib.import_module(module_path)
    for part in attr_path.split("."):
        obj = getattr(obj, part)
    if not callable(obj):
        raise TypeError(
            f"MMRAG_GEMINI_CLIENT_FACTORY {dotted_path!r} resolved to non-callable {type(obj).__name__}"
        )
    return obj


def get_genai_client(api_key):
    """Construct a Gemini client.

    Default returns google.genai.Client(api_key=api_key) — byte-identical to
    the prior behavior. To inject a fake client (e.g. for testing the retry
    loop in ingest_pdf), set the env-var MMRAG_GEMINI_CLIENT_FACTORY to a
    dotted import path of a callable taking (api_key) and returning an object
    with .models.generate_content / .models.embed_content compatible shape.
    See knowledge-base/scripts/_test_clients/fault_injection.py for a reference.
    """
    factory_path = os.environ.get("MMRAG_GEMINI_CLIENT_FACTORY")
    if factory_path:
        return _load_factory(factory_path)(api_key)
    from google import genai
    return genai.Client(api_key=api_key)


def _retry_generate_content(client, *, model, contents, backoffs=(5, 15, 45)):
    """Call client.models.generate_content with bounded retries on transient APIErrors.

    Retries on HTTP code in TRANSIENT_HTTP_CODES or status name in
    TRANSIENT_STATUS_NAMES; re-raises immediately on any other APIError (auth,
    malformed request, etc.); re-raises last_err after all attempts exhausted.

    backoffs is a tuple of sleep seconds between attempts. len(backoffs) is the
    attempt count. Tests pass (0, 0, 0) to skip sleeps.
    """
    from google.genai import errors as _genai_errors
    last_err = None
    for attempt, backoff in enumerate(backoffs, start=1):
        try:
            return client.models.generate_content(model=model, contents=contents)
        except _genai_errors.APIError as e:
            last_err = e
            is_transient = (e.code in TRANSIENT_HTTP_CODES) or (e.status in TRANSIENT_STATUS_NAMES)
            if not is_transient:
                raise
            if attempt < len(backoffs):
                print(f"    Transient error (HTTP {e.code} {e.status or ''}); retrying in {backoff}s (attempt {attempt}/{len(backoffs)})")
                time.sleep(backoff)
            else:
                print(f"    Exhausted retries on transient error: HTTP {e.code} {e.status or ''}")
    raise last_err if last_err else RuntimeError("retry loop completed without response or error")


def embed_content(client, config, content, task_type="RETRIEVAL_DOCUMENT"):
    """Embed content using Gemini Embedding 2. Content can be text string or list of Parts."""
    from google.genai import types
    result = client.models.embed_content(
        model=config.get("embedding_model", "gemini-embedding-2-preview"),
        contents=content,
        config=types.EmbedContentConfig(
            output_dimensionality=config.get("embedding_dimensions", DEFAULT_EMBEDDING_DIMENSIONS),
            task_type=task_type,
        ),
    )
    if _tracker:
        _tracker.track_embedding(content)
    return result.embeddings[0].values


def embed_multimodal(client, config, description_text, media_bytes, mime_type):
    """
    Option B embedding: combine text description + raw media into one embedding.
    This captures both semantic text meaning AND visual/audio content.
    """
    from google.genai import types
    contents = [
        description_text,
        types.Part.from_bytes(data=media_bytes, mime_type=mime_type),
    ]
    return embed_content(client, config, contents)


def embed_query(client, config, query_text):
    """Embed a query string for retrieval."""
    return embed_content(client, config, query_text, task_type="RETRIEVAL_QUERY")


def describe_media(client, config, file_path, media_type="video"):
    """Use Gemini Flash to generate a text description of media."""
    from google.genai import types

    mime = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
    with open(file_path, "rb") as f:
        data = f.read()

    prompts = {
        "video": (
            "Provide a detailed description of this video. Include:\n"
            "1. What is being shown/demonstrated\n"
            "2. Any text visible on screen\n"
            "3. Key concepts or topics discussed\n"
            "4. A transcript of any spoken words\n"
            "5. Step-by-step actions if it's a tutorial\n"
            "Be thorough - this description will be used for search and retrieval."
        ),
        "image": (
            "Describe this image in detail. Include:\n"
            "1. What is shown in the image\n"
            "2. Any text visible in the image\n"
            "3. Key concepts or topics depicted\n"
            "4. Colors, layout, and composition\n"
            "Be thorough - this description will be used for search and retrieval."
        ),
        "audio": (
            "Transcribe and describe this audio. Include:\n"
            "1. A full transcript of spoken words\n"
            "2. Description of any sounds or music\n"
            "3. Key topics discussed\n"
            "4. Speaker identification if possible\n"
            "Be thorough - this description will be used for search and retrieval."
        ),
    }

    response = client.models.generate_content(
        model=config.get("gemini_model", "gemini-2.5-flash"),
        contents=[
            types.Part.from_bytes(data=data, mime_type=mime),
            prompts.get(media_type, prompts["video"]),
        ],
    )
    if _tracker:
        _tracker.track_generation(response)
    # Scrub the Gemini transcription/description at the source so EVERY media
    # ingest path (image/video/audio) persists and embeds redacted text — this
    # closes the scanned-SSN-document path (an SSN visible in a PDF/image that
    # Gemini transcribes). The embedding is computed on the scrubbed text too.
    return scrub_ssn(response.text), data, mime

# ---------------------------------------------------------------------------
# ChromaDB
# ---------------------------------------------------------------------------
def get_chroma_collection(collection_name="default"):
    import chromadb
    client = chromadb.PersistentClient(path=str(CHROMADB_DIR))
    return client.get_or_create_collection(
        name=collection_name,
        metadata={"hnsw:space": "cosine"},
    )


def get_chroma_client():
    import chromadb
    return chromadb.PersistentClient(path=str(CHROMADB_DIR))

# ---------------------------------------------------------------------------
# PII (SSN) redaction — persistence-point scrub
#
# Mirror of src/utils/ssn-redaction.ts (the canonical redactor used by the
# PTY / event / bus layers). Enforced HERE because KB ingest passes file PATHS
# to this tool, which reads/transcribes each file and embeds the text — this is
# the only point where the FINAL text (including the Gemini transcription of a
# binary, e.g. a scanned SSN doc) exists in-process before it is persisted to
# ChromaDB. Scrubbing here preserves the original source path (shared-collection
# allowlist, provenance, dedup, delete-by-path all keep working), covers
# directory inputs and media alike, and has no read/scrub TOCTOU.
#
# Fail-CLOSED: scrub_ssn is pure and raises only on a programming error; that
# error is allowed to propagate and abort the ingest. Raw text is NEVER
# embedded as a fallback. Keep this pattern set in sync with ssn-redaction.ts.
# ---------------------------------------------------------------------------
import re as _re

SSN_PLACEHOLDER = "[REDACTED-SSN]"
# Formatted-SSN separator — parity with SSN_SEP in ssn-redaction.ts: ASCII
# dash/dot/tab/space PLUS the Unicode Zs horizontal spaces (NBSP, figure, narrow,
# thin, ideographic, ...) so an SSN typed with a non-ASCII space is caught.
# Line/para separators excluded (like newline).
_SSN_SEP = r"[-.\t \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]"
# re.ASCII on the DIGIT/BOUNDARY patterns pins \b (and \w, \d) to ASCII so they
# match JS exactly. JS \b is ASCII-word-based while Python \b is Unicode-aware,
# so without this a letter-adjacent SSN (`café123-45-6789`) is redacted by JS
# (é is non-word in ASCII → the boundary fires) but LEAKED by Python (é is a
# Unicode word char → no boundary) — a real divergence at the KB-ingest sink.
# [0-9] is kept explicit (US SSNs are ASCII digits; Unicode digit scripts are an
# accepted boundary). re.ASCII is applied ONLY here, NOT to the label patterns
# below: JS \s IS Unicode-aware (matches NBSP), so the labels must keep Unicode
# \s to stay in parity. SSN_SEP is explicit codepoints, untouched by re.ASCII.
# Invisible / format chars (Unicode \p{Cf} + \p{Default_Ignorable_Code_Point})
# tolerated BETWEEN an SSN's digits, mirroring INVIS in ssn-redaction.ts. Python
# `re` has no \p{}, so this codepoint set is GENERATED from the JS class
# /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u (node) and pinned char-for-char by
# the drift-guard test — NOT hand-maintained. Handled IN-PATTERN (matched as part
# of the SSN span, redacted with it), NOT stripped from output, so a legit
# load-bearing ZWJ/ZWNJ in Indic text or an emoji sequence elsewhere stays
# byte-identical. INVIS and [0-9] are disjoint → no catastrophic backtracking.
_INVIS_RANGES = [
    (0xAD, 0xAD), (0x34F, 0x34F), (0x600, 0x605), (0x61C, 0x61C), (0x6DD, 0x6DD),
    (0x70F, 0x70F), (0x890, 0x891), (0x8E2, 0x8E2), (0x115F, 0x1160), (0x17B4, 0x17B5),
    (0x180B, 0x180F), (0x200B, 0x200F), (0x202A, 0x202E), (0x2060, 0x206F), (0x3164, 0x3164),
    (0xFE00, 0xFE0F), (0xFEFF, 0xFEFF), (0xFFA0, 0xFFA0), (0xFFF0, 0xFFFB), (0x110BD, 0x110BD),
    (0x110CD, 0x110CD), (0x13430, 0x1343F), (0x1BCA0, 0x1BCA3), (0x1D173, 0x1D17A), (0xE0000, 0xE0FFF),
]
def _u(cp):
    # Emit a regex \uXXXX / \UXXXXXXXX ESCAPE (text), not the literal codepoint —
    # building the class from literal invisible/bidi chars both pollutes the source
    # and miscompiles (a literal bidi codepoint corrupts the class parse).
    return ("\\u%04x" % cp) if cp <= 0xFFFF else ("\\U%08x" % cp)


_INVIS = "[" + "".join(_u(lo) if lo == hi else _u(lo) + "-" + _u(hi) for lo, hi in _INVIS_RANGES) + "]*"


def _ssn_digits(n):
    """`n` ASCII digits with optional invisibles interleaved between them."""
    return "[0-9]" + ("(?:" + _INVIS + "[0-9])") * (n - 1)


# Each group stays EXACTLY 3/2/4 VISIBLE digits (INVIS adds no digit), so the
# 3-2-4 shape never loosens into a 3-3-4 phone.
# Boundary anchors: digit-only negative lookbehind/lookahead, NOT \b — mirrors
# SSN_LEAD/SSN_TRAIL in ssn-redaction.ts, so an SSN glued to a letter/underscore
# is found while a 10+-digit run has no sub-9. Python lookbehind is fixed-width
# (digit-only qualifies) = JS parity. NOT digit-or-dash (a dash would make
# `ssn-123-45-6789` survive). re.ASCII keeps \b/\d ASCII elsewhere.
_SSN_LEAD = r"(?<![0-9])"
_SSN_TRAIL = r"(?![0-9])"
_SSN_FORMATTED = _re.compile(
    _SSN_LEAD + _ssn_digits(3) + _INVIS + _SSN_SEP + _INVIS + _ssn_digits(2)
    + _INVIS + _SSN_SEP + _INVIS + _ssn_digits(4) + _SSN_TRAIL,
    _re.ASCII,
)
_SSN_NINE = _re.compile(_SSN_LEAD + r"[0-9](?:" + _INVIS + r"[0-9]){8}" + _SSN_TRAIL, _re.ASCII)
# Label-internal separator — MIRRORS LABEL_SEP in ssn-redaction.ts. NOT \s: JS \s
# and python \s are INCOMPARABLE (JS has U+FEFF; python has U+0085/NEL + U+1C-1F),
# so a \s label would redact social<FEFF>security in JS but LEAK it in this python
# KB sink (and vice-versa for NEL). LABEL_SEP is the UNION of JS \s ∪ python \s +
# underscore — a superset of both, identical on both runtimes — pinned to
# tests/fixtures/label-sep-ranges.json (drift-guard asserts live python \s ⊆ it).
# re.ASCII pins the label case-fold to ASCII (= JS /i; neither folds ſ→s): after
# [\s_]→LABEL_SEP the label has no \s/\w/\b/\d, so re.ASCII only affects case-fold
# (the [\s\S]{0,16} gap stays any-char). Mirrors the JS label patterns exactly.
_LABEL_SEP = (
    "[\\u0009-\\u000d\\u001c-\\u0020\\u002d\\u005f\\u0085\\u00a0\\u1680"
    "\\u2000-\\u200a\\u2028-\\u2029\\u202f\\u205f\\u3000\\ufeff]"
)
_LABEL_ALT = r"(?:ssn|social" + _LABEL_SEP + r"+security|tax" + _LABEL_SEP + r"*id)"
_SSN_LABEL = _re.compile(_LABEL_ALT, _re.IGNORECASE | _re.ASCII)
# In-text promotion keyed on the label END within _SSN_GAP chars of the number,
# over an _SSN_LOOKBACK window — parity with ssn-redaction.ts. Anchoring on the
# label END lets a long label ("social security number") promote; the tight GAP
# keeps a label for ANOTHER nearby number from bleeding across.
_SSN_GAP = 16
_SSN_LOOKBACK = 40
# [\s\S]{0,16} (not .{0,16}) so the label<->number gap may span a NEWLINE — a
# label on the adjacent line still promotes (SSN:\n987654321 / pretty-JSON).
# GAP only; the formatted separator stays horizontal so 123\n45\n6789 is safe.
_SSN_LABEL_BEFORE = _re.compile(_LABEL_ALT + r"[\s\S]{0,16}$", _re.IGNORECASE | _re.ASCII)
_SSN_LABEL_AFTER = _re.compile(r"^[\s\S]{0,16}" + _LABEL_ALT, _re.IGNORECASE | _re.ASCII)

# ---------------------------------------------------------------------------
# PII v2 milestone-2 — EIN, routing number, bank account. Direct ports of the
# canonical TS registry entries (src/utils/ssn-redaction.ts). Same primitives
# (_SSN_SEP, _INVIS, _SSN_LEAD/_SSN_TRAIL, _LABEL_SEP, _SSN_GAP/_LOOKBACK), same
# label sets, same registry ORDER (SSN > EIN > ROUTING > BANK_ACCT). re.ASCII on
# the digit/boundary patterns keeps \b/\d ASCII = JS parity; label patterns keep
# Unicode \s. No streaming/chunk path needed (mmrag has no holdback infra).
# ---------------------------------------------------------------------------
EIN_PLACEHOLDER = "[REDACTED-EIN]"
ROUTING_PLACEHOLDER = "[REDACTED-ROUTING]"
BANK_ACCT_PLACEHOLDER = "[REDACTED-BANK-ACCT]"

# Formatted EIN \d{2}<sep>\d{7} — 2-7 shape, unambiguous vs SSN 3-2-4.
_EIN_FORMATTED = _re.compile(
    _SSN_LEAD + _ssn_digits(2) + _INVIS + _SSN_SEP + _INVIS + _ssn_digits(7) + _SSN_TRAIL,
    _re.ASCII,
)
# Bank-account candidate: 4-17 digit run (3-16 repeats of the trailing digit).
_BANK_RANGE = _re.compile(_SSN_LEAD + r"[0-9](?:" + _INVIS + r"[0-9]){3,16}" + _SSN_TRAIL, _re.ASCII)

# EIN label set: ein, fein, employer identification, employer id, federal tax id
# (tax id stays SSN-only). Routing: routing, aba (catch the multi-word forms as
# substrings). Bank: bank account, account number, bank acct. Same _LABEL_SEP +
# IGNORECASE|ASCII discipline as the SSN labels (Unicode \s NOT used — _LABEL_SEP
# is the explicit JS∪python union).
# SNAKE_CASE / JSON keys (F5 audit, structural fix): \b treats `_` AND digits as
# word chars, so bare \bein\b/\bfein\b MISSED `ein_number`/`ein_value` snake_case
# keys (would leak the EIN raw). Switching the in-text boundary to LETTER-CLASS
# (?<![a-z])…(?![a-z]) treats `_`/digits as boundaries, so the bare ein/fein roots
# now match both `ein number` and `ein_number`/`ein_value` — no explicit
# ein<SEP>+number form needed (redundant once the boundary stopped being \b).
# Mirrors TS EIN_LABEL_ALT exactly.
_EIN_LABEL_ALT = (
    r"(?:fein|ein|employer"
    + _LABEL_SEP + r"+identification|employer" + _LABEL_SEP
    + r"+id|federal" + _LABEL_SEP + r"+tax" + _LABEL_SEP + r"*id)"
)
_EIN_LABEL = _re.compile(_EIN_LABEL_ALT, _re.IGNORECASE | _re.ASCII)
# LETTER-CLASS boundary in-text matchers (?<![a-z])…(?![a-z]), NOT \b: `ein`/
# `fein` are common substrings (protein, vein, caffeine) — a letter on the
# boundary still excludes them, while `_`/digits are boundaries so snake_case
# keys match. ASCII fixed-width lookbehind (re.ASCII) matches the JS `(?<![a-z])`
# (no `u` flag) for parity. The labelHint predicate (_EIN_LABEL) stays unanchored.
_EIN_LABEL_BEFORE = _re.compile(r"(?<![a-z])" + _EIN_LABEL_ALT + r"(?![a-z])[\s\S]{0,16}$", _re.IGNORECASE | _re.ASCII)
_EIN_LABEL_AFTER = _re.compile(r"^[\s\S]{0,16}(?<![a-z])" + _EIN_LABEL_ALT + r"(?![a-z])", _re.IGNORECASE | _re.ASCII)

# ROUTING is ASYMMETRIC (unlike EIN/bank). SNAKE_CASE / JSON keys (F5, structural
# fix): leading (?<![a-z]) (letter-only) admits `{"routing_number`/`aba_routing`;
# trailing (?![a-z0-9_]) (= \b-trailing) so the BARE `routing` root matches
# `routing `/`routing transit`/`routing number` but NOT `routing_table`/
# `routing_protocol` (networking FP guard — `_` is a letter-boundary, so a pure
# (?![a-z]) trailing would false-redact those). The legit `routing_number` LABEL is
# caught by the EXPLICIT routing<SEP>+number / aba<SEP>+routing alternatives (listed
# first), whose trailing boundary sits after `number`/`routing` (space/value). The
# discriminator is the WORD AFTER routing, not the boundary. Mirrors TS exactly.
_ROUTING_LABEL_ALT = (
    r"(?:routing" + _LABEL_SEP + r"+number|aba" + _LABEL_SEP + r"+routing|routing|aba)"
)
_ROUTING_LABEL = _re.compile(_ROUTING_LABEL_ALT, _re.IGNORECASE | _re.ASCII)
# Asymmetric boundary (?<![a-z])…(?![a-z0-9_]): leading letter-only, trailing
# word-char-excluding (see ALT comment). labelHint predicate stays unanchored.
_ROUTING_LABEL_BEFORE = _re.compile(r"(?<![a-z])" + _ROUTING_LABEL_ALT + r"(?![a-z0-9_])[\s\S]{0,16}$", _re.IGNORECASE | _re.ASCII)
_ROUTING_LABEL_AFTER = _re.compile(r"^[\s\S]{0,16}(?<![a-z])" + _ROUTING_LABEL_ALT + r"(?![a-z0-9_])", _re.IGNORECASE | _re.ASCII)

_BANK_LABEL_ALT = (
    r"(?:bank" + _LABEL_SEP + r"+account|account" + _LABEL_SEP + r"+number|bank" + _LABEL_SEP + r"+acct)"
)
_BANK_LABEL = _re.compile(_BANK_LABEL_ALT, _re.IGNORECASE | _re.ASCII)
# LETTER-CLASS boundary (?<![a-z])…(?![a-z]), NOT \b: treats `_`/digits as
# boundaries so the snake_case key `bank_account_number` matches (the
# `account_number` form fires across the `_`) while `embankment` (letter-glued)
# stays excluded. Mirrors TS BANK_LABEL_BEFORE/AFTER.
_BANK_LABEL_BEFORE = _re.compile(r"(?<![a-z])" + _BANK_LABEL_ALT + r"(?![a-z])[\s\S]{0,16}$", _re.IGNORECASE | _re.ASCII)
_BANK_LABEL_AFTER = _re.compile(r"^[\s\S]{0,16}(?<![a-z])" + _BANK_LABEL_ALT + r"(?![a-z])", _re.IGNORECASE | _re.ASCII)


def scrub_ssn(text, aggressive=None):
    """Replace every SSN in ``text`` with ``[REDACTED-SSN]``.

    PII v2 milestone-1: the CANONICAL live PII-pattern registry lives in
    ``src/utils/ssn-redaction.ts`` (``redactSSN`` iterates ``PII_REGISTRY``).
    This python ``scrub_ssn`` is a deliberately LIGHTER behavior-parity MIRROR
    (no registry class in m1); its observable behavior must stay byte-identical
    to the canonical SSN entry so the differential parity fuzz stays 0-divergence.


    Conservative by default: formatted ``\\d{3}[-.\\t ]\\d{2}[-.\\t ]\\d{4}``
    (dash/dot/tab/space, HORIZONTAL only — no newline; \\b boundaries keep a
    10-digit phone from matching) plus a context-keyed bare-9 run (within ~20
    chars of an ``ssn`` / ``social security`` / ``tax id`` label, either
    direction). Aggressive mode (any bare 9-digit run) is opt-in via
    ``SSN_REDACT_AGGRESSIVE=1``. Mirrors ``redactSSN`` in
    src/utils/ssn-redaction.ts.
    """
    if not text:
        return text
    if aggressive is None:
        aggressive = os.environ.get("SSN_REDACT_AGGRESSIVE") == "1"

    def _make_repl(placeholder, label_before, label_after, short_circuit_aggressive):
        """Build a Pass-1 conservative callback for one registry entry. Mirrors
        makeLabelKeyedConservativeMatcher / makeSsnConservativeMatcher in the TS.
        short_circuit_aggressive: SSN/EIN/routing redact unconditionally in
        aggressive mode; bank-acct does NOT (label-required in all modes)."""
        def _repl(m):
            if short_circuit_aggressive and aggressive:
                return placeholder
            s = m.string
            # Neutralize THIS entry's placeholder to a SAME-LENGTH run so its
            # literal text never promotes a nearby number (idempotency under
            # double-scrub) AND offsets are preserved. Mirrors ssn-redaction.ts.
            neutral = " " * len(placeholder)
            before = s[max(0, m.start() - _SSN_LOOKBACK):m.start()].replace(placeholder, neutral)
            after = s[m.end():m.end() + _SSN_LOOKBACK].replace(placeholder, neutral)
            if label_before.search(before) or label_after.search(after):
                return placeholder
            return m.group(0)
        return _repl

    # Registry order is LOAD-BEARING and mirrors PII_REGISTRY exactly:
    # SSN > EIN > ROUTING > BANK_ACCT. Each entry runs Pass-1 (bare-run/candidate
    # + conservative callback) then Pass-2 (formatted), in sequence over the
    # accumulated string — so first-match-wins: a span an earlier entry redacted
    # is placeholder text a later entry's digit regex can't re-match. SSN's Pass-1
    # MUST precede SSN's Pass-2 (the placeholder's "SSN" would else promote a
    # nearby unrelated bare-9). EIN's Pass-1 (bare-9) is a no-op vs SSN's already-
    # consumed runs in aggressive mode; in conservative it claims EIN-labeled
    # bare-9 SSN didn't. Bank-acct's candidate runs last, label-gated in all modes.
    #
    # _registry: (pass1_regex, pass1_callback, pass2_regex_or_None, pass2_placeholder)
    _registry = [
        (_SSN_NINE, _make_repl(SSN_PLACEHOLDER, _SSN_LABEL_BEFORE, _SSN_LABEL_AFTER, True),
         _SSN_FORMATTED, SSN_PLACEHOLDER),
        (_SSN_NINE, _make_repl(EIN_PLACEHOLDER, _EIN_LABEL_BEFORE, _EIN_LABEL_AFTER, True),
         _EIN_FORMATTED, EIN_PLACEHOLDER),
        (_SSN_NINE, _make_repl(ROUTING_PLACEHOLDER, _ROUTING_LABEL_BEFORE, _ROUTING_LABEL_AFTER, True),
         None, None),
        (_BANK_RANGE, _make_repl(BANK_ACCT_PLACEHOLDER, _BANK_LABEL_BEFORE, _BANK_LABEL_AFTER, False),
         None, None),
    ]

    out = text
    for pass1_re, pass1_cb, pass2_re, pass2_ph in _registry:
        out = pass1_re.sub(pass1_cb, out)
        if pass2_re is not None:
            out = pass2_re.sub(pass2_ph, out)
    return out


# ---------------------------------------------------------------------------
# Text chunking
# ---------------------------------------------------------------------------
def chunk_text(text, chunk_size=DEFAULT_TEXT_CHUNK_SIZE, overlap=DEFAULT_TEXT_CHUNK_OVERLAP):
    """Split text into overlapping chunks, preferring paragraph/section boundaries."""
    # Scrub SSNs on the FULL text before chunking, so an SSN can never be split
    # across two chunks in a way that escapes redaction (covers text/PDF/office).
    text = scrub_ssn(text)
    if len(text) <= chunk_size:
        return [text] if text.strip() else []

    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size

        # Try to break at a paragraph boundary (double newline)
        if end < len(text):
            # Look backwards from end for a good break point
            search_zone = text[max(start + chunk_size // 2, start):end]
            # Prefer double newline (paragraph break)
            para_break = search_zone.rfind("\n\n")
            if para_break != -1:
                end = max(start + chunk_size // 2, start) + para_break + 2
            else:
                # Fall back to single newline
                line_break = search_zone.rfind("\n")
                if line_break != -1:
                    end = max(start + chunk_size // 2, start) + line_break + 1

        chunk = text[start:end]
        if chunk.strip():
            chunks.append(chunk.strip())
        start = end - overlap
        if start >= len(text):
            break

    return chunks

# ---------------------------------------------------------------------------
# Video chunking with FFmpeg
# ---------------------------------------------------------------------------
def get_media_duration(file_path):
    """Get duration of a media file in seconds. Returns 0 if unreadable."""
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(file_path)],
            capture_output=True, text=True,
        )
        val = result.stdout.strip()
        return float(val) if val else 0.0
    except (ValueError, subprocess.SubprocessError):
        return 0.0


def chunk_video(video_path, chunk_seconds=DEFAULT_VIDEO_CHUNK_SECONDS,
                overlap_seconds=DEFAULT_VIDEO_OVERLAP_SECONDS):
    """Split video into overlapping chunks using FFmpeg."""
    video_path = Path(video_path)
    output_dir = MEDIA_DIR / video_path.stem
    output_dir.mkdir(parents=True, exist_ok=True)

    duration = get_media_duration(video_path)

    chunks = []
    start = 0
    idx = 0
    step = chunk_seconds - overlap_seconds

    while start < duration:
        end = min(start + chunk_seconds, duration)
        # Skip tiny trailing chunks (< 5 seconds)
        if end - start < 5 and idx > 0:
            break

        output_file = output_dir / f"chunk_{idx:04d}.mp4"

        if not output_file.exists():
            subprocess.run(
                ["ffmpeg", "-y", "-i", str(video_path),
                 "-ss", str(start), "-t", str(end - start),
                 "-c", "copy", "-avoid_negative_ts", "1",
                 str(output_file)],
                capture_output=True,
            )

        chunks.append({
            "path": str(output_file),
            "start": start,
            "end": end,
            "index": idx,
        })

        start += step
        idx += 1

    return chunks


def chunk_audio(audio_path, chunk_seconds=DEFAULT_AUDIO_CHUNK_SECONDS,
                overlap_seconds=DEFAULT_AUDIO_OVERLAP_SECONDS):
    """Split audio into overlapping chunks using FFmpeg."""
    audio_path = Path(audio_path)
    output_dir = MEDIA_DIR / audio_path.stem
    output_dir.mkdir(parents=True, exist_ok=True)

    duration = get_media_duration(audio_path)

    ext = audio_path.suffix
    chunks = []
    start = 0
    idx = 0
    step = chunk_seconds - overlap_seconds

    while start < duration:
        end = min(start + chunk_seconds, duration)
        if end - start < 3 and idx > 0:
            break

        output_file = output_dir / f"chunk_{idx:04d}{ext}"

        if not output_file.exists():
            subprocess.run(
                ["ffmpeg", "-y", "-i", str(audio_path),
                 "-ss", str(start), "-t", str(end - start),
                 "-c", "copy", str(output_file)],
                capture_output=True,
            )

        chunks.append({
            "path": str(output_file),
            "start": start,
            "end": end,
            "index": idx,
        })

        start += step
        idx += 1

    return chunks

# ---------------------------------------------------------------------------
# File ID helper
# ---------------------------------------------------------------------------
def file_id(path, chunk_idx=None):
    """Generate a stable ID for a file or chunk."""
    h = hashlib.md5(str(path).encode()).hexdigest()[:12]
    if chunk_idx is not None:
        return f"{h}_chunk{chunk_idx}"
    return h

# ---------------------------------------------------------------------------
# Ingest logic
# ---------------------------------------------------------------------------
def already_exists(collection, doc_id):
    """Check if a document ID already exists in the collection. Respects --force flag."""
    if args_force:
        return False
    existing = collection.get(ids=[doc_id])
    return bool(existing and existing["ids"])


def ingest_text_file(client, config, collection, file_path):
    """Ingest a text-based file."""
    file_path = Path(file_path)
    text = file_path.read_text(errors="replace")
    if not text.strip():
        print(f"  SKIP (empty): {file_path}")
        return 0

    chunks = chunk_text(
        text,
        chunk_size=config.get("text_chunk_size", DEFAULT_TEXT_CHUNK_SIZE),
        overlap=config.get("text_chunk_overlap", DEFAULT_TEXT_CHUNK_OVERLAP),
    )

    count = 0
    for i, chunk in enumerate(chunks):
        doc_id = file_id(file_path, i)
        if already_exists(collection, doc_id):
            continue

        embedding = embed_content(client, config, chunk)
        collection.upsert(
            ids=[doc_id],
            embeddings=[embedding],
            documents=[chunk],
            metadatas=[{
                "source": str(file_path.resolve()),
                "type": "text",
                "chunk_index": i,
                "total_chunks": len(chunks),
                "filename": file_path.name,
                "file_ext": file_path.suffix.lower(),
                "ingested_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            }],
        )
        count += 1

    return count


def ingest_image(client, config, collection, file_path):
    """Ingest an image: Gemini Flash describes it, then embed description + raw image together."""
    file_path = Path(file_path)
    doc_id = file_id(file_path)

    if already_exists(collection, doc_id):
        print(f"  SKIP (exists): {file_path}")
        return 0

    print(f"  Generating description for {file_path.name}...")
    description, media_bytes, mime = describe_media(client, config, file_path, "image")

    # Option B: embed text description + raw image together
    try:
        embedding = embed_multimodal(client, config, description, media_bytes, mime)
    except Exception:
        # Fallback to text-only embedding if multimodal fails (e.g., file too large)
        embedding = embed_content(client, config, description)

    collection.upsert(
        ids=[doc_id],
        embeddings=[embedding],
        documents=[description],
        metadatas=[{
            "source": str(file_path.resolve()),
            "type": "image",
            "filename": file_path.name,
            "file_ext": file_path.suffix.lower(),
            "mime_type": mime,
            "ingested_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }],
    )
    return 1


def extract_audio_from_video(video_path, output_path):
    """Extract audio track from a video file as mp3."""
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(video_path),
         "-vn", "-acodec", "libmp3lame", "-q:a", "4",
         str(output_path)],
        capture_output=True,
    )
    return Path(output_path).exists()


def ingest_video(client, config, collection, file_path):
    """Ingest a video: chunk it, describe each chunk, embed.

    For large videos (chunks > 20MB), falls back to audio-only extraction
    since the video bytes would be too large for the embedding API.
    For small chunks, uses full multimodal embedding (description + video).
    """
    file_path = Path(file_path)
    size_mb = file_path.stat().st_size / (1024 * 1024)
    duration = get_media_duration(file_path)

    if duration <= 0:
        print(f"  SKIP (unreadable/zero duration): {file_path}")
        return 0

    print(f"  Video: {file_path.name} ({size_mb:.0f}MB, {duration:.0f}s)")

    # Chunk the video
    chunk_secs = config.get("video_chunk_seconds", DEFAULT_VIDEO_CHUNK_SECONDS)
    overlap_secs = config.get("video_overlap_seconds", DEFAULT_VIDEO_OVERLAP_SECONDS)

    print(f"  Chunking into {chunk_secs}s segments with {overlap_secs}s overlap...")
    chunks = chunk_video(file_path, chunk_seconds=chunk_secs, overlap_seconds=overlap_secs)
    total_chunks = len(chunks)
    print(f"  Created {total_chunks} chunks")

    count = 0
    for chunk in chunks:
        doc_id = file_id(file_path, chunk["index"])
        if already_exists(collection, doc_id):
            continue

        chunk_path = Path(chunk["path"])
        chunk_size_mb = chunk_path.stat().st_size / (1024 * 1024) if chunk_path.exists() else 0

        print(f"  Chunk {chunk['index'] + 1}/{total_chunks} "
              f"({chunk['start']:.0f}s-{chunk['end']:.0f}s, {chunk_size_mb:.1f}MB)")

        description = None
        media_bytes = None
        mime = None

        # Strategy: try video description first, fall back to audio-only for large chunks
        if chunk_size_mb <= 20:
            # Small enough for full video analysis
            try:
                description, media_bytes, mime = describe_media(client, config, chunk_path, "video")
                print(f"    Described via video")
            except Exception as e:
                print(f"    Video description failed ({e}), trying audio...")

        if description is None:
            # Large chunk or video failed: extract audio and describe that
            audio_path = chunk_path.with_suffix(".mp3")
            if not audio_path.exists():
                print(f"    Extracting audio track...")
                extract_audio_from_video(chunk_path, audio_path)

            if audio_path.exists() and audio_path.stat().st_size > 0:
                try:
                    description, media_bytes, mime = describe_media(client, config, audio_path, "audio")
                    # Prefix so the agent knows this came from a video's audio
                    description = (
                        f"[Audio extracted from video: {file_path.name}, "
                        f"{chunk['start']:.0f}s-{chunk['end']:.0f}s]\n\n{description}"
                    )
                    print(f"    Described via audio extraction")
                except Exception as e:
                    print(f"    Audio description also failed: {e}")

        if description is None:
            description = (
                f"Video chunk from {file_path.name}, "
                f"{chunk['start']:.0f}s to {chunk['end']:.0f}s. "
                f"(Description unavailable - file may be too large or corrupted)"
            )

        # Embed: try multimodal if we have small media bytes, else text-only
        if media_bytes and mime and len(media_bytes) < 20 * 1024 * 1024:
            try:
                embedding = embed_multimodal(client, config, description, media_bytes, mime)
            except Exception:
                embedding = embed_content(client, config, description)
        else:
            embedding = embed_content(client, config, description)

        collection.upsert(
            ids=[doc_id],
            embeddings=[embedding],
            documents=[description],
            metadatas=[{
                "source": str(file_path.resolve()),
                "type": "video_chunk",
                "chunk_index": chunk["index"],
                "total_chunks": total_chunks,
                "chunk_start_seconds": chunk["start"],
                "chunk_end_seconds": chunk["end"],
                "chunk_path": str(chunk_path),
                "filename": file_path.name,
                "file_ext": file_path.suffix.lower(),
                "duration_seconds": duration,
                "ingested_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            }],
        )
        count += 1

    return count


def ingest_audio(client, config, collection, file_path):
    """Ingest audio: chunk if needed, describe, embed description + audio together."""
    file_path = Path(file_path)
    duration = get_media_duration(file_path)
    if duration <= 0:
        print(f"  SKIP (unreadable/zero duration): {file_path}")
        return 0
    max_chunk = config.get("audio_chunk_seconds", DEFAULT_AUDIO_CHUNK_SECONDS)

    if duration <= max_chunk:
        # Short enough to process as one piece
        doc_id = file_id(file_path)
        if already_exists(collection, doc_id):
            print(f"  SKIP (exists): {file_path}")
            return 0

        print(f"  Transcribing {file_path.name}...")
        description, media_bytes, mime = describe_media(client, config, file_path, "audio")

        try:
            embedding = embed_multimodal(client, config, description, media_bytes, mime)
        except Exception:
            embedding = embed_content(client, config, description)

        collection.upsert(
            ids=[doc_id],
            embeddings=[embedding],
            documents=[description],
            metadatas=[{
                "source": str(file_path.resolve()),
                "type": "audio",
                "filename": file_path.name,
                "file_ext": file_path.suffix.lower(),
                "duration_seconds": duration,
                "ingested_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            }],
        )
        return 1
    else:
        # Chunk the audio
        print(f"  Chunking audio: {file_path.name} ({duration:.0f}s)...")
        overlap = config.get("audio_overlap_seconds", DEFAULT_AUDIO_OVERLAP_SECONDS)
        chunks = chunk_audio(file_path, chunk_seconds=max_chunk, overlap_seconds=overlap)
        total_chunks = len(chunks)
        count = 0

        for chunk in chunks:
            doc_id = file_id(file_path, chunk["index"])
            if already_exists(collection, doc_id):
                continue

            print(f"  Transcribing chunk {chunk['index'] + 1}/{total_chunks}...")
            try:
                description, media_bytes, mime = describe_media(client, config, chunk["path"], "audio")
            except Exception as e:
                print(f"  WARNING: Failed to transcribe chunk {chunk['index']}: {e}")
                description = f"Audio chunk from {file_path.name}, {chunk['start']:.0f}s to {chunk['end']:.0f}s"
                media_bytes = None
                mime = None

            if media_bytes and mime:
                try:
                    embedding = embed_multimodal(client, config, description, media_bytes, mime)
                except Exception:
                    embedding = embed_content(client, config, description)
            else:
                embedding = embed_content(client, config, description)

            collection.upsert(
                ids=[doc_id],
                embeddings=[embedding],
                documents=[description],
                metadatas=[{
                    "source": str(file_path.resolve()),
                    "type": "audio_chunk",
                    "chunk_index": chunk["index"],
                    "total_chunks": total_chunks,
                    "chunk_start_seconds": chunk["start"],
                    "chunk_end_seconds": chunk["end"],
                    "chunk_path": chunk["path"],
                    "filename": file_path.name,
                    "file_ext": file_path.suffix.lower(),
                    "ingested_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                }],
            )
            count += 1
        return count


def ingest_pdf(client, config, collection, file_path):
    """Ingest a PDF page-by-page using Gemini to extract content including visual elements."""
    file_path = Path(file_path)
    from google.genai import types

    with open(file_path, "rb") as f:
        data = f.read()

    # Estimate page count (rough: ~3KB per page for typical PDFs, but varies wildly)
    # We'll ask Gemini to process the whole thing and get structured output
    # For PDFs > 6 pages, we chunk by asking for specific page ranges

    print(f"  Analyzing PDF: {file_path.name}...")

    # Gemini Flash returns 503 UNAVAILABLE during high-demand windows. Without
    # retries, a single 503 kills the ingest. _retry_generate_content wraps the
    # call with bounded retries on transient SDK conditions (HTTP 429/500/503,
    # status UNAVAILABLE/RESOURCE_EXHAUSTED) and fails fast on everything else.
    extraction_prompt = (
        "Extract ALL content from this PDF. For each page, include:\n"
        "1. Page number\n"
        "2. All text content (headings, body, lists, footnotes)\n"
        "3. Description of any images, charts, diagrams, or tables\n"
        "4. Key concepts and topics on that page\n"
        "Separate each page's content with '=== PAGE N ===' markers.\n"
        "Be thorough - this will be used for search and retrieval."
    )
    response = _retry_generate_content(
        client,
        model=config.get("gemini_model", "gemini-2.5-flash"),
        contents=[
            types.Part.from_bytes(data=data, mime_type="application/pdf"),
            extraction_prompt,
        ],
    )
    if _tracker:
        _tracker.track_generation(response)
    # Scrub at extraction, BEFORE the page-marker split branch below — that
    # branch does not call chunk_text(), so without scrubbing here an SSN in a
    # PDF page would be embedded raw.
    text = scrub_ssn(response.text)

    # Split by page markers if present, otherwise chunk normally
    pages = []
    if "=== PAGE" in text:
        import re
        page_splits = re.split(r'===\s*PAGE\s*\d+\s*===', text)
        pages = [p.strip() for p in page_splits if p.strip()]
    else:
        # No page markers - chunk as text
        pages = chunk_text(
            text,
            chunk_size=config.get("text_chunk_size", DEFAULT_TEXT_CHUNK_SIZE),
            overlap=config.get("text_chunk_overlap", DEFAULT_TEXT_CHUNK_OVERLAP),
        )

    count = 0
    for i, page_content in enumerate(pages):
        if not page_content.strip():
            continue
        doc_id = file_id(file_path, i)
        if already_exists(collection, doc_id):
            continue

        embedding = embed_content(client, config, page_content)
        collection.upsert(
            ids=[doc_id],
            embeddings=[embedding],
            documents=[page_content],
            metadatas=[{
                "source": str(file_path.resolve()),
                "type": "pdf_page",
                "chunk_index": i,
                "total_chunks": len(pages),
                "page_number": i + 1,
                "filename": file_path.name,
                "file_ext": ".pdf",
                "ingested_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            }],
        )
        count += 1
    return count


def extract_docx_text(file_path):
    """Extract text from .docx using python-docx."""
    from docx import Document
    doc = Document(str(file_path))
    parts = []
    for para in doc.paragraphs:
        if para.text.strip():
            style_name = para.style.name if para.style else ""
            if style_name.startswith("Heading"):
                level = style_name.replace("Heading ", "").strip()
                prefix = "#" * (int(level) if level.isdigit() else 1)
                parts.append(f"{prefix} {para.text}")
            else:
                parts.append(para.text)
    # Also extract tables
    for table in doc.tables:
        rows = []
        for row in table.rows:
            cells = [cell.text.strip() for cell in row.cells]
            rows.append(" | ".join(cells))
        if rows:
            parts.append("\n".join(rows))
    return "\n\n".join(parts)


def extract_pptx_text(file_path):
    """Extract text from .pptx using python-pptx."""
    from pptx import Presentation
    prs = Presentation(str(file_path))
    slides = []
    for i, slide in enumerate(prs.slides):
        texts = [f"=== SLIDE {i+1} ==="]
        for shape in slide.shapes:
            if shape.has_text_frame:
                for para in shape.text_frame.paragraphs:
                    if para.text.strip():
                        texts.append(para.text)
            if shape.has_table:
                for row in shape.table.rows:
                    cells = [cell.text.strip() for cell in row.cells]
                    texts.append(" | ".join(cells))
        # Notes
        if slide.has_notes_slide and slide.notes_slide.notes_text_frame:
            notes = slide.notes_slide.notes_text_frame.text.strip()
            if notes:
                texts.append(f"Speaker Notes: {notes}")
        slides.append("\n".join(texts))
    return "\n\n".join(slides)


def extract_xlsx_text(file_path):
    """Extract text from .xlsx using openpyxl."""
    from openpyxl import load_workbook
    wb = load_workbook(str(file_path), data_only=True)
    parts = []
    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        rows = []
        for row in ws.iter_rows(values_only=True):
            cells = [str(c) if c is not None else "" for c in row]
            if any(cells):
                rows.append(" | ".join(cells))
        if rows:
            parts.append(f"=== SHEET: {sheet_name} ===\n" + "\n".join(rows[:200]))  # cap at 200 rows
    return "\n\n".join(parts)


def ingest_office_doc(client, config, collection, file_path):
    """Ingest Office documents (.docx, .pptx, .xlsx) by extracting text locally."""
    file_path = Path(file_path)
    ext = file_path.suffix.lower()

    print(f"  Extracting content from {file_path.name}...")

    try:
        if ext in (".docx", ".doc"):
            text = extract_docx_text(file_path)
            type_name = "docx"
        elif ext in (".pptx", ".ppt"):
            text = extract_pptx_text(file_path)
            type_name = "slides"
        elif ext in (".xlsx", ".xls"):
            text = extract_xlsx_text(file_path)
            type_name = "spreadsheet"
        else:
            print(f"  SKIP (unsupported office format): {file_path}")
            return 0
    except Exception as e:
        print(f"  ERROR extracting {file_path.name}: {e}")
        return 0

    if not text.strip():
        print(f"  SKIP (empty document): {file_path}")
        return 0

    # Scrub at extraction, BEFORE the slide/sheet-marker split branches below —
    # those branches do not call chunk_text(), so without scrubbing here an SSN
    # in a slide or a spreadsheet cell would be embedded raw.
    text = scrub_ssn(text)

    # Split presentations by slide markers, everything else by text chunks
    sections = []
    if type_name == "slides" and "=== SLIDE" in text:
        import re
        slide_splits = re.split(r'===\s*SLIDE\s*\d+\s*===', text)
        sections = [s.strip() for s in slide_splits if s.strip()]
    elif type_name == "spreadsheet" and "=== SHEET" in text:
        import re
        sheet_splits = re.split(r'===\s*SHEET:.*?===', text)
        sections = [s.strip() for s in sheet_splits if s.strip()]
    else:
        sections = chunk_text(
            text,
            chunk_size=config.get("text_chunk_size", DEFAULT_TEXT_CHUNK_SIZE),
            overlap=config.get("text_chunk_overlap", DEFAULT_TEXT_CHUNK_OVERLAP),
        )

    count = 0
    for i, section in enumerate(sections):
        if not section.strip():
            continue
        doc_id = file_id(file_path, i)
        if already_exists(collection, doc_id):
            continue

        embedding = embed_content(client, config, section)
        meta = {
            "source": str(file_path.resolve()),
            "type": type_name,
            "chunk_index": i,
            "total_chunks": len(sections),
            "filename": file_path.name,
            "file_ext": ext,
            "ingested_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        if type_name == "slides":
            meta["slide_number"] = i + 1

        collection.upsert(ids=[doc_id], embeddings=[embedding], documents=[section], metadatas=[meta])
        count += 1
    return count


# Global flag for --force re-ingestion
args_force = False


def ingest_file(client, config, collection, file_path):
    """Route a file to the appropriate ingest handler."""
    file_path = Path(file_path)
    ext = file_path.suffix.lower()

    # Skip common non-content files
    skip_names = {".ds_store", "thumbs.db", ".gitignore", ".gitkeep", "package-lock.json",
                  "yarn.lock", "pnpm-lock.yaml", ".eslintcache",
                  "lockbox-codes.md"}
    if file_path.name.lower() in skip_names:
        return 0

    # Skip junk directories
    skip_dirs = {".git", "node_modules", "__pycache__", ".venv", "venv", ".env",
                 ".next", ".nuxt", "dist", "build", ".cache", ".turbo",
                 "vendor", ".terraform", ".angular", ".svelte-kit", ".output",
                 "coverage", ".nyc_output", ".pytest_cache", ".mypy_cache",
                 ".obsidian", "secure-local"}
    parts = set(file_path.parts)
    if parts & skip_dirs:
        return 0

    # Skip text files > 10MB (likely generated/binary)
    size_mb = file_path.stat().st_size / (1024 * 1024)
    if ext in TEXT_EXTS and size_mb > 10:
        print(f"  SKIP (too large: {size_mb:.0f}MB): {file_path}")
        return 0
    if ext in IMAGE_EXTS and size_mb > 50:
        print(f"  SKIP (too large: {size_mb:.0f}MB): {file_path}")
        return 0
    if ext in DOC_EXTS and size_mb > 100:
        print(f"  SKIP (too large: {size_mb:.0f}MB): {file_path}")
        return 0

    if ext in VIDEO_EXTS:
        return ingest_video(client, config, collection, file_path)
    elif ext in AUDIO_EXTS:
        return ingest_audio(client, config, collection, file_path)
    elif ext in IMAGE_EXTS:
        return ingest_image(client, config, collection, file_path)
    elif ext == ".pdf":
        return ingest_pdf(client, config, collection, file_path)
    elif ext in DOC_EXTS:
        return ingest_office_doc(client, config, collection, file_path)
    elif ext in TEXT_EXTS:
        return ingest_text_file(client, config, collection, file_path)
    else:
        # Try as text for unknown extensions
        try:
            file_path.read_text(errors="strict")[:100]
            return ingest_text_file(client, config, collection, file_path)
        except (UnicodeDecodeError, Exception):
            print(f"  SKIP (binary/unsupported): {file_path}")
            return 0

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
def _shared_allowlist_check(file_path: Path, collection_name: str, config: dict) -> bool:
    """Return True if file is allowed into this collection. Shared collections enforce an allowlist."""
    if not collection_name.startswith("shared"):
        return True  # agent-private collections have no allowlist restriction
    allowlist = config.get("shared_ingest_allowlist")
    if not allowlist:
        return True  # no allowlist configured — open (legacy behaviour)
    resolved = str(file_path.resolve())
    for allowed in allowlist:
        if resolved == allowed or resolved.startswith(allowed.rstrip("/") + "/"):
            return True
    print(f"  BLOCKED (not in shared allowlist): {file_path}")
    return False


def cmd_ingest(args):
    global args_force, _tracker
    args_force = getattr(args, 'force', False)
    _tracker = UsageTracker("ingest")

    config = load_config()
    client = get_genai_client(get_api_key(config))
    collection_name = args.collection or config.get("default_collection", "default")
    collection = get_chroma_collection(collection_name)

    if args_force:
        print(f"Force mode: will re-ingest existing files")

    total = 0
    skipped = 0
    errors = 0

    try:
        for path_str in args.paths:
            p = Path(path_str).resolve()
            if p.is_dir():
                files = sorted(f for f in p.rglob("*") if f.is_file() and not f.name.startswith("."))
                print(f"Ingesting directory: {p} ({len(files)} files)")
                for f in files:
                    if not _shared_allowlist_check(f, collection_name, config):
                        skipped += 1
                        continue
                    print(f"  Processing: {f.relative_to(p)}")
                    try:
                        count = ingest_file(client, config, collection, f)
                        total += count
                        if count > 0:
                            print(f"    Added {count} chunk(s)")
                        elif count == 0:
                            skipped += 1
                    except Exception as e:
                        print(f"    ERROR: {e}")
                        errors += 1
            elif p.is_file():
                if not _shared_allowlist_check(p, collection_name, config):
                    print(f"Blocked: {p.name} not in shared allowlist")
                else:
                    print(f"Ingesting: {p.name}")
                    try:
                        count = ingest_file(client, config, collection, p)
                        total += count
                        if count > 0:
                            print(f"  Added {count} chunk(s)")
                    except Exception as e:
                        print(f"  ERROR: {e}")
                        errors += 1
            else:
                print(f"NOT FOUND: {p}")
    finally:
        _tracker.persist()

    print(f"\nDone! Ingested {total} new chunk(s) into '{collection_name}'")
    if skipped:
        print(f"  Skipped: {skipped} (already existed or empty)")
    if errors:
        print(f"  Errors: {errors}")
    print(_tracker.summary_line())


def deduplicate_results(results, similarity_ratio=0.85):
    """Remove near-duplicate results based on content overlap."""
    if len(results) <= 1:
        return results

    deduped = [results[0]]
    for r in results[1:]:
        is_dup = False
        r_content = r["content"][:500]  # compare first 500 chars
        for existing in deduped:
            e_content = existing["content"][:500]
            # Quick overlap check: count shared words
            r_words = set(r_content.lower().split())
            e_words = set(e_content.lower().split())
            if not r_words or not e_words:
                continue
            overlap = len(r_words & e_words) / max(len(r_words), len(e_words))
            if overlap > similarity_ratio:
                is_dup = True
                break
        if not is_dup:
            deduped.append(r)
    return deduped


def _get_reranker(model_name):
    """Lazy-load the cross-encoder only when reranking is explicitly enabled."""
    global _reranker, _reranker_model_name
    if _reranker is not None and _reranker_model_name == model_name:
        return _reranker, 0.0

    started = time.perf_counter()
    try:
        from sentence_transformers import CrossEncoder
    except ImportError as exc:
        raise RuntimeError(
            "rerank_enabled is true but sentence-transformers is not installed. "
            "Install knowledge-base/scripts/requirements.txt into knowledge-base/venv."
        ) from exc

    try:
        _reranker = CrossEncoder(model_name)
    except Exception as exc:
        raise RuntimeError(
            f"rerank_enabled is true but rerank_model {model_name!r} failed to load: {exc}"
        ) from exc
    _reranker_model_name = model_name
    return _reranker, time.perf_counter() - started


def rerank_results(question, results, model_name):
    """Reorder candidate results with a cross-encoder, preserving vector similarity."""
    if len(results) <= 1:
        return results

    reranker, load_seconds = _get_reranker(model_name)
    pairs = [(question, r.get("content", "")) for r in results]
    inference_started = time.perf_counter()
    try:
        scores = reranker.predict(pairs)
    except Exception as exc:
        raise RuntimeError(f"rerank_enabled is true but rerank inference failed: {exc}") from exc
    inference_seconds = time.perf_counter() - inference_started

    for r, score in zip(results, scores):
        r["rerank_score"] = float(score)

    print(
        f"Rerank timings: model_load={load_seconds:.3f}s inference={inference_seconds:.3f}s "
        f"candidates={len(results)} model={model_name}",
        file=sys.stderr,
    )
    return sorted(results, key=lambda r: r.get("rerank_score", float("-inf")), reverse=True)


def cmd_query(args):
    global _tracker
    _tracker = UsageTracker("query")

    config = load_config()
    client = get_genai_client(get_api_key(config))
    collection_name = args.collection or config.get("default_collection", "default")
    collection = get_chroma_collection(collection_name)

    if collection.count() == 0:
        print("Knowledge base is empty. Ingest some files first.")
        return

    rerank_enabled = bool(config.get("rerank_enabled", DEFAULT_RERANK_ENABLED))
    rerank_model = config.get("rerank_model", DEFAULT_RERANK_MODEL)
    try:
        rerank_overfetch = int(config.get("rerank_overfetch", DEFAULT_RERANK_OVERFETCH))
    except (TypeError, ValueError):
        print("ERROR: rerank_overfetch must be an integer", file=sys.stderr)
        sys.exit(1)
    if rerank_overfetch < 1:
        print("ERROR: rerank_overfetch must be >= 1", file=sys.stderr)
        sys.exit(1)

    # Fetch extra results so we have room after filtering/dedup
    fetch_k = (args.top_k or 5) * (rerank_overfetch if rerank_enabled else 3)
    threshold = args.threshold if args.threshold is not None else config.get("similarity_threshold", DEFAULT_SIMILARITY_THRESHOLD)
    max_tokens = args.max_tokens or config.get("max_tokens", DEFAULT_MAX_TOKENS)
    show_full = args.full
    type_filter = args.type  # e.g., "image", "video", "text", "pdf"

    query_embedding = embed_query(client, config, args.question)

    # Build ChromaDB where filter for type
    where_filter = None
    if type_filter:
        # Map user-friendly names to stored types
        type_map = {
            "image": {"type": "image"},
            "video": {"type": "video_chunk"},
            "text": {"type": "text"},
            "pdf": {"type": "pdf_page"},
            "audio": {"$or": [{"type": "audio"}, {"type": "audio_chunk"}]},
        }
        if type_filter in type_map:
            where_filter = type_map[type_filter]
        else:
            # Direct type match
            where_filter = {"type": type_filter}

    query_kwargs = {
        "query_embeddings": [query_embedding],
        "n_results": min(fetch_k, collection.count()),
        "include": ["documents", "metadatas", "distances"],
    }
    if where_filter:
        query_kwargs["where"] = where_filter

    try:
        results = collection.query(**query_kwargs)
    except Exception as e:
        # where filter might fail if no docs match - fall back to unfiltered
        if where_filter:
            del query_kwargs["where"]
            results = collection.query(**query_kwargs)
        else:
            raise

    # Filter by similarity threshold
    filtered = []
    if results["ids"] and results["ids"][0]:
        for i, doc_id in enumerate(results["ids"][0]):
            distance = results["distances"][0][i] if results["distances"] else 0
            similarity = 1 - distance
            if similarity >= threshold:
                filtered.append({
                    "id": doc_id,
                    "content": results["documents"][0][i] if results["documents"] else "",
                    "similarity": similarity,
                    "metadata": results["metadatas"][0][i] if results["metadatas"] else {},
                })

    # Deduplicate near-identical results (same file in multiple lesson folders)
    filtered = deduplicate_results(filtered)

    if rerank_enabled:
        try:
            filtered = rerank_results(args.question, filtered, rerank_model)
        except RuntimeError as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            sys.exit(1)

    # Trim to requested top_k after dedup
    final_k = args.top_k or 5
    filtered = filtered[:final_k]

    # Apply max_tokens budget
    if max_tokens > 0:
        budgeted = []
        token_count = 0
        for r in filtered:
            chunk_tokens = len(r["content"]) // 4
            if token_count + chunk_tokens > max_tokens:
                remaining = max_tokens - token_count
                if remaining > 50:
                    r["content"] = r["content"][:remaining * 4] + "... [truncated]"
                    budgeted.append(r)
                break
            budgeted.append(r)
            token_count += chunk_tokens
        filtered = budgeted

    # Collect unique source files for the agent
    source_files = list(dict.fromkeys(
        r["metadata"].get("source", "") for r in filtered if r["metadata"].get("source")
    ))

    if args.json:
        output = {
            "query": args.question,
            "collection": collection_name,
            "result_count": len(filtered),
            "source_files": source_files,
            "results": [],
        }
        for r in filtered:
            meta = r["metadata"]
            entry = {
                "content": r["content"] if show_full else r["content"][:DEFAULT_PREVIEW_CHARS],
                "content_full_length": len(r["content"]),
                "similarity": round(r["similarity"], 4),
                "source": meta.get("source", ""),
                "type": meta.get("type", ""),
                "filename": meta.get("filename", ""),
            }
            if r.get("rerank_score") is not None:
                entry["rerank_score"] = round(r["rerank_score"], 4)
            # Add type-specific fields
            if meta.get("chunk_index") is not None:
                entry["chunk_index"] = meta["chunk_index"]
                entry["total_chunks"] = meta.get("total_chunks", 0)
            if meta.get("chunk_start_seconds") is not None:
                entry["time_start"] = meta["chunk_start_seconds"]
                entry["time_end"] = meta.get("chunk_end_seconds", 0)
            if meta.get("chunk_path"):
                entry["chunk_path"] = meta["chunk_path"]
            if meta.get("page_number"):
                entry["page_number"] = meta["page_number"]
            output["results"].append(entry)

        print(json.dumps(output, indent=2))
    else:
        print(f"Query: {args.question}")
        print(f"Collection: {collection_name}")
        print(f"Results: {len(filtered)} (threshold: {threshold})")
        if source_files:
            print(f"Source files ({len(source_files)}):")
            for sf in source_files:
                print(f"  - {sf}")
        print("-" * 60)

        if filtered:
            for i, r in enumerate(filtered):
                meta = r["metadata"]
                print(f"\n[{i+1}] Similarity: {r['similarity']:.3f}")
                print(f"    Source: {meta.get('source', 'unknown')}")
                print(f"    Type: {meta.get('type', 'unknown')}")
                if meta.get("chunk_index") is not None:
                    print(f"    Chunk: {meta['chunk_index'] + 1}/{meta.get('total_chunks', '?')}")
                if meta.get("chunk_start_seconds") is not None:
                    print(f"    Time: {meta['chunk_start_seconds']:.0f}s - {meta.get('chunk_end_seconds', 0):.0f}s")
                if meta.get("chunk_path"):
                    print(f"    Chunk file: {meta['chunk_path']}")
                if meta.get("page_number"):
                    print(f"    Page: {meta['page_number']}")

                content = r["content"]
                if not show_full and len(content) > DEFAULT_PREVIEW_CHARS:
                    content = content[:DEFAULT_PREVIEW_CHARS] + f"... [{len(r['content'])} chars total, use --full to see all]"
                print(f"    Content: {content}")
        else:
            print("No results above similarity threshold.")

    _tracker.persist()


def cmd_usage(args):
    """Show token usage and cost summary."""
    if args.reset:
        if USAGE_FILE.exists():
            USAGE_FILE.unlink()
        print("Usage data reset.")
        return

    if not USAGE_FILE.exists():
        print("No usage data yet. Run an ingest or query first.")
        return

    with open(USAGE_FILE) as f:
        data = json.load(f)

    if args.json:
        print(json.dumps(data, indent=2))
        return

    c = data.get("cumulative", {})
    sessions = data.get("sessions", [])

    emb_cost = (c.get("embedding_tokens", 0) / 1_000_000) * EMBEDDING_PRICE_PER_M
    gen_in_cost = (c.get("generation_input_tokens", 0) / 1_000_000) * FLASH_INPUT_PRICE_PER_M
    gen_out_cost = (c.get("generation_output_tokens", 0) / 1_000_000) * FLASH_OUTPUT_PRICE_PER_M
    total = emb_cost + gen_in_cost + gen_out_cost

    print("mmrag Usage Summary")
    print("=" * 40)
    print(f"Total cost:    ${total:.4f}")
    print(f"Total calls:   {c.get('embedding_calls', 0) + c.get('generation_calls', 0)} "
          f"({c.get('embedding_calls', 0)} embedding, {c.get('generation_calls', 0)} generation)")
    print()
    print("Token breakdown:")
    print(f"  Embedding:         {c.get('embedding_tokens', 0):>10,} tokens (est)  ${emb_cost:.4f}")
    print(f"  Generation input:  {c.get('generation_input_tokens', 0):>10,} tokens        ${gen_in_cost:.4f}")
    print(f"  Generation output: {c.get('generation_output_tokens', 0):>10,} tokens        ${gen_out_cost:.4f}")
    print()
    print(f"Sessions: {len(sessions)}")
    if sessions:
        last = sessions[-1]
        print(f"  Last: {last.get('operation', '?')} @ {last.get('finished_at', '?')} "
              f"(${last.get('cost', {}).get('total', 0):.4f})")

    # Per-day breakdown from sessions
    by_day = {}
    for s in sessions:
        day = s.get("started_at", "")[:10]
        if day:
            by_day.setdefault(day, {"cost": 0, "count": 0})
            by_day[day]["cost"] += s.get("cost", {}).get("total", 0)
            by_day[day]["count"] += 1

    if by_day:
        print()
        print("Daily breakdown:")
        for day in sorted(by_day.keys(), reverse=True)[:7]:
            d = by_day[day]
            print(f"  {day}:  ${d['cost']:.4f} ({d['count']} sessions)")


def cmd_status(args):
    config = load_config()
    collection_name = args.collection or config.get("default_collection", "default")

    try:
        collection = get_chroma_collection(collection_name)
        count = collection.count()
    except Exception:
        count = 0

    print(f"Collection: {collection_name}")
    print(f"Total chunks: {count}")
    print(f"Data dir: {MMRAG_DIR}")
    print(f"ChromaDB: {CHROMADB_DIR}")
    print(f"Config: {CONFIG_FILE}")

    # Show config values
    print(f"\nChunk settings:")
    print(f"  Text: {config.get('text_chunk_size', DEFAULT_TEXT_CHUNK_SIZE)} chars, {config.get('text_chunk_overlap', DEFAULT_TEXT_CHUNK_OVERLAP)} overlap")
    print(f"  Video: {config.get('video_chunk_seconds', DEFAULT_VIDEO_CHUNK_SECONDS)}s, {config.get('video_overlap_seconds', DEFAULT_VIDEO_OVERLAP_SECONDS)}s overlap")
    print(f"  Audio: {config.get('audio_chunk_seconds', DEFAULT_AUDIO_CHUNK_SECONDS)}s, {config.get('audio_overlap_seconds', DEFAULT_AUDIO_OVERLAP_SECONDS)}s overlap")
    print(f"  Embedding dims: {config.get('embedding_dimensions', DEFAULT_EMBEDDING_DIMENSIONS)}")

    if count > 0:
        all_data = collection.get(include=["metadatas"])
        types_map = {}
        sources = set()
        for meta in all_data["metadatas"]:
            t = meta.get("type", "unknown")
            types_map[t] = types_map.get(t, 0) + 1
            sources.add(meta.get("source", "unknown"))

        print(f"\nUnique sources: {len(sources)}")
        print("Type breakdown:")
        for t, c in sorted(types_map.items()):
            print(f"  {t}: {c} chunks")


def cmd_list(args):
    config = load_config()
    collection_name = args.collection or config.get("default_collection", "default")

    try:
        collection = get_chroma_collection(collection_name)
    except Exception:
        print("No data found.")
        return

    all_data = collection.get(include=["metadatas"])
    if not all_data["ids"]:
        print("No documents in collection.")
        return

    # Group by source
    by_source = {}
    for meta in all_data["metadatas"]:
        src = meta.get("source", "unknown")
        if src not in by_source:
            by_source[src] = {"type": meta.get("type", "unknown"), "chunks": 0,
                              "filename": meta.get("filename", "")}
        by_source[src]["chunks"] += 1

    print(f"Collection: {collection_name} ({len(by_source)} files, {len(all_data['ids'])} chunks)")
    print(f"{'Source':<60} {'Type':<15} {'Chunks':<8}")
    print("-" * 85)
    for src, info in sorted(by_source.items()):
        display = src if len(src) <= 58 else "..." + src[-55:]
        print(f"{display:<60} {info['type']:<15} {info['chunks']:<8}")


def cmd_collections(args):
    chroma = get_chroma_client()
    collections = chroma.list_collections()
    if not collections:
        print("No collections found.")
        return
    print(f"{'Collection':<30} {'Documents':<12}")
    print("-" * 44)
    for c in collections:
        col = chroma.get_collection(c.name if hasattr(c, 'name') else c)
        name = c.name if hasattr(c, 'name') else c
        print(f"{name:<30} {col.count():<12}")


def cmd_delete(args):
    config = load_config()
    collection_name = args.collection or config.get("default_collection", "default")
    collection = get_chroma_collection(collection_name)

    source_path = str(Path(args.path).resolve())
    all_data = collection.get(include=["metadatas"])

    ids_to_delete = []
    for i, meta in enumerate(all_data["metadatas"]):
        if meta.get("source") == source_path:
            ids_to_delete.append(all_data["ids"][i])

    if not ids_to_delete:
        print(f"No documents found for: {source_path}")
        return

    collection.delete(ids=ids_to_delete)
    print(f"Deleted {len(ids_to_delete)} chunk(s) from '{collection_name}' for: {source_path}")


def cmd_reset(args):
    if not args.confirm:
        print("ERROR: Pass --confirm to reset the knowledge base.")
        return

    chroma = get_chroma_client()
    collections = chroma.list_collections()
    count = 0
    for c in collections:
        name = c.name if hasattr(c, 'name') else c
        chroma.delete_collection(name)
        count += 1

    import shutil
    if MEDIA_DIR.exists():
        shutil.rmtree(MEDIA_DIR)
        MEDIA_DIR.mkdir(parents=True)

    print(f"Reset complete. Deleted {count} collection(s) and cleared media cache.")

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Multimodal RAG Knowledge Base CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", help="Command to run")

    # ingest
    p_ingest = sub.add_parser("ingest", help="Ingest files into the knowledge base")
    p_ingest.add_argument("paths", nargs="+", help="File or directory paths to ingest")
    p_ingest.add_argument("--collection", "-c", help="Collection name (default: 'default')")
    p_ingest.add_argument("--force", action="store_true", help="Re-ingest files even if already in the KB")

    # query
    p_query = sub.add_parser("query", help="Query the knowledge base")
    p_query.add_argument("question", help="Question to ask")
    p_query.add_argument("--top-k", "-k", type=int, default=5, help="Max number of results (default: 5)")
    p_query.add_argument("--threshold", "-t", type=float, default=None,
                         help="Min similarity threshold 0.0-1.0 (default: 0.0, return all)")
    p_query.add_argument("--max-tokens", "-m", type=int, default=0,
                         help="Max total tokens in results (0=unlimited)")
    p_query.add_argument("--collection", "-c", help="Collection name")
    p_query.add_argument("--type", help="Filter by content type: image, video, text, pdf, audio")
    p_query.add_argument("--json", "-j", action="store_true", help="Output as JSON (for agent consumption)")
    p_query.add_argument("--full", "-f", action="store_true", help="Show full content (not truncated)")

    # status
    p_status = sub.add_parser("status", help="Show knowledge base status")
    p_status.add_argument("--collection", "-c", help="Collection name")

    # list
    p_list = sub.add_parser("list", help="List ingested documents")
    p_list.add_argument("--collection", "-c", help="Collection name")

    # collections
    sub.add_parser("collections", help="List all collections")

    # delete
    p_delete = sub.add_parser("delete", help="Delete a document by source path")
    p_delete.add_argument("path", help="Source file path to delete")
    p_delete.add_argument("--collection", "-c", help="Collection name")

    # reset
    p_reset = sub.add_parser("reset", help="Reset the entire knowledge base")
    p_reset.add_argument("--confirm", action="store_true", help="Confirm reset")

    # usage
    p_usage = sub.add_parser("usage", help="Show token usage and cost summary")
    p_usage.add_argument("--json", "-j", action="store_true", help="Output as JSON")
    p_usage.add_argument("--reset", action="store_true", help="Reset usage data")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    commands = {
        "ingest": cmd_ingest,
        "query": cmd_query,
        "status": cmd_status,
        "list": cmd_list,
        "collections": cmd_collections,
        "delete": cmd_delete,
        "reset": cmd_reset,
        "usage": cmd_usage,
    }

    commands[args.command](args)


if __name__ == "__main__":
    main()
