import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { assertReviewedAssetTool, classifyJobState, classifyRefusal, decodeAssetSearch, decodeJobId, insertOutcome, insertNativeAsset, searchNativeAssets,
  startNativeGeneration, waitNativeJob, nativeAssetGenerateSchema, nativeAssetSearchSchema, nativeAssetInsertSchema, generatedMaterialName, NATIVE_ASSET_TOOLS, type NativeAssetContext } from '../../packages/studio-test-controller/src/native-assets.js';
import type { Scheduler } from '../../packages/studio-test-controller/src/contracts.js';
import { decodeTestMode } from '../../apps/daemon/src/studio-test-decoders.js';
import { createStudioTestService, type NativeTestConnection } from '../../apps/daemon/src/studio-test-service.js';
import { studioTestRoutes, type StudioTestRouteService } from '../../apps/daemon/src/studio-test-routes.js';
import { NATIVE_ASSET_RATE } from '../../apps/daemon/src/studio-native-assets.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { validateCommandArgs, sceneBuildInstanceCount } from '../../packages/core/src/studio-policy.js';
import { READ_METHODS, WRITE_METHODS, type Json, type StudioSession } from '../../packages/protocol/src/studio.js';
import { compileSceneBuild, sceneBuildShape, type SceneBuildInput } from '../../apps/mcp/src/scene-build.js';
import { DaemonClient } from '../../apps/mcp/src/daemon-client.js';
import { createMcpServer } from '../../apps/mcp/src/server.js';
import { STUDIO_ASSET_TOOLS } from '../../apps/mcp/src/native-asset-tools.js';
import { ARCANE_TOOL_NAMES, ARCANE_TASK_INSTRUCTIONS } from '../../packages/protocol/src/arcane-tools.js';
import { makeFixtureDirectory } from './windows-fixture-paths.js';
import { z } from 'zod';

// Scripted native peers only: the tool schemas come from the recorded built-in Studio MCP
// inventory (docs/research/native-studio-checks.json). No Studio executable is launched.
const STUDIO = 'studio-asset-fixture', NAME = 'Asset fixture place', MARKER = 'ArcaneTestProof_asset_fixture', ARTIFACT = 'b'.repeat(64);
const EDIT = '- Current Studio Mode: Edit\n- Available DataModels: Edit\n- Focused DataModel in the viewport: Edit';
const PLAY = '- Current Studio Mode: Play\n- Available DataModels: Client, Server\n- Focused DataModel in the viewport: Client';
const text = (value: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) });
const inventory = JSON.parse(readFileSync(join(process.cwd(), 'docs/research/native-studio-checks.json'), 'utf8')) as { runtime: { capabilityInventory: { tools: (Tool & { allowed?: unknown; blockedReason?: unknown })[] } } };
const RECORDED: Tool[] = inventory.runtime.capabilityInventory.tools
  .filter(tool => ['list_roblox_studios', 'get_studio_state', ...NATIVE_ASSET_TOOLS].includes(tool.name))
  .map(({ allowed: _allowed, blockedReason: _blocked, ...tool }) => tool as Tool);
const recorded = (name: string) => structuredClone(RECORDED.find(tool => tool.name === name)!);

type Reply = (name: string, args: Record<string, unknown>) => CallToolResult;
const SEARCH_REPLY = JSON.stringify({ results: [
  { assetId: 1001, name: 'Realistic Pine\u0007 Tree', creatorName: 'TreeMaker', creatorVerified: true, assetType: 'Model', price: 0, thumbnailUrl: 'https://tr.rbxcdn.com/abc/420/420/Image/Png' },
  { assetId: '2002', name: 'Paid Pine', creator: { name: 'Shop' }, price: 25 },
  { id: 'rbxassetid://3003', title: 'Pine Pack', isFree: true, thumbnailUrl: 'https://evil.example.com/x.png', source: 'creator_store' },
  { assetId: 'not-a-number', name: 'Broken' },
  { assetId: 4004, name: 'Spruce', assetType: 10, thumbnailAssetId: 5005 },
] });
const defaultReply: Reply = name => {
  if (name === 'search_asset') return text(SEARCH_REPLY);
  if (name === 'insert_asset') return text('Inserted asset into Workspace.');
  if (name === 'generate_mesh' || name === 'generate_material' || name === 'generate_texture') return text(JSON.stringify({ jobId: 'native-job-1', status: 'pending' }));
  if (name === 'wait_job_finished') return text(JSON.stringify({ status: 'completed' }));
  throw new Error('unexpected ' + name);
};
type Native = { mode: 'Edit' | 'Play'; calls: { name: string; args: Record<string, unknown> }[]; tools: Tool[]; reply: Reply; hang: string | null };
async function nativeFixture(t: TestContext, changes: Partial<Native> = {}) {
  const state: Native = { mode: 'Edit', calls: [], tools: structuredClone(RECORDED), reply: defaultReply, hang: null, ...changes };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fixture-asset-client', version: 'fixture-only' }, { capabilities: {} });
  const server = new Server({ name: 'RobloxStudio', version: 'fixture-only' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: structuredClone(state.tools) }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const call = { name: request.params.name, args: request.params.arguments ?? {} }; state.calls.push(structuredClone(call));
    assert.ok(!['execute_luau', 'start_stop_play', 'upload_image', 'store_image'].includes(call.name), 'asset tools never run Luau, Play or uploads');
    if (call.name === 'list_roblox_studios') return text(JSON.stringify({ studios: [{ id: STUDIO, name: NAME }] }));
    assert.equal(call.args.studio_id, STUDIO);
    if (call.name === 'get_studio_state') return text(state.mode === 'Edit' ? EDIT : PLAY);
    if (state.hang === call.name) return new Promise<CallToolResult>(() => {});
    return state.reply(call.name, call.args);
  });
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return { state, client };
}
/** Delays (2 s polls) run immediately; request deadlines never fire on their own. */
function fastScheduler(): Scheduler & { elapsed: () => number } {
  let now = 1_000_000;
  return { now: () => now, elapsed: () => now - 1_000_000, schedule(ms, callback) { if (ms === 2000) { now += ms; queueMicrotask(callback); } return () => {}; } };
}
const context = (client: Client, verify: () => Promise<string> = async () => 'evidence', scheduler?: Scheduler): NativeAssetContext =>
  ({ client, nativeStudioId: STUDIO, verifyBinding: verify, decodeMode: decodeTestMode, ...(scheduler ? { scheduler } : {}) });
