(function (root, factory) {
  const api = factory(root.ChatgptGoalCore || (typeof require === 'function' ? require('../shared/goal-core.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ChatgptGoalService = api;
})(globalThis, function (Core) {
  'use strict';
  function createService({ storage, getSettings, evaluate, randomId = () => crypto.randomUUID() }) {
    const locks = new Map();
    const key = id => `chatgptGoal.tab.${id}`;
    const read = async id => (await storage.get(key(id)))[key(id)] || null;
    const save = async (id, goal) => { await storage.set({ [key(id)]: goal }); return goal; };
    async function serial(id, action) {
      const previous = locks.get(id) || Promise.resolve();
      const next = previous.catch(() => {}).then(action); locks.set(id, next);
      try { return await next; } finally { if (locks.get(id) === next) locks.delete(id); }
    }
    function source(message, sender) {
      const tabId = sender?.tab?.id;
      if (!Number.isInteger(tabId) || sender.frameId !== 0 || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(sender.url || '')) throw new Error('Only top-level ChatGPT content scripts can drive a goal.');
      const thread = Core.threadKey(message.threadUrl);
      if (!thread || thread !== Core.threadKey(sender.url)) throw new Error('Conversation changed or is not ready.');
      return { tabId, thread };
    }
    function matches(goal, message, thread) {
      return goal && goal.threadKey === thread && (!message.goalId || message.goalId === goal.goalId);
    }
    async function handleMessage(message, sender) {
      if (!message || typeof message.type !== 'string') throw new Error('Invalid extension message.');
      const { tabId, thread } = source(message, sender);
      if (message.type === 'CG_EVALUATE') return judge(tabId, thread, message);
      return serial(tabId, async () => {
        let goal = await read(tabId);
        if (message.type === 'CG_SET_GOAL') {
          const anchor = Core.normalizeTurn(message.anchor);
          const command = anchor && Core.parseGoalCommand(anchor.text);
          if (!anchor || anchor.role !== 'user' || !command || command.objective !== message.objective || command.objective.length > 4000) throw new Error('Goal must match an observed submitted /goal message (maximum 4000 characters).');
          goal = { ...Core.createGoalState(command.objective), goalId: randomId(), threadKey: thread,
            anchorId: anchor.id, anchorIndex: anchor.index, history: [anchor] };
          return { ok: true, goal: await save(tabId, goal) };
        }
        if (message.type === 'CG_GET_GOAL') return { ok: true, goal: matches(goal, message, thread) ? goal : null };
        if (!matches(goal, message, thread)) return { ok: true, skipped: true, goal: null };
        if (message.type === 'CG_CLEAR_GOAL') { await save(tabId, null); return { ok: true, goal: null }; }
        if (message.type === 'CG_PAUSE_GOAL' || message.type === 'CG_RESUME_GOAL') {
          if (message.type === 'CG_RESUME_GOAL' && goal.status !== 'paused') return { ok: false, error: 'Only a paused goal may be resumed.' };
          goal = { ...goal, status: message.type === 'CG_PAUSE_GOAL' ? 'paused' : 'active', revision: goal.revision + 1,
            lastError: message.reason || null, evaluating: null, pending: null };
          // Resume may retry a failed/aborted send, but only by explicit user action.
          if (message.type === 'CG_RESUME_GOAL') goal.lastEvaluatedFingerprint = '';
        } else if (message.type === 'CG_CLAIM_SEND') {
          if (goal.status !== 'active' || goal.pending?.token !== message.token || goal.pending.phase !== 'ready') return { ok: true, skipped: true };
          goal = { ...goal, pending: { ...goal.pending, phase: 'claimed' }, revision: goal.revision + 1 };
        } else if (message.type === 'CG_SENT') {
          if (goal.pending?.token !== message.token || goal.pending.phase !== 'claimed') return { ok: true, skipped: true };
          const sent = Core.normalizeTurn(message.turn);
          if (!sent || sent.role !== 'user' || sent.text.trim() !== goal.pending.text.trim() || sent.index <= goal.history.at(-1).index) throw new Error('Submission was not acknowledged by a new user turn.');
          goal = { ...goal, pending: null, iteration: goal.iteration + 1, revision: goal.revision + 1,
            history: Core.mergeHistory(goal.history, [sent], goal.anchorIndex) };
        } else if (message.type === 'CG_SEND_FAILED') {
          if (goal.pending?.token !== message.token) return { ok: true, skipped: true };
          goal = { ...goal, status: 'paused', pending: null, revision: goal.revision + 1, lastError: 'Continuation was not acknowledged. Check the chat before resuming.' };
        } else throw new Error(`Unknown message type: ${message.type}`);
        return { ok: true, goal: await save(tabId, { ...goal, updatedAt: Date.now() }) };
      });
    }
    async function judge(tabId, thread, message) {
      const prepared = await serial(tabId, async () => {
        let goal = await read(tabId);
        if (!matches(goal, message, thread) || goal.status !== 'active' || goal.pending) return null;
        if (goal.evaluating) {
          if (Date.now() - goal.evaluating.startedAt > 60000) await save(tabId, { ...goal, status: 'paused', evaluating: null, lastError: 'An evaluator request was interrupted. Resume manually.' });
          return null;
        }
        const visible = (Array.isArray(message.transcript) ? message.transcript : []).map(Core.normalizeTurn).filter(Boolean);
        const anchor = visible.find(t => t.index === goal.anchorIndex);
        const latest = visible.at(-1);
        if (anchor && anchor.id !== goal.anchorId) { await save(tabId, { ...goal, status: 'paused', lastError: 'Conversation branch changed.' }); return null; }
        if (!latest || latest.role !== 'assistant' || !latest.complete || latest.index <= goal.anchorIndex) return null;
        const fingerprint = Core.turnFingerprint(latest);
        if (fingerprint === goal.lastEvaluatedFingerprint) return null;
        const history = Core.mergeHistory(goal.history, visible, goal.anchorIndex);
        let problem = Core.contextProblem(history, goal.anchorIndex);
        if (goal.history.at(-1)?.index > latest.index) problem = 'The current conversation branch is older than the observed history.';
        if (!latest.text.trim() && latest.artifacts.length) problem = 'Image-only output needs visual verification; the evaluator receives no pixels.';
        if (problem) { await save(tabId, { ...goal, history, status: 'needs_review', lastError: problem }); return null; }
        const lease = { token: randomId(), revision: goal.revision, startedAt: Date.now() };
        goal = { ...goal, history, evaluating: lease }; await save(tabId, goal);
        return { goal, lease, fingerprint };
      });
      if (!prepared) return { ok: true, skipped: true, goal: await read(tabId) };
      let verdict, failure, settings;
      try {
        settings = await getSettings();
        verdict = await evaluate({ settings, objective: prepared.goal.objective, transcript: prepared.goal.history });
      } catch { failure = 'Evaluator failed or timed out. Check API settings/limits, then resume manually.'; }
      return serial(tabId, async () => {
        const current = await read(tabId);
        if (!matches(current, { goalId: prepared.goal.goalId }, thread) || current.status !== 'active' ||
            current.revision !== prepared.lease.revision || current.evaluating?.token !== prepared.lease.token) return { ok: true, skipped: true };
        if (failure) {
          const goal = await save(tabId, { ...current, status: 'paused', evaluating: null, lastError: failure });
          return { ok: false, error: failure, goal };
        }
        let outcome;
        try { outcome = Core.applyEvaluation(current, verdict, Math.max(1, Math.min(100, Math.floor(Number(settings.maxIterations) || 12))), prepared.fingerprint); }
        catch {
          const goal = await save(tabId, { ...current, status: 'paused', evaluating: null, lastError: 'Invalid evaluator verdict.' });
          return { ok: false, error: goal.lastError, goal };
        }
        const pending = outcome.shouldContinue ? { token: randomId(), phase: 'ready', text: outcome.continuation, fingerprint: prepared.fingerprint } : null;
        const goal = await save(tabId, { ...outcome.state, evaluating: null, pending });
        return { ok: true, goal, shouldContinue: outcome.shouldContinue, continuation: outcome.continuation, token: pending?.token };
      });
    }
    return { handleMessage, read, remove: tabId => serial(tabId, () => storage.remove(key(tabId))) };
  }
  return { createService };
});
