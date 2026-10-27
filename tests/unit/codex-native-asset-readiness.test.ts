import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DaemonClient } from '../../apps/mcp/src/daemon-client.js';
import { createMcpServer } from '../../apps/mcp/src/server.js';
import { CodexSession } from '../../packages/codex-client/src/session.js';
import { nativeEnvironment } from '../../packages/codex-client/src/transport.js';
import { limits } from '../../packages/codex-client/src/validation.js';
import { requireArcaneBuildTools, type McpInventoryRow } from '../../packages/codex-client/src/mcp-isolation.js';
import { ARCANE_TOOL_NAMES, ARCANE_NATIVE_TOOL_NAMES } from '../../packages/protocol/src/arcane-tools.js';

const ROOT = resolve(process.cwd()), HUMAN = { initiatedBy: 'human' } as const;
const THREAD = 'readiness.thread:exact', ADOPT = 'assets_adopt_glb', CONVERT = 'assets_convert_glb', PREPARE = 'assets_prepare_studio_import', STAGE = 'assets_stage_studio_import', STATUS = 'assets_studio_staging_status';
const INPUT = { ...HUMAN, threadId: THREAD, text: 'Synthetic readiness turn' };
type Wire = { method?: string; params?: { threadId?: string } };

// Only Node executes this JSONL peer. No CLI, inference, credentials, HTTP or Studio.
const PEER = String.raw`
const { createInterface } = require('node:readline');
const { appendFileSync } = require('node:fs');
const [encoded, audit] = process.argv.slice(1), scenario = JSON.parse(encoded);
let checks = 0;
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
 const { id, method, params = {} } = JSON.parse(line);
 appendFileSync(audit, JSON.stringify({ method, params }) + '\n');
 if (method === 'initialized') return;
 if (method === 'initialize') return reply(id, {});
 if (method === 'account/read') return reply(id, { account: { type: 'chatgpt', planType: 'plus' }, requiresOpenaiAuth: true });
 if (method === 'model/list') return reply(id, { data: [{ id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture',
   supportedReasoningEfforts: [{ reasoningEffort: 'low' }], nativeAssets: scenario.metadataNative,
   assetAudience: scenario.metadataNative ? 'native-session' : 'generic', nativeAssetHooks: scenario.metadataNative }], nextCursor: null });
 if (method === 'thread/start' || method === 'thread/resume') return reply(id, {
   thread: { id: 'readiness.thread:exact', sessionId: 'readiness.session:exact', turns: [], status: { type: 'idle' } },
   model: params.model, modelProvider: 'openai', cwd: process.cwd(), approvalPolicy: 'on-request', approvalsReviewer: 'user',
   sandbox: { type: 'readOnly', networkAccess: false }, nativeAssets: scenario.metadataNative });
 if (method === 'mcpServerStatus/list') {
   const tools = ++checks === 1 ? scenario.initial : scenario.preflight;
   return reply(id, { data: [{ name: 'arcane', runtimeStatus: 'connected', toolsError: null, pluginId: null,
     tools: Object.fromEntries(tools.map(name => [name, {}])), assetAudience: scenario.metadataNative ? 'native-session' : 'generic' }],
     nextCursor: null, nativeAssets: scenario.metadataNative, nativeAssetHooks: scenario.metadataNative });
 }
 if (method === 'turn/start') return reply(id, { turn: { id: 'readiness.turn:exact', status: 'completed' } });
 throw new Error('Unexpected synthetic method');
});
`;
async function fixture(t: test.TestContext, native: boolean, initial: readonly string[], preflight = initial) {
 const boundary = await realpath(tmpdir()), directory = await realpath(await mkdtemp(join(boundary, 'arcane-native-readiness-peer-')));
 const audit = join(directory, 'wire.jsonl'), lifecycle = { dispatched: 0, ended: 0, retired: 0 };
 const hooks = Object.freeze({ finalCredential() { assert.fail('Readiness never acquires a credential'); },
   dispatched() { lifecycle.dispatched++; }, ended() { lifecycle.ended++; }, retired() { lifecycle.retired++; } });
 // Opposing ambient/model/inventory routing claims cannot choose host capability.
 const env = nativeEnvironment(); env.ARCANE_ASSET_AUDIENCE = native ? 'generic' : 'native-session';
 const session = new CodexSession({ command: process.execPath,
   args: ['-e', PEER, JSON.stringify({ initial, preflight, metadataNative: !native }), audit], cwd: ROOT, env },
   limits({ requestTimeoutMs: 5000 }), 'spawned-node-fixture', 'arcane-only', native ? hooks : undefined);
 t.after(async () => {
   await session.close();
   const child = relative(boundary, await realpath(directory));
   assert.ok(!isAbsolute(child) && child.startsWith('arcane-native-readiness-peer-') && !child.includes(sep) && !child.includes('..'));
   await rm(directory, { recursive: true, force: true });
 });
 await session.initialize(); session.selectModel({ ...HUMAN, model: 'fixture-model', effort: 'low' });
 const receipts = async (): Promise<Wire[]> => (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Wire);
 return { session, lifecycle, receipts };
}
const calls = (wire: Wire[], method: string) => wire.filter(row => row.method === method);
const setup = (session: CodexSession, method: 'start' | 'resume') => method === 'start'
 ? session.startThread(HUMAN) : session.resumeThread({ ...HUMAN, threadId: THREAD });