const assetNames = (calls: Native['calls']) => calls.map(call => call.name).filter(name => (NATIVE_ASSET_TOOLS as readonly string[]).includes(name));

test('native asset tools: the recorded inventory passes the reviewed schema checks; widened or missing shapes are refused', () => {
  for (const name of NATIVE_ASSET_TOOLS) assert.doesNotThrow(() => assertReviewedAssetTool(recorded(name), name), name);
  const widen: [typeof NATIVE_ASSET_TOOLS[number], (tool: Tool) => void][] = [
    ['search_asset', tool => { tool.annotations = { ...tool.annotations, readOnlyHint: false }; }],
    ['search_asset', tool => { (tool.inputSchema.properties!.priceFilter as { enum: string[] }).enum = ['paid', 'all']; }],
    ['insert_asset', tool => { tool.inputSchema.required = [...tool.inputSchema.required!, 'parentPath']; }],
    ['insert_asset', tool => { tool.annotations = { ...tool.annotations, destructiveHint: true }; }],
    ['generate_mesh', tool => { (tool.inputSchema.properties!.size as { type: string }).type = 'array'; }],
    ['generate_material', tool => { (tool.inputSchema.properties!.baseMaterial as { enum: string[] }).enum = ['Plastic']; }],
    ['generate_texture', tool => { delete tool.inputSchema.properties!.instance_path; }],
    ['wait_job_finished', tool => { tool.inputSchema.required = ['jobId', 'studio_id', 'callback']; }],
  ];
  for (const [name, change] of widen) { const tool = recorded(name); change(tool); assert.throws(() => assertReviewedAssetTool(tool, name), { code: 'UNSUPPORTED_TOOL' }, name); }
  assert.throws(() => assertReviewedAssetTool(undefined, 'search_asset'), { code: 'UNSUPPORTED_TOOL' });
});

test('native asset decoding: free results only, sanitised names, allowlisted thumbnail hosts, job and refusal classification', () => {
  const decoded = decodeAssetSearch(SEARCH_REPLY, 10);
  assert.deepEqual(decoded.results.map(result => result.id), ['1001', '3003', '4004'], 'paid and malformed results are dropped');
  assert.deepEqual(decoded.results[0], { id: '1001', name: 'Realistic Pine Tree', creator: 'TreeMaker', type: 'Model', verifiedCreator: true, price: 'free',
    thumbnailId: null, thumbnailUrl: 'https://tr.rbxcdn.com/abc/420/420/Image/Png', source: null });
  assert.equal(decoded.results[1]!.thumbnailUrl, null, 'non-Roblox thumbnail hosts are dropped');
  assert.equal(decoded.results[1]!.source, 'creator_store');
  assert.deepEqual([decoded.results[2]!.type, decoded.results[2]!.thumbnailId], ['Model', '5005']);
  assert.equal(decodeAssetSearch('Found assets: ' + JSON.stringify([{ id: 7, name: 'Rock' }]) + ' (end)', 5).results[0]!.id, '7', 'embedded JSON is found');
  assert.equal(decodeAssetSearch(SEARCH_REPLY, 1).results.length, 1);
  assert.throws(() => decodeAssetSearch('no results here', 5), { code: 'BAD_NATIVE_RESPONSE' });
  assert.equal(decodeAssetSearch(JSON.stringify({ results: [{ id: 9, name: 'x'.repeat(500) }] }), 5).results[0]!.name.length, 100);
  assert.equal(decodeJobId('{"jobId":"abc-123","status":"queued"}'), 'abc-123');
  assert.equal(decodeJobId('Started generation. Job ID: gen_77 (poll wait_job_finished)'), 'gen_77');
  assert.equal(decodeJobId('{"jobId":"../etc"}'), null);
  assert.equal(classifyJobState('{"status":"completed"}', false), 'completed');
  assert.equal(classifyJobState('Timed out waiting for job; still running', false), 'running');
  assert.equal(classifyJobState('{"status":"failed"}', false), 'failed');
  assert.equal(classifyJobState('anything', true), 'failed');
  assert.equal(classifyRefusal('Please sign in to use generation'), 'sign_in');
  assert.equal(classifyRefusal('Rate limit exceeded'), 'quota');
  assert.equal(classifyRefusal('This feature is not enabled for your account'), 'unavailable');
  assert.equal(classifyRefusal('Prompt violates guidelines'), 'rejected');
  assert.equal(insertOutcome('Insert timed out; it probably succeeded, verify in Explorer', false), 'unconfirmed');
  assert.equal(insertOutcome('Asset is not available', true), 'refused');
  assert.equal(insertOutcome('Inserted', false), 'acknowledged');
});

test('native audio search: category Audio is search-only, free and licensed results with duration when provided', () => {
  const reply = JSON.stringify({ results: [
    { id: 501, name: 'Forest Birds Loop', assetType: 3, price: 0, duration: 62.456 },
    { id: 502, name: 'Paid Rain', price: 25, duration: 30 },
    { id: 503, name: 'Private Wind', isPublic: false, duration: 40 },
    { id: 504, name: 'Unlicensed Track', isLicensed: false },
    { id: 505, name: 'River', audioDuration: '18.5' },
    { id: 506, name: 'Odd Duration', duration: -3 },
  ] });
  const audio = decodeAssetSearch(reply, 10, true).results;
  assert.deepEqual(audio.map(result => result.id), ['501', '505', '506'], 'paid, private and unlicensed audio is dropped');
  assert.deepEqual([audio[0]!.type, audio[0]!.durationSeconds, audio[1]!.durationSeconds, audio[2]!.durationSeconds], ['Audio', 62.46, 18.5, undefined]);
  assert.equal(Object.hasOwn(decodeAssetSearch(reply, 10).results[0]!, 'durationSeconds'), false, 'non-audio searches never carry durations');
  assert.equal(nativeAssetSearchSchema.parse({ sessionId: 's1', query: 'forest birds', category: 'Audio' }).category, 'Audio');
  assert.throws(() => nativeAssetInsertSchema.parse({ sessionId: 's1', assetId: '501', category: 'Audio', watch: 'w' }), 'audio ids are never inserted');
});

