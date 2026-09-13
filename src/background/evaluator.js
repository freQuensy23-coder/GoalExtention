(function (root, factory) {
  const api = factory(root.ChatgptGoalCore);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ChatgptGoalEvaluator = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Core) {
  "use strict";

  function buildJudgePrompt(objective, transcript, latestResponse) {
    const conversation = (transcript || [])
      .map((message) => `${message.role.toUpperCase()}: ${message.text}`)
      .join("\n\n");

    return [
      "You are a strict completion judge for an autonomous browser agent.",
      "Decide whether the user's original goal is fully completed by the work visible in the conversation.",
      "Be conservative: incomplete, promised, deferred, unverified, placeholder, mocked, or partially satisfied requirements mean complete=false.",
      "Do not require work that the goal did not ask for. Judge the actual outcome, not writing style.",
      "Return ONLY valid JSON with this exact shape:",
      '{"complete":boolean,"reason":string,"missing":string[],"confidence":number}',
      "confidence must be between 0 and 1.",
      `\nORIGINAL GOAL:\n${objective}`,
      `\nCONVERSATION SINCE/AROUND THE GOAL:\n${conversation}`,
      `\nLATEST ASSISTANT RESPONSE:\n${latestResponse}`,
    ].join("\n");
  }

  function extractText(payload) {
    if (!payload || typeof payload !== "object") return "";
    if (typeof payload.output_text === "string") return payload.output_text;
    if (payload.choices && payload.choices[0] && payload.choices[0].message) {
      const content = payload.choices[0].message.content;
      if (typeof content === "string") return content;
    }
    if (Array.isArray(payload.output)) {
      for (const item of payload.output) {
        if (!item || !Array.isArray(item.content)) continue;
        for (const part of item.content) {
          if (part && typeof part.text === "string") return part.text;
        }
      }
    }
    return "";
  }

  function parseJsonLoose(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) throw new Error("Evaluator returned an empty response.");
    try {
      return JSON.parse(trimmed);
    } catch (_) {
      const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fenced) return JSON.parse(fenced[1].trim());
      const objectMatch = trimmed.match(/\{[\s\S]*\}/);
      if (objectMatch) return JSON.parse(objectMatch[0]);
      throw new Error("Evaluator did not return valid JSON.");
    }
  }

  async function evaluateGoal({ fetchFn, settings, objective, transcript, latestResponse }) {
    if (!settings || !settings.apiKey) throw new Error("API key is not configured.");
    const endpoint = settings.apiEndpoint || "https://api.openai.com/v1/responses";
    const model = settings.model || "gpt-5-mini";
    const input = buildJudgePrompt(objective, transcript, latestResponse);
    const isChatCompletions = /\/chat\/completions\/?$/i.test(endpoint);

    const body = isChatCompletions
      ? {
          model,
          temperature: 0,
          messages: [{ role: "user", content: input }],
        }
      : {
          model,
          input,
          max_output_tokens: 500,
        };

    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new Error(`Evaluator API failed (${response.status}): ${bodyText.slice(0, 500)}`);
    }

    const payload = await response.json();
    const parsed = parseJsonLoose(extractText(payload));
    return Core.normalizeEvaluation(parsed);
  }

  return { buildJudgePrompt, extractText, parseJsonLoose, evaluateGoal };
});
