# ChatgptGoal

Chrome Manifest V3 extension adding a `/goal ...` feedback loop to ChatGPT's rendered conversation. Version 0.2 replaces the original unverified DOM assumptions using an audit of the supplied 2026-09-13 lecture capture. See [the audit and evidence map](docs/capture-audit.md).

## Install

Requires Node 22+ and Chrome/Chromium 114+.

```sh
npm ci
npm test
npm run build
```

Load `dist/` through **chrome://extensions**, Developer mode, **Load unpacked**. Open extension settings, select an evaluator endpoint/model supporting strict JSON Schema, and enter your own API key. The default is `https://api.openai.com/v1/responses` with `gpt-5-mini`; compatible `/v1/chat/completions` endpoints are also supported. Custom HTTPS origins require an explicit host-permission grant. API charges are separate from ChatGPT subscription usage.

Send `/goal Finish the requested feature and verify it with tests` in the normal chat composer. The extension arms the goal only after observing that exact submitted user turn. It waits for a finalized **latest** assistant turn and stable content, submits goal-scoped observed history to the evaluator, then inserts and submits a continuation if more work is needed. It counts a continuation only after a new user message confirms submission. The popup shows status, errors, acknowledged sends, Pause, Resume and Clear.

## Controls and limits

A goal belongs to one tab and one `/c/<conversation>` identity. Opening another chat cannot reuse its goal. Normal Chat, Work, image output and embedded file cards have distinct DOM cases. User Stop, manual messages, drafts, pending attachments, dialogs and navigation prevent automated sends. An in-flight API result cannot undo Pause or Clear. Requests time out after 25 seconds; API errors pause rather than retry automatically. The default cap is **12 acknowledged continuations**, not 12 evaluator calls.

Goal/history state uses `chrome.storage.session`: it survives service-worker suspension and page reload in the same browser session, but not browser restart or extension reload/update. Closing the tab removes its state. Unknown send outcomes after reload require manual review rather than automatic resubmission. Old 0.1 goals are not migrated. Resume is for `paused`; a `needs_review` or `blocked` goal must be reviewed and cleared/replaced.

## What is and is not verified

The judge sees observed text and image/file **metadata**, not image pixels, downloaded file contents, or proof of external side effects. Image-only responses and missing/oversized history stop for review. File names are not treated as inspected contents. A judge may still make mistakes; this is not an independent verifier of arbitrary outcomes.

The DOM terminal marker is a conservative heuristic validated against the supplied snapshots, not a public ChatGPT contract. Missing markers make the extension wait. The capture does not establish that every future ChatGPT version works. Temporary/no-ID conversations, voice, external file viewers and unknown UI variants are not supported. Close editors/dialogs before allowing automatic continuation. Keep the tab open; background throttling may delay checks.

The extension does **not** replay internal ChatGPT endpoints, extract cookies/tokens, patch fetch/WebSocket, circumvent limits, or bypass refusals/permission requests. Only normal composer interaction is automated. The separate evaluator uses the public API. Review the service's current usage rules before enabling automation.

## Privacy

Your goal and observed conversation since the goal are sent to the evaluator endpoint you configure. Do not use it with information that provider should not receive. API settings are stored locally **without encryption**, restricted to trusted extension contexts with `setAccessLevel`; they are never sent to content scripts or injected into the page. The public repository contains only sanitized structural projections from the private capture, no HAR, session cookies, signed URLs, downloaded personal files, or unrelated chats.

## Tests and CI

```sh
python -m pip install -r tests/browser/requirements.txt
python -m playwright install chromium
npm run ci
```

Node unit tests exercise the state machine, API wire formats, strict verdict validation, budgets, per-tab isolation, races, cancellation and acknowledgement. Playwright runs real Chromium against 27 sanitized capture states and simulated editor/transport boundaries; no live ChatGPT session, paid evaluator or credentials are required. Browser tests also exercise the actual controller, goal service and DOM together. A logical URL is injected in offline tests rather than navigating to ChatGPT. `CHROMIUM_PATH` can select an installed Chromium binary. Fixtures are gzip JSON to reduce repetitive HTML size.

GitHub Actions installs Chromium, runs syntax/manifest checks, unit tests, build, browser tests, native MV3 registration/options smoke test and uploads the installable `dist/` artifact only after all pass. `src/content/dom-adapter.js` handles DOM; `controller.js` owns the loop; `background/goal-service.js` owns state/concurrency; `evaluator.js` owns public API validation; `service-worker.js` and `content-script.js` are thin entry points. Runtime dependencies: none.

GPL-3.0-only; see LICENSE. No warranty.
