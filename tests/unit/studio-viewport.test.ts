import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { boundViewportPng, decodeViewportPng, encodeRgbPng, VIEWPORT_LIMITS } from '../../packages/studio-test-controller/src/viewport-image.js';
import { captureEditViewport, cameraRestoreProgram, VIEWPORT_CAMERA_READ_PROGRAM } from '../../packages/studio-test-controller/src/viewport.js';
import { decodeTestMode } from '../../apps/daemon/src/studio-test-decoders.js';
import { createStudioTestService, type NativeTestConnection } from '../../apps/daemon/src/studio-test-service.js';
import { studioTestRoutes, type StudioTestRouteService } from '../../apps/daemon/src/studio-test-routes.js';
import { StudioStore } from '../../packages/storage/src/studio-store.js';
import { DaemonClient } from '../../apps/mcp/src/daemon-client.js';
import { createMcpServer } from '../../apps/mcp/src/server.js';
import { ARCANE_TOOL_NAMES } from '../../packages/protocol/src/arcane-tools.js';
import { makeFixtureDirectory } from './windows-fixture-paths.js';

// Synthetic native fixtures only: in-memory SDK peers, generated PNG bytes and a
// fixture StudioStore. No Studio executable, no Play and no real viewport.
const STUDIO = 'studio-viewport-fixture', NAME = 'Viewport fixture place', MARKER = 'ArcaneTestProof_viewport_fixture', ARTIFACT = 'a'.repeat(64);
const EDIT = '- Current Studio Mode: Edit\n- Available DataModels: Edit\n- Focused DataModel in the viewport: Edit';
const PLAY = '- Current Studio Mode: Play\n- Available DataModels: Client, Server\n- Focused DataModel in the viewport: Client';
const text = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }] });
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CAPTURE_TOOL: Tool = { name: 'screen_capture', annotations: READ, inputSchema: { type: 'object', required: ['capture_id', 'studio_id'], properties: {
  camera_position: { type: 'array', items: { type: 'number' } }, capture_id: { type: 'string' },
  look_at_position: { type: 'array', items: { type: 'number' } }, studio_id: { type: 'string' } } } };
const TOOLS: Tool[] = [
  { name: 'list_roblox_studios', inputSchema: { type: 'object', properties: {} }, annotations: READ },
  { name: 'get_studio_state', inputSchema: { type: 'object', properties: { studio_id: { type: 'string' } }, required: ['studio_id'] }, annotations: READ },
  { name: 'execute_luau', inputSchema: { type: 'object', required: ['code', 'studio_id', 'datamodel_type'], properties: {
    code: { type: 'string' }, studio_id: { type: 'string' }, datamodel_type: { type: 'string', enum: ['Edit', 'Client', 'Server'] } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'start_stop_play', inputSchema: { type: 'object', properties: { is_start: { type: 'boolean' }, studio_id: { type: 'string' } }, required: ['is_start', 'studio_id'] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  CAPTURE_TOOL,
];

function gradient(width: number, height: number, noise = false): Buffer {
  const rgb = noise ? randomBytes(width * height * 3) : Buffer.alloc(width * height * 3);
  if (!noise) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 3; rgb[i] = x & 0xff; rgb[i + 1] = y & 0xff; rgb[i + 2] = (x + y) & 0xff;
  }
  return encodeRgbPng(rgb, width, height);
}
function rgbaPng(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (data: Buffer) => { let c = 0xffffffff; for (const byte of data) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (kind: string, data: Buffer) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(kind, 4, 'latin1');
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data]))); return Buffer.concat([head, data, tail]); };
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set([200, 100, 50, 7], y * (width * 4 + 1) + 1 + x * 4);
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('tEXt', Buffer.from('Comment\0fixture')),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('viewport image: normalized RGB PNG, longest side bounded, alpha and ancillary chunks dropped', () => {
  const source = gradient(1600, 900);
  const bounded = boundViewportPng(source, 768);
  assert.equal(bounded.width, 768); assert.equal(bounded.height, 432); assert.equal(bounded.downscaled, true);
  assert.equal(bounded.originalWidth, 1600); assert.equal(bounded.originalHeight, 900);
  assert.ok(bounded.bytes <= VIEWPORT_LIMITS.outputBytes); assert.equal(bounded.png.length, bounded.bytes);
  assert.equal(bounded.sha256, createHash('sha256').update(bounded.png).digest('hex'));
  const decoded = decodeViewportPng(bounded.png);
  assert.deepEqual([decoded.width, decoded.height], [768, 432]);
  const small = boundViewportPng(gradient(320, 200), 1024);
  assert.equal(small.downscaled, false); assert.deepEqual(decodeViewportPng(small.png).rgb, decodeViewportPng(gradient(320, 200)).rgb);
  const alpha = boundViewportPng(rgbaPng(300, 300), 256);
  assert.equal(alpha.width, 256); assert.equal(alpha.png.includes(Buffer.from('tEXt')), false);
  assert.deepEqual([...decodeViewportPng(alpha.png).rgb.subarray(0, 3)], [200, 100, 50]);
  // Incompressible content shrinks further until it fits the byte bound.
  const noisy = boundViewportPng(gradient(1024, 1024, true), 1024);
  assert.ok(noisy.bytes <= VIEWPORT_LIMITS.outputBytes && noisy.width < 1024, String(noisy.width));
});

