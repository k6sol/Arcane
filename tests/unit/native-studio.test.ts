import { sanitizeObservationText } from '../../packages/studio-adapter/src/observations.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ReadBuffer } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { parseStudioMcpLauncher } from '../../packages/studio-adapter/src/discovery.js';
import { NativeStudioSession } from '../../packages/studio-adapter/src/session.js';
import { NativeStudioError, NATIVE_STUDIO_LIMITS, sessionLimits, type NativeStudioReadArgs, type NativeStudioReadMethod } from '../../packages/studio-adapter/src/policy.js';

const A = '43b622a3-4265-42da-92fd-c9980c3022a3', B = '5e20e764-3ac3-497f-8908-39e54a2bfc21';
const result = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });
function tool(name: string, required: string[] = ['studio_id'], extra: Record<string, object> = {}): Tool {
  return { name, annotations: { readOnlyHint: true }, inputSchema: {
    type: 'object', properties: { ...(name === 'list_roblox_studios' ? {} : { studio_id: { type: 'string' } }), ...extra }, required,
  } };
}
function fixtureTools(): Tool[] {
  return [
    tool('list_roblox_studios', []), tool('get_studio_state'), tool('get_console_output'),
    tool('search_game_tree', ['studio_id', 'datamodel_type'], {
      datamodel_type: { type: 'string', enum: ['Edit', 'Client', 'Server'] }, path: { type: 'string' },
      instance_type: { type: 'string' }, keywords: { type: 'string' }, head_limit: { type: 'number' }, max_depth: { type: 'number' },
    }),
    tool('inspect_instance', ['studio_id', 'path'], { path: { type: 'string' } }),
    tool('script_read', ['studio_id', 'target_file'], {
      target_file: { type: 'string' }, should_read_entire_file: { type: 'boolean' },
      start_line_one_indexed: { type: 'number' }, end_line_one_indexed_inclusive: { type: 'number' },
    }),
    tool('script_search', ['studio_id', 'keywords'], { keywords: { type: 'string' } }),
    tool('script_grep', ['studio_id', 'query'], { query: { type: 'string' } }),
    ...['execute_luau', 'multi_edit', 'start_stop_play', 'user_mouse_input', 'insert_asset', 'subagent', 'new_read_tool'].map(name => tool(name)),
  ];
}
async function fixture(options: {
  tools?: Tool[]; timeoutMs?: number; maxRequests?: number; inventory?: unknown;
  handle?: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
  pages?: (cursor: string | undefined) => { tools: Tool[]; nextCursor?: string };
} = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: 'arcane-unit-fixture', version: 'fixture-only' }, { capabilities: { tools: { listChanged: true } } });
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const state = { tools: options.tools ?? fixtureTools(), inventories: 0, lists: 0 };
  server.setRequestHandler(ListToolsRequestSchema, async request => {
    state.lists++;
    return options.pages ? options.pages(request.params?.cursor) : { tools: state.tools };
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const args = request.params.arguments ?? {}; calls.push({ name: request.params.name, args });
    if (request.params.name === 'list_roblox_studios') {
      state.inventories++;
      return result(options.inventory ?? { studios: [{ id: A, name: 'UNIT FIXTURE A' }, { id: B, name: 'UNIT FIXTURE B' }] });
    }
    return options.handle ? options.handle(request.params.name, args) : result({ fixture: true, studio_id: args.studio_id });
  });
  await server.connect(serverTransport);
  const session = new NativeStudioSession(clientTransport, { kind: 'fixture', label: 'SDK in-memory unit fixture; not Roblox Studio' }, options);
  try { await session.initialize(); }
  catch (error) { await server.close(); throw error; }
  return { session, calls, state, server, close: async () => { await session.close(); await server.close(); } };
}
const code = (expected: string) => (error: unknown) => error instanceof NativeStudioError && error.code === expected;

test('launcher is parsed as bounded data; only an absolute installed version exe is accepted', () => {
  const root = String.raw`C:\Users\fixture\AppData\Local`;
  const executable = root + String.raw`\Roblox\Versions\version-9b554450a0fc4e65\StudioMCP.exe`;
  assert.equal(parseStudioMcpLauncher('if exist "' + executable + '" ( "' + executable + '" %* )', root), executable);
  for (const path of ['cmd.exe', 'StudioMCP.exe', String.raw`C:\other\StudioMCP.exe`, root + String.raw`\Roblox\Versions\version-9b554450a0fc4e65\..\evil.exe`, executable + ':evil']) {
    assert.throws(() => parseStudioMcpLauncher('if exist "' + path + '" ( )', root), code('STUDIO_EXECUTABLE'));
  }
  assert.throws(() => parseStudioMcpLauncher('x'.repeat(16_385), root), code('STUDIO_EXECUTABLE'));
  assert.throws(() => parseStudioMcpLauncher('cmd.exe /c malicious.bat', root), code('STUDIO_EXECUTABLE'));
});

