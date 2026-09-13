# Public capture corpus

This repository intentionally does **not** publish the original lecture ZIP. The raw capture contains account/session credentials, cookies, signed URLs, unrelated conversation notifications, sidebar history, personal message text, and large static/browser artifacts.

The public evidence is split into two allowlist-only projections:

- `tests/fixtures/capture-dom.json.gz` — 27 minimized DOM states. It preserves only the structure and semantic attributes needed by the extension. Message text, identifiers, resource URLs, scripts, handlers, sidebar history, and image/file contents are replaced or removed.
- `tests/fixtures/capture-network/` — protocol structure derived from the HTTP/SSE/WebSocket capture. It contains endpoint **templates**, JSON field/type shapes, transport event/operation names, aggregate counts, state metadata, and source hashes. It contains no raw headers, cookies, query strings, scalar payload values, conversation text, signed links, WebSocket payload text, or timestamps.

## Why the raw formats are excluded

`traffic.har`, `network-events.jsonl`, `api-requests-responses.jsonl`, raw `streams/*.sse`, MHTML, screenshots, saved conversations, downloaded artifacts, and response-body dumps are useful private source evidence but are unsafe and unnecessary as public regression fixtures. The public corpus keeps the behaviorally relevant boundaries without retaining account data.

The projection intentionally preserves protocol **field names** such as `conversation_id`, `conduit_token`, `upload_url`, and `download_url`, because those names describe the captured wire shape. Their captured values are never published.

## Reproducibility and privacy gates

`scripts/build-public-capture.py` and `scripts/build-public-dom.py` each verify every private archive member against `MANIFEST.json` before deriving their projection. It is allowlist-based rather than a global regex redactor. `scripts/audit-public-capture.py` is the publication gate: CI fails on credential patterns, signed URLs, raw conversation/file IDs, emails, IP addresses, executable/network-bearing DOM, or suspicious high-entropy strings. Existing browser tests also assert that all 27 DOM projections remain non-executable and identifier-free.

To reproduce both projections from the owner's private extracted archive:

```sh
python -m pip install -r scripts/requirements-capture.txt
python scripts/build-public-capture.py /path/to/private-capture tests/fixtures/capture-network
python scripts/build-public-dom.py /path/to/private-capture tests/fixtures/capture-dom.json.gz
python scripts/audit-public-capture.py
```

`tests/capture-corpus.test.js` checks that the corpus still proves the transport facts the runtime relies on: final DOM controls cannot be inferred from network silence alone, conversation streams can hand off, deltas use multiple operations, WebSocket conversation updates exist, and upload processing has its own event sequence.

## Source binding

`tests/fixtures/capture-network/provenance.json` records SHA-256 hashes of the private source files used for the projection. `tests/fixtures/capture-network/states.json` binds each public DOM case name to the SHA-256 of its original private HTML snapshot. This permits verification against the owner's private archive without publishing it.
