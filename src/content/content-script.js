(function () {
  "use strict";

  const Core = globalThis.ChatgptGoalCore;
  const Dom = globalThis.ChatgptGoalDom;
  const SETTLE_MS = 1600;
  let settleTimer = null;
  let evaluating = false;

  function runtimeMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(response || { ok: false, error: "No response from extension background." });
      });
    });
  }

  async function captureGoalFromComposer() {
    const parsed = Core.parseGoalCommand(Dom.getComposerText());
    if (!parsed) return false;
    await runtimeMessage({
      type: "CG_SET_GOAL",
      objective: parsed.objective,
      baselineFingerprint: Dom.latestAssistantFingerprint(),
      threadUrl: location.href,
    });
    return true;
  }

  function maybeCaptureGoalEvent(event) {
    const sendButton = event.target && event.target.closest && event.target.closest("button[data-testid='send-button']");
    const composer = Dom.getComposer();
    const enterSubmit =
      event.type === "keydown" &&
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.isComposing &&
      composer &&
      composer.contains(event.target);
    if (sendButton || enterSubmit) captureGoalFromComposer().catch(console.warn);
  }

  async function evaluateIfSettled() {
    if (evaluating || Dom.isGenerating()) return;
    const latestResponse = Dom.latestAssistantText();
    if (!latestResponse) return;

    const goalResult = await runtimeMessage({ type: "CG_GET_GOAL" });
    const goal = goalResult && goalResult.goal;
    if (!goal || goal.status !== "active") return;

    const fingerprint = Core.fingerprintText(latestResponse);
    if (fingerprint === goal.lastEvaluatedFingerprint) return;

    evaluating = true;
    try {
      const result = await runtimeMessage({
        type: "CG_EVALUATE",
        fingerprint,
        latestResponse,
        transcript: Dom.collectMessages(),
        threadUrl: location.href,
      });
      if (result && result.ok && result.shouldContinue && result.continuation) {
        await Dom.sendMessage(result.continuation);
      }
    } catch (error) {
      console.warn("[ChatgptGoal] evaluation loop failed", error);
    } finally {
      evaluating = false;
    }
  }

  function scheduleEvaluation() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => evaluateIfSettled().catch(console.warn), SETTLE_MS);
  }

  document.addEventListener("click", maybeCaptureGoalEvent, true);
  document.addEventListener("keydown", maybeCaptureGoalEvent, true);

  const observer = new MutationObserver(scheduleEvaluation);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  scheduleEvaluation();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return false;
    if (message.type === "CG_POPUP_STATUS") {
      runtimeMessage({ type: "CG_GET_GOAL" }).then(sendResponse);
      return true;
    }
    if (["CG_PAUSE_GOAL", "CG_RESUME_GOAL", "CG_CLEAR_GOAL"].includes(message.type)) {
      runtimeMessage({ type: message.type }).then((result) => {
        sendResponse(result);
        scheduleEvaluation();
      });
      return true;
    }
    return false;
  });
})();
