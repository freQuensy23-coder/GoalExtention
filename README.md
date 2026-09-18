# ChatgptGoal

Chrome Manifest V3 extension adding a `/goal ...` feedback loop to ChatGPT's rendered conversation. Version 0.2 replaces the original unverified DOM assumptions using an audit of the supplied 2026-09-13 lecture capture. See [the audit and evidence map](docs/capture-audit.md) and the [public sanitized capture corpus](docs/public-capture/README.md).

## Install

Requires Node 22+ and Chrome/Chromium 114+.

```sh
npm ci
npm test
npm run build
```

Load `dist/` through **chrome://extensions**, Developer mode, **Load unpacked**. Open extension settings, select an evaluator endpoint/model supporting strict JSON Schema, and enter your own API key. The default is OpenRouter at `https://openrouter.ai/api/v1/chat/completions` with **GPT-5.6 Luna** (`openai/gpt-5.6-luna`). OpenAI Responses and compatible Chat Completions endpoints remain supported. Existing saved settings are preserved; select the new endpoint/model explicitly when upgrading. Use **Test connection** to check the current fields with a synthetic example and a real API request, then **Save**. The test does not send your conversations or start a goal loop. Custom HTTPS origins require an explicit host-permission grant. API charges are separate from ChatGPT subscription usage.

Send `/goal Finish the requested feature and verify it with tests` in the normal chat composer. The extension arms the goal only after observing that exact submitted user turn. It waits for a finalized **latest** assistant turn and stable content, submits the last N observed conversation messages, including messages before /goal to the evaluator, then inserts and submits a continuation if more work is needed. It counts a continuation only after a new user message confirms submission. The popup shows status, errors, acknowledged sends, Pause, Resume and Clear.

## Controls and limits

A goal belongs to one tab and one `/c/<conversation>` identity. Opening another chat cannot reuse its goal. Normal Chat, Work, image output and embedded file cards have distinct DOM cases. User Stop, manual messages, drafts, pending attachments, dialogs and navigation prevent automated sends. An in-flight API result cannot undo Pause or Clear. Requests time out after 25 seconds; API errors pause rather than retry automatically. The reviewer returns exactly `{"short_explanation":"...","is_goal_done":false}`. `true` finishes; `false` sends a continuation. There is no confidence field, review verdict, or iteration cap. Pause or Clear stops the loop.

Goal/history state uses `chrome.storage.session`: it survives service-worker suspension and page reload in the same browser session, but not browser restart or extension reload/update. Closing the tab removes its state. Unknown send outcomes after reload require manual review rather than automatic resubmission. Old 0.1 goals are not migrated. Resume is for technical/manual pauses; new goals use the two-field verdict.

## What is and is not verified

The reviewer receives the goal plus the last **20 messages by default** (N is configurable from 1–100). It receives image bytes as multimodal image parts and downloadable file bytes as file parts. Attachments are loaded using their rendered download URLs and included as base64, including private same-origin images. A missing/inaccessible download, unsupported attachment, or technical API failure pauses with an error instead of silently substituting a filename. Limits: 4 MB per attachment and 6 MB of encoded attachments per request. Non-downloadable file buttons and media without a supported readable source cannot currently be included. The model must support the supplied image/file types.

The DOM terminal marker is a conservative heuristic validated against the supplied snapshots, not a public ChatGPT contract. Missing markers make the extension wait. The capture does not establish that every future ChatGPT version works. Temporary/no-ID conversations, voice, external file viewers and unknown UI variants are not supported. Close editors/dialogs before allowing automatic continuation. Keep the tab open; background throttling may delay checks.

The extension does **not** replay internal ChatGPT endpoints, extract cookies/tokens, patch fetch/WebSocket, circumvent limits, or bypass refusals/permission requests. Only normal composer interaction is automated. The separate evaluator uses the public API. Review the service's current usage rules before enabling automation.

## Privacy

Your goal, the last N observed messages (including pre-goal context), and their readable images/files are sent to the evaluator endpoint you configure. Do not use it with information that provider should not receive. API settings are stored locally **without encryption**, restricted to trusted extension contexts with `setAccessLevel`; they are never sent to content scripts or injected into the page.

The private lecture capture is not published. The repository contains an allowlist-only public corpus: 27 minimized DOM states plus normalized HTTP/SSE/WebSocket structures. Raw HAR/CDP logs, cookies, tokens, signed links, saved conversations, screenshots, MHTML and personal artifact contents are excluded. CI runs a dedicated privacy audit over every public capture fixture.

## Tests and CI

```sh
python -m pip install -r tests/browser/requirements.txt
python -m playwright install chromium
npm run ci
```

Node tests exercise the state machine, API wire formats, strict verdict validation, budgets, per-tab isolation, races, cancellation, acknowledgement, and the sanitized capture corpus. Playwright runs real Chromium against 27 sanitized capture states and simulated editor/transport boundaries; no live ChatGPT session, paid evaluator or credentials are required. Browser tests also exercise the actual controller, goal service and DOM together. A logical URL is injected in offline tests rather than navigating to ChatGPT.

CI additionally loads the built extension as a real unpacked MV3 extension in full Chromium. One smoke test verifies worker registration/storage/options; a second routes a synthetic page at a logical `chatgpt.com/c/...` URL and runs the native `/goal -> evaluator -> automatic continuation -> complete` loop across the real content-script/service-worker boundary with a deterministic in-worker evaluator. No live ChatGPT or evaluator network request is made.

GitHub Actions installs Chromium, runs syntax/manifest checks, the privacy gate, unit/corpus tests, build, browser regressions, both native MV3 smoke tests, and uploads the installable `dist/` artifact only after all pass. `src/content/dom-adapter.js` handles DOM; `controller.js` owns the loop; `background/goal-service.js` owns state/concurrency; `evaluator.js` owns public API validation; `service-worker.js` and `content-script.js` are thin entry points. Runtime dependencies: none.

GPL-3.0-only; see LICENSE. No warranty.
