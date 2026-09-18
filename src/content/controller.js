(function (root) {
  'use strict';
  function createController({ doc = document, browser = chrome, getUrl = () => doc.defaultView.location.href } = {}) {
  const Core = globalThis.ChatgptGoalCore;
  const Dom = globalThis.ChatgptGoalDom.createAdapter(doc, { getUrl });
  const SETTLE_MS = 1600;
  let pendingGoal = null, busy = false, disposed = false, epoch = 0;
  let currentThread = Core.threadKey(getUrl()), lastSignature = '', stableSince = 0, autoSending = false, inserting = false;
  let tickQueued = false;
  const runtime = message => new Promise(resolve => browser.runtime.sendMessage({ ...message, threadUrl: getUrl() }, response => {
    resolve(browser.runtime.lastError ? { ok: false, error: browser.runtime.lastError.message } : response || { ok: false });
  }));
  function error(message) { console.warn('[ChatgptGoal]', message); }
  async function pause(reason) {
    epoch++;
    if (Core.threadKey(getUrl())) await runtime({ type: 'CG_PAUSE_GOAL', reason });
  }
  function onSubmit(event) {
    if (autoSending && (!event.isTrusted || event.type === 'submit')) return;
    const composer = Dom.getComposer();
    if (!composer) return;
    const form = composer.closest('form');
    const clickedSend = event.target.closest?.('button[data-testid="send-button"]');
    const click = event.type === 'click' && Boolean(clickedSend) && clickedSend === Dom.findSendButton();
    const submit = event.type === 'submit' && event.target === form;
    const enter = event.type === 'keydown' && event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing && composer.contains(event.target);
    if (event.type === 'click' && event.target.closest?.('button[data-testid="stop-button"]')) { pause('Stopped by the user.'); return; }
    if (!click && !submit && !enter) return;
    const raw = Dom.getComposerText(); const command = Core.parseGoalCommand(raw);
    if (!command) { if (raw) pause('A manual message interrupted the goal.'); return; }
    // Capturing does not mean submitted. Only a new matching user turn arms the goal.
    if (pendingGoal?.raw === raw) return;
    epoch++;
    pendingGoal = { raw, objective: command.objective, thread: Core.threadKey(getUrl()),
      previousIds: Dom.collectMessages().map(t => t.id), afterIndex: Dom.collectMessages().at(-1)?.index || 0, createdAt: Date.now() };
  }
  function signature(snapshot) {
    const last = snapshot.turns.at(-1);
    return JSON.stringify([snapshot.threadKey, Core.turnFingerprint(last), last?.complete, snapshot.generating]);
  }
  async function tick() {
    if (disposed || busy) return;
    busy = true;
    try {
      const snapshot = Dom.snapshot();
      if (snapshot.threadKey !== currentThread) {
        epoch++; currentThread = snapshot.threadKey; lastSignature = ''; stableSince = Date.now();
        if (pendingGoal?.thread && pendingGoal.thread !== currentThread) pendingGoal = null;
      }
      if (pendingGoal && Date.now() - pendingGoal.createdAt > 30000) pendingGoal = null;
      if (pendingGoal && snapshot.threadKey) {
        // The editor and the rendered message can represent the whitespace after
        // /goal differently. Compare the parsed objective, preserving its content.
        const anchor = snapshot.turns.find(t => t.role === 'user' && t.index > pendingGoal.afterIndex && !pendingGoal.previousIds.includes(t.id) && Core.parseGoalCommand(t.text)?.objective === pendingGoal.objective);
        if (anchor) {
          const pending = pendingGoal; pendingGoal = null;
          const result = await runtime({ type: 'CG_SET_GOAL', objective: pending.objective, anchor });
          if (!result.ok) error(result.error || 'Could not start the goal.');
          lastSignature = ''; stableSince = Date.now(); return;
        }
      }
      const sig = signature(snapshot);
      if (sig !== lastSignature) { lastSignature = sig; stableSince = Date.now(); return; }
      if (!snapshot.threadKey || !snapshot.composerReady || snapshot.blocked || snapshot.draft || !snapshot.candidate || Date.now() - stableSince < SETTLE_MS) return;
      const version = epoch, thread = snapshot.threadKey;
      const goalResult = await runtime({ type: 'CG_GET_GOAL' });
      const goal = goalResult.goal;
      if (!goal || goal.status !== 'active') return;
      // Unknown outcome after reload/service-worker restart is never resent automatically.
      if (goal.pending) { await pause('An interrupted continuation needs review before resuming.'); return; }
      const unchanged = () => !disposed && epoch === version && Core.threadKey(getUrl()) === thread && signature(Dom.snapshot()) === sig;
      if (!unchanged()) return;
      const result = await runtime({ type: 'CG_EVALUATE', goalId: goal.goalId, transcript: snapshot.turns });
      if (!result.ok || !result.shouldContinue) return;
      if (!unchanged() || Dom.hasDraft() || Dom.interactionBlocked()) {
        await runtime({ type: 'CG_SEND_FAILED', goalId: goal.goalId, token: result.token }); return;
      }
      const claimed = await runtime({ type: 'CG_CLAIM_SEND', goalId: goal.goalId, token: result.token });
      if (!claimed.ok || claimed.skipped || !unchanged()) return;
      autoSending = true;
      try {
        // During insertion, the previous assistant remains the same. After a real send it changes to a user turn.
        const sendEpoch = epoch;
        const turn = await Dom.sendMessage(result.continuation, {
          guard: () => !disposed && epoch === sendEpoch && Core.threadKey(getUrl()) === thread,
          beforeSend: unchanged,
          onInsert: value => { inserting = value; },
        });
        await runtime({ type: 'CG_SENT', goalId: goal.goalId, token: result.token, turn });
      } catch (e) {
        await runtime({ type: 'CG_SEND_FAILED', goalId: goal.goalId, token: result.token }); error(e.message);
      } finally { autoSending = false; lastSignature = ''; }
    } finally { busy = false; }
  }
  function schedule() {
    if (tickQueued || disposed) return;
    tickQueued = true;
    setTimeout(() => { tickQueued = false; tick().catch(e => error(e.message)); }, 100);
  }
  function onInput(event) {
    if (autoSending && !inserting && event.isTrusted && Dom.getComposer()?.contains(event.target)) pause('User edited the continuation.');
  }
  doc.addEventListener('input', onInput, true);
  ['click', 'keydown', 'submit'].forEach(type => doc.addEventListener(type, onSubmit, true));
  const observer = new MutationObserver(schedule);
  observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ['data-testid', 'disabled', 'aria-disabled', 'aria-busy', 'data-turn', 'contenteditable', 'hidden', 'inert'] });
  // Polling also catches SPA history changes without patching the page's scripts.
  const interval = setInterval(schedule, 500); schedule();
  browser.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === 'CG_POPUP_STATUS') { runtime({ type: 'CG_GET_GOAL' }).then(respond); return true; }
    if (['CG_PAUSE_GOAL', 'CG_RESUME_GOAL', 'CG_CLEAR_GOAL'].includes(message.type)) {
      epoch++; pendingGoal = null;
      runtime({ type: message.type }).then(result => { respond(result); schedule(); }); return true;
    }
    return false;
  });
  return { tick, dispose() {
    disposed = true; epoch++; doc.removeEventListener('input', onInput, true); observer.disconnect(); clearInterval(interval);
    ['click', 'keydown', 'submit'].forEach(type => doc.removeEventListener(type, onSubmit, true));
  } };
  }
  root.ChatgptGoalControllerFactory = { createController };
})(globalThis);
