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
  return new Promise((resolve) => chrome.tabs.sendMessage(activeTabId, { type }, (response) => resolve(response)));
}

function render(goal) {
  currentGoal = goal;
  if (!goal) {
    summary.textContent = "No goal is active in this tab. Send /goal … in ChatGPT.";
    controls.hidden = true;
    return;
  }
  summary.textContent = `${goal.status} · iteration ${goal.iteration}: ${goal.objective}`;
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
  render(response && response.goal);
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
