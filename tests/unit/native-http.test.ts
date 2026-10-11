import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { NativeStudioSession } from '../../packages/studio-adapter/src/session.js';
import { NativeStudioError } from '../../packages/studio-adapter/src/index.js';
import { nativeRoutes, NATIVE_HTTP_BODY_BYTES, type NativeHttpSession, type NativeRouteOptions } from '../../apps/daemon/src/native-routes.js';

const HUMAN = 'human-native-http-fixture-control-token';
const AGENT = 'model-agent-native-http-fixture-token';
const A = 'native-http-fixture-a', B = 'native-http-fixture-b';
const textResult = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });
const tool = (name: string, required: string[], properties: Record<string, object> = {}): Tool => ({
  name, annotations: { readOnlyHint: true },
  inputSchema: { type: 'object', required, properties: name === 'list_roblox_studios' ? {} : { studio_id: { type: 'string' }, ...properties } },
});
const tools = [
  tool('list_roblox_studios', []), tool('get_studio_state', ['studio_id']), tool('get_console_output', ['studio_id']),
  tool('search_game_tree', ['studio_id', 'datamodel_type'], { datamodel_type: { type: 'string', enum: ['Edit', 'Client', 'Server'] }, path: { type: 'string' }, instance_type: { type: 'string' }, keywords: { type: 'string' }, max_depth: { type: 'number' }, head_limit: { type: 'number' } }),
  tool('inspect_instance', ['studio_id', 'path'], { path: { type: 'string' } }),
  tool('script_read', ['studio_id', 'target_file'], { target_file: { type: 'string' }, should_read_entire_file: { type: 'boolean' }, start_line_one_indexed: { type: 'number' }, end_line_one_indexed_inclusive: { type: 'number' } }),
  tool('script_search', ['studio_id', 'keywords'], { keywords: { type: 'string' } }), tool('script_grep', ['studio_id', 'query'], { query: { type: 'string' } }),
  tool('execute_luau', ['studio_id'], { code: { type: 'string' } }),
];
function fixtureConnector(options: {
  inventory?: unknown;
  handle?: (method: string, args: Record<string, unknown>, connection: number) => Promise<CallToolResult>;
  waitBeforeReturn?: (connection: number) => Promise<void>;
  closeFails?: boolean;
} = {}) {
  const state = { created: 0, closed: 0, listed: 0, calls: [] as { connection: number; method: string; args: Record<string, unknown> }[] };
  const connect = async (): Promise<NativeHttpSession> => {
    const connection = ++state.created;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: 'arcane-native-http-sdk-fixture', version: 'fixture-only' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => { state.listed++; return { tools }; });
    server.setRequestHandler(CallToolRequestSchema, async request => {
      const args = request.params.arguments ?? {};
      state.calls.push({ connection, method: request.params.name, args });
      if (request.params.name === 'list_roblox_studios')
        return textResult(options.inventory ?? { studios: [{ id: A, name: 'HTTP UNIT FIXTURE A' }, { id: B, name: 'HTTP UNIT FIXTURE B' }] });
      return options.handle ? options.handle(request.params.name, args, connection) : textResult({ fixtureOnly: true, studio_id: args.studio_id });
    });
    await server.connect(serverTransport);
    const session = new NativeStudioSession(clientTransport, { kind: 'fixture', label: 'HTTP unit SDK fixture; not a live Studio place' }, { timeoutMs: 500, maxRequests: 16 });
    try { await session.initialize(); }
    catch (error) { await session.close(); await server.close(); throw error; }
    if (options.waitBeforeReturn) await options.waitBeforeReturn(connection);
    let closing: Promise<void> | undefined;
    return {
      metadata: session.metadata.bind(session), listStudios: session.listStudios.bind(session), read: session.read.bind(session),
      close: () => {
        closing ??= (async () => {
          await session.close(); await server.close(); state.closed++;
          if (options.closeFails) throw new Error('raw close secret ' + HUMAN);
        })();
        return closing;
      },
    };
  };
  return { connect, state };
}
async function harness(options: NativeRouteOptions, controlToken = HUMAN) {
  const route = nativeRoutes(options);
  let origin = '';
  const handled: boolean[] = [];
  const server = createServer((request, response) => {
    void route(request, response, new URL(request.url ?? '/', origin), controlToken, origin).then(result => {
      handled.push(result);
      if (!result) { response.writeHead(404, { 'Content-Type': 'application/json' }); response.end('{"outsideNative":true}'); }
    }).catch(error => { response.destroy(error as Error); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  origin = 'http://127.0.0.1:' + address.port;
  const get = (path = '/v1/native/capabilities', token = HUMAN, headers: Record<string, string> = {}) =>
    raw(origin, path, 'GET', undefined, { Authorization: 'Bearer ' + token, ...headers });
  const post = (body: unknown, headers: Record<string, string> = {}, token = HUMAN) =>
    raw(origin, '/v1/native/read', 'POST', Buffer.from(JSON.stringify(body)), { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...headers });
  const close = async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); };
  return { origin, get, post, close, handled, server };
}
function raw(origin: string, path: string, method: string, body?: Buffer, headers: Record<string, string | string[]> = {}, chunked = false) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string; json: Record<string, any> }>((resolve, reject) => {
    const request = httpRequest(new URL(path, origin), { method, headers: {
      ...headers, ...(body && !chunked ? { 'Content-Length': String(body.length) } : {}),
    } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text, json: JSON.parse(text) as Record<string, any> }); }
        catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    if (body && chunked) { request.write(body.subarray(0, 16_000)); request.write(body.subarray(16_000)); request.end(); }
    else request.end(body);
  });
}

