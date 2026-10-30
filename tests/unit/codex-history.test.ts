import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_HISTORY_MAX_PAGES, HISTORY_GAP_MARKER, NATIVE_HISTORY_LIMITS, codexThreadHistoryMode, codexTurnsPageProgress,
  parseCodexPaginatedHistory, parseCodexThreadRead, planNativeHistoryCapabilities, redactNativeHistoryText,
} from '../../packages/codex-client/src/history.js';
import type { CodexHistoryScope } from '../../packages/codex-client/src/history.js';
import {readStudioStagingDiagnostic} from '../../packages/asset-pipeline/src/failure-diagnostics.js';

// Synthetic fixtures follow the installed public v2 schema; no native files or CLI.
const THREAD = '0199fa23-7777-7000-8000-000000000001';
const SESSION = '0199fa23-7777-7000-8000-000000000002';
const TURN = '0199fa23-7777-7000-8000-000000000003';
const CWD = 'C:\\work\\arcane';
const SCOPE: CodexHistoryScope = { threadId: THREAD, sessionId: SESSION, cwd: CWD, includeTurns: true };
const user = (id = 'user-1', text = 'Inspect the selected object.') => ({
  type: 'userMessage', id, clientId: null, content: [{ type: 'text', text, text_elements: [] }],
});
const assistant = (id = 'agent-1', text = 'The object has twelve faces.') => ({
  type: 'agentMessage', id, text, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null,
});
const turn = (items: unknown[], id = TURN, overrides: Record<string, unknown> = {}) => ({
  id, rootTurnId: null, items, itemsView: 'full', status: 'completed', error: null,
  startedAt: 1760200000, completedAt: 1760200001, durationMs: 1000, ...overrides,
});
const read = (turns: unknown[] = [turn([user(), assistant()])], overrides: Record<string, unknown> = {}) => ({
  thread: {
    id: THREAD, sessionId: SESSION, forkedFromId: null, parentThreadId: null,
    preview: 'Inspect the selected object.', ephemeral: false, section: null, sectionEnteredAt: null,
    projectId: null, historyMode: 'legacy', modelProvider: 'openai', model: 'fixture-model', reasoningEffort: null,
    createdAt: 1760200000, updatedAt: 1760200001, recencyAt: null, status: { type: 'notLoaded' },
    path: null, cwd: CWD, cliVersion: 'schema-fixture', originator: 'arcane-fixture', source: 'appServer',
    threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: 'Geometry check',
    turns, ...overrides,
  },
});
const reasons = (result: ReturnType<typeof parseCodexThreadRead>) => result.gaps.map(gap => gap.reason);

test('public legacy thread/read projects roles and exact native IDs, retaining session-tree distinction', () => {
  const result = parseCodexThreadRead(read(), SCOPE);
  assert.equal(result.completeness, 'complete');
  assert.equal(result.marker, null);
  assert.deepEqual(result.entries, [
    { role: 'user', text: 'Inspect the selected object.', ids: { threadId: THREAD, sessionId: SESSION, turnId: TURN, itemId: 'user-1' } },
    { role: 'assistant', text: 'The object has twelve faces.', ids: { threadId: THREAD, sessionId: SESSION, turnId: TURN, itemId: 'agent-1' } },
  ]);
  assert.notEqual(result.entries[0]?.ids.threadId, result.entries[0]?.ids.sessionId);
});

test('unwrapped, JSON-RPC and wire JSON results agree without mutating input', () => {
  const fixture = read();
  const original = JSON.stringify(fixture);
  const expected = parseCodexThreadRead(fixture, SCOPE);
  assert.deepEqual(parseCodexThreadRead({ jsonrpc: '2.0', id: 19, result: fixture }, SCOPE), expected);
  assert.deepEqual(parseCodexThreadRead(JSON.stringify({ id: 19, result: fixture }), SCOPE), expected);
  assert.equal(JSON.stringify(fixture), original);
  expected.entries[0]!.text = 'caller mutation';
  assert.equal(parseCodexThreadRead(fixture, SCOPE).entries[0]?.text, 'Inspect the selected object.');
});

test('older legacy schemas may omit historyMode, itemsView and sessionId, but never synthesize IDs', () => {
  const result = parseCodexThreadRead(read([turn([assistant()], TURN, { itemsView: undefined })], {
    historyMode: undefined, sessionId: undefined,
  }), { threadId: THREAD, cwd: CWD, includeTurns: true });
  assert.equal(result.completeness, 'complete');
  assert.equal(result.entries[0]?.ids.sessionId, null);
});

test('thread, workspace and optional session mismatch reject before reading content', () => {
  for (const overrides of [{ id: 'other-thread' }, { cwd: 'C:\\work\\other' }, { sessionId: 'other-session' }]) {
    const fixture = read([], overrides);
    Object.defineProperty(fixture.thread, 'turns', { get() { assert.fail('scope mismatch accessed content'); } });
    const result = parseCodexThreadRead(fixture, SCOPE);
    assert.equal(result.completeness, 'rejected');
    assert.deepEqual(reasons(result), ['scope-mismatch']);
    assert.deepEqual(result.entries, []);
  }
  assert.deepEqual(reasons(parseCodexThreadRead(read(), { ...SCOPE, cwd: CWD.toLowerCase() })), ['scope-mismatch']);
});

test('unknown storage modes fail closed before inspecting turns', () => {
  for (const mode of ['future-mode', null, {}]) {
    const fixture = read([], { historyMode: mode });
    Object.defineProperty(fixture.thread, 'turns', { get() { assert.fail('unsupported mode accessed content'); } });
    const result = parseCodexThreadRead(fixture, SCOPE);
    assert.equal(result.completeness, 'rejected');
    assert.deepEqual(reasons(result), ['unsupported-history-mode']);
  }
});

