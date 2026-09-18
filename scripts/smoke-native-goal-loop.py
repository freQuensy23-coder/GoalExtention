#!/usr/bin/env python3
"""Native unpacked-extension E2E against an offline ChatGPT-shaped page.

No live ChatGPT or evaluator endpoint is contacted. Playwright fulfills the ChatGPT URL from
memory and the extension service worker's fetch is replaced with a deterministic evaluator.
This validates the real MV3 registration/content-script/background/storage boundary in Chromium.
"""
from __future__ import annotations

import json
import tempfile
import time
import os
import shutil
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = str(ROOT / "dist")
CHAT_URL = "https://chatgpt.com/"

CHAT_HTML = r'''<!doctype html>
<meta charset="utf-8">
<title>Offline ChatGPT fixture</title>
<main id="main"></main>
<form data-type="unified-composer">
  <textarea name="prompt-textarea" hidden></textarea>
  <div id="prompt-textarea" class="ProseMirror" contenteditable="true"><p><br></p></div>
  <button id="composer-submit-button" data-testid="send-button" type="submit" disabled>Send prompt</button>
</form>
<style>
  #prompt-textarea { min-height: 40px; width: 600px; }
  button { min-width: 40px; min-height: 30px; }
</style>
<script>
(() => {
  const main = document.querySelector('main');
  const form = document.querySelector('form');
  const editor = document.querySelector('#prompt-textarea');
  const send = document.querySelector('[data-testid="send-button"]');
  window.nativeSubmissions = [];
  let sequence = 0;
  const text = () => editor.innerText.trim();
  editor.addEventListener('input', () => { send.disabled = !text(); });
  function addTurn(role, value, complete) {
    sequence += 1;
    const section = document.createElement('section');
    section.dataset.testid = `conversation-turn-${sequence}`;
    section.dataset.turn = role;
    const message = document.createElement('div');
    message.dataset.messageAuthorRole = role;
    message.dataset.messageId = `synthetic-${sequence}`;
    message.textContent = value;
    section.append(message);
    if (role === 'assistant' && complete) {
      const copy = document.createElement('button');
      copy.dataset.testid = 'copy-turn-action-button';
      copy.textContent = 'Copy response';
      section.append(copy);
    }
    main.append(section);
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    const value = text();
    if (!value || send.disabled) return;
    window.nativeSubmissions.push(value);
    if (window.nativeSubmissions.length === 1) {
      history.pushState({}, '', '/c/WEB:pending');
      setTimeout(() => history.replaceState({}, '', '/c/native-offline-demo'), 200);
    }
    addTurn('user', value, false);
    editor.replaceChildren(document.createElement('p'));
    editor.firstChild.append(document.createElement('br'));
    send.disabled = true;
    setTimeout(() => addTurn('assistant', window.nativeSubmissions.length === 1 ? 'Partial deliverable' : 'Finished deliverable', true), 100);
  });
})();
</script>'''


def first_goal(worker):
    return worker.evaluate("""async () => {
      const all = await chrome.storage.session.get(null);
      const values = Object.values(all).filter(v => v && typeof v === 'object' && v.goalId);
      return values[0] || null;
    }""")


def wait_goal(worker, predicate, timeout=15.0):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = first_goal(worker)
        if last and predicate(last):
            return last
        time.sleep(0.1)
    raise AssertionError(f"goal state did not reach expected condition; last={last}")


with sync_playwright() as playwright, tempfile.TemporaryDirectory() as profile:
    executable = os.environ.get("CHROMIUM_PATH")
    launch = {
        "headless": True,
        "args": [f"--disable-extensions-except={EXTENSION}", f"--load-extension={EXTENSION}"],
    }
    if executable:
        launch["executable_path"] = executable
    else:
        launch["channel"] = "chromium"
    context = playwright.chromium.launch_persistent_context(profile, **launch)
    try:
        context.route("https://chatgpt.com/**", lambda route: route.fulfill(status=200, content_type="text/html", body=CHAT_HTML))
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker", timeout=15000)
        worker.evaluate("""async () => {
          await ready;
          await chrome.storage.local.set({'chatgptGoal.settings': {
            apiKey: 'synthetic-key-not-a-credential',
            apiEndpoint: 'https://api.openai.com/v1/responses',
            model: 'synthetic-evaluator',
            historyMessages: 3,
          }});
          globalThis.__nativeJudgeCalls = 0;
          globalThis.fetch = async () => {
            globalThis.__nativeJudgeCalls += 1;
            const verdict = globalThis.__nativeJudgeCalls === 1
              ? {is_goal_done:false, short_explanation:'One check remains'}
              : {is_goal_done:true, short_explanation:'All requested work is visible'};
            return new Response(JSON.stringify({
              status:'completed',
              output:[{type:'message', content:[{type:'output_text', text:JSON.stringify(verdict)}]}],
            }), {status:200, headers:{'Content-Type':'application/json'}});
          };
        }""")

        page = context.new_page()
        page.goto(CHAT_URL, wait_until="domcontentloaded")
        # Content scripts run at document_idle in an isolated world. Give the real
        # extension listener a deterministic chance to attach before the first submit.
        page.wait_for_timeout(750)
        page.locator("#prompt-textarea").fill("/goal \n\nfinish the offline native smoke test")
        page.locator('[data-testid="send-button"]').click()

        wait_goal(worker, lambda goal: goal.get("status") == "active")
        final = wait_goal(worker, lambda goal: goal.get("status") == "complete" and goal.get("iteration") == 1)
        submissions = page.evaluate("window.nativeSubmissions")
        judge_calls = worker.evaluate("globalThis.__nativeJudgeCalls")

        assert len(submissions) == 2, submissions
        assert submissions[0].split() == ['/goal', 'finish', 'the', 'offline', 'native', 'smoke', 'test']
        assert "You are working in a fully automated environment" in submissions[1]
        assert "Your task:\nfinish the offline native smoke test" in submissions[1]
        assert judge_calls == 2, judge_calls
        assert final["pending"] is None
        print("Native offline /goal loop passed: content script -> session state -> evaluator -> auto-send -> complete.")
    finally:
        context.close()