test('native namespace is separate; unknown paths/methods/query fields cannot connect or fall back to plugin routes', async t => {
  const f = fixtureConnector(), h = await harness(f); t.after(h.close);
  assert.equal((await h.get('/v1/studio/sessions')).status, 404);
  assert.ok(h.handled.includes(false));
  assert.equal((await h.get('/v1/native/unknown')).json.error, 'NOT_FOUND');
  const wrong = await raw(h.origin, '/v1/native/read', 'GET', undefined, { Authorization: 'Bearer ' + HUMAN });
  assert.equal(wrong.status, 405); assert.equal(wrong.headers.allow, 'POST');
  const query = await h.get('/v1/native/capabilities?studio_id=' + A);
  assert.equal(query.status, 400); assert.equal(query.json.error, 'QUERY');
  assert.equal(f.state.created, 0);
});

test('human control bearer alone is accepted; agent/absent/ambiguous auth is denied before native discovery', async t => {
  const f = fixtureConnector(), h = await harness(f); t.after(h.close);
  for (const authorization of [undefined, 'Bearer ' + AGENT, 'Basic ' + HUMAN, HUMAN, 'Bearer wrong']) {
    const r = await raw(h.origin, '/v1/native/capabilities', 'GET', undefined, authorization ? { Authorization: authorization } : {});
    assert.equal(r.status, 401); assert.equal(r.json.error, 'AUTH');
    assert.equal(r.body.includes(HUMAN), false); assert.equal(r.body.includes(AGENT), false);
  }
  const duplicate = await raw(h.origin, '/v1/native/capabilities', 'GET', undefined, { Authorization: ['Bearer ' + HUMAN, 'Bearer ' + AGENT] });
  assert.equal(duplicate.status, 401); assert.equal(f.state.created, 0);
  const r = await h.get();
  assert.equal(r.status, 200); assert.equal(f.state.created, 1); assert.equal(f.state.closed, 1);
  const empty = await harness(f, ''); t.after(empty.close);
  assert.equal((await empty.get()).json.error, 'AUTH');
  assert.equal(f.state.created, 1);
});

test('Origin must match when supplied; browser POST needs exact Origin while native human CLI can omit it', async t => {
  const f = fixtureConnector(), h = await harness(f); t.after(h.close);
  const read = { method: 'get_studio_state', args: { studio_id: A } };
  for (const origin of ['https://attacker.example', 'null', '']) {
    assert.equal((await h.get('/v1/native/capabilities', HUMAN, { Origin: origin })).status, 403);
    assert.equal((await h.post(read, { Origin: origin })).status, 403);
  }
  assert.equal((await h.post(read, { 'Sec-Fetch-Site': 'same-origin' })).status, 403);
  assert.equal((await h.post(read, { 'User-Agent': 'Mozilla/5.0' })).status, 403);
  assert.equal(f.state.created, 0);
  assert.equal((await h.post(read, { 'Sec-Fetch-Site': 'same-origin', Origin: h.origin })).status, 200);
  assert.equal((await h.post(read, { 'Sec-Fetch-Mode': 'cors' })).status, 200); // Node human CLI fetch convention.
  assert.equal((await h.post(read, {}, AGENT)).status, 401);
  assert.equal(f.state.created, 2); assert.equal(f.state.closed, 2);
});

test('host and URL origin checks enforce loopback instead of trusting Host forwarding', async t => {
  const f = fixtureConnector(), h = await harness(f); t.after(h.close);
  const r = await h.get('/v1/native/capabilities', HUMAN, { Host: 'attacker.example' });
  assert.equal(r.status, 403); assert.equal(r.json.error, 'HOST'); assert.equal(f.state.created, 0);
});