test('hydrated paginated thread/read preserves exact public IDs and redacts text using the existing bounds', () => {
  const result = parseCodexThreadRead(read([turn([user(), assistant('answer', 'Public answer. password=fixtureSecret')])], { historyMode: 'paginated' }), SCOPE);
  assert.equal(result.completeness, 'complete'); assert.equal(result.marker, null);
  assert.deepEqual(result.entries.map(entry => entry.role), ['user', 'assistant']);
  assert.deepEqual(result.entries[1]!.ids, { threadId: THREAD, sessionId: SESSION, turnId: TURN, itemId: 'answer' });
  assert.equal(result.entries[1]!.text, 'Public answer. password=[REDACTED]'); assert.equal(result.redacted, true);
  const bounded = parseCodexThreadRead(read([turn([user(), assistant()])], { historyMode: 'paginated' }), SCOPE, { maxItems: 1 });
  assert.equal(bounded.entries.length, 1); assert.equal(bounded.completeness, 'incomplete'); assert.ok(reasons(bounded).includes('item-limit'));
});

test('each paginated turn requires full items before visiting content and summary responses retain a gap marker', () => {
  const summary = turn([], TURN + '-summary', { itemsView: 'summary' });
  const unloaded = turn([], TURN + '-unloaded', { itemsView: undefined });
  for (const omitted of [summary, unloaded]) Object.defineProperty(omitted, 'items', { get() { assert.fail('summary content was accessed'); } });
  const result = parseCodexThreadRead(read([turn([assistant()]), summary, unloaded], { historyMode: 'paginated' }), SCOPE);
  assert.equal(result.completeness, 'incomplete'); assert.equal(result.marker, HISTORY_GAP_MARKER);
  assert.equal(result.entries.length, 1); assert.deepEqual(reasons(result), ['items-not-full', 'items-not-full']);
  for (const fixture of [read([], { historyMode: 'paginated' }), read([], { historyMode: 'paginated', turns: undefined })]) {
    const empty = parseCodexThreadRead(fixture, SCOPE);
    assert.equal(empty.completeness, 'incomplete'); assert.deepEqual(empty.entries, []); assert.equal(empty.marker, HISTORY_GAP_MARKER);
  }
  const page = { ...read([turn([assistant()])], { historyMode: 'paginated' }), nextCursor: 'older' };
  assert.equal(parseCodexThreadRead(page, SCOPE).completeness, 'rejected');
});

test('ephemeral threads, missing hydration and summaries cannot report complete history', () => {
  assert.deepEqual(reasons(parseCodexThreadRead(read([], { ephemeral: true }), SCOPE)), ['ephemeral-thread']);
  const summary = parseCodexThreadRead(read([]), { ...SCOPE, includeTurns: false });
  assert.equal(summary.completeness, 'incomplete');
  assert.deepEqual(reasons(summary), ['turns-not-requested']);
  assert.deepEqual(reasons(parseCodexThreadRead(read([], { turns: undefined }), SCOPE)), ['missing-turns']);
  assert.equal(parseCodexThreadRead(read([]), SCOPE).completeness, 'complete');
});

test('turn pages, notifications and raw Responses-like messages are not thread/read responses', () => {
  for (const fixture of [
    { data: [turn([assistant()])], nextCursor: null, backwardsCursor: null },
    { ...read(), nextCursor: 'older' },
    { method: 'item/agentMessage/delta', params: { threadId: THREAD, turnId: TURN, itemId: 'agent-1', delta: 'fragment' } },
    { method: 'item/completed', params: { threadId: THREAD, turnId: TURN, item: assistant() }, ...read() },
    { role: 'assistant', content: [{ type: 'output_text', text: 'Unrecognized raw payload.' }] },
  ]) {
    const result = parseCodexThreadRead(fixture, SCOPE);
    assert.equal(result.completeness, 'rejected');
    assert.deepEqual(result.entries, []);
  }
});

test('JSON-RPC error content is never extracted or included in diagnostics', () => {
  const result = parseCodexThreadRead({ id: 19, error: { code: -32601, message: 'SYNTHETIC_PRIVATE_ERROR', data: read() } }, SCOPE);
  assert.deepEqual(reasons(result), ['rpc-error']);
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_ERROR'));
});

test('only explicit public command/MCP/dynamic/function text output becomes tool entries', () => {
  const items = [
    { type: 'commandExecution', id: 'cmd-1', command: 'PRIVATE_COMMAND', cwd: CWD, processId: null,
      source: 'agent', status: 'completed', commandActions: [], aggregatedOutput: '12 faces', exitCode: 0, durationMs: 3 },
    { type: 'mcpToolCall', id: 'mcp-1', server: 'arcane', tool: 'inspect', status: 'completed', arguments: { raw: 'PRIVATE_ARGUMENT' },
      result: { content: [{ type: 'text', text: 'Selected Cube' }], structuredContent: { raw: 'PRIVATE_STRUCTURED' }, _meta: { raw: 'PRIVATE_META' } } },
    { type: 'dynamicToolCall', id: 'dynamic-1', namespace: null, tool: 'inspect', status: 'completed',
      arguments: { raw: 'PRIVATE_ARGUMENT' }, contentItems: [{ type: 'inputText', text: 'Mesh valid' }], success: true },
    { type: 'functionCallOutput', id: 'function-1', name: 'inspect', namespace: null,
      output: [{ type: 'input_text', text: 'No errors' }] },
    { type: 'functionCallOutput', id: 'function-2', name: 'inspect', namespace: null, output: 'String output' },
  ];
  const result = parseCodexThreadRead(read([turn(items)]), SCOPE);
  assert.equal(result.completeness, 'complete');
  assert.deepEqual(result.entries.map(entry => [entry.role, entry.text]), [
    ['tool', '12 faces'], ['tool', 'Selected Cube'], ['tool', 'Mesh valid'], ['tool', 'No errors'], ['tool', 'String output'],
  ]);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
});

