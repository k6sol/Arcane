import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createArcaneGateway } from '../../apps/daemon/src/arcane-gateway.js';

// The ACTUAL desktop arcane-chat.cjs host and the ACTUAL gateway client (apps/daemon/src/arcane-gateway.ts) with a MOCK
// gateway (scripted fetch, Server-Sent Events) and a MOCK MCP server (a small Node stdio JSON-RPC script). No real gateway,
// model API, daemon, Studio, dialog or renderer runs; the handoff broker and window are scripted.
const require = createRequire(join(process.cwd(), 'package.json'));
const host = require(join(process.cwd(), 'apps/desktop/electron/arcane-chat.cjs')) as any;
const CREDENTIAL = 'C'.repeat(43);
const ACCOUNT = 'arc_' + 'a'.repeat(40);
const BASE = 'https://gateway.arcane.test';

// Mock Arcane MCP server: initialize (with instructions), tools/list (two valid tools, one bad name, one oversized
// schema), tools/call (echo; `leaky` repeats the credential it was started with; `slow` never answers; `capture` adds an
// image block: 'png' and 'jpeg' are real signatures, 'gif' a refused type, 'url' a remote reference).
const MCP_SCRIPT = String.raw`
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const tools = [
  { name: 'scene_inspect', description: 'Read: inspect a ref.', inputSchema: { type: 'object', properties: { ref: { type: 'string' } } } },
  { name: 'selection_read', description: 'Read: the Studio selection.', inputSchema: { type: 'object', properties: {} } },
  { name: 'leaky', description: 'Fixture: echoes its credential.', inputSchema: { type: 'object' } },
  { name: 'slow', description: 'Fixture: never answers.', inputSchema: { type: 'object' } },
  { name: 'bad name', description: 'Invalid name.', inputSchema: { type: 'object' } },
  { name: 'huge', description: 'Oversized schema.', inputSchema: { type: 'object', description: 'x'.repeat(40000) } },
];
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'arcane-studio', version: '0' }, instructions: 'MCP INSTRUCTIONS FIXTURE' } });
  else if (message.method === 'tools/list') send({ jsonrpc: '2.0', id: message.id, result: { tools } });
  else if (message.method === 'tools/call') {
    const { name, arguments: args } = message.params;
    if (name === 'slow') return;
    const text = name === 'leaky' ? 'token=' + process.env.ARCANE_LOCAL_TOKEN : JSON.stringify({ ok: true, name, args, tokenSeen: process.env.ARCANE_LOCAL_TOKEN === '${CREDENTIAL}', daemon: process.env.ARCANE_DAEMON_URL });
    const capture = args && args.capture, bytes = capture === 'png' ? Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('capture fixture')])
      : capture === 'jpeg' ? Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('capture fixture')]) : Buffer.from('GIF89a capture fixture');
    const image = !capture ? [] : capture === 'url' ? [{ type: 'image', url: 'https://example.invalid/capture.png', mimeType: 'image/png' }]
      : [{ type: 'image', data: bytes.toString('base64'), mimeType: capture === 'gif' ? 'image/gif' : 'image/' + capture }];
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }, ...image], ...(args && args.fail ? { isError: true } : {}) } });
  }
});
`;

type Reply = (body: any, init: RequestInit) => Response | Promise<Response>;
const sse = (...events: unknown[]) => new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
const done = (extra: Record<string, unknown> = {}) => ({ type: 'done', creditsUsed: 2, actionsUsed: 0, stopReason: 'end', inputTokens: 100, outputTokens: 20, ...extra });
const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ type: 'tool_call', id, name, arguments: args });

