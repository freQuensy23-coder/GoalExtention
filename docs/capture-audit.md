# Capture audit — 2026-09-13

## Scope and provenance

The private ZIP contains 3,438 members. All 3,437 files listed in its manifest passed size and SHA-256 verification; the extra member is the manifest itself. Analysis covered the complete inventory, 27 DOM/state views and their screenshots/MHTML, 25 DOMSnapshot records, capture helper scripts, both saved conversations, downloaded demonstration artifacts, nine stream files, 3,230 response-body wrappers, 3,250 HAR entries, 661 summarized request records, 16,302 network events and 542 WebSocket/EventSource records. Static resource bodies were inventoried and parsed as capture resources, not adopted as extension code.

The archive is private evidence, not a distributable test fixture. In particular, it contains account credentials, signed file URLs and notifications concerning other conversations. None are committed. `tests/fixtures/capture-dom.json.gz` holds one minimized structural projection per view, with pseudonymous IDs, replacement text/image labels and allowlisted semantic attributes. Scripts, CSS assets, network URLs, sidebar/history content and handlers were removed. Only necessary hidden/semantic classes remain. Each projection records its source member path and original SHA-256. These fixtures test structure/behavior, not pixel-perfect rendering or React/ProseMirror internals.

DOM, screenshot and network files were sampled at different instants. A filename saying “complete” or “generating” is not evidence of completion. The network gap during the second image generation must not be filled with invented events.

## Confirmed defects in 0.1 and corrections

| Evidence | Old behavior | Correction / regression coverage |
| --- | --- | --- |
| 03 and 06: incomplete rendered reply, no Stop button, no final turn toolbar | A 1.6 s DOM pause could trigger judging prematurely | Require the latest assistant turn's `copy-turn-action-button`, no Stop, and a stable relevant signature |
| Actual turns are `section[data-testid="conversation-turn-N"][data-turn]` | Collected only author-role nodes | Collect complete turns with numeric turn identity; never select an older assistant after a new user turn |
| 10, 11, 14, 27: generated image turns can lack author-role nodes | Image result disappears from transcript / previous answer reused | Keep image-only turns and metadata; request human visual review rather than judging alt text as pixels |
| Unified composer is contenteditable `.ProseMirror`; hidden textarea also exists | `textContent` replacement bypasses editor state, broad textarea fallback is unsafe | Scope to unified composer, issue editing transactions, wait for enabled Send and actual echoed user turn |
| 12, 13, 20: duplicate `#prompt-textarea` in editor/viewer dialogs; dialog lacks `aria-modal` | Global selectors could target another editor | Exclude dialog composers, block visible dialogs even without aria-modal; test Canvas and image viewer |
| User attachment file tiles precede the actual prompt | `/goal` was not matched after a filename prefix | Read the user prompt bubble separately and keep file tiles as metadata |
| Work file downloads are often buttons, not sandbox anchors | File artifacts were omitted | Collect file-button metadata without claiming byte verification or following signed URLs |
| Virtualized conversation slices omit previous turns | Sent whatever DOM happened to contain, including pre-goal history | Preserve observed goal-scoped history, detect gaps/branch changes/over-budget context and stop for review |
| Whole-map local state and long asynchronous evaluation | Concurrent tabs overwrite state; stale judge resurrects paused goal | Per-tab session keys, short locks, request lease/revision checks and two-phase send acknowledgement |
| Evaluator requests accepted loosely parsed text / coercible verdicts | Malformed, refused or truncated output might be treated as a verdict | Strict JSON Schema, explicit types, confidence/review gate, terminal response checks, timeout and no automatic error retry |

The original `src/background`, `src/content`, `src/options` layout was not inherently invalid: the manifest referenced existing files. The defect was missing browser-boundary verification and mixing loop/state responsibilities. Entry points are now thin; the controller and state service are testable separately and together.

## Network findings and implementation decision