for (const method of ['start', 'resume'] as const) for (const native of [false, true]) for (const missing of [ADOPT, CONVERT, PREPARE, STAGE, STATUS]) {
 test(`${method}: missing ${missing} ${native ? 'fences native' : 'allows generic'} setup despite opposing metadata`, async t => {
   const partial = native ? ARCANE_NATIVE_TOOL_NAMES.filter(name => name !== missing) : ARCANE_TOOL_NAMES;
   const f = await fixture(t, native, partial);
   if (native) {
     await assert.rejects(() => setup(f.session, method), { code: 'MCP_CAPABILITIES' });
     const state = f.session.snapshot();
     assert.equal(state.thread?.configured, false); assert.equal(state.thread?.writeGranted, false);
     assert.equal(state.operations[0]?.state, method === 'start' ? 'unknown' : 'not-sent'); assert.equal(state.ready, false);
     assert.equal(state.mcpIsolation, 'arcane-only-pending'); assert.equal(f.lifecycle.retired, 1);
     assert.equal(calls(await f.receipts(), 'turn/start').length, 0); assert.equal(f.lifecycle.dispatched, 0);
   } else {
     await setup(f.session, method); await f.session.startTurn(INPUT);
     assert.equal(f.session.snapshot().mcpIsolation, 'arcane-only-verified');
     assert.equal(calls(await f.receipts(), 'turn/start').length, 1);
   }
   for (const call of calls(await f.receipts(), 'mcpServerStatus/list')) assert.equal(call.params?.threadId, THREAD);
 });
 test(`${method}: fresh preflight missing ${missing} ${native ? 'revokes native authority without dispatch' : 'allows generic turn'}`, async t => {
   const inventory = native ? ARCANE_NATIVE_TOOL_NAMES : ARCANE_TOOL_NAMES;
   const partial = native ? ARCANE_NATIVE_TOOL_NAMES.filter(name => name !== missing) : ARCANE_TOOL_NAMES;
   const f = await fixture(t, native, inventory, partial);
   await setup(f.session, method); f.session.grantThreadWrites({ ...HUMAN, threadId: THREAD });
   const before = f.session.snapshot();
   if (native) {
     await assert.rejects(() => f.session.startTurn(INPUT), { code: 'MCP_CAPABILITIES', dispatched: false });
     const after = f.session.snapshot();
     assert.deepEqual(after.operations, before.operations); assert.equal(after.thread?.turnId, null);
     assert.equal(after.thread?.turnStatus, 'idle'); assert.equal(after.thread?.writeGranted, false);
     assert.equal(after.thread?.configured, false); assert.equal(after.ready, false);
     assert.equal(after.mcpIsolation, 'arcane-only-pending'); assert.deepEqual(after.approvals, []);
     assert.equal(f.lifecycle.retired, 1); assert.equal(f.lifecycle.dispatched, 0);
     await assert.rejects(() => f.session.startTurn(INPUT), { code: 'DISCONNECTED' });
     assert.equal(calls(await f.receipts(), 'turn/start').length, 0);
   } else {
     await f.session.startTurn(INPUT);
     assert.equal(calls(await f.receipts(), 'turn/start').length, 1);
     assert.equal(f.session.snapshot().thread?.writeGranted, true);
   }
   assert.equal(calls(await f.receipts(), 'mcpServerStatus/list').length, 2);
   for (const call of calls(await f.receipts(), 'mcpServerStatus/list')) assert.equal(call.params?.threadId, THREAD);
 });
}