test('viewport image: corrupt, oversized or unsupported PNGs are refused', () => {
  const good = gradient(300, 300);
  const corrupt = Buffer.from(good); corrupt[40] = corrupt[40]! ^ 0xff;
  for (const bytes of [corrupt, Buffer.from('not a png'), good.subarray(0, good.length - 4), Buffer.alloc(VIEWPORT_LIMITS.inputBytes + 1)])
    assert.throws(() => boundViewportPng(bytes));
  const tooWide = Buffer.from(good); tooWide.writeUInt32BE(VIEWPORT_LIMITS.inputDimension + 1, 16);
  assert.throws(() => decodeViewportPng(tooWide));
  for (const dimension of [255, 1025, 512.5]) assert.throws(() => boundViewportPng(good, dimension));
});

type Native = { mode: 'Edit' | 'Play'; calls: { name: string; args: Record<string, unknown> }[]; camera: number[][]; moveCamera: boolean; restoreWorks: boolean;
  image: () => CallToolResult; tools: Tool[] };
async function nativeFixture(t: TestContext, changes: Partial<Native> = {}) {
  const state: Native = { mode: 'Edit', calls: [], camera: [[0, 10, 20, 1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]], moveCamera: true, restoreWorks: true,
    image: () => ({ content: [{ type: 'image', data: gradient(1280, 720).toString('base64'), mimeType: 'image/png' }] }), tools: structuredClone(TOOLS), ...changes };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fixture-viewport-client', version: 'fixture-only' }, { capabilities: {} });
  const server = new Server({ name: 'RobloxStudio', version: 'fixture-only' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: structuredClone(state.tools) }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const call = { name: request.params.name, args: request.params.arguments ?? {} }; state.calls.push(structuredClone(call));
    assert.notEqual(call.name, 'start_stop_play', 'viewport capture never starts Play');
    if (call.name === 'list_roblox_studios') return text(JSON.stringify({ studios: [{ id: STUDIO, name: NAME }] }));
    assert.equal(call.args.studio_id, STUDIO);
    if (call.name === 'get_studio_state') return text(state.mode === 'Edit' ? EDIT : PLAY);
    if (call.name === 'execute_luau') {
      assert.equal(call.args.datamodel_type, 'Edit');
      if (call.args.code === VIEWPORT_CAMERA_READ_PROGRAM) return text(JSON.stringify({ cframe: state.camera[0], focus: state.camera[1] }));
      assert.match(String(call.args.code), /^local camera = workspace\.CurrentCamera\n/);
      if (state.restoreWorks) state.camera = [[0, 10, 20, 1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]];
      return text('{"restored":true}');
    }
    assert.equal(call.name, 'screen_capture');
    if (call.args.camera_position && state.moveCamera) state.camera = [[...call.args.camera_position as number[], 1, 0, 0, 0, 1, 0, 0, 0, 1], state.camera[1]!];
    return state.image();
  });
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return { state, client };
}
const capture = (client: Client, extra: Partial<Parameters<typeof captureEditViewport>[0]> = {}, verify = async () => 'evidence') =>
  captureEditViewport({ client, nativeStudioId: STUDIO, captureId: 'ArcaneViewport_fixture', maxDimension: 768, verifyBinding: verify,
    decodeMode: decodeTestMode, ...extra }, AbortSignal.timeout(10_000));

