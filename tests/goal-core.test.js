const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../src/shared/goal-core.js");

test("parseGoalCommand extracts slash goal objective", () => {
  assert.deepEqual(Core.parseGoalCommand("/goal Build the feature completely"), {
    objective: "Build the feature completely",
  });
  assert.deepEqual(Core.parseGoalCommand(" /GOAL: verify tests "), { objective: "verify tests" });
  assert.equal(Core.parseGoalCommand("hello /goal nope"), null);
  assert.equal(Core.parseGoalCommand("/goal"), null);
});

test("applyEvaluation completes a goal", () => {
  const state = Core.createGoalState("ship", "old", 1);
  const outcome = Core.applyEvaluation(state, { complete: true, reason: "done" }, 5, "new", 2);
  assert.equal(outcome.shouldContinue, false);
  assert.equal(outcome.state.status, "complete");
  assert.equal(outcome.state.lastEvaluatedFingerprint, "new");
});

test("applyEvaluation creates continuation and enforces iteration cap", () => {
  let state = Core.createGoalState("ship", "", 1);
  let outcome = Core.applyEvaluation(
    state,
    { complete: false, reason: "missing tests", missing: ["Run unit tests"] },
    2,
    "a",
    2,
  );
  assert.equal(outcome.shouldContinue, true);
  assert.match(outcome.continuation, /Run unit tests/);
  state = outcome.state;
  outcome = Core.applyEvaluation(state, { complete: false, missing: ["Still failing"] }, 2, "b", 3);
  assert.equal(outcome.shouldContinue, false);
  assert.equal(outcome.state.status, "blocked");
});

test("truncateTranscript keeps newest messages within budget", () => {
  const result = Core.truncateTranscript(
    [
      { role: "user", text: "a".repeat(20) },
      { role: "assistant", text: "b".repeat(20) },
      { role: "user", text: "latest" },
    ],
    45,
  );
  assert.equal(result.at(-1).text, "latest");
  assert.ok(result.length < 3);
});

test("fingerprintText is deterministic and content-sensitive", () => {
  assert.equal(Core.fingerprintText("abc"), Core.fingerprintText("abc"));
  assert.notEqual(Core.fingerprintText("abc"), Core.fingerprintText("abd"));
});
