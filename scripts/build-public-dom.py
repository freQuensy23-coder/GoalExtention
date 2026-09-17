#!/usr/bin/env python3
"""Build the 27-state structural DOM projection without private text or identifiers."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import html as html_lib
import json
import re
from pathlib import Path

FILE_NAME = re.compile(r"\b([A-Za-z0-9._-]+\.(txt|json|csv|pdf|docx?|xlsx?|pptx?|zip|md|py|js|html))\b", re.I)

def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def verify_private_manifest(root: Path) -> dict[str, dict]:
    manifest = json.loads((root / "MANIFEST.json").read_text("utf-8"))
    if not isinstance(manifest, list):
        raise ValueError("MANIFEST.json must be a list")
    by_path = {}
    for row in manifest:
        path = root / row["path"]
        if not path.is_file():
            raise ValueError(f"missing source file: {row['path']}")
        actual_size = path.stat().st_size
        actual_hash = sha256(path)
        if actual_size != row["bytes"] or actual_hash != row["sha256"]:
            raise ValueError(f"source manifest mismatch: {row['path']}")
        by_path[row["path"]] = row
    return by_path

def build_dom_projection(root: Path, manifest_by_path: dict[str, dict], output: Path):
    try:
        from bs4 import BeautifulSoup
    except ImportError as exc:
        raise RuntimeError("DOM projection requires beautifulsoup4: python -m pip install beautifulsoup4") from exc
    catalog = json.loads((root / "catalog.json").read_text("utf-8"))

    def source_for(index, row):
        if index == 1: return "01-chat.html"
        if index == 2: return "02-work.html"
        return f"{row['path']}/dom.html"

    def extensions(turn):
        found = []
        for el in turn.select("button[aria-label],a[href],button"):
            value = (el.get("aria-label") or "") + " " + el.get_text(" ", strip=True)
            for match in FILE_NAME.finditer(value):
                ext = match.group(2).lower()
                if ext not in found: found.append(ext)
        return found

    def project_turn(src, index):
        role = src.get("data-turn")
        parts = [f'<section data-testid="{src.get("data-testid")}" data-turn="{role}">']
        authors = src.select(f'[data-message-author-role="{role}"]')
        if authors:
            if role == "user":
                parts.append(f'<div data-message-author-role="user" data-message-id="msg-{index}"><div data-testid="collapsible-user-message-content"><div class="whitespace-pre-wrap">USER_MESSAGE_{index}</div></div></div>')
            else:
                parts.append(f'<div data-message-author-role="assistant" data-message-id="msg-{index}">')
                author = authors[0]
                emitted = False
                # Preserve behaviorally relevant rendered structure while replacing every payload token.
                for node in author.find_all(["pre", "table", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6", "li"]):
                    if node.name == "span" and "katex" not in (node.get("class") or []):
                        continue
                    if node.find_parent(["pre", "table"]) and node.name not in {"pre", "table"}:
                        continue
                    if node.name == "pre":
                        code = node.find("code") or node
                        masked = re.sub(r"\S+", "X", code.get_text())
                        parts.append("<pre><code>" + html_lib.escape(masked) + "</code></pre>")
                    elif node.name == "table":
                        parts.append("<table>")
                        for row in node.find_all("tr"):
                            parts.append("<tr>")
                            for cell in row.find_all(["th", "td"], recursive=False):
                                parts.append(f"<{cell.name}>CELL</{cell.name}>")
                            parts.append("</tr>")
                        parts.append("</table>")
                    elif node.name == "span":
                        parts.append('<span class="katex"><annotation>MATH</annotation></span>')
                    else:
                        parts.append(f"<{node.name}>TEXT</{node.name}>")
                    emitted = True
                if not emitted:
                    parts.append(f'<p>ASSISTANT_MESSAGE_{index}</p>')
                parts.append('</div>')
        images = src.select("img[alt]")
        if images:
            if role == "assistant" and not authors:
                # The private capture has multiple display/glow <img> layers inside one
                # generated-image container. Preserve that identity boundary without IDs/src.
                parts.append('<div class="group/imagegen-image">')
                parts.extend(f'<img alt="generated-image-{index}">' for _ in images)
                parts.append('</div>')
            else:
                parts.extend(f'<img alt="input-image-{index}-{i + 1}">' for i, _ in enumerate(images))
        for ext in extensions(src):
            parts.append(f'<button aria-label="Download demo-file.{ext}">demo-file.{ext}</button>')
        if role == "assistant" and src.select_one('button[data-testid="copy-turn-action-button"]'):
            parts.append('<button data-testid="copy-turn-action-button">Copy response</button>')
        parts.append("</section>")
        return "".join(parts)

    rows = []
    for state_index, row in enumerate(catalog, 1):
        source = source_for(state_index, row)
        soup = BeautifulSoup((root / source).read_text("utf-8", errors="replace"), "html.parser")
        html = ['<!doctype html><html><body><main id="main">']
        for turn in soup.select('[data-testid^="conversation-turn-"][data-turn]'):
            match = re.search(r"(\d+)$", turn.get("data-testid") or "")
            if match:
                html.append(project_turn(turn, int(match.group(1))))
        html.append("</main>")

        forms = soup.select('form[data-type="unified-composer"]')
        if forms:
            source_form = forms[0]
            html.append('<form data-type="unified-composer"><textarea name="prompt-textarea" hidden></textarea><div id="prompt-textarea" class="ProseMirror" contenteditable="true"><p><br></p></div>')
            if source_form.select_one('button[data-testid="stop-button"]'):
                html.append('<button data-testid="stop-button" type="button">Stop</button>')
            source_send = source_form.select_one('button[data-testid="send-button"]')
            if source_send:
                disabled = ' disabled' if source_send.has_attr("disabled") or source_send.get("aria-disabled") == "true" else ""
                html.append(f'<button data-testid="send-button" type="submit"{disabled}>Send</button>')
            removals = [el for el in source_form.select('button[aria-label]') if (el.get("aria-label") or "").startswith("Remove file")]
            for number, _ in enumerate(removals, 1):
                html.append(f'<button aria-label="Remove file {number}: demo-attachment-{number}.png">Remove</button>')
            html.append("</form>")

        for menu in soup.select('[role="menu"]'):
            state = menu.get("data-state")
            if state in {"open", "closed"}:
                html.append(f'<div role="menu" data-state="{state}">Menu</div>')
        for dialog in soup.select('[role="dialog"]'):
            html.append('<div role="dialog">Dialog')
            if dialog.select_one('form[data-type="unified-composer"] #prompt-textarea'):
                html.append('<form data-type="unified-composer"><div id="prompt-textarea" class="ProseMirror" contenteditable="true">DIALOG_EDITOR</div></form>')
            html.append('</div>')
        html.append('</body></html>')
        rows.append({
            "name": row["name"], "source": source,
            "source_sha256": manifest_by_path[source]["sha256"], "html": "".join(html),
        })
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(rows, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    output.write_bytes(gzip.compress(payload, compresslevel=9, mtime=0))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("capture_root", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    root = args.capture_root.resolve()
    manifest_by_path = verify_private_manifest(root)
    build_dom_projection(root, manifest_by_path, args.output.resolve())
    print(f"Wrote sanitized 27-state DOM projection to {args.output.resolve()}")


if __name__ == "__main__":
    main()
