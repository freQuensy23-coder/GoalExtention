'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, 'fixtures', 'capture-network');
const read = name => { const bytes = fs.readFileSync(path.join(ROOT, name)); return JSON.parse((name.endsWith('.gz') ? zlib.gunzipSync(bytes) : bytes).toString('utf8')); };

test('public capture contains all 27 source-bound DOM states', () => {
  const states = read('states.json.gz');
  assert.equal(states.length, 27);
  assert.deepEqual(states.map(x => x.index), Array.from({ length: 27 }, (_, i) => i + 1));
  for (const state of states) {
    assert.match(state.name, /^\d{2}-/);
    assert.match(state.source_sha256, /^[0-9a-f]{64}$/);
    assert.ok(!/https?:|[0-9a-f]{8}-[0-9a-f]{4}-/i.test(JSON.stringify(state)));
  }
});

test('endpoint corpus is normalized and proves captured conversation/file boundaries', () => {
  const rows = read('endpoints.json');
  const key = (method, p, status = 200) => rows.find(r => r.method === method && r.path === p && r.status === status);
  assert.ok(key('POST', '/backend-api/f/conversation'));
  assert.equal(key('POST', '/backend-api/f/conversation').mime_type, 'text/event-stream');
  assert.ok(key('POST', '/backend-api/f/conversation/prepare'));
  assert.ok(key('GET', '/backend-api/conversations/<conversation_id>'));
  assert.ok(key('POST', '/backend-api/files'));
  assert.ok(key('POST', '/backend-api/files/process_upload_stream'));
  for (const row of rows) {
    assert.equal(row.host, 'chatgpt.com');
    assert.ok(row.path.startsWith('/backend-api/'));
    assert.ok(!row.path.includes('?'));
  }
});

test('wire-shape corpus preserves field names but no captured scalar values', () => {
  const shapes = read('http-shapes.json');
  const request = shapes.request_shapes['POST /backend-api/f/conversation'];
  assert.equal(request.messages[0].content.parts[0], 'string');
  assert.equal(request.model, 'string');
  assert.equal(request.parent_message_id, 'string');
  const saved = shapes.response_shapes['GET /backend-api/conversations/<conversation_id>'];
  assert.equal(saved.messages[0].author.role, 'string');
  assert.equal(saved.messages[0].status, 'string');
  assert.equal(saved.current_node, 'string');
  const serialized = JSON.stringify(shapes);
  assert.doesNotMatch(serialized, /Bearer |https?:\/\/|file_[0-9a-f]{12,}|[0-9a-f]{8}-[0-9a-f]{4}-/i);
});

test('captured stream semantics prove close/DONE alone is not a universal completion signal', () => {
  const s = read('stream-semantics.json');
  assert.ok((s.message_type_counts.stream_handoff || 0) > 0);
  assert.ok((s.message_type_counts.message_stream_complete || 0) > 0);
  for (const op of ['add', 'append', 'patch']) assert.ok((s.delta_operation_counts[op] || 0) > 0);
  assert.ok((s.upload_processing_event_counts['file.processing.completed'] || 0) > 0);
});

test('captured WebSocket semantics include conversation continuation updates', () => {
  const ws = read('websocket-semantics.json');
  assert.ok(ws.cdp_event_counts['Network.webSocketFrameReceived'] > 0);
  assert.ok(ws.json_type_counts['conversation-update'] > 0);
  assert.ok(ws.conversation_update_type_counts['add-messages'] > 0);
  assert.equal(ws.conversation_update_shape.payload.conversation_id, 'string');
});

test('public corpus manifest is stable and matches only the six generated evidence files', () => {
  const manifest = read('manifest.json');
  assert.equal(manifest.length, 6);
  assert.ok(!manifest.some(entry => entry.path === 'manifest.json'));
  assert.deepEqual(manifest.map(entry => entry.path).sort(), [
    'endpoints.json', 'http-shapes.json', 'provenance.json', 'states.json.gz',
    'stream-semantics.json', 'websocket-semantics.json',
  ]);
  for (const entry of manifest) {
    const file = path.join(ROOT, entry.path);
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.length, entry.bytes);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.sha256);
  }
});


test('sanitized DOM corpus preserves captured structural edge cases without private text', () => {
  const domPath = path.resolve(__dirname, 'fixtures', 'capture-dom.json.gz');
  const fixtures = JSON.parse(zlib.gunzipSync(fs.readFileSync(domPath)));
  const formatted = fixtures[3].html;
  assert.equal((formatted.match(/<pre>/g) || []).length, 6);
  assert.equal((formatted.match(/<table>/g) || []).length, 2);
  assert.equal((formatted.match(/class="katex"/g) || []).length, 1);
  assert.match(fixtures[4].html, /aria-label="Remove file 1: demo-attachment-1\.png"/);
  assert.match(fixtures[11].html, /role="dialog"/);
  assert.match(fixtures[11].html, /<form data-type="unified-composer"><div id="prompt-textarea"/);
  assert.equal((fixtures[26].html.match(/group\/imagegen-image/g) || []).length, 2);
  const serialized = fixtures.map(x => x.html).join('\n');
  assert.doesNotMatch(serialized, /https?:\/\/|[0-9a-f]{8}-[0-9a-f]{4}-|file_[0-9a-f]{12,}|Bearer /i);
});
