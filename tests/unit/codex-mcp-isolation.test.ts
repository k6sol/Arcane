import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexSession } from '../../packages/codex-client/src/session.js';
import { arcaneThreadIsIsolated, type McpInventoryRow } from '../../packages/codex-client/src/mcp-isolation.js';
import { nativeEnvironment } from '../../packages/codex-client/src/transport.js';
import { ARCANE_TOOL_NAMES } from '../../packages/protocol/src/arcane-tools.js';
import { limits } from '../../packages/codex-client/src/validation.js';
import { CodexClientError, type Approval } from '../../packages/codex-client/src/types.js';

const ROOT = resolve(process.cwd()), HUMAN = { initiatedBy: 'human' } as const;
const PAIR = { model: 'fixture-sol', effort: 'ultra' }, OTHER = { model: 'fixture-other', effort: 'low' };
const THREAD = 'native.thread:exact-17', SESSION = 'native.session:exact-23';
const INPUT = { ...HUMAN, threadId: THREAD, text: 'Synthetic isolation check' };
type Scenario = { inventory?: string; failCheck?: number; holdCheck?: number; accountChange?: boolean; holdAccount?: boolean; activeFirst?: boolean; lostTurn?: boolean; wrongThread?: boolean; changedTurn?: boolean };
type Wire = { id?: string | number; method?: string; params?: Record<string, unknown>; result?: { decision?: string } };
// This is the only spawned peer: Node JSONL with synthetic metadata and file-controlled gates.
// There is no installed CLI, inference, HTTP, browser, Studio, auth/config read or inherited token access.
const PEER = String.raw`
const { createInterface } = require('node:readline');
const { appendFileSync, existsSync } = require('node:fs');
const [encoded, audit, gate] = process.argv.slice(1), scenario = JSON.parse(encoded);
const threadId = 'native.thread:exact-17', sessionId = 'native.session:exact-23';
let check = 0, turns = 0, accountReads = 0;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => send({ method, params });
const result = (id, value) => send({ id, result: value });
const record = value => appendFileSync(audit, JSON.stringify(value) + '\n');
const held = (file, reply) => { const timer = setInterval(() => { if (existsSync(file)) { clearInterval(timer); reply(); } }, 5); };
const row = (name, runtimeStatus = 'disabled') => ({ name, runtimeStatus, tools: {}, toolsError: null, pluginId: null });
const inventory = params => {
  const arcane = { ...row('arcane', 'connected'), tools: Object.fromEntries(${JSON.stringify(ARCANE_TOOL_NAMES)}.map(name=>[name,{description:'SYNTHETIC_PRIVATE_DESCRIPTION'}])) };
  let data = [arcane, row('inherited')], nextCursor = null;
  const mode = scenario.inventory;
  if (check >= (scenario.failCheck || 2) || mode === 'initial-inherited') {
    if (mode === 'read-only-tools') delete arcane.tools.scene_create;
    if (mode === 'missing-skill-router') delete arcane.tools.skills_recommend;
    if (mode === 'inherited' || mode === 'initial-inherited') data[1].runtimeStatus = 'connected';
    if (mode === 'missing-arcane') data = [row('inherited')];
    if (mode === 'duplicate') data = [arcane, arcane];
    if (mode === 'unknown-status') arcane.runtimeStatus = 'future-status';
    if (mode === 'null-status') arcane.runtimeStatus = null;
    if (mode === 'missing-status') delete arcane.runtimeStatus;
    if (mode === 'missing-error') delete arcane.toolsError;
    if (mode === 'missing-plugin') delete arcane.pluginId;
    if (mode === 'bad-error') arcane.toolsError = false;
    if (mode === 'error') arcane.toolsError = 'synthetic discovery failed';
    if (mode === 'plugin-arcane') arcane.pluginId = 'unexpected-plugin';
    if (mode === 'bad-plugin') arcane.pluginId = {};
    if (mode === 'bad-tools') arcane.tools = [];
    if (mode === 'bad-tool-value') arcane.tools.work_runs = null;
    if (mode === 'bad-name') arcane.name = null;
    if (mode === 'bad-data') data = {};
    if (mode === 'bad-row') data = [null];
    if (mode === 'page-bound') data = Array.from({ length: 5 }, (_, n) => row('server-' + n));
    if (mode === 'server-bound') { const page = Number(params.cursor || 0); data = Array.from({ length: 32 }, (_, n) => row('server-' + (page * 32 + n))); nextCursor = String(page + 1); }
    if (mode === 'tool-bound') arcane.tools = Object.fromEntries(Array.from({ length: 2049 }, (_, n) => ['tool-' + n, {}]));
    if (mode === 'tool-name-bound') arcane.tools = { ['x'.repeat(257)]: {} };
    if (mode === 'cursor-loop') { data = []; nextCursor = 'same'; }
    if (mode === 'pagination-bound') { data = []; nextCursor = String(Number(params.cursor || 0) + 1); }
    if (mode === 'duplicate-page') { data = [arcane]; nextCursor = params.cursor ? null : 'next'; }
    if (mode === 'paged') { data = params.cursor ? [row('inherited')] : [arcane]; nextCursor = params.cursor ? null : 'next'; }
    if (mode === 'missing-cursor') return { data };
  }
  return { data, nextCursor };
};
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line); record(message);
  const { id, method, params = {} } = message;
  if (!method || method === 'initialized') return;
  if (method === 'initialize') return result(id, {});
  if (method === 'account/read') {
    accountReads++;
    const reply = () => result(id, { account: { type: 'chatgpt', planType: 'pro' }, requiresOpenaiAuth: true });
    if (scenario.holdAccount && accountReads > 1) held(gate + '-account', reply); else reply();
    return;
  }
  if (method === 'model/list') return result(id, { data: ['fixture-sol', 'fixture-other'].map(model => ({ id: 'picker-' + model, model, displayName: model, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }] })), nextCursor: null });
  if (method === 'thread/start' || method === 'thread/resume') {
    notify('thread/started', { thread: { id: threadId, sessionId } });
    return result(id, { thread: { id: threadId, sessionId, turns: [], status: { type: 'idle' } }, model: params.model, modelProvider: 'openai', cwd: process.cwd(), approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false } });
  }
  if (method === 'mcpServerStatus/list') {
    if (!params.cursor) check++;
    if (check > 1 && scenario.inventory === 'timeout') return;
    if (check > 1 && scenario.inventory === 'disconnect') return process.exit(0);
    if (check > 1 && scenario.inventory === 'remote') return send({ id, error: { code: -32017, message: 'synthetic inventory refusal' } });
    const reply = () => result(id, inventory(params));
    if (check === scenario.holdCheck && !params.cursor) {
      if (scenario.accountChange) notify('account/updated', { authMode: 'chatgpt' });
      if (scenario.wrongThread) {
        notify('turn/started', { threadId: 'other-native-thread', turn: { id: 'foreign-turn', status: 'inProgress' } });
        send({ id: 'foreign-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'other-native-thread', turnId: 'foreign-turn', itemId: 'foreign-item', command: 'synthetic', cwd: process.cwd() } });
      }
      if (scenario.changedTurn) notify('turn/completed', { threadId, turn: { id: 'native.turn:exact-' + turns, status: 'failed' } });
      held(gate, reply);
    } else reply();
    return;
  }
  if (method === 'turn/start') {
    const turnId = 'native.turn:exact-' + (++turns), turn = { id: turnId, status: 'inProgress' };
    if (scenario.lostTurn) return;
    notify('turn/started', { threadId, turn });
    if (scenario.activeFirst && turns === 1) {
      send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'review-item', command: 'synthetic command', cwd: process.cwd() } });
      return result(id, { turn });
    }
    turn.status = 'completed'; notify('turn/completed', { threadId, turn });
    return result(id, { turn });
  }
  if (method === 'turn/interrupt') {
    notify('turn/completed', { threadId, turn: { id: params.turnId, status: 'interrupted' } });
    return result(id, {});
  }
  send({ id, error: { code: -32601, message: 'unknown synthetic method' } });
});
`;
const code = (expected: string, dispatched?: boolean) => (error: unknown) => error instanceof CodexClientError && error.code === expected && (dispatched === undefined || error.dispatched === dispatched);
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!await predicate()) { if (Date.now() >= deadline) assert.fail('Timed out waiting for synthetic peer evidence.'); await delay(5); }
}
async function fixture(t: test.TestContext, scenario: Scenario = {}, policy: 'arcane-only' | 'native-config' = 'arcane-only') {
  const dir = await mkdtemp(join(tmpdir(), 'arcane-mcp-isolation-')), audit = join(dir, 'wire.jsonl'), gate = join(dir, 'release');
  const bounds = limits({ requestTimeoutMs: 5000, approvalTimeoutMs: 1000 });
  const session = new CodexSession({ command: process.execPath, args: ['-e', PEER, JSON.stringify(scenario), audit, gate], cwd: ROOT, env: nativeEnvironment() }, bounds, 'spawned-node-fixture', policy);
  t.after(async () => {
    await session.close();
    const child = relative(tmpdir(), dir);
    assert.ok(child.startsWith('arcane-mcp-isolation-') && !child.includes(sep) && !child.includes('..'));
    await rm(dir, { recursive: true, force: true });
  });
  const receipts = async (): Promise<Wire[]> => { try { return (await readFile(audit, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Wire); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; } };
  await session.initialize(); session.selectModel({ ...HUMAN, ...PAIR });
  return { session, bounds, receipts, release: () => writeFile(gate, ''), releaseAccount: () => writeFile(gate + '-account', '') };
}
async function open(t: test.TestContext, scenario: Scenario = {}) { const context = await fixture(t, scenario); await context.session.startThread(HUMAN); return context; }
const calls = (wire: Wire[], method: string) => wire.filter(row => row.method === method);
function answer(approval: Approval) { return { ...HUMAN, handle: approval.handle, connectionId: approval.connectionId, threadId: approval.threadId, turnId: approval.turnId, decision: 'accept' as const }; }
function assertFenced(session: CodexSession, before: ReturnType<CodexSession['snapshot']>) {
  const after = session.snapshot();
  assert.equal(after.connected, false); assert.equal(after.ready, false);
  assert.equal(after.mcpIsolation, 'arcane-only-pending');
  assert.equal(after.thread!.configured, false); assert.equal(after.thread!.writeGranted, false);
  assert.equal(after.thread!.threadId, before.thread!.threadId); assert.equal(after.thread!.sessionId, SESSION);
  assert.equal(after.thread!.turnId, before.thread!.turnId); assert.equal(after.thread!.turnStatus, before.thread!.turnStatus);
  assert.deepEqual(after.operations, before.operations); assert.deepEqual(after.approvals, []);
}

test('initial thread inventory plus every turn uses the exact native thread and fresh bounded inventory', async t => {
  const { session, receipts } = await open(t, { inventory: 'paged' });
  assert.equal(session.snapshot().mcpIsolation, 'arcane-only-verified');
  assert.equal(calls(await receipts(), 'mcpServerStatus/list').length, 1);
  session.grantThreadWrites({ ...HUMAN, threadId: THREAD });
  await session.startTurn(INPUT); session.selectModel({ ...HUMAN, ...OTHER }); await session.startTurn(INPUT);
  const wire = await receipts(), inventory = calls(wire, 'mcpServerStatus/list'), turns = calls(wire, 'turn/start');
  assert.equal(inventory.length, 5); assert.equal(turns.length, 2);
  for (const row of inventory) assert.deepEqual(Object.keys(row.params!).sort(), ['cursor', 'detail', 'limit', 'threadId']);
  for (const row of inventory) { assert.equal(row.params!.threadId, THREAD); assert.equal(row.params!.limit, 4); assert.equal(row.params!.detail, 'toolsAndAuthOnly'); }
  assert.equal(turns[0]!.params!.model, PAIR.model); assert.equal(turns[0]!.params!.effort, PAIR.effort);
  assert.deepEqual(turns[0]!.params!.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [ROOT], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
  assert.deepEqual(turns[1]!.params!.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(turns[1]!.params!.model, OTHER.model); assert.equal(session.snapshot().thread!.turnId, 'native.turn:exact-2');
  assert.equal(session.snapshot().thread!.sessionId, SESSION);
  assert.ok(!JSON.stringify(session.snapshot()).includes('SYNTHETIC_PRIVATE_DESCRIPTION'));
  for (const turn of turns) assert.equal(wire[wire.indexOf(turn) - 1]!.method, 'mcpServerStatus/list');
});

test('native-config retains its legacy launch and turn path without automatic inventories', async t => {
  const { session, receipts } = await fixture(t, { inventory: 'inherited' }, 'native-config');
  await session.startThread(HUMAN); await session.startTurn(INPUT); await session.startTurn(INPUT);
  assert.equal(session.snapshot().mcpIsolation, 'native-config');
  assert.equal(calls(await receipts(), 'mcpServerStatus/list').length, 0);
  assert.equal(calls(await receipts(), 'turn/start').length, 2);
});

for (const [inventory, expected] of [
  ['read-only-tools', 'MCP_CAPABILITIES'], ['missing-skill-router', 'MCP_CAPABILITIES'],
  ['inherited', 'MCP_ISOLATION'], ['missing-arcane', 'MCP_ISOLATION'], ['null-status', 'MCP_ISOLATION'], ['error', 'MCP_ISOLATION'], ['plugin-arcane', 'MCP_ISOLATION'],
  ...['duplicate', 'unknown-status', 'missing-status', 'missing-error', 'missing-plugin', 'bad-error', 'bad-plugin', 'bad-tools', 'bad-tool-value', 'bad-name', 'bad-data', 'bad-row', 'page-bound', 'server-bound', 'tool-bound', 'tool-name-bound', 'cursor-loop', 'pagination-bound', 'duplicate-page', 'missing-cursor'].map(mode => [mode, 'MCP_INVENTORY']),
  ['remote', 'REMOTE_REJECTED'], ['timeout', 'TIMEOUT'], ['disconnect', 'DISCONNECTED'],
] as const) test('fresh metadata failure refuses unsent turns and revokes grants without replay: ' + inventory, async t => {
  const { session, receipts, bounds } = await open(t, { inventory });
  session.grantThreadWrites({ ...HUMAN, threadId: THREAD }); const before = session.snapshot();
  if (inventory === 'timeout') Object.assign(bounds, { requestTimeoutMs: 60 });
  await assert.rejects(() => session.startTurn(INPUT), code(expected, false));
  assertFenced(session, before);
  await assert.rejects(() => session.startTurn(INPUT), code('DISCONNECTED', false));
  assert.equal(calls(await receipts(), 'turn/start').length, 0);
  assert.equal(calls(await receipts(), 'thread/start').length, 1);
  assert.equal(calls(await receipts(), 'initialize').length, 1);
});

test('changed inherited server after a completed turn preserves exact previous turn and acknowledged operations', async t => {
  const { session, receipts } = await open(t, { inventory: 'inherited', failCheck: 3 });
  await session.startTurn(INPUT); session.grantThreadWrites({ ...HUMAN, threadId: THREAD });
  const before = session.snapshot(); await assert.rejects(() => session.startTurn(INPUT), code('MCP_ISOLATION', false));
  assertFenced(session, before); assert.equal(before.operations[1]!.state, 'acknowledged');
  assert.equal(before.thread!.turnId, 'native.turn:exact-1'); assert.equal(before.thread!.turnStatus, 'completed');
  assert.equal(calls(await receipts(), 'turn/start').length, 1);
});

test('the entire held preflight is oneflight and blocks selection, grants, interrupt and thread/history starts', async t => {
  const { session, receipts, release } = await open(t, { holdCheck: 2, wrongThread: true });
  const before = session.snapshot(), start = session.startTurn(INPUT); start.catch(() => undefined);
  await until(async () => calls(await receipts(), 'mcpServerStatus/list').length === 2);
  assert.deepEqual(session.snapshot().operations, before.operations);
  assert.equal(session.snapshot().thread!.turnId, null); assert.equal(session.snapshot().thread!.turnStatus, 'idle');
  assert.equal(session.snapshot().mcpIsolation, 'arcane-only-pending');
  await assert.rejects(() => session.startTurn(INPUT), code('BUSY'));
  assert.throws(() => session.selectModel({ ...HUMAN, ...OTHER }), code('STATE'));
  assert.throws(() => session.selectModel({ ...HUMAN, ...PAIR }), code('STATE'));
  assert.throws(() => session.grantThreadWrites({ ...HUMAN, threadId: THREAD }), code('STATE'));
  await assert.rejects(() => session.interruptTurn({ ...HUMAN, threadId: THREAD, turnId: 'previous-turn' }), code('STATE'));
  await assert.rejects(() => session.startThread(HUMAN), code('STATE'));
  await assert.rejects(() => session.resumeThread({ ...HUMAN, threadId: THREAD }), code('STATE'));
  await assert.rejects(() => session.readThreadHistory({ ...HUMAN, threadId: THREAD }), code('BUSY'));
  await until(async () => (await receipts()).some(row => row.id === 'foreign-approval' && row.result?.decision === 'cancel'));
  assert.deepEqual(session.snapshot().approvals, []); assert.deepEqual(session.snapshot().selection, PAIR);
  await release(); await start;
  assert.equal(calls(await receipts(), 'turn/start').length, 1); assert.equal(calls(await receipts(), 'turn/interrupt').length, 0);
});

for (const granted of [false, true]) test('revocation while inventory is held cancels unsent intent and cannot restore a grant: ' + granted, async t => {
  const { session, receipts, release } = await open(t, { holdCheck: 2 });
  if (granted) session.grantThreadWrites({ ...HUMAN, threadId: THREAD });
  const before = session.snapshot(), start = session.startTurn(INPUT), rejected = assert.rejects(start, code('GRANT_REVOKED', false));
  await until(async () => calls(await receipts(), 'mcpServerStatus/list').length === 2);
  session.revokeThreadWrites({ ...HUMAN, threadId: THREAD });
  assert.equal(session.snapshot().thread!.writeGranted, false);
  assert.throws(() => session.grantThreadWrites({ ...HUMAN, threadId: THREAD }), code('STATE'));
  await release(); await rejected; assertFenced(session, before);
  assert.equal(calls(await receipts(), 'turn/start').length, 0);
});

test('closing a connection during inventory cannot resurrect configured isolation or create a turn attempt', async t => {
  const { session, receipts } = await open(t, { holdCheck: 2 });
  session.grantThreadWrites({ ...HUMAN, threadId: THREAD }); const before = session.snapshot();
  const start = session.startTurn(INPUT), rejected = assert.rejects(start, code('DISCONNECTED', false));
  await until(async () => calls(await receipts(), 'mcpServerStatus/list').length === 2);
  await session.close(); await rejected; assertFenced(session, before);
  assert.equal(calls(await receipts(), 'turn/start').length, 0);
});

for (const phase of ['during', 'before', 'changed-and-restored']) test('account lifecycle fences a held inventory even when subscription metadata is restored: ' + phase, async t => {
  const { session, receipts, release, releaseAccount } = await open(t, { holdCheck: 2, holdAccount: phase !== 'changed-and-restored', accountChange: phase === 'changed-and-restored' });
  session.grantThreadWrites({ ...HUMAN, threadId: THREAD }); const before = session.snapshot();
  if (phase === 'before') {
    const read = session.readAccount(); read.catch(() => undefined);
    await assert.rejects(() => session.startTurn(INPUT), code('STATE', false));
    await assert.rejects(read, code('STATE')); assertFenced(session, before);
    assert.equal(calls(await receipts(), 'mcpServerStatus/list').length, 1); return;
  }
  const start = session.startTurn(INPUT), rejected = assert.rejects(start, code('STATE', false));
  await until(async () => calls(await receipts(), 'mcpServerStatus/list').length === 2);
  if (phase === 'changed-and-restored') await until(() => session.snapshot().account === null);
  const read = session.readAccount(); read.catch(() => undefined);
  if (phase === 'during') await releaseAccount();
  await read; assert.equal(session.snapshot().account!.auth, 'subscription');
  await release(); await rejected; assertFenced(session, before);
  assert.equal(calls(await receipts(), 'turn/start').length, 0);
});

test('initial setup rechecks readiness after inventory awaits and never restores a disconnected thread', async t => {
  const { session, receipts } = await fixture(t, { holdCheck: 1 });
  const start = session.startThread(HUMAN), rejected = assert.rejects(start, code('DISCONNECTED'));
  await until(async () => calls(await receipts(), 'mcpServerStatus/list').length === 1);
  await session.close(); await rejected;
  const snapshot = session.snapshot(); assert.equal(snapshot.thread!.configured, false); assert.equal(snapshot.mcpIsolation, 'arcane-only-pending');
  assert.equal(snapshot.thread!.threadId, THREAD); assert.equal(snapshot.operations[0]!.state, 'unknown');
  assert.equal(calls(await receipts(), 'turn/start').length, 0);
});

test('same-thread lifecycle changes during inventory cannot dispatch a new turn', async t => {
  const { session, receipts, release } = await open(t, { holdCheck: 3, changedTurn: true });
  await session.startTurn(INPUT); const before = session.snapshot();
  const start = session.startTurn(INPUT), rejected = assert.rejects(start, code('STATE', false));
  await until(() => session.snapshot().thread!.turnStatus === 'failed');
  await release(); await rejected;
  assert.equal(session.snapshot().thread!.turnId, before.thread!.turnId);
  assert.equal(session.snapshot().thread!.turnStatus, 'failed'); assert.deepEqual(session.snapshot().operations, before.operations);
  assert.equal(session.snapshot().thread!.configured, false); assert.equal(calls(await receipts(), 'turn/start').length, 1);
});

test('resumed native thread is checked on setup and again before a turn using its exact ID', async t => {
  const { session, receipts } = await fixture(t);
  await session.resumeThread({ ...HUMAN, threadId: THREAD }); await session.startTurn(INPUT);
  assert.equal(calls(await receipts(), 'thread/start').length, 0); assert.equal(calls(await receipts(), 'thread/resume').length, 1);
  assert.equal(calls(await receipts(), 'mcpServerStatus/list').length, 2);
  for (const call of calls(await receipts(), 'mcpServerStatus/list')) assert.equal(call.params!.threadId, THREAD);
});

test('initial isolation failure retains the observed native thread as unknown without turn dispatch', async t => {
  const { session, receipts } = await fixture(t, { inventory: 'initial-inherited' });
  await assert.rejects(() => session.startThread(HUMAN), code('MCP_ISOLATION'));
  const snapshot = session.snapshot(); assert.equal(snapshot.thread!.threadId, THREAD); assert.equal(snapshot.thread!.sessionId, SESSION);
  assert.equal(snapshot.thread!.configured, false); assert.equal(snapshot.operations[0]!.state, 'unknown');
  assert.equal(calls(await receipts(), 'turn/start').length, 0);
});

test('initial setup cannot configure a thread after account metadata changed and was restored during inventory', async t => {
  const { session, receipts, release } = await fixture(t, { holdCheck: 1, accountChange: true });
  const start = session.startThread(HUMAN), rejected = assert.rejects(start, code('STATE'));
  await until(() => session.snapshot().account === null);
  await session.readAccount(); assert.equal(session.snapshot().account!.auth, 'subscription');
  assert.throws(() => session.selectModel({ ...HUMAN, ...PAIR }), code('STATE'));
  assert.throws(() => session.grantThreadWrites({ ...HUMAN, threadId: THREAD }), code('THREAD'));
  await release(); await rejected;
  assert.equal(session.snapshot().thread!.configured, false); assert.equal(session.snapshot().thread!.writeGranted, false);
  assert.equal(session.snapshot().mcpIsolation, 'arcane-only-pending'); assert.equal(session.snapshot().operations[0]!.state, 'unknown');
  assert.equal(calls(await receipts(), 'turn/start').length, 0);
});

test('exact thread validation precedes metadata dispatch; inventory cannot fall back to connection-wide scope', async t => {
  const { session, receipts } = await open(t);
  await assert.rejects(() => session.startTurn({ ...INPUT, threadId: 'another-thread' }), code('THREAD'));
  await assert.rejects(() => session.inspectMcpServers({ ...HUMAN, threadId: 'another-thread' }), code('STATE'));
  assert.equal(calls(await receipts(), 'mcpServerStatus/list').length, 1);
  await session.startTurn(INPUT); for (const call of calls(await receipts(), 'mcpServerStatus/list')) assert.equal(call.params!.threadId, THREAD);
});

test('actual lost turn acknowledgement still retains a dispatched unknown operation and is never replayed', async t => {
  const { session, receipts, bounds } = await open(t, { lostTurn: true }); Object.assign(bounds, { requestTimeoutMs: 60 });
  await assert.rejects(() => session.startTurn(INPUT), code('TIMEOUT', true));
  const snapshot = session.snapshot(); assert.equal(snapshot.operations.at(-1)!.method, 'turn/start'); assert.equal(snapshot.operations.at(-1)!.state, 'unknown');
  assert.notEqual(snapshot.operations.at(-1)!.requestId, null); assert.equal(snapshot.thread!.turnId, null); assert.equal(snapshot.thread!.turnStatus, 'unknown');
  await assert.rejects(() => session.startTurn(INPUT), code('DISCONNECTED'));
  assert.equal(calls(await receipts(), 'turn/start').length, 1); assert.equal(calls(await receipts(), 'mcpServerStatus/list').length, 2);
});

test('approvals from a previous interrupted turn cannot be accepted or grant writes during a new preflight', async t => {
  const { session, receipts, release } = await open(t, { activeFirst: true, holdCheck: 3 });
  session.grantThreadWrites({ ...HUMAN, threadId: THREAD }); await session.startTurn(INPUT);
  await until(() => session.snapshot().approvals.length === 1); const stale = session.snapshot().approvals[0]!;
  await session.interruptTurn({ ...HUMAN, threadId: THREAD, turnId: stale.turnId });
  const before = session.snapshot(), start = session.startTurn(INPUT); start.catch(() => undefined);
  await until(async () => calls(await receipts(), 'mcpServerStatus/list').length === 3);
  assert.equal(session.snapshot().thread!.turnId, stale.turnId); assert.deepEqual(session.snapshot().operations, before.operations);
  assert.throws(() => session.respondApproval(answer(stale)), code('STALE_APPROVAL'));
  assert.throws(() => session.grantThreadWrites({ ...HUMAN, threadId: THREAD }), code('STATE'));
  await release(); await start;
  assert.equal(calls(await receipts(), 'turn/start').length, 2); assert.equal(session.snapshot().thread!.writeGranted, false);
  assert.ok(!(await receipts()).some(row => row.result?.decision === 'accept'));
});

test('isolated predicate refuses malformed, duplicate and unknown rows independently of the parser', () => {
  const arcane: McpInventoryRow = { name: 'arcane', runtimeStatus: 'connected', toolNames: [], toolsError: false, plugin: false, pluginId: null };
  const disabled: McpInventoryRow = { ...arcane, name: 'inherited', runtimeStatus: 'disabled' };
  assert.equal(arcaneThreadIsIsolated([arcane, disabled]), true);
  for (const rows of [[], [arcane, arcane], [arcane, disabled, disabled], [null], [{ ...arcane, toolsError: undefined }], [{ ...arcane, toolNames: null }], [{ ...arcane, toolNames: new Array(1) }], [{ ...arcane, pluginId: 'plugin' }], [{ ...arcane, plugin: true, pluginId: 'plugin' }], [{ ...arcane, runtimeStatus: 'unknown' }], [arcane, { ...disabled, runtimeStatus: null }], [arcane, { ...disabled, name: '' }]]) {
    assert.equal(arcaneThreadIsIsolated(rows as McpInventoryRow[]), false);
  }
});