test('reasoning, plans and private nested fields are never read, stringified or traversed', () => {
  const hidden = () => { assert.fail('private content was accessed'); };
  const reasoning = { type: 'reasoning', id: 'reasoning-1' };
  Object.defineProperties(reasoning, { summary: { get: hidden }, content: { get: hidden }, toJSON: { get: hidden } });
  const tool = { type: 'mcpToolCall', id: 'mcp-1', result: { content: [{ type: 'text', text: 'Safe public output' }] } };
  Object.defineProperties(tool, { arguments: { get: hidden }, raw: { get: hidden } });
  Object.defineProperties(tool.result, { structuredContent: { get: hidden }, _meta: { get: hidden } });
  const fixture = read([turn([reasoning, { type: 'plan', id: 'plan-1', text: 'PRIVATE_PLAN' }, tool, assistant()])]);
  Object.defineProperties(fixture.thread, { path: { get: hidden }, auth: { get: hidden }, rollout: { get: hidden } });
  const result = parseCodexThreadRead(fixture, SCOPE);
  assert.equal(result.excludedItems, 2);
  assert.equal(result.completeness, 'complete');
  assert.deepEqual(result.entries.map(entry => entry.role), ['tool', 'assistant']);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_PLAN'));
});

test('unknown/raw item kinds and content blocks expose gaps, with no generic recursive text fallback', () => {
  const hidden = () => { assert.fail('unknown text accessed'); };
  const unknown = { type: 'message', id: 'raw-1', role: 'assistant' };
  Object.defineProperty(unknown, 'content', { get: hidden });
  const userItem = user();
  userItem.content.push({ type: 'thinking', text: 'PRIVATE_THINKING', text_elements: [] });
  const result = parseCodexThreadRead(read([turn([unknown, userItem, assistant()])]), SCOPE);
  assert.equal(result.completeness, 'incomplete');
  assert.deepEqual(reasons(result), ['unsupported-item', 'non-text-content']);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_THINKING'));
});

test('multimodal, encrypted and missing text are explicit omissions rather than private extraction', () => {
  const result = parseCodexThreadRead(read([turn([
    { type: 'userMessage', id: 'user-image', content: [{ type: 'image', url: 'PRIVATE_IMAGE' }] },
    { type: 'functionCallOutput', id: 'encrypted', output: [{ type: 'encrypted_content', encrypted_content: 'PRIVATE_ENCRYPTED' }] },
    { type: 'agentMessage', id: 'missing-text', content: 'PRIVATE_FALLBACK' },
  ])]), SCOPE);
  assert.equal(result.completeness, 'incomplete');
  assert.deepEqual(reasons(result), ['non-text-content', 'non-text-content', 'malformed-item']);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
});

test('credential patterns are redacted in every public role', () => {
  const secrets = [
    'sk-proj-syntheticKey123456789', 'sk-ant-syntheticKey123456789', 'ghp_synthetic123456789',
    'Bearer synthetic-bearer', 'Basic c3ludGhldGlj', 'OPENAI_API_KEY="synthetic quoted secret"',
    'access_token=synthetic-query', 'password: synthetic-password', 'ARCANE_LOCAL_TOKEN=' + 'a'.repeat(64),
    'ARCANE_LOCAL_TOKEN=synthetic-local-token', 'token="synthetic-generic-token"',
    'https://synthetic-user:synthetic-pass@example.test', 'eyJsynthetic.payload.signature',
    '-----BEGIN PRIVATE KEY-----\nSYNTHETIC_KEY\n-----END PRIVATE KEY-----',
  ];
  const text = 'Public geometry result\n' + secrets.join('\n');
  const result = parseCodexThreadRead(read([turn([
    user('user-secret', text), assistant('assistant-secret', text),
    { type: 'commandExecution', id: 'tool-secret', aggregatedOutput: text },
  ])]), SCOPE);
  assert.equal(result.completeness, 'complete');
  assert.equal(result.redacted, true);
  assert.equal(result.entries.length, 3);
  for (const entry of result.entries) {
    assert.ok(entry.text.includes('Public geometry result'));
    for (const secret of secrets) assert.ok(!entry.text.includes(secret), secret);
    for (const fragment of ['synthetic quoted secret', 'synthetic-query', 'synthetic-password', 'synthetic-pass', 'synthetic-local-token', 'synthetic-generic-token', 'SYNTHETIC_KEY']) {
      assert.ok(!entry.text.includes(fragment), fragment);
    }
  }
  assert.ok(redactNativeHistoryText('ordinary output') === 'ordinary output');
});

test('redaction covers assignments spanning public text blocks and incomplete private keys', () => {
  const result = parseCodexThreadRead(read([turn([{ type: 'userMessage', id: 'user-1', content: [
    { type: 'text', text: 'API_KEY=', text_elements: [] },
    { type: 'text', text: '"SYNTHETIC_SPLIT_SECRET"', text_elements: [] },
  ] }])]), SCOPE);
  assert.ok(!result.entries[0]?.text.includes('SYNTHETIC_SPLIT_SECRET'));
  assert.equal(redactNativeHistoryText('-----BEGIN RSA PRIVATE KEY-----\nSYNTHETIC_UNFINISHED'), '[REDACTED]');
});