test('viewport capture: Edit-mode screen capture, bounded image, no camera or Luau without framing', async t => {
  const { state, client } = await nativeFixture(t);
  const image = await capture(client);
  assert.equal(image.camera, 'not_requested'); assert.equal(image.width, 768); assert.equal(image.height, 432);
  assert.deepEqual(state.calls.map(call => call.name), ['get_studio_state', 'screen_capture', 'get_studio_state']);
  assert.deepEqual(state.calls[1]!.args, { studio_id: STUDIO, capture_id: 'ArcaneViewport_fixture' });
});

test('viewport capture: framed capture restores the previous Edit camera with a fixed program', async t => {
  const { state, client } = await nativeFixture(t);
  const image = await capture(client, { camera: { position: [50, 40, 50], lookAt: [0, 0, 0] } });
  assert.equal(image.camera, 'restored');
  assert.deepEqual(state.calls.map(call => call.name), ['get_studio_state', 'execute_luau', 'screen_capture', 'execute_luau', 'execute_luau', 'execute_luau', 'get_studio_state']);
  assert.deepEqual(state.calls[2]!.args, { studio_id: STUDIO, capture_id: 'ArcaneViewport_fixture', camera_position: [50, 40, 50], look_at_position: [0, 0, 0] });
  assert.equal(state.calls[4]!.args.code, cameraRestoreProgram({ cframe: [0, 10, 20, 1, 0, 0, 0, 1, 0, 0, 0, 1], focus: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }));
  const still = await nativeFixture(t, { moveCamera: false });
  assert.equal((await capture(still.client, { camera: { position: [5, 5, 5], lookAt: [0, 0, 0] } })).camera, 'unchanged');
  const stuck = await nativeFixture(t, { restoreWorks: false });
  assert.equal((await capture(stuck.client, { camera: { position: [5, 5, 5], lookAt: [0, 0, 0] } })).camera, 'restore_failed');
  await assert.rejects(capture(client, { camera: { position: [0, 0, 0], lookAt: [0, 0, 0.1] } }), { code: 'INVALID_REQUEST' });
});

test('viewport capture: Play mode, widened tools, binding changes and bad images are refused', async t => {
  const play = await nativeFixture(t, { mode: 'Play' });
  await assert.rejects(capture(play.client), { code: 'MODE_MISMATCH' });
  assert.equal(play.state.calls.some(call => call.name === 'screen_capture'), false);
  for (const widen of [
    (tool: Tool) => { tool.inputSchema.properties!.path = { type: 'string' }; },
    (tool: Tool) => { tool.annotations = { ...tool.annotations, readOnlyHint: false }; },
    (tool: Tool) => { tool.inputSchema.required = ['studio_id']; },
  ]) {
    const tools = structuredClone(TOOLS); widen(tools.find(tool => tool.name === 'screen_capture')!);
    const native = await nativeFixture(t, { tools });
    await assert.rejects(capture(native.client), { code: 'UNSUPPORTED_TOOL' });
    assert.deepEqual(native.state.calls, []);
  }
  const missing = await nativeFixture(t, { tools: TOOLS.filter(tool => tool.name !== 'screen_capture') });
  await assert.rejects(capture(missing.client), { code: 'UNSUPPORTED_TOOL' });
  let reads = 0;
  const moved = await nativeFixture(t);
  await assert.rejects(capture(moved.client, {}, async () => 'evidence-' + reads++), { code: 'BINDING_CHANGED' });
  for (const image of [
    (): CallToolResult => ({ content: [{ type: 'image', data: gradient(64, 64).toString('base64'), mimeType: 'image/jpeg' }] }),
    (): CallToolResult => ({ content: [{ type: 'image', data: Buffer.from('not png').toString('base64'), mimeType: 'image/png' }] }),
    (): CallToolResult => ({ content: [{ type: 'text', text: 'no image' }] }),
    (): CallToolResult => ({ isError: true, content: [{ type: 'image', data: gradient(64, 64).toString('base64'), mimeType: 'image/png' }] }),
  ]) {
    const native = await nativeFixture(t, { image });
    await assert.rejects(capture(native.client), { code: 'BAD_NATIVE_RESPONSE' });
  }
});

