import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { CodexSession } from '../../packages/codex-client/src/session.js';
import { arcaneIsolationOverrides, arcaneThreadIsIsolated, requireArcaneBuildTools } from '../../packages/codex-client/src/mcp-isolation.js';
import { nativeEnvironment, readNativeFrameEvidence } from '../../packages/codex-client/src/transport.js';
import { limits } from '../../packages/codex-client/src/validation.js';
import { CODEX_LIMITS, CodexClientError } from '../../packages/codex-client/src/types.js';
import { ARCANE_TOOL_NAMES } from '../../packages/protocol/src/arcane-tools.js';

const ROOT = resolve(process.cwd()), HUMAN = { initiatedBy: 'human' } as const;
const THREAD = 'inventory-fixture-thread', PAIR = { model: 'inventory-fixture-model', effort: 'low' };
type Scenario = { count: number; large?: boolean; oversized?: boolean };
type Receipt = { event: 'request' | 'shape' | 'response'; method?: string; params?: Record<string, unknown>; bytes?: number; count?: number };

// Only a controlled Node JSONL peer is launched. It measures its actual encoded
// catalogue responses; no installed CLI, inherited servers or provider is used.
const PEER = String.raw`
const { createInterface } = require('node:readline');
const { appendFileSync } = require('node:fs');
const [encoded, audit] = process.argv.slice(1), scenario = JSON.parse(encoded);
const record = value => appendFileSync(audit, JSON.stringify(value) + '\n');
const rows = Array.from({ length: scenario.count }, (_, index) => ({
  name: index === 0 ? 'arcane' : 'inherited-' + index,
  runtimeStatus: index === 0 ? 'connected' : 'disabled',
  pluginId: index === 3 ? 'fixture-plugin@bundled' : null, toolsError: null,
  tools: Object.fromEntries((index === 0 ? scenario.oversized ? ['oversized'] : scenario.arcaneToolNames :
    Array.from({ length: scenario.large ? 40 : 1 }, (_, n) => 'tool-' + n)).map(name => [name, {
      description: 's'.repeat(scenario.oversized ? scenario.frameLimit + 256 : scenario.large ? 8192 : 16),
      inputSchema: { type: 'object', properties: { synthetic: { type: 'string' } } },
    }])),
}));
const send = (id, value, inventory = false) => {
  const frame = JSON.stringify({ id, result: value }) + '\n';
  if (inventory) record({ event: 'response', bytes: Buffer.byteLength(frame) });
  process.stdout.write(frame);
};
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params = {} } = JSON.parse(line);
  record({ event: 'request', method, params });
  if (method === 'initialized') return;
  if (method === 'initialize') return send(id, {});
  if (method === 'account/read') return send(id, { account: { type: 'chatgpt', planType: 'pro' }, requiresOpenaiAuth: true });
  if (method === 'model/list') return send(id, { data: [{ id: 'inventory-picker', model: 'inventory-fixture-model', displayName: 'Synthetic', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: null });
  if (method === 'thread/start') return send(id, { thread: { id: 'inventory-fixture-thread', sessionId: 'inventory-fixture-session', turns: [], status: { type: 'idle' } }, model: params.model, modelProvider: 'openai', cwd: process.cwd(), approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false } });
  if (method === 'mcpServerStatus/list') {
    if (params.cursor == null) record({ event: 'shape', count: rows.length, bytes: Buffer.byteLength(JSON.stringify({ id, result: { data: rows, nextCursor: null } }) + '\n') });
    const offset = Number(params.cursor || 0), end = Math.min(rows.length, offset + params.limit);
    return send(id, { data: rows.slice(offset, end), nextCursor: end < rows.length ? String(end) : null }, true);
  }
  process.stdout.write(JSON.stringify({ id, error: { code: -32601, message: 'Unsupported synthetic method' } }) + '\n');
});
`;