async function fixture(t: TestContext, options: { connected?: boolean; limits?: Record<string, number>; permissions?: unknown; response?: number } = {}) {
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'arcane-arcane-chat-')));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 }));
  const project = join(root, 'project'), state = join(root, 'state'), script = join(root, 'mock-mcp.cjs'), config = join(root, 'arcane.mcp.json');
  await mkdir(project); await mkdir(state);
  await writeFile(script, MCP_SCRIPT);
  await writeFile(config, JSON.stringify({ mcpServers: { arcane: { type: 'stdio', command: process.execPath, args: [script], env: { ARCANE_DAEMON_URL: '${ARCANE_DAEMON_URL}', ARCANE_LOCAL_TOKEN: '${ARCANE_LOCAL_TOKEN}' } } } }));
  const events: any[] = [], requests: { url: string; body: any; auth: string | null }[] = [], prepared: any[] = [], released: string[] = [], dialogs: any[] = [];
  const replies: Reply[] = [];
  let connected = options.connected ?? true;
  const fetch = (async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const url = String(input), body = init.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url, body, auth: new Headers(init.headers).get('authorization') });
    if (url.endsWith('/v1/models')) return Response.json({ models: [{ id: 'arcane-default', label: 'Arcane default', pricing: { inputPerMTok: 360, outputPerMTok: 1800 }, tools: true }, { id: 'vendor/fast:1', label: 'Fast', tools: true }] });
    if (url.endsWith('/v1/balance')) return Response.json({ credits: 1200, actionsRemaining: 40, plan: 'Pro', renewsAt: '2026-11-01T00:00:00Z' });
    if (url.endsWith('/v1/chat/stream')) { const reply = replies.shift(); if (!reply) throw new Error('unexpected chat request'); return reply(body, init); }
    return new Response('{}', { status: 404 });
  }) as typeof globalThis.fetch;
  const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send(channel: string, event: unknown) { assert.equal(channel, 'arcane:arcane-chat-event'); events.push(JSON.parse(JSON.stringify(event))); } } };
  const chat = host.createArcaneChat({
    projectPath: project, stateDirectory: state, getWindow: () => window,
    env: { ...process.env, ARCANE_LOCAL_TOKEN: 'inherited-never', OPENAI_API_KEY: 'never-forward' },
    gateway: async () => connected ? createArcaneGateway({ config: null as never, vault: null, fetch, credential: async () => connected ? { base: BASE, token: ACCOUNT } : null }) : null,
    dialog: { showMessageBox: async (_w: unknown, value: any) => { dialogs.push(value); return { response: options.response ?? 1 }; } },
    handoff: {
      prepare: async (selection: unknown) => {
        const receipt: any = { handoffId: randomUUID(), expiresAt: new Date(Date.now() + 30 * 60000).toISOString(), configPath: config };
        Object.defineProperty(receipt, 'env', { value: Object.freeze({ ARCANE_DAEMON_URL: 'http://127.0.0.1:45871', ARCANE_LOCAL_TOKEN: CREDENTIAL }), enumerable: false });
        prepared.push({ selection }); return Object.freeze(receipt);
      },
      release: async (id: string) => { released.push(id); return true; },
    },
    instructions: async () => 'ARCANE TASK INSTRUCTIONS FIXTURE',
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.permissions ? { permissions: options.permissions } : {}),
  });
  t.after(() => chat.dispose());
  const finished = (turnId: string) => waitFor(() => events.find(e => e.turnId === turnId && e.type === 'done'), 15000);
  const chats = () => requests.filter(r => r.url.endsWith('/v1/chat/stream'));
  return { chat, events, requests, chats, replies, prepared, released, dialogs, finished, disconnect: () => { connected = false; } };
}
async function waitFor<T>(read: () => T | undefined, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) { const value = read(); if (value) return value; if (Date.now() > deadline) throw new Error('timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
const input = (text: string, conversationId: string | null = null, model = 'arcane-default') => ({ conversationId, text, model, effort: 'standard' });

test('disabled until a gateway and account exist: status is unavailable, nothing is requested, a send fails closed', async t => {
  const f = await fixture(t, { connected: false });
  const s = await f.chat.status();
  assert.deepEqual({ ...s, models: [...s.models], efforts: [...s.efforts] }, { available: false, state: 'disabled', models: [], efforts: ['standard'], defaultModel: null, balance: null, message: 'Arcane Credits are not connected yet.' });
  const sent = await f.chat.send(input('Build a lobby'));
  const end = await f.finished(sent.turnId);
  assert.equal(end.ok, false); assert.equal(end.error, 'Arcane Credits are not connected yet.');
  assert.deepEqual(f.requests, []); assert.deepEqual(f.prepared, [], 'no project credential is minted while disabled');
});

test('status lists the account models with credit prices and the balance; frozen, no secrets', async t => {
  const f = await fixture(t);
  const s = await f.chat.status();
  assert.deepEqual(JSON.parse(JSON.stringify(s)), { available: true, state: 'ready', defaultModel: 'arcane-default', message: null, efforts: ['standard'],
    models: [{ id: 'arcane-default', label: 'Arcane default', pricing: { inputPerMTok: 360, outputPerMTok: 1800 } }, { id: 'vendor/fast:1', label: 'Fast', pricing: null }],
    balance: { credits: 1200, actionsRemaining: 40, plan: 'Pro' } });
  assert.ok(Object.isFrozen(s) && Object.isFrozen(s.models));
  assert.ok(!JSON.stringify(s).includes(ACCOUNT) && !JSON.stringify(s).includes(BASE));
  assert.ok(f.requests.every(r => r.auth === 'Bearer ' + ACCOUNT && r.url.startsWith(BASE + '/v1/')));
});

test('tool loop: MCP tools offered in the function-calling shape, calls run through the scoped MCP server, results fed back, events in the Claude bridge shape', async t => {
  const f = await fixture(t);
  f.replies.push(
    () => sse({ type: 'delta', text: 'Checking ' }, { type: 'delta', text: 'the scene.' }, call('call_1', 'scene_inspect', { ref: 'Workspace' }), done({ stopReason: 'tool_use', creditsUsed: 2 })),
    () => sse({ type: 'delta', text: 'Placed ' }, { type: 'delta', text: 'it.' }, done({ creditsUsed: 1, inputTokens: 150, outputTokens: 10 })));
  const sent = await f.chat.send({ ...input('Build a lobby'), playtest: false });
  const end = await f.finished(sent.turnId);
  assert.deepEqual(end, { turnId: sent.turnId, conversationId: sent.conversationId, type: 'done', ok: true, error: null,
    usage: { inputTokens: 250, outputTokens: 30, costUsd: null, credits: 3 }, usageLimit: null });
  const shape = f.events.filter(e => e.turnId === sent.turnId).map(e => e.type === 'delta' ? 'delta:' + e.text : e.type === 'done' ? 'done' :
    e.type + ':' + e.message.role + ':' + (e.message.tool ? e.message.tool.name + '/' + e.message.tool.status : e.message.text));
  assert.deepEqual(shape, ['delta:Checking ', 'delta:the scene.', 'message:assistant:Checking the scene.', 'tool:tool:scene_inspect/started', 'tool:tool:scene_inspect/finished',
    'delta:Placed ', 'delta:it.', 'message:assistant:Placed it.', 'done']);
  const finishedTool = f.events.find(e => e.type === 'tool' && e.message.tool.status === 'finished').message.tool;
  assert.equal(finishedTool.input, '{"ref":"Workspace"}');
  assert.equal(JSON.parse(finishedTool.result).tokenSeen, true, 'the MCP server ran with the scoped project credential');

  const [first, second] = f.chats();
  assert.deepEqual(first!.body.tools.map((tool: any) => tool.name), ['scene_inspect', 'selection_read', 'leaky', 'slow'], 'invalid names and oversized schemas are left out');
  assert.deepEqual(first!.body.tools[0], { name: 'scene_inspect', description: 'Read: inspect a ref.', inputSchema: { type: 'object', properties: { ref: { type: 'string' } } } });
  assert.equal(first!.body.messages[0].role, 'system');
  for (const part of ['ARCANE TASK INSTRUCTIONS FIXTURE', 'MCP INSTRUCTIONS FIXTURE', 'Project memory:']) assert.ok(first!.body.messages[0].content.includes(part), part);
  assert.equal(first!.body.messages.at(-1).role, 'user'); assert.match(first!.body.messages.at(-1).content, /^Build a lobby\n\nArcane setting: Playtest is OFF\./);
  assert.equal(first!.body.turnId, sent.turnId); assert.equal(second!.body.turnId, sent.turnId, 'one turn id for every request of the reply (one action)');
  assert.equal(first!.body.conversationId, sent.conversationId);
  assert.deepEqual(second!.body.messages.slice(-2).map((m: any) => ({ ...m, content: m.role === 'tool' ? JSON.parse(m.content) : m.content })), [
    { role: 'assistant', content: 'Checking the scene.', toolCalls: [{ id: 'call_1', name: 'scene_inspect', arguments: { ref: 'Workspace' } }] },
    { role: 'tool', toolCallId: 'call_1', content: { ok: true, name: 'scene_inspect', args: { ref: 'Workspace' }, tokenSeen: true, daemon: 'http://127.0.0.1:45871' } }]);
  for (const request of f.requests) { assert.ok(!JSON.stringify(request.body ?? '').includes(CREDENTIAL), 'the project credential never reaches the gateway'); assert.equal(request.auth, 'Bearer ' + ACCOUNT); }
  assert.deepEqual(f.prepared, [{ selection: { model: 'arcane', effort: 'standard' } }]);

  const saved = await f.chat.history(sent.conversationId);
  assert.deepEqual(saved.messages.map((m: any) => m.role + ':' + (m.tool ? m.tool.name + '/' + m.tool.status : m.text)), ['user:Build a lobby', 'assistant:Checking the scene.', 'tool:scene_inspect/finished', 'assistant:Placed it.']);
  const listed = await f.chat.list();
  assert.equal(listed.conversations[0].model, 'arcane-default'); assert.equal(listed.conversations[0].effort, 'standard');

  // The next turn carries the saved conversation as context (there is no server-side session to resume).
  f.replies.push(() => sse({ type: 'delta', text: 'Sure.' }, done()));
  const next = await f.chat.send(input('Make it red', sent.conversationId, 'vendor/fast:1'));
  assert.equal((await f.finished(next.turnId)).ok, true);
  assert.deepEqual(f.chats()[2]!.body.messages.slice(1).map((m: any) => m.role + ':' + m.content), ['user:Build a lobby', 'assistant:Checking the scene.\n\n[Arcane tool scene_inspect finished]\n\nPlaced it.', 'user:Make it red']);
  assert.equal(f.chats()[2]!.body.model, 'vendor/fast:1');
  await f.chat.dispose();
  assert.equal(f.released.length, 1, 'the shared credential is revoked on dispose');
});

test('out of credits ends the reply with the fixed notice and a usage limit; sign-in expiry and rate limits have their own messages', async t => {
  const f = await fixture(t);
  f.replies.push(() => Response.json({ error: 'insufficient_balance', message: 'You are out of Arcane Credits.' }, { status: 402 }));
  const sent = await f.chat.send(input('Build a lobby'));
  const end = await f.finished(sent.turnId);
  assert.deepEqual([end.ok, end.error, end.usageLimit, end.usage], [false, "You're out of Arcane Credits. This message was not answered; buy credits to continue.", { resetsAt: null }, null]);
  f.replies.push(() => new Response('{}', { status: 401 }));
  const expired = await f.chat.send(input('again', sent.conversationId));
  assert.deepEqual([(await f.finished(expired.turnId)).error, f.events.find(e => e.turnId === expired.turnId && e.type === 'done').usageLimit], ['Your Arcane sign-in expired. Connect your account again in Settings > Plans & credits.', null]);
  f.replies.push(() => new Response('{}', { status: 429 }));
  const limited = await f.chat.send(input('again', sent.conversationId));
  assert.equal((await f.finished(limited.turnId)).error, 'Too many Arcane requests right now. Try again in a minute.');
  f.replies.push(() => sse({ type: 'delta', text: 'Half' }, { type: 'error', message: 'The model is unavailable right now.' }));
  const broken = await f.chat.send(input('again', sent.conversationId));
  assert.equal((await f.finished(broken.turnId)).error, 'The model is unavailable right now.');
  assert.ok(f.events.some(e => e.turnId === broken.turnId && e.type === 'message' && e.message.text === 'Half'), 'streamed text is kept');
});

test('the loop is bounded: model rounds, tool calls, unknown tools and slow tools', async t => {
  const f = await fixture(t, { limits: { rounds: 3, toolCalls: 2, toolTimeoutMs: 300 } });
  f.replies.push(
    () => sse(call('c1', 'nope'), done({ stopReason: 'tool_use' })),
    () => sse(call('c2', 'slow'), call('c3', 'selection_read'), done({ stopReason: 'tool_use' })),
    () => sse(call('c4', 'selection_read'), done({ stopReason: 'tool_use' })));
  const sent = await f.chat.send(input('Loop forever'));
  const end = await f.finished(sent.turnId);
  assert.equal(end.ok, false); assert.equal(end.error, 'Arcane paused after the most steps one reply may take. Send "continue" to go on.');
  assert.equal(end.usage.credits, 6);
  const [, second, third] = f.chats();
  const toolMessages = (request: any) => request.body.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.toolCallId + ':' + (m.isError ? 'error:' : '') + m.content.split(' ').slice(0, 3).join(' '));
  assert.deepEqual(toolMessages(second), ['c1:error:Unknown tool: nope.']);
  assert.deepEqual(toolMessages(third).slice(1), ['c2:error:The tool did', 'c3:error:Arcane reached the'], 'a slow tool times out; calls past the bound are refused');
});

test('a capture image from an Arcane MCP tool rides on the live tool event only (at most 4 per reply); the model and the transcript get text', async t => {
  const f = await fixture(t);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('capture fixture')]).toString('base64');
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('capture fixture')]).toString('base64');
  f.replies.push(
    () => sse(call('c1', 'scene_inspect', { capture: 'png' }), call('c2', 'scene_inspect', { capture: 'jpeg' }), call('c3', 'scene_inspect', { capture: 'gif' }),
      call('c4', 'scene_inspect', { capture: 'url' }), call('c5', 'scene_inspect', { capture: 'png', fail: true }), done({ stopReason: 'tool_use' })),
    () => sse(call('c6', 'scene_inspect', { capture: 'png' }), call('c7', 'scene_inspect', { capture: 'png' }), call('c8', 'scene_inspect', { capture: 'png' }), done({ stopReason: 'tool_use' })),
    () => sse({ type: 'delta', text: 'Captured.' }, done()));
  const sent = await f.chat.send(input('Capture the scene'));
  assert.equal((await f.finished(sent.turnId)).ok, true);
  const finished = f.events.filter(e => e.type === 'tool' && e.message.tool.status !== 'started').map(e => e.message.tool);
  assert.deepEqual(finished.map(tool => tool.image ?? null), ['data:image/png;base64,' + png, 'data:image/jpeg;base64,' + jpeg, null, null, null,
    'data:image/png;base64,' + png, 'data:image/png;base64,' + png, null], 'PNG/JPEG only, never a failed call or a URL, at most 4 per reply');
  for (const request of f.chats()) assert.ok(!JSON.stringify(request.body).includes(png) && !JSON.stringify(request.body).includes(jpeg), 'the gateway never receives the image bytes');
  const saved = await f.chat.history(sent.conversationId);
  assert.ok(saved.messages.every((m: any) => !m.tool || !('image' in m.tool)), 'the transcript never keeps an image');
});

