"use strict";

const SETTINGS_KEY = "chatgptGoal.settings";
const DEFAULTS = ChatgptGoalEvaluator.DEFAULTS;

const form = document.getElementById("settings-form");
const apiKey = document.getElementById("api-key");
const endpoint = document.getElementById("api-endpoint");
const model = document.getElementById("model");
const historyMessages = document.getElementById("history-messages");
const status = document.getElementById("status");

async function load() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = { ...DEFAULTS, ...(stored[SETTINGS_KEY] || {}) };
  apiKey.value = settings.apiKey;
  endpoint.value = settings.apiEndpoint;
  model.value = settings.model;
  historyMessages.value = settings.historyMessages;
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
      historyMessages: Math.max(1, Math.min(100, Math.floor(Number(historyMessages.value)) || 20)),
    };
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    status.textContent = "Saved.";
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  }
});

load().catch((error) => { status.textContent = String(error); });

document.getElementById('test-connection').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  status.textContent = 'Testing with a synthetic example…';
  try {
    const settings = { apiKey: apiKey.value.trim(), model: model.value.trim(),
      apiEndpoint: ChatgptGoalEvaluator.validateEndpoint(endpoint.value.trim()) };
    if (!settings.apiKey) throw new Error('API key is not configured.');
    if (!await ensureEndpointPermission(settings.apiEndpoint)) throw new Error('Host permission was not granted.');
    const verdict = await ChatgptGoalEvaluator.evaluateGoal({ settings,
      objective: 'Describe the attached image as a red square.',
      transcript: [{ role: 'user', text: 'Describe this image.', artifacts: [{ kind: 'image', name: 'red-square.png', data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=' }] },
        { role: 'assistant', text: 'A red square.' }] });
    if (!verdict.is_goal_done) throw new Error('API responded, but the synthetic completion check did not pass.');
    status.textContent = 'Connection verified: valid completion verdict received. Click Save to keep these settings.';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally { button.disabled = false; }
});