test('identical items deduplicate by scoped native IDs; equal text with different IDs remains', () => {
  const result = parseCodexThreadRead(read([turn([
    assistant('same', 'Repeated text'), assistant('same', 'Repeated text'), assistant('different', 'Repeated text'),
  ]), turn([assistant('same', 'Repeated text')], 'turn-other')]), SCOPE);
  assert.equal(result.completeness, 'complete');
  assert.equal(result.entries.length, 3);
  assert.deepEqual(result.entries.map(entry => [entry.ids.turnId, entry.ids.itemId]), [[TURN, 'same'], [TURN, 'different'], ['turn-other', 'same']]);
});

test('conflicting items and duplicate turn snapshots cannot silently claim completeness', () => {
  const result = parseCodexThreadRead(read([
    turn([assistant('same', 'partial'), assistant('same', 'final'), assistant('same', 'final'), user()]),
    turn([assistant('different', 'Other snapshot')]),
  ]), SCOPE);
  assert.deepEqual(reasons(result), ['conflicting-item', 'duplicate-turn']);
  assert.equal(result.completeness, 'incomplete');
  assert.deepEqual(result.entries.map(entry => entry.ids.itemId), ['user-1']);
});

test('deltas never append to a complete item snapshot or masquerade as final text', () => {
  const result = parseCodexThreadRead(read([turn([
    { type: 'agentMessageDelta', id: 'delta-1', delta: 'duplicate fragment' }, assistant('agent-1', 'Final snapshot'),
  ])]), SCOPE);
  assert.deepEqual(reasons(result), ['unsupported-item']);
  assert.deepEqual(result.entries.map(entry => entry.text), ['Final snapshot']);
});

test('compaction, unhydrated turns and interrupted work retain gap evidence and a marker', () => {
  const result = parseCodexThreadRead(read([
    turn([{ type: 'contextCompaction', id: 'compact-1' }, assistant()]),
    turn([assistant('summary', 'PRIVATE_SUMMARY')], 'turn-summary', { itemsView: 'summary' }),
    turn([assistant('partial', 'Partial public response')], 'turn-active', { status: 'inProgress' }),
    turn([], 'turn-failed', { status: 'interrupted', error: { message: 'PRIVATE_ERROR' } }),
  ]), SCOPE);
  assert.deepEqual(reasons(result), ['context-compaction', 'items-not-full', 'unfinished-turn', 'failed-turn']);
  assert.equal(result.marker, HISTORY_GAP_MARKER);
  assert.equal(result.truncated, false);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
});

test('64-turn and 256-item caps preserve prefixes and report truncation', () => {
  const turnResult = parseCodexThreadRead(read(Array.from({ length: 65 }, (_, index) => turn([assistant()], 'turn-' + index))), SCOPE);
  assert.equal(turnResult.entries.length, 64);
  assert.ok(reasons(turnResult).includes('turn-limit'));
  assert.equal(turnResult.truncated, true);
  const itemResult = parseCodexThreadRead(read([turn(Array.from({ length: 257 }, (_, index) => assistant('item-' + index)))]), SCOPE);
  assert.equal(itemResult.entries.length, 256);
  assert.deepEqual(reasons(itemResult), ['item-limit']);
  assert.equal(itemResult.marker, HISTORY_GAP_MARKER);
});

test('wire inputs enforce 2 MiB UTF-8 before parse; object projections account for JSON escapes and IDs', () => {
  const oversized = JSON.stringify(read([turn([assistant('large', 'é'.repeat(NATIVE_HISTORY_LIMITS.maxBytes / 2))])]));
  assert.deepEqual(reasons(parseCodexThreadRead(oversized, SCOPE)), ['byte-limit']);
  const huge = parseCodexThreadRead(read([turn([assistant('large', 'x'.repeat(NATIVE_HISTORY_LIMITS.maxBytes + 1))])]), SCOPE);
  assert.equal(huge.truncated, true);
  assert.deepEqual(huge.entries, []);
  const escaped = parseCodexThreadRead(read([turn([assistant('first', 'ok'), assistant('large', '\u0001'.repeat(400))])]), SCOPE, { maxBytes: 1024 });
  assert.equal(escaped.truncated, true);
  assert.equal(escaped.entries[0]?.text, 'ok');
  assert.ok(Buffer.byteLength(JSON.stringify(escaped)) <= 1024);
  const result = parseCodexThreadRead(read([turn([assistant('large', 'x'.repeat(NATIVE_HISTORY_LIMITS.maxBytes - 64))])]), SCOPE);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= NATIVE_HISTORY_LIMITS.maxBytes);
});

test('caps can only be reduced; malformed envelopes and selected accessors fail without extracting errors', () => {
  for (const options of [{ maxTurns: 65 }, { maxItems: 257 }, { maxBytes: 512 }, { maxItems: 0 }, { unknown: 1 }]) {
    assert.equal(parseCodexThreadRead(read(), SCOPE, options).completeness, 'rejected');
  }
  for (const fixture of [null, [], 12, '{bad json', new Date(), { id: null, result: read() }, { thread: null }, { thread: [] }]) {
    assert.doesNotThrow(() => {
      assert.equal(parseCodexThreadRead(fixture, SCOPE).completeness, 'rejected');
    });
  }
  const malformed = read();
  Object.defineProperty(malformed.thread, 'id', { get() { assert.fail('selected getter invoked'); } });
  assert.equal(parseCodexThreadRead(malformed, SCOPE).completeness, 'rejected');
});