test('actual SDK handshake/discovery preserves runtime schemas; fixture evidence cannot masquerade as live', async t => {
  const f = await fixture(); t.after(f.close);
  const metadata = f.session.metadata();
  assert.equal(metadata.sdkVersion, '1.32.1'); assert.equal(metadata.evidenceKind, 'fixture');
  assert.equal(metadata.transport, 'in-memory-fixture'); assert.equal(metadata.server?.name, 'arcane-unit-fixture');
  assert.equal(metadata.tools.find(item => item.name === 'get_studio_state')?.allowed, true);
  assert.equal(metadata.tools.find(item => item.name === 'execute_luau')?.allowed, false);
  assert.equal(metadata.tools.find(item => item.name === 'new_read_tool')?.blockedReason, 'not_read_allowlisted');
  metadata.tools.length = 0;
  assert.ok(f.session.metadata().tools.length > 0);
  assert.equal('transport' in f.session, false);
  assert.equal('client' in f.session, false);
});

test('every allowed targeted read forwards the caller exact studio_id; multiple windows never infer a target', async t => {
  const f = await fixture(); t.after(f.close);
  const reads: { [K in NativeStudioReadMethod]: NativeStudioReadArgs[K] } = {
    get_studio_state: { studio_id: A }, get_console_output: { studio_id: B },
    search_game_tree: { studio_id: A, datamodel_type: 'Edit', path: 'Workspace' },
    inspect_instance: { studio_id: B, path: 'Workspace.Baseplate' },
    script_read: { studio_id: A, target_file: 'game.ServerScriptService.Existing' },
    script_search: { studio_id: B, keywords: 'Existing' }, script_grep: { studio_id: A, query: 'function' },
  };
  for (const method of Object.keys(reads) as NativeStudioReadMethod[]) await f.session.read(method, reads[method]);
  for (const call of f.calls.filter(item => item.name !== 'list_roblox_studios')) {
    assert.equal(call.args.studio_id, reads[call.name as NativeStudioReadMethod].studio_id);
  }
  assert.equal(f.state.inventories, 7);
  const tree = f.calls.find(item => item.name === 'search_game_tree');
  assert.equal(tree?.args.head_limit, 100); assert.equal(tree?.args.max_depth, 3);
});

test('missing/blank targets, unknown fields, evaluation, play, inputs, writes and autonomous subagents are refused before dispatch', async t => {
  const f = await fixture(); t.after(f.close);
  const read = f.session.read.bind(f.session) as (method: string, args: unknown) => Promise<unknown>;
  for (const args of [{}, { studio_id: '' }, { studio_id: ' ' }, { studio_id: A, code: 'return 1' }])
    await assert.rejects(read('get_studio_state', args), code('STUDIO_ARGUMENTS'));
  for (const method of ['execute_luau', 'multi_edit', 'start_stop_play', 'user_keyboard_input', 'user_mouse_input', 'insert_asset', 'subagent', 'http_get', 'new_read_tool', 'list_roblox_studios'])
    await assert.rejects(read(method, { studio_id: A }), code('STUDIO_READ_ONLY'));
  assert.equal(f.calls.length, 0);
});

test('stale target inventory never dispatches the targeted read or selects the other window', async t => {
  const f = await fixture({ inventory: { studios: [{ id: B, name: 'OTHER FIXTURE' }] } }); t.after(f.close);
  await assert.rejects(f.session.read('get_studio_state', { studio_id: A }), code('STUDIO_NOT_FOUND'));
  assert.deepEqual(f.calls.map(call => call.name), ['list_roblox_studios']);
});

test('malformed/duplicate/oversized inventories fail closed', async t => {
  for (const inventory of [{ studios: [{ id: A, name: 'a' }, { id: A, name: 'b' }] }, { studios: [{ name: 'a' }] }, { studios: [] }, { studios: Array.from({ length: 65 }, (_, i) => ({ id: String(i), name: 'fixture' })) }]) {
    const f = await fixture({ inventory }); t.after(f.close);
    await assert.rejects(f.session.read('get_studio_state', { studio_id: A }), code(Array.isArray(inventory.studios) && inventory.studios.length === 0 ? 'STUDIO_NOT_FOUND' : 'STUDIO_INVENTORY'));
    assert.equal(f.calls.some(call => call.name === 'get_studio_state'), false);
  }
});

