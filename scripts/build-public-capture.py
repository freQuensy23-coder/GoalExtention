#!/usr/bin/env python3
"""Build the public, value-free network/transport projection from the private capture.

This is allowlist-based. It publishes endpoint templates, JSON field/type shapes, transport
event names/operations, state counters and source hashes; never headers, cookies, query
strings, message text, scalar payload values, raw frame text or signed URLs.
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urlparse

CONVERSATION_ID = re.compile(r"/conversations/[0-9a-f-]{20,}", re.I)
RELEVANT_PREFIXES = (
    "/backend-api/conversation/init",
    "/backend-api/f/conversation",
    "/backend-api/conversations",
    "/backend-api/files",
    "/backend-api/celsius/ws/user",
)

def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def shape(value, depth: int = 0):
    if depth >= 8:
        return "…"
    if isinstance(value, dict):
        return {str(k): shape(v, depth + 1) for k, v in value.items()}
    if isinstance(value, list):
        return [shape(value[0], depth + 1)] if value else []
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    return type(value).__name__

def field_paths(value, prefix=""):
    """Return only structural field paths; never scalar values."""
    out = []
    if isinstance(value, dict):
        if not value and prefix:
            out.append(prefix)
        for key in sorted(value):
            child = f"{prefix}.{key}" if prefix else str(key)
            out.extend(field_paths(value[key], child))
    elif isinstance(value, list):
        child = f"{prefix}[]" if prefix else "[]"
        if value:
            out.extend(field_paths(value[0], child))
        else:
            out.append(child)
    elif prefix:
        out.append(prefix)
    return out

def endpoint_template(url: str) -> tuple[str, str] | None:
    p = urlparse(url)
    if p.hostname != "chatgpt.com":
        return None
    path = p.path
    if not path.startswith(RELEVANT_PREFIXES):
        return None
    path = CONVERSATION_ID.sub("/conversations/<conversation_id>", path)
    path = re.sub(r"/files/file_[0-9a-f]+/simple$", "/files/<file_id>/simple", path, flags=re.I)
    path = re.sub(r"/files/download/file_[0-9a-f]+$", "/files/download/<file_id>", path, flags=re.I)
    return p.hostname, path

def load_body(root: Path, request_id: str):
    path = root / "bodies" / f"{request_id}.json"
    if not path.exists():
        return None
    wrapper = json.loads(path.read_text("utf-8"))
    result = wrapper.get("result") or {}
    if result.get("base64Encoded"):
        return None  # binary/raw content is never projected
    return result.get("body")

def parse_json_body(body: str | None):
    if not body:
        return None
    try:
        return json.loads(body)
    except Exception:
        return None

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

def parse_network(root: Path):
    request_meta = {}
    response_meta = {}
    endpoints = collections.Counter()
    request_shapes = {}
    response_shapes = {}
    network_path = root / "network-events.jsonl"

    with network_path.open("r", encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                record = json.loads(line)
            except Exception:
                continue
            params = record.get("params") or {}
            rid = params.get("requestId")
            if record.get("method") == "Network.requestWillBeSent" and rid:
                req = params.get("request") or {}
                normalized = endpoint_template(req.get("url", ""))
                if normalized:
                    host, path = normalized
                    request_meta[rid] = (req.get("method") or "", host, path, req)
            elif record.get("method") == "Network.responseReceived" and rid:
                response_meta[rid] = params.get("response") or {}

    for rid, (method, host, path, req) in request_meta.items():
        resp = response_meta.get(rid, {})
        key = (method, host, path, int(resp.get("status") or 0), str(resp.get("mimeType") or ""))
        endpoints[key] += 1
        if path == "/backend-api/f/conversation" and method == "POST" and path not in request_shapes:
            parsed = parse_json_body(req.get("postData"))
            if parsed is not None:
                request_shapes["POST /backend-api/f/conversation"] = shape(parsed)
        body = parse_json_body(load_body(root, rid))
        if body is None:
            continue
        family = None
        if path == "/backend-api/conversation/init": family = "POST /backend-api/conversation/init"
        elif path == "/backend-api/f/conversation/prepare": family = "POST /backend-api/f/conversation/prepare"
        elif path == "/backend-api/conversations/<conversation_id>": family = "GET /backend-api/conversations/<conversation_id>"
        elif path == "/backend-api/files": family = "POST /backend-api/files"
        elif path == "/backend-api/files/<file_id>/simple": family = "GET /backend-api/files/<file_id>/simple"
        elif path == "/backend-api/files/download/<file_id>": family = "GET /backend-api/files/download/<file_id>"
        if family and family not in response_shapes:
            response_shapes[family] = shape(body)

    endpoint_rows = [
        {"method": m, "host": h, "path": p, "status": s, "mime_type": mt or None, "observed": n}
        for (m, h, p, s, mt), n in sorted(endpoints.items())
    ]
    return endpoint_rows, request_shapes, response_shapes

def parse_streams(root: Path):
    event_counts = collections.Counter()
    type_counts = collections.Counter()
    operation_counts = collections.Counter()
    upload_event_counts = collections.Counter()
    representative_paths = {}
    handoff_shape = None
    delta_paths = {}

    for path in sorted((root / "streams").glob("*.sse")):
        current_event = None
        for raw in path.read_text("utf-8", errors="replace").splitlines():
            if raw.startswith("event:"):
                current_event = raw.split(":", 1)[1].strip() or "message"
                continue
            if raw.startswith("data:"):
                event = current_event or "message"
                data = raw.split(":", 1)[1].strip()
                current_event = None
            elif raw.strip() and not raw.startswith(":"):
                event, data = "ndjson", raw.strip()
            else:
                continue
            event_counts[event] += 1
            try:
                obj = json.loads(data)
            except Exception:
                continue
            if not isinstance(obj, dict):
                continue

            msg_type = obj.get("type") if isinstance(obj.get("type"), str) else None
            nested = obj.get("v")
            nested_type = nested.get("type") if isinstance(nested, dict) and isinstance(nested.get("type"), str) else None
            for name in [msg_type, nested_type]:
                if name:
                    type_counts[name] += 1
                    if name in {"input_message", "message_marker", "message_stream_complete", "resume_conversation_token", "stream_handoff"}:
                        representative_paths.setdefault(name, field_paths(obj))
            if msg_type == "stream_handoff" and handoff_shape is None:
                handoff_shape = shape(obj)

            operation = obj.get("o") if isinstance(obj.get("o"), str) else None
            if operation:
                operation_counts[operation] += 1
                delta_paths.setdefault(operation, field_paths(obj))

            if event == "ndjson" and isinstance(obj.get("event"), str):
                upload_event_counts[obj["event"]] += 1

    return {
        "event_counts": dict(sorted(event_counts.items())),
        "message_type_counts": dict(sorted(type_counts.items())),
        "delta_operation_counts": dict(sorted(operation_counts.items())),
        "upload_processing_event_counts": dict(sorted(upload_event_counts.items())),
        "stream_handoff_shape": handoff_shape,
        "representative_field_paths_by_message_type": {k: representative_paths[k] for k in sorted(representative_paths)},
        "representative_field_paths_by_delta_operation": {k: delta_paths[k] for k in sorted(delta_paths)},
    }

def parse_websocket(root: Path):
    method_counts = collections.Counter()
    json_type_counts = collections.Counter()
    update_type_counts = collections.Counter()
    conversation_update_shape = None
    opaque_received = 0
    parsed_received = 0

    with (root / "websocket-and-eventsource.jsonl").open("r", encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                record = json.loads(line)
            except Exception:
                continue
            method = str(record.get("method") or "")
            method_counts[method] += 1
            if method != "Network.webSocketFrameReceived":
                continue
            payload = ((record.get("params") or {}).get("response") or {}).get("payloadData", "")
            try:
                obj = json.loads(payload)
            except Exception:
                opaque_received += 1
                continue
            if not isinstance(obj, dict):
                opaque_received += 1
                continue
            parsed_received += 1
            if isinstance(obj.get("type"), str):
                json_type_counts[obj["type"]] += 1
            if obj.get("type") == "conversation-update":
                payload_obj = obj.get("payload") or {}
                if isinstance(payload_obj.get("update_type"), str):
                    update_type_counts[payload_obj["update_type"]] += 1
                if conversation_update_shape is None:
                    conversation_update_shape = shape(obj)

    return {
        "cdp_event_counts": dict(sorted(method_counts.items())),
        "received_json_frames": parsed_received,
        "received_opaque_or_non_object_frames": opaque_received,
        "json_type_counts": dict(sorted(json_type_counts.items())),
        "conversation_update_type_counts": dict(sorted(update_type_counts.items())),
        "conversation_update_shape": conversation_update_shape,
    }

def state_metadata(root: Path, manifest_by_path: dict[str, dict]):
    catalog = json.loads((root / "catalog.json").read_text("utf-8"))
    result = []
    for index, row in enumerate(catalog, 1):
        if index == 1:
            source = "01-chat.html"
        elif index == 2:
            source = "02-work.html"
        else:
            source = f"{row['path']}/dom.html"
        source_meta = manifest_by_path[source]
        result.append({
            "index": index,
            "name": row["name"],
            "source": source,
            "source_sha256": source_meta["sha256"],
            "counts": row.get("counts") or {},
        })
    return result

def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", "utf-8")

def write_json_gz(path: Path, value):
    import gzip
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    path.write_bytes(gzip.compress(payload, compresslevel=9, mtime=0))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("capture_root", type=Path)
    parser.add_argument("output_root", type=Path)
    args = parser.parse_args()
    root = args.capture_root.resolve()
    out = args.output_root.resolve()
    out.mkdir(parents=True, exist_ok=True)

    manifest_by_path = verify_private_manifest(root)
    endpoint_rows, request_shapes, response_shapes = parse_network(root)
    write_json(out / "endpoints.json", endpoint_rows)
    write_json(out / "http-shapes.json", {"request_shapes": request_shapes, "response_shapes": response_shapes})
    write_json(out / "stream-semantics.json", parse_streams(root))
    write_json(out / "websocket-semantics.json", parse_websocket(root))
    write_json_gz(out / "states.json.gz", state_metadata(root, manifest_by_path))

    named_sources = [
        "MANIFEST.json", "catalog.json", "network-events.jsonl",
        "websocket-and-eventsource.jsonl", "api-requests-responses.jsonl", "traffic.har",
    ]
    sources = [
        {"kind": "named-source", "name": name, "sha256": manifest_by_path[name]["sha256"], "bytes": manifest_by_path[name]["bytes"]}
        for name in named_sources if name in manifest_by_path
    ]
    for index, stream in enumerate(sorted((root / "streams").glob("*.sse")), 1):
        name = str(stream.relative_to(root))
        row = manifest_by_path[name]
        sources.append({"kind": "stream", "index": index, "sha256": row["sha256"], "bytes": row["bytes"]})
    write_json(out / "provenance.json", {
        "private_archive_members": len(manifest_by_path) + 1,
        "manifest_listed_members": len(manifest_by_path),
        "manifest_sha256": sha256(root / "MANIFEST.json"),
        "sources": sources,
        "projection_policy": "allowlist-structure-only-v1",
    })

    generated_names = [
        "endpoints.json", "http-shapes.json", "provenance.json",
        "states.json.gz", "stream-semantics.json", "websocket-semantics.json",
    ]
    generated = []
    for name in generated_names:
        path = out / name
        generated.append({"path": name, "bytes": path.stat().st_size, "sha256": sha256(path)})
    write_json(out / "manifest.json", generated)
    print(f"Wrote {len(generated)} public network projection files to {out}")


if __name__ == "__main__":
    main()