test('capabilities use fresh actual SDK metadata/inventory only, preserve fixture provenance and await closure', async t => {
  const f = fixtureConnector(), h = await harness(f); t.after(h.close);
  for (let index = 1; index <= 2; index++) {
    const r = await h.get();
    assert.equal(r.status, 200); assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.json.native.kind, 'built-in-studio-mcp'); assert.equal(r.json.native.readOnly, true); assert.equal(r.json.native.available, true);
    assert.equal(r.json.native.requiresExplicitRead, true);
    assert.equal(r.json.native.provenance.kind, 'fixture');
    assert.equal(r.json.native.metadata.evidenceKind, 'fixture'); assert.equal(r.json.native.metadata.connected, false);
    assert.equal(r.json.native.metadata.sdkVersion, '1.32.1');
    assert.equal(r.json.native.metadata.tools.find((tool: any) => tool.name === 'execute_luau').allowed, false);
    assert.deepEqual(r.json.studios.map((item: any) => item.id), [A, B]);
    assert.equal('result' in r.json, false); assert.equal('sessionId' in r.json, false);
    assert.equal(f.state.created, index); assert.equal(f.state.closed, index); assert.equal(f.state.listed, index);
  }
  assert.deepEqual(f.state.calls.map(call => call.method), ['list_roblox_studios', 'list_roblox_studios']);
});

test('all seven HTTP read methods require explicit target; selected ID is refreshed/forwarded by the adapter', async t => {
  const f = fixtureConnector(), h = await harness(f); t.after(h.close);
  const reads = [
    { method: 'get_studio_state', args: { studio_id: A } },
    { method: 'get_console_output', args: { studio_id: B } },
    { method: 'search_game_tree', args: { studio_id: A, datamodel_type: 'Edit', path: 'Workspace' } },
    { method: 'inspect_instance', args: { studio_id: B, path: 'Workspace.Baseplate' } },
    { method: 'script_read', args: { studio_id: A, target_file: 'game.ServerScriptService.ExistingFixture' } },
    { method: 'script_search', args: { studio_id: B, keywords: 'ExistingFixture' } },
    { method: 'script_grep', args: { studio_id: A, query: 'function' } },
  ];
  for (const read of reads) {
    const r = await h.post(read);
    assert.equal(r.status, 200); assert.equal(r.json.method, read.method); assert.equal(r.json.studio_id, read.args.studio_id);
    assert.equal(r.json.native.metadata.connected, false);
  }
  const targeted = f.state.calls.filter(call => call.method !== 'list_roblox_studios');
  assert.deepEqual(targeted.map(call => call.args.studio_id), reads.map(read => read.args.studio_id));
  assert.equal(f.state.calls.filter(call => call.method === 'list_roblox_studios').length, reads.length);
  assert.equal(f.state.created, reads.length); assert.equal(f.state.closed, reads.length);
});

test('stale target is unavailable after fresh inventory; other open window is never substituted', async t => {
  const f = fixtureConnector({ inventory: { studios: [{ id: B, name: 'OTHER UNIT FIXTURE' }] } }), h = await harness(f); t.after(h.close);
  const r = await h.post({ method: 'get_studio_state', args: { studio_id: A } });
  assert.equal(r.status, 404); assert.equal(r.json.error, 'STUDIO_NOT_FOUND');
  assert.deepEqual(f.state.calls.map(call => call.method), ['list_roblox_studios']);
  assert.equal(f.state.closed, 1);
});