test('malformed items or turns do not erase later valid public entries', () => {
  const fixture = read([null, turn([null, { type: 'agentMessage', id: [], text: 'PRIVATE_BAD' }, assistant()])]);
  const result = parseCodexThreadRead(fixture, SCOPE);
  assert.deepEqual(reasons(result), ['malformed-turn', 'malformed-item', 'malformed-item']);
  assert.deepEqual(result.entries.map(entry => entry.text), ['The object has twelve faces.']);
});

test('array element accessors and custom iterators are not invoked', () => {
  const items: unknown[] = [null, assistant()];
  const turns: unknown[] = [null, turn(items)];
  const hidden = () => { assert.fail('array accessor or iterator invoked'); };
  for (const array of [items, turns]) {
    Object.defineProperty(array, '0', { get: hidden });
    Object.defineProperty(array, Symbol.iterator, { get: hidden });
  }
  const result = parseCodexThreadRead(read(turns), SCOPE);
  assert.deepEqual(reasons(result), ['malformed-turn', 'malformed-item']);
  assert.deepEqual(result.entries.map(entry => entry.text), ['The object has twelve faces.']);
});

test('unknown assistant phases reject text instead of exposing analysis', () => {
  const hidden = () => { assert.fail('analysis text accessed'); };
  const analysis = { type: 'agentMessage', id: 'analysis-1', phase: 'analysis' };
  Object.defineProperty(analysis, 'text', { get: hidden });
  const result = parseCodexThreadRead(read([turn([analysis, assistant()])]), SCOPE);
  assert.deepEqual(reasons(result), ['malformed-item']);
  assert.deepEqual(result.entries.map(entry => entry.text), ['The object has twelve faces.']);
});

test('bounded diagnostic overflow preserves dropped-gap counts and truncation evidence', () => {
  const blocks = Array.from({ length: 256 }, () => ({ type: 'image', url: 'PRIVATE_IMAGE' }));
  const result = parseCodexThreadRead(read([turn([
    { type: 'userMessage', id: 'image-1', content: blocks },
    { type: 'userMessage', id: 'image-2', content: blocks },
  ])]), SCOPE, { maxBytes: 1024 });
  assert.equal(result.completeness, 'incomplete');
  assert.equal(result.truncated, true);
  assert.ok(result.droppedGaps > 0);
  assert.equal(result.marker, HISTORY_GAP_MARKER);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1024);
});

test('persistent Codex plan describes public API support and exact IDs, without claiming desktop or runtime proof', () => {
  const plan = planNativeHistoryCapabilities({ provider: 'codex', cwd: CWD, nativeId: THREAD });
  assert.equal(plan.status, 'planned');
  assert.equal(plan.wiring, 'not-wired');
  assert.equal(plan.runtimeVerified, false);
  assert.deepEqual(plan.desktopVisibility, { status: 'unverified', requires: 'real-desktop-test' });
  assert.deepEqual(plan.requests.find(request => request.method === 'thread/start')?.params, { cwd: CWD, ephemeral: false });
  assert.deepEqual(plan.requests.find(request => request.method === 'thread/resume')?.params, { threadId: THREAD, cwd: CWD });
  assert.deepEqual(plan.requests.find(request => request.method === 'thread/read')?.params, { threadId: THREAD, includeTurns: true });
  assert.deepEqual(plan.requests.find(request => request.method === 'thread/list')?.params.sourceKinds, ['cli', 'vscode', 'appServer', 'exec']);
  assert.ok(!JSON.stringify(plan.requests).includes('fork'));
  // Documented paged history is supported, but legacy threads keep the hydrated read and plan no pages.
  assert.equal(plan.nativeApis.find(api => api.api === 'thread/turns/list')?.support, 'supported');
  assert.equal(plan.nativeApis.find(api => api.api === 'thread/turns/list')?.availableInPlan, false);
  assert.ok(!plan.requests.some(request => request.method === 'thread/turns/list'));
});

test('legacy plans never page, with or without experimental evidence', () => {
  for (const evidence of [{}, { experimentalApi: true }, { turnPaginationSchemaAvailable: true }, { experimentalApi: true, turnPaginationSchemaAvailable: true }]) {
    assert.ok(!planNativeHistoryCapabilities({ provider: 'codex', cwd: CWD, nativeId: THREAD, ...evidence }).requests.some(request => request.method === 'thread/turns/list'));
  }
});

test('paginated storage plans a metadata read then documented ascending full pages without experimental negotiation', () => {
  for (const evidence of [{}, { experimentalApi: false }, { experimentalApi: true, turnPaginationSchemaAvailable: true }]) {
    const plan = planNativeHistoryCapabilities({ provider: 'codex', cwd: CWD, nativeId: THREAD, historyMode: 'paginated', ...evidence });
    assert.equal(plan.status, 'unsupported', 'paginated thread creation/resume still fail closed');
    assert.deepEqual(plan.requests.map(request => request.method), ['thread/list', 'thread/read', 'thread/turns/list']);
    assert.deepEqual(plan.requests[1]?.params, { threadId: THREAD, includeTurns: false });
    assert.deepEqual(plan.requests[2]?.params, { threadId: THREAD, limit: 32, sortDirection: 'asc', itemsView: 'full' });
    assert.equal(plan.nativeApis.find(api => api.api === 'thread/turns/list')?.availableInPlan, true);
    assert.equal(plan.nativeId, THREAD); assert.equal(plan.runtimeVerified, false);
  }
  const unidentified = planNativeHistoryCapabilities({ provider: 'codex', cwd: CWD, historyMode: 'paginated' });
  assert.ok(!unidentified.requests.some(request => request.method === 'thread/turns/list' || request.method === 'thread/read'));
});

