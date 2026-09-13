const test = require("node:test");
const assert = require("node:assert/strict");
require("../src/shared/goal-core.js");
const Evaluator = require("../src/background/evaluator.js");

test("parseJsonLoose accepts fenced JSON", () => {
  assert.deepEqual(Evaluator.parseJsonLoose('```json\n{"complete":true,"missing":[]}\n```'), {
    complete: true,
    missing: [],
  });
});

test("evaluateGoal calls Responses API and normalizes result", async () => {
  let request;
  const fetchFn = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      async json() {
        return { output_text: '{"complete":false,"reason":"Needs tests","missing":["tests"],"confidence":0.9}' };
      },
    };
  };

  const result = await Evaluator.evaluateGoal({
    fetchFn,
    settings: { apiKey: "secret", apiEndpoint: "https://api.openai.com/v1/responses", model: "judge" },
    objective: "finish",
    transcript: [{ role: "assistant", text: "almost" }],
    latestResponse: "almost",
  });

  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.options.headers.Authorization, "Bearer secret");
  assert.equal(JSON.parse(request.options.body).model, "judge");
  assert.equal(result.complete, false);
  assert.deepEqual(result.missing, ["tests"]);
});

test("evaluateGoal supports chat completions endpoint", async () => {
  const fetchFn = async (_url, options) => ({
    ok: true,
    async json() {
      const body = JSON.parse(options.body);
      assert.ok(Array.isArray(body.messages));
      return { choices: [{ message: { content: '{"complete":true,"reason":"ok","missing":[],"confidence":1}' } }] };
    },
  });
  const result = await Evaluator.evaluateGoal({
    fetchFn,
    settings: { apiKey: "x", apiEndpoint: "https://example.com/v1/chat/completions", model: "m" },
    objective: "finish",
    transcript: [],
    latestResponse: "done",
  });
  assert.equal(result.complete, true);
});
