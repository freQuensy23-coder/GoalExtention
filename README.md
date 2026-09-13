# ChatgptGoal

A Manifest V3 Chrome extension that adds a Codex-like `/goal` loop to the ChatGPT web UI.

## How it works

1. Send a normal ChatGPT message that starts with `/goal`, for example `/goal Implement the requested feature and verify it with tests`.
2. The content script records the objective and watches the ChatGPT DOM with `MutationObserver`.
3. When generation appears to have finished, the extension sends the objective, recent transcript, and latest assistant response to a small evaluator model using the API key configured in extension settings.
4. The evaluator returns `{ complete, reason, missing, confidence }`.
5. If complete, the loop stops. Otherwise ChatgptGoal inserts a continuation message describing what is missing and clicks ChatGPT's Send button.
6. The loop repeats until completion, pause/clear, an error, or the configured iteration cap.

The API key stays in the extension background/service-worker context and is never injected into the ChatGPT page.

## Install locally

```sh
npm ci
npm test
npm run build
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `dist/`. Open the extension settings and configure the evaluator API key/model.

The default evaluator endpoint is `https://api.openai.com/v1/responses`. A `/v1/chat/completions`-style endpoint is also supported. Custom HTTPS origins request an optional Chrome host permission when settings are saved.

## Current ChatGPT DOM assumptions

The real ChatGPT site is intentionally isolated behind `src/content/dom-adapter.js`. The current skeleton uses conservative selectors such as:

- composer: `#prompt-textarea`
- send button: `button[data-testid="send-button"]`
- stop button: `button[data-testid="stop-button"]`
- messages: `[data-message-author-role]`

If ChatGPT changes its DOM, update only that adapter. The fallback deliberately returns no transcript rather than guessing message authorship.

## Safety / loop controls

- Goals are isolated per browser tab.
- A response fingerprint prevents evaluating the same assistant response twice.
- The popup supports pause, resume, and clear.
- `maxIterations` defaults to 12 to prevent accidental infinite loops/API spend.
- The evaluator is instructed to treat placeholders, deferred work, and unverified promises as incomplete.
- Closing a tab deletes its stored goal state.

## Tests

Unit tests use Node's built-in test runner and cover command parsing, state transitions, iteration limits, transcript truncation, fingerprinting, evaluator JSON parsing, and both supported API response shapes. No runtime dependency is required.

## CI

`.github/workflows/ci.yml` runs on pushes and pull requests, executes checks/tests/build, and uploads `dist/` as the `chatgpt-goal-extension` artifact.

## Known MVP limitations

This repository does not yet include browser-level integration tests against the live ChatGPT UI. Completion detection is based on DOM stability plus the disappearance of the Stop button, so the DOM adapter should be validated against the live site before treating it as production-ready. Tab-scoped goals survive reloads in the same tab but are intentionally cleared when the tab closes.