test('native asset calls: exact reviewed arguments inside an Edit-mode binding bracket', async t => {
  const { state, client } = await nativeFixture(t);
  const search = await searchNativeAssets(context(client), nativeAssetSearchSchema.parse({ sessionId: 's1', query: 'pine tree', page: 2, pageSize: 2 }), AbortSignal.timeout(10_000));
  assert.deepEqual(state.calls.map(call => call.name), ['get_studio_state', 'search_asset', 'get_studio_state']);
  assert.deepEqual(state.calls[1]!.args, { query: 'pine tree', assetType: 'Model', priceFilter: 'free', maxResults: 4, studio_id: STUDIO });
  assert.deepEqual(search.results.map(result => result.id), ['4004'], 'page 2 of size 2 skips the first two free results');
  state.calls.length = 0;
  const inserted = await insertNativeAsset(context(client), { sessionId: 's1', assetId: '1001', category: 'MeshPart', watch: 'watch-aa-11' }, AbortSignal.timeout(10_000));
  assert.deepEqual(inserted, { assetName: 'ArcaneAsset_watchaa11', outcome: 'acknowledged' });
  assert.deepEqual(state.calls[1]!.args, { assetId: '1001', assetName: 'ArcaneAsset_watchaa11', assetType: 'MeshPart', studio_id: STUDIO }, 'no parentPath, no purchase fields');
  state.calls.length = 0;
  const mesh = await startNativeGeneration(context(client), nativeAssetGenerateSchema.parse({ sessionId: 's1', kind: 'mesh', prompt: 'carved stone pillar', size: [4, 16, 4], maxTriangles: 8000, watch: 'w1' }), 'nonce-1', AbortSignal.timeout(10_000));
  assert.deepEqual(mesh, { state: 'running', nativeJobId: 'native-job-1', refusal: null, materialVariant: null });
  assert.deepEqual(state.calls[1]!.args, { textPrompt: 'carved stone pillar', async: true, size: { x: 4, y: 16, z: 4 }, maxTriangles: 8000, studio_id: STUDIO });
  state.calls.length = 0;
  const material = await startNativeGeneration(context(client), nativeAssetGenerateSchema.parse({ sessionId: 's1', kind: 'material', prompt: 'mossy cobble path', baseMaterial: 'Cobblestone', pattern: 'Organic' }), 'abcd1234ef', AbortSignal.timeout(10_000));
  assert.equal(material.materialVariant, 'Arcane_MossyCobblePath_abcd1234');
  assert.deepEqual(state.calls[1]!.args, { materialId: 'Arcane_MossyCobblePath_abcd1234', baseMaterial: 'Cobblestone', materialPattern: 'Organic', materialDescription: 'mossy cobble path', async: true, studio_id: STUDIO });
  state.calls.length = 0;
  await startNativeGeneration(context(client), nativeAssetGenerateSchema.parse({ sessionId: 's1', kind: 'texture', prompt: 'weathered bronze', target: { root: 'Workspace', path: ['Plaza', 'Statue'] } }), 'n', AbortSignal.timeout(10_000));
  assert.deepEqual(state.calls[1]!.args, { textPrompt: 'weathered bronze', instance_path: 'game.Workspace.Plaza.Statue', studio_id: STUDIO });
  assert.equal(generatedMaterialName('!!!', 'zz'), 'Arcane_Material_zz');
  assert.throws(() => nativeAssetGenerateSchema.parse({ sessionId: 's1', kind: 'mesh', prompt: 'pillar' }), /watch/);
  assert.throws(() => nativeAssetGenerateSchema.parse({ sessionId: 's1', kind: 'material', prompt: 'moss', baseMaterial: 'Cobblestone', size: [1, 1, 1] }), /size/);
  assert.throws(() => nativeAssetGenerateSchema.parse({ sessionId: 's1', kind: 'texture', prompt: 'x\ny', target: { root: 'Workspace', path: ['A'] } }));
  assert.throws(() => nativeAssetGenerateSchema.parse({ sessionId: 's1', kind: 'texture', prompt: 'bronze', target: { root: 'Workspace', path: ['A.B'] } }));
  assert.throws(() => nativeAssetSearchSchema.parse({ sessionId: 's1', query: 'x'.repeat(101) }));
  assert.throws(() => nativeAssetSearchSchema.parse({ sessionId: 's1', query: 'pine', pageSize: 11 }));
  assert.throws(() => nativeAssetSearchSchema.parse({ sessionId: 's1', query: 'pine', priceFilter: 'all' }));
});

