import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { assertReviewedAssetTool, classifyJobState, classifyRefusal, decodeAssetSearch, decodeJobId, insertOutcome, insertNativeAsset, searchNativeAssets,
  startNativeGeneration, waitNativeJob, nativeAssetGenerateSchema, nativeAssetSearchSchema, nativeAssetInsertSchema, generatedMaterialName, NATIVE_ASSET_TOOLS, type NativeAssetContext } from '../../packages/studio-test-controller/src/native-assets.js';
import {digest,type Scheduler} from '../../packages/studio-test-controller/src/contracts.js';
import type {StudioTestTaskSettled} from '../../packages/protocol/src/chat-task-playtest.js';
import { decodeTestMode } from '../../apps/daemon/src/studio-test-decoders.js';
import { createStudioTestService, type NativeTestConnection } from '../../apps/daemon/src/studio-test-service.js';
import { studioTestRoutes, type StudioTestRouteService } from '../../apps/daemon/src/studio-test-routes.js';
import { NATIVE_ASSET_RATE } from '../../apps/daemon/src/studio-native-assets.js';
import {createNativeAssetRegistry,type NativeAssetActor} from '../../apps/daemon/src/native-asset-authority.js';
import {captureModelSourceBinding} from '../../apps/daemon/src/model-source-binding.js';
import {studioRoutes} from '../../apps/daemon/src/studio-routes.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import {workflowProjectIdentity} from '../../packages/storage/src/workflow-store.js';
import { validateCommandArgs, sceneBuildInstanceCount } from '../../packages/core/src/studio-policy.js';
import {recordReviewedOriginalRun} from '../helpers/asset-review-boundary-fixture.js';
import { READ_METHODS, WRITE_METHODS,ASSET_STAGE_METHODS, type Json, type StudioSession } from '../../packages/protocol/src/studio.js';
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
type Native = { mode: 'Edit' | 'Play'; calls: { name: string; args: Record<string, unknown> }[]; tools: Tool[]; reply: Reply; hang: string | null;
  beforeCall?: (name: string) => Promise<void> | void };