test('Stop aborts the open stream and the MCP child; the credential never appears in a reply or a tool result', async t => {
  const f = await fixture(t);
  f.replies.push(() => sse(call('c1', 'leaky'), done({ stopReason: 'tool_use' })), (_body, init) => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"delta","text":"Working ' + CREDENTIAL + '"}\n\ndata: {"type":"delta","text":"on it"}\n\n'));
      init.signal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true }); },
  }), { status: 200 }));
  const sent = await f.chat.send(input('Leak test'));
  await waitFor(() => f.events.find(e => e.turnId === sent.turnId && e.type === 'delta' && e.text === 'on it'));
  assert.equal(await f.chat.stop(sent.turnId), true);
  const end = await f.finished(sent.turnId);
  assert.deepEqual([end.ok, end.error], [false, 'Stopped.']);
  const toolMessage = f.chats()[1]!.body.messages.find((m: any) => m.role === 'tool');
  assert.equal(toolMessage.content, 'token=[redacted]');
  assert.ok(!JSON.stringify(f.events).includes(CREDENTIAL), 'no event carries the credential');
  assert.ok(!JSON.stringify(await f.chat.history(sent.conversationId)).includes(CREDENTIAL));
  assert.equal(await f.chat.stop(sent.turnId), false);
});

test('consent: the project switch or one in-app question; a decline mints nothing', async t => {
  const declined = await fixture(t, { response: 0 });
  const sent = await declined.chat.send(input('Build'));
  assert.equal((await declined.finished(sent.turnId)).error, 'Arcane chat was not allowed to use Arcane project tools for this project.');
  assert.equal(declined.dialogs.length, 1); assert.match(declined.dialogs[0].detail, /Arcane Credits/); assert.deepEqual(declined.prepared, []);
  const allowed = await fixture(t, { permissions: { claudeTools: async () => true } });
  allowed.replies.push(() => sse({ type: 'delta', text: 'ok' }, done()));
  const ok = await allowed.chat.send(input('Build'));
  assert.equal((await allowed.finished(ok.turnId)).ok, true); assert.equal(allowed.dialogs.length, 0);
});