async function serviceFixture(t: TestContext, options: { allowWrites?: boolean; mode?: 'Edit' | 'Play' } = {}) {
  const root = makeFixtureDirectory('arcane-studio-viewport-');
  const store = new StudioStore({ directory: join(root, 'store') });
  const grant = store.createGrant({ allowedRoots: ['Workspace', 'ServerStorage'], allowWrites: options.allowWrites ?? true });
  const pair = store.pair({ code: grant.code, protocolVersion: 1, identity: { clientSessionId: 'plugin-viewport-lifetime', placeId: 0, universeId: 0, name: NAME, pluginVersion: 'fixture-only' },
    capabilities: ['scene.children'] });
  store.authenticate(pair.sessionId, pair.token);
  // A continuity marker needs writable ServerStorage; a read-only pairing never publishes one.
  if (options.allowWrites !== false) store.poll(pair.sessionId, { sessionId: pair.sessionId, clientLifetimeId: 'plugin-viewport-lifetime', pluginArtifactHash: ARTIFACT, markerName: MARKER,
    placeId: 0, universeId: 0, placeName: NAME, mode: options.mode ?? 'Edit', playEpoch: 4, continuitySupported: true, connected: true });
  const witnesses: string[] = []; let closes = 0; let natives: Awaited<ReturnType<typeof nativeFixture>>[] = [];
  const connect = async (): Promise<NativeTestConnection> => {
    const native = await nativeFixture(t); natives.push(native);
    return { client: native.client, evidence: 'fixture', async witness(studioId, markerName, mode) {
      witnesses.push(studioId + ':' + markerName + ':' + mode);
      const s = store.session(pair.sessionId);
      return { placeId: 0, universeId: 0, placeName: s.name, sessionId: s.id, clientLifetimeId: s.clientSessionId, pluginArtifactHash: ARTIFACT };
    }, async close() { closes++; } };
  };
  const service = await createStudioTestService({ directory: join(root, 'service'), store, pluginArtifactHash: ARTIFACT, connect });
  t.after(async () => { await service.lifecycle.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { service, pair, witnesses, closes: () => closes, natives: () => natives };
}

test('viewport service: exact paired Edit session, witnessed mapping, base64 PNG and closed connection', async t => {
  const f = await serviceFixture(t);
  const result = await f.service.requests.viewport({ sessionId: f.pair.sessionId, maxDimension: 512 }, 'agent-fixture');
  assert.equal(result.viewport.sessionId, f.pair.sessionId); assert.equal(result.viewport.nativeStudioId, STUDIO);
  assert.equal(result.viewport.mode, 'Edit'); assert.equal(result.viewport.width, 512); assert.equal(result.viewport.evidence, 'fixture');
  assert.equal(Buffer.from(result.data, 'base64').length, result.viewport.bytes);
  assert.deepEqual(f.witnesses, [STUDIO + ':' + MARKER + ':Edit', STUDIO + ':' + MARKER + ':Edit']);
  assert.equal(f.closes(), 1);
  await assert.rejects(f.service.requests.viewport({ sessionId: f.pair.sessionId, maxDimension: 2048 }, 'agent-fixture'));
  await assert.rejects(f.service.requests.viewport({ sessionId: f.pair.sessionId, code: 'print(1)' }, 'agent-fixture'));
  await assert.rejects(f.service.requests.viewport({ sessionId: 'missing-session' }, 'agent-fixture'), { code: 'SESSION' });
});

test('viewport service: Play mode and sessions without the exact write grant are refused before any native call', async t => {
  const play = await serviceFixture(t, { mode: 'Play' });
  await assert.rejects(play.service.requests.viewport({ sessionId: play.pair.sessionId }, 'agent-fixture'), { code: 'MODE_MISMATCH' });
  assert.equal(play.natives().length, 0);
  const readOnly = await serviceFixture(t, { allowWrites: false });
  await assert.rejects(readOnly.service.requests.viewport({ sessionId: readOnly.pair.sessionId }, 'agent-fixture'), { code: 'PLACE_DENIED' });
  assert.equal(readOnly.natives().length, 0);
});

async function routeFixture(t: TestContext, viewport?: NonNullable<StudioTestRouteService['requests']['viewport']>) {
  const refuse = async (): Promise<never> => { throw new Error('unused'); };
  const service: StudioTestRouteService = { requests: { prepare: refuse, status: refuse, list: refuse, cancel: refuse, ...(viewport ? { viewport } : {}) },
    humanControl: { approve: refuse }, lifecycle: { async close() {} } };
  const route = studioTestRoutes(service, request => request.headers.authorization === 'Bearer agent-token' ? { kind: 'agent', id: 'agent-fixture' } : null);
  let origin = '';
  const server = createServer((request, response) => { void route(request, response, new URL(request.url ?? '/', origin), origin); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { origin, post: (body: unknown) => new Promise<{ status: number; json: any }>((resolve, reject) => {
    const outgoing = httpRequest(origin + '/v1/playtests/viewport', { method: 'POST', agent: false, headers: { Authorization: 'Bearer agent-token', 'Content-Type': 'application/json' } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk)); response.once('end', () => resolve({ status: response.statusCode!, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    outgoing.once('error', reject); outgoing.end(JSON.stringify(body));
  }) };
}
const viewportRecord = (png: Buffer, sessionId = 'paired-fixture') => ({ viewport: { sessionId, nativeStudioId: STUDIO, mode: 'Edit' as const, mimeType: 'image/png' as const,
  width: 64, height: 64, originalWidth: 64, originalHeight: 64, downscaled: false, bytes: png.length, sha256: createHash('sha256').update(png).digest('hex'),
  camera: 'not_requested' as const, evidence: 'fixture' as const }, data: png.toString('base64') });

test('viewport route: bounded POST returns the image record; refusals are definite and fields are closed', async t => {
  const png = boundViewportPng(gradient(64, 64), 256).png, seen: unknown[] = [];
  const f = await routeFixture(t, async (input, actor) => { seen.push({ input, actor }); return viewportRecord(png); });
  const ok = await f.post({ sessionId: 'paired-fixture', maxDimension: 512 });
  assert.equal(ok.status, 200); assert.equal(ok.json.viewport.bytes, png.length);
  assert.deepEqual(seen, [{ input: { sessionId: 'paired-fixture', maxDimension: 512 }, actor: 'agent-fixture' }]);
  assert.equal((await f.post({ sessionId: 'paired-fixture', code: 'print(1)' })).status, 400);
  assert.equal(seen.length, 1);
  for (const [code, expected, status] of [['UNSUPPORTED_TOOL', 'VIEWPORT_TOOL_UNSUPPORTED', 422], ['BAD_NATIVE_RESPONSE', 'VIEWPORT_INVALID', 424],
    ['MODE_MISMATCH', 'MODE_MISMATCH', 409], ['EFFECT_UNKNOWN', 'VIEWPORT_CAMERA_UNKNOWN', 409], ['SESSION', 'SESSION_NOT_FOUND', 404]] as const) {
    const refusing = await routeFixture(t, async () => { throw Object.assign(new Error(code), { code }); });
    const response = await refusing.post({ sessionId: 'paired-fixture' });
    assert.deepEqual([response.status, response.json.error], [status, expected]);
  }
  const absent = await routeFixture(t);
  assert.equal((await absent.post({ sessionId: 'paired-fixture' })).status, 503);
});

test('viewport MCP tool: advertised read tool returns image content plus a small JSON summary', async t => {
  const png = boundViewportPng(gradient(64, 64), 256).png, bodies: unknown[] = [];
  let reply: (sessionId: string) => unknown = sessionId => viewportRecord(png, sessionId);
  const daemon = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(chunk));
    request.once('end', () => {
      assert.equal(request.url, '/v1/playtests/viewport'); const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); bodies.push(body);
      const json = JSON.stringify(reply(body.sessionId)); response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) }); response.end(json);
    });
  });
  await new Promise<void>(resolve => daemon.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { daemon.closeAllConnections(); daemon.close(() => resolve()); }));
  const client = new DaemonClient({ url: 'http://127.0.0.1:' + (daemon.address() as { port: number }).port, token: 'fixture-viewport-token' });
  const server = createMcpServer({ client, projectRoot: process.cwd() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'fixture-viewport-mcp', version: 'fixture-only' }, { capabilities: {} });
  await server.connect(serverTransport); await mcp.connect(clientTransport);
  t.after(async () => { await mcp.close(); await server.close(); });
  const tools = (await mcp.listTools()).tools, tool = tools.find(item => item.name === 'studio_viewport_capture')!;
  assert.deepEqual(tools.map(item => item.name).sort(), [...ARCANE_TOOL_NAMES].sort());
  assert.equal(tool.annotations?.readOnlyHint, true); assert.equal(tool.inputSchema.additionalProperties, false);
  assert.ok(tool.inputSchema.properties?.camera && tool.inputSchema.properties?.maxDimension);
  assert.match(tool.description ?? '', /2–3 captures per task/);
  const result = CallToolResultSchema.parse(await mcp.callTool({ name: 'studio_viewport_capture', arguments: { sessionId: 'paired-fixture', camera: { position: [10, 10, 10], lookAt: [0, 0, 0] } } }));
  assert.notEqual(result.isError, true);
  const image = result.content.find(item => item.type === 'image');
  assert.ok(image && image.type === 'image'); assert.equal(image.mimeType, 'image/png'); assert.deepEqual(Buffer.from(image.data, 'base64'), png);
  const summary = result.content.find(item => item.type === 'text');
  assert.ok(summary && summary.type === 'text'); assert.equal(JSON.parse(summary.text).viewport.sha256, createHash('sha256').update(png).digest('hex'));
  assert.equal(summary.text.includes(png.toString('base64')), false, 'image bytes are not duplicated into text');
  assert.deepEqual(bodies, [{ sessionId: 'paired-fixture', maxDimension: 768, camera: { position: [10, 10, 10], lookAt: [0, 0, 0] } }]);
  for (const args of [{ sessionId: 'paired-fixture', maxDimension: 4096 }, { sessionId: 'paired-fixture', code: 'x' }, { sessionId: 'paired-fixture', camera: { position: [0, 0, 0], lookAt: [0, 0, 0] } }])
    assert.equal(CallToolResultSchema.parse(await mcp.callTool({ name: 'studio_viewport_capture', arguments: args })).isError, true);
  assert.equal(bodies.length, 1, 'invalid inputs never reach the daemon');
  reply = sessionId => ({ ...viewportRecord(png, sessionId), data: gradient(8, 8).toString('base64') });
  const mismatched = CallToolResultSchema.parse(await mcp.callTool({ name: 'studio_viewport_capture', arguments: { sessionId: 'paired-fixture' } }));
  assert.equal(mismatched.isError, true); assert.match(JSON.stringify(mismatched.content), /PROTOCOL/);
});