ChatGPT web UI and the public evaluator API are separate protocols. The capture submits conversation work to `/backend-api/f/conversation`; saved conversation reads use `/backend-api/conversations/<id>` and return a `messages` list with message author/content/status/end_turn, `current_node` and pagination metadata. They are not public Responses API objects and are not assumed to contain a `mapping` tree.

Captured SSE uses `delta_encoding` version v1, full message records, append/patch operations and inherited patch path/operation fields. A closed stream or `[DONE]` is insufficient: Work streams hand off using `stream_handoff` with SSE-resume/WebSocket subscription options. Later WebSocket frames carry updates and conversation-turn completion. An image request also involves intermediate tool messages and asynchronous completion. Some WebSocket traffic belongs to other chats and cannot be associated by timing alone.

Upload uses creation, a signed blob PUT and upload-processing streams; those processing streams are NDJSON even when saved with `.sse` filenames. File downloads use an interpreter-download endpoint and signed content URLs. These are not generic `/v1/files` or `/v1/responses` requests.

**Decision:** retain DOM-only operation; do not introduce private-API replay or cookie/token extraction. The recorded transport semantics explain why `[DONE]`, network silence or the disappearance of Stop are not sufficient standalone completion signals. The extension's only direct network call is to the configured public evaluator API: Responses uses `text.format` with strict JSON Schema, Chat Completions uses `response_format.json_schema`. Unsupported `temperature: 0` was removed. Completed/refused/truncated output is checked before validating the verdict.

Public references checked for the external boundaries: [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [Chrome storage API](https://developer.chrome.com/docs/extensions/reference/api/storage), [Playwright Chrome extensions](https://playwright.dev/python/docs/chrome-extensions).

## All capture states

| States | Observed meaning / expected behavior |
| --- | --- |
| 01–02 | Empty Chat/Work. No candidate or goal; hidden textarea is not the editor. |
| 03 | Partial DOM after stream closure; wait. |
| 04 | Same answer after reload, formatted text/code/table/math and finalized toolbar. |
| 05 | Unsubmitted image attachments; do not overwrite/send. |
| 06 | Partial image-analysis reply; wait. |
| 07–09 | Final image analysis; 07 menu closed, 08–09 menu open. Open menu blocks sending. |
| 10–11 | First generated image already present, despite 10's filename. Metadata only, needs review. Menu retained in 10 is closed. |
| 12–13 | Image viewer/markup, duplicate composer IDs in a dialog; no automated send. |
| 14 | Restored conversation, incomplete virtualized sequence; no invented missing history. |
| 15 | Loading screen, not two finished images; no composer/turn candidate. |
| 16 | Empty Work. |
| 17–18 | Work in progress, Stop visible and no final toolbar; wait. |
| 19 | Raw TXT opened on an external content host, not Canvas; unsupported. |
| 20 | Actual Canvas editor/dialog, not the normal composer. |
| 21–22 | Completed Work plus activity/files panels; dialog in 22 blocks sending. |
| 23 | Second Work request in progress; do not evaluate first answer. |
| 24 | Completed second reply, TXT/JSON metadata and formatted JSON. |
| 25–26 | JSON preview preparing/loaded; preview is not new assistant text. |
| 27 | Fully loaded conversation with both generated image turns. |

## Remaining uncertainty

No live authenticated ChatGPT validation or paid evaluator call was performed. The provided snapshots do not prove future selectors, editor implementation compatibility, or semantic correctness of an LLM judge. Recorded terminal controls are treated conservatively, not as a supported public contract. Missing evidence causes waiting/review. The deterministic offline editor models editing events and an echoed user turn; it is deliberately not advertised as a full copy of ChatGPT's editor. Raw pixels/files and external effects remain outside the text evaluator's evidence boundary.

The local managed Chromium did not expose an unpacked extension service worker. Native MV3 worker registration, trusted storage access and the options page are therefore checked separately in CI with full bundled Chromium (`scripts/smoke-extension.py`). This is distinct from the offline DOM/controller replay tests.
