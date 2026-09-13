(function (root, factory) {
  root.ChatgptGoalDom = factory(root.ChatgptGoalCore);
})(typeof globalThis !== "undefined" ? globalThis : this, function (Core) {
  "use strict";

  const SELECTORS = {
    composer: ["#prompt-textarea", "textarea[data-id='root']", "textarea"],
    sendButton: ["button[data-testid='send-button']", "button[aria-label*='Send']", "button[aria-label*='send']"],
    stopButton: ["button[data-testid='stop-button']", "button[aria-label*='Stop']", "button[aria-label*='stop']"],
    roleMessage: ["[data-message-author-role]"],
  };

  function first(selectors, scope = document) {
    for (const selector of selectors) {
      const element = scope.querySelector(selector);
      if (element) return element;
    }
    return null;
  }

  function getComposer() {
    return first(SELECTORS.composer);
  }

  function getComposerText() {
    const composer = getComposer();
    if (!composer) return "";
    if ("value" in composer && typeof composer.value === "string") return composer.value.trim();
    return (composer.innerText || composer.textContent || "").trim();
  }

  function setComposerText(text) {
    const composer = getComposer();
    if (!composer) throw new Error("ChatGPT composer was not found.");

    composer.focus();
    if ("value" in composer && typeof composer.value === "string") {
      const prototype = Object.getPrototypeOf(composer);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      if (descriptor && descriptor.set) descriptor.set.call(composer, text);
      else composer.value = text;
    } else {
      composer.textContent = text;
    }
    composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }

  function findSendButton() {
    return first(SELECTORS.sendButton);
  }

  function isGenerating() {
    return Boolean(first(SELECTORS.stopButton));
  }

  function collectMessages() {
    const direct = Array.from(document.querySelectorAll(SELECTORS.roleMessage[0]));
    if (direct.length) {
      return direct
        .map((node) => ({
          role: node.getAttribute("data-message-author-role") === "assistant" ? "assistant" : "user",
          text: (node.innerText || node.textContent || "").trim(),
        }))
        .filter((message) => message.text);
    }
    return [];
  }

  function latestAssistantText() {
    const messages = collectMessages();
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "assistant") return messages[i].text;
    }
    return "";
  }

  async function sendMessage(text) {
    setComposerText(text);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const button = findSendButton();
    if (!button || button.disabled) throw new Error("ChatGPT send button is unavailable.");
    button.click();
  }

  function latestAssistantFingerprint() {
    return Core.fingerprintText(latestAssistantText());
  }

  return {
    SELECTORS,
    getComposer,
    getComposerText,
    setComposerText,
    findSendButton,
    isGenerating,
    collectMessages,
    latestAssistantText,
    latestAssistantFingerprint,
    sendMessage,
  };
});