test('viewport capture: a multi-view sheet captures 2–4 framed views, restores the camera once and stays within the image bounds', async t => {
  const { state, client } = await nativeFixture(t);
  const sheet: { position: [number, number, number]; lookAt: [number, number, number] }[] = [{ position: [40, 20, -40], lookAt: [0, 0, 0] }, { position: [0, 60, -5], lookAt: [0, 0, 0] }, { position: [0, 8, -50], lookAt: [0, 0, 0] }];
  const image = await capture(client, { sheet });
  assert.equal(image.views, 3); assert.equal(image.camera, 'restored');
  assert.ok(image.width <= 768 && image.height <= 768 && image.bytes <= VIEWPORT_LIMITS.outputBytes);
  const shots = state.calls.filter(call => call.name === 'screen_capture');
  assert.deepEqual(shots.map(call => call.args.camera_position), sheet.map(camera => camera.position));
  assert.equal(new Set(shots.map(call => call.args.capture_id)).size, 3, 'distinct capture ids');
  assert.deepEqual(state.calls.map(call => call.name), ['get_studio_state', 'execute_luau', 'screen_capture', 'screen_capture', 'screen_capture',
    'execute_luau', 'execute_luau', 'execute_luau', 'get_studio_state']);
  await assert.rejects(capture(client, { sheet: [sheet[0]!] }));
  await assert.rejects(capture(client, { camera: sheet[0]!, sheet }));
});

