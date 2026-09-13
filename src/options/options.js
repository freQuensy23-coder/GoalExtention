"use strict";

const SETTINGS_KEY = "chatgptGoal.settings";
const DEFAULTS = {
  apiKey: "",
  apiEndpoint: "https://api.openai.com/v1/responses",
  model: "gpt-5-mini",
  maxIterations: 12,
};

const form = document.getElementById("settings-form");
const apiKey = document.getElementById("api-key");
const endpoint = document.getElementById("api-endpoint");
const model = document.getElementById("model");
const maxIterations = document.getElementById("max-iterations");
const status = document.getElementById("status");

async function load() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = { ...DEFAULTS, ...(stored[SETTINGS_KEY] || {}) };
  apiKey.value = settings.apiKey;
  endpoint.value = settings.apiEndpoint;
  model.value = settings.model;
  maxIterations.value = settings.maxIterations;
}

async function ensureEndpointPermission(urlString) {
  const url = new URL(urlString);
  if (url.origin === "https://api.openai.com") return true;
  if (url.protocol !== "https:") throw new Error("Only HTTPS evaluator endpoints are allowed.");
  return chrome.permissions.request({ origins: [`${url.origin}/*`] });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  status.textContent = "Saving…";
  try {
    const apiEndpoint = ChatgptGoalEvaluator.validateEndpoint(endpoint.value.trim());
    const granted = await ensureEndpointPermission(apiEndpoint);
    if (!granted) throw new Error("Host permission was not granted.");
    const settings = {
      apiKey: apiKey.value.trim(),
      apiEndpoint,
      model: model.value.trim(),
      maxIterations: Math.max(1, Math.min(100, Math.floor(Number(maxIterations.value)) || 12)),
    };
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    status.textContent = "Saved.";
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  }
});

load().catch((error) => { status.textContent = String(error); });