test('strict envelope/method/args validation rejects evaluation, writes, play, schemas and server overrides before connection', async t => {
  const f = fixtureConnector(), h = await harness(f); t.after(h.close);
  for (const method of ['execute_luau', 'multi_edit', 'start_stop_play', 'publish', 'script.update', 'user_keyboard_input', 'insert_asset', 'subagent', 'list_roblox_studios'])
    assert.equal((await h.post({ method, args: { studio_id: A } })).status, 403);
  const invalid = [
    null, [], { method: 'get_studio_state' }, { args: { studio_id: A } },
    { method: 'get_studio_state', args: null }, { method: 'get_studio_state', args: [] },
    { method: 'get_studio_state', args: {} }, { method: 'get_studio_state', args: { studio_id: '' } },
    { method: 'get_studio_state', args: { studio_id: A, code: 'return 1' } },
    { method: 'get_studio_state', args: { studio_id: A }, server: 'evil.exe' },
    { method: 'get_studio_state', args: { studio_id: A }, schema: {} },
    { method: 'get_studio_state', args: { studio_id: A }, origin: h.origin },
    { method: 'get_studio_state', args: { studio_id: A, transport: 'shell', args: ['/c', 'evil'] } },
    { method: 'script_read', args: { studio_id: A, target_file: 'game.Fixture', source: 'overwrite' } },
    { method: 'script_read', args: { studio_id: A, target_file: 'game.Fixture', should_read_entire_file: false, start_line_one_indexed: 1, end_line_one_indexed_inclusive: 501 } },
    { method: 'search_game_tree', args: { studio_id: A, datamodel_type: 'Edit', head_limit: 201 } },
    { method: 'search_game_tree', args: { studio_id: A, datamodel_type: 'Edit', max_depth: 11 } },
    { method: 'inspect_instance', args: { studio_id: A, path: 'Workspace', properties: { Name: 'write' } } },
  ];
  for (const input of invalid) assert.equal((await h.post(input)).status, 400);
  assert.equal(f.state.created, 0);
});

