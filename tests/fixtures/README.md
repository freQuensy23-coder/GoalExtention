# Sanitized capture projections

`capture-dom.json.gz` decompresses to a JSON array of 27 objects with `name`, `source`, `source_sha256`, `html`. Source paths and SHA-256 bind each case to the privately supplied lecture ZIP. Only the structural portions used by the extension remain. Message text, image labels and IDs are replaced; scripts, event handlers, sidebar history, credentials, resource URLs and signed links are absent. Semantic attributes and hidden state are preserved.

The fixture builder was run privately against the archive; do not commit the raw archive or regenerate by copying whole HTML. The browser privacy test rejects executable/network content and unredacted UUID identifiers. Expected outcomes are independently enumerated in `tests/browser/test_browser.py` from source inspection, not computed using the adapter under test. Additional synthetic interaction scenarios test behavior that a static snapshot cannot establish.