test('native asset calls: Play mode, widened tools, binding changes, refusals and lapsed inserts are handled without retries', async t => {
  const play = await nativeFixture(t, { mode: 'Play' });
  await assert.rejects(searchNativeAssets(context(play.client), nativeAssetSearchSchema.parse({ sessionId: 's1', query: 'pine' }), AbortSignal.timeout(5000)), { code: 'MODE_MISMATCH' });
  assert.deepEqual(assetNames(play.state.calls), [], 'nothing native runs outside Edit');
  const tools = structuredClone(RECORDED); tools.find(tool => tool.name === 'insert_asset')!.inputSchema.required!.push('parentPath');
  const widened = await nativeFixture(t, { tools });
  await assert.rejects(insertNativeAsset(context(widened.client), { sessionId: 's1', assetId: '1', category: 'Model', watch: 'w' }, AbortSignal.timeout(5000)), { code: 'UNSUPPORTED_TOOL' });
  assert.deepEqual(widened.state.calls, []);
  let reads = 0;
  const moved = await nativeFixture(t);
  await assert.rejects(insertNativeAsset(context(moved.client, async () => 'evidence-' + reads++), { sessionId: 's1', assetId: '1', category: 'Model', watch: 'w' }, AbortSignal.timeout(5000)), { code: 'EFFECT_UNKNOWN' });
  const refused = await nativeFixture(t, { reply: name => name === 'insert_asset' ? text('Asset 1 is not available for insertion', true) : defaultReply(name, {}) });
  await assert.rejects(insertNativeAsset(context(refused.client), { sessionId: 's1', assetId: '1', category: 'Model', watch: 'w' }, AbortSignal.timeout(5000)), { code: 'ASSET_INSERT_REFUSED' });
  assert.equal(assetNames(refused.state.calls).length, 1, 'refusals are never retried');
  const lapsed = await nativeFixture(t, { reply: name => name === 'insert_asset' ? text('Insert acknowledgement timed out; the asset was probably inserted, verify it', true) : defaultReply(name, {}) });
  assert.equal((await insertNativeAsset(context(lapsed.client), { sessionId: 's1', assetId: '1', category: 'Model', watch: 'w' }, AbortSignal.timeout(5000))).outcome, 'unconfirmed');
  const signIn = await nativeFixture(t, { reply: name => name === 'search_asset' ? text('You must be logged in to search the Creator Store', true) : defaultReply(name, {}) });
  await assert.rejects(searchNativeAssets(context(signIn.client), nativeAssetSearchSchema.parse({ sessionId: 's1', query: 'pine' }), AbortSignal.timeout(5000)), { code: 'NATIVE_SIGN_IN' });
  const disabled = await nativeFixture(t, { reply: name => name === 'generate_mesh' ? text('Mesh generation is not enabled for this account', true) : defaultReply(name, {}) });
  const failed = await startNativeGeneration(context(disabled.client), nativeAssetGenerateSchema.parse({ sessionId: 's1', kind: 'mesh', prompt: 'pillar', watch: 'w' }), 'n', AbortSignal.timeout(5000));
  assert.deepEqual([failed.state, failed.refusal], ['failed', 'unavailable']);
});

test('native generation wait: bounded polls of wait_job_finished in seconds until completion or the budget ends', async t => {
  let polls = 0;
  const { state, client } = await nativeFixture(t, { reply: (name, args) => name === 'wait_job_finished'
    ? text(++polls < 3 ? 'Timed out; job still running' : JSON.stringify({ status: 'completed' })) : defaultReply(name, args) });
  const scheduler = fastScheduler();
  assert.deepEqual(await waitNativeJob(context(client, undefined, scheduler), 'native-job-1', 30_000, AbortSignal.timeout(10_000)), { state: 'completed', refusal: null });
  const waits = state.calls.filter(call => call.name === 'wait_job_finished');
  assert.equal(waits.length, 3);
  assert.ok(waits.every(call => call.args.jobId === 'native-job-1' && Number.isInteger(call.args.timeout) && (call.args.timeout as number) >= 1 && (call.args.timeout as number) <= 15));
  const forever = await nativeFixture(t, { reply: (name, args) => name === 'wait_job_finished' ? text('still running') : defaultReply(name, args) });
  const slow = fastScheduler();
  assert.deepEqual(await waitNativeJob(context(forever.client, undefined, slow), 'job-2', 9_000, AbortSignal.timeout(10_000)), { state: 'running', refusal: null });
  assert.ok(forever.state.calls.filter(call => call.name === 'wait_job_finished').length <= 8, 'bounded attempts');
});

