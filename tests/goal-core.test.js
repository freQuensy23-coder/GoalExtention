const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/shared/goal-core.js');
const verdict = (overrides = {}) => ({ is_goal_done: false, short_explanation: 'Missing tests', ...overrides });
const turn = (index, role = 'assistant', text = 'result') => ({ index, role, text, id: `id-${index}`, complete: true, artifacts: [] });

test('goal command parsing has a boundary, supports multiline and colon, rejects empty', () => {
  assert.deepEqual(C.parseGoalCommand(' /GOAL: finish\nand test '), { objective: 'finish\nand test' });
  for (const value of ['/goal', '/goals xyz', 'hello /goal xyz', '/goalkeeper test']) assert.equal(C.parseGoalCommand(value), null);
});
test('thread identity ignores query parameters, accepts project routes, rejects foreign hosts and temporary pages', () => {
  assert.equal(C.threadKey('https://chatgpt.com/g/demo/c/abc?model=x'), 'chatgpt:abc');
  assert.equal(C.threadKey('https://chat.openai.com/c/abc/'), 'chatgpt:abc');
  for (const url of ['https://chatgpt.com/', 'https://chatgpt.com.evil.test/c/abc', 'https://example.org/c/abc', 'http://chatgpt.com/c/abc', 'garbage']) assert.equal(C.threadKey(url), null);
});
test('judge accepts exactly the two requested fields', () => {
  for (const bad of [{}, verdict({is_goal_done:'true'}), verdict({short_explanation:1}), verdict({confidence:1})]) assert.throws(() => C.normalizeEvaluation(bad));
  assert.deepEqual(C.normalizeEvaluation(verdict()), verdict());
});
test('done stops and not done continues regardless of iteration count', () => {
  const state = C.createGoalState('ship');
  assert.equal(C.applyEvaluation(state, verdict({is_goal_done:true}), 'done').state.status, 'complete');
  const result = C.applyEvaluation({...state, iteration:100}, verdict(), 'unfinished');
  assert.equal(result.shouldContinue, true);
  assert.equal(state.status, 'active');
});
test('continuations use the exact translated template with the original multiline goal', () => {
  const state = C.createGoalState('Implement the feature\nand verify the result.');
  const result = C.applyEvaluation(state, verdict(), 'a');
  const expected = [
    'You are working in a fully automated environment, and you must complete the task entirely on your own if the message was preceded by /goal.',
    'Your task:\nImplement the feature\nand verify the result.',
    'If you have any questions that should be discussed, then NO — you DO NOT HAVE THE RIGHT TO DISCUSS THEM and must choose the best solution on your own.',
    'If you reach a dead end, you must not spout nonsense about the task being impossible — instead, stop, think deeply about what you are doing wrong, and find a better path.',
    'Likewise, when there are problems with access, permissions, etc. — if you do not have access to a tool in automated mode, that means you do NOT need it to complete this task, and you should stop and plan the work better using other tools configured for this task.',
  ].join('\n\n');
  assert.equal(result.shouldContinue, true);
  assert.equal(result.continuation, expected);
  assert.equal(C.applyEvaluation(state, verdict({ short_explanation: 'Different feedback' }), 'b').continuation, expected);
});
test('fingerprints distinguish repeated text in different turns and image-only responses', () => {
  assert.notEqual(C.turnFingerprint(turn(2)), C.turnFingerprint(turn(4)));
  const a = { ...turn(2, 'assistant', ''), artifacts: [{ kind: 'image', name: 'a' }] };
  assert.notEqual(C.turnFingerprint(a), C.turnFingerprint({ ...a, artifacts: [{kind: 'image', name: 'b'}] }));
});
test('history preserves virtualized turns and strips unrelated pre-goal content', () => {
  const first = C.mergeHistory([], [turn(1), turn(2), turn(3), turn(4)], 3);
  const next = C.mergeHistory(first, [turn(4, 'assistant', 'updated'), turn(5)], 3);
  assert.deepEqual(next.map(t => t.index), [3, 4, 5]); assert.equal(next[1].text, 'updated');
  assert.equal(C.contextProblem(next, 3), null);
  assert.match(C.contextProblem([turn(3), turn(5)], 3), /missing/);
  assert.match(C.contextProblem([turn(3, 'user', 'x'.repeat(50001))], 3), /budget/);
});
test('normalization never upgrades unknown roles or artifact metadata into evidence', () => {
  assert.equal(C.normalizeTurn(turn(1, 'tool')), null);
  assert.deepEqual(C.normalizeTurn({...turn(1), artifacts: [{kind: 'image', name: 'test', data:'data:image/png;base64,AAAA'}]}).artifacts[0], {kind:'image', name:'test', data:'data:image/png;base64,AAAA'});
});