test('32 KiB UTF-8 body bound applies to content-length and chunked bodies; MIME/encoding/JSON errors cannot connect', async t => {
  const f = fixtureConnector(), h = await harness(f); t.after(h.close);
  const headers = { Authorization: 'Bearer ' + HUMAN, 'Content-Type': 'application/json' };
  const tooLarge = Buffer.from(JSON.stringify({ method: 'script_grep', args: { studio_id: A, query: '🙂'.repeat(9_000) } }));
  assert.ok(tooLarge.length > NATIVE_HTTP_BODY_BYTES);
  for (const chunked of [false, true]) {
    const r = await raw(h.origin, '/v1/native/read', 'POST', tooLarge, headers, chunked);
    assert.equal(r.status, 413); assert.equal(r.json.error, 'BODY_LIMIT');
  }
  assert.equal((await raw(h.origin, '/v1/native/read', 'POST', Buffer.from('x'.repeat(NATIVE_HTTP_BODY_BYTES)), headers)).status, 400);
  assert.equal((await raw(h.origin, '/v1/native/read', 'POST', Buffer.from('{'), headers)).status, 400);
  assert.equal((await raw(h.origin, '/v1/native/read', 'POST', Buffer.from([0xff]), headers)).status, 400);
  assert.equal((await raw(h.origin, '/v1/native/read', 'POST', Buffer.from('{}'), { ...headers, 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await raw(h.origin, '/v1/native/read', 'POST', Buffer.from('{}'), { ...headers, 'Content-Encoding': 'gzip' })).status, 415);
  assert.equal(f.state.created, 0);
});

test('native gate is global across factories and routes; BUSY does not open or queue another connection', async t => {
  let release!: () => void, began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixtureConnector({ handle: async () => { began(); await gate; return textResult('FIXTURE READ'); } });
  const h1 = await harness(f), h2 = await harness(f); t.after(h1.close); t.after(h2.close);
  const first = h1.post({ method: 'get_studio_state', args: { studio_id: A } }); await started;
  try {
    const busy = await h2.get(); assert.equal(busy.status, 409); assert.equal(busy.json.error, 'BUSY');
    assert.equal(busy.json.native.busy, true); assert.equal(f.state.created, 1);
  } finally { release(); }
  assert.equal((await first).status, 200); assert.equal(f.state.closed, 1);
  assert.equal((await h2.get()).status, 200); assert.equal(f.state.created, 2); assert.equal(f.state.closed, 2);
});

test('timeouts/native failures close fresh session, release gate and expose bounded generic errors', async t => {
  const f = fixtureConnector({ handle: async (_method, _args, connection) => {
    if (connection === 1) return new Promise<CallToolResult>(() => {});
    throw new Error('provider-like secret ' + HUMAN);
  } }), h = await harness(f); t.after(h.close);
  const timed = await h.post({ method: 'get_studio_state', args: { studio_id: A } });
  assert.equal(timed.status, 504); assert.equal(timed.json.error, 'STUDIO_TIMEOUT'); assert.equal(f.state.closed, 1);
  const failed = await h.post({ method: 'get_studio_state', args: { studio_id: B } });
  assert.equal(failed.status, 502); assert.equal(failed.json.error, 'STUDIO_REQUEST_FAILED');
  assert.equal(failed.body.includes(HUMAN), false); assert.equal(failed.body.includes('provider-like secret'), false);
  assert.equal(f.state.closed, 2);
  assert.equal((await h.get()).status, 200); assert.equal(f.state.closed, 3);
});

test('source and total HTTP response size remain bounded; results are available only through explicit reads', async t => {
  const f = fixtureConnector({ handle: async method => textResult('x'.repeat(method === 'script_read' ? 103_000 : 524_180)) }), h = await harness(f); t.after(h.close);
  assert.equal((await h.post({ method: 'script_read', args: { studio_id: A, target_file: 'game.ExistingFixture' } })).status, 413);
  assert.equal((await h.post({ method: 'get_console_output', args: { studio_id: A } })).status, 413);
  assert.equal(f.state.closed, 2);
  const r = await h.get(); assert.equal(r.status, 200); assert.equal('result' in r.json, false);
});

test('bearer cannot leak through untrusted read text; returned tool errors remain errors after cleanup', async t => {
  const f = fixtureConnector({ handle: async () => ({ ...textResult('untrusted literal ' + HUMAN), isError: true }) }), h = await harness(f); t.after(h.close);
  const r = await h.post({ method: 'get_studio_state', args: { studio_id: A } });
  assert.equal(r.status, 502); assert.equal(r.json.result.isError, true); assert.equal(r.json.error, 'STUDIO_TOOL_ERROR'); assert.equal(r.body.includes(HUMAN), false);
  assert.ok(r.body.includes('[REDACTED]')); assert.equal(f.state.closed, 1);
});

test('connector/cleanup failures do not claim success or strand the global gate', async t => {
  let attempts = 0;
  const f = fixtureConnector({ closeFails: true });
  const h = await harness({ connect: async () => {
    if (++attempts === 1) throw new NativeStudioError('STUDIO_EXECUTABLE', 'raw secret ' + HUMAN);
    if (attempts === 2) throw new NativeStudioError('toString', 'unknown raw secret ' + HUMAN);
    return f.connect();
  } }); t.after(h.close);
  const unavailable = await h.get(); assert.equal(unavailable.status, 503); assert.equal(unavailable.json.error, 'STUDIO_EXECUTABLE');
  assert.equal(unavailable.body.includes(HUMAN), false);
  const unknown = await h.get(); assert.equal(unknown.status, 502); assert.equal(unknown.json.error, 'NATIVE_ERROR');
  assert.equal(unknown.body.includes(HUMAN), false);
  const cleanup = await h.get(); assert.equal(cleanup.status, 502); assert.equal(cleanup.json.error, 'STUDIO_CLOSE_FAILED');
  assert.equal(f.state.closed, 1);
  assert.equal((await h.get()).json.error, 'STUDIO_CLOSE_FAILED'); assert.equal(f.state.closed, 2);
});

test('disconnect while connector resolves late still closes owned connection without issuing an inventory/read', async t => {
  let release!: () => void, began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixtureConnector({ waitBeforeReturn: async connection => { if (connection === 1) { began(); await gate; } } });
  const h = await harness(f); t.after(h.close);
  let disconnected!: () => void;
  const observedDisconnect = new Promise<void>(resolve => { disconnected = resolve; });
  h.server.once('request', (_request, response) => { response.once('close', disconnected); });
  const request = httpRequest(h.origin + '/v1/native/capabilities', { headers: { Authorization: 'Bearer ' + HUMAN } });
  request.on('error', () => {}); request.end(); await started; request.destroy();
  await observedDisconnect;
  release();
  const limit = Date.now() + 2_000;
  while (f.state.closed !== 1 && Date.now() < limit) await new Promise<void>(resolve => setTimeout(resolve, 5));
  assert.equal(f.state.closed, 1); assert.equal(f.state.calls.length, 0);
  assert.equal((await h.get()).status, 200); assert.equal(f.state.closed, 2);
});

test('absolute body deadline refuses stalled authenticated upload and releases native gate', async t => {
  const f = fixtureConnector(), h = await harness(f); t.after(h.close);
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(h.origin + '/v1/native/read', { method: 'POST', headers: { Authorization: 'Bearer ' + HUMAN, 'Content-Type': 'application/json' } }, incoming => {
      let body = ''; incoming.on('data', chunk => { body += String(chunk); });
      incoming.on('end', () => { resolve({ status: incoming.statusCode ?? 0, body }); request.destroy(); });
      incoming.on('error', reject);
    });
    request.on('error', error => { if (!request.destroyed) reject(error); });
    request.write('{'); // Never ends; deadline is measured from request body handling.
  });
  assert.equal(response.status, 408); assert.equal(JSON.parse(response.body).error, 'BODY_TIMEOUT');
  assert.equal(f.state.created, 0);
  assert.equal((await h.get()).status, 200); assert.equal(f.state.closed, 1);
});
