import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_GAP_MARKER, NATIVE_HISTORY_LIMITS, parseCodexThreadRead,
  planNativeHistoryCapabilities, redactNativeHistoryText,
} from '../../packages/codex-client/src/history.js';
import type { CodexHistoryScope } from '../../packages/codex-client/src/history.js';

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

test('paginated and unknown storage modes fail closed even when turns look like valid legacy data', () => {
  for (const mode of ['paginated', 'future-mode', null, {}]) {
    const fixture = read([], { historyMode: mode });
    Object.defineProperty(fixture.thread, 'turns', { get() { assert.fail('unsupported mode accessed content'); } });
    const result = parseCodexThreadRead(fixture, SCOPE);
    assert.equal(result.completeness, 'rejected');
    assert.deepEqual(reasons(result), ['unsupported-history-mode']);
  }
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
  assert.equal(plan.nativeApis.find(api => api.api === 'thread/turns/list')?.support, 'experimental');
  assert.equal(plan.nativeApis.find(api => api.api === 'thread/turns/list')?.availableInPlan, false);
});

test('experimental turn pagination requires explicit negotiation and schema evidence', () => {
  for (const evidence of [{}, { experimentalApi: true }, { turnPaginationSchemaAvailable: true }]) {
    assert.ok(!planNativeHistoryCapabilities({ provider: 'codex', cwd: CWD, nativeId: THREAD, ...evidence }).requests.some(request => request.method === 'thread/turns/list'));
  }
  const plan = planNativeHistoryCapabilities({ provider: 'codex', cwd: CWD, nativeId: THREAD, experimentalApi: true, turnPaginationSchemaAvailable: true });
  assert.deepEqual(plan.requests.find(request => request.method === 'thread/turns/list')?.params, { threadId: THREAD, limit: 64, sortDirection: 'asc', itemsView: 'full' });
  assert.equal(plan.runtimeVerified, false);
});

test('unsupported paginated storage permits metadata inspection only and never falls back to a fake chat', () => {
  const plan = planNativeHistoryCapabilities({ provider: 'codex', cwd: CWD, nativeId: THREAD, historyMode: 'paginated', experimentalApi: true, turnPaginationSchemaAvailable: true });
  assert.equal(plan.status, 'unsupported');
  assert.deepEqual(plan.requests.map(request => request.method), ['thread/list', 'thread/read']);
  assert.deepEqual(plan.requests[1]?.params, { threadId: THREAD, includeTurns: false });
  assert.equal(plan.nativeId, THREAD);
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
