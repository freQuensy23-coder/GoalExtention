#!/usr/bin/env python3
"""Fail closed if a public capture fixture looks like it contains private capture data."""
from __future__ import annotations

import gzip
import html
import json
import math
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOM = ROOT / "tests" / "fixtures" / "capture-dom.json.gz"
NETWORK = ROOT / "tests" / "fixtures" / "capture-network"
DOC = ROOT / "docs" / "public-capture"

PATTERNS = {
    "uuid": re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I),
    "raw file id": re.compile(r"\bfile_[0-9a-f]{12,}\b", re.I),
    "jwt": re.compile(r"\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]{10,})?\b"),
    "email": re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I),
    "authorization header": re.compile(r"(?i)\bauthorization\s*[:=]"),
    "bearer credential": re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{10,}"),
    "cookie header": re.compile(r"(?i)\b(?:set-cookie|cookie)\s*[:=]"),
    "session cookie": re.compile(r"(?i)(?:session-token|__Secure-[A-Za-z0-9_-]*session|oai-did)"),
    "signed URL query": re.compile(r"(?i)(?:[?&](?:sig|se|sp|sv|skt|ske|skoid|sktid|token|access_token)=)"),
    "conversation URL": re.compile(r"(?i)https?://(?:chatgpt\.com|chat\.openai\.com)/c/"),
    "private content host": re.compile(r"(?i)https?://[^\s\"']*oaiusercontent\.com"),
    "IPv4 address": re.compile(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])"),
}

ALLOWED_LONG = re.compile(r"^[0-9a-f]{64}$", re.I)


class _TextCollector(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
    def handle_data(self, data):
        if data.strip():
            self.parts.append(html.unescape(data).strip())

DOM_TEXT = re.compile(r"^(?:USER_MESSAGE_\d+|ASSISTANT_MESSAGE_\d+|TEXT|CELL|MATH|Copy response|demo-file\.[A-Za-z0-9]+|Remove|Stop|Send|Menu|Dialog|DIALOG_EDITOR|[X\s]+)$")


def entropy(value: str) -> float:
    if not value:
        return 0.0
    counts = {ch: value.count(ch) for ch in set(value)}
    return -sum((n / len(value)) * math.log2(n / len(value)) for n in counts.values())


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for k, v in value.items():
            yield str(k)
            yield from strings(v)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)


def check_text(label: str, text: str, *, entropy_check: bool = False):
    errors = []
    for name, pattern in PATTERNS.items():
        if pattern.search(text):
            errors.append(f"{label}: matched {name}")
    if entropy_check:
        for token in re.findall(r"[A-Za-z0-9_./+=-]{48,}", text):
            if ALLOWED_LONG.fullmatch(token):
                continue
            if token.startswith(("tests/fixtures/", "states/", "network-events", "api-requests", "websocket-and-eventsource")):
                continue
            if entropy(token) >= 4.4:
                errors.append(f"{label}: suspicious high-entropy token ({len(token)} chars)")
                break
    return errors


def main() -> int:
    errors = []
    if not DOM.is_file():
        errors.append("missing tests/fixtures/capture-dom.json.gz")
    else:
        try:
            fixtures = json.loads(gzip.decompress(DOM.read_bytes()))
        except Exception as exc:
            errors.append(f"DOM fixture is unreadable: {exc}")
            fixtures = []
        if len(fixtures) != 27:
            errors.append(f"DOM fixture must contain 27 states, found {len(fixtures)}")
        for i, fixture in enumerate(fixtures, 1):
            html = str(fixture.get("html", ""))
            errors += check_text(f"DOM state {i}", html, entropy_check=True)
            for forbidden in ("<script", "<iframe", " src=", " href=", "onclick=", "onload=", "https://", "http://"):
                if forbidden.lower() in html.lower():
                    errors.append(f"DOM state {i}: forbidden executable/network marker {forbidden!r}")
            collector = _TextCollector(); collector.feed(html)
            for part in collector.parts:
                if not DOM_TEXT.fullmatch(part):
                    errors.append(f"DOM state {i}: non-synthetic text escaped the allowlist")
                    break
            source_hash = str(fixture.get("source_sha256", ""))
            if not re.fullmatch(r"[0-9a-f]{64}", source_hash, re.I):
                errors.append(f"DOM state {i}: invalid source_sha256")

    if not NETWORK.is_dir():
        errors.append("missing tests/fixtures/capture-network")
    else:
        for path in sorted([*NETWORK.glob("*.json"), *NETWORK.glob("*.json.gz")]):
            try:
                raw = gzip.decompress(path.read_bytes()).decode("utf-8") if path.suffix == ".gz" else path.read_text("utf-8")
                value = json.loads(raw)
            except Exception as exc:
                errors.append(f"{path.relative_to(ROOT)} unreadable: {exc}")
                continue
            for text in strings(value):
                errors += check_text(str(path.relative_to(ROOT)), text, entropy_check=True)

    if DOC.is_dir():
        for path in sorted(DOC.rglob("*")):
            if path.is_file():
                errors += check_text(str(path.relative_to(ROOT)), path.read_text("utf-8", errors="replace"))

    # The public network projection is structural. Full URLs and scalar credential values should never be needed.
    endpoints = NETWORK / "endpoints.json"
    if endpoints.is_file():
        for row in json.loads(endpoints.read_text("utf-8")):
            if row.get("host") != "chatgpt.com" or not str(row.get("path", "")).startswith("/backend-api/"):
                errors.append("endpoints.json contains a non-normalized endpoint")
            if "?" in str(row.get("path", "")):
                errors.append("endpoints.json contains a query string")

    if errors:
        print("Public capture privacy audit FAILED:", file=sys.stderr)
        for error in sorted(set(errors)):
            print(f"- {error}", file=sys.stderr)
        return 1
    print("Public capture privacy audit passed: no credential/PII/network-bearing DOM patterns found.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
