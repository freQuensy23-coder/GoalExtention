"use strict";

const summary = document.getElementById("summary");
const controls = document.getElementById("controls");
const toggle = document.getElementById("toggle");
const clear = document.getElementById("clear");
const options = document.getElementById("options");
let activeTabId = null;
let currentGoal = null;

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function sendToTab(type) {
  return new Promise((resolve) => chrome.tabs.sendMessage(activeTabId, { type }, (response) => resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : response)));
}

function render(goal) {
  currentGoal = goal;
  if (!goal) {
    summary.textContent = "No goal is active in this tab. Send /goal … in ChatGPT.";
    controls.hidden = true;
    return;
  }
  summary.textContent = `${goal.status} · sent ${goal.iteration}: ${goal.objective}` +
    (goal.lastError ? `\n${goal.lastError}` : goal.lastEvaluation ? `\n${goal.lastEvaluation.short_explanation}` : '');
  controls.hidden = false;
  toggle.textContent = goal.status === "paused" ? "Resume" : "Pause";
  toggle.disabled = !["active", "paused"].includes(goal.status);
}

async function refresh() {
  const tab = await activeTab();
  activeTabId = tab && tab.id;
  if (!activeTabId || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || "")) {
    summary.textContent = "Open ChatGPT to use ChatgptGoal.";
    return;
  }
  const response = await sendToTab("CG_POPUP_STATUS");
  if (!response?.ok) {
    summary.textContent = `Could not read goal status. Reload the ChatGPT tab. ${response?.error || ''}`;
    controls.hidden = true;
    return;
  }
  render(response && response.goal);
  if (response.goal?.status === 'active' && response.waiting) summary.textContent += `\n${response.waiting}`;
}

toggle.addEventListener("click", async () => {
  const type = currentGoal && currentGoal.status === "paused" ? "CG_RESUME_GOAL" : "CG_PAUSE_GOAL";
  const response = await sendToTab(type);
  render(response && response.goal);
});
clear.addEventListener("click", async () => {
  await sendToTab("CG_CLEAR_GOAL");
  render(null);
});
options.addEventListener("click", () => chrome.runtime.openOptionsPage());
refresh().catch((error) => { summary.textContent = String(error); });