test('runtime hints cannot expand allowlist; changed required target schema removes capability', async t => {
  const tools = fixtureTools();
  const state = tools.find(tool => tool.name === 'get_studio_state')!;
  state.inputSchema.required = []; // Even a documented read must advertise exact targeting.
  const inspect = tools.find(tool => tool.name === 'inspect_instance')!;
  inspect.annotations = { readOnlyHint: false };
  const f = await fixture({ tools }); t.after(f.close);
  await assert.rejects(f.session.read('get_studio_state', { studio_id: A }), code('STUDIO_CAPABILITY_UNAVAILABLE'));
  await assert.rejects(f.session.read('inspect_instance', { studio_id: A, path: 'Workspace' }), code('STUDIO_CAPABILITY_UNAVAILABLE'));
  assert.equal(f.calls.length, 0);
});

test('runtime input schemas are used as well as local argument bounds', async t => {
  const tools = fixtureTools();
  tools.find(tool => tool.name === 'get_studio_state')!.inputSchema.properties = { studio_id: { type: 'string', enum: [B] } };
  const f = await fixture({ tools }); t.after(f.close);
  await assert.rejects(f.session.read('get_studio_state', { studio_id: A }), code('STUDIO_CAPABILITY_SCHEMA'));
  assert.equal(f.calls.length, 0);
});

test('list-changed refresh removes capabilities before another targeted read', async t => {
  const f = await fixture(); t.after(f.close);
  f.state.tools = f.state.tools.filter(tool => tool.name !== 'get_studio_state');
  await f.server.notification({ method: 'notifications/tools/list_changed' });
  await assert.rejects(f.session.read('get_studio_state', { studio_id: A }), code('STUDIO_CAPABILITY_UNAVAILABLE'));
  assert.equal(f.state.lists, 2); assert.equal(f.calls.length, 0);
});

test('tool pagination is actually traversed; duplicate and cyclic inventories are bounded', async t => {
  const f = await fixture({ pages: cursor => cursor ? { tools: [tool('get_studio_state')] } : { tools: [tool('list_roblox_studios', [])], nextCursor: 'second' } });
  t.after(f.close); assert.equal(f.state.lists, 2);
  await f.session.read('get_studio_state', { studio_id: A });
  await assert.rejects(fixture({ pages: () => ({ tools: [tool('get_studio_state')], nextCursor: 'repeat' }) }), code('STUDIO_CAPABILITY_LIMIT'));
  await assert.rejects(fixture({ tools: Array.from({ length: 129 }, (_, i) => tool('unknown_' + i)) }), code('STUDIO_CAPABILITY_LIMIT'));
  await assert.rejects(fixture({ pages: cursor => {
    const next = cursor ? tool('get_studio_state') : tool('list_roblox_studios', []);
    next.inputSchema['x-unit-fixture-padding'] = 'x'.repeat(140_000);
    return cursor ? { tools: [next] } : { tools: [next], nextCursor: 'second' };
  } }), code('STUDIO_CAPABILITY_LIMIT'));

});

test('tree and source requests enforce numeric and line-range limits before contacting Studio', async t => {
  const f = await fixture(); t.after(f.close);
  for (const args of [{ studio_id: A, datamodel_type: 'Edit' as const, max_depth: 11 }, { studio_id: A, datamodel_type: 'Edit' as const, head_limit: 201 }, { studio_id: A, datamodel_type: 'Edit' as const, head_limit: NaN }])
    await assert.rejects(f.session.read('search_game_tree', args), code('STUDIO_ARGUMENTS'));
  for (const args of [
    { studio_id: A, target_file: 'game.S', should_read_entire_file: false },
    { studio_id: A, target_file: 'game.S', should_read_entire_file: false, start_line_one_indexed: 3, end_line_one_indexed_inclusive: 2 },
    { studio_id: A, target_file: 'game.S', should_read_entire_file: false, start_line_one_indexed: 1, end_line_one_indexed_inclusive: 501 },
  ]) await assert.rejects(f.session.read('script_read', args), code('STUDIO_ARGUMENTS'));
  assert.equal(f.calls.length, 0);
  await f.session.read('script_read', { studio_id: A, target_file: 'game.S', should_read_entire_file: false, start_line_one_indexed: 1, end_line_one_indexed_inclusive: 500 });
});

