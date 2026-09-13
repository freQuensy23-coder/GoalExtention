'use strict';
importScripts('../shared/goal-core.js', 'evaluator.js', 'goal-service.js');
// Local settings are not encrypted. They are restricted to extension contexts, never content scripts.
const ready = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
]);
const service = ChatgptGoalService.createService({
  storage: chrome.storage.session,
  getSettings: async () => {
    const result = await chrome.storage.local.get('chatgptGoal.settings');
    return { apiKey: '', apiEndpoint: 'https://api.openai.com/v1/responses', model: 'gpt-5-mini', maxIterations: 12,
      ...(result['chatgptGoal.settings'] || {}) };
  },
  evaluate: args => ChatgptGoalEvaluator.evaluateGoal(args),
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  ready.then(() => service.handleMessage(message, sender)).then(sendResponse)
    .catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => { service.remove(tabId).catch(() => {}); });
