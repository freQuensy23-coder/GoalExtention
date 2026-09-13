# Follow-up DOM regressions — 2026-09-13

The archive audit and its 27 sanitized views remain documented in `capture-audit.md`.
This follow-up is based on the corrected `a362281` main branch, without replacing
its controller, storage service, fixtures, or CI configuration.

Two additional defects were reproduced in real Chromium before fixing the adapter:

1. `textOf(PRE)` trimmed code, and a later whole-message whitespace replacement
   removed indentation and collapsed blank lines inside that code. Valid and
   invalid Python indentation could therefore produce the same response
   fingerprint. The adapter now preserves the code's complete text, including
   leading/trailing spaces and blank lines. Only outer message framing is trimmed.
2. Image artifacts were deduplicated by their human-readable `alt` text. Distinct
   generated images with the same label became one artifact. Deduplication now
   uses the nearest generated-image container, with a source identity fallback
   for unwrapped images. Repeated glow/display layers remain one image. DOM nodes
   and source URLs are not included in the evaluator payload; metadata still
   carries `verified: false` and does not imply visual inspection.

`tests/browser/test_dom_regressions.py` adds six offline Chromium regression tests:
Python indentation, internal blank lines, a bare PRE with leading/trailing
whitespace, indentation-sensitive fingerprinting, two same-label generated images
with three layers each, and repeated unwrapped layers of the same source.
Five failed against the previous adapter; all six pass after the correction.
Fixtures are fully synthetic, and all network requests are blocked in these tests.
The existing GitHub Actions unittest discovery includes this file automatically.

This is structural/browser-boundary verification, not a live authenticated
ChatGPT or paid evaluator test. The original audit's limitations still apply.
