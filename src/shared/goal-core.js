(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ChatgptGoalCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const GOAL_RE = /^\s*\/goal(?:\s+|\s*:\s*)([\s\S]+?)\s*$/i;

  function parseGoalCommand(text) {
    if (typeof text !== "string") return null;
    const match = text.match(GOAL_RE);
    if (!match) return null;
    const objective = match[1].trim();
    return objective ? { objective } : null;
  }

  function normalizeEvaluation(value) {
    const raw = value && typeof value === "object" ? value : {};
    const missing = Array.isArray(raw.missing)
      ? raw.missing.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 12)
      : [];
    const complete = raw.complete === true;
    return {
      complete,
      reason: typeof raw.reason === "string" ? raw.reason.trim().slice(0, 2000) : "",
      missing,
      confidence:
        typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
          ? Math.max(0, Math.min(1, raw.confidence))
          : null,
    };
  }

  function buildContinuationPrompt(evaluation) {
    const normalized = normalizeEvaluation(evaluation);
    const details = normalized.missing.length
      ? normalized.missing.map((item) => `- ${item}`).join("\n")
      : normalized.reason || "Проверь исходную цель целиком и заверши всё, что осталось.";

    return [
      "Твоя задача ещё не выполнена. Не пингуй меня, пока она не будет полностью готова.",
      "Продолжай работу над исходной целью самостоятельно и проверь результат перед завершением.",
      "Осталось выполнить:",
      details,
    ].join("\n\n");
  }

  function createGoalState(objective, baselineFingerprint = "", now = Date.now()) {
    return {
      objective: String(objective || "").trim(),
      status: "active",
      iteration: 0,
      createdAt: now,
      updatedAt: now,
      lastEvaluatedFingerprint: baselineFingerprint || "",
      lastEvaluation: null,
      lastError: null,
    };
  }

  function applyEvaluation(state, evaluation, maxIterations, fingerprint, now = Date.now()) {
    const next = { ...state };
    const normalized = normalizeEvaluation(evaluation);
    next.lastEvaluation = normalized;
    next.lastEvaluatedFingerprint = fingerprint || next.lastEvaluatedFingerprint || "";
    next.updatedAt = now;
    next.lastError = null;

    if (normalized.complete) {
      next.status = "complete";
      return { state: next, shouldContinue: false, continuation: null };
    }

    next.iteration = (Number(next.iteration) || 0) + 1;
    if (next.iteration >= Math.max(1, Number(maxIterations) || 1)) {
      next.status = "blocked";
      next.lastError = "Maximum continuation iterations reached.";
      return { state: next, shouldContinue: false, continuation: null };
    }

    next.status = "active";
    return {
      state: next,
      shouldContinue: true,
      continuation: buildContinuationPrompt(normalized),
    };
  }

  function fingerprintText(text) {
    const input = String(text || "");
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `${input.length}:${(hash >>> 0).toString(16)}`;
  }

  function truncateTranscript(messages, maxChars = 50000) {
    const normalized = (Array.isArray(messages) ? messages : [])
      .map((message) => ({
        role: message && message.role === "assistant" ? "assistant" : "user",
        text: String((message && message.text) || "").trim(),
      }))
      .filter((message) => message.text);

    const result = [];
    let used = 0;
    for (let i = normalized.length - 1; i >= 0; i -= 1) {
      const item = normalized[i];
      const cost = item.text.length + item.role.length + 8;
      if (result.length && used + cost > maxChars) break;
      result.unshift(item);
      used += cost;
    }
    return result;
  }

  return {
    parseGoalCommand,
    normalizeEvaluation,
    buildContinuationPrompt,
    createGoalState,
    applyEvaluation,
    fingerprintText,
    truncateTranscript,
  };
});