test('send and IPC envelopes are exact: text only, gateway model ids, fixed refusals', async t => {
  const f = await fixture(t);
  assert.throws(() => host.sendInput({ ...input('x'), images: [] }), /sends text only/);
  assert.throws(() => host.sendInput({ ...input('x'), effort: 'high' }), /unavailable/);
  assert.throws(() => host.sendInput({ ...input('x'), model: '../evil' }), /unavailable/);
  assert.throws(() => host.sendInput({ ...input(' '), }), /empty or too long/);
  assert.equal(host.sendInput(input('x', null, 'vendor/fast:1')).model, 'vendor/fast:1');
  const handlers = new Map<string, any>();
  const contents: any = { isDestroyed: () => false }; contents.mainFrame = { url: 'http://127.0.0.1:45871/studio' };
  const window = { isDestroyed: () => false, webContents: contents };
  host.installArcaneChatIpc({ handle: (channel: string, handler: any) => handlers.set(channel, handler) }, { getSession: () => ({ window, origin: 'http://127.0.0.1:45871', epoch: 1 }), getHost: () => f.chat });
  assert.deepEqual([...handlers.keys()].sort(), ['status', 'list', 'history', 'send', 'rewind', 'stop', 'remove'].map(a => 'arcane:arcane-chat-' + a).sort());
  const event = { sender: contents, senderFrame: contents.mainFrame };
  assert.equal((await handlers.get('arcane:arcane-chat-status')(event)).available, true);
  await assert.rejects(handlers.get('arcane:arcane-chat-send')(event, { ...input('x'), images: [] }), /^Error: Arcane Credits chat sends text only/);
  await assert.rejects(handlers.get('arcane:arcane-chat-status')({ sender: {}, senderFrame: contents.mainFrame }), /^Error: Arcane chat is unavailable\.$/);
  await assert.rejects(handlers.get('arcane:arcane-chat-history')(event, 'not-an-id'), /^Error: Arcane chat is unavailable\.$/);
});