test('request budget counts handshake, discovery and inventory; no partial targeted operation starts beyond budget', async t => {
  const f = await fixture({ maxRequests: 5 }); t.after(f.close);
  await f.session.listStudios();
  await f.session.read('get_studio_state', { studio_id: A });
  assert.equal(f.session.metadata().requestsUsed, 5);
  const before = f.calls.length;
  await assert.rejects(f.session.read('get_studio_state', { studio_id: B }), code('STUDIO_REQUEST_LIMIT'));
  assert.equal(f.calls.length, before);
  await assert.rejects(f.session.listStudios(), code('STUDIO_REQUEST_LIMIT'));
  assert.equal(f.session.metadata().requestsUsed, 5);
  assert.equal(f.calls.length, before);
  for (const limits of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { maxRequests: 257 }, { maxRequests: 2 }])
    assert.throws(() => sessionLimits(limits), code('STUDIO_LIMITS'));
});

test('timed-out SDK request closes session and is never retried; raw provider-like error text is not surfaced', async t => {
  const f = await fixture({ timeoutMs: 80, handle: async () => new Promise<CallToolResult>(() => {}) }); t.after(f.close);
  await assert.rejects(f.session.read('get_studio_state', { studio_id: A }), code('STUDIO_TIMEOUT'));
  assert.equal(f.calls.filter(call => call.name === 'get_studio_state').length, 1);
  await assert.rejects(f.session.listStudios(), code('STUDIO_CLOSED'));
  const broken = await fixture({ handle: async () => { throw new Error('secret-provider-value'); } }); t.after(broken.close);
  await assert.rejects(broken.session.read('get_studio_state', { studio_id: A }), error => code('STUDIO_REQUEST_FAILED')(error) && !(error as Error).message.includes('secret-provider-value'));
});

test('deadline also bounds transport start before SDK initialize can register its own timeout', async () => {
  let closed = 0;
  const transport: Transport = {
    start: async () => new Promise<void>(() => {}), send: async () => {},
    close: async () => { closed++; transport.onclose?.(); },
  };
  const session = new NativeStudioSession(transport, { kind: 'fixture', label: 'hung-start unit fixture' }, { timeoutMs: 30 });
  await assert.rejects(session.initialize(), code('STUDIO_TIMEOUT'));
  assert.ok(closed > 0);
});

test('SDK wire buffer and adapter result/source bounds reject excessive payloads', async t => {
  const buffer = new ReadBuffer({ maxBufferSize: NATIVE_STUDIO_LIMITS.resultBytes });
  assert.throws(() => buffer.append(Buffer.alloc(NATIVE_STUDIO_LIMITS.resultBytes + 1)), /exceeded maximum size/);
  const oversized = await fixture({ handle: async () => result('x'.repeat(NATIVE_STUDIO_LIMITS.resultBytes)) }); t.after(oversized.close);
  await assert.rejects(oversized.session.read('get_console_output', { studio_id: A }), code('STUDIO_PAYLOAD_LIMIT'));
  await assert.rejects(oversized.session.listStudios(), code('STUDIO_CLOSED'));
  const source = await fixture({ handle: async () => result('🙂'.repeat(Math.ceil(NATIVE_STUDIO_LIMITS.sourceBytes / 4))) }); t.after(source.close);
  await assert.rejects(source.session.read('script_read', { studio_id: A, target_file: 'game.Existing' }), code('STUDIO_SOURCE_LIMIT'));
});

test('explicit close is idempotent and prevents subsequent reads', async () => {
  const f = await fixture();
  await f.session.close(); await f.session.close(); await f.server.close();
  await assert.rejects(f.session.read('get_studio_state', { studio_id: A }), code('STUDIO_CLOSED'));
});


test('overlapping operations are refused without dispatch or hidden queueing', async t => {
  let release!: () => void, began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ handle: async () => { began(); await gate; return result({ fixture: true }); } });
  t.after(f.close);
  const pending = f.session.read('get_studio_state', { studio_id: A });
  await started;
  try {
    await assert.rejects(f.session.read('get_studio_state', { studio_id: B }), code('STUDIO_BUSY'));
    await assert.rejects(f.session.listStudios(), code('STUDIO_BUSY'));
    assert.equal(f.calls.filter(call => call.name === 'get_studio_state').length, 1);
  } finally { release(); }
  await pending;
  assert.equal(f.session.metadata().connected, true);
  await f.session.close();
  assert.equal(f.session.metadata().connected, false);
});

test('saved observation redaction handles bearer values and quoted or assigned credential fields', () => {
  const output = sanitizeObservationText('Bearer abc123.secret-value api_key=private-value {"refresh_token":"private phrase","password":"another private phrase"} sk-examplesecretvalue');
  for (const value of ['abc123.secret-value', 'private-value', 'private phrase', 'another private phrase', 'sk-examplesecretvalue'])
    assert.equal(output.includes(value), false);
  assert.ok(output.includes('[REDACTED]'));
  assert.equal(sanitizeObservationText('Place1'), 'Place1');
});