test('complete native inventory passes setup and fresh preflight with hooks, even when metadata claims generic', async t => {
 const f = await fixture(t, true, ARCANE_NATIVE_TOOL_NAMES);
 await f.session.startThread(HUMAN); await f.session.startTurn(INPUT);
 assert.equal(f.session.snapshot().thread?.configured, true);
 assert.equal(f.session.snapshot().operations.at(-1)?.state, 'acknowledged');
 assert.equal(f.lifecycle.dispatched, 1); assert.equal(f.lifecycle.ended, 1); assert.equal(f.lifecycle.retired, 0);
 assert.equal(calls(await f.receipts(), 'mcpServerStatus/list').length, 2);
});

for (const native of [false, true]) for (const phase of ['setup', 'preflight'] as const) {
 test(`${native ? 'native' : 'generic'} still requires original build tools during ${phase}`, async t => {
   const inventory = native ? ARCANE_NATIVE_TOOL_NAMES : ARCANE_TOOL_NAMES;
   const partial = inventory.filter(name => name !== 'script_update');
   const f = await fixture(t, native, phase === 'setup' ? partial : inventory, partial);
   if (phase === 'preflight') await f.session.startThread(HUMAN);
   await assert.rejects(() => phase === 'setup' ? f.session.startThread(HUMAN) : f.session.startTurn(INPUT), { code: 'MCP_CAPABILITIES' });
   assert.equal(calls(await f.receipts(), 'turn/start').length, 0);
 });
}

test('actual generic and native MCP catalogues exactly match their reviewed readiness inventories', async t => {
 for (const native of [false, true]) {
   // Listing the real server over SDK in-memory transports makes no HTTP request.
   const daemon = new DaemonClient({ url: 'http://127.0.0.1:1', token: 'synthetic-readiness-bearer', assetAudience: native ? 'native-session' : 'generic' });
   const server = createMcpServer({ client: daemon, projectRoot: ROOT });
   const client = new Client({ name: 'readiness-fixture', version: '1' });
   const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
   t.after(async () => { await client.close(); await server.close(); });
   await server.connect(serverTransport); await client.connect(clientTransport);
   const names: string[] = (await client.listTools()).tools.map(tool => tool.name);
   assert.deepEqual([...names], [...(native ? ARCANE_NATIVE_TOOL_NAMES : ARCANE_TOOL_NAMES)]);
   assert.equal(names.includes(ADOPT), native); assert.equal(names.includes(PREPARE), native); assert.equal(names.includes(STAGE), native); assert.equal(names.includes(STATUS), native);
   assert.equal(names.includes('scene_import_context'), false);
   const row: McpInventoryRow = { name: 'arcane', runtimeStatus: 'connected', toolNames: names, toolsError: false, plugin: false, pluginId: null };
   assert.doesNotThrow(() => requireArcaneBuildTools([row], native));
   if (!native) assert.throws(() => requireArcaneBuildTools([row], true), { code: 'MCP_CAPABILITIES' });
 }
});