test('viewport MCP tool: frame {ref, views} reads plugin bounds and sends computed cameras as one sheet', async t => {
  const png = boundViewportPng(gradient(64, 64), 256).png, bodies: Record<string, unknown>[] = [];
  const ref = { instanceId: 'opaque-tower', sessionId: 'paired-fixture', root: 'Workspace', pathSegments: ['Tower'], className: 'Model' };
  let bounds: unknown = { center: [0, 20, 0], size: [10, 40, 10], space: 'world-aabb' };
  const daemon = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(chunk));
    request.once('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); bodies.push({ url: request.url, ...body });
      const now = new Date().toISOString();
      const reply = request.url === '/v1/studio/commands' ? { command: { protocolVersion: 1, id: 'cmd-1', requestId: body.requestId, sessionId: body.sessionId, clientSessionId: 'life',
        method: body.method, args: body.args, allowedRoots: ['Workspace'], allowWrites: true, leaseEpoch: 1, expiresAt: now, state: 'succeeded', createdAt: now, finishedAt: now,
        result: { ref, name: 'Tower', className: 'Model', childCount: 3, properties: { Name: 'Tower' }, bounds }, error: null } } : viewportRecord(png, body.sessionId);
      const json = JSON.stringify(reply); response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) }); response.end(json);
    });
  });
  await new Promise<void>(resolve => daemon.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { daemon.closeAllConnections(); daemon.close(() => resolve()); }));
  const client = new DaemonClient({ url: 'http://127.0.0.1:' + (daemon.address() as { port: number }).port, token: 'fixture-viewport-token' });
  const server = createMcpServer({ client, projectRoot: process.cwd() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'fixture-viewport-frame', version: 'fixture-only' }, { capabilities: {} });
  await server.connect(serverTransport); await mcp.connect(clientTransport);
  t.after(async () => { await mcp.close(); await server.close(); });
  const result = CallToolResultSchema.parse(await mcp.callTool({ name: 'studio_viewport_capture', arguments: { sessionId: 'paired-fixture', frame: { ref, views: ['front', 'top', 'low_angle'] } } }));
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  assert.deepEqual(bodies[0], { url: '/v1/studio/commands', sessionId: 'paired-fixture', requestId: bodies[0]!.requestId, method: 'scene.inspect', args: { ref, bounds: true } });
  const sent = bodies[1]!.sheet as { position: number[]; lookAt: number[] }[];
  assert.equal(bodies[1]!.url, '/v1/playtests/viewport'); assert.equal(sent.length, 3); assert.equal(bodies[1]!.camera, undefined);
  assert.deepEqual(sent[0]!.lookAt, [0, 20, 0]); assert.ok(sent[1]!.position[1]! > 40 && sent[2]!.position[1]! < 20);
  const summary = JSON.parse((result.content.find(item => item.type === 'text') as { text: string }).text);
  assert.deepEqual(summary.framing.views, ['front', 'top', 'low_angle']);
  const single = CallToolResultSchema.parse(await mcp.callTool({ name: 'studio_viewport_capture', arguments: { sessionId: 'paired-fixture', frame: { ref } } }));
  assert.notEqual(single.isError, true); assert.ok(bodies[3]!.camera && !bodies[3]!.sheet, 'one view sends a single camera');
  bounds = undefined;
  const old = CallToolResultSchema.parse(await mcp.callTool({ name: 'studio_viewport_capture', arguments: { sessionId: 'paired-fixture', frame: { ref } } }));
  assert.equal(old.isError, true); assert.match(JSON.stringify(old.content), /PLUGIN_UPDATE_REQUIRED/);
  const both = CallToolResultSchema.parse(await mcp.callTool({ name: 'studio_viewport_capture', arguments: { sessionId: 'paired-fixture', frame: { ref }, camera: { position: [9, 9, 9], lookAt: [0, 0, 0] } } }));
  assert.equal(both.isError, true);
  assert.equal(CallToolResultSchema.parse(await mcp.callTool({ name: 'studio_viewport_capture', arguments: { sessionId: 'paired-fixture', frame: { ref, views: ['front'] } } })).isError, true);
});
