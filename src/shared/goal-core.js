(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ChatgptGoalCore = api;
})(globalThis, function () {
  'use strict';
  const MAX_CONTEXT = 50000;
  function parseGoalCommand(text) {
    const match = typeof text === 'string' && text.match(/^\s*\/goal(?:\s+|\s*:\s*)([\s\S]+?)\s*$/i);
    return match && match[1].trim() ? { objective: match[1].trim() } : null;
  }
  function threadKey(value) {
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' || !['chatgpt.com', 'chat.openai.com'].includes(u.hostname)) return null;
      const id = u.pathname.match(/(?:^|\/)c\/([\w-]+)\/?$/)?.[1];
      return id ? `chatgpt:${id}` : null;
    } catch { return null; }
  }
  function fingerprintText(text) {
    const input = String(text || ''); let hash = 2166136261;
    for (let i = 0; i < input.length; i++) { hash ^= input.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return `${input.length}:${(hash >>> 0).toString(16)}`;
  }
  function turnFingerprint(turn) {
    return turn ? fingerprintText(JSON.stringify([turn.index, turn.id, turn.role, turn.text, turn.artifacts || []])) : '';
  }
  function normalizeEvaluation(raw) {
    if (!raw || typeof raw.complete !== 'boolean' || typeof raw.reason !== 'string' ||
        !Array.isArray(raw.missing) || raw.missing.some(s => typeof s !== 'string') ||
        typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1 ||
        typeof raw.needsReview !== 'boolean') throw new Error('Invalid evaluator verdict.');
    if (raw.complete && (raw.missing.length || raw.needsReview)) throw new Error('Contradictory evaluator verdict.');
    return { complete: raw.complete, reason: raw.reason.trim().slice(0, 2000),
      missing: raw.missing.map(s => s.trim().slice(0, 1000)).filter(Boolean).slice(0, 12),
      confidence: raw.confidence, needsReview: raw.needsReview };
  }
  function buildContinuationPrompt(objective) {
    return [
      'You are working in a fully automated environment, and you must complete the task entirely on your own if the message was preceded by /goal.',
      'Your task:\n' + objective,
      'If you have any questions that should be discussed, then NO — you DO NOT HAVE THE RIGHT TO DISCUSS THEM and must choose the best solution on your own.',
      'If you reach a dead end, you must not spout nonsense about the task being impossible — instead, stop, think deeply about what you are doing wrong, and find a better path.',
      'Likewise, when there are problems with access, permissions, etc. — if you do not have access to a tool in automated mode, that means you do NOT need it to complete this task, and you should stop and plan the work better using other tools configured for this task.',
    ].join('\n\n');
  }
  function createGoalState(objective, baselineFingerprint = '', now = Date.now()) {
    return { objective: String(objective || '').trim(), status: 'active', iteration: 0, revision: 1,
      createdAt: now, updatedAt: now, lastEvaluatedFingerprint: baselineFingerprint,
      lastEvaluation: null, lastError: null, history: [], pending: null };
  }
  // maxIterations counts acknowledged sends, not evaluator calls.
  function applyEvaluation(state, evaluation, maxIterations, fingerprint, now = Date.now()) {
    const e = normalizeEvaluation(evaluation);
    const next = { ...state, lastEvaluation: e, lastEvaluatedFingerprint: fingerprint, updatedAt: now, lastError: null };
    let continuation = null;
    if (e.needsReview || e.confidence < 0.75) next.status = 'needs_review';
    else if (e.complete) next.status = 'complete';
    else if (state.iteration >= maxIterations) { next.status = 'blocked'; next.lastError = 'Maximum continuation iterations reached.'; }
    else continuation = buildContinuationPrompt(state.objective);
    return { state: next, shouldContinue: Boolean(continuation), continuation };
  }
  function normalizeTurn(t) {
    if (!t || !['user', 'assistant'].includes(t.role) || !Number.isInteger(t.index) || t.index < 1 || typeof t.id !== 'string' || !t.id) return null;
    return { id: t.id.slice(0, 200), index: t.index, role: t.role, text: String(t.text || ''),
      complete: t.complete === true, artifacts: (Array.isArray(t.artifacts) ? t.artifacts : []).slice(0, 20).map(a => ({
        kind: a.kind === 'image' ? 'image' : 'file', name: String(a.name || '').slice(0, 200), verified: false,
      })) };
  }
  function mergeHistory(previous, visible, anchorIndex) {
    const map = new Map((previous || []).map(t => [t.index, t]));
    for (const t of (visible || []).map(normalizeTurn).filter(Boolean)) if (t.index >= anchorIndex) map.set(t.index, t);
    return [...map.values()].filter(t => t.index >= anchorIndex).sort((a, b) => a.index - b.index);
  }
  function contextProblem(history, anchorIndex) {
    if (!history.length || history[0].index !== anchorIndex) return 'The goal start is missing from the observed conversation.';
    if (history.some((t, i) => i && t.index !== history[i - 1].index + 1)) return 'Conversation turns are missing (virtualized or not observed).';
    if (JSON.stringify(history).length > MAX_CONTEXT) return 'The observed conversation exceeds the evaluator context budget.';
    return null;
  }
  // Kept for callers, but never silently used to judge incomplete context.
  function truncateTranscript(messages, maxChars = MAX_CONTEXT) {
    const result = []; let left = Math.max(0, Math.floor(maxChars));
    for (let i = (messages || []).length - 1; i >= 0 && left > 0; i--) {
      const m = messages[i]; if (!['user', 'assistant'].includes(m?.role)) continue;
      const overhead = m.role.length + 8; if (left <= overhead) break;
      const text = String(m.text || '').slice(-(left - overhead));
      if (text) { result.unshift({ role: m.role, text }); left -= text.length + overhead; }
    }
    return result;
  }
  return { MAX_CONTEXT, parseGoalCommand, threadKey, fingerprintText, turnFingerprint, normalizeEvaluation,
    buildContinuationPrompt, createGoalState, applyEvaluation, normalizeTurn, mergeHistory, contextProblem, truncateTranscript };
});