async function fixture(t: test.TestContext, scenario: Scenario, isolated = false) {
  const directory = await mkdtemp(join(tmpdir(), 'arcane-inventory-pages-')), audit = join(directory, 'wire.jsonl');
  const session = new CodexSession({ command: process.execPath,
    args: ['-e', PEER, JSON.stringify({ ...scenario, arcaneToolNames: ARCANE_TOOL_NAMES, frameLimit: CODEX_LIMITS.maxFrameBytes }), audit],
    cwd: ROOT, env: nativeEnvironment() }, limits({ requestTimeoutMs: 5000 }), 'spawned-node-fixture', isolated ? 'arcane-only' : 'native-config');
  t.after(async () => {
    await session.close();
    const child = relative(tmpdir(), directory);
    assert.ok(child.startsWith('arcane-inventory-pages-') && !child.includes(sep) && !child.includes('..'));
    await rm(directory, { recursive: true, force: true });
  });
  await session.initialize();
  const receipts = async (): Promise<Receipt[]> => (await readFile(audit, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Receipt);
  return { session, receipts };
}

const inventoryCalls = (rows: Receipt[]) => rows.filter(row => row.event === 'request' && row.method === 'mcpServerStatus/list');
const refusal = (expected: string) => (error: unknown) => error instanceof CodexClientError && error.code === expected;

test('four individually bounded catalogues retain the full isolated inventory when their combined frame exceeds 1 MiB', async t => {
  const { session, receipts } = await fixture(t, { count: 4, large: true }, true);
  session.selectModel({ ...HUMAN, ...PAIR });
  await session.startThread(HUMAN);
  assert.equal(session.snapshot().mcpIsolation, 'arcane-only-verified');
  const inventory = await session.inspectMcpServers({ ...HUMAN, threadId: THREAD });
  assert.deepEqual(inventory.map(row => row.name), ['arcane', 'inherited-1', 'inherited-2', 'inherited-3']);
  assert.equal(arcaneThreadIsIsolated(inventory), true); requireArcaneBuildTools(inventory);
  assert.equal(inventory[3]!.pluginId, 'fixture-plugin@bundled');
  const overrides = arcaneIsolationOverrides(inventory, process.execPath, '');
  for (const name of ['inherited-1', 'inherited-2']) assert.ok(overrides.some(value => value.startsWith('mcp_servers.' + name + '=') && value.includes('enabled=false')));
  assert.ok(overrides.includes('plugins.fixture-plugin@bundled.mcp_servers.inherited-3.enabled=false'));
  const rows = await receipts(), calls = inventoryCalls(rows), shapes = rows.filter(row => row.event === 'shape');
  assert.equal(shapes.length, 2); assert.ok(shapes.every(row => row.count === 4 && row.bytes! > CODEX_LIMITS.maxFrameBytes));
  const pages = rows.filter(row => row.event === 'response');
  assert.equal(pages.length, 8); assert.ok(pages.every(row => row.bytes! < CODEX_LIMITS.maxFrameBytes));
  assert.deepEqual(calls.map(row => row.params), Array.from({ length: 2 }, () => [null, '1', '2', '3'].map(cursor => ({ cursor, limit: 1, detail: 'toolsAndAuthOnly', threadId: THREAD }))).flat());
  assert.equal(rows.filter(row => row.method === 'thread/start').length, 1);
  assert.equal(rows.filter(row => row.method === 'turn/start').length, 0);
  assert.ok(!JSON.stringify(session.snapshot()).includes('ssssssssssssssss'));
  await session.close(); await session.close(); assert.equal(session.snapshot().connected, false);
});

test('all 32 original inventory slots are accepted when the last one-server page terminates', async t => {
  const { session, receipts } = await fixture(t, { count: 32 });
  const inventory = await session.inspectMcpServers(HUMAN);
  assert.equal(inventory.length, 32); assert.equal(new Set(inventory.map(row => row.name)).size, 32);
  assert.equal(inventory.at(-1)!.name, 'inherited-31'); assert.equal(arcaneThreadIsIsolated(inventory), true);
  const calls = inventoryCalls(await receipts());
  assert.deepEqual(calls.map(row => row.params), Array.from({ length: 32 }, (_, index) => ({ cursor: index === 0 ? null : String(index), limit: 1, detail: 'toolsAndAuthOnly' })));
  await session.close(); assert.equal(session.snapshot().connected, false);
});

test('an advertised 33rd server is refused after 32 pages without requesting or retrying it', async t => {
  const { session, receipts } = await fixture(t, { count: 33 });
  await assert.rejects(() => session.inspectMcpServers(HUMAN), refusal('MCP_INVENTORY'));
  const rows = await receipts(), calls = inventoryCalls(rows);
  assert.equal(calls.length, 32); assert.equal(calls.at(-1)!.params!.cursor, '31');
  assert.ok(calls.every(row => row.params!.limit === 1));
  assert.equal(rows.filter(row => row.method === 'initialize').length, 1);
  assert.equal(rows.filter(row => row.method === 'thread/start' || row.method === 'turn/start').length, 0);
  await session.close(); await session.close(); assert.equal(session.snapshot().connected, false);
});

test('one oversized server still fails the original frame cap once and joins its original child', async t => {
  const { session, receipts } = await fixture(t, { count: 1, oversized: true });
  let failure: unknown;
  await assert.rejects(() => session.inspectMcpServers(HUMAN), error => { failure = error; return refusal('FRAME_LIMIT')(error); });
  const evidence = readNativeFrameEvidence(failure);
  assert.ok(evidence); assert.equal(evidence.direction, 'inbound');
  assert.equal(evidence.frameLimitBytes, CODEX_LIMITS.maxFrameBytes);
  assert.equal(evidence.pendingMethodMask, 512); assert.equal(evidence.pendingCount, 1);
  const rows = await receipts(); assert.equal(inventoryCalls(rows).length, 1);
  assert.equal(rows.filter(row => row.method === 'initialize').length, 1);
  assert.equal(rows.filter(row => row.method === 'thread/start' || row.method === 'turn/start').length, 0);
  await session.close(); await session.close(); assert.equal(session.snapshot().connected, false);
});
