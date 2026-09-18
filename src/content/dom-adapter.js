(function (root, factory) {
  const api = factory(root.ChatgptGoalCore || (typeof require === 'function' ? require('../shared/goal-core.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ChatgptGoalDom = api;
})(globalThis, function (Core) {
  'use strict';
  const SELECTORS = Object.freeze({
    composer: 'form[data-type="unified-composer"] #prompt-textarea',
    form: 'form[data-type="unified-composer"]',
    turn: '[data-testid^="conversation-turn-"][data-turn]',
    send: 'button[data-testid="send-button"]', stop: 'button[data-testid="stop-button"]',
    terminal: 'button[data-testid="copy-turn-action-button"]',
  });
  function createAdapter(doc = document, { getUrl = () => doc.defaultView.location.href } = {}) {
    const win = doc.defaultView;
    const attachmentCache = new Map();
    const root = () => doc.querySelector('main#main, main');
    function visible(el) {
      if (!el?.isConnected || el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
      const style = win.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
    }
    function getComposer() {
      return [...doc.querySelectorAll(SELECTORS.composer)].find(el =>
        (el.isContentEditable || el.tagName === 'TEXTAREA') && !el.closest('[role="dialog"]') && visible(el)) || null;
    }
    function getComposerText() {
      const el = getComposer();
      return el ? (el.tagName === 'TEXTAREA' ? el.value : el.innerText).trim() : '';
    }
    const form = () => getComposer()?.closest(SELECTORS.form);
    function findSendButton() { return form()?.querySelector(SELECTORS.send) || null; }
    function isGenerating() {
      // Attribute-only send -> stop transitions are observed by the controller too.
      return Boolean(doc.querySelector(`${SELECTORS.form} ${SELECTORS.stop}`));
    }
    function interactionBlocked() {
      return [...doc.querySelectorAll('[role="dialog"], [role="menu"][data-state="open"]')].some(visible);
    }
    function hasDraft() {
      return Boolean(getComposerText() || form()?.querySelector('button[aria-label^="Remove file"]') ||
        [...(form()?.querySelectorAll('input[type="file"]') || [])].some(input => input.files?.length));
    }
    function textOf(node) {
      if (node.nodeType === 3) return node.textContent;
      if (node.nodeType !== 1) return '';
      if (node.classList.contains('katex')) return node.querySelector('annotation')?.textContent || '';
      if (node.matches('script, style, button, svg, img, [hidden], [aria-hidden="true"], .sr-only, .hidden')) return '';
      if (node.tagName === 'BR') return '\n';
      if (node.tagName === 'PRE') return '\n```\n' + (node.querySelector('code') || node).textContent + '\n```\n';
      if (node.tagName === 'TABLE') return '\n' + [...node.rows].map(row => '| ' + [...row.cells].map(cell => [...cell.childNodes].map(textOf).join('').trim()).join(' | ') + ' |').join('\n') + '\n';
      const text = [...node.childNodes].map(textOf).join('');
      return /^(P|DIV|LI|H[1-6]|UL|OL|BLOCKQUOTE)$/.test(node.tagName) ? `\n${text}\n` : text;
    }
    function artifactsOf(turn) {
      const items = [];
      const images = new Set(), files = new Set();
      for (const img of turn.querySelectorAll('img[alt]')) {
        const alt = img.getAttribute('alt').trim();
        // Captured image cards have several display/glow <img> layers.
        // Identity is the image container (or source), never its human label.
        const identity = img.closest('[id^="image-"], [class~="group/imagegen-image"]') ||
          img.currentSrc || img.getAttribute('src') || img;
        if (alt && !images.has(identity)) {
          images.add(identity);
          items.push({ kind: 'image', name: alt.slice(0, 200), url: img.currentSrc || img.getAttribute('src') || '' });
        }
      }
      for (const el of turn.querySelectorAll('button[aria-label], a[href]')) {
        const label = el.getAttribute('aria-label') || el.textContent;
        const name = label?.match(/([^\s/\\]+\.(?:txt|json|csv|pdf|docx?|xlsx?|pptx?|zip|md|py|js|html))\b/i)?.[1];
        if (name && !files.has(name)) {
          files.add(name);
          items.push({ kind: 'file', name, url: el.tagName === 'A' ? el.href : '' });
        }
      }
      return items;
    }
    async function prepareTranscript(turns, count = 20) {
      const recent = turns.slice(-Math.max(1, Math.min(100, count)));
      let total = 0;
      const result = [];
      for (const turn of recent) {
        const artifacts = [];
        for (const artifact of turn.artifacts) {
          let data = artifact.data || attachmentCache.get(artifact.url);
          if (!data) {
            if (!artifact.url) throw new Error(`Attachment has no readable download: ${artifact.name}`);
            const url = new URL(artifact.url, getUrl());
            if (!['https:', 'blob:', 'data:'].includes(url.protocol)) throw new Error('Unsupported attachment URL.');
            const response = await win.fetch(url.href, { credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
            if (!response.ok) throw new Error(`Could not load attachment: ${artifact.name}`);
            const blob = await response.blob();
            if (blob.size > 4 * 1024 * 1024) throw new Error(`Attachment exceeds 4 MB: ${artifact.name}`);
            if (artifact.kind === 'image' && !blob.type.startsWith('image/')) throw new Error('Image download returned non-image content.');
            data = await new Promise((resolve, reject) => {
              const reader = new win.FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = () => reject(new Error('Could not read attachment.'));
              reader.readAsDataURL(blob);
            });
            attachmentCache.set(artifact.url, data);
            if (attachmentCache.size > 100) attachmentCache.delete(attachmentCache.keys().next().value);
          }
          total += data.length;
          if (total > 6 * 1024 * 1024) throw new Error('Attachments exceed 6 MB. Reduce the recent-message count.');
          artifacts.push({ ...artifact, data });
        }
        result.push({ ...turn, artifacts });
      }
      return result;
    }
    function collectMessages() {
      return [...(root()?.querySelectorAll(SELECTORS.turn) || [])].flatMap(turn => {
        const role = turn.dataset.turn;
        const index = Number(turn.dataset.testid.match(/^conversation-turn-(\d+)$/)?.[1]);
        if (!['user', 'assistant'].includes(role) || !index) return [];
        const nodes = [...turn.querySelectorAll(`[data-message-author-role="${role}"]`)]
          .filter(n => !n.parentElement.closest('[data-message-author-role]'));
        // User file tiles are siblings of the actual prompt; their filenames are not command text.
        // Whitespace inside code is evidence, including indentation and blank lines.
        // Do not normalize the combined rendered text after extracting <pre>.
        const text = nodes.map(n => textOf(role === 'user' ?
          (n.querySelector('[data-testid="collapsible-user-message-content"]') || n.querySelector('.whitespace-pre-wrap') || n) : n).trim()).filter(Boolean).join('\n\n');
        return [{ id: nodes.map(n => n.dataset.messageId).filter(Boolean).join('|') || turn.dataset.testid,
          index, role, text, artifacts: artifactsOf(turn),
          complete: role === 'assistant' && Boolean(turn.querySelector(SELECTORS.terminal)) }];
      });
    }
    function snapshot() {
      const turns = collectMessages();
      const last = turns.at(-1);
      const generating = isGenerating();
      return { threadKey: Core.threadKey(getUrl()), turns, generating,
        composerReady: Boolean(getComposer()), blocked: interactionBlocked(), draft: hasDraft(),
        candidate: last?.role === 'assistant' && last.complete && !generating ? last : null };
    }
    function setComposerText(text) {
      const el = getComposer();
      if (!el) throw new Error('ChatGPT composer was not found.');
      el.focus();
      if (el.tagName === 'TEXTAREA') {
        Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value').set.call(el, text);
        el.dispatchEvent(new win.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      } else {
        // Editing transaction is observed by ProseMirror. Replacing textContent bypasses its state.
        const range = doc.createRange(); range.selectNodeContents(el);
        const selection = win.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        for (const [index, line] of text.split('\n').entries()) {
          if (index && !doc.execCommand('insertLineBreak', false)) throw new Error('The editor rejected a line break.');
          if (line && !doc.execCommand('insertText', false, line)) throw new Error('The editor rejected text insertion.');
        }
      }
      if (getComposerText() !== text.trim()) throw new Error('The editor did not accept the continuation text.');
    }
    async function waitFor(predicate, timeoutMs) {
      const until = Date.now() + timeoutMs;
      do { const value = predicate(); if (value) return value; await new Promise(r => win.setTimeout(r, 50)); } while (Date.now() < until);
      throw new Error('ChatGPT did not acknowledge the operation before timeout.');
    }
    async function sendMessage(text, { guard = () => true, beforeSend = () => true, onInsert = () => {}, timeoutMs = 10000 } = {}) {
      const assertSafe = () => {
        if (!guard() || !getComposer() || isGenerating() || interactionBlocked()) throw new Error('Continuation cancelled: page or goal changed.');
      };
      assertSafe();
      if (hasDraft()) throw new Error('An unsent draft or attachment is present.');
      const old = collectMessages(); const lastIndex = old.at(-1)?.index || 0;
      onInsert(true);
      try { setComposerText(text); } finally { onInsert(false); }
      await waitFor(() => {
        assertSafe();
        if (getComposerText() !== text.trim()) throw new Error('The user changed the composer.');
        const button = findSendButton();
        return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true' && visible(button) && button;
      }, timeoutMs);
      assertSafe();
      if (!beforeSend()) throw new Error('Assistant turn changed before send.');
      findSendButton().click();
      // A click/cleared composer alone is not proof that a request was submitted.
      return waitFor(() => {
        if (!guard()) throw new Error('Goal changed while waiting for submission.');
        return collectMessages().find(t => t.role === 'user' && t.index > lastIndex && t.text.trim() === text.trim());
      }, timeoutMs);
    }
    return { getComposer, getComposerText, findSendButton, setComposerText, isGenerating, hasDraft,
      collectMessages, snapshot, sendMessage, interactionBlocked, prepareTranscript,
      latestAssistantText: () => collectMessages().filter(t => t.role === 'assistant').at(-1)?.text || '' };
  }
  return { SELECTORS, createAdapter };
});