async function serviceFixture(t: TestContext, options: { mode?: 'Edit' | 'Play'; reply?: Reply } = {}) {
  const root = makeFixtureDirectory('arcane-studio-assets-');
  const store = new StudioStore({ directory: join(root, 'store') });
  const grant = store.createGrant({ allowedRoots: ['Workspace', 'ServerStorage'], allowWrites: true });
  const pair = store.pair({ code: grant.code, protocolVersion: 1, identity: { clientSessionId: 'plugin-asset-lifetime', placeId: 0, universeId: 0, name: NAME, pluginVersion: '0.2.0' },
    capabilities: [...READ_METHODS, ...WRITE_METHODS] });
  store.authenticate(pair.sessionId, pair.token);
  const proof = { sessionId: pair.sessionId, clientLifetimeId: 'plugin-asset-lifetime', pluginArtifactHash: ARTIFACT, markerName: MARKER,
    placeId: 0, universeId: 0, placeName: NAME, mode: options.mode ?? 'Edit', playEpoch: 2, continuitySupported: true, connected: true };
  store.poll(pair.sessionId, proof);
  const natives: Awaited<ReturnType<typeof nativeFixture>>[] = [];
  const connect = async (): Promise<NativeTestConnection> => {
    const native = await nativeFixture(t, options.reply ? { reply: options.reply } : {}); natives.push(native);
    return { client: native.client, evidence: 'fixture', async witness() {
      const s = store.session(pair.sessionId);
      return { placeId: 0, universeId: 0, placeName: s.name, sessionId: s.id, clientLifetimeId: s.clientSessionId, pluginArtifactHash: ARTIFACT };
    }, async close() {} };
  };
  const service = await createStudioTestService({ directory: join(root, 'service'), store, pluginArtifactHash: ARTIFACT, connect });
  t.after(async () => { await service.lifecycle.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  /** Plugin side of scene.asset_watch: a succeeded read receipt carrying the token. */
  const watch = (token: string) => {
    const command = store.enqueue({ sessionId: pair.sessionId, requestId: 'watch-' + token, method: 'scene.asset_watch', args: {} });
    store.poll(pair.sessionId, proof);
    store.result({ sessionId: pair.sessionId, commandId: command.id, state: 'succeeded', result: { watch: token, expiresInSeconds: 600 } });
  };
  return { service, store, pair, natives: () => natives, watch, assets: service.requests.nativeAssets };
}

test('native asset service: search remembers free ids; insert needs a searched id and a fresh plugin watch', async t => {
  const f = await serviceFixture(t);
  const found = await f.assets.search({ sessionId: f.pair.sessionId, query: 'pine tree' }, 'agent-fixture');
  assert.equal(found.search.nativeStudioId, STUDIO);
  assert.deepEqual(found.search.results.map(result => result.id), ['1001', '3003', '4004']);
  await assert.rejects(f.assets.insert({ sessionId: f.pair.sessionId, assetId: '2002', watch: 'watch-1' }, 'agent-fixture'), { code: 'ASSET_NOT_SEARCHED' }, 'paid results can never be inserted');
  await assert.rejects(f.assets.insert({ sessionId: f.pair.sessionId, assetId: '1001', watch: 'watch-1' }, 'agent-fixture'), { code: 'ASSET_WATCH_REQUIRED' });
  f.watch('watch-1');
  const inserted = await f.assets.insert({ sessionId: f.pair.sessionId, assetId: '1001', watch: 'watch-1' }, 'agent-fixture');
  assert.deepEqual(inserted.insert, { sessionId: f.pair.sessionId, nativeStudioId: STUDIO, assetId: '1001', assetName: 'ArcaneAsset_watch1', acknowledgement: 'acknowledged' });
  await assert.rejects(f.assets.insert({ sessionId: f.pair.sessionId, assetId: '1001', watch: 'watch-1', parentPath: 'game.Workspace' }, 'agent-fixture'));
  await assert.rejects(f.assets.search({ sessionId: 'missing-session', query: 'pine' }, 'agent-fixture'), { code: 'SESSION' });
});

test('native asset service: Play mode is refused before any native call; searches are rate limited', async t => {
  const play = await serviceFixture(t, { mode: 'Play' });
  await assert.rejects(play.assets.search({ sessionId: play.pair.sessionId, query: 'pine' }, 'agent-fixture'), { code: 'MODE_MISMATCH' });
  assert.equal(play.natives().length, 0);
  const f = await serviceFixture(t);
  for (let index = 0; index < NATIVE_ASSET_RATE.search; index++) await f.assets.search({ sessionId: f.pair.sessionId, query: 'rock ' + index }, 'agent-fixture');
  await assert.rejects(f.assets.search({ sessionId: f.pair.sessionId, query: 'one more' }, 'agent-fixture'), { code: 'RATE_LIMITED' });
});

test('native asset service: generation jobs complete, report variants, map refusals and stay caller-owned', async t => {
  const f = await serviceFixture(t);
  f.watch('watch-mesh');
  const mesh = await f.assets.generate({ sessionId: f.pair.sessionId, kind: 'mesh', prompt: 'carved stone pillar', size: [4, 16, 4], watch: 'watch-mesh' }, 'agent-fixture');
  assert.equal(mesh.job.state, 'completed'); assert.equal(mesh.job.watch, 'watch-mesh');
  await assert.rejects(f.assets.generate({ sessionId: f.pair.sessionId, kind: 'mesh', prompt: 'pillar', watch: 'never-armed' }, 'agent-fixture'), { code: 'ASSET_WATCH_REQUIRED' });
  const material = await f.assets.generate({ sessionId: f.pair.sessionId, kind: 'material', prompt: 'mossy cobble', baseMaterial: 'Cobblestone' }, 'agent-fixture');
  assert.match(material.job.materialVariant!, /^Arcane_MossyCobble_[A-Za-z0-9]{8}$/); assert.equal(material.job.baseMaterial, 'Cobblestone');
  assert.deepEqual(await f.assets.job({ jobId: material.job.jobId }, 'agent-fixture'), material, 'a finished job is read without native calls');
  await assert.rejects(f.assets.job({ jobId: material.job.jobId }, 'agent-other'), { code: 'ASSET_JOB_NOT_FOUND' });
  const refusing = await serviceFixture(t, { reply: (name, args) => name === 'generate_material' ? text('Quota exceeded: too many generations today', true) : defaultReply(name, args) });
  await assert.rejects(refusing.assets.generate({ sessionId: refusing.pair.sessionId, kind: 'material', prompt: 'moss', baseMaterial: 'Rock' }, 'agent-fixture'), { code: 'NATIVE_QUOTA' });
});

async function routeFixture(t: TestContext, nativeAssets: NonNullable<StudioTestRouteService['requests']['nativeAssets']>) {
  const refuse = async (): Promise<never> => { throw new Error('unused'); };
  const service: StudioTestRouteService = { requests: { prepare: refuse, status: refuse, list: refuse, cancel: refuse, nativeAssets },
    humanControl: { approve: refuse }, lifecycle: { async close() {} } };
  const route = studioTestRoutes(service, request => request.headers.authorization === 'Bearer agent-token' ? { kind: 'agent', id: 'agent-fixture' } : null);
  let origin = '';
  const server = createServer((request, response) => { void route(request, response, new URL(request.url ?? '/', origin), origin); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return (path: string, body: unknown) => new Promise<{ status: number; json: any }>((resolve, reject) => {
    const outgoing = httpRequest(origin + path, { method: 'POST', agent: false, headers: { Authorization: 'Bearer agent-token', 'Content-Type': 'application/json' } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk)); response.once('end', () => resolve({ status: response.statusCode!, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    outgoing.once('error', reject); outgoing.end(JSON.stringify(body));
  });
}

test('native asset routes: closed fields, fixed refusal messages and no native text leakage', async t => {
  const seen: unknown[] = [];
  const ok = async (input: unknown, actor: string) => { seen.push({ input, actor }); return { search: { results: [] } }; };
  const post = await routeFixture(t, { search: ok as never, insert: ok as never, generate: ok as never, job: ok as never });
  assert.equal((await post('/v1/studio-native/asset-search', { sessionId: 's1', query: 'pine' })).status, 200);
  assert.deepEqual(seen, [{ input: { sessionId: 's1', query: 'pine' }, actor: 'agent-fixture' }]);
  assert.equal((await post('/v1/studio-native/asset-search', { sessionId: 's1', query: 'pine', code: 'print(1)' })).status, 400);
  assert.equal((await post('/v1/studio-native/asset-insert', { sessionId: 's1', assetId: '1', watch: 'w', parentPath: 'game' })).status, 400);
  assert.equal((await post('/v1/studio-native/asset-unknown', {})).status, 404);
  assert.equal(seen.length, 1);
  const SECRET = 'native internal detail 8f2c';
  for (const [code, expected, status] of [['UNSUPPORTED_TOOL', 'NATIVE_ASSET_TOOL_UNSUPPORTED', 422], ['BAD_NATIVE_RESPONSE', 'NATIVE_ASSET_INVALID', 424],
    ['EFFECT_UNKNOWN', 'NATIVE_ASSET_UNKNOWN', 409], ['PLACE_DENIED', 'NATIVE_PLACE_DENIED', 403], ['NATIVE_SIGN_IN', 'NATIVE_SIGN_IN', 424],
    ['RATE_LIMITED', 'RATE_LIMITED', 429], ['ASSET_NOT_SEARCHED', 'ASSET_NOT_SEARCHED', 409], ['MODE_MISMATCH', 'MODE_MISMATCH', 409], ['WEIRD', 'NATIVE_ASSET_FAILED', 424]] as const) {
    const failing = async () => { throw Object.assign(new Error(SECRET), { code }); };
    const refusing = await routeFixture(t, { search: failing, insert: failing, generate: failing, job: failing });
    const response = await refusing('/v1/studio-native/asset-search', { sessionId: 's1', query: 'pine' });
    assert.deepEqual([response.status, response.json.error], [status, expected]);
    assert.equal(JSON.stringify(response.json).includes(SECRET), false, 'native/raw error text never crosses the route');
  }
});

const ROOT = (sessionId: string) => ({ instanceId: 'opaque-root', sessionId, root: 'Workspace' as const, pathSegments: [], className: 'Workspace' });
const TEMPLATE = (sessionId: string) => ({ instanceId: 'opaque-pine', sessionId, root: 'ServerStorage' as const, pathSegments: ['Templates', 'Pine'], className: 'Model' });
const session = (capabilities: string[] = [...READ_METHODS, ...WRITE_METHODS]): StudioSession => ({
  id: 'asset-session', protocolVersion: 1, clientSessionId: 'lifetime', placeId: 0, universeId: 0, name: 'Fixture', pluginVersion: '0.2.0',
  allowedRoots: ['Workspace', 'ServerStorage'], allowWrites: true, capabilities, connectedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), revokedAt: null });

test('policy: placement, material and clone items are bounded, scoped and need the updated plugin', () => {
  const place = { watch: 'watch-1', parent: TEMPLATE('asset-session'), name: 'Pine', position: [0, 0, 0], yaw: 0, ground: true, anchor: true, allowScripts: false, maxSize: [10, 30, 10] };
  assert.doesNotThrow(() => validateCommandArgs('scene.place_asset', place, session()));
  assert.throws(() => validateCommandArgs('scene.place_asset', { ...place, maxSize: [10, 3000, 10] }, session()), /maxSize/);
  assert.throws(() => validateCommandArgs('scene.place_asset', { ...place, parentPath: 'game.Workspace' }, session()), /Unexpected/);
  assert.throws(() => validateCommandArgs('scene.place_asset', { ...place, allowScripts: 'yes' }, session()), /allowScripts/);
  assert.throws(() => validateCommandArgs('scene.place_asset', { ...place, parent: TEMPLATE('other-session') }, session()), /scope/);
  const old = session(['scene.children', 'scene.build']);
  assert.throws(() => validateCommandArgs('scene.place_asset', place, old), { code: 'PLUGIN_UPDATE_REQUIRED' });
  assert.throws(() => validateCommandArgs('scene.asset_watch', {}, old), { code: 'PLUGIN_UPDATE_REQUIRED' });
  const refs = Array.from({ length: 65 }, (_, index) => ({ ...ROOT('asset-session'), instanceId: 'part-' + index, className: 'Part' }));
  assert.doesNotThrow(() => validateCommandArgs('scene.apply_material', { refs: refs.slice(0, 64), material: 'Cobblestone', variant: 'Arcane_Moss_ab' }, session()));
  assert.throws(() => validateCommandArgs('scene.apply_material', { refs, material: 'Cobblestone', variant: 'Arcane_Moss_ab' }, session()), /1\.\.64/);
  assert.throws(() => validateCommandArgs('scene.apply_material', { refs: refs.slice(0, 1), material: 'Lava', variant: 'v' }, session()), /base material/);
  assert.throws(() => validateCommandArgs('scene.apply_material', { refs: refs.slice(0, 1), material: 'Rock', variant: 'bad name' }, session()), /variant/);
  const parse = (input: Record<string, unknown>) => z.strictObject(sceneBuildShape).parse(input) as SceneBuildInput;
  const compiled = compileSceneBuild(parse({ name: 'Forest', templates: { Pine: TEMPLATE('asset-session') }, prototypes: { Bush: { parts: [{ name: 'Ball', props: { Shape: 'Ball', Size: [2, 2, 2] } }] } },
    items: [{ use: 'Pine', at: [0, 0, 0], key: 'Hero', ground: true }], scatter: [{ use: ['Pine', 'Bush'], count: 40, center: [0, 0, 0], radius: 120, minSpacing: 8, ground: true }] }), ROOT('asset-session') as unknown as Json);
  const items = compiled.args.items as { kind: string; template: number }[];
  assert.equal(items[0]!.kind, 'clone'); assert.ok(items.some(item => item.kind === 'place') && items.some(item => item.kind === 'clone'));
  assert.ok(items.filter(item => item.kind === 'clone').every(item => item.template === 1 && !('tint' in item)));
  assert.deepEqual(compiled.args.templates, [TEMPLATE('asset-session')]);
  assert.deepEqual(validateCommandArgs('scene.build', structuredClone(compiled.args), session()).templates, compiled.args.templates);
  assert.equal(sceneBuildInstanceCount(compiled.args), compiled.instances);
  assert.throws(() => validateCommandArgs('scene.build', compiled.args, session(['scene.build', 'scene.children'])), { code: 'PLUGIN_UPDATE_REQUIRED' });
  assert.throws(() => validateCommandArgs('scene.build', { ...compiled.args, items: [{ ...items[0], template: 2 }] }, session()), /template index/);
  assert.throws(() => validateCommandArgs('scene.build', { ...compiled.args, items: [{ ...items[0], tint: [1, 1, 1] }] }, session()), /Unexpected/);
  assert.throws(() => compileSceneBuild(parse({ name: 'X', templates: { Pine: TEMPLATE('asset-session') }, prototypes: { Pine: { parts: [{ name: 'P' }] } }, items: [{ use: 'Pine', at: [0, 0, 0] }] }), ROOT('asset-session') as unknown as Json), /both a prototype and a template/);
});

test('store: placement and clone-build receipts are validated and restorable', t => {
  const root = makeFixtureDirectory('arcane-asset-receipts-');
  const store = new StudioStore({ directory: join(root, 'store') });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const grant = store.createGrant({ allowedRoots: ['Workspace', 'ServerStorage'], allowWrites: true });
  const pair = store.pair({ code: grant.code, protocolVersion: 1, identity: { clientSessionId: 'receipt-window', placeId: 0, universeId: 0, name: 'Fixture', pluginVersion: '0.2.0' },
    capabilities: [...READ_METHODS, ...WRITE_METHODS] });
  const placeRef = { ...TEMPLATE(pair.sessionId) };
  const place = store.enqueue({ sessionId: pair.sessionId, requestId: 'place-asset-1', method: 'scene.place_asset',
    args: { watch: 'w-1', parent: { ...ROOT(pair.sessionId) }, name: 'Pine', position: [0, 0, 0], yaw: 0, ground: true, anchor: true, allowScripts: false } });
  store.poll(pair.sessionId);
  const receipt = (after: Record<string, Json>) => ({ ref: placeRef, removedScripts: { count: 2, classes: {}, names: [] }, mutation: { kind: 'scene.place_asset', ref: placeRef, before: null, after } });
  assert.throws(() => store.result({ sessionId: pair.sessionId, commandId: place.id, state: 'succeeded', result: receipt({ descendants: 3, removedScripts: 2, keptScripts: 1, scale: 1 }) }), /exact adoption/, 'scripts may not survive without allowScripts');
  store.result({ sessionId: pair.sessionId, commandId: place.id, state: 'succeeded', result: receipt({ descendants: 3, removedScripts: 2, keptScripts: 0, scale: 0.5 }) });
  const restore = store.restore({ commandId: place.id, requestId: 'place-restore-1' });
  assert.equal(restore.method, 'scene.restore'); assert.equal((restore.args.mutation as { kind: string }).kind, 'scene.place_asset');
  store.poll(pair.sessionId);
  store.result({ sessionId: pair.sessionId, commandId: restore.id, state: 'succeeded', result: { restored: true, ref: placeRef } });
  const build = store.enqueue({ sessionId: pair.sessionId, requestId: 'clone-build-1', method: 'scene.build', args: { parent: ROOT(pair.sessionId), container: { className: 'Model', name: 'Forest' },
    prototypes: [], templates: [TEMPLATE(pair.sessionId)], items: [{ kind: 'clone', template: 1, name: 'Pine', parent: 0, at: [0, 0, 0], yaw: 0, scale: 1 }] } });
  store.poll(pair.sessionId);
  const forestRef = { instanceId: 'opaque-forest', sessionId: pair.sessionId, root: 'Workspace', pathSegments: ['Forest'], className: 'Model' };
  const built = (count: number) => ({ ref: forestRef, refs: {}, created: { count, classes: { Model: 2 } }, mutation: { kind: 'scene.build', ref: forestRef, before: null, after: { count, classes: { Model: 2 } } } });
  assert.throws(() => store.result({ sessionId: pair.sessionId, commandId: build.id, state: 'succeeded', result: built(1) }), /exact requested hierarchy/);
  store.result({ sessionId: pair.sessionId, commandId: build.id, state: 'succeeded', result: built(14) });
  assert.equal(store.command(build.id).state, 'succeeded');
});

test('MCP: asset tools are registered with bounded schemas; insert arms a watch, inserts natively, then adopts with scripts stripped', async t => {
  const posts: { path: string; body: any }[] = [];
  const commandRecord = (body: any, result: Json) => ({ command: { protocolVersion: 1, id: 'cmd-' + posts.length, requestId: body.requestId, sessionId: body.sessionId, clientSessionId: 'lifetime',
    method: body.method, args: body.args, allowedRoots: ['Workspace', 'ServerStorage'], allowWrites: true, leaseEpoch: posts.length, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    state: 'succeeded', createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), result, error: null } });
  const daemon = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(chunk));
    request.once('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; posts.push({ path: request.url!, body });
      let reply: unknown;
      if (request.url === '/v1/studio/commands' && body.method === 'scene.asset_watch') reply = commandRecord(body, { watch: 'watch-mcp', expiresInSeconds: 600 });
      else if (request.url === '/v1/studio/commands' && body.method === 'scene.place_asset') {
        const ref = { instanceId: 'opaque-pine', sessionId: body.sessionId, root: 'ServerStorage', pathSegments: ['Templates', 'Pine'], className: 'Model' };
        reply = commandRecord(body, { ref, removedScripts: { count: 2, classes: { Script: 2 }, names: ['Spread', 'Lag'] }, keptScripts: 0, scale: 0.5, grounded: true,
          mutation: { kind: 'scene.place_asset', ref, before: null, after: { descendants: 4, removedScripts: 2, keptScripts: 0, scale: 0.5 } } });
      } else if (request.url === '/v1/studio-native/asset-insert') reply = { insert: { sessionId: body.sessionId, nativeStudioId: STUDIO, assetId: body.assetId, assetName: 'ArcaneAsset_watchmcp', acknowledgement: 'acknowledged' } };
      else if (request.url === '/v1/studio-native/asset-search') reply = { search: { sessionId: body.sessionId, nativeStudioId: STUDIO, query: body.query, category: 'Model', page: 1, pageSize: 8, hasMore: false,
        results: [{ id: '1001', name: 'Pine', creator: 'TreeMaker', type: 'Model', verifiedCreator: true, price: 'free', thumbnailId: null, thumbnailUrl: null, source: null }] } };
      else { response.writeHead(404, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'NOT_FOUND', message: 'unused' })); return; }
      const json = JSON.stringify(reply); response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) }); response.end(json);
    });
  });
  await new Promise<void>(resolve => daemon.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { daemon.closeAllConnections(); daemon.close(() => resolve()); }));
  const client = new DaemonClient({ url: 'http://127.0.0.1:' + (daemon.address() as { port: number }).port, token: 'fixture-asset-token', pollIntervalMs: 5 });
  const server = createMcpServer({ client, projectRoot: process.cwd() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'fixture-asset-mcp', version: 'fixture-only' }, { capabilities: {} });
  await server.connect(serverTransport); await mcp.connect(clientTransport);
  t.after(async () => { await mcp.close(); await server.close(); });
  const tools = (await mcp.listTools()).tools;
  assert.deepEqual(tools.map(item => item.name).sort(), [...ARCANE_TOOL_NAMES].sort());
  for (const name of STUDIO_ASSET_TOOLS) assert.ok(ARCANE_TOOL_NAMES.includes(name as never), name);
  const search = tools.find(tool => tool.name === 'studio_asset_search')!, insert = tools.find(tool => tool.name === 'studio_asset_insert')!;
  assert.equal(search.annotations?.readOnlyHint, true); assert.equal(insert.annotations?.readOnlyHint, false); assert.equal(insert.inputSchema.additionalProperties, false);
  assert.match(insert.description ?? '', /removes every Script\/LocalScript\/ModuleScript/);
  const sessionId = 'paired-fixture', parent = { instanceId: 'opaque-templates', sessionId, root: 'ServerStorage', pathSegments: ['Templates'], className: 'Folder' };
  const found = CallToolResultSchema.parse(await mcp.callTool({ name: 'studio_asset_search', arguments: { sessionId, query: 'pine tree' } }));
  assert.notEqual(found.isError, true);
  const result = CallToolResultSchema.parse(await mcp.callTool({ name: 'studio_asset_insert', arguments: { sessionId, assetId: '1001', parent, name: 'Pine', position: [0, 0, 0], maxSize: [10, 30, 10] } }));
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  const steps = posts.filter(post => post.body).map(post => post.path === '/v1/studio/commands' ? post.body.method : post.path);
  assert.deepEqual(steps, ['/v1/studio-native/asset-search', 'scene.asset_watch', '/v1/studio-native/asset-insert', 'scene.place_asset']);
  assert.deepEqual(posts.find(post => post.path === '/v1/studio-native/asset-insert')!.body, { sessionId, assetId: '1001', category: 'Model', watch: 'watch-mcp' });
  const placement = posts.find(post => post.body?.method === 'scene.place_asset')!.body.args;
  assert.deepEqual(placement, { watch: 'watch-mcp', expectName: 'ArcaneAsset_watchmcp', parent, name: 'Pine', maxSize: [10, 30, 10], position: [0, 0, 0], yaw: 0, ground: true, anchor: true, allowScripts: false });
  const summary = JSON.parse((result.content[0] as { text: string }).text);
  assert.equal(summary.placement.state, 'succeeded'); assert.equal(summary.placement.result.removedScripts.count, 2); assert.match(summary.nextStep, /studio_viewport_capture/);
  const before = posts.length;
  for (const [name, args] of [
    ['studio_asset_search', { sessionId, query: 'x'.repeat(101) }], ['studio_asset_search', { sessionId, query: 'pine', pageSize: 11 }],
    ['studio_asset_search', { sessionId, query: 'pine', priceFilter: 'all' }], ['studio_asset_insert', { sessionId, assetId: '12ab', parent, name: 'P', position: [0, 0, 0] }],
    ['studio_asset_insert', { sessionId, assetId: '1001', parent, name: 'P', position: [0, 0, 0], maxSize: [1, 1, 5000] }],
    ['studio_asset_insert', { sessionId, assetId: '1001', parent, name: 'P', position: [0, 0, 0], parentPath: 'game.Workspace' }],
    ['studio_asset_generate', { sessionId, kind: 'mesh', prompt: 'p\u0000illar' }], ['studio_asset_generate', { sessionId, kind: 'mesh', prompt: 'pillar', maxTriangles: 99_999 }],
    ['studio_asset_generate', { sessionId, kind: 'mesh', prompt: 'pillar' }],
  ] as const) assert.equal(CallToolResultSchema.parse(await mcp.callTool({ name, arguments: args })).isError, true, name + JSON.stringify(args));
  assert.equal(posts.length, before, 'invalid inputs never reach the daemon');
});

