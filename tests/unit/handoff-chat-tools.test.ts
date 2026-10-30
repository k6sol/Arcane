import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { createConnectionLab } from '../../apps/daemon/src/lab-server.js';
import { createAssetService } from '../../apps/daemon/src/asset-service.js';
import { createStudioTestService, type NativeTestConnection } from '../../apps/daemon/src/studio-test-service.js';
import { createMcpServer } from '../../apps/mcp/src/server.js';
import { DaemonClient } from '../../apps/mcp/src/daemon-client.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import {workflowProjectIdentity} from '../../packages/storage/src/workflow-store.js';
import { WorkStore } from '../../packages/storage/src/work-store.js';
import { encodeRgbPng } from '../../packages/studio-test-controller/src/viewport-image.js';
import { VIEWPORT_CAMERA_READ_PROGRAM } from '../../packages/studio-test-controller/src/viewport.js';
import { ARCANE_TOOL_NAMES, ARCANE_NATIVE_TOOL_NAMES } from '../../packages/protocol/src/arcane-tools.js';

// The in-app Claude chat runs Arcane MCP with a sealed native-handoff credential. This drives the actual
// createConnectionLab (real handoff routes, StudioStore, WorkStore, AssetService, studio test service) with a
// synthetic in-memory native Studio peer. No Studio, provider, Blender run or desktop app is touched.
const STUDIO = 'handoff-chat-native', NAME = 'Handoff chat fixture place', MARKER = 'ArcaneTestProof_handoff_chat', ARTIFACT = 'b'.repeat(64);
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const text = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }] });
const TOOLS: Tool[] = [
  { name: 'list_roblox_studios', inputSchema: { type: 'object', properties: {} }, annotations: READ },
  { name: 'get_studio_state', inputSchema: { type: 'object', properties: { studio_id: { type: 'string' } }, required: ['studio_id'] }, annotations: READ },
  { name: 'execute_luau', inputSchema: { type: 'object', required: ['code', 'studio_id', 'datamodel_type'], properties: {
    code: { type: 'string' }, studio_id: { type: 'string' }, datamodel_type: { type: 'string', enum: ['Edit', 'Client', 'Server'] } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'screen_capture', annotations: READ, inputSchema: { type: 'object', required: ['capture_id', 'studio_id'], properties: {
    camera_position: { type: 'array', items: { type: 'number' } }, capture_id: { type: 'string' },
    look_at_position: { type: 'array', items: { type: 'number' } }, studio_id: { type: 'string' } } } },
];
function png(width: number, height: number): Buffer {
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = i & 0xff;
  return encodeRgbPng(rgb, width, height);
}
type Reply = { status: number; body: Record<string, any>; text: string };

async function fixture(t: TestContext, options: { heartbeat?: boolean } = {}) {
  const base = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(base, 'arcane-handoff-chat-'))), project = join(root, 'project');
  await mkdir(project, { recursive: true });
  const studio = new StudioStore({ directory: join(root, 'studio') }), work = new WorkStore({ directory: join(root, 'work'), projectPath: project });
  const assets = await createAssetService({ cwd: process.cwd(), projectPath: project, outputRoot: join(root, 'assets') });
  const grant = studio.createGrant({ allowedRoots: ['Workspace', 'ServerStorage'], allowWrites: true });
  const pair = studio.pair({ code: grant.code, protocolVersion: 1, identity: { clientSessionId: 'plugin-handoff-chat', placeId: 0, universeId: 0, name: NAME, pluginVersion: 'fixture-only' },
    capabilities: ['scene.children'] });
  studio.authenticate(pair.sessionId, pair.token);
  const heartbeat = () => studio.poll(pair.sessionId, { sessionId: pair.sessionId, clientLifetimeId: 'plugin-handoff-chat', pluginArtifactHash: ARTIFACT, markerName: MARKER,
    placeId: 0, universeId: 0, placeName: NAME, mode: 'Edit', playEpoch: 1, continuitySupported: true, connected: true });
  heartbeat();
  // This viewport fixture represents a connected plugin, including its regular proof heartbeat.
  const heartbeatTimer = options.heartbeat ? setInterval(heartbeat, 500) : null;
  heartbeatTimer?.unref();
  const nativeCalls: string[] = [], peers: { close(): Promise<void> }[] = [];
  const connect = async (): Promise<NativeTestConnection> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'fixture-handoff-native-client', version: 'fixture-only' }, { capabilities: {} });
    const server = new Server({ name: 'RobloxStudio', version: 'fixture-only' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: structuredClone(TOOLS) }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      const name = request.params.name, args = request.params.arguments ?? {}; nativeCalls.push(name);
      assert.notEqual(name, 'start_stop_play', 'no fixture call ever starts Play');
      if (name === 'list_roblox_studios') return text(JSON.stringify({ studios: [{ id: STUDIO, name: NAME }] }));
      if (name === 'get_studio_state') return text('- Current Studio Mode: Edit\n- Available DataModels: Edit\n- Focused DataModel in the viewport: Edit');
      if (name === 'execute_luau') return args.code === VIEWPORT_CAMERA_READ_PROGRAM
        ? text(JSON.stringify({ cframe: [0, 10, 20, 1, 0, 0, 0, 1, 0, 0, 0, 1], focus: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] })) : text('{"restored":true}');
      if (name === 'screen_capture') return { content: [{ type: 'image', data: png(96, 54).toString('base64'), mimeType: 'image/png' }] };
      return { isError: true, content: [{ type: 'text', text: 'unknown fixture tool' }] };
    });
    await server.connect(serverTransport); await client.connect(clientTransport); peers.push(client, server);
    return { client, evidence: 'fixture', async witness() {
      const s = studio.session(pair.sessionId);
      return { placeId: 0, universeId: 0, placeName: s.name, sessionId: s.id, clientLifetimeId: s.clientSessionId, pluginArtifactHash: ARTIFACT };
    }, async close() { /* peers closed after the test */ } };
  };
  const tests = await createStudioTestService({ directory: join(root, 'playtests'), store: studio, custody: studio.bindNativeCustody(workflowProjectIdentity(project).projectId, join(root, 'studio')), pluginArtifactHash: ARTIFACT, connect });
  const lab = await createConnectionLab({ cwd: process.cwd(), stateDirectory: join(root, 'lab'), projectPath: project, studioStore: studio, workStore: work, assetService: assets,
    studioTestService: tests, codexConnect: async () => { throw new Error('No provider in this fixture.'); } });
  const agents: Client[] = [];
  t.after(async () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    for (const close of [...agents.map(a => () => a.close()), () => lab.close(), () => tests.lifecycle.close(), ...peers.map(p => () => p.close()), () => assets.close(), () => { work.close(); }, () => { studio.close(); }])
      try { await close(); } catch { /* best-effort owned cleanup */ }
    const part = relative(base, root); assert.ok(part.startsWith('arcane-handoff-chat-') && !isAbsolute(part) && !part.includes(sep)); await rm(root, { recursive: true, force: true });
  });
  const call = async (token: string, path: string, body?: unknown, origin = body !== undefined): Promise<Reply> => {
    const response = await fetch(lab.origin + path, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: 'Bearer ' + token, ...(origin ? { Origin: lab.origin } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const raw = await response.text(); let parsed: Record<string, any> = {}; try { parsed = JSON.parse(raw); } catch { /* non-JSON */ }
    return { status: response.status, body: parsed, text: raw };
  };
  const human = (path: string, body?: unknown) => call(lab.token, path, body);
  const projectId = async () => (await human('/v1/native-handoffs')).body.projectId as string;
  const sealed = async () => {
    const started = await human('/v1/native-handoffs/begin', { requestId: randomUUID(), projectId: await projectId() }); assert.equal(started.status, 200, started.text);
    assert.equal((await human('/v1/native-handoffs/seal', { handoffId: started.body.handoff.handoffId, projectId: await projectId() })).status, 200);
    return { handoffId: started.body.handoff.handoffId as string, credential: started.body.credential as string };
  };
  const revoke = async (handoffId: string) => human('/v1/native-handoffs/revoke', { handoffId, projectId: await projectId() });
  const workbench = async () => (await human('/v1/product/mcp-token', {})).body.token as string;
  const mcp = async (token: string) => {
    const server = createMcpServer({ client: new DaemonClient({ url: lab.origin, token, pollIntervalMs: 10 }), projectRoot: project });
    const agent = new Client({ name: 'handoff-chat-fixture', version: 'fixture' });
    const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(right); await agent.connect(left); agents.push(agent);
    return { agent, tool: async (name: string, args: Record<string, unknown>) => {
      if (options.heartbeat) heartbeat();
      return CallToolResultSchema.parse(await agent.callTool({ name, arguments: args }));
    } };
  };
  return { lab, studio, sessionId: pair.sessionId, nativeCalls, call, human, sealed, revoke, workbench, mcp };
}
const errorOf = (result: CallToolResult) => (result.structuredContent as { error?: { code?: string } } | undefined)?.error?.code;
const tokenFree = (raw: string, credential: string) => assert.ok(!raw.includes(credential), 'credential leaked');

test('handoff MCP end to end: studio_viewport_capture returns the native image; revocation ends access', async t => {
  const f = await fixture(t, { heartbeat: true }), { handoffId, credential } = await f.sealed(), { agent, tool } = await f.mcp(credential);
  const listed = (await agent.listTools()).tools.map(item => item.name).sort();
  assert.deepEqual(listed, [...ARCANE_TOOL_NAMES].sort(), 'the chat sees the generic Arcane surface, never the native-hook asset delivery tools');
  const generic = new Set<string>(ARCANE_TOOL_NAMES), hookOnly = ARCANE_NATIVE_TOOL_NAMES.filter(item => !generic.has(item));
  assert.ok(hookOnly.includes('assets_place_studio_import'));
  for (const name of hookOnly) assert.ok(!new Set<string>(listed).has(name), name);
  const result = await tool('studio_viewport_capture', { sessionId: f.sessionId });
  assert.notEqual(result.isError, true, JSON.stringify(result.content).slice(0, 400));
  const image = result.content.find(item => item.type === 'image'); assert.ok(image && image.type === 'image'); assert.equal(image.mimeType, 'image/png');
  assert.ok(f.nativeCalls.includes('screen_capture'));
  tokenFree(JSON.stringify(result), credential);
  // Framed capture through the same credential restores the camera.
  const framed = await tool('studio_viewport_capture', { sessionId: f.sessionId, camera: { position: [30, 20, 30], lookAt: [0, 0, 0] } });
  assert.notEqual(framed.isError, true, JSON.stringify(framed.content).slice(0, 400));
  assert.equal((await f.revoke(handoffId)).status, 200);
  const after = await tool('studio_viewport_capture', { sessionId: f.sessionId });
  assert.equal(after.isError, true); assert.equal(errorOf(after), 'AUTH');
});

test('handoff credential reaches every chat tool route with the same fences as the workbench agent token', async t => {
  const f = await fixture(t, { heartbeat: true }), { credential } = await f.sealed(), core = await f.workbench();
  const s = f.sessionId;
  // [method, path, body]: each is a chat tool route. The handoff must never get AUTH and must see the
  // workbench token's exact status/error (same exact-session, grant, Edit-mode, budget and input fences).
  const routes: [string, string, unknown][] = [
    ['POST', '/v1/playtests/viewport', { sessionId: s, maxDimension: 256 }],                                  // studio_viewport_capture
    ['POST', '/v1/playtests/viewport', { sessionId: 'missing-session' }],                                      // exact session fence
    ['POST', '/v1/studio-native/asset-search', { sessionId: s, query: 'pine tree' }],                         // studio_asset_search
    ['POST', '/v1/studio-native/asset-insert', { sessionId: s, assetId: '123', watch: 'w'.repeat(16) }],      // studio_asset_insert
    ['POST', '/v1/studio-native/asset-generate', { sessionId: s, kind: 'mesh', prompt: 'mossy rock' }],      // studio_asset_generate
    ['POST', '/v1/studio-native/asset-job', { jobId: randomUUID() }],                                         // studio_asset_generate (wait)
    ['GET', '/v1/playtests', undefined],                                                                       // playtest_status (list)
    ['GET', '/v1/playtests?id=missing-job', undefined],                                                        // playtest_status
    ['POST', '/v1/playtests/cancel', { id: 'missing-job' }],                                                   // playtest_cancel
    ['POST', '/v1/studio/commands', { sessionId: s, requestId: randomUUID(), method: 'scene.build', args: {} }],        // scene_build
    ['POST', '/v1/studio/commands', { sessionId: s, requestId: randomUUID(), method: 'environment.apply', args: {} }],  // environment_apply
    ['POST', '/v1/studio/commands', { sessionId: s, requestId: randomUUID(), method: 'terrain.generate', args: {} }],   // terrain_generate
    ['GET', '/v1/assets/jobs', undefined],                                                                     // assets_jobs
    ['POST', '/v1/assets/start', {}],                                                                          // assets_procedural (invalid recipe, nothing starts)
    ['POST', '/v1/assets/cancel', {}],                                                                         // assets_cancel
    ['GET', '/v1/assets/manifest?jobId=not-a-job', undefined],                                                 // assets_manifest
    ['GET', '/v1/assets/preview?jobId=not-a-job&path=preview-hero.png', undefined],                            // assets_preview
  ];
  // Each caller sends its own requestId so a command is never a duplicate of the other caller's.
  const fresh = (body: unknown) => body && typeof body === 'object' && 'requestId' in body ? { ...body, requestId: randomUUID() } : body;
  for (const [method, path, body] of routes) {
    const handoff = await f.call(credential, path, method === 'POST' ? fresh(body) : undefined, false);
    const workbench = await f.call(core, path, method === 'POST' ? fresh(body) : undefined, false);
    const label = method + ' ' + path + ' ' + JSON.stringify(body ?? {}).slice(0, 80);
    assert.notEqual(handoff.status, 401, label + ' -> ' + handoff.text.slice(0, 200)); assert.notEqual(handoff.body.error, 'AUTH', label);
    assert.deepEqual([handoff.status, handoff.body.error], [workbench.status, workbench.body.error], label);
    tokenFree(handoff.text, credential);
  }
  // Studio commands were accepted or refused by StudioRoutes' own validation, not by authentication.
  const viewport = await f.call(credential, '/v1/playtests/viewport', { sessionId: s }, false);
  assert.equal(viewport.status, 200); assert.equal(viewport.body.viewport.sessionId, s);
});

test('handoff credential stays out of human-only and native-hook-only routes', async t => {
  const f = await fixture(t), { credential } = await f.sealed(), pid = (await f.human('/v1/native-handoffs')).body.projectId as string;
  const refused: [string, unknown][] = [
    ['/v1/playtests/approve', { id: 'job', displayDigest: 'a'.repeat(64) }],  // human playtest approval
    ['/v1/playtests/capture?id=job', undefined],                             // human review capture
    ['/v1/assets/native/start', {}],                                         // native-hook asset delivery
    ['/v1/assets/native/jobs', undefined],
    ['/v1/assets/native/stage-studio-import', { jobId: 'x' }],               // assets_place_studio_import path
    ['/v1/assets/artifact?jobId=x&path=y', undefined],                       // human artifact download
    ['/v1/assets/history-status', undefined],                                // human history control
    ['/v1/assets/conversation-start', {}],
    ['/v1/studio/keys', undefined],                                          // settings
    ['/v1/studio/pairing', {}],                                              // pairing
    ['/v1/studio/revoke', {}],
    ['/v1/studio/diagnostics', undefined],                                   // diagnostics
    ['/v1/studio/diagnostics/clear', {}],
    ['/v1/project-memory/append', { text: 'x' }],                            // project memory writes
    ['/v1/project-memory', { text: 'x' }],
    ['/v1/plans/state', undefined],                                          // plans
    ['/v1/plans/checkout', { kind: 'plan', id: 'x' }],
    ['/v1/work/review', { taskId: randomUUID(), approved: true, note: 'self' }],
    ['/v1/product/mcp-token', {}],
    ['/v1/native-handoffs', undefined],
    ['/v1/native-handoffs/begin', { requestId: randomUUID(), projectId: pid }],
  ];
  for (const [path, body] of refused) for (const origin of [false, true]) {
    const reply = await f.call(credential, path, body, origin);
    assert.ok(reply.status === 401 || reply.status === 403, path + ' -> ' + reply.status + ' ' + reply.text.slice(0, 160)); tokenFree(reply.text, credential);
  }
  assert.equal(f.studio.sessions().filter(session => !session.revokedAt).length, 1, 'no pairing changed');
});
