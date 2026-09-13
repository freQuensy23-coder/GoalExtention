"use strict";

importScripts(
  chrome.runtime.getURL("src/shared/goal-core.js"),
  chrome.runtime.getURL("src/background/evaluator.js"),
);

const Core = globalThis.ChatgptGoalCore;
const Evaluator = globalThis.ChatgptGoalEvaluator;
const GOALS_KEY = "chatgptGoal.goalsByTab";
const SETTINGS_KEY = "chatgptGoal.settings";

const DEFAULT_SETTINGS = {
  apiKey: "",
  apiEndpoint: "https://api.openai.com/v1/responses",
  model: "gpt-5-mini",
  maxIterations: 12,
};

async function getSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] || {}) };
}

async function getGoals() {
  const result = await chrome.storage.local.get(GOALS_KEY);
  return result[GOALS_KEY] || {};
}

async function setGoals(goals) {
  await chrome.storage.local.set({ [GOALS_KEY]: goals });
}

async function getGoal(tabId) {
  if (tabId == null) return null;
  const goals = await getGoals();
  return goals[String(tabId)] || null;
}

async function saveGoal(tabId, goal) {
  const goals = await getGoals();
  if (goal) goals[String(tabId)] = goal;
  else delete goals[String(tabId)];
  await setGoals(goals);
  return goal;
}

function tabIdFromSender(sender) {
  return sender && sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
}

async function handleMessage(message, sender) {
  const tabId = tabIdFromSender(sender);
  if (!message || typeof message.type !== "string") return { ok: false, error: "Invalid message." };

  if (message.type === "CG_GET_SETTINGS") {
    const settings = await getSettings();
    return { ok: true, settings: { ...settings, apiKey: settings.apiKey ? "••••••••" : "" } };
  }

  if (tabId == null) return { ok: false, error: "Message is not associated with a ChatGPT tab." };

  if (message.type === "CG_SET_GOAL") {
    const objective = String(message.objective || "").trim();
    if (!objective) return { ok: false, error: "Goal is empty." };
    const state = Core.createGoalState(objective, message.baselineFingerprint || "");
    state.threadUrl = String(message.threadUrl || sender.tab.url || "");
    await saveGoal(tabId, state);
    return { ok: true, goal: state };
  }

  if (message.type === "CG_GET_GOAL") return { ok: true, goal: await getGoal(tabId) };

  if (message.type === "CG_CLEAR_GOAL") {
    await saveGoal(tabId, null);
    return { ok: true, goal: null };
  }

  if (message.type === "CG_PAUSE_GOAL" || message.type === "CG_RESUME_GOAL") {
    const goal = await getGoal(tabId);
    if (!goal) return { ok: false, error: "No goal for this tab." };
    goal.status = message.type === "CG_PAUSE_GOAL" ? "paused" : "active";
    goal.updatedAt = Date.now();
    await saveGoal(tabId, goal);
    return { ok: true, goal };
  }

  if (message.type === "CG_EVALUATE") {
    const goal = await getGoal(tabId);
    if (!goal || goal.status !== "active") return { ok: true, skipped: true, goal };

    const fingerprint = String(message.fingerprint || "");
    if (!fingerprint || fingerprint === goal.lastEvaluatedFingerprint) {
      return { ok: true, skipped: true, goal };
    }

    const settings = await getSettings();
    try {
      const evaluation = await Evaluator.evaluateGoal({
        fetchFn: fetch,
        settings,
        objective: goal.objective,
        transcript: Core.truncateTranscript(message.transcript, 50000),
        latestResponse: String(message.latestResponse || ""),
      });
      const outcome = Core.applyEvaluation(goal, evaluation, settings.maxIterations, fingerprint);
      outcome.state.threadUrl = String(message.threadUrl || sender.tab.url || goal.threadUrl || "");
      await saveGoal(tabId, outcome.state);
      return {
        ok: true,
        goal: outcome.state,
        evaluation,
        shouldContinue: outcome.shouldContinue,
        continuation: outcome.continuation,
      };
    } catch (error) {
      goal.lastError = error instanceof Error ? error.message : String(error);
      goal.updatedAt = Date.now();
      await saveGoal(tabId, goal);
      return { ok: false, error: goal.lastError, goal };
    }
  }

  return { ok: false, error: `Unknown message type: ${message.type}` };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }));
  return true;
});

chrome.tabs && chrome.tabs.onRemoved && chrome.tabs.onRemoved.addListener(async (tabId) => {
  await saveGoal(tabId, null).catch(() => {});
});