test('tool and history helpers are bounded', () => {
  const tools = host.gatewayTools([{ name: 'a', description: 'x'.repeat(5000), inputSchema: { type: 'object' } }, { name: 'a', inputSchema: {} }, { name: 'b', inputSchema: [] }, null]);
  assert.deepEqual(tools.map((tool: any) => [tool.name, tool.description.length]), [['a', 4096]]);
  assert.equal(host.toolResultText({ content: [{ type: 'text', text: 'y'.repeat(20) }] }, null, 10), 'yyyyyyyyyy\n[10 more characters omitted]');
  assert.equal(host.toolResultText({ content: [], structuredContent: { a: 1 } }, null), '{"a":1}');
  assert.equal(host.toolResultText({ content: [], isError: true }, null), 'The tool failed without details.');
  const history = host.historyMessages([{ role: 'assistant', text: 'orphan' }, { role: 'user', text: 'one' }, { role: 'error', text: 'x' }, { role: 'user', text: 'two' }, { role: 'assistant', text: 'reply' }], 1000);
  assert.deepEqual(history, [{ role: 'user', content: 'one\n\ntwo' }, { role: 'assistant', content: 'reply' }]);
  const long = host.historyMessages([{ role: 'user', text: 'a'.repeat(50) }, { role: 'assistant', text: 'b'.repeat(50) }, { role: 'user', text: 'c'.repeat(50) }], 60);
  assert.deepEqual(long.map((m: any) => m.content[0]), ['c']);
});