async function nativeFixture(t: TestContext, changes: Partial<Native> = {}) {
  const state: Native = { mode: 'Edit', calls: [], tools: structuredClone(RECORDED), reply: defaultReply, hang: null, ...changes };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fixture-asset-client', version: 'fixture-only' }, { capabilities: {} });
  const server = new Server({ name: 'RobloxStudio', version: 'fixture-only' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: structuredClone(state.tools) }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const call = { name: request.params.name, args: request.params.arguments ?? {} }; state.calls.push(structuredClone(call));
    await state.beforeCall?.(call.name);
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

async function serviceFixture(t: TestContext, options: { mode?: 'Edit' | 'Play'; reply?: Reply; allowModels?:boolean;reviewedOriginal?:boolean;
  beforeCall?: Native['beforeCall']; afterNativeClose?: () => void } = {}) {
  const root = makeFixtureDirectory('arcane-studio-assets-');
  const store = new StudioStore({ directory: join(root, 'store') });
  const grant = store.createGrant({ allowedRoots: ['Workspace', 'ServerStorage'], allowWrites: true });
  const pair = store.pair({ code: grant.code, protocolVersion: 1, identity: { clientSessionId: 'plugin-asset-lifetime', placeId: 0, universeId: 0, name: NAME, pluginVersion: '0.2.0' },
    capabilities: [...READ_METHODS, ...WRITE_METHODS,...(options.reviewedOriginal?ASSET_STAGE_METHODS:[])] });
  store.authenticate(pair.sessionId, pair.token);
  const proof = { sessionId: pair.sessionId, clientLifetimeId: 'plugin-asset-lifetime', pluginArtifactHash: ARTIFACT, markerName: MARKER,
    placeId: 0, universeId: 0, placeName: NAME, mode: options.mode ?? 'Edit', playEpoch: 2, continuitySupported: true, connected: true };
  store.poll(pair.sessionId, proof);
  const registry=createNativeAssetRegistry({projectPath:root,modelSourceBinding:sessionId=>captureModelSourceBinding(store,sessionId)});
  const task=registry.issue(),taskToken=task.credential(),binding={connectionId:'original-human-connection',threadId:'original-human-thread'};
  task.seal({...binding,provider:'codex',sessionId:null});task.grant(binding);
  // Native-effect fixtures explicitly admit one original human message. The
  // manual checkbox below does not supply this task execution capability.
  if(options.allowModels!==false&&options.mode!=='Play')task.grantModelSource(pair.sessionId);
  task.dispatched({...binding,operationId:'original-human-message'});
  const capture=()=>registry.capture(taskToken,'mutate');
  const scope=()=>({guard(){},signal:new AbortController().signal,dispatched(){},modelSource:capture()});
  const natives: Awaited<ReturnType<typeof nativeFixture>>[] = [];
  const connect = async (): Promise<NativeTestConnection> => {
    const native = await nativeFixture(t, { ...(options.reply ? { reply: options.reply } : {}), ...(options.beforeCall ? { beforeCall: options.beforeCall } : {}) }); natives.push(native);
    return { client: native.client, evidence: 'fixture', async witness() {
      const s = store.session(pair.sessionId);
      return { placeId: 0, universeId: 0, placeName: s.name, sessionId: s.id, clientLifetimeId: s.clientSessionId, pluginArtifactHash: ARTIFACT };
    }, async close() { options.afterNativeClose?.(); } };
  };
  const service = await createStudioTestService({ directory: join(root, 'service'), store, custody: store.bindNativeCustody(workflowProjectIdentity(root).projectId, join(root, 'store')), pluginArtifactHash: ARTIFACT, connect,revokeModelSource:sessionId=>registry.revokeModelSource(sessionId) });
  if(options.allowModels!==false&&options.mode!=='Play')service.humanControl.toolboxPolicy({sessionId:pair.sessionId,allowModels:true},()=>{});
  t.after(async () => { await service.lifecycle.close();registry.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  /** Plugin side of scene.asset_watch: a succeeded read receipt carrying the token. */
  const watch = (token: string) => {
    const command = store.enqueue({ sessionId: pair.sessionId, requestId: 'watch-' + token, method: 'scene.asset_watch', args: {} });
    store.poll(pair.sessionId, proof);
    store.result({ sessionId: pair.sessionId, commandId: command.id, state: 'succeeded', result: { watch: token, expiresInSeconds: 600 } });
  };
  return { root,service, store, pair, proof, natives: () => natives, watch, assets: service.requests.nativeAssets,registry,task,taskToken,binding,capture,scope };
}

test('native asset service: search remembers free ids; insert needs a searched id and a fresh plugin watch', async t => {
  const f = await serviceFixture(t);
  const found = await f.assets.search({ sessionId: f.pair.sessionId, query: 'pine tree' }, 'agent-fixture',f.scope());
  assert.equal(found.search.nativeStudioId, STUDIO);
  assert.deepEqual(found.search.results.map(result => result.id), ['1001', '3003', '4004']);
  await assert.rejects(f.assets.insert({ sessionId: f.pair.sessionId, assetId: '2002', watch: 'watch-1' }, 'agent-fixture',f.scope()), { code: 'ASSET_NOT_SEARCHED' }, 'paid results can never be inserted');
  await assert.rejects(f.assets.insert({ sessionId: f.pair.sessionId, assetId: '1001', watch: 'watch-1' }, 'agent-fixture',f.scope()), { code: 'ASSET_WATCH_REQUIRED' });
  f.watch('watch-1');
  const inserted = await f.assets.insert({ sessionId: f.pair.sessionId, assetId: '1001', watch: 'watch-1' }, 'agent-fixture',f.scope());
  assert.deepEqual(inserted.insert, { sessionId: f.pair.sessionId, nativeStudioId: STUDIO, assetId: '1001', assetName: 'ArcaneAsset_watch1', acknowledgement: 'acknowledged' });
  await assert.rejects(f.assets.insert({ sessionId: f.pair.sessionId, assetId: '1001', watch: 'watch-1', parentPath: 'game.Workspace' }, 'agent-fixture'));
  await assert.rejects(f.assets.search({ sessionId: 'missing-session', query: 'pine' }, 'human'), { code: 'SESSION' });
});

test('native asset service: Play mode is refused before any native call; searches are rate limited', async t => {
  const play = await serviceFixture(t, { mode: 'Play' });
  await assert.rejects(play.assets.search({ sessionId: play.pair.sessionId, query: 'pine',category:'Audio' }, 'agent-fixture'), { code: 'MODE_MISMATCH' });
  assert.equal(play.natives().length, 0);
  const f = await serviceFixture(t);
  for (let index = 0; index < NATIVE_ASSET_RATE.search; index++) {
    // This long rate-inventory fixture represents a live paired plugin. Renew
    // its actual same-epoch heartbeat rather than extending the 6s proof bound.
    assert.deepEqual(f.store.poll(f.pair.sessionId,f.proof),[]);
    await f.assets.search({ sessionId: f.pair.sessionId, query: 'rock ' + index }, 'agent-fixture',f.scope());
  }
  await assert.rejects(f.assets.search({ sessionId: f.pair.sessionId, query: 'one more' }, 'agent-fixture',f.scope()), { code: 'RATE_LIMITED' });
  assert.equal(f.natives().flatMap(native=>assetNames(native.state.calls)).filter(name=>name==='search_asset').length,NATIVE_ASSET_RATE.search);
});

test('native asset service: Blender authoring policy refuses every Studio AI kind before any native connection',async t=>{
 const f=await serviceFixture(t);
 for(const actor of ['agent-fixture','human'])for(const input of [
  {kind:'mesh',prompt:'carved pillar',watch:'watch-mesh'},
  {kind:'material',prompt:'mossy cobble',baseMaterial:'Rock'},
  {kind:'texture',prompt:'weathered bark',target:{root:'Workspace',path:['Tree']}}
 ])await assert.rejects(f.assets.generate({sessionId:f.pair.sessionId,...input},actor),{code:'BLENDER_REQUIRED'});
 assert.equal(f.natives().length,0,'refusal cannot connect to Studio or consume a native generation');
});

async function routeFixture(t: TestContext, nativeAssets: NonNullable<StudioTestRouteService['requests']['nativeAssets']>, toolboxPolicy?:StudioTestRouteService['humanControl']['toolboxPolicy'], lifecycle: { actorCurrent?: () => boolean; closed?: () => void;captureModelSource?:()=>NativeAssetActor } = {}) {
  const refuse = async (): Promise<never> => { throw new Error('unused'); };
  const service: StudioTestRouteService = { requests: { prepare: refuse, status: refuse, list: refuse, cancel: refuse, nativeAssets },
    humanControl: { approve: refuse,...(toolboxPolicy?{toolboxPolicy}:{}) }, lifecycle: { async close() {} } };
  const route = studioTestRoutes(service, request => lifecycle.actorCurrent?.() === false ? null : request.headers.authorization === 'Bearer agent-token' ? { kind: 'agent', id: 'agent-fixture' } : request.headers.authorization === 'Bearer human-token' ? {kind:'human',id:'human'} : null,lifecycle.captureModelSource);
  let origin = '';
  const server = createServer((request, response) => { response.once('close',()=>lifecycle.closed?.()); void route(request, response, new URL(request.url ?? '/', origin), origin); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return (path: string, body: unknown, human=false,withOrigin=true,signal?:AbortSignal) => new Promise<{ status: number; json: any }>((resolve, reject) => {
    const outgoing = httpRequest(origin + path, { method: 'POST', agent: false, ...(signal?{signal}:{}), headers: { Authorization: human?'Bearer human-token':'Bearer agent-token', 'Content-Type': 'application/json',...(human&&withOrigin?{Origin:origin}:{}) } }, response => {
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
    ['BLENDER_REQUIRED','BLENDER_REQUIRED',403], ['TOOLBOX_MODELS_DISABLED','TOOLBOX_MODELS_DISABLED',403], ['RATE_LIMITED', 'RATE_LIMITED', 429], ['ASSET_NOT_SEARCHED', 'ASSET_NOT_SEARCHED', 409], ['MODE_MISMATCH', 'MODE_MISMATCH', 409], ['WEIRD', 'NATIVE_ASSET_FAILED', 424]] as const) {
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
  const releaseSourcePolicy=store.bindModelSourcePolicy(()=>true);t.after(releaseSourcePolicy); // explicit external-template fixture opt-in
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
  assert.match(ARCANE_TASK_INSTRUCTIONS, /Toolbox\/Creator Store needs an explicit request/);
  assert.match(ARCANE_TASK_INSTRUCTIONS, /not realism\/build permission/);
  assert.match(ARCANE_TASK_INSTRUCTIONS, /Blender geometry\/UV\/PBR/);
  assert.match(ARCANE_TASK_INSTRUCTIONS, /No Studio AI, buying\/publishing/);
  assert.match(ARCANE_TASK_INSTRUCTIONS, /studio_viewport_capture, critique the image against the request, then fix what you see/);
  assert.doesNotMatch(ARCANE_TASK_INSTRUCTIONS, /studio_asset_search first|studio_asset_generate only when nothing suitable exists/);
  for (const skill of ['arcane-natural-scenes', 'arcane-architectural-features', 'arcane-photoreal', 'arcane-world-building']) {
    const body = readFileSync(join(process.cwd(), 'skills/arcane', skill, 'SKILL.md'), 'utf8');
    assert.match(body, /Toolbox[^.]*require an express request/, skill);
    assert.match(body, /Blender/, skill); assert.match(body, /human(?:-reviewed| approval| review)/, skill);
    assert.doesNotMatch(body, /Creator Store asset first|Real assets first/, skill);
  }
  for (const tool of ['studio_asset_search', 'studio_asset_insert', 'studio_viewport_capture'] as const) assert.ok(ARCANE_TOOL_NAMES.includes(tool), tool);
});

// The default fixture explicitly admits one original human task and separately
// enables manual browsing. Neither grant can be inferred from the other.
test('model sources: default refuses search and insert before any native connection, and directs generation to local Blender',async t=>{
  const f=await serviceFixture(t,{allowModels:false});
  assert.deepEqual(f.service.humanControl.toolboxPolicy({sessionId:f.pair.sessionId},()=>{}),{sessionId:f.pair.sessionId,allowModels:false});
  for(const category of ['Model','MeshPart'])await assert.rejects(f.assets.search({sessionId:f.pair.sessionId,query:'forest',category},'agent-fixture'),{code:'TOOLBOX_MODELS_DISABLED'});
  await assert.rejects(f.assets.insert({sessionId:f.pair.sessionId,assetId:'1001',watch:'w'},'agent-fixture'),{code:'TOOLBOX_MODELS_DISABLED'});
  assert.equal(f.natives().length,0);
  await assert.rejects(f.assets.generate({sessionId:f.pair.sessionId,kind:'material',prompt:'moss',baseMaterial:'Rock'},'agent-fixture'),{code:'BLENDER_REQUIRED'});
  assert.equal(f.natives().length,0);
});

test('model sources: human choice is guarded, scoped to proof epoch, revocable, and cannot be supplied in tool arguments',async t=>{
  const f=await serviceFixture(t,{allowModels:false}),input={sessionId:f.pair.sessionId};
  assert.throws(()=>f.service.humanControl.toolboxPolicy({...input,allowModels:true},()=>{throw Error('revoked');}),/revoked/);
  assert.equal(f.service.humanControl.toolboxPolicy(input,()=>{}).allowModels,false);
  assert.throws(()=>f.service.humanControl.toolboxPolicy({...input,allowModels:true,actor:'human'},()=>{}));
  await assert.rejects(f.assets.search({...input,query:'pine',allowModels:true},'agent-fixture'));
  let guards=0;f.service.humanControl.toolboxPolicy({...input,allowModels:true},()=>{guards++;});assert.equal(guards,2);
  await assert.rejects(f.assets.search({...input,query:'pine'},'agent-fixture'),{code:'TOOLBOX_MODELS_DISABLED'},'a session manual preference never grants an agent task');
  await f.assets.search({...input,query:'pine'},'human');f.watch('policy-watch');
  f.service.humanControl.toolboxPolicy({...input,allowModels:false},()=>{});
  await assert.rejects(f.assets.insert({...input,assetId:'1001',watch:'policy-watch'},'human'),{code:'TOOLBOX_MODELS_DISABLED'});
  f.service.humanControl.toolboxPolicy({...input,allowModels:true},()=>{});
  await assert.rejects(f.assets.insert({...input,assetId:'1001',watch:'policy-watch'},'human'),{code:'ASSET_NOT_SEARCHED'});
  f.store.poll(f.pair.sessionId,{...f.proof,playEpoch:f.proof.playEpoch+1});
  assert.equal(f.service.humanControl.toolboxPolicy(input,()=>{}).allowModels,false);
});

test('model source route: agent cannot read or enable the human policy',async t=>{
  const seen:unknown[]=[];const ok=async (...a:unknown[])=>{seen.push(a);return {};};
  const post=await routeFixture(t,{search:ok as never,insert:ok as never,generate:ok as never,job:ok as never});
  for(const input of [{sessionId:'s1'},{sessionId:'s1',allowModels:true}])assert.equal((await post('/v1/studio-native/toolbox-policy',input)).status,403);
  assert.deepEqual(seen,[]);
});

test('model execution: manual browsing never enables another task; original repair needs a fresh operation capture',async t=>{
 const f=await serviceFixture(t),input={sessionId:f.pair.sessionId,query:'pine'};
 await f.assets.search(input,'human');
 await assert.rejects(f.assets.search(input,'agent-fixture'),{code:'TOOLBOX_MODELS_DISABLED'});
 await f.assets.search({...input,category:'Audio'},'another-agent');
 const initial=f.scope();await f.assets.search(input,'agent-fixture',initial);
 const other=f.registry.issue();other.seal({...f.binding,provider:'codex',sessionId:null});other.grant(f.binding);other.dispatched({...f.binding,operationId:'unrelated-task'});
 await assert.rejects(f.assets.search(input,'other-task',{...initial,modelSource:f.registry.capture(other.credential(),'mutate')}),{code:'TOOLBOX_MODELS_DISABLED'});
 f.task.ended('original-human-message');f.task.dispatched({...f.binding,operationId:'same-original-repair'});
 await assert.rejects(f.assets.search(input,'agent-fixture',initial),{code:'TOOLBOX_MODELS_DISABLED'});
 await f.assets.search(input,'agent-fixture',f.scope());
 f.service.humanControl.toolboxPolicy({sessionId:f.pair.sessionId,allowModels:false},()=>{});
 await assert.rejects(f.assets.search(input,'agent-fixture',f.scope()),{code:'TOOLBOX_MODELS_DISABLED'});
 await f.assets.search({...input,category:'Audio'},'agent-fixture');
});

test('model execution: held HTTP body retains its original operation and cannot borrow a later repair', {timeout:15000},async t=>{
 const f=await serviceFixture(t),captured=deferred();let origin='';
 const route=studioTestRoutes(f.service,()=>({kind:'agent',id:'agent-fixture'}),()=>{const actor=f.capture();captured.resolve();return actor;});
 const server=createServer((request,response)=>{void route(request,response,new URL(request.url??'/',origin),origin);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+(server.address()as {port:number}).port;
 t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
 const body=JSON.stringify({sessionId:f.pair.sessionId,query:'pine'});
 let request!:ReturnType<typeof httpRequest>;
 const pending=new Promise<{status:number;body:{error?:string}}>((resolve,reject)=>{
  request=httpRequest(origin+'/v1/studio-native/asset-search',{method:'POST',headers:{Authorization:'Bearer exact-original','Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},response=>{
   let text='';response.setEncoding('utf8');response.on('data',chunk=>{text+=chunk;});response.on('end',()=>resolve({status:response.statusCode!,body:JSON.parse(text)}));response.on('error',reject);
  });request.on('error',reject);request.write(body.slice(0,1));
 });
 await captured.promise;f.task.ended('original-human-message');f.task.dispatched({...f.binding,operationId:'later-original-repair'});request.end(body.slice(1));
 const refused=await pending;assert.equal(refused.status,403);assert.equal(refused.body.error,'TOOLBOX_MODELS_DISABLED');assert.equal(f.natives().length,0);
 await f.assets.search({sessionId:f.pair.sessionId,query:'pine'},'agent-fixture',f.scope());assert.equal(f.natives().length,1);
});

test('model execution: refreshed proof timestamps keep the original task, but a changed Edit incarnation cannot refresh consent',async t=>{
 const f=await serviceFixture(t),input={sessionId:f.pair.sessionId,query:'pine'};
 f.store.poll(f.pair.sessionId,f.proof);await f.assets.search(input,'agent-fixture',f.scope());const before=f.natives().length;
 f.store.poll(f.pair.sessionId,{...f.proof,playEpoch:f.proof.playEpoch+1});
 await assert.rejects(f.assets.search(input,'agent-fixture',f.scope()),{code:'TOOLBOX_MODELS_DISABLED'});
 f.task.ended('original-human-message');f.task.dispatched({...f.binding,operationId:'same-task-after-proof-change'});
 await assert.rejects(f.assets.search(input,'agent-fixture',f.scope()),{code:'TOOLBOX_MODELS_DISABLED'});
 assert.equal(f.natives().length,before);assert.throws(()=>f.task.grantModelSource(f.pair.sessionId),{code:'NATIVE_ASSET_AUTHORITY'});
});

test('model execution: only original-owner settled Play transition advances its epoch once; manual browsing stays independent',async t=>{
 const f=await serviceFixture(t),s=f.store.session(f.pair.sessionId),old=f.scope();
 // Controlled packet metadata exercises the private binding guard here; the
 // production adapter/SDK/SQLite Play and Stop are exercised in chat-task-studio.
 const report:StudioTestTaskSettled={jobId:randomUUID(),displayDigest:'a'.repeat(64),scenarioDigest:'b'.repeat(64),subjectDigest:'c'.repeat(64),reportDigest:'d'.repeat(64),
  review:{runId:randomUUID(),evidence:'fixture',nativeAcceptance:false,binding:{nativeStudioId:STUDIO,pairedSessionId:s.id,clientLifetimeId:s.clientSessionId,pluginArtifactHash:ARTIFACT,placeId:0,
   scopeRevision:digest({sessionId:s.id,clientLifetimeId:s.clientSessionId,placeId:s.placeId,universeId:s.universeId,name:s.name,roots:s.allowedRoots,writes:s.allowWrites,revoked:s.revokedAt})},
   scopeDigest:'e'.repeat(64),phase:'done',outcome:'failed',code:'ASSERTION_FAILED',cleanup:'complete',startedAt:1,deadline:2,cleanupDeadline:3,watchdog:{armed:false,fired:false,reason:null},observations:1,logs:[],logsTruncated:false,requiresHumanReview:false,canStartAnotherOperation:true},
  scenario:{outcome:'failed',requiredEvidence:'complete',inputRelease:'complete',restoration:'complete',subjects:'current'}};
 assert.throws(()=>f.task.advanceModelSourceAfterOwnedPlay(report),{code:'NATIVE_ASSET_AUTHORITY'},'an active operation cannot refresh its own proof');
 f.task.ended('original-human-message');f.store.poll(s.id,{...f.proof,playEpoch:f.proof.playEpoch+2});
 for(const bad of [{...report,review:{...report.review,cleanup:'unknown' as const}},
  {...report,review:{...report.review,binding:{...report.review.binding!,pairedSessionId:'foreign'}}},
  {...report,scenario:{...report.scenario!,subjects:'unobserved' as const}},
  {...report,scenario:{...report.scenario!,inputRelease:'unknown' as const}}])assert.throws(()=>f.task.advanceModelSourceAfterOwnedPlay(bad),{code:'TOOLBOX_MODELS_DISABLED'});
 f.task.advanceModelSourceAfterOwnedPlay(report);assert.equal(f.task.status().admissionOpen,false,'proof transition never opens or grants an operation');
 f.task.dispatched({...f.binding,operationId:'proved-original-repair'});
 await assert.rejects(f.assets.search({sessionId:s.id,query:'pine'},'agent-fixture',old),{code:'TOOLBOX_MODELS_DISABLED'});
 await f.assets.search({sessionId:s.id,query:'pine'},'agent-fixture',f.scope());
 assert.equal(f.service.humanControl.toolboxPolicy({sessionId:s.id},()=>{}).allowModels,false,'task continuation never renews a manual session preference');
 f.task.ended('proved-original-repair');f.store.poll(s.id,{...f.proof,playEpoch:f.proof.playEpoch+4});
 assert.throws(()=>f.task.advanceModelSourceAfterOwnedPlay(report),{code:'TOOLBOX_MODELS_DISABLED'},'replaying old settled metadata cannot authorize another epoch');
 f.registry.revokeModelSource(s.id);assert.throws(()=>f.task.advanceModelSourceAfterOwnedPlay({...report,review:{...report.review,runId:randomUUID()}}),{code:'NATIVE_ASSET_AUTHORITY'});
});


test('model source route: only exact-origin human control changes the session policy',async t=>{
  const seen:unknown[]=[];const unused=async()=>{throw Error('unused');};
  const post=await routeFixture(t,{search:unused,insert:unused,generate:unused,job:unused},(input,guard)=>{guard();seen.push(input);return {sessionId:'s1',allowModels:!!(input as {allowModels?:boolean}).allowModels};});
  const input={sessionId:'s1',allowModels:true};
  assert.equal((await post('/v1/studio-native/toolbox-policy',input)).status,403);
  assert.equal((await post('/v1/studio-native/toolbox-policy',input,true,false)).status,403);
  assert.equal((await post('/v1/studio-native/toolbox-policy',{...input,actor:'human'},true)).status,400);
  assert.deepEqual(seen,[]);
  const enabled=await post('/v1/studio-native/toolbox-policy',input,true);assert.equal(enabled.status,200);assert.deepEqual(enabled.json,input);
  assert.deepEqual(seen,[input]);
});

test('model source revocation: a changed choice before dispatch prevents insert; after dispatch preserves an unknown outcome',async t=>{
  let allowed=true;const authorize=()=>{if(!allowed)throw Object.assign(Error('off'),{code:'TOOLBOX_MODELS_DISABLED'});};
  const before=await nativeFixture(t);const ctx={...context(before.client),authorize,decodeMode:(r:CallToolResult)=>{allowed=false;return decodeTestMode(r);}};
  const request=nativeAssetInsertSchema.parse({sessionId:'s1',assetId:'1001',watch:'w'});
  await assert.rejects(insertNativeAsset(ctx,request,AbortSignal.timeout(5000)),{code:'TOOLBOX_MODELS_DISABLED'});
  assert.deepEqual(assetNames(before.state.calls),[]);
  allowed=true;const after=await nativeFixture(t,{reply:(name,args)=>{if(name==='insert_asset')allowed=false;return defaultReply(name,args);}});
  await assert.rejects(insertNativeAsset({...context(after.client),authorize},request,AbortSignal.timeout(5000)),{code:'EFFECT_UNKNOWN'});
  assert.deepEqual(assetNames(after.state.calls),['insert_asset']);
});

const clonedForest=(sessionId:string,requestId:string)=>({sessionId,requestId,method:'scene.build',args:{parent:ROOT(sessionId),container:{className:'Model',name:'Forest'},prototypes:[],templates:[TEMPLATE(sessionId)],items:[{kind:'clone',template:1,name:'Tree',parent:0,at:[0,0,0],yaw:0,scale:1}]}});

test('raw external adoption refuses a later agent task even when a prior watched insertion was acknowledged', {timeout:15000},async t=>{
 const f=await serviceFixture(t),sessionId=f.pair.sessionId,watch='prior-model-task-watch';
 await f.assets.search({sessionId,query:'pine'},'original-task',f.scope());f.watch(watch);
 const inserted=await f.assets.insert({sessionId,assetId:'1001',watch},'original-task',f.scope());assert.equal(inserted.insert.acknowledgement,'acknowledged');
 f.task.ended('original-human-message');
 const other=f.registry.issue(),token=other.credential();other.seal({...f.binding,provider:'codex',sessionId:null});other.grant(f.binding);other.dispatched({...f.binding,operationId:'unrelated-adoption'});
 const route=studioRoutes(f.store,process.cwd(),undefined,f.root,token,null,undefined,{discoveryPort:0},request=>f.registry.capture(request.headers.authorization!.slice(7),'mutate'));
 let origin='';const server=createServer((request,response)=>{void route(request,response,new URL(request.url??'/',origin),'human-control',origin);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(undefined)));const address=server.address();assert.ok(address&&typeof address!=='string');origin='http://127.0.0.1:'+address.port;
 t.after(()=>new Promise(resolve=>{route.closePairing();server.closeAllConnections();server.close(()=>resolve(undefined));}));
 const response=await fetch(origin+'/v1/studio/commands',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({
  sessionId,requestId:'new-task-external-adoption',method:'scene.place_asset',args:{watch,expectName:inserted.insert.assetName,parent:ROOT(sessionId),name:'Later adoption',position:[0,0,0],yaw:0,ground:true,anchor:true,allowScripts:false}})});
 const reply=await response.json();assert.equal(response.status,403,JSON.stringify(reply));assert.equal(reply.error,'TEMPLATE_SOURCE');
 assert.equal(f.store.commands(sessionId).filter(command=>command.method==='scene.place_asset').length,0);
 assert.equal(f.natives().flatMap(native=>assetNames(native.state.calls)).filter(name=>name==='insert_asset').length,1,'the old actual SDK insertion is never replayed');
});


test('scene source route: every agent command retains an original operation guard and manual access cannot substitute', {timeout:15000},async t=>{
 const f=await serviceFixture(t),sessionId=f.pair.sessionId,human='owned-human-control';let origin='',currentToken=f.taskToken;
 const route=studioRoutes(f.store,process.cwd(),undefined,f.root,()=>currentToken,null,undefined,{discoveryPort:0},request=>f.registry.capture(request.headers.authorization!.slice(7),'mutate'));
 const server=createServer((request,response)=>{void route(request,response,new URL(request.url??'/',origin),human,origin);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+(server.address()as {port:number}).port;
 t.after(()=>new Promise<void>(resolve=>{route.closePairing();server.closeAllConnections();server.close(()=>resolve());}));
 const post=async(body:unknown,token=currentToken)=>{const response=await fetch(origin+'/v1/studio/commands',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(token===human?{Origin:origin}:{})},body:JSON.stringify(body)});return{status:response.status,data:await response.json()as {command?:{id:string};error?:string}};};
 const queued=await post(clonedForest(sessionId,'original-operation'));assert.equal(queued.status,200);const commandId=queued.data.command!.id;
 f.task.ended('original-human-message');f.task.dispatched({...f.binding,operationId:'same-task-repair'});
 assert.deepEqual(f.store.poll(sessionId,f.proof),[]);assert.equal(f.store.command(commandId).state,'cancelled','queued initial-operation authority cannot be upgraded into repair authority');
 const fresh=await post(clonedForest(sessionId,'fresh-repair-operation'));assert.equal(fresh.status,200);
 assert.equal(f.store.poll(sessionId,f.proof)[0]?.id,fresh.data.command!.id);
 // A queued external command has now actually been offered. Ending its
 // source operation cannot manufacture a definite cancellation or new replay.
 f.task.ended('same-task-repair');assert.equal(f.store.command(fresh.data.command!.id).state,'dispatched');
 const other=f.registry.issue();other.seal({...f.binding,provider:'codex',sessionId:null});other.grant(f.binding);other.dispatched({...f.binding,operationId:'unrelated'});
 currentToken=other.credential();
 const denied=await post(clonedForest(sessionId,'manual-cannot-enable-agent'));assert.equal(denied.status,403);assert.equal(denied.data.error,'TEMPLATE_SOURCE');
 assert.equal(f.service.humanControl.toolboxPolicy({sessionId},()=>{}).allowModels,true,'manual browsing choice remains independently allowed');
});

test('scene source route: a held body cannot borrow a later operation; human manual commands retain their own path', {timeout:15000},async t=>{
 const f=await serviceFixture(t),captured=deferred(),human='human-control';let origin='';
 const route=studioRoutes(f.store,process.cwd(),undefined,f.root,f.taskToken,null,undefined,{discoveryPort:0},()=>{const actor=f.capture();captured.resolve();return actor;});
 const server=createServer((request,response)=>{void route(request,response,new URL(request.url??'/',origin),human,origin);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+(server.address()as {port:number}).port;
 t.after(()=>new Promise<void>(resolve=>{route.closePairing();server.closeAllConnections();server.close(()=>resolve());}));
 const body=JSON.stringify(clonedForest(f.pair.sessionId,'held-body-source'));let request!:ReturnType<typeof httpRequest>;
 const pending=new Promise<{status:number;error:string}>((resolve,reject)=>{request=httpRequest(origin+'/v1/studio/commands',{method:'POST',headers:{Authorization:'Bearer '+f.taskToken,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},response=>{let text='';response.setEncoding('utf8');response.on('data',chunk=>{text+=chunk;});response.on('end',()=>resolve({status:response.statusCode!,error:(JSON.parse(text)as {error:string}).error}));});request.on('error',reject);request.write(body.slice(0,1));});
 await captured.promise;f.task.ended('original-human-message');f.task.dispatched({...f.binding,operationId:'later-operation'});request.end(body.slice(1));
 assert.deepEqual(await pending,{status:403,error:'TEMPLATE_SOURCE'});assert.equal(f.store.commands().length,0);
 const response=await fetch(origin+'/v1/studio/commands',{method:'POST',headers:{Authorization:'Bearer '+human,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(clonedForest(f.pair.sessionId,'human-manual-source'))});
 assert.equal(response.status,200);assert.equal(f.store.commands().length,1);
});

test('template sources: default rejects reuse of existing external models before queueing; explicit human opt-in is rechecked before dispatch',async t=>{
 const f=await serviceFixture(t,{allowModels:false}),sessionId=f.pair.sessionId;
 assert.throws(()=>f.store.enqueue(clonedForest(sessionId,'no-reuse')),{code:'TEMPLATE_SOURCE'});
 assert.equal(f.store.commands(sessionId).length,0);assert.equal(f.natives().length,0);
 f.service.humanControl.toolboxPolicy({sessionId,allowModels:true},()=>{});
 const command=f.store.enqueue(clonedForest(sessionId,'opted-in'));
 f.service.humanControl.toolboxPolicy({sessionId,allowModels:false},()=>{});
 assert.deepEqual(f.store.poll(sessionId,f.proof),[]);
 assert.equal(f.store.command(command.id).state,'cancelled');
 assert.match(f.store.command(command.id).error!,/This operation was not sent/);
 assert.throws(()=>f.store.enqueue(clonedForest(sessionId,'still-disabled')),{code:'TEMPLATE_SOURCE'});
});

test('template sources: an authenticated original-reconstruction placement receipt allows the exact template without enabling external models',async t=>{
 const f=await serviceFixture(t,{allowModels:false,reviewedOriginal:true}),sessionId=f.pair.sessionId,ref=TEMPLATE(sessionId);
 recordReviewedOriginalRun(f.store,sessionId,'a'.repeat(64),ROOT(sessionId).instanceId,f.proof);
 const placed=f.store.enqueue({sessionId,requestId:'original-placement',method:'scene.place_asset',args:{watch:'editable-'+'a'.repeat(64),parent:ROOT(sessionId),name:'Original oak',position:[0,0,0],yaw:0,ground:true,anchor:true,allowScripts:false}});
 f.store.poll(sessionId,f.proof);
 f.store.result({sessionId,commandId:placed.id,state:'succeeded',result:{ref,removedScripts:{count:0,classes:{},names:[]},mutation:{kind:'scene.place_asset',ref,before:null,after:{descendants:3,removedScripts:0,keptScripts:0,scale:1}}}});
 const command=f.store.enqueue(clonedForest(sessionId,'original-scatter'));
 assert.equal(command.state,'queued');assert.equal(f.service.humanControl.toolboxPolicy({sessionId},()=>{}).allowModels,false);
 assert.equal(f.store.poll(sessionId,f.proof)[0]!.id,command.id);
 const other=clonedForest(sessionId,'forged-template');other.args.templates=[{...ref,instanceId:'other-model'}];
 assert.throws(()=>f.store.enqueue(other),{code:'TEMPLATE_SOURCE'});
});

// These use real route/service/controller/MCP code with disposable HTTP and
// scripted native peers. They do not start Studio or assert engine acceptance.
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

for (const fence of ['retirement', 'disconnect'] as const) test(`native lifecycle: ${fence} before dispatch prevents insertion`, {timeout: 10_000}, async t => {
  const entered = deferred(), release = deferred(), settled = deferred(), disconnected = deferred();
  let inserting = false, paused = false, actorCurrent = true;
  t.after(() => release.resolve());
  const f = await serviceFixture(t, { beforeCall: async name => {
    if (inserting && !paused && name === 'get_studio_state') { paused = true; entered.resolve(); await release.promise; }
  } });
  await f.assets.search({sessionId:f.pair.sessionId,query:'oak'}, 'agent-fixture',f.scope());
  f.watch('lifecycle-before-' + fence);
  const assets = { ...f.assets, async insert(...args: Parameters<typeof f.assets.insert>) {
    try { return await f.assets.insert(...args); } finally { settled.resolve(); }
  } };
  const post = await routeFixture(t, assets, undefined, {actorCurrent:()=>actorCurrent,closed:()=>disconnected.resolve(),captureModelSource:f.capture});
  const abort = new AbortController();
  inserting = true;
  const response = post('/v1/studio-native/asset-insert', {sessionId:f.pair.sessionId,assetId:'1001',watch:'lifecycle-before-' + fence}, false, true, abort.signal)
    .then(value => ({value,error:null}), error => ({value:null,error}));
  await entered.promise;
  if (fence === 'retirement') actorCurrent = false;
  else { abort.abort(); await disconnected.promise; }
  release.resolve();
  const outcome = await response;
  await settled.promise;
  assert.equal(f.natives().flatMap(n=>assetNames(n.state.calls)).filter(name=>name==='insert_asset').length, 0);
  assert.equal(f.store.commands(f.pair.sessionId).filter(c=>c.method==='scene.place_asset').length, 0);
  if (fence === 'retirement') {
    assert.equal(outcome.value?.status, 401);
    assert.equal(outcome.value?.json.error, 'AUTH', 'a refused pre-dispatch request stays definite because the native call never began');
  } else assert.ok(outcome.error, 'the disposable client observed its own abort');
});

for (const fence of ['after-dispatch', 'during-close'] as const) test(`native lifecycle: retirement ${fence} preserves an unknown insertion outcome`, {timeout: 10_000}, async t => {
  let inserting = false, actorCurrent = true;
  const f = await serviceFixture(t, {
    reply: (name,args) => { if (inserting && fence === 'after-dispatch' && name === 'insert_asset') actorCurrent = false; return defaultReply(name,args); },
    afterNativeClose: () => { if (inserting && fence === 'during-close') actorCurrent = false; },
  });
  await f.assets.search({sessionId:f.pair.sessionId,query:'oak'}, 'agent-fixture',f.scope());
  f.watch('lifecycle-after-' + fence);
  const post = await routeFixture(t, f.assets, undefined, {actorCurrent:()=>actorCurrent,captureModelSource:f.capture});
  inserting = true;
  const outcome = await post('/v1/studio-native/asset-insert', {sessionId:f.pair.sessionId,assetId:'1001',watch:'lifecycle-after-' + fence});
  assert.equal(outcome.status, 409);
  assert.equal(outcome.json.error, 'NATIVE_ASSET_UNKNOWN');
  assert.equal(f.natives().flatMap(n=>assetNames(n.state.calls)).filter(name=>name==='insert_asset').length, 1);
  assert.equal(f.store.commands(f.pair.sessionId).filter(c=>c.method==='scene.place_asset').length, 0);
});

for (const refusal of ['unknown', 'denied'] as const) test(`MCP native lifecycle: ${refusal} insertion never replays or adopts without a live receipt`, async t => {
  const posts: {path:string;method?:string}[] = [];
  const sessionId = 'paired-lifecycle', parent = {instanceId:'lifecycle-parent',sessionId,root:'ServerStorage',pathSegments:['Templates'],className:'Folder'};
  const daemon = createServer((request,response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk=>chunks.push(chunk));
    request.once('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      posts.push({path:request.url!,method:body.method});
      let status = 200, reply: unknown;
      if (request.url === '/v1/studio/commands' && body.method === 'scene.asset_watch') reply = {command:{protocolVersion:1,id:'lifecycle-watch-command',requestId:body.requestId,sessionId,clientSessionId:'lifecycle-plugin',method:body.method,args:body.args,
        allowedRoots:['Workspace','ServerStorage'],allowWrites:true,leaseEpoch:1,expiresAt:new Date(Date.now()+60_000).toISOString(),state:'succeeded',createdAt:new Date().toISOString(),finishedAt:new Date().toISOString(),result:{watch:'lifecycle-watch',expiresInSeconds:600},error:null}};
      else if (request.url === '/v1/studio-native/asset-insert') {
        status = refusal === 'unknown' ? 409 : 403;
        reply = {error:refusal === 'unknown'?'NATIVE_ASSET_UNKNOWN':'TOOLBOX_MODELS_DISABLED',message:refusal === 'unknown'?'The native insert may have applied.':'Toolbox models are off.'};
      } else { status = 500; reply = {error:'UNEXPECTED',message:'No adoption or replay is authorized in this fixture.'}; }
      response.writeHead(status, {'Content-Type':'application/json'}); response.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>(resolve=>daemon.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>{daemon.closeAllConnections();daemon.close(()=>resolve());}));
  const client = new DaemonClient({url:'http://127.0.0.1:'+(daemon.address() as {port:number}).port,token:'lifecycle-fixture-agent',pollIntervalMs:5});
  const server = createMcpServer({client,projectRoot:process.cwd()});
  const [clientTransport,serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({name:'fixture-native-lifecycle',version:'fixture-only'},{capabilities:{}});
  await server.connect(serverTransport); await mcp.connect(clientTransport);
  t.after(async()=>{await mcp.close();await server.close();});
  const result = CallToolResultSchema.parse(await mcp.callTool({name:'studio_asset_insert',arguments:{sessionId,assetId:'1001',parent,name:'Oak',position:[0,0,0]}}));
  assert.equal(result.isError,true);
  const value = result.structuredContent as {error:{code:string};insert?:{sessionId:string;assetId:string;watch:string;acknowledgement:string};adoption?:string;nextStep?:string};
  assert.equal(value.error.code,refusal==='unknown'?'NATIVE_ASSET_UNKNOWN':'TOOLBOX_MODELS_DISABLED');
  if (refusal === 'unknown') {
    assert.equal(value.insert?.acknowledgement,'unknown');
    assert.deepEqual(value.insert,{sessionId,assetId:'1001',watch:'lifecycle-watch',acknowledgement:'unknown'});
    assert.equal(value.adoption,'not_started');
    assert.match(value.nextStep!,/Do not repeat insertion or adopt automatically/);
  } else assert.equal(value.insert,undefined,'a definite pre-effect refusal remains definite');
  assert.deepEqual(posts,[{path:'/v1/studio/commands',method:'scene.asset_watch'},{path:'/v1/studio-native/asset-insert',method:undefined}]);
});