test('Claude Code plan uses documented UUID session/resume and stream-json flags, with web/design sync unverified', () => {
  const plan = planNativeHistoryCapabilities({ provider: 'claude-code', cwd: CWD, nativeId: SESSION });
  assert.equal(plan.status, 'planned');
  assert.deepEqual(plan.requests, []);
  assert.deepEqual(plan.cli?.startArgs, ['--session-id', SESSION, '--print', '--output-format', 'stream-json', '--verbose']);
  assert.deepEqual(plan.cli?.resumeArgs, ['--resume', SESSION, '--print', '--output-format', 'stream-json', '--verbose']);
  assert.equal(plan.nativeApis.find(api => api.api === 'claude.ai / Claude Design sync')?.support, 'unverified');
  assert.ok(!JSON.stringify(plan.cli).includes('--fork-session'));
  assert.deepEqual(plan.desktopVisibility, { status: 'unverified', requires: 'real-desktop-test' });
});

test('planners never mint native IDs, accept transcript paths or return plans for invalid inputs', () => {
  for (const provider of ['codex', 'claude-code'] as const) {
    const plan = planNativeHistoryCapabilities({ provider, cwd: CWD });
    assert.equal(plan.nativeId, null);
    assert.ok(!plan.requests.some(request => request.method === 'thread/resume'));
    if (provider === 'claude-code') assert.deepEqual(plan.cli, { startArgs: null, resumeArgs: null });
  }
  for (const input of [
    { provider: 'claude-code', cwd: CWD, nativeId: 'session-name' },
    { provider: 'codex', cwd: CWD, nativeId: 'C:\\private\\transcript.jsonl' },
    { provider: 'codex', cwd: 'relative' },
    { provider: 'codex', cwd: CWD, historyMode: 'future' },
    { provider: 'codex', cwd: CWD, historyMode: null },
    { provider: 'codex', cwd: CWD, experimentalApi: 'yes' },
    { provider: 'codex', cwd: CWD, token: 'PRIVATE_TOKEN' },
    { provider: 'claude-code', cwd: CWD, experimentalApi: true },
  ]) {
    const plan = planNativeHistoryCapabilities(input as never);
    assert.equal(plan.status, 'invalid');
    assert.deepEqual(plan.requests, []);
    assert.equal(plan.cli, null);
    assert.ok(!JSON.stringify(plan).includes('PRIVATE_TOKEN'));
  }
});


test('hydrated paginated thread/read projects exact public IDs only with explicit full turn items', () => {
  const result = parseCodexThreadRead(read([turn([user(), {type:'reasoning',id:'private-reasoning',summary:['PRIVATE_REASONING']}, assistant()])], {historyMode:'paginated'}), SCOPE);
  assert.equal(result.completeness, 'complete');
  assert.equal(result.entries.length, 2);
  assert.equal(result.excludedItems, 1);
  assert.equal(result.entries[0]?.ids.threadId, THREAD);
  assert.equal(result.entries[0]?.ids.sessionId, SESSION);
  assert.equal(result.entries[0]?.ids.turnId, TURN);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_REASONING'));
});

test('paginated summaries, missing view and empty histories retain honest hydration gaps', () => {
  for (const itemsView of ['summary', 'notLoaded', undefined]) {
    const result = parseCodexThreadRead(read([turn([assistant('a','NOT_HYDRATED')], TURN, {itemsView})], {historyMode:'paginated'}), SCOPE);
    assert.equal(result.completeness, 'incomplete');
    assert.deepEqual(reasons(result), ['items-not-full']);
    assert.equal(result.entries.length,0);
    assert.ok(!JSON.stringify(result).includes('NOT_HYDRATED'));
  }
  const empty = parseCodexThreadRead(read([], {historyMode:'paginated'}), SCOPE);
  assert.equal(empty.completeness, 'incomplete');
  assert.deepEqual(reasons(empty), ['missing-turns']);
  assert.equal(parseCodexThreadRead(read([], {historyMode:'paginated'}), {...SCOPE,includeTurns:false}).completeness,'incomplete');
});

test('paginated projections still enforce scope, limits and cursor-envelope rejection', () => {
  const input = read([turn([user(),assistant()]),turn([assistant('other','Public')],'turn-other')],{historyMode:'paginated'});
  assert.equal(parseCodexThreadRead(input,{...SCOPE,cwd:'/foreign'}).completeness,'rejected');
  assert.equal(parseCodexThreadRead(input,{...SCOPE,threadId:'foreign'}).completeness,'rejected');
  const limited=parseCodexThreadRead(input,SCOPE,{maxTurns:1});
  assert.equal(limited.completeness,'incomplete');
  assert.ok(limited.truncated);
  assert.ok(reasons(limited).includes('turn-limit'));
  assert.deepEqual(reasons(parseCodexThreadRead(read([], {historyMode:'paginated',nextCursor:'opaque'}),SCOPE)),['unsupported-envelope']);
});

// ---- documented paged history: metadata-only thread/read + ascending itemsView:'full' thread/turns/list pages ----
const metadata = (overrides: Record<string, unknown> = {}) => { const value = read([], { historyMode: 'paginated', ...overrides }); delete (value.thread as Record<string, unknown>).turns; return value; };
const page = (data: unknown[], nextCursor: string | null = null, extra: Record<string, unknown> = {}) => ({ data, nextCursor, backwardsCursor: data.length ? 'back-cursor' : null, ...extra });