test('instructions: original assets are the default and Toolbox models require explicit requests', () => {
  assert.match(ARCANE_TASK_INSTRUCTIONS, /Original assets by default/);
  assert.match(ARCANE_TASK_INSTRUCTIONS, /Do not search for or insert Toolbox\/Creator Store models unless the user explicitly requests them/);
  assert.match(ARCANE_TASK_INSTRUCTIONS, /realism or general permission to build is not that request/);
  assert.match(ARCANE_TASK_INSTRUCTIONS, /assets_procedural\/Blender with assets_preview, or studio_asset_generate/);
  assert.match(ARCANE_TASK_INSTRUCTIONS, /Never buy or publish assets/);
  assert.match(ARCANE_TASK_INSTRUCTIONS, /studio_viewport_capture, critique the image against the request, then fix what you see/);
  assert.doesNotMatch(ARCANE_TASK_INSTRUCTIONS, /studio_asset_search first|studio_asset_generate only when nothing suitable exists/);
  for (const skill of ['arcane-natural-scenes', 'arcane-architectural-features', 'arcane-photoreal', 'arcane-world-building']) {
    const body = readFileSync(join(process.cwd(), 'skills/arcane', skill, 'SKILL.md'), 'utf8');
    assert.match(body, /user explicitly requests Toolbox models/, skill);
    assert.match(body, /studio_asset_search/, skill); assert.match(body, /studio_asset_insert/, skill); assert.match(body, /studio_viewport_capture/, skill);
    assert.doesNotMatch(body, /Creator Store asset first|Real assets first/, skill);
  }
});
