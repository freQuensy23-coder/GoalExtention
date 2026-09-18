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
    return { ...ChatgptGoalEvaluator.DEFAULTS,
      ...(result['chatgptGoal.settings'] || {}) };
  },
  evaluate: args => ChatgptGoalEvaluator.evaluateGoal(args),
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  ready.then(async () => {
    // sender.url can retain the document's original URL across pushState.
    // Authenticate the original sender, then use the browser's current tab URL.
    if (sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) ||
        !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(sender.url || '')) {
      throw new Error('Only top-level ChatGPT content scripts can drive a goal.');
    }
    const tab = await chrome.tabs.get(sender.tab.id);
    if (new URL(tab.url).origin !== new URL(sender.url).origin) {
      throw new Error('Conversation changed or is not ready.');
    }
    return service.handleMessage(message, { ...sender, url: tab.url });
  }).then(sendResponse)
    .catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => { service.remove(tabId).catch(() => {}); });