test('failed MCP details use finite envelopes in legacy and paged history without raw provider messages', () => {
  const items = [
    { type:'mcpToolCall',id:'skill',server:'arcane',tool:'skills_recommend',status:'failed',result:{content:[{type:'text',text:'PRIVATE_ERROR_BODY'}],structuredContent:{error:{code:'INTEGRITY',message:'PRIVATE_PATH C:/secret'}},_meta:{secret:'PRIVATE_META'}} },
    { type:'mcpToolCall',id:'provider',server:'arcane',tool:'skills_get',status:'failed',result:null,error:{message:'PRIVATE_PROVIDER_ERROR password=secret'} },
    { type:'mcpToolCall',id:'forest',server:'arcane',tool:'scene_build',status:'failed',result:{content:[{type:'text',text:'{"error":{"code":"FOREST_SOURCES_REQUIRED","message":"PRIVATE_FOREST"}}'}]} },
    { type:'mcpToolCall',id:'blender',server:'arcane',tool:'studio_asset_generate',status:'failed',result:{content:[{type:'text',text:'{"error":{"code":"BLENDER_REQUIRED","message":"PRIVATE_BLENDER"}}'}]} },
    { type:'mcpToolCall',id:'reconstruction',server:'arcane',tool:'assets_place_studio_import',status:'failed',result:{content:[{type:'text',text:'{"error":{"code":"STUDIO_RECONSTRUCTION_REQUIRED","message":"PRIVATE_RECONSTRUCTION"}}'}]} },
    { type:'mcpToolCall',id:'unknown',server:'arcane',tool:'skills_get',status:'failed',result:null,error:null },
  ];
  const legacy=parseCodexThreadRead(read([turn(items)]),SCOPE);
  const paged=parseCodexPaginatedHistory(metadata(),[page([turn(items)])],SCOPE);
  assert.equal(legacy.completeness,'complete');assert.deepEqual(paged.entries,legacy.entries);
  assert.deepEqual(legacy.entries.map(entry=>JSON.parse(entry.text).toolFailure),[
    {schemaVersion:1,kind:'arcane-code',tool:'skills_recommend',code:'INTEGRITY'},
    {schemaVersion:1,kind:'mcp-error',tool:'skills_get',code:null},
    {schemaVersion:1,kind:'arcane-code',tool:'scene_build',code:'FOREST_SOURCES_REQUIRED'},
    {schemaVersion:1,kind:'arcane-code',tool:'studio_asset_generate',code:'BLENDER_REQUIRED'},
    {schemaVersion:1,kind:'arcane-code',tool:'assets_place_studio_import',code:'STUDIO_RECONSTRUCTION_REQUIRED'},
    {schemaVersion:1,kind:'details-unavailable',tool:'skills_get',code:null},
  ]);
  assert.deepEqual(legacy.entries[1]!.ids,{threadId:THREAD,sessionId:SESSION,turnId:TURN,itemId:'provider'});
  assert.ok(!JSON.stringify(legacy).includes('PRIVATE_'));assert.ok(!JSON.stringify(legacy).includes('password='));
  const duplicate=parseCodexThreadRead(read([turn([items[0],items[0]])]),SCOPE);assert.equal(duplicate.entries.length,1);
  const changed={...items[0],result:{structuredContent:{error:{code:'REGISTRY'}},content:[]}};
  const conflict=parseCodexThreadRead(read([turn([items[0],changed])]),SCOPE);
  assert.deepEqual(conflict.entries,[]);assert.ok(reasons(conflict).includes('conflicting-item'));
  const capped=parseCodexThreadRead(read([turn(Array.from({length:12},(_,n)=>({...items[1],id:'failure-'+n})))]),SCOPE,{maxBytes:1024});
  assert.equal(capped.completeness,'incomplete');assert.ok(Buffer.byteLength(JSON.stringify(capped))<=1024);
});

test('failed MCP projection never invokes private getters or proxy traps', () => {
  let invoked=0;const hidden=()=>{invoked++;throw new Error('untrusted field was read');};
  const failure={type:'mcpToolCall',id:'failed',server:'arcane',tool:'skills_get',status:'failed',result:null};
  Object.defineProperty(failure,'error',{enumerable:true,get:hidden});
  const projected=parseCodexThreadRead(read([turn([failure])]),SCOPE);
  assert.equal(JSON.parse(projected.entries[0]!.text).toolFailure.kind,'details-unavailable');
  const proxy=new Proxy({},{getPrototypeOf:hidden,getOwnPropertyDescriptor:hidden,ownKeys:hidden});
  const rejected=parseCodexThreadRead(read([turn([proxy])]),SCOPE);
  assert.ok(reasons(rejected).includes('malformed-item'));assert.equal(invoked,0);
});

test('existing finite staging unknown details retain public phase/reason even with a failed provider item status',()=>{
  const diagnostic=readStudioStagingDiagnostic({schemaVersion:1,operation:'stage',phase:'packet-receipt',reason:'proof-expired',packetOrdinal:12});assert.ok(diagnostic);
  const body={state:'unknown',terminal:false,ambiguous:true,retry:false,error:{code:'STUDIO_STAGE_CONTINUITY',message:'Fixed host continuity message.',diagnostic}};
  const text=JSON.stringify(body),item={type:'mcpToolCall',id:'staging',server:'arcane',tool:'assets_stage_studio_import',status:'failed',result:{content:[{type:'text',text}],structuredContent:body}};
  for(const projected of [parseCodexThreadRead(read([turn([item])]),SCOPE),parseCodexPaginatedHistory(metadata(),[page([turn([item])])],SCOPE)]){
    assert.equal(projected.entries[0]!.text,text,'existing safe public staging fields are not replaced by a generic failure');
    assert.deepEqual(JSON.parse(projected.entries[0]!.text).error.diagnostic,diagnostic);
  }
});

test('metadata reads select storage mode only after exact scope and persistence checks', () => {
  assert.equal(codexThreadHistoryMode(metadata(), SCOPE), 'paginated');
  assert.equal(codexThreadHistoryMode(metadata({ historyMode: 'legacy' }), SCOPE), 'legacy');
  const older = metadata(); delete (older.thread as Record<string, unknown>).historyMode;
  assert.equal(codexThreadHistoryMode(older, SCOPE), 'legacy', 'older schemas without historyMode are legacy');
  for (const [input, reason] of [[metadata({ id: 'foreign' }), 'scope-mismatch'], [metadata({ cwd: '/foreign' }), 'scope-mismatch'],
    [metadata({ sessionId: 'foreign' }), 'scope-mismatch'], [metadata({ historyMode: 'future' }), 'unsupported-history-mode'],
    [metadata({ ephemeral: true }), 'ephemeral-thread'], [{ id: 1, error: { message: 'PRIVATE' } }, 'rpc-error']] as const) {
    const result = codexThreadHistoryMode(input, SCOPE);
    assert.ok(typeof result !== 'string'); assert.equal(result.completeness, 'rejected'); assert.deepEqual(reasons(result), [reason]);
  }
});

test('paged turns use the shared projection; a fully enumerated empty thread is complete', () => {
  const two = parseCodexPaginatedHistory(metadata(), [page([turn([user()], 'turn-a')], 'cursor-2'), page([turn([assistant()], 'turn-b')])], SCOPE);
  assert.equal(two.completeness, 'complete'); assert.deepEqual(two.entries.map(entry => [entry.role, entry.ids.turnId]), [['user', 'turn-a'], ['assistant', 'turn-b']]);
  assert.ok(two.entries.every(entry => entry.ids.threadId === THREAD && entry.ids.sessionId === SESSION));
  const empty = parseCodexPaginatedHistory(metadata(), [page([])], SCOPE);
  assert.equal(empty.completeness, 'complete'); assert.deepEqual(empty.entries, []); assert.deepEqual(empty.gaps, []); assert.equal(empty.marker, null);
  const secret = parseCodexPaginatedHistory(metadata(), [page([turn([assistant('a', 'token=sk-proj-abcdefghijklmnop')])])], SCOPE);
  assert.equal(secret.redacted, true); assert.ok(!JSON.stringify(secret).includes('sk-proj-abcdefghijklmnop'));
});

test('unresolved cursors, page caps and non-full items never report completeness', () => {
  const unresolved = parseCodexPaginatedHistory(metadata(), [page([turn([user()])], 'more')], SCOPE);
  assert.equal(unresolved.completeness, 'incomplete'); assert.equal(unresolved.truncated, true); assert.ok(reasons(unresolved).includes('turn-limit'));
  const summary = parseCodexPaginatedHistory(metadata(), [page([turn([assistant('a', 'NOT_HYDRATED')], TURN, { itemsView: 'summary' })])], SCOPE);
  assert.equal(summary.completeness, 'incomplete'); assert.deepEqual(reasons(summary), ['items-not-full']); assert.ok(!JSON.stringify(summary).includes('NOT_HYDRATED'));
  const capped = parseCodexPaginatedHistory(metadata(), Array.from({ length: CODEX_HISTORY_MAX_PAGES + 1 }, (_, n) => page([turn([user()], 't-' + n)], 'c-' + n)), SCOPE);
  assert.equal(capped.completeness, 'rejected');
  const many = parseCodexPaginatedHistory(metadata(), [page(Array.from({ length: 65 }, (_, n) => turn([assistant('a-' + n)], 't-' + n)))], SCOPE);
  assert.equal(many.completeness, 'incomplete'); assert.equal(many.entries.length, NATIVE_HISTORY_LIMITS.maxTurns); assert.ok(reasons(many).includes('turn-limit'));
});

test('malformed or foreign page shapes and wrong storage modes are refused without extracting content', () => {
  for (const pages of [[], [{ nextCursor: null }], [page([], 'next'), { data: 'PRIVATE', nextCursor: null }], [page([]), page([])],
    [page([], '')], [page([], 'bad\ncursor')], [{ ...page([]), backwardsCursor: 7 }]]) {
    assert.equal(parseCodexPaginatedHistory(metadata(), pages, SCOPE).completeness, 'rejected', JSON.stringify(pages).slice(0, 80));
  }
  assert.deepEqual(reasons(parseCodexPaginatedHistory(metadata(), [{ id: 3, error: { message: 'PRIVATE_PAGE_ERROR' } }], SCOPE)), ['rpc-error']);
  assert.deepEqual(reasons(parseCodexPaginatedHistory(metadata(), [{ thread: {}, data: [], nextCursor: null }], SCOPE)), ['unsupported-envelope']);
  assert.deepEqual(reasons(parseCodexPaginatedHistory(metadata({ historyMode: 'legacy' }), [page([])], SCOPE)), ['unsupported-history-mode']);
  assert.deepEqual(reasons(parseCodexPaginatedHistory(metadata({ id: 'foreign' }), [page([turn([user()])])], SCOPE)), ['scope-mismatch']);
  assert.equal(parseCodexPaginatedHistory(metadata(), [page([])], { ...SCOPE, includeTurns: false }).completeness, 'incomplete');
});

test('page progress reads only the cursor and turn count of a public page', () => {
  assert.deepEqual(codexTurnsPageProgress(page([turn([user()]), turn([user()], 't2')], 'next')), { nextCursor: 'next', turns: 2 });
  assert.deepEqual(codexTurnsPageProgress(page([])), { nextCursor: null, turns: 0 });
  for (const bad of [null, [], { nextCursor: null }, { data: [], nextCursor: 5 }, { data: [], nextCursor: '' }]) assert.equal(codexTurnsPageProgress(bad), null);
});
